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
          'border-[#007a7a]', 'bg-[#007a7a]/5', 'bg-[#e6f2f2]', 'text-[#007a7a]', 'font-bold',
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

  window.toggleQBankNav = function(force) {
    const open = typeof force === "boolean" ? force : !document.body.classList.contains("qbank-nav-open");
    document.body.classList.toggle("qbank-nav-open", open);
    const btn = document.getElementById("qbank-nav-btn");
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  };

  document.addEventListener("click", (event) => {
    if (event.target && event.target.closest && event.target.closest("aside nav a[data-path]")) {
      window.toggleQBankNav(false);
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 1024) window.toggleQBankNav(false);
  });

  window.qbankFocusSearch = function() {
    nextNavToken();
    if (window.setQBankNav) window.setQBankNav("search");
    if (window.closeFullscreen) window.closeFullscreen("qbank-modal");
    const input = document.getElementById("home-search-input");
    if (input) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      input.focus();
      if (input.select) input.select();
    }
  };

  window.qbankOpenNotes = function() {
    nextNavToken();
    if (window.setQBankNav) window.setQBankNav("notes");
    if (window.closeFullscreen) window.closeFullscreen("qbank-modal");
    qblockEnsureStyles();
    if (window.hideAllMainViews) window.hideAllMainViews();
    const view = document.getElementById("qbank-home-view");
    if (view) view.style.display = "flex";
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    const progress = qbankProgressMap();
    const questions = qblockActiveQuestions();
    const byId = {};
    questions.forEach(q => { if (q && q.id) byId[q.id] = q; });
    const notes = Object.keys(progress)
      .map(id => {
        const p = progress[id] || {};
        const q = byId[id] || null;
        const data = (q && q.data) || {};
        const code = data.code || (q && q.id ? "Q-" + String(q.id).substring(0, 5).toUpperCase() : "Question");
        const objective = q ? qblockObjectiveOf(q) : "";
        const organSystem = q ? qblockSubjectOf(q) : "";
        const specialty = q ? qblockClinicalSpecialtyOf(q) : "";
        const subTopic = q ? qblockSubTopicOf(q) : "";
        return { id, code, objective, organSystem, specialty, subTopic, note: String(p.note || "").trim(), updatedAt: p.updatedAt || p.noteUpdatedAt || p.timestamp || 0 };
      })
      .filter(item => item.note)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const rows = notes.map(item => `
      <article class="qbn-note">
        <div class="qbn-note-head">
          <span class="qbn-code">${cqEsc(item.code)}</span>
          ${item.objective ? `<span class="qbn-meta">${cqEsc(item.objective)}</span>` : ""}
          ${item.organSystem ? `<span class="qbn-meta">${cqEsc(item.organSystem)}</span>` : ""}
          ${item.specialty ? `<span class="qbn-meta">${cqEsc(item.specialty)}</span>` : ""}
          ${item.subTopic ? `<span class="qbn-meta">${cqEsc(item.subTopic)}</span>` : ""}
        </div>
        <div class="qbn-note-text">${cqEsc(item.note)}</div>
      </article>`).join("");

    area.innerHTML = `
      <div class="qbc-page">
        <div class="qbc-top">
          <button type="button" class="qbc-back" onclick="window.openQBank()"><i data-lucide="arrow-left" aria-hidden="true"></i> Back to home</button>
          <span class="qbc-kicker">QBank notes</span>
        </div>
        <div class="qbc-heading">
          <div>
            <h1 class="qbc-title">Notes</h1>
            <p class="qbc-sub">Question notes you saved while practising.</p>
          </div>
        </div>
        <div class="qbc-panel">
          ${notes.length ? `<div class="qbn-list">${rows}</div>` : `<div class="qbc-empty-inline" style="padding:22px;">No notes yet. Open a question and use the note tool to save one.</div>`}
        </div>
        <p class="qbc-foot">${notes.length} note${notes.length === 1 ? "" : "s"} in this bank.</p>
      </div>`;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
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
        if (update.omitted !== undefined) progressObj[update.questionId].omitted = !!update.omitted;
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

  function startTimer(resume) {
    const block = window.__qbankBlock;
    if (block && block.active && block.submitted) {
      const display = document.getElementById("qbank-timer-display");
      if (display) display.innerHTML = `<i data-lucide="search" style="width:14px;height:14px;vertical-align:-2px;"></i> Review mode`;
      return;
    }
    if (block && block.active && block.mode === "exam") {
      qblockTick();
      return;
    }
    if ((block && block.active && block.suspended) || (!block && window.__qbankPausedAt)) return;
    stopTimer();
    if (!resume) questionStartTime = Date.now();
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

  // ============================================================
  // QBank chrome: the teal top/bottom toolbars around the question.
  // All state lives on window so the markup (index.html) can call
  // the window.* handlers directly.
  // ============================================================
  const QBANK_CHROME_PREFS_KEY = "curaq_qbank_chrome_prefs:v1";
  const QBANK_TEXT_ZOOM_KEY = "curaq_qbank_text_zoom:v1";
  const QBANK_TEXT_ZOOMS = [
    { stem: 16, option: 15, label: "Default" },
    { stem: 17.5, option: 16, label: "Large" },
    { stem: 19.5, option: 17.5, label: "Extra large" },
    { stem: 14.5, option: 13.5, label: "Small" },
  ];
  let qbankChromeTicker = null;

  function qbankToastSafe(msg, isError) {
    try {
      if (typeof window.qbankToast === "function") return window.qbankToast(msg, !!isError);
    } catch (_) {}
    try { console[isError ? "warn" : "log"](msg); } catch (_) {}
  }

  function qbankProgressMap() {
    if (!window.qbankProgress) window.qbankProgress = {};
    return window.qbankProgress;
  }

  function qbankGetChromePrefs() {
    const fallback = { mode: "exam", timed: true };
    try {
      const raw = localStorage.getItem(QBANK_CHROME_PREFS_KEY);
      if (!raw) return fallback;
      const p = JSON.parse(raw);
      return {
        mode: p && p.mode === "tutor" ? "tutor" : "exam",
        timed: !(p && p.timed === false),
      };
    } catch (_) {
      return fallback;
    }
  }

  function qbankSaveChromePrefs(prefs) {
    try { localStorage.setItem(QBANK_CHROME_PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
  }

  function qbankTextZoomIndex() {
    let idx = 0;
    try { idx = parseInt(localStorage.getItem(QBANK_TEXT_ZOOM_KEY) || "0", 10) || 0; } catch (_) {}
    if (idx < 0 || idx >= QBANK_TEXT_ZOOMS.length) idx = 0;
    return idx;
  }

  function qbankApplyTextZoom() {
    const area = document.getElementById("qbank-question-area");
    const z = QBANK_TEXT_ZOOMS[qbankTextZoomIndex()];
    if (!area || !z) return;
    area.style.setProperty("--qbank-stem-size", z.stem + "px");
    area.style.setProperty("--qbank-option-size", z.option + "px");
  }

  function qbankFreeSessionElapsedMs() {
    const started = Number(window.__qbankSessionStartedAt) || 0;
    if (!started) return 0;
    const pausedMs = Number(window.__qbankPausedMs) || 0;
    const pausedAt = Number(window.__qbankPausedAt) || 0;
    const end = pausedAt || Date.now();
    return Math.max(0, end - started - pausedMs);
  }

  function qbankBlockElapsedSec(b) {
    const end = b.suspended && b.pausedAt ? b.pausedAt : Date.now();
    return Math.max(0, (end - b.startedAt) / 1000);
  }

  function qbankChromeClockText() {
    const b = window.__qbankBlock;
    if (b && b.active) {
      if (b.submitted) {
        return qblockFormatClock((b.results && b.results.secondsUsed) || 0) + " used";
      }
      if (b.deadline) {
        const now = b.suspended && b.pausedAt ? b.pausedAt : Date.now();
        return qblockFormatClock(Math.max(0, Math.ceil((b.deadline - now) / 1000))) + " left";
      }
      return qblockFormatClock(qbankBlockElapsedSec(b)) + " elapsed";
    }
    if (!window.__qbankSessionStartedAt) return "00:00";
    return qblockFormatClock(qbankFreeSessionElapsedMs() / 1000);
  }

  function qbankChromeAnsweredCount() {
    const b = window.__qbankBlock;
    if (b && b.active) return qblockAnsweredCount();
    const progress = qbankProgressMap();
    return currentQuestions.reduce((n, q) => {
      const p = progress[q.id];
      return n + (p && p.correct !== undefined ? 1 : 0);
    }, 0);
  }

  function qbankChromeProgressText() {
    const answered = qbankChromeAnsweredCount();
    const total = currentQuestions.length;
    if (!total) return "0 answered";
    return `${answered}/${total} answered`;
  }

  function qbankChromeSuspendState() {
    const b = window.__qbankBlock;
    if (b && b.active) {
      if (b.submitted) return { disabled: true, paused: false, label: "Suspend", title: "This test is complete" };
      return {
        disabled: false,
        paused: !!b.suspended,
        label: b.suspended ? "Resume" : "Suspend",
        title: b.suspended ? "Resume the test clock and timer" : "Pause the test clock and timer",
      };
    }
    const paused = !!window.__qbankPausedAt;
    return {
      disabled: !window.__qbankSessionStartedAt,
      paused,
      label: paused ? "Resume" : "Suspend",
      title: paused ? "Resume the session clock and timer" : "Pause the session clock and timer",
    };
  }

  function qbankRenderChrome() {
    const q = currentQuestions[currentIndex];
    const progress = qbankProgressMap();
    const p = q ? (progress[q.id] || {}) : {};
    const b = window.__qbankBlock;
    const blockActive = !!(b && b.active);
    const blockSubmitted = !!(blockActive && b.submitted);
    const blockExam = !!(blockActive && !blockSubmitted && b.mode === "exam");

    const itemInfo = document.getElementById("qbank-item-info");
    if (itemInfo) {
      itemInfo.textContent = q
        ? `Item ${currentIndex + 1} of ${currentQuestions.length}`
        : "Item —";
    }

    const codeEl = document.getElementById("qbank-question-code");
    if (codeEl) {
      let code = "";
      if (q) {
        const data = q.data || {};
        code = data.code ? String(data.code) : ("Q-" + String(q.id || "").substring(0, 5).toUpperCase());
      }
      codeEl.textContent = `Question Id: ${code || "—"}`;
    }

    const data = q && q.data ? q.data : {};
    const correctIndices = Array.isArray(data.correctIndices)
      ? data.correctIndices
      : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
    const isMultiple = correctIndices.length > 1 || (correctIndices.length === 0 && data.multi === true);
    const qtype = document.getElementById("qbank-qtype-badge");
    if (qtype) qtype.textContent = isMultiple ? "QCM" : "QCS";

    const markBtn = document.getElementById("qbank-mark-btn");
    const markLabel = document.getElementById("qbank-mark-label");
    if (markBtn) {
      const marked = !!p.marked;
      markBtn.classList.toggle("is-on", marked);
      markBtn.title = marked ? "Remove this question from your marked list" : "Mark this question for review";
      const icon = markBtn.querySelector("i");
      if (icon) icon.className = marked ? "fa-solid fa-bookmark" : "fa-regular fa-bookmark";
    }
    if (markLabel) markLabel.textContent = p.marked ? "Marked" : "Mark";

    const noteBtn = document.getElementById("qbank-note-btn");
    if (noteBtn) {
      const hasNote = !!p.note;
      noteBtn.classList.toggle("is-on", hasNote);
      noteBtn.title = hasNote ? "Edit your note for this question" : "Add a note to this question";
    }

    const highBtn = document.getElementById("qbank-highlighter-top-btn");
    if (highBtn) highBtn.classList.toggle("is-on", !!window.qbankHighlighterActive);

    const prevBtn = document.getElementById("qbank-prev-btn");
    if (prevBtn) prevBtn.disabled = currentIndex <= 0;

    const timedToggle = document.getElementById("qbank-timed-toggle");
    const tutorToggle = document.getElementById("qbank-tutor-toggle");
    if (timedToggle && tutorToggle) {
      if (blockActive) {
        timedToggle.checked = !!b.timeLimitSec;
        tutorToggle.checked = b.mode === "tutor";
        timedToggle.disabled = true;
        tutorToggle.disabled = true;
        timedToggle.title = "The mode is locked while a test is in progress";
        tutorToggle.title = "The mode is locked while a test is in progress";
      } else {
        const prefs = qbankGetChromePrefs();
        timedToggle.checked = prefs.mode === "exam" && prefs.timed;
        tutorToggle.checked = prefs.mode === "tutor";
        timedToggle.disabled = false;
        tutorToggle.disabled = false;
        timedToggle.title = "Timed tests in the next session";
        tutorToggle.title = "Tutor tests in the next session";
      }
    }

    const endLabel = document.getElementById("qbank-end-label");
    if (endLabel) {
      endLabel.textContent = blockActive && !blockSubmitted ? "End test" : "End Session";
    }

    const adminEl = document.getElementById("qbank-admin-actions");
    if (adminEl) {
      if (window.isQBankAdmin && q) {
        adminEl.innerHTML = `
          <button type="button" class="qbank-uw-tool" onclick="window.qbankAdminEdit('${q.id}')" title="Edit this question">
            <i class="fa-solid fa-pen"></i><span>Edit</span>
          </button>
          <button type="button" class="qbank-uw-tool qbank-uw-tool-end" onclick="window.qbankAdminDelete('${q.id}')" title="Delete this question">
            <i class="fa-solid fa-trash"></i><span>Delete</span>
          </button>`;
      } else {
        adminEl.innerHTML = "";
      }
    }

    qbankUpdateChromeLive();
    qblockRenderFooterBar();
    qbankApplyTextZoom();
    qbankStartChromeTicker();
  }

  function qbankUpdateChromeLive() {
    const clock = document.getElementById("qbank-block-time");
    if (clock) {
      clock.innerHTML = `<i class="fa-regular fa-clock"></i> Test Time: ${qbankChromeClockText()}`;
    }

    const progress = document.getElementById("qbank-progress-info");
    if (progress) progress.textContent = qbankChromeProgressText();

    const state = qbankChromeSuspendState();
    const suspendBtn = document.getElementById("qbank-suspend-btn");
    const suspendLabel = document.getElementById("qbank-suspend-label");
    if (suspendBtn) {
      suspendBtn.disabled = state.disabled;
      suspendBtn.classList.toggle("is-active", state.paused);
      suspendBtn.title = state.title;
      const icon = suspendBtn.querySelector("i");
      if (icon) icon.className = state.paused ? "fa-solid fa-play" : "fa-solid fa-pause";
    }
    if (suspendLabel) suspendLabel.textContent = state.label;
  }

  function qbankStartChromeTicker() {
    if (qbankChromeTicker) return;
    qbankChromeTicker = setInterval(() => {
      if (!document.getElementById("qbank-block-time")) return;
      qbankUpdateChromeLive();
    }, 1000);
  }

  window.qbankRenderChrome = qbankRenderChrome;
  window.qbankUpdateBlockTime = qbankUpdateChromeLive;

  window.startQBankBlockClock = function (startedAt) {
    window.__qbankSessionStartedAt = Number(startedAt) || Date.now();
    window.__qbankPausedMs = 0;
    window.__qbankPausedAt = 0;
    qbankUpdateChromeLive();
  };

  window.qbankResetSessionClock = function () {
    window.__qbankSessionStartedAt = 0;
    window.__qbankPausedMs = 0;
    window.__qbankPausedAt = 0;
    qbankUpdateChromeLive();
  };

  window.qbankPrev = function () {
    const b = window.__qbankBlock;
    if (b && b.active) {
      window.qbankBlockPrev();
      return;
    }
    if (currentIndex <= 0) return;
    stopTimer();
    currentIndex--;
    window.currentIndex = currentIndex;
    window.qbankRenderSidebar();
    window.qbankRenderCurrent();
  };

  window.qbankCycleTextZoom = function () {
    const next = (qbankTextZoomIndex() + 1) % QBANK_TEXT_ZOOMS.length;
    try { localStorage.setItem(QBANK_TEXT_ZOOM_KEY, String(next)); } catch (_) {}
    qbankApplyTextZoom();
    qbankToastSafe("Question text size: " + QBANK_TEXT_ZOOMS[next].label);
  };

  window.qbankToggleChromeMode = function (kind, checked) {
    const prefs = qbankGetChromePrefs();
    const b = window.__qbankBlock;
    if (b && b.active && !b.submitted) {
      qbankToastSafe("Timed / Tutor can't change while a test is in progress.", true);
      qbankRenderChrome();
      return;
    }
    if (kind === "timed") {
      prefs.mode = "exam";
      prefs.timed = !!checked;
    } else if (kind === "tutor") {
      if (checked) {
        prefs.mode = "tutor";
        prefs.timed = false;
      } else {
        prefs.mode = "exam";
        prefs.timed = true;
      }
    }
    qbankSaveChromePrefs(prefs);
    qbankRenderChrome();
  };

  window.qbankToggleSuspend = function () {
    const b = window.__qbankBlock;
    if (b && b.active) {
      if (b.submitted) return;
      if (!b.suspended) {
        b.suspended = true;
        b.pausedAt = Date.now();
        qblockTrackTime();
        qblockStopTimer();
        stopTimer();
      } else {
        const delta = Math.max(0, Date.now() - (b.pausedAt || Date.now()));
        b.startedAt += delta;
        if (b.deadline) b.deadline += delta;
        b.questionStartedAt = Date.now();
        b.suspended = false;
        b.pausedAt = 0;
        qblockStartTimer();
        startTimer(true);
      }
      qbankUpdateChromeLive();
      return;
    }
    if (!window.__qbankSessionStartedAt) return;
    if (!window.__qbankPausedAt) {
      window.__qbankPausedAt = Date.now();
      stopTimer();
    } else {
      const delta = Math.max(0, Date.now() - window.__qbankPausedAt);
      window.__qbankPausedMs = (Number(window.__qbankPausedMs) || 0) + delta;
      window.__qbankPausedAt = 0;
      questionStartTime += delta;
      startTimer(true);
    }
    qbankUpdateChromeLive();
  };

  window.qbankChromeExam = function () {
    const prefs = qbankGetChromePrefs();
    return window.qbankOpenBlockBuilder({ mode: prefs.mode, timed: prefs.timed });
  };

  window.qbankChromeFlashcard = function () {
    const q = currentQuestions[currentIndex];
    if (!q) return;
    return window.generateAIFlashcard(q.id);
  };

  window.qbankChromeFeedback = function () {
    const q = currentQuestions[currentIndex];
    if (!q) return;
    return window.qbankReportQuestion(q.id);
  };

  window.qbankChromeEndBlock = function () {
    const b = window.__qbankBlock;
    if (b && b.active && !b.submitted) {
      window.qbankSubmitBlock(false);
      return;
    }
    window.qbankEndSession();
  };

  // -------------------------- Calculator --------------------------
  function qbankCalcState() {
    if (!window.__qbankCalcState) {
      window.__qbankCalcState = { display: "0", prev: null, op: null, waiting: false };
    }
    return window.__qbankCalcState;
  }

  function qbankCalcCompute(a, z, op) {
    if (op === "+") return a + z;
    if (op === "-") return a - z;
    if (op === "*") return a * z;
    if (op === "/") return z === 0 ? NaN : a / z;
    return z;
  }

  function qbankCalcPaint() {
    const s = qbankCalcState();
    const el = document.getElementById("qbank-calc-display");
    if (el) el.textContent = s.display;
  }

  window.qbankCalcKey = function (key) {
    const s = qbankCalcState();
    const current = parseFloat(s.display) || 0;
    if (key === "C") {
      s.display = "0";
      s.prev = null;
      s.op = null;
      s.waiting = false;
      return qbankCalcPaint();
    }
    if (key === "back") {
      if (s.waiting) return;
      s.display = s.display.length > 1 ? s.display.slice(0, -1) : "0";
      if (s.display === "-") s.display = "0";
      return qbankCalcPaint();
    }
    if (key === "%") {
      s.display = String(current / 100);
      s.waiting = false;
      return qbankCalcPaint();
    }
    if (key === "±") {
      if (current === 0) return;
      s.display = String(-current);
      return qbankCalcPaint();
    }
    if (key === ".") {
      if (s.waiting) {
        s.display = "0.";
        s.waiting = false;
      } else if (!s.display.includes(".")) {
        s.display += ".";
      }
      return qbankCalcPaint();
    }
    if (key === "+" || key === "-" || key === "*" || key === "/") {
      if (s.op && !s.waiting) {
        const out = qbankCalcCompute(s.prev, current, s.op);
        s.display = Number.isFinite(out) ? String(Math.round(out * 1e10) / 1e10) : "Error";
      }
      s.prev = parseFloat(s.display);
      s.op = key;
      s.waiting = true;
      if (s.display === "Error") {
        s.display = "0";
        s.prev = 0;
      }
      return qbankCalcPaint();
    }
    if (key === "=") {
      if (!s.op) return qbankCalcPaint();
      const out = qbankCalcCompute(s.prev, current, s.op);
      s.display = Number.isFinite(out) ? String(Math.round(out * 1e10) / 1e10) : "Error";
      s.prev = null;
      s.op = null;
      s.waiting = true;
      return qbankCalcPaint();
    }
    if (/^[0-9]$/.test(key)) {
      if (s.waiting || s.display === "0" || s.display === "Error") {
        s.display = key;
        s.waiting = false;
      } else if (s.display.replace(/[-.]/g, "").length < 14) {
        s.display += key;
      }
      return qbankCalcPaint();
    }
  };

  window.qbankCalcClose = function () {
    const modal = document.getElementById("qbank-calculator-modal");
    if (modal) modal.classList.remove("is-open");
  };

  window.qbankOpenCalculator = function () {
    let modal = document.getElementById("qbank-calculator-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "qbank-calculator-modal";
      const keys = [
        { k: "C", label: "C", cls: "qbank-calc-clear" },
        { k: "back", label: "âŒ«", cls: "qbank-calc-clear" },
        { k: "%", label: "%", cls: "qbank-calc-op" },
        { k: "/", label: "Ã·", cls: "qbank-calc-op" },
        { k: "7", label: "7" }, { k: "8", label: "8" }, { k: "9", label: "9" },
        { k: "*", label: "Ã—", cls: "qbank-calc-op" },
        { k: "4", label: "4" }, { k: "5", label: "5" }, { k: "6", label: "6" },
        { k: "-", label: "âˆ’", cls: "qbank-calc-op" },
        { k: "1", label: "1" }, { k: "2", label: "2" }, { k: "3", label: "3" },
        { k: "+", label: "+", cls: "qbank-calc-op" },
        { k: "±", label: "±" }, { k: "0", label: "0" }, { k: ".", label: "." },
        { k: "=", label: "=", cls: "qbank-calc-eq" },
      ];
      modal.innerHTML = `
        <div class="qbank-calc-card" role="dialog" aria-label="Calculator">
          <div class="qbank-calc-head">
            <strong><i class="fa-solid fa-calculator"></i> Calculator</strong>
            <button type="button" class="qbank-calc-close" onclick="window.qbankCalcClose()" title="Close calculator">Ã—</button>
          </div>
          <div class="qbank-calc-display" id="qbank-calc-display">0</div>
          <div class="qbank-calc-keys">
            ${keys.map(k => `<button type="button" class="${k.cls || ""}" onclick="window.qbankCalcKey('${k.k}')">${k.label}</button>`).join("")}
          </div>
        </div>`;
      modal.addEventListener("mousedown", (e) => {
        if (e.target === modal) window.qbankCalcClose();
      });
      document.body.appendChild(modal);
    }
    modal.classList.add("is-open");
    qbankCalcPaint();
    document.addEventListener("keydown", function calcEsc(e) {
      if (e.key === "Escape") {
        window.qbankCalcClose();
        document.removeEventListener("keydown", calcEsc);
      }
    });
  };

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
  function saveQBankSession(qbankId, qbankName, subject, topicPath = null, tag = null) {
    try {
      const session = { qbankId, qbankName, subject, timestamp: Date.now() };
      if (Array.isArray(topicPath) && topicPath.length) session.topicPath = topicPath;
      if (tag) session.tag = tag;
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
      major: bundle.profileMajor || "",
      college: bundle.profileCollege || "",
      majorId: bundle.majorId || "",
      collegeId: bundle.collegeId || "",
      paidUntil: Number(bundle.paidUntil || 0),
      mainIds: Array.isArray(bundle.mainIds) ? bundle.mainIds : [],
      prepIds: Array.isArray(bundle.prepIds) ? bundle.prepIds : [],
      grants: Array.isArray(bundle.grants) ? bundle.grants : [],
      legacy: false,
    };
    const a = window.db.access;
    const isAllowed = (id) => a.legacy || a.grants.includes(id) || a.mainIds.includes(id) || a.prepIds.includes(id);
    if (window.db.selectedQBankId && !isAllowed(window.db.selectedQBankId)) {
      window.db.selectedQBankId = null;
    }
    if (!window.db.selectedQBankId && a.mainIds.length > 0) {
      window.db.selectedQBankId = a.mainIds[0];
    }
    try {
      const banksBtn = document.getElementById("qbank-banks-btn");
      if (banksBtn) {
        banksBtn.innerHTML = `<i class="fa-solid fa-layer-group text-[14px]"></i> My banks`;
        banksBtn.title = "Switch QBank";
      }
    } catch (_) {}
    if (typeof saveDb === "function") saveDb();
    window.__bootstrapPromise = Promise.resolve(a);
    window.__bootstrapCacheTime = Date.now();
    return a;
  };

  window.qbankCanOpen = function(bankId) {
    const a = window.db && window.db.access;
    if (!a) return true; // fail-open before first bootstrap
    return a.grants.includes(bankId) || a.mainIds.includes(bankId) || a.prepIds.includes(bankId);
  };

  window.qbankPaidActive = function() {
    const a = window.db && window.db.access;
    return !!(a && Number(a.paidUntil || 0) > Date.now());
  };

  window.qbankEnterLicense = function(bankId, bankName) {
    ensureRaStyles();
    const old = document.getElementById("license-modal");
    if (old) old.remove();
    const ov = document.createElement("div");
    ov.id = "license-modal";
    ov.innerHTML = `
      <div class="ra-box">
        <div class="ra-head">
          <div>
            <div class="ra-title">Enter License</div>
            <div class="ra-sub">${window.escapeHtml ? window.escapeHtml(bankName || "CuraQ paid banks") : (bankName || "CuraQ paid banks")}</div>
          </div>
          <button type="button" class="ra-close">×</button>
        </div>
        <label class="ra-label">License code</label>
        <input id="license-code-input" class="login-input" style="font-family:monospace;" placeholder="CQ-XXXX-XXXX-XXXX" autocomplete="off" />
        <div class="ra-status" id="license-status"></div>
        <div class="ra-foot">
          <button type="button" class="btn-dark-pill ra-cancel">Cancel</button>
          <button type="button" id="license-send" class="btn-action primary">Activate</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    document.body.style.overflow = "hidden";
    setTimeout(() => ov.querySelector("#license-code-input").focus(), 60);

    const close = () => { ov.remove(); document.body.style.overflow = ""; };
    ov.querySelector(".ra-close").addEventListener("click", close);
    ov.querySelector(".ra-cancel").addEventListener("click", close);
    ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });

    ov.querySelector("#license-send").addEventListener("click", async () => {
      const code = (ov.querySelector("#license-code-input").value || "").trim();
      const statusEl = ov.querySelector("#license-status");
      const sendBtn = ov.querySelector("#license-send");
      if (code.length < 8) {
        statusEl.textContent = "Enter the full license code.";
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = "Activating…";
      try {
        const token = await firebase.auth().currentUser.getIdToken();
        const res = await fetch("/api/qbank", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "redeem_license", code }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        if (data.access) window.applyAccessBundle(data.access);
        else await window.bootstrapAccess(true);
        close();
        if (typeof window.openQBankSelection === "function") await window.openQBankSelection();
        else if (typeof window.openQBank === "function") await window.openQBank();
        alert("License activated.");
      } catch (err) {
        statusEl.textContent = "";
        sendBtn.disabled = false;
        sendBtn.textContent = "Activate";
        alert("License failed: " + (err.message || err));
      }
    });
  };

  window.qbankRequestAccess = function(bankId, bankName) {
    // Styled modal (native prompt() can be suppressed by extensions/embeds)
    ensureRaStyles();
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
      </div>`;
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
        else {
          if (window.__pendingAccess instanceof Set) window.__pendingAccess.add(bankId);
          if (typeof window.__epRefresh === "function") window.__epRefresh();
        }
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
  #req-access-modal, #license-modal { position: fixed; inset: 0; z-index: 999999; background: rgba(6,25,31,0.72);
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

  body.app-light-mode #req-access-modal, body.app-light-mode #license-modal { background: rgba(10,61,74,0.45); }
  body.app-light-mode .ra-box { background: #fff; border-color: #dbe3e7; color: #0a3d4a; }
  body.app-light-mode .ra-title { color: #0a3d4a; }
  body.app-light-mode .ra-sub { color: #6b7f88; }
  body.app-light-mode .ra-box textarea { background: #fff; border-color: #dbe3e7; color: #0a3d4a; }
  `;

  function ensureRaStyles() {
    if (document.getElementById("cq-ra-styles")) return;
    const st = document.createElement("style");
    st.id = "cq-ra-styles";
    st.textContent = RA_CSS;
    document.head.appendChild(st);
  }

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
          window.qbankEnterLicense(qbankId, (meta && meta.name) || qbankId);
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
      try {
        const token = await firebase.auth().currentUser.getIdToken();
        fetch("/api/qbank", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "set_active_qbank", qbankId }),
        }).catch(() => {});
      } catch (_) {}
      await window.openQBank();
  };

  window.openQBankSelection = async function() {
    const myNav = nextNavToken();
    if (window.setQBankNav) window.setQBankNav("banks");
    if (typeof window.toggleQBankNav === "function") window.toggleQBankNav(false);
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
      // All banks are listed; the tabs below split Modules from License Exams
      // by bankType (legacy banks without bankType are License Exams).

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

      // Only banks included in the current access bundle are offered.
      const accSel = (window.db && window.db.access) || null;
      const allowedIds = accSel
        ? new Set([...(accSel.mainIds || []), ...(accSel.prepIds || []), ...(accSel.grants || [])])
        : new Set();
      const tierById = new Map(qbanks.map(q => [q.id, q.accessTier === "paid" ? "paid" : "free"]));
      const paidActive = window.qbankPaidActive ? window.qbankPaidActive() : false;

      if (qbanks.length === 0) {
        area.innerHTML = `<div style="max-width:1000px; margin:0 auto; padding:32px 24px; font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <div style="border:1px solid #F1F5F9; border-radius:6px; background:#FAFAFA; color:#64748B; text-align:center; padding:18px 14px; font-size:13px;">No QBanks are available on your account yet. Contact support or enter a license.</div>
        </div>`;
        if (window.hideGlobalLoader) window.hideGlobalLoader();
        return;
      }
      if (typeof window.__epEnsureRowStyle === "function") window.__epEnsureRowStyle();

      const isModuleBank = (q) => q && (q.bankType === "module_academic" || q.bankType === "module_clinical");
      const moduleBanks = qbanks.filter(isModuleBank);
      const licenseBanks = qbanks.filter(q => !isModuleBank(q));
      const activeTab = window.__qbankStoreTab === "exams" ? "exams" : "modules";
      const query = String(window.__qbankStoreQuery || "").trim().toLowerCase();
      const filter = window.__qbankStoreFilter || "all";
      const sort = window.__qbankStoreSort || "recent";

      const escQ = (s) => window.escapeHtml ? window.escapeHtml(s) : String(s == null ? "" : s);
      const flagMap = { usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg", morocco: "ma", saudi: "sa", global: null };
      const countryLabels = { usa: "USA", uk: "UK", australia: "Australia", canada: "Canada", india: "India", europe: "Europe", tunisia: "Tunisia", algeria: "Algeria", egypt: "Egypt", morocco: "Morocco", saudi: "Saudi Arabia", global: "International" };

      const ownedCount = (list) => list.filter(q => allowedIds.has(q.id)).length;
      const matches = (q) => {
        const tier = tierById.get(q.id) || "free";
        const owned = allowedIds.has(q.id);
        if (filter === "owned" && !owned) return false;
        if (filter === "free" && tier !== "free") return false;
        if (filter === "paid" && tier !== "paid") return false;
        if (!query) return true;
        const hay = `${q.name || ""} ${q.description || ""} ${countryLabels[q.country] || q.country || ""} ${q.college || ""}`.toLowerCase();
        return hay.includes(query);
      };
      const sorted = (list) => {
        const arr = list.filter(matches);
        if (sort === "name") arr.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
        else arr.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
        return arr;
      };
      const shown = sorted(activeTab === "modules" ? moduleBanks : licenseBanks);

      const statsHtml = `
        <div class="qb-shop-stats">
          <span class="qb-shop-stat"><b>${moduleBanks.length}</b> modules</span>
          <span class="qb-shop-stat"><b>${licenseBanks.length}</b> license exams</span>
          <span class="qb-shop-stat"><b>${ownedCount(moduleBanks) + ownedCount(licenseBanks)}</b> you own</span>
          ${paidActive ? `<span class="qb-shop-stat is-on"><i data-lucide="badge-check" style="width:13px;height:13px;"></i> paid license active</span>` : ""}
        </div>`;

      const tabBtn = (key, label, count) => `<button type="button" class="qb-shop-tab ${activeTab === key ? "is-on" : ""}" onclick="window.qbankStoreTab('${key}')">${label}<span class="qb-shop-tab-count">${count}</span></button>`;
      const chipBtn = (key, label) => `<button type="button" class="qb-shop-chip ${filter === key ? "is-on" : ""}" onclick="window.qbankStoreFilter('${key}')">${label}</button>`;

      const tool = activeTab === "modules" ? "modules" : "exams";
      let html = `<style>
        .qb-shop{max-width:1200px;margin:0 auto;padding:28px 24px 60px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
        .qb-shop-hero{background:linear-gradient(135deg,#063b44 0%,#0a5a63 55%,#0e7c86 100%);border-radius:18px;padding:28px 30px;color:#fff;display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap}
        .qb-shop-hero h2{margin:0;font-size:26px;font-weight:800;letter-spacing:-0.02em}
        .qb-shop-hero p{margin:8px 0 0;font-size:14px;color:rgba(255,255,255,.82);max-width:56ch;line-height:1.55}
        .qb-shop-enter{white-space:nowrap;background:#fff;color:#0a5a63;border:none;padding:13px 20px;border-radius:10px;font:inherit;font-size:14px;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;gap:8px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
        .qb-shop-enter:hover{background:#e6fbfc}
        .qb-shop-stats{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0 18px}
        .qb-shop-stat{background:#fff;border:1px solid #E2E8F0;border-radius:999px;padding:7px 13px;font-size:12.5px;color:#475569;display:inline-flex;align-items:center;gap:6px}
        .qb-shop-stat b{color:#0F172A}
        .qb-shop-stat.is-on{background:#e6f2f2;border-color:#9ed3d3;color:#007a7a;font-weight:700}
        .qb-shop-bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:22px}
        .qb-shop-tabs{display:flex;gap:8px;background:#EEF2F7;border:1px solid #E2E8F0;border-radius:12px;padding:4px}
        .qb-shop-tab{border:none;background:transparent;padding:9px 16px;border-radius:9px;font:inherit;font-size:13.5px;font-weight:800;color:#64748B;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
        .qb-shop-tab.is-on{background:#fff;color:#007a7a;box-shadow:0 1px 3px rgba(15,23,42,.12)}
        .qb-shop-tab-count{background:#E2E8F0;color:#475569;font-size:11px;font-weight:800;padding:1px 7px;border-radius:999px}
        .qb-shop-tab.is-on .qb-shop-tab-count{background:#e6f2f2;color:#007a7a}
        .qb-shop-search{flex:1;min-width:220px;display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:0 12px;height:42px}
        .qb-shop-search i{color:#94A3B8;font-size:14px}
        .qb-shop-search input{flex:1;border:none;outline:none;font:inherit;font-size:13.5px;color:#0F172A;background:transparent}
        .qb-shop-chips{display:flex;gap:6px}
        .qb-shop-chip{border:1px solid #E2E8F0;background:#fff;color:#475569;border-radius:999px;padding:8px 13px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}
        .qb-shop-chip.is-on{background:#007a7a;border-color:#007a7a;color:#fff}
        .qb-shop-select{height:42px;border:1px solid #E2E8F0;border-radius:10px;background:#fff;font:inherit;font-size:13px;color:#334155;padding:0 10px;cursor:pointer}
        .qb-shop-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:20px}
        .qb-card{background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 1px 2px rgba(15,23,42,.05);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
        .qb-card:hover{transform:translateY(-3px);box-shadow:0 14px 34px rgba(15,23,42,.10);border-color:#CBD5E1}
        .qb-card.is-active{border-color:#007a7a;box-shadow:0 0 0 2px rgba(0,122,122,.15)}
        .qb-card-cover{position:relative;aspect-ratio:4/3;background:#E2E8F0;overflow:hidden}
        .qb-card-cover img{width:100%;height:100%;object-fit:cover;display:block}
        .qb-card-cover-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.92)}
        .qb-card-cover-fallback svg,.qb-card-cover-fallback i{width:48px;height:48px}
        .qb-card-kind{position:absolute;top:10px;left:10px;background:rgba(6,25,31,.72);color:#fff;font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;padding:5px 9px;border-radius:999px}
        .qb-card-flag{position:absolute;bottom:10px;right:10px;background:rgba(255,255,255,.92);border-radius:6px;padding:4px 6px;display:flex;align-items:center;gap:5px;font-size:11px;font-weight:800;color:#334155}
        .qb-card-flag img{width:20px;height:auto;border-radius:3px}
        .qb-card-status{position:absolute;top:10px;right:10px;font-size:11px;font-weight:800;padding:5px 10px;border-radius:999px}
        .qb-card-status.is-active{background:#007a7a;color:#fff}
        .qb-card-status.is-owned{background:#fff;color:#007a7a}
        .qb-card-status.is-paid{background:#FEF3C7;color:#B45309}
        .qb-new{position:absolute;bottom:10px;left:10px;background:#F59E0B;color:#fff;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:4px 8px;border-radius:999px}
        .qb-card-body{padding:16px;display:flex;flex-direction:column;gap:8px;flex:1}
        .qb-card-title{margin:0;font-size:16px;font-weight:800;color:#0F172A;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:44px}
        .qb-card-desc{font-size:12.5px;color:#475569;line-height:1.55;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;min-height:58px}
        .qb-card-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:#64748B}
        .qb-card-meta .dot{opacity:.5}
        .qb-card-price{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:8px;border-top:1px solid #F1F5F9}
        .qb-card-price-label{font-size:15px;font-weight:800;color:#0F172A}
        .qb-card-price-sub{font-size:11px;color:#64748B;font-weight:600}
        .qb-card-cta{margin-top:12px}
        .qb-btn{width:100%;min-height:44px;border:none;border-radius:10px;font:inherit;font-size:13.5px;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px}
        .qb-btn-primary{background:#007a7a;color:#fff}
        .qb-btn-primary:hover{background:#006666}
        .qb-btn-warn{background:#FEF3C7;color:#B45309}
        .qb-btn-warn:hover{background:#FDE68A}
        .qb-btn-on{background:#e6f2f2;color:#007a7a;cursor:default}
        .qb-shop-empty{background:#fff;border:1px dashed #CBD5E1;border-radius:14px;padding:44px 24px;text-align:center;color:#64748B}
        .qb-shop-empty i{font-size:34px;color:#94A3B8}
        .qb-shop-empty p{font-size:14px;margin:10px 0 0}
        @media (max-width:640px){.qb-shop{padding:18px 14px 44px}.qb-shop-hero h2{font-size:22px}.qb-card-title{min-height:0}}
      </style>
      <div class="qb-shop">
        <div class="qb-shop-hero">
          <div>
            <h2>QBank Shop</h2>
            <p>Buy modules for your major and college, or unlock license exams. Buy with a license code, then build tests in one tap.</p>
          </div>
          <button class="qb-shop-enter" onclick="window.qbankEnterLicense()"><i data-lucide="key-round" style="width:16px;height:16px;"></i> Enter license</button>
        </div>
        ${statsHtml}
        <div class="qb-shop-bar">
          <div class="qb-shop-tabs">${tabBtn("modules", "Modules", moduleBanks.length)}${tabBtn("exams", "License Exams", licenseBanks.length)}</div>
          <div class="qb-shop-search"><i data-lucide="search"></i><input id="qb-shop-search" type="search" placeholder="Search modules or exams…" value="${escQ(window.__qbankStoreQuery || "")}" oninput="window.qbankStoreSearch(this.value)"></div>
          <div class="qb-shop-chips">${chipBtn("all", "All")}${chipBtn("owned", "Owned")}${chipBtn("free", "Free")}${chipBtn("paid", "Paid")}</div>
          <select class="qb-shop-select" onchange="window.qbankStoreSort(this.value)">
            <option value="recent" ${sort === "recent" ? "selected" : ""}>Recently updated</option>
            <option value="name" ${sort === "name" ? "selected" : ""}>Name A–Z</option>
          </select>
        </div>`;

      const kindBadge = (q) => isModuleBank(q)
        ? `<span class="qb-card-kind">${q.bankType === "module_clinical" ? "Clinical module" : "Academic module"}</span>`
        : `<span class="qb-card-kind">License exam</span>`;

      html += `<div class="qb-shop-grid">`;
      if (!shown.length) {
        html += `<div class="qb-shop-empty" style="grid-column:1/-1;"><i data-lucide="package-open"></i><p>${query || filter !== "all" ? "Nothing matches your search. Try another name or clear the filters." : (activeTab === "modules" ? "No modules for your major or college yet. New modules appear here once published." : "No license exams available yet. Contact support or enter a license.")}</p></div>`;
      }

      for (const q of shown) {
        const countryCode = flagMap[q.country];
        const countryName = countryLabels[q.country] || q.country || "";
        const cached = cachedQBanks[q.id];
        const qCount = cached ? (cached.questions || []).length : 0;
        const owned = allowedIds.has(q.id);
        const tier = tierById.get(q.id) || "free";
        const locked = !owned;
        const active = owned && (window.db && window.db.selectedQBankId) === q.id;
        const isNew = Date.now() - (Number(q.updatedAt) || 0) < 14 * 24 * 3600 * 1000;
        const safeQName = String(q.name || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const price = locked
          ? (q.priceLabel || "Paid")
          : (q.priceLabel || (tier === "paid" ? "Included" : "Free"));
        const priceSub = active ? "Active now" : owned ? "In your library" : (tier === "paid" ? "One license unlocks it" : "Open now");
        const statusChip = active
          ? `<span class="qb-card-status is-active">Active</span>`
          : owned
            ? `<span class="qb-card-status is-owned">Owned</span>`
            : tier === "paid"
              ? `<span class="qb-card-status is-paid">Paid</span>`
              : "";
        const cta = active
          ? `<button type="button" class="qb-btn qb-btn-on" data-cta-bank="${q.id}"><i data-lucide="check-circle-2" style="width:15px;height:15px;"></i> Active bank</button>`
          : locked
            ? `<button type="button" class="qb-btn qb-btn-warn" data-cta-bank="${q.id}" onclick="event.stopPropagation(); window.qbankEnterLicense('${q.id}','${safeQName}')"><i data-lucide="key-round" style="width:15px;height:15px;"></i> Enter license</button>`
            : `<button type="button" class="qb-btn qb-btn-primary" data-cta-bank="${q.id}" onclick="event.stopPropagation(); window.selectQBank('${q.id}')"><span>Open &amp; create test</span><i data-lucide="arrow-right" style="width:15px;height:15px;"></i></button>`;
        const fallbackBg = isModuleBank(q)
          ? "background:linear-gradient(135deg,#007a7a,#00a8a8)"
          : "background:linear-gradient(135deg,#0a3d4a,#1b5e86)";
        const fallbackIcon = isModuleBank(q) ? "book-open" : "graduation-cap";
        const newChip = isNew ? `<span class="qb-new">New</span>` : "";
        const cover = q.coverUrl
          ? `<div class="qb-card-cover"><img src="${escQ(q.coverUrl)}" alt="${escQ(q.name)}" loading="lazy">${kindBadge(q)}${statusChip}${newChip}</div>`
          : `<div class="qb-card-cover"><div class="qb-card-cover-fallback" style="${fallbackBg}"><i data-lucide="${fallbackIcon}"></i></div>${kindBadge(q)}${statusChip}${newChip}</div>`;
        const meta = `${countryCode ? `<img src="https://flagcdn.com/${countryCode}.svg" alt="" style="width:16px;height:auto;border-radius:2px;vertical-align:-3px;"> ` : ""}${escQ(countryName)}${qCount ? ` <span class="dot">·</span> ${qCount.toLocaleString()} questions` : ""}${q.college ? ` <span class="dot">·</span> ${escQ(q.college)}` : ""}`;

        html += `
          <article class="qb-card ${active ? "is-active" : ""}">
            ${cover}
            <div class="qb-card-body">
              <h3 class="qb-card-title">${escQ(q.name)}</h3>
              <div class="qb-card-desc">${q.description ? escQ(q.description) : (activeTab === "modules" ? (q.bankType === "module_clinical" ? "Clinical module — Objective, System, Topic." : "Academic module — Objective, Subject, Topic.") : "License exam — organ system, clinical specialty and sub-topic format.")}</div>
              <div class="qb-card-meta">${meta}</div>
              <div class="qb-card-price">
                <div><div class="qb-card-price-label">${escQ(price)}</div><div class="qb-card-price-sub">${priceSub}</div></div>
                ${countryCode ? `<span class="qb-card-flag" style="position:static;"><img src="https://flagcdn.com/${countryCode}.svg" alt="">${escQ(countryName)}</span>` : ""}
              </div>
              <div class="qb-card-cta">${cta}</div>
            </div>
          </article>`;
      }

      html += `</div></div>`;
      window.qbankStoreTab = function(tab) {
        window.__qbankStoreTab = tab;
        window.openQBankSelection();
      };
      window.qbankStoreFilter = function(f) {
        window.__qbankStoreFilter = f;
        window.openQBankSelection();
      };
      window.qbankStoreSort = function(s) {
        window.__qbankStoreSort = s;
        window.openQBankSelection();
      };
      window.qbankStoreSearch = function(v) {
        window.__qbankStoreQuery = v;
        clearTimeout(window.__qbankStoreSearchT);
        const pos = document.getElementById("qb-shop-search");
        const cursor = pos ? pos.selectionStart : null;
        const next = String(v || "");
        window.__qbankStoreSearchT = setTimeout(() => {
          window.openQBankSelection().then(() => {
            const el = document.getElementById("qb-shop-search");
            if (el) {
              el.focus();
              if (cursor != null && (el.value || "") === next) { try { el.setSelectionRange(cursor, cursor); } catch (_) {} }
            }
          });
        }, 300);
      };
      area.innerHTML = html;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      if (window.hideGlobalLoader) window.hideGlobalLoader();
    } catch (e) {
      area.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);">Failed to load QBanks: ${e.message}</div>`;
      if (window.hideGlobalLoader) window.hideGlobalLoader();
    }
  };

  // --- Student home: saved college + one-tap exam prep ---
  const CQ_COLLEGE_KEY = "curaq_student_college_v1";
  const CQ_COUNTRY_LABELS = { usa: "USA", uk: "UK", australia: "Australia", canada: "Canada", india: "India", europe: "Europe", tunisia: "Tunisia", algeria: "Algeria", egypt: "Egypt", morocco: "Morocco", saudi: "Saudi Arabia", global: "International" };
  const CQ_FLAG_CODES = { usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg", morocco: "ma", saudi: "sa", global: "un" };

  function cqEsc(s) {
    const base = window.escapeHtml ? window.escapeHtml(s) : String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    return String(base).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function cqJsArg(s) {
    return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, "\\x22").replace(/\r?\n/g, " ");
  }
  function cqPrepBanks() {
    let list = (cachedCategories || []).filter(q => q && q.kind === "exam_prep");
    if (!list.length && Array.isArray(window.__epBanks)) list = window.__epBanks.filter(q => q && q.kind === "exam_prep");
    return list;
  }

  window.cqHomeSearchTerm = function (term) {
    const input = document.getElementById("cq-home-search-input");
    if (!input) return;
    input.value = String(term == null ? "" : term);
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  window.cqGetSavedCollege = function () {
    try {
      const saved = JSON.parse(localStorage.getItem(CQ_COLLEGE_KEY) || "null");
      if (saved && saved.country && saved.college) return saved;
    } catch (_) {}
    return null;
  };

  window.cqSetSavedCollege = function (country, college) {
    try {
      if (!country || !college) return;
      localStorage.setItem(CQ_COLLEGE_KEY, JSON.stringify({ country: String(country), college: String(college), savedAt: Date.now() }));
    } catch (_) {}
  };

  window.cqCloseCollegePicker = function () {
    const modal = document.getElementById("cq-college-modal");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    const prev = modal.dataset.prevOverflow;
    document.documentElement.style.overflow = prev || "";
    delete modal.dataset.prevOverflow;
    const trigger = window.__cqCollegeTrigger;
    window.__cqCollegeTrigger = null;
    if (trigger && trigger.focus && document.body.contains(trigger)) trigger.focus();
  };

  window.cqOpenCollegePicker = function (country) {
    const modal = document.getElementById("cq-college-modal");
    if (!modal) return;
    window.__cqCollegeTrigger = document.activeElement;
    if (modal.hidden) modal.dataset.prevOverflow = document.documentElement.style.overflow || "";
    modal.hidden = false;
    document.documentElement.style.overflow = "hidden";
    window.cqRenderCollegePicker(country || null);
    setTimeout(() => {
      const focusEl = modal.querySelector("[data-cq-autofocus]") || modal.querySelector("button");
      if (focusEl) focusEl.focus();
    }, 30);
  };

  window.cqRenderCollegePicker = function (country) {
    const body = document.getElementById("cq-college-body");
    const title = document.getElementById("cq-college-title");
    const sub = document.getElementById("cq-college-sub");
    if (!body || !title) return;

    const prep = cqPrepBanks();
    const byCountry = {};
    prep.forEach(q => {
      const c = q.country || "global";
      if (!byCountry[c]) byCountry[c] = [];
      byCountry[c].push(q);
    });

    if (!country) {
      title.textContent = "Choose your country";
      if (sub) sub.textContent = "Then pick your college. We will remember it for next time.";
      const countries = Object.keys(byCountry).sort((a, b) => (byCountry[b].length - byCountry[a].length) || a.localeCompare(b));
      if (!countries.length) {
        body.innerHTML = `<div class="cq-inline-empty">No past exams have been added yet. Check back soon.</div>`;
        return;
      }
      body.innerHTML = `<div class="cq-country-grid">` + countries.map(c => {
        const cols = new Set(byCountry[c].map(q => q.college || "General"));
        const code = CQ_FLAG_CODES[c] || "un";
        return `<button type="button" class="cq-pick-country" data-cq-autofocus onclick="window.cqRenderCollegePicker('${cqJsArg(c)}')">
          <img src="https://flagcdn.com/${code}.svg" alt="" class="cq-pick-flag">
          <span class="cq-pick-text"><b>${cqEsc(CQ_COUNTRY_LABELS[c] || c)}</b><small><b>${cols.size}</b> <span>${cols.size === 1 ? "college" : "colleges"}</span> <span class="cq-sep">·</span> <b>${byCountry[c].length}</b> <span>${byCountry[c].length === 1 ? "exam" : "exams"}</span></small></span>
          <i data-lucide="chevron-right" class="cq-pick-chev"></i>
        </button>`;
      }).join("") + `</div>`;
    } else {
      const list = byCountry[country] || [];
      const byCollege = {};
      list.forEach(q => {
        const col = q.college || "General";
        if (!byCollege[col]) byCollege[col] = [];
        byCollege[col].push(q);
      });
      const code = CQ_FLAG_CODES[country] || "un";
      const cLabel = CQ_COUNTRY_LABELS[country] || country;
      title.textContent = "Choose your college";
      if (sub) sub.textContent = "Pick once. We will open this college's past exams for you.";
      const cols = Object.keys(byCollege).sort((a, b) => a.localeCompare(b));
      if (!cols.length) {
        body.innerHTML = `
          <button type="button" class="cq-back-link" onclick="window.cqRenderCollegePicker(null)">
            <i data-lucide="arrow-left"></i> All countries
          </button>
          <div class="cq-current-country">
            <img src="https://flagcdn.com/${code}.svg" alt="" class="cq-pick-flag">
            <b>${cqEsc(cLabel)}</b>
          </div>
          <div class="cq-inline-empty">No past exams in this country yet. Please check back soon.</div>`;
        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
        return;
      }
      body.innerHTML = `
        <button type="button" class="cq-back-link" onclick="window.cqRenderCollegePicker(null)">
          <i data-lucide="arrow-left"></i> All countries
        </button>
        <div class="cq-current-country">
          <img src="https://flagcdn.com/${code}.svg" alt="" class="cq-pick-flag">
          <b>${cqEsc(cLabel)}</b>
          <span><b>${cols.length}</b> <span>${cols.length === 1 ? "college" : "colleges"}</span></span>
        </div>
        <div class="cq-college-list">
          ${cols.map(col => {
            const n = byCollege[col].length;
            return `<button type="button" class="cq-pick-college" data-cq-autofocus onclick="window.cqChooseCollege('${cqJsArg(country)}', '${cqJsArg(col)}')">
              <span class="cq-college-ic"><i data-lucide="school"></i></span>
              <span class="cq-pick-text"><b>${cqEsc(col)}</b><small><b>${n}</b> <span>${n === 1 ? "past exam" : "past exams"}</span> <span class="cq-sep">·</span> ${cqEsc(cLabel)}</small></span>
              <i data-lucide="chevron-right" class="cq-pick-chev"></i>
            </button>`;
          }).join("")}
        </div>`;
    }
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.cqChooseCollege = function (country, college) {
    window.__cqCollegeTrigger = null;
    window.cqSetSavedCollege(country, college);
    window.cqCloseCollegePicker();
    window.openExamPrepForCollege(country, college);
  };

  window.cqOpenSavedCollege = function () {
    const saved = window.cqGetSavedCollege();
    if (!saved) {
      window.cqOpenCollegePicker();
      return;
    }
    window.openExamPrepForCollege(saved.country, saved.college);
  };

  if (!window.__cqCollegeEscBound) {
    window.__cqCollegeEscBound = true;
    document.addEventListener("keydown", function (e) {
      const modal = document.getElementById("cq-college-modal");
      if (!modal || modal.hidden) return;
      if (e.key === "Escape") {
        window.cqCloseCollegePicker();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = [...modal.querySelectorAll("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")].filter(el => el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  // --- Study blocks: 40-question timed/tutor sessions ---
  const QBLOCK_CSS = `
    #qbank-block-bar { position: sticky; top: 8px; z-index: 20; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; width: min(1360px, calc(100% - 40px)); margin: 12px auto 0; padding: 10px 12px; background: #FFFFFF; border: 1px solid #DCE7E7; border-radius: 12px; box-shadow: 0 4px 14px rgba(15, 23, 42, 0.08); color: #0F172A; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; box-sizing: border-box; }
    .qb-block-left, .qb-block-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .qb-block-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 10px; border-radius: 999px; background: #E6F2F2; color: #006B6B; font-size: 11px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
    .qb-block-meta { font-size: 12.5px; font-weight: 600; color: #425C5C; white-space: nowrap; }
    .qb-block-meta b { color: #0F172A; }
    .qb-block-clock { display: inline-flex; align-items: center; gap: 5px; min-height: 30px; padding: 0 10px; border-radius: 8px; background: #F1F5F9; border: 1px solid #E2E8F0; color: #0F172A; font-size: 12.5px; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .qb-block-clock.warn { background: #FEF2F2; border-color: #FECACA; color: #B91C1C; }
    .qb-block-btn { min-height: 38px; padding: 0 12px; border: 1px solid #DCE7E7; border-radius: 8px; background: #FFFFFF; color: #0F172A; font: inherit; font-size: 12.5px; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer; white-space: nowrap; }
    .qb-block-btn svg { width: 15px; height: 15px; }
    .qb-block-btn.primary { background: #007A7A; border-color: #007A7A; color: #FFFFFF; }
    .qb-block-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    #qbank-block-bar button:focus-visible { outline: 3px solid #007A7A; outline-offset: 2px; }
    html.dark #qbank-block-bar, body.dark-exam #qbank-block-bar { background: #10191C; border-color: #1F2E33; color: #EAF2F4; box-shadow: none; }
    html.dark .qb-block-chip, body.dark-exam .qb-block-chip { background: #123A3F; color: #7ADDE4; }
    html.dark .qb-block-meta, body.dark-exam .qb-block-meta { color: #C1D1D6; }
    html.dark .qb-block-meta b, body.dark-exam .qb-block-meta b { color: #EAF2F4; }
    html.dark .qb-block-clock, body.dark-exam .qb-block-clock { background: #0B1416; border-color: #1F2E33; color: #EAF2F4; }
    html.dark .qb-block-clock.warn, body.dark-exam .qb-block-clock.warn { background: rgba(244, 63, 94, 0.14); border-color: rgba(244, 63, 94, 0.35); color: #FDA4AF; }
    html.dark .qb-block-btn, body.dark-exam .qb-block-btn { background: #10191C; border-color: #1F2E33; color: #EAF2F4; }
    html.dark .qb-block-btn.primary, body.dark-exam .qb-block-btn.primary { background: #45C9D2; border-color: #45C9D2; color: #071A1D; }
    @media (hover: hover) { .qb-block-btn:hover { border-color: #007A7A; color: #007A7A; } .qb-block-btn.primary:hover { background: #005F5F; border-color: #005F5F; color: #FFFFFF; } }

    .qbb-page { --qb-ink: var(--text-primary, #0F172A); --qb-muted: var(--text-muted, #64748B); --qb-line: var(--border-color, #E2E8F0); --qb-card: var(--surface-color, #FFFFFF); width: 100%; max-width: 980px; margin: 0 auto; padding: 26px 20px 80px; color: var(--qb-ink); font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; box-sizing: border-box; }
    .qbb-page *, .qbb-page *::before, .qbb-page *::after { box-sizing: border-box; }
    .qbb-top { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
    .qbb-back { min-height: 42px; padding: 0 14px; border: 1px solid var(--qb-line); border-radius: 999px; background: var(--qb-card); color: var(--qb-ink); font: inherit; font-size: 13px; font-weight: 700; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
    .qbb-kicker { font-size: 11px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: #007A7A; }
    .qbb-title { margin: 0 0 6px; font-size: clamp(26px, 4vw, 34px); line-height: 1.08; letter-spacing: -0.025em; font-weight: 800; }
    .qbb-sub { margin: 0 0 20px; max-width: 64ch; color: var(--qb-muted); font-size: 14px; line-height: 1.55; }
    .qbb-layout { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 14px; align-items: start; }
    .qbb-card { padding: 18px; background: var(--qb-card); border: 1px solid var(--qb-line); border-radius: 14px; }
    .qbb-card.wide { grid-column: 1 / -1; }
    .qbb-card h2 { margin: 0 0 4px; font-size: 15px; font-weight: 800; color: var(--qb-ink); }
    .qbb-card .qbb-help { margin: 0 0 12px; color: var(--qb-muted); font-size: 12px; line-height: 1.45; }
    .qbb-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .qbb-mode { position: relative; min-height: 112px; padding: 14px; border: 1.5px solid var(--qb-line); border-radius: 12px; background: var(--qb-card); color: var(--qb-ink); font: inherit; text-align: left; cursor: pointer; display: flex; flex-direction: column; gap: 5px; }
    .qbb-mode b { font-size: 14px; }
    .qbb-mode small { color: var(--qb-muted); font-size: 11.5px; line-height: 1.4; }
    .qbb-mode .qbb-mode-ic { width: 32px; height: 32px; border-radius: 9px; background: #E6F2F2; color: #007A7A; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 3px; }
    .qbb-mode .qbb-mode-ic svg { width: 17px; height: 17px; }
    .qbb-mode.on { border-color: #007A7A; background: #F2FAFA; box-shadow: 0 0 0 1px #007A7A inset; }
    .qbb-mode.on::after { content: "âœ“"; position: absolute; top: 10px; right: 11px; width: 20px; height: 20px; border-radius: 50%; background: #007A7A; color: #fff; font-size: 12px; line-height: 20px; text-align: center; font-weight: 800; }
    .qbb-pills { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 10px; }
    .qbb-pill { min-height: 40px; padding: 0 13px; border: 1px solid var(--qb-line); border-radius: 9px; background: var(--qb-card); color: var(--qb-ink); font: inherit; font-size: 13px; font-weight: 800; cursor: pointer; }
    .qbb-pill.on { background: #007A7A; border-color: #007A7A; color: #FFFFFF; }
    .qbb-field { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; color: var(--qb-muted); font-size: 12px; font-weight: 600; }
    .qbb-input { width: 86px; min-height: 40px; padding: 0 10px; border: 1px solid var(--qb-line); border-radius: 9px; background: var(--qb-card); color: var(--qb-ink); font: inherit; font-size: 14px; font-weight: 700; }
    .qbb-input:focus { outline: 3px solid rgba(0, 122, 122, 0.18); border-color: #007A7A; }
    .qbb-input:disabled { opacity: 0.5; }
    .qbb-select { width: 100%; min-height: 44px; padding: 0 12px; border: 1px solid var(--qb-line); border-radius: 9px; background: var(--qb-card); color: var(--qb-ink); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
    .qbb-select:focus { outline: 3px solid rgba(0, 122, 122, 0.18); border-color: #007A7A; }
    html.dark .qbb-select, body.dark-exam .qbb-select { background: #10191C; border-color: #1F2E33; color: #EAF2F4; }
    .qbb-switch { display: inline-flex; padding: 3px; border: 1px solid var(--qb-line); border-radius: 10px; background: #F8FAFC; gap: 3px; }
    .qbb-switch button { min-height: 34px; padding: 0 11px; border: 0; border-radius: 7px; background: transparent; color: var(--qb-muted); font: inherit; font-size: 12px; font-weight: 800; cursor: pointer; }
    .qbb-switch button.on { background: var(--qb-card); color: #007A7A; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    .qbb-chips { display: flex; gap: 7px; flex-wrap: wrap; max-height: 190px; overflow-y: auto; padding: 2px; }
    .qbb-chip { min-height: 38px; padding: 0 12px; border: 1px solid var(--qb-line); border-radius: 999px; background: var(--qb-card); color: var(--qb-ink); font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
    .qbb-chip span { color: var(--qb-muted); font-size: 10.5px; font-weight: 800; }
    .qbb-chip.on { background: #E6F2F2; border-color: #9CCFCF; color: #006B6B; }
    .qbb-chip.on span { color: #007A7A; }
    .qbb-topic-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
    .qbb-topic-toolbar span { color: var(--qb-muted); font-size: 11.5px; font-weight: 600; }
    .qbb-topic-clear { min-height: 30px; padding: 0 10px; border: 1px solid var(--qb-line); border-radius: 999px; background: var(--qb-card); color: var(--qb-ink); font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; }
    .qbb-topics { max-height: 280px; overflow-y: auto; padding: 5px; border: 1px solid var(--qb-line); border-radius: 11px; background: #F8FAFC; }
    .qbb-topic-row { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 5px 8px; border-radius: 7px; color: var(--qb-ink); font-size: 12.5px; font-weight: 600; cursor: pointer; }
    .qbb-topic-row:hover { background: rgba(0, 122, 122, 0.06); }
    .qbb-topic-row.dim { opacity: 0.38; }
    .qbb-topic-check { width: 15px; height: 15px; flex: 0 0 auto; accent-color: #007A7A; cursor: pointer; }
    .qbb-topic-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qbb-topic-count { margin-left: auto; color: var(--qb-muted); font-size: 10.5px; font-weight: 800; }
    .qbb-available { margin: 9px 0 0; color: var(--qb-muted); font-size: 11.5px; }
    .qbb-available b { color: var(--qb-ink); }
    .qbb-summary { position: sticky; bottom: 12px; display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 16px; padding: 14px 16px; border: 1px solid #CBE3E3; border-radius: 14px; background: rgba(255, 255, 255, 0.96); box-shadow: 0 12px 32px rgba(15, 23, 42, 0.12); backdrop-filter: blur(8px); }
    .qbb-summary b { display: block; font-size: 15px; color: var(--qb-ink); }
    .qbb-summary span { display: block; margin-top: 2px; color: var(--qb-muted); font-size: 12px; }
    .qbb-start { min-height: 50px; padding: 0 22px; border: 1px solid #007A7A; border-radius: 10px; background: #007A7A; color: #FFFFFF; font: inherit; font-size: 14px; font-weight: 800; cursor: pointer; white-space: nowrap; }
    .qbb-start:disabled { opacity: 0.5; cursor: not-allowed; }
    .qbb-check { display: inline-flex; align-items: center; gap: 7px; margin-top: 10px; color: var(--qb-muted); font-size: 12px; font-weight: 600; cursor: pointer; }
    .qbb-check input { width: 17px; height: 17px; accent-color: #007A7A; }
    .qbb-page button:focus-visible, .qbb-page input:focus-visible { outline: 3px solid #007A7A; outline-offset: 2px; }
    .qbr-wrap { max-width: 780px; margin: 0 auto; padding: 28px 20px 60px; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--text-primary, #0F172A); }
    .qbr-hero { padding: 24px; text-align: center; border: 1px solid var(--border-color, #E2E8F0); border-radius: 18px; background: var(--surface-color, #FFFFFF); }
    .qbr-score { display: inline-flex; align-items: center; justify-content: center; width: 118px; height: 118px; margin: 4px auto 12px; border-radius: 50%; background: #E6F2F2; color: #006B6B; font-size: 34px; font-weight: 800; letter-spacing: -0.04em; }
    .qbr-hero h2 { margin: 0 0 4px; font-size: 24px; font-weight: 800; }
    .qbr-hero p { margin: 0; color: var(--text-muted, #64748B); font-size: 13px; }
    .qbr-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; margin: 14px 0; }
    .qbr-stat { padding: 12px; border: 1px solid var(--border-color, #E2E8F0); border-radius: 11px; background: var(--surface-color, #FFFFFF); text-align: center; }
    .qbr-stat b { display: block; font-size: 22px; line-height: 1.1; }
    .qbr-stat small { color: var(--text-muted, #64748B); font-size: 10.5px; }
    .qbr-actions { display: flex; gap: 9px; flex-wrap: wrap; justify-content: center; margin-top: 16px; }
    .qbr-btn { min-height: 48px; padding: 0 18px; border: 1px solid var(--border-color, #E2E8F0); border-radius: 10px; background: var(--surface-color, #FFFFFF); color: var(--text-primary, #0F172A); font: inherit; font-size: 13.5px; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; }
    .qbr-btn.primary { background: #007A7A; border-color: #007A7A; color: #FFF; }
    @media (max-width: 760px) { .qbb-layout { grid-template-columns: 1fr; } .qbb-card.wide { grid-column: auto; } .qbb-modes { grid-template-columns: 1fr; } .qbr-grid { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 520px) { .qbb-page { padding: 18px 14px 70px; } .qbb-summary { align-items: stretch; flex-direction: column; } .qbb-start { width: 100%; } .qbr-actions .qbr-btn { width: 100%; justify-content: center; } }
    html.dark .qbb-page, body.dark-exam .qbb-page, html.dark .qbr-wrap, body.dark-exam .qbr-wrap { color: #EAF2F4; }
    html.dark .qbb-card, body.dark-exam .qbb-card, html.dark .qbb-summary, body.dark-exam .qbb-summary { background: #10191C; border-color: #1F2E33; }
    html.dark .qbb-summary, body.dark-exam .qbb-summary { background: rgba(16, 25, 28, 0.96); border-color: #2E6478; box-shadow: 0 12px 32px rgba(0,0,0,.4); }
    html.dark .qbb-pill, body.dark-exam .qbb-pill, html.dark .qbb-chip, body.dark-exam .qbb-chip, html.dark .qbb-input, body.dark-exam .qbb-input, html.dark .qbb-back, body.dark-exam .qbb-back { background: #10191C; border-color: #1F2E33; color: #EAF2F4; }
    html.dark .qbb-switch, body.dark-exam .qbb-switch { background: #0B1416; border-color: #1F2E33; }
    html.dark .qbb-switch button.on, body.dark-exam .qbb-switch button.on { background: #10191C; color: #7ADDE4; }
    html.dark .qbb-pill.on, body.dark-exam .qbb-pill.on { background: #45C9D2; border-color: #45C9D2; color: #071A1D; }
    html.dark .qbb-chip.on, body.dark-exam .qbb-chip.on { background: #123A3F; border-color: #2E6478; color: #7ADDE4; }
    html.dark .qbb-topics, body.dark-exam .qbb-topics { background: #0B1416; border-color: #1F2E33; }
    html.dark .qbb-topic-row, body.dark-exam .qbb-topic-row { color: #EAF2F4; }
    html.dark .qbb-topic-row:hover, body.dark-exam .qbb-topic-row:hover { background: rgba(69, 201, 210, 0.09); }
    html.dark .qbb-topic-clear, body.dark-exam .qbb-topic-clear { background: #10191C; border-color: #1F2E33; color: #EAF2F4; }
    html.dark .qbb-topic-count, body.dark-exam .qbb-topic-count { color: #9FB3B8; }
    html.dark .qbb-mode, body.dark-exam .qbb-mode { background: #10191C; border-color: #1F2E33; color: #EAF2F4; }
    html.dark .qbb-mode.on, body.dark-exam .qbb-mode.on { background: #0F2A2E; border-color: #45C9D2; box-shadow: 0 0 0 1px #45C9D2 inset; }
    html.dark .qbb-mode.on::after, body.dark-exam .qbb-mode.on::after { background: #45C9D2; color: #071A1D; }
    html.dark .qbr-hero, body.dark-exam .qbr-hero, html.dark .qbr-stat, body.dark-exam .qbr-stat, html.dark .qbr-btn, body.dark-exam .qbr-btn { background: #10191C; border-color: #1F2E33; color: #EAF2F4; }
    html.dark .qbr-score, body.dark-exam .qbr-score { background: #123A3F; color: #7ADDE4; }
  `;

  // Block builder / block history. Kept separate from the legacy builder
  // styles above so the new screen has its own scoped design language.
  const QBLOCK_BUILDER_CSS = `
    .qbc-page, .qbh-page { --qbc-ink: var(--text-primary, #0F172A); --qbc-muted: var(--text-muted, #64748B); --qbc-line: var(--border-color, #DCE7E7); --qbc-card: var(--surface-color, #FFFFFF); --qbc-teal: #007A7A; --qbc-teal-dark: #005F5F; --qbc-teal-soft: #E6F2F2; --qbc-canvas: #F5FAFA; width: 100%; max-width: 1000px; margin: 0 auto; padding: 26px 20px 80px; color: var(--qbc-ink); font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; box-sizing: border-box; }
    #qbank-home-view:has(> #qbank-home-content > .qbc-page), #qbank-home-view:has(> #qbank-home-content > .qbh-page) { background: #F5FAFA; align-items: flex-start; }
    html.dark #qbank-home-view:has(> #qbank-home-content > .qbc-page), html.dark #qbank-home-view:has(> #qbank-home-content > .qbh-page), body.dark-exam #qbank-home-view:has(> #qbank-home-content > .qbc-page), body.dark-exam #qbank-home-view:has(> #qbank-home-content > .qbh-page) { background: #0B1416; }
    .qbc-page *, .qbc-page *::before, .qbc-page *::after, .qbh-page *, .qbh-page *::before, .qbh-page *::after { box-sizing: border-box; }
    .qbc-top, .qbh-top { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
    .qbc-back, .qbh-back { min-height: 40px; padding: 0 13px; border: 1px solid var(--qbc-line); border-radius: 9px; background: var(--qbc-card); color: var(--qbc-ink); font: inherit; font-size: 12.5px; font-weight: 700; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
    .qbc-back svg, .qbh-back svg { width: 15px; height: 15px; }
    .qbc-kicker, .qbh-kicker { font-size: 10.5px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: var(--qbc-teal); }
    .qbc-heading, .qbh-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; margin-bottom: 18px; }
    .qbc-title, .qbh-title { margin: 0 0 5px; font-size: clamp(25px, 3.4vw, 32px); line-height: 1.08; letter-spacing: -0.025em; font-weight: 800; color: var(--qbc-ink); }
    .qbc-sub, .qbh-sub { margin: 0; max-width: 60ch; font-size: 13.5px; line-height: 1.55; color: var(--qbc-muted); }
    .qbc-source-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .qbc-source-field { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 4px 6px 4px 12px; border: 1px solid var(--qbc-line); border-radius: 10px; background: var(--qbc-card); }
    .qbc-source-field span { font-size: 10px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--qbc-muted); white-space: nowrap; }
    .qbc-source-select { max-width: 280px; min-height: 34px; padding: 0 26px 0 7px; border: 0; background: transparent; color: var(--qbc-ink); font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; }
    .qbc-source-select:focus { outline: 2px solid var(--qbc-teal); outline-offset: 2px; border-radius: 5px; }
    .qbc-source-meta { font-size: 11.5px; color: var(--qbc-muted); }
    .qbc-objective-select, .qbc-filter-input { width: 100%; min-height: 38px; padding: 0 34px 0 10px; border: 1px solid var(--qbc-line); border-radius: 9px; background: var(--qbc-card); color: var(--qbc-ink); font: inherit; font-size: 12px; font-weight: 700; }
    .qbc-objective-select:focus, .qbc-filter-input:focus { outline: 2px solid var(--qbc-teal); outline-offset: 2px; }
    .qbc-objective-meta { display: flex; align-items: center; margin-top: 8px; min-height: 20px; }
    .qbc-filter-input { max-width: 280px; min-height: 31px; padding: 0 10px; border-radius: 8px; font-size: 11px; }
    .qbc-clickable-grid, .qbc-subtopic-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 14px; max-height: 280px; }
    .qbc-subtopic-grid { max-height: 240px; }
    .qbt-tabs { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--qbc-line); margin: 0 0 16px; }
    .qbt-tab { min-height: 44px; padding: 0 14px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--qbc-muted); font: inherit; font-size: 13px; font-weight: 700; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; margin-bottom: -1px; }
    .qbt-tab.is-active { color: var(--qbc-teal); border-bottom-color: var(--qbc-teal); }
    .qbt-count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--qbc-teal-soft); color: var(--qbc-teal); display: inline-flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 800; line-height: 1; }
    .qbc-panel { background: var(--qbc-card); border: 1px solid var(--qbc-line); border-radius: 16px; overflow: hidden; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 18px 40px -34px rgba(15, 23, 42, 0.22); }
    .qbc-row { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 26px; padding: 22px 24px; border-bottom: 1px solid var(--qbc-line); }
    .qbc-row-head h2 { margin: 0 0 4px; font-size: 14.5px; line-height: 1.25; font-weight: 800; color: var(--qbc-ink); }
    .qbc-row-help { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--qbc-muted); }
    .qbc-row-body { min-width: 0; }
    .qbc-row-tools { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
    .qbc-tool { min-height: 30px; padding: 0 9px; border: 1px solid var(--qbc-line); border-radius: 7px; background: var(--qbc-card); color: var(--qbc-muted); font: inherit; font-size: 10.5px; font-weight: 800; cursor: pointer; }
    .qbc-tool:hover { border-color: var(--qbc-teal); color: var(--qbc-teal); }
    .qbc-mode-seg { display: inline-flex; padding: 3px; border: 1px solid var(--qbc-line); border-radius: 10px; background: #F7FAFA; gap: 3px; }
    .qbc-mode-btn { min-height: 38px; min-width: 104px; padding: 0 16px; border: 0; border-radius: 7px; background: transparent; color: var(--qbc-muted); font: inherit; font-size: 12.5px; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
    .qbc-mode-btn svg { width: 15px; height: 15px; }
    .qbc-mode-btn.is-on { background: var(--qbc-card); color: var(--qbc-teal); box-shadow: 0 1px 3px rgba(15, 23, 42, 0.14); }
    .qbc-hint { margin: 9px 0 0; font-size: 11.5px; line-height: 1.45; color: var(--qbc-muted); }
    .qbc-mode-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .qbc-mode-card { position: relative; display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 9px 10px; border: 1px solid var(--qbc-line); border-radius: 9px; background: var(--qbc-card); color: var(--qbc-ink); cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease; }
    .qbc-mode-card.is-on { border-color: var(--qbc-teal); background: var(--qbc-teal-soft); }
    .qbc-mode-card.is-disabled { opacity: 0.45; cursor: not-allowed; }
    .qbc-mode-card input, .qbc-check input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    .qbc-box { width: 18px; height: 18px; flex: 0 0 auto; border: 1.5px solid #B7CCCC; border-radius: 4px; background: var(--qbc-card); display: inline-flex; align-items: center; justify-content: center; transition: background 0.15s ease, border-color 0.15s ease; }
    .qbc-box::after { content: ""; width: 8px; height: 4px; border-left: 2px solid #FFFFFF; border-bottom: 2px solid #FFFFFF; transform: rotate(-45deg) translateY(-1px) scale(0); transition: transform 0.12s ease; }
    .qbc-mode-card input:checked + .qbc-box, .qbc-check input:checked + .qbc-box { background: var(--qbc-teal); border-color: var(--qbc-teal); }
    .qbc-mode-card input:checked + .qbc-box::after, .qbc-check input:checked + .qbc-box::after { transform: rotate(-45deg) translateY(-1px) scale(1); }
    .qbc-mode-card:focus-within, .qbc-check:focus-within { outline: 3px solid rgba(0, 122, 122, 0.22); outline-offset: 2px; }
    .qbc-mode-name { min-width: 0; font-size: 11.5px; line-height: 1.2; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qbc-mode-count { margin-left: auto; min-width: 26px; padding: 2px 5px; border-radius: 999px; background: #F0F5F5; color: var(--qbc-muted); font-size: 9.5px; font-weight: 800; line-height: 1.35; text-align: center; }
    .qbc-mode-card.is-on .qbc-mode-count { background: rgba(0, 122, 122, 0.14); color: var(--qbc-teal); }
    .qbc-check-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 14px; }
    .qbc-check { position: relative; display: flex; align-items: center; gap: 9px; min-height: 42px; padding: 6px 8px; border: 1px solid transparent; border-radius: 8px; color: var(--qbc-ink); cursor: pointer; }
    .qbc-check:hover { background: rgba(0, 122, 122, 0.055); }
    .qbc-check.is-on { background: var(--qbc-teal-soft); border-color: #BFE0E0; }
    .qbc-check.is-empty { opacity: 0.45; }
    .qbc-check-label { min-width: 0; font-size: 12.5px; line-height: 1.35; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qbc-check-count { margin-left: auto; color: var(--qbc-muted); font-size: 10.5px; font-weight: 800; white-space: nowrap; }
    .qbc-check.is-on .qbc-check-count { color: var(--qbc-teal); }
    .qbc-systems { max-height: 320px; overflow-y: auto; padding-right: 4px; scrollbar-width: thin; }
    .qbc-taxonomy-block { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 14px; }
    .qbc-taxonomy-group { grid-column: 1 / -1; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 6px 0 4px; padding: 7px 9px; border-top: 1px solid var(--qbc-line); color: var(--qbc-ink); }
    .qbc-taxonomy-group:first-child { border-top: 0; margin-top: 0; padding-top: 2px; }
    .qbc-taxonomy-group span { font-size: 10.5px; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase; color: var(--qbc-teal); }
    .qbc-taxonomy-group small { color: var(--qbc-muted); font-size: 10px; font-weight: 600; text-align: right; }
    .qbc-check.is-subspecialty { min-height: 36px; padding-left: 20px; }
    .qbc-check.is-subspecialty .qbc-check-label { font-weight: 500; }
    .qbc-systems.is-expanded { max-height: none; overflow: visible; }
    .qbc-systems::-webkit-scrollbar { width: 8px; }
    .qbc-systems::-webkit-scrollbar-thumb { background: #C7DCDC; border-radius: 999px; }
    .qbc-empty-inline { margin: 8px 0 0; color: var(--qbc-muted); font-size: 11.5px; }
    .qbc-activefilters { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin: 0 0 14px; padding: 9px 11px; border: 1px solid #CBE3E3; border-radius: 9px; background: #F3FAFA; }
    .qbc-activefilters > span { font-size: 10px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--qbc-teal); }
    .qbc-filter-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 27px; padding: 0 8px; border: 1px solid #BFE0E0; border-radius: 7px; background: var(--qbc-card); color: var(--qbc-ink); font-size: 10.5px; font-weight: 700; }
    .qbc-filter-chip button { width: 17px; height: 17px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--qbc-muted); font: inherit; font-size: 13px; line-height: 1; cursor: pointer; }
    .qbc-filter-chip button:hover { background: #FEE2E2; color: #BE123C; }
    .qbc-count-line { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .qbc-count-input { width: 118px; height: 52px; padding: 0 12px; border: 1.5px solid var(--qbc-line); border-radius: 9px; background: var(--qbc-card); color: var(--qbc-ink); font: inherit; font-size: 21px; font-weight: 800; text-align: center; font-variant-numeric: tabular-nums; }
    .qbc-count-input:focus { outline: 3px solid rgba(0, 122, 122, 0.18); border-color: var(--qbc-teal); }
    .qbc-count-note { font-size: 12px; line-height: 1.45; color: var(--qbc-muted); }
    .qbc-count-note b { color: var(--qbc-ink); }
    .qbc-available { margin: 9px 0 0; font-size: 11.5px; color: var(--qbc-muted); }
    .qbc-available b { color: var(--qbc-ink); }
    .qbc-actionbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 18px 24px; background: linear-gradient(180deg, #FAFDFD 0%, #F2F9F9 100%); }
    .qbc-summary b { display: block; font-size: 15px; line-height: 1.25; color: var(--qbc-ink); }
    .qbc-summary span { display: block; margin-top: 3px; font-size: 11.5px; line-height: 1.4; color: var(--qbc-muted); }
    .qbc-generate { min-height: 50px; padding: 0 25px; border: 1px solid var(--qbc-teal); border-radius: 9px; background: var(--qbc-teal); color: #FFFFFF; font: inherit; font-size: 14px; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer; white-space: nowrap; }
    .qbc-generate svg { width: 16px; height: 16px; }
    .qbc-generate:disabled { opacity: 0.5; cursor: not-allowed; }
    .qbc-foot { margin: 15px 0 0; text-align: center; font-size: 11px; line-height: 1.45; color: var(--qbc-muted); }
    .qbc-loading, .qbc-error { padding: 36px 24px; text-align: center; color: var(--qbc-muted); font-size: 13px; }
    .qbc-error h2 { margin: 0 0 7px; color: var(--qbc-ink); font-size: 18px; }
    .qbc-error p { margin: 0 0 16px; }

    .qbh-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
    .qbh-stat { padding: 13px 15px; border: 1px solid var(--qbc-line); border-radius: 11px; background: var(--qbc-card); box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04); }
    .qbh-stat b { display: block; font-size: 22px; line-height: 1.1; letter-spacing: -0.02em; color: var(--qbc-ink); }
    .qbh-stat small { display: block; margin-top: 3px; font-size: 10.5px; color: var(--qbc-muted); }
    .qbh-filterbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 0 0 12px; }
    .qbh-filter { min-height: 34px; padding: 0 12px; border: 1px solid var(--qbc-line); border-radius: 8px; background: var(--qbc-card); color: var(--qbc-muted); font: inherit; font-size: 11.5px; font-weight: 700; cursor: pointer; }
    .qbh-filter.is-on { border-color: var(--qbc-teal); background: var(--qbc-teal-soft); color: var(--qbc-teal); }
    .qbh-list { display: flex; flex-direction: column; gap: 10px; }
    .qbh-card { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 15px 16px; border: 1px solid var(--qbc-line); border-radius: 13px; background: var(--qbc-card); box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04); }
    .qbh-score { width: 62px; height: 62px; border-radius: 12px; background: var(--qbc-teal-soft); color: var(--qbc-teal); display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0; }
    .qbh-score b { font-size: 19px; line-height: 1.1; letter-spacing: -0.02em; }
    .qbh-score small { margin-top: 1px; font-size: 8px; line-height: 1; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 800; opacity: 0.75; }
    .qbh-score.is-mid { background: #FFF7E6; color: #B45309; }
    .qbh-score.is-low { background: #FFF0F3; color: #BE123C; }
    .qbh-score.is-progress { background: #EFF6FF; color: #1D4ED8; }
    .qbh-main { min-width: 0; }
    .qbh-title-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 3px; }
    .qbh-title-row h2 { margin: 0; font-size: 14.5px; line-height: 1.3; font-weight: 800; color: var(--qbc-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qbh-pill { display: inline-flex; align-items: center; min-height: 20px; padding: 0 7px; border-radius: 999px; background: #F0F5F5; color: var(--qbc-muted); font-size: 9px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; white-space: nowrap; }
    .qbh-pill.is-progress { background: #EFF6FF; color: #1D4ED8; }
    .qbh-pill.is-complete { background: var(--qbc-teal-soft); color: var(--qbc-teal); }
    .qbh-meta { display: flex; align-items: center; gap: 5px 8px; flex-wrap: wrap; font-size: 11px; line-height: 1.4; color: var(--qbc-muted); }
    .qbh-meta b { color: var(--qbc-ink); font-weight: 700; }
    .qbh-meta-sep { opacity: 0.45; }
    .qbh-progress { height: 6px; margin-top: 8px; border-radius: 999px; background: #EDF3F3; overflow: hidden; max-width: 320px; }
    .qbh-progress span { display: block; height: 100%; border-radius: 999px; background: var(--qbc-teal); }
    .qbh-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .qbh-btn { min-height: 36px; padding: 0 11px; border: 1px solid var(--qbc-line); border-radius: 7px; background: var(--qbc-card); color: var(--qbc-ink); font: inherit; font-size: 11px; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
    .qbh-btn svg { width: 13px; height: 13px; }
    .qbh-btn.primary { border-color: var(--qbc-teal); background: var(--qbc-teal); color: #FFFFFF; }
    .qbh-btn.danger { color: #BE123C; }
    .qbh-btn.danger:hover { border-color: #FCA5A5; background: #FFF1F2; }
    .qbh-empty { padding: 42px 24px; text-align: center; border: 1px dashed #BFD8D8; border-radius: 14px; background: var(--qbc-card); }
    .qbh-empty-ic { width: 56px; height: 56px; margin: 0 auto 12px; border-radius: 14px; background: var(--qbc-teal-soft); color: var(--qbc-teal); display: flex; align-items: center; justify-content: center; }
    .qbh-empty-ic svg { width: 25px; height: 25px; }
    .qbh-empty h2 { margin: 0 0 5px; font-size: 18px; font-weight: 800; color: var(--qbc-ink); }
    .qbh-empty p { margin: 0 0 16px; font-size: 12.5px; color: var(--qbc-muted); }
    .qbn-list { display: flex; flex-direction: column; gap: 10px; padding: 14px; }
    .qbn-note { padding: 13px 15px; border: 1px solid var(--qbc-line); border-radius: 12px; background: var(--qbc-card); box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04); }
    .qbn-note-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 7px; }
    .qbn-code { min-height: 22px; padding: 0 8px; display: inline-flex; align-items: center; border-radius: 999px; background: var(--qbc-teal-soft); color: var(--qbc-teal); font-size: 10.5px; font-weight: 800; letter-spacing: 0.04em; }
    .qbn-meta { font-size: 11px; color: var(--qbc-muted); }
    .qbn-note-text { font-size: 13px; line-height: 1.55; color: var(--qbc-ink); white-space: pre-wrap; }
    .qbc-page button:focus-visible, .qbc-page input:focus-visible, .qbh-page button:focus-visible { outline: 3px solid rgba(0, 122, 122, 0.35); outline-offset: 2px; }
    @media (hover: hover) {
      .qbc-back:hover, .qbh-back:hover, .qbc-tool:hover, .qbh-btn:hover { border-color: var(--qbc-teal); color: var(--qbc-teal); }
      .qbc-generate:hover, .qbh-btn.primary:hover { background: var(--qbc-teal-dark); border-color: var(--qbc-teal-dark); }
      .qbc-mode-btn:hover { color: var(--qbc-teal); }
      .qbc-check:hover { border-color: #CBE3E3; }
    }
    html.dark .qbc-page, body.dark-exam .qbc-page, html.dark .qbh-page, body.dark-exam .qbh-page { --qbc-ink: #EAF2F4; --qbc-muted: #9FB3B8; --qbc-line: #1F2E33; --qbc-card: #10191C; --qbc-teal: #45C9D2; --qbc-teal-dark: #7ADDE4; --qbc-teal-soft: #123A3F; }
    html.dark .qbc-panel, body.dark-exam .qbc-panel, html.dark .qbh-card, body.dark-exam .qbh-card, html.dark .qbh-stat, body.dark-exam .qbh-stat { box-shadow: none; }
    html.dark .qbc-mode-seg, body.dark-exam .qbc-mode-seg { background: #0B1416; }
    html.dark .qbc-mode-btn.is-on, body.dark-exam .qbc-mode-btn.is-on { background: #10191C; color: #7ADDE4; box-shadow: none; }
    html.dark .qbc-box, body.dark-exam .qbc-box { border-color: #3A5A60; background: #0B1416; }
    html.dark .qbc-mode-card input:checked + .qbc-box, body.dark-exam .qbc-mode-card input:checked + .qbc-box, html.dark .qbc-check input:checked + .qbc-box, body.dark-exam .qbc-check input:checked + .qbc-box { background: #45C9D2; border-color: #45C9D2; }
    html.dark .qbc-mode-count, body.dark-exam .qbc-mode-count { background: #17272B; color: #9FB3B8; }
    html.dark .qbc-mode-card.is-on .qbc-mode-count, body.dark-exam .qbc-mode-card.is-on .qbc-mode-count { background: rgba(69, 201, 210, 0.16); color: #7ADDE4; }
    html.dark .qbc-check:hover, body.dark-exam .qbc-check:hover { background: rgba(69, 201, 210, 0.08); }
    html.dark .qbc-check.is-on, body.dark-exam .qbc-check.is-on { border-color: #2E6478; background: #123A3F; }
    html.dark .qbc-systems::-webkit-scrollbar-thumb, body.dark-exam .qbc-systems::-webkit-scrollbar-thumb { background: #2E4B51; }
    html.dark .qbc-activefilters, body.dark-exam .qbc-activefilters { background: #0D2326; border-color: #2E6478; }
    html.dark .qbc-filter-chip, body.dark-exam .qbc-filter-chip { border-color: #2E6478; }
    html.dark .qbc-actionbar, body.dark-exam .qbc-actionbar { background: linear-gradient(180deg, #0E1B1E 0%, #102426 100%); }
    html.dark .qbc-generate, body.dark-exam .qbc-generate, html.dark .qbh-btn.primary, body.dark-exam .qbh-btn.primary { color: #071A1D; }
    html.dark .qbc-filter-chip button:hover, body.dark-exam .qbc-filter-chip button:hover { background: #3B121A; color: #FDA4AF; }
    html.dark .qbh-pill, body.dark-exam .qbh-pill { background: #17272B; color: #9FB3B8; }
    html.dark .qbh-pill.is-complete, body.dark-exam .qbh-pill.is-complete { background: #123A3F; color: #7ADDE4; }
    html.dark .qbh-pill.is-progress, body.dark-exam .qbh-pill.is-progress { background: #102A3A; color: #7CC4E8; }
    html.dark .qbh-score.is-mid, body.dark-exam .qbh-score.is-mid { background: #3B2A12; color: #F0B429; }
    html.dark .qbh-score.is-low, body.dark-exam .qbh-score.is-low { background: #3B121A; color: #FDA4AF; }
    html.dark .qbh-score.is-progress, body.dark-exam .qbh-score.is-progress { background: #102A3A; color: #7CC4E8; }
    html.dark .qbh-progress, body.dark-exam .qbh-progress { background: #17272B; }
    html.dark .qbh-btn.danger, body.dark-exam .qbh-btn.danger { color: #FDA4AF; }
    html.dark .qbh-btn.danger:hover, body.dark-exam .qbh-btn.danger:hover { background: #3B121A; border-color: #7F1D1D; }
    html.dark .qbh-empty, body.dark-exam .qbh-empty { border-color: #2E4B51; }
    @media (max-width: 1000px) {
      .qbc-row { grid-template-columns: 1fr; gap: 11px; padding: 20px; }
      .qbc-mode-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 880px) {
      .qbh-stats { grid-template-columns: 1fr 1fr; }
      .qbh-card { grid-template-columns: auto minmax(0, 1fr); }
      .qbh-actions { grid-column: 1 / -1; justify-content: flex-start; padding-top: 3px; }
    }
    @media (max-width: 760px) {
      .qbc-mode-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .qbc-check-grid, .qbc-clickable-grid, .qbc-subtopic-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 620px) {
      .qbc-page, .qbh-page { padding: 18px 14px 70px; }
      .qbc-heading, .qbh-heading { align-items: flex-start; flex-direction: column; gap: 12px; }
      .qbc-source-row { width: 100%; }
      .qbc-source-field { width: 100%; }
      .qbc-source-select { max-width: calc(100% - 76px); flex: 1; }
      .qbc-row { padding: 18px 15px; }
      .qbc-mode-list { grid-template-columns: 1fr 1fr; }
      .qbc-check-grid, .qbc-clickable-grid, .qbc-subtopic-grid { grid-template-columns: 1fr; }
      .qbc-actionbar { align-items: stretch; flex-direction: column; padding: 16px 15px; }
      .qbc-generate { width: 100%; }
      .qbt-tabs { overflow-x: auto; }
      .qbt-tab { white-space: nowrap; padding: 0 11px; }
      .qbh-stats { gap: 8px; }
      .qbh-card { grid-template-columns: auto minmax(0, 1fr); padding: 13px; }
      .qbh-score { width: 54px; height: 54px; border-radius: 10px; }
      .qbh-score b { font-size: 17px; }
      .qbh-actions .qbh-btn { flex: 1 1 auto; justify-content: center; }
      .qbh-title-row h2 { white-space: normal; }
    }
    @media (max-width: 390px) {
      .qbc-mode-list { grid-template-columns: 1fr; }
      .qbh-stats { grid-template-columns: 1fr; }
      .qbh-card { grid-template-columns: 1fr; }
      .qbh-score { width: 100%; height: 44px; flex-direction: row; gap: 6px; }
      .qbh-actions { grid-column: auto; }
    }
    @media (prefers-reduced-motion: reduce) { .qbc-page *, .qbc-page *::before, .qbc-page *::after, .qbh-page *, .qbh-page *::before, .qbh-page *::after { transition: none !important; } }
  `;

  function qblockEnsureStyles() {
    if (document.getElementById("qblock-styles")) return;
    const style = document.createElement("style");
    style.id = "qblock-styles";
    style.textContent = QBLOCK_CSS + QBLOCK_BUILDER_CSS;
    document.head.appendChild(style);
  }

  function qblockActiveQuestions() {
    const id = currentQBankId || (window.db && window.db.selectedQBankId);
    const entry = id ? cachedQBanks[id] : null;
    if (entry && Array.isArray(entry.questions)) return entry.questions;
    return Array.isArray(allQuestions) ? allQuestions : [];
  }

  function qblockBankName() {
    const id = currentQBankId || (window.db && window.db.selectedQBankId);
    const meta = (cachedCategories || []).find(q => q.id === id);
    if (meta && meta.name) return meta.name;
    const el = document.getElementById("qbank-active-name");
    return el && el.textContent && el.textContent !== "None" ? el.textContent : "QBank";
  }

  function qblockSubjectOf(q) {
    const data = (q && q.data) || {};
    return data.organSystem || data.organ_system || data.subject || data.subcategory || "Uncategorized";
  }

  // --- Bank type: license_exam (4-level) vs modules (3-level) -------------
  // Modules: Objective > Subject (academic) / System (clinical) > Topic.
  function qblockBankMeta(bankId) {
    const id = bankId || currentQBankId || (window.db && window.db.selectedQBankId);
    return (cachedCategories || []).find(b => b.id === id)
      || (Array.isArray(window.__epBanks) ? window.__epBanks.find(b => b && b.id === id) : null)
      || null;
  }
  function qblockBankType() {
    const meta = qblockBankMeta();
    return meta && meta.bankType ? meta.bankType : "license_exam";
  }
  function qblockIsModule() {
    const t = qblockBankType();
    return t === "module_academic" || t === "module_clinical";
  }
  function qblockLevel2Label() {
    if (qblockBankType() === "module_clinical") return "Systems";
    if (qblockBankType() === "module_academic") return "Subjects";
    return "Organ Systems";
  }
  function qblockLevel2Singular() {
    if (qblockBankType() === "module_clinical") return "System";
    if (qblockBankType() === "module_academic") return "Subject";
    return "Organ System";
  }
  function qblockLevel3Label() {
    return qblockIsModule() ? "Topics" : "Clinical Specialties";
  }
  function qblockLevel3Singular() {
    return qblockIsModule() ? "Topic" : "Clinical Specialty";
  }
  function qblockLevel4Label() {
    return qblockIsModule() ? "Topics" : "Sub-topics / Diseases";
  }
  function qblockTaxonomyCrumb() {
    return qblockIsModule()
      ? `Objective → ${qblockLevel2Singular()} → Topic`
      : "Objective → Organ System → Clinical Specialty → Sub-topic / Disease";
  }

  function qblockTaxonomyClean(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function qblockTaxonomyPathFromQuestion(q) {
    const data = (q && q.data) || {};
    const objective = qblockTaxonomyClean(data.objective) || "General educational objective";
    const organSystem0 = qblockTaxonomyClean(data.organSystem || data.organ_system || data.subject || data.subcategory);
    const organSystem = organSystem0 || "Uncategorized";
    const clinicalSpecialty0 = qblockTaxonomyClean(data.clinicalSpecialty || data.clinical_specialty || data.specialty || data.chapter);
    const clinicalSpecialty = clinicalSpecialty0 || "Uncategorized";
    const subTopic0 = qblockTaxonomyClean(data.subTopic || data.subtopic || data.sub_topic || data.topic || data.part);
    const subTopic = subTopic0 || "Unspecified sub-topic";
    const raw = Array.isArray(data.taxonomyPath) ? data.taxonomyPath.map(qblockTaxonomyClean).filter(Boolean) : [];
    if (qblockIsModule()) {
      // Module taxonomy is stored with 3 segments: [Objective, Subject/System, Topic].
      // Pad to the 4-slot shape every UI shares (leaf topic duplicated);
      // Create Test hides the duplicated middle slot for modules.
      if (raw.length >= 3 && raw[0].toLowerCase() === objective.toLowerCase()) {
        return [raw[0], raw[1], raw[2], raw[2]];
      }
      if (raw.length === 4 && raw[0].toLowerCase() === objective.toLowerCase()) {
        return [raw[0], raw[1], raw[3], raw[3]];
      }
      return [objective, organSystem, subTopic, subTopic];
    }
    let path = [];
    if (raw.length >= 4 && raw[0].toLowerCase() === objective.toLowerCase()) path = raw.slice(0, 4);
    else if (raw.length === 3) path = [objective, ...raw];
    else if (raw.length === 2) path = [objective, ...raw, clinicalSpecialty, subTopic].slice(0, 4);
    else if (raw.length === 1) path = [objective, raw[0], clinicalSpecialty, subTopic].slice(0, 4);
    else path = [objective, organSystem, clinicalSpecialty, subTopic];
    if (path.length < 4) {
      if (path.length === 1) path.push(organSystem);
      if (path.length === 2) path.push(clinicalSpecialty);
      if (path.length === 3) path.push(subTopic);
    }
    while (path.length < 4) path.push(subTopic);
    return path.slice(0, 4).map((segment, index) => segment || [objective, organSystem, clinicalSpecialty, subTopic][index] || "Unspecified");
  }

  function qblockObjectiveOf(q) { return qblockTaxonomyPathFromQuestion(q)[0] || "General educational objective"; }
  function qblockOrganSystemOf(q) { return qblockTaxonomyPathFromQuestion(q)[1] || "Uncategorized"; }
  function qblockClinicalSpecialtyOf(q) { return qblockTaxonomyPathFromQuestion(q)[2] || "Uncategorized"; }
  function qblockSubTopicOf(q) { return qblockTaxonomyPathFromQuestion(q)[3] || "Unspecified sub-topic"; }

  function qblockSystemOf(q) { return qblockClinicalSpecialtyOf(q); }

  function qblockTagNames(q) {
    const data = (q && q.data) || {};
    const out = [];
    const push = raw => {
      if (raw == null) return;
      if (Array.isArray(raw)) { raw.forEach(push); return; }
      if (typeof raw === "object") {
        const name = String(raw.name || raw.tag || raw.value || raw.label || raw.text || raw.title || "").trim();
        if (name) out.push(name);
        return;
      }
      const text = String(raw).trim();
      if (!text) return;
      if (/[,;|]/.test(text)) { text.split(/[,;|]/).forEach(push); return; }
      out.push(text);
    };
    push(data.tags);
    push(data.tag);
    push(q && q.tags);
    return out;
  }

  function qblockSubjectCounts(questions = qblockActiveQuestions()) {
    const map = {};
    (questions || []).forEach(q => {
      const sub = qblockSubjectOf(q);
      map[sub] = (map[sub] || 0) + 1;
    });
    return Object.keys(map).sort((a, b) => a.localeCompare(b)).map(name => ({ name, count: map[name] }));
  }

  function qblockTaxonomyPath(q) {
    return qblockTaxonomyPathFromQuestion(q);
  }

  function qblockTopicKey(path) {
    return JSON.stringify(path);
  }

  function qblockTopicPathFromKey(key) {
    try {
      const parsed = JSON.parse(key);
      return Array.isArray(parsed) ? parsed.map(s => String(s)) : [];
    } catch (_) {
      return [];
    }
  }

  function qblockTopicMatches(path, prefix) {
    if (!prefix.length || path.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (String(path[i]).toLowerCase() !== String(prefix[i]).toLowerCase()) return false;
    }
    return true;
  }

  function qblockTopicTree(questions) {
    const root = { path: [], children: new Map(), count: 0 };
    (questions || []).forEach(q => {
      const path = qblockTaxonomyPath(q);
      if (!path.length) return;
      root.count++;
      let node = root;
      const acc = [];
      path.forEach(segment => {
        acc.push(segment);
        if (!node.children.has(segment)) {
          node.children.set(segment, { path: [...acc], children: new Map(), count: 0 });
        }
        node = node.children.get(segment);
        node.count++;
      });
    });
    const sortNode = (node) => {
      const children = [...node.children.values()].sort((a, b) => {
        const al = a.path[a.path.length - 1] || "";
        const bl = b.path[b.path.length - 1] || "";
        return al.localeCompare(bl);
      });
      children.forEach(sortNode);
      node.children = children;
      return node;
    };
    return sortNode(root).children;
  }

  function qblockTopicCounts(questions) {
    const map = {};
    const walk = (nodes) => {
      nodes.forEach(node => {
        map[qblockTopicKey(node.path)] = node.count;
        if (node.children.length) walk(node.children);
      });
    };
    walk(qblockTopicTree(questions));
    return map;
  }

  function qblockRenderTopicRows(nodes, depth = 0) {
    return nodes.map(node => {
      const key = qblockTopicKey(node.path);
      const label = node.path[node.path.length - 1] || "";
      const children = Array.isArray(node.children) ? node.children : [];
      return `
        <label class="qbb-topic-row" data-topic-row="${cqEsc(key)}" style="padding-left:${8 + depth * 16}px;">
          <input type="checkbox" class="qbb-topic-check" data-topic="${cqEsc(key)}" onchange="window.qbankBuilderToggleTopic(this.dataset.topic, this.checked)">
          <span class="qbb-topic-label">${cqEsc(label)}</span>
          <span class="qbb-topic-count">${node.count}</span>
        </label>
        ${children.length ? qblockRenderTopicRows(children, depth + 1) : ""}`;
    }).join("");
  }

  function qblockTopicLabel(topics) {
    const paths = (topics || []).map(qblockTopicPathFromKey).filter(p => p.length);
    if (!paths.length) return "";
    const first = paths[0][paths[0].length - 1];
    return paths.length === 1 ? first : `${first} +${paths.length - 1}`;
  }

  function qblockShuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function qblockFormatClock(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = n => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }

  function qblockBuilderPool() {
    const b = window.__qbankBuilder;
    if (!b) return [];
    const all = qblockActiveQuestions();
    let pool = all;
    if (b.subjects && b.subjects.length) {
      const picked = new Set(b.subjects);
      pool = pool.filter(q => picked.has(qblockSubjectOf(q)));
    }
    if (b.topics && b.topics.length) {
      const prefixes = b.topics.map(qblockTopicPathFromKey).filter(p => p.length);
      if (prefixes.length) {
        pool = pool.filter(q => {
          const path = qblockTaxonomyPath(q);
          return prefixes.some(prefix => qblockTopicMatches(path, prefix));
        });
      }
    }
    return pool;
  }

  function qblockSubjectLabel(subjects) {
    if (!subjects || !subjects.length) return "Mixed subjects";
    if (subjects.length === 1) return subjects[0];
    return `${subjects[0]} +${subjects.length - 1}`;
  }

  function qblockPrepAllowed(id) {
    const acc = window.db && window.db.access;
    if (!acc) return true;
    const grants = Array.isArray(acc.grants) ? acc.grants : [];
    const prepIds = Array.isArray(acc.prepIds) ? acc.prepIds : [];
    return grants.includes(id) || prepIds.includes(id);
  }

  function qblockSourceBanks() {
    const all = (cachedCategories || []).filter(q => q && q.id);
    const seen = new Set(all.map(q => q.id));
    if (Array.isArray(window.__epBanks)) {
      window.__epBanks.forEach(q => {
        if (q && q.id && !seen.has(q.id)) {
          all.push(q);
          seen.add(q.id);
        }
      });
    }
    const acc = window.db && window.db.access;
    const mainAllowed = (id) => !acc
      || (Array.isArray(acc.mainIds) && acc.mainIds.includes(id))
      || (Array.isArray(acc.grants) && acc.grants.includes(id));
    return {
      main: all.filter(q => q.kind !== "exam_prep" && mainAllowed(q.id)),
      prep: all.filter(q => q.kind === "exam_prep" && qblockPrepAllowed(q.id)),
    };
  }

  function qblockSourceBankLabel(q) {
    const bits = [];
    if (q.college) bits.push(q.college);
    if (q.year) bits.push(q.year);
    const name = q.name || q.id || "Exam prep";
    return bits.length ? `${name} - ${bits.join(" · ")}` : name;
  }

  async function qblockLoadBankQuestions(bankId) {
    const existing = cachedQBanks[bankId];
    const usable = existing && Array.isArray(existing.questions) && (existing.questions.length > 0 || existing._fullEmpty);
    if (usable) return existing;
    const meta = (cachedCategories || []).find(q => q.id === bankId)
      || (Array.isArray(window.__epBanks) ? window.__epBanks.find(q => q && q.id === bankId) : null)
      || {};
    const updatedAt = Number(meta.updatedAt) || 0;
    const idbData = await getCachedQBank(bankId);
    if (idbData && (!updatedAt || Number(idbData.updatedAt) === updatedAt) && Array.isArray(idbData.questions) && idbData.questions.length > 0) {
      const res = await apiGet("get_questions", { qbankId: bankId, onlyProgress: true });
      cachedQBanks[bankId] = { questions: idbData.questions, progress: applyLocalQueueProgress(bankId, res.progress || {}) };
    } else {
      const res = await apiGet("get_questions", { qbankId: bankId });
      cachedQBanks[bankId] = { questions: res.questions || [], progress: applyLocalQueueProgress(bankId, res.progress || {}) };
      setCachedQBank(bankId, { updatedAt, questions: res.questions || [] });
    }
    if (!cachedQBanks[bankId].questions.length) cachedQBanks[bankId]._fullEmpty = true;
    return cachedQBanks[bankId];
  }

  window.qbankOpenBlockBuilder = async function(opts = {}) {
    qblockEnsureStyles();
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    if (window.hideAllMainViews) window.hideAllMainViews();
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";
    const view = document.getElementById("qbank-home-view");
    if (view) view.style.display = "flex";
    if (window.setQBankNav) window.setQBankNav("home");

    try { await window.bootstrapAccess(); } catch (_) {}
    const sourceBanks = qblockSourceBanks();
    let bankId = opts.bankId || currentQBankId || (window.db && window.db.selectedQBankId);
    if (opts.pickExamPrep && !opts.bankId) {
      const saved = window.cqGetSavedCollege ? window.cqGetSavedCollege() : null;
      const preferred = saved
        ? sourceBanks.prep.filter(q => (q.country || "global") === saved.country && (q.college || "General") === saved.college)
        : [];
      bankId = (preferred[0] || sourceBanks.prep[0] || {}).id || "";
      if (!bankId) {
        if (window.qbankToast) window.qbankToast("No exam-prep banks are available yet.", true);
        return;
      }
    }
    if (!bankId) {
      if (window.qbankToast) window.qbankToast("Choose a QBank before creating a test.", true);
      return;
    }

    const loadToken = (window.__qbankBuilderLoadToken || 0) + 1;
    window.__qbankBuilderLoadToken = loadToken;
    const cached = cachedQBanks[bankId];
    const needsLoad = !cached || !Array.isArray(cached.questions) || (cached.questions.length === 0 && !cached._fullEmpty);
    if (needsLoad) {
      area.innerHTML = `<div class="qbb-page"><div class="qbb-card" style="text-align:center; color:var(--qb-muted);">Loading questions…</div></div>`;
      try {
        await qblockLoadBankQuestions(bankId);
      } catch (e) {
        if (window.__qbankBuilderLoadToken !== loadToken) return;
        area.innerHTML = `<div class="qbb-page"><div class="qbb-card" style="text-align:center;">
          <h2 style="margin-bottom:8px;">Could not load this bank</h2>
          <p class="qbb-help">${cqEsc((e && e.message) || "Please try again.")}</p>
          <button type="button" class="qbb-back" onclick="window.openQBank()">Back to home</button>
        </div></div>`;
        return;
      }
      if (window.__qbankBuilderLoadToken !== loadToken) return;
    }

    currentQBankId = bankId;
    const loaded = cachedQBanks[bankId];
    allQuestions = loaded && Array.isArray(loaded.questions) ? loaded.questions : [];
    if (loaded && loaded.progress) window.qbankProgress = loaded.progress;
    const sourceMeta = (cachedCategories || []).find(q => q.id === bankId) || null;
    if (sourceMeta && sourceMeta.name) {
      const nameEl = document.getElementById("qbank-active-name");
      if (nameEl) nameEl.textContent = sourceMeta.name;
    }
    if (bankId && !sourceBanks.main.some(q => q.id === bankId) && !sourceBanks.prep.some(q => q.id === bankId)) {
      sourceBanks.main.unshift(sourceMeta || { id: bankId, name: qblockBankName() });
    }

    const counts = qblockSubjectCounts();
    const total = counts.reduce((n, s) => n + s.count, 0);
    const preset = Array.isArray(opts.subjects) ? opts.subjects.filter(s => counts.some(c => c.name === s)) : [];
    const topicTree = qblockTopicTree(qblockActiveQuestions());
    const defaultCount = total > 0 ? Math.min(40, total) : 40;
    window.__qbankBuilder = {
      mode: opts.mode === "tutor" ? "tutor" : "exam",
      count: defaultCount,
      timed: opts.mode === "tutor" ? false : (opts.timed !== false),
      minutes: Math.max(1, Math.ceil(defaultCount * 1.5)),
      subjects: preset,
      topics: [],
      random: true,
      total,
      counts,
      sourceBankId: bankId,
    };
    if (opts.subject && counts.some(c => c.name === opts.subject)) window.__qbankBuilder.subjects = [opts.subject];

    const b = window.__qbankBuilder;
    const chips = counts.map(s => `
      <button type="button" class="qbb-chip" data-sub="${cqEsc(s.name)}" onclick="window.qbankBuilderToggleSubject('${cqJsArg(s.name)}')">
        ${cqEsc(s.name)} <span>${s.count}</span>
      </button>`).join("");
    const topicRows = topicTree.length ? qblockRenderTopicRows(topicTree) : "";
    const topicSection = topicTree.length ? `
          <section class="qbb-card wide">
            <h2>5. Parts</h2>
            <p class="qbb-help">Optional filter. Pick a Sub-topic / Disease inside a Clinical Specialty to focus your test. Selecting a specialty includes all of its sub-topics.</p>
            <div class="qbb-topic-toolbar">
              <button type="button" class="qbb-topic-clear" onclick="window.qbankBuilderSelectAllTopics()">Clear parts</button>
              <span id="qbb-topic-selected">No part filter</span>
            </div>
            <div class="qbb-topics" id="qbb-topics">${topicRows}</div>
          </section>` : "";
    const sourceOptions = [
      sourceBanks.main.length ? `<optgroup label="Regular QBanks">${sourceBanks.main.map(q => `<option value="${cqEsc(q.id)}" ${q.id === bankId ? "selected" : ""}>${cqEsc(q.name || q.id)}</option>`).join("")}</optgroup>` : "",
      sourceBanks.prep.length ? `<optgroup label="Exam prep">${sourceBanks.prep.map(q => `<option value="${cqEsc(q.id)}" ${q.id === bankId ? "selected" : ""}>${cqEsc(qblockSourceBankLabel(q))}</option>`).join("")}</optgroup>` : "",
    ].join("");
    const isPrep = !!(sourceMeta && sourceMeta.kind === "exam_prep");
    const sourceName = (sourceMeta && sourceMeta.name) || qblockBankName();

    area.innerHTML = `
      <div class="qbb-page">
        <div class="qbb-top">
          <button type="button" class="qbb-back" onclick="window.openQBank()"><i data-lucide="arrow-left"></i> Back to home</button>
          <span class="qbb-kicker">${isPrep ? "Past-exam tests" : "USMLE-style tests"}</span>
        </div>
        <h1 class="qbb-title">${isPrep ? "Create an exam-prep test" : "Create a study test"}</h1>
        <p class="qbb-sub">Pick your mode, length, and subjects. Timed tests hide answers until you submit; tutor tests explain each answer as you go.</p>

        <div class="qbb-layout">
          <section class="qbb-card wide">
            <h2>Question source</h2>
            <p class="qbb-help">Build from your regular QBank or any exam-prep bank you can access.</p>
            <select id="qbb-source" class="qbb-select" onchange="window.qbankBuilderChangeSource(this.value)">${sourceOptions}</select>
            <p class="qbb-available">Building from <b>${cqEsc(sourceName)}</b> · <b>${total}</b> question${total === 1 ? "" : "s"}</p>
          </section>

          <section class="qbb-card wide">
            <h2>1. Choose a mode</h2>
            <p class="qbb-help">Both modes end with a score report and full answer review.</p>
            <div class="qbb-modes">
              <button type="button" class="qbb-mode" data-mode="exam" onclick="window.qbankBuilderSetMode('exam')">
                <span class="qbb-mode-ic"><i data-lucide="timer"></i></span>
                <b>Timed exam</b>
                <small>Answers and explanations stay hidden until you submit. Best for simulating test day.</small>
              </button>
              <button type="button" class="qbb-mode" data-mode="tutor" onclick="window.qbankBuilderSetMode('tutor')">
                <span class="qbb-mode-ic"><i data-lucide="lightbulb"></i></span>
                <b>Tutor mode</b>
                <small>See the answer and explanation immediately after each question. Best for learning.</small>
              </button>
            </div>
          </section>

          <section class="qbb-card">
            <h2>2. Questions</h2>
            <p class="qbb-help">Standard USMLE test is 40 questions. Use any number you like.</p>
            <div class="qbb-pills">
              ${[10, 20, 40, 60].map(n => `<button type="button" class="qbb-pill" data-count="${n}" onclick="window.qbankBuilderSetCount(${n})">${n}</button>`).join("")}
            </div>
            <label class="qbb-field" for="qbb-count">Custom
              <input id="qbb-count" class="qbb-input" type="number" min="1" max="${Math.max(1, total)}" value="${b.count}" oninput="window.qbankBuilderCountInput(this.value)">
              questions
            </label>
            <p class="qbb-available">Available in this bank: <b id="qbb-available">${total}</b></p>
          </section>

          <section class="qbb-card">
            <h2>3. Time limit</h2>
            <p class="qbb-help">60 minutes is about 90 seconds per question.</p>
            <div class="qbb-switch" role="group" aria-label="Time limit">
              <button type="button" data-timed="1" onclick="window.qbankBuilderSetTimed(true)">Timed</button>
              <button type="button" data-timed="0" onclick="window.qbankBuilderSetTimed(false)">Untimed</button>
            </div>
            <label class="qbb-field" for="qbb-minutes" style="margin-top:10px;">Minutes
              <input id="qbb-minutes" class="qbb-input" type="number" min="1" max="300" value="${b.minutes}" oninput="window.qbankBuilderMinutesInput(this.value)">
            </label>
            <p class="qbb-available" id="qbb-pace"></p>
            <label class="qbb-check"><input id="qbb-random" type="checkbox" checked onchange="window.qbankBuilderToggleRandom(this.checked)"> Randomize question order</label>
          </section>

          <section class="qbb-card wide">
            <h2>4. Subjects / systems</h2>
            <p class="qbb-help">Leave “All subjects” selected for a mixed test, or choose specific organ systems and disciplines.</p>
            <div class="qbb-chips" id="qbb-chips">
              <button type="button" class="qbb-chip" data-sub="" onclick="window.qbankBuilderSelectAll()">All subjects <span>${total}</span></button>
              ${chips}
            </div>
          </section>
          ${topicSection}
        </div>

        <div class="qbb-summary">
          <div>
            <b id="qbb-summary-count">${b.count} questions</b>
            <span id="qbb-summary-detail"></span>
          </div>
          <button type="button" class="qbb-start" id="qbb-start" onclick="window.qbankBuilderStart()">Start test</button>
        </div>
      </div>`;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    window.qbankBuilderSync();
  };

  window.qbankBuilderChangeSource = function(bankId) {
    if (!bankId) return;
    return window.qbankOpenBlockBuilder({ bankId });
  };

  window.qbankOpenExamPrepBlockBuilder = function() {
    return window.qbankOpenBlockBuilder({ pickExamPrep: true });
  };

  window.qbankBuilderSetMode = function(mode) {
    const b = window.__qbankBuilder;
    if (!b || (mode !== "exam" && mode !== "tutor")) return;
    b.mode = mode;
    if (mode === "tutor") b.timed = false;
    else if (!b.timed) b.timed = true;
    window.qbankBuilderSync();
  };

  window.qbankBuilderSetCount = function(n) {
    const b = window.__qbankBuilder;
    if (!b) return;
    b.count = Math.max(1, parseInt(n, 10) || 1);
    window.qbankBuilderSync();
  };

  window.qbankBuilderCountInput = function(value) {
    const b = window.__qbankBuilder;
    if (!b) return;
    b.count = Math.max(1, parseInt(value, 10) || 1);
    window.qbankBuilderSync(true);
  };

  window.qbankBuilderSetTimed = function(timed) {
    const b = window.__qbankBuilder;
    if (!b) return;
    b.timed = !!timed;
    window.qbankBuilderSync();
  };

  window.qbankBuilderMinutesInput = function(value) {
    const b = window.__qbankBuilder;
    if (!b) return;
    b.minutes = Math.max(1, Math.min(300, parseInt(value, 10) || 1));
    window.qbankBuilderSync(true);
  };

  window.qbankBuilderToggleRandom = function(checked) {
    if (!window.__qbankBuilder) return;
    window.__qbankBuilder.random = !!checked;
  };

  function qblockPruneTopics() {
    const b = window.__qbankBuilder;
    if (!b || !b.topics || !b.topics.length) return;
    const all = qblockActiveQuestions();
    const pool = b.subjects.length ? all.filter(q => b.subjects.includes(qblockSubjectOf(q))) : all;
    const counts = qblockTopicCounts(pool);
    b.topics = b.topics.filter(key => (counts[key] || 0) > 0);
  }

  window.qbankBuilderSelectAllTopics = function() {
    const b = window.__qbankBuilder;
    if (!b) return;
    b.topics = [];
    window.qbankBuilderSync();
  };

  window.qbankBuilderToggleTopic = function(key, checked) {
    const b = window.__qbankBuilder;
    if (!b || !key) return;
    const has = b.topics.includes(key);
    if (checked && !has) b.topics = [...b.topics, key];
    if (!checked && has) b.topics = b.topics.filter(k => k !== key);
    window.qbankBuilderSync();
  };

  window.qbankBuilderSelectAll = function() {
    const b = window.__qbankBuilder;
    if (!b) return;
    b.subjects = [];
    b.topics = [];
    window.qbankBuilderSync();
  };

  window.qbankBuilderToggleSubject = function(subject) {
    const b = window.__qbankBuilder;
    if (!b) return;
    if (!subject) {
      b.subjects = [];
    } else if (b.subjects.includes(subject)) {
      b.subjects = b.subjects.filter(s => s !== subject);
    } else {
      b.subjects = [...b.subjects, subject];
    }
    qblockPruneTopics();
    window.qbankBuilderSync();
  };

  window.qbankBuilderSync = function(skipInputs) {
    const b = window.__qbankBuilder;
    if (!b) return;
    const pool = qblockBuilderPool();
    const count = Math.max(1, Math.min(parseInt(b.count, 10) || 1, Math.max(1, pool.length)));
    const timed = b.timed;
    const total = Number(b.total) || qblockActiveQuestions().length;

    document.querySelectorAll(".qbb-mode").forEach(el => el.classList.toggle("on", el.dataset.mode === b.mode));
    document.querySelectorAll(".qbb-pill[data-count]").forEach(el => el.classList.toggle("on", Number(el.dataset.count) === b.count));
    document.querySelectorAll(".qbb-switch button[data-timed]").forEach(el => el.classList.toggle("on", (el.dataset.timed === "1") === !!timed));
    document.querySelectorAll(".qbb-chip[data-sub]").forEach(el => {
      const on = el.dataset.sub ? b.subjects.includes(el.dataset.sub) : b.subjects.length === 0;
      el.classList.toggle("on", on);
    });
    const builderQuestions = qblockActiveQuestions();
    const topicPool = b.subjects.length ? builderQuestions.filter(q => b.subjects.includes(qblockSubjectOf(q))) : builderQuestions;
    const topicCounts = qblockTopicCounts(topicPool);
    document.querySelectorAll("[data-topic-row]").forEach(row => {
      const key = row.getAttribute("data-topic-row");
      const input = row.querySelector(".qbb-topic-check");
      const countEl = row.querySelector(".qbb-topic-count");
      const topicCount = topicCounts[key] || 0;
      if (input) input.checked = b.topics.includes(key);
      if (countEl) countEl.textContent = String(topicCount);
      row.classList.toggle("dim", topicCount === 0);
    });
    const topicSelectedEl = document.getElementById("qbb-topic-selected");
    if (topicSelectedEl) {
      topicSelectedEl.textContent = b.topics.length ? `${b.topics.length} selected - ${qblockTopicLabel(b.topics)}` : "No part filter";
    }
    if (!skipInputs) {
      const countInput = document.getElementById("qbb-count");
      if (countInput) countInput.value = b.count;
      const minutesInput = document.getElementById("qbb-minutes");
      if (minutesInput) minutesInput.value = b.minutes;
    }
    const minutesInput = document.getElementById("qbb-minutes");
    if (minutesInput) minutesInput.disabled = !b.timed;
    const availableEl = document.getElementById("qbb-available");
    if (availableEl) availableEl.textContent = String(pool.length);
    const paceEl = document.getElementById("qbb-pace");
    if (paceEl) paceEl.textContent = b.timed ? `${Math.round((b.minutes * 60) / Math.max(1, count))} seconds per question` : "No clock — study at your own pace.";
    const countEl = document.getElementById("qbb-summary-count");
    if (countEl) countEl.textContent = `${count} question${count === 1 ? "" : "s"}`;
    const detailEl = document.getElementById("qbb-summary-detail");
    if (detailEl) {
      const timeText = b.timed ? `${b.minutes} minute${b.minutes === 1 ? "" : "s"}` : "Untimed";
      const modeText = b.mode === "exam" ? (b.timed ? "Timed exam" : "Exam") : "Tutor";
      const filterText = qblockTopicLabel(b.topics) || qblockSubjectLabel(b.subjects);
      detailEl.textContent = `${modeText} · ${timeText} · ${filterText}`;
      if (count < b.count) detailEl.textContent += ` · only ${pool.length} available`;
    }
    const startEl = document.getElementById("qbb-start");
    if (startEl) {
      startEl.disabled = pool.length === 0;
      startEl.textContent = pool.length === 0 ? "No questions available" : `Start ${count}-question test`;
    }
    if (total && !b.total) b.total = total;
  };

  window.qbankBuilderStart = function() {
    const b = window.__qbankBuilder;
    if (!b) return;
    let pool = qblockBuilderPool();
    if (!pool.length) {
      if (window.qbankToast) window.qbankToast("No questions match these filters.", true);
      return;
    }
    const count = Math.max(1, Math.min(parseInt(b.count, 10) || 1, pool.length));
    if (b.random) pool = qblockShuffle(pool);
    const questions = pool.slice(0, count);
    const minutes = Math.max(1, Math.min(300, parseInt(b.minutes, 10) || 60));
    window.qbankStartBlock({
      bankId: b.sourceBankId || currentQBankId || (window.db && window.db.selectedQBankId),
      bankName: qblockBankName(),
      mode: b.mode,
      questions,
      timeLimitSec: b.timed ? minutes * 60 : null,
      filters: { subjects: [...b.subjects], topics: b.topics.map(qblockTopicPathFromKey).filter(p => p.length), random: !!b.random },
    });
  };

  // --- Block-only practice: builder, saved blocks, and history ---
  const QBLOCK_MAX_QUESTIONS = 40;
  const QBLOCK_SECONDS_PER_QUESTION = 90;
  const QBLOCK_HISTORY_PREFIX = "omnote_qbank_blocks:v1:";
  const QBLOCK_FILTER_MODES = ["unused", "incorrect", "marked", "omitted", "correct"];
  const QBLOCK_FILTER_MODE_LABELS = {
    unused: "Unused",
    incorrect: "Incorrect",
    marked: "Marked",
    omitted: "Omitted",
    correct: "Correct",
  };

  function qblockCurrentUid() {
    try {
      const user = window.firebase && window.firebase.auth && window.firebase.auth().currentUser;
      if (user && user.uid) return user.uid;
    } catch (_) {}
    return "local";
  }

  function qblockHistoryKey() {
    return QBLOCK_HISTORY_PREFIX + qblockCurrentUid();
  }

  function qblockReadHistory() {
    try {
      const list = JSON.parse(localStorage.getItem(qblockHistoryKey()) || "[]");
      return Array.isArray(list) ? list.filter(record => record && record.id) : [];
    } catch (_) {
      return [];
    }
  }

  function qblockWriteHistory(records) {
    try {
      localStorage.setItem(qblockHistoryKey(), JSON.stringify((records || []).slice(0, 100)));
    } catch (_) {}
  }

  function qblockNewRecordId() {
    return "blk_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function qblockFindRecord(recordId) {
    return qblockReadHistory().find(record => record.id === recordId) || null;
  }

  function qblockSaveRecord(record) {
    if (!record || !record.id) return;
    const list = qblockReadHistory();
    const index = list.findIndex(item => item.id === record.id);
    if (index >= 0) list[index] = record;
    else list.unshift(record);
    list.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    qblockWriteHistory(list);
  }

  function qblockDeleteRecord(recordId) {
    qblockWriteHistory(qblockReadHistory().filter(record => record.id !== recordId));
  }

  function qblockSnapshot(b) {
    if (!b || !b.active || !b.recordId) return null;
    const now = Date.now();
    const questionIds = Array.isArray(b.questionIds)
      ? [...b.questionIds]
      : currentQuestions.map(question => question.id).filter(Boolean);
    const completed = !!b.submitted;
    const result = b.results ? {
      total: Number(b.results.total) || 0,
      answered: Number(b.results.answered) || 0,
      correct: Number(b.results.correct) || 0,
      incorrect: Number(b.results.incorrect) || 0,
      partial: Number(b.results.partial) || 0,
      unanswered: Number(b.results.unanswered) || 0,
      score: Number(b.results.score) || 0,
      secondsUsed: Number(b.results.secondsUsed) || 0,
      byId: b.results.byId || null,
    } : null;
    return {
      id: b.recordId,
      bankId: b.bankId,
      bankName: b.bankName,
      mode: b.mode,
      timeLimitSec: b.timeLimitSec || null,
      startedAt: b.startedAt,
      updatedAt: now,
      completedAt: completed ? (b.completedAt || now) : null,
      status: completed ? "completed" : "in_progress",
      questionIds,
      questionCount: questionIds.length,
      answers: JSON.parse(JSON.stringify(b.answers || {})),
      timeByQ: JSON.parse(JSON.stringify(b.timeByQ || {})),
      currentIndex,
      elapsedSec: result ? result.secondsUsed : Math.max(0, Math.round((now - b.startedAt) / 1000)),
      remainingSec: b.deadline ? Math.max(0, Math.ceil((b.deadline - now) / 1000)) : null,
      results: result,
      filters: b.filters || {},
    };
  }

  function qblockPersistActive() {
    const b = window.__qbankBlock;
    if (!b || !b.active || !b.recordId) return;
    const record = qblockSnapshot(b);
    if (record) qblockSaveRecord(record);
  }

  function qblockSystemCounts(questions) {
    const map = {};
    (questions || []).forEach(q => {
      const system = qblockClinicalSpecialtyOf(q);
      if (!system) return;
      map[system] = (map[system] || 0) + 1;
    });
    return Object.keys(map)
      .sort((a, b) => a.localeCompare(b))
      .map(name => ({ kind: "clinical-specialty", name, count: map[name], parent: "" }));
  }

  function qblockSubTopicCounts(questions) {
    const map = {};
    (questions || []).forEach(q => {
      const subtopic = qblockSubTopicOf(q);
      if (!subtopic) return;
      map[subtopic] = (map[subtopic] || 0) + 1;
    });
    return Object.keys(map)
      .sort((a, b) => a.localeCompare(b))
      .map(name => ({ name, count: map[name] }));
  }

  function qblockObjectiveCounts(questions) {
    const map = {};
    (questions || []).forEach(q => {
      const objective = qblockObjectiveOf(q);
      if (!objective) return;
      map[objective] = (map[objective] || 0) + 1;
    });
    return Object.keys(map)
      .sort((a, b) => a.localeCompare(b))
      .map(name => ({ name, count: map[name] }));
  }

  function qblockModeMatch(progress, mode) {
    const p = progress || {};
    const answered = p.correct !== undefined;
    if (mode === "unused") return !answered && !p.omitted;
    if (mode === "incorrect") return p.correct === false;
    if (mode === "marked") return !!p.marked;
    if (mode === "omitted") return !!p.omitted && !answered;
    if (mode === "correct") return p.correct === true;
    return false;
  }

  function qblockMatchesModes(progress, modes) {
    if (!Array.isArray(modes) || modes.length === 0) return true;
    return modes.some(mode => qblockModeMatch(progress, mode));
  }

  function qblockModeLabelList(modes) {
    return (modes || []).map(mode => QBLOCK_FILTER_MODE_LABELS[mode]).filter(Boolean).join(", ");
  }

  function qblockRecordModeLabel(record) {
    if (!record) return "Test";
    if (record.mode === "tutor") return "Tutor";
    return record.timeLimitSec ? "Timed" : "Exam";
  }

  function qblockRecordTitle(record) {
    const filters = (record && record.filters) || {};
    const subjects = Array.isArray(filters.subjects) ? filters.subjects : [];
    const systems = Array.isArray(filters.systems) ? filters.systems : [];
    const subTopics = Array.isArray(filters.subTopics) ? filters.subTopics : [];
    if (subjects.length === 1) return subjects[0];
    if (subjects.length > 1) return subjects[0] + " +" + (subjects.length - 1);
    if (systems.length === 1) return systems[0];
    if (systems.length > 1) return systems[0] + " +" + (systems.length - 1);
    if (subTopics.length === 1) return subTopics[0];
    if (subTopics.length > 1) return subTopics[0] + " +" + (subTopics.length - 1);
    return filters.objective ? String(filters.objective).slice(0, 80) : "Mixed test";
  }

  function qblockRecordWhen(timestamp) {
    if (!timestamp) return "—";
    try {
      const date = new Date(timestamp);
      return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
        + " · " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch (_) {
      return "—";
    }
  }

  function qblockRecordAnswered(record) {
    if (!record) return 0;
    if (record.results && record.results.answered !== undefined) return Number(record.results.answered) || 0;
    const answers = record.answers || {};
    return (record.questionIds || []).reduce((count, id) => {
      return count + (Array.isArray(answers[id]) && answers[id].length ? 1 : 0);
    }, 0);
  }

  function qblockRecordScore(record) {
    if (!record || !record.results) return null;
    return Math.max(0, Math.min(100, Number(record.results.score) || 0));
  }

  function qblockLatestInProgress() {
    return qblockReadHistory().find(record => record.status === "in_progress") || null;
  }

  function qblockCanonicalName(names, value) {
    const wanted = String(value == null ? "" : value).trim().toLowerCase();
    if (!wanted) return "";
    return (names || []).find(name => String(name).trim().toLowerCase() === wanted) || "";
  }

  function qblockParseCombinedSubject(subject, chapter, topicPath) {
    let nextSubject = subject || "";
    let nextChapter = chapter || "";
    let nextTopic = Array.isArray(topicPath) ? [...topicPath] : [];
    if (nextSubject && !nextChapter && !nextTopic.length && nextSubject.includes(" - ")) {
      const pieces = nextSubject.split(" - ");
      nextSubject = pieces[0] || "";
      nextChapter = pieces.slice(1).join(" - ");
    }
    if (!nextChapter && nextTopic.length > 1) nextChapter = nextTopic[1];
    return { subject: nextSubject, chapter: nextChapter, topicPath: nextTopic };
  }

  function qblockShowHomeShell() {
    if (window.hideAllMainViews) window.hideAllMainViews();
    const view = document.getElementById("qbank-home-view");
    if (view) view.style.display = "flex";
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";
  }

  function qblockConfirmLeaveActive() {
    const b = window.__qbankBlock;
    if (!b || !b.active || b.submitted) return true;
    return window.confirm("Leave this test? Your answers will be saved so you can resume it from Previous tests.");
  }

  function qblockBuilderData() {
    const state = window.__qblockBuilderV2;
    if (!state) return { modeCounts: {}, subjectCounts: {}, systemCounts: {}, subTopicCounts: {}, objectiveCounts: {}, subjectNames: [], systemNames: [], subTopicNames: [], pool: [], available: 0 };
    const base = qblockActiveQuestions();
    const progress = qbankProgressMap();
    const selectedObjective = String(state.objective || "");
    const selectedSubjects = Array.isArray(state.subjects) ? state.subjects : [];
    const selectedSystems = Array.isArray(state.systems) ? state.systems : [];
    const selectedSubTopics = Array.isArray(state.subTopics) ? state.subTopics : [];
    const selectedModes = Array.isArray(state.modes) ? state.modes : [];

    const byObjective = selectedObjective ? base.filter(q => qblockObjectiveOf(q) === selectedObjective) : base;
    const bySubject = selectedSubjects.length ? byObjective.filter(q => selectedSubjects.includes(qblockSubjectOf(q))) : byObjective;
    const bySystem = selectedSystems.length ? byObjective.filter(q => selectedSystems.includes(qblockClinicalSpecialtyOf(q))) : byObjective;
    const bySubTopic = selectedSubTopics.length ? byObjective.filter(q => selectedSubTopics.includes(qblockSubTopicOf(q))) : byObjective;
    const byBoth = byObjective.filter(q => {
      if (selectedSubjects.length && !selectedSubjects.includes(qblockSubjectOf(q))) return false;
      if (selectedSystems.length && !selectedSystems.includes(qblockClinicalSpecialtyOf(q))) return false;
      if (selectedSubTopics.length && !selectedSubTopics.includes(qblockSubTopicOf(q))) return false;
      return true;
    });

    const modeCounts = {};
    QBLOCK_FILTER_MODES.forEach(mode => {
      modeCounts[mode] = byBoth.reduce((count, q) => count + (qblockModeMatch(progress[q.id], mode) ? 1 : 0), 0);
    });

    const subjectCounts = {};
    const subjectValid = {};
    byObjective.forEach(q => subjectValid[qblockSubjectOf(q)] = true);
    selectedSystems.length || selectedSubTopics.length
      ? bySubTopic.filter(q => !selectedSystems.length || selectedSystems.includes(qblockClinicalSpecialtyOf(q))).forEach(q => {
          if (!qblockMatchesModes(progress[q.id], selectedModes)) return;
          const subject = qblockSubjectOf(q);
          subjectCounts[subject] = (subjectCounts[subject] || 0) + 1;
        })
      : byObjective.forEach(q => {
          if (!qblockMatchesModes(progress[q.id], selectedModes)) return;
          const subject = qblockSubjectOf(q);
          subjectCounts[subject] = (subjectCounts[subject] || 0) + 1;
        });

    const systemCounts = {};
    const validSystemCounts = {};
    bySubject.forEach(q => {
      if (selectedSubTopics.length && !selectedSubTopics.includes(qblockSubTopicOf(q))) return;
      const system = qblockClinicalSpecialtyOf(q);
      validSystemCounts[system] = (validSystemCounts[system] || 0) + 1;
      if (!qblockMatchesModes(progress[q.id], selectedModes)) return;
      systemCounts[system] = (systemCounts[system] || 0) + 1;
    });

    const subTopicCounts = {};
    const validSubTopicCounts = {};
    const bySpecialtyScope = bySubject.filter(q => !selectedSystems.length || selectedSystems.includes(qblockClinicalSpecialtyOf(q)));
    bySpecialtyScope.forEach(q => {
      const subTopic = qblockSubTopicOf(q);
      validSubTopicCounts[subTopic] = (validSubTopicCounts[subTopic] || 0) + 1;
      if (!qblockMatchesModes(progress[q.id], selectedModes)) return;
      subTopicCounts[subTopic] = (subTopicCounts[subTopic] || 0) + 1;
    });

    const subjectNames = Object.keys(subjectValid).sort((a, b) => a.localeCompare(b));
    const systemNames = Object.keys(validSystemCounts).sort((a, b) => a.localeCompare(b));
    const subTopicNames = Object.keys(validSubTopicCounts).sort((a, b) => a.localeCompare(b));

    let pool = byBoth.filter(q => qblockMatchesModes(progress[q.id], selectedModes));
    if (Array.isArray(state.topicPath) && state.topicPath.length) {
      pool = pool.filter(q => qblockTopicMatches(qblockTaxonomyPath(q), state.topicPath));
    }
    if (state.tag) {
      const wantedTag = String(state.tag).trim().toLowerCase();
      pool = pool.filter(q => qblockTagNames(q).some(name => String(name).trim().toLowerCase() === wantedTag));
    }

    return { modeCounts, subjectCounts, systemCounts, subTopicCounts, objectiveCounts: qblockObjectiveCounts(base), subjectNames, systemNames, subTopicNames, pool, available: pool.length };
  }

  function qblockTabsHtml(active) {
    const count = qblockReadHistory().length;
    return `<div class="qbt-tabs" role="tablist" aria-label="QBank tests">
      <button type="button" class="qbt-tab ${active === "builder" ? "is-active" : ""}" role="tab" aria-selected="${active === "builder"}" onclick="window.qbankBlockBuilderTab('builder')">
        <i data-lucide="layers" aria-hidden="true"></i> Create test
      </button>
      <button type="button" class="qbt-tab ${active === "history" ? "is-active" : ""}" role="tab" aria-selected="${active === "history"}" onclick="window.qbankBlockBuilderTab('history')">
        <i data-lucide="history" aria-hidden="true"></i> Previous tests <span class="qbt-count" id="qbt-history-count">${count}</span>
      </button>
    </div>`;
  }

  function qblockBuilderSourceOptions(state) {
    const sources = qblockSourceBanks();
    const main = [...sources.main];
    if (state && state.bankId && !main.some(bank => bank.id === state.bankId) && !sources.prep.some(bank => bank.id === state.bankId)) {
      main.unshift({ id: state.bankId, name: qblockBankName() });
    }
    const opt = bank => `<option value="${cqEsc(bank.id)}" ${bank.id === state.bankId ? "selected" : ""}>${cqEsc(bank.name || bank.id)}</option>`;
    const modsAcademic = main.filter(b => b.bankType === "module_academic");
    const modsClinical = main.filter(b => b.bankType === "module_clinical");
    const licenses = main.filter(b => b.bankType !== "module_academic" && b.bankType !== "module_clinical");
    return [
      modsAcademic.length ? `<optgroup label="Modules — Academic">${modsAcademic.map(opt).join("")}</optgroup>` : "",
      modsClinical.length ? `<optgroup label="Modules — Clinical">${modsClinical.map(opt).join("")}</optgroup>` : "",
      licenses.length ? `<optgroup label="License Exams">${licenses.map(opt).join("")}</optgroup>` : "",
      sources.prep.length ? `<optgroup label="Exam prep">${sources.prep.map(bank => `<option value="${cqEsc(bank.id)}" ${bank.id === state.bankId ? "selected" : ""}>${cqEsc(qblockSourceBankLabel(bank))}</option>`).join("")}</optgroup>` : "",
    ].filter(Boolean).join("");
  }

  function qblockRenderBuilder() {
    const state = window.__qblockBuilderV2;
    const area = document.getElementById("qbank-home-content");
    if (!state || !area) return;
    window.setQBankNav && window.setQBankNav("blocks");

    const base = qblockActiveQuestions();
    const objectiveOptions = qblockObjectiveCounts(base);
    const selectedObjective = String(state.objective || "");
    const objectiveQuestions = selectedObjective ? base.filter(q => qblockObjectiveOf(q) === selectedObjective) : base;
    const selectedSubjects = Array.isArray(state.subjects) ? state.subjects : [];
    const bySubject = selectedSubjects.length ? objectiveQuestions.filter(q => selectedSubjects.includes(qblockSubjectOf(q))) : objectiveQuestions;
    const selectedSubTopics = Array.isArray(state.subTopics) ? state.subTopics : [];
    const systemScope = bySubject.filter(q => !selectedSubTopics.length || selectedSubTopics.includes(qblockSubTopicOf(q)));
    const systems = qblockSystemCounts(systemScope);
    const selectedSystems = Array.isArray(state.systems) ? state.systems : [];
    const subTopicScope = bySubject.filter(q => !selectedSystems.length || selectedSystems.includes(qblockClinicalSpecialtyOf(q)));
    const subTopics = qblockSubTopicCounts(subTopicScope);
    const subjects = qblockSubjectCounts(objectiveQuestions);
    const sourceMeta = (cachedCategories || []).find(bank => bank.id === state.bankId) || {};
    const isPrep = sourceMeta.kind === "exam_prep";
    const isModule = sourceMeta.bankType === "module_academic" || sourceMeta.bankType === "module_clinical";
    if (isModule) state.systems = [];
    const modeDescription = state.mode === "tutor"
      ? "Answers and explanations appear as you go. No clock."
      : `${QBLOCK_SECONDS_PER_QUESTION} seconds per question. Answers stay hidden until you submit.`;

    const optionHtml = `<option value="">All educational objectives</option>${objectiveOptions.map(option => `<option value="${cqEsc(option.name)}" ${option.name === selectedObjective ? "selected" : ""}>${cqEsc(option.name)} · ${option.count}</option>`).join("")}`;
    const objectiveNote = selectedObjective
      ? `<span class="qbc-source-meta">Objective: ${cqEsc(selectedObjective)}</span>`
      : `<span class="qbc-source-meta">All objectives</span>`;

    const modeCards = QBLOCK_FILTER_MODES.map(mode => `
      <label class="qbc-mode-card ${state.modes.includes(mode) ? "is-on" : ""}" data-mode="${mode}">
        <input type="checkbox" ${state.modes.includes(mode) ? "checked" : ""} onchange="window.qbcToggleMode('${mode}', this.checked)">
        <span class="qbc-box" aria-hidden="true"></span>
        <span class="qbc-mode-name">${QBLOCK_FILTER_MODE_LABELS[mode]}</span>
        <span class="qbc-mode-count" data-mode-count="${mode}">0</span>
      </label>`).join("");

    const rowFor = (value, attrs, count) => `<label class="qbc-check ${state[attrs.stateKey] && state[attrs.stateKey].includes(value.name) ? "is-on" : ""}" ${attrs.data}="${cqEsc(value.name)}" title="${cqEsc(value.name)}">
        <input type="checkbox" ${state[attrs.stateKey] && state[attrs.stateKey].includes(value.name) ? "checked" : ""} onchange="${attrs.toggle}(this)">
        <span class="qbc-box" aria-hidden="true"></span>
        <span class="qbc-check-label" title="${cqEsc(value.name)}">${cqEsc(value.name)}</span>
        <span class="qbc-check-count" ${attrs.countAttr}="${cqEsc(value.name)}">${value.count}</span>
      </label>`;

    const subjectRows = subjects.map(subject => rowFor(subject, { data: "data-subject", stateKey: "subjects", toggle: "window.qbcToggleSubject", countAttr: "data-subject-count" })).join("") || `<p class="qbc-empty-inline">No ${qblockLevel2Label().toLowerCase()} match this objective.</p>`;
    const systemRows = systems.map(system => rowFor(system, { data: "data-system", stateKey: "systems", toggle: "window.qbcToggleSystem", countAttr: "data-system-count" })).join("") || `<p class="qbc-empty-inline">No clinical specialties match these filters.</p>`;
    const subTopicRows = subTopics.map(subtopic => rowFor(subtopic, { data: "data-subtopic", stateKey: "subTopics", toggle: "window.qbcToggleSubTopic", countAttr: "data-subtopic-count" })).join("") || `<p class="qbc-empty-inline">No ${qblockLevel4Label().toLowerCase()} match these filters.</p>`;

    const presetChips = [
      state.topicPath && state.topicPath.length ? `<span class="qbc-filter-chip">Topic path: ${cqEsc(state.topicPath.join(" > "))} <button type="button" aria-label="Clear topic filter" onclick="window.qbcClearPreset('topic')">Ã—</button></span>` : "",
      state.tag ? `<span class="qbc-filter-chip">Tag: ${cqEsc(state.tag)} <button type="button" aria-label="Clear tag filter" onclick="window.qbcClearPreset('tag')">Ã—</button></span>` : "",
    ].filter(Boolean).join("");

    area.innerHTML = `
      <div class="qbc-page">
        <div class="qbc-top">
          <button type="button" class="qbc-back" onclick="window.openQBank()"><i data-lucide="arrow-left" aria-hidden="true"></i> Back to home</button>
          <span class="qbc-kicker">${isPrep ? "Past-exam tests" : "QBank tests"}</span>
        </div>
        <div class="qbc-heading">
          <div>
            <h1 class="qbc-title">Create test</h1>
            <p class="qbc-sub">Choose a test mode and a path from ${cqEsc(sourceMeta.name || qblockBankName())}.</p>
          </div>
          <div class="qbc-source-row">
            <label class="qbc-source-field" for="qbc-source">
              <span>Question bank</span>
              <select id="qbc-source" class="qbc-source-select" onchange="window.qbcSourceChange(this.value)">
                ${qblockBuilderSourceOptions(state)}
              </select>
            </label>
          </div>
        </div>
        ${qblockTabsHtml("builder")}
        <div class="qbc-panel">
          <section class="qbc-row">
            <div class="qbc-row-head">
              <h2>Test Mode</h2>
              <p class="qbc-row-help">Choose how this test behaves.</p>
            </div>
            <div class="qbc-row-body">
              <div class="qbc-mode-seg" role="group" aria-label="Test mode">
                <button type="button" class="qbc-mode-btn ${state.mode === "tutor" ? "is-on" : ""}" data-mode="tutor" onclick="window.qbcSetMode('tutor')"><i data-lucide="lightbulb" aria-hidden="true"></i> Tutor</button>
                <button type="button" class="qbc-mode-btn ${state.mode === "exam" ? "is-on" : ""}" data-mode="exam" onclick="window.qbcSetMode('exam')"><i data-lucide="clock" aria-hidden="true"></i> Timed</button>
              </div>
              <p class="qbc-hint" id="qbc-mode-hint">${modeDescription}</p>
            </div>
          </section>

          <section class="qbc-row">
            <div class="qbc-row-head">
              <h2>Question Mode</h2>
              <p class="qbc-row-help">Pick one or more states. Counts follow the objective and taxonomy filters.</p>
            </div>
            <div class="qbc-row-body">
              <div class="qbc-mode-list" id="qbc-modes">${modeCards}</div>
              <p class="qbc-hint">Unused questions have not been answered or omitted. Selecting no mode includes the whole pool.</p>
            </div>
          </section>

          <section class="qbc-row">
            <div class="qbc-row-head">
              <h2>Educational Objective</h2>
              <p class="qbc-row-help">Optional scope. ${qblockTaxonomyCrumb()}.</p>
            </div>
            <div class="qbc-row-body">
              <select id="qbc-objective" class="qbc-objective-select" aria-label="Educational objective" onchange="window.qbcObjectiveChange(this.value)">
                ${optionHtml}
              </select>
              <div class="qbc-objective-meta" id="qbc-objective-meta">${objectiveNote}</div>
            </div>
          </section>

          <section class="qbc-row">
            <div class="qbc-row-head">
              <h2>${qblockLevel2Label()}</h2>
              <p class="qbc-row-help">Leave everything unchecked for a mixed test.</p>
            </div>
            <div class="qbc-row-body">
              <div class="qbc-row-tools">
                <button type="button" class="qbc-tool" onclick="window.qbcAllSubjects()">Select all</button>
                <button type="button" class="qbc-tool" onclick="window.qbcClearSubjects()">Clear</button>
              </div>
              <div class="qbc-check-grid" id="qbc-subjects">${subjectRows}</div>
            </div>
          </section>

          ${isModule ? "" : `<section class="qbc-row">
            <div class="qbc-row-head">
              <h2>Clinical Specialties</h2>
              <p class="qbc-row-help">Specialties inside the selected organ systems.</p>
            </div>
            <div class="qbc-row-body">
              <div class="qbc-row-tools">
                <input class="qbc-filter-input" id="qbc-clinical-filter" type="search" placeholder="Filter clinical specialties..." aria-label="Filter clinical specialties" oninput="window.qbcFilterList('system', this.value)">
                <span class="qbc-source-meta" id="qbc-system-selected">${state.systems.length ? `${state.systems.length} selected` : "All systems"}</span>
                <button type="button" class="qbc-tool" onclick="window.qbcAllSystems()">Select all</button>
                <button type="button" class="qbc-tool" onclick="window.qbcClearSystems()">Clear</button>
              </div>
              <div class="qbc-systems qbc-clickable-grid" id="qbc-systems">${systemRows}</div>
            </div>
          </section>`}

          <section class="qbc-row">
            <div class="qbc-row-head">
              <h2>${qblockLevel4Label()}</h2>
              <p class="qbc-row-help">${isModule ? "Leaf topics inside the selected subjects/systems." : "Optional diseases and leaf-level topics."}</p>
            </div>
            <div class="qbc-row-body">
              <div class="qbc-row-tools">
                <input class="qbc-filter-input" id="qbc-subtopic-filter" type="search" placeholder="Filter ${qblockLevel4Label().toLowerCase()}..." aria-label="Filter ${qblockLevel4Label().toLowerCase()}" oninput="window.qbcFilterList('subtopic', this.value)">
                <span class="qbc-source-meta" id="qbc-subtopic-selected">${state.subTopics.length ? `${state.subTopics.length} selected` : `All ${qblockLevel4Label().toLowerCase()}`}</span>
                <button type="button" class="qbc-tool" onclick="window.qbcClearSubTopics()">Clear</button>
              </div>
              <div class="qbc-systems qbc-subtopic-grid" id="qbc-subtopics">${subTopicRows}</div>
            </div>
          </section>

          <section class="qbc-row">
            <div class="qbc-row-head">
              <h2>No. of Questions</h2>
              <p class="qbc-row-help">Maximum ${QBLOCK_MAX_QUESTIONS} questions per test.</p>
            </div>
            <div class="qbc-row-body">
              <div class="qbc-count-line">
                <input id="qbc-count" class="qbc-count-input" type="number" inputmode="numeric" min="1" max="${QBLOCK_MAX_QUESTIONS}" value="${state.count}" oninput="window.qbcCountInput(this)" onblur="window.qbcSync()" aria-label="Number of questions">
                <span class="qbc-count-note">Maximum <b>${QBLOCK_MAX_QUESTIONS}</b> per test</span>
              </div>
              <p class="qbc-available" id="qbc-available"></p>
              ${presetChips ? `<div class="qbc-activefilters" id="qbc-preset-filters"><span>Topic path</span>${presetChips}</div>` : ""}
            </div>
          </section>

          <div class="qbc-actionbar">
            <div class="qbc-summary">
              <b id="qbc-summary">—</b>
              <span id="qbc-summary-detail"></span>
            </div>
            <button type="button" class="qbc-generate" id="qbc-generate" onclick="window.qbcGenerate()">
              <i data-lucide="play" aria-hidden="true"></i> <span id="qbc-generate-label">Generate test</span>
            </button>
          </div>
        </div>
        <p class="qbc-foot">Your test is saved automatically. Resume it from Previous tests any time.</p>
      </div>`;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    window.qbcSync();
  }

  function qblockPruneBuilderFilters(state) {
    if (!state) return;
    const base = qblockActiveQuestions();
    const objective = String(state.objective || "");
    const byObjective = objective ? base.filter(q => qblockObjectiveOf(q) === objective) : base;
    const subjectSet = new Set(byObjective.map(qblockSubjectOf));
    state.subjects = (Array.isArray(state.subjects) ? state.subjects : []).filter(name => subjectSet.has(name));

    const bySubject = state.subjects.length ? byObjective.filter(q => state.subjects.includes(qblockSubjectOf(q))) : byObjective;
    const systemSet = new Set(bySubject.map(qblockClinicalSpecialtyOf));
    state.systems = (Array.isArray(state.systems) ? state.systems : []).filter(name => systemSet.has(name));

    const bySystem = state.systems.length ? bySubject.filter(q => state.systems.includes(qblockClinicalSpecialtyOf(q))) : bySubject;
    const subTopicSet = new Set(bySystem.map(qblockSubTopicOf));
    state.subTopics = (Array.isArray(state.subTopics) ? state.subTopics : []).filter(name => subTopicSet.has(name));
  }

  window.qbcObjectiveChange = function(value) {
    const state = window.__qblockBuilderV2;
    if (!state) return;
    state.objective = String(value || "");
    qblockPruneBuilderFilters(state);
    window.qbcSync();
  };

  window.qbcFilterList = function(kind, value) {
    const wanted = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
    const selector = kind === "subtopic" ? ".qbc-check[data-subtopic]" : ".qbc-check[data-system]";
    document.querySelectorAll(selector).forEach(row => {
      row.style.display = !wanted || String(row.dataset[kind === "subtopic" ? "subtopic" : "system"] || "").toLowerCase().includes(wanted) ? "" : "none";
    });
  };

  window.qbcSync = function(skipInputs) {
    const state = window.__qblockBuilderV2;
    if (!state) return;
    const data = qblockBuilderData();
    const available = data.available;

    const objectiveSelect = document.getElementById("qbc-objective");
    if (objectiveSelect) objectiveSelect.value = String(state.objective || "");
    const objectiveMeta = document.getElementById("qbc-objective-meta");
    if (objectiveMeta) {
      objectiveMeta.innerHTML = state.objective
        ? `<span class="qbc-source-meta">Objective: ${cqEsc(state.objective)}</span>`
        : `<span class="qbc-source-meta">All objectives</span>`;
    }

    document.querySelectorAll(".qbc-mode-btn[data-mode]").forEach(button => {
      button.classList.toggle("is-on", button.dataset.mode === state.mode);
      button.setAttribute("aria-pressed", button.dataset.mode === state.mode ? "true" : "false");
    });
    document.querySelectorAll(".qbc-mode-card[data-mode]").forEach(card => {
      const mode = card.dataset.mode;
      const on = state.modes.includes(mode);
      card.classList.toggle("is-on", on);
      card.classList.toggle("is-disabled", (data.modeCounts[mode] || 0) === 0);
      const input = card.querySelector("input");
      if (input) {
        input.checked = on;
        input.disabled = (data.modeCounts[mode] || 0) === 0 && !on;
      }
      const count = card.querySelector(".qbc-mode-count");
      if (count) count.textContent = String(data.modeCounts[mode] || 0);
    });

    const setRows = (selector, countMap, enabledNames, stateList, countAttr) => {
      document.querySelectorAll(selector).forEach(row => {
        const name = row.dataset[selector === ".qbc-check[data-subject]" ? "subject" : selector === ".qbc-check[data-system]" ? "system" : "subtopic"];
        const count = countMap[name] || 0;
        const visible = enabledNames.includes(name);
        row.style.display = visible ? "" : "none";
        const on = stateList.includes(name);
        row.classList.toggle("is-on", on);
        row.classList.toggle("is-empty", count === 0);
        const input = row.querySelector("input");
        if (input) {
          input.checked = on;
          input.disabled = count === 0 && !on;
        }
        const countEl = row.querySelector("[" + countAttr + "]");
        if (countEl) countEl.textContent = String(count);
      });
    };
    setRows(".qbc-check[data-subject]", data.subjectCounts, data.subjectNames || [], state.subjects || [], "data-subject-count");
    setRows(".qbc-check[data-system]", data.systemCounts, data.systemNames || [], state.systems || [], "data-system-count");
    setRows(".qbc-check[data-subtopic]", data.subTopicCounts, data.subTopicNames || [], state.subTopics || [], "data-subtopic-count");

    const systemSelected = document.getElementById("qbc-system-selected");
    if (systemSelected) {
      systemSelected.textContent = state.systems.length
        ? `${state.systems.length} clinical ${state.systems.length === 1 ? "specialty" : "specialties"} selected`
        : "All specialties";
    }
    const subTopicSelected = document.getElementById("qbc-subtopic-selected");
    if (subTopicSelected) {
      const noun = qblockLevel4Label().toLowerCase();
      subTopicSelected.textContent = state.subTopics.length
        ? `${state.subTopics.length} ${noun} selected`
        : `All ${noun}`;
    }

    const summary = document.getElementById("qbc-summary");
    const detail = document.getElementById("qbc-summary-detail");
    const availableEl = document.getElementById("qbc-available");
    const countInput = document.getElementById("qbc-count");
    const count = Math.max(1, Math.min(QBLOCK_MAX_QUESTIONS, Number(state.count) || QBLOCK_MAX_QUESTIONS));
    if (availableEl) availableEl.textContent = `${available.toLocaleString()} question${available === 1 ? "" : "s"} match these filters.`;
    if (summary) summary.textContent = `${Math.min(count, available || count)} question${Math.min(count, available || count) === 1 ? "" : "s"} · ${state.mode === "tutor" ? "Tutor" : "Timed"}`;
    if (detail) {
      const bits = [];
      bits.push(state.modes.length ? QBLOCK_FILTER_MODES.filter(mode => state.modes.includes(mode)).map(mode => QBLOCK_FILTER_MODE_LABELS[mode]).join(", ") : "All questions");
      if (state.objective) bits.push(`Objective`);
      if (state.subjects.length) bits.push(state.subjects.length === 1 ? state.subjects[0] : `${state.subjects[0]} +${state.subjects.length - 1}`);
      else bits.push(`All ${qblockLevel2Label().toLowerCase()}`);
      if (!qblockIsModule()) {
        if (state.systems.length) bits.push(state.systems.length === 1 ? state.systems[0] : `${state.systems[0]} +${state.systems.length - 1}`);
        else bits.push("All clinical specialties");
      }
      if (state.subTopics.length) bits.push(state.subTopics.length === 1 ? state.subTopics[0] : `${state.subTopics[0]} +${state.subTopics.length - 1}`);
      if (state.mode === "exam") bits.push(`${Math.ceil((Number(state.blockTimeSec) || QBLOCK_SECONDS_PER_QUESTION * count) / 60)} min`);
      detail.textContent = bits.join(" · ");
    }
    if (countInput) countInput.value = String(count);
    const generate = document.getElementById("qbc-generate");
    if (generate) generate.disabled = available <= 0;
  };

  window.qbcSetMode = function(mode) {
    const state = window.__qblockBuilderV2;
    if (!state || !["tutor", "exam"].includes(mode)) return;
    state.mode = mode;
    window.qbcSync();
  };

  window.qbcToggleMode = function(mode, checked) {
    const state = window.__qblockBuilderV2;
    if (!state || !QBLOCK_FILTER_MODES.includes(mode)) return;
    const has = state.modes.includes(mode);
    if (checked && !has) state.modes = [...state.modes, mode];
    if (!checked && has) state.modes = state.modes.filter(item => item !== mode);
    window.qbcSync();
  };

  window.qbcToggleSubject = function(input) {
    const state = window.__qblockBuilderV2;
    if (!state || !input) return;
    const row = input.closest("[data-subject]");
    const name = row ? row.dataset.subject : "";
    if (!name) return;
    if (input.checked) {
      if (!state.subjects.includes(name)) state.subjects = [...state.subjects, name];
    } else {
      state.subjects = state.subjects.filter(item => item !== name);
    }
    qblockPruneBuilderFilters(state);
    window.qbcSync();
  };

  window.qbcAllSubjects = function() {
    const state = window.__qblockBuilderV2;
    if (!state) return;
    const base = qblockActiveQuestions();
    const objective = String(state.objective || "");
    const scoped = objective ? base.filter(q => qblockObjectiveOf(q) === objective) : base;
    state.subjects = qblockSubjectCounts(scoped).map(subject => subject.name);
    qblockPruneBuilderFilters(state);
    window.qbcSync();
  };

  window.qbcClearSubjects = function() {
    const state = window.__qblockBuilderV2;
    if (!state) return;
    state.subjects = [];
    qblockPruneBuilderFilters(state);
    window.qbcSync();
  };

  window.qbcToggleSystem = function(input) {
    const state = window.__qblockBuilderV2;
    if (!state || !input) return;
    const row = input.closest("[data-system]");
    const name = row ? row.dataset.system : "";
    if (!name) return;
    if (input.checked) {
      if (!state.systems.includes(name)) state.systems = [...state.systems, name];
    } else {
      state.systems = state.systems.filter(item => item !== name);
    }
    qblockPruneBuilderFilters(state);
    window.qbcSync();
  };

  window.qbcAllSystems = function() {
    const state = window.__qblockBuilderV2;
    if (!state) return;
    const base = qblockActiveQuestions();
    const objective = String(state.objective || "");
    const scoped = objective ? base.filter(q => qblockObjectiveOf(q) === objective) : base;
    const bySubject = state.subjects.length ? scoped.filter(q => state.subjects.includes(qblockSubjectOf(q))) : scoped;
    state.systems = qblockSystemCounts(bySubject).map(system => system.name);
    qblockPruneBuilderFilters(state);
    window.qbcSync();
  };

  window.qbcClearSystems = function() {
    const state = window.__qblockBuilderV2;
    if (!state) return;
    state.systems = [];
    qblockPruneBuilderFilters(state);
    window.qbcSync();
  };

  window.qbcToggleSubTopic = function(input) {
    const state = window.__qblockBuilderV2;
    if (!state || !input) return;
    const row = input.closest("[data-subtopic]");
    const name = row ? row.dataset.subtopic : "";
    if (!name) return;
    if (input.checked) {
      if (!state.subTopics.includes(name)) state.subTopics = [...state.subTopics, name];
    } else {
      state.subTopics = state.subTopics.filter(item => item !== name);
    }
    window.qbcSync();
  };

  window.qbcClearSubTopics = function() {
    const state = window.__qblockBuilderV2;
    if (!state) return;
    state.subTopics = [];
    window.qbcSync();
  };


  window.qbcCountInput = function(input) {
    const state = window.__qblockBuilderV2;
    if (!state || !input) return;
    const raw = String(input.value || "").replace(/[^\d]/g, "");
    if (raw !== input.value) input.value = raw;
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) state.count = Math.max(1, Math.min(QBLOCK_MAX_QUESTIONS, parsed));
    window.qbcSync(true);
  };

  window.qbcClearPreset = function(kind) {
    const state = window.__qblockBuilderV2;
    if (!state) return;
    if (kind === "topic") state.topicPath = [];
    if (kind === "tag") state.tag = "";
    qblockRenderBuilder();
  };

  function qblockBuilderPath(path) {
    if (!Array.isArray(path) || !path.length) return [];
    const cleaned = path.map(qblockTaxonomyClean).filter(Boolean);
    return cleaned.length === 3 ? ["General educational objective", ...cleaned] : cleaned.slice(0, 4);
  }

  window.qbcChooseObjective = function(objective) {
    const state = window.__qblockBuilderV2;
    if (!state) return;
    state.objective = objective || "";
    qblockPruneBuilderFilters(state);
    window.qbcSync();
  };

  window.qbcSourceChange = function(bankId) {
    if (!bankId) return;
    const state = window.__qblockBuilderV2;
    return qblockOpenBuilderScreen({
      bankId,
      mode: state ? state.mode : "exam",
      modes: state ? state.modes : ["unused"],
      objective: state ? state.objective : "",
      subjects: state ? [...state.subjects] : [],
      systems: state ? [...state.systems] : [],
      subTopics: state ? [...state.subTopics] : [],
      count: state ? state.count : QBLOCK_MAX_QUESTIONS,
    });
  };

  window.qbcGenerate = function() {
    const state = window.__qblockBuilderV2;
    if (!state) return;
    const data = qblockBuilderData();
    if (!data.pool.length) {
      if (window.qbankToast) window.qbankToast("No questions match these filters.", true);
      return;
    }
    const count = Math.max(1, Math.min(state.count, QBLOCK_MAX_QUESTIONS, data.pool.length));
    const questions = qblockShuffle(data.pool).slice(0, count);
    const timeLimitSec = state.mode === "exam" ? count * QBLOCK_SECONDS_PER_QUESTION : null;
    window.qbankStartBlock({
      bankId: state.bankId,
      bankName: qblockBankName(),
      mode: state.mode,
      questions,
      timeLimitSec,
      filters: {
        subjects: [...state.subjects],
        systems: [...state.systems],
        subTopics: [...(state.subTopics || [])],
        objective: state.objective || "",
        modes: [...state.modes],
        topicPath: Array.isArray(state.topicPath) ? [...state.topicPath] : [],
        tag: state.tag || "",
        random: true,
        requestedCount: count,
      },
    });
  };

  async function qblockOpenBuilderScreen(opts = {}) {
    qblockEnsureStyles();
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    if (!qblockConfirmLeaveActive()) return;
    if (window.__qbankBlock && window.__qbankBlock.active) qblockCleanup();
    qblockShowHomeShell();

    if (opts.tab === "history") {
      window.setQBankNav && window.setQBankNav("past-blocks");
      qblockRenderHistory();
      return;
    }

    let bankId = opts.bankId || currentQBankId || (window.db && window.db.selectedQBankId);
    if (opts.pickExamPrep && !opts.bankId) {
      const sources = qblockSourceBanks();
      const saved = window.cqGetSavedCollege ? window.cqGetSavedCollege() : null;
      const preferred = saved
        ? sources.prep.filter(bank => (bank.country || "global") === saved.country && (bank.college || "General") === saved.college)
        : [];
      bankId = (preferred[0] || sources.prep[0] || {}).id || "";
      if (!bankId) {
        if (window.qbankToast) window.qbankToast("No exam-prep banks are available yet.", true);
        return;
      }
    }
    if (!bankId) {
      try { await window.bootstrapAccess(true); } catch (_) {}
      bankId = currentQBankId || (window.db && window.db.selectedQBankId);
    }
    if (!bankId) {
      if (window.qbankToast) window.qbankToast("Choose a QBank before creating a test.", true);
      return;
    }

    window.setQBankNav && window.setQBankNav("blocks");
    area.innerHTML = `<div class="qbc-page"><div class="qbc-panel"><div class="qbc-loading">Loading your test builder…</div></div></div>`;
    try {
      await qblockLoadBankQuestions(bankId);
    } catch (error) {
      area.innerHTML = `<div class="qbc-page"><div class="qbc-panel qbc-error">
        <h2>Could not load this bank</h2>
        <p>${cqEsc((error && error.message) || "Please try again.")}</p>
        <button type="button" class="qbc-back" onclick="window.qbankOpenBlockBuilder()">Try again</button>
      </div></div>`;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      return;
    }

    currentQBankId = bankId;
    const entry = cachedQBanks[bankId] || {};
    allQuestions = Array.isArray(entry.questions) ? entry.questions : [];
    if (entry.progress) window.qbankProgress = entry.progress;
    const nameEl = document.getElementById("qbank-active-name");
    const meta = (cachedCategories || []).find(bank => bank.id === bankId);
    if (nameEl && meta && meta.name) nameEl.textContent = meta.name;

    const baseQuestions = qblockActiveQuestions();
    const allObjectiveNames = qblockObjectiveCounts(baseQuestions).map(item => item.name);
    const subjectNames = qblockSubjectCounts(baseQuestions).map(subject => subject.name);
    const systemNames = qblockSystemCounts(baseQuestions).map(system => system.name);
    const subTopicNames = qblockSubTopicCounts(baseQuestions).map(subtopic => subtopic.name);
    const path = qblockBuilderPath(opts.topicPath || []);

    let objective = String(
      opts.objective !== undefined
        ? opts.objective
        : (path.length ? path[0] : "")
    ).trim();
    const canonicalObjective = qblockCanonicalName(allObjectiveNames, objective);
    if (canonicalObjective) objective = canonicalObjective;

    let subjects = Array.isArray(opts.subjects) ? [...opts.subjects] : [];
    if (!subjects.length && path.length > 1) subjects = [path[1]];
    if (opts.subject) subjects.push(opts.subject);
    const canonicalSubject = path.length > 1 ? qblockCanonicalName(subjectNames, path[1]) : qblockCanonicalName(subjectNames, opts.organSystem || opts.chapter || "");
    subjects = subjects.map(name => {
      const canonical = qblockCanonicalName(subjectNames, name);
      return canonical || String(name || "").trim();
    }).filter(Boolean);

    let systems = Array.isArray(opts.systems) ? [...opts.systems] : [];
    if (!systems.length && path.length > 2) systems = [path[2]];
    if (opts.system) systems.push(opts.system);
    systems = systems.map(name => {
      const canonical = qblockCanonicalName(systemNames, name);
      return canonical || String(name || "").trim();
    }).filter(Boolean);

    let subTopics = Array.isArray(opts.subTopics) ? [...opts.subTopics] : [];
    if (!subTopics.length && path.length > 3) subTopics = [path[3]];
    if (opts.subTopic) subTopics.push(opts.subTopic);
    subTopics = subTopics.map(name => {
      const canonical = qblockCanonicalName(subTopicNames, name);
      return canonical || String(name || "").trim();
    }).filter(Boolean);

    let modes = Array.isArray(opts.modes) ? opts.modes.filter(mode => QBLOCK_FILTER_MODES.includes(mode)) : [];
    if (!modes.length && opts.reviewIncorrectsOnly) modes = ["incorrect", "marked"];
    if (!modes.length) modes = ["unused"];

    const total = qblockActiveQuestions().length;
    const count = Math.max(1, Math.min(QBLOCK_MAX_QUESTIONS, parseInt(opts.count, 10) || Math.min(QBLOCK_MAX_QUESTIONS, total || QBLOCK_MAX_QUESTIONS)));
    window.__qblockBuilderV2 = {
      bankId,
      mode: opts.mode === "tutor" ? "tutor" : "exam",
      count,
      modes,
      objective,
      subjects,
      systems,
      subTopics,
      topicPath: [],
      tag: opts.tag || "",
      expandedSystems: false,
    };
    qblockRenderBuilder();
  }

  function qblockHistoryCard(record) {
    const total = Number(record.questionCount) || (Array.isArray(record.questionIds) ? record.questionIds.length : 0);
    const answered = qblockRecordAnswered(record);
    const completed = record.status === "completed";
    const score = qblockRecordScore(record);
    const tone = !completed ? "is-progress" : score >= 80 ? "" : score >= 60 ? "is-mid" : "is-low";
    const statusPill = completed
      ? `<span class="qbh-pill is-complete">Completed</span>`
      : `<span class="qbh-pill is-progress">In progress</span>`;
    const scoreMarkup = completed
      ? `<b>${score}%</b><small>score</small>`
      : `<b>${answered}/${total}</b><small>done</small>`;
    const progressPct = total ? Math.max(0, Math.min(100, Math.round((answered / total) * 100))) : 0;
    const filters = record.filters || {};
    const subjectLabel = Array.isArray(filters.subjects) && filters.subjects.length
      ? (filters.subjects.length === 1 ? filters.subjects[0] : `${filters.subjects[0]} +${filters.subjects.length - 1}`)
      : "All organ systems";
    const systemLabel = Array.isArray(filters.systems) && filters.systems.length
      ? (filters.systems.length === 1 ? filters.systems[0] : `${filters.systems[0]} +${filters.systems.length - 1}`)
      : "All clinical specialties";
    const subTopicLabel = Array.isArray(filters.subTopics) && filters.subTopics.length
      ? (filters.subTopics.length === 1 ? filters.subTopics[0] : `${filters.subTopics[0]} +${filters.subTopics.length - 1}`)
      : "";
    const objectiveLabel = filters.objective ? String(filters.objective).slice(0, 120) : "";
    const modesLabel = qblockModeLabelList(filters.modes) || "All questions";
    const actions = completed
      ? `<button type="button" class="qbh-btn primary" onclick="window.qbankBlockHistoryAction('review','${cqJsArg(record.id)}')"><i data-lucide="book-open" aria-hidden="true"></i> Review</button>
         <button type="button" class="qbh-btn" onclick="window.qbankBlockHistoryAction('retake','${cqJsArg(record.id)}')"><i data-lucide="rotate-ccw" aria-hidden="true"></i> Retake</button>
         <button type="button" class="qbh-btn danger" onclick="window.qbankBlockHistoryAction('delete','${cqJsArg(record.id)}')"><i data-lucide="trash-2" aria-hidden="true"></i> Delete</button>`
      : `<button type="button" class="qbh-btn primary" onclick="window.qbankBlockHistoryAction('resume','${cqJsArg(record.id)}')"><i data-lucide="play" aria-hidden="true"></i> Resume</button>
         <button type="button" class="qbh-btn danger" onclick="window.qbankBlockHistoryAction('delete','${cqJsArg(record.id)}')"><i data-lucide="trash-2" aria-hidden="true"></i> Delete</button>`;
    return `<article class="qbh-card">
      <div class="qbh-score ${tone}">${scoreMarkup}</div>
      <div class="qbh-main">
        <div class="qbh-title-row">
          <h2>${cqEsc(qblockRecordTitle(record))}</h2>
          ${statusPill}
          <span class="qbh-pill">${qblockRecordModeLabel(record)}</span>
        </div>
        <div class="qbh-meta">
          <span><b>${total}</b> questions</span><span class="qbh-meta-sep">·</span>
          <span>${cqEsc(subjectLabel)}</span><span class="qbh-meta-sep">·</span>
          <span>${cqEsc(systemLabel)}</span>
          ${subTopicLabel ? `<span class="qbh-meta-sep">·</span><span>${cqEsc(subTopicLabel)}</span>` : ""}
          <span class="qbh-meta-sep">·</span>
          <span>${cqEsc(modesLabel)}</span>
        </div>
        ${objectiveLabel ? `<div class="qbh-meta" style="margin-top:3px;"><span>${cqEsc(objectiveLabel)}</span></div>` : ""}
        <div class="qbh-meta" style="margin-top:3px;">
          <span>${qblockRecordWhen(record.completedAt || record.updatedAt || record.startedAt)}</span>
          <span class="qbh-meta-sep">·</span>
          <span>${cqEsc(record.bankName || "QBank")}</span>
          ${record.timeLimitSec ? `<span class="qbh-meta-sep">·</span><span>${Math.round(record.timeLimitSec / 60)} min limit</span>` : ""}
        </div>
        ${completed ? "" : `<div class="qbh-progress" aria-hidden="true"><span style="width:${progressPct}%"></span></div>`}
      </div>
      <div class="qbh-actions">${actions}</div>
    </article>`;
  }

  function qblockRenderHistory() {
    qblockEnsureStyles();
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    qblockShowHomeShell();
    window.setQBankNav && window.setQBankNav("past-blocks");

    const records = qblockReadHistory();
    const completed = records.filter(record => record.status === "completed");
    const scored = completed.map(record => qblockRecordScore(record)).filter(score => score !== null);
    const average = scored.length ? Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length) : null;
    const totalQuestions = records.reduce((sum, record) => sum + (Number(record.questionCount) || (record.questionIds || []).length), 0);
    const filter = window.__qblockHistoryFilter || "all";
    const filtered = records.filter(record => {
      if (filter === "in_progress") return record.status === "in_progress";
      if (filter === "completed") return record.status === "completed";
      return true;
    });

    let list = "";
    if (filtered.length) {
      list = `<div class="qbh-list">${filtered.map(qblockHistoryCard).join("")}</div>`;
    } else if (!records.length) {
      list = `<div class="qbh-empty">
        <div class="qbh-empty-ic"><i data-lucide="layers" aria-hidden="true"></i></div>
        <h2>No previous tests yet</h2>
        <p>Create your first test and it will appear here automatically.</p>
        <button type="button" class="qbh-btn primary" onclick="window.qbankOpenBlockBuilder()"><i data-lucide="plus" aria-hidden="true"></i> Create test</button>
      </div>`;
    } else {
      list = `<div class="qbh-empty">
        <div class="qbh-empty-ic"><i data-lucide="filter" aria-hidden="true"></i></div>
        <h2>No tests match this filter</h2>
        <p>Try another status filter to see your saved tests.</p>
        <button type="button" class="qbh-btn" onclick="window.qbcHistoryFilter('all')">Show all tests</button>
      </div>`;
    }

    area.innerHTML = `<div class="qbh-page">
      <div class="qbh-top">
        <button type="button" class="qbh-back" onclick="window.openQBank()"><i data-lucide="arrow-left" aria-hidden="true"></i> Back to home</button>
        <span class="qbh-kicker">QBank history</span>
      </div>
      <div class="qbh-heading">
        <div>
          <h1 class="qbh-title">Previous tests</h1>
          <p class="qbh-sub">Resume unfinished tests, review completed tests, or retake a test with the same filters.</p>
        </div>
        <button type="button" class="qbh-btn primary" onclick="window.qbankOpenBlockBuilder()"><i data-lucide="plus" aria-hidden="true"></i> Create test</button>
      </div>
      ${qblockTabsHtml("history")}
      <div class="qbh-stats">
        <div class="qbh-stat"><b>${records.length}</b><small>total tests</small></div>
        <div class="qbh-stat"><b>${completed.length}</b><small>completed</small></div>
        <div class="qbh-stat"><b>${average === null ? "—" : average + "%"}</b><small>average score</small></div>
        <div class="qbh-stat"><b>${totalQuestions.toLocaleString()}</b><small>questions practised</small></div>
      </div>
      <div class="qbh-filterbar" role="group" aria-label="Filter previous tests">
        <button type="button" class="qbh-filter ${filter === "all" ? "is-on" : ""}" onclick="window.qbcHistoryFilter('all')">All tests</button>
        <button type="button" class="qbh-filter ${filter === "in_progress" ? "is-on" : ""}" onclick="window.qbcHistoryFilter('in_progress')">In progress</button>
        <button type="button" class="qbh-filter ${filter === "completed" ? "is-on" : ""}" onclick="window.qbcHistoryFilter('completed')">Completed</button>
      </div>
      ${list}
    </div>`;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }

  window.qbcHistoryFilter = function(filter) {
    window.__qblockHistoryFilter = ["all", "in_progress", "completed"].includes(filter) ? filter : "all";
    qblockRenderHistory();
  };

  window.qbankBlockBuilderTab = function(tab) {
    if (tab === "history") {
      qblockRenderHistory();
      return;
    }
    if (!window.__qblockBuilderV2) return window.qbankOpenBlockBuilder();
    window.setQBankNav && window.setQBankNav("blocks");
    qblockRenderBuilder();
  };

  async function qblockOpenSavedBlock(record, action) {
    if (!record) return;
    qblockEnsureStyles();
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    if (!qblockConfirmLeaveActive()) return;
    if (window.__qbankBlock && window.__qbankBlock.active) qblockCleanup();
    qblockShowHomeShell();
    area.innerHTML = `<div class="qbc-page"><div class="qbc-panel"><div class="qbc-loading">${action === "retake" ? "Rebuilding your test…" : "Loading your test…"}</div></div></div>`;
    try {
      await qblockLoadBankQuestions(record.bankId);
    } catch (error) {
      if (window.qbankToast) window.qbankToast("Could not load this block's questions.", true);
      qblockRenderHistory();
      return;
    }
    currentQBankId = record.bankId;
    const entry = cachedQBanks[record.bankId] || {};
    allQuestions = Array.isArray(entry.questions) ? entry.questions : [];
    if (entry.progress) window.qbankProgress = entry.progress;
    const byId = {};
    allQuestions.forEach(question => { if (question && question.id) byId[question.id] = question; });
    const questionIds = Array.isArray(record.questionIds) ? record.questionIds : [];
    const questions = questionIds.map(id => byId[id]).filter(Boolean);
    if (!questions.length) {
      if (window.qbankToast) window.qbankToast("The questions in this block are no longer available.", true);
      qblockRenderHistory();
      return;
    }

    const common = {
      bankId: record.bankId,
      bankName: record.bankName || qblockBankName(),
      mode: record.mode === "tutor" ? "tutor" : "exam",
      questions,
      filters: record.filters || {},
    };

    if (action === "retake") {
      window.qbankStartBlock({
        ...common,
        timeLimitSec: record.timeLimitSec ? questions.length * QBLOCK_SECONDS_PER_QUESTION : null,
      });
      return;
    }

    if (action === "review" && record.results) {
      window.qbankStartBlock({
        ...common,
        answers: record.answers || {},
        timeByQ: record.timeByQ || {},
        timeLimitSec: record.timeLimitSec || null,
        startedAt: record.startedAt,
        submitted: true,
        results: record.results,
        completedAt: record.completedAt,
        recordId: record.id,
      });
      window.qbankBlockReview();
      return;
    }

    const elapsedSec = Math.max(0, Number(record.elapsedSec) || 0);
    const remainingSec = record.remainingSec === null || record.remainingSec === undefined
      ? null
      : Math.max(0, Number(record.remainingSec) || 0);
    window.qbankStartBlock({
      ...common,
      answers: record.answers || {},
      timeByQ: record.timeByQ || {},
      timeLimitSec: record.timeLimitSec || null,
      startedAt: Date.now() - elapsedSec * 1000,
      deadline: remainingSec === null ? null : Date.now() + remainingSec * 1000,
      currentIndex: Math.max(0, Number(record.currentIndex) || 0),
      recordId: record.id,
    });
  }

  window.qbankBlockHistoryAction = async function(action, recordId) {
    const record = qblockFindRecord(recordId);
    if (!record) {
      qblockRenderHistory();
      return;
    }
    if (action === "delete") {
      const ok = window.confirm("Delete this block from your history? This cannot be undone.");
      if (!ok) return;
      qblockDeleteRecord(record.id);
      qblockRenderHistory();
      return;
    }
    if (action === "resume" || action === "review" || action === "retake") {
      return qblockOpenSavedBlock(record, action);
    }
  };

  function qblockUpdateEndButton(label) {
    const btn = document.getElementById("qbank-end-btn");
    if (!btn) return;
    const text = label || "End Session";
    const span = btn.querySelector("#qbank-end-label");
    if (span) span.textContent = text;
    else btn.innerHTML = `<i class="fa-solid fa-circle-stop"></i> ${text}`;
  }

  function qblockStopTimer() {
    const b = window.__qbankBlock;
    if (b && b.timerId) {
      clearInterval(b.timerId);
      b.timerId = null;
    }
  }

  function qblockClockText() {
    const b = window.__qbankBlock;
    if (!b || !b.active) return "";
    if (b.deadline) return `${qblockFormatClock(Math.max(0, Math.ceil((b.deadline - Date.now()) / 1000)))} left`;
    return `${qblockFormatClock((Date.now() - b.startedAt) / 1000)} elapsed`;
  }

  function qblockTick() {
    const b = window.__qbankBlock;
    if (!b || !b.active || b.submitted) return;
    if (b.suspended) {
      qblockStopTimer();
      return;
    }
    const text = qblockClockText();
    const clock = document.getElementById("qbank-block-clock");
    if (clock) {
      clock.textContent = text;
      clock.classList.toggle("warn", !!(b.deadline && b.deadline - Date.now() <= 5 * 60 * 1000));
    }
    if (b.mode === "exam") {
      const header = document.getElementById("qbank-timer-display");
      if (header) header.innerHTML = `<i class="fa-regular fa-clock" style="width:14px;height:14px;vertical-align:-2px;"></i> ${text}`;
    }
    if (window.qbankUpdateBlockTime) window.qbankUpdateBlockTime();
    if (b.deadline && Date.now() >= b.deadline) {
      window.qbankSubmitBlock(true);
    }
  }

  function qblockStartTimer() {
    qblockStopTimer();
    const b = window.__qbankBlock;
    if (!b || !b.active || b.suspended) return;
    qblockTick();
    b.timerId = setInterval(qblockTick, 1000);
  }

  function qblockTrackTime() {
    const b = window.__qbankBlock;
    if (!b || !b.active || b.submitted) return;
    const q = currentQuestions[currentIndex];
    if (!q) return;
    const now = Date.now();
    const delta = Math.max(0, now - (b.questionStartedAt || now));
    b.timeByQ[q.id] = (b.timeByQ[q.id] || 0) + delta;
    b.questionStartedAt = now;
  }

  function qblockAnsweredCount() {
    const b = window.__qbankBlock;
    if (!b) return 0;
    return currentQuestions.reduce((n, q) => n + (Array.isArray(b.answers[q.id]) && b.answers[q.id].length ? 1 : 0), 0);
  }

  function qblockCleanup() {
    const b = window.__qbankBlock;
    if (!b) return;
    qblockPersistActive();
    qblockStopTimer();
    b.active = false;
    window.__qbankBlock = null;
    qblockRenderFooterBar();
    qblockUpdateEndButton("End Session");
    const sidebar = document.getElementById("qbank-sidebar");
    if (sidebar) sidebar.style.display = "none";
    window.qbankUpdateBlockTime && window.qbankUpdateBlockTime();
  }
  window.qbankBlockCleanup = qblockCleanup;

  window.qbankStartBlock = function(config) {
    qblockEnsureStyles();
    qblockCleanup();
    const questions = Array.isArray(config.questions) ? config.questions : [];
    const timeLimitSec = config.timeLimitSec || null;
    const startedAt = Number(config.startedAt) || Date.now();
    const submitted = !!(config.submitted && config.results);
    const deadlineProvided = Object.prototype.hasOwnProperty.call(config, "deadline");
    const block = {
      active: true,
      recordId: config.recordId || qblockNewRecordId(),
      mode: config.mode === "tutor" ? "tutor" : "exam",
      submitted,
      reviewing: false,
      submitting: false,
      results: submitted ? config.results : null,
      answers: config.answers && typeof config.answers === "object" ? JSON.parse(JSON.stringify(config.answers)) : {},
      timeByQ: config.timeByQ && typeof config.timeByQ === "object" ? JSON.parse(JSON.stringify(config.timeByQ)) : {},
      startedAt,
      completedAt: config.completedAt || (submitted ? Date.now() : null),
      deadline: deadlineProvided
        ? (config.deadline ? Number(config.deadline) : null)
        : (timeLimitSec ? Date.now() + timeLimitSec * 1000 : null),
      timeLimitSec,
      questionStartedAt: Date.now(),
      timerId: null,
      suspended: false,
      pausedAt: 0,
      bankId: config.bankId || currentQBankId || (window.db && window.db.selectedQBankId),
      bankName: config.bankName || qblockBankName(),
      filters: config.filters || { subjects: [], systems: [], modes: [], random: true },
      questionIds: questions.map(question => question.id).filter(Boolean),
    };
    window.__qbankBlock = block;

    currentQBankId = block.bankId;
    allQuestions = qblockActiveQuestions();
    const entry = block.bankId ? cachedQBanks[block.bankId] : null;
    if (entry && entry.progress) window.qbankProgress = entry.progress;
    currentQuestions = questions;
    currentIndex = Math.max(0, Math.min(parseInt(config.currentIndex, 10) || 0, Math.max(0, currentQuestions.length - 1)));
    window.currentQuestions = currentQuestions;
    window.currentIndex = currentIndex;
    currentSelectedIndices = [];

    const title = submitted ? "Test review" : (block.mode === "exam" ? "Timed test" : "Tutor test");
    const activeNameEl = document.getElementById("qbank-active-name");
    if (activeNameEl) activeNameEl.textContent = `${block.bankName} · ${title}`;
    if (window.hideAllMainViews) window.hideAllMainViews();
    window.setQBankNav && window.setQBankNav("blocks");
    const view = document.getElementById("qbank-home-view");
    if (view) view.style.display = "flex";
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "flex";
    const sidebar = document.getElementById("qbank-sidebar");
    if (sidebar) sidebar.style.display = "flex";
    qblockUpdateEndButton(submitted ? "End Session" : "End test");
    window.startQBankBlockClock(block.startedAt);
    window.qbankRenderCurrent();
    if (!submitted) qblockStartTimer();
    qblockPersistActive();
  };

  window.qbankBlockPick = function(index) {
    const b = window.__qbankBlock;
    const q = currentQuestions[currentIndex];
    if (!b || !b.active || b.submitted || b.mode !== "exam" || !q) return;
    const data = q.data || {};
    const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
    const isMultiple = correctIndices.length > 1 || (correctIndices.length === 0 && data.multi === true);
    let selected = Array.isArray(b.answers[q.id]) ? [...b.answers[q.id]] : [];
    if (isMultiple) {
      selected = selected.includes(index) ? selected.filter(i => i !== index) : [...selected, index].sort((a, z) => a - z);
    } else {
      selected = [index];
    }
    if (selected.length) b.answers[q.id] = selected;
    else delete b.answers[q.id];

    const container = document.getElementById("qbank-options-container");
    if (container) {
      container.querySelectorAll('input[name="qbank-radio"]').forEach(input => {
        input.checked = selected.includes(parseInt(input.value, 10));
      });
      if (window.qbankSyncOptionSelected) window.qbankSyncOptionSelected();
    }
    window.qbankRenderSidebar();
    const answeredEl = document.getElementById("qb-block-answered");
    if (answeredEl) answeredEl.textContent = `${qblockAnsweredCount()}/${currentQuestions.length}`;
    const hintEl = document.getElementById("qb-block-hint-text");
    if (hintEl) hintEl.textContent = selected.length
      ? "Answer saved. Correct answers and explanations unlock after you submit."
      : (isMultiple ? "Select all that apply. Answers unlock after you submit." : "Select one answer. Answers unlock after you submit.");
    window.qbankUpdateBlockTime && window.qbankUpdateBlockTime();
    qblockPersistActive();
  };

  window.qbankBlockNext = function() {
    const b = window.__qbankBlock;
    if (!b || !b.active) return;
    if (b.submitted) return window.qbankBlockNextReview();
    if (currentIndex >= currentQuestions.length - 1) {
      window.qbankSubmitBlock(false);
      return;
    }
    qblockTrackTime();
    currentIndex++;
    window.currentIndex = currentIndex;
    window.qbankRenderSidebar();
    window.qbankRenderCurrent();
    qblockPersistActive();
  };

  window.qbankBlockPrev = function() {
    const b = window.__qbankBlock;
    if (!b || !b.active) return;
    if (b.submitted) {
      if (currentIndex > 0) {
        currentIndex--;
        window.currentIndex = currentIndex;
        window.qbankRenderSidebar();
        window.qbankRenderCurrent();
      }
      return;
    }
    if (currentIndex <= 0) return;
    qblockTrackTime();
    currentIndex--;
    window.currentIndex = currentIndex;
    window.qbankRenderSidebar();
    window.qbankRenderCurrent();
    qblockPersistActive();
  };

  function qblockBarHtml() {
    const b = window.__qbankBlock;
    if (!b || !b.active) return "";
    const total = currentQuestions.length;
    const answered = qblockAnsweredCount();
    const atStart = currentIndex <= 0;
    const atEnd = currentIndex >= total - 1;
    if (b.submitted) {
      return `<div id="qbank-block-bar">
        <div class="qb-block-left">
          <span class="qb-block-chip">Review</span>
          <span class="qb-block-meta">Question <b>${currentIndex + 1}</b> of <b>${total}</b></span>
        </div>
        <div class="qb-block-right">
          <button type="button" class="qb-block-btn" onclick="window.qbankBlockShowResults()"><i data-lucide="bar-chart-3"></i> Results</button>
          <button type="button" class="qb-block-btn" onclick="window.qbankBlockPrev()" ${atStart ? "disabled" : ""}><i data-lucide="chevron-left"></i> Previous</button>
          <button type="button" class="qb-block-btn primary" onclick="window.qbankBlockNextReview()">${atEnd ? "Finish review" : "Next"} <i data-lucide="chevron-right"></i></button>
        </div>
      </div>`;
    }
    const modeLabel = b.mode === "exam" ? (b.timeLimitSec ? "Timed exam" : "Untimed exam") : "Tutor";
    const nextLabel = atEnd ? "Review & submit" : "Next";
    return `<div id="qbank-block-bar">
      <div class="qb-block-left">
        <span class="qb-block-chip">${modeLabel}</span>
        <span class="qb-block-meta">Question <b>${currentIndex + 1}</b> of <b>${total}</b> · <span id="qb-block-answered">${answered}/${total}</span> answered</span>
        <span class="qb-block-clock" id="qbank-block-clock"><i data-lucide="clock"></i> ${qblockClockText()}</span>
      </div>
      <div class="qb-block-right">
        <button type="button" class="qb-block-btn" onclick="window.qbankBlockPrev()" ${atStart ? "disabled" : ""}><i data-lucide="chevron-left"></i> Previous</button>
        <button type="button" class="qb-block-btn" onclick="window.qbankBlockNext()">${nextLabel} <i data-lucide="chevron-right"></i></button>
        <button type="button" class="qb-block-btn primary" onclick="window.qbankSubmitBlock(false)">${b.mode === "exam" ? "Submit test" : "Finish test"}</button>
      </div>
    </div>`;
  }
  window.qbankBlockBarHtml = qblockBarHtml;

  // The block bar lives in the green footer (not in the question canvas)
  // so it stays tappable without covering the question in timed or tutor
  // mode. The question area only receives the question itself.
  function qblockRenderFooterBar() {
    const slot = document.getElementById("qbank-block-bar-slot");
    if (!slot) return;
    const html = qblockBarHtml();
    if (slot.innerHTML !== html) slot.innerHTML = html;
    slot.style.display = html ? "flex" : "none";
    if (html && window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }
  window.qblockRenderFooterBar = qblockRenderFooterBar;

  window.qbankSubmitBlock = async function(auto) {
    const b = window.__qbankBlock;
    if (!b || !b.active || b.submitted || b.submitting) return;
    const total = currentQuestions.length;
    const answered = qblockAnsweredCount();
    const missing = total - answered;
    if (!auto && missing > 0) {
      const ok = window.confirm(`You still have ${missing} unanswered question${missing === 1 ? "" : "s"}. Submit this test anyway?`);
      if (!ok) return;
    }
    b.submitting = true;
    qblockTrackTime();
    qblockStopTimer();
    const area = document.getElementById("qbank-question-area");
    if (area) {
      area.innerHTML = `<div style="padding:60px 20px;text-align:center;color:var(--text-muted);">
        <div class="press-wrapper" style="margin:0 auto 18px;display:flex;justify-content:center;"><div class="press"><div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="sheet"></div><div class="sheet"></div><div class="sheet"></div><div class="sheet"></div><div class="roll"></div></div></div>
        <div style="font-weight:700;color:var(--text-primary);">Scoring your test…</div>
        <div style="font-size:12px;margin-top:4px;">Loading answers and explanations</div>
      </div>`;
    }
    try {
      const ids = currentQuestions.map(q => q.id).filter(Boolean);
      if (ids.length && typeof window.ensureQBankAnswers === "function") {
        await window.ensureQBankAnswers(currentQBankId, ids);
        if (typeof window.mergeQBankAnswers === "function") window.mergeQBankAnswers(currentQuestions, currentQBankId);
      }
      if (window.__qbankBlock !== b) return;
      const byId = {};
      let correct = 0, incorrect = 0, partial = 0, unanswered = 0;
      currentQuestions.forEach(q => {
        const selected = Array.isArray(b.answers[q.id]) ? b.answers[q.id] : [];
        const data = q.data || {};
        const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
        const isMultiple = correctIndices.length > 1 || (correctIndices.length === 0 && data.multi === true);
        let isCorrect = false;
        let isPartial = false;
        if (!selected.length) {
          unanswered++;
          const skipped = window.qbankProgress[q.id] || {};
          if (skipped.correct === undefined && !skipped.omitted) {
            skipped.omitted = true;
            window.qbankProgress[q.id] = skipped;
            if (currentQBankId) {
              pushToSyncQueue({
                qbankId: currentQBankId,
                questionId: q.id,
                omitted: true,
                subject: (q.data && q.data.subject) || "",
                chapter: (q.data && q.data.chapter) || "",
              });
            }
          }
          byId[q.id] = { correct: false, partial: false, unanswered: true, selected: [] };
          return;
        }
        if (isMultiple) {
          const s = [...selected].sort((a, z) => a - z);
          const c = [...correctIndices].sort((a, z) => a - z);
          isCorrect = s.length === c.length && s.every((v, i) => v === c[i]);
          isPartial = !isCorrect && selected.length > 0 && selected.every(v => correctIndices.includes(v)) && selected.length < correctIndices.length;
        } else {
          isCorrect = correctIndices.includes(selected[0]);
        }
        if (isCorrect) correct++; else incorrect++;
        if (isPartial) partial++;
        const timeMs = Math.max(0, Math.round(b.timeByQ[q.id] || 0));
        const p = window.qbankProgress[q.id] || {};
        const alreadyGraded = b.mode === "tutor" && p.correct !== undefined;
        if (!alreadyGraded) {
          p.correct = isCorrect;
          p.partial = isPartial;
          p.timeTakenMs = timeMs;
          p.omitted = false;
          window.qbankProgress[q.id] = p;
        }
        if (currentQBankId && !alreadyGraded) {
          pushToSyncQueue({
            qbankId: currentQBankId,
            questionId: q.id,
            correct: isCorrect,
            timeTakenMs: timeMs,
            omitted: false,
            subject: (q.data && q.data.subject) || "",
            chapter: (q.data && q.data.chapter) || "",
          });
        }
        byId[q.id] = { correct: isCorrect, partial: isPartial, unanswered: false, selected, correctIndices, timeMs };
      });
      try { await flushSyncQueue(); } catch (_) {}
      const secondsUsed = Math.max(0, Math.round((Date.now() - b.startedAt) / 1000));
      b.results = {
        total,
        answered,
        correct,
        incorrect,
        partial,
        unanswered,
        score: total > 0 ? Math.round((correct / total) * 100) : 0,
        secondsUsed,
        byId,
      };
      b.submitted = true;
      b.reviewing = false;
      b.submitting = false;
      b.completedAt = Date.now();
      qblockStopTimer();
      window.qbankRenderSidebar();
      window.qbankUpdateBlockTime && window.qbankUpdateBlockTime();
      qblockPersistActive();
      window.qbankBlockShowResults();
    } catch (e) {
      b.submitting = false;
      if (area) area.innerHTML = `<div style="padding:50px 20px;text-align:center;color:#e11d48;">Could not score this block: ${cqEsc(e.message || e)}<br><button class="qb-block-btn primary" style="margin-top:14px;" onclick="window.qbankRenderCurrent()">Try again</button></div>`;
    }
  };

  window.qbankBlockShowResults = function() {
    const b = window.__qbankBlock;
    if (!b || !b.active || !b.results) return;
    b.reviewing = false;
    qblockUpdateEndButton("End Session");
    const timerEl = document.getElementById("qbank-timer-display");
    if (timerEl) timerEl.innerHTML = `<i class="fa-solid fa-circle-check" style="width:14px;height:14px;vertical-align:-2px;"></i> Test complete`;
    const r = b.results;
    const area = document.getElementById("qbank-question-area");
    const sidebar = document.getElementById("qbank-sidebar");
    if (sidebar) sidebar.style.display = "none";
    if (!area) return;
    const scoreColor = r.score >= 80 ? "#15803D" : (r.score >= 60 ? "#B45309" : "#BE123C");
    area.innerHTML = `
      <div class="qbr-wrap">
        <div class="qbr-hero">
          <div class="qbr-score" style="color:${scoreColor};background:${r.score >= 80 ? "#E9F9EF" : (r.score >= 60 ? "#FFF7E6" : "#FFF0F3")};">${r.score}%</div>
          <h2>Test complete</h2>
          <p>${r.correct} of ${r.total} correct${r.partial ? ` · ${r.partial} partial` : ""} · ${b.timeLimitSec ? (b.mode === "exam" ? "Timed exam" : "Tutor, timed") : (b.mode === "exam" ? "Untimed exam" : "Tutor")} · ${qblockFormatClock(r.secondsUsed)} used</p>
        </div>
        <div class="qbr-grid">
          <div class="qbr-stat"><b style="color:#15803D;">${r.correct}</b><small>Correct</small></div>
          <div class="qbr-stat"><b style="color:#BE123C;">${r.incorrect}</b><small>Incorrect</small></div>
          <div class="qbr-stat"><b style="color:#B45309;">${r.unanswered}</b><small>Unanswered</small></div>
          <div class="qbr-stat"><b>${qblockFormatClock(r.secondsUsed)}</b><small>Time used</small></div>
        </div>
        <div class="qbr-actions">
          <button type="button" class="qbr-btn primary" onclick="window.qbankBlockReview()"><i data-lucide="book-open"></i> Review all answers</button>
          <button type="button" class="qbr-btn" onclick="window.qbankBlockRetake()"><i data-lucide="rotate-ccw"></i> Retake this test</button>
          <button type="button" class="qbr-btn" onclick="window.qbankEndSession()"><i data-lucide="home"></i> Back to home</button>
        </div>
        <p style="margin:16px 0 0;text-align:center;font-size:11.5px;color:var(--text-muted,#64748B);">Scores and explanations are saved to your QBank progress.</p>
      </div>`;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    window.qbankRenderChrome && window.qbankRenderChrome();
  };

  window.qbankBlockReview = function() {
    const b = window.__qbankBlock;
    if (!b || !b.active || !b.submitted) return;
    b.reviewing = true;
    currentIndex = 0;
    window.currentIndex = currentIndex;
    const sidebar = document.getElementById("qbank-sidebar");
    if (sidebar) sidebar.style.display = "flex";
    window.qbankRenderSidebar();
    window.qbankRenderCurrent();
  };

  window.qbankBlockNextReview = function() {
    const b = window.__qbankBlock;
    if (!b || !b.active || !b.submitted) return;
    if (currentIndex >= currentQuestions.length - 1) {
      window.qbankBlockShowResults();
      return;
    }
    currentIndex++;
    window.currentIndex = currentIndex;
    window.qbankRenderSidebar();
    window.qbankRenderCurrent();
  };

  window.qbankBlockRetake = function() {
    const b = window.__qbankBlock;
    if (!b || !b.active) return;
    b.recordId = qblockNewRecordId();
    b.submitted = false;
    b.reviewing = false;
    b.submitting = false;
    b.results = null;
    b.completedAt = null;
    b.answers = {};
    b.timeByQ = {};
    b.startedAt = Date.now();
    b.deadline = b.timeLimitSec ? Date.now() + b.timeLimitSec * 1000 : null;
    b.questionStartedAt = Date.now();
    b.suspended = false;
    b.pausedAt = 0;
    currentIndex = 0;
    window.currentIndex = currentIndex;
    const sidebar = document.getElementById("qbank-sidebar");
    if (sidebar) sidebar.style.display = "flex";
    qblockUpdateEndButton("End test");
    window.startQBankBlockClock(b.startedAt);
    window.qbankRenderSidebar();
    window.qbankRenderCurrent();
    qblockStartTimer();
    qblockPersistActive();
  };

  window.qbankEndSession = function() {
    const b = window.__qbankBlock;
    if (b && b.active && !b.submitted) {
      const ok = window.confirm("Leave this test? Your answers are saved and you can resume it from Previous tests.");
      if (!ok) return;
    }
    if (b) {
      qblockCleanup();
      window.qbankResetSessionClock && window.qbankResetSessionClock();
      window.openQBank();
      return;
    }
    window.qbankResetSessionClock && window.qbankResetSessionClock();
    if (window.closeFullscreen) window.closeFullscreen("qbank-modal");
  };

  // --- QBank Home Dashboard ---
  window.openQBank = async function () {
    if (window.__qbankBlock && window.__qbankBlock.active && !window.__qbankBlock.submitted) {
      const ok = window.confirm("Leave this test? Your answers will not be scored.");
      if (!ok) return;
    }
    if (window.__qbankBlock && window.__qbankBlock.active) qblockCleanup();
    window.qbankResetSessionClock && window.qbankResetSessionClock();
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
        // Resolve access from the academic profile first: the profile's
        // college already decides which bank the student should use, so
        // auto-select it instead of showing the bank chooser.
        try { await window.bootstrapAccess(true); } catch (_) {}
        if (navStale(myNav)) return;
        if (!window.db || !window.db.selectedQBankId) {
          try { await window.openQBankSelection(); }
          finally { if (window.hideGlobalLoader) window.hideGlobalLoader(); }
          return;
        }
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
              const catUpdated = Number(activeQBankMeta.updatedAt) || 0;
              const idbData = await getCachedQBank(activeQBankId);
              if (idbData && (!catUpdated || Number(idbData.updatedAt) === catUpdated) && idbData.questions && idbData.questions.length > 0) {
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
      const lastSession = getLastSession();
      const savedBlocks = qblockReadHistory();
      const latestBlock = savedBlocks.find(record => record.status === "in_progress") || null;

      const hour = new Date().getHours();
      let greeting = "Good morning";
      if (hour >= 12 && hour < 17) greeting = "Good afternoon";
      else if (hour >= 17) greeting = "Good evening";

      let firstName = "Doctor";
      const headerNameEl = document.getElementById("header-user-name");
      if (headerNameEl && headerNameEl.innerText) {
        const full = headerNameEl.innerText.replace(/Dr\.?\s+/i, "").trim();
        firstName = full.split(" ")[0] || "Doctor";
      }

      const streakVal = window.studyGoals && window.studyGoals.computeStreak ? window.studyGoals.computeStreak() : 0;
      const accHome = (window.db && window.db.access) || null;
      const prepBanks = cqPrepBanks();
      const prepAllowed = (id) => !accHome
        || (Array.isArray(accHome.prepIds) && accHome.prepIds.includes(id))
        || (Array.isArray(accHome.grants) && accHome.grants.includes(id));
      const prepAvailable = prepBanks.filter(q => prepAllowed(q.id));
      const prepLocked = Math.max(0, prepBanks.length - prepAvailable.length);
      const examHasAccess = prepAvailable.length > 0 || prepBanks.length === 0;

      const subjectCount = Object.keys(subjectStats).filter(s => s !== "Uncategorized").length;
      const progressPct = totalQuestions > 0 ? Math.round((totalAnswered / totalQuestions) * 100) : 0;
      const totalIncorrect = Math.max(0, totalAnswered - totalCorrect);

      let bankFlag = "";
      const activeCountry = activeQBankMeta && activeQBankMeta.country;
      if (activeCountry && activeCountry !== "global" && CQ_FLAG_CODES[activeCountry]) {
        bankFlag = `<img src="https://flagcdn.com/${CQ_FLAG_CODES[activeCountry]}.svg" alt="" class="cq-flag">`;
      } else {
        bankFlag = `<span class="cq-flag cq-flag-fallback"><i data-lucide="book-open"></i></span>`;
      }

      let continueBanner = "";
      if (latestBlock) {
        const totalForResume = Number(latestBlock.questionCount) || (latestBlock.questionIds || []).length;
        const answeredForResume = qblockRecordAnswered(latestBlock);
        const resumePct = totalForResume > 0 ? Math.round((answeredForResume / totalForResume) * 100) : 0;
        const resumeLabel = qblockRecordTitle(latestBlock);
        const resumeBank = latestBlock.bankName || activeQBankName;
        continueBanner = `
          <section class="cq-resume" aria-label="Resume your unfinished test">
            <div class="cq-resume-ic"><i data-lucide="clock-3"></i></div>
            <div class="cq-resume-text">
              <small>Test in progress</small>
              <b>${cqEsc(resumeLabel)}</b>
              <span><b>${cqEsc(resumeBank)}</b> · <b>${answeredForResume}</b> of <b>${totalForResume}</b> answered</span>
            </div>
            <div class="cq-resume-meter" aria-hidden="true"><span style="width:${resumePct}%"></span></div>
            <button type="button" class="cq-btn cq-btn-ghost" onclick="window.qbankBlockHistoryAction('resume','${cqJsArg(latestBlock.id)}')">Resume test <i data-lucide="arrow-right"></i></button>
          </section>`;
      } else if (lastSession && lastSession.qbankId) {
        const lsSubject = lastSession.subject && lastSession.subject !== "All Subjects" ? lastSession.subject : null;
        const st = lsSubject ? subjectStats[lsSubject] : null;
        const totalForResume = st ? st.total : totalQuestions;
        const answeredForResume = st ? st.answered : totalAnswered;
        const resumePct = totalForResume > 0 ? Math.round((answeredForResume / totalForResume) * 100) : 0;
        const resumeLabel = lsSubject || "Mixed practice";
        const resumeBank = lastSession.qbankName || activeQBankName;
        continueBanner = `
          <section class="cq-resume" aria-label="Continue your last session">
            <div class="cq-resume-ic"><i data-lucide="history"></i></div>
            <div class="cq-resume-text">
              <small>Pick up where you left off</small>
              <b>${cqEsc(resumeLabel)}</b>
              <span><b>${cqEsc(resumeBank)}</b> · <b>${answeredForResume}</b> of <b>${totalForResume}</b> answered</span>
            </div>
            <div class="cq-resume-meter" aria-hidden="true"><span style="width:${resumePct}%"></span></div>
            <button type="button" class="cq-btn cq-btn-ghost" onclick="window.qbankContinueLast()">Resume <i data-lucide="arrow-right"></i></button>
          </section>`;
      }

      const examEmpty = prepBanks.length === 0;
      const examSchoolBox = examEmpty
        ? `<div class="cq-inline-empty">Exam prep banks will appear here as soon as they are published.</div>`
        : `<div class="cq-school-box">
             <span class="cq-flag cq-flag-fallback"><i data-lucide="graduation-cap"></i></span>
             <div class="cq-school-text">
               <small>Exam prep access</small>
               <b>${prepAvailable.length} of ${prepBanks.length} banks ready</b>
               <span>${prepLocked ? `<b>${prepLocked}</b> paid ${prepLocked === 1 ? "bank needs" : "banks need"} a license` : "All exam prep banks are unlocked"}</span>
             </div>
             <button type="button" class="cq-mini" onclick="window.qbankEnterLicense()">License</button>
           </div>`;

      const examCta = examEmpty
        ? `<button type="button" class="cq-btn cq-btn-exam" onclick="window.openExamPrepTab()">Open exam prep <i data-lucide="arrow-right"></i></button>`
        : examHasAccess
          ? `<button type="button" class="cq-btn cq-btn-exam" onclick="window.openExamPrepTab()">Open exam prep <i data-lucide="arrow-right"></i></button>`
          : `<button type="button" class="cq-btn cq-btn-exam" onclick="window.qbankEnterLicense()">Enter license <i data-lucide="arrow-right"></i></button>`;

      const quickSearchTerms = Object.keys(subjectStats)
        .filter(s => s !== "Uncategorized")
        .sort((a, b) => (subjectStats[b].total || 0) - (subjectStats[a].total || 0))
        .slice(0, 4);
      const quickSearchChips = quickSearchTerms
        .map(term => `<button type="button" class="cq-search-chip" data-term="${cqEsc(term)}" onclick="window.cqHomeSearchTerm(this.dataset.term)">${cqEsc(term)}</button>`)
        .join("");
      const reviewAction = totalIncorrect > 0
        ? `<button type="button" class="cq-quick-card" onclick="window.qbankOpenBlockBuilder({ reviewIncorrectsOnly: true })">
             <span class="cq-quick-icon is-rose"><i data-lucide="rotate-ccw"></i></span>
             <span class="cq-quick-copy"><b>Review incorrects</b><small><b>${totalIncorrect.toLocaleString()}</b> to revisit in a test</small></span>
             <i data-lucide="arrow-right" class="cq-quick-arrow"></i>
           </button>`
        : `<button type="button" class="cq-quick-card" disabled aria-disabled="true">
             <span class="cq-quick-icon is-rose"><i data-lucide="rotate-ccw"></i></span>
             <span class="cq-quick-copy"><b>Review incorrects</b><small>No incorrect answers yet</small></span>
             <i data-lucide="lock" class="cq-quick-arrow"></i>
           </button>`;

      let html = `
        <div class="cq-home">
          <style>
            .cq-home {
              --cq-bg: #F5FAFA;
              --cq-surface: #FFFFFF;
              --cq-ink: #0B2B2B;
              --cq-ink-2: #425C5C;
              --cq-muted: #64748B;
              --cq-line: #DCE7E7;
              --cq-teal: #007A7A;
              --cq-teal-dark: #005F5F;
              --cq-teal-soft: #E6F2F2;
              --cq-blue: #1B5E86;
              --cq-blue-dark: #144866;
              --cq-blue-soft: #EAF3F9;
              --cq-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
              min-height: calc(100vh - 60px);
              background: var(--cq-bg);
              background-image: radial-gradient(rgba(0, 122, 122, 0.07) 1px, transparent 1px);
              background-size: 26px 26px;
              color: var(--cq-ink);
              font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              padding: 30px 24px 88px;
              box-sizing: border-box;
            }
            .cq-home, .cq-home *, .cq-home *::before, .cq-home *::after { box-sizing: border-box; }
            html.dark .cq-home {
              --cq-bg: #0B1416;
              --cq-surface: #10191C;
              --cq-ink: #EAF2F4;
              --cq-ink-2: #C1D1D6;
              --cq-muted: #8BA0A7;
              --cq-line: #1F2E33;
              --cq-teal: #45C9D2;
              --cq-teal-dark: #7ADDE4;
              --cq-teal-soft: #123A3F;
              --cq-blue: #7CC4E8;
              --cq-blue-dark: #A6D9F2;
              --cq-blue-soft: #102A3A;
              --cq-shadow: none;
              background-image: radial-gradient(rgba(69, 201, 210, 0.09) 1px, transparent 1px);
            }
            .cq-shell { max-width: 1040px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
            .cq-hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; flex-wrap: wrap; margin-bottom: 2px; }
            .cq-kicker { margin: 0 0 8px; font-size: 11px; line-height: 1; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 800; color: var(--cq-teal); }
            .cq-title { margin: 0 0 7px; font-size: clamp(26px, 3.6vw, 34px); line-height: 1.08; letter-spacing: -0.025em; font-weight: 800; color: var(--cq-ink); }
            .cq-sub { margin: 0; font-size: 14.5px; line-height: 1.55; color: var(--cq-ink-2); max-width: 54ch; }
            .cq-streak { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 8px 14px; border: 1px solid var(--cq-line); background: var(--cq-surface); border-radius: 999px; box-shadow: var(--cq-shadow); color: var(--cq-ink-2); font-size: 13px; font-weight: 700; white-space: nowrap; }
            .cq-streak svg { width: 17px; height: 17px; color: #C2410C; }
            html.dark .cq-streak svg { color: #F0B429; }
            .cq-streak b { color: var(--cq-ink); }
            .cq-search-stage { position: relative; isolation: isolate; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: clamp(26px, 4.2vw, 40px) clamp(18px, 3.4vw, 36px); background: linear-gradient(160deg, #FFFFFF 0%, #F3FBFB 52%, #E7F3F3 100%); border: 1px solid #D3E7E7; border-radius: 26px; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 30px 60px -46px rgba(0, 122, 122, 0.6); text-align: center; animation: cq-rise 0.45s ease both; }
            .cq-search-stage::before { content: ""; position: absolute; inset: 0; border-radius: inherit; background: radial-gradient(90% 120% at 50% -10%, rgba(0, 122, 122, 0.15), rgba(0, 122, 122, 0) 70%); pointer-events: none; z-index: -1; }
            .cq-search-stage::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background-image: radial-gradient(rgba(0, 122, 122, 0.16) 0.7px, transparent 0.7px); background-size: 16px 16px; opacity: 0.28; mask-image: linear-gradient(180deg, transparent 45%, #000 100%); -webkit-mask-image: linear-gradient(180deg, transparent 45%, #000 100%); pointer-events: none; z-index: -1; }
            html.dark .cq-search-stage { background: linear-gradient(160deg, #10191C 0%, #0D2326 55%, #0B1D20 100%); border-color: #22454A; box-shadow: none; }
            html.dark .cq-search-stage::before { background: radial-gradient(closest-side, rgba(69, 201, 210, 0.16), rgba(69, 201, 210, 0) 74%); }
            html.dark .cq-search-stage::after { background-image: radial-gradient(rgba(69, 201, 210, 0.22) 0.7px, transparent 0.7px); }
            .cq-search-kicker { margin-bottom: 0; }
            .cq-search-title { margin: 0; font-size: clamp(24px, 3.2vw, 31px); line-height: 1.12; letter-spacing: -0.025em; font-weight: 800; color: var(--cq-ink); }
            .cq-search-sub { margin: 0 0 10px; max-width: 58ch; font-size: 13.5px; line-height: 1.55; color: var(--cq-ink-2); }
            .cq-search { position: relative; width: min(100%, 720px); text-align: left; z-index: 1; }
            .cq-search-field { display: flex; align-items: center; gap: 10px; min-height: 70px; padding: 7px 9px 7px 8px; background: var(--cq-surface); border: 1px solid #CBDFDF; border-radius: 999px; box-shadow: 0 2px 4px rgba(16, 24, 40, 0.04), 0 18px 38px -28px rgba(16, 24, 40, 0.45); transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease; }
            html.dark .cq-search-field { border-color: #2A5055; box-shadow: 0 18px 38px -30px rgba(0, 0, 0, 0.8); }
            .cq-search-field:hover { border-color: #A9CDCD; }
            .cq-search-field:focus-within { border-color: var(--cq-teal); box-shadow: 0 0 0 5px rgba(0, 122, 122, 0.12), 0 24px 46px -30px rgba(16, 24, 40, 0.5); transform: translateY(-1px); }
            html.dark .cq-search-field:focus-within { box-shadow: 0 0 0 5px rgba(69, 201, 210, 0.14); }
            .cq-search-icon-wrap { width: 54px; height: 54px; border-radius: 999px; background: linear-gradient(145deg, var(--cq-teal-soft), rgba(230, 242, 242, 0.35)); color: var(--cq-teal); display: grid; place-items: center; flex-shrink: 0; }
            html.dark .cq-search-icon-wrap { background: linear-gradient(145deg, #123A3F, rgba(18, 58, 63, 0.35)); }
            .cq-search-icon { width: 22px; height: 22px; color: var(--cq-teal); flex-shrink: 0; }
            .cq-search input { flex: 1; min-width: 0; height: 52px; padding: 0 2px; border: none; outline: none; background: transparent; color: var(--cq-ink); font: inherit; font-size: 16.5px; font-weight: 600; }
            .cq-search input::placeholder { color: var(--cq-muted); font-weight: 500; }
            .cq-search-kbd { flex-shrink: 0; margin-inline-end: 8px; padding: 7px 11px; border: 1px solid #D6E7E7; border-radius: 10px; background: #F5FBFB; color: var(--cq-teal); font-size: 10.5px; font-weight: 800; letter-spacing: 0.03em; white-space: nowrap; }
            html.dark .cq-search-kbd { border-color: #24474C; background: #10282C; }
            .cq-search-dropdown { position: absolute; top: calc(100% + 10px); left: 0; right: 0; z-index: 40; max-height: min(420px, 55vh); overflow-y: auto; padding: 6px; background: var(--cq-surface); color: var(--cq-ink); border-radius: 18px; border: 1px solid var(--cq-line); box-shadow: 0 28px 64px -30px rgba(16, 24, 40, 0.55); }
            .cq-search-dropdown.hidden { display: none; }
            .cq-search-chips { display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
            .cq-search-chips > span { font-size: 10px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--cq-muted); }
            .cq-search-chip { min-height: 34px; padding: 0 14px; border: 1px solid rgba(185, 216, 216, 0.85); border-radius: 999px; background: rgba(255, 255, 255, 0.78); color: var(--cq-ink-2); font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); transition: border-color 0.18s ease, color 0.18s ease, background 0.18s ease, transform 0.18s ease; }
            .cq-search-chip:hover { transform: translateY(-1px); }
            html.dark .cq-search-chip { border-color: #2A5055; background: rgba(16, 25, 28, 0.72); }
            .cq-quick { display: flex; flex-direction: column; gap: 10px; }
            .cq-quick-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
            .cq-quick-head h2 { margin: 0; font-size: 13px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--cq-ink-2); }
            .cq-quick-head p { margin: 0; font-size: 11.5px; color: var(--cq-muted); }
            .cq-quick-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
            .cq-quick-card { display: flex; align-items: center; gap: 12px; min-height: 76px; padding: 12px 14px; background: var(--cq-surface); border: 1px solid var(--cq-line); border-radius: 14px; box-shadow: var(--cq-shadow); font: inherit; color: var(--cq-ink); text-align: left; cursor: pointer; transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease; }
            .cq-quick-card:disabled { cursor: not-allowed; opacity: 0.55; }
            .cq-quick-icon { width: 42px; height: 42px; border-radius: 11px; display: inline-flex; align-items: center; justify-content: center; background: var(--cq-teal-soft); color: var(--cq-teal); flex-shrink: 0; }
            .cq-quick-icon svg { width: 20px; height: 20px; }
            .cq-quick-icon.is-blue { background: var(--cq-blue-soft); color: var(--cq-blue); }
            .cq-quick-icon.is-rose { background: #FFF1F2; color: #BE123C; }
            html.dark .cq-quick-icon.is-rose { background: #3B121A; color: #FDA4AF; }
            .cq-quick-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
            .cq-quick-copy b { font-size: 13.5px; line-height: 1.25; font-weight: 800; color: var(--cq-ink); }
            .cq-quick-copy small { font-size: 11.5px; line-height: 1.35; color: var(--cq-ink-2); }
            .cq-quick-arrow { width: 16px; height: 16px; color: var(--cq-muted); flex-shrink: 0; }
            .cq-paths { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: stretch; }
            .cq-path { position: relative; overflow: hidden; display: flex; flex-direction: column; min-height: 318px; padding: 22px; background: var(--cq-surface); border: 1px solid var(--cq-line); border-radius: 16px; box-shadow: var(--cq-shadow); animation: cq-rise 0.45s ease both; }
            .cq-path:nth-child(2) { animation-delay: 0.06s; }
            .cq-path::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: var(--cq-teal); }
            .cq-path-exam::before { background: var(--cq-blue); }
            .cq-path-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
            .cq-icon { width: 52px; height: 52px; border-radius: 14px; background: var(--cq-teal-soft); color: var(--cq-teal); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
            .cq-icon svg { width: 25px; height: 25px; stroke-width: 2; }
            .cq-icon-exam { background: var(--cq-blue-soft); color: var(--cq-blue); }
            .cq-pill { display: inline-flex; align-items: center; padding: 6px 10px; border-radius: 999px; background: var(--cq-teal-soft); color: var(--cq-teal); font-size: 10.5px; line-height: 1; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 800; white-space: nowrap; }
            .cq-pill-exam { background: var(--cq-blue-soft); color: var(--cq-blue); }
            .cq-path h2 { margin: 0 0 6px; font-size: 22px; line-height: 1.2; letter-spacing: -0.015em; font-weight: 800; color: var(--cq-ink); }
            .cq-path > p { margin: 0 0 16px; font-size: 13.5px; line-height: 1.55; color: var(--cq-ink-2); }
            .cq-bank-line { display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 9px 11px; margin: auto 0 14px; border-radius: 10px; background: var(--cq-teal-soft); }
            .cq-bank-line > div { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
            .cq-bank-line b { font-size: 13.5px; line-height: 1.3; color: var(--cq-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .cq-bank-line span { font-size: 11.5px; color: var(--cq-ink-2); }
            .cq-flag { width: 32px; height: 23px; border-radius: 4px; object-fit: cover; flex-shrink: 0; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14); background: #fff; }
            .cq-flag-fallback { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; background: var(--cq-surface); color: var(--cq-teal); }
            .cq-flag-fallback svg { width: 16px; height: 16px; }
            .cq-meter { margin: 0 0 16px; }
            .cq-meter-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 7px; font-size: 11.5px; font-weight: 700; color: var(--cq-ink-2); }
            .cq-track { height: 7px; border-radius: 999px; background: var(--cq-line); overflow: hidden; }
            .cq-fill { height: 100%; border-radius: 999px; background: var(--cq-teal); transition: width 0.4s ease; }
            .cq-school-box { display: flex; align-items: center; gap: 11px; min-height: 64px; padding: 10px 11px; margin: auto 0 14px; border-radius: 10px; background: var(--cq-blue-soft); }
            .cq-school-text { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
            .cq-school-text small { font-size: 10px; line-height: 1; letter-spacing: 0.09em; text-transform: uppercase; font-weight: 800; color: var(--cq-blue); }
            .cq-school-text b { font-size: 14px; line-height: 1.3; color: var(--cq-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .cq-school-text span { font-size: 11.5px; line-height: 1.3; color: var(--cq-ink-2); }
            .cq-mini { min-height: 38px; padding: 0 12px; border: 1px solid var(--cq-line); border-radius: 8px; background: var(--cq-surface); color: var(--cq-ink-2); font: inherit; font-size: 12px; font-weight: 800; cursor: pointer; flex-shrink: 0; }
            .cq-setup { display: flex; align-items: center; gap: 11px; width: 100%; min-height: 64px; padding: 10px 11px; margin: auto 0 14px; border: 1px dashed #9CC7D8; border-radius: 10px; background: var(--cq-blue-soft); color: var(--cq-ink); font: inherit; text-align: left; cursor: pointer; }
            html.dark .cq-setup { border-color: #2E6478; }
            .cq-setup-ic { width: 38px; height: 38px; border-radius: 9px; background: var(--cq-surface); color: var(--cq-blue); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
            .cq-setup-ic svg { width: 19px; height: 19px; }
            .cq-setup .cq-school-text b { font-size: 13.5px; }
            .cq-setup .cq-school-text small { color: var(--cq-ink-2); letter-spacing: 0; text-transform: none; font-size: 11.5px; font-weight: 500; }
            .cq-setup-arrow { width: 17px; height: 17px; color: var(--cq-blue); flex-shrink: 0; }
            .cq-inline-empty { display: flex; align-items: center; min-height: 64px; padding: 12px; margin: auto 0 14px; border-radius: 10px; background: var(--cq-blue-soft); color: var(--cq-ink-2); font-size: 12.5px; line-height: 1.5; }
            .cq-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: auto; }
            .cq-btn { min-height: 48px; padding: 0 17px; border: 1px solid transparent; border-radius: 10px; font: inherit; font-size: 14px; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer; transition: background 0.18s ease, border-color 0.18s ease, transform 0.18s ease; }
            .cq-btn svg { width: 16px; height: 16px; flex-shrink: 0; }
            .cq-btn-primary { background: var(--cq-teal); color: #FFFFFF; }
            .cq-btn-exam { background: var(--cq-blue); color: #FFFFFF; }
            html.dark .cq-btn-primary, html.dark .cq-btn-exam { color: #071A1D; }
            .cq-btn-ghost { background: var(--cq-surface); border-color: var(--cq-line); color: var(--cq-ink); }
            .cq-link { min-height: 44px; padding: 0 5px; border: none; background: transparent; color: var(--cq-ink-2); font: inherit; font-size: 12.5px; font-weight: 700; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
            .cq-resume { display: flex; align-items: center; gap: 13px; padding: 13px 15px; background: var(--cq-surface); border: 1px solid var(--cq-line); border-radius: 14px; box-shadow: var(--cq-shadow); }
            .cq-resume-ic { width: 42px; height: 42px; border-radius: 11px; background: var(--cq-teal-soft); color: var(--cq-teal); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
            .cq-resume-ic svg { width: 20px; height: 20px; }
            .cq-resume-text { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
            .cq-resume-text small { font-size: 10.5px; letter-spacing: 0.07em; text-transform: uppercase; font-weight: 800; color: var(--cq-teal); }
            .cq-resume-text b { font-size: 14px; color: var(--cq-ink); line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .cq-resume-text span { font-size: 11.5px; color: var(--cq-ink-2); }
            .cq-resume-meter { width: 120px; height: 7px; border-radius: 999px; background: var(--cq-line); overflow: hidden; flex-shrink: 0; }
            .cq-resume-meter span { display: block; height: 100%; border-radius: 999px; background: var(--cq-teal); }
            .cq-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
            .cq-stat { display: flex; align-items: center; gap: 11px; min-height: 68px; padding: 12px 15px; background: var(--cq-surface); border: 1px solid var(--cq-line); border-radius: 12px; box-shadow: var(--cq-shadow); }
            .cq-stat svg { width: 20px; height: 20px; color: var(--cq-teal); flex-shrink: 0; }
            .cq-stat div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
            .cq-stat span { font-size: 20px; line-height: 1.1; font-weight: 800; color: var(--cq-ink); }
            .cq-stat small { font-size: 11.5px; color: var(--cq-ink-2); }
            .cq-block { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 14px 16px; background: linear-gradient(135deg, #EAF3F9 0%, #F4FAFA 100%); border: 1px solid #CFE4E4; border-radius: 14px; box-shadow: var(--cq-shadow); }
            html.dark .cq-block { background: linear-gradient(135deg, #102A3A 0%, #102024 100%); border-color: #2E6478; }
            .cq-block-ic { width: 44px; height: 44px; border-radius: 11px; background: var(--cq-surface); color: var(--cq-blue); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
            .cq-block-ic svg { width: 21px; height: 21px; }
            .cq-block-text { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
            .cq-block-text b { font-size: 14px; color: var(--cq-ink); }
            .cq-block-text small { font-size: 11.5px; line-height: 1.4; color: var(--cq-ink-2); }
            .cq-block-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
            .cq-block .cq-btn { flex-shrink: 0; }
            .cq-foot { margin: 0; text-align: center; font-size: 11.5px; color: var(--cq-muted); }
            .cq-home button:focus-visible, .cq-home a:focus-visible { outline: 3px solid var(--cq-teal); outline-offset: 2px; }
            .cq-modal[hidden] { display: none !important; }
            .cq-modal { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(6, 28, 30, 0.58); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
            .cq-modal-card { display: flex; flex-direction: column; width: 100%; max-width: 620px; max-height: min(760px, 90vh); overflow: hidden; background: var(--cq-surface); border: 1px solid var(--cq-line); border-radius: 18px; box-shadow: 0 28px 70px rgba(0, 0, 0, 0.3); animation: cq-pop 0.2s ease both; }
            .cq-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 20px 22px 16px; border-bottom: 1px solid var(--cq-line); }
            .cq-modal-head h3 { margin: 0; font-size: 19px; line-height: 1.25; font-weight: 800; color: var(--cq-ink); }
            .cq-modal-head p { margin: 4px 0 0; font-size: 12.5px; line-height: 1.45; color: var(--cq-ink-2); }
            .cq-modal-close { width: 42px; height: 42px; border: 1px solid var(--cq-line); border-radius: 10px; background: var(--cq-surface); color: var(--cq-ink-2); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
            .cq-modal-close svg { width: 20px; height: 20px; }
            .cq-modal-body { padding: 18px 22px 24px; overflow-y: auto; }
            .cq-country-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }
            .cq-pick-country, .cq-pick-college { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 64px; padding: 11px 12px; border: 1px solid var(--cq-line); border-radius: 12px; background: var(--cq-surface); color: var(--cq-ink); font: inherit; text-align: left; cursor: pointer; transition: background 0.18s ease, border-color 0.18s ease; }
            .cq-pick-flag { width: 34px; height: 24px; object-fit: cover; border-radius: 4px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14); background: #fff; flex-shrink: 0; }
            .cq-pick-text { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
            .cq-pick-text b { font-size: 14px; line-height: 1.3; font-weight: 800; color: var(--cq-ink); }
            .cq-pick-text small { font-size: 11.5px; line-height: 1.35; color: var(--cq-ink-2); }
            .cq-pick-chev { width: 18px; height: 18px; color: var(--cq-muted); flex-shrink: 0; margin-left: auto; }
            .cq-back-link { display: inline-flex; align-items: center; gap: 7px; min-height: 40px; margin: 0 0 10px; padding: 0 4px; border: none; background: transparent; color: var(--cq-ink-2); font: inherit; font-size: 12.5px; font-weight: 800; cursor: pointer; }
            .cq-back-link svg { width: 15px; height: 15px; }
            .cq-current-country { display: flex; align-items: center; gap: 9px; margin: 0 0 12px; padding: 9px 11px; border-radius: 10px; background: var(--cq-teal-soft); }
            .cq-current-country b { font-size: 13.5px; color: var(--cq-ink); }
            .cq-current-country span { font-size: 11.5px; color: var(--cq-ink-2); }
            .cq-college-list { display: flex; flex-direction: column; gap: 8px; }
            .cq-college-ic { width: 40px; height: 40px; border-radius: 10px; background: var(--cq-teal-soft); color: var(--cq-teal); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
            .cq-college-ic svg { width: 19px; height: 19px; }
            @keyframes cq-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
            @keyframes cq-pop { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
            @media (hover: hover) {
              .cq-btn-primary:hover { background: var(--cq-teal-dark); }
              .cq-btn-exam:hover { background: var(--cq-blue-dark); }
              .cq-btn-ghost:hover { border-color: var(--cq-teal); color: var(--cq-teal); }
              .cq-mini:hover, .cq-modal-close:hover, .cq-back-link:hover { background: var(--cq-teal-soft); color: var(--cq-teal); }
              .cq-pick-country:hover, .cq-pick-college:hover { border-color: var(--cq-teal); background: var(--cq-teal-soft); }
              .cq-setup:hover { border-color: var(--cq-blue); }
              .cq-search-chip:hover { border-color: var(--cq-teal); color: var(--cq-teal); background: var(--cq-teal-soft); }
              .cq-quick-card:hover:not(:disabled) { transform: translateY(-2px); border-color: #9CC7D8; }
            }
            @media (max-width: 860px) {
              .cq-home { padding: 22px 16px 72px; }
              .cq-paths { grid-template-columns: 1fr; }
              .cq-path { min-height: 0; }
              .cq-hero { align-items: flex-start; flex-direction: column; gap: 12px; }
              .cq-stats { grid-template-columns: 1fr 1fr; }
              .cq-stat:last-child { grid-column: 1 / -1; }
              .cq-resume { flex-wrap: wrap; }
              .cq-resume-meter { order: 4; width: 100%; flex-basis: 100%; }
              .cq-resume .cq-btn { width: 100%; margin-top: 2px; }
              .cq-quick-grid { grid-template-columns: 1fr 1fr; }
              .cq-search-stage { padding: 24px 16px; }
            }
            @media (max-width: 440px) {
              .cq-stats { grid-template-columns: 1fr; }
              .cq-stat:last-child { grid-column: auto; }
              .cq-quick-grid { grid-template-columns: 1fr; }
              .cq-search-stage { padding: 20px 14px; border-radius: 20px; }
              .cq-search-field { min-height: 60px; padding: 6px 7px; }
              .cq-search-icon-wrap { width: 46px; height: 46px; }
              .cq-search-icon { width: 20px; height: 20px; }
              .cq-search input { height: 48px; font-size: 16px; }
              .cq-search-kbd { display: none; }
              .cq-search-chips { justify-content: flex-start; }
              .cq-actions { flex-direction: column; align-items: stretch; }
              .cq-actions .cq-btn { width: 100%; }
              .cq-actions .cq-link { width: 100%; }
              .cq-block { align-items: flex-start; }
              .cq-block-actions { width: 100%; flex-direction: column; align-items: stretch; }
              .cq-block .cq-btn { width: 100%; margin-left: 0; }
            }
            @media (max-width: 600px) {
              .cq-modal { padding: 0; align-items: flex-end; }
              .cq-modal-card { max-height: 92vh; border-radius: 18px 18px 0 0; }
              .cq-country-grid { grid-template-columns: 1fr; }
            }
            @media (prefers-reduced-motion: reduce) {
              .cq-home *, .cq-home *::before, .cq-home *::after { animation: none !important; transition: none !important; }
            }
          </style>

          <div class="cq-shell">
            <header class="cq-hero">
              <div>
                <h1 class="cq-title"><span>${greeting}</span>, ${cqEsc(firstName)}</h1>
                <p class="cq-sub">Search a topic, jump into a test, or continue where you left off.</p>
              </div>
              <div class="cq-streak" title="Study streak"><i data-lucide="flame"></i><b>${streakVal}</b> <span>${streakVal === 1 ? "day streak" : "days streak"}</span></div>
            </header>

            <section class="cq-search-stage" aria-labelledby="cq-search-title">
              <p class="cq-kicker cq-search-kicker">Search your banks</p>
              <h2 class="cq-search-title" id="cq-search-title">Find what you need, fast</h2>
              <p class="cq-search-sub">Search subjects, chapters, parts and tags across your accessible banks.</p>
              <div class="cq-search" role="search">
                <label class="cq-sr-only" for="cq-home-search-input">Search subjects, chapters, parts and tags</label>
                <div class="cq-search-field">
                  <span class="cq-search-icon-wrap" aria-hidden="true"><i data-lucide="search" class="cq-search-icon"></i></span>
                  <input id="cq-home-search-input" data-home-search-input type="search" autocomplete="off" spellcheck="false" placeholder="Search subjects, chapters, parts, tags..." aria-controls="cq-home-search-dropdown" aria-expanded="false" aria-autocomplete="list" onkeydown="window.handleHomeSearch && window.handleHomeSearch(event)" oninput="window.handleHomeSearchInput && window.handleHomeSearchInput(event)" onfocus="window.handleHomeSearchFocus && window.handleHomeSearchFocus(event)"/>
                  <kbd class="cq-search-kbd">Ctrl K</kbd>
                </div>
                <div id="cq-home-search-dropdown" class="home-search-dropdown cq-search-dropdown hidden" role="listbox" aria-label="Search suggestions"></div>
              </div>
              ${quickSearchChips ? `<div class="cq-search-chips" aria-label="Quick searches"><span>Quick search</span>${quickSearchChips}</div>` : ""}
            </section>

            <section class="cq-quick" aria-labelledby="cq-quick-title">
              <div class="cq-quick-head">
                <h2 id="cq-quick-title">Quick actions</h2>
                <p>Build a test or revisit a previous test.</p>
              </div>
              <div class="cq-quick-grid">
                <button type="button" class="cq-quick-card" onclick="window.qbankOpenBlockBuilder()">
                  <span class="cq-quick-icon"><i data-lucide="clipboard-list"></i></span>
                  <span class="cq-quick-copy"><b>Create test</b><small>Filter by mode, objective, system, and topic</small></span>
                  <i data-lucide="arrow-right" class="cq-quick-arrow"></i>
                </button>
                <button type="button" class="cq-quick-card" onclick="window.qbankOpenBlockHistory()">
                  <span class="cq-quick-icon is-blue"><i data-lucide="history"></i></span>
                  <span class="cq-quick-copy"><b>Previous tests</b><small><b>${savedBlocks.length}</b> saved ${savedBlocks.length === 1 ? "test" : "tests"}</small></span>
                  <i data-lucide="arrow-right" class="cq-quick-arrow"></i>
                </button>
                ${reviewAction}
                <button type="button" class="cq-quick-card" onclick="window.openExamPrepTab()">
                  <span class="cq-quick-icon is-blue"><i data-lucide="graduation-cap"></i></span>
                  <span class="cq-quick-copy"><b>Past papers</b><small>${examEmpty ? "No past papers yet" : `<b>${prepBanks.length}</b> ${prepBanks.length === 1 ? "exam available" : "exams available"}`}</small></span>
                  <i data-lucide="arrow-right" class="cq-quick-arrow"></i>
                </button>
              </div>
            </section>

            ${continueBanner}

            <section class="cq-paths" aria-label="Choose how you want to study">
              <article class="cq-path cq-path-qbank">
                <div class="cq-path-head">
                  <span class="cq-icon"><i data-lucide="book-open"></i></span>
                  <span class="cq-pill">${activeQBankMeta && activeQBankMeta.bankType === "module_clinical" ? "Clinical Module" : activeQBankMeta && activeQBankMeta.bankType === "module_academic" ? "Academic Module" : "License Exam"}</span>
                </div>
                <h2>${activeQBankMeta && (activeQBankMeta.bankType === "module_academic" || activeQBankMeta.bankType === "module_clinical") ? "Build tests by topic" : "Build tests by subject"}</h2>
                <p>Mix everything or focus on one ${qblockLevel2Singular().toLowerCase()}. Every question is answered inside a saved test.</p>
                <div class="cq-bank-line">
                  ${bankFlag}
                  <div>
                    <b>${cqEsc(activeQBankName)}</b>
                    <span><b>${subjectCount}</b> <span>${subjectCount === 1 ? "subject" : "subjects"}</span> <span class="cq-sep">·</span> <b>${totalQuestions.toLocaleString()}</b> <span>questions</span></span>
                  </div>
                </div>
                <div class="cq-meter">
                  <div class="cq-meter-head"><span><b>${totalAnswered.toLocaleString()}</b> answered</span><span><b>${globalScore}%</b> average</span></div>
                  <div class="cq-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progressPct}" aria-label="Bank progress"><div class="cq-fill" style="width:${progressPct}%"></div></div>
                </div>
                <div class="cq-actions">
                  <button type="button" class="cq-btn cq-btn-primary" onclick="window.qbankOpenBlockBuilder()">Create test <i data-lucide="arrow-right"></i></button>
                  <button type="button" class="cq-link" onclick="window.qbankOpenBlockHistory()">Previous tests</button>
                  <button type="button" class="cq-link" onclick="window.openQBankSelection()">Change bank</button>
                </div>
              </article>

              <article class="cq-path cq-path-exam">
                <div class="cq-path-head">
                  <span class="cq-icon cq-icon-exam"><i data-lucide="graduation-cap"></i></span>
                  <span class="cq-pill cq-pill-exam">Exam prep</span>
                </div>
                <h2>Exam prep</h2>
                <p>${examEmpty ? "Exam prep banks will appear here as soon as they are published." : prepLocked ? `${prepLocked} paid ${prepLocked === 1 ? "bank is" : "banks are"} locked. Enter a license to unlock them.` : "All exam prep banks are ready. Open them in one tap."}</p>
                ${examSchoolBox}
                <div class="cq-actions">
                  ${examCta}
                  ${prepBanks.length > 0 ? `<button type="button" class="cq-link" onclick="window.openExamPrepTab()">See all exam prep</button>` : ""}
                </div>
              </article>
            </section>

            <section class="cq-stats" aria-label="Your overall progress">
              <div class="cq-stat"><i data-lucide="check-circle"></i><div><span>${totalAnswered.toLocaleString()}</span><small>questions answered</small></div></div>
              <div class="cq-stat"><i data-lucide="target"></i><div><span>${globalScore}%</span><small>average score</small></div></div>
              <div class="cq-stat"><i data-lucide="rotate-ccw"></i><div><span>${totalIncorrect.toLocaleString()}</span><small>questions to review</small></div></div>
            </section>

            <p class="cq-foot">${prepBanks.length > 0 ? `<b>${prepAvailable.length}</b> of <b>${prepBanks.length}</b> exam prep banks ready` : "Exam prep banks will appear when they are published"} <span class="cq-foot-sep">·</span> <span>Switch banks anytime from My banks.</span></p>
          </div>
          <div id="cq-college-modal" class="cq-modal" hidden onclick="if (event.target === this) window.cqCloseCollegePicker()">
            <div class="cq-modal-card" role="dialog" aria-modal="true" aria-labelledby="cq-college-title">
              <div class="cq-modal-head">
                <div>
                  <h3 id="cq-college-title">Choose your country</h3>
                  <p id="cq-college-sub">Then pick your college. We will remember it for next time.</p>
                </div>
                <button type="button" class="cq-modal-close" aria-label="Close college picker" onclick="window.cqCloseCollegePicker()"><i data-lucide="x"></i></button>
              </div>
              <div class="cq-modal-body" id="cq-college-body"></div>
            </div>
          </div>
        </div>`;
      area.innerHTML = html;

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
         : `<div style="font-size:4rem; margin-bottom:20px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1)); line-height:1;">ðŸŒ</div>`;
         
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
    window.qbankResumeSession(last.qbankId, last.qbankName, last.subject, last.topicPath, last.tag);
  };

  // --- Resume a specific session ---
  window.qbankResumeSession = async function (qbankId, qbankName, subject, topicPath = null, tag = null) {
    if (!qbankId) { window.openQBankCategories(); return; }
    const topicMode = Array.isArray(topicPath) && topicPath.length > 0;
    let resumeSubject = tag ? null : (subject && subject !== "All Subjects" ? subject : null);
    if (topicMode && resumeSubject && resumeSubject.includes(" - ")) {
      resumeSubject = resumeSubject.split(" - ")[0] || null;
    }
    const hasFilter = !!resumeSubject || topicMode || !!tag;
    
    // Ensure data is loaded
    if (!cachedQBanks[qbankId]) {
      await window.startQBankSession(qbankId, qbankName || "QBank");
      // After session loads, filter to subject if needed
      if (hasFilter) {
        window.startQBankFiltered(resumeSubject, null, false, topicPath, tag);
      }
    } else {
      currentQBankId = qbankId;
      window.isQBankAdmin = window.checkAdmin ? await window.checkAdmin() : false;
      const qData = cachedQBanks[qbankId];
      allQuestions = qData.questions;
      window.qbankProgress = qData.progress;
      document.getElementById("qbank-active-name").textContent = qbankName || "QBank";
      
      if (hasFilter) {
        window.startQBankFiltered(resumeSubject, null, false, topicPath, tag);
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

  // ---- Question lookup by Firestore id or human code — DISABLED ----
  // Disabled to save Firestore reads. Home search is subject/chapter only.
  // Stubbed to fail closed (no API call) so any legacy caller does nothing.
  window.qbankFindByRef = async function(term, preferBankId) {
    return null;
  };

  // Opens exactly one question as a mini-session — DISABLED with ID search.
  window.qbankOpenSingle = async function(bankId, bankName, question) {
    return;
  };

  window.startQBankSession = async function (qbankId, qbankName, targetSubject = null, reviewIncorrectsOnly = false, targetChapter = null) {
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
      // A cached entry with no stems is not usable (e.g. only progress was
      // ever fetched for it) — refetch instead of showing "empty". Genuinely
      // empty banks are flagged after a full fetch so they don't refetch.
      const needsStems = !qData || !Array.isArray(qData.questions) || (qData.questions.length === 0 && !qData._fullEmpty);
      if (needsStems) {
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
         const qCat = (cachedCategories || []).find(c => c.id === qbankId)
           || (Array.isArray(window.__epBanks) ? window.__epBanks.find(c => c && c.id === qbankId) : null);
         const catUpdated = Number(qCat && qCat.updatedAt) || 0;
         
         const idbData = await getCachedQBank(qbankId);
         if (idbData && (!catUpdated || Number(idbData.updatedAt) === catUpdated) && idbData.questions && idbData.questions.length > 0) {
            const res = await apiGet("get_questions", { qbankId, onlyProgress: true });
            cachedQBanks[qbankId] = { questions: idbData.questions, progress: applyLocalQueueProgress(qbankId, res.progress || {}) };
         } else {
            const res = await apiGet("get_questions", { qbankId });
            cachedQBanks[qbankId] = { questions: res.questions || [], progress: applyLocalQueueProgress(qbankId, res.progress || {}) };
            setCachedQBank(qbankId, { updatedAt: catUpdated, questions: res.questions || [] });
         }
         
          qData = cachedQBanks[qbankId];
          if (qData && (!qData.questions || qData.questions.length === 0)) qData._fullEmpty = true;
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
      
      if (targetSubject !== null || reviewIncorrectsOnly || targetChapter !== null || (qbankName === "Answer Party" && !window.pendingPartyCreation)) {
          window.startQBankFiltered(targetSubject, targetChapter, reviewIncorrectsOnly);
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
  function qbankChapterParts(subject, chapter) {
    const subjectKey = String(subject || "").trim().toLowerCase();
    const chapterKey = String(chapter || "").trim().toLowerCase();
    if (!subjectKey || !chapterKey) return [];
    const parts = new Map();
    (allQuestions || []).forEach(q => {
      const data = (q && q.data) || {};
      const taxPath = qblockTaxonomyPath(q);
      const taxSubject = taxPath.length ? String(taxPath[0] || "").trim().toLowerCase() : "";
      const taxChapter = taxPath.length > 1 ? String(taxPath[1] || "").trim().toLowerCase() : "";
      const qSubject = String(data.subject || "").trim().toLowerCase();
      const qChapter = String(data.chapter || (taxSubject === subjectKey ? taxChapter : "")).trim().toLowerCase();
      if (qSubject !== subjectKey || qChapter !== chapterKey) return;

      let name = String(data.part || "").trim();
      let path = null;
      if (taxPath.length >= 3 && taxSubject === subjectKey && taxChapter === chapterKey) {
        const taxPart = String(taxPath[2] || "").trim();
        if (taxPart) {
          name = taxPart;
          path = taxPath.slice(0, 3);
        }
      }
      if (!name) return;
      const key = name.toLowerCase();
      let part = parts.get(key);
      if (!part) {
        part = { name, path: path || [subject, chapter, name], total: 0, answered: 0, correct: 0 };
        parts.set(key, part);
      } else if (!part.path && path) {
        part.path = path;
      }
      part.total++;
      const p = (window.qbankProgress || {})[q.id];
      if (p && p.correct !== undefined) {
        part.answered++;
        if (p.correct) part.correct++;
      }
    });
    return [...parts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  window.qbankStartPartRoute = function(id) {
    const route = (window.__qbankPartRoutes || {})[id];
    if (route) window.startQBankFiltered(route.subject, route.chapter, false, route.path);
  };

  function cqBrowserScore(correct, answered) {
    if (!answered) return { text: "—", tone: "empty" };
    const score = Math.round((correct / answered) * 100);
    return { text: `${score}%`, tone: score >= 80 ? "good" : (score >= 50 ? "mid" : "low") };
  }

  function cqBrowserAdmin(buttons) {
    if (!buttons || !buttons.length) return "";
    return `<div class="cq-list-admin">${buttons.map(b => `
      <button type="button" class="cq-list-admin-btn is-${b.tone || "neutral"}" onclick="${b.onclick}" aria-label="${cqEsc(b.label)}">
        <i data-lucide="${b.icon}" aria-hidden="true"></i><span>${cqEsc(b.text)}</span>
      </button>`).join("")}</div>`;
  }

  function cqBrowserRow(opts) {
    const title = cqEsc(opts.title);
    const meta = opts.meta ? cqEsc(opts.meta) : "";
    const searchText = cqEsc(opts.searchText || opts.title);
    const total = Number(opts.total) || 0;
    const answered = Number(opts.answered) || 0;
    const correct = Number(opts.correct) || 0;
    const pct = total ? Math.max(0, Math.min(100, Math.round((answered / total) * 100))) : 0;
    const score = cqBrowserScore(correct, answered);
    const color = opts.color || "#007A7A";
    const icon = opts.icon || "book-open";
    const chevron = opts.chevron || "chevron-right";
    const ariaLabel = cqEsc(opts.ariaLabel || `${opts.title}. ${answered} of ${total} answered.`);
    return `<div class="cq-list-row${opts.featured ? " is-featured" : ""}">
      <button type="button" class="cq-list-main qbank-subject-btn" data-subject="${searchText}" aria-label="${ariaLabel}" onclick="${opts.onclick || ""}">
        <span class="cq-list-icon" style="--row-accent:${color};" aria-hidden="true"><i data-lucide="${icon}"></i></span>
        <span class="cq-list-copy">
          <span class="cq-list-title">${title}</span>
          ${meta ? `<span class="cq-list-meta">${meta}</span>` : ""}
          <span class="cq-list-track" aria-hidden="true"><span style="width:${pct}%"></span></span>
        </span>
        <span class="cq-list-stats">
          <span class="cq-list-stat"><small>Answered</small><b>${answered} / ${total}</b></span>
          <span class="cq-list-stat"><small>Score</small><b class="cq-list-score is-${score.tone}">${score.text}</b></span>
        </span>
        <i data-lucide="${chevron}" class="cq-list-chev" aria-hidden="true"></i>
      </button>
      ${opts.admin || ""}
    </div>`;
  }

  function cqBrowserPage(opts) {
    const backLabel = cqEsc(opts.backLabel || "Back");
    const kicker = opts.kicker ? cqEsc(opts.kicker) : "";
    const title = cqEsc(opts.title || "");
    const subtitle = opts.subtitle ? cqEsc(opts.subtitle) : "";
    const searchPlaceholder = cqEsc(opts.searchPlaceholder || "Search...");
    const searchLabel = cqEsc(opts.searchLabel || opts.searchPlaceholder || "Search");
    const status = cqEsc(opts.status || "");
    const noun = cqEsc(opts.noun || "items");
    const total = Number(opts.total) || 0;
    const layoutClass = opts.layout === "grid" ? " is-grid" : "";
    return `<div class="cq-browser">
      <div class="cq-browser-shell">
        <div class="cq-browser-top">
          <button type="button" class="cq-browser-back" onclick="${opts.backAction || "window.openQBank()"}">
            <i data-lucide="arrow-left" aria-hidden="true"></i><span>${backLabel}</span>
          </button>
          <span class="cq-browser-crumb">${opts.crumb || ""}</span>
        </div>
        <div class="cq-browser-head">
          <div class="cq-browser-heading">
            ${kicker ? `<p class="cq-browser-kicker">${kicker}</p>` : ""}
            <h1 class="cq-browser-title">${title}</h1>
            <p class="cq-browser-sub">${subtitle}</p>
          </div>
          ${opts.actions ? `<div class="cq-browser-actions">${opts.actions}</div>` : ""}
        </div>
        <div class="cq-browser-search" role="search">
          <label class="cq-sr-only" for="qbank-browser-search">${searchLabel}</label>
          <div class="cq-browser-search-field">
            <i data-lucide="search" class="cq-browser-search-icon" aria-hidden="true"></i>
            <input id="qbank-browser-search" type="search" autocomplete="off" spellcheck="false" placeholder="${searchPlaceholder}" aria-controls="qbank-subject-list-container" oninput="window.filterQBankSubjects(this.value)" onkeydown="if(event.key==='Escape'){this.value='';window.filterQBankSubjects('');this.blur();}">
            <span class="cq-browser-search-hint" aria-hidden="true">Type to filter</span>
          </div>
          <p class="cq-browser-status" id="qbank-search-status" aria-live="polite">${status}</p>
        </div>
        <div id="qbank-subject-list-container" class="cq-browser-list${layoutClass}" data-search-noun="${noun}" data-search-total="${total}">
          ${opts.rows || ""}
        </div>
      </div>
    </div>`;
  }

  function qbankTaxonomyLoadBank(requestedQBankId) {
    nextNavToken();
    if (window.hideAllMainViews) window.hideAllMainViews();
    const view = document.getElementById("qbank-home-view");
    if (view) view.style.display = "flex";
    if (window.setQBankNav) window.setQBankNav('browse');

    return (async () => {
      const area = document.getElementById("qbank-home-content");
      if (!area) return null;

      const activeQBankId = requestedQBankId || currentQBankId || (window.db && window.db.selectedQBankId);
      if (!activeQBankId) { window.openQBank(); return null; }

      if (!cachedQBanks[activeQBankId] || !cachedQBanks[activeQBankId].questions) {
        const _nm = ((cachedCategories || []).find(qb => qb.id === activeQBankId) || {}).name || "Your QBank";
        await window.startQBankSession(activeQBankId, _nm);
        return null;
      }

      allQuestions = cachedQBanks[activeQBankId].questions || [];
      window.qbankProgress = cachedQBanks[activeQBankId].progress || {};
      currentQBankId = activeQBankId;
      const questions = allQuestions;
      const progress = window.qbankProgress || {};
      const activeQBankName = (cachedCategories || []).find(qb => qb.id === activeQBankId)?.name || "Your QBank";
      return { activeQBankId, activeQBankName, questions, progress };
    })();
  }

  function qbankTaxonomyLevelStats(questions, progress, level, prefix = []) {
    const map = new Map();
    (questions || []).forEach(q => {
      const path = qblockTaxonomyPath(q);
      if (path.length <= level) return;
      for (let i = 0; i < prefix.length; i++) {
        if (String(path[i] || "").trim().toLowerCase() !== String(prefix[i] || "").trim().toLowerCase()) return;
      }
      const name = path[level];
      if (!name) return;
      if (!map.has(name)) map.set(name, { name, total: 0, answered: 0, correct: 0, children: new Set() });
      const entry = map.get(name);
      entry.total += 1;
      const child = level < 3 ? path[level + 1] : "";
      if (child) entry.children.add(child);
      const p = (progress || {})[q.id];
      if (p && p.correct !== undefined) {
        entry.answered += 1;
        if (p.correct) entry.correct += 1;
      }
    });
    return [...map.values()]
      .map(entry => ({ ...entry, childCount: entry.children.size, children: undefined }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function qbankTaxonomyRoute(path, level) {
    window.__qbankTaxonomyRoutes = window.__qbankTaxonomyRoutes || {};
    const routeId = "tax_" + Math.random().toString(36).slice(2, 10);
    window.__qbankTaxonomyRoutes[routeId] = { path: path || [], level: Number(level) || 0 };
    return routeId;
  }

  window.qbankStartTaxonomyRoute = function(routeId) {
    const route = window.__qbankTaxonomyRoutes && window.__qbankTaxonomyRoutes[routeId];
    if (!route) return;
    const bankId = currentQBankId || (window.db && window.db.selectedQBankId);
    const path = Array.isArray(route.path) ? route.path : [];
    if (qblockIsModule()) {
      return window.qbankOpenBlockBuilder({
        bankId,
        objective: path[0] || "",
        subjects: path[1] ? [path[1]] : [],
        systems: [],
        subTopics: route.level >= 2 && path[2] ? [path[2]] : [],
      });
    }
    return window.qbankOpenBlockBuilder({
      bankId,
      objective: path[0] || "",
      subjects: path[1] ? [path[1]] : [],
      systems: path[2] ? [path[2]] : [],
      subTopics: route.level >= 3 && path[3] ? [path[3]] : [],
    });
  };

  function qbankTaxonomyRows(stats, level, path, activeQBankId) {
    return stats.map(item => {
      const safePath = path.concat(item.name);
      const routeId = qbankTaxonomyRoute(safePath, level + 1);
      const childCount = item.childCount || 0;
      const isLeaf = qblockIsModule() ? level >= 2 : level >= 3;
      const onclick = isLeaf
        ? `window.qbankStartTaxonomyRoute('${cqJsArg(routeId)}')`
        : `window.showQBankTaxonomyByRoute('${cqJsArg(routeId)}')`;
      const nouns = qblockIsModule()
        ? [qblockLevel2Label().toLowerCase(), "topics"]
        : ["organ systems", "clinical specialties", "sub-topics"];
      const noun = isLeaf ? "leaf" : `${childCount} ${nouns[level] || "sections"}`;
      const design = level === 1 ? window.getSubjectDesign(item.name) : { icon: level === 0 ? "target" : level === 2 ? "stethoscope" : "activity", color: "#007A7A" };
      return cqBrowserRow({
        title: item.name,
        searchText: item.name,
        meta: isLeaf ? `Start leaf · ${item.total} question${item.total === 1 ? "" : "s"}` : `${noun} · View contents`,
        total: item.total,
        answered: item.answered,
        correct: item.correct,
        color: design.color,
        icon: design.icon,
        chevron: isLeaf ? "chevron-right" : "folder",
        onclick,
        ariaLabel: `${item.name}. ${item.answered} of ${item.total} answered.`
      });
    });
  }

  window.showQBankTaxonomyByRoute = async function(routeId) {
    const route = window.__qbankTaxonomyRoutes && window.__qbankTaxonomyRoutes[routeId];
    if (!route || !currentQBankId) return;
    if (qblockIsModule()) {
      if (route.level === 1) return window.showQBankTopics(route.path[0], route.path[1]);
      return window.qbankStartTaxonomyRoute(routeId);
    }
    if (route.level === 1) return window.showQBankOrganSystems(route.path[0]);
    if (route.level === 2) return window.showQBankClinicalSpecialties(route.path[0], route.path[1]);
    if (route.level === 3) return window.showQBankSubTopics(route.path[0], route.path[1], route.path[2]);
    return window.showQBankObjectives();
  };

  function qbankTaxonomyRender(opts) {
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    area.innerHTML = cqBrowserPage(opts);
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }

  window.showQBankObjectives = async function(requestedQBankId = null) {
    const loaded = await qbankTaxonomyLoadBank(requestedQBankId);
    if (!loaded) return;
    const { activeQBankId, activeQBankName, questions, progress } = loaded;
    const stats = qbankTaxonomyLevelStats(questions, progress, 0);
    const totalAnswered = stats.reduce((sum, item) => sum + item.answered, 0);
    const totalCorrect = stats.reduce((sum, item) => sum + item.correct, 0);
    const totalQuestions = questions.length;

    let rows = cqBrowserRow({
      title: "All objectives (Mix)",
      searchText: "all objectives mix",
      meta: "Practice across every educational objective in this bank",
      total: totalQuestions,
      answered: totalAnswered,
      correct: totalCorrect,
      icon: "shuffle",
      featured: true,
      onclick: `window.qbankOpenBlockBuilder({ bankId: '${cqJsArg(activeQBankId)}' })`,
      ariaLabel: `Practice all objectives. ${totalAnswered} of ${totalQuestions} answered.`
    });
    rows += qbankTaxonomyRows(stats, 0, [], activeQBankId);

    qbankTaxonomyRender({
      backLabel: "Back to home",
      backAction: "window.openQBank()",
      crumb: `${cqEsc(activeQBankName)} · ${stats.length} objectives`,
      kicker: activeQBankName,
      title: "Educational objectives",
      subtitle: `${stats.length} objectives · ${qblockTaxonomyCrumb()}`,
      actions: `<button type="button" class="cq-browser-action" onclick="window.qbankOpenBlockBuilder()"><i data-lucide="timer" aria-hidden="true"></i><span>Create test</span></button>`,
      searchPlaceholder: "Search educational objectives...",
      searchLabel: "Search educational objectives",
      status: `Showing all ${stats.length} objectives`,
      noun: "objectives",
      total: stats.length,
      layout: "grid",
      rows
    });
  };

  window.showQBankOrganSystems = async function(objective) {
    const loaded = await qbankTaxonomyLoadBank(currentQBankId);
    if (!loaded) return;
    const { activeQBankName, questions, progress } = loaded;
    const prefix = [objective];
    const stats = qbankTaxonomyLevelStats(questions, progress, 1, prefix);
    const total = questions.filter(q => qblockObjectiveOf(q) === objective).length;
    const answered = questions.filter(q => qblockObjectiveOf(q) === objective && progress[q.id] && progress[q.id].correct !== undefined).length;
    const correct = questions.filter(q => qblockObjectiveOf(q) === objective && progress[q.id] && progress[q.id].correct).length;
    const path = [objective];
    const routeId = qbankTaxonomyRoute(path, 1);

    let rows = cqBrowserRow({
      title: `All ${qblockLevel2Label().toLowerCase()} (Mix)`,
      searchText: `${objective} all ${qblockLevel2Label().toLowerCase()} mix`,
      meta: `Practice questions across all ${qblockLevel2Label().toLowerCase()} for this objective`,
      total,
      answered,
      correct,
      icon: "shuffle",
      featured: true,
      onclick: `window.qbankStartTaxonomyRoute('${cqJsArg(routeId)}')`,
      ariaLabel: `Practice all ${qblockLevel2Label().toLowerCase()} for ${objective}. ${answered} of ${total} answered.`
    });
    rows += qbankTaxonomyRows(stats, 1, path, currentQBankId);

    qbankTaxonomyRender({
      backLabel: "Back to objectives",
      backAction: "window.showQBankObjectives()",
      crumb: `${cqEsc(activeQBankName)} &gt; ${cqEsc(objective)}`,
      kicker: activeQBankName,
      title: cqEsc(objective),
      subtitle: `${qblockLevel2Label()} · ${stats.length} ${qblockLevel2Label().toLowerCase()} · ${total} questions`,
      actions: `<button type="button" class="cq-browser-action" onclick="window.qbankOpenBlockBuilder()"><i data-lucide="timer" aria-hidden="true"></i><span>Create test</span></button>`,
      searchPlaceholder: `Search ${qblockLevel2Label().toLowerCase()}...`,
      searchLabel: `Search ${qblockLevel2Label().toLowerCase()} in ${objective}`,
      status: `Showing all ${stats.length} ${qblockLevel2Label().toLowerCase()}`,
      noun: qblockLevel2Label().toLowerCase(),
      total: stats.length,
      layout: "grid",
      rows
    });
  };

  window.showQBankClinicalSpecialties = async function(objective, organSystem) {
    const loaded = await qbankTaxonomyLoadBank(currentQBankId);
    if (!loaded) return;
    const { activeQBankName, questions, progress } = loaded;
    const prefix = [objective, organSystem];
    const stats = qbankTaxonomyLevelStats(questions, progress, 2, prefix);
    const total = questions.filter(q => qblockObjectiveOf(q) === objective && qblockSubjectOf(q) === organSystem).length;
    const answered = questions.filter(q => qblockObjectiveOf(q) === objective && qblockSubjectOf(q) === organSystem && progress[q.id] && progress[q.id].correct !== undefined).length;
    const correct = questions.filter(q => qblockObjectiveOf(q) === objective && qblockSubjectOf(q) === organSystem && progress[q.id] && progress[q.id].correct).length;
    const path = [objective, organSystem];
    const routeId = qbankTaxonomyRoute(path, 2);

    let rows = cqBrowserRow({
      title: "All clinical specialties (Mix)",
      searchText: `${organSystem} all clinical specialties mix`,
      meta: "Practice questions across all clinical specialties for this objective and organ system",
      total,
      answered,
      correct,
      icon: "shuffle",
      featured: true,
      onclick: `window.qbankStartTaxonomyRoute('${cqJsArg(routeId)}')`,
      ariaLabel: `Practice all clinical specialties in ${organSystem}. ${answered} of ${total} answered.`
    });
    rows += qbankTaxonomyRows(stats, 2, path, currentQBankId);

    qbankTaxonomyRender({
      backLabel: "Back to organ systems",
      backAction: `window.showQBankOrganSystems('${cqJsArg(objective)}')`,
      crumb: `${cqEsc(activeQBankName)} &gt; ${cqEsc(objective)} &gt; ${cqEsc(organSystem)}`,
      kicker: activeQBankName,
      title: cqEsc(organSystem),
      subtitle: `Clinical specialties · ${stats.length} specialties · ${total} questions`,
      actions: `<button type="button" class="cq-browser-action" onclick="window.qbankOpenBlockBuilder()"><i data-lucide="timer" aria-hidden="true"></i><span>Create test</span></button>`,
      searchPlaceholder: "Search clinical specialties...",
      searchLabel: `Search clinical specialties in ${organSystem}`,
      status: `Showing all ${stats.length} clinical specialties`,
      noun: "clinical specialties",
      total: stats.length,
      layout: "grid",
      rows
    });
  };

  // Module leaf view: topics inside one Subject/System.
  window.showQBankTopics = async function(objective, level2) {
    const loaded = await qbankTaxonomyLoadBank(currentQBankId);
    if (!loaded) return;
    const { activeQBankName, questions, progress } = loaded;
    const stats = qbankTaxonomyLevelStats(questions, progress, 3, [objective, level2]);
    const total = questions.filter(q => qblockObjectiveOf(q) === objective && qblockSubjectOf(q) === level2).length;
    const answered = questions.filter(q => qblockObjectiveOf(q) === objective && qblockSubjectOf(q) === level2 && progress[q.id] && progress[q.id].correct !== undefined).length;
    const correct = questions.filter(q => qblockObjectiveOf(q) === objective && qblockSubjectOf(q) === level2 && progress[q.id] && progress[q.id].correct).length;
    const path = [objective, level2];
    const routeId = qbankTaxonomyRoute(path, 2);

    let rows = cqBrowserRow({
      title: "All topics (Mix)",
      searchText: `${level2} all topics mix`,
      meta: `Practice questions across all topics in this ${qblockLevel2Singular().toLowerCase()}`,
      total,
      answered,
      correct,
      icon: "shuffle",
      featured: true,
      onclick: `window.qbankStartTaxonomyRoute('${cqJsArg(routeId)}')`,
      ariaLabel: `Practice all topics in ${level2}. ${answered} of ${total} answered.`
    });
    rows += qbankTaxonomyRows(stats, 3, path, currentQBankId);

    qbankTaxonomyRender({
      backLabel: `Back to ${qblockLevel2Label().toLowerCase()}`,
      backAction: `window.showQBankOrganSystems('${cqJsArg(objective)}')`,
      crumb: `${cqEsc(activeQBankName)} &gt; ${cqEsc(objective)} &gt; ${cqEsc(level2)}`,
      kicker: activeQBankName,
      title: cqEsc(level2),
      subtitle: `Topics · ${stats.length} topics · ${total} questions`,
      actions: `<button type="button" class="cq-browser-action" onclick="window.qbankOpenBlockBuilder()"><i data-lucide="timer" aria-hidden="true"></i><span>Create test</span></button>`,
      searchPlaceholder: "Search topics...",
      searchLabel: `Search topics in ${level2}`,
      status: `Showing all ${stats.length} topics`,
      noun: "topics",
      total: stats.length,
      layout: "grid",
      rows
    });
  };

  window.showQBankSubTopics = async function(objective, organSystem, clinicalSpecialty) {
    const loaded = await qbankTaxonomyLoadBank(currentQBankId);
    if (!loaded) return;
    const { activeQBankName, questions, progress } = loaded;
    const prefix = [objective, organSystem, clinicalSpecialty];
    const stats = qbankTaxonomyLevelStats(questions, progress, 3, prefix);
    const total = questions.filter(q => qblockObjectiveOf(q) === objective && qblockSubjectOf(q) === organSystem && qblockClinicalSpecialtyOf(q) === clinicalSpecialty).length;
    const answered = questions.filter(q => qblockObjectiveOf(q) === objective && qblockSubjectOf(q) === organSystem && qblockClinicalSpecialtyOf(q) === clinicalSpecialty && progress[q.id] && progress[q.id].correct !== undefined).length;
    const correct = questions.filter(q => qblockObjectiveOf(q) === objective && qblockSubjectOf(q) === organSystem && qblockClinicalSpecialtyOf(q) === clinicalSpecialty && progress[q.id] && progress[q.id].correct).length;
    const path = [objective, organSystem, clinicalSpecialty];
    const routeId = qbankTaxonomyRoute(path, 3);

    let rows = cqBrowserRow({
      title: "All sub-topics / diseases (Mix)",
      searchText: `${clinicalSpecialty} all sub-topics mix`,
      meta: "Practice questions across all sub-topics and diseases in this specialty",
      total,
      answered,
      correct,
      icon: "shuffle",
      featured: true,
      onclick: `window.qbankStartTaxonomyRoute('${cqJsArg(routeId)}')`,
      ariaLabel: `Practice all sub-topics in ${clinicalSpecialty}. ${answered} of ${total} answered.`
    });
    rows += qbankTaxonomyRows(stats, 3, path, currentQBankId);

    qbankTaxonomyRender({
      backLabel: "Back to clinical specialties",
      backAction: `window.showQBankClinicalSpecialties('${cqJsArg(objective)}', '${cqJsArg(organSystem)}')`,
      crumb: `${cqEsc(activeQBankName)} &gt; ${cqEsc(objective)} &gt; ${cqEsc(organSystem)} &gt; ${cqEsc(clinicalSpecialty)}`,
      kicker: activeQBankName,
      title: cqEsc(clinicalSpecialty),
      subtitle: `Sub-topics / diseases · ${stats.length} leaves · ${total} questions`,
      actions: `<button type="button" class="cq-browser-action" onclick="window.qbankOpenBlockBuilder()"><i data-lucide="timer" aria-hidden="true"></i><span>Create test</span></button>`,
      searchPlaceholder: "Search sub-topics / diseases...",
      searchLabel: `Search sub-topics and diseases in ${clinicalSpecialty}`,
      status: `Showing all ${stats.length} sub-topics`,
      noun: "sub-topics",
      total: stats.length,
      layout: "grid",
      rows
    });
  };

  window.showQBankOrganSystemsByRoute = function(routeId) {
    const route = window.__qbankTaxonomyRoutes && window.__qbankTaxonomyRoutes[routeId];
    if (route) window.showQBankOrganSystems(route.path[0]);
  };

  window.showQBankSubjects = window.showQBankObjectives;
  window.showQBankChapters = function() {
    return window.showQBankObjectives();
  };
  window.showQBankParts = function() {
    return window.showQBankObjectives();
  };

  window.filterQBankSubjects = function(query) {
    const raw = String(query == null ? "" : query).trim();
    const q = raw.toLowerCase();
    const container = document.getElementById("qbank-subject-list-container");
    if (!container) return;
    let visible = 0;
    container.querySelectorAll(".qbank-subject-btn").forEach(btn => {
      const row = btn.closest(".cq-list-row") || btn;
      const text = (btn.getAttribute("data-subject") || "").toLowerCase();
      const match = !q || text.includes(q);
      row.style.display = match ? "" : "none";
      if (match) visible++;
    });
    container.querySelectorAll(".qbank-topic-group").forEach(group => {
      const text = (group.getAttribute("data-subject") || "").toLowerCase();
      group.style.display = !q || text.includes(q) ? "block" : "none";
    });
    const status = document.getElementById("qbank-search-status");
    if (!status) return;
    const noun = container.getAttribute("data-search-noun") || "items";
    const total = Number(container.getAttribute("data-search-total")) || visible;
    if (!q) status.textContent = `Showing all ${total} ${noun}`;
    else if (visible) status.textContent = `${visible} of ${total} ${noun} match “${raw}”`;
    else status.textContent = `No ${noun} match “${raw}”. Try a shorter term.`;
  };

  window.startQBankFiltered = async function(subject, chapter = null, reviewIncorrectsOnly = false, topicPath = null, tag = null) {
    // If subject contains a hyphen and chapter is not provided, try to parse them from the combined string (e.g. from last session)
    if (subject && !chapter && !topicPath && subject.includes(" - ")) {
        const parts = subject.split(" - ");
        const potentialSubject = parts[0];
        const remainder = parts.slice(1).join(" - ");
        const potentialTopic = remainder.split(/\s*>\s*/).map(s => s.trim()).filter(Boolean);
        const topicCandidates = potentialTopic.length ? [potentialTopic] : [];
        if (potentialTopic.length && String(potentialTopic[0]).toLowerCase() !== String(potentialSubject).toLowerCase()) {
            topicCandidates.push([potentialSubject, ...potentialTopic]);
        }
        const matchedTopic = topicCandidates.find(candidate => allQuestions.some(q => qblockTopicMatches(qblockTaxonomyPath(q), candidate)));
        const isValid = window.qbankCurrentSubjectStats 
            ? !!window.qbankCurrentSubjectStats[potentialSubject]
            : allQuestions.some(q => q.data && q.data.subject === potentialSubject);
        const chapterExists = isValid && (window.qbankCurrentSubjectStats?.[potentialSubject]?.chapters?.[remainder]
            || allQuestions.some(q => q.data && q.data.subject === potentialSubject && q.data.chapter === remainder));
        if (matchedTopic && !chapterExists) {
            subject = potentialSubject;
            topicPath = matchedTopic;
        } else if (isValid) {
            subject = potentialSubject;
            chapter = remainder;
        } else if (matchedTopic) {
            subject = potentialSubject;
            topicPath = matchedTopic;
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
    let topicLabel = Array.isArray(topicPath) && topicPath.length ? topicPath.join(" > ") : "";
    if (topicLabel && subject && topicPath.length > 1 && String(topicPath[0]).toLowerCase() === String(subject).toLowerCase()) {
      topicLabel = topicPath.slice(1).join(" > ");
    }
    const sessionLabel = tag
      ? `Tag: ${tag}`
      : (topicLabel ? `${subject || "All Subjects"} - ${topicLabel}` : (chapter ? `${subject} - ${chapter}` : (subject || "All Subjects")));
    saveQBankSession(currentQBankId, qbName, sessionLabel, topicPath, tag);
    
    if (subject) {
      currentQuestions = allQuestions.filter(q => q.data && q.data.subject === subject);
      if (chapter) {
          currentQuestions = currentQuestions.filter(q => q.data && q.data.chapter === chapter);
      }
    } else {
      currentQuestions = [...allQuestions];
    }
    if (Array.isArray(topicPath) && topicPath.length) {
      currentQuestions = currentQuestions.filter(q => {
        if (qblockTopicMatches(qblockTaxonomyPath(q), topicPath)) return true;
        if (topicPath.length === 3 && qblockTaxonomyPath(q).length === 0) {
          const data = (q && q.data) || {};
          return String(data.subject || "").toLowerCase() === String(topicPath[0] || "").toLowerCase()
            && String(data.chapter || "").toLowerCase() === String(topicPath[1] || "").toLowerCase()
            && String(data.part || "").toLowerCase() === String(topicPath[2] || "").toLowerCase();
        }
        return false;
      });
    }

    if (tag) {
      const wantedTag = String(tag).trim().toLowerCase();
      currentQuestions = currentQuestions.filter(q => {
        return qblockTagNames(q).some(name => String(name).trim().toLowerCase() === wantedTag);
      });
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

    window.startQBankBlockClock && window.startQBankBlockClock(Date.now());
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
      <button type="button" class="qlb-close" title="Close (Esc)">Ã—</button>
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
    
    if (window.__qbankBlock && window.__qbankBlock.active) qblockTrackTime();
    currentIndex = idx;
    window.currentIndex = currentIndex;
    window.qbankRenderSidebar();
    window.qbankRenderCurrent();
  };

  window.qbankRenderSidebar = function() {
    const container = document.getElementById("qbank-sidebar");
    if (!container) return;
    
    let html = "";
    const block = window.__qbankBlock;
    currentQuestions.forEach((q, idx) => {
      const p = window.qbankProgress[q.id] || {};
      const isMarked = p.marked;
      const blockPick = block && block.active && Array.isArray(block.answers[q.id]) && block.answers[q.id].length > 0;
      let isAnswered = blockPick || p.correct !== undefined;
      if (block && block.active) {
        if (!block.submitted) isAnswered = !!blockPick;
        else {
          const rr = block.results && block.results.byId && block.results.byId[q.id];
          isAnswered = rr ? !rr.unanswered : !!blockPick;
        }
      }
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
    const block = window.__qbankBlock;
    const blockActive = !!(block && block.active);
    const blockSubmitted = !!(blockActive && block.submitted);
    const blockExam = !!(blockActive && !blockSubmitted && block.mode === "exam");
    if (currentIndex >= currentQuestions.length) {
      stopTimer();
      if (blockActive && block.results) {
        window.qbankBlockShowResults();
        return;
      }
      if (blockActive) currentIndex = Math.max(0, currentQuestions.length - 1);
      else {
        area.innerHTML = `<div style="padding:60px; text-align:center;">
          <i data-lucide="check-circle" style="width:64px; height:64px; color:var(--accent-cyan); margin-bottom:20px;"></i>
          <h2>You have completed all questions in this session!</h2>
          <button class="btn-action primary" style="margin-top:20px; padding:12px 24px;" onclick="window.openQBank()">Return to QBank Home</button>
        </div>`;
        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
        window.qbankEnhanceImages && window.qbankEnhanceImages(document.getElementById("qbank-modal"));
        return;
      }
    }
    
    const q = currentQuestions[currentIndex];
    const data = q.data || {};
    
    const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
    // Answer split: while the slice is in flight, fall back to the
    // non-sensitive `multi` stem flag so QCM still renders as checkboxes.
    const isMultiple = correctIndices.length > 1 || (correctIndices.length === 0 && data.multi === true);
    const blockPick = blockActive && Array.isArray(block.answers[q.id]) ? block.answers[q.id] : [];
    const blockResult = blockSubmitted && block.results && block.results.byId ? block.results.byId[q.id] : null;
    const reviewState = blockSubmitted ? (blockResult || { correct: false, partial: false, unanswered: true, selected: [] }) : null;
    
    const inPartyMode = window.QBankParty && window.QBankParty.state.party;
    let optionsHtml = '';
    if (data.options) {
      // Get peer stats for this question (hidden during a timed block)
      const peerStats = !blockExam && window.qbankPeerStats && window.qbankPeerStats[q.id] || null;
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

        const selectedHere = (blockExam || blockSubmitted) && blockPick.includes(i);
        const isCorrectPick = blockSubmitted && correctIndices.includes(i);
        const isPartialPick = blockSubmitted && reviewState && reviewState.partial && selectedHere && isCorrectPick;
        let optionClass = "usmle-option qbank-option-btn uiverse-label qbank-uw-option";
        if (selectedHere) optionClass += " selected";
        if (blockSubmitted) {
          if (isPartialPick) optionClass += " partial";
          else if (isCorrectPick) optionClass += " correct";
          else if (selectedHere) optionClass += " incorrect";
        }
        const inputDisabled = blockSubmitted ? "disabled" : "";
        const inputPrevent = blockExam || blockSubmitted ? 'onclick="event.preventDefault()"' : "";
        const labelClick = blockExam
          ? `onclick="window.qbankBlockPick(${i}); event.preventDefault();"`
          : "";

        return `
        <div class="qbank-radio-input">
          <input type="${isMultiple ? 'checkbox' : 'radio'}" id="qbank-radio-input-${i}" name="qbank-radio" value="${i}" ${selectedHere ? "checked" : ""} ${inputDisabled} style="position:absolute; opacity:0; pointer-events:none; width:1px; height:1px; margin:0;" ${inputPrevent} aria-label="Option ${String.fromCharCode(65 + i)}">
          <label class="${optionClass}" id="qbank-opt-${i}" for="qbank-radio-input-${i}" ${labelClick}>
            <span class="qbank-uw-radio" aria-hidden="true"></span>
            <span class="usmle-option-letter">${String.fromCharCode(65 + i)}</span>
            <span class="usmle-option-text">${window.renderRichText ? window.renderRichText(opt) : (window.escapeHtml ? window.escapeHtml(opt) : opt)}</span>
            ${peerPercent}
          </label>
        </div>`;
      }).join('');
    }
    
    // Fetch peer stats for this question (cached: 0 reads on revisit).
    // loadPeerStats() dedupes in-flight requests and serves fresh cache,
    // so rapid Next/Prev navigation never fires duplicate Firestore gets.
    if (!blockExam && q.id && window.loadPeerStats) {
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
          if ((qbankTimer || blockExam) && currentQuestions[currentIndex] && currentQuestions[currentIndex].id === q.id
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
    if (blockSubmitted) {
      submitHtml = '';
    } else if (blockExam) {
      const examHint = blockPick.length
        ? "Answer saved. Correct answers and explanations unlock after you submit."
        : (isMultiple ? "Select all that apply. Answers unlock after you submit." : "Select one answer. Answers unlock after you submit.");
      submitHtml = `<div class="qbank-uw-hint" id="qb-block-hint"><i class="fa-solid fa-lock"></i><span id="qb-block-hint-text">${examHint}</span></div>`;
    } else if (inPartyMode) {
      submitHtml = `<button id="qbank-submit-btn" class="qbank-uw-submit" onclick="window.qbankPartyLockAnswer()">Lock Answer</button>`;
    } else {
      const hint = isMultiple ? "Select all that apply, then submit." : "Select one answer, then submit.";
      submitHtml = `<button id="qbank-submit-btn" class="qbank-uw-submit" onclick="window.qbankSelectOption()">Submit</button>
        <div class="qbank-uw-hint" id="qbank-submit-hint"><i class="fa-regular fa-hand-pointer"></i><span>${hint}</span></div>`;
    }

    let reviewHeader = "";
    if (blockSubmitted) {
      if (reviewState.unanswered) reviewHeader = '<span style="color:#eab308;"><i data-lucide="minus-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Not answered</span>';
      else if (reviewState.correct) reviewHeader = '<span style="color:#22c55e;"><i data-lucide="check-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Correct</span>';
      else if (reviewState.partial) reviewHeader = '<span style="color:#eab308;"><i data-lucide="check-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Partially correct</span>';
      else reviewHeader = '<span style="color:#f43f5e;"><i data-lucide="x-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Incorrect</span>';
    }
    const reviewTimeText = blockSubmitted ? formatTime(reviewState.timeMs || 0) : "";
    const isLastQuestion = currentIndex >= currentQuestions.length - 1;
    const nextButtonLabel = blockSubmitted
      ? (isLastQuestion ? "Back to block results" : "Next review question")
      : (blockActive && block.mode === "tutor" && isLastQuestion ? "Finish test" : "Next Question");
    const nextButtonAction = blockSubmitted ? "window.qbankBlockNextReview()" : "window.qbankNext()";

    area.innerHTML = `
      <div id="qbank-split-container" class="qbank-uw-split" style="display:flex; text-align:left; align-items:flex-start;">
        
        <!-- MAIN QUESTION COLUMN -->
        <div id="qbank-left-col" class="qbank-uw-left" style="flex:1; min-width:0;">
          <div class="usmle-question-card qbank-uw-question-card">
          
          ${(() => {
             const p = window.qbankProgress[q.id] || {};
             if (!p.note) return "";
             return `
             <div id="qbank-note-container" class="qbank-uw-note">
               <div class="qbank-uw-note-label"><i class="fa-solid fa-sticky-note"></i> MY NOTE</div>
               <div class="qbank-uw-note-text">${window.escapeHtml ? window.escapeHtml(p.note) : p.note}</div>
             </div>`;
          })()}

          <div id="qbank-note-editor" class="qbank-uw-note-editor" style="display:none;">
             <textarea id="qbank-note-input" class="login-input" style="width:100%; height:80px; padding:10px; font-size:0.9rem; margin-bottom:10px;" placeholder="Type your personal note here..."></textarea>
             <div style="display:flex; justify-content:flex-end; gap:8px;">
               <button class="btn-dark-pill" style="padding:6px 12px; font-size:0.85rem;" onclick="window.qbankToggleNoteUI()">Cancel</button>
               <button class="btn-action primary" style="padding:6px 12px; font-size:0.85rem;" onclick="window.qbankSaveNote()">Save Note</button>
             </div>
          </div>
          <h2 id="qbank-question-content" class="qbank-uw-stem" onmouseup="window.qbankHandleSelection(event)">
            ${q.highlightedHTML ? q.highlightedHTML : (window.renderRichText ? window.renderRichText(q.text) : (window.escapeHtml ? window.escapeHtml(q.text) : q.text))}
          </h2>
          <div class="qbank-uw-options-box">
            <div class="usmle-options qbank-uw-options" id="qbank-options-container">
              ${optionsHtml}
            </div>
          </div>
          ${submitHtml}
          
          <div id="qbank-explanation-container" class="usmle-explanation" style="display:${blockSubmitted ? "block" : "none"}; margin-top:30px;">
             <div id="qbank-result-header" style="font-weight:bold; margin-bottom:12px; font-size:1.1rem;">${reviewHeader}</div>
             <div style="margin-bottom:16px; font-size:0.9rem; color:var(--text-muted); display:flex; align-items:center;">
               <i class="fa-regular fa-clock" style="font-size:14px; margin-right:4px;"></i> Time Taken: <span id="qbank-time-taken-text" style="margin-left:4px; font-weight:600; color:var(--text-primary);">${reviewTimeText}</span>
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
             
             <div class="qbank-uw-explanation-actions">
               <button id="qbank-study-btn" type="button" class="btn-dark-pill" onclick="window.generateStudyConcept('${q.id}')" title="Study this concept in detail">
                 <i class="fa-solid fa-book-open"></i> Study this part
               </button>
               <button type="button" class="btn-dark-pill" onclick="window.generateAIFlashcard('${q.id}')" title="Generate an AI flashcard from this question">
                 <i class="fa-solid fa-brain"></i> AI Flashcard
               </button>
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

             <button class="usmle-proceed-btn" style="margin-top:20px; width:100%;" onclick="${nextButtonAction}">${nextButtonLabel}</button>
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
    window.qbankRenderChrome();
  };

  window.qbankSelectOption = async function (selectedIndex) {
    const activeBlock = window.__qbankBlock;
    if (activeBlock && activeBlock.active && (activeBlock.submitted || activeBlock.mode === "exam")) return;
    if (!qbankTimer) return; // already answered
    const q = currentQuestions[currentIndex];
    if (!q) return;

    // Two-step answer flow: the user picks an option, then presses Submit.
    // Read the checked input(s) so both radio and checkbox groups work.
    const inputs = Array.from(document.getElementsByName("qbank-radio"));
    let selectedIndices = [];
    const explicit = (selectedIndex !== undefined && selectedIndex !== null) ? parseInt(selectedIndex, 10) : NaN;
    if (Number.isFinite(explicit)) {
      selectedIndices = [explicit];
      inputs.forEach((input) => {
        const idx = parseInt(input.value, 10);
        if (idx === explicit) input.checked = true;
      });
    } else {
      inputs.forEach((input) => {
        if (input.checked) selectedIndices.push(parseInt(input.value, 10));
      });
    }
    selectedIndices = [...new Set(selectedIndices.filter((n) => Number.isFinite(n)))].sort((a, z) => a - z);
    if (!selectedIndices.length) {
      qbankToastSafe("Select an answer choice before submitting.", true);
      return;
    }

    stopTimer();
    currentQuestionTimeMs = questionStartTime ? Math.max(0, Date.now() - questionStartTime) : 0;
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
    const gradedData = q.data || {};
    const correctIndices = Array.isArray(gradedData.correctIndices) ? gradedData.correctIndices : (gradedData.correctOptionIndex !== undefined ? [gradedData.correctOptionIndex] : []);
    const isMultiple = correctIndices.length > 1 || (correctIndices.length === 0 && gradedData.multi === true);

    const submitBtn = document.getElementById("qbank-submit-btn");
    if (submitBtn) submitBtn.style.display = "none";
    const submitHint = document.getElementById("qbank-submit-hint");
    if (submitHint) submitHint.style.display = "none";
    
    currentSelectedIndices = selectedIndices;
    if (activeBlock && activeBlock.active && !activeBlock.submitted && activeBlock.mode === "tutor") {
      activeBlock.answers[q.id] = [...selectedIndices];
      const answeredEl = document.getElementById("qb-block-answered");
      if (answeredEl) answeredEl.textContent = `${qblockAnsweredCount()}/${currentQuestions.length}`;
    }

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
      isCorrect = correctIndices.includes(selectedIndices[0]);
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
      } else if (correctIndices.includes(i)) {
        label.classList.add("correct");
      } else if (selectedIndices.includes(i) && !correctIndices.includes(i)) {
        label.classList.add("incorrect");
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
    p.omitted = false;
    window.qbankProgress[q.id] = p;
    window.qbankRenderSidebar();

    // Submit progress silently
    if (currentQBankId) {
      pushToSyncQueue({
        qbankId: currentQBankId,
        questionId: q.id,
        correct: isCorrect,
        timeTakenMs: currentQuestionTimeMs,
        omitted: false,
        subject: (q.data && q.data.subject) || "",
        chapter: (q.data && q.data.chapter) || ""
      });
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

    window.qbankRenderChrome();
    if (activeBlock && activeBlock.active) qblockPersistActive();
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
    
    const block = window.__qbankBlock;
    if (block && block.active) {
      if (block.submitted) {
        window.qbankBlockNextReview();
        return;
      }
      if (currentIndex >= currentQuestions.length - 1) {
        window.qbankSubmitBlock(false);
        return;
      }
      qblockTrackTime();
      currentIndex++;
      window.currentIndex = currentIndex;
      window.qbankRenderSidebar();
      window.qbankRenderCurrent();
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
    const p = qbankProgressMap()[q.id] || {};
    const newMarked = !p.marked;
    
    // Optimistic update only — re-rendering the question would reset the
    // current selection, the timer, and any revealed explanation.
    p.marked = newMarked;
    qbankProgressMap()[q.id] = p;
    window.qbankRenderChrome();
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
          <button type="button" class="rp-close">Ã—</button>
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
      window.qbankRenderChrome();
      if (window.qbankHighlighterActive) {
          qbankToastSafe("Highlighter on. Select text in the question to highlight it.");
      }
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
    p.noteUpdatedAt = Date.now();
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
      const escH = window.escapeHtml ? window.escapeHtml : (s) => s;
      // JS-escape the RAW value first, then HTML-escape: inline onclick args
      // are HTML-decoded before running as JS, so \' survives both layers.
      const jsStr = (s) => escH(String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
      const safeBankName = jsStr(activeQBankName);

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
           const ch = (q.data && q.data.chapter) || null;
           if (!subjectStats[sub]) subjectStats[sub] = { total: 0, answered: 0, correct: 0, incorrect: 0, marked: 0, chapters: {} };
           subjectStats[sub].total++;
           let chStat = null;
           if (ch) {
               if (!subjectStats[sub].chapters[ch]) subjectStats[sub].chapters[ch] = { total: 0, answered: 0, correct: 0, incorrect: 0, marked: 0 };
               chStat = subjectStats[sub].chapters[ch];
               chStat.total++;
           }

           if (prog[q.id]) {
             if (prog[q.id].correct !== undefined) {
               totalAnswered++;
               subjectStats[sub].answered++;
               if (prog[q.id].correct) {
                 totalCorrect++;
                 subjectStats[sub].correct++;
                 if (chStat) chStat.correct++;
               } else {
                 subjectStats[sub].incorrect++;
                 if (chStat) chStat.incorrect++;
               }
               if (chStat) chStat.answered++;
             }
             if (prog[q.id].marked) {
                 subjectStats[sub].marked++;
                 if (chStat) chStat.marked++;
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
              const subSafe = jsStr(spec.name);

              // Chapter-by-chapter breakdown, expandable per specialty.
              const chEntries = Object.keys(spec.chapters || {})
                  .map(name => ({ name, ...spec.chapters[name] }))
                  .map(c => ({ ...c, score: c.answered > 0 ? Math.round((c.correct / c.answered) * 100) : 0 }))
                  .sort((a, b) => b.answered - a.answered || String(a.name).localeCompare(String(b.name)));
              let chapHtml = '';
              if (chEntries.length > 0) {
                  const chRows = chEntries.map(c => {
                      const cColor = c.score >= 80 ? '#10b981' : (c.score >= 50 ? '#007a7a' : '#e11d48');
                      const chSafe = jsStr(c.name);
                      // Reviewable = wrong OR marked (mirrors the review session filter).
                      const reviewable = (c.incorrect || 0) + (c.marked || 0);
                      return `
                      <div class="flex items-center gap-2 rounded-lg px-3 py-2" style="background:#f8fafc; border:1px solid #eef2f7;">
                          <div class="flex-1 min-w-0">
                              <div class="text-[13px] font-semibold truncate" style="color:#111827;" title="${escH(c.name)}">${escH(c.name)}</div>
                              <div class="text-[11px]" style="color:#6b7280;">${c.answered} / ${c.total} · <span style="color:${cColor}; font-weight:800;">${c.score}%</span></div>
                          </div>
                          <button class="px-2 py-1 text-[11px] font-bold uppercase rounded-lg border cursor-pointer" style="border-color:#e2e8f0; color:#007a7a; background:#fff;" onclick="window.startQBankSession('${activeQBankId}', '${safeBankName}', '${subSafe}', false, '${chSafe}')">Practice</button>
                          ${reviewable > 0 ? `<button class="px-2 py-1 text-[11px] font-bold uppercase rounded-lg cursor-pointer" style="background:#fef2f2; color:#e11d48; border:1px solid #fecaca;" onclick="window.startQBankSession('${activeQBankId}', '${safeBankName}', '${subSafe}', true, '${chSafe}')">Incorrects${c.incorrect > 0 ? ` (${c.incorrect})` : ''}</button>` : ''}
                      </div>`;
                  }).join('');
                  chapHtml = `
                  <details class="mb-4" style="border:1px solid #eef2f7; border-radius:12px; padding:10px 12px; background:#fff;">
                      <summary class="text-[12px] font-bold cursor-pointer" style="color:#007a7a;">Chapters (${chEntries.length}) — chapter by chapter</summary>
                      <div class="flex flex-col gap-2 mt-3">${chRows}</div>
                  </details>`;
              }

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

                  ${chapHtml}

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

          <div>
              <h3 class="font-headline-lg text-[22px] mb-2 mt-4" style="color:#111827;">Exam Prep</h3>
              <p class="text-sm mb-4" style="color:#6b7280;">Your performance across past-exam (exam-prep) banks and their subjects — only banks with at least one answered question are shown.</p>
              <div id="ep-performance-section">
                  <div class="text-center p-8" style="color:#6b7280;">Loading exam-prep stats…</div>
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

      // Exam-prep banks + subjects load async (cheap progress-only fetches).
      try { loadExamPrepPerformance(); } catch (_) {}
  }

  // â”€â”€ Exam Prep section of the Analytics tab â”€â”€
  // Lists every exam-prep bank with its own accuracy stats plus a combined
  // subject breakdown aggregated across exam-prep banks. Bank-level totals
  // come from progress-only fetches (no question download); subject splits
  // are included for banks whose stems are already cached on the device.
  // Progress-only results for exam-prep banks whose stems are NOT cached.
  // Kept OUT of cachedQBanks on purpose: an entry with questions:[] would
  // make startQBankSession skip its fetch and report "This QBank is empty".
  // READ BUDGET: opening Analytics must not re-read every exam-prep bank.
  // Fresh progress is kept in the session memo + an IDB snapshot, so repeat
  // opens cost 0 reads; a Refresh button forces a live re-fetch instead.
  const EP_SNAP_KEY = "ep_progress_snapshot:v1";
  const EP_SNAP_TTL = 2 * 24 * 60 * 60 * 1000; // re-check live numbers when the saved check is older than 2 days
  let epProgressCache = {}; // session memo: bankId -> progress
  let epSnapshotUsed = false;
  let epSnapshotAt = 0;

  async function loadExamPrepPerformance() {
      const el = document.getElementById("ep-performance-section");
      if (!el) return;
      try {
          let banks = [];
          try {
              const list = (window.getQBankList && window.getQBankList()) || cachedCategories || [];
              banks = (list || []).filter(q => q && q.kind === "exam_prep");
          } catch (_) { banks = []; }
          if (banks.length === 0) {
              try {
                  const saved = await idbKvGet(KV_KEYS.QBANK_LIST);
                  if (saved && Array.isArray(saved.banks)) {
                      cachedCategories = saved.banks;
                      banks = saved.banks.filter(q => q && q.kind === "exam_prep");
                  }
              } catch (_) {}
          }
          if (banks.length === 0) {
              try {
                  const res = await apiGet("list_categories");
                  if (res && Array.isArray(res.qbanks)) {
                      cachedCategories = res.qbanks;
                      if (res.maxUpdatedAt) window.__qbanksMaxUpdatedAt = res.maxUpdatedAt;
                      try { idbKvSet(KV_KEYS.QBANK_LIST, { banks: cachedCategories, maxUpdatedAt: window.__qbanksMaxUpdatedAt || 0 }); } catch (_) {}
                      banks = cachedCategories.filter(q => q && q.kind === "exam_prep");
                  }
              } catch (_) {}
          }
          if (!document.getElementById("ep-performance-section")) return; // navigated away
          if (banks.length === 0) {
              el.innerHTML = '<div class="text-center p-8" style="color:#6b7280;">No exam-prep banks available yet.</div>';
              return;
          }

          const rows = [];
          const subjAgg = {}; // subject -> { total, answered, correct, incorrect, chapters: { ch -> { ..., marked, banks } } }
          const MAX_FETCH = 30; // bound on progress-only fetches per manual refresh
          let fetched = 0;
          // Zero-read snapshot from the last check (plus unsynced local answers merged on top).
          // Older than 2 days counts as stale and is silently re-checked live.
          let snapshot = null;
          let snapshotAt = 0;
          try { snapshot = await idbKvGet(EP_SNAP_KEY); } catch (_) { snapshot = null; }
          if (!snapshot || !snapshot.byBank || typeof snapshot.byBank !== "object") {
              snapshot = null;
          } else {
              snapshotAt = Number(snapshot.fetchedAt) || 0;
              if (!snapshotAt || (Date.now() - snapshotAt) > EP_SNAP_TTL) snapshot = null;
          }
          epSnapshotUsed = false;
          epSnapshotAt = 0;
          for (const b of banks.slice(0, 60)) {
              const entry = cachedQBanks[b.id];
              let questions = entry ? (entry.questions || []) : [];
              let progress = entry ? (entry.progress || {}) : (epProgressCache[b.id] || null);
              if (progress === null && snapshot && snapshot.byBank[b.id] && snapshot.byBank[b.id].progress) {
                  try {
                      // Clone so merging the local sync queue never mutates the snapshot.
                      progress = applyLocalQueueProgress(b.id, JSON.parse(JSON.stringify(snapshot.byBank[b.id].progress)));
                      epSnapshotUsed = true;
                      epSnapshotAt = snapshotAt;
                  } catch (_) { progress = null; }
              }
              if (progress === null) {
                  if (fetched >= MAX_FETCH) continue; // skip silently: unattempted banks are hidden anyway
                  fetched++;
                  try {
                      if (questions.length === 0) {
                          try {
                              const idbData = await getCachedQBank(b.id);
                              if (idbData && Array.isArray(idbData.questions) && idbData.questions.length) questions = idbData.questions;
                          } catch (_) {}
                      }
                      const res = await apiGet("get_questions", { qbankId: b.id, onlyProgress: true });
                      progress = applyLocalQueueProgress(b.id, (res && res.progress) || {});
                      if (questions.length > 0) {
                          if (!cachedQBanks[b.id]) cachedQBanks[b.id] = { questions, progress };
                          else {
                              cachedQBanks[b.id].progress = progress;
                              if (!cachedQBanks[b.id].questions || !cachedQBanks[b.id].questions.length) {
                                  cachedQBanks[b.id].questions = questions;
                              }
                          }
                      } else {
                          epProgressCache[b.id] = progress; // stems unknown: never poison the question cache
                      }
                      // Write-through to the snapshot so the next open costs 0 reads.
                      try {
                          const cur = (await idbKvGet(EP_SNAP_KEY)) || { fetchedAt: 0, byBank: {} };
                          if (!cur.byBank || typeof cur.byBank !== "object") cur.byBank = {};
                          cur.byBank[b.id] = { progress, fetchedAt: Date.now() };
                          cur.fetchedAt = Date.now();
                          await idbKvSet(EP_SNAP_KEY, cur);
                      } catch (_) {}
                  } catch (_) {
                      continue; // unreachable/failed: hidden like any unattempted bank
                  }
              }
              let answered = 0, correct = 0, incorrect = 0;
              const detail = { subjects: {} }; // per-bank subject -> chapter breakdown (stems known only)
              if (questions.length > 0) {
                  for (const q of questions) {
                      const sub = (q.data && q.data.subject) || "Uncategorized";
                      const ch = (q.data && q.data.chapter) || null;
                      const p = progress[q.id];
                      const hasAns = !!(p && p.correct !== undefined);
                      if (sub !== "Uncategorized") {
                          if (!subjAgg[sub]) subjAgg[sub] = { total: 0, answered: 0, correct: 0, incorrect: 0, chapters: {} };
                          if (!detail.subjects[sub]) detail.subjects[sub] = { total: 0, answered: 0, correct: 0, incorrect: 0, chapters: {} };
                          subjAgg[sub].total++;
                          detail.subjects[sub].total++;
                          let aggCh = null, detCh = null;
                          if (ch) {
                              if (!subjAgg[sub].chapters[ch]) subjAgg[sub].chapters[ch] = { total: 0, answered: 0, correct: 0, incorrect: 0, marked: 0, banks: {} };
                              if (!detail.subjects[sub].chapters[ch]) detail.subjects[sub].chapters[ch] = { total: 0, answered: 0, correct: 0, incorrect: 0, marked: 0 };
                              aggCh = subjAgg[sub].chapters[ch];
                              detCh = detail.subjects[sub].chapters[ch];
                              aggCh.total++;
                              detCh.total++;
                          }
                          if (hasAns) {
                              subjAgg[sub].answered++;
                              detail.subjects[sub].answered++;
                              if (p.correct) {
                                  subjAgg[sub].correct++;
                                  detail.subjects[sub].correct++;
                                  if (aggCh) aggCh.correct++;
                                  if (detCh) detCh.correct++;
                              } else {
                                  subjAgg[sub].incorrect++;
                                  detail.subjects[sub].incorrect++;
                                  if (aggCh) aggCh.incorrect++;
                                  if (detCh) detCh.incorrect++;
                              }
                              if (p.marked) {
                                  if (aggCh) aggCh.marked++;
                                  if (detCh) detCh.marked++;
                              }
                              if (aggCh) {
                                  aggCh.answered++;
                                  if (!aggCh.banks[b.id]) aggCh.banks[b.id] = { name: b.name || "Exam bank", incorrect: 0, marked: 0 };
                                  if (!p.correct) aggCh.banks[b.id].incorrect++;
                                  if (p.marked) aggCh.banks[b.id].marked++;
                              }
                              if (detCh) detCh.answered++;
                          }
                      }
                      if (hasAns) {
                          answered++;
                          if (p.correct) correct++; else incorrect++;
                      }
                  }
              } else {
                  // Stems not cached: progress keys alone still give bank totals.
                  for (const k of Object.keys(progress)) {
                      const p = progress[k];
                      if (p && p.correct !== undefined) {
                          answered++;
                          if (p.correct) correct++; else incorrect++;
                      }
                  }
              }
              // Only banks with at least one answered question are shown.
              if (answered > 0) {
                  rows.push({ bank: b, attempted: true, answered, correct, incorrect, total: questions.length, knownTotal: questions.length > 0, detail });
              }
          }
          if (!document.getElementById("ep-performance-section")) return; // navigated away
          el.innerHTML = renderExamPrepHtml(rows, subjAgg, { fetchedAt: epSnapshotUsed ? epSnapshotAt : Date.now() });
          if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      } catch (e) {
          const el2 = document.getElementById("ep-performance-section");
          if (el2) el2.innerHTML = '<div class="text-center p-8" style="color:#e11d48;">Could not load exam-prep stats.</div>';
      }
  }

  function renderExamPrepHtml(rows, subjAgg, meta) {
      const escH = window.escapeHtml ? window.escapeHtml : (s) => s;
      // JS-escape the RAW value first, then HTML-escape: inline onclick args
      // are HTML-decoded before running as JS, so \' survives both layers.
      const jsStr = (s) => escH(String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
      // Only banks with at least one answered question are ever shown.
      const attempted = rows.filter(r => r.attempted && r.answered > 0);
      const totAnswered = attempted.reduce((a, r) => a + r.answered, 0);
      const totCorrect = attempted.reduce((a, r) => a + r.correct, 0);
      const avg = totAnswered > 0 ? Math.round((totCorrect / totAnswered) * 100) : 0;

      if (attempted.length === 0) {
          return '<div class="text-center p-8 rounded-2xl" style="background:#fff; border:1px solid #e2e8f0; color:#6b7280;">No exam-prep attempts yet.<br>Answer at least one question in an exam-prep bank and your chapter-by-chapter results will appear here.</div>';
      }

      const withScore = (o) => ({ ...o, score: o.answered > 0 ? Math.round((o.correct / o.answered) * 100) : 0 });
      const subjList = Object.keys(subjAgg)
          .map(name => withScore({ name, ...subjAgg[name] }))
          .sort((a, b) => b.answered - a.answered || b.score - a.score);

      // Short label for per-bank chips.
      const shortBank = (name) => {
          const s = String(name || "Bank");
          return s.length > 22 ? s.slice(0, 21) + "…" : s;
      };

      // Chapter rows, most-active first. btn=null renders display-only rows;
      // otherwise btn={ bankId, safeName, subSafe } wires Practice/Incorrects
      // buttons scoped to that bank + subject + chapter.
      // In the cross-bank subject overview each chapter instead gets one
      // Incorrects chip per bank that holds wrong/marked questions there.
      function epChapterRows(chMap, btn, subNameForChips) {
          const list = Object.keys(chMap || {})
              .map(name => withScore({ name, ...chMap[name] }))
              .sort((a, b) => b.answered - a.answered || String(a.name).localeCompare(String(b.name)));
          if (list.length === 0) return '';
          return list.map(c => {
              const cColor = c.score >= 80 ? '#10b981' : (c.score >= 50 ? '#007a7a' : '#e11d48');
              const chSafe = jsStr(c.name);
              let btns = '';
              if (btn) {
                  // Reviewable = wrong OR marked (mirrors the review session filter).
                  const reviewable = (c.incorrect || 0) + (c.marked || 0);
                  btns = `<button class="px-2 py-1 text-[11px] font-bold uppercase rounded-lg border cursor-pointer" style="border-color:#e2e8f0; color:#007a7a; background:#fff;" onclick="window.startQBankSession('${btn.bankId}', '${btn.safeName}', '${btn.subSafe}', false, '${chSafe}')">Practice</button>`;
                  if (reviewable > 0) {
                      btns += `<button class="px-2 py-1 text-[11px] font-bold uppercase rounded-lg cursor-pointer" style="background:#fef2f2; color:#e11d48; border:1px solid #fecaca;" onclick="window.startQBankSession('${btn.bankId}', '${btn.safeName}', '${btn.subSafe}', true, '${chSafe}')">Incorrects (${reviewable})</button>`;
                  }
              } else {
                  // Cross-bank overview: one review chip per contributing bank.
                  const chips = Object.keys(c.banks || {}).map(bid => {
                      const info = c.banks[bid] || { incorrect: 0, marked: 0 };
                      const n = (info.incorrect || 0) + (info.marked || 0);
                      if (n <= 0) return '';
                      return `<button class="px-2 py-1 text-[11px] font-bold uppercase rounded-lg cursor-pointer" style="background:#fef2f2; color:#e11d48; border:1px solid #fecaca;" title="Review wrong questions in ${escH(subNameForChips || '')} — ${escH(c.name)} (${escH(info.name || 'bank')})" onclick="window.startQBankSession('${bid}', '${jsStr(info.name || 'Exam bank')}', '${jsStr(subNameForChips || '')}', true, '${chSafe}')">Incorrects · ${escH(shortBank(info.name))} (${n})</button>`;
                  }).join('');
                  if (chips) btns = `<div class="flex flex-wrap gap-1 justify-end" style="max-width:220px;">${chips}</div>`;
              }
              return `
              <div class="flex items-center gap-2 rounded-lg px-3 py-2" style="background:#f8fafc; border:1px solid #eef2f7;">
                  <div class="flex-1 min-w-0">
                      <div class="text-[13px] font-semibold truncate" style="color:#111827;" title="${escH(c.name)}">${escH(c.name)}</div>
                      <div class="text-[11px]" style="color:#6b7280;">${c.answered} / ${c.total} · <span style="color:${cColor}; font-weight:800;">${c.score}%</span></div>
                  </div>
                  ${btns}
              </div>`;
          }).join('');
      }

      function epDetails(title, inner) {
          if (!inner) return '';
          return `
          <details class="mb-4" style="border:1px solid #eef2f7; border-radius:12px; padding:10px 12px; background:#fff;">
              <summary class="text-[12px] font-bold cursor-pointer" style="color:#007a7a;">${title}</summary>
              <div class="flex flex-col gap-2 mt-3">${inner}</div>
          </details>`;
      }

      const updatedAt = meta && meta.fetchedAt ? Number(meta.fetchedAt) : 0;
      const updatedLabel = (() => {
          if (!updatedAt) return '';
          const d = Date.now() - updatedAt;
          if (d < 0) return 'just now';
          const m = Math.floor(d / 60000);
          if (m < 1) return 'just now';
          if (m < 60) return m + 'm ago';
          const h = Math.floor(m / 60);
          if (h < 24) return h + 'h ago';
          return Math.floor(h / 24) + 'd ago';
      })();

      let html = `
          <div class="grid grid-cols-3 gap-3 w-full mb-6" style="max-width:640px;">
              <div class="rounded-xl p-3 flex flex-col justify-center border" style="background:#f8fafc; border-color:#e2e8f0;">
                  <div class="text-[10px] uppercase font-bold tracking-wider mb-1" style="color:#6b7280;">Banks attempted</div>
                  <div class="font-bold text-[18px]" style="color:#007a7a;">${attempted.length}</div>
              </div>
              <div class="rounded-xl p-3 flex flex-col justify-center border" style="background:#f8fafc; border-color:#e2e8f0;">
                  <div class="text-[10px] uppercase font-bold tracking-wider mb-1" style="color:#6b7280;">Answered</div>
                  <div class="font-bold text-[18px]" style="color:#007a7a;">${totAnswered}</div>
              </div>
              <div class="rounded-xl p-3 flex flex-col justify-center border" style="background:#f8fafc; border-color:#e2e8f0;">
                  <div class="text-[10px] uppercase font-bold tracking-wider mb-1" style="color:#6b7280;">Avg accuracy</div>
                  <div class="font-bold text-[18px]" style="color:#111827;">${avg}%</div>
              </div>
          </div>
          <div class="flex flex-wrap items-center gap-3 mb-6">
              ${updatedLabel ? `<span class="text-[12px]" style="color:#9ca3af;">Updated ${updatedLabel}</span>` : ''}
          </div>`;

      if (subjList.length > 0) {
          html += `<div class="text-[12px] font-bold uppercase tracking-wider mb-3" style="color:#6b7280;">Exam-prep subjects</div>
          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 mb-8">`;
          subjList.forEach(spec => {
              const barColor = spec.score >= 80 ? 'background:#10b981' : (spec.score >= 50 ? 'background:#007a7a' : 'background:#e11d48');
              const numColor = spec.score >= 80 ? 'color:#10b981' : (spec.score >= 50 ? 'color:#111827' : 'color:#e11d48');
              const chCount = Object.keys(spec.chapters || {}).length;
              html += `
              <div class="rounded-2xl p-6 shadow-sm flex flex-col" style="background:#fff; border:1px solid #e2e8f0;">
                  <div class="flex items-start justify-between mb-2">
                      <div>
                          <h3 class="text-[18px] mb-1 font-bold" style="color:#111827;">${escH(spec.name)}</h3>
                          <p class="text-[12px]" style="color:#6b7280;">${spec.answered} / ${spec.total} Answered</p>
                      </div>
                      <div class="text-right"><span class="font-black" style="${numColor}; font-size:22px;">${spec.score}%</span></div>
                  </div>
                  <div class="w-full rounded-full h-2 mb-4" style="background:#f8fafc;">
                      <div class="h-2 rounded-full" style="${barColor}; width:${spec.score}%"></div>
                  </div>
                  ${epDetails(`Chapters (${chCount}) — chapter by chapter`, epChapterRows(spec.chapters, null, spec.name))}
                  <div class="mt-auto pt-4 flex gap-4 text-[12px]" style="border-top:1px solid #e2e8f0; color:#6b7280;">
                      <div class="flex items-center gap-1"><span class="w-2 h-2 rounded-full" style="background:#10b981;"></span> ${spec.correct} Correct</div>
                      <div class="flex items-center gap-1"><span class="w-2 h-2 rounded-full" style="background:#e11d48;"></span> ${spec.incorrect} Incorrect</div>
                  </div>
              </div>`;
          });
          html += `</div>`;
      }

      html += `<div class="text-[12px] font-bold uppercase tracking-wider mb-3" style="color:#6b7280;">Exam-prep banks</div>
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">`;
      attempted.forEach(r => {
          const b = r.bank;
          const meta = [b.college, b.year].filter(Boolean).map(x => escH(x)).join(' · ');
          const score = r.answered > 0 ? Math.round((r.correct / r.answered) * 100) : 0;
          const barColor = score >= 80 ? 'background:#10b981' : (score >= 50 ? 'background:#007a7a' : 'background:#e11d48');
          const numColor = score >= 80 ? 'color:#10b981' : (score >= 50 ? 'color:#111827' : 'color:#e11d48');
          const countLabel = r.knownTotal ? `${r.answered} / ${r.total} Answered` : `${r.answered} Answered`;
          const safeName = jsStr(b.name || 'Exam bank');
          // Per-bank subject -> chapter detail with chapter-scoped actions.
          const subEntries = Object.keys((r.detail && r.detail.subjects) || {})
              .map(name => withScore({ name, ...r.detail.subjects[name] }))
              .sort((a, b2) => b2.answered - a.answered || String(a.name).localeCompare(String(b2.name)));
          let bankChapHtml = '';
          if (subEntries.length > 0) {
              bankChapHtml = subEntries.map(s => {
                  const rowsHtml = epChapterRows(s.chapters, { bankId: b.id, safeName, subSafe: jsStr(s.name) });
                  if (!rowsHtml) return '';
                  return `<div class="mb-2"><div class="text-[12px] font-bold mb-2" style="color:#0f172a;">${escH(s.name)} <span style="color:#6b7280; font-weight:600;">· ${s.answered}/${s.total} · ${s.score}%</span></div>${rowsHtml}</div>`;
              }).join('');
              const chTotal = subEntries.reduce((a, s) => a + Object.keys(s.chapters || {}).length, 0);
              bankChapHtml = epDetails(`Subjects & chapters (${subEntries.length} subjects, ${chTotal} chapters)`, bankChapHtml);
          }
          html += `
          <div class="rounded-2xl p-6 shadow-sm flex flex-col" style="background:#fff; border:1px solid #e2e8f0;">
              <h3 class="text-[16px] mb-1 font-bold" style="color:#111827;">${escH(b.name || 'Exam bank')}</h3>
              ${meta ? `<p class="text-[12px] mb-3" style="color:#6b7280;">${meta}</p>` : `<div class="mb-3"></div>`}
              <div class="flex items-end justify-between mb-2">
                  <span class="text-[12px]" style="color:#6b7280;">${countLabel}</span>
                  <span class="font-black" style="${numColor}; font-size:20px;">${score}%</span>
              </div>
              <div class="w-full rounded-full h-2 mb-4" style="background:#f8fafc;">
                  <div class="h-2 rounded-full" style="${barColor}; width:${score}%"></div>
              </div>
              ${bankChapHtml}
              <div class="mt-auto pt-4 flex justify-between items-center" style="border-top:1px solid #e2e8f0;">
                  <div class="flex gap-3 text-[12px]" style="color:#6b7280;">
                      <span>${r.correct} Correct</span><span>${r.incorrect} Incorrect</span>
                  </div>
                  ${r.incorrect > 0 ? `<button class="px-3 py-1.5 text-[12px] font-bold uppercase rounded-lg border cursor-pointer" style="border-color:#e2e8f0; color:#007a7a; background:transparent;" onclick="window.startQBankSession('${b.id}', '${safeName}', null, true)">Review Incorrects</button>` : ''}
              </div>
          </div>`;
      });
      html += `</div>`;
      return html;
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

  // ---------- EXAM PREP (academic profile -> associated banks) ----------
  const EP_FLAG_CODES = { global: "un", usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg", morocco: "ma", saudi: "sa" };
  const EP_COUNTRY_LABELS = { global: "International", usa: "USA", uk: "UK", australia: "Australia", canada: "Canada", india: "India", europe: "Europe", tunisia: "Tunisia", algeria: "Algeria", egypt: "Egypt", morocco: "Morocco", saudi: "Saudi Arabia" };

  const epEsc = (s) => window.escapeHtml
      ? window.escapeHtml(s == null ? "" : s)
      : String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const epJs = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, "\\x22").replace(/\r?\n/g, " ");
  const epCountryLabel = (c) => EP_COUNTRY_LABELS[c] || c || "International";

  const getEpFlagImg = (c, cls = "ep-flag") => {
      const code = EP_FLAG_CODES[c] || "un";
      return `<img src="https://flagcdn.com/${code}.svg" alt="" class="${cls}" loading="lazy"/>`;
  };

  window.__epState = { view: "home", country: null, college: null, focusCountry: null, focusCollege: null };

  window.__epProfile = function() {
      const acc = (window.db && window.db.access) || {};
      const ap = window.__academicProfile || {};
      const saved = window.cqGetSavedCollege ? window.cqGetSavedCollege() : null;
      const academicCountry = acc.country || ap.country || "";
      const academicCollege = acc.college || ap.college || "";
      const country = academicCountry || (saved && saved.country) || "";
      return {
          country,
          countryName: ap.countryName || epCountryLabel(country),
          college: academicCollege || (saved && saved.college) || "",
          academicCountry,
          academicCollege,
          major: acc.major || ap.major || "",
          collegeId: acc.collegeId || ap.collegeId || "",
          legacy: !!acc.legacy,
      };
  };

  function epQuestionsKnown(q) {
      const cached = cachedQBanks[q.id];
      return cached && Array.isArray(cached.questions) ? cached.questions.length : 0;
  }

  window.__epBankCard = function(q) {
      const locked = !!q.locked;
      const safeId = epJs(q.id);
      const safeName = epJs(q.name || "");
      const qCount = epQuestionsKnown(q);
      const college = q.college || "General";
      const country = q.country || "global";
      const meta = [];
      if (q.year) meta.push(`<span class="ep-bank-chip"><i data-lucide="calendar-days"></i>${epEsc(q.year)}</span>`);
      meta.push(`<span class="ep-bank-chip"><i data-lucide="globe-2"></i>${epEsc(epCountryLabel(country))}</span>`);
      if (qCount > 0) meta.push(`<span class="ep-bank-chip"><i data-lucide="list-checks"></i>${qCount.toLocaleString()} questions</span>`);
      const status = locked
          ? `<span class="ep-status is-locked"><i data-lucide="lock"></i>Paid</span>`
          : `<span class="ep-status is-open"><i data-lucide="check-circle"></i>Ready</span>`;
      const cta = locked
          ? `<button type="button" class="ep-btn ep-btn-locked" onclick="event.stopPropagation(); window.qbankEnterLicense('${safeId}', '${safeName}')"><i data-lucide="key-round"></i>Enter license</button>`
          : `<button type="button" class="ep-btn ep-btn-primary" onclick="event.stopPropagation(); window.startQBankSession('${safeId}', '${safeName}')">Practice <i data-lucide="arrow-right"></i></button>`;
      const click = locked
          ? `onclick="window.qbankEnterLicense('${safeId}', '${safeName}')"`
          : `onclick="window.startQBankSession('${safeId}', '${safeName}')"`;
      return `
      <article class="ep-bank-card${locked ? " is-locked" : ""}" ${click}>
          <div class="ep-bank-head">
              <span class="ep-bank-icon"><i data-lucide="${locked ? "lock" : "graduation-cap"}"></i></span>
              ${status}
          </div>
          <h3 class="ep-bank-name">${epEsc(q.name || "Exam prep bank")}</h3>
          <div class="ep-bank-college"><i data-lucide="school"></i><span>${epEsc(college)}</span></div>
          <div class="ep-bank-meta">${meta.join("")}</div>
          <div class="ep-bank-foot">${cta}</div>
      </article>`;
  };

  window.__epRenderHomeLegacy = function(focusCountry = null, focusCollege = null) {
      const listEl = document.getElementById("exam-prep-content");
      if (!listEl) return;
      const profile = window.__epProfile();
      const acc = (window.db && window.db.access) || null;
      const all = (window.__epBanks && window.__epBanks.length)
          ? window.__epBanks
          : cqPrepBanks().map(q => ({ ...q, locked: false }));
      const fCountry = focusCountry || profile.country;
      const fCollege = focusCollege || profile.college;
      window.__epState = { ...window.__epState, view: "home", focusCountry: fCountry, focusCollege: fCollege };
      const linkedToProfile = !!profile.academicCollege && fCollege === profile.academicCollege &&
          (!profile.academicCountry || !fCountry || fCountry === profile.academicCountry);
      const accessFallback = !fCollege && !!(acc && !acc.legacy && acc.collegeId && (acc.prepIds || []).length);
      const useAccessIds = (linkedToProfile || accessFallback) && acc && !acc.legacy;
      let banks = [];
      if (useAccessIds) {
          const allowed = new Set(acc.prepIds || []);
          banks = all.filter(q => allowed.has(q.id));
      } else if (fCollege) {
          banks = all.filter(q => (q.country || "global") === fCountry && (q.college || "General") === fCollege);
      } else if (acc && acc.legacy) {
          banks = all.slice();
      }
      banks.sort((a, b) => String(b.year || "").localeCompare(String(a.year || "")) || String(a.name || "").localeCompare(String(b.name || "")));

      const years = new Set(banks.map(b => b.year).filter(Boolean));
      const hasProfile = !!(profile.country || profile.college || profile.collegeId);
      const hasFocus = !!(fCountry && fCollege);
      const matchedToProfile = linkedToProfile || accessFallback;
      const label = !hasFocus ? "Academic profile" : (linkedToProfile ? "Your academic profile" : "Selected college");
      const title = hasFocus
          ? fCollege
          : accessFallback
              ? "Your college"
              : hasProfile
                  ? "Add your college"
                  : "Set up your academic profile";
      const showStats = hasFocus || hasProfile || banks.length > 0;
      const subParts = [];
      if (hasFocus) {
          subParts.push(profile.countryName || epCountryLabel(fCountry));
          if (linkedToProfile && profile.major) subParts.push(profile.major);
      } else if (accessFallback) {
          if (profile.countryName || profile.country) subParts.push(profile.countryName || epCountryLabel(profile.country));
          if (profile.major) subParts.push(profile.major);
          if (!subParts.length) subParts.push("Matched from your saved academic profile.");
      } else {
          subParts.push("Choose your country and college so we can show your past papers.");
      }

      let actions = "";
      if (!hasFocus) {
          const setupLabel = accessFallback ? "Choose college" : (hasProfile ? (profile.collegeId ? "Update profile" : "Add your college") : "Set up academic profile");
          const setupAction = accessFallback ? "window.cqOpenCollegePicker()" : "window.epSetupProfile()";
          actions = `<button type="button" class="ep-btn ep-btn-primary" onclick="${setupAction}">${setupLabel} <i data-lucide="arrow-right"></i></button>`;
      } else {
          if (!linkedToProfile && profile.college) {
              actions += `<button type="button" class="ep-btn ep-btn-ghost" onclick="window.epRenderHome()"><i data-lucide="arrow-left"></i>My profile</button>`;
          }
          actions += `<button type="button" class="ep-btn ep-btn-ghost" onclick="window.cqOpenCollegePicker('${epJs(fCountry)}')">Change college</button>`;
      }

      const flag = fCountry
          ? getEpFlagImg(fCountry, "ep-profile-flag-img")
          : `<i data-lucide="graduation-cap"></i>`;
      const sectionTitle = matchedToProfile ? "Your exam prep banks" : "Exam prep banks";
      const sectionSub = matchedToProfile
          ? "Every bank attached to your college and academic profile — no searching needed."
          : hasFocus
              ? `Past papers linked to ${epEsc(fCollege)}.`
              : banks.length
                  ? "All available exam-prep banks. Set up your academic profile to see only your college's past papers."
                  : hasProfile
                      ? "Add your college to your academic profile to see its past papers here."
                      : "Set up your academic profile to see your college's past papers here.";

      let empty = "";
      if (!banks.length) {
          const emptyTitle = matchedToProfile ? "No exam prep banks found" : hasFocus ? "No exam prep banks yet" : (hasProfile ? "Finish your academic profile" : "No academic profile yet");
          const emptyText = matchedToProfile
              ? "We couldn't find banks attached to your saved college. Try updating your academic profile or browse all colleges."
              : hasFocus
                  ? `There are no past papers linked to ${epEsc(fCollege)} yet. Check back soon or browse other colleges.`
                  : hasProfile
                      ? "Add your college to your academic profile and its past papers will appear here automatically."
                      : "Add your country, major and college from your academic profile and your college's past papers will appear here automatically.";
          const emptyCta = hasFocus ? "Browse colleges" : matchedToProfile ? "Update profile" : hasProfile ? "Complete profile" : "Set up profile";
          const emptyAction = hasFocus ? "window.epShowCountries()" : "window.epSetupProfile()";
          empty = `<div class="ep-empty">
              <span class="ep-empty-icon"><i data-lucide="${hasFocus ? "folder-open" : "graduation-cap"}"></i></span>
              <h3>${emptyTitle}</h3>
              <p>${emptyText}</p>
              <button type="button" class="ep-btn ep-btn-primary" onclick="${emptyAction}">${emptyCta} <i data-lucide="arrow-right"></i></button>
          </div>`;
      }

      const yearStat = years.size > 0
          ? `<div class="ep-profile-stat"><b>${years.size}</b><small>${years.size === 1 ? "exam year" : "exam years"}</small></div>`
          : "";
      const statsHtml = showStats
          ? `<div class="ep-profile-stats">
                  <div class="ep-profile-stat"><b>${banks.length}</b><small>${banks.length === 1 ? "bank" : "banks"}</small></div>
                  ${yearStat}
              </div>`
          : "";
      let noteTitle, noteText;
      if (matchedToProfile) {
          noteTitle = "Matched to your academic profile";
          noteText = "Your profile controls which exam-prep banks appear here. Use Browse all colleges to explore any bank outside your profile.";
      } else if (hasFocus) {
          noteTitle = hasProfile ? "Browsing another college" : "Set up your academic profile";
          noteText = hasProfile
              ? `You are viewing ${epEsc(fCollege)} instead of your saved profile. Open My exam prep to return to your matched banks.`
              : `You are browsing ${epEsc(fCollege)}. Add your country, major and college to your profile to get your matched banks on this page automatically.`;
      } else {
          noteTitle = hasProfile ? "Your profile is incomplete" : "Set up your academic profile";
          noteText = hasProfile
              ? "Your profile doesn't have a college attached yet, so all exam-prep banks are shown. Add your college to see only your past papers."
              : "Add your country, major and college from your profile and your college's past papers will appear here automatically.";
      }

      listEl.innerHTML = `
      <div class="ep-home">
          <section class="ep-profile">
              <span class="ep-profile-flag">${flag}</span>
              <div class="ep-profile-main">
                  <span class="ep-profile-kicker">${label}</span>
                  <h2>${epEsc(title)}</h2>
                  <p>${subParts.filter(Boolean).map(epEsc).join(" · ")}</p>
              </div>
              ${statsHtml}
              <div class="ep-profile-actions">${actions}</div>
          </section>

          <section class="ep-section">
              <div class="ep-section-head">
                  <div>
                      <h2>${sectionTitle}</h2>
                      <p>${sectionSub}</p>
                  </div>
                  <button type="button" class="ep-link" onclick="window.epShowCountries()">Browse all colleges <i data-lucide="arrow-up-right"></i></button>
              </div>
              ${banks.length
                  ? `<div class="ep-bank-grid">${banks.map(q => window.__epBankCard(q)).join("")}</div>`
                  : empty}
          </section>

          <section class="ep-note">
              <span class="ep-note-icon"><i data-lucide="info"></i></span>
              <div>
                  <b>${noteTitle}</b>
                  <span>${noteText}</span>
              </div>
          </section>
      </div>`;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.epRenderHome = function() {
      const listEl = document.getElementById("exam-prep-content");
      if (!listEl) return;
      const acc = (window.db && window.db.access) || null;
      const allowed = new Set([
          ...((acc && Array.isArray(acc.prepIds)) ? acc.prepIds : []),
          ...((acc && Array.isArray(acc.grants)) ? acc.grants : []),
      ]);
      const all = (window.__epBanks && window.__epBanks.length)
          ? window.__epBanks
          : cqPrepBanks().map(q => ({ ...q }));
      const banks = all
          .filter(q => q && q.id)
          .map(q => ({ ...q, locked: acc ? !allowed.has(q.id) : false }))
          .sort((a, b) => String(b.year || "").localeCompare(String(a.year || "")) || String(a.name || "").localeCompare(String(b.name || "")));
      const paidCount = banks.filter(q => q.accessTier === "paid").length;
      const lockedCount = banks.filter(q => q.locked).length;
      const stats = `<div class="ep-profile-stats">
          <div class="ep-profile-stat"><b>${banks.length}</b><small>${banks.length === 1 ? "bank" : "banks"}</small></div>
          ${paidCount ? `<div class="ep-profile-stat"><b>${lockedCount}</b><small>locked</small></div>` : ""}
      </div>`;
      const empty = `<div class="ep-empty">
          <span class="ep-empty-icon"><i data-lucide="folder-open"></i></span>
          <h3>No exam prep banks yet</h3>
          <p>Exam prep banks will appear here as soon as they are published.</p>
      </div>`;
      listEl.innerHTML = `
      <div class="ep-home">
          <section class="ep-profile">
              <span class="ep-profile-flag"><i data-lucide="graduation-cap"></i></span>
              <div class="ep-profile-main">
                  <span class="ep-profile-kicker">QBank access</span>
                  <h2>Exam Prep</h2>
                  <p>Free banks open instantly. Paid banks unlock with a license or an admin assignment.</p>
              </div>
              ${stats}
              <div class="ep-profile-actions">
                  <button type="button" class="ep-btn ep-btn-primary" onclick="window.qbankEnterLicense()"><i data-lucide="key-round"></i> Enter license</button>
              </div>
          </section>
          <section class="ep-section">
              <div class="ep-section-head">
                  <div>
                      <h2>Exam prep banks</h2>
                      <p>${lockedCount ? `${lockedCount} paid ${lockedCount === 1 ? "bank needs" : "banks need"} a license.` : "All available banks are ready to practice."}</p>
                  </div>
              </div>
              ${banks.length
                  ? `<div class="ep-bank-grid">${banks.map(q => window.__epBankCard(q)).join("")}</div>`
                  : empty}
          </section>
      </div>`;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.epShowCountries = function() {
      const listEl = document.getElementById("exam-prep-content");
      if (!listEl || !window.__epBanks) return;
      window.__epState = { ...window.__epState, view: "countries", country: null, college: null };

      const counts = {};
      const collegesByCountry = {};
      window.__epBanks.forEach(q => {
          const c = q.country || "global";
          counts[c] = (counts[c] || 0) + 1;
          if (!collegesByCountry[c]) collegesByCountry[c] = new Set();
          collegesByCountry[c].add(q.college || "General");
      });

      let out = `<div class="ep-subpage">
          <div class="ep-subhead">
              <div>
                  <button type="button" class="ep-back" onclick="window.epRenderHome()"><i data-lucide="arrow-left"></i> My exam prep</button>
                  <h2>Browse exam prep</h2>
                  <p>Choose a country, then a college, to open its past papers.</p>
              </div>
          </div>`;

      if (Object.keys(counts).length === 0) {
          out += `<div class="ep-empty">
              <span class="ep-empty-icon"><i data-lucide="graduation-cap"></i></span>
              <h3>No exam prep banks yet</h3>
              <p>Past papers will appear here as soon as colleges add their exam-prep banks.</p>
          </div>`;
      } else {
          out += `<div class="ep-country-grid">`;
          Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b)).forEach(c => {
              const collegeCount = collegesByCountry[c].size;
              out += `<button type="button" class="ep-country-card" onclick="window.epShowColleges('${epJs(c)}')">
                  <span class="ep-country-flag">${getEpFlagImg(c, "ep-flag-img")}</span>
                  <span class="ep-country-text">
                      <b>${epEsc(epCountryLabel(c))}</b>
                      <small>${collegeCount} ${collegeCount === 1 ? "college" : "colleges"} · ${counts[c]} ${counts[c] === 1 ? "bank" : "banks"}</small>
                  </span>
                  <i data-lucide="chevron-right" class="ep-country-chev"></i>
              </button>`;
          });
          out += `</div>`;
      }
      out += `</div>`;
      listEl.innerHTML = out;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.epShowColleges = function(country) {
      const listEl = document.getElementById("exam-prep-content");
      if (!listEl || !window.__epBanks) return;
      window.__epState = { ...window.__epState, view: "colleges", country, college: null };

      const banks = window.__epBanks.filter(q => (q.country || "global") === country);
      const byCollege = {};
      banks.forEach(q => {
          const col = q.college || "General";
          if (!byCollege[col]) byCollege[col] = [];
          byCollege[col].push(q);
      });
      const cols = Object.keys(byCollege).sort((a, b) => a.localeCompare(b));
      if (cols.length === 1) {
          window.epShowBanks(country, cols[0]);
          return;
      }

      let out = `<div class="ep-subpage">
          <div class="ep-subhead">
              <div>
                  <button type="button" class="ep-back" onclick="window.epShowCountries()"><i data-lucide="arrow-left"></i> All countries</button>
                  <div class="ep-title-row">
                      <span class="ep-title-flag">${getEpFlagImg(country, "ep-flag-img")}</span>
                      <div>
                          <h2>${epEsc(epCountryLabel(country))}</h2>
                          <p>${cols.length} ${cols.length === 1 ? "college" : "colleges"} with past papers</p>
                      </div>
                  </div>
              </div>
              <button type="button" class="ep-btn ep-btn-ghost" onclick="window.epRenderHome()"><i data-lucide="home"></i> My exam prep</button>
          </div>`;

      if (!cols.length) {
          out += `<div class="ep-empty">
              <span class="ep-empty-icon"><i data-lucide="school"></i></span>
              <h3>No colleges yet</h3>
              <p>No exam-prep colleges have been added for ${epEsc(epCountryLabel(country))} yet.</p>
          </div>`;
      } else {
          out += `<div class="ep-college-list">`;
          cols.forEach(col => {
              const n = byCollege[col].length;
              out += `<button type="button" class="ep-college-card" onclick="window.epShowBanks('${epJs(country)}', '${epJs(col)}')">
                  <span class="ep-college-icon"><i data-lucide="school"></i></span>
                  <span class="ep-college-text"><b>${epEsc(col)}</b><small>${n} ${n === 1 ? "bank" : "banks"} · ${epEsc(epCountryLabel(country))}</small></span>
                  <span class="ep-college-open">View banks <i data-lucide="arrow-right"></i></span>
              </button>`;
          });
          out += `</div>`;
      }
      out += `</div>`;
      listEl.innerHTML = out;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.epShowBanks = function(country, college) {
      const listEl = document.getElementById("exam-prep-content");
      if (!listEl || !window.__epBanks) return;
      window.__epState = { ...window.__epState, view: "banks", country, college };
      window.cqSetSavedCollege(country, college);

      const banks = window.__epBanks.filter(q =>
          (q.country || "global") === country &&
          (q.college || "General") === college
      );
      banks.sort((a, b) => String(b.year || "").localeCompare(String(a.year || "")) || String(a.name || "").localeCompare(String(b.name || "")));

      const profile = window.__epProfile();
      const linked = !!profile.academicCollege && profile.academicCollege === college &&
          (!profile.academicCountry || profile.academicCountry === country);
      const countryColleges = new Set(window.__epBanks
          .filter(q => (q.country || "global") === country)
          .map(q => q.college || "General"));
      const backToCountries = countryColleges.size <= 1;
      const backAction = backToCountries ? "window.epShowCountries()" : `window.epShowColleges('${epJs(country)}')`;
      const backLabel = backToCountries ? "All countries" : `${epEsc(epCountryLabel(country))} colleges`;

      let out = `<div class="ep-subpage">
          <div class="ep-subhead">
              <div>
                  <button type="button" class="ep-back" onclick="${backAction}"><i data-lucide="arrow-left"></i> ${backLabel}</button>
                  <div class="ep-title-row">
                      <span class="ep-title-flag">${getEpFlagImg(country, "ep-flag-img")}</span>
                      <div>
                          <h2>${epEsc(college)}</h2>
                          <p>${banks.length} ${banks.length === 1 ? "past paper bank" : "past paper banks"} · ${linked ? "Matched to your academic profile" : "From the exam prep catalogue"}</p>
                      </div>
                  </div>
              </div>
              <button type="button" class="ep-btn ep-btn-ghost" onclick="window.epRenderHome()"><i data-lucide="home"></i> My exam prep</button>
          </div>`;

      if (banks.length === 0) {
          out += `<div class="ep-empty">
              <span class="ep-empty-icon"><i data-lucide="folder-open"></i></span>
              <h3>No banks in this college yet</h3>
              <p>Past papers for ${epEsc(college)} will appear here as soon as they are added.</p>
              <button type="button" class="ep-btn ep-btn-primary" onclick="window.epShowCountries()">Browse colleges <i data-lucide="arrow-right"></i></button>
          </div>`;
      } else {
          out += `<div class="ep-bank-grid">${banks.map(q => window.__epBankCard(q)).join("")}</div>`;
      }
      out += `</div>`;
      listEl.innerHTML = out;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };



  window.epSetupProfile = function() {
      try {
          if (window.firebase && firebase.auth().currentUser && typeof window.showWelcomeOnboarding === "function") {
              return window.showWelcomeOnboarding();
          }
      } catch (_) {}
      if (typeof window.cqOpenCollegePicker === "function") return window.cqOpenCollegePicker();
  };

  window.__epRefresh = function() {
      const s = window.__epState || {};
      if (s.view === "countries") return window.epShowCountries();
      if (s.view === "colleges" && s.country) return window.epShowColleges(s.country);
      if (s.view === "banks" && s.country && s.college) return window.epShowBanks(s.country, s.college);
      return window.epRenderHome(s.focusCountry || null, s.focusCollege || null);
  };

  window.openExamPrepForCollege = async function(country, college) {
      if (!country || !college) return window.openExamPrepTab();
      return window.openExamPrepTab(country, college);
  };

  window.openExamPrepTab = async function(country = null, college = null) {
      if (window.hideAllMainViews) window.hideAllMainViews();
      const view = document.getElementById('resources-view');
      if (view) {
          view.style.display = 'flex';
          view.style.flexDirection = 'column';
      }

      if (window.setQBankNav) window.setQBankNav('exam-prep');

      if (view) view.innerHTML = `<div class="ep-page">
          <div class="ep-shell">
              <header class="ep-hero">
                  <div class="ep-hero-main">
                      <span class="ep-kicker">QBank access</span>
                      <h1>Exam Prep</h1>
                      <p>Free and licensed exam-prep banks in one place.</p>
                  </div>
                  <button type="button" class="ep-btn ep-btn-ghost" onclick="window.qbankEnterLicense && window.qbankEnterLicense()"><i data-lucide="key-round"></i> Enter license</button>
              </header>
              <div id="exam-prep-content">
                  <div class="ep-loading" aria-label="Loading exam prep">
                      <div class="ep-skeleton ep-skeleton-profile"></div>
                      <div class="ep-skeleton-row"><div class="ep-skeleton"></div><div class="ep-skeleton"></div></div>
                  </div>
              </div>
          </div>
      </div>`;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

      try {
          await window.preloadQBank();
          qbanks = cachedCategories || [];
      } catch (e) { console.error("preload failed:", e); }

      try { await window.bootstrapAccess(true); } catch (_) {}
      const acc = window.db.access || null;
      const accGrants = Array.isArray(acc && acc.grants) ? acc.grants : [];
      const accPrep = Array.isArray(acc && acc.prepIds) ? acc.prepIds : [];
      const prepAllowed = (id) => !acc || accGrants.includes(id) || accPrep.includes(id);
      window.__epBanks = (qbanks || []).filter(q => q.kind === "exam_prep").map(q => ({
        ...q,
        locked: !prepAllowed(q.id),
      }));
      if (country && college) {
        window.cqSetSavedCollege(country, college);
        window.epRenderHome(country, college);
      } else if (country) {
        window.epShowColleges(country);
      } else {
        window.epRenderHome();
      }

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

  // ---- Block-only practice entry points ----
  // The legacy browser remains available for taxonomy browsing, but every
  // action that would start answering questions now opens the block builder
  // with the same subject/chapter/topic filters preselected.
  window.qbankOpenBlockBuilder = function(opts = {}) {
    return qblockOpenBuilderScreen(opts || {});
  };

  window.qbankOpenBlockHistory = function() {
    return qblockOpenBuilderScreen({ tab: "history" });
  };

  window.qbankOpenExamPrepBlockBuilder = function() {
    return qblockOpenBuilderScreen({ pickExamPrep: true });
  };

  const qblockLegacyStartFiltered = window.startQBankFiltered;
  window.startQBankFiltered = async function(subject, chapter = null, reviewIncorrectsOnly = false, topicPath = null, tag = null) {
    // Answer Party is a separate live mode; keep its original path intact.
    if (window.pendingPartyCreation) {
      return qblockLegacyStartFiltered.apply(this, arguments);
    }
    const bankId = currentQBankId || (window.db && window.db.selectedQBankId);
    if (!bankId) return window.openQBank();
    return qblockOpenBuilderScreen({
      bankId,
      subject,
      chapter,
      reviewIncorrectsOnly,
      topicPath,
      tag,
      modes: reviewIncorrectsOnly ? ["incorrect", "marked"] : undefined,
    });
  };

  window.qbankResumeSession = async function(qbankId, qbankName, subject, topicPath = null, tag = null) {
    const bankId = qbankId || currentQBankId || (window.db && window.db.selectedQBankId);
    if (!bankId) return window.openQBank();
    return qblockOpenBuilderScreen({ bankId, subject, topicPath, tag });
  };

  window.qbankContinueLast = function() {
    const lastBlock = qblockLatestInProgress();
    if (lastBlock) return qblockOpenSavedBlock(lastBlock, "resume");
    const last = getLastSession();
    if (!last || !last.qbankId) return window.qbankOpenBlockBuilder();
    return window.qbankResumeSession(last.qbankId, last.qbankName, last.subject, last.topicPath, last.tag);
  };

  window.qbankContinueMarked = async function() {
    let bankId = currentQBankId || (window.db && window.db.selectedQBankId);
    if (!bankId) {
      const cachedIds = Object.keys(cachedQBanks || {});
      bankId = cachedIds[0] || "";
    }
    if (!bankId) return window.qbankOpenBlockBuilder({ modes: ["marked"] });
    return qblockOpenBuilderScreen({ bankId, modes: ["marked"] });
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
      head.innerHTML = `<span>Admin DB Diagnostics</span><span id="adw-toggle">â–²</span>`;
      head.onclick = () => {
        const body = document.getElementById('adw-body');
        const isHidden = body.style.display === 'none';
        body.style.display = isHidden ? 'block' : 'none';
        document.getElementById('adw-toggle').textContent = isHidden ? 'â–¼' : 'â–²';
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
      ${diagnosticData.untracked > 0 ? `<div style="color:#f59e0b;" title="${diagnosticData.untracked} API call(s) without Firestore headers — backend route not instrumented">âš  untracked: <b>${diagnosticData.untracked}</b></div>` : ""}
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


