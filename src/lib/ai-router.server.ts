// AI router — walks a per-task fallback chain of {provider, model} steps.
// At each step it picks an LRU non-cooling key of that provider that is also
// not cooling for that specific model, and issues one call. On 429/5xx it
// cools (key, model) and moves to the next step. First success wins.

import type { Message } from "./prompt-registry.server";
import {
  PROVIDER_META,
  bumpDailyCounter,
  cool,
  coolModel,
  coolModelUntilUTCMidnight,
  hashKey,
  isKeyCooling,
  isModelCooling,
  keyRuntimeSnapshot,
  loadProvidersConfig,
  loadCustomChains,
  noteRequest,
  type ProviderId,
  type ProvidersConfig,
} from "./ai-providers.server";
import { resolveChain, type ChainStep } from "./task-chains.server";

export type RouteTaskOpts = {
  task?: string;
  messages: Message[];
  requireJson?: boolean;
  /** Explicit provider/model override (admin use). Bypasses the chain. */
  override?: { provider?: ProviderId; model?: string };
  temperature?: number;
  /** Ignored — kept for signature compat with legacy callers. */
  role?: string;
  preferProvider?: ProviderId;
};

export type RouteResult = {
  text: string;
  provider: ProviderId;
  model: string;
  keyHash: string;
  ms: number;
  tokensIn: number;
  tokensOut: number;
};

export class AiBusyError extends Error {
  retryAfter: number;
  attempts: Array<{ provider: string; model: string; keyHash: string; status: number; error: string }>;
  constructor(msg: string, retryAfter: number, attempts: AiBusyError["attempts"]) {
    super(msg);
    this.name = "AiBusyError";
    this.retryAfter = retryAfter;
    this.attempts = attempts;
  }
}

function estimateTokens(msgs: Message[], reply: string): { tokensIn: number; tokensOut: number } {
  let inChars = 0;
  for (const m of msgs) inChars += (m.content || "").length;
  return { tokensIn: Math.ceil(inChars / 4), tokensOut: Math.ceil(reply.length / 4) };
}

// Pick an LRU non-cooling key of `providerId` that is also not cooling
// for the specific `model`.
function pickKeyForModel(
  providerId: ProviderId,
  keys: string[],
  model: string,
): { key: string; hash: string; idx: number } | null {
  if (!keys || keys.length === 0) return null;
  const meta = PROVIDER_META[providerId];
  const rpmCap = (model && meta.rpmByModel?.[model]) || meta.defaultRpm;
  const rpmGate = Math.max(1, Math.floor(rpmCap * 0.95));
  let best: { key: string; hash: string; idx: number; lastUsed: number } | null = null;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const h = hashKey(k);
    if (isKeyCooling(providerId, h)) continue;
    if (isModelCooling(providerId, h, model)) continue;
    const rt = keyRuntimeSnapshot(providerId, h);
    if (rt.rpm >= rpmGate) continue;
    const lastUsed = rt.lastUsedAt || 0;
    if (!best || lastUsed < best.lastUsed) best = { key: k, hash: h, idx: i, lastUsed };
  }
  if (!best) return null;
  return { key: best.key, hash: best.hash, idx: best.idx };
}

type ChatUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
type ChatResp = { choices?: Array<{ message?: { content?: string } }>; usage?: ChatUsage };

export type CallResult =
  | { ok: true; text: string; usage?: ChatUsage }
  | { ok: false; status: number; message: string };

export async function callOnce(
  providerId: ProviderId,
  key: string,
  model: string,
  body: { messages: Message[]; temperature: number; requireJson: boolean; maxTokens?: number },
  signal?: AbortSignal,
): Promise<CallResult> {
  const meta = PROVIDER_META[providerId];
  const payload: Record<string, unknown> = {
    model,
    messages: body.messages,
    temperature: body.temperature,
  };
  if (typeof body.maxTokens === "number") payload.max_tokens = body.maxTokens;
  if (body.requireJson && meta.supportsJsonMode) {
    payload.response_format = { type: "json_object" };
  }
  if (meta.extraBody) Object.assign(payload, meta.extraBody);

  let resp: Response;
  try {
    resp = await fetch(meta.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...meta.authHeader(key) },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    return { ok: false, status: 599, message: (e as Error).message || "Network error" };
  }
  const text = await resp.text();
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const d = JSON.parse(text) as { error?: { message?: string } | string };
      const em = typeof d.error === "string" ? d.error : d.error?.message;
      if (em) msg = String(em).slice(0, 400);
    } catch { msg = (text || msg).slice(0, 400); }
    return { ok: false, status: resp.status, message: msg };
  }
  let parsed: ChatResp;
  try { parsed = JSON.parse(text) as ChatResp; }
  catch { return { ok: false, status: 502, message: "Non-JSON response" }; }
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return { ok: false, status: 502, message: "Empty content" };
  }
  return { ok: true, text: content, usage: parsed.usage };
}

