// In-app feedback popup — star rating (1-5) + optional comment.
// PUSH-ONLY: never shows automatically. While an admin push is active it
// shows ONCE per account, forever, to users with >= 5 answered QBank
// questions (eligibility enforced server-side). Dismissing without
// submitting also counts as the one lifetime showing.
// Global on/off + push live in the admin panel Feedback tab.
(function () {
  var MODAL_ID = "feedback-modal";
  // v2 key: v1 flags were set spuriously for everyone (server status bug
  // returned done:true without any showing). Fresh key = clean slate.
  var LS_PREFIX = "curaq_feedback_done2_";
  var MAX_RETRIES = 8;
  var lastCheck = 0;

  function currentUser() {
    try { return window.firebase && firebase.auth && firebase.auth().currentUser; }
    catch (_) { return null; }
  }
  function lsKey(uid) { return LS_PREFIX + uid; }
  function doneLocal(uid) {
    if (!uid) return true;
    try { return localStorage.getItem(lsKey(uid)) === "1"; } catch (_) { return false; }
  }
  function markDoneLocal(uid) {
    if (!uid) return;
    try { localStorage.setItem(lsKey(uid), "1"); } catch (_) {}
  }

  async function authedPost(payload) {
    var user = currentUser();
    if (!user) throw new Error("Not signed in");
    var token = await user.getIdToken();
    var res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(payload),
    });
    var data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      var err = new Error((data && data.error) || "Request failed");
      err.reason = data && data.reason;
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function ensureModal() {
    if (document.getElementById(MODAL_ID)) return;
    var wrap = document.createElement("div");
    wrap.className = "modal";
    wrap.id = MODAL_ID;
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-label", "Rate your experience");
    wrap.innerHTML =
      '<div class="modal-content fb-card">' +
        '<button class="fb-x" id="fb-x" aria-label="Dismiss">&times;</button>' +
        '<div id="fb-body">' +
          '<div class="fb-emoji">💬</div>' +
          '<h2 class="fb-title">Enjoying CuraQ?</h2>' +
          '<p class="fb-desc" id="fb-desc">Tap a star to rate your experience. A short comment is optional but helps us a lot.</p>' +
          '<div class="fb-stars" id="fb-stars" dir="ltr" role="radiogroup" aria-label="Star rating">' +
            [1, 2, 3, 4, 5].map(function (n) {
              return '<button type="button" class="fb-star" data-n="' + n + '" role="radio" aria-checked="false" aria-label="' + n + ' star' + (n > 1 ? "s" : "") + '">★</button>';
            }).join("") +
          '</div>' +
          '<textarea class="fb-area" id="fb-comment" maxlength="1000" rows="3" placeholder="Anything we should improve? (optional)"></textarea>' +
          '<div class="fb-count"><span id="fb-count-n">0</span>/1000</div>' +
          '<div class="fb-err" id="fb-err"></div>' +
          '<button class="fb-submit" id="fb-submit" disabled>Send feedback</button>' +
          '<button class="fb-later" id="fb-later">Not now</button>' +
        '</div>' +
      '</div>' +
      '<style>' +
        '#feedback-modal{z-index:900000;padding:16px;}' +
        '#feedback-modal.active{display:flex;}' +
        '.fb-card{position:relative;width:400px;max-width:calc(100vw - 32px);text-align:center;' +
          'padding:32px 26px 22px;border-radius:18px;background:#fff;color:#0a3d4a;' +
          'border:1px solid #e2e8f0;box-shadow:0 24px 70px rgba(10,61,74,.25);align-items:center;}' +
        'html.dark .fb-card{background:#0f2027;color:#e6f4f5;border-color:rgba(255,255,255,.12);}' +
        '.fb-x{position:absolute;top:10px;right:12px;border:none;background:transparent;' +
          'font-size:24px;line-height:1;color:#94a3b8;cursor:pointer;padding:4px 8px;}' +
        '.fb-x:hover{color:#0a3d4a;}' +
        '.fb-emoji{font-size:40px;line-height:1;margin-bottom:10px;}' +
        '.fb-title{margin:0 0 6px;font-size:22px;font-weight:800;letter-spacing:-.01em;}' +
        '.fb-desc{margin:0 0 14px;font-size:13.5px;line-height:1.6;color:#5c727d;}' +
        'html.dark .fb-desc{color:#9fb3ba;}' +
        '.fb-stars{display:flex;justify-content:center;gap:6px;margin-bottom:14px;}' +
        '.fb-star{border:none;background:transparent;font-size:38px;line-height:1;cursor:pointer;' +
          'color:#e2e8f0;padding:2px;transition:transform .12s ease,color .12s ease;}' +
        '.fb-star.on{color:#f59e0b;}' +
        '.fb-star:hover{transform:scale(1.15);}' +
        '.fb-area{width:100%;box-sizing:border-box;resize:vertical;min-height:74px;' +
          'border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;font-size:13.5px;' +
          'font-family:inherit;color:inherit;background:transparent;outline:none;}' +
        '.fb-area:focus{border-color:#0e7c86;box-shadow:0 0 0 3px rgba(14,124,134,.12);}' +
        '.fb-count{text-align:right;font-size:11px;color:#94a3b8;margin:4px 0 8px;}' +
        '.fb-err{min-height:18px;font-size:12.5px;color:#c0392b;font-weight:600;margin-bottom:6px;}' +
        '.fb-submit{width:100%;padding:13px;border:none;border-radius:12px;background:#0e7c86;' +
          'color:#fff;font-size:15px;font-weight:700;cursor:pointer;transition:background .2s ease;}' +
        '.fb-submit:hover:not(:disabled){background:#0b6770;}' +
        '.fb-submit:disabled{opacity:.45;cursor:not-allowed;}' +
        '.fb-later{margin-top:8px;border:none;background:transparent;color:#94a3b8;' +
          'font-size:13px;font-weight:600;cursor:pointer;padding:6px;}' +
        '.fb-later:hover{color:#0a3d4a;text-decoration:underline;}' +
        '.fb-thanks{font-size:44px;margin-bottom:8px;}' +
      '</style>';
    document.body.appendChild(wrap);

    var chosen = 0;
    var starsEl = wrap.querySelector("#fb-stars");
    var submitBtn = wrap.querySelector("#fb-submit");
    var errEl = wrap.querySelector("#fb-err");
    var area = wrap.querySelector("#fb-comment");
    var countN = wrap.querySelector("#fb-count-n");

    function paint() {
      var btns = starsEl.querySelectorAll(".fb-star");
      btns.forEach(function (b) {
        var n = Number(b.getAttribute("data-n"));
        var on = n <= chosen;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", on && n === chosen ? "true" : "false");
      });
      submitBtn.disabled = chosen === 0;
      errEl.textContent = "";
    }
    starsEl.addEventListener("click", function (e) {
      var b = e.target.closest(".fb-star");
      if (!b) return;
      chosen = Number(b.getAttribute("data-n"));
      paint();
    });
    area.addEventListener("input", function () { countN.textContent = String(area.value.length); });

    wrap.addEventListener("click", function (e) { if (e.target === wrap) window.closeFeedback(true); });
    wrap.querySelector("#fb-x").addEventListener("click", function () { window.closeFeedback(true); });
    wrap.querySelector("#fb-later").addEventListener("click", function () { window.closeFeedback(true); });
    submitBtn.addEventListener("click", async function () {
      if (!chosen) return;
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
      errEl.textContent = "";
      try {
        await authedPost({ action: "submit", stars: chosen, comment: area.value });
        var user = currentUser();
        if (user) markDoneLocal(user.uid);
        wrap.querySelector("#fb-body").innerHTML =
          '<div class="fb-thanks">🎉</div>' +
          '<h2 class="fb-title">Thank you!</h2>' +
          '<p class="fb-desc">Your feedback helps us make CuraQ better for everyone.</p>';
        setTimeout(function () { window.closeFeedback(false); }, 1600);
      } catch (e) {
        if (e && (e.reason === "already_submitted" || e.status === 409)) {
          var u2 = currentUser();
          if (u2) markDoneLocal(u2.uid);
          window.closeFeedback(false);
          return;
        }
        errEl.textContent = (e && e.message) || "Could not send. Please try again.";
        submitBtn.disabled = false;
        submitBtn.textContent = "Send feedback";
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        var mm = document.getElementById(MODAL_ID);
        if (mm && mm.classList.contains("active")) window.closeFeedback(true);
      }
    });
  }

  // Dismiss (tell server this was the lifetime showing) or silent close
  // (already recorded at show time / after submit).
  window.closeFeedback = function (record) {
    var user = currentUser();
    if (record && user) {
      authedPost({ action: "dismiss" }).catch(function () {});
    }
    var m = document.getElementById(MODAL_ID);
    if (m) { m.classList.remove("active"); m.style.display = "none"; }
  };

  // Show once per account when eligible. Safe to call often: short-circuits
  // locally when done, throttled to 1 status check / 60s otherwise.
  window.maybeShowFeedback = async function (retry) {
    retry = retry || 0;
    try {
      var user = currentUser();
      if (!user) return false;
      if (doneLocal(user.uid)) { clearRechecks(); return false; }
      if (document.getElementById(MODAL_ID) && document.getElementById(MODAL_ID).classList.contains("active")) return false;
      // Don't fight the welcome onboarding wizard.
      if (document.getElementById("welcome-onboarding")) {
        if (retry < MAX_RETRIES) setTimeout(function () { window.maybeShowFeedback(retry + 1); }, 3000);
        return false;
      }
      var now = Date.now();
      if (now - lastCheck < 60_000) return false;
      lastCheck = now;
      var st = await authedPost({ action: "status" });
      if (st.done) { markDoneLocal(user.uid); clearRechecks(); return false; }
      if (!st.enabled || !st.eligible) return false;
      if (doneLocal(user.uid)) return false;
      ensureModal();
      var modal = document.getElementById(MODAL_ID);
      modal.classList.add("active");
      modal.style.display = "flex"; // belt & suspenders: never depend on CSS alone
      // Record the showing INSTANTLY (server + local) — a reload or an
      // instant click-away can never cause a second showing.
      markDoneLocal(user.uid);
      authedPost({ action: "shown" }).catch(function () {});
      try { console.info("[feedback] popup shown (once-forever recorded)"); } catch (_) {}
      clearRechecks();
      return true;
    } catch (err) {
      try { console.warn("[feedback] status check failed:", (err && err.message) || err); } catch (_) {}
      return false;
    }
  };

  // Bounded re-checks after boot: covers "admin pushed while the app is
  // already open" and the 60s server settings cache. Stops forever once done.
  var recheckTimers = [];
  function clearRechecks() {
    recheckTimers.forEach(function (t) { try { clearTimeout(t); } catch (_) {} });
    recheckTimers = [];
  }
  function scheduleRechecks() {
    clearRechecks();
    [60_000, 180_000, 420_000].forEach(function (ms) {
      recheckTimers.push(setTimeout(function () {
        try { window.maybeShowFeedback(0); } catch (_) {}
      }, ms));
    });
  }

  // Diagnostics: run `await window.feedbackDebug()` in the console to see
  // exactly why the popup does or doesn't show for the signed-in account.
  window.feedbackDebug = async function () {
    try {
      var user = currentUser();
      var st = await authedPost({ action: "status" });
      var local = user ? doneLocal(user.uid) : null;
      var verdict;
      if (local && st.done) {
        var when = st.at ? " at " + st.at : "";
        if (st.state === "submitted") verdict = "Response SUBMITTED" + when + " — once-forever rule. To retest: admin Reset + clear localStorage key, then reload.";
        else if (st.state === "dismissed") verdict = "Popup was SHOWN then closed (X / Not now / backdrop / Esc)" + when + " — once-forever rule. To retest: admin Reset + clear localStorage key, then reload.";
        else verdict = "Popup was SHOWN" + when + " (no close recorded — likely reloaded while open). To retest: admin Reset + clear localStorage key, then reload.";
      }
      else if (local && !st.done) verdict = "Marked done in THIS browser only (likely dismissed while offline) — server has no record. Clear the localStorage key and reload to retry.";
      else if (!local && st.done) verdict = "Server says already shown (probably on another device/browser). Use admin Reset to retest.";
      else if (!st.enabled) verdict = "Popup is LOCKED in admin panel — nothing shows anywhere.";
      else if (!st.eligible) verdict = "Not eligible: needs 5+ synced answers (has " + st.answers + ") AND an active admin push.";
      else verdict = "ELIGIBLE — the popup should be visible now.";
      var out = {
        verdict: verdict,
        uid: user && user.uid,
        email: user && user.email,
        localDone: local,
        server: st,
      };
      try { console.info("[feedback debug]", out); } catch (_) {}
      return out;
    } catch (e) {
      var err = { error: String((e && e.message) || e), reason: e && e.reason, status: e && e.status };
      try { console.warn("[feedback debug]", err); } catch (_) {}
      return err;
    }
  };

  function arm() {
    if (!window.firebase || !firebase.auth) return false;
    firebase.auth().onAuthStateChanged(function (user) {
      if (!user) return;
      // Active users only: short delay so it never fights initial load.
      setTimeout(function () { window.maybeShowFeedback(0); }, 4000);
      scheduleRechecks();
    });
    return true;
  }
  if (!arm()) {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(arm, 500); });
  }
})();
