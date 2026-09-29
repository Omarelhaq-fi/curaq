// Public (no-auth) listing of qbank metadata for the marketing landing page.
// Returns ONLY non-sensitive fields: name, country, kind, college, year.
import { createFileRoute } from "@tanstack/react-router";
import { getServiceAccount, getGoogleAccessToken } from "@/lib/firebase.server";
import { getQbankListCache, setQbankListCache } from "@/lib/qbank-cache.server";
import { getCorsHeaders } from "@/lib/cors";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";

function toPublicShape(banks: { id: string; name: string; country: string; kind: string; college: string; year: string }[]) {
  return {
    mains: banks.filter((b) => b.kind !== "exam_prep"),
    examPrep: banks.filter((b) => b.kind === "exam_prep"),
  };
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

export const Route = createFileRoute("/api/public/qbanks")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },
      GET: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, OPTIONS" });
        const ip = getClientIp(request);
        const rl = rateLimit(`public-qbanks:${ip}`, 60_000, 60);
        if (!rl.ok) return rateLimitResponse(rl.retryAfter, cors);

        try {
          // Shared publish-invalidated cache (0 reads when warm).
          const warm = getQbankListCache();
          if (warm) return json(toPublicShape(warm.banks), 200, cors);

          const sa = getServiceAccount();
          const token = await getGoogleAccessToken();

          const docs: any[] = [];
          let pageToken = "";
          while (true) {
            const params = new URLSearchParams({ pageSize: "300" });
            if (pageToken) params.set("pageToken", pageToken);
            const r = await fetch(
              `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks?${params}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!r.ok && r.status !== 404) return json({ error: "Failed to load banks" }, 500, cors);
            if (r.status === 404) break;
            const d = await r.json();
            for (const doc of d.documents || []) docs.push(doc);
            pageToken = d.nextPageToken || "";
            if (!pageToken) break;
          }

          const all = docs.map((doc) => {
            const updatedAtStr = doc.fields?.updatedAt?.integerValue || doc.fields?.updatedAt?.doubleValue;
            let resources: unknown[] = [];
            try { resources = JSON.parse(doc.fields?.resources?.stringValue || "[]"); } catch {}
            return {
              id: doc.name.split("/").pop(),
              name: doc.fields?.name?.stringValue || "(unnamed)",
              country: doc.fields?.country?.stringValue || "global",
              updatedAt: updatedAtStr ? parseInt(String(updatedAtStr), 10) : 0,
              isLocked: doc.fields?.isLocked?.booleanValue || false,
              isPartyLocked: doc.fields?.isPartyLocked?.booleanValue || false,
              resources,
              kind: doc.fields?.kind?.stringValue || "main",
              college: doc.fields?.college?.stringValue || "",
              year: doc.fields?.year?.stringValue || "",
            };
          });

          setQbankListCache(all);

          return json(toPublicShape(all), 200, cors);
        } catch (e: any) {
          console.error("[public-qbanks]", e?.message);
          return json({ error: "Server error" }, 500, cors);
        }
      },
    },
  },
});
