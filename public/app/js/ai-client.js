// AI proxy client — all API keys live server-side.
// window.aiCall({ provider, messages, model, requireJson, temperature })
// Returns the assistant string on success, or { _error: "..." } on failure
// (matching the legacy callGroqAPI contract used across the codebase).

(function () {
  async function getIdToken() {
    if (!window.firebase || !firebase.auth) throw new Error("Firebase not loaded");
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("Not signed in");
    return await user.getIdToken();
  }

  async function post(payload, maxRetries) {
    let token;
    try {
      token = await getIdToken();
    } catch (e) {
      return { _error: e.message || "Auth failed" };
    }

    if (window.adminAiOverride) {
      payload.overrideStep = window.adminAiOverride;
    }

    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const resp = await fetch("/api/ai", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
          body: JSON.stringify(payload),
        });
        let data = null;
        try { data = await resp.json(); } catch (_) {}

        if (resp.ok && data && typeof data.content === "string") {
          if (data.aiMeta && typeof window.showAdminAiDebug === "function") {
            window.showAdminAiDebug(data.aiMeta);
          }
          return data.content;
        }
        const errMsg = (data && data.error) || `HTTP ${resp.status}`;
        // Do NOT retry on 429 — the server already retries provider-side 429s
        // internally, so a 429 reaching us is a quota / rate-limit signal that
        // must surface to the user with its real message and reason.
        if (resp.status === 500 || resp.status === 502 || resp.status === 503) {
          // 503 with reason ai_busy = every free provider hit its limit.
          // Do NOT retry silently — bubble the friendly message straight up.
          const isAiBusy = data && data.reason === "ai_busy";
          if (isAiBusy) {
            return { _error: errMsg, _status: resp.status, _reason: "ai_busy", _retryAfter: data.retryAfter || 60 };
          }
          const backoff = Math.min(15000, Math.pow(2, attempt) * 800);
          console.warn(`AI proxy ${resp.status}, retry ${attempt + 1}/${maxRetries} in ${backoff}ms — ${errMsg}`);
          await new Promise((r) => setTimeout(r, backoff));
          attempt++;
          continue;
        }
        const out = { _error: errMsg, _status: resp.status };
        if (data && data.reason) out._reason = data.reason;
        if (data && data.feature) out._feature = data.feature;
        if (data && data.plan) out._plan = data.plan;
        if (data && data.scope) out._scope = data.scope;
        if (data && data.retryAfter) out._retryAfter = data.retryAfter;
        return out;

      } catch (e) {
        if (attempt >= maxRetries - 1) return { _error: e.message || "Network error" };
        await new Promise((r) => setTimeout(r, 1500));
        attempt++;
      }
    }
    return { _error: "AI request failed after retries" };
  }

  // Legacy: raw messages passthrough
  window.aiCall = function aiCall(opts) {
    const {
      provider = "gemini",
      messages,
      model,
      requireJson = false,
      temperature = 0.3,
      maxRetries = 6,
    } = opts || {};
    return post({ provider, messages, model, requireJson, temperature }, maxRetries);
  };

  // Preferred: task-based — prompts live server-side, client only sends variables.
  window.aiTask = function aiTask(task, vars, opts) {
    const { model, temperature = 0.3, maxRetries = 6, lang: langOverride } = opts || {};
    const lang = langOverride || (typeof window.getUserLanguage === "function" ? window.getUserLanguage() : null) || "en";
    return post({ task, vars: vars || {}, lang, model, temperature }, maxRetries);
  };
})();
