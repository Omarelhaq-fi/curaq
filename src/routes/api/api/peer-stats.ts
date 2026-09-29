// Public (NO auth) peer answer aggregates, shared across ALL users via CDN.
//
// Why public: percentages are anonymous ({counts, total} — never uids) and
// byte-identical for everyone, so one cached copy serves the whole world:
// 1000 users opening the same question cost ~1 Firestore read/day/edge
// region instead of 1000 reads/min. Auth on this URL would fragment the
// cache per user and destroy the sharing — hence a separate route from the
// authed /api/qbank endpoints. No access check either: without the (gated)
// question content, anonymous percentages for an unguessable UUID are
// meaningless, and the questionId space is not enumerable (no listing).
// Client layers: memory 15 min -> IDB 3 days -> this endpoint -> edge cache
// -> origin (1 read). Origin is hit only on a cold edge or a question
// nobody opened in 24h.
import { createFileRoute } from "@tanstack/react-router";
import { getServiceAccount, getGoogleAccessToken, dbStats } from "@/lib/firebase.server";
import { getCorsHeaders } from "@/lib/cors";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";

export const Route = createFileRoute("/api/peer-stats")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },
      GET: async ({ request }) => {
        return dbStats.run({ reads: 0, writes: 0 }, async () => {
          const cors = getCorsHeaders(request, { methods: "GET, OPTIONS" });
          const ip = getClientIp(request);
          const rl = rateLimit(`peer-stats:${ip}`, 60_000, 120);
          if (!rl.ok) return rateLimitResponse(rl.retryAfter, cors);

          const qid = new URL(request.url).searchParams.get("qid") || "";
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(qid)) {
            return new Response(JSON.stringify({ error: "Invalid qid" }), {
              status: 400,
              headers: { "content-type": "application/json", ...cors },
            });
          }

          // Shared cache headers (overwrite the private no-store default
          // from getCorsHeaders): browsers revalidate after 60s, the edge
          // serves one copy per question for 24h. Client must NOT send
          // Authorization/AppCheck here — anything user-varying in the
          // request fragments the shared cache.
          const shared: Record<string, string> = {
            ...cors,
            "cache-control": "public, max-age=60, s-maxage=86400, stale-while-revalidate=3600",
          };

          try {
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            const r = await fetch(
              `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/questionStats/${qid}`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            const store = dbStats.getStore();
            const reads = store ? String(store.reads) : "0";
            if (!r.ok) {
              // No stats yet — cacheable empty shape (avoids a read per view
              // of unanswered questions too).
              return new Response(JSON.stringify({ userCounts: {}, total: 0 }), {
                status: 200,
                headers: { "content-type": "application/json", "x-firestore-reads": reads, ...shared },
              });
            }
            const doc = await r.json();
            const f = doc.fields || {};
            // userCounts wins; fill gaps from legacy `counts`. The users map
            // (uids of strangers) is NEVER sent to clients.
            const userCounts: Record<string, number> = {};
            const uc = f.userCounts?.mapValue?.fields || {};
            for (const [k, v] of Object.entries(uc)) {
              const n = parseInt((v as any)?.integerValue || "0", 10);
              if (Number.isFinite(n)) userCounts[k] = n;
            }
            const legacy = f.counts?.mapValue?.fields || {};
            for (const [k, v] of Object.entries(legacy)) {
              if (userCounts[k] === undefined) {
                const n = parseInt((v as any)?.integerValue || "0", 10);
                if (Number.isFinite(n)) userCounts[k] = n;
              }
            }
            let total = parseInt(f.total?.integerValue || "0", 10);
            if (!Number.isFinite(total) || total < 0) {
              total = Object.values(userCounts).reduce((a, b) => a + b, 0);
            }
            return new Response(JSON.stringify({ userCounts, total }), {
              status: 200,
              headers: { "content-type": "application/json", "x-firestore-reads": reads, ...shared },
            });
          } catch (e: any) {
            console.error("[peer-stats]", e?.message);
            return new Response(JSON.stringify({ error: "Server error" }), {
              status: 500,
              headers: { "content-type": "application/json", ...cors },
            });
          }
        });
      },
    },
  },
});
