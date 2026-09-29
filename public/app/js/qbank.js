(function () {
  let qbanks = [];
  let currentQBankId = null;
  let allQuestions = [];
  let currentQuestions = [];
  let currentIndex = 0;
  let qbankTimer = null;
  let questionStartTime = 0;
  let currentQuestionTimeMs = 0;
  let currentSelectedIndices = [];

  let cachedCategories = null;
  let preloadPromise = null;
  let cachedQBanks = {}; // { qbankId: { questions, progress } }
  let isSyncing = false;

  // Navigation token: every top-level bank navigation bumps this. Async
  // continuations bail out if a newer navigation started, so a slow
  // in-flight load can never overwrite the freshly selected bank with
  // stale (old-bank) content.
  function nextNavToken() {
    window.__qbankNavToken = (window.__qbankNavToken || 0) + 1;
    return window.__qbankNavToken;
  }
  function navStale(tok) { return tok !== window.__qbankNavToken; }

  // Single sidebar active-state setter (solid 3px left bar + subtle tint
  // via .qbank-nav-active in layout-polish.css). Replaces the scattered
  // per-view Tailwind class juggling so every view looks identical.
  window.setQBankNav = function(path) {
    try {
      document.querySelectorAll('nav a[data-path]').forEach(a => {
        a.classList.remove(
          'qbank-nav-active',
          'border-[#007a7a]', 'bg-[#007a7a]/5', 'text-[#007a7a]', 'font-bold',
          'border-primary', 'bg-primary/10', 'text-primary'
        );
        if (!a.classList.contains('font-medium')) a.classList.add('font-medium');
        if (!a.classList.contains('text-gray-600')) a.classList.add('text-gray-600');
      });
      if (!path) return;
      const tab = document.querySelector('nav a[data-path="' + path + '"]');
      if (tab) {
        tab.classList.remove('border-transparent', 'text-gray-600', 'font-medium', 'text-on-surface-variant');
        tab.classList.add('qbank-nav-active');
      }
    } catch (_) {}
  };

  // --- IndexedDB Caching ---
  // Two stores (DB v2):
  // - `qbanks`: versioned question payloads, keyed by bank id
  //   ({ id, updatedAt, questions }). Immutable per `updatedAt`, so entries
  //   are kept FOREVER and only replaced when the version stamp changes.
  //   Survives Vercel cold starts / page reloads: repeat visits download
  //   0 questions and fetch only the tiny progress blob.
  // - `kv`: forever-cache for tiny, rarely-changing values (qbank list,
  //   peer threshold, study concepts). Stale-while-revalidate: serve
  //   instantly from IDB, refresh in background. NEVER stored here:
  //   per-question peer stats (volatile) and user progress (private).
  const DB_NAME = "OmnoteQBankCache";
  const STORE_NAME = "qbanks";
  const KV_STORE = "kv";
  const DB_VERSION = 2;

  const KV_KEYS = {
    // v2: v1 briefly cached a per-user FILTERED bank list (since reverted to
    // the full list server-side). Bump forces one fresh fetch; stale v1 rows
    // are simply never read again.
    QBANK_LIST: "qbank_list:v2",
    PEER_THRESHOLD: "peer_threshold:v1",
    studyConcept: (bankId, qid, lang) => `study_concept:v1:${bankId}:${qid}:${lang || "auto"}`,
  };

  function openQBankDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(KV_STORE)) {
          db.createObjectStore(KV_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbKvGet(key) {
    return openQBankDB().then((db) => new Promise((resolve) => {
      try {
        const tx = db.transaction(KV_STORE, "readonly");
        const req = tx.objectStore(KV_STORE).get(key);
        req.onsuccess = () => resolve(req.result ? req.result.value : null);
        req.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    })).catch(() => null);
  }

  function idbKvSet(key, value) {
    return openQBankDB().then((db) => new Promise((resolve) => {
      try {
        const tx = db.transaction(KV_STORE, "readwrite");
        const req = tx.objectStore(KV_STORE).put({ key, value, savedAt: Date.now() });
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      } catch (_) { resolve(); }
    })).catch(() => {});
  }

  async function getCachedQBank(id) {
    try {
      const db = await openQBankDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch(e) { return null; }
  }
  window.getCachedQBank = getCachedQBank;
  window.getQBankList = function () { return cachedCategories || []; }; // for library.js bank picker
  window.idbKvGet = idbKvGet; // shared forever-cache for library.js (books, lists)
  window.idbKvSet = idbKvSet;
  async function setCachedQBank(id, data) {
    try {
      const db = await openQBankDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.put({ id, ...data });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch(e) {}
  }
  window.setCachedQBank = setCachedQBank;

  function pushToSyncQueue(update) {
    let queue = JSON.parse(localStorage.getItem('omnote_qbank_sync_queue') || '[]');
    queue.push(update);
    localStorage.setItem('omnote_qbank_sync_queue', JSON.stringify(queue));
    if (queue.length >= 10) {
      flushSyncQueue();
    }
  }

  function applyLocalQueueProgress(qbankId, progressObj) {
    if (!progressObj) progressObj = {};
    let queue = JSON.parse(localStorage.getItem('omnote_qbank_sync_queue') || '[]');
    queue.forEach(update => {
      if (update.qbankId === qbankId) {
        if (!progressObj[update.questionId]) progressObj[update.questionId] = {};
        if (update.correct !== undefined) progressObj[update.questionId].correct = update.correct;
        if (update.timeTakenMs !== undefined) progressObj[update.questionId].timeTakenMs = update.timeTakenMs;
        if (update.marked !== undefined) progressObj[update.questionId].marked = update.marked;
        if (update.note !== undefined) progressObj[update.questionId].note = update.note;
      }
    });
    return progressObj;
  }

  let cachedAuthToken = null;
  window.addEventListener('load', () => {
    if (window.firebase) {
      window.firebase.auth().onIdTokenChanged(async user => {
        if (user) {
          cachedAuthToken = await user.getIdToken();
          setTimeout(flushSyncQueue, 1500);
          // Drain any peer votes left queued by a previous session/tab.
          try { if (window.flushPeerVotes) setTimeout(() => window.flushPeerVotes(), 3000); } catch (_) {}
        } else {
          cachedAuthToken = null;
        }
      });
    }
  });

  async function flushSyncQueue() {
    let queue = JSON.parse(localStorage.getItem('omnote_qbank_sync_queue') || '[]');
    if (queue.length === 0 || isSyncing) return;
    isSyncing = true;
    try {
      const updates = [...queue];
      const token = cachedAuthToken || (window.firebase && window.firebase.auth().currentUser ? await window.firebase.auth().currentUser.getIdToken() : null);
      if (token) {
        fetch(`/api/qbank`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "batch_sync_progress", updates }),
          keepalive: true
        }).then(async res => {
          if (!res.ok) throw new Error(await res.text());
          let currentQueue = JSON.parse(localStorage.getItem('omnote_qbank_sync_queue') || '[]');
          currentQueue = currentQueue.slice(updates.length);
          localStorage.setItem('omnote_qbank_sync_queue', JSON.stringify(currentQueue));
        }).catch(e => {
          console.error("Keepalive sync failed", e);
        });
      }
    } catch (e) {
      console.error("Failed to sync QBank progress:", e);
    } finally {
      isSyncing = false;
    }
  }
  
  window.addEventListener('visibilitychange', () => { 
    if (document.visibilityState === 'hidden') {
      isSyncing = false; // Force allow!
      flushSyncQueue();
      try { if (window.flushPeerVotes) window.flushPeerVotes(); } catch (_) {}
    }
  });
  window.addEventListener('pagehide', () => {
    isSyncing = false; // Force allow!
    flushSyncQueue();
    try { if (window.flushPeerVotes) window.flushPeerVotes(); } catch (_) {}
  });

  const pendingApiGets = new Map();
  // On-demand answers (memory only, never persisted): stems ship in bulk,
  // correctIndices/explanation are fetched per block via get_answers (max 50
  // ids/call, server-throttled). Bulk scrape becomes thousands of calls.
  window.qbankAnswerCache = window.qbankAnswerCache || {};
  window.ensureQBankAnswers = async function(qbankId, ids) {
    if (!qbankId || !Array.isArray(ids) || ids.length === 0) return {};
    if (!window.qbankAnswerCache[qbankId]) window.qbankAnswerCache[qbankId] = {};
    const cache = window.qbankAnswerCache[qbankId];
    const missing = [...new Set(ids)].filter(id => !cache[id]);
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      try {
        const res = await apiGet("get_answers", { qbankId, ids: batch.join(",") });
        const ans = (res && res.answers) || {};
        for (const [qid, a] of Object.entries(ans)) cache[qid] = a;
        // Mark unfound so we don't refetch every render.
        for (const qid of batch) if (!cache[qid]) cache[qid] = {};
      } catch (e) {
        console.warn("get_answers failed", e);
        break;
      }
    }
    const out = {};
    for (const id of ids) if (cache[id]) out[id] = cache[id];
    return out;
  };
  window.mergeQBankAnswers = function(questions, qbankId) {
    const cache = (window.qbankAnswerCache && window.qbankAnswerCache[qbankId]) || {};
    for (const q of (questions || [])) {
      try {
        const a = q && q.id ? cache[q.id] : null;
        if (!a || typeof a !== "object") continue;
        if (!q.data || typeof q.data !== "object") continue;
        // Only fill gaps (keeps backward compat with old full IDB caches).
        for (const [k, v] of Object.entries(a)) {
          if (q.data[k] === undefined && v !== undefined) q.data[k] = v;
        }
        if (q.data.correctIndices === undefined && typeof q.data.correctOptionIndex === "number") {
          q.data.correctIndices = [q.data.correctOptionIndex];
        }
      } catch (_) {}
    }
    return questions;
  };
  async function apiGet(action, params = {}) {
    const qs = new URLSearchParams({ action, ...params }).toString();
    if (pendingApiGets.has(qs)) return pendingApiGets.get(qs);
    
    const promise = (async () => {
      const _u = window.firebase && firebase.auth().currentUser;
      if (!_u) throw new Error("Not signed in");
      const token = await _u.getIdToken();
      if (!token) throw new Error("Not signed in");
      const headers = { Authorization: `Bearer ${token}` };
      try {
        if (window.getAppCheckToken) {
          const ac = await window.getAppCheckToken();
          if (ac) headers["X-Firebase-AppCheck"] = ac;
        }
      } catch (_) {}
      const res = await fetch(`/api/qbank?${qs}`, {
        headers
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "API error");
      if (data.encryptedQuestions) {
        try {
            const bid = params.qbankId || params.qbankid || null;
            if (!bid) throw new Error("Missing qbankId for decrypt");
            const jsonStr = await window.decryptQBankPayload(data.encryptedQuestions, bid);
            data.questions = JSON.parse(jsonStr);
        } catch(e) {
            console.error("DRM decryption failed", e);
        }
      }
      return data;
    })();
    
    pendingApiGets.set(qs, promise);
    try {
      return await promise;
    } finally {
      pendingApiGets.delete(qs);
    }
  }

  async function apiPost(action, body) {
    const _u2 = window.firebase && firebase.auth().currentUser;
    if (!_u2) throw new Error("Not signed in");
    const token = await _u2.getIdToken();
    if (!token) throw new Error("Not signed in");
    const res = await fetch(`/api/qbank`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...body })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "API error");
    return data;
  }

  function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60).toString().padStart(2, "0");
    const s = (totalSec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function startTimer() {
    stopTimer();
    questionStartTime = Date.now();
    const display = document.getElementById("qbank-timer-display");
    if (display) display.innerHTML = `<i data-lucide="clock" style="width:14px;height:14px;vertical-align:-2px;"></i> Time: 00:00`;
    
    qbankTimer = setInterval(() => {
      const elapsed = Date.now() - questionStartTime;
      if (display) display.innerHTML = `<i data-lucide="clock" style="width:14px;height:14px;vertical-align:-2px;"></i> Time: ${formatTime(elapsed)}`;
    }, 1000);
  }

  function stopTimer() {
    if (qbankTimer) {
      clearInterval(qbankTimer);
      qbankTimer = null;
    }
  }

  window.preloadQBank = function() {
    if (!preloadPromise) {
      preloadPromise = (async () => {
        try {
          // Forever-cache hydrate: survive reloads / Vercel cold starts.
          // IDB holds { banks, maxUpdatedAt } with no TTL; the ?v=
          // revalidation below costs 0 Firestore reads when unchanged.
          if (!cachedCategories) {
            try {
              const saved = await idbKvGet(KV_KEYS.QBANK_LIST);
              if (saved && Array.isArray(saved.banks) && saved.banks.length) {
                cachedCategories = saved.banks;
                if (saved.maxUpdatedAt) window.__qbanksMaxUpdatedAt = saved.maxUpdatedAt;
              }
            } catch (_) {}
          }
          // Version-aware: send our known maxUpdatedAt; server answers
          // `{ unchanged: true }` with 0 Firestore reads when nothing was
          // published since. `window.__qbanksMaxUpdatedAt` persists for the
          // page session AND in IDB forever; cachedCategories is never refetched otherwise.
          // Only send v when we actually hold the matching list — otherwise
          // an `unchanged` answer would leave us with nothing to render.
          const params = {};
          if (window.__qbanksMaxUpdatedAt && cachedCategories) params.v = String(window.__qbanksMaxUpdatedAt);
          const res = await apiGet("list_categories", params);
          if (res.unchanged) return; // keep existing cachedCategories (memory + IDB)
          if (Array.isArray(res.qbanks)) {
            cachedCategories = res.qbanks;
            if (res.maxUpdatedAt) window.__qbanksMaxUpdatedAt = res.maxUpdatedAt;
            // Persist forever (fire-and-forget: never blocks render).
            try { idbKvSet(KV_KEYS.QBANK_LIST, { banks: cachedCategories, maxUpdatedAt: window.__qbanksMaxUpdatedAt || 0 }); } catch (_) {}
          } else if (res.maxUpdatedAt) {
            window.__qbanksMaxUpdatedAt = res.maxUpdatedAt;
          }
        } catch (e) {
          console.error("Preload QBank failed", e);
          preloadPromise = null; // allow retry
        }
      })();
    }
    return preloadPromise;
  };

  // --- Session persistence ---
  function saveQBankSession(qbankId, qbankName, subject) {
    try {
      const session = { qbankId, qbankName, subject, timestamp: Date.now() };
      localStorage.setItem("omnote_qbank_last_session", JSON.stringify(session));
      // Also save to recent list (max 5)
      let recent = [];
      try { recent = JSON.parse(localStorage.getItem("omnote_qbank_recent") || "[]"); } catch(e) {}
      recent = recent.filter(r => !(r.qbankId === qbankId && r.subject === subject));
      recent.unshift(session);
      if (recent.length > 5) recent = recent.slice(0, 5);
      localStorage.setItem("omnote_qbank_recent", JSON.stringify(recent));
    } catch(e) {}
  }

  function getLastSession() {
    try { return JSON.parse(localStorage.getItem("omnote_qbank_last_session") || "null"); } catch(e) { return null; }
  }

  function getRecentSessions() {
    try { return JSON.parse(localStorage.getItem("omnote_qbank_recent") || "[]"); } catch(e) { return []; }
  }

  // --- Country-based access bootstrap ---
  // Called once per session (from openQBank). Fetches the student's profile
  // country + admin-granted banks; auto-selects their first main bank if
  // nothing selected yet.
  window.bootstrapAccess = async function(force = false) {
    if (!force && window.__bootstrapPromise) {
      if (Date.now() - (window.__bootstrapCacheTime || 0) < 300_000) {
        return window.__bootstrapPromise;
      }
    }
    window.__bootstrapCacheTime = Date.now();
    window.__bootstrapPromise = (async () => {
      try {
        if (!window.db) window.db = {};
        const res = await apiGet("bootstrap_access");
        return window.applyAccessBundle(res);
      } catch (e) {
        console.warn("bootstrap_access failed", e);
        return null;
      }
    })();
    return window.__bootstrapPromise;
  };

  // Apply an access bundle (from bootstrap_access OR piggybacked on
  // get_questions?includeAccess=1 — identical shape by server contract).
  // Single source of truth for selection correction + memo seeding, so the
  // batched path can never diverge from the standalone call.
  window.applyAccessBundle = function(bundle) {
    if (!bundle) return null;
    if (!window.db) window.db = {};
    window.db.access = {
      country: bundle.profileCountry || "",
      mainIds: Array.isArray(bundle.mainIds) ? bundle.mainIds : [],
      prepIds: Array.isArray(bundle.prepIds) ? bundle.prepIds : [],
      grants: Array.isArray(bundle.grants) ? bundle.grants : [],
      legacy: !!bundle.legacy,
    };
    const a = window.db.access;
    const isAllowed = (id) => a.legacy || a.grants.includes(id) || a.mainIds.includes(id);
    if (window.db.selectedQBankId && !isAllowed(window.db.selectedQBankId)) {
      window.db.selectedQBankId = null;
    }
    if (!window.db.selectedQBankId && a.mainIds.length > 0) {
      window.db.selectedQBankId = a.mainIds[0];
    }
    if (typeof saveDb === "function") saveDb();
    // Seed the bootstrap memo so later bootstrapAccess() calls within
    // 5 min cost 0 HTTP.
    window.__bootstrapPromise = Promise.resolve(a);
    window.__bootstrapCacheTime = Date.now();
    return a;
  };

  window.qbankCanOpen = function(bankId) {
    const a = window.db && window.db.access;
    if (!a) return true; // fail-open before first bootstrap
    return a.grants.includes(bankId) || a.mainIds.includes(bankId) || a.prepIds.includes(bankId);
  };

  window.qbankRequestAccess = function(bankId, bankName) {
    // Styled modal (native prompt() can be suppressed by extensions/embeds)
    const old = document.getElementById("req-access-modal");
    if (old) old.remove();

    const ov = document.createElement("div");
    ov.id = "req-access-modal";
    ov.innerHTML = `
      <div class="ra-box">
        <div class="ra-head">
          <div>
            <div class="ra-title">Request Access</div>
            <div class="ra-sub">${window.escapeHtml ? window.escapeHtml(bankName) : bankName}</div>
          </div>
          <button type="button" class="ra-close">×</button>
        </div>
        <label class="ra-label">Why do you need this question bank?</label>
        <textarea id="ra-reason" rows="4" placeholder="e.g. I'm rotating at a Tunisian hospital next month…"></textarea>
        <div class="ra-status" id="ra-status"></div>
        <div class="ra-foot">
          <button type="button" class="btn-dark-pill ra-cancel">Cancel</button>
          <button type="button" id="ra-send" class="btn-action primary">Send Request</button>
        </div>
      </div>
      <style>${RA_CSS}</style>`;
    document.body.appendChild(ov);
    document.body.style.overflow = "hidden";
    setTimeout(() => ov.querySelector("#ra-reason").focus(), 60);

    const close = () => { ov.remove(); document.body.style.overflow = ""; };
    ov.querySelector(".ra-close").addEventListener("click", close);
    ov.querySelector(".ra-cancel").addEventListener("click", close);
    ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });

    ov.querySelector("#ra-send").addEventListener("click", async () => {
      const reason = (ov.querySelector("#ra-reason").value || "").trim();
      const statusEl = ov.querySelector("#ra-status");
      const sendBtn = ov.querySelector("#ra-send");
      if (reason.length < 5) {
        statusEl.textContent = "Please write a few words so the team can review your request.";
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending…";
      try {
        const token = await firebase.auth().currentUser.getIdToken();
        const res = await fetch("/api/qbank", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "request_access", qbankId: bankId, reason }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        close();
        if (typeof window.__markAccessPending === "function") window.__markAccessPending(bankId);
        else if (window.__pendingAccess instanceof Set) window.__pendingAccess.add(bankId);
        alert(data && data.alreadyRequested
          ? "You already have a pending request for this bank — you'll be notified once it's reviewed."
          : "Request sent! You'll get a notification once it's reviewed.");
      } catch (err) {
        statusEl.textContent = "";
        sendBtn.disabled = false;
        sendBtn.textContent = "Send Request";
        alert("Could not send request: " + (err.message || err));
      }
    });
  };

  const RA_CSS = `
  #req-access-modal { position: fixed; inset: 0; z-index: 999999; background: rgba(6,25,31,0.72);
    backdrop-filter: blur(5px); display: flex; align-items: center; justify-content: center; padding: 24px;
    font-family: 'Figtree', sans-serif; }
  .ra-box { width: min(480px, 100%); background: var(--bg-elevated, #16232a); color: var(--text-primary, #fff);
    border: 1px solid rgba(245,158,11,0.3); border-radius: 18px; padding: 24px 26px;
    box-shadow: 0 40px 90px -30px rgba(4,18,22,0.85); }
  .ra-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
  .ra-title { font-family: 'Outfit', sans-serif; font-size: 1.2rem; font-weight: 800; display: flex; align-items: center; gap: 8px; }
  .ra-title::before { content: ''; width: 20px; height: 20px; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23f59e0b' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='11' width='18' height='11' rx='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 10 0v4'/%3E%3C/svg%3E") center/contain no-repeat; }
  .ra-sub { font-size: 0.85rem; color: var(--text-muted, #8fa9b4); margin-top: 3px; }
  .ra-close { background: transparent; border: none; color: var(--text-muted, #7d97a3); font-size: 26px; cursor: pointer; line-height: 1; border-radius: 8px; width: 30px; height: 30px; }
  .ra-close:hover { color: #fff; background: rgba(244,63,94,0.15); }
  .ra-label { display: block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase;
    color: var(--accent-cyan, #2dd4bf); margin-bottom: 7px; }
  .ra-box textarea { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.12); color: var(--text-primary, #fff); padding: 12px 14px;
    border-radius: 10px; font-family: inherit; font-size: 0.93rem; resize: vertical; min-height: 96px; }
  .ra-box textarea:focus { outline: none; border-color: var(--accent-cyan, #2dd4bf); box-shadow: 0 0 0 3px rgba(14,124,134,0.18); }
  .ra-status { min-height: 18px; font-size: 0.82rem; color: #facc15; margin-top: 8px; }
  .ra-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px; }

  body.app-light-mode #req-access-modal { background: rgba(10,61,74,0.45); }
  body.app-light-mode .ra-box { background: #fff; border-color: #dbe3e7; color: #0a3d4a; }
  body.app-light-mode .ra-title { color: #0a3d4a; }
  body.app-light-mode .ra-sub { color: #6b7f88; }
  body.app-light-mode .ra-box textarea { background: #fff; border-color: #dbe3e7; color: #0a3d4a; }
  `;

  // --- QBank Selection ---
  window.selectQBank = async function(qbankId) {
      if (!qbankId) return;
      if (!window.db) window.db = {};
      // Client-side access guard: locked banks route to the request flow
      // instead of loading (server still enforces with 403). Fail-open only
      // before the first bootstrap, when we cannot know yet.
      try {
        if (typeof window.qbankCanOpen === "function" && window.db.access && !window.qbankCanOpen(qbankId)) {
          const meta = (cachedCategories || []).find(c => c.id === qbankId);
          window.qbankRequestAccess(qbankId, (meta && meta.name) || qbankId);
          return;
        }
      } catch (_) { /* fall through to the normal flow */ }
      // Commit the switch synchronously so nothing can render the old bank
      // while the dashboard loads (module state + persisted selection).
      window.db.selectedQBankId = qbankId;
      currentQBankId = qbankId;
      window.qbankCurrentSubjectStats = null;
      nextNavToken();
      try {
        if (typeof window.saveDb === "function") window.saveDb();
      } catch (_) {}
      await window.openQBank();
  };

  window.openQBankSelection = async function() {
    const myNav = nextNavToken();
    const area = document.getElementById("qbank-home-content");
    if (!area) { if (window.hideGlobalLoader) window.hideGlobalLoader(); return; }
    
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";

    area.innerHTML = `
      <div class="flex justify-center items-center h-64">
        <div class="press-wrapper" style="margin: 20px auto 0; display: flex; justify-content: center; align-items: center;">
            <div class="press">
              <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="roll"></div>
              <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="sheet"></div>
              <div class="sheet"></div><div class="sheet"></div><div class="sheet"></div><div class="roll"></div>
            </div>
        </div>
      </div>
    `;

    try {
      await window.preloadQBank();
      // Revalidate against the publish timestamp: 0 Firestore reads when
      // nothing was published since, fresh list otherwise (no reload needed
      // to see newly published banks).
        try {
          const params = {};
          if (window.__qbanksMaxUpdatedAt && cachedCategories) params.v = String(window.__qbanksMaxUpdatedAt);
          const re = await apiGet("list_categories", params);
          if (!re.unchanged && Array.isArray(re.qbanks)) {
            cachedCategories = re.qbanks;
            try { idbKvSet(KV_KEYS.QBANK_LIST, { banks: cachedCategories, maxUpdatedAt: window.__qbanksMaxUpdatedAt || re.maxUpdatedAt || 0 }); } catch (_) {}
          }
          if (re.maxUpdatedAt) window.__qbanksMaxUpdatedAt = re.maxUpdatedAt;
      } catch (e) { /* keep session cache on revalidation failure */ }
      if (navStale(myNav)) return;
      qbanks = cachedCategories || [];
      qbanks = qbanks.filter(q => q.kind !== "exam_prep");

      // Access must be FRESH before rendering, otherwise lock states lie:
      // a null access fail-opens (every foreign bank looks selectable) and
      // a stale memo hides just-approved grants. Always force here — the
      // server profile cache (60s) bounds this to ~1 read, and this page is
      // visited rarely. Falls back to the memo only when offline.
      try {
        await window.bootstrapAccess(true);
      } catch (_) {
        try { await window.bootstrapAccess(); } catch (_) {}
      }
      if (navStale(myNav)) return;

      // Banks already requested (pending review) render as "Pending" so a
      // repeat tap can never file a duplicate request.
      let pendingAccess = new Set();
      try {
        const pr = await apiGet("my_access_requests");
        if (pr && Array.isArray(pr.pendingIds)) pendingAccess = new Set(pr.pendingIds);
      } catch (_) {}
      window.__pendingAccess = pendingAccess;

      // Flip a selection-page row to "Pending" in place after a request is
      // filed (also used by the request modal on success). No-op elsewhere.
      window.__markAccessPending = function(bankId) {
        try {
          if (window.__pendingAccess instanceof Set) window.__pendingAccess.add(bankId);
          document.querySelectorAll(`[data-cta-bank="${bankId}"]`).forEach(el => {
            el.innerHTML = `<button disabled style="background:#F1F5F9; color:#64748B; border:none; padding:9px 18px; border-radius:6px; font-weight:700; font-size:13px; cursor:default; display:inline-flex; align-items:center; gap:8px; flex-shrink:0;"><i data-lucide="clock" style="width:14px;height:14px;"></i><span>Pending</span></button>`;
          });
          document.querySelectorAll(`[data-lock-pill="${bankId}"]`).forEach(el => {
            el.textContent = "PENDING";
            el.style.color = "#92400E";
            el.style.background = "#FEF3C7";
          });
          if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
        } catch (_) {}
      };

      if (qbanks.length === 0) {
        area.innerHTML = '<div style="max-width:1000px; margin:0 auto; padding:32px 24px; font-family:Inter,-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;"><div style="border:1px solid #F1F5F9; border-radius:6px; background:#FAFAFA; color:#64748B; text-align:center; padding:16px 12px; font-size:12px;">No QBanks available yet. Admins can create them in the Admin Panel.</div></div>';
        if (window.hideGlobalLoader) window.hideGlobalLoader();
        return;
      }
      if (typeof window.__epEnsureRowStyle === "function") window.__epEnsureRowStyle();

      let html = `<div style="max-width:1000px; margin:0 auto; padding:32px 24px; font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
        <div style="margin-bottom:20px;">
          <h2 style="margin:0; font-size:1.5rem; font-weight:700; color:#0F172A;">Select Question Bank</h2>
          <p style="margin:6px 0 0 0; font-size:0.9rem; color:#64748B;">Choose a bank to start practicing. You can switch anytime.</p>
        </div>
        <div style="font-size:12px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#64748B; margin:0 0 10px 0;">Available banks</div>
        <div class="ep-card-rows" style="background:#fff; border:1px solid #E2E8F0; border-radius:6px; padding:6px 16px;">`;

      const flagMap = { usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg", morocco: "ma", saudi: "sa", global: null };
      const countryLabels = { usa: "USA", uk: "UK", australia: "Australia", canada: "Canada", india: "India", europe: "Europe", tunisia: "Tunisia", algeria: "Algeria", egypt: "Egypt", morocco: "Morocco", saudi: "Saudi Arabia", global: "International" };
      const escQ = (s) => window.escapeHtml ? window.escapeHtml(s) : s;
      const acc = (window.db && window.db.access) || null;
      const isAllowedMain = (id) => !acc || acc.legacy || !acc.country || acc.grants.includes(id) || acc.mainIds.includes(id);

      for (const q of qbanks) {
        const countryCode = flagMap[q.country];
        const flagHtml = countryCode
           ? `<img src="https://flagcdn.com/${countryCode}.svg" alt="" style="width:28px; height:auto; border-radius:3px; box-shadow:0 1px 3px rgba(0,0,0,0.1);">`
           : `<span style="font-size:20px; line-height:1;">🌍</span>`;

        const cached = cachedQBanks[q.id];
        const qCount = cached ? (cached.questions || []).length : 0;
        const subLabel = qCount > 0
          ? `${escQ(countryLabels[q.country] || q.country || "")} &middot; ${qCount.toLocaleString()} questions`
          : escQ(countryLabels[q.country] || q.country || "");

        const allowed = isAllowedMain(q.id);
        const pending = !allowed && pendingAccess.has(q.id);
        const safeQName = String(q.name || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");

        const clickAttr = allowed
          ? `onclick="window.selectQBank('${q.id}')"`
          : (pending ? "" : `onclick="window.qbankRequestAccess('${q.id}','${safeQName}')"`);
        const rowCursor = allowed || pending ? (pending ? "cursor:default;" : "cursor:pointer;") : "cursor:pointer;";

        const cta = allowed
          ? `<button style="background:#007a7a; color:#fff; border:none; padding:9px 18px; border-radius:6px; font-weight:700; font-size:13px; cursor:pointer; display:inline-flex; align-items:center; gap:8px; flex-shrink:0;" onmouseover="this.style.background='#006666'" onmouseout="this.style.background='#007a7a'" onclick="event.stopPropagation(); window.selectQBank('${q.id}')">
               <span>Select</span>
               <i data-lucide="arrow-right" style="width:14px;height:14px;"></i>
             </button>`
          : (pending
            ? `<button disabled style="background:#F1F5F9; color:#64748B; border:none; padding:9px 18px; border-radius:6px; font-weight:700; font-size:13px; cursor:default; display:inline-flex; align-items:center; gap:8px; flex-shrink:0;">
                 <i data-lucide="clock" style="width:14px;height:14px;"></i>
                 <span>Pending</span>
               </button>`
            : `<button style="background:#FBEAEA; color:#C62828; border:none; padding:9px 18px; border-radius:6px; font-weight:700; font-size:13px; cursor:pointer; flex-shrink:0;" onclick="event.stopPropagation(); window.qbankRequestAccess('${q.id}','${safeQName}')">
                 <i data-lucide="lock" style="width:14px;height:14px;"></i>
                 <span>Request Access</span>
               </button>`);
        const pill = allowed
          ? ""
          : (pending
            ? `<span data-lock-pill="${q.id}" style="font-size:11px; font-weight:700; color:#92400E; background:#FEF3C7; padding:2px 9px; border-radius:999px; white-space:nowrap;">PENDING</span>`
            : `<span data-lock-pill="${q.id}" style="font-size:11px; font-weight:700; color:#C62828; background:#FBEAEA; padding:2px 9px; border-radius:999px; white-space:nowrap;">LOCKED</span>`);

        html += `
          <div class="qbank-select-card" style="display:flex; align-items:center; gap:10px; padding:10px 6px; margin:0 -6px; border-bottom:1px solid #F1F5F9; border-radius:4px; ${rowCursor} opacity:${allowed ? "1" : "0.65"};" ${clickAttr} onmouseover="this.style.background='#F8FAFC'" onmouseout="this.style.background='transparent'">
             <div style="flex-shrink:0; display:flex; align-items:center; justify-content:center; width:40px; height:40px; background:#e6f2f2; border-radius:6px; overflow:hidden;">
               ${flagHtml}
             </div>
             <div style="flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center; gap:2px;">
               <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                 <span style="font-size:15px; font-weight:700; color:#0F172A; line-height:1.3; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escQ(q.name)}</span>
                 ${pill}
               </div>
               <div style="font-size:12px; color:#64748B;">${subLabel}</div>
             </div>
             <div style="flex-shrink:0;" data-cta-bank="${q.id}">
               ${cta}
             </div>
          </div>`;
      }

      html += `</div></div>`;
      area.innerHTML = html;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      if (window.hideGlobalLoader) window.hideGlobalLoader();
    } catch (e) {
      area.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);">Failed to load QBanks: ${e.message}</div>`;
      if (window.hideGlobalLoader) window.hideGlobalLoader();
    }
  };

  // --- QBank Home Dashboard ---
  window.openQBank = async function () {
    const myNav = nextNavToken();
    const area = document.getElementById("qbank-home-content");
    if (!area) { if (window.hideGlobalLoader) window.hideGlobalLoader(); return; }
    
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";
    
    // Ensure we are on the QBank platform
    if (localStorage.getItem("omnote_active_platform") !== "qbank") {
        window.switchPlatform("qbank");
        return; // switchPlatform will call openQBank again
    }

    if (window.hideAllMainViews) window.hideAllMainViews();

    const qbankView = document.getElementById("qbank-home-view");
    if (qbankView) qbankView.style.display = "flex";
    // Update Sidebar active state
    if (window.setQBankNav) window.setQBankNav('home');

    // Load peer stats threshold
    _loadPeerThreshold();

    area.innerHTML = `
      <div class="flex flex-col justify-center items-center h-64 gap-4">
        <div class="press-wrapper" style="margin: 20px auto 0; display: flex; justify-content: center; align-items: center;">
            <div class="press">
              <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="roll"></div>
              <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="sheet"></div>
              <div class="sheet"></div><div class="sheet"></div><div class="sheet"></div><div class="roll"></div>
            </div>
        </div>
      </div>
      <style>
        @keyframes loading-bar-indeterminate {
          0% { transform: translateX(-100%) scaleX(0.2); }
          50% { transform: translateX(0) scaleX(1); }
          100% { transform: translateX(100%) scaleX(0.2); }
        }
      </style>
    `;
    
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    
    try {
      if (!window.db || !window.db.selectedQBankId) {
        try { await window.openQBankSelection(); }
        finally { if (window.hideGlobalLoader) window.hideGlobalLoader(); }
        return;
      }
      const activeQBankId = window.db.selectedQBankId;

      if (cachedQBanks[activeQBankId]) {
        await window.bootstrapAccess(); // memoized (5 min) — usually 0 HTTP
        if (navStale(myNav)) return;
        // Bootstrap may correct the selection (revoked bank -> first allowed).
        // Restart once with the corrected id instead of rendering a stale mix.
        if (!window.db || window.db.selectedQBankId !== activeQBankId) {
          return window.openQBank();
        }
      }
      // Else: standalone bootstrap SKIPPED — the progress fetch below carries
      // ?includeAccess=1 and applies the same bundle (fresher than memo,
      // 0 extra HTTP). The correction restart happens after it lands.
      // Commit the active bank NOW so "Browse Specialties" can never fall
      // back to the previous bank, even if question loading below fails.
      currentQBankId = activeQBankId;
      await window.preloadQBank();
      if (navStale(myNav)) return;
      qbanks = (cachedCategories || []).filter(q => q.kind !== "exam_prep");
      
      if (qbanks.length === 0) {
        area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">No QBanks available yet. Admins can create them in the Admin Panel.</div>';
        if (window.hideGlobalLoader) window.hideGlobalLoader();
        return;
      }

      const activeQBankMeta = (cachedCategories || []).find(qb => qb.id === activeQBankId) || qbanks.find(qb => qb.kind !== "exam_prep") || qbanks[0];
      const activeQBankName = activeQBankMeta ? activeQBankMeta.name : "Your QBank";
      const isActiveExamPrep = activeQBankMeta && activeQBankMeta.kind === "exam_prep";
      
       if (!cachedQBanks[activeQBankId]) {
          area.innerHTML = `
           <div class="flex flex-col justify-center items-center h-64 gap-4">
             <div class="press-wrapper" style="margin: 20px auto 0; display: flex; justify-content: center; align-items: center;">
                 <div class="press">
                   <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="roll"></div>
                   <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="sheet"></div>
                   <div class="sheet"></div><div class="sheet"></div><div class="sheet"></div><div class="roll"></div>
                 </div>
             </div>
             <div class="text-on-surface-variant text-sm">Loading details...</div>
           </div>`;
          let batchedAccess = null; // ?includeAccess=1 piggyback (replaces standalone bootstrap)
          try {
              const catUpdated = activeQBankMeta.updatedAt || 0;
              const idbData = await getCachedQBank(activeQBankId);
              if (idbData && idbData.updatedAt === catUpdated && idbData.questions && idbData.questions.length > 0) {
                  // Questions are fresh in IndexedDB — only fetch progress (tiny, private)
                  // + access bundle (batched: 0 extra HTTP vs standalone bootstrap).
                  const res = await apiGet("get_questions", { qbankId: activeQBankId, onlyProgress: true, includeAccess: true });
                  cachedQBanks[activeQBankId] = { questions: idbData.questions, progress: applyLocalQueueProgress(activeQBankId, res.progress || {}) };
                  if (res.access) batchedAccess = res.access;
               } else {
                  // Questions outdated or missing — download stems from the
                  // authenticated private static endpoint (per-bank key, no
                  // public CDN cache) + progress/access in parallel.
                  const [staticRes, progressRes] = await Promise.all([
                    (async () => {
                      const headers = await window.qbankAuthHeaders();
                      const r = await fetch(`/api/qbank_static?qbankId=${encodeURIComponent(activeQBankId)}&v=${encodeURIComponent(catUpdated)}`, { headers });
                      const d = await r.json();
                      if (!r.ok) throw new Error(d.error || 'Static fetch failed');
                      let questions = d.questions || [];
                      if (d.encryptedQuestions && window.decryptQBankPayload) {
                        try {
                          const jsonStr = await window.decryptQBankPayload(d.encryptedQuestions, activeQBankId);
                          questions = JSON.parse(jsonStr);
                        } catch(e) { console.error('DRM decryption failed', e); }
                      }
                      return questions;
                    })(),
                     apiGet("get_questions", { qbankId: activeQBankId, onlyProgress: true, includeAccess: true })
                   ]);
                  const questions = staticRes;
                  const progress = progressRes.progress || {};
                  if (progressRes.access) batchedAccess = progressRes.access;
                  cachedQBanks[activeQBankId] = { questions, progress: applyLocalQueueProgress(activeQBankId, progress) };
                  // Persist STEMS to IndexedDB so next visit is instant.
                  // Answers are never persisted: they are fetched per block
                  // via get_answers (memory only).
                  setCachedQBank(activeQBankId, { updatedAt: catUpdated, questions });
               }
           } catch (e) {
               const msg = String((e && e.message) || e);
               if (/forbidden|403/i.test(msg)) {
                 // Stale selection (grant revoked) — standalone bootstrap was
                 // skipped, so correct the selection now and restart once.
                 try { await window.bootstrapAccess(true); } catch (_) {}
                 if (navStale(myNav)) return;
                 return window.openQBank();
               }
               console.error("Failed to load bank data", e);
           }
           // Batched access landed with progress: same correction restart the
           // standalone bootstrap used to do, minus one HTTP roundtrip.
           if (batchedAccess && window.applyAccessBundle) {
             window.applyAccessBundle(batchedAccess);
             if (navStale(myNav)) return;
             if (!window.db || window.db.selectedQBankId !== activeQBankId) {
               return window.openQBank();
             }
           }
        }
       if (navStale(myNav)) return;

      let totalQuestions = 0;
      let totalAnswered = 0;
      let totalCorrect = 0;
      let totalMarked = 0;
      let subjectStats = {};
      
      const qData = cachedQBanks[activeQBankId];
      if (qData) {
        // Set module-level allQuestions for startQBankFiltered
        allQuestions = qData.questions || [];
        window.qbankProgress = qData.progress || {};
        currentQBankId = activeQBankId;
        
        totalQuestions = (qData.questions || []).length;
        const prog = qData.progress || {};
        for (const q of (qData.questions || [])) {
           const sub = (q.data && q.data.subject) || "Uncategorized";
           if (!subjectStats[sub]) subjectStats[sub] = { total: 0, answered: 0, correct: 0 };
           subjectStats[sub].total++;
           if (prog[q.id]) {
             if (prog[q.id].correct !== undefined) { 
               totalAnswered++; 
               subjectStats[sub].answered++;
               if (prog[q.id].correct) {
                 totalCorrect++; 
                 subjectStats[sub].correct++;
               }
             }
             if (prog[q.id].marked) totalMarked++;
           }
        }
      }
      
      const globalScore = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;
      const scoreColor = globalScore >= 80 ? '#22c55e' : (globalScore >= 50 ? '#eab308' : '#f43f5e');
      
      const lastSession = getLastSession();
      const recentSessions = getRecentSessions();
      
      let specialtyStats = [];
      for (const [sub, stat] of Object.entries(subjectStats)) {
          if (sub === "Uncategorized") continue;
          let specScore = stat.answered > 0 ? Math.round((stat.correct / stat.answered) * 100) : 0;
          specialtyStats.push({ name: sub, total: stat.total, answered: stat.answered, score: specScore });
      }
      specialtyStats.sort((a, b) => b.answered - a.answered || b.total - a.total);
      
      let specialtyHtml = '';
      if (specialtyStats.length > 0) {
        const topSpecs = specialtyStats.slice(0, 4);
        topSpecs.forEach(spec => {
          let colorClass = spec.score >= 80 ? 'bg-primary' : (spec.score >= 50 ? 'bg-primary/70' : 'bg-error/70');
          specialtyHtml += `
            <div>
              <div class="flex justify-between text-sm mb-1">
                <span class="font-medium">${window.escapeHtml ? window.escapeHtml(spec.name) : spec.name}</span>
                <span class="text-on-surface-variant">${spec.score}% (${spec.answered}/${spec.total})</span>
              </div>
              <div class="w-full bg-surface-container rounded-full h-2">
                <div class="${colorClass} h-2 rounded-full" style="width: ${spec.score}%"></div>
              </div>
            </div>`;
        });
      } else {
        specialtyHtml = '<div class="text-on-surface-variant text-sm">No specialty data yet. Start practicing!</div>';
      }

      // Continuing Session HTML
      let continueSessionHtml = '';
      if (lastSession && lastSession.qbankId) {
        const lastBankName = lastSession.qbankName || "QBank";
        const lastSubject = lastSession.subject && lastSession.subject !== "All Subjects" ? lastSession.subject : "active";
        
        let subStat = subjectStats[lastSubject];
        let progPct = 0;
        let answeredStr = "Q0 / 0";
        if (subStat && subStat.total > 0) {
            progPct = Math.round((subStat.answered / subStat.total) * 100);
            answeredStr = `Q${subStat.answered} / ${subStat.total}`;
        } else {
            // Fallback to global if subject isn't active
            progPct = totalQuestions > 0 ? Math.round((totalAnswered / totalQuestions) * 100) : 0;
            answeredStr = `Q${totalAnswered} / ${totalQuestions}`;
        }
        
        continueSessionHtml = `
          <div class="mb-4">
              <h3 class="font-title-md text-[20px] mb-2 font-bold">Continue ${window.escapeHtml ? window.escapeHtml(lastSubject) : lastSubject}</h3>
              <p class="font-body-md opacity-90">${answeredStr}</p>
          </div>
          <div class="flex items-center gap-3 mb-6">
              <div class="h-1.5 flex-1 bg-surface-container-highest/30 rounded-full overflow-hidden">
                  <div class="h-full bg-on-primary rounded-full transition-all" style="width: ${progPct}%"></div>
              </div>
              <span class="text-sm font-bold">${progPct}%</span>
          </div>
          <div class="flex items-center gap-2 font-label-caps text-label-caps tracking-widest mt-auto">
              CONTINUE <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
          </div>
        `;
      } else {
        continueSessionHtml = `
          <div class="mb-4">
              <h3 class="font-title-md text-[20px] mb-2 font-bold">Start Session</h3>
              <p class="font-body-md opacity-90 mb-6">Start a new practice block.</p>
          </div>
          <div class="flex items-center gap-2 font-label-caps text-label-caps tracking-widest mt-auto">
              START <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
          </div>
        `;
      }

      // Review Incorrects HTML
      let incorrectBySubject = [];
      for (const [sub, stat] of Object.entries(subjectStats)) {
          let inc = stat.answered - stat.correct;
          if (inc > 0 && sub !== "Uncategorized") {
              incorrectBySubject.push({ name: sub, count: inc });
          }
      }
      incorrectBySubject.sort((a,b) => b.count - a.count);
      
      let reviewIncorrectsHtml = '';
      if (incorrectBySubject.length > 0) {
          const topInc = incorrectBySubject.slice(0, 3);
          const totalInc = incorrectBySubject.reduce((sum, item) => sum + item.count, 0);
          
          let breakdown = '';
          topInc.forEach(inc => {
              breakdown += `<div class="text-sm text-on-surface-variant mb-1 flex items-center gap-2"><span class="font-bold text-on-surface w-6 text-right">${inc.count}</span> <span class="truncate">${window.escapeHtml ? window.escapeHtml(inc.name) : inc.name}</span></div>`;
          });
          
          reviewIncorrectsHtml = `
            <div class="mb-4">
                <h3 class="font-title-md text-[20px] mb-2 font-bold text-primary">Review Incorrects</h3>
                <p class="font-body-md font-bold mb-3">${totalInc} questions</p>
                <div class="flex flex-col">${breakdown}</div>
            </div>
            <div class="flex items-center gap-2 font-label-caps text-label-caps text-primary tracking-widest mt-auto pt-4">
                REVIEW <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
            </div>
          `;
      } else {
          reviewIncorrectsHtml = `
            <div class="mb-4">
                <h3 class="font-title-md text-[20px] mb-2 font-bold text-primary">Review Incorrects</h3>
                <p class="font-body-md font-bold text-primary mb-2">You're all caught up 🎉</p>
                <p class="font-body-md text-on-surface-variant text-sm">No incorrect questions waiting for review.</p>
            </div>
            <div class="flex items-center gap-2 font-label-caps text-label-caps text-primary tracking-widest mt-auto pt-4">
                START NEW BLOCK <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
            </div>
          `;
      }
      
      // Weak Areas HTML
      let weakAreas = specialtyStats.filter(s => s.answered > 0).sort((a, b) => a.score - b.score).slice(0, 3);
      let weakAreasHtml = '';
      if (weakAreas.length > 0) {
          let list = '';
          weakAreas.forEach(wa => {
              list += `
              <div class="mb-3 last:mb-0">
                  <div class="flex justify-between text-sm mb-1">
                      <span class="font-medium truncate mr-2">${window.escapeHtml ? window.escapeHtml(wa.name) : wa.name}</span>
                      <span class="text-on-surface-variant">${wa.score}%</span>
                  </div>
                  <div class="w-full bg-surface-container rounded-full h-1.5">
                      <div class="bg-[var(--accent-purple)] h-1.5 rounded-full transition-all" style="width: ${wa.score}%"></div>
                  </div>
              </div>`;
          });
          weakAreasHtml = `
            <div class="mb-4 flex-1 w-full">
                <h3 class="font-title-md text-[20px] mb-2 font-bold" style="color:var(--accent-purple);">Weak Areas</h3>
                <p class="text-xs text-on-surface-variant mb-4">Topics where you need the most practice</p>
                <div class="flex flex-col w-full">${list}</div>
            </div>
            <div class="flex items-center gap-2 font-label-caps text-label-caps tracking-widest mt-auto pt-2" style="color:var(--accent-purple);">
                PRACTICE WEAK AREAS <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
            </div>
          `;
      } else {
          weakAreasHtml = `
            <div class="mb-4 flex-1">
                <h3 class="font-title-md text-[20px] mb-2 font-bold" style="color:var(--accent-purple);">Weak Areas</h3>
                <p class="text-sm text-on-surface-variant mt-4">Answer more questions to reveal your weak areas.</p>
            </div>
            <div class="flex items-center gap-2 font-label-caps text-label-caps tracking-widest mt-auto pt-2" style="color:var(--accent-purple);">
                BROWSE SUBJECTS <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
            </div>
          `;
      }
      
      let recentActivityHtml = '';
      if (recentSessions && recentSessions.length > 0) {
        recentSessions.forEach(rs => {
            const timeDiff = Date.now() - (rs.timestamp || Date.now());
            let timeStr = 'just now';
            const mins = Math.floor(timeDiff / 60000);
            if (mins > 0 && mins < 60) timeStr = `${mins}m ago`;
            else if (mins >= 60 && mins < 1440) timeStr = `${Math.floor(mins / 60)}h ago`;
            else if (mins >= 1440) timeStr = `${Math.floor(mins / 1440)}d ago`;

            let subStat = subjectStats[rs.subject];
            let score = 0;
            if (subStat && subStat.answered > 0) {
                score = Math.round((subStat.correct / subStat.answered) * 100);
            } else if (rs.subject === "All Subjects") {
                score = globalScore;
            }
            
            const colorClass = score >= 80 ? 'bg-primary' : (score >= 50 ? 'bg-primary/70' : 'bg-error/70');
            const icon = rs.subject === "All Subjects" ? "dashboard" : "psychology";

            recentActivityHtml += `
            <div class="flex items-center p-3 rounded-xl hover:bg-surface-container transition-colors group cursor-pointer" onclick="window.startQBankSession('${rs.qbankId}', '${window.escapeHtml ? window.escapeHtml(rs.qbankName) : rs.qbankName}', '${window.escapeHtml ? window.escapeHtml(rs.subject) : rs.subject}')">
              <div class="w-10 h-10 rounded-full bg-primary-container/30 flex items-center justify-center mr-3">
                <span class="material-symbols-outlined text-primary text-sm">${icon}</span>
              </div>
              <div class="flex-1 min-w-0">
                <h4 class="font-title-md text-sm text-on-surface truncate">${window.escapeHtml ? window.escapeHtml(rs.subject) : rs.subject}</h4>
                <div class="flex items-center gap-2 mt-1">
                  <div class="h-1 w-12 bg-surface-container-highest rounded-full overflow-hidden">
                    <div class="h-full ${colorClass} rounded-full" style="width: ${score}%"></div>
                  </div>
                  <span class="font-label-sm text-[10px] text-on-surface-variant">${score}%</span>
                </div>
              </div>
              <span class="font-label-sm text-[10px] text-on-surface-variant opacity-60 group-hover:opacity-100 transition-opacity whitespace-nowrap">${timeStr}</span>
            </div>
            `;
        });
      } else {
          recentActivityHtml = `<div class="text-on-surface-variant text-sm p-4 text-center">No recent sessions yet. Start practicing!</div>`;
      }

      let resourcesHtml = '';
      if (activeQBankMeta.resources && activeQBankMeta.resources.length > 0) {
        let normalizedResources = [];
        let uncategorized = [];
        
        activeQBankMeta.resources.forEach(r => {
            if (r.isCategory) {
                normalizedResources.push(r);
            } else {
                uncategorized.push(r);
            }
        });
        if (uncategorized.length > 0) {
            normalizedResources.push({ id: 'cat-general', isCategory: true, title: 'General Resources', items: uncategorized });
        }
        
        let catsHtml = normalizedResources.map(cat => {
            if (!cat.items || cat.items.length === 0) return '';
            let itemsHtml = cat.items.map(r => {
                let icon = 'link';
                let color = 'text-primary';
                let action = `href="${window.escapeHtml ? window.escapeHtml(r.url) : r.url}" target="_blank"`;
                
                if (r.type === 'youtube') { 
                    icon = 'play_circle'; 
                    color = 'text-[#ef4444]'; 
                    action = `href="javascript:void(0)" onclick="window.openYouTubeModal('${r.url}')"`;
                }
                if (r.type === 'pdf') { icon = 'picture_as_pdf'; color = 'text-[#3b82f6]'; }
                if (r.type === 'flashcards') { icon = 'style'; color = 'text-[#eab308]'; }
                
                return `
                <a ${action} class="flex items-center gap-3 p-4 rounded-xl bg-surface-container hover:bg-surface-container-high transition-colors group border border-transparent hover:border-outline-variant/30">
                  <div class="w-10 h-10 rounded-full bg-surface-container-highest flex items-center justify-center flex-shrink-0 group-hover:scale-105 transition-transform">
                    <span class="material-symbols-outlined ${color}">${icon}</span>
                  </div>
                  <div class="flex-1 min-w-0">
                    <h4 class="font-title-sm text-sm text-on-surface truncate font-medium">${window.escapeHtml ? window.escapeHtml(r.title || r.url) : (r.title || r.url)}</h4>
                    ${r.description ? `<p class="text-xs text-on-surface-variant truncate opacity-80 mt-1">${window.escapeHtml(r.description)}</p>` : ''}
                  </div>
                  <span class="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity -translate-x-2 group-hover:translate-x-0">open_in_new</span>
                </a>
                `;
            }).join('');
            
            return `
            <div class="mb-6 last:mb-0">
              <h4 class="text-sm font-label-caps text-on-surface-variant tracking-wider uppercase mb-3 px-1">${window.escapeHtml ? window.escapeHtml(cat.title) : cat.title}</h4>
              <div class="flex flex-col gap-2">
                ${itemsHtml}
              </div>
            </div>
            `;
        }).join('');
        
        resourcesHtml = `
        <div class="flex flex-col mt-6" id="qbank-resources-widget">
          <div class="flex items-center justify-between mb-4">
            <h2 class="font-headline-lg text-[20px] text-on-surface flex items-center gap-2">
                <span class="material-symbols-outlined text-primary">auto_stories</span> Study Resources
            </h2>
          </div>
          <div class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm border border-outline-variant/30">
            ${catsHtml}
          </div>
        </div>
        `;
      }

      let safeBankName = activeQBankName.replace(/'/g, "\\'");
      
      const flagMap = { usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg", morocco: "ma" };
      let flagHtml = '';
      let smallFlagHtml = '';
      if (activeQBankMeta && activeQBankMeta.country && activeQBankMeta.country !== "global") {
          const countryCode = flagMap[activeQBankMeta.country];
          if (countryCode) {
              flagHtml = `<img src="https://flagcdn.com/${countryCode}.svg" alt="${countryCode}" style="height:32px; width:auto; border-radius:4px; box-shadow:0 2px 6px rgba(0,0,0,0.15);" class="inline-block mr-3 align-text-bottom">`;
              smallFlagHtml = `<img src="https://flagcdn.com/${countryCode}.svg" alt="${countryCode}" style="height:13px; width:auto; border-radius:2px;" class="inline-block mr-1.5 align-middle">`;
          }
      }
      
      const hour = new Date().getHours();
      let greeting = "Good morning";
      if (hour >= 12 && hour < 17) greeting = "Good afternoon";
      else if (hour >= 17) greeting = "Good evening";

      let firstName = "Doctor";
      const headerNameEl = document.getElementById("header-user-name");
      if (headerNameEl && headerNameEl.innerText) {
          let full = headerNameEl.innerText.replace(/Dr\.?\s+/i, "").trim();
          firstName = full.split(" ")[0] || "Doctor";
      }

      // CLINICAL DASHBOARD REDESIGN
      let isSessionCompleted = false;
      let lastSubject = "All Subjects";
      let progPct = 0;
      let answeredStr = "Q0 / 0";
      let subStat = null;

      if (lastSession && lastSession.qbankId) {
          lastSubject = lastSession.subject && lastSession.subject !== "All Subjects" ? lastSession.subject : "All Subjects";
          subStat = subjectStats[lastSubject];
          if (subStat && subStat.total > 0) {
              progPct = Math.round((subStat.answered / subStat.total) * 100);
              answeredStr = `Q${subStat.answered} / ${subStat.total}`;
          } else {
              progPct = totalQuestions > 0 ? Math.round((totalAnswered / totalQuestions) * 100) : 0;
              answeredStr = `Q${totalAnswered} / ${totalQuestions}`;
          }
          if (progPct >= 100) isSessionCompleted = true;
      }

      // Calculate correct/incorrect
      let totalIncorrect = totalAnswered - totalCorrect;
      let totalUnused = Math.max(0, totalQuestions - totalAnswered);
      
      let pctCorrect = totalQuestions > 0 ? (totalCorrect / totalQuestions) * 100 : 0;
      let pctIncorrect = totalQuestions > 0 ? (totalIncorrect / totalQuestions) * 100 : 0;
      let pctUnused = totalQuestions > 0 ? (totalUnused / totalQuestions) * 100 : 100;

      const streakVal = window.studyGoals ? window.studyGoals.computeStreak() : 0;

      // Performance Overview - Donut Chart (new version)

      const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

      // Header Section (compact clinical)
      const escName = window.escapeHtml ? window.escapeHtml(firstName) : firstName;
      let headerHtml = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px;">
          <div>
              <h1 style="font-size:20px; font-weight:700; color:#0F172A; margin:0 0 2px 0; letter-spacing:-0.01em;">Good ${greeting.toLowerCase().replace('good ', '')}, ${escName}</h1>
              <p style="color:#64748B; font-size:12.5px; margin:0;">Consistency today builds the doctor you want to be tomorrow.</p>
          </div>
          <div style="display:flex; align-items:center; gap:10px;">
              <div style="display:flex; align-items:center; gap:8px; background:#fff; padding:6px 12px; border-radius:6px; border:1px solid #E2E8F0;">
                  <span style="background:#e6f2f2; width:26px; height:26px; border-radius:6px; display:inline-flex; align-items:center; justify-content:center;">
                      <i class="fa-solid fa-fire" style="color:#007a7a; font-size:13px;"></i>
                  </span>
                  <span style="font-size:13px; font-weight:700; color:#0F172A;">${streakVal}d</span>
                  <span style="font-size:11px; color:#64748B; font-weight:600;">STREAK</span>
              </div>
              <div style="color:#64748B; font-size:12px;">${dateStr}</div>
          </div>
      </div>
      `;

      // Card 1: Continue Studying (primary call to action, visually dominant)
      const escLastSubject = window.escapeHtml ? window.escapeHtml(lastSubject) : lastSubject;
      let continueCardHtml = '';
      if (lastSession && lastSession.qbankId && !isSessionCompleted) {
          const subjScore = subStat && subStat.answered > 0 ? Math.round((subStat.correct / subStat.answered) * 100) : 0;
          const scoreBadge = subjScore >= 70
              ? `<span class="clin-badge clin-badge-good">${subjScore}%</span>`
              : (subjScore >= 50
                  ? `<span class="clin-badge clin-badge-warn">${subjScore}%</span>`
                  : `<span class="clin-badge clin-badge-bad">${subjScore}%</span>`);
          continueCardHtml = `
          <div class="clin-card clin-glass" style="display:flex; flex-direction:column; position:relative; overflow:hidden;">
              <div style="position:absolute; top:25%; left:-5%; width:110%; height:75%; opacity:0.04; pointer-events:none; z-index:0;">
                 <svg viewBox="0 0 500 100" preserveAspectRatio="none" style="width:100%; height:100%;">
                     <path d="M0 50 L100 50 L120 20 L140 80 L160 50 L180 50 L200 50 L210 30 L230 70 L250 50 L500 50" fill="none" stroke="#007a7a" stroke-width="4"/>
                 </svg>
              </div>
              <div style="position:relative; z-index:1; display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                  <h2 class="clin-card-title"><i class="fa-solid fa-book-open" style="color:#007a7a;"></i>Continue studying <span class="micro-tag live">Live</span></h2>
                  <a href="#" onclick="window.openExamPrepTab && window.openExamPrepTab(); return false;" style="color:#64748B; font-size:11.5px; text-decoration:none; font-weight:600;">Change</a>
              </div>
              <div style="position:relative; z-index:1; font-weight:700; color:#0F172A; font-size:16px; margin-bottom:4px;">${escLastSubject}</div>
              <div class="clin-muted" style="position:relative; z-index:1; font-size:12px; margin-bottom:2px;">${subStat ? subStat.answered : 0} of ${subStat ? subStat.total : 0} answered &middot; last score ${scoreBadge}</div>
              <div class="clin-muted" style="position:relative; z-index:1; font-size:12px; margin-bottom:12px;">${lastSubject === "All Subjects" ? "Mixed review block" : "Priority topic review"} &middot; ~15 Qs &middot; ~12 min</div>
              <div style="margin-top:auto; position:relative; z-index:1;">
                  <button class="clin-btn-primary" onclick="window.qbankContinueLast()">
                      Continue session <i class="fa-solid fa-arrow-right" style="font-size:12px;"></i>
                  </button>
              </div>
          </div>
          `;
      } else {
          continueCardHtml = `
          <div class="clin-card clin-glass" style="display:flex; flex-direction:column;">
              <h2 class="clin-card-title"><i class="fa-solid fa-book-open" style="color:#007a7a;"></i>Continue studying <span class="micro-tag live">Ready</span></h2>
              <div class="clin-muted" style="font-size:12.5px; margin:2px 0 12px;">Ready to dive in? Start a block to track progress.</div>
              <div style="margin-top:auto;">
                  <button class="clin-btn-primary" onclick="window.openExamPrepTab && window.openExamPrepTab()">
                      Start new session <i class="fa-solid fa-arrow-right" style="font-size:12px;"></i>
                  </button>
              </div>
          </div>
          `;
      }

      // Wide analytics + diagnostics card (donut, badges, sparkline)
      let strongestAreas = specialtyStats.filter(s => s.answered > 0).sort((a, b) => b.score - a.score);
      let topStrong = strongestAreas.length > 0 ? strongestAreas[0] : null;
      let topWeakPerf = weakAreas && weakAreas.length > 0 ? weakAreas[0] : null;
      const escStrong = topStrong && window.escapeHtml ? window.escapeHtml(topStrong.name) : (topStrong ? topStrong.name : '');
      const escWeak = topWeakPerf && window.escapeHtml ? window.escapeHtml(topWeakPerf.name) : (topWeakPerf ? topWeakPerf.name : '');

      // Donut geometry (SVG ring)
      const _C = 2 * Math.PI * 54;
      const _off = (_C * (1 - globalScore / 100)).toFixed(1);
      const _donutColor = globalScore >= 70 ? '#007a7a' : (globalScore >= 50 ? '#D97706' : '#DC2626');

      // Sparkline: current score of each recent session's subject, oldest -> newest
      let _trendPts = [];
      try {
        (recentSessions || []).slice(0, 9).forEach(rs => {
          let sc = null;
          const st = rs && rs.subject ? subjectStats[rs.subject] : null;
          if (st && st.answered > 0) sc = Math.round((st.correct / st.answered) * 100);
          else if (rs && rs.subject === 'All Subjects' && totalAnswered > 0) sc = globalScore;
          if (sc !== null) _trendPts.push(sc);
        });
        _trendPts.reverse();
        if (totalAnswered > 0) _trendPts.push(globalScore);
        _trendPts = _trendPts.slice(-10);
      } catch (_) { _trendPts = totalAnswered > 0 ? [globalScore] : []; }
      let _sparkHtml = '';
      if (_trendPts.length >= 2) {
        const W = 150, H = 36, P = 3;
        const min = Math.min.apply(null, _trendPts), max = Math.max.apply(null, _trendPts);
        const span = Math.max(1, max - min);
        const stepX = (W - P * 2) / (_trendPts.length - 1);
        const pts = _trendPts.map((v, i) => {
          const x = (P + i * stepX).toFixed(1);
          const y = (H - P - ((v - min) / span) * (H - P * 2)).toFixed(1);
          return x + ',' + y;
        }).join(' ');
        const lastX = (P + (_trendPts.length - 1) * stepX).toFixed(1);
        _sparkHtml = `
          <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block; overflow:visible;">
            <defs>
              <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#007a7a" stop-opacity="0.25"/>
                <stop offset="100%" stop-color="#007a7a" stop-opacity="0"/>
              </linearGradient>
              <filter id="neonGlow">
                <feGaussianBlur stdDeviation="1.5" result="coloredBlur"/>
                <feMerge>
                  <feMergeNode in="coloredBlur"/>
                  <feMergeNode in="SourceGraphic"/>
                </feMerge>
              </filter>
            </defs>
            <polygon points="${P},${H} ${pts} ${lastX},${H}" fill="url(#trendGrad)"></polygon>
            <polyline points="${pts}" fill="none" stroke="#007a7a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#neonGlow)"></polyline>
          </svg>
          <div class="clin-muted" style="font-size:11px; margin-top:4px;">Recent trend &middot; last ${_trendPts.length} blocks</div>`;
      } else {
        _sparkHtml = `
        <div class="clin-empty" style="position:relative; overflow:hidden; padding:12px 10px;">
            <div style="position:absolute; bottom:-4px; left:0; width:100%; opacity:0.15; pointer-events:none; mask-image: linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,1) 100%); -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,1) 100%);">
                <svg width="100%" height="40" preserveAspectRatio="none" viewBox="0 0 100 40">
                    <path d="M0 40 Q25 15 50 30 T100 5" fill="none" stroke="#007a7a" stroke-width="2" stroke-dasharray="4 4"/>
                </svg>
            </div>
            <span style="position:relative; z-index:1;">Trend appears after a few practice blocks.</span>
        </div>`;
      }

      const _scoreBadge = globalScore >= 70
          ? `<div class="clin-status-bar good"><i class="fa-solid fa-shield-check"></i> High performance</div>`
          : (globalScore >= 50
              ? `<div class="clin-status-bar warn"><i class="fa-solid fa-shield-halved"></i> Developing</div>`
              : `<div class="clin-status-bar bad"><i class="fa-solid fa-shield-cat"></i> Remediation needed</div>`);
      const _weakRow = topWeakPerf
          ? `<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0;">
                 <span style="font-size:12.5px; color:#334155; font-weight:600;">${escWeak}</span>
                 <span class="clin-badge clin-badge-bad">${topWeakPerf.score}%</span>
             </div>`
          : '';
      const _strongRow = topStrong
          ? `<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0;">
                 <span style="font-size:12.5px; color:#334155; font-weight:600;">${escStrong}</span>
                 <span class="clin-badge clin-badge-good">${topStrong.score}%</span>
             </div>`
          : '';
      // Never show the same topic as both weakest AND strongest (single-topic
      // progress) — that looks broken. Require two distinct scored areas.
      const _sameTopic = topWeakPerf && topStrong && topWeakPerf.name === topStrong.name;
      const _diagBody = totalAnswered <= 0
          ? `<div class="clin-empty"><div style="margin-bottom:6px; opacity:0.4;"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#A0AEC0" stroke-width="1.5"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>Diagnostics populate after you answer questions.</div>`
          : (_sameTopic || !topWeakPerf || !topStrong
              ? `<div class="clin-empty"><div style="margin-bottom:6px; opacity:0.4;"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#A0AEC0" stroke-width="1.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></div>More data needed to calculate strengths.</div>`
              : `${_weakRow}${_strongRow}`);

      let performanceCardHtml = `
      <div class="clin-card clin-glass">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
              <h2 class="clin-card-title" style="margin:0;"><i class="fa-solid fa-chart-column" style="color:#007a7a;"></i>Performance &amp; diagnostics <span class="micro-tag global">Global</span></h2>
              <a href="#" onclick="window.openPerformance && window.openPerformance(); return false;" style="color:#007a7a; font-size:11.5px; text-decoration:none; font-weight:600;">Full analytics</a>
          </div>
          <div class="clin-analytics">
              <div style="display:flex; align-items:center; gap:16px;">
                  <div style="position:relative; width:104px; height:104px; flex-shrink:0;">
                      <svg width="104" height="104" viewBox="0 0 120 120" style="display:block;">
                          <defs>
                              <filter id="ringInnerShadow">
                                  <feOffset dx="0" dy="3"/>
                                  <feGaussianBlur stdDeviation="3" result="offset-blur"/>
                                  <feComposite operator="out" in="SourceGraphic" in2="offset-blur" result="inverse"/>
                                  <feFlood flood-color="black" flood-opacity="0.08" result="color"/>
                                  <feComposite operator="in" in="color" in2="inverse" result="shadow"/>
                                  <feComposite operator="over" in="shadow" in2="SourceGraphic"/>
                              </filter>
                          </defs>
                          <circle cx="60" cy="60" r="54" fill="none" stroke="#E2E8F0" stroke-width="12" filter="url(#ringInnerShadow)"></circle>
                          <circle cx="60" cy="60" r="42" fill="none" stroke="#F1F5F9" stroke-width="4"></circle>
                          <circle cx="60" cy="60" r="54" fill="none" stroke="${_donutColor}" stroke-width="12" stroke-linecap="round"
                              stroke-dasharray="${_C.toFixed(1)}" stroke-dashoffset="${_off}" transform="rotate(-90 60 60)" style="filter: drop-shadow(0 2px 4px ${_donutColor}40)"></circle>
                          <text x="60" y="80" text-anchor="middle" font-size="9" font-weight="700" letter-spacing="1.5" fill="#64748B" font-family="Inter,-apple-system,'Segoe UI',Roboto,sans-serif">AVG SCORE</text>
                      </svg>
                      <div class="donut-text-overlay" style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); display:flex; flex-direction:column; align-items:center; justify-content:center; pointer-events:none; text-align:center;">
                          <div style="font-size:21px; font-weight:700; color:#0F172A; line-height:1; font-family:Inter,-apple-system,'Segoe UI',Roboto,sans-serif;">${globalScore}%</div>
                      </div>
                  </div>
                  <div>
                      <div style="margin-bottom:6px;">${_scoreBadge}</div>
                      <div style="font-size:12.5px; color:#334155; font-weight:600;">${totalAnswered} <span style="font-weight:400;" class="clin-muted">attempted</span> &middot; ${totalCorrect} <span style="font-weight:400;" class="clin-muted">correct</span> &middot; ${totalIncorrect} <span style="font-weight:400;" class="clin-muted">incorrect</span></div>
                      <div class="clin-muted" style="font-size:11.5px; font-weight:400; margin-top:2px;">${totalQuestions} questions in bank</div>
                  </div>
              </div>
              <div>
                  <div class="clin-muted" style="font-size:11px; font-weight:700; letter-spacing:.05em; margin-bottom:2px;">WEAKEST / STRONGEST</div>
                  ${_diagBody}
              </div>
              <div>
                  <div class="clin-muted" style="font-size:11px; font-weight:700; letter-spacing:.05em; margin-bottom:6px;">TREND</div>
                  ${_sparkHtml}
              </div>
          </div>
      </div>
      `;

      // Card 2: Question Pool metrics (stacked horizontal bars)
      const _poolRows = totalQuestions > 0 ? [
          { label: 'Used', val: totalAnswered, pct: Math.round((totalAnswered / totalQuestions) * 100), color: '#334155' },
          { label: 'Unused', val: totalUnused, pct: Math.round((totalUnused / totalQuestions) * 100), color: '#94A3B8' },
          { label: 'Incorrect pool', val: totalIncorrect, pct: Math.round((totalIncorrect / totalQuestions) * 100), color: '#EF4444' }
      ] : [];
      let focusCardHtml = `
      <div class="clin-card clin-glass" style="display:flex; flex-direction:column;">
          <h2 class="clin-card-title"><i class="fa-solid fa-layer-group" style="color:#007a7a;"></i>Question pool <span class="micro-tag data">Data</span></h2>
          ${totalQuestions > 0 ? `
          <div style="display:block; width:100%; margin-top:2px;">
              ${_poolRows.map((r, i) => `
              <div class="metric-row" style="display:block; width:100%;${i < _poolRows.length - 1 ? ' margin-bottom:12px;' : ''}">
                  <div style="display:flex; justify-content:space-between; align-items:center; width:100%; font-size:13px; margin:0 0 4px 0; padding:0;">
                      <span style="font-weight:500; color:#475569; margin:0; padding:0;">${r.label}</span>
                      <span style="font-weight:600; color:#0F172A; margin:0; padding:0;">${r.val.toLocaleString()} (${r.pct}%)</span>
                  </div>
                  <div class="clin-pool-track" style="display:block; width:100%; height:6px; background-color:#E2E8F0; border-radius:999px; overflow:hidden; margin:0; padding:0;"><div class="clin-pool-fill" style="display:block; height:100%; width:${r.pct}%; background-color:${r.color}; border-radius:999px; margin:0; padding:0; box-shadow:0 0 6px ${r.color}66;"></div></div>
              </div>`).join('')}
          </div>
          <div class="clin-muted" style="font-size:11.5px; margin-top:16px;">${totalQuestions.toLocaleString()} questions in bank</div>
          ` : `<div class="clin-empty">No questions in this bank yet.</div>`}
      </div>
      `;

      // Quick Actions (compact clinical)
      const _qa = (fn, icon, title, sub, colorClass) => `
          <div onclick="${fn}" class="qa-tile-3d ${colorClass}" onmouseover="this.classList.add('hover')" onmouseout="this.classList.remove('hover')">
              <div class="qa-icon-container">
                  <i class="${icon}"></i>
              </div>
              <div class="qa-content">
                  <div class="qa-title">${title}</div>
                  <div class="qa-sub">${sub}</div>
              </div>
          </div>`;
      let quickActionsHtml = `
      <div class="clin-card clin-glass" style="background:transparent; border:none; box-shadow:none; padding:0;">
          <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px;">
              ${_qa('window.openExamPrepTab && window.openExamPrepTab()', 'fa-solid fa-stethoscope', 'New session', 'Customize practice', 'qa-cyan')}
              ${_qa('window.openFlashcardsExplorer && window.openFlashcardsExplorer()', 'fa-solid fa-layer-group', 'Flashcards', 'Reinforce learning', 'qa-purple')}
              ${_qa('window.openPlanner && window.openPlanner()', 'fa-solid fa-calendar-check', 'Study plan', 'Stay on track', 'qa-blue')}
          </div>
      </div>
      `;

      // Card 3: Priority Review / Daily Targets (compact data list)
      let weakestAreasHtml = '';
      if (weakAreas && weakAreas.length > 0) {
          let listHtml = '';
          weakAreas.slice(0, 5).forEach((w) => {
              const safeName = window.escapeHtml ? window.escapeHtml(w.name) : w.name;
              const safeNameClick = safeName.replace(/'/g, "\\'");
              const wBadge = w.score >= 50
                  ? `<span class="clin-badge clin-badge-warn">${w.score}%</span>`
                  : `<span class="clin-badge clin-badge-bad">${w.score}%</span>`;
              listHtml += `
              <div class="clin-row clin-row-hover" onclick="window.startQBankSession('${activeQBankId}', '${safeBankName}', '${safeNameClick}')">
                  <div style="flex:1; min-width:0;">
                      <div style="font-size:12.5px; font-weight:600; color:#0F172A; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${safeName}</div>
                      <div class="clin-bar-track" style="margin-top:5px;"><div style="height:100%; width:${Math.max(0, Math.min(100, w.score))}%; background: linear-gradient(90deg, #f87171, #ef4444); border-radius:3px; box-shadow: 0 0 6px rgba(239,68,68,0.5);"></div></div>
                  </div>
                  ${wBadge}
                  <i class="fa-solid fa-chevron-right" style="font-size:11px; color:#94A3B8;"></i>
              </div>
              `;
          });

          weakestAreasHtml = `
          <div class="clin-card clin-glass" style="display:flex; flex-direction:column;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                  <h2 class="clin-card-title" style="margin:0;"><i class="fa-solid fa-bullseye" style="color:#007a7a;"></i>Priority review <span class="micro-tag focus">Focus</span></h2>
                  <a href="#" onclick="window.openPerformance && window.openPerformance(); return false;" style="color:#007a7a; font-size:11.5px; text-decoration:none; font-weight:600;">View all</a>
              </div>
              <div style="flex:1; display:flex; flex-direction:column; justify-content:center;">
                  ${listHtml}
              </div>
          </div>
          `;
      } else {
          weakestAreasHtml = `
          <div class="clin-card clin-glass" style="display:flex; flex-direction:column;">
              <h2 class="clin-card-title"><i class="fa-solid fa-bullseye" style="color:#007a7a;"></i>Priority review <span class="micro-tag focus">Focus</span></h2>
              <div class="clin-empty">No weak areas yet — answer more questions to reveal priority targets.</div>
          </div>
          `;
      }

      let plannerInlineHtml = `
        <div id="dashboard-planner-inline" style="margin-bottom: 24px;"></div>
      `;

      let html = `
        <div class="clin-wrap w-full max-w-[1200px] mx-auto" style="padding:20px 20px 96px;">
            ${plannerInlineHtml}
            ${headerHtml}
            <div class="clin-rowblock clin-grid-top">
                ${continueCardHtml}
                ${focusCardHtml}
                ${weakestAreasHtml}
            </div>
            <div class="clin-rowblock" style="margin-top:12px;">
                ${performanceCardHtml}
            </div>
            <div class="clin-rowblock" style="margin-top:12px;">
                ${quickActionsHtml}
            </div>
        </div>
        <style>
        .clin-wrap {
            font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #F8FAFC;
            background-image: radial-gradient(rgba(0,122,122, 0.08) 1px, transparent 1px);
            background-size: 24px 24px;
            animation: clin-fade-in 0.4s ease-out;
            width: 100%;
            box-sizing: border-box;
        }
        /* One box model for every row so all right edges share a pixel */
        .clin-wrap, .clin-wrap *, .clin-wrap *::before, .clin-wrap *::after {
            box-sizing: border-box;
        }
        .clin-rowblock { width: 100%; }
        .clin-grid-top {
            display: flex;
            align-items: stretch;
            gap: 12px;
            width: 100%;
        }
        .clin-grid-top > .clin-card {
            min-height: 212px;
            min-width: 0;
        }
        .clin-grid-top > .clin-card:nth-child(1) { flex: 1.25; }
        .clin-grid-top > .clin-card:nth-child(2) { flex: 1; }
        .clin-grid-top > .clin-card:nth-child(3) { flex: 1; }
        .clin-card {
            background: #fff;
            border: 1px solid #E2E8F0;
            border-radius: 6px;
            padding: 14px 16px;
            box-shadow: none;
            width: 100%;
        }
        .clin-card-title {
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: #64748B;
            margin: 0 0 10px 0;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .clin-card-title i {
            font-size: 12px;
            color: #007a7a;
        }
        .clin-btn-primary {
            background: #007a7a;
            color: #fff;
            border: none;
            border-radius: 6px;
            padding: 9px 18px;
            font-weight: 700;
            font-size: 13px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        .clin-btn-primary:hover { background: #006666; }
        .clin-bar-track {
            height: 5px;
            background: #EDF2F7;
            border-radius: 3px;
            overflow: hidden;
            width: 100%;
        }
        /* NOTE: pool bars intentionally use clin-pool-* names — the generic
           .progress-bar-fill class is hijacked by global stylesheets
           (teal !important override + shimmer animation). */
        .clin-pool-track {
            display: block;
            width: 100%;
            height: 6px;
            background-color: #E2E8F0;
            border-radius: 999px;
            overflow: hidden;
        }
        .clin-pool-fill {
            display: block;
            height: 100%;
            border-radius: 999px;
        }
        .clin-badge {
            font-size: 11px;
            font-weight: 700;
            padding: 2px 9px;
            border-radius: 999px;
            white-space: nowrap;
        }
        .clin-badge-good { color: #15803D; background: #DCFCE7; }
        .clin-badge-bad { color: #C62828; background: #FBEAEA; }
        .clin-badge-warn { color: #92400E; background: #FEF3C7; }
        .clin-badge-mut { color: #475569; background: #F1F5F9; }
        .clin-muted { color: #64748B; }
        .clin-empty {
            border: 1px solid #F1F5F9;
            border-radius: 6px;
            background: #FAFAFA;
            color: #64748B;
            text-align: center;
            padding: 16px 12px;
            font-size: 12px;
            line-height: 1.5;
        }
        .clin-row {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 6px;
            margin: 0 -6px;
            border-bottom: 1px solid #F1F5F9;
            border-radius: 4px;
            cursor: pointer;
        }
        .clin-glass {
            background: rgba(255, 255, 255, 0.9) !important;
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.8) !important;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.02), inset 0 0 0 1px rgba(255, 255, 255, 0.5) !important;
            border-radius: 12px !important;
        }
        .micro-tag {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 9px;
            font-weight: 800;
            text-transform: uppercase;
            padding: 4px 8px;
            border-radius: 999px;
            letter-spacing: 0.05em;
            line-height: 1;
            transform: translateY(-1px);
        }
        .micro-tag.live { background: #DCFCE7; color: #14532D; }
        .micro-tag.data { background: #E0F2FE; color: #0C4A6E; }
        .micro-tag.global { background: #F3E8FF; color: #4C1D95; }
        .micro-tag.focus { background: #FFEDD5; color: #7C2D12; }
        
        .clin-status-bar {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 5px 12px;
            border-radius: 999px;
            font-size: 11px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            box-shadow: 0 2px 10px rgba(0,0,0,0.03);
        }
        .clin-status-bar.bad { background: linear-gradient(135deg, #FEE2E2, #FCA5A5); border: 1px solid rgba(255,255,255,0.5); color: #B91C1C; }
        .clin-status-bar.warn { background: linear-gradient(135deg, #FEF3C7, #FCD34D); border: 1px solid rgba(255,255,255,0.5); color: #B45309; }
        .clin-status-bar.good { background: linear-gradient(135deg, #DCFCE7, #86EFAC); border: 1px solid rgba(255,255,255,0.5); color: #15803D; }
        
        .qa-tile-3d {
            display: flex;
            align-items: center;
            gap: 14px;
            padding: 16px;
            border-radius: 12px;
            background: rgba(255,255,255,0.85);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255,255,255,0.8);
            box-shadow: 0 4px 15px rgba(0,0,0,0.03), inset 0 2px 4px rgba(255,255,255,0.8);
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .qa-tile-3d.hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(0,0,0,0.06), inset 0 2px 4px rgba(255,255,255,0.8);
        }
        .qa-icon-container {
            width: 48px;
            height: 48px;
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: inset 0 2px 4px rgba(255,255,255,0.9), inset 0 -2px 6px rgba(0,0,0,0.05), 0 4px 10px rgba(0,0,0,0.05);
        }
        .qa-icon-container i {
            font-size: 20px;
            filter: drop-shadow(0 2px 2px rgba(0,0,0,0.15));
        }
        .qa-cyan .qa-icon-container { background: linear-gradient(135deg, #ccfbf1 0%, #5eead4 100%); box-shadow: inset 0 2px 4px rgba(255,255,255,0.6), inset 0 -4px 10px rgba(13,148,136,0.3), 0 4px 10px rgba(0,0,0,0.05); }
        .qa-cyan .qa-icon-container i { color: #0f766e; }
        .qa-cyan:hover { border-color: #5eead4; }
        
        .qa-purple .qa-icon-container { background: linear-gradient(135deg, #f3e8ff 0%, #d8b4fe 100%); box-shadow: inset 0 2px 4px rgba(255,255,255,0.6), inset 0 -4px 10px rgba(147,51,234,0.3), 0 4px 10px rgba(0,0,0,0.05); }
        .qa-purple .qa-icon-container i { color: #7e22ce; }
        .qa-purple:hover { border-color: #d8b4fe; }
        
        .qa-blue .qa-icon-container { background: linear-gradient(135deg, #e0f2fe 0%, #7dd3fc 100%); box-shadow: inset 0 2px 4px rgba(255,255,255,0.6), inset 0 -4px 10px rgba(2,132,199,0.3), 0 4px 10px rgba(0,0,0,0.05); }
        .qa-blue .qa-icon-container i { color: #0369a1; }
        .qa-blue:hover { border-color: #7dd3fc; }
        
        .qa-content { flex: 1; min-width: 0; }
        .qa-title { font-weight: 700; color: #0F172A; font-size: 14px; margin-bottom: 2px; }
        .qa-sub { font-size: 11px; color: #64748B; }
        .clin-row-hover:hover { background: rgba(248, 250, 252, 0.6) !important; }
        .clin-row:last-child { border-bottom: none; }
        .clin-analytics {
            display: grid;
            grid-template-columns: 1.25fr 1fr 1fr;
            gap: 12px;
            align-items: start;
        }
        @media (max-width: 1024px) {
            .clin-grid-top { flex-direction: column; }
            .clin-grid-top > .clin-card { min-height: 0; }
            .clin-analytics { grid-template-columns: 1fr; }
        }
        @keyframes clin-fade-in {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }
        /* Legacy fallback (dashboard-ux home-view widgets still use these) */
        .dash-card {
            background: #fff;
            border-radius: 6px;
            padding: 14px 16px;
            border: 1px solid #E2E8F0;
        }
        .dash-card-title {
            font-size: 11.5px;
            font-weight: 700;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: #64748B;
            margin: 0;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        </style>
      `;
      area.innerHTML = html;
      // Attach renderDashboardPlannerWidget
      if (window.renderDashboardPlannerWidget) window.renderDashboardPlannerWidget();

      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      if (window.hideGlobalLoader) window.hideGlobalLoader();
      
    } catch (e) {
      area.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);">Failed to load QBanks: ${e.message}</div>`;
      if (window.hideGlobalLoader) window.hideGlobalLoader();
    }
  };

  // --- Browse All Banks (original category grid) ---
  window.openQBankCategories = function () {
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";
    
    if (!qbanks || qbanks.length === 0) {
      area.innerHTML = '<div style="padding:40px;text-align:center;color:#6b7280;">No QBanks available.</div>';
      return;
    }
    
    let html = `<div style="max-width:1400px; margin:0 auto; padding:40px 20px;">
      <div style="display:flex; align-items:center; margin-bottom:30px;">
        <button style="background:#f8fafc; border:1px solid #e2e8f0; color:#111827; border-radius:999px; padding:8px 16px; margin-right:15px; display:flex; align-items:center; gap:8px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f8fafc'" onclick="window.openQBank()">
          <i data-lucide="arrow-left" style="width:16px;height:16px;"></i> Home
        </button>
        <div>
          <h2 style="margin:0; font-size:1.5rem; font-weight:700; color:#111827;">Choose Your Exam</h2>
          <p style="margin:4px 0 0 0; font-size:0.9rem; color:#6b7280;">Select from ${qbanks.length} available question bank${qbanks.length !== 1 ? 's' : ''}</p>
        </div>
      </div>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:24px;">`;
    
    const flagMap = { usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg", morocco: "ma" };
    for (const q of qbanks) {
      const countryCode = flagMap[q.country];
      const flagHtml = countryCode 
         ? `<img src="https://flagcdn.com/w80/${countryCode}.png" alt="${countryCode}" style="width:64px; height:auto; border-radius:4px; margin-bottom:20px; box-shadow:0 1px 3px rgba(0,0,0,0.1);">`
         : `<div style="font-size:4rem; margin-bottom:20px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1)); line-height:1;">🌍</div>`;
         
      // Show question count if cached
      const cached = cachedQBanks[q.id];
      const qCount = cached ? (cached.questions || []).length : 0;
      const countLabel = qCount > 0 ? `<div style="font-size:0.85rem; color:#6b7280; margin-bottom:12px;">${qCount.toLocaleString()} questions</div>` : '';
         
      html += `
        <div class="qbank-exam-card" style="background:#fff; border:1px solid #e2e8f0; border-radius:20px; padding:32px 24px; cursor:pointer; transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1); display:flex; flex-direction:column; align-items:center; text-align:center; position:relative; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.05);" onclick="window.startQBankSession('${q.id}', '${window.escapeHtml ? window.escapeHtml(q.name).replace(/'/g, "\\\\'") : q.name.replace(/'/g, "\\\\'")}')" onmouseover="this.style.transform='translateY(-4px)'; this.style.borderColor='#007a7a'; this.style.boxShadow='0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05)';" onmouseout="this.style.transform='translateY(0)'; this.style.borderColor='#e2e8f0'; this.style.boxShadow='0 1px 3px rgba(0,0,0,0.05)';">
           ${flagHtml}
           <h3 style="font-size:1.4rem; font-weight:700; margin-bottom:8px; color:#111827; letter-spacing:0.2px;">${window.escapeHtml ? window.escapeHtml(q.name) : q.name}</h3>
           ${countLabel}
           <div style="color:#007a7a; font-size:0.95rem; font-weight:600; display:flex; align-items:center; gap:8px; margin-top:auto; padding-top:15px; text-transform:uppercase; letter-spacing:1px;">
             <span>Start Practicing</span>
             <i data-lucide="arrow-right" style="width:18px;height:18px;"></i>
           </div>
        </div>`;
    }
    
    html += `</div></div>`;
    area.innerHTML = html;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  // --- Continue last session ---
  window.qbankContinueLast = function () {
    const last = getLastSession();
    if (!last || !last.qbankId) { window.openQBankCategories(); return; }
    window.qbankResumeSession(last.qbankId, last.qbankName, last.subject);
  };

  // --- Resume a specific session ---
  window.qbankResumeSession = async function (qbankId, qbankName, subject) {
    if (!qbankId) { window.openQBankCategories(); return; }
    
    // Ensure data is loaded
    if (!cachedQBanks[qbankId]) {
      await window.startQBankSession(qbankId, qbankName || "QBank");
      // After session loads, filter to subject if needed
      if (subject && subject !== "All Subjects") {
        window.startQBankFiltered(subject);
      }
    } else {
      currentQBankId = qbankId;
      window.isQBankAdmin = window.checkAdmin ? await window.checkAdmin() : false;
      const qData = cachedQBanks[qbankId];
      allQuestions = qData.questions;
      window.qbankProgress = qData.progress;
      document.getElementById("qbank-active-name").textContent = qbankName || "QBank";
      
      if (subject && subject !== "All Subjects") {
        window.startQBankFiltered(subject);
      } else {
        window.startQBankFiltered(null);
      }
    }
  };

  // --- Continue Marked Questions ---
  window.qbankContinueMarked = async function () {
    // Gather all marked questions across all banks
    let markedQuestions = [];
    let firstBankId = null;
    
    for (const qb of qbanks) {
      const data = cachedQBanks[qb.id];
      if (!data) continue;
      const prog = data.progress || {};
      
      for (const q of (data.questions || [])) {
        if (prog[q.id] && prog[q.id].marked) {
          markedQuestions.push(q);
          if (!firstBankId) firstBankId = qb.id;
        }
      }
    }
    
    if (markedQuestions.length === 0) {
      alert("No marked questions found. Mark questions during practice by clicking the bookmark button.");
      return;
    }
    
    // Use the first bank's ID for context
    currentQBankId = firstBankId;
    window.isQBankAdmin = window.checkAdmin ? await window.checkAdmin() : false;
    
    // Merge progress from all banks
    window.qbankProgress = {};
    for (const qb of qbanks) {
      const data = cachedQBanks[qb.id];
      if (data && data.progress) Object.assign(window.qbankProgress, data.progress);
    }
    
    allQuestions = markedQuestions;
    currentQuestions = [...markedQuestions];
    currentIndex = 0;
    window.currentQuestions = currentQuestions;
    window.currentIndex = currentIndex;
    
    document.getElementById("qbank-active-name").textContent = "Marked Questions";
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "flex";
    const sidebar = document.getElementById("qbank-sidebar");
    if (sidebar) sidebar.style.display = "flex";
    
    window.qbankRenderCurrent();
  };

  // ---- Cache invalidation after admin edits ----
  // Keeps the in-session question store in sync with Firestore so question
  // pages and ID search always show the latest saved content.
  window.qbankPatchCachedQuestion = function(qbankId, questionId, questionText, dataObj) {
    const entry = cachedQBanks[qbankId];
    if (!entry || !Array.isArray(entry.questions)) return;
    const q = entry.questions.find(x => x.id === questionId);
    if (!q) return;
    if (questionText !== undefined) q.text = questionText;
    if (dataObj !== undefined) q.data = dataObj;
    q.highlightedHTML = null;
  };

  window.qbankRemoveCachedQuestion = function(qbankId, questionId) {
    const entry = cachedQBanks[qbankId];
    if (!entry || !Array.isArray(entry.questions)) return;
    const i = entry.questions.findIndex(x => x.id === questionId);
    if (i !== -1) entry.questions.splice(i, 1);
  };

  // ---- Question lookup by Firestore id or human code (used by home search) ----
  // ALWAYS resolves via the server (Firestore = source of truth), so results
  // reflect admin edits instantly. No client cache involvement.
  window.qbankFindByRef = async function(term, preferBankId) {
    term = String(term || "").trim();
    if (!term || !/^[A-Za-z0-9_-]{3,64}$/.test(term)) return null;
    try {
      // Search the preferred bank (or current one) first — most likely hit
      const params = { ref: term };
      const hint = preferBankId || currentQBankId;
      if (hint) params.qbankId = hint;
      const res = await apiGet("get_question", params);
      if (!res || !res.question) return null;
      const qd = res.question;
      // Patch ONLY the in-memory entry — never overwrite the IndexedDB bank
      // cache with a single question (that previously shrank whole banks).
      try {
        const entry = cachedQBanks[qd.qbankId];
        if (entry && Array.isArray(entry.questions)) {
          const i = entry.questions.findIndex(x => x.id === qd.id);
          if (i >= 0) entry.questions[i] = { id: qd.id, text: qd.text, data: qd.data };
          else entry.questions.push({ id: qd.id, text: qd.text, data: qd.data });
        } else {
          cachedQBanks[qd.qbankId] = { questions: [{ id: qd.id, text: qd.text, data: qd.data }], progress: {} };
        }
      } catch (e) { /* non-fatal */ }
      const nameOf = (bid) => ((cachedCategories || []).find(c => c.id === bid) || {}).name || bid;
      return {
        bankId: qd.qbankId,
        bankName: nameOf(qd.qbankId),
        question: { id: qd.id, text: qd.text, data: qd.data },
        alternatives: (res.alternatives || []).map(a => ({ bankId: a.qbankId, bankName: nameOf(a.qbankId) })),
      };
    } catch (e) {
      console.error("qbankFindByRef failed:", e);
      return null;
    }
  };

  // Opens exactly one question as a mini-session.
  window.qbankOpenSingle = async function(bankId, bankName, question) {
    currentQBankId = bankId;
    allQuestions = [question];
    currentQuestions = [question];
    window.currentQuestions = currentQuestions;
    window.isQBankAdmin = window.checkAdmin ? await window.checkAdmin() : false;

    window.qbankProgress = (cachedQBanks[bankId] && cachedQBanks[bankId].progress) || {};

    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "flex";
    const nameEl = document.getElementById("qbank-active-name");
    if (nameEl) nameEl.textContent = bankName || "";
    window.hideAllMainViews && window.hideAllMainViews();
    const view = document.getElementById("qbank-home-view");
    if (view) view.style.display = "flex";
    if (window.setQBankNav) window.setQBankNav('home');

    currentIndex = 0;
    sessionAnswers = [];
    window.currentIndex = 0;
    const sidebar = document.getElementById("qbank-sidebar");
    if (sidebar) sidebar.style.display = "flex";
    window.qbankRenderCurrent();
  };

  window.startQBankSession = async function (qbankId, qbankName, targetSubject = null, reviewIncorrectsOnly = false) {
    const myNav = nextNavToken();
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";
    
    if (window.hideAllMainViews) window.hideAllMainViews();
    const qbankView = document.getElementById("qbank-home-view");
    if (qbankView) qbankView.style.display = "flex";
    
    // We update the modal's title now so it's ready when they actually start practicing
    const activeNameEl = document.getElementById("qbank-active-name");
    if (activeNameEl) activeNameEl.textContent = qbankName;
    
    currentQBankId = qbankId;
    window.isQBankAdmin = window.checkAdmin ? await window.checkAdmin() : false;
    
    try {
      let qData = cachedQBanks[qbankId];
      if (!qData) {
         area.innerHTML = `
          <div class="flex flex-col justify-center items-center h-64 gap-4">
            <div class="press-wrapper" style="margin: 20px auto 0; display: flex; justify-content: center; align-items: center;">
                <div class="press">
                  <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="roll"></div>
                  <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="sheet"></div>
                  <div class="sheet"></div><div class="sheet"></div><div class="sheet"></div><div class="roll"></div>
                </div>
            </div>
            <div class="text-on-surface-variant text-sm">Updating Questions</div>
          </div>`;
         const qCat = (cachedCategories || []).find(c => c.id === qbankId);
         const catUpdated = qCat ? qCat.updatedAt : 0;
         
         const idbData = await getCachedQBank(qbankId);
         if (idbData && idbData.updatedAt === catUpdated && idbData.questions && idbData.questions.length > 0) {
            const res = await apiGet("get_questions", { qbankId, onlyProgress: true });
            cachedQBanks[qbankId] = { questions: idbData.questions, progress: applyLocalQueueProgress(qbankId, res.progress || {}) };
         } else {
            const res = await apiGet("get_questions", { qbankId });
            cachedQBanks[qbankId] = { questions: res.questions || [], progress: applyLocalQueueProgress(qbankId, res.progress || {}) };
            setCachedQBank(qbankId, { updatedAt: catUpdated, questions: res.questions || [] });
         }
         
          qData = cachedQBanks[qbankId];
       }
       if (navStale(myNav)) return;

      allQuestions = qData.questions;
      window.qbankProgress = qData.progress;
      const progress = window.qbankProgress;
      
      if (allQuestions.length === 0) {
        area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">This QBank is empty.</div>';
        return;
      }
      
      // Extract subjects and stats
      const subjectStats = {};
      let totalQ = 0;
      let totalAns = 0;
      let totalCorrect = 0;

      allQuestions.forEach(q => {
        const sub = (q.data && q.data.subject) || "Uncategorized";
        const chapter = (q.data && q.data.chapter) || null;
        
        if (!subjectStats[sub]) subjectStats[sub] = { total: 0, answered: 0, correct: 0, chapters: {} };
        subjectStats[sub].total++;
        totalQ++;
        
        if (chapter) {
            if (!subjectStats[sub].chapters[chapter]) subjectStats[sub].chapters[chapter] = { total: 0, answered: 0, correct: 0 };
            subjectStats[sub].chapters[chapter].total++;
        }
        
        if (progress[q.id] && progress[q.id].correct !== undefined) {
          subjectStats[sub].answered++;
          totalAns++;
          if (chapter) subjectStats[sub].chapters[chapter].answered++;
          
          if (progress[q.id].correct) {
             subjectStats[sub].correct++;
             totalCorrect++;
             if (chapter) subjectStats[sub].chapters[chapter].correct++;
          }
        }
      });
      
      let subjectList = Object.keys(subjectStats).filter(s => s !== "Uncategorized");
      subjectList.sort((a, b) => {
        const isCasA = a.toLowerCase().includes("cas clinique");
        const isCasB = b.toLowerCase().includes("cas clinique");
        if (isCasA && !isCasB) return -1;
        if (!isCasA && isCasB) return 1;
        return a.localeCompare(b);
      });
      
      window.qbankCurrentSubjectStats = subjectStats; // Save for chapter view
      
      if (targetSubject !== null || reviewIncorrectsOnly || (qbankName === "Answer Party" && !window.pendingPartyCreation)) {
          window.startQBankFiltered(targetSubject, null, reviewIncorrectsOnly);
          return;
      }
      
      if (subjectList.length === 0) {
        // No subjects, start directly
        window.startQBankFiltered(null);
      } else {
        const getScoreDisplay = (correct, answered) => {
           if (answered === 0) return { text: '0%', color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)' };
           const score = Math.round((correct / answered) * 100);
           const color = score >= 80 ? '#22c55e' : (score >= 50 ? '#eab308' : '#f43f5e');
           const bg = score >= 80 ? 'rgba(34,197,94,0.1)' : (score >= 50 ? 'rgba(234,179,8,0.1)' : 'rgba(244,63,94,0.1)');
           return { text: `${score}%`, color, bg };
        };

        const globalScoreUI = getScoreDisplay(totalCorrect, totalAns);

        // Show subject selection (extracted renderer)
        window.showQBankSubjects(qbankId);
      }

    } catch (e) {
      area.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);">Failed to load questions: ${e.message}</div>`;
    }
  };

  // Renders the sub-category ("subjects") grid for the active bank.
  // Relies on window.qbankCurrentSubjectStats computed by startQBankSession,
  // and currentQBankId / allQuestions being set.
  window.getSubjectDesign = function(sub) {
    const s = (sub || "").toLowerCase();
    const color = "var(--text-primary)";
    const bg = "transparent";
    if (s.includes("cardio") || s.includes("heart")) return { icon: "heart", color, bg };
    if (s.includes("neuro") || s.includes("brain") || s.includes("psych")) return { icon: "brain", color, bg };
    if (s.includes("pneumo") || s.includes("pulmo") || s.includes("lung") || s.includes("respira")) return { icon: "wind", color, bg };
    if (s.includes("gastro") || s.includes("hepato") || s.includes("digest") || s.includes("git") || s.includes("entero")) return { icon: "coffee", color, bg };
    if (s.includes("nephro") || s.includes("uro") || s.includes("kidney")) return { icon: "filter", color, bg };
    if (s.includes("ortho") || s.includes("rhumato") || s.includes("trauma") || s.includes("bone") || s.includes("osteo")) return { icon: "bone", color, bg };
    if (s.includes("pedia") || s.includes("child") || s.includes("neo")) return { icon: "baby", color, bg };
    if (s.includes("ophtalmo") || s.includes("eye") || s.includes("ophthal")) return { icon: "eye", color, bg };
    if (s.includes("orl") || s.includes("ear") || s.includes("ent")) return { icon: "ear", color, bg };
    if (s.includes("derma") || s.includes("skin")) return { icon: "sun", color, bg };
    if (s.includes("infect") || s.includes("microbio") || s.includes("bacterio") || s.includes("vir")) return { icon: "bug", color, bg };
    if (s.includes("hemato") || s.includes("blood") || s.includes("sang")) return { icon: "droplet", color, bg };
    if (s.includes("onco") || s.includes("cancer") || s.includes("tumor")) return { icon: "target", color, bg };
    if (s.includes("endocrin") || s.includes("hormon") || s.includes("diabet") || s.includes("meta")) return { icon: "activity", color, bg };
    if (s.includes("chirurg") || s.includes("surg")) return { icon: "scissors", color, bg };
    if (s.includes("gyneco") || s.includes("obste") || s.includes("woman") || s.includes("mater")) return { icon: "activity", color, bg };
    if (s.includes("urgences") || s.includes("reanima") || s.includes("emergenc") || s.includes("icu") || s.includes("soins inten")) return { icon: "zap", color, bg };
    if (s.includes("pharma") || s.includes("drug") || s.includes("thera")) return { icon: "pill", color, bg };
    if (s.includes("bio") || s.includes("lab")) return { icon: "test-tube", color, bg };
    if (s.includes("immuno")) return { icon: "shield", color, bg };
    if (s.includes("anatomy") || s.includes("physio")) return { icon: "user", color, bg };
    if (s.includes("cas clinique") || s.includes("clinical")) return { icon: "clipboard-list", color, bg };
    return { icon: "book-open", color, bg };
  };
  window.showQBankSubjects = async function(requestedQBankId = null) {
      nextNavToken();
      // 1. Switch active view to qbank-home-view
      if (window.hideAllMainViews) window.hideAllMainViews();
      const view = document.getElementById("qbank-home-view");
      if (view) view.style.display = "flex";

      // 2. Update navigation active state
      if (window.setQBankNav) window.setQBankNav('browse');

      const area = document.getElementById("qbank-home-content");
      if (!area) return;
      
      const activeQBankId = requestedQBankId || currentQBankId || (window.db && window.db.selectedQBankId);
      if (!activeQBankId) { window.openQBank(); return; }

      // Make sure the QBank data is loaded
      if (!cachedQBanks[activeQBankId] || !cachedQBanks[activeQBankId].questions) {
          // Load via startQBankSession (fetches this bank's questions, then
          // renders its subjects directly). NOTE: openQBank() takes no bank
          // argument and follows window.db.selectedQBankId, so delegating to
          // it here rendered the WRONG bank's subjects.
          const _nm = ((cachedCategories || []).find(qb => qb.id === activeQBankId) || {}).name || "Your QBank";
          await window.startQBankSession(activeQBankId, _nm);
          return;
      }

      // Set module-level allQuestions for startQBankFiltered
      allQuestions = cachedQBanks[activeQBankId].questions || [];
      window.qbankProgress = cachedQBanks[activeQBankId].progress || {};
      currentQBankId = activeQBankId;

      const questionsToUse = cachedQBanks[activeQBankId].questions;
      const progressToUse = cachedQBanks[activeQBankId].progress || {};
      const activeQBankName = (cachedCategories || []).find(qb => qb.id === activeQBankId)?.name || "Your QBank";
      const subSafeQbankId = window.escapeHtml ? window.escapeHtml(activeQBankId).replace(/'/g, "\\'") : activeQBankId;
      const subSafeQbankName = window.escapeHtml ? window.escapeHtml(activeQBankName).replace(/'/g, "\\'") : activeQBankName;

      const subjectStats = window.qbankCurrentSubjectStats || {};
      const getScoreDisplay = (correct, answered) => {
          if (answered === 0) return { text: '0%', color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)' };
          const score = Math.round((correct / answered) * 100);
          const color = score >= 80 ? '#22c55e' : (score >= 50 ? '#eab308' : '#f43f5e');
          const bg = score >= 80 ? 'rgba(34,197,94,0.1)' : (score >= 50 ? 'rgba(234,179,8,0.1)' : 'rgba(244,63,94,0.1)');
          return { text: `${score}%`, color, bg };
      };

      // Recompute stats fresh so progress is always current
      const stats = {};
      let totalAns = 0, totalCorrect = 0;
      questionsToUse.forEach(q => {
        const sub = (q.data && q.data.subject) || "Uncategorized";
        const chapter = (q.data && q.data.chapter) || null;
        if (!stats[sub]) stats[sub] = { total: 0, answered: 0, correct: 0, chapters: {} };
        stats[sub].total++;
        if (chapter) {
          if (!stats[sub].chapters[chapter]) stats[sub].chapters[chapter] = { total: 0, answered: 0, correct: 0 };
          stats[sub].chapters[chapter].total++;
        }
        const p = progressToUse[q.id];
        if (p && p.correct !== undefined) {
          stats[sub].answered++;
          totalAns++;
          if (chapter && stats[sub].chapters[chapter]) stats[sub].chapters[chapter].answered++;
          if (p.correct) {
            stats[sub].correct++; totalCorrect++;
            if (chapter && stats[sub].chapters[chapter]) stats[sub].chapters[chapter].correct++;
          }
        }
      });
      window.qbankCurrentSubjectStats = stats;

      let subjectList = Object.keys(stats).filter(x => x !== "Uncategorized");
      subjectList.sort((a, b) => {
        const isCasA = a.toLowerCase().includes("cas clinique");
        const isCasB = b.toLowerCase().includes("cas clinique");
        if (isCasA && !isCasB) return -1;
        if (!isCasA && isCasB) return 1;
        return a.localeCompare(b);
      });

      const globalScoreUI = getScoreDisplay(totalCorrect, totalAns);

      let html = `<div style="width:100%; max-width:1200px; margin:0 auto; padding:20px;">
          <div style="display:flex; align-items:center; margin-bottom:25px;">
             <button style="background:#f8fafc; border:1px solid #e2e8f0; color:#111827; border-radius:999px; padding:8px 16px; margin-right:15px; display:flex; align-items:center; gap:8px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f8fafc'" onclick="window.openQBank()">
               <i data-lucide="arrow-left" style="width:16px;height:16px;"></i> Back
             </button>
             <h2 style="margin:0; font-size:1.5rem; font-weight:700; color:#111827;">Select Sub-Category</h2>
          </div>
          <input type="text" placeholder="Search sub-categories..." style="width:100%; margin-bottom:15px; padding:12px 16px; font-size:1rem; border-radius:12px; border:1px solid #e2e8f0; background:#fff; color:#111827; outline:none;" onfocus="this.style.borderColor='#007a7a'; this.style.boxShadow='0 0 0 3px rgba(0,122,122,0.1)'" onblur="this.style.borderColor='#e2e8f0'; this.style.boxShadow='none'" oninput="window.filterQBankSubjects(this.value)">
          <div id="qbank-subject-list-container" style="display:flex; flex-direction:column; gap:16px;">
            <div style="position:relative; width:100%;">
            <button style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px 24px; text-align:left; justify-content:space-between; align-items:center; display:flex; width:100%; box-shadow:0 1px 3px rgba(0,0,0,0.05); cursor:pointer; transition:all 0.2s;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 6px -1px rgba(0,0,0,0.1)';" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 1px 3px rgba(0,0,0,0.05)';" onclick="window.startQBankFiltered(null)">
              <div style="display:flex; align-items:center; gap:20px;">
                <div style="width:48px; height:48px; border-radius:12px; background:#f8fafc; border:1px solid #e2e8f0; display:flex; align-items:center; justify-content:center;">
                  <i data-lucide="shuffle" style="width:24px; height:24px; color:#6b7280;"></i>
                </div>
                <div>
                  <div style="font-size:1.2rem; font-weight:600; color:#111827;">All Subjects (Mix)</div>
                  <div style="font-size:0.9rem; color:#6b7280; margin-top:4px;">Practice questions from all available subjects</div>
                </div>
              </div>
              <div style="display:flex; gap:24px; align-items:center;">
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Answered</div>
                  <div style="font-size:1rem; font-weight:500; color:#111827; margin-top:4px;">${totalAns} / ${questionsToUse.length}</div>
                </div>
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Score</div>
                  <div style="font-size:1rem; font-weight:700; color:${globalScoreUI.color}; margin-top:4px; display:inline-block; background:${globalScoreUI.bg}; padding:2px 10px; border-radius:12px;">${globalScoreUI.text}</div>
                </div>
                <i data-lucide="chevron-right" style="width:20px;height:20px;color:#9ca3af;margin-left:10px;"></i>
              </div>
            </button>
            </div>` +
        subjectList.map(sub => {
            const st = stats[sub];
            const scoreUI = getScoreDisplay(st.correct, st.answered);
            const hasChapters = Object.keys(st.chapters || {}).length > 0;
            const subSafe = window.escapeHtml ? window.escapeHtml(sub).replace(/'/g, "\\'") : sub;
            let adminBtn = "";
            if (window.isQBankAdmin) {
               adminBtn = `<div style="position:absolute; top:-12px; left:80px; z-index:2; display:flex; gap:8px;">
                 <button style="padding:4px 10px; font-size:0.75rem; font-weight:600; color:#e11d48; border:1px solid #ffe4e6; background:#fff1f2; border-radius:999px; cursor:pointer; display:flex; align-items:center;" onclick="event.stopPropagation(); window.qbankAdminDeleteSubject('${subSafe}')"><i data-lucide="trash-2" style="width:12px;height:12px;margin-right:4px;"></i>Delete</button>
                 <button style="padding:4px 10px; font-size:0.75rem; font-weight:600; color:#8b5cf6; border:1px solid #ede9fe; background:#f5f3ff; border-radius:999px; cursor:pointer; display:flex; align-items:center;" onclick="event.stopPropagation(); window.qbankAdminMoveSubject('${subSafe}')"><i data-lucide="folder-input" style="width:12px;height:12px;margin-right:4px;"></i>Merge</button>
                 <button style="padding:4px 10px; font-size:0.75rem; font-weight:600; color:#0ea5e9; border:1px solid #e0f2fe; background:#f0f9ff; border-radius:999px; cursor:pointer; display:flex; align-items:center;" onclick="event.stopPropagation(); window.qbankAdminRenameSubject('${subSafe}')"><i data-lucide="edit-3" style="width:12px;height:12px;margin-right:4px;"></i>Rename</button>
               </div>`;
            }
            const design = window.getSubjectDesign(sub);
            return `
            <div style="position:relative; width:100%;">
            ${adminBtn}
            <button class="qbank-subject-btn" data-subject="${subSafe}" style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px 24px; text-align:left; justify-content:space-between; align-items:center; display:flex; width:100%; box-shadow:0 1px 3px rgba(0,0,0,0.05); cursor:pointer; transition:all 0.2s; position:relative; overflow:hidden;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 6px -1px rgba(0,0,0,0.1)';" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 1px 3px rgba(0,0,0,0.05)';" onclick="${hasChapters ? `window.showQBankChapters('${subSafe}')` : `window.startQBankFiltered('${subSafe}', null)`}">
              <div style="display:flex; align-items:center; gap:20px; z-index:1;">
                <div style="width:48px; height:48px; border-radius:12px; background:${design.color}15; border:1px solid ${design.color}30; display:flex; align-items:center; justify-content:center;">
                  <i data-lucide="${design.icon}" style="width:24px; height:24px; color:${design.color};"></i>
                </div>
                <div>
                  <div style="font-size:1.2rem; font-weight:600; color:#111827;">${window.escapeHtml ? window.escapeHtml(sub) : sub}</div>
                  <div style="font-size:0.9rem; color:#6b7280; margin-top:4px;">${hasChapters ? 'View Chapters' : 'Start Subject'}</div>
                </div>
              </div>
              <div style="display:flex; gap:24px; align-items:center; z-index:1;">
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Answered</div>
                  <div style="font-size:1rem; font-weight:500; color:#111827; margin-top:4px;">${st.answered} / ${st.total}</div>
                </div>
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Score</div>
                  <div style="font-size:1rem; font-weight:700; color:${scoreUI.color}; margin-top:4px; display:inline-block; background:${scoreUI.bg}; padding:2px 10px; border-radius:12px;">${scoreUI.text}</div>
                </div>
                <i data-lucide="${hasChapters ? 'folder' : 'chevron-right'}" style="width:20px;height:20px;color:#9ca3af;margin-left:10px;"></i>
              </div>
              <i data-lucide="${design.icon}" style="position:absolute; right:15%; top:-20px; width:120px; height:120px; opacity:0.03; color:${design.color}; pointer-events:none; transform:rotate(-15deg);"></i>
            </button>
            </div>`;
        }).join("") +
        `</div></div>`;
      area.innerHTML = html;
      document.getElementById("qbank-active-name") && (document.getElementById("qbank-active-name").textContent = document.getElementById("qbank-active-name").textContent || "QBank");
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      window.showQBankChaptersView = false;
  };

  
  window.showQBankChapters = function(subject) {
      const area = document.getElementById("qbank-home-content");
      if (!area) return;
      const stats = window.qbankCurrentSubjectStats[subject];
      if (!stats) return;
      
      const getScoreDisplay = (correct, answered) => {
          if (answered === 0) return { text: '0%', color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)' };
          const score = Math.round((correct / answered) * 100);
          const color = score >= 80 ? '#22c55e' : (score >= 50 ? '#eab308' : '#f43f5e');
          const bg = score >= 80 ? 'rgba(34,197,94,0.1)' : (score >= 50 ? 'rgba(234,179,8,0.1)' : 'rgba(244,63,94,0.1)');
          return { text: `${score}%`, color, bg };
      };
      
      const subSafe = window.escapeHtml ? window.escapeHtml(subject).replace(/'/g, "\\'") : subject;
      const globalScoreUI = getScoreDisplay(stats.correct, stats.answered);
      
      let html = `<div style="width:100%; max-width:1200px; margin:0 auto; padding:20px;">
          <div style="display:flex; align-items:center; margin-bottom:25px;">
             <button style="background:#f8fafc; border:1px solid #e2e8f0; color:#111827; border-radius:999px; padding:8px 16px; margin-right:15px; display:flex; align-items:center; gap:8px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f8fafc'" onclick="window.showQBankSubjects()">
               <i data-lucide="arrow-left" style="width:16px;height:16px;"></i> Back to Subjects
             </button>
             <h2 style="margin:0; font-size:1.5rem; font-weight:700; color:#111827;">Chapters: ${window.escapeHtml ? window.escapeHtml(subject) : subject}</h2>
          </div>
          
          <input type="text" placeholder="Search chapters..." style="width:100%; margin-bottom:15px; padding:12px 16px; font-size:1rem; border-radius:12px; border:1px solid #e2e8f0; background:#fff; color:#111827; outline:none;" onfocus="this.style.borderColor='#007a7a'; this.style.boxShadow='0 0 0 3px rgba(0,122,122,0.1)'" onblur="this.style.borderColor='#e2e8f0'; this.style.boxShadow='none'" oninput="window.filterQBankSubjects(this.value)">
          <div id="qbank-subject-list-container" style="display:flex; flex-direction:column; gap:16px;">
            <div style="position:relative; width:100%;">
            <button style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px 24px; text-align:left; justify-content:space-between; align-items:center; display:flex; width:100%; box-shadow:0 1px 3px rgba(0,0,0,0.05); cursor:pointer; transition:all 0.2s;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 6px -1px rgba(0,0,0,0.1)';" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 1px 3px rgba(0,0,0,0.05)';" onclick="window.startQBankFiltered('${subSafe}', null)">
              <div style="display:flex; align-items:center; gap:20px;">
                <div style="width:48px; height:48px; border-radius:12px; background:#f8fafc; border:1px solid #e2e8f0; display:flex; align-items:center; justify-content:center;">
                  <i data-lucide="shuffle" style="width:24px; height:24px; color:#6b7280;"></i>
                </div>
                <div>
                  <div style="font-size:1.2rem; font-weight:600; color:#111827;">All Chapters (Mix)</div>
                  <div style="font-size:0.9rem; color:#6b7280; margin-top:4px;">Practice questions from all chapters in this subject</div>
                </div>
              </div>
              <div style="display:flex; gap:24px; align-items:center;">
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Answered</div>
                  <div style="font-size:1rem; font-weight:500; color:#111827; margin-top:4px;">${stats.answered} / ${stats.total}</div>
                </div>
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Score</div>
                  <div style="font-size:1rem; font-weight:700; color:${globalScoreUI.color}; margin-top:4px; display:inline-block; background:${globalScoreUI.bg}; padding:2px 10px; border-radius:12px;">${globalScoreUI.text}</div>
                </div>
                <i data-lucide="chevron-right" style="width:20px;height:20px;color:#9ca3af;margin-left:10px;"></i>
              </div>
            </button>
            </div>`;
            
      const chaptersList = Object.keys(stats.chapters).sort((a,b) => a.localeCompare(b));
      
      chaptersList.forEach(ch => {
          const chStats = stats.chapters[ch];
          const chSafe = window.escapeHtml ? window.escapeHtml(ch).replace(/'/g, "\\'") : ch;
          const scoreUI = getScoreDisplay(chStats.correct, chStats.answered);
          
          let adminBtn = "";
          if (window.isQBankAdmin) {
             adminBtn = `<div style="position:absolute; top:-12px; left:80px; z-index:2; display:flex; gap:8px;">
               <button style="padding:4px 10px; font-size:0.75rem; font-weight:600; color:#8b5cf6; border:1px solid #ede9fe; background:#f5f3ff; border-radius:999px; cursor:pointer; display:flex; align-items:center;" onclick="event.stopPropagation(); window.qbankAdminMoveChapter('${subSafe}', '${chSafe}')"><i data-lucide="folder-input" style="width:12px;height:12px;margin-right:4px;"></i>Merge</button>
               <button style="padding:4px 10px; font-size:0.75rem; font-weight:600; color:#0ea5e9; border:1px solid #e0f2fe; background:#f0f9ff; border-radius:999px; cursor:pointer; display:flex; align-items:center;" onclick="event.stopPropagation(); window.qbankAdminRenameChapter('${subSafe}', '${chSafe}')"><i data-lucide="edit-3" style="width:12px;height:12px;margin-right:4px;"></i>Rename</button>
             </div>`;
          }
          const design = window.getSubjectDesign(ch);
          html += `
            <div style="position:relative; width:100%;">
            ${adminBtn}
            <button class="qbank-subject-btn" data-subject="${chSafe}" style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px 24px; text-align:left; justify-content:space-between; align-items:center; display:flex; width:100%; box-shadow:0 1px 3px rgba(0,0,0,0.05); cursor:pointer; transition:all 0.2s; position:relative; overflow:hidden;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 6px -1px rgba(0,0,0,0.1)';" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 1px 3px rgba(0,0,0,0.05)';" onclick="window.startQBankFiltered('${subSafe}', '${chSafe}')">
              <div style="display:flex; align-items:center; gap:20px; z-index:1;">
                <div style="width:48px; height:48px; border-radius:12px; background:${design.color}15; border:1px solid ${design.color}30; display:flex; align-items:center; justify-content:center;">
                  <i data-lucide="${design.icon}" style="width:24px; height:24px; color:${design.color};"></i>
                </div>
                <div>
                  <div style="font-size:1.1rem; font-weight:600; color:#111827;">${window.escapeHtml ? window.escapeHtml(ch) : ch}</div>
                  <div style="font-size:0.9rem; color:#6b7280; margin-top:4px;">Start Chapter</div>
                </div>
              </div>
              <div style="display:flex; gap:24px; align-items:center; z-index:1;">
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Answered</div>
                  <div style="font-size:1rem; font-weight:500; color:#111827; margin-top:4px;">${chStats.answered} / ${chStats.total}</div>
                </div>
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Score</div>
                  <div style="font-size:1rem; font-weight:700; color:${scoreUI.color}; margin-top:4px; display:inline-block; background:${scoreUI.bg}; padding:2px 10px; border-radius:12px;">${scoreUI.text}</div>
                </div>
                <i data-lucide="chevron-right" style="width:20px;height:20px;color:#9ca3af;margin-left:10px;"></i>
              </div>
              <i data-lucide="${design.icon}" style="position:absolute; right:15%; top:-20px; width:120px; height:120px; opacity:0.03; color:${design.color}; pointer-events:none; transform:rotate(-15deg);"></i>
            </button>
            </div>`;
      });
      
      html += `</div></div>`;
      area.innerHTML = html;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.filterQBankSubjects = function(query) {
    const q = (query || "").toLowerCase();
    const container = document.getElementById("qbank-subject-list-container");
    if (!container) return;
    const btns = container.querySelectorAll(".qbank-subject-btn");
    btns.forEach(btn => {
      const text = (btn.getAttribute("data-subject") || "").toLowerCase();
      if (text.includes(q)) {
        btn.style.display = "flex";
      } else {
        btn.style.display = "none";
      }
    });
  };

  window.startQBankFiltered = async function(subject, chapter = null, reviewIncorrectsOnly = false) {
    // If subject contains a hyphen and chapter is not provided, try to parse them from the combined string (e.g. from last session)
    if (subject && !chapter && subject.includes(" - ")) {
        const parts = subject.split(" - ");
        const potentialSubject = parts[0];
        const isValid = window.qbankCurrentSubjectStats 
            ? !!window.qbankCurrentSubjectStats[potentialSubject]
            : allQuestions.some(q => q.data && q.data.subject === potentialSubject);
        if (isValid) {
            subject = potentialSubject;
            chapter = parts.slice(1).join(" - ");
        }
    }

    // Ensure allQuestions is populated from cached data
    if (allQuestions.length === 0) {
        const activeQBankId = window.db && window.db.selectedQBankId;
        if (activeQBankId && cachedQBanks[activeQBankId]) {
            allQuestions = cachedQBanks[activeQBankId].questions || [];
            window.qbankProgress = cachedQBanks[activeQBankId].progress || {};
            currentQBankId = activeQBankId;
        }
    }

    if (window.pendingPartyCreation) {
       window.pendingPartyCreation = false;
       window.QBankParty.createParty(currentQBankId, subject || "All").then(code => {
           window.QBankParty.attachParty(code);
           setTimeout(() => window.qbankToast("Answer Party Created! Invite Code: " + code), 500);
       }).catch(e => window.qbankToast(e.message, true));
       return;
    }
    // Save session for Continue feature
    const qbName = document.getElementById("qbank-active-name")?.textContent || "QBank";
    saveQBankSession(currentQBankId, qbName, chapter ? `${subject} - ${chapter}` : (subject || "All Subjects"));
    
    if (subject) {
      currentQuestions = allQuestions.filter(q => q.data && q.data.subject === subject);
      if (chapter) {
          currentQuestions = currentQuestions.filter(q => q.data && q.data.chapter === chapter);
      }
    } else {
      currentQuestions = [...allQuestions];
    }

    if (reviewIncorrectsOnly) {
        currentQuestions = currentQuestions.filter(q => {
            const p = window.qbankProgress[q.id];
            return p && (p.correct === false || p.marked === true);
        });
    }
    
    // 1. Sort by creation time to guarantee sequential order (vital for clinical cases)
    currentQuestions.sort((a, b) => {
       const t1 = (a.data && a.data.createdAt) ? a.data.createdAt : 0;
       const t2 = (b.data && b.data.createdAt) ? b.data.createdAt : 0;
       return t1 - t2;
    });

    // (Removed random shuffle to ensure stable question ordering across sessions)

    // Answer split: stems render immediately; answer slices load lazily via
    // the render-window prefetch in qbankRenderCurrent (fire-and-forget) +
    // await-on-demand in qbankSelectOption. No whole-block prefetch: a 37k
    // "All subjects" block must not fan out to hundreds of requests.
    
    let firstUnsolved = 0;
    for (let i = 0; i < currentQuestions.length; i++) {
       const p = window.qbankProgress[currentQuestions[i].id] || {};
       if (p.correct === undefined) {
          firstUnsolved = i;
          break;
       }
    }
    
    currentIndex = firstUnsolved;
    window.currentQuestions = currentQuestions;
    window.currentIndex = currentIndex;
    
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "flex";
    
    const sidebar = document.getElementById("qbank-sidebar");
    if (sidebar) sidebar.style.display = "flex";

    window.qbankRenderCurrent();
    
    if (window.QBankParty && window.QBankParty.state.party && typeof window.qbankPartyStateChanged === 'function') {
        window.qbankPartyStateChanged(true, true);
    }
  };

  // Upgrades content images: capped height so they never dominate the
  // explanation box, hover hint, and click-to-zoom lightbox.
  window.qbankEnhanceImages = function(rootEl) {
    const root = rootEl || document;
    root.querySelectorAll(".qbank-rich img").forEach(img => {
      if (img.dataset.enhanced) return;
      img.dataset.enhanced = "1";
      img.style.maxWidth = "100%";
      img.style.maxHeight = "260px";
      img.style.width = "auto";
      img.style.height = "auto";
      img.style.borderRadius = "10px";
      img.style.cursor = "zoom-in";
      img.style.transition = "filter .15s ease";
      img.addEventListener("click", () => window.qbankOpenImageLightbox(img.src));
    });
    if (root.querySelector && root.querySelector(".qbank-rich img") && window.lucide && window.lucide.createIcons) {
      try { window.lucide.createIcons(); } catch (_) {}
    }
  };

  window.qbankOpenImageLightbox = function(src) {
    const old = document.getElementById("qbank-img-lightbox");
    if (old) old.remove();
    const lb = document.createElement("div");
    lb.id = "qbank-img-lightbox";
    lb.innerHTML = `
      <button type="button" class="qlb-close" title="Close (Esc)">×</button>
      <img src="${src}" alt="Enlarged image" />
      <div class="qlb-hint">Click anywhere or press Esc to close</div>
      <style>${QLB_CSS}</style>`;
    document.body.appendChild(lb);
    document.body.style.overflow = "hidden";
    const close = () => { lb.remove(); document.body.style.overflow = ""; };
    lb.addEventListener("click", close);
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
    });
  };

  const QLB_CSS = `
  #qbank-img-lightbox { position: fixed; inset: 0; z-index: 2147483000;
    background: rgba(4,12,16,0.92); backdrop-filter: blur(8px);
    display: flex; align-items: center; justify-content: center; padding: 40px;
    cursor: zoom-out; }
  #qbank-img-lightbox img { max-width: min(1100px, 92vw); max-height: 88vh;
    width: auto; height: auto; border-radius: 12px;
    box-shadow: 0 30px 90px rgba(0,0,0,0.7); cursor: default; }
  #qbank-img-lightbox .qlb-close { position: absolute; top: 18px; right: 22px;
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2);
    color: #fff; font-size: 26px; width: 42px; height: 42px; border-radius: 50%;
    cursor: pointer; line-height: 1; transition: background .15s ease; }
  #qbank-img-lightbox .qlb-close:hover { background: rgba(244,63,94,0.35); }
  #qbank-img-lightbox .qlb-hint { position: absolute; bottom: 20px; left: 50%;
    transform: translateX(-50%); color: rgba(255,255,255,0.55); font-size: 0.8rem;
    font-family: 'Figtree', sans-serif; }
  `;

  window.qbankJumpTo = function(idx) {
    if (idx < 0 || idx >= currentQuestions.length) return;
    
    const isParty = document.getElementById("qbank-party-sidebar")?.style.display !== "none";
    if (isParty) {
        if (!window.QBankParty || !window.QBankParty.state.isHost) {
            window.qbankToast("Only the host can jump to a different question during a party.", true);
            return;
        }
        const nextId = currentQuestions[idx].id;
        window.QBankParty.hostStartSession(nextId);
        return;
    }
    
    currentIndex = idx;
    window.currentIndex = currentIndex;
    window.qbankRenderSidebar();
    window.qbankRenderCurrent();
  };

  window.qbankRenderSidebar = function() {
    const container = document.getElementById("qbank-sidebar");
    if (!container) return;
    
    let html = "";
    currentQuestions.forEach((q, idx) => {
      const p = window.qbankProgress[q.id] || {};
      const isMarked = p.marked;
      const isAnswered = p.correct !== undefined;
      const isActive = idx === currentIndex;
      
      let cls = "usmle-sidebar-item";
      if (isActive) cls += " active";
      if (isAnswered) cls += " answered";
      if (isMarked) cls += " flagged";
      
      let icon = "";
      if (isAnswered) {
          icon = `<div style="position:absolute; bottom: -2px; right: -2px; width: 12px; height: 12px; background: #0e7c86; border-radius: 50%; box-shadow: 0 0 0 2px #ffffff; display: flex; align-items: center; justify-content: center;"><i data-lucide="check" style="width: 8px; height: 8px; color: #ffffff; stroke-width: 4px;"></i></div>`;
      }
      
      html += `<div class="${cls}" onclick="window.qbankJumpTo(${idx})">${idx + 1}${icon}</div>`;
    });
    
    container.innerHTML = html;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    
    // Auto scroll to active
    const activeEl = container.children[currentIndex];
    if (activeEl) {
       activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };

  if (!document.getElementById("uiverse-radio-styles")) {
    const style = document.createElement("style");
    style.id = "uiverse-radio-styles";
    style.innerHTML = `
      .qbank-radio-input label.uiverse-label {
        display: flex;
        background-color: var(--bg-elevated, #fff);
        padding: 16px 20px;
        margin: 10px 0;
        font-size: 1rem;
        font-weight: 600;
        border-radius: 12px;
        cursor: pointer;
        border: 2px solid var(--border-color, rgba(187, 187, 187, 0.2));
        color: var(--text-primary, #000);
        transition: .3s ease;
      }
      .qbank-radio-input label.uiverse-label:hover {
        background-color: var(--hover-bg, rgba(24, 24, 24, 0.05));
        border-color: var(--border-hover, #bbb);
      }
      .qbank-radio-input input:checked + label.uiverse-label {
        border-color: var(--accent-cyan, #2dd4bf);
        background-color: var(--accent-cyan-light, rgba(45, 212, 191, 0.05));
      }
      /* Pre-submit picked state: calm brand-teal outline, NOT green/red.
         Green = correct and red = wrong are applied only after submit.
         Scoped to :not(.answered) so the picked style can never override
         the post-submit correct/incorrect highlight. Must beat rebrand.css
         .usmle-option rules which use !important. */
      #qbank-options-container:not(.answered) .qbank-radio-input input:checked + label.usmle-option,
      #qbank-options-container:not(.answered) .usmle-option.qbank-option-btn.selected {
        background: #eef6f7 !important;
        border-color: #0e7c86 !important;
        color: #0a3d4a !important;
        box-shadow: 0 0 0 1px #0e7c86 inset !important;
      }
      #qbank-options-container:not(.answered) .qbank-radio-input input:checked + label.usmle-option .usmle-option-letter,
      #qbank-options-container:not(.answered) .usmle-option.qbank-option-btn.selected .usmle-option-letter {
        color: #ffffff !important;
        background: #0e7c86 !important;
        border-radius: 6px !important;
        padding: 1px 7px !important;
        margin-right: 12px !important;
        opacity: 1 !important;
      }
      body.dark-exam #qbank-options-container:not(.answered) .qbank-radio-input input:checked + label.usmle-option,
      html.dark #qbank-options-container:not(.answered) .qbank-radio-input input:checked + label.usmle-option,
      body.dark-exam #qbank-options-container:not(.answered) .usmle-option.qbank-option-btn.selected,
      html.dark #qbank-options-container:not(.answered) .usmle-option.qbank-option-btn.selected {
        background: rgba(14,124,134,0.18) !important;
        border-color: #2dd4bf !important;
        color: #eef4f5 !important;
        box-shadow: 0 0 0 1px #2dd4bf inset !important;
      }
      body.dark-exam #qbank-options-container:not(.answered) .qbank-radio-input input:checked + label.usmle-option .usmle-option-letter,
      html.dark #qbank-options-container:not(.answered) .qbank-radio-input input:checked + label.usmle-option .usmle-option-letter,
      body.dark-exam #qbank-options-container:not(.answered) .usmle-option.qbank-option-btn.selected .usmle-option-letter,
      html.dark #qbank-options-container:not(.answered) .usmle-option.qbank-option-btn.selected .usmle-option-letter {
        color: #062a2e !important;
        background: #2dd4bf !important;
      }
      /* Post-submit: guarantee green/red always win over any picked style. */
      #qbank-options-container.answered .usmle-option.correct {
        background: #e8f4ee !important;
        border-color: #0f8a5f !important;
        color: #0a5a3f !important;
        box-shadow: none !important;
      }
      #qbank-options-container.answered .usmle-option.incorrect {
        background: #fbeae7 !important;
        border-color: #c0392b !important;
        color: #7a2216 !important;
        box-shadow: none !important;
      }
      #qbank-options-container.answered .usmle-option.partial {
        background: #fef9c3 !important;
        border-color: #eab308 !important;
        color: #713f12 !important;
        box-shadow: none !important;
      }
      body.dark-exam #qbank-options-container.answered .usmle-option.correct,
      html.dark #qbank-options-container.answered .usmle-option.correct {
        background: #123424 !important;
        border-color: #0f8a5f !important;
        color: #a7e3c4 !important;
      }
      body.dark-exam #qbank-options-container.answered .usmle-option.incorrect,
      html.dark #qbank-options-container.answered .usmle-option.incorrect {
        background: #3a1a14 !important;
        border-color: #c0392b !important;
        color: #f2b8ae !important;
      }
      body.dark-exam #qbank-options-container.answered .usmle-option.partial,
      html.dark #qbank-options-container.answered .usmle-option.partial {
        background: rgba(234,179,8,0.15) !important;
        border-color: #eab308 !important;
        color: #fde68a !important;
      }
      .qbank-radio-input input:focus-visible + label.usmle-option {
        outline: 2px solid #0e7c86 !important;
        outline-offset: 2px;
      }
    `;
    document.head.appendChild(style);
  }

  // Keeps the visual .selected class in sync with the hidden radio/checkbox
  // state so users see their pick BEFORE pressing Submit / Lock Answer.
  // Pure :checked + label CSS is not enough because rebrand.css overrides
  // it with !important rules.
  window.qbankSyncOptionSelected = function () {
    const container = document.getElementById("qbank-options-container");
    if (!container || container.classList.contains("answered")) return;
    const inputs = container.querySelectorAll('input[name="qbank-radio"]');
    inputs.forEach((input) => {
      const label = document.getElementById("qbank-opt-" + input.value)
        || input.nextElementSibling;
      if (!label) return;
      if (input.checked) label.classList.add("selected");
      else label.classList.remove("selected");
      input.setAttribute("aria-checked", input.checked ? "true" : "false");
    });
  };

  window.qbankWireOptionSelection = function () {
    const container = document.getElementById("qbank-options-container");
    if (!container) return;
    const inputs = container.querySelectorAll('input[name="qbank-radio"]');
    inputs.forEach((input) => {
      input.addEventListener("change", () => {
        if (container.classList.contains("answered")) return;
        const isRadio = input.type === "radio";
        if (isRadio) {
          // Single-answer (party lock mode): clear peers, mark this one.
          inputs.forEach((other) => {
            const otherLabel = document.getElementById("qbank-opt-" + other.value)
              || other.nextElementSibling;
            if (otherLabel) otherLabel.classList.toggle("selected", other === input && input.checked);
          });
        } else {
          const label = document.getElementById("qbank-opt-" + input.value)
            || input.nextElementSibling;
          if (label) label.classList.toggle("selected", input.checked);
        }
        window.qbankSyncOptionSelected();
      });
    });
    window.qbankSyncOptionSelected();
  };

  window.qbankRenderCurrent = function () {
    const area = document.getElementById("qbank-question-area");
    if (currentIndex >= currentQuestions.length) {
      stopTimer();
      area.innerHTML = `<div style="padding:60px; text-align:center;">
        <i data-lucide="check-circle" style="width:64px; height:64px; color:var(--accent-cyan); margin-bottom:20px;"></i>
        <h2>You have completed all questions in this session!</h2>
        <button class="btn-action primary" style="margin-top:20px; padding:12px 24px;" onclick="window.openQBank()">Return to QBank Home</button>
      </div>`;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      window.qbankEnhanceImages && window.qbankEnhanceImages(document.getElementById("qbank-modal"));
      return;
    }
    
    const q = currentQuestions[currentIndex];
    const data = q.data || {};
    
    const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
    // Answer split: while the slice is in flight, fall back to the
    // non-sensitive `multi` stem flag so QCM still renders as checkboxes.
    const isMultiple = correctIndices.length > 1 || (correctIndices.length === 0 && data.multi === true);
    
    const inPartyMode = window.QBankParty && window.QBankParty.state.party;
    let optionsHtml = '';
    if (data.options) {
      // Get peer stats for this question
      const peerStats = window.qbankPeerStats && window.qbankPeerStats[q.id] || null;
      const peerThreshold = window.qbankPeerThreshold || 50;
      const isAdmin = window.isAdminCache || false;
      const showPeerStats = peerStats && peerStats.total >= peerThreshold;
      
      optionsHtml = data.options.map((opt, i) => {
        let peerPercent = '';
        // New batched writes land in userCounts; ancient docs used counts.
        const voteCounts = (peerStats && (peerStats.userCounts || peerStats.counts)) || null;
        
        // Admin always sees real percentages
        if (isAdmin && peerStats && voteCounts) {
          const count = voteCounts[i] || 0;
          const pct = peerStats.total > 0 ? Math.round((count / peerStats.total) * 100) : 0;
          peerPercent = `<span style="font-size:11px; color:#6b7280; margin-left:8px; font-weight:600;">${pct}%</span>`;
        }
        // Regular users only see percentages when threshold is met
        else if (showPeerStats && voteCounts) {
          const count = voteCounts[i] || 0;
          const pct = peerStats.total > 0 ? Math.round((count / peerStats.total) * 100) : 0;
          peerPercent = `<span style="font-size:11px; color:#6b7280; margin-left:8px; font-weight:600;">${pct}%</span>`;
        }
        // Otherwise show nothing (no "Pending", no "No data")
        
        return `
        <div class="qbank-radio-input" style="position:relative; width:100%;">
          <input type="${isMultiple ? 'checkbox' : 'radio'}" id="qbank-radio-input-${i}" name="qbank-radio" value="${i}" style="position:absolute; opacity:0; pointer-events:none; width:1px; height:1px; margin:0;" ${!isMultiple && !inPartyMode ? 'onclick="event.preventDefault()"' : ''} aria-label="Option ${String.fromCharCode(65 + i)}">
          <label class="usmle-option qbank-option-btn uiverse-label" id="qbank-opt-${i}" for="qbank-radio-input-${i}" ${!isMultiple && !inPartyMode ? `onclick="window.qbankSelectOption(${i}); event.preventDefault();"` : ""} style="display:flex; align-items:flex-start; width:100%; box-sizing:border-box;">
            <span class="usmle-option-letter" style="margin-right:12px; font-weight:800; opacity:0.8;">${String.fromCharCode(65 + i)}</span>
            <span class="usmle-option-text" style="flex:1;">${window.renderRichText ? window.renderRichText(opt) : (window.escapeHtml ? window.escapeHtml(opt) : opt)}</span>
            ${peerPercent}
          </label>
        </div>`;
      }).join('');
    }
    
    // Fetch peer stats for this question (cached: 0 reads on revisit).
    // loadPeerStats() dedupes in-flight requests and serves fresh cache,
    // so rapid Next/Prev navigation never fires duplicate Firestore gets.
    if (q.id && window.loadPeerStats) {
      window.loadPeerStats(q.id).then((stats) => {
        // Only paint if the user hasn't navigated away mid-fetch.
        if (!currentQuestions[currentIndex] || currentQuestions[currentIndex].id !== q.id) return;
        if (stats && window.qbankUpdatePeerPercentages) {
          window.qbankUpdatePeerPercentages(q.id, stats);
        }
      }).catch(() => {});
    }

    // Answer-split prefetch: current + next 10, fire-and-forget. Answers land
    // in memory (never IDB) well before the user answers; qbankSelectOption
    // awaits the single slice as fallback. Served from R2 (0 Firestore reads).
    window.__qbankRenderedMulti = isMultiple;
    window.__qbankRenderedQid = q.id;
    if (q.id && typeof window.ensureQBankAnswers === "function") {
      const winIds = [];
      for (let k = currentIndex; k < Math.min(currentIndex + 11, currentQuestions.length); k++) {
        const qq = currentQuestions[k];
        if (qq && qq.id && !(qq.data && (qq.data.correctIndices !== undefined || qq.data.correctOptionIndex !== undefined))) winIds.push(qq.id);
      }
      if (winIds.length) {
        window.ensureQBankAnswers(currentQBankId, winIds).then(() => {
          if (typeof window.mergeQBankAnswers === "function") window.mergeQBankAnswers(currentQuestions, currentQBankId);
          // Stale-cache repair: stems saved before the `multi` flag existed
          // may have rendered QCM as QCS. Re-render once if unanswered and
          // the arrived slice flips the input type.
          if (qbankTimer && currentQuestions[currentIndex] && currentQuestions[currentIndex].id === q.id
              && window.__qbankRenderedQid === q.id) {
            const dd = currentQuestions[currentIndex].data || {};
            const ci = Array.isArray(dd.correctIndices) ? dd.correctIndices : [];
            if (ci.length > 0 && (ci.length > 1) !== window.__qbankRenderedMulti) {
              window.qbankRenderCurrent();
            }
          }
        }).catch(() => {});
      }
    }

    let submitHtml = '';
    if (inPartyMode) {
      submitHtml = `<button id="qbank-submit-btn" class="btn-action primary" style="margin-top:10px; width:100%; padding:12px;" onclick="window.qbankPartyLockAnswer()">Lock Answer</button>`;
    } else if (isMultiple) {
      submitHtml = `<button id="qbank-submit-btn" class="btn-action primary" style="margin-top:10px; width:100%; padding:12px;" onclick="window.qbankSelectOption()">Submit Answer</button>`;
    }

    area.innerHTML = `
      <div id="qbank-split-container" style="display:flex; max-width:1400px; margin:0 auto; padding:20px; gap:24px; text-align:left; align-items:flex-start;">
        
        <!-- MAIN QUESTION COLUMN -->
        <div id="qbank-left-col" style="flex:1; min-width:0; transition: width 0.3s ease;">
          <div class="usmle-question-card">
          <div class="usmle-question-num" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
            <div style="display:flex; align-items:center; gap:12px;">
              <button class="btn-dark-pill" style="padding:4px 8px; font-size:0.8rem; display:flex; align-items:center; gap:4px; height:27px; color:var(--text-secondary); border: 1px solid #d1d5db;" onclick="window.openQBank()" title="Return to QBank Home">
                <i class="fa-solid fa-arrow-left" style="font-size:12px;"></i> Leave
              </button>
              <span>Question ${currentIndex + 1} of ${currentQuestions.length}</span>
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
               ${(() => {
                 const p = window.qbankProgress[q.id] || {};
                 const isMarked = p.marked;
                 const hasNote = !!p.note;
                 const highActive = !!window.qbankHighlighterActive;
                 return `
                   <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:${isMarked ? 'var(--accent-cyan)' : 'var(--text-secondary)'}; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankToggleMark()">
                     <i class="fa-solid fa-bookmark" style="font-size:12px;${isMarked ? 'color:var(--accent-cyan);' : ''}"></i> ${isMarked ? 'Marked' : 'Mark'}
                   </button>
                   <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:${hasNote ? 'var(--accent-cyan)' : 'var(--text-secondary)'}; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankToggleNoteUI()">
                     <i class="fa-solid fa-file-alt" style="font-size:12px;${hasNote ? 'color:var(--accent-cyan);' : ''}"></i> ${hasNote ? 'Edit Note' : 'Add Note'}
                   </button>
                   <button class="btn-dark-pill" id="qbank-highlighter-btn" style="padding:4px 10px; font-size:0.8rem; color:${highActive ? 'var(--accent-cyan)' : 'var(--text-secondary)'}; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankToggleHighlighter()">
                     <i class="fa-solid fa-highlighter" style="font-size:12px;${highActive ? 'color:var(--accent-cyan);' : ''}"></i> Highlighter
                   </button>
                   <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:var(--text-secondary); display:flex; align-items:center; gap:4px; height:27px;" onclick="window.generateAIFlashcard('${q.id}')" title="Generate AI Flashcard for this question">
                     <i class="fa-solid fa-brain" style="font-size:12px;"></i> AI Flashcard
                   </button>
                   <button id="qbank-study-btn" class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:var(--accent-cyan); display:flex; align-items:center; gap:4px; height:27px;" onclick="window.generateStudyConcept('${q.id}')" title="Study this concept in detail">
                     <i class="fa-solid fa-book-open" style="font-size:12px;"></i> Study this part
                   </button>
                   <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:#ef4444; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankReportQuestion('${q.id}')" title="Report an error in this question">
                     <i class="fa-solid fa-flag" style="font-size:12px;"></i> Report
                   </button>
                 `;
               })()}
               <span title="${isMultiple ? 'Question à Choix Multiples (Multiple Answers)' : 'Question à Choix Simple (Single Answer)'}" style="font-size:0.8rem; padding:4px 10px; background:${isMultiple ? 'rgba(168,85,247,0.15)' : 'rgba(6,182,212,0.15)'}; border:1px solid ${isMultiple ? 'rgba(168,85,247,0.3)' : 'rgba(6,182,212,0.3)'}; border-radius:12px; color:${isMultiple ? '#a855f7' : '#06b6d4'}; font-weight:700; cursor:help; letter-spacing:0.5px;">${isMultiple ? 'QCM' : 'QCS'}</span>
               ${data.subject ? `<span style="font-size:0.8rem; padding:4px 10px; background:rgba(255,255,255,0.1); border-radius:12px; color:var(--text-secondary); text-transform:uppercase;">${window.escapeHtml ? window.escapeHtml(data.subject) : data.subject}</span>` : ""}
               <span style="font-size:0.8rem; padding:4px 10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:12px; color:var(--text-secondary); font-family:monospace;">ID: ${data.code ? (window.escapeHtml ? window.escapeHtml(data.code) : data.code) : ("Q-" + q.id.substring(0, 5).toUpperCase())}</span>
               ${(data.tags || []).map(t => `<span style="font-size:0.75rem; padding:3px 8px; background:rgba(167, 139, 250, 0.15); border:1px solid rgba(167, 139, 250, 0.3); border-radius:12px; color:#a78bfa;">#${window.escapeHtml ? window.escapeHtml(t) : t}</span>`).join("")}

               ${window.isQBankAdmin ? `
                 <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:#f43f5e; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankAdminDelete('${q.id}')">
                   <i class="fa-solid fa-trash" style="font-size:12px;"></i> Delete
                 </button>
                 <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:#38bdf8; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankAdminEdit('${q.id}')">
                   <i class="fa-solid fa-edit" style="font-size:12px;"></i> Edit
                 </button>
               ` : ''}
            </div>
          </div>
          
          ${(() => {
             const p = window.qbankProgress[q.id] || {};
             if (!p.note) return "";
             return `
             <div id="qbank-note-container" style="background:rgba(255,255,100,0.05); border-left:3px solid #facc15; padding:12px; margin-bottom:15px; border-radius:0 8px 8px 0; margin-top:15px;">
               <div style="font-size:0.8rem; color:#facc15; font-weight:700; margin-bottom:4px; display:flex; align-items:center; gap:4px;"><i class="fa-solid fa-sticky-note" style="font-size:12px;"></i> MY NOTE</div>
               <div style="font-size:0.9rem; color:var(--text-primary); white-space:pre-wrap;">${window.escapeHtml ? window.escapeHtml(p.note) : p.note}</div>
             </div>`;
          })()}

          <div id="qbank-note-editor" style="display:none; margin-top:15px; margin-bottom:15px; background:rgba(0,0,0,0.2); padding:12px; border-radius:8px; border:1px solid rgba(255,255,255,0.1);">
             <textarea id="qbank-note-input" class="login-input" style="width:100%; height:80px; padding:10px; font-size:0.9rem; margin-bottom:10px;" placeholder="Type your personal note here..."></textarea>
             <div style="display:flex; justify-content:flex-end; gap:8px;">
               <button class="btn-dark-pill" style="padding:6px 12px; font-size:0.85rem;" onclick="window.qbankToggleNoteUI()">Cancel</button>
               <button class="btn-action primary" style="padding:6px 12px; font-size:0.85rem;" onclick="window.qbankSaveNote()">Save Note</button>
             </div>
          </div>
          <h2 id="qbank-question-content" onmouseup="window.qbankHandleSelection(event)" style="font-size:1.05rem; line-height:1.6; margin-bottom:1.5rem; font-weight:500;">
            ${q.highlightedHTML ? q.highlightedHTML : (window.renderRichText ? window.renderRichText(q.text) : (window.escapeHtml ? window.escapeHtml(q.text) : q.text))}
          </h2>
          <div class="usmle-options" id="qbank-options-container">
            ${optionsHtml}
          </div>
          ${submitHtml}
          
          <div id="qbank-explanation-container" class="usmle-explanation" style="display:none; margin-top:30px;">
             <div id="qbank-result-header" style="font-weight:bold; margin-bottom:12px; font-size:1.1rem;"></div>
             <div style="margin-bottom:16px; font-size:0.9rem; color:var(--text-muted); display:flex; align-items:center;">
               <i class="fa-regular fa-clock" style="font-size:14px; margin-right:4px;"></i> Time Taken: <span id="qbank-time-taken-text" style="margin-left:4px; font-weight:600; color:var(--text-primary);"></span>
             </div>
             <div style="display:flex; align-items:center; gap:10px; margin-bottom:14px;">
               <div style="width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg, rgba(14,124,134,0.2), rgba(45,212,191,0.15)); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                 <i class="fa-solid fa-lightbulb" style="font-size:18px;color:var(--accent-cyan, #2dd4bf);"></i>
               </div>
               <h3 style="font-size:1.1rem; margin:0; color:var(--text-primary); font-weight:700; letter-spacing:-0.01em;">Explanation</h3>
             </div>
             <div class="qbank-rich qbank-explanation-body" style="font-size:0.95rem; line-height:1.7; color:var(--text-secondary);">
               ${(() => {
                 const blocksHtml = window.renderExplanationBlocks ? window.renderExplanationBlocks(data.explanationBlocks) : "";
                 let textHtml = "No explanation provided.";
                 if (data.explanation) {
                   textHtml = (window.marked && window.DOMPurify)
                     ? window.DOMPurify.sanitize(window.marked.parse(data.explanation))
                     : (window.escapeHtml ? window.escapeHtml(data.explanation) : data.explanation);
                 }
                 const combined = blocksHtml + textHtml;
                 return window.formatExplanationSections ? window.formatExplanationSections(combined, data.options || [], data.correctIndices || []) : combined;
               })()}
             </div>
             
             <!-- AI Chat Area -->
             <div style="margin-top:20px; border-top:1px solid var(--border-color, rgba(0,0,0,0.1)); padding-top:20px;">
               <button class="btn-dark-pill" style="color:var(--accent-cyan); display:flex; align-items:center; gap:8px;" onclick="window.qbankToggleChat()">
                 <i class="fa-solid fa-robot" style="font-size:18px;"></i> Ask AI Tutor
               </button>
               <div id="qbank-ai-chat-container" style="display:none; margin-top:15px; background:var(--surface-color, rgba(255,255,255,0.02)); border:1px solid var(--border-color, rgba(0,0,0,0.1)); border-radius:12px; padding:15px;">
                 <div id="qbank-ai-chat-history" style="max-height:250px; overflow-y:auto; margin-bottom:15px; display:flex; flex-direction:column; gap:10px; font-size:0.95rem;"></div>
                 <div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap;">
                   <button class="btn-dark-pill" style="font-size:0.8rem; padding:4px 10px;" onclick="document.getElementById('qbank-ai-chat-input').value='Explain why I was incorrect.'; window.qbankSendChat();">Explain why</button>
                   <button class="btn-dark-pill" style="font-size:0.8rem; padding:4px 10px;" onclick="document.getElementById('qbank-ai-chat-input').value='Summarize the key concept.'; window.qbankSendChat();">Summarize concept</button>
                   <button class="btn-dark-pill" style="font-size:0.8rem; padding:4px 10px;" onclick="document.getElementById('qbank-ai-chat-input').value='Give me a mnemonic to remember this.'; window.qbankSendChat();">Give mnemonic</button>
                 </div>
                 <div style="display:flex; gap:10px;">
                   <input type="text" id="qbank-ai-chat-input" class="login-input" placeholder="E.g. Why is option A incorrect?" style="flex:1; margin:0;" onkeypress="if(event.key==='Enter') window.qbankSendChat()">
                   <button id="qbank-ai-chat-send" class="btn-action primary" style="padding:0 20px;" onclick="window.qbankSendChat()">Send</button>
                 </div>
               </div>
             </div>

             <button class="usmle-proceed-btn" style="margin-top:20px; width:100%;" onclick="window.qbankNext()">Next Question</button>
          </div> <!-- closes qbank-explanation-container -->
        </div> <!-- closes usmle-question-card -->
      </div> <!-- closes qbank-left-col -->
      
      <!-- STUDY CONCEPT RIGHT COLUMN -->
      <div id="qbank-right-col" style="display:none; flex:1; min-width:0; background:var(--surface-color, #fff); border:1px solid var(--border-color, rgba(0,0,0,0.1)); border-radius:8px; overflow:hidden; flex-direction:column; box-shadow:0 4px 20px rgba(0,0,0,0.05); height: calc(100vh - 120px); position: sticky; top: 80px;">
         <div style="display:flex; border-bottom:1px solid var(--border-color, rgba(0,0,0,0.1)); background:var(--header-bg, rgba(0,0,0,0.02));">
           <div style="padding:12px 24px; background:var(--surface-color, #fff); border-right:1px solid var(--border-color, rgba(0,0,0,0.1)); border-bottom:2px solid var(--primary-color); font-weight:600; font-size:0.95rem; color:var(--text-primary); cursor:pointer;">
             Explanation
           </div>
           <div style="flex:1;"></div>
           <button class="btn-icon" style="padding:12px; color:var(--text-muted);" onclick="window.closeStudyConcept()" title="Close">
             <i class="fa-solid fa-times"></i>
           </button>
         </div>
         <div id="qbank-study-content" class="qbank-rich" style="padding:24px; overflow-y:auto; flex:1; font-size:0.95rem; line-height:1.7; color:var(--text-color);">
         </div> <!-- closes qbank-study-content -->
      </div> <!-- closes qbank-right-col -->
    </div> <!-- closes qbank-split-container -->
  `;
    
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    startTimer();
    
    window.qbankRenderSidebar();
    // Wire pre-submit selected visuals (QCM + party lock mode).
    if (window.qbankWireOptionSelection) window.qbankWireOptionSelection();
  };

  window.qbankSelectOption = async function (selectedIndex) {
    if (!qbankTimer) return; // already answered
    stopTimer();
    
    currentQuestionTimeMs = Date.now() - questionStartTime;
    const q = currentQuestions[currentIndex];
    const data = q.data || {};
    // Answer split: the slice is usually prefetched by the render window;
    // await it here as fallback so grading never runs on missing answers.
    if (q && q.id && !(data.correctIndices !== undefined || data.correctOptionIndex !== undefined)) {
      try {
        if (typeof window.ensureQBankAnswers === "function") {
          await window.ensureQBankAnswers(currentQBankId, [q.id]);
          if (typeof window.mergeQBankAnswers === "function") window.mergeQBankAnswers([q], currentQBankId);
        }
      } catch (_) {}
    }
    const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
    const isMultiple = correctIndices.length > 1;

    let selectedIndices = [];
    if (isMultiple) {
      const inputs = document.getElementsByName("qbank-radio");
      inputs.forEach(r => { if (r.checked) selectedIndices.push(parseInt(r.value, 10)); });
      const submitBtn = document.getElementById("qbank-submit-btn");
      if (submitBtn) submitBtn.style.display = "none";
    } else {
      selectedIndices = [selectedIndex];
      const inputs = document.getElementsByName("qbank-radio");
      inputs.forEach((r) => { if (parseInt(r.value, 10) === selectedIndex) r.checked = true; });
    }
    
    currentSelectedIndices = selectedIndices;

    let isCorrect = false;
    // Partially correct: QCM subset with no wrong picks (e.g. correct=A,B,C and picked=A,B)
    let isPartial = false;
    if (isMultiple) {
      if (selectedIndices.length === correctIndices.length) {
        const sortedSelected = [...selectedIndices].sort();
        const sortedCorrect = [...correctIndices].sort();
        isCorrect = sortedSelected.every((v, i) => v === sortedCorrect[i]);
      }
      if (!isCorrect && selectedIndices.length > 0 && selectedIndices.every((v) => correctIndices.includes(v)) && selectedIndices.length < correctIndices.length) {
        isPartial = true;
      }
    } else {
      isCorrect = correctIndices.includes(selectedIndex);
    }
    
    // Highlight UI
    const container = document.getElementById("qbank-options-container");
    const labels = container.querySelectorAll(".qbank-option-btn");
    const inputsByIndex = container.querySelectorAll('input[name="qbank-radio"]');
    // Lock the question: pre-submit picked style is scoped to :not(.answered),
    // so adding this class guarantees green/red win after submit.
    container.classList.add("answered");
    labels.forEach((label, i) => {
      label.style.pointerEvents = "none";
      label.classList.remove("selected");
      const input = inputsByIndex[i] || document.getElementById("qbank-radio-input-" + i);
      if (input) input.disabled = true;
      
      if (isPartial && selectedIndices.includes(i) && correctIndices.includes(i)) {
        // User's picked subset: correct but incomplete -> yellow so their answer stays visible
        label.classList.add("partial");
        label.style.background = "rgba(234,179,8,0.12)";
        label.style.border = "2px solid #eab308";
        label.style.borderRadius = "12px";
        label.style.padding = "16px 20px";
      } else if (correctIndices.includes(i)) {
        label.classList.add("correct");
        label.style.background = "rgba(34,197,94,0.1)";
        label.style.border = "2px solid #22c55e";
        label.style.borderRadius = "12px";
        label.style.padding = "16px 20px";
      } else if (selectedIndices.includes(i) && !correctIndices.includes(i)) {
        label.classList.add("incorrect");
        label.style.background = "rgba(244,63,94,0.1)";
        label.style.border = "2px solid #f43f5e";
        label.style.borderRadius = "12px";
        label.style.padding = "16px 20px";
      }
    });

    const explContainer = document.getElementById("qbank-explanation-container");
    const resultHeader = document.getElementById("qbank-result-header");
    
    if (isCorrect) {
      resultHeader.innerHTML = '<span style="color:#22c55e;"><i data-lucide="check-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Correct</span>';
    } else if (isPartial) {
      resultHeader.innerHTML = '<span style="color:#eab308;"><i data-lucide="check-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Partially correct</span>';
    } else {
      resultHeader.innerHTML = '<span style="color:#f43f5e;"><i data-lucide="x-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Incorrect</span>';
    }

    // Auto-open the study concept panel (#qbank-study-content) on both
    // incorrect AND partially-correct answers (partial = QCM subset with
    // no wrong picks, e.g. picked A,B of correct A,B,C).
    if (!isCorrect) {
      if (!document.getElementById("qbank-study-styles")) {
        const style = document.createElement("style");
        style.id = "qbank-study-styles";
        style.innerHTML = `
          @keyframes qbank-pulse-glow {
            0% { box-shadow: 0 0 0 0 rgba(244,63,94, 0.6); }
            70% { box-shadow: 0 0 0 10px rgba(244,63,94, 0); }
            100% { box-shadow: 0 0 0 0 rgba(244,63,94, 0); }
          }
          .qbank-study-glow {
            animation: qbank-pulse-glow 2s infinite !important;
            border-color: rgba(244,63,94,0.5) !important;
            background: rgba(244,63,94,0.1) !important;
            color: #f43f5e !important;
          }
        `;
        document.head.appendChild(style);
      }

      const studyBtn = document.getElementById("qbank-study-btn");
      if (studyBtn) {
        studyBtn.classList.add("qbank-study-glow");
        // Auto-open study concept when wrong or partially correct.
        // Cost is one-time per question globally: first wrong answer pays
        // 1r + 1 AI call + save, then it's cached (server 10-min + IDB
        // forever) and free for every future student.
        window.generateStudyConcept(q.id);
      }
    }
    
    document.getElementById("qbank-time-taken-text").textContent = formatTime(currentQuestionTimeMs);
    explContainer.style.display = "block";
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

    // Update local progress so sidebar icon shows immediately
    const p = window.qbankProgress[q.id] || {};
    p.correct = isCorrect;
    p.partial = isPartial;
    p.timeTakenMs = currentQuestionTimeMs;
    window.qbankProgress[q.id] = p;
    window.qbankRenderSidebar();

    // Submit progress silently
    if (currentQBankId) {
      pushToSyncQueue({
        qbankId: currentQBankId,
        questionId: q.id,
        correct: isCorrect,
        timeTakenMs: currentQuestionTimeMs,
        subject: (q.data && q.data.subject) || "",
        chapter: (q.data && q.data.chapter) || ""
      });
      // Feedback popup check (self-throttled + no-ops once done forever).
      try { window.maybeShowFeedback && window.maybeShowFeedback(); } catch (_) {}
    }

    // Log answer to global peer stats (write path also patches the cache,
    // so the UI refresh below needs no extra Firestore read).
    if (selectedIndices.length > 0) {
      _logPeerAnswer(q.id, selectedIndices[0]);
      // Update percentages without re-rendering (cached stats only: 0 reads)
      setTimeout(() => {
        try {
          const stats = window.qbankPeerStats && window.qbankPeerStats[q.id];
          if (stats && window.qbankUpdatePeerPercentages) {
            window.qbankUpdatePeerPercentages(q.id, stats);
          }
        } catch (_) {}
      }, 500);
    }
  };

  // Update peer percentages without re-rendering the question
  window.qbankUpdatePeerPercentages = async function(questionId, stats) {
    // Use the cached threshold (loaded once per session). The old code
    // refetched it on EVERY question render = 1 Firestore read per question.
    if (!window.qbankPeerThreshold) {
      window.qbankPeerThreshold = 50;
      if (window._loadPeerThreshold) window._loadPeerThreshold();
    }

    const peerThreshold = window.qbankPeerThreshold || 50;
    const isAdmin = window.isAdminCache || false;
    
    // Threshold + denominator use `total` (server increments it blindly per
    // batched vote). The users map no longer grows server-side, so unique
    // counting would freeze; total ≈ unique thanks to client dedupe.
    const uniqueUsers = stats && stats.users ? Object.keys(stats.users).length : 0;
    const totalVotes = (stats && typeof stats.total === "number" && stats.total > 0) ? stats.total : uniqueUsers;
    const showPeerStats = totalVotes >= peerThreshold;
    
    // Update each option's percentage
    const container = document.getElementById("qbank-options-container");
    if (!container) return;
    
    const labels = container.querySelectorAll(".qbank-option-btn");
    labels.forEach((label, i) => {
      // Remove existing percentage
      const existingPercent = label.querySelector(".peer-percent");
      if (existingPercent) existingPercent.remove();
      
      let peerPercent = '';
      
      // Calculate percentages based on vote totals
      if (stats && (stats.userCounts || stats.counts)) {
        const counts = stats.userCounts || stats.counts;
        const totalUsers = totalVotes;
        const count = counts[i] || 0;
        const pct = totalUsers > 0 ? Math.round((count / totalUsers) * 100) : 0;
        
        if (showPeerStats) {
          // Threshold met - show percentages
          peerPercent = `<span class="peer-percent" style="font-size:11px; color:#6b7280; margin-left:8px; font-weight:600;">${pct}%</span>`;
        } else if (isAdmin) {
          // Admin sees pending status
          peerPercent = `<span class="peer-percent" style="font-size:10px; color:#9ca3af; margin-left:8px;">Pending (${totalVotes}/${peerThreshold})</span>`;
        }
      }
      
      if (peerPercent) {
        label.insertAdjacentHTML('beforeend', peerPercent);
      }
    });
  };

  // Peer votes: IndexedDB outbox + batched server flush.
  // Answering used to write questionStats immediately (1w + 1r per answer).
  // Now the vote queues in IDB (survives tab close, first vote per question
  // wins) and flushes in batches of ≤50 via batch_log_peer_votes — blind
  // increments in ONE commit, 0 reads, ~10x fewer write requests.
  // KILL SWITCH — peer stats fully disabled for now (0 reads + 0 writes).
  // Re-enable by setting true (server batch endpoint no-ops too, so even
  // stale cached clients can't write while this is false).
  const PEER_STATS_ENABLED = false;
  const PEER_OUTBOX_KEY = "peer_votes_outbox:v1";
  const PEER_FLUSH_AT = 10;
  const PEER_MAX_OUTBOX = 500;
  let peerFlushInflight = null;

  async function peerOutboxGet() {
    try {
      const v = await idbKvGet(PEER_OUTBOX_KEY);
      return Array.isArray(v) ? v : [];
    } catch (_) { return []; }
  }
  async function peerOutboxSet(votes) {
    try { await idbKvSet(PEER_OUTBOX_KEY, votes); } catch (_) {}
  }
  async function peerEnqueue(questionId, selectedIndex) {
    try {
      const votes = await peerOutboxGet();
      if (votes.some(v => v && v.qid === questionId)) return votes;
      votes.push({ qid: questionId, idx: selectedIndex, ts: Date.now() });
      while (votes.length > PEER_MAX_OUTBOX) votes.shift();
      await peerOutboxSet(votes);
      return votes;
    } catch (_) { return []; }
  }
  async function peerSendBatch(batch) {
    try {
      const u = window.firebase && firebase.auth().currentUser;
      if (!u) return false;
      const token = await u.getIdToken();
      if (!token) return false;
      const headers = { "Content-Type": "application/json", Authorization: "Bearer " + token };
      try {
        if (window.getAppCheckToken) {
          const ac = await window.getAppCheckToken();
          if (ac) headers["X-Firebase-AppCheck"] = ac;
        }
      } catch (_) {}
      const res = await fetch("/api/qbank", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "batch_log_peer_votes",
          votes: batch.map(v => ({ questionId: v.qid, selectedIndex: v.idx }))
        }),
        keepalive: true
      });
      return res.ok;
    } catch (_) { return false; }
  }
  async function flushPeerVotes() {
    if (peerFlushInflight) return peerFlushInflight;
    peerFlushInflight = (async () => {
      try {
        for (let i = 0; i < 10; i++) {
          const votes = await peerOutboxGet();
          if (!votes.length) break;
          const batch = votes.slice(0, 50);
          const ok = await peerSendBatch(batch);
          if (!ok) break; // stay queued, retry on next trigger
          const fresh = await peerOutboxGet();
          // Append-only queue: drop exactly the flushed head.
          await peerOutboxSet(fresh.slice(batch.length));
          if ((await peerOutboxGet()).length === 0) break;
        }
      } catch (_) {}
    })();
    try { await peerFlushInflight; }
    finally { peerFlushInflight = null; }
  }
  window.flushPeerVotes = flushPeerVotes;
  // "Already counted" record (per device): the public stats endpoint no
  // longer returns the users map (uids of strangers stay private), so the
  // client tracks its own voted questions in IDB instead of re-reading.
  const PEER_VOTED_MAX = 5000;
  const peerVotedKey = (uidKey) => "peer_voted:v1:" + uidKey;
  async function peerHasVoted(uidKey, questionId) {
    try {
      const v = await idbKvGet(peerVotedKey(uidKey));
      return Array.isArray(v) && v.indexOf(questionId) !== -1;
    } catch (_) { return false; }
  }
  async function peerMarkVoted(uidKey, questionId) {
    try {
      let v = await idbKvGet(peerVotedKey(uidKey));
      if (!Array.isArray(v)) v = [];
      if (v.indexOf(questionId) === -1) {
        v.push(questionId);
        while (v.length > PEER_VOTED_MAX) v.shift();
        await idbKvSet(peerVotedKey(uidKey), v);
      }
    } catch (_) {}
  }
  // Periodic drain (once) + unload drain with keepalive below.
  if (!window.__peerFlushTimer) {
    window.__peerFlushTimer = true;
    try { setInterval(() => { flushPeerVotes(); }, 60_000); } catch (_) {}
  }

  // Log answer to global peer statistics (unique users only).
  // Deduped per session + outbox + users-map precheck: re-renders, revisits
  // and repeat sessions never queue (or write) twice. Percentages update
  // instantly from the optimistic cache patch (0 reads); persistence rides
  // the next batch flush.
  function _logPeerAnswer(questionId, selectedIndex) {
    if (!PEER_STATS_ENABLED) return; // disabled: no queue, no write
    try {
      if (!window.__peerLogged) window.__peerLogged = {};
      if (window.__peerLogged[questionId]) return;
      window.__peerLogged[questionId] = true;
      const currentUser = window.firebase && firebase.auth && firebase.auth().currentUser;
      const userId = currentUser ? currentUser.uid : null;
      const uidKey = userId || "anon";
      // Already counted on this device? (IDB voted-set replaces the old
      // server users-map check — the public endpoint never sends uids.)
      peerHasVoted(uidKey, questionId).then(async (voted) => {
        try {
          if (voted) return;
          // Optimistic patch so the post-answer UI refresh needs ZERO reads.
          // Also refreshes the IDB day entry so reloads keep showing own vote.
          const cached = window.qbankPeerStats && window.qbankPeerStats[questionId];
          try {
            if (!window.qbankPeerStats) window.qbankPeerStats = {};
            if (!window.__peerStatsTime) window.__peerStatsTime = {};
            const base = cached || {};
            const users = { ...(base.users || {}) };
            const userCounts = { ...(base.userCounts || {}) };
            if (userId) users[userId] = true;
            userCounts[selectedIndex] = (userCounts[selectedIndex] || 0) + 1;
            const prevTotal = typeof base.total === "number" ? base.total : Object.keys(users).length;
            const patched = { ...base, users, userCounts, total: prevTotal + 1 };
            window.qbankPeerStats[questionId] = patched;
            window.__peerStatsTime[questionId] = Date.now();
            try { idbKvSet(peerDayKey(questionId), { data: patched, day: peerDayStamp(0) }); } catch (_) {}
          } catch (_) {}
          await peerMarkVoted(uidKey, questionId);
          const votes = await peerEnqueue(questionId, selectedIndex);
          if (votes.length >= PEER_FLUSH_AT) flushPeerVotes();
        } catch (_) {}
      });
    } catch (e) {
      console.warn('Error logging peer answer:', e);
    }
  }

  // Load peer stats threshold from server (public endpoint).
  // Forever-cached in IDB (admin setting, changes rarely) + 5-min memory:
  // repeat dashboard opens and question renders cost zero blocking fetches
  // / zero Firestore reads. IDB seed renders instantly; background
  // revalidation (at most once per hour) keeps it fresh without ever
  // blocking the UI.
  window._loadPeerThreshold = function() {
    try {
      const now = Date.now();
      if (window.qbankPeerThreshold && window.__peerThresholdTime &&
          now - window.__peerThresholdTime < 5 * 60_000) {
        return Promise.resolve(window.qbankPeerThreshold);
      }
      if (window.__peerThresholdPromise) return window.__peerThresholdPromise;
      const persistThreshold = (n) => {
        window.qbankPeerThreshold = n;
        window.__peerThresholdTime = Date.now();
        try {
          idbKvSet(KV_KEYS.PEER_THRESHOLD, { threshold: n, at: Date.now() });
          localStorage.setItem("omnote_peer_threshold", String(n));
          localStorage.setItem("omnote_peer_threshold_at", String(Date.now()));
        } catch (_) {}
      };
      const backgroundRefresh = () => {
        fetch('/api/qbank?action=get_peer_stats_threshold')
          .then(res => res.json())
          .then(data => persistThreshold(data.threshold || 50))
          .catch(() => {});
      };
      // Fast path: forever-cache seeds instantly (sync localStorage with
      // age stamp; async IDB as backup). Background refresh at most once
      // per hour — the setting changes only via explicit admin save.
      if (!window.qbankPeerThreshold) {
        let seedAt = 0;
        try {
          const ls = parseInt(localStorage.getItem("omnote_peer_threshold") || "", 10);
          seedAt = parseInt(localStorage.getItem("omnote_peer_threshold_at") || "0", 10) || 0;
          if (ls >= 1 && !window.qbankPeerThreshold) {
            window.qbankPeerThreshold = ls;
            window.__peerThresholdTime = Date.now();
          }
        } catch (_) {}
        idbKvGet(KV_KEYS.PEER_THRESHOLD).then((saved) => {
          const t = saved && (saved.threshold || saved);
          const n = typeof t === "number" ? t : parseInt(t, 10);
          if (n >= 1 && !window.qbankPeerThreshold) {
            window.qbankPeerThreshold = n;
            window.__peerThresholdTime = Date.now();
          }
        }).catch(() => {});
        if (window.qbankPeerThreshold) {
          if (!seedAt || now - seedAt > 60 * 60_000) backgroundRefresh();
          return Promise.resolve(window.qbankPeerThreshold);
        }
      }
      window.__peerThresholdPromise = fetch('/api/qbank?action=get_peer_stats_threshold')
        .then(res => res.json())
        .then(data => {
          persistThreshold(data.threshold || 50);
          console.log('[peer-stats] threshold loaded:', window.qbankPeerThreshold);
          return window.qbankPeerThreshold;
        })
        .catch(err => {
          console.warn('Failed to load peer threshold:', err);
          window.qbankPeerThreshold = window.qbankPeerThreshold || 50;
          return window.qbankPeerThreshold;
        })
        .finally(() => { window.__peerThresholdPromise = null; });
      return window.__peerThresholdPromise;
    } catch (e) {
      console.warn('Error loading peer threshold:', e);
      window.qbankPeerThreshold = window.qbankPeerThreshold || 50;
      return Promise.resolve(window.qbankPeerThreshold);
    }
  }

  // Load peer stats for a specific question.
  // Three cache layers, zero server memory (Vercel-free safe — everything
  // lives client-side):
  //   1. memory 15 min (scrolling/re-renders),
  //   2. IndexedDB day-stamped (survives reloads: at most 1 read per
  //      question every PEER_STATS_STALE_DAYS — percentages days-stale is
  //      fine, they're slow aggregates and your own vote patches instantly),
  //   3. in-flight dedupe (rapid Next/Prev never double-fires).
  // Tune PEER_STATS_STALE_DAYS up to cut reads further (7 = weekly refresh).
  const PEER_STATS_STALE_DAYS = 3;
  function peerDayKey(questionId) { return "peer_stats:v1:" + questionId; }
  function peerDayStamp(daysBack) {
    const d = new Date(Date.now() - (daysBack || 0) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  function peerDayFresh(dayStr) {
    if (!dayStr || typeof dayStr !== "string") return false;
    const cutoff = peerDayStamp(PEER_STATS_STALE_DAYS);
    return dayStr >= cutoff;
  }
  window.loadPeerStats = function(questionId, opts) {
    if (!PEER_STATS_ENABLED) return Promise.resolve(null); // disabled: 0 reads
    const force = !!(opts && opts.force);
    const now = Date.now();
    // 15-min TTL: peer percentages move slowly (and your own vote patches
    // instantly on answer), so re-reading every 2 min while scrolling was
    // pure waste. One read per question per quarter-hour, max.
    const TTL = 15 * 60_000;
    try {
      if (!force && window.qbankPeerStats && window.qbankPeerStats[questionId] &&
          window.__peerStatsTime && (now - (window.__peerStatsTime[questionId] || 0)) < TTL) {
        return Promise.resolve(window.qbankPeerStats[questionId]);
      }
      if (!window.__peerStatsInflight) window.__peerStatsInflight = {};
      if (!force && window.__peerStatsInflight[questionId]) return window.__peerStatsInflight[questionId];
      const seedFromDayCache = (data) => {
        try {
          if (!window.qbankPeerStats) window.qbankPeerStats = {};
          if (!window.__peerStatsTime) window.__peerStatsTime = {};
          window.qbankPeerStats[questionId] = data;
          window.__peerStatsTime[questionId] = Date.now();
        } catch (_) {}
      };
      const p = new Promise((resolve) => {
        const fetchFresh = () => {
        try {
          // Public CDN-shared endpoint: NO Authorization/AppCheck headers —
          // anything user-varying fragments the shared edge cache. Response
          // is anonymous aggregates ({userCounts, total}, never uids) with
          // 24h s-maxage: all users share one copy per question per day.
          fetch(`/api/peer-stats?qid=${encodeURIComponent(questionId)}`).then(r => r.json()).then(data => {
          if (data && !data.error && (data.total || data.userCounts)) {
            const clean = { userCounts: data.userCounts || {}, total: data.total || 0 };
            seedFromDayCache(clean);
            // Persist day-stamped (client IDB = free, survives reloads).
            try { idbKvSet(peerDayKey(questionId), { data: clean, day: peerDayStamp(0) }); } catch (_) {}
            resolve(clean);
          } else {
            resolve(null);
          }
        }).catch(err => {
          console.warn('Failed to load peer stats:', err);
          resolve(null);
        });
        } catch (e) {
          console.warn('Error loading peer stats:', e);
          resolve(null);
        }
        };
        if (!force) {
          idbKvGet(peerDayKey(questionId)).then((dayHit) => {
            if (dayHit && dayHit.data && peerDayFresh(dayHit.day)) {
              seedFromDayCache(dayHit.data);
              resolve(dayHit.data);
            } else {
              fetchFresh();
            }
          }).catch(() => fetchFresh());
        } else {
          fetchFresh();
        }
      });
      p.finally(() => { if (window.__peerStatsInflight) delete window.__peerStatsInflight[questionId]; });
      window.__peerStatsInflight[questionId] = p;
      return p;
    } catch (e) {
      console.warn('Error loading peer stats:', e);
      return Promise.resolve(null);
    }
  }

  // Log answer to global peer statistics
  window.logPeerAnswer = function(questionId, selectedIndex) {
    _logPeerAnswer(questionId, selectedIndex);
  }
  
  window.qbankNext = function() {
    if (currentQuestions.length === 0) return;
    
    const isParty = document.getElementById("qbank-party-sidebar")?.style.display !== "none";
    if (isParty) {
        if (!window.QBankParty || !window.QBankParty.state.isHost) {
            window.qbankToast("Only the host can advance to the next question.", true);
            return;
        }
        window.QBankParty.hostNextQuestion();
        return;
    }
    
    if (qbankTimer) {
      // User is skipping
    }
    currentIndex++;
    window.currentIndex = currentIndex;
    window.qbankRenderSidebar();
    window.qbankRenderCurrent();
  };

  window.qbankToggleMark = async function() {
    const q = currentQuestions[currentIndex];
    if (!q) return;
    const p = window.qbankProgress[q.id] || {};
    const newMarked = !p.marked;
    
    // Optimistic UI update (in-place only: do NOT re-render the question,
    // otherwise the current checkbox/radio selection, timer and revealed
    // answer would reset mid-question)
    p.marked = newMarked;
    window.qbankProgress[q.id] = p;
    try {
      let btn = null;
      if (window.event && window.event.target && window.event.target.closest) {
        btn = window.event.target.closest('button');
      }
      if (!btn) {
        const all = document.querySelectorAll('[onclick="window.qbankToggleMark()"]');
        if (all && all.length) btn = all[0];
      }
      if (btn) {
        btn.style.color = newMarked ? 'var(--accent-cyan)' : 'var(--text-secondary)';
        btn.innerHTML = `<i class="fa-solid fa-bookmark" style="font-size:12px;${newMarked ? 'color:var(--accent-cyan);' : ''}"></i> ${newMarked ? 'Marked' : 'Mark'}`;
      }
    } catch (e) {}
    window.qbankRenderSidebar();
    
    // Background save
    if (currentQBankId) {
      pushToSyncQueue({
        qbankId: currentQBankId,
        questionId: q.id,
        marked: newMarked
      });
    }
  };

  window.qbankReportQuestion = function(id) {
    if (!currentQBankId) return;
    const old = document.getElementById("qbank-report-modal");
    if (old) old.remove();

    const REASONS = [
      { key: "wrong_answer", label: "The answer is wrong", icon: "x-circle", suggest: true },
      { key: "invalid_question", label: "Question is invalid / unclear", icon: "help-circle", suggest: false },
      { key: "needs_explanation", label: "Needs a better explanation", icon: "message-square", suggest: false },
      { key: "typo", label: "Typo / formatting issue", icon: "type", suggest: false },
      { key: "other", label: "Other problem", icon: "flag", suggest: false },
    ];

    const ov = document.createElement("div");
    ov.id = "qbank-report-modal";
    ov.innerHTML = `
      <div class="rp-box">
        <div class="rp-head">
          <div>
            <div class="rp-title"><i data-lucide="flag" style="width:17px;height:17px;color:#f59e0b;"></i> Report Question</div>
            <div class="rp-sub">What is wrong with this question?</div>
          </div>
          <button type="button" class="rp-close">×</button>
        </div>

        <div class="rp-reasons">
          ${REASONS.map(r => `
            <button type="button" class="rp-reason" data-key="${r.key}" data-suggest="${r.suggest ? "1" : ""}">
              <i data-lucide="${r.icon}" style="width:15px;height:15px;"></i>
              <span>${r.label}</span>
            </button>`).join("")}
        </div>

        <div id="rp-suggest-wrap" style="display:none;">
          <label class="rp-label">Suggest the correct answer (optional)</label>
          <input id="rp-suggest-input" type="text" placeholder="e.g. The correct answer should be C because…" />
        </div>

        <div id="rp-details-wrap" style="display:none;">
          <label class="rp-label">Add details (optional)</label>
          <textarea id="rp-details-input" rows="3" placeholder="Anything else that helps us fix it…"></textarea>
        </div>

        <div class="rp-status" id="rp-status"></div>
        <div class="rp-foot">
          <button type="button" class="btn-dark-pill rp-cancel">Cancel</button>
          <button type="button" id="rp-send" class="btn-action primary" disabled>Submit Report</button>
        </div>
      </div>
      <style>${RP_CSS}</style>`;
    document.body.appendChild(ov);
    document.body.style.overflow = "hidden";
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

    let picked = null;
    const sendBtn = ov.querySelector("#rp-send");
    const statusEl = ov.querySelector("#rp-status");
    const suggestWrap = ov.querySelector("#rp-suggest-wrap");
    const detailsWrap = ov.querySelector("#rp-details-wrap");

    const close = () => { ov.remove(); document.body.style.overflow = ""; };
    ov.querySelector(".rp-close").addEventListener("click", close);
    ov.querySelector(".rp-cancel").addEventListener("click", close);
    ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
    const escHandler = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); } };
    document.addEventListener("keydown", escHandler);

    ov.querySelectorAll(".rp-reason").forEach(btn => {
      btn.addEventListener("click", () => {
        ov.querySelectorAll(".rp-reason").forEach(b => b.classList.remove("picked"));
        btn.classList.add("picked");
        picked = btn.dataset.key;
        const wantsSuggest = btn.dataset.suggest === "1";
        suggestWrap.style.display = wantsSuggest ? "block" : "none";
        // details box for everything except plain "needs explanation"
        detailsWrap.style.display = picked === "needs_explanation" ? "none" : "block";
        sendBtn.disabled = false;
      });
    });

    sendBtn.addEventListener("click", async () => {
      if (!picked) return;
      const reasonObj = {
        option: picked,
        suggestedAnswer: (ov.querySelector("#rp-suggest-input")?.value || "").trim(),
        details: (ov.querySelector("#rp-details-input")?.value || "").trim(),
      };
      sendBtn.disabled = true;
      sendBtn.textContent = "Submitting…";
      try {
        await apiPost("report_question", {
          qbankId: currentQBankId,
          questionId: id,
          reason: JSON.stringify(reasonObj),
        });
        close();
        const t = document.createElement("div");
        t.textContent = "Thank you! The question has been reported.";
        t.style.cssText = "position:fixed;bottom:20px;right:20px;padding:12px 20px;background:#0f8a5f;color:#fff;border-radius:10px;z-index:2147483647;font-family:'Figtree',sans-serif;font-size:0.9rem;box-shadow:0 6px 20px rgba(0,0,0,0.3);";
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3500);
      } catch (err) {
        statusEl.textContent = "Could not submit: " + (err.message || err);
        sendBtn.disabled = false;
        sendBtn.textContent = "Submit Report";
      }
    });
  };

  const RP_CSS = `
  #qbank-report-modal { position: fixed; inset: 0; z-index: 2147483000; background: rgba(6,25,31,0.72);
    backdrop-filter: blur(5px); display: flex; align-items: center; justify-content: center; padding: 24px;
    font-family: 'Figtree', sans-serif; }
  .rp-box { width: min(460px, 100%); max-height: 90vh; overflow-y: auto;
    background: var(--bg-elevated, #16232a); color: var(--text-primary, #fff);
    border: 1px solid rgba(245,158,11,0.28); border-radius: 18px; padding: 22px 24px;
    box-shadow: 0 40px 90px -30px rgba(4,18,22,0.85); animation: rp-in .25s cubic-bezier(.4,0,.2,1); }
  @keyframes rp-in { from { opacity:0; transform: translateY(12px) scale(.98);} to { opacity:1; transform:none;} }
  .rp-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
  .rp-title { font-family: 'Outfit', sans-serif; font-size: 1.15rem; font-weight: 800; display:flex; align-items:center; gap:8px; }
  .rp-sub { font-size: 0.85rem; color: var(--text-muted, #8fa9b4); margin-top: 4px; }
  .rp-close { background: transparent; border: none; color: var(--text-muted, #7d97a3); font-size: 26px; cursor:pointer; line-height:1; border-radius:8px; width:30px; height:30px; }
  .rp-close:hover { color: #fff; background: rgba(244,63,94,0.15); }
  .rp-reasons { display: flex; flex-direction: column; gap: 8px; margin-bottom: 6px; }
  .rp-reason { display: flex; align-items: center; gap: 10px; padding: 12px 14px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
    color: var(--text-secondary, #cfe0e6); cursor: pointer; font-family: inherit; font-size: 0.92rem; font-weight: 600;
    text-align: left; transition: all .13s ease; width: 100%; }
  .rp-reason:hover { background: rgba(255,255,255,0.08); transform: translateX(2px); }
  .rp-reason.picked { background: rgba(14,124,134,0.2); border-color: var(--accent-cyan, #2dd4bf); color: #fff; }
  .rp-reason.picked::after { content: '\\2713'; margin-left: auto; color: var(--accent-cyan, #2dd4bf); font-weight: 800; }
  .rp-label { display: block; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase;
    color: var(--accent-cyan, #2dd4bf); margin: 12px 0 6px; }
  .rp-box input, .rp-box textarea { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.12); color: var(--text-primary, #fff); padding: 11px 13px;
    border-radius: 10px; font-family: inherit; font-size: 0.92rem; resize: vertical; }
  .rp-box input:focus, .rp-box textarea:focus { outline: none; border-color: var(--accent-cyan, #2dd4bf);
    box-shadow: 0 0 0 3px rgba(14,124,134,0.16); }
  .rp-status { min-height: 18px; font-size: 0.82rem; color: #facc15; margin-top: 8px; }
  .rp-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }

  body.app-light-mode #qbank-report-modal { background: rgba(10,61,74,0.45); }
  body.app-light-mode .rp-box { background: #fff; border-color: #dbe3e7; color: #0a3d4a; }
  body.app-light-mode .rp-title { color: #0a3d4a; }
  body.app-light-mode .rp-sub { color: #6b7f88; }
  body.app-light-mode .rp-reason { background: #f4f6f8; border-color: #dbe3e7; color: #334e59; }
  body.app-light-mode .rp-reason.picked { background: #e6f4f5; border-color: #0e7c86; color: #0b6770; }
  body.app-light-mode .rp-box input, body.app-light-mode .rp-box textarea { background: #fff; border-color: #dbe3e7; color: #0a3d4a; }
  `;

  window.qbankToggleNoteUI = function() {
    const ed = document.getElementById("qbank-note-editor");
    if (ed.style.display === "none") {
      ed.style.display = "block";
      const q = currentQuestions[currentIndex];
      const p = window.qbankProgress[q.id] || {};
      const inp = document.getElementById("qbank-note-input");
      inp.value = p.note || "";
      inp.focus();
    } else {
      ed.style.display = "none";
    }
  };

  window.qbankToggleHighlighter = function() {
      window.qbankHighlighterActive = !window.qbankHighlighterActive;
      const btn = document.getElementById("qbank-highlighter-btn");
      if (window.qbankHighlighterActive) {
          btn.style.color = "var(--accent-cyan)";
          btn.innerHTML = '<i data-lucide="highlighter" style="width:14px;height:14px;stroke:var(--accent-cyan);"></i> Highlighter';
      } else {
          btn.style.color = "var(--text-secondary)";
          btn.innerHTML = '<i data-lucide="highlighter" style="width:14px;height:14px;"></i> Highlighter';
      }
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.qbankHandleSelection = function(e) {
      if (!window.qbankHighlighterActive) return;
      
      if (e && e.target && e.target.classList.contains("qbank-highlighted-text")) {
          const span = e.target;
          const parent = span.parentNode;
          while(span.firstChild) parent.insertBefore(span.firstChild, span);
          parent.removeChild(span);
          if (currentQuestions[currentIndex]) {
              currentQuestions[currentIndex].highlightedHTML = document.getElementById("qbank-question-content").innerHTML;
          }
          return;
      }

      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) return;
      
      // Ensure selection is inside the question content to prevent highlighting the whole page
      const container = document.getElementById("qbank-question-content");
      if (!container || !container.contains(sel.anchorNode)) return;

      const range = sel.getRangeAt(0);
      const span = document.createElement("span");
      span.style.backgroundColor = "rgba(255, 255, 0, 0.4)";
      span.style.color = "inherit";
      span.style.borderRadius = "3px";
      span.className = "qbank-highlighted-text";
      span.style.cursor = "pointer";
      span.title = "Click to remove highlight";
      
      try {
          range.surroundContents(span);
          if (currentQuestions[currentIndex]) {
              currentQuestions[currentIndex].highlightedHTML = document.getElementById("qbank-question-content").innerHTML;
          }
      } catch (err) {
          console.warn("Cannot highlight across multiple HTML elements.");
      }
      sel.removeAllRanges();
  };

  window.qbankSaveNote = async function() {
    const q = currentQuestions[currentIndex];
    if (!q) return;
    const inp = document.getElementById("qbank-note-input");
    const newNote = inp.value.trim();
    
    const p = window.qbankProgress[q.id] || {};
    p.note = newNote;
    window.qbankProgress[q.id] = p;
    window.qbankRenderCurrent();
    
    if (currentQBankId) {
      pushToSyncQueue({
        qbankId: currentQBankId,
        questionId: q.id,
        note: newNote
      });
    }
  };

  window.qbankToggleChat = function() {
    const container = document.getElementById("qbank-ai-chat-container");
    if (container.style.display === "none") {
      container.style.display = "block";
      document.getElementById("qbank-ai-chat-input").focus();
    } else {
      container.style.display = "none";
    }
  };

  window.qbankSendChat = async function() {
    const input = document.getElementById("qbank-ai-chat-input");
    const val = input.value.trim();
    if (!val) return;
    
    const history = document.getElementById("qbank-ai-chat-history");
    const q = currentQuestions[currentIndex];
    const data = q.data || {};
    
    const userMsg = document.createElement("div");
    userMsg.style.alignSelf = "flex-end";
    userMsg.style.background = "var(--accent-cyan)";
    userMsg.style.color = "#fff";
    userMsg.style.padding = "8px 12px";
    userMsg.style.borderRadius = "12px 12px 0 12px";
    userMsg.style.maxWidth = "85%";
    userMsg.textContent = val;
    history.appendChild(userMsg);
    
    input.value = "";
    input.disabled = true;
    const sendBtn = document.getElementById("qbank-ai-chat-send");
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<i data-lucide="loader" class="spin" style="width:18px;height:18px;"></i>';
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    
    history.scrollTop = history.scrollHeight;
    
    try {
      const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
      const correctLetters = correctIndices.map(i => String.fromCharCode(65+i)).join(", ");
      const selectedLetters = currentSelectedIndices.map(i => String.fromCharCode(65+i)).join(", ");
      
      const qContext = `Question:\n${q.text || ""}\n\nOptions:\n${(data.options || []).map((o,i) => String.fromCharCode(65+i) + ". " + o).join("\n")}\n\nCorrect Answer(s): ${correctLetters}\nUser Selected Answer(s): ${selectedLetters}\n\nExplanation given:\n${data.explanation || ""}`;
      
      const res = await apiPost("chat_question", {
        questionContext: qContext,
        userMessage: val,
        lang: (window.qbankAiLang && window.qbankAiLang()) || "auto"
      });
      
      const aiMsg = document.createElement("div");
      aiMsg.style.alignSelf = "flex-start";
      aiMsg.style.background = "var(--bg-card, rgba(128,128,128,0.15))";
      aiMsg.style.color = "var(--text-primary)";
      aiMsg.style.padding = "8px 12px";
      aiMsg.style.borderRadius = "12px 12px 12px 0";
      aiMsg.style.maxWidth = "85%";
      
      if (window.marked && window.marked.parse) {
         aiMsg.innerHTML = window.marked.parse(res.response);
      } else {
         aiMsg.textContent = res.response;
      }
      history.appendChild(aiMsg);
    } catch (e) {
      const errMsg = document.createElement("div");
      errMsg.style.color = "var(--danger)";
      errMsg.textContent = "Error: " + e.message;
      history.appendChild(errMsg);
    }
    
    input.disabled = false;
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
    history.scrollTop = history.scrollHeight;
    input.focus();
  };

  window.pendingRenames = window.pendingRenames || [];

  window.qbankAdminDeleteSubject = async function(subject) {
    const activeQBankId = window.db && window.db.selectedQBankId;
    if (!activeQBankId) return;
    if (!confirm(`Are you sure you want to delete the entire subject "${subject}"? This action cannot be undone and will delete all questions within it.`)) return;

    let btn = null;
    try { btn = window.event ? window.event.target.closest('button') : null; } catch(e) {}
    if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width:12px;height:12px;margin-right:4px;"></i>Deleting...'; if (window.lucide) window.lucide.createIcons(); }

    const questionsToUse = (cachedQBanks[activeQBankId] && cachedQBanks[activeQBankId].questions) || [];
    const questionIds = questionsToUse.filter(q => q.data && q.data.subject === subject).map(q => q.id);

    if (questionIds.length === 0) {
      alert("No questions found for this subject.");
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="trash-2" style="width:12px;height:12px;margin-right:4px;"></i>Delete'; if (window.lucide) window.lucide.createIcons(); }
      return;
    }

    try {
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      const res = await fetch(`/api/admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "delete_multiple_qbank_questions", qbankId: activeQBankId, questionIds })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete questions");
      
      alert(`Successfully deleted ${questionIds.length} questions in subject "${subject}".`);
      
      // Purge ALL caches so refreshing doesn't restore stale data
      if (cachedQBanks[activeQBankId] && cachedQBanks[activeQBankId].questions) {
          cachedQBanks[activeQBankId].questions = cachedQBanks[activeQBankId].questions.filter(q => !questionIds.includes(q.id));
      }
      delete cachedQBanks[activeQBankId];  // force full re-fetch
      preloadPromise = null;                // reset category list cache
      cachedCategories = null;
      window.__qbanksMaxUpdatedAt = 0;      // reset publish-timestamp stamp
      
      // Clear IndexedDB cache for this qbank
      try {
        const db = await openQBankDB();
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(activeQBankId);
      } catch(e) {}
      
      window.openQBank(activeQBankId);
      setTimeout(window.showQBankSubjects, 200);
    } catch (e) {
      alert("Error: " + e.message);
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="trash-2" style="width:12px;height:12px;margin-right:4px;"></i>Delete'; if (window.lucide) window.lucide.createIcons(); }
    }
  };

  window.qbankAdminRenameSubject = function(oldSubject) {
    const activeQBankId = window.db && window.db.selectedQBankId;
    if (!activeQBankId) return;
    const newSubject = prompt(`Rename or move questions in subject "${oldSubject}" to:`, oldSubject);
    if (!newSubject || newSubject === oldSubject) return;
    
    window.pendingRenames.push({ type: 'subject', oldSubject, newSubject });
    window.renderPendingRenames();
  };

  window.qbankAdminRenameChapter = function(subject, oldChapter) {
    const activeQBankId = window.db && window.db.selectedQBankId;
    if (!activeQBankId) return;
    const newChapter = prompt(`Rename or move chapter "${oldChapter}" in subject "${subject}" to:`, oldChapter);
    if (!newChapter || newChapter === oldChapter) return;
    
    window.pendingRenames.push({ type: 'chapter', subject, oldChapter, newChapter });
    window.renderPendingRenames();
  };

  window.qbankAdminMoveSubject = function(oldSubject) {
    const activeQBankId = window.db && window.db.selectedQBankId;
    if (!activeQBankId) return;
    
    const existingSubjects = Object.keys(window.qbankCurrentSubjectStats || {}).filter(s => s !== oldSubject).sort((a,b) => a.localeCompare(b));
    if (existingSubjects.length === 0) {
      alert("No other subjects available to merge into.");
      return;
    }

    const modal = document.createElement('div');
    modal.style.cssText = "position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(4px);";
    
    const content = document.createElement('div');
    content.style.cssText = "background:var(--bg-card, #1e293b); padding:24px; border-radius:12px; width:400px; max-width:90%; box-shadow:0 10px 40px rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.1); color:var(--text-primary);";
    
    content.innerHTML = `
      <h3 style="margin-top:0; font-family:var(--font-heading);">Merge Subject</h3>
      <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:16px;">Select an existing subject to merge all questions from <b>${window.escapeHtml(oldSubject)}</b> into:</p>
    `;
    
    const select = document.createElement('select');
    select.style.cssText = "width:100%; padding:10px; margin-bottom:20px; border-radius:6px; background:var(--bg-elevated, #0f172a); color:var(--text-primary); border:1px solid rgba(255,255,255,0.2); font-size:0.95rem; outline:none;";
    existingSubjects.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      select.appendChild(opt);
    });
    content.appendChild(select);
    
    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = "display:flex; justify-content:flex-end; gap:12px;";
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = "btn-action secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => modal.remove();
    
    const moveBtn = document.createElement('button');
    moveBtn.className = "btn-action primary";
    moveBtn.textContent = "Merge";
    moveBtn.onclick = () => {
      const newSub = select.value;
      window.pendingRenames.push({ type: 'subject', oldSubject, newSubject: newSub });
      window.renderPendingRenames();
      modal.remove();
    };
    
    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(moveBtn);
    content.appendChild(btnContainer);
    modal.appendChild(content);
    document.body.appendChild(modal);
  };

  window.qbankAdminMoveChapter = function(subject, oldChapter) {
    const activeQBankId = window.db && window.db.selectedQBankId;
    if (!activeQBankId) return;
    
    const stats = window.qbankCurrentSubjectStats[subject];
    if (!stats || !stats.chapters) return;

    const existingChapters = Object.keys(stats.chapters).filter(c => c !== oldChapter).sort((a,b) => a.localeCompare(b));
    if (existingChapters.length === 0) {
      alert("No other chapters available in this subject to merge into.");
      return;
    }

    const modal = document.createElement('div');
    modal.style.cssText = "position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(4px);";
    
    const content = document.createElement('div');
    content.style.cssText = "background:var(--bg-card, #1e293b); padding:24px; border-radius:12px; width:400px; max-width:90%; box-shadow:0 10px 40px rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.1); color:var(--text-primary);";
    
    content.innerHTML = `
      <h3 style="margin-top:0; font-family:var(--font-heading);">Merge Chapter</h3>
      <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:16px;">Select an existing chapter to merge all questions from <b>${window.escapeHtml(oldChapter)}</b> into:</p>
    `;
    
    const select = document.createElement('select');
    select.style.cssText = "width:100%; padding:10px; margin-bottom:20px; border-radius:6px; background:var(--bg-elevated, #0f172a); color:var(--text-primary); border:1px solid rgba(255,255,255,0.2); font-size:0.95rem; outline:none;";
    existingChapters.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      select.appendChild(opt);
    });
    content.appendChild(select);
    
    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = "display:flex; justify-content:flex-end; gap:12px;";
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = "btn-action secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => modal.remove();
    
    const moveBtn = document.createElement('button');
    moveBtn.className = "btn-action primary";
    moveBtn.textContent = "Merge";
    moveBtn.onclick = () => {
      const newChap = select.value;
      window.pendingRenames.push({ type: 'chapter', subject, oldChapter, newChapter: newChap });
      window.renderPendingRenames();
      modal.remove();
    };
    
    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(moveBtn);
    content.appendChild(btnContainer);
    modal.appendChild(content);
    document.body.appendChild(modal);
  };

  window.removePendingRename = function(index) {
    window.pendingRenames.splice(index, 1);
    window.renderPendingRenames();
  };

  window.applyPendingRenames = async function() {
    const activeQBankId = window.db && window.db.selectedQBankId;
    if (!activeQBankId || window.pendingRenames.length === 0) return;
    if (!confirm(`Are you sure you want to apply ${window.pendingRenames.length} renames to this QBank?`)) return;

    const btn = document.getElementById("admin-apply-renames-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Applying..."; }

    try {
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      const res = await fetch(`/api/admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "batch_rename_qbank_categories", qbankId: activeQBankId, renames: window.pendingRenames })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to apply renames");
      
      // Update local state
      const questionsToUse = (cachedQBanks[activeQBankId] && cachedQBanks[activeQBankId].questions) || [];
      questionsToUse.forEach(q => {
        if (!q.data) return;
        window.pendingRenames.forEach(r => {
          if (r.type === 'subject' && q.data.subject === r.oldSubject) {
            q.data.subject = r.newSubject;
          }
          if (r.type === 'chapter' && q.data.subject === r.subject && q.data.chapter === r.oldChapter) {
            q.data.chapter = r.newChapter;
          }
        });
      });

      alert(`Successfully applied ${window.pendingRenames.length} renames. Updated ${data.updatedCount || 0} questions.`);
      window.pendingRenames = [];
      window.renderPendingRenames();
      
      // Clear all caches so next load fetches fresh renamed chunks
      delete cachedQBanks[activeQBankId];
      preloadPromise = null;
      cachedCategories = null;
      window.__qbanksMaxUpdatedAt = 0; // reset publish-timestamp stamp
      try {
        const db = await openQBankDB();
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(activeQBankId);
      } catch(e) {}
      
      // Full recompute / reload
      window.openQBank(activeQBankId);
      setTimeout(window.showQBankSubjects, 200);
    } catch (e) {
      alert("Error: " + e.message);
      if (btn) { btn.disabled = false; btn.textContent = "Apply All Renames"; }
    }
  };

  window.isPendingRenamesMinimized = false;
  window.togglePendingRenamesMinimize = function() {
    window.isPendingRenamesMinimized = !window.isPendingRenamesMinimized;
    window.renderPendingRenames();
  };

  window.renderPendingRenames = function() {
    let container = document.getElementById("admin-pending-renames-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "admin-pending-renames-container";
      container.style.position = "fixed";
      container.style.bottom = "20px";
      container.style.right = "20px";
      container.style.width = "320px";
      container.style.backgroundColor = "var(--bg-elevated)";
      container.style.border = "1px solid rgba(255,255,255,0.1)";
      container.style.borderRadius = "12px";
      container.style.boxShadow = "0 8px 32px rgba(0,0,0,0.5)";
      container.style.zIndex = "9999";
      container.style.display = "none";
      container.style.flexDirection = "column";
      document.body.appendChild(container);
    }

    if (window.pendingRenames.length === 0) {
      container.style.display = "none";
      return;
    }

    container.style.display = "flex";
    
    let html = `
      <div style="padding:12px 16px; border-bottom:1px solid rgba(255,255,255,0.05); font-weight:bold; color:var(--text-primary); display:flex; justify-content:space-between; align-items:center;">
        <span style="cursor:pointer; display:flex; align-items:center; gap:6px; user-select:none;" onclick="window.togglePendingRenamesMinimize()" title="Click to minimize/expand">
          <i data-lucide="${window.isPendingRenamesMinimized ? 'chevron-up' : 'chevron-down'}" style="width:18px;height:18px;color:var(--text-muted);"></i>
          Bulk Rename Queue (${window.pendingRenames.length})
        </span>
        <button onclick="window.pendingRenames=[]; window.renderPendingRenames();" style="background:transparent; border:none; color:var(--danger); cursor:pointer; font-size:0.8rem;">Clear</button>
      </div>
      <div style="display: ${window.isPendingRenamesMinimized ? 'none' : 'block'};">
        <div style="max-height:300px; overflow-y:auto; padding:12px 16px; display:flex; flex-direction:column; gap:8px;">
    `;

    window.pendingRenames.forEach((r, i) => {
      let desc = r.type === 'subject' 
        ? `<span style="color:var(--text-muted)">Sub:</span> ${window.escapeHtml(r.oldSubject)} &rarr; <span style="color:#38bdf8">${window.escapeHtml(r.newSubject)}</span>`
        : `<span style="color:var(--text-muted)">Chap:</span> ${window.escapeHtml(r.oldChapter)} &rarr; <span style="color:#38bdf8">${window.escapeHtml(r.newChapter)}</span>`;
      html += `
        <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:8px 12px; border-radius:6px; font-size:0.85rem;">
          <div>${desc}</div>
          <button onclick="window.removePendingRename(${i})" style="background:transparent; border:none; color:var(--text-muted); cursor:pointer;"><i data-lucide="x" style="width:14px;height:14px;"></i></button>
        </div>
      `;
    });

    html += `
        </div>
        <div style="padding:12px 16px; border-top:1px solid rgba(255,255,255,0.05);">
          <button id="admin-apply-renames-btn" class="btn-action primary" style="width:100%; font-weight:bold;" onclick="window.applyPendingRenames()">Apply All Renames</button>
        </div>
      </div>
    `;

    container.innerHTML = html;
    if (window.lucide) window.lucide.createIcons();
  };

  window.qbankAdminDelete = async function(questionId) {
    if (!confirm("Are you sure you want to delete this question for everyone?")) return;
    try {
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      const res = await fetch(`/api/admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "delete_qbank_question", qbankId: currentQBankId, questionId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete");
      
      // Remove locally
      allQuestions = allQuestions.filter(q => q.id !== questionId);
      currentQuestions = currentQuestions.filter(q => q.id !== questionId);
      if (currentIndex >= currentQuestions.length) currentIndex = Math.max(0, currentQuestions.length - 1);
      window.qbankRenderCurrent();
      alert("Question deleted successfully.");
    } catch (e) {
      alert("Delete failed: " + e.message);
    }
  };

  window.qbankAdminEdit = function(questionId) {
    const q = allQuestions.find(q => q.id === questionId);
    if (!q || !currentQBankId) return;
    // Reuse the same rich editor as the admin panel
    window.openRichQuestionEditor({
      qbankId: currentQBankId,
      questionId,
      questionText: q.text,
      data: q.data || {},
      onSave: async (payload) => {
        const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
        const res = await fetch(`/api/admin`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "update_qbank_question", qbankId: currentQBankId, questionId, ...payload })
        });
        const resp = await res.json();
        if (!res.ok) throw new Error(resp.error || "Failed to save");

        // Update local state so the change shows instantly
        q.text = payload.questionText;
        try {
          const newData = JSON.parse(payload.dataJson);
          delete newData.questionText;
          q.data = newData;
        } catch (e) {}
        q.highlightedHTML = null; // Clear highlight cache
        window.qbankRenderCurrent();
        alert("Question updated successfully.");
      }
    });
  };

  window.generateAIFlashcard = async function(questionId) {
    const q = allQuestions.find(q => q.id === questionId);
    if (!q) return;

    let modal = document.getElementById("qbank-ai-flashcard-modal");
    if (!modal) {
      modal = document.createElement("dialog");
      modal.id = "qbank-ai-flashcard-modal";
      modal.style.cssText = "padding:0; border:none; background:transparent; max-width:600px; width:100%; outline:none;";
      const style = document.createElement("style");
      style.innerHTML = `
        #qbank-ai-flashcard-modal::backdrop { background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px); }
        @keyframes qbspin { 100% { transform: rotate(360deg); } }
      `;
      document.head.appendChild(style);
      document.body.appendChild(modal);
    }
    
    modal.innerHTML = `
      <div class="bg-surface-container-high text-on-surface rounded-2xl p-6 md:p-8 relative shadow-2xl border border-outline-variant/30 w-full animate-[fade-in_0.3s_ease-out]">
        <button onclick="document.getElementById('qbank-ai-flashcard-modal').close()" class="absolute top-4 right-4 p-2 rounded-full hover:bg-surface-container-highest text-on-surface-variant transition-colors cursor-pointer">
          <i data-lucide="x" style="width:20px;height:20px;"></i>
        </button>
        <h3 class="font-title-lg text-[22px] font-bold mb-6 flex items-center gap-2">
          <i data-lucide="brain" class="text-primary" style="width:24px; height:24px;"></i> AI Concept Flashcard
        </h3>
        <div id="ai-flashcard-content" class="min-h-[120px] flex justify-center items-center flex-col gap-4">
          <div style="width:36px; height:36px; border:3px solid rgba(128,128,128,0.2); border-top-color:var(--primary); border-radius:50%; animation:qbspin 1s linear infinite;"></div>
          <span class="text-on-surface-variant text-sm" id="qbank-fc-loading-text">Extracting core concepts...</span>
        </div>
      </div>
    `;
    modal.showModal();
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

    const data = q.data || {};
    let optionsText = "";
    if (data.options && Array.isArray(data.options)) {
      optionsText = data.options.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt}`).join("\\n");
    }
    const explanation = data.explanation || "No explanation provided.";
    
    let correctAns = "Unknown";
    const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
    if (correctIndices.length > 0 && data.options) {
       correctAns = correctIndices.map(i => `${String.fromCharCode(65 + i)}. ${data.options[i]}`).join(", ");
    }
    
    const questionText = `${q.text}\\n\\n${optionsText}`;

    try {
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          task: "qbank_flashcard_from_question",
          vars: { question: questionText, answer: correctAns, explanation: explanation }
        })
      });
      
      const resData = await res.json();
      if (!res.ok) throw new Error(resData.error || resData.message || "AI failed to generate flashcard.");
      
      let parsedContent;
      try {
        parsedContent = JSON.parse(resData.content);
      } catch(e) {
        throw new Error("AI returned malformed data.");
      }
      
      const fFront = parsedContent.flashcardFront || parsedContent.flashcard_front || parsedContent.front || "";
      const fBack = parsedContent.flashcardBack || parsedContent.flashcard_back || parsedContent.back || "";
      const fConcepts = parsedContent.conceptBreakdown || parsedContent.concept_breakdown || parsedContent.concepts || "No breakdown provided.";
      
      if (!fFront && !fConcepts) {
         throw new Error("AI returned an empty response. Please try again.");
      }
      
      // Store globally so the save button can access it (legacy)
      window.__currentAIFlashcard = {
        questionId: questionId,
        qbankId: window.currentQBankId,
        front: fFront,
        back: fBack,
        concepts: fConcepts
      };

      // Auto-save it to main flashcards db!
      if (window.db && window.db.rems) {
         window.db.rems.push({
           id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
           type: "flashcard",
           isFlashcard: true,
           cardType: "basic",
           front: fFront,
           back: fBack,
           explanation: fConcepts,
           docId: "qbank",
           qbankId: window.currentQBankId,
           subject: q.data.subject || "Uncategorized",
           topic: q.data.subject ? `QBank: ${q.data.subject}` : "QBank Auto-Flashcard",
           text: fFront + " == " + fBack,
           nextReviewAt: new Date().toISOString(),
           interval: 0,
           repetition: 0,
           ease: 2.5
         });
         if (typeof window.saveDb === 'function') window.saveDb();
         if (typeof window.updateSRSQueue === 'function') window.updateSRSQueue();
      }

      document.getElementById("ai-flashcard-content").innerHTML = `
        <div class="w-full bg-surface-container-highest rounded-xl p-6 mb-6 text-center border border-outline-variant/30 shadow-inner">
           <p class="text-lg font-semibold mb-4 leading-relaxed">${fFront}</p>
           ${fBack ? `<hr class="border-outline-variant/30 my-4"><p class="text-md text-on-surface-variant leading-relaxed">${fBack}</p>` : ""}
        </div>
        <div class="w-full text-left bg-primary/5 p-5 rounded-xl border border-primary/10 mb-6">
           <h4 class="text-sm font-bold text-primary uppercase mb-3 tracking-wide flex items-center gap-2">
             <i data-lucide="lightbulb" style="width:16px;height:16px;"></i> Key Concepts
           </h4>
           <div class="text-sm text-on-surface-variant leading-relaxed ai-concept-breakdown">
             ${fConcepts}
           </div>
        </div>
        <div class="flex justify-end gap-3 w-full items-center">
           <div class="text-sm text-green-500 font-medium flex items-center gap-1 mr-auto">
             <i data-lucide="check-circle-2" style="width:16px;height:16px;"></i> Auto-saved to Flashcards tab
           </div>
           <button class="btn-action secondary px-4 py-2 rounded-full font-medium" onclick="document.getElementById('qbank-ai-flashcard-modal').close()">Close</button>
        </div>
      `;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    } catch(err) {
      document.getElementById("ai-flashcard-content").innerHTML = `
        <div class="w-full bg-red-500/10 text-red-500 p-6 text-center rounded-xl border border-red-500/20">
          <i data-lucide="alert-triangle" style="width:24px;height:24px;margin:0 auto 8px;"></i>
          <br>${err.message}
        </div>
        <div class="flex justify-end gap-3 w-full mt-6">
           <button class="btn-action secondary px-4 py-2 rounded-full" onclick="document.getElementById('qbank-ai-flashcard-modal').close()">Close</button>
        </div>
      `;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    }
  };

  window.closeStudyConcept = function() {
    const rightCol = document.getElementById("qbank-right-col");
    if (rightCol) rightCol.style.display = "none";
  };

  // Language for AI-generated QBank content (study concepts, tutor chat).
  // Explicit site language when the student chose one; otherwise "auto" so
  // the model matches the question's own language instead of defaulting
  // to English.
  window.qbankAiLang = function() {
    try {
      if (window.db && window.db.settings && window.db.settings.siteLanguage) {
        return String(window.db.settings.siteLanguage).slice(0, 8);
      }
    } catch (_) {}
    try {
      const keys = ["omnote_site_language", "omnote_lang"];
      for (const k of keys) {
        const v = localStorage.getItem(k);
        if (v && /^[a-zA-Z-]{2,8}$/.test(v)) return v.slice(0, 8);
      }
    } catch (_) {}
    return "auto";
  };

  // Whether a cached study concept (tagged with its generation language)
  // is usable for the requested language. Untagged legacy concepts were
  // generated without any language instruction, i.e. in English.
  window.qbankConceptUsable = function(taggedLang, wantLang) {
    if (taggedLang) return taggedLang === wantLang;
    return wantLang === "en";
  };

  window.generateStudyConcept = async function(questionId) {
    const q = allQuestions.find(q => q.id === questionId);
    if (!q) return;

    const rightCol = document.getElementById("qbank-right-col");
    const contentDiv = document.getElementById("qbank-study-content");
    if (!rightCol || !contentDiv) return;
    
    rightCol.style.display = "flex";

    const conceptLang = (window.qbankAiLang && window.qbankAiLang()) || "auto";

    if (q.studyConcept && window.qbankConceptUsable(q.studyConceptLang, conceptLang)) {
      contentDiv.innerHTML = (window.marked && window.DOMPurify) ? window.DOMPurify.sanitize(window.marked.parse(q.studyConcept)) : q.studyConcept;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      return;
    }

    // Forever-cache (IDB): study concepts are immutable per question+lang.
    // Survives reloads / Vercel cold starts: 0 Firestore reads + 0 AI cost
    // on revisit. Keyed by bank+question+lang so language switches stay correct.
    try {
      const idbHit = await idbKvGet(KV_KEYS.studyConcept(currentQBankId, questionId, conceptLang));
      if (idbHit && idbHit.html && window.qbankConceptUsable(idbHit.lang, conceptLang)) {
        q.studyConcept = idbHit.html;
        q.studyConceptLang = idbHit.lang || null;
        contentDiv.innerHTML = (window.marked && window.DOMPurify) ? window.DOMPurify.sanitize(window.marked.parse(q.studyConcept)) : q.studyConcept;
        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
        return;
      }
    } catch (_) {}

    contentDiv.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:60px 20px; gap:16px;">
        <div style="width:40px; height:40px; border:3px solid rgba(128,128,128,0.2); border-top-color:var(--accent-cyan); border-radius:50%; animation:qbspin 1s linear infinite;"></div>
        <span style="color:var(--text-secondary); font-size:1rem; font-weight:500;">Extracting relevant textbook excerpt for this concept...</span>
      </div>
    `;

    try {
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      
      const getRes = await fetch(`/api/qbank?action=get_study_concept&qbankId=${encodeURIComponent(currentQBankId)}&questionId=${encodeURIComponent(questionId)}&lang=${encodeURIComponent(conceptLang)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (getRes.ok) {
        const getData = await getRes.json();
        if (getData.studyConcept && window.qbankConceptUsable(getData.studyConceptLang, conceptLang)) {
          q.studyConcept = getData.studyConcept;
          q.studyConceptLang = getData.studyConceptLang || null;
          try { idbKvSet(KV_KEYS.studyConcept(currentQBankId, questionId, conceptLang), { html: q.studyConcept, lang: q.studyConceptLang }); } catch (_) {}
          contentDiv.innerHTML = (window.marked && window.DOMPurify) ? window.DOMPurify.sanitize(window.marked.parse(q.studyConcept)) : q.studyConcept;
          if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
          return;
        }
      }

      const data = q.data || {};
      let optionsText = "";
      if (data.options && Array.isArray(data.options)) {
        optionsText = data.options.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt}`).join("\\n");
      }
      const explanation = data.explanation || "No explanation provided.";
      
      let correctAns = "Unknown";
      const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
      if (correctIndices.length > 0 && data.options) {
         correctAns = correctIndices.map(i => `${String.fromCharCode(65 + i)}. ${data.options[i]}`).join(", ");
      }
      
      const questionText = `${q.text}\\n\\n${optionsText}`;

      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          task: "qbank_study_concept",
          lang: conceptLang,
          vars: { question: questionText, answer: correctAns, explanation: explanation }
        })
      });
      
      const resData = await res.json();
      if (!res.ok) throw new Error(resData.error || resData.message || "AI failed to generate study concept.");
      
      const parsedContent = resData.content;
      if (!parsedContent) throw new Error("AI returned empty response.");
      
      q.studyConcept = parsedContent;
      q.studyConceptLang = conceptLang;
      try { idbKvSet(KV_KEYS.studyConcept(currentQBankId, questionId, conceptLang), { html: parsedContent, lang: conceptLang }); } catch (_) {}
      contentDiv.innerHTML = (window.marked && window.DOMPurify) ? window.DOMPurify.sanitize(window.marked.parse(parsedContent)) : parsedContent;

      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

      fetch("/api/qbank", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: "save_study_concept",
          qbankId: currentQBankId,
          questionId: questionId,
          studyConcept: parsedContent,
          lang: conceptLang,
          // Already in memory — lets the server maintain the concepts
          // digest with 0 extra reads.
          code: (q.data && q.data.code) || "",
          subject: (q.data && q.data.subject) || "",
          chapter: (q.data && q.data.chapter) || ""
        })
      }).catch(e => console.error("Failed to save study concept async", e));

    } catch(err) {
      contentDiv.innerHTML = `
        <div style="background:rgba(244,63,94,0.1); color:#f43f5e; padding:16px; border-radius:8px; border:1px solid rgba(244,63,94,0.2); text-align:center;">
          <i class="fa-solid fa-triangle-exclamation" style="font-size:24px; margin-bottom:8px;"></i>
          <br>${err.message}
        </div>
      `;
    }
  };

  window.saveQBankFlashcard = async function(btn) {
    const fc = window.__currentAIFlashcard;
    if (!fc) return;
    
    const originalText = btn.innerHTML;
    btn.innerHTML = `<div class="spinner" style="width:16px;height:16px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:qbspin 1s linear infinite;"></div> Saving...`;
    btn.disabled = true;

    try {
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      const res = await fetch("/api/qbank", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: "save_flashcard",
          ...fc
        })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      
      btn.innerHTML = `<i data-lucide="check" style="width:16px;height:16px;"></i> Saved!`;
      btn.classList.replace("primary", "success"); // Assuming success class exists, or just change bg
      btn.style.backgroundColor = "#10b981";
      btn.style.color = "#fff";
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      
      setTimeout(() => {
        const modal = document.getElementById('qbank-ai-flashcard-modal');
        if(modal) modal.close();
      }, 1500);
      
    } catch(err) {
      alert("Error saving flashcard: " + err.message);
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  };

  window.openPerformance = function() {
      if (window.hideAllMainViews) window.hideAllMainViews();
      
      const pv = document.getElementById("performance-view");
      if (pv) {
          pv.style.display = "flex";
      }

      // Update active nav class
      if (window.setQBankNav) window.setQBankNav('performance');

      if (window.innerWidth < 1024 && typeof window.toggleSidebar === 'function') {
          // Close mobile sidebar if needed
      }

      renderPerformanceView();
  };

  let performanceChartInstance = null;

  function renderPerformanceView() {
      const area = document.getElementById("performance-content");
      if (!area) return;

      if (!window.db || !window.db.selectedQBankId) {
          area.innerHTML = '<div class="text-center p-12 mt-12 bg-surface-container-lowest rounded-2xl shadow-sm"><p class="text-on-surface-variant">Please select a Question Bank from the Home Dashboard first to view your analytics.</p></div>';
          return;
      }

      const activeQBankId = window.db.selectedQBankId;
      const qbanks = window.db.qbanks || [];
      const activeQBankMeta = qbanks.find(qb => qb.id === activeQBankId) || qbanks[0];
      const activeQBankName = activeQBankMeta ? activeQBankMeta.name : "Your QBank";

      let totalQuestions = 0;
      let totalAnswered = 0;
      let totalCorrect = 0;
      let subjectStats = {};

      const qData = cachedQBanks[activeQBankId];
      if (qData) {
        totalQuestions = (qData.questions || []).length;
        const prog = qData.progress || {};
        for (const q of (qData.questions || [])) {
           const sub = (q.data && q.data.subject) || "Uncategorized";
           if (!subjectStats[sub]) subjectStats[sub] = { total: 0, answered: 0, correct: 0, incorrect: 0, marked: 0 };
           subjectStats[sub].total++;
           
           if (prog[q.id]) {
             if (prog[q.id].correct !== undefined) { 
               totalAnswered++; 
               subjectStats[sub].answered++;
               if (prog[q.id].correct) {
                 totalCorrect++; 
                 subjectStats[sub].correct++;
               } else {
                 subjectStats[sub].incorrect++;
               }
             }
             if (prog[q.id].marked) {
                 subjectStats[sub].marked++;
             }
           }
        }
      }

      const globalScore = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;
      
      let specialtyStats = [];
      for (const [sub, stat] of Object.entries(subjectStats)) {
          if (sub === "Uncategorized") continue;
          let specScore = stat.answered > 0 ? Math.round((stat.correct / stat.answered) * 100) : 0;
          specialtyStats.push({ name: sub, ...stat, score: specScore });
      }
      specialtyStats.sort((a, b) => b.score - a.score || b.answered - a.answered);

      let specialtyListHtml = '';
      let labels = [];
      let dataScore = [];
      
      if (specialtyStats.length > 0) {
          specialtyStats.forEach(spec => {
              labels.push(spec.name);
              dataScore.push(spec.score);
              
              const colorClass = spec.score >= 80 ? 'background:#10b981' : (spec.score >= 50 ? 'background:#007a7a' : 'background:#e11d48');
              const textClass = spec.score >= 80 ? 'color:#10b981' : (spec.score >= 50 ? 'color:#111827' : 'color:#e11d48');
              
              specialtyListHtml += `
              <div class="rounded-2xl p-6 shadow-sm flex flex-col hover:-translate-y-1 transition-transform group" style="background:#fff; border:1px solid #e2e8f0;">
                  <div class="flex items-start justify-between mb-2">
                      <div>
                          <h3 class="font-title-md text-[18px] mb-1" style="color:#111827;">${window.escapeHtml ? window.escapeHtml(spec.name) : spec.name}</h3>
                          <p class="font-label-sm" style="color:#6b7280;">${spec.answered} / ${spec.total} Answered</p>
                      </div>
                      <div class="text-right">
                          <span class="font-headline-lg" style="${textClass}">${spec.score}%</span>
                      </div>
                  </div>
                  
                  <div class="w-full rounded-full h-2 mb-4" style="background:#f8fafc;">
                    <div class="h-2 rounded-full" style="${colorClass}; width: ${spec.score}%"></div>
                  </div>

                  <div class="mt-auto pt-4 flex justify-between items-center" style="border-top:1px solid #e2e8f0;">
                      <div class="flex gap-4 text-[12px]" style="color:#6b7280;">
                          <div class="flex items-center gap-1"><span class="w-2 h-2 rounded-full" style="background:#10b981;"></span> ${spec.correct} Correct</div>
                          <div class="flex items-center gap-1"><span class="w-2 h-2 rounded-full" style="background:#e11d48;"></span> ${spec.incorrect} Incorrect</div>
                      </div>
                      <button class="px-3 py-1.5 text-[12px] font-bold uppercase rounded-lg border transition-colors flex items-center gap-1 cursor-pointer"
                          style="border-color:#e2e8f0; color:#007a7a; background:transparent;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'"
                          onclick="window.startQBankSession('${activeQBankId}', '${window.escapeHtml ? window.escapeHtml(activeQBankName).replace(/'/g, "\\'") : activeQBankName}', '${window.escapeHtml ? window.escapeHtml(spec.name).replace(/'/g, "\\'") : spec.name}', true)">
                          <span class="material-symbols-outlined text-[14px]">refresh</span> Review Incorrects
                      </button>
                  </div>
              </div>
              `;
          });
      } else {
          specialtyListHtml = '<div class="col-span-full text-center p-8 text-on-surface-variant">No specialty data available. Answer some questions to see your breakdown.</div>';
      }

      area.innerHTML = `
      <div class="animate-[fade-in_0.5s_ease-out] flex flex-col gap-6">
          <div class="flex items-end justify-between">
              <div>
                  <p class="font-label-caps tracking-[0.1em] mb-2" style="color:#007a7a;">DETAILED ANALYTICS</p>
                  <h1 class="font-headline-xl" style="color:#111827;">My Performance</h1>
              </div>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div class="rounded-2xl p-6 shadow-sm lg:col-span-1 flex flex-col justify-between" style="background:#fff; border:1px solid #e2e8f0;">
                  <div class="flex items-center justify-between mb-4">
                      <div class="flex items-center gap-2 font-bold tracking-wider text-[13px]" style="color:#007a7a;">
                           <span class="material-symbols-outlined text-[18px]">workspace_premium</span> GLOBAL ACCURACY
                      </div>
                  </div>
                  <div class="flex items-end gap-1 mb-6 mt-4">
                      <h2 class="font-headline-xl text-[64px] leading-none font-black tracking-tight" style="color:#111827;">${globalScore}<span class="text-[32px] font-medium ml-1" style="color:#6b7280;">%</span></h2>
                  </div>
                  
                  <div class="grid grid-cols-3 gap-3 w-full mt-auto">
                      <div class="rounded-xl p-3 flex flex-col justify-center transition-colors border" style="background:#f8fafc; border-color:#e2e8f0;" onmouseover="this.style.borderColor='#007a7a'" onmouseout="this.style.borderColor='#e2e8f0'">
                          <div class="text-[10px] uppercase font-bold tracking-wider mb-1" style="color:#6b7280;">Answered</div>
                          <div class="font-title-md font-bold text-[18px]" style="color:#007a7a;">${totalAnswered}</div>
                      </div>
                      <div class="rounded-xl p-3 flex flex-col justify-center transition-colors border" style="background:#f8fafc; border-color:#e2e8f0;" onmouseover="this.style.borderColor='#10b981'" onmouseout="this.style.borderColor='#e2e8f0'">
                          <div class="text-[10px] uppercase font-bold tracking-wider mb-1" style="color:#6b7280;">Correct</div>
                          <div class="font-title-md font-bold text-[18px]" style="color:#10b981;">${totalCorrect}</div>
                      </div>
                      <div class="rounded-xl p-3 flex flex-col justify-center transition-colors border" style="background:#f8fafc; border-color:#e2e8f0;" onmouseover="this.style.borderColor='#9ca3af'" onmouseout="this.style.borderColor='#e2e8f0'">
                          <div class="text-[10px] uppercase font-bold tracking-wider mb-1" style="color:#6b7280;">Remaining</div>
                          <div class="font-title-md font-bold text-[18px]" style="color:#111827;">${totalQuestions - totalAnswered}</div>
                      </div>
                  </div>
              </div>

              <div class="rounded-2xl p-6 shadow-sm lg:col-span-2" style="background:#fff; border:1px solid #e2e8f0;">
                  <h3 class="font-title-md mb-4" style="color:#111827;">Accuracy by Specialty</h3>
                  <div class="relative h-[250px] w-full">
                      <canvas id="performanceChart"></canvas>
                  </div>
              </div>
          </div>

          <div>
              <h3 class="font-headline-lg text-[22px] mb-4 mt-4" style="color:#111827;">Specialty Breakdown</h3>
              <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                  ${specialtyListHtml}
              </div>
          </div>
      </div>
      `;

      // Initialize Chart
      if (labels.length > 0 && window.Chart) {
          const ctx = document.getElementById('performanceChart');
          if (ctx) {
              if (performanceChartInstance) {
                  performanceChartInstance.destroy();
              }

              // Top 10 specialties to avoid chart clutter
              const chartLabels = labels.slice(0, 10);
              const chartData = dataScore.slice(0, 10);

              performanceChartInstance = new Chart(ctx.getContext('2d'), {
                  type: 'bar',
                  data: {
                      labels: chartLabels,
                      datasets: [{
                          label: 'Accuracy (%)',
                          data: chartData,
                          backgroundColor: 'rgba(0, 122, 122, 0.7)',
                          hoverBackgroundColor: 'rgba(0, 122, 122, 1)',
                          borderColor: 'rgba(0, 122, 122, 1)',
                          borderWidth: 1,
                          borderRadius: 6
                      }]
                  },
                  options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      layout: {
                          padding: {
                              top: 20
                          }
                      },
                      scales: {
                          y: {
                              beginAtZero: true,
                              max: 100,
                              grid: {
                                  color: 'rgba(0, 0, 0, 0.08)',
                                  drawBorder: false
                              },
                              ticks: {
                                  stepSize: 20,
                                  color: '#6f797b',
                                  font: { family: 'Inter', size: 11, weight: '600' }
                              }
                          },
                          x: {
                              grid: {
                                  display: false,
                                  drawBorder: false
                              },
                              ticks: {
                                  color: '#6f797b',
                                  font: { family: 'Inter', size: 11, weight: '600' }
                              }
                          }
                      },
                      plugins: {
                          legend: {
                              display: false
                          },
                          tooltip: {
                              backgroundColor: '#005c5c',
                              titleFont: { family: 'Inter', size: 13, weight: 'bold' },
                              bodyFont: { family: 'Inter', size: 12 },
                              padding: 10,
                              displayColors: false,
                              cornerRadius: 8
                          }
                      }
                  },
                  plugins: [{
                      id: 'customDataLabels',
                      afterDatasetsDraw: (chart) => {
                          const ctx = chart.ctx;
                          chart.data.datasets.forEach((dataset, i) => {
                              const meta = chart.getDatasetMeta(i);
                              meta.data.forEach((bar, index) => {
                                  const data = dataset.data[index];
                                  if (data > 0) {
                                      ctx.fillStyle = '#007a7a';
                                      ctx.font = 'bold 12px Inter';
                                      ctx.textAlign = 'center';
                                      ctx.textBaseline = 'bottom';
                                      ctx.fillText(data + '%', bar.x, bar.y - 6);
                                  }
                              });
                          });
                      }
                  }]
              });
          }
      }
  }
  
  window.renderDashboardPlannerWidget = function() {
      const widget = document.getElementById("dashboard-planner-widget");
      if (!widget) return;
      
      let tasks = [];
      try {
          tasks = JSON.parse(localStorage.getItem("omnote_planner_tasks") || "[]");
      } catch (e) {
          tasks = [];
      }
      
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      
      const todayTasks = tasks.filter(t => t.date === todayKey);
      const completed = todayTasks.filter(t => t.completed).length;
      
      let taskHtml = '';
      if (todayTasks.length === 0) {
          taskHtml = '<div class="text-sm text-on-surface-variant p-3 text-center">No tasks for today. <br> Add one in the Full Calendar.</div>';
      } else {
          // Show up to 4 tasks on the dashboard widget
          todayTasks.slice(0, 4).forEach(t => {
              taskHtml += `
              <label class="flex items-start gap-3 p-3 rounded-lg hover:bg-surface-container transition-colors cursor-pointer group">
                  <input type="checkbox" ${t.completed ? 'checked' : ''} class="mt-1 rounded text-primary focus:ring-primary/20" onchange="window.plannerToggleTask && window.plannerToggleTask('${t.id}')">
                  <span class="text-sm flex-1 ${t.completed ? 'line-through opacity-50' : ''}">${window.escapeHtml ? window.escapeHtml(t.title) : t.title}</span>
              </label>
              `;
          });
          if (todayTasks.length > 4) {
              taskHtml += `<div class="text-center text-xs text-on-surface-variant mt-2">+${todayTasks.length - 4} more tasks</div>`;
          }
      }

      widget.innerHTML = `
      <div class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm border border-outline-variant/30">
          <h2 class="font-headline-lg text-[20px] text-on-surface mb-4">Study Planner</h2>
          <div class="flex justify-between items-center mb-4 text-sm font-medium">
              <span class="text-on-surface-variant">Today</span>
              <span class="text-primary">${completed} / ${todayTasks.length} Tasks</span>
          </div>
          <div class="space-y-1 max-h-[220px] overflow-y-auto pr-1">
              ${taskHtml}
          </div>
          <button class="w-full mt-4 py-2 border border-outline-variant rounded-xl text-sm font-medium hover:bg-surface-container transition-colors" onclick="window.openPlanner && window.openPlanner()">View Full Calendar</button>
      </div>
      `;
  };

  // --- Answer Party Hooks ---
  window.qbankPartyStateChanged = function(questionChanged, statusChanged) {
      if (!window.QBankParty || !window.QBankParty.state.party) return;
      const state = window.QBankParty.state;
      
      if (state.isHost && state.party.status === "waiting" && !state.party.currentQuestionId) {
          if (currentQuestions && currentQuestions[currentIndex]) {
               window.firebase.firestore().collection("answerParties").doc(state.code).update({
                   currentQuestionId: currentQuestions[currentIndex].id
               }).catch(e => console.error(e));
          }
      }
      
      if (state.party.status === "playing" || state.party.status === "waiting") {
          if (questionChanged && currentQuestions && state.party.currentQuestionId) {
             const idx = currentQuestions.findIndex(q => q.id === state.party.currentQuestionId);
             if (idx >= 0 && currentIndex !== idx) {
                 currentIndex = idx;
                 window.currentIndex = idx;
                 if (typeof window.qbankRenderSidebar === 'function') {
                    window.qbankRenderSidebar();
                 }
                 if (typeof window.qbankRenderCurrent === 'function') {
                    window.qbankRenderCurrent();
                 }
             }
          }
          const expl = document.getElementById("qbank-explanation-container");
          if (expl) expl.style.display = "none";
          
          const submitBtn = document.getElementById("qbank-submit-btn");
          if (submitBtn) {
              submitBtn.style.display = "block";
              if (state.party.status === "waiting") {
                  submitBtn.disabled = true;
                  submitBtn.innerHTML = 'Waiting for Host...';
              } else if (state.hasLocked) {
                  submitBtn.disabled = true;
                  submitBtn.innerHTML = '<i data-lucide="lock" style="width:16px;height:16px;"></i> Locked';
                  if (window.lucide) window.lucide.createIcons();
              } else {
                  submitBtn.disabled = false;
                  submitBtn.innerHTML = 'Lock Answer';
              }
          }
      } else if (state.party.status === "revealing") {
          window.qbankRevealPartyAnswers();
      }
  };

  window.qbankPartyMembersChanged = function() {};
  window.qbankPartyChatChanged = function() {};

  window.qbankPartyLockAnswer = function() {
      if (!window.QBankParty || !window.QBankParty.state.party) return;
      const q = currentQuestions[currentIndex];
      const data = q.data || {};
      const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
      const isMultiple = correctIndices.length > 1;

      let selectedIndices = [];
      const inputs = document.getElementsByName("qbank-radio");
      inputs.forEach(r => { if (r.checked) selectedIndices.push(parseInt(r.value, 10)); });
      
      if (selectedIndices.length === 0) {
          window.qbankToast("Please select an answer to lock.", true);
          return;
      }
      
      window.QBankParty.state.hasLocked = true;
      window.QBankParty.lockAnswer(selectedIndices);
      window.qbankPartyStateChanged(false, false);
  };
  
   window.qbankRevealPartyAnswers = async function() {
        const q = currentQuestions[currentIndex];
        try {
          if (q && q.id && typeof window.ensureQBankAnswers === "function") {
            await window.ensureQBankAnswers(currentQBankId, [q.id]);
            if (typeof window.mergeQBankAnswers === "function") window.mergeQBankAnswers([q], currentQBankId);
          }
        } catch (_) {}
        const data = q.data || {};
       const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
       
       let u = null;
       if (window.firebase && window.firebase.auth) u = window.firebase.auth().currentUser;
       const uid = u ? u.uid : null;
       
       const myLock = window.QBankParty.state.members.find(m => m.uid === uid)?.lockedAnswer || [];
       
        let isCorrect = false;
        let isPartial = false;
        if (myLock.length === correctIndices.length && myLock.every(v => correctIndices.includes(v))) {
            isCorrect = true;
        } else if (myLock.length > 0 && myLock.every(v => correctIndices.includes(v)) && myLock.length < correctIndices.length && correctIndices.length > 1) {
            isPartial = true;
        }
        
        if (isCorrect && window.lastScoredQuestionId !== q.id) {
            window.lastScoredQuestionId = q.id;
            window.QBankParty.updateScore(100);
        }
        
          const inputs = document.getElementsByName("qbank-radio");
         const revealContainer = document.getElementById("qbank-options-container");
         if (revealContainer) revealContainer.classList.add("answered");
         inputs.forEach(r => {
             r.disabled = true;
             const val = parseInt(r.value, 10);
             const label = document.getElementById("qbank-opt-" + val) || r.nextElementSibling;
             if (!label) return;
             label.classList.remove("selected");
             if (isPartial && myLock.includes(val) && correctIndices.includes(val)) {
                label.classList.add("partial");
                label.style.background = "rgba(234,179,8,0.12)";
                label.style.border = "1px solid #eab308";
                label.style.borderRadius = "8px";
                label.style.padding = "8px";
            } else if (correctIndices.includes(val)) {
                label.classList.add("correct");
                label.style.background = "rgba(34,197,94,0.1)";
                label.style.border = "1px solid #22c55e";
                label.style.borderRadius = "8px";
                label.style.padding = "8px";
            } else if (myLock.includes(val)) {
                label.classList.add("incorrect");
                label.style.background = "rgba(244,63,94,0.1)";
                label.style.border = "1px solid #f43f5e";
                label.style.borderRadius = "8px";
                label.style.padding = "8px";
            }
        });
        
        const expl = document.getElementById("qbank-explanation-container");
        if (expl) expl.style.display = "block";
        
        const submitBtn = document.getElementById("qbank-submit-btn");
        if (submitBtn) submitBtn.style.display = "none";
        
        const resultHeader = document.getElementById("qbank-result-header");
        if (resultHeader) {
            if (isCorrect) {
                resultHeader.innerHTML = '<span style="color:#22c55e;"><i data-lucide="check-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Correct</span>';
            } else if (isPartial) {
                resultHeader.innerHTML = '<span style="color:#eab308;"><i data-lucide="check-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Partially correct</span>';
            } else {
                resultHeader.innerHTML = '<span style="color:#f43f5e;"><i data-lucide="x-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Incorrect</span>';
            }
           if (window.lucide) window.lucide.createIcons();
       }
       
       if (qbankTimer) {
          clearInterval(qbankTimer);
          qbankTimer = null;
       }
       
       window.QBankParty.revealOthers();
  };

  window.openQBankResourcesTab = async function() {
      if (window.hideAllMainViews) window.hideAllMainViews();
      const view = document.getElementById('resources-view');
      if (view) {
          view.style.display = 'flex';
          view.style.flexDirection = 'column';
      }
      
      // Update Sidebar active state
      if (window.setQBankNav) window.setQBankNav('resources');
      
      let html = `<div style="max-width:1400px; margin:0 auto; width:100%; padding-bottom:40px;">
          <h2 style="font-size:1.8rem; font-weight:700; margin-bottom:8px; color:var(--text-primary);">Study Resources</h2>
          <p style="margin:0 0 30px 0; font-size:1rem; color:var(--text-muted);">Explore hand-picked study materials for your question banks.</p>
      `;
      
      // Ensure we have the latest qbanks data (reuse session cache when fresh:
      // 0 fetches / 0 Firestore reads on repeat visits; version-aware
      // revalidation otherwise. Backed by IDB forever-cache so reloads
      // never pay a full list fetch).
      try {
          let useCache = !!(cachedCategories && Array.isArray(cachedCategories) && cachedCategories.length);
          if (!useCache) {
              try {
                  const saved = await idbKvGet(KV_KEYS.QBANK_LIST);
                  if (saved && Array.isArray(saved.banks) && saved.banks.length) {
                      cachedCategories = saved.banks;
                      if (saved.maxUpdatedAt) window.__qbanksMaxUpdatedAt = saved.maxUpdatedAt;
                      useCache = true;
                  }
              } catch (_) {}
          }
          if (useCache && window.__qbanksMaxUpdatedAt) {
              try {
                  const re = await apiGet("list_categories", { v: String(window.__qbanksMaxUpdatedAt) });
                  if (!re.unchanged && Array.isArray(re.qbanks)) {
                      cachedCategories = re.qbanks;
                      try { idbKvSet(KV_KEYS.QBANK_LIST, { banks: cachedCategories, maxUpdatedAt: re.maxUpdatedAt || window.__qbanksMaxUpdatedAt || 0 }); } catch (_) {}
                  }
                  if (re.maxUpdatedAt) window.__qbanksMaxUpdatedAt = re.maxUpdatedAt;
              } catch (_) { /* keep session cache on revalidation failure */ }
          } else {
              const res = await apiGet("list_categories");
              if (Array.isArray(res.qbanks)) {
                  cachedCategories = res.qbanks;
                  if (res.maxUpdatedAt) window.__qbanksMaxUpdatedAt = res.maxUpdatedAt;
                  try { idbKvSet(KV_KEYS.QBANK_LIST, { banks: cachedCategories, maxUpdatedAt: window.__qbanksMaxUpdatedAt || 0 }); } catch (_) {}
              }
          }
          qbanks = cachedCategories || [];
      } catch(e) {
          console.error("Failed to refresh resources:", e);
      }

      let hasAnyResources = false;
      
      if (qbanks && qbanks.length > 0) {
          for (const q of qbanks) {
              const res = q.resources || [];
              if (res.length > 0) {
                  hasAnyResources = true;
                  html += `<div style="margin-bottom:40px;">`;
                  html += `<h3 style="font-size:1.3rem; font-weight:600; margin-bottom:20px; color:var(--accent-cyan); display:flex; align-items:center; gap:8px;">
                     <i data-lucide="folder" style="width:20px;height:20px;"></i> ${window.escapeHtml ? window.escapeHtml(q.name) : q.name}
                  </h3>`;
                  
                  let normalizedResources = [];
                  let uncategorized = [];
                  
                  res.forEach(r => {
                      if (r.isCategory) {
                          normalizedResources.push(r);
                      } else {
                          uncategorized.push(r);
                      }
                  });
                  if (uncategorized.length > 0) {
                      normalizedResources.push({ id: 'cat-general', isCategory: true, title: 'General Resources', items: uncategorized });
                  }
                  
                  for (const catData of normalizedResources) {
                      if (!catData.items || catData.items.length === 0) continue;
                      html += `<div style="margin-bottom:24px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05); border-radius:12px; padding:20px;">`;
                      html += `<h4 style="font-size:1.1rem; font-weight:600; margin-top:0; margin-bottom:16px; color:var(--text-primary);">${window.escapeHtml(catData.title)}</h4>`;
                      html += `<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap:16px;">`;
                      
                      catData.items.forEach(r => {
                          const isYT = r.url && (r.url.includes("youtube.com") || r.url.includes("youtu.be"));
                          const clickHandler = isYT ? `onclick="window.openYouTubeModal('${r.url}')"` : `href="${r.url}" target="_blank"`;
                          const tag = isYT ? 'div' : 'a';
                          
                          let icon = "link";
                          let color = "var(--text-muted)";
                          if (r.type === "youtube" || r.type === "video") { icon = "play-circle"; color = "#ef4444"; }
                          else if (r.type === "pdf") { icon = "file-text"; color = "#3b82f6"; }
                          else if (r.type === "flashcards" || r.type === "deck") { icon = "layers"; color = "#10b981"; }
                          
                          html += `<${tag} ${clickHandler} style="display:flex; align-items:flex-start; gap:12px; padding:16px; background:var(--bg-card); border:1px solid var(--border-color); border-radius:10px; text-decoration:none; color:inherit; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.borderColor='var(--accent-cyan)'; this.style.transform='translateY(-2px)';" onmouseout="this.style.borderColor='var(--border-color)'; this.style.transform='translateY(0)';">
                              <i data-lucide="${icon}" style="width:24px;height:24px;color:${color}; flex-shrink:0;"></i>
                              <div style="flex:1;">
                                  <div style="font-weight:600; font-size:1rem; margin-bottom:4px; color:var(--text-primary); line-height:1.3;">${window.escapeHtml(r.title)}</div>
                                  ${r.description ? `<div style="font-size:0.85rem; color:var(--text-muted); line-height:1.4;">${window.escapeHtml(r.description)}</div>` : ''}
                              </div>
                              <i data-lucide="${isYT ? 'play' : 'external-link'}" style="width:16px;height:16px;color:var(--text-muted);opacity:0.5;flex-shrink:0;"></i>
                          </${tag}>`;
                      });
                      
                      html += `</div></div>`;
                  }
                  
                  html += `</div>`;
              }
          }
      }
      
      if (!hasAnyResources) {
          html += `
          <div style="text-align:center; padding:60px 20px; background:rgba(255,255,255,0.02); border:1px dashed rgba(255,255,255,0.1); border-radius:16px;">
              <i data-lucide="folder-open" style="width:48px;height:48px;color:var(--text-muted);opacity:0.5;margin-bottom:16px;"></i>
              <h3 style="font-size:1.2rem; color:var(--text-primary); margin:0 0 8px 0;">No Resources Available</h3>
              <p style="color:var(--text-muted); margin:0;">There are no study materials linked to any of the available question banks yet.</p>
          </div>`;
      }
      
      html += `</div>`;
      
            if (view) view.innerHTML = html;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  // ---------- EXAM PREP STANDALONE SIDEBAR TAB (countries -> colleges -> banks) ----------
  const EP_FLAG_CODES = { global: "un", usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg", morocco: "ma" };
  const EP_COUNTRY_LABELS = { global: "Global", usa: "USA", uk: "UK", australia: "Australia", canada: "Canada", india: "India", europe: "Europe", tunisia: "Tunisia", algeria: "Algeria", egypt: "Egypt", morocco: "Morocco" };

  const getEpFlagImg = (c, size = 40) => {
      const code = EP_FLAG_CODES[c] || "un";
      return `<img src="https://flagcdn.com/${code}.svg" style="width:${size}px; border-radius:4px; vertical-align:middle; display:inline-block;" alt=""/>`;
  };

  window.__epState = { country: null };

  // Shared clinical row polish: no trailing divider on the last row.
  // Injected once (guarded by id) — matches the dashboard .clin-row look.
  window.__epEnsureRowStyle = function() {
      if (document.getElementById("ep-clin-style")) return;
      const st = document.createElement("style");
      st.id = "ep-clin-style";
      st.textContent = ".ep-card-rows > div:last-child { border-bottom: none !important; }";
      document.head.appendChild(st);
  };

  window.epShowCountries = function() {
      const listEl = document.getElementById("exam-prep-content");
      if (!listEl || !window.__epBanks) return;
      window.__epEnsureRowStyle();
      window.__epState.country = null;

      // group counts by country
      const counts = {};
      window.__epBanks.forEach(q => {
          const c = q.country || "global";
          counts[c] = (counts[c] || 0) + 1;
      });

      if (Object.keys(counts).length === 0) {
          listEl.innerHTML = '<div style="border:1px solid #F1F5F9; border-radius:6px; background:#FAFAFA; color:#64748B; text-align:center; padding:16px 12px; font-size:12px;">No exam-prep banks available yet.</div>';
          return;
      }
      let out = '<div class="ep-countries" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:12px; font-family:Inter,-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">';
      Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach(c => {
          out += `<button onclick="window.epShowColleges('${c}')" style="background:#fff; border:1px solid #E2E8F0; border-radius:6px; padding:14px 16px; cursor:pointer; display:flex; align-items:center; gap:12px; text-align:left; transition:all 0.2s;" onmouseover="this.style.borderColor='#007a7a'; this.style.background='#F8FAFC';" onmouseout="this.style.borderColor='#E2E8F0'; this.style.background='#fff';">
              <span style="flex-shrink:0; display:flex; align-items:center;">${getEpFlagImg(c, 40)}</span>
              <span style="flex:1; min-width:0; display:flex; flex-direction:column; gap:4px;">
                  <span style="font-weight:700; font-size:15px; color:#0F172A; line-height:1.2;">${window.escapeHtml ? window.escapeHtml(EP_COUNTRY_LABELS[c] || c) : (EP_COUNTRY_LABELS[c] || c)}</span>
                  <span><span style="font-size:11px; font-weight:700; color:#007a7a; background:#e6f2f2; padding:2px 9px; border-radius:999px; white-space:nowrap;">${counts[c]} bank${counts[c] > 1 ? 's' : ''}</span></span>
              </span>
              <i data-lucide="chevron-right" style="width:16px;height:16px;color:#94A3B8;flex-shrink:0;"></i>
          </button>`;
      });
      out += '</div>';
      listEl.innerHTML = out;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.epShowColleges = function(country) {
      const listEl = document.getElementById("exam-prep-content");
      if (!listEl || !window.__epBanks) return;
      window.__epEnsureRowStyle();
      window.__epState.country = country;

      const banks = window.__epBanks.filter(q => (q.country || "global") === country);
      const byCollege = {};
      banks.forEach(q => {
          const col = q.college || "General";
          if (!byCollege[col]) byCollege[col] = [];
          byCollege[col].push(q);
      });

      const escCol = (s) => window.escapeHtml ? window.escapeHtml(s) : s;
      const jsEsc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      let out = `<div style="max-width:1000px; margin:0 auto; font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
              <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                  <a href="#" onclick="window.openExamPrepTab(); return false;" style="color:#64748B; font-size:12.5px; text-decoration:none; font-weight:600;" onmouseover="this.style.color='#007a7a'" onmouseout="this.style.color='#64748B'">Exam Prep</a>
                  <i data-lucide="chevron-right" style="width:14px;height:14px;color:#94A3B8;flex-shrink:0;"></i>
                  <h3 style="display:flex; align-items:center; gap:8px; margin:0; font-size:14px; font-weight:700; color:#0F172A;">${getEpFlagImg(country, 20)} ${escCol(EP_COUNTRY_LABELS[country] || country)}</h3>
              </div>
              <button onclick="window.epShowCountries()" style="display:flex; align-items:center; gap:8px; padding:8px 16px; background:#F8FAFC; border:1px solid #E2E8F0; color:#0F172A; border-radius:999px; font-size:12.5px; font-weight:600; cursor:pointer; transition:all 0.2s; flex-shrink:0;" onmouseover="this.style.background='#E2E8F0'" onmouseout="this.style.background='#F8FAFC'">
                  <i data-lucide="arrow-left" style="width:14px;height:14px;"></i> All countries
              </button>
          </div>
          <div style="font-size:12px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#64748B; margin:0 0 10px 0;">Colleges &middot; ${escCol(EP_COUNTRY_LABELS[country] || country)}</div>
          <div class="ep-card-rows" style="background:#fff; border:1px solid #E2E8F0; border-radius:6px; padding:6px 16px;">`;

      if (Object.keys(byCollege).length === 1 && byCollege["General"]) {
          banks.forEach(q => {
              out += window.__epBankRow(q);
          });
      } else {
          Object.keys(byCollege).sort().forEach(col => {
              const collegeBanks = byCollege[col];
              const firstBank = collegeBanks[0];
              // Raw values for JS args (display strings are HTML-escaped
              // separately) so names with & / quotes still match filters.
              const safeName = jsEsc(firstBank.name);
              const safeCol = jsEsc(col);
              const multi = collegeBanks.length > 1;
              // Bank name leads, university sits underneath.
              const subLabel = `${escCol(col)} &middot; ${collegeBanks.length} bank${collegeBanks.length > 1 ? 's' : ''}`;

              const rowAction = firstBank.locked
                  ? `window.qbankRequestAccess('${firstBank.id}', '${safeName}')`
                  : (multi
                      ? `window.epShowBanks('${country}', '${safeCol}')`
                      : `window.startQBankSession('${firstBank.id}', '${safeName}')`);
              const actionBtn = firstBank.locked
                  ? `<button style="background:#FBEAEA; color:#C62828; border:none; padding:9px 18px; border-radius:6px; font-weight:700; font-size:13px; cursor:pointer; flex-shrink:0;" onclick="event.stopPropagation(); window.qbankRequestAccess('${firstBank.id}', '${safeName}')">Request Access</button>`
                  : (multi
                      ? `<button style="background:#F8FAFC; color:#0F172A; border:1px solid #E2E8F0; padding:9px 18px; border-radius:6px; font-weight:700; font-size:13px; cursor:pointer; display:inline-flex; align-items:center; gap:8px; flex-shrink:0;" onmouseover="this.style.background='#E2E8F0'" onmouseout="this.style.background='#F8FAFC'" onclick="event.stopPropagation(); window.epShowBanks('${country}', '${safeCol}')">View banks <i data-lucide="arrow-right" style="width:14px;height:14px;"></i></button>`
                      : `<button style="background:#007a7a; color:#fff; border:none; padding:9px 18px; border-radius:6px; font-weight:700; font-size:13px; cursor:pointer; display:inline-flex; align-items:center; gap:8px; flex-shrink:0;" onmouseover="this.style.background='#006666'" onmouseout="this.style.background='#007a7a'" onclick="event.stopPropagation(); window.startQBankSession('${firstBank.id}', '${safeName}')">Practice <i data-lucide="arrow-right" style="width:14px;height:14px;"></i></button>`);

              out += `
              <div onclick="${rowAction}" style="display:flex; align-items:center; gap:10px; padding:10px 6px; margin:0 -6px; border-bottom:1px solid #F1F5F9; border-radius:4px; cursor:pointer; opacity:${firstBank.locked ? '0.65' : '1'};" onmouseover="this.style.background='#F8FAFC'" onmouseout="this.style.background='transparent'">
                  <div style="flex-shrink:0; display:flex; align-items:center; justify-content:center; width:40px; height:40px; background:${firstBank.locked ? '#F1F5F9' : '#e6f2f2'}; border-radius:6px;">
                      <i data-lucide="${firstBank.locked ? 'lock' : (multi ? 'building-2' : 'graduation-cap')}" style="width:20px;height:20px;color:${firstBank.locked ? '#94A3B8' : '#007a7a'};"></i>
                  </div>
                  <div style="flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center; gap:2px;">
                      <div style="font-size:15px; font-weight:700; color:#0F172A; line-height:1.3;">${escCol(firstBank.name)}</div>
                      <div style="font-size:12px; color:#64748B;">${subLabel}</div>
                  </div>
                  ${actionBtn}
              </div>`;
          });
      }

      out += `</div></div>`;
      listEl.innerHTML = out;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.__epBankRow = function(q) {
      const esc = (s) => window.escapeHtml ? window.escapeHtml(s) : s;
      const cached = cachedQBanks[q.id];
      const qCount = cached && cached.questions ? cached.questions.length : 0;
      const countLabel = qCount > 0 ? `${qCount.toLocaleString()} questions` : "No questions yet";
      const yearBadge = q.year ? ` <span style="font-size:11px; font-weight:700; color:#475569; background:#F1F5F9; padding:2px 9px; border-radius:999px; white-space:nowrap;">${esc(q.year)}</span>` : "";
      // Raw name for JS args (rendered text is HTML-escaped separately).
      const safeName = String(q.name || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const college = q.college || "General";

      const actionBtn = q.locked
          ? `<button style="background:#FBEAEA; color:#C62828; border:none; padding:9px 18px; border-radius:6px; font-weight:700; font-size:13px; cursor:pointer; flex-shrink:0;" onclick="event.stopPropagation(); window.qbankRequestAccess('${q.id}', '${safeName}')">Request Access</button>`
          : `<button style="background:#007a7a; color:#fff; border:none; padding:9px 18px; border-radius:6px; font-weight:700; font-size:13px; cursor:pointer; display:inline-flex; align-items:center; gap:8px; flex-shrink:0;" onmouseover="this.style.background='#006666'" onmouseout="this.style.background='#007a7a'" onclick="event.stopPropagation(); window.startQBankSession('${q.id}', '${safeName}')">Practice <i data-lucide="arrow-right" style="width:14px;height:14px;"></i></button>`;

      return `
      <div onclick="${q.locked ? `window.qbankRequestAccess('${q.id}', '${safeName}')` : `window.startQBankSession('${q.id}', '${safeName}')`}" style="display:flex; align-items:center; gap:10px; padding:10px 6px; margin:0 -6px; border-bottom:1px solid #F1F5F9; border-radius:4px; cursor:pointer; opacity:${q.locked ? '0.65' : '1'};" onmouseover="this.style.background='#F8FAFC'" onmouseout="this.style.background='transparent'">
          <div style="flex-shrink:0; display:flex; align-items:center; justify-content:center; width:40px; height:40px; background:${q.locked ? '#F1F5F9' : '#e6f2f2'}; border-radius:6px;">
              <i data-lucide="${q.locked ? 'lock' : 'graduation-cap'}" style="width:20px;height:20px;color:${q.locked ? '#94A3B8' : '#007a7a'};"></i>
          </div>
          <div style="flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center; gap:2px;">
              <div style="font-size:15px; font-weight:700; color:#0F172A; line-height:1.3;">${esc(q.name)}${yearBadge}</div>
              <div style="font-size:12px; color:#64748B;">${esc(college)} &middot; ${countLabel}</div>
          </div>
          ${actionBtn}
      </div>`;
  };

  window.epShowBanks = function(country, college) {
      const listEl = document.getElementById("exam-prep-content");
      if (!listEl || !window.__epBanks) return;
      window.__epEnsureRowStyle();

      const esc = (s) => window.escapeHtml ? window.escapeHtml(s) : s;
      const banks = window.__epBanks.filter(q =>
          (q.country || "global") === country &&
          (q.college || "General") === college
      );

      let out = `<div style="max-width:1000px; margin:0 auto; font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
              <div style="display:flex; align-items:center; gap:8px; min-width:0; flex-wrap:wrap;">
                  <a href="#" onclick="window.openExamPrepTab(); return false;" style="color:#64748B; font-size:12.5px; text-decoration:none; font-weight:600;" onmouseover="this.style.color='#007a7a'" onmouseout="this.style.color='#64748B'">Exam Prep</a>
                  <i data-lucide="chevron-right" style="width:14px;height:14px;color:#94A3B8;flex-shrink:0;"></i>
                  <button onclick="window.epShowColleges('${country}')" style="display:flex; align-items:center; gap:6px; padding:4px 10px; background:#F8FAFC; border:1px solid #E2E8F0; border-radius:999px; color:#0F172A; font-size:12.5px; font-weight:600; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.background='#E2E8F0'" onmouseout="this.style.background='#F8FAFC'">
                      ${getEpFlagImg(country, 16)} ${esc(EP_COUNTRY_LABELS[country] || country)}
                  </button>
                  <i data-lucide="chevron-right" style="width:14px;height:14px;color:#94A3B8;flex-shrink:0;"></i>
                  <h3 style="margin:0; font-size:14px; font-weight:700; color:#0F172A;">${esc(college)}</h3>
              </div>
          </div>
          <div style="font-size:12px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#64748B; margin:0 0 10px 0;">Banks &middot; ${esc(college)}</div>
          <div class="ep-card-rows" style="background:#fff; border:1px solid #E2E8F0; border-radius:6px; padding:6px 16px;">`;

      if (banks.length === 0) {
          out += `<div style="border:1px solid #F1F5F9; border-radius:6px; background:#FAFAFA; color:#64748B; text-align:center; padding:16px 12px; font-size:12px; margin:10px 0;">No banks in this college yet.</div>`;
      } else {
          banks.forEach(q => {
              out += window.__epBankRow(q);
          });
      }

      out += `</div></div>`;
      listEl.innerHTML = out;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };



  window.openExamPrepTab = async function() {
      if (window.hideAllMainViews) window.hideAllMainViews();
      const view = document.getElementById('resources-view');
      if (view) {
          view.style.display = 'flex';
          view.style.flexDirection = 'column';
      }

      if (window.setQBankNav) window.setQBankNav('exam-prep');

      if (view) view.innerHTML = `<div style="max-width:1000px; margin:0 auto; width:100%; padding-bottom:40px; font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">
              <div style="display:flex; align-items:center; justify-content:center; width:40px; height:40px; background:#e6f2f2; border-radius:6px; flex-shrink:0;">
                  <i data-lucide="graduation-cap" style="width:20px;height:20px;color:#007a7a;"></i>
              </div>
              <h2 style="font-size:1.5rem; font-weight:700; margin:0; color:#0F172A;">Exam Prep</h2>
          </div>
          <p style="margin:0 0 24px 0; font-size:0.9rem; color:#64748B;">Browse past exams by country, then pick your college.</p>
          <div id="exam-prep-content" style="color:#64748B; font-size:12px;">Loading…</div>
      </div>`;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

      try {
          await window.preloadQBank();
          qbanks = cachedCategories || [];
      } catch (e) { console.error("preload failed:", e); }

      await window.bootstrapAccess(); // always fresh
      const acc = window.db.access || null;
      const prepAllowed = (id) => !acc || acc.legacy || !acc.country || acc.grants.includes(id) || acc.prepIds.includes(id);
      window.__epBanks = (qbanks || []).filter(q => q.kind === "exam_prep").map(q => ({
        ...q,
        locked: !prepAllowed(q.id),
      }));
      window.epShowCountries();

      if (view) view.scrollTop = 0;
  };

  window.openYouTubeModal = function(url) {
      let videoId = '';
      if (url.includes('youtube.com/watch?v=')) {
          videoId = url.split('v=')[1].split('&')[0];
      } else if (url.includes('youtu.be/')) {
          videoId = url.split('youtu.be/')[1].split('?')[0];
      } else if (url.includes('youtube.com/embed/')) {
          videoId = url.split('youtube.com/embed/')[1].split('?')[0];
      }
      
      if (!videoId) {
          window.open(url, '_blank');
          return;
      }
      
      let modal = document.getElementById("youtube-player-modal");
      if (!modal) {
          modal = document.createElement("div");
          modal.id = "youtube-player-modal";
          modal.className = "fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6";
          modal.style.backgroundColor = "rgba(0,0,0,0.85)";
          modal.style.backdropFilter = "blur(8px)";
          
          modal.innerHTML = `
              <div class="bg-surface-container-high rounded-2xl shadow-2xl w-full max-w-5xl overflow-hidden flex flex-col relative border border-outline-variant/20 transform scale-95 opacity-0 transition-all duration-300" id="youtube-player-content">
                  <button onclick="document.getElementById('youtube-player-modal').style.opacity='0'; document.getElementById('youtube-player-content').style.transform='scale(0.95)'; setTimeout(()=>{document.getElementById('youtube-player-modal').style.display='none'; document.getElementById('youtube-iframe').src='';}, 300);" class="absolute top-4 right-4 w-10 h-10 rounded-full bg-surface-container-highest hover:bg-surface-container flex items-center justify-center text-on-surface transition-colors z-10">
                      <span class="material-symbols-outlined">close</span>
                  </button>
                  <div class="relative w-full" style="padding-top: 56.25%;">
                      <iframe id="youtube-iframe" class="absolute inset-0 w-full h-full border-0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
                  </div>
              </div>
          `;
          document.body.appendChild(modal);
      }
      
      document.getElementById("youtube-iframe").src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`;
      modal.style.display = "flex";
      
      // Animate in
      setTimeout(() => {
          modal.style.opacity = "1";
          document.getElementById('youtube-player-content').style.opacity = "1";
          document.getElementById('youtube-player-content').style.transform = "scale(1)";
      }, 10);
  };

})();

// Admin Diagnostic System — Firebase-real counts only.
// Every entry is either TRACKED (server sent x-firestore-reads/writes
// headers, or a direct SDK op logged at its call site) or UNTRACKED
// (backend route without instrumentation — flagged, never guessed).
(function() {
  let diagnosticData = { reads: 0, writes: 0, untracked: 0, logs: [] };
  
  window.logAdminDiagnostic = function(action, reads, writes, tracked) {
    const isTracked = tracked !== false; // default true for direct-SDK call sites
    if (isTracked) {
      diagnosticData.reads += reads;
      diagnosticData.writes += writes;
    } else {
      diagnosticData.untracked += 1;
    }
    diagnosticData.logs.unshift({
      time: new Date().toLocaleTimeString(),
      action, reads, writes, tracked: isTracked
    });
    if (diagnosticData.logs.length > 50) diagnosticData.logs.pop();
    
    if (window.isQBankAdmin) {
       renderAdminDiagnosticWidget();
    }
  };

  // Global fetch interceptor
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    if (!args[0] || typeof args[0] === 'string' && !args[0].includes('/api/')) return originalFetch.apply(this, args);
    let logName = "API Call";
    let isApi = false;
    
    try {
      const urlStr = args[0] instanceof Request ? args[0].url : args[0];
      const urlObj = new URL(urlStr, window.location.origin);
      
      if (urlObj.pathname.startsWith('/api/')) {
        isApi = true;
        let method = 'GET';
        if (args[0] instanceof Request) method = args[0].method;
        else if (args[1] && args[1].method) method = args[1].method;
        method = method.toUpperCase();
        
        let action = urlObj.searchParams.get('action');
        if (!action && method !== 'GET' && args[1] && args[1].body) {
           try {
             const bodyStr = typeof args[1].body === 'string' ? args[1].body : '';
             if (bodyStr) {
               const parsed = JSON.parse(bodyStr);
               action = parsed.action;
             }
           } catch(e) {}
        }
        
        let endpoint = urlObj.pathname.replace('/api/', '');
        logName = `${method} /api/${endpoint}${action ? ' [' + action + ']' : ''}`;
      }
    } catch (e) {}
    
    const res = await originalFetch.apply(this, args);
    
    if (isApi) {
        try {
            // Firebase-real only: no guessing. Routes without the
            // x-firestore-* headers are flagged UNTRACKED so missing
            // instrumentation is visible instead of silently wrong.
            const hasHeaders = res.headers.has('x-firestore-reads');
            const reads = parseInt(res.headers.get('x-firestore-reads') || '0', 10);
            const writes = parseInt(res.headers.get('x-firestore-writes') || '0', 10);
            window.logAdminDiagnostic(logName, reads, writes, hasHeaders);
        } catch(e) {}
    }
    
    return res;
  };
  
  function renderAdminDiagnosticWidget() {
    let w = document.getElementById('admin-diagnostic-widget');
    if (!w) {
      w = document.createElement('div');
      w.id = 'admin-diagnostic-widget';
      w.style.cssText = 'position:fixed;bottom:20px;left:20px;background:var(--surface-container-high, #1e1e1e);color:var(--on-surface, #e2e2e2);z-index:99999;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-size:12px;font-family:monospace;overflow:hidden;border:1px solid var(--outline, #444);width:280px;';
      
      const head = document.createElement('div');
      head.style.cssText = 'padding:8px 12px;background:var(--surface-container-highest, #2d2d2d);cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-weight:bold;user-select:none;';
      head.innerHTML = `<span>Admin DB Diagnostics</span><span id="adw-toggle">▲</span>`;
      head.onclick = () => {
        const body = document.getElementById('adw-body');
        const isHidden = body.style.display === 'none';
        body.style.display = isHidden ? 'block' : 'none';
        document.getElementById('adw-toggle').textContent = isHidden ? '▼' : '▲';
      };
      w.appendChild(head);
      
      const body = document.createElement('div');
      body.id = 'adw-body';
      body.style.cssText = 'display:none;';
      w.appendChild(body);
      
      document.body.appendChild(w);
    }
    
    const body = document.getElementById('adw-body');
    let html = `<div style="padding:8px 12px;border-bottom:1px solid var(--outline, #444);display:flex;gap:12px;align-items:center;" title="Real Firestore counts only — untracked calls carry no headers and are excluded">
      <div style="color:#22c55e;">Reads: <b>${diagnosticData.reads}</b></div>
      <div style="color:#eab308;">Writes: <b>${diagnosticData.writes}</b></div>
      ${diagnosticData.untracked > 0 ? `<div style="color:#f59e0b;" title="${diagnosticData.untracked} API call(s) without Firestore headers — backend route not instrumented">⚠ untracked: <b>${diagnosticData.untracked}</b></div>` : ""}
    </div>`;
    
    html += `<div style="max-height:200px;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;gap:6px;">`;
    diagnosticData.logs.forEach(l => {
      let cost = [];
      if (l.tracked === false) {
        cost.push(`<span style="color:#f59e0b;white-space:nowrap;" title="No x-firestore-* headers — not counted">?</span>`);
      } else {
        if (l.reads > 0) cost.push(`<span style="color:#22c55e;white-space:nowrap;">${l.reads}r</span>`);
        if (l.writes > 0) cost.push(`<span style="color:#eab308;white-space:nowrap;">${l.writes}w</span>`);
        if (cost.length === 0) cost.push(`<span style="color:var(--text-muted);white-space:nowrap;">0</span>`);
      }
      html += `<div style="display:flex;justify-content:space-between;opacity:0.9;border-bottom:1px solid var(--outline-variant, #333);padding-bottom:2px;">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px;" title="${l.action}">[${l.time}] ${l.action}</span>
        <span>${cost.join(' ')}</span>
      </div>`;
    });
    html += `</div>`;
    
    body.innerHTML = html;
  }

  // Ensure it renders if admin status resolves late
  setInterval(async () => {
     if (window.checkAdmin && typeof window.isQBankAdmin === 'undefined') {
         window.isQBankAdmin = await window.checkAdmin();
     }
     if (window.isQBankAdmin && !document.getElementById('admin-diagnostic-widget')) {
         renderAdminDiagnosticWidget();
     }
  }, 1000);

  // ---- Direct Firestore SDK catch-all ----
  // The fetch interceptor above only sees /api/* traffic. Anything using
  // the browser SDK directly (syncDbToCloud users/users_index writes,
  // boot-time users_index gets, pomodoro, notifications + party
  // onSnapshot listeners, peer-stats gets) bypassed it completely — those
  // were the "phantom" reads visible in the Firebase console but missing
  // here. So we patch the compat SDK prototypes once: every doc get counts
  // 1r (billed even on miss), every set/update/delete/add counts 1w,
  // query gets count max(1, size), batches count their ops at commit, and
  // onSnapshot listeners count the initial snapshot + subsequent deltas.
  // Ref creation (collection()/doc()) and FieldValue sentinels are pure
  // local — never logged.
  function diagRefPath(ref, fallback) {
    try {
      if (ref && typeof ref.path === "string" && ref.path) return ref.path;
      const inner = (ref && (ref._query || (ref._delegate && ref._delegate._query))) || null;
      const segs = inner && inner.path;
      if (segs && typeof segs.canonicalString === "function") return segs.canonicalString();
      if (Array.isArray(segs)) return segs.join("/");
    } catch (_) {}
    return fallback || "query";
  }
  function diagIsQuerySnap(snap) {
    try { return snap && typeof snap.size === "number"; } catch (_) { return false; }
  }
  function diagWrapObserverArgs(args, onSnap) {
    const out = Array.prototype.slice.call(args);
    const wrapNext = (next) => function (snap) { try { onSnap(snap); } catch (_) {} return next(snap); };
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      if (typeof a === "function" && i > 0 && typeof out[0] === "object") { out[i] = wrapNext(a); break; } // (options, next, ...)
      if (typeof a === "function") { out[i] = wrapNext(a); break; } // (next, ...)
      if (a && typeof a === "object" && typeof a.next === "function") { // observer object
        try {
          const clone = Object.create(Object.getPrototypeOf(a));
          for (const k of Object.keys(a)) clone[k] = a[k];
          const oNext = a.next.bind(a);
          clone.next = function (snap) { try { onSnap(snap); } catch (_) {} return oNext(snap); };
          out[i] = clone;
        } catch (_) {}
        break;
      }
    }
    return out;
  }
  function patchFirestoreSDK() {
    try {
      if (!window.firebase || !window.firebase.firestore) return false;
      const fs = window.firebase.firestore();
      if (!fs) return false;
      // Probe refs: creating them is pure local, zero network.
      const probeDoc = fs.doc("__diag__/probe");
      const probeCol = fs.collection("__diag__");
      const probeBatch = fs.batch();
      const DocProto = Object.getPrototypeOf(probeDoc);
      const ColProto = Object.getPrototypeOf(probeCol);
      const QueryProto = Object.getPrototypeOf(ColProto); // CollectionReference extends Query
      const BatchProto = Object.getPrototypeOf(probeBatch);
      if (!DocProto || !QueryProto || !BatchProto) return false;
      if (DocProto.__diagPatched) return true;

      const log = (action, r, w) => { try { window.logAdminDiagnostic(action, r, w, true); } catch (_) {} };

      const origDocGet = DocProto.get;
      if (origDocGet && !DocProto.__diagPatched) {
        DocProto.get = function (...args) { log("sdk doc get " + diagRefPath(this, "doc"), 1, 0); return origDocGet.apply(this, args); };
      }
      [["set", 0, 1], ["update", 0, 1], ["delete", 0, 1]].forEach(([m, r, w]) => {
        const orig = DocProto[m];
        if (typeof orig === "function") {
          DocProto[m] = function (...args) { log("sdk doc " + m + " " + diagRefPath(this, "doc"), r, w); return orig.apply(this, args); };
        }
      });
      const origDocSnap = DocProto.onSnapshot;
      if (typeof origDocSnap === "function") {
        DocProto.onSnapshot = function (...args) {
          const path = diagRefPath(this, "doc");
          let first = true;
          const wrapped = diagWrapObserverArgs(args, () => { if (first) { first = false; log("sdk live doc " + path, 1, 0); } else { log("sdk live doc update " + path, 1, 0); } });
          return origDocSnap.apply(this, wrapped);
        };
      }

      const origQueryGet = QueryProto.get;
      if (typeof origQueryGet === "function" && !QueryProto.__diagQueryPatched) {
        QueryProto.get = function (...args) {
          const label = diagRefPath(this, null) || "query";
          return origQueryGet.apply(this, args).then((snap) => {
            log("sdk query get " + label, Math.max(1, (snap && snap.size) || 0), 0);
            return snap;
          });
        };
        QueryProto.__diagQueryPatched = true;
      }
      const origQuerySnap = QueryProto.onSnapshot;
      if (typeof origQuerySnap === "function" && !QueryProto.__diagSnapPatched) {
        QueryProto.onSnapshot = function (...args) {
          const label = diagRefPath(this, null) || "query";
          let first = true;
          const wrapped = diagWrapObserverArgs(args, (snap) => {
            if (first) { first = false; log("sdk live query " + label, Math.max(1, (snap && snap.size) || 0), 0); }
            else {
              let n = 0;
              try { n = (snap && snap.docChanges ? snap.docChanges().length : 1) || 0; } catch (_) { n = 1; }
              if (n > 0) log("sdk live query update " + label, n, 0);
            }
          });
          return origQuerySnap.apply(this, wrapped);
        };
        QueryProto.__diagSnapPatched = true;
      }

      const origAdd = ColProto.add;
      if (typeof origAdd === "function") {
        ColProto.add = function (...args) { log("sdk col add " + diagRefPath(this, "col"), 0, 1); return origAdd.apply(this, args); };
      }

      ["set", "update", "delete", "create"].forEach((m) => {
        const orig = BatchProto[m];
        if (typeof orig === "function") {
          BatchProto[m] = function (...args) {
            try { this.__diagWrites = (this.__diagWrites || 0) + 1; } catch (_) {}
            return orig.apply(this, args);
          };
        }
      });
      const origCommit = BatchProto.commit;
      if (typeof origCommit === "function") {
        BatchProto.commit = function (...args) {
          let n = 0;
          try { n = this.__diagWrites || 0; this.__diagWrites = 0; } catch (_) {}
          if (n > 0) log("sdk batch commit (" + n + " ops)", 0, n);
          return origCommit.apply(this, args);
        };
      }

      DocProto.__diagPatched = true;
      return true;
    } catch (_) { return false; }
  }
  // firebase compat loads before this file, but retry in case init races.
  (function ensureSdkPatch(tries) {
    if (patchFirestoreSDK()) return;
    if (tries > 0) setTimeout(() => ensureSdkPatch(tries - 1), 500);
  })(10);
  window.__diagPatchFirestore = patchFirestoreSDK;

})();
