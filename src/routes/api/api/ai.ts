// AI proxy — free-for-all: no credits/quotas, ranked provider pool with
// automatic fallback via routeRequest.
//
// Request:  POST /api/ai { task, vars, lang } | { messages, provider?, model?, requireJson? } (admin only)
// Response: { content, provider, model, ms, tokensIn, tokensOut }
// Errors:   401/403 auth, 400 bad input, 503 { error, reason:"ai_busy", retryAfter }

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { verifyFirebaseIdToken } from "@/lib/firebase.server";
import { buildTaskRequest } from "@/lib/prompt-registry.server";
import { getCorsHeaders } from "@/lib/cors";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";
import { isAdminEmail } from "@/lib/admin.server";
import { loadAuthSettings } from "@/lib/auth-settings.server";
import { routeRequest, AiBusyError, logRecent } from "@/lib/ai-router.server";
import { loadProvidersConfig, loadCustomChains } from "@/lib/ai-providers.server";
import type { ProviderId } from "@/lib/ai-providers.server";
import { resolveChain } from "@/lib/task-chains.server";

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(200_000),
});
const AIRequestSchema = z.object({
  task: z.string().max(100).optional(),
  vars: z.record(z.string(), z.union([z.string().max(200_000), z.number(), z.boolean()])).optional(),
  lang: z.string().max(20).optional(),
  provider: z.enum(["gemini", "groq", "openrouter", "mistral", "huggingface", "nvidia"]).optional(),
  messages: z.array(MessageSchema).max(50).optional(),
  model: z.string().optional(),
  overrideStep: z.object({ provider: z.string(), model: z.string() }).optional(),
  temperature: z.number().min(0).max(2).optional(),
  requireJson: z.boolean().optional(),
});

export const Route = createFileRoute("/api/ai")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },
      GET: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });
        // Legacy "quota" probe — always return "unlimited" so old clients
        // that still poll it don't render a credits chip.
        const url = new URL(request.url);
        if (url.searchParams.get("action") === "quota") {
          return json(
            { plan: "free", unlimited: true, credits: 999_999, bonus: 0, allotment: 0 },
            200,
            cors,
          );
        }
        return json({ ok: true }, 200, cors);
      },
      POST: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, POST, OPTIONS" });

        const ip = getClientIp(request);
        const ipLimit = rateLimit(`ai:ip:${ip}`, 60_000, 60);
        if (!ipLimit.ok) return rateLimitResponse(ipLimit.retryAfter, cors);

        const authHeader = request.headers.get("authorization") || "";
        const m = authHeader.match(/^Bearer\s+(.+)$/i);
        if (!m) return json({ error: "Unauthorized" }, 401, cors);
        let user;
        try {
          user = await verifyFirebaseIdToken(m[1]);
        } catch (e) {
          console.warn("[ai] token verify failed:", (e as Error).message);
          return json({ error: "Unauthorized" }, 401, cors);
        }

        const isAdmin = await isAdminEmail(user.email);
        const authPolicy = await loadAuthSettings();
        if (!isAdmin && authPolicy.requireEmailVerification && user.email_verified === false) {
          return json({
            error: "Please verify your email address before using AI features. Check your inbox for the verification link (or resend it from your profile).",
            reason: "email_not_verified",
          }, 403, cors);
        }

        const userLimit = rateLimit(`ai:uid:${user.sub}`, 60_000, 30);
        if (!userLimit.ok) return rateLimitResponse(userLimit.retryAfter, cors);

        let raw: unknown;
        try { raw = await request.json(); }
        catch { return json({ error: "Bad request" }, 400, cors); }
        const parsed = AIRequestSchema.safeParse(raw);
        if (!parsed.success) {
          return json({ error: "Bad request", details: parsed.error.issues.slice(0, 3) }, 400, cors);
        }
        const body = parsed.data;

        const varsForBuild: Record<string, string> = {};
        if (body.vars) for (const [k, v] of Object.entries(body.vars)) varsForBuild[k] = String(v);

        let messages;
        let requireJson: boolean;
        let taskId: string | undefined;
        let preferProvider: ProviderId | undefined;

        if (body.task) {
          const built = buildTaskRequest(body.task, varsForBuild, body.lang);
          if (!built) return json({ error: "Bad request" }, 400, cors);
          messages = built.messages;
          requireJson = built.requireJson;
          taskId = body.task;
          // Prompt registry hints at a preferred provider (e.g. "groq" for
          // low-latency micro tasks) — router uses it as first-try only.
          preferProvider = built.provider as ProviderId;
        } else {
          // Raw passthrough — admin only.
          if (!isAdmin) return json({ error: "Forbidden" }, 403, cors);
          if (!Array.isArray(body.messages) || body.messages.length === 0) {
            return json({ error: "Bad request" }, 400, cors);
          }
          messages = body.messages;
          requireJson = !!body.requireJson;
          preferProvider = body.provider;
        }

        try {
          const r = await routeRequest({
            task: taskId,
            messages,
            requireJson,
            temperature: body.temperature,
            preferProvider,
            override: isAdmin && body.overrideStep ? { provider: body.overrideStep.provider as ProviderId, model: body.overrideStep.model } : undefined,
          });
          logRecent({
            ts: Date.now(),
            task: taskId,
            provider: r.provider,
            model: r.model,
            keyHash: r.keyHash,
            ok: true,
            ms: r.ms,
            tokensIn: r.tokensIn,
            tokensOut: r.tokensOut,
          });
          let chainInfo = undefined;
          if (isAdmin && taskId) {
            const cfg = await loadProvidersConfig();
            const custom = await loadCustomChains();
            chainInfo = resolveChain(taskId, cfg, custom);
          }

          return json(
            {
              content: r.text,
              provider: r.provider,
              model: r.model,
              ms: r.ms,
              tokensIn: r.tokensIn,
              tokensOut: r.tokensOut,
              aiMeta: isAdmin ? {
                task: taskId,
                provider: r.provider,
                model: r.model,
                ms: r.ms,
                chain: chainInfo,
              } : undefined,
            },
            200,
            cors,
          );
        } catch (e) {
          if (e instanceof AiBusyError) {
            logRecent({
              ts: Date.now(),
              task: taskId,
              provider: e.attempts[e.attempts.length - 1]?.provider || "none",
              model: "-",
              keyHash: "-",
              ok: false,
              ms: 0,
              err: "AI_BUSY",
            });
            const last = e.attempts[e.attempts.length - 1];
            console.warn(
              `[ai] ai_busy task=${taskId || "-"} attempts=${e.attempts.length} last=${last ? `${last.provider}/${last.status}:${last.error.slice(0, 200)}` : "none"}`,
            );
            return json(
              {
                error: e.message,
                reason: "ai_busy",
                retryAfter: e.retryAfter,
                attempts: e.attempts.length,
                debug: last ? { provider: last.provider, status: last.status, error: last.error.slice(0, 300) } : undefined,
              },
              503,
              cors,
            );
          }
          console.error("[ai] unexpected:", (e as Error).message);
          return json({ error: "Server error" }, 500, cors);
        }
      },
    },
  },
});
