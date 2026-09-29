// AI Providers registry — the source of truth for the multi-provider fallback pool.
// Provider configuration + per-key cooldown / counter state live here.
//
// Persistence layout in Firestore:
//   admin/ai_providers           → { providers: { <providerId>: { enabled, priority, keys[], models } } }
//   ai_counters/{YYYY-MM-DD}/providers/{providerId}
//                                → { <keyId>: { rpd, tokens, lastUsedAt, coolUntil } }
//
// Runtime state is kept in-memory per Worker instance (best effort — Workers are
// ephemeral, so we combine (a) in-memory RPM windows + cooldowns to protect the
// caller within a hot instance, and (b) persistent daily counters written to
// Firestore for the admin Capacity dashboard.

import { getServiceAccount, getGoogleAccessToken } from "./firebase.server";

export type ProviderId =
  | "gemini"
  | "groq"
  | "openrouter"
  | "mistral"
  | "nvidia"
  | "huggingface";

export type ModelRole = "volumeJson" | "longContext" | "micro" | "chat";

export type ProviderConfig = {
  enabled: boolean;
  priority: number;
  keys: string[];
  models: Record<ModelRole, string>;
};

export type ProvidersConfig = Record<ProviderId, ProviderConfig>;

export type ProviderMeta = {
  id: ProviderId;
  label: string;
  baseUrl: string;
  authHeader: (key: string) => Record<string, string>;
  /** Default per-key daily request budget when we don't know a per-model number. */
  defaultRpd: number;
  /** Per-model daily request budgets (per key). If missing, defaultRpd is used. */
  rpdByModel?: Record<string, number>;
  /** Per-model requests-per-minute limits (per key). Used as pre-flight guard. */
  rpmByModel?: Record<string, number>;
  defaultRpm: number;
  supportsJsonMode: boolean;
  /** Extra body fields to send with every request. */
  extraBody?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Static provider catalog

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
    defaultRpd: 250,
    rpdByModel: {
      // Free-tier per-key daily limits per Google AI docs (each model is an
      // independent bucket — a single key gives ~30k+ combined daily RPD).
      "gemini-flash-lite-latest": 500,        // Gemini 3.x flash-lite
      "gemini-3.1-flash-lite-preview": 500,
      "gemini-2.5-flash-lite": 1000,
      "gemini-2.5-flash": 250,
      "gemini-2.5-pro": 100,
      "gemini-2.0-flash": 200,
      "gemini-2.0-flash-lite": 200,
      "gemma-3-27b-it": 14_400,
      "gemma-3-12b-it": 14_400,
      "gemma-3-4b-it": 14_400,
    },
    rpmByModel: {
      "gemini-flash-lite-latest": 15,
      "gemini-3.1-flash-lite-preview": 15,
      "gemini-2.5-flash-lite": 15,
      "gemini-2.5-flash": 10,
      "gemini-2.5-pro": 5,
      "gemini-2.0-flash": 15,
      "gemini-2.0-flash-lite": 30,
      "gemma-3-27b-it": 30,
      "gemma-3-12b-it": 30,
      "gemma-3-4b-it": 30,
    },


    defaultRpm: 10,
    supportsJsonMode: true,
  },
  groq: {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
    defaultRpd: 14_400,
    defaultRpm: 30,
    supportsJsonMode: true,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter (:free models)",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    authHeader: (k) => ({
      Authorization: `Bearer ${k}`,
      "HTTP-Referer": "https://omnote.app",
      "X-Title": "OmNote",
    }),
    defaultRpd: 50,
    defaultRpm: 20,
    supportsJsonMode: true,
  },
  nvidia: {
    id: "nvidia",
    label: "Nvidia NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    defaultRpd: 1_000,
    defaultRpm: 60,
    supportsJsonMode: true,
  },
  mistral: {
    id: "mistral",
    label: "Mistral La Plateforme",
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
    defaultRpd: 100,
    defaultRpm: 30,
    supportsJsonMode: false, // free-tier reliability is spotty
  },
  huggingface: {
    id: "huggingface",
    label: "HuggingFace Inference",
    // Router endpoint; model IDs must be provider-scoped e.g. "meta-llama/Llama-3.3-70B-Instruct:novita".
    baseUrl: "https://router.huggingface.co/v1/chat/completions",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
    defaultRpd: 300,
    defaultRpm: 10,
    supportsJsonMode: false,
  },
};

// ---------------------------------------------------------------------------
// Default provider configuration used when the Firestore doc is missing/empty.