function classifyError(status: number, msg: string): { coolMs?: number; untilMidnight?: boolean; reason: "rpm" | "rpd" | "dead" | "5xx" | "other" } {
  if (status === 401 || status === 403) return { reason: "dead" };
  if (status === 429) {
    const lower = msg.toLowerCase();
    if (lower.includes("day") || lower.includes("quota") || lower.includes("daily")) {
      return { untilMidnight: true, reason: "rpd" };
    }
    return { coolMs: 60_000, reason: "rpm" };
  }
  if (status >= 500) return { coolMs: 120_000, reason: "5xx" };
  return { reason: "other" };
}

// Try EVERY non-cooling key of a single (provider, model) step before giving up.
// This is what keeps a task on its primary model: we only advance to the next
// chain step once the whole key pool is exhausted / cooling for that model.
async function tryStep(
  step: ChainStep,
  cfg: ProvidersConfig,
  body: { messages: Message[]; temperature: number; requireJson: boolean },
  attempts: AiBusyError["attempts"],
  task: string | undefined,
  maxKeys?: number,
): Promise<{ ok: true; text: string; keyHash: string; usage?: ChatUsage; ms: number } | { ok: false }> {
  const p = cfg[step.provider];
  if (!p || !p.enabled || p.keys.length === 0) return { ok: false };
  const budget = Math.max(1, Math.min(maxKeys ?? p.keys.length, p.keys.length));
  const tried = new Set<string>();
  for (let i = 0; i < budget; i++) {
    const picked = pickKeyForModel(step.provider, p.keys, step.model);
    if (!picked) return { ok: false };
    if (tried.has(picked.hash)) return { ok: false };
    tried.add(picked.hash);
    noteRequest(step.provider, picked.hash);
    const t0 = Date.now();
    const r = await callOnce(step.provider, picked.key, step.model, {
      messages: body.messages,
      temperature: body.temperature,
      requireJson: body.requireJson,
    });
    const ms = Date.now() - t0;
    if (r.ok) return { ok: true, text: r.text, keyHash: picked.hash, usage: r.usage, ms };
    const cls = classifyError(r.status, r.message);
    if (cls.untilMidnight) coolModelUntilUTCMidnight(step.provider, picked.hash, step.model, "rpd", r.message);
    else if (cls.coolMs && cls.reason !== "other") coolModel(step.provider, picked.hash, step.model, cls.coolMs, cls.reason, r.message);
    else if (cls.reason === "dead") cool(step.provider, picked.hash, 24 * 3600_000, "dead", r.message);
    attempts.push({
      provider: step.provider, model: step.model, keyHash: picked.hash,
      status: r.status, error: r.message,
    });
    console.warn(
      `[ai-router] step failed provider=${step.provider} model=${step.model} key=${picked.hash} status=${r.status} reason=${cls.reason} task=${task || "-"} msg=${r.message.slice(0, 200)}`,
    );
    // 4xx non-quota (e.g. model not found / bad request) — the key is fine, the
    // model isn't; no other key in the pool will behave differently.
    if (cls.reason === "other" && r.status >= 400 && r.status < 500) return { ok: false };
    // Quota / rate / dead / 5xx → cooled above, next iteration picks another key.
  }
  return { ok: false };
}


