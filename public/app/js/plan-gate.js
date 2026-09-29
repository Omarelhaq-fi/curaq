// plan-gate.js — Free-tier limits for non-AI power features.
// Preview only for Free users; Pro/Ultimate unlock full functionality.
// Reads plan from window.userPlan (populated by subscription.js fetchQuotaStatus).
(function () {
  window.FREE_LIMITS = {
    whiteboardPages: 1,       // Free: single page only
    mindmapUserNodes: 5,      // Free: cap on hand-added nodes per doc
    mindmapAIGenerate: false, // Free: cannot AI-generate a mind map
    scheduleItems: 5,         // Free: cap on custom scheduled items
    examEvents: false,        // Free: no exam-type events
    radarInsight: false,      // Free: no AI weekly insight
    radarDrill: false,        // Free: preview only, no "Drill Today's 5"
    goalsEditable: false,     // Free: default targets, cannot customize
    pomoStats: false,         // Free: pomodoro works; stats view locked
    pomoSettings: false,      // Free: default pomodoro intervals only
  };

  window.getUserPlan = function () {
    return (window.userPlan || "free").toLowerCase();
  };
  window.isFreePlan = function () {
    const p = window.getUserPlan();
    return p !== "pro" && p !== "aplus" && p !== "ultimate";
  };
  window.isPaidPlan = function () { return !window.isFreePlan(); };

  // Small centred toast + auto-open upgrade modal.
  window.showLockedFeature = function (label, subtitle) {
    let host = document.getElementById("omn-lock-toast");
    if (!host) {
      host = document.createElement("div");
      host.id = "omn-lock-toast";
      host.style.cssText =
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);z-index:100002;opacity:0;transition:.3s;max-width:460px;width:calc(100% - 40px);";
      document.body.appendChild(host);
    }
    const sub = subtitle || "Become a Supporter or Supporter+ to unlock the full feature.";
    host.innerHTML = `
      <div style="background:linear-gradient(160deg,#0f172a,#1e293b);border:1px solid rgba(139,92,246,0.45);border-radius:14px;padding:14px 16px;box-shadow:0 20px 60px rgba(0,0,0,0.5);color:#f1f5f9;display:flex;align-items:center;gap:12px;">
        <div style="font-size:1.4rem;"><i data-lucide="lock"></i></div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:0.9rem;">${label} is a Supporter feature</div>
          <div style="color:#94a3b8;font-size:0.78rem;margin-top:2px;">${sub}</div>
        </div>
        <button onclick="window.showUpgradeModal && window.showUpgradeModal('pro_required');document.getElementById('omn-lock-toast').style.opacity=0;" style="background:linear-gradient(90deg,#06b6d4,#8b5cf6);border:none;color:#fff;padding:8px 14px;border-radius:10px;font-weight:700;font-size:0.78rem;cursor:pointer;white-space:nowrap;">Become a Supporter</button>
      </div>`;
    requestAnimationFrame(() => {
      host.style.opacity = "1";
      host.style.transform = "translateX(-50%) translateY(0)";
    });
    clearTimeout(window.__omnLockT);
    window.__omnLockT = setTimeout(() => {
      host.style.opacity = "0";
      host.style.transform = "translateX(-50%) translateY(20px)";
    }, 5000);
  };

  // Returns true when the user may perform the action; false when blocked.
  // opts: { current, limit, label, subtitle }
  window.gateFreeLimit = function (opts) {
    if (window.isPaidPlan()) return true;
    const { current = 0, limit, label = "This feature", subtitle } = opts || {};
    if (typeof limit === "number" && current < limit) return true;
    window.showLockedFeature(
      label,
      subtitle || `Free plan is limited to ${limit}. Become a Supporter for unlimited use.`,
    );
    return false;
  };

  // Hard gate: show locked message and block regardless of counts.
  window.gatePaidOnly = function (label, subtitle) {
    if (window.isPaidPlan()) return true;
    window.showLockedFeature(label, subtitle);
    return false;
  };

  // Full-panel locked overlay used in stats-style views.
  window.buildLockedPanel = function (title, subtitle, iconSvg) {
    return `
      <div style="max-width:520px;margin:80px auto;padding:32px;text-align:center;background:linear-gradient(160deg,rgba(15,23,42,0.6),rgba(30,41,59,0.6));border:1px solid rgba(139,92,246,0.35);border-radius:20px;color:#f1f5f9;">
        <div style="font-size:3rem;margin-bottom:12px;"><i data-lucide="lock"></i></div>
        <h2 style="margin:0 0 8px;font-size:1.4rem;font-weight:800;">${title}</h2>
        <p style="color:#94a3b8;font-size:0.92rem;margin:0 0 20px;line-height:1.5;">${subtitle}</p>
        <button onclick="window.showUpgradeModal && window.showUpgradeModal('pro_required')" style="background:linear-gradient(90deg,#06b6d4,#8b5cf6);border:none;color:#fff;padding:12px 24px;border-radius:12px;font-weight:700;font-size:0.9rem;cursor:pointer;box-shadow:0 8px 24px rgba(6,182,212,0.35);">Become a Supporter</button>
        <div style="margin-top:14px;color:#64748b;font-size:0.78rem;">Included in Supporter ($10/mo) & Supporter+ ($20/mo)</div>
      </div>`;
  };
})();