// Selectable model ids per provider — powers the admin dropdowns.
export const MODEL_CATALOG: Record<ProviderId, string[]> = {
  gemini: [
    "gemini-3.1-flash-lite-preview",
    "gemini-flash-lite-latest",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemma-3-27b-it",
    "gemma-3-12b-it",
    "gemma-3-4b-it",
  ],
  groq: [
    "openai/gpt-oss-20b",
    "qwen/qwen3.6-27b",
    "openai/gpt-oss-120b"
  ],
  openrouter: [
    "openai/gpt-oss-20b:free",
    "openai/gpt-oss-120b:free",
    "google/gemma-4-26b-a4b-it:free",
  ],
  nvidia: [
    "meta/llama-3.3-70b-instruct",
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.1-8b-instruct",
    "mistralai/mixtral-8x7b-instruct-v0.1",
    "mistralai/mistral-neotron",
    "deepseek-ai/deepseek-r1",
    "nvidia/nemotron-4-340b-instruct",
    "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    "qwen/qwen3.5-122b-a10b",
  ],
  mistral: [
    "ministral-3b-latest",
    "ministral-8b-latest",
    "mistral-small-latest",
    "mistral-large-latest",
    "open-mistral-nemo",
  ],
  huggingface: [
    "meta-llama/Llama-3.3-70B-Instruct:novita",
    "meta-llama/Llama-3.2-3B-Instruct:novita",
  ],
};