export async function routeRequest(opts: RouteTaskOpts): Promise<RouteResult> {
  const cfg = await loadProvidersConfig();
  const customChains = await loadCustomChains();
  const temperature = typeof opts.temperature === "number" ? opts.temperature : 0.3;
  const requireJson = !!opts.requireJson;
  const attempts: AiBusyError["attempts"] = [];

  // Explicit override — single-shot bypass.
  if (opts.override?.provider && opts.override?.model) {
    const p = cfg[opts.override.provider];
    if (p?.enabled && p.keys.length > 0) {
      const step = { provider: opts.override.provider, model: opts.override.model };
      const r = await tryStep(step, cfg, { messages: opts.messages, temperature, requireJson }, attempts, opts.task, 3);
      if (r.ok) {
        const est = estimateTokens(opts.messages, r.text);
        const tokensIn = r.usage?.prompt_tokens ?? est.tokensIn;
        const tokensOut = r.usage?.completion_tokens ?? est.tokensOut;
        const total = (r.usage?.total_tokens ?? tokensIn + tokensOut);
        bumpDailyCounter(step.provider, r.keyHash, total).catch(() => {});
        return { text: r.text, provider: step.provider, model: step.model, keyHash: r.keyHash, ms: r.ms, tokensIn, tokensOut };
      }
    }
  }

  const chain = resolveChain(opts.task, cfg, customChains);
  const startAll = Date.now();
  for (const step of chain) {
    // No maxKeys cap: every key in the pool is tried before the next model.
    const r = await tryStep(step, cfg, { messages: opts.messages, temperature, requireJson }, attempts, opts.task);

    if (r.ok) {
      const est = estimateTokens(opts.messages, r.text);
      const tokensIn = r.usage?.prompt_tokens ?? est.tokensIn;
      const tokensOut = r.usage?.completion_tokens ?? est.tokensOut;
      const total = (r.usage?.total_tokens ?? tokensIn + tokensOut);
      bumpDailyCounter(step.provider, r.keyHash, total).catch(() => {});
      return { text: r.text, provider: step.provider, model: step.model, keyHash: r.keyHash, ms: r.ms, tokensIn, tokensOut };
    }
  }

  const wait = Math.min(300, Math.max(30, Math.round((Date.now() - startAll) / 1000)));
  console.warn(
    `[ai-router] ALL CHAIN STEPS EXHAUSTED task=${opts.task || "-"} attempts=${JSON.stringify(attempts).slice(0, 800)}`,
  );
  throw new AiBusyError(
    "Our AI is a bit overloaded right now. Please try again in a moment.",
    wait,
    attempts,
  );
}

// Admin health checker — probe one chain step without cooling side-effects
// beyond real errors. Returns per-step detail.
export type ProbeStepResult = {
  provider: ProviderId;
  model: string;
  status: number;
  ok: boolean;
  ms: number;
  keyHash?: string;
  message?: string;
  skipped?: "no-key" | "disabled" | "cooling";
};

export async function probeChainStep(
  step: ChainStep,
  cfg: ProvidersConfig,
  probe: { messages: Message[]; requireJson: boolean; maxTokens: number },
): Promise<ProbeStepResult> {
  const p = cfg[step.provider];
  if (!p || !p.enabled) return { provider: step.provider, model: step.model, status: 0, ok: false, ms: 0, skipped: "disabled" };
  if (p.keys.length === 0) return { provider: step.provider, model: step.model, status: 0, ok: false, ms: 0, skipped: "no-key" };
  const picked = pickKeyForModel(step.provider, p.keys, step.model);
  if (!picked) return { provider: step.provider, model: step.model, status: 0, ok: false, ms: 0, skipped: "cooling" };
  noteRequest(step.provider, picked.hash);
  const t0 = Date.now();
  const r = await callOnce(step.provider, picked.key, step.model, {
    messages: probe.messages, temperature: 0, requireJson: probe.requireJson, maxTokens: probe.maxTokens,
  });
  const ms = Date.now() - t0;
  if (r.ok) return { provider: step.provider, model: step.model, status: 200, ok: true, ms, keyHash: picked.hash };
  const cls = classifyError(r.status, r.message);
  if (cls.untilMidnight) coolModelUntilUTCMidnight(step.provider, picked.hash, step.model, "rpd", r.message);
  else if (cls.coolMs && cls.reason !== "other") coolModel(step.provider, picked.hash, step.model, cls.coolMs, cls.reason, r.message);
  else if (cls.reason === "dead") cool(step.provider, picked.hash, 24 * 3600_000, "dead", r.message);
  return { provider: step.provider, model: step.model, status: r.status, ok: false, ms, keyHash: picked.hash, message: r.message };
}

export type RecentCall = {
  ts: number;
  task?: string;
  provider: string;
  model: string;
  keyHash: string;
  ok: boolean;
  ms: number;
  tokensIn?: number;
  tokensOut?: number;
  err?: string;
};

const RECENT_MAX = 100;
const recent: RecentCall[] = [];
export function logRecent(c: RecentCall) {
  recent.push(c);
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
}
export function getRecentCalls(): RecentCall[] {
  return recent.slice().reverse();
}
