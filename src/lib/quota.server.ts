// Token-metered AI credit system + Free-tier per-feature daily/monthly caps.
//
// Every AI call debits credits after the provider responds:
//   credits = ceil(total_tokens / TOKENS_PER_CREDIT) * modelMultiplier
// with a floor of 1 credit per successful call.
//
// Free-tier users are ALSO gated by per-feature daily / monthly caps
// (whichever runs out first stops the action). Pro & Ultimate skip caps.

import { getGoogleAccessToken, getServiceAccount } from "./firebase.server";

export type Plan = "free" | "pro" | "aplus";

// Legacy re-exports.
export type Period = "day" | "week" | "month";
export type FeatureKey = string;
export type FeatureRule = { period: Period; limit: number };

export const TOKENS_PER_CREDIT = 1000;

export const DEFAULT_PLAN_CREDITS: Record<Plan, number> = {
  free: 200,
  pro: 3_000,
  aplus: 15_000,
};

export const DEFAULT_MODEL_MULTIPLIERS: Record<string, number> = {
  "gemini-3.1-flash-lite": 1.0,
  "gemini-2.5-flash-lite": 1.0,
  "gemini-2.5-flash": 3.0,
  "gemini-2.5-pro": 12.0,
  "llama-3.1-8b-instant": 0.5,
  "llama-3.3-70b-versatile": 2.0,
};

export type FeatureCap = { daily: number; monthly: number };
export const DEFAULT_FEATURE_CAPS: Record<Plan, Record<string, FeatureCap>> = {
  free: {
    chunk_plan:  { daily: 5,  monthly: 20 },
    summary:     { daily: 15, monthly: 60 },
    flashcards:  { daily: 8,  monthly: 30 },
    mcq:         { daily: 5,  monthly: 20 },
    explain:     { daily: 25, monthly: 120 },
    chat:        { daily: 20, monthly: 100 },
    insight:     { daily: 1,  monthly: 4 },
  },
  pro: {
    chunk_plan:  { daily: 50,  monthly: 500 },
    summary:     { daily: 50,  monthly: 500 },
    flashcards:  { daily: 50,  monthly: 500 },
    mcq:         { daily: 50,  monthly: 500 },
    explain:     { daily: 50,  monthly: 500 },
    chat:        { daily: 50,  monthly: 500 },
    insight:     { daily: 10,  monthly: 50 },
  },
  aplus: {
    chunk_plan:  { daily: 100, monthly: 1000 },
    summary:     { daily: 100, monthly: 1000 },
    flashcards:  { daily: 100, monthly: 1000 },
    mcq:         { daily: 100, monthly: 1000 },
    explain:     { daily: 100, monthly: 1000 },
    chat:        { daily: 100, monthly: 1000 },
    insight:     { daily: 20,  monthly: 100 },
  },
};

// ---------- Firestore REST helpers ----------
export type FSValue = {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  timestampValue?: string;
  nullValue?: null;
  mapValue?: { fields?: Record<string, FSValue> };
};
export type FSDoc = { fields?: Record<string, FSValue>; updateTime?: string };

export function toFieldsPatch(patch: Record<string, string | number | null>) {
  const out: Record<string, FSValue> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) out[k] = { nullValue: null };
    else if (typeof v === "number") out[k] = { integerValue: String(Math.floor(v)) };
    else out[k] = { stringValue: v };
  }
  return out;
}

