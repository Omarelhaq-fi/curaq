// free-mode.js — OmNote is now fully free with a shared AI provider pool.
// This shim replaces the retired paywall scripts (quotas.js, subscription.js,
// plan-gate.js) so any legacy call from feature code still resolves without
// throwing. It also renders a friendly "AI is busy" toast when the router
// exhausts every free provider (503 { reason: "ai_busy" }).

(function () {
  // Hide any leftover paywall UI (topbar upgrade button, credit chips).
  const css = document.createElement("style");
  css.textContent = `
    #topbar-upgrade-btn, .topbar-upgrade-btn,
    #credits-pill, .credits-pill,
    #topbar-credits, .topbar-credits,
    .plan-badge-pro-only,
    #upgrade-modal, .paywall-modal { display: none !important; }
  `;
  document.head.appendChild(css);

  // ---- Legacy paywall API stubs ------------------------------------------
  const noop = () => {};
  const truthy = () => true;
  const emptyObj = () => ({});
  window.showUpgradeModal = noop;
  window.hideUpgradeModal = noop;
  window.openUpgradeModal = noop;
  window.checkFeatureAccess = truthy;         // was gated -> always allowed
  window.isPro = truthy;
  window.isUltimate = () => false;            // avoid unrelated "ultimate-only" tags
  window.getPlan = () => "free";
  window.getCredits = () => Infinity;
  window.getQuota = () => ({ unlimited: true, credits: Infinity });
  window.refreshQuota = noop;
  window.showLockToast = noop;
  window.showQuotaToast = noop;

  // ---- AI Busy toast ------------------------------------------------------
  // Wrap the low-level fetch used by ai-client so we can surface a single
  // friendly toast when every provider is at capacity.
  const origFetch = window.fetch.bind(window);
  let lastBusyToast = 0;
  function showBusyToast(msg, retryAfter) {
    const now = Date.now();
    if (now - lastBusyToast < 4000) return; // debounce
    lastBusyToast = now;
    let host = document.getElementById("omn-ai-busy-toast");
    if (!host) {
      host = document.createElement("div");
      host.id = "omn-ai-busy-toast";
      host.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;background:rgba(20,20,28,0.96);color:#fff;padding:14px 20px;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.08);max-width:420px;font-size:0.88rem;display:flex;gap:12px;align-items:center;backdrop-filter:blur(10px);";
      document.body.appendChild(host);
    }
    host.innerHTML = `
      <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#ef4444);display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i data-lucide="zap-off" style="width:16px;height:16px;color:#fff;"></i></div>
      <div style="flex:1;">
        <div style="font-weight:700;margin-bottom:2px;">AI is a bit busy</div>
        <div style="opacity:0.8;font-size:0.8rem;">${msg}${retryAfter ? ` Please try again in a moment.` : ""}</div>
      </div>
      <button onclick="this.parentElement.remove()" style="background:transparent;border:none;color:#fff;opacity:0.6;cursor:pointer;font-size:1.2rem;line-height:1;">×</button>
    `;
    host.style.opacity = "1";
    if (window.lucide && window.lucide.createIcons) { try { window.lucide.createIcons(); } catch (_) {} }
    setTimeout(() => { if (host && host.parentElement) host.remove(); }, 8000 + (retryAfter || 0) * 1000);
  }

  window.fetch = async function (input, init) {
    const resp = await origFetch(input, init);
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (resp.status === 503 && url.includes("/api/ai")) {
        const clone = resp.clone();
        clone.json().then((d) => {
          if (d && d.reason === "ai_busy") {
            showBusyToast(d.error || "Every free AI provider is at capacity.", d.retryAfter);
          }
        }).catch(() => {});
      }
    } catch (_) {}
    return resp;
  };
})();
