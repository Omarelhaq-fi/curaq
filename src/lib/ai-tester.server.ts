// Key tester — sends a 1-token ping to a specific provider+key and reports
// outcome. Used by the Admin Panel's "Test" button.

import { PROVIDER_META, type ProviderId } from "./ai-providers.server";

export type TestOutcome = "ok" | "invalid" | "rate_limited" | "network" | "server_error" | "not_found";

export type TestResult = {
  outcome: TestOutcome;
  status: number;
  ms: number;
  message?: string;
};

const KEY_TEST_MODELS: Partial<Record<ProviderId, string>> = {
  gemini: "gemini-flash-lite-latest",
  groq: "openai/gpt-oss-20b",
  openrouter: "openai/gpt-oss-20b:free",
  mistral: "ministral-3b-latest",
  nvidia: "meta/llama-3.1-8b-instruct",
  huggingface: "meta-llama/Llama-3.2-3B-Instruct:novita",
};

async function testKeyOnce(provider: ProviderId, key: string, model: string): Promise<TestResult> {
  const meta = PROVIDER_META[provider];
  const t0 = Date.now();
  let resp: Response;
  try {
    resp = await fetch(meta.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...meta.authHeader(key) },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        temperature: 0,
        max_tokens: 3,
      }),
    });
  } catch (e) {
    return { outcome: "network", status: 0, ms: Date.now() - t0, message: (e as Error).message };
  }
  const ms = Date.now() - t0;
  const text = await resp.text().catch(() => "");
  let msg = text.slice(0, 300);
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string };
    const em = typeof j.error === "string" ? j.error : j.error?.message;
    if (em) msg = String(em).slice(0, 300);
  } catch { /* ignore */ }
  if (resp.ok) return { outcome: "ok", status: resp.status, ms };
  if (resp.status === 401 || resp.status === 403) return { outcome: "invalid", status: resp.status, ms, message: msg };
  if (resp.status === 429) return { outcome: "rate_limited", status: resp.status, ms, message: msg };
  if (resp.status === 404) return { outcome: "not_found", status: resp.status, ms, message: msg };
  console.error(`[AI Tester] Server error for ${provider} / ${model}. Status: ${resp.status}, Body:`, msg);
  return { outcome: "server_error", status: resp.status, ms, message: msg };
}

export async function testKey(provider: ProviderId, key: string, model: string): Promise<TestResult> {
  const first = await testKeyOnce(provider, key, model);
  const fallbackModel = KEY_TEST_MODELS[provider];
  if (first.outcome !== "not_found" || !fallbackModel || fallbackModel === model) return first;

  const retry = await testKeyOnce(provider, key, fallbackModel);
  if (retry.outcome === "ok") {
    return {
      ...retry,
      message: `Key is valid. Saved model was not found (${model}); tested with ${fallbackModel}.`,
    };
  }
  return retry;
}