export function defaultProvidersConfig(): ProvidersConfig {
  return {
    gemini: {
      enabled: true,
      priority: 1,
      keys: [],
      models: {
        // Gemini 3.1 flash-lite is the primary model for every smart task.
        volumeJson: "gemini-3.1-flash-lite-preview",
        longContext: "gemini-3.1-flash-lite-preview",
        micro: "gemini-3.1-flash-lite-preview",
        chat: "gemini-3.1-flash-lite-preview",
      },
    },

    groq: {
      enabled: true,
      priority: 2,
      keys: [],
      models: {
        volumeJson: "openai/gpt-oss-20b",
        longContext: "openai/gpt-oss-120b",
        micro: "openai/gpt-oss-20b",
        chat: "qwen/qwen3.6-27b",
      },
    },
    openrouter: {
      enabled: false,
      priority: 3,
      keys: [],
      models: {
        volumeJson: "openai/gpt-oss-20b:free",
        longContext: "google/gemma-4-26b-a4b-it:free",
        micro: "openai/gpt-oss-20b:free",
        chat: "google/gemma-4-26b-a4b-it:free",
      },

    },
    nvidia: {
      enabled: true,
      priority: 6,
      keys: [],
      models: {
        chat: "meta/llama-3.3-70b-instruct",
        volumeJson: "meta/llama-3.1-8b-instruct",
      },
    },
    mistral: {
      enabled: false,
      priority: 6,
      keys: [],
      models: {
        volumeJson: "ministral-8b-latest",
        longContext: "open-mistral-nemo",
        micro: "ministral-3b-latest",
        chat: "ministral-8b-latest",
      },
    },
    huggingface: {
      enabled: false,
      priority: 7,
      keys: [],
      models: {
        // HF router requires "<repo>:<provider>" model IDs (novita, together, hyperbolic, etc.).
        volumeJson: "meta-llama/Llama-3.3-70B-Instruct:novita",
        longContext: "meta-llama/Llama-3.3-70B-Instruct:novita",
        micro: "meta-llama/Llama-3.2-3B-Instruct:novita",
        chat: "meta-llama/Llama-3.3-70B-Instruct:novita",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Firestore config load/save

let configCache: { data: ProvidersConfig; exp: number } | null = null;

type FSValue = {
  stringValue?: string;
  integerValue?: string;
  booleanValue?: boolean;
  arrayValue?: { values?: Array<{ stringValue?: string }> };
  mapValue?: { fields?: Record<string, FSValue> };
  nullValue?: null;
};

function unwrap(v: FSValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.arrayValue)
    return (v.arrayValue.values || []).map((x) => x.stringValue || "").filter(Boolean);
  if (v.mapValue) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = unwrap(val);
    return out;
  }
  return undefined;
}

function wrapString(s: string): FSValue { return { stringValue: s }; }
function wrapBool(b: boolean): FSValue { return { booleanValue: !!b }; }
function wrapInt(n: number): FSValue { return { integerValue: String(Math.floor(n)) }; }
function wrapArray(a: string[]): FSValue {
  return { arrayValue: { values: a.filter(Boolean).map((s) => ({ stringValue: String(s) })) } };
}
function wrapMap(m: Record<string, FSValue>): FSValue { return { mapValue: { fields: m } }; }

function providerToFS(p: ProviderConfig): FSValue {
  return wrapMap({
    enabled: wrapBool(p.enabled),
    priority: wrapInt(p.priority),
    keys: wrapArray(p.keys),
    models: wrapMap({
      volumeJson: wrapString(p.models.volumeJson || ""),
      longContext: wrapString(p.models.longContext || ""),
      micro: wrapString(p.models.micro || ""),
      chat: wrapString(p.models.chat || ""),
    }),
  });
}

async function fsGet(path: string): Promise<Record<string, FSValue> | null> {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Firestore get ${path} failed: ${resp.status}`);
  const doc = (await resp.json()) as { fields?: Record<string, FSValue> };
  return doc.fields || {};
}

async function fsPut(path: string, fields: Record<string, FSValue>): Promise<void> {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const keys = Object.keys(fields);
  const mask = keys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}${mask ? "?" + mask : ""}`;
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) {
    console.error(`Firestore put ${path} failed: ${resp.status} ${await resp.text()}`);
    throw new Error(`Firestore put ${path} failed: ${resp.status}`);
  }
}

// Merge stored config onto defaults so newly-added providers show up automatically.
const STALE_OPENROUTER_MODELS = new Set([
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat-v3.1:free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "inclusionai/ling-3.0-flash:free",
]);


function normalizeStoredModel(providerId: ProviderId, value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (providerId === "openrouter" && STALE_OPENROUTER_MODELS.has(value)) return fallback;
  return value;
}

function mergeConfig(stored: Partial<ProvidersConfig> | null): ProvidersConfig {
  const base = defaultProvidersConfig();
  if (!stored) return base;
  const out = { ...base } as ProvidersConfig;
  for (const id of Object.keys(base) as ProviderId[]) {
    const s = stored[id];
    if (!s) continue;
    out[id] = {
      enabled: typeof s.enabled === "boolean" ? s.enabled : base[id].enabled,
      priority: typeof s.priority === "number" ? s.priority : base[id].priority,
      keys: Array.isArray(s.keys) ? s.keys.filter((k) => typeof k === "string" && k.length > 6) : [],
      models: {
        volumeJson: normalizeStoredModel(id, s.models?.volumeJson, base[id].models.volumeJson),
        longContext: normalizeStoredModel(id, s.models?.longContext, base[id].models.longContext),
        micro: normalizeStoredModel(id, s.models?.micro, base[id].models.micro),
        chat: normalizeStoredModel(id, s.models?.chat, base[id].models.chat),
      },
    };
  }
  return out;
}

async function migrateFromLegacyKeys(): Promise<ProvidersConfig | null> {
  // Bootstrap from the legacy admin/api_keys doc when the new doc is empty.
  try {
    const legacy = await fsGet("admin/api_keys");
    if (!legacy) return null;
    const g = unwrap(legacy.gemini) as string[] | undefined;
    const gq = unwrap(legacy.groq);
    const groqKeys = Array.isArray(gq) ? (gq as string[]) : typeof gq === "string" ? [gq] : [];
    const geminiKeys = Array.isArray(g) ? g : [];
    if (geminiKeys.length === 0 && groqKeys.length === 0) return null;
    const cfg = defaultProvidersConfig();
    cfg.gemini.keys = geminiKeys;
    cfg.groq.keys = groqKeys;
    return cfg;
  } catch {
    return null;
  }
}

export async function loadProvidersConfig(force = false): Promise<ProvidersConfig> {
  const now = Date.now();
  if (!force && configCache && configCache.exp > now) return configCache.data;
  const fields = await fsGet("admin/ai_providers");
  let stored: Partial<ProvidersConfig> | null = null;
  if (fields) {
    const p = unwrap(fields.providers);
    if (p && typeof p === "object") stored = p as Partial<ProvidersConfig>;
  }
  let cfg: ProvidersConfig;
  if (!stored) {
    // Attempt one-time migration from legacy admin/api_keys.
    const migrated = await migrateFromLegacyKeys();
    cfg = migrated || defaultProvidersConfig();
    // Persist so future reads don't repeat the migration.
    if (migrated) {
      try { await saveProvidersConfig(cfg); } catch (e) {
        console.warn("[ai-providers] migration write failed:", (e as Error).message);
      }
    }
  } else {
    cfg = mergeConfig(stored);
  }
  configCache = { data: cfg, exp: now + 30_000 };
  return cfg;
}

export async function saveProvidersConfig(cfg: ProvidersConfig): Promise<void> {
  const providersMap: Record<string, FSValue> = {};
  for (const [id, p] of Object.entries(cfg)) providersMap[id] = providerToFS(p as ProviderConfig);
  await fsPut("admin/ai_providers", { providers: wrapMap(providersMap) });
  configCache = null;
}

export function invalidateProvidersCache(): void {
  configCache = null;
}

// ---------------------------------------------------------------------------
// Custom Fallback Chains Config load/save

export type ChainStepConfig = { provider: ProviderId; model: string };
export type CustomChainsConfig = Record<string, ChainStepConfig[]>; // task -> chain

let customChainsCache: { data: CustomChainsConfig; exp: number } | null = null;

export async function loadCustomChains(force = false): Promise<CustomChainsConfig> {
  const now = Date.now();
  if (!force && customChainsCache && customChainsCache.exp > now) return customChainsCache.data;
  const doc = await fsGet("admin/ai_chains");
  const chains: CustomChainsConfig = {};
  if (doc && doc.chains && doc.chains.mapValue) {
    const fields = doc.chains.mapValue.fields || {};
    for (const [task, v] of Object.entries(fields)) {
      if (v.arrayValue) {
        chains[task] = (v.arrayValue.values || []).map((x) => {
          if (x.mapValue) {
             const f = x.mapValue.fields || {};
             return {
               provider: (f.provider?.stringValue || "gemini") as ProviderId,
               model: f.model?.stringValue || "",
             };
          }
          return null as any;
        }).filter(s => s && s.model);
      }
    }
  }
  customChainsCache = { data: chains, exp: now + 30_000 };
  return chains;
}

export async function saveCustomChains(chains: CustomChainsConfig): Promise<void> {
  const fields: Record<string, FSValue> = {};
  for (const [task, steps] of Object.entries(chains)) {
     fields[task] = {
       arrayValue: {
         values: steps.map(s => wrapMap({
           provider: wrapString(s.provider),
           model: wrapString(s.model)
         }))
       }
     };
  }
  await fsPut("admin/ai_chains", { chains: wrapMap(fields) });
  customChainsCache = null;
}

// ---------------------------------------------------------------------------
// In-memory runtime state: cooldowns + RPM windows per key.
// Keyed by `${providerId}:${keyIndex}` (index in current pool).

type KeyRuntime = {
  coolUntil: number;
  reason?: "rpm" | "rpd" | "dead" | "5xx";
  rpmWindow: number[]; // timestamps of recent requests (< 60s)
  lastError?: string;
  lastUsedAt?: number;
};

const runtime = new Map<string, KeyRuntime>();

// Per-(key, model) cooldowns — a model exhausting its RPD doesn't take the
// whole key offline; other models on the same key stay usable.
type ModelRuntime = { coolUntil: number; reason?: KeyRuntime["reason"]; lastError?: string };
const modelRuntime = new Map<string, ModelRuntime>();

function runtimeKey(provider: ProviderId, keyHash: string): string {
  return `${provider}:${keyHash}`;
}
function modelRuntimeKey(provider: ProviderId, keyHash: string, model: string): string {
  return `${provider}:${keyHash}:${model}`;
}

// Small deterministic key hash so we can identify keys without leaking secrets.
export function hashKey(k: string): string {
  let h = 5381;
  for (let i = 0; i < k.length; i++) h = ((h << 5) + h + k.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function getRuntime(provider: ProviderId, keyHash: string): KeyRuntime {
  const k = runtimeKey(provider, keyHash);
  let rt = runtime.get(k);
  if (!rt) {
    rt = { coolUntil: 0, rpmWindow: [] };
    runtime.set(k, rt);
  }
  return rt;
}

export function isKeyCooling(provider: ProviderId, keyHash: string): boolean {
  const rt = getRuntime(provider, keyHash);
  return rt.coolUntil > Date.now();
}

export function isModelCooling(provider: ProviderId, keyHash: string, model: string): boolean {
  const mk = modelRuntime.get(modelRuntimeKey(provider, keyHash, model));
  return !!mk && mk.coolUntil > Date.now();
}

export function coolModel(
  provider: ProviderId,
  keyHash: string,
  model: string,
  ms: number,
  reason: KeyRuntime["reason"],
  errMsg?: string,
): void {
  modelRuntime.set(modelRuntimeKey(provider, keyHash, model), {
    coolUntil: Date.now() + ms,
    reason,
    lastError: errMsg ? errMsg.slice(0, 300) : undefined,
  });
}

export function coolModelUntilUTCMidnight(
  provider: ProviderId,
  keyHash: string,
  model: string,
  reason: KeyRuntime["reason"],
  errMsg?: string,
): void {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5,
  ));
  coolModel(provider, keyHash, model, tomorrow.getTime() - now.getTime(), reason, errMsg);
}

export function keyRuntimeSnapshot(provider: ProviderId, keyHash: string): {
  coolUntil: number;
  reason?: string;
  rpm: number;
  lastError?: string;
  lastUsedAt?: number;
} {
  const rt = getRuntime(provider, keyHash);
  const cutoff = Date.now() - 60_000;
  rt.rpmWindow = rt.rpmWindow.filter((t) => t > cutoff);
  return {
    coolUntil: rt.coolUntil,
    reason: rt.reason,
    rpm: rt.rpmWindow.length,
    lastError: rt.lastError,
    lastUsedAt: rt.lastUsedAt,
  };
}

/**
 * Mark a request as issued for RPM tracking.
 */
export function noteRequest(provider: ProviderId, keyHash: string): void {
  const rt = getRuntime(provider, keyHash);
  const now = Date.now();
  rt.lastUsedAt = now;
  rt.rpmWindow.push(now);
  const cutoff = now - 60_000;
  rt.rpmWindow = rt.rpmWindow.filter((t) => t > cutoff);
}

export function cool(
  provider: ProviderId,
  keyHash: string,
  ms: number,
  reason: KeyRuntime["reason"],
  errMsg?: string,
): void {
  const rt = getRuntime(provider, keyHash);
  rt.coolUntil = Date.now() + ms;
  rt.reason = reason;
  if (errMsg) rt.lastError = errMsg.slice(0, 300);
}

/** Cool until the next UTC midnight. */

export function coolUntilUTCMidnight(
  provider: ProviderId,
  keyHash: string,
  reason: KeyRuntime["reason"],
  errMsg?: string,
): void {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5,
  ));
  cool(provider, keyHash, tomorrow.getTime() - now.getTime(), reason, errMsg);
}

