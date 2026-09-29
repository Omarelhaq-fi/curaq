// Session restore — remembers the last-viewed document, sub-tabs, and summary
// chunk so a page reload lands the user back where they were.
// Purely client-side; state is stored in localStorage per-user (by firebase uid).
(function () {
  const BASE_KEY = "omnote_last_view";

  function currentUid() {
    try {
      if (window.firebase && firebase.auth && firebase.auth().currentUser) {
        return firebase.auth().currentUser.uid || "anon";
      }
    } catch (_) {}
    return "anon";
  }
  function storageKey(uid) {
    return BASE_KEY + ":" + (uid || currentUid());
  }

  let saveTimer = null;
  let pending = null;

  window.getLastView = function () {
    try {
      const raw = localStorage.getItem(storageKey());
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      return obj;
    } catch (_) { return null; }
  };

  window.saveLastView = function (patch) {
    if (!patch || typeof patch !== "object") return;
    pending = Object.assign(pending || window.getLastView() || {}, patch);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(storageKey(), JSON.stringify(pending));
      } catch (_) {}
      pending = null;
      saveTimer = null;
    }, 250);
  };

  window.clearLastView = function (uid) {
    try { localStorage.removeItem(storageKey(uid)); } catch (_) {}
    pending = null;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  };

  // Try to restore after the app has loaded documents.
  // Called from app.js initApp() once db is ready.
  window.restoreLastView = function () {
    const state = window.getLastView();
    if (!state) return false;
    try {
      const doc =
        state.docId && window.db && window.db.documents
          ? window.db.documents.find((d) => d.id === state.docId)
          : null;
      if (!doc) return false;

      window.switchDocument && window.switchDocument(state.docId);

      // Defer tab restoration until after switchDocument's synchronous DOM writes.
      setTimeout(() => {
        try {
          if (state.leftTab) {
            const btn = document.querySelector(
              `#left-pane-tabs .left-tab-item[onclick*="'${state.leftTab}'"]`,
            );
            if (btn && window.switchLeftView) {
              window.switchLeftView(state.leftTab, btn);
              // Trigger the extra handlers wired inline on the button
              // (renderFlashcardsList, whiteboardActivate, renderMindMap).
              try { btn.click(); } catch (_) {}
            }
          }
          if (state.rightTab) {
            const btn = document.querySelector(
              `.right-tab-item[onclick*="'${state.rightTab}'"]`,
            );
            if (btn && window.switchRightView) {
              window.switchRightView(state.rightTab, btn);
            }
          }
          if (state.mainTab) {
            const btn = document.querySelector(
              `.main-nav-tab[onclick*="'${state.mainTab}'"]`,
            );
            if (btn && window.switchMainTab) {
              window.switchMainTab(state.mainTab, btn);
            }
          }
          if (state.summaryTopic && doc.sections) {
            const sec = doc.sections.find((s) => s.title === state.summaryTopic);
            if (sec && window.readSummary) {
              // readSummary handles cache display and left-view switch.
              window.readSummary(state.summaryTopic, false);
            }
          }
        } catch (e) { /* ignore restore failures */ }
      }, 60);
      return true;
    } catch (_) { return false; }
  };

  // Clear when the signed-in user changes so a different account doesn't
  // inherit the previous session pointer.
  function watchAuth() {
    if (!window.firebase || !firebase.auth) {
      setTimeout(watchAuth, 300);
      return;
    }
    let lastUid = null;
    firebase.auth().onAuthStateChanged((user) => {
      const uid = user ? user.uid : null;
      if (lastUid && uid !== lastUid) {
        // signed out or switched accounts — clear the OLD user's pointer only
        window.clearLastView(lastUid);
      }
      lastUid = uid;
    });
  }
  watchAuth();
})();
