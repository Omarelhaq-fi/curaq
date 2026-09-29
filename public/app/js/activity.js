// Activity heartbeat client — pings /api/activity when the signed-in user
// actually does something (click, keypress, tab focus, route/tab switch),
// throttled so it costs at most one write every 2 minutes.
(function () {
  const MIN_INTERVAL = 120_000; // 2 min between writes
  let lastSent = 0;
  let pendingAction = "";
  let inflight = false;

  function currentUser() {
    try {
      return window.firebase && firebase.auth && firebase.auth().currentUser;
    } catch (_) { return null; }
  }

  async function send(action) {
    const user = currentUser();
    if (!user || inflight) return;
    inflight = true;
    try {
      const token = await user.getIdToken();
      await fetch("/api/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ action: action || "" }),
      });
      lastSent = Date.now();
    } catch (_) { /* silent */ }
    inflight = false;
  }

  // Public: call with a short label from anywhere, e.g. trackActivity("summary")
  window.trackActivity = function (action) {
    if (action) pendingAction = String(action);
    const now = Date.now();
    if (now - lastSent < MIN_INTERVAL) return;
    lastSent = now; // optimistic, avoids bursts
    const label = pendingAction;
    pendingAction = "";
    send(label);
  };

  function bump(label) {
    return function () { window.trackActivity(label); };
  }

  document.addEventListener("click", bump("click"), true);
  document.addEventListener("keydown", bump("typing"), true);
  // NOTE: no visibilitychange/"focus" ping — tab switches aren't real
  // activity and each one cost a Firestore write + a POST /api/activity
  // log line. Clicks, typing, signin and the active keep-alive below
  // already keep lastActiveIso fresh.

  // First ping as soon as a user is signed in.
  function watchAuth() {
    if (!window.firebase || !firebase.auth) { setTimeout(watchAuth, 400); return; }
    firebase.auth().onAuthStateChanged(function (user) {
      if (user) {
        if (!sessionStorage.getItem('exora_activity_pinged')) {
          sessionStorage.setItem('exora_activity_pinged', '1');
          lastSent = 0;
          window.trackActivity("signin");
        } else {
          lastSent = Date.now(); // Start the 2-minute cooldown on refresh
        }
      }
    });
  }
  watchAuth();

  // Keep-alive while the tab stays open and in use.
  setInterval(function () {
    if (!document.hidden) window.trackActivity("active");
  }, MIN_INTERVAL);
})();
