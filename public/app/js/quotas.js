// quotas.js — credit balance pill + upgrade nudge for the token-metered
// credit system. Reads from window.fetchQuotaStatus() which now returns
// { plan, credits, bonus, allotment, resetIso, featureCaps, featureUsage, ... }.
(function () {
  function planTone(plan) {
    if (plan === "aplus") return { grad: "linear-gradient(90deg,#f59e0b,#ef4444)", text: "#fff" };
    if (plan === "pro") return { grad: "linear-gradient(90deg,#06b6d4,#8b5cf6)", text: "#fff" };
    return { grad: "rgba(255,255,255,0.08)", text: "#e8ebff" };
  }

  window.planBadgeHTML = function (plan) {
    const raw = String(plan || "free").toLowerCase();
    const p = (raw === "supporter") ? "pro" : (raw === "supporter+" || raw === "ultimate") ? "aplus" : raw;
    const label = p === "aplus" ? "SUPPORTER+" : p === "pro" ? "SUPPORTER" : "FREE";
    const t = planTone(p);
    return `<span style="background:${t.grad};color:${t.text};padding:2px 9px;border-radius:999px;font-size:0.65rem;font-weight:800;letter-spacing:0.06em;">${label}</span>`;
  };

  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function resetLabel(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch (_) { return ""; }
  }

  // Compact "1,234 / 3,000 credits · resets Nov 1" pill. (Deprecated)
  window.creditPillHTML = function (status) {
    return "";
  };

  window.renderCreditPill = async function (target) {
    if (typeof window.fetchQuotaStatus !== "function") return;
    const s = await window.fetchQuotaStatus();
    if (!s) return;
    const el = typeof target === "string" ? document.getElementById(target) : target;
    if (!el) return;
    el.innerHTML = window.creditPillHTML(s);
  };

  // Legacy shims — old callers still reference these names.
  window.quotaChipHTML = function () { return ""; };
  window.renderQuotaChip = function () { return Promise.resolve(); };

  // -------- Compact soft credits chip next to the profile circle --------
  // Renders a tiny "★ 1,234" pill; click opens profile settings for full view.
  window.renderTopbarCreditChip = async function () {
    let s = null;
    if (typeof window.fetchQuotaStatus === "function") {
      s = await window.fetchQuotaStatus();
    }
    if (!s) {
       s = { plan: window.userPlan || "free" };
    }

    // Topbar plan badge — visible only for Supporter and Supporter+
    const topBadge = document.getElementById("topbar-plan-badge");
    const rawPlan = String(s.plan || "free").toLowerCase();
    const plan = (rawPlan === "supporter") ? "pro" : (rawPlan === "supporter+" || rawPlan === "ultimate") ? "aplus" : rawPlan;
    const isTop = plan === "aplus";
    if (topBadge) {
      if (plan === "free") {
        topBadge.style.display = "none";
      } else {
        topBadge.style.display = "flex";
        topBadge.innerHTML = window.planBadgeHTML(plan);
      }
    }

    const sbBtn = document.getElementById("sidebar-upgrade-btn");
    if (sbBtn) {
      if (isTop) {
        sbBtn.style.display = "none";
      } else {
        sbBtn.style.display = "flex";
        const label = sbBtn.querySelector(".nav-label");
        if (label) label.textContent = plan === "pro" ? "Supporter+" : "Become a Supporter";
        sbBtn.title = plan === "pro" ? "Supporter+" : "Become a Supporter";
      }
    }

    const dashBanner = document.getElementById("dashboard-supporter-banner");
    if (dashBanner) {
      if (isTop) {
        dashBanner.style.display = "none";
      } else {
        dashBanner.style.display = "flex";
        dashBanner.style.opacity = "1";
        const title = document.getElementById("dashboard-supporter-title");
        const desc = document.getElementById("dashboard-supporter-desc");
        const btnLabel = document.querySelector("#dashboard-supporter-btn .btn-label");
        if (plan === "pro") {
          if (title) title.textContent = "Upgrade to Supporter+";
          if (desc) desc.textContent = "Thank you for supporting OmNote! Upgrade to Supporter+ to unlock priority support and more.";
          if (btnLabel) btnLabel.textContent = "Supporter+";
        } else {
          if (title) title.textContent = "Keep OmNote Free";
          if (desc) desc.textContent = "OmNote is 100% free to use. Support the website to help keep our servers running and unlock exclusive features!";
          if (btnLabel) btnLabel.textContent = "Become a Supporter";
        }
      }
    }
  };

  // Feature-group label helper used by the toast.
  const FEATURE_LABELS = {
    chunk_plan: "Study Plan",
    summary: "Summaries",
    flashcards: "Flashcards",
    mcq: "MCQs / Exams",
    explain: "Explain",
    chat: "AI Tutor",
    insight: "Weekly Insight",
  };

  // Called by AI error interceptor when the user runs out of credits or
  // hits a Free-tier per-feature cap.
  window.showFeatureLimitToast = function (feature, plan, opts) {
    const raw = String(plan || "free").toLowerCase();
    const p = (raw === "supporter") ? "pro" : (raw === "supporter+" || raw === "ultimate") ? "aplus" : raw;
    const info = opts || {};
    const t = planTone(p);
    let toast = document.getElementById("omn-quota-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "omn-quota-toast";
      toast.style.cssText =
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);z-index:100002;opacity:0;transition:.3s;max-width:460px;width:calc(100% - 40px);";
      document.body.appendChild(toast);
    }
    const upgradeLabel = p === "aplus" ? "" : p === "pro" ? "Supporter+" : "Become a Supporter";
    const isCap = info.reason === "feature_cap_daily" || info.reason === "feature_cap_monthly";
    const featLabel = FEATURE_LABELS[feature] || info.featureLabel || feature || "This feature";
    const scope = info.reason === "feature_cap_daily" ? "today" : info.reason === "feature_cap_monthly" ? "this month" : "";
    const resetTxt = info.resetIso ? new Date(info.resetIso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    const title = isCap ? `Free limit reached for ${featLabel}` : "Out of AI credits";
    const sub = isCap
      ? `You've used ${scope}'s Free allowance (${info.cap || 0}). ${resetTxt ? "Resets " + resetTxt + ". " : ""}Supporter & Supporter+ have no per-feature limits.`
      : `Your ${window.planBadgeHTML(p)} monthly credits refresh next month.`;
    toast.innerHTML = `
      <div style="background:linear-gradient(160deg,#0f172a,#1e293b);border:1px solid rgba(6,182,212,0.4);border-radius:14px;padding:14px 16px;box-shadow:0 20px 60px rgba(0,0,0,0.5);color:#f1f5f9;display:flex;align-items:center;gap:12px;">
        <div style="font-size:1.4rem;"><i data-lucide="zap"></i></div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:0.9rem;">${title}</div>
          <div style="color:#94a3b8;font-size:0.78rem;margin-top:2px;">${sub}</div>
        </div>
        ${upgradeLabel ? `<button onclick="window.showUpgradeModal('${isCap ? "feature_cap" : "insufficient_credits"}');document.getElementById('omn-quota-toast').style.opacity=0;" style="background:${t.grad};border:none;color:#fff;padding:8px 14px;border-radius:10px;font-weight:700;font-size:0.78rem;cursor:pointer;white-space:nowrap;">${upgradeLabel}</button>` : ""}
      </div>`;
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateX(-50%) translateY(0)";
    });
    clearTimeout(window.__omnToastT);
    window.__omnToastT = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(-50%) translateY(20px)";
    }, 6500);
  };
})();

