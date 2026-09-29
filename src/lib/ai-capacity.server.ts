// AI Capacity — computes "% of total free-tier capacity used today" for the
// Admin Panel dashboard. Combines runtime state (cooldowns) + Firestore
// counters (persistent RPD/tokens) + static per-provider limits.

import {
  PROVIDER_META,
  hashKey,
  keyRuntimeSnapshot,
  loadProvidersConfig,
  readDailyCounter,
  type ProviderId,
} from "./ai-providers.server";

export type ProviderCapacity = {
  id: ProviderId;
  label: string;
  enabled: boolean;
  priority: number;
  keyCount: number;
  usableKeyCount: number;
  totalRpd: number;
  usedRpd: number;
  totalTokens: number | null;
  usedTokens: number;
  keys: Array<{
    hash: string;
    masked: string;
    rpdCap: number;
    rpdUsed: number;
    tokensUsed: number;
    rpm: number;
    coolUntil: number;
    coolReason?: string;
    lastError?: string;
    lastUsedAt?: number;
    dead: boolean;
  }>;
  models: Record<string, string>;
};

export type CapacitySnapshot = {
  day: string;
  totals: { rpd: number; tokens: number };
  totalRpdBudget: number;
  perProvider: ProviderCapacity[];
  alerts: Array<{ level: "info" | "warn" | "danger"; message: string }>;
};

function maskKey(k: string): string {
  if (!k) return "";
  if (k.length <= 12) return k;
  return k.slice(0, 6) + "…" + k.slice(-4);
}

function todayUTC(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function getCapacitySnapshot(): Promise<CapacitySnapshot> {
  const cfg = await loadProvidersConfig();
  const day = todayUTC();
  let counters: Awaited<ReturnType<typeof readDailyCounter>>;
  try {
    counters = await readDailyCounter(day);
  } catch {
    counters = { totals: { rpd: 0, tokens: 0 }, perProvider: {} };
  }

  const perProvider: ProviderCapacity[] = [];
  let totalRpdBudget = 0;
  const alerts: CapacitySnapshot["alerts"] = [];

  for (const [pid, p] of Object.entries(cfg) as Array<[ProviderId, typeof cfg.gemini]>) {
    const meta = PROVIDER_META[pid];
    const keyEntries = p.keys.map((k) => {
      const h = hashKey(k);
      const rt = keyRuntimeSnapshot(pid, h);
      const c = counters.perProvider[pid]?.keys?.[h] || { rpd: 0, tokens: 0 };
      // Per-key RPD cap uses model-specific budget when we can guess model role's model.
      const usedModel = p.models.volumeJson || p.models.chat;
      const rpdCap = (meta.rpdByModel && meta.rpdByModel[usedModel]) || meta.defaultRpd;
      return {
        hash: h,
        masked: maskKey(k),
        rpdCap,
        rpdUsed: c.rpd,
        tokensUsed: c.tokens,
        rpm: rt.rpm,
        coolUntil: rt.coolUntil,
        coolReason: rt.reason,
        lastError: rt.lastError,
        lastUsedAt: rt.lastUsedAt,
        dead: rt.reason === "dead" && rt.coolUntil > Date.now() + 12 * 3600_000,
      };
    });
    const totalRpd = keyEntries.reduce((s, k) => s + k.rpdCap, 0);
    const usableKeyCount = keyEntries.filter((k) => !k.dead && k.coolUntil <= Date.now()).length;
    const usedRpd = counters.perProvider[pid]?.totals?.rpd || 0;
    const usedTokens = counters.perProvider[pid]?.totals?.tokens || 0;
    totalRpdBudget += totalRpd;

    if (p.enabled) {
      if (p.keys.length === 0) {
        alerts.push({ level: "warn", message: `${meta.label}: no API keys in the pool.` });
      } else if (p.keys.length === 1) {
        alerts.push({ level: "info", message: `${meta.label}: only 1 key — add a backup for redundancy.` });
      }
      if (totalRpd > 0 && usedRpd / totalRpd >= 0.85) {
        alerts.push({ level: "danger", message: `${meta.label}: ${Math.round((usedRpd / totalRpd) * 100)}% of daily capacity used.` });
      }
      const deadCount = keyEntries.filter((k) => k.dead).length;
      if (deadCount > 0) {
        alerts.push({ level: "danger", message: `${meta.label}: ${deadCount} dead key(s) — remove or replace.` });
      }
    }

    perProvider.push({
      id: pid,
      label: meta.label,
      enabled: p.enabled,
      priority: p.priority,
      keyCount: p.keys.length,
      usableKeyCount,
      totalRpd,
      usedRpd,
      totalTokens: null,
      usedTokens,
      keys: keyEntries,
      models: p.models,
    });
  }

  perProvider.sort((a, b) => a.priority - b.priority);

  return {
    day,
    totals: counters.totals,
    totalRpdBudget,
    perProvider,
    alerts,
  };
}
