// Daily AI spend cap — Firestore-backed so it holds across Worker isolates
// (the in-memory rate limiter in rate-limit.server.ts is per-isolate and can
// be multiplied by fan-out). One small doc per user per day:
//   ai_usage_daily/{uid}_{YYYY-MM-DD}  { count }
// Cost: 1 read per AI call (fail-open on errors), 1 write per successful
// call. Negligible next to provider inference cost/latency.
import { getServiceAccount, getGoogleAccessToken } from "./firebase.server";

export const AI_DAILY_MAX = 200;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function docId(uid: string): string {
  return `${uid}_${todayKey()}`;
}

export async function checkAiDailyUsage(
  uid: string,
  max: number = AI_DAILY_MAX,
): Promise<{ ok: true; used: number } | { ok: false; used: number }> {
  try {
    const sa = getServiceAccount();
    const token = await getGoogleAccessToken();
    const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/ai_usage_daily/${docId(uid)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) return { ok: true, used: 0 };
    if (!r.ok) return { ok: true, used: 0 }; // fail-open: never block legit use on transient errors
    const doc = await r.json();
    const used = Number(doc.fields?.count?.integerValue ?? doc.fields?.count?.doubleValue ?? 0);
    return used >= max ? { ok: false, used } : { ok: true, used };
  } catch {
    return { ok: true, used: 0 };
  }
}

// Fire-and-forget: call (without await) after a successful AI response.
export function bumpAiDailyUsage(uid: string): void {
  try {
    const sa = getServiceAccount();
    getGoogleAccessToken()
      .then((token) =>
        fetch(
          `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              writes: [
                {
                  update: {
                    name: `projects/${sa.project_id}/databases/(default)/documents/ai_usage_daily/${docId(uid)}`,
                    fields: { day: { stringValue: todayKey() } },
                  },
                  updateMask: { fieldPaths: ["day"] },
                },
                {
                  transform: {
                    document: `projects/${sa.project_id}/databases/(default)/documents/ai_usage_daily/${docId(uid)}`,
                    fieldTransforms: [{ fieldPath: "count", increment: { integerValue: "1" } }],
                  },
                },
              ],
            }),
          },
        ).catch((e) => console.warn("[ai-usage] bump failed:", (e as Error)?.message || e)),
      )
      .catch((e) => console.warn("[ai-usage] token failed:", (e as Error)?.message || e));
  } catch (e) {
    console.warn("[ai-usage]", (e as Error)?.message || e);
  }
}