export async function fsGetDoc(path: string): Promise<FSDoc | null> {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Firestore get ${path} failed: ${resp.status}`);
  return (await resp.json()) as FSDoc;
}

export type PatchResult =
  | { ok: true; updateTime?: string }
  | { ok: false; reason: "precondition" };

export async function fsPatchDoc(
  path: string,
  fields: Record<string, FSValue>,
  updateMask: string[],
  opts: { ifUpdateTime?: string } = {},
): Promise<PatchResult> {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  const mask = updateMask.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
  const precondition = opts.ifUpdateTime
    ? `&currentDocument.updateTime=${encodeURIComponent(opts.ifUpdateTime)}`
    : "";
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}?${mask}${precondition}`;
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (resp.status === 412 || resp.status === 409) return { ok: false, reason: "precondition" };
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Firestore patch ${path} failed: ${resp.status} ${t}`);
  }
  const data = (await resp.json()) as { updateTime?: string };
  return { ok: true, updateTime: data.updateTime };
}

// ---------- Time keys ----------
function pad(n: number) { return String(n).padStart(2, "0"); }
export function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}
export function dayKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function nextMonthResetIso(d = new Date()): string {
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toISOString();
}
export function nextDayResetIso(d = new Date()): string {
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return next.toISOString();
}
export function periodKey(_p: Period, d = new Date()): string {
  return monthKey(d);
}

// ---------- Admin config cache ----------
type CreditConfig = {
  plans: Record<Plan, number>;
  multipliers: Record<string, number>;
  featureCaps: Record<Plan, Record<string, FeatureCap>>;
};
let cfgCache: { at: number; cfg: CreditConfig } | null = null;

async function loadCreditConfig(): Promise<CreditConfig> {
  if (cfgCache && Date.now() - cfgCache.at < 30_000) return cfgCache.cfg;
  const merged: CreditConfig = {
    plans: { ...DEFAULT_PLAN_CREDITS },
    multipliers: { ...DEFAULT_MODEL_MULTIPLIERS },
    featureCaps: { 
      free: { ...DEFAULT_FEATURE_CAPS.free },
      pro: { ...DEFAULT_FEATURE_CAPS.pro },
      aplus: { ...DEFAULT_FEATURE_CAPS.aplus },
    },
  };
  try {
    const doc = await fsGetDoc("admin/credit_config");
    const plansRaw = doc?.fields?.plans?.stringValue;
    const multRaw = doc?.fields?.multipliers?.stringValue;
    const capsRaw = doc?.fields?.featureCaps?.stringValue;
    if (plansRaw) {
      const p = JSON.parse(plansRaw) as Partial<Record<Plan, number>>;
      for (const k of ["free", "pro", "aplus"] as Plan[]) {
        const val = p[k];
        if (typeof val === "number" && val >= 0) merged.plans[k] = Math.floor(val);
      }
    }
    if (multRaw) {
      const m = JSON.parse(multRaw) as Record<string, number>;
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === "number" && v > 0) merged.multipliers[k] = v;
      }
    }
    if (capsRaw) {
      const c = JSON.parse(capsRaw) as any;
      if (c && typeof c === "object") {
        if (c.free || c.pro || c.aplus) {
          // New nested format
          for (const plan of ["free", "pro", "aplus"] as Plan[]) {
            if (c[plan]) {
              for (const [k, v] of Object.entries(c[plan])) {
                if (v && typeof v === "object") {
                  const daily = Number((v as any).daily);
                  const monthly = Number((v as any).monthly);
                  if (Number.isFinite(daily) && Number.isFinite(monthly) && daily >= 0 && monthly >= 0) {
                    if (!merged.featureCaps[plan]) merged.featureCaps[plan] = {};
                    merged.featureCaps[plan][k] = { daily: Math.floor(daily), monthly: Math.floor(monthly) };
                  }
                }
              }
            }
          }
        } else {
          // Old flat format => map to 'free'
          for (const [k, v] of Object.entries(c)) {
            if (v && typeof v === "object") {
              const daily = Number((v as any).daily);
              const monthly = Number((v as any).monthly);
              if (Number.isFinite(daily) && Number.isFinite(monthly) && daily >= 0 && monthly >= 0) {
                if (!merged.featureCaps.free) merged.featureCaps.free = {};
                merged.featureCaps.free[k] = { daily: Math.floor(daily), monthly: Math.floor(monthly) };
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("loadCreditConfig failed, using defaults:", (e as Error).message);
  }
  cfgCache = { at: Date.now(), cfg: merged };
  return merged;
}

export async function readCreditConfig(): Promise<{ config: CreditConfig; defaults: CreditConfig }> {
  const config = await loadCreditConfig();
  return {
    config,
    defaults: {
      plans: { ...DEFAULT_PLAN_CREDITS },
      multipliers: { ...DEFAULT_MODEL_MULTIPLIERS },
      featureCaps: { ...DEFAULT_FEATURE_CAPS },
    },
  };
}

export async function writeCreditConfig(cfg: CreditConfig) {
  await fsPatchDoc(
    "admin/credit_config",
    toFieldsPatch({
      plans: JSON.stringify(cfg.plans),
      multipliers: JSON.stringify(cfg.multipliers),
      featureCaps: JSON.stringify(cfg.featureCaps || {}),
    }),
    ["plans", "multipliers", "featureCaps"],
  );
  cfgCache = null;
}

// Back-compat.
export async function readFeatureLimitsConfig() {
  return { limits: {}, defaults: {} };
}
export async function writeFeatureLimitsConfig(_l: unknown) { /* no-op */ }

// ---------- User state ----------
type FeatureUsage = Record<string, { dayKey: string; day: number; monthKey: string; month: number }>;

type State = {
  plan: Plan;
  proUntil: number;
  email: string;
  credits: number;
  creditsBonus: number;
  creditsMonthKey: string;
  creditsUsedThisMonth: number;
  featureUsage: FeatureUsage;
  featureUsageRaw: string;
};

function readState(doc: FSDoc | null): State {
  const f = doc?.fields || {};
  const rawPlan = (f.plan?.stringValue || "free") as Plan;
  const plan: Plan = rawPlan === "pro" || rawPlan === "aplus" ? rawPlan : "free";
  const proUntil = f.proUntil?.timestampValue ? new Date(f.proUntil.timestampValue).getTime() : 0;
  const rawCredits = f.credits?.integerValue;
  const rawUsage = f.featureUsage?.stringValue || "";
  let featureUsage: FeatureUsage = {};
  if (rawUsage) {
    try { featureUsage = JSON.parse(rawUsage) as FeatureUsage; }
    catch { featureUsage = {}; }
  }
  return {
    plan, proUntil,
    email: f.email?.stringValue || "",
    credits: rawCredits === undefined ? -1 : Number(rawCredits),
    creditsBonus: Number(f.creditsBonus?.integerValue || 0),
    creditsMonthKey: f.creditsMonthKey?.stringValue || "",
    creditsUsedThisMonth: Number(f.creditsUsedThisMonth?.integerValue || 0),
    featureUsage,
    featureUsageRaw: rawUsage,
  };
}

function effectivePlan(state: State): Plan {
  let p = state.plan;
  if ((p === "pro" || p === "aplus") && state.proUntil > 0 && state.proUntil < Date.now()) p = "free";
  return p;
}

function applyRefill(state: State, allotment: number, curMonth: string): {
  credits: number; monthKey: string; used: number;
} {
  if (state.creditsMonthKey !== curMonth || state.credits < 0) {
    return { credits: allotment, monthKey: curMonth, used: 0 };
  }
  return { credits: state.credits, monthKey: state.creditsMonthKey, used: state.creditsUsedThisMonth };
}

function rollUsage(entry: FeatureUsage[string] | undefined, curDay: string, curMonth: string) {
  const day = !entry || entry.dayKey !== curDay ? 0 : entry.day;
  const month = !entry || entry.monthKey !== curMonth ? 0 : entry.month;
  return { dayKey: curDay, day, monthKey: curMonth, month };
}

// ---------- Public API ----------
export type CreditStatus = {
  plan: Plan;
  credits: number;
  bonus: number;
  allotment: number;
  usedThisMonth: number;
  resetIso: string;
  proUntil: string | null;
  featureCaps: Record<string, FeatureCap>;
  featureUsage: Record<string, { day: number; month: number; dayResetIso: string; monthResetIso: string }>;
  used: number;
  limit: number;
};

export type CreditCheck =
  | { ok: true; plan: Plan; credits: number; bonus: number; allotment: number }
  | { ok: false; reason: "insufficient_credits"; plan: Plan; credits: number; bonus: number; allotment: number };

export async function checkCredits(uid: string, minCost = 1): Promise<CreditCheck> {
  const cfg = await loadCreditConfig();
  const doc = await fsGetDoc(`users_index/${uid}`);
  const state = readState(doc);
  const plan = effectivePlan(state);
  const allotment = cfg.plans[plan];
  const refill = applyRefill(state, allotment, monthKey());
  const total = refill.credits + state.creditsBonus;
  if (total < minCost) {
    return { ok: false, reason: "insufficient_credits", plan, credits: refill.credits, bonus: state.creditsBonus, allotment };
  }
  return { ok: true, plan, credits: refill.credits, bonus: state.creditsBonus, allotment };
}

export type FeatureCapCheck =
  | { ok: true }
  | { ok: false; reason: "feature_cap_daily" | "feature_cap_monthly"; feature: string; cap: number; used: number; resetIso: string };

// Per-feature caps evaluated for all plans.
export async function checkFeatureCap(uid: string, plan: Plan, group: string): Promise<FeatureCapCheck> {
  const cfg = await loadCreditConfig();
  const capsForPlan = cfg.featureCaps[plan] || {};
  const cap = capsForPlan[group];
  if (!cap) return { ok: true };
  const doc = await fsGetDoc(`users_index/${uid}`);
  const state = readState(doc);
  const rolled = rollUsage(state.featureUsage[group], dayKey(), monthKey());
  if (cap.daily > 0 && rolled.day >= cap.daily) {
    return { ok: false, reason: "feature_cap_daily", feature: group, cap: cap.daily, used: rolled.day, resetIso: nextDayResetIso() };
  }
  if (cap.monthly > 0 && rolled.month >= cap.monthly) {
    return { ok: false, reason: "feature_cap_monthly", feature: group, cap: cap.monthly, used: rolled.month, resetIso: nextMonthResetIso() };
  }
  return { ok: true };
}

// Increment a user's per-feature counters (all plans).
export async function incrementFeatureUsage(uid: string, plan: Plan, group: string): Promise<void> {
  const cfg = await loadCreditConfig();
  const capsForPlan = cfg.featureCaps[plan] || {};
  if (!capsForPlan[group]) return;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await fsGetDoc(`users_index/${uid}`);
    const state = readState(doc);
    const rolled = rollUsage(state.featureUsage[group], dayKey(), monthKey());
    rolled.day += 1;
    rolled.month += 1;
    const nextUsage = { ...state.featureUsage, [group]: rolled };
    try {
      const result = await fsPatchDoc(
        `users_index/${uid}`,
        toFieldsPatch({ featureUsage: JSON.stringify(nextUsage) }),
        ["featureUsage"],
        { ifUpdateTime: doc?.updateTime },
      );
      if (result.ok) return;
    } catch (e) { lastErr = e as Error; }
  }
  if (lastErr) console.warn("incrementFeatureUsage failed:", lastErr.message);
}

export function computeCreditCost(totalTokens: number, model: string | undefined, multipliers: Record<string, number>): number {
  const mult = (model && multipliers[model]) || 1.0;
  const raw = Math.ceil(Math.max(0, totalTokens) / TOKENS_PER_CREDIT) * mult;
  return Math.max(1, Math.ceil(raw));
}

export async function debitCredits(uid: string, email: string | undefined, cost: number): Promise<void> {
  if (cost <= 0) return;
  const cfg = await loadCreditConfig();
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await fsGetDoc(`users_index/${uid}`);
    const state = readState(doc);
    const plan = effectivePlan(state);
    const allotment = cfg.plans[plan];
    const refill = applyRefill(state, allotment, monthKey());

    let bonus = state.creditsBonus;
    let credits = refill.credits;
    let remaining = cost;
    if (bonus > 0) {
      const take = Math.min(bonus, remaining);
      bonus -= take; remaining -= take;
    }
    if (remaining > 0) credits = Math.max(0, credits - remaining);
    const used = refill.used + cost;

    const patch: Record<string, string | number | null> = {
      credits, creditsBonus: bonus,
      creditsMonthKey: refill.monthKey,
      creditsUsedThisMonth: used,
      creditsAllotment: allotment,
      lastSeenIso: new Date().toISOString(),
    };
    if (email && email !== state.email) patch.email = email;

    try {
      const result = await fsPatchDoc(
        `users_index/${uid}`,
        toFieldsPatch(patch),
        Object.keys(patch),
        { ifUpdateTime: doc?.updateTime },
      );
      if (result.ok) return;
    } catch (e) { lastErr = e as Error; }
  }
  throw lastErr || new Error("credit_write_conflict");
}

export async function grantBonusCredits(uid: string, amount: number): Promise<number> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await fsGetDoc(`users_index/${uid}`);
    const state = readState(doc);
    const next = Math.max(0, state.creditsBonus + Math.floor(amount));
    try {
      const result = await fsPatchDoc(
        `users_index/${uid}`,
        toFieldsPatch({ creditsBonus: next }),
        ["creditsBonus"],
        { ifUpdateTime: doc?.updateTime },
      );
      if (result.ok) return next;
    } catch (e) { lastErr = e as Error; }
  }
  throw lastErr || new Error("credit_write_conflict");
}

export async function resetUserCredits(uid: string): Promise<number> {
  const cfg = await loadCreditConfig();
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await fsGetDoc(`users_index/${uid}`);
    const state = readState(doc);
    const plan = effectivePlan(state);
    const allotment = cfg.plans[plan];
    try {
      const result = await fsPatchDoc(
        `users_index/${uid}`,
        toFieldsPatch({
          credits: allotment,
          creditsAllotment: allotment,
          creditsMonthKey: monthKey(),
          creditsUsedThisMonth: 0,
          featureUsage: "{}",
        }),
        ["credits", "creditsAllotment", "creditsMonthKey", "creditsUsedThisMonth", "featureUsage"],
        { ifUpdateTime: doc?.updateTime },
      );
      if (result.ok) return allotment;
    } catch (e) { lastErr = e as Error; }
  }
  throw lastErr || new Error("credit_write_conflict");
}

export async function getCreditStatus(uid: string): Promise<CreditStatus> {
  const cfg = await loadCreditConfig();
  const doc = await fsGetDoc(`users_index/${uid}`);
  const state = readState(doc);
  const plan = effectivePlan(state);
  const allotment = cfg.plans[plan];
  const refill = applyRefill(state, allotment, monthKey());
  const usage: CreditStatus["featureUsage"] = {};
  const capsForPlan = cfg.featureCaps[plan] || {};
  for (const group of Object.keys(capsForPlan)) {
    const rolled = rollUsage(state.featureUsage[group], dayKey(), monthKey());
    usage[group] = { day: rolled.day, month: rolled.month, dayResetIso: nextDayResetIso(), monthResetIso: nextMonthResetIso() };
  }
  
  return {
    plan,
    credits: refill.credits,
    bonus: state.creditsBonus,
    allotment,
    usedThisMonth: refill.used,
    resetIso: nextMonthResetIso(),
    proUntil: state.proUntil ? new Date(state.proUntil).toISOString() : null,
    featureCaps: capsForPlan,
    featureUsage: usage,
    used: refill.used,
    limit: allotment,
  };
}

export const getQuotaStatus = getCreditStatus;
