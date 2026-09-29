// Subscription UI — credit balance, Kashier checkout, and hooks.
// Reads status from /api/ai?action=quota using current user's ID token.

(function () {
  let cachedStatus = null;
  let lastFetch = 0;
  let cachedQuote = null;
  let quoteAt = 0;
  let quoteCurrency = null; // user override; null = auto


  async function idToken() {
    if (!window.firebase || !firebase.auth) return null;
    const u = firebase.auth().currentUser;
    if (!u) return null;
    return await u.getIdToken();
  }

  window.fetchQuotaStatus = async function (force) {
    const now = Date.now();
    if (!force && cachedStatus && now - lastFetch < 15000) return cachedStatus;
    
    let plan = "free";
    try {
      const user = window.firebase && firebase.auth && firebase.auth().currentUser;
      if (user) {
        let data = null, exists = false;
        if (window.getUsersIndexDoc) {
          const rec = await window.getUsersIndexDoc(user.uid);
          exists = rec.exists; data = rec.data;
        } else {
          const snap = await firebase.firestore().collection('users_index').doc(user.uid).get();
          exists = snap.exists; data = exists ? snap.data() : null;
        }
        if (exists) {
          if (data && data.plan) plan = data.plan;
          else if (data && data.data) {
             try { const p = JSON.parse(data.data); if (p.plan) plan = p.plan; } catch(e) {}
          }
        }
      }
    } catch (err) {
      console.warn("Failed to fetch plan from Firestore", err);
    }

    const quota = { plan: plan, credits: 0, allotment: 1 };
    cachedStatus = quota;
    lastFetch = now;
    window.userPlan = plan;
    return cachedStatus;
  };

  window.invalidateQuotaCache = function () {
    cachedStatus = null;
    lastFetch = 0;
  };

  // ---------- Pricing quote ----------
  async function fetchQuote(force) {
    const now = Date.now();
    if (!force && cachedQuote && now - quoteAt < 60_000) return cachedQuote;
    let qs = "?action=quote";
    if (quoteCurrency) {
      qs += "&currency=" + quoteCurrency;
    } else {
      try {
        if (Intl.DateTimeFormat().resolvedOptions().timeZone === "Africa/Cairo") {
          qs += "&currency=EGP";
        }
      } catch(e) {}
    }
    try {
      const r = await fetch("/api/kashier" + qs);
      if (!r.ok) return null;
      cachedQuote = await r.json();
      quoteAt = now;
      return cachedQuote;
    } catch { return null; }
  }
  window.fetchKashierQuote = fetchQuote;

  window.setPreferredCurrency = async function (cur) {
    quoteCurrency = cur === "EGP" || cur === "USD" ? cur : null;
    cachedQuote = null;
    if (document.getElementById("upgrade-modal")) await renderUpgradeModal();
  };

  // ---------- Upgrade modal ----------
  function planCardHTML(plan, price, extras) {
    const isPop = plan === "pro";
    const isBest = plan === "aplus";
    const accent = plan === "free"
      ? { border: "rgba(255,255,255,0.08)", bg: "rgba(255,255,255,0.03)", label: "#94a3b8" }
      : plan === "pro"
        ? { border: "rgba(6,182,212,0.45)", bg: "linear-gradient(160deg,rgba(6,182,212,0.15),rgba(139,92,246,0.15))", label: "#67e8f9" }
        : { border: "rgba(245,158,11,0.55)", bg: "linear-gradient(160deg,rgba(245,158,11,0.18),rgba(244,63,94,0.12))", label: "#fbbf24" };
    const badge = isPop
      ? '<div style="position:absolute;top:-10px;right:12px;background:#06b6d4;color:#fff;padding:2px 10px;border-radius:999px;font-size:0.62rem;font-weight:800;">POPULAR</div>'
      : isBest
        ? '<div style="position:absolute;top:-10px;right:12px;background:linear-gradient(90deg,#f59e0b,#ef4444);color:#fff;padding:2px 10px;border-radius:999px;font-size:0.62rem;font-weight:800;">BEST VALUE</div>'
        : "";
    let cta = "";
    if (plan !== "free") {
      const isCurrent = window.userPlan === plan || (window.userPlan === "aplus" && plan === "pro");
      if (isCurrent) {
        cta = `<div style="text-align:center;width:100%;margin-top:14px;padding:11px;font-weight:800;font-size:0.9rem;color:#94a3b8;border:1px solid rgba(255,255,255,0.1);border-radius:10px;">Current Plan</div>`;
      } else {
        cta = `<button onclick="window.startKashierCheckout('${plan}')" style="width:100%;margin-top:14px;background:${plan === "pro" ? "linear-gradient(90deg,#06b6d4,#8b5cf6)" : "linear-gradient(90deg,#f59e0b,#ef4444)"};border:none;color:#fff;padding:11px;border-radius:10px;font-weight:800;font-size:0.9rem;cursor:pointer;">Upgrade to ${price.planLabel}</button>`;
      }
    }
    return `
      <div style="padding:18px;border-radius:14px;background:${accent.bg};border:1px solid ${accent.border};position:relative;">
        ${badge}
        <div style="color:${accent.label};font-size:0.72rem;text-transform:uppercase;letter-spacing:0.08em;font-weight:800;">${price.planLabel}</div>
        <div style="font-size:1.6rem;font-weight:800;margin:6px 0 4px;">${price.priceLabel}</div>
        <ul style="list-style:none;padding:0;margin:0;font-size:0.83rem;color:#e2e8f0;line-height:1.9;">${extras}</ul>
        ${cta}
      </div>`;
  }

  async function renderUpgradeModal(reason) {
    ensureUpgradeModal();
    const box = document.getElementById("upgrade-cards");
    if (!box) return;
    const q = await fetchQuote(true);
    const priceFree = { planLabel: "Free", priceLabel: "$0", creditsLabel: "200 credits / month" };
    const priceForPlan = (plan) => {
      if (!q || !q[plan]) return { planLabel: plan === "pro" ? "Supporter" : "Supporter+", priceLabel: plan === "pro" ? "$10/mo" : "$20/mo", creditsLabel: (plan === "pro" ? "3,000" : "15,000") + " credits / month" };
      return {
        planLabel: q[plan].planLabel,
        priceLabel: q[plan].label,
        creditsLabel: Number(q[plan].credits).toLocaleString() + " credits / month",
      };
    };
    const cur = (q && q.currency) || "USD";
    const notice = !q || q.configured === false
      ? '<div style="margin-top:14px;padding:12px 14px;border-radius:10px;background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.35);color:#fcd34d;font-size:0.8rem;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;">Payments are being set up. Open a ticket and we\'ll upgrade you manually.<button onclick="var m=document.getElementById(\'upgrade-modal\');if(m)m.style.display=\'none\';window.openSupportNewTicket && window.openSupportNewTicket({category:\'payment\', subject:\'Payment / Upgrade request\', message:\'Hi, I\\\'d like to upgrade my plan. Please help me complete payment.\'});" style="background:linear-gradient(90deg,#f59e0b,#ef4444);border:none;color:#fff;padding:8px 18px;border-radius:999px;font-size:0.78rem;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px;"><i data-lucide="life-buoy" style="width:14px;height:14px;"></i> Open a payment ticket</button></div>'
      : "";
    const toggle = `
      <div style="display:inline-flex;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:999px;padding:3px;gap:2px;">
        <button onclick="window.setPreferredCurrency('USD')" style="background:${cur === "USD" ? "linear-gradient(90deg,#06b6d4,#8b5cf6)" : "transparent"};border:none;color:${cur === "USD" ? "#fff" : "#94a3b8"};padding:5px 14px;border-radius:999px;font-size:0.72rem;font-weight:700;cursor:pointer;">USD</button>
        <button onclick="window.setPreferredCurrency('EGP')" style="background:${cur === "EGP" ? "linear-gradient(90deg,#06b6d4,#8b5cf6)" : "transparent"};border:none;color:${cur === "EGP" ? "#fff" : "#94a3b8"};padding:5px 14px;border-radius:999px;font-size:0.72rem;font-weight:700;cursor:pointer;">EGP</button>
      </div>`;
    box.innerHTML = `
      <div style="text-align:center;margin-bottom:10px;">${toggle}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;">
        ${planCardHTML("pro", priceForPlan("pro"),
          '<li><i data-lucide="heart"></i> Support the website</li>' +
          '<li><i data-lucide="sparkles"></i> Smartest AI models</li>' +
          '<li><i data-lucide="check"></i> No per-feature limits</li>' +
          '<li><i data-lucide="check"></i> Priority support tickets</li>')}
        ${planCardHTML("aplus", priceForPlan("aplus"),
          '<li><i data-lucide="heart"></i> Support the website</li>' +
          '<li><i data-lucide="zap"></i> Early access to new updates</li>' +
          '<li><i data-lucide="check"></i> ~100+ full docs / month</li>' +
          '<li><i data-lucide="check"></i> Priority support tickets</li>')}
      </div>
      ${notice}
    `;
    const r = document.getElementById("upgrade-reason");
    if (r) {
      r.textContent =
        reason === "feature_cap" || reason === "feature_cap_daily" || reason === "feature_cap_monthly" || reason === "feature_exceeded"
          ? "You've hit today's Free-tier limit for this feature — upgrade to Supporter to remove per-feature caps."
          : reason === "insufficient_credits" || reason === "quota_exceeded"
          ? "You're out of AI credits — upgrade for more monthly credits."
          : reason === "pro_required"
          ? "This feature is available on Supporter and Supporter+."
          : "Support OmNote and unlock exclusive features.";
    }
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }

  function ensureUpgradeModal() {
    if (document.getElementById("upgrade-modal")) return;
    const wrap = document.createElement("div");
    wrap.id = "upgrade-modal";
    wrap.style.cssText =
      "display:none;position:fixed;inset:0;background:rgba(0,0,0,0.78);backdrop-filter:blur(8px);z-index:100001;align-items:center;justify-content:center;padding:20px;overflow:auto;";
    wrap.innerHTML = `
      <div style="max-width:960px;width:100%;background:linear-gradient(160deg,#0f172a,#1e293b);border:1px solid rgba(6,182,212,0.35);border-radius:20px;padding:28px;box-shadow:0 30px 80px rgba(0,0,0,0.6);color:#f1f5f9;">
        <div style="text-align:center;margin-bottom:14px;">
          <h2 style="margin:0 0 6px;font-size:1.6rem;font-weight:800;background:linear-gradient(90deg,#f59e0b,#06b6d4,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">Choose your OmNote plan</h2>
          <div id="upgrade-reason" style="color:#94a3b8;font-size:0.9rem;"></div>
          <div style="color:#7a819a;font-size:0.75rem;margin-top:6px;">Secure checkout by Kashier · cancel any time</div>
        </div>
        <div id="upgrade-cards" style="margin:14px 0;"><div style="text-align:center;color:#94a3b8;padding:30px;">Loading prices…</div></div>
        <div style="text-align:center;margin-top:8px;">
          <button onclick="document.getElementById('upgrade-modal').style.display='none'" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:0.85rem;">Close</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
  }

  window.showUpgradeModal = async function (reason) {
    ensureUpgradeModal();
    document.getElementById("upgrade-modal").style.display = "flex";
    await renderUpgradeModal(reason);
  };

  window.startKashierCheckout = async function (plan) {
    if (plan !== "pro" && plan !== "aplus") return;
    const t = await idToken();
    if (!t) {
      alert("Please sign in first.");
      return;
    }
    const btn = event && event.target ? event.target : null;
    const orig = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Opening checkout…"; }
    try {
      const r = await fetch("/api/kashier", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
        body: JSON.stringify({ action: "create_session", plan, currency: quoteCurrency || undefined }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.url) {
        const msg = data && data.error ? data.error : "Could not start checkout.";
        alert(msg);
        return;
      }
      window.location.href = data.url;
    } catch (e) {
      alert("Network error. Please try again.");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  };

  window.requestUpgrade = async function () {
    return window.showUpgradeModal();
  };

  window.cancelProSubscription = async function () {
    if (!confirm("Cancel auto-renewal? Your plan stays active until the end of the current period.")) return;
    const t = await idToken();
    if (!t) return;
    try {
      const r = await fetch("/api/kashier", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
        body: JSON.stringify({ action: "cancel" }),
      });
      if (r.ok) alert("Auto-renewal canceled. Your plan remains active until the current period ends.");
      else alert("Could not cancel — please email contact@omnote.app.");
    } catch { alert("Network error."); }
  };



  // ---------- Inject credit card into profile settings modal ----------
  window.renderQuotaInProfile = async function () {
    const modal = document.getElementById("profile-settings-modal");
    if (!modal) return;
    const grid = modal.querySelector(".omn-profile-grid");
    const card = modal.querySelector(".omn-lang-card");
    const host = grid || card;
    if (!host) return;
    let box = document.getElementById("profile-quota-box");
    if (!box) {
      box = document.createElement("div");
      box.id = "profile-quota-box";
      box.style.cssText =
        "margin:0;padding:16px 18px;border-radius:16px;background:var(--bg-base, #f4f6f8);border:1px solid var(--border-medium, #dbe3e7);color:var(--text-primary, #0a3d4a);";
    }
    if (grid) {
      // Place credits card at the top of the grid, spanning both columns
      if (box.parentElement !== grid) grid.insertBefore(box, grid.firstChild);
    } else {
      const title = card.querySelector(".omn-lang-title");
      if (title && title.nextSibling) card.insertBefore(box, title.nextSibling.nextSibling || null);
      else card.appendChild(box);
    }

    box.innerHTML =
      '<div style="color:#aab0c6;font-size:0.85rem;">Loading plan…</div>';
    const s = await window.fetchQuotaStatus(true);
    if (!s) {
      box.innerHTML =
        '<div style="color:#aab0c6;font-size:0.85rem;">Sign in to view your plan.</div>';
      return;
    }
    const raw = String(s.plan || "free").toLowerCase();
    const p = (raw === "supporter") ? "pro" : (raw === "supporter+" || raw === "ultimate") ? "aplus" : raw;
    const planBadge = window.planBadgeHTML ? window.planBadgeHTML(p) : (p === "pro" ? "SUPPORTER" : p === "aplus" ? "SUPPORTER+" : "FREE");
    const untilLine = s.proUntil
      ? `<div style="color:#aab0c6;font-size:0.72rem;margin-top:3px;">${p === "aplus" ? "Supporter+" : "Supporter"} until ${new Date(s.proUntil).toLocaleDateString()}</div>`
      : "";
    
    let actionBtn = "";
    if (p === "free") {
      actionBtn = `<button onclick="window.showUpgradeModal()" style="width:100%;margin-top:14px;background:var(--accent-cyan, #0e7c86);border:none;color:#fff;padding:11px;border-radius:10px;font-weight:700;font-size:0.9rem;cursor:pointer;"><i data-lucide="sparkles"></i> See Supporter Plans</button>`;
    } else if (p === "pro") {
      actionBtn = `<button onclick="window.showUpgradeModal()" style="width:100%;margin-top:14px;background:#b8760b;border:none;color:#fff;padding:11px;border-radius:10px;font-weight:700;font-size:0.9rem;cursor:pointer;"><i data-lucide="rocket"></i> Upgrade to Supporter+</button>`;
    }

    const LABELS = {
      chunk_plan: "Study Plans",
      summary: "Summaries",
      flashcards: "Flashcards",
      mcq: "MCQs / Exams",
      explain: "Explain",
      chat: "AI Tutor Chat",
      insight: "Weekly Insight",
    };
    const caps = s.featureCaps || {};
    const usage = s.featureUsage || {};
    const capKeys = Object.keys(caps);
    let capsHTML = "";
    if (capKeys.length) {
      const rows = capKeys.map((k) => {
        const c = caps[k] || { daily: 0, monthly: 0 };
        const u = usage[k] || { day: 0, month: 0 };
        const dPct = c.daily > 0 ? Math.min(100, Math.round((u.day / c.daily) * 100)) : 0;
        const near = dPct >= 100 ? "#ef4444" : dPct >= 70 ? "#f59e0b" : "#06b6d4";
        return `
          <div style="padding:9px 11px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);">
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;color:#e2e8f0;margin-bottom:5px;">
              <span style="font-weight:600;">${LABELS[k] || k}</span>
              <span style="color:#aab0c6;font-size:0.72rem;"><b style="color:#f4f5ff;">${u.day}</b>/${c.daily} today · ${u.month}/${c.monthly} mo</span>
            </div>
            <div style="height:5px;background:rgba(255,255,255,0.06);border-radius:999px;overflow:hidden;">
              <div style="height:100%;width:${dPct}%;background:${near};transition:width 0.3s;"></div>
            </div>
          </div>`;
      }).join("");
      capsHTML = `
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.08);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="font-weight:700;color:#f4f5ff;font-size:0.85rem;">Feature Limits</div>
            <div style="color:#7a819a;font-size:0.68rem;">Resets daily · monthly</div>
          </div>
          <div style="display:grid;grid-template-columns:1fr;gap:6px;">${rows}</div>
        </div>`;
    }

    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:700;color:#f4f5ff;font-size:0.95rem;display:flex;align-items:center;gap:8px;">Your Plan ${planBadge}</div>
          ${untilLine}
        </div>
      </div>
      ${capsHTML}
      ${actionBtn}
    `;
  };


  // Hook into openProfileSettings without breaking i18n's implementation
  const origOpen = window.openProfileSettings;
  const wrap = function () {
    if (typeof origOpen === "function") origOpen();
    else if (typeof window.openProfileSettings === "function" && window.openProfileSettings !== wrap)
      window.openProfileSettings();
    setTimeout(() => window.renderQuotaInProfile(), 50);
  };
  const poller = setInterval(() => {
    if (typeof window.openProfileSettings === "function" && window.openProfileSettings !== wrap) {
      const real = window.openProfileSettings;
      window.openProfileSettings = function () {
        real();
        setTimeout(() => window.renderQuotaInProfile(), 60);
      };
      clearInterval(poller);
    }
  }, 200);
  setTimeout(() => clearInterval(poller), 8000);

  // Pre-flight guard for pro-only actions
  window.requirePro = async function () {
    const s = await window.fetchQuotaStatus();
    if (!s) return false;
    if (s.plan !== "pro" && s.plan !== "aplus") {
      window.showUpgradeModal("pro_required");
      return false;
    }
    return true;
  };

  // ---------- Global interceptor: catch 402 from aiCall/aiTask ----------
  const origTask = window.aiTask;
  const origCall = window.aiCall;
  function wrapErr(res) {
    if (res && typeof res === "object" && res._error) {
      const reason = res._reason;
      if (reason === "insufficient_credits") {
        window.showUpgradeModal && window.showUpgradeModal("insufficient_credits");
      } else if (reason === "feature_cap_daily" || reason === "feature_cap_monthly" || reason === "feature_exceeded" || reason === "quota_exceeded") {
        window.showUpgradeModal && window.showUpgradeModal("feature_cap");
      } else if (reason === "maintenance") {

        window.showToast && window.showToast(res._error, "info");
      } else {
        const s = String(res._error).toLowerCase();
        if (s.includes("pro plan") || s.includes("pro-only")) window.showUpgradeModal && window.showUpgradeModal("pro_required");
        else if (s.includes("credit") || s.includes("this month") || s.includes("quota") || s.includes("daily limit"))
          window.showUpgradeModal && window.showUpgradeModal("insufficient_credits");
      }
      window.invalidateQuotaCache && window.invalidateQuotaCache();
    } else {
      window.invalidateQuotaCache && window.invalidateQuotaCache();
    }
    return res;
  }

  if (typeof origTask === "function") {
    window.aiTask = function (t, v, o) {
      return origTask(t, v, o).then(wrapErr);
    };
  }
  if (typeof origCall === "function") {
    window.aiCall = function (o) {
      return origCall(o).then(wrapErr);
    };
  }

  // Friendly HTML for a failed AI reply — shows upgrade CTA on credit errors.
  window.aiErrorHTML = function (reply) {
    const rawMsg = reply && reply._error ? String(reply._error) : "";
    const msg = rawMsg.toLowerCase();
    const reason = reply && reply._reason;
    const isMaintenance = reason === "maintenance" || msg.includes("maintenance");
    const isPro = reason === "pro_required" || msg.includes("pro plan") || msg.includes("pro-only") || msg.includes("pro only");
    const isCredits = reason === "insufficient_credits" || msg.includes("out of ai credits") || msg.includes("credit");
    const isFeatureCap = reason === "feature_cap_daily" || reason === "feature_cap_monthly" || reason === "feature_exceeded" || reason === "quota_exceeded";

    if (isMaintenance) {
      return `
        <div style="text-align:center;padding:22px 18px;border-radius:14px;background:linear-gradient(160deg,rgba(245,158,11,0.10),rgba(239,68,68,0.06));border:1px solid rgba(245,158,11,0.28);">
          <div style="font-size:1.6rem;margin-bottom:6px;"><i data-lucide="wrench"></i></div>
          <div style="font-weight:700;color:#f4f5ff;font-size:1rem;margin-bottom:4px;">Under maintenance</div>
          <div style="color:#aab0c6;font-size:0.85rem;">${rawMsg || "This AI feature is temporarily unavailable. Please try again shortly."}</div>
        </div>`;
    }

    if (isPro || isCredits || isFeatureCap) {
      const title = isPro
        ? "This feature is for Supporters"
        : isFeatureCap
          ? "Daily free limit reached"
          : "Usage limit reached";
      const sub = isPro
        ? "Become a Supporter to unlock this feature."
        : isFeatureCap
          ? (rawMsg || "You've hit today's free-tier limit for this feature. Upgrade to Supporter to remove per-feature caps.")
          : "Upgrade to Supporter to remove usage caps and unlock all features.";
      const cta = isPro ? "pro_required" : isFeatureCap ? "feature_cap" : "insufficient_credits";
      return `
        <div style="text-align:center;padding:22px 18px;border-radius:14px;background:linear-gradient(160deg,rgba(139,92,246,0.10),rgba(6,182,212,0.06));border:1px solid rgba(139,92,246,0.28);">
          <div style="font-size:1.6rem;margin-bottom:6px;"><i data-lucide="sparkles"></i></div>
          <div style="font-weight:700;color:#f4f5ff;font-size:1rem;margin-bottom:4px;">${title}</div>
          <div style="color:#aab0c6;font-size:0.85rem;margin-bottom:14px;">${sub}</div>
          <button onclick="window.showUpgradeModal('${cta}')" style="background:linear-gradient(90deg,#06b6d4,#8b5cf6);border:none;color:#fff;padding:10px 22px;border-radius:10px;font-weight:700;font-size:0.88rem;cursor:pointer;box-shadow:0 6px 18px rgba(6,182,212,0.3);">Become a Supporter</button>
        </div>`;
    }
    return `<div style="text-align:center;padding:18px;color:#aab0c6;font-size:0.9rem;">${rawMsg || "Couldn't reach the AI right now. Please try again in a moment."}</div>`;
  };

  // ---------- Checkout return handler ----------
  function handleReturnFlag() {
    const hash = String(window.location.hash || "");
    if (hash.indexOf("upgraded=1") !== -1) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
      if (window.showToast) window.showToast("Payment received — your plan is being activated.", "success");
      else alert("Payment received — your plan is being activated.");
      // Poll a few times to catch webhook activation.
      let tries = 0;
      const iv = setInterval(async () => {
        tries++;
        window.invalidateQuotaCache && window.invalidateQuotaCache();
        const s = await window.fetchQuotaStatus(true);
        if (s && (s.plan === "pro" || s.plan === "aplus")) {
          clearInterval(iv);
          if (window.showToast) window.showToast("You're on " + (s.plan === "aplus" ? "Supporter+" : "Supporter") + " — enjoy!", "success");
          if (window.renderTopbarCreditChip) window.renderTopbarCreditChip();
        }
        if (tries > 12) clearInterval(iv);
      }, 2500);
    } else if (hash.indexOf("checkout_failed=1") !== -1) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
      if (window.showToast) window.showToast("Payment did not complete. Please try again.", "error");
      else alert("Payment did not complete. Please try again.");
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", handleReturnFlag);
  } else {
    handleReturnFlag();
  }

})();

