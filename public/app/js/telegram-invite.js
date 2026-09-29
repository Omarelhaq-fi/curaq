// Telegram channel invite — shown ONCE per user, then never again.
// Persists per-user in two places:
//   1) Firestore users_index/{uid}.telegramInviteSeen = true (survives devices / cache clear)
//   2) localStorage curaq_telegram_seen_<uid> = "1" (instant, works offline)
// Either flag being set means "never show again".
(function () {
  var TELEGRAM_URL = "https://t.me/curaqegypt";
  var LS_PREFIX = "curaq_telegram_seen_";
  var FIELD = "telegramInviteSeen";
  var MODAL_ID = "tg-invite-modal";
  var MAX_RETRIES = 8;

  function uidOf(user) {
    return (user && user.uid) || ((window.firebase && firebase.auth().currentUser || {}).uid) || null;
  }

  function lsKey(uid) { return LS_PREFIX + uid; }

  function seenLocal(uid) {
    if (!uid) return false;
    try { return localStorage.getItem(lsKey(uid)) === "1"; } catch (_) { return false; }
  }

  function markSeenLocal(uid) {
    if (!uid) return;
    try { localStorage.setItem(lsKey(uid), "1"); } catch (_) {}
  }

  async function seenRemote(uid) {
    try {
      if (!window.firebase || !firebase.firestore) return false;
      var snap = await firebase.firestore().collection("users_index").doc(uid).get();
      if (snap && snap.exists) {
        var d = snap.data() || {};
        if (d[FIELD] === true) return true;
      }
    } catch (_) {}
    return false;
  }

  async function markSeenRemote(uid) {
    try {
      if (!window.firebase || !firebase.firestore) return;
      await firebase.firestore().collection("users_index").doc(uid).set(
        { telegramInviteSeen: true, telegramInviteSeenAt: new Date().toISOString() },
        { merge: true }
      );
    } catch (_) {}
  }

  function markSeen(uid) {
    markSeenLocal(uid);
    // Fire-and-forget cloud write so other devices also never show it.
    markSeenRemote(uid);
  }

  function ensureModal() {
    if (document.getElementById(MODAL_ID)) return;
    var wrap = document.createElement("div");
    wrap.className = "modal";
    wrap.id = MODAL_ID;
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-label", "Join our Telegram channel");
    wrap.innerHTML =
      '<div class="modal-content tg-invite-card">' +
        '<button class="tg-invite-x" id="tg-invite-x" aria-label="Dismiss">&times;</button>' +
        '<div class="tg-invite-icon">' +
          '<svg viewBox="0 0 24 24" width="30" height="30" fill="#fff" aria-hidden="true">' +
            '<path d="M21.9 4.6 2.7 12.1c-.8.3-.8 1.4.1 1.6l4.7 1.5 1.8 5.6c.3.8 1.3.9 1.8.2l2.6-3.1 4.9 3.6c.6.4 1.5.1 1.7-.6l2.6-14.1c.2-1-.9-1.8-2-1.2zm-4.4 4.1-8.2 7.5-.3 3.2-1.7-5.3 9.3-6.4c.4-.3.9.3.9 1z"/>' +
          '</svg>' +
        '</div>' +
        '<h2 class="tg-invite-title">Stay Updated!</h2>' +
        '<p class="tg-invite-desc">Join our Telegram channel to get the latest updates about questions &amp; new data.</p>' +
        '<a class="tg-invite-join" id="tg-invite-join" href="' + TELEGRAM_URL + '" target="_blank" rel="noopener">' +
          'Join Telegram Channel' +
        '</a>' +
        '<button class="tg-invite-later" id="tg-invite-later">Maybe later</button>' +
      '</div>' +
      '<style>' +
        '#tg-invite-modal{z-index:1000000;padding:16px;}' +
        '#tg-invite-modal.active{display:flex;}' +
        '.tg-invite-card{position:relative;width:380px;max-width:calc(100vw - 32px);text-align:center;' +
          'padding:36px 28px 24px;border-radius:18px;background:#fff;color:#0a3d4a;' +
          'border:1px solid #e2e8f0;box-shadow:0 24px 70px rgba(10,61,74,.25);align-items:center;}' +
        'html.dark .tg-invite-card{background:#0f2027;color:#e6f4f5;border-color:rgba(255,255,255,.12);}' +
        '.tg-invite-x{position:absolute;top:10px;right:12px;border:none;background:transparent;' +
          'font-size:24px;line-height:1;color:#94a3b8;cursor:pointer;padding:4px 8px;}' +
        '.tg-invite-x:hover{color:#0a3d4a;}' +
        '.tg-invite-icon{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#2AABEE,#229ED9);' +
          'display:flex;align-items:center;justify-content:center;margin:0 auto 16px;' +
          'box-shadow:0 8px 20px rgba(42,171,238,.4);}' +
        '.tg-invite-title{margin:0 0 8px;font-size:22px;font-weight:800;letter-spacing:-.01em;}' +
        '.tg-invite-desc{margin:0 0 20px;font-size:14px;line-height:1.6;color:#5c727d;}' +
        'html.dark .tg-invite-desc{color:#9fb3ba;}' +
        '.tg-invite-join{display:flex;align-items:center;justify-content:center;width:100%;box-sizing:border-box;' +
          'padding:13px 16px;border-radius:12px;background:#229ED9;color:#fff !important;' +
          'font-size:15px;font-weight:700;text-decoration:none;transition:background .2s ease;}' +
        '.tg-invite-join:hover{background:#1b8bc0;}' +
        '.tg-invite-later{margin-top:10px;border:none;background:transparent;color:#94a3b8;' +
          'font-size:13px;font-weight:600;cursor:pointer;padding:6px;}' +
        '.tg-invite-later:hover{color:#0a3d4a;text-decoration:underline;}' +
      '</style>';
    document.body.appendChild(wrap);

    wrap.addEventListener("click", function (e) {
      if (e.target === wrap) window.closeTelegramInvite();
    });
    var x = wrap.querySelector("#tg-invite-x");
    if (x) x.addEventListener("click", window.closeTelegramInvite);
    var later = wrap.querySelector("#tg-invite-later");
    if (later) later.addEventListener("click", window.closeTelegramInvite);
    var join = wrap.querySelector("#tg-invite-join");
    if (join) join.addEventListener("click", function () {
      // Joining counts as seen — never show again afterwards.
      try { window.closeTelegramInvite(); } catch (_) {}
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        var m = document.getElementById(MODAL_ID);
        if (m && m.classList.contains("active")) window.closeTelegramInvite();
      }
    });
  }

  window.closeTelegramInvite = function () {
    var uid = uidOf();
    if (uid) markSeen(uid);
    var m = document.getElementById(MODAL_ID);
    if (m) m.classList.remove("active");
  };

  // Core check: show once per user, then never again.
  window.maybeShowTelegramInvite = async function (user, retry) {
    retry = retry || 0;
    var uid = uidOf(user);
    if (!uid) return false;

    // Fast path: already dismissed on this device.
    if (seenLocal(uid)) return false;

    // Don't interrupt the welcome onboarding wizard.
    if (document.getElementById("welcome-onboarding")) {
      if (retry < MAX_RETRIES) setTimeout(function () { window.maybeShowTelegramInvite(user, retry + 1); }, 3000);
      return false;
    }

    // Authoritative path: already dismissed on another device.
    if (await seenRemote(uid)) {
      markSeenLocal(uid);
      return false;
    }

    // Double-check local again (race with another tab).
    if (seenLocal(uid)) return false;

    ensureModal();
    var m = document.getElementById(MODAL_ID);
    if (m) m.classList.add("active");
    // Mark seen immediately on show so it can never reappear,
    // even if the user just closes the tab without clicking.
    markSeen(uid);
    return true;
  };

  // Auto-trigger shortly after sign-in. Delayed so it never fights
  // the welcome/onboarding overlay or the initial dashboard load.
  function arm() {
    if (!window.firebase || !firebase.auth) return false;
    firebase.auth().onAuthStateChanged(function (user) {
      if (!user) return;
      setTimeout(function () { window.maybeShowTelegramInvite(user, 0); }, 2500);
    });
    return true;
  }

  if (!arm()) {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(arm, 500);
    });
  }
})();