// ---------------------------------------------------------------------------
// Daily counters (Firestore-persisted, one write per successful call).

function todayUTC(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Fire-and-forget increment of {provider}/{keyHash}/rpd + tokens. Non-blocking. */
export async function bumpDailyCounter(
  provider: ProviderId,
  keyHash: string,
  tokens: number,
): Promise<void> {
  const day = todayUTC();
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  // Use commit with FieldTransform 'increment' — atomic, cheap.
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`;
  const docPath = `projects/${sa.project_id}/databases/(default)/documents/ai_counters/${day}/providers/${provider}`;
  const body = {
    writes: [
      {
        transform: {
          document: docPath,
          fieldTransforms: [
            {
              fieldPath: `keys.${keyHash}.rpd`,
              increment: { integerValue: "1" },
            },
            {
              fieldPath: `keys.${keyHash}.tokens`,
              increment: { integerValue: String(Math.max(0, Math.floor(tokens))) },
            },
            {
              fieldPath: `totals.rpd`,
              increment: { integerValue: "1" },
            },
            {
              fieldPath: `totals.tokens`,
              increment: { integerValue: String(Math.max(0, Math.floor(tokens))) },
            },
          ],
        },
      },
    ],
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`bumpDailyCounter failed ${resp.status}: ${t.slice(0, 200)}`);
  }
}

export async function readDailyCounter(
  day: string = todayUTC(),
): Promise<{
  totals: { rpd: number; tokens: number };
  perProvider: Record<string, {
    totals: { rpd: number; tokens: number };
    keys: Record<string, { rpd: number; tokens: number }>;
  }>;
}> {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/ai_counters/${day}/providers`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const out: Record<string, {
    totals: { rpd: number; tokens: number };
    keys: Record<string, { rpd: number; tokens: number }>;
  }> = {};
  const totals = { rpd: 0, tokens: 0 };
  if (resp.status === 404 || !resp.ok) return { totals, perProvider: out };
  const data = (await resp.json()) as {
    documents?: Array<{ name: string; fields?: Record<string, FSValue> }>;
  };
  for (const d of data.documents || []) {
    const pid = d.name.split("/").pop() || "";
    const f = d.fields || {};
    const t = (unwrap(f.totals) as { rpd?: number; tokens?: number } | undefined) || {};
    const rpd = Number(t.rpd || 0);
    const tokens = Number(t.tokens || 0);
    totals.rpd += rpd;
    totals.tokens += tokens;
    const keysMap = (unwrap(f.keys) as Record<string, { rpd?: number; tokens?: number }> | undefined) || {};
    const keys: Record<string, { rpd: number; tokens: number }> = {};
    for (const [kh, v] of Object.entries(keysMap)) {
      keys[kh] = { rpd: Number(v.rpd || 0), tokens: Number(v.tokens || 0) };
    }
    out[pid] = { totals: { rpd, tokens }, keys };
  }
  return { totals, perProvider: out };
}
