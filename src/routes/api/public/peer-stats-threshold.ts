// Public endpoint to get peer stats threshold (no auth required)
import { createFileRoute } from "@tanstack/react-router";
import { loadPeerStatsSettings } from "@/lib/peer-stats-settings.server";
import { getCorsHeaders } from "@/lib/cors";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

export const Route = createFileRoute("/api/public/peer-stats-threshold")({
  server: {
    handlers: {
      async GET({ request }) {
        try {
          const cors = getCorsHeaders();
          const ip = getClientIp(request as unknown as Request);
          const rl = rateLimit(`peer-public:${ip}`, 60_000, 100);
          if (!rl.ok) return rateLimitResponse(rl.retryAfter, cors);

          const settings = await loadPeerStatsSettings();
          console.log("[peer-public] threshold:", settings.threshold);
          return json({ threshold: settings.threshold }, 200, cors);
        } catch (e) {
          console.error("[peer-public] error:", e);
          return json({ threshold: 50 }, 200, cors);
        }
      },
    },
  },
});
