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
  let syncQueue = [];
  let isSyncing = false;

  // --- IndexedDB Caching ---
  const DB_NAME = "OmnoteQBankCache";
  const STORE_NAME = "qbanks";
  const DB_VERSION = 1;

  function openQBankDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
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

  async function flushSyncQueue() {
    if (syncQueue.length === 0 || isSyncing) return;
    isSyncing = true;
    try {
      const updates = [...syncQueue];
      syncQueue = []; // clear queue
      await apiPost("batch_sync_progress", { updates });
    } catch (e) {
      console.error("Failed to sync QBank progress:", e);
      // Optional: push back failed updates to syncQueue
    } finally {
      isSyncing = false;
    }
  }
  
  setInterval(flushSyncQueue, 5000);

  async function apiGet(action, params = {}) {
    const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
    if (!token) throw new Error("Not signed in");
    const qs = new URLSearchParams({ action, ...params }).toString();
    const res = await fetch(`/api/qbank?${qs}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "API error");
    return data;
  }

  async function apiPost(action, body) {
    const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
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
          const res = await apiGet("list_categories");
          cachedCategories = res.qbanks || [];
          
          const promises = cachedCategories.map(async q => {
             if (!cachedQBanks[q.id]) {
               try {
                 const idbData = await getCachedQBank(q.id);
                 // Only load from IDB if it's fresh. Do NOT fetch from API for all banks here, 
                 // because downloading tens of thousands of questions will freeze the app.
                 if (idbData && idbData.updatedAt === q.updatedAt && idbData.questions && idbData.questions.length > 0) {
                   try {
                     // We can fetch just the progress since it's small, to keep stats up to date
                     const res = await apiGet("get_questions", { qbankId: q.id, onlyProgress: true });
                     cachedQBanks[q.id] = { questions: idbData.questions, progress: res.progress || {} };
                   } catch(e) {
                     console.error("Prefetch progress failed for", q.id, e);
                   }
                 }
               } catch(e) {
                 console.error("IDB prefetch error", e);
               }
             }
          });
          await Promise.all(promises);
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

  // --- QBank Selection ---
  window.selectQBank = function(qbankId) {
      if (!window.db) window.db = {};
      window.db.selectedQBankId = qbankId;
      if (typeof window.saveDb === "function") window.saveDb();
      window.openQBank();
  };

  window.openQBankSelection = async function() {
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";

    area.innerHTML = `
      <div class="flex justify-center items-center h-64">
        <div class="w-48 h-1 bg-surface-container rounded-full overflow-hidden relative">
            <div class="absolute top-0 left-0 h-full w-full bg-primary rounded-full animate-[loading-bar-indeterminate_1.5s_infinite_ease-in-out] origin-left"></div>
        </div>
      </div>
    `;

    try {
      await window.preloadQBank();
      qbanks = cachedCategories || [];
      
      if (qbanks.length === 0) {
        area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">No QBanks available yet. Admins can create them in the Admin Panel.</div>';
        return;
      }
      
      let html = `<div style="max-width:1000px; margin:0 auto; padding:40px 20px;">
        <div style="display:flex; align-items:center; margin-bottom:30px;">
          <div>
            <h2 style="margin:0; font-size:1.5rem; font-weight:700;">Select Your Question Bank</h2>
            <p style="margin:4px 0 0 0; font-size:0.9rem; color:var(--text-muted);">Choose the bank you want to practice. You can change this at any time from your dashboard.</p>
          </div>
        </div>
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:24px;">`;
      
      const isAdmin = window.checkAdmin ? await window.checkAdmin() : false;
      const flagMap = { usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg" };
      for (const q of qbanks) {
        const isLockedForUser = q.isLocked;
        const countryCode = flagMap[q.country];
        const flagHtml = countryCode 
           ? `<img src="https://flagcdn.com/w80/${countryCode}.png" alt="${countryCode}" style="width:64px; height:auto; border-radius:4px; margin-bottom:20px; box-shadow:0 4px 12px rgba(0,0,0,0.15);">`
           : `<div style="font-size:4rem; margin-bottom:20px; filter: drop-shadow(0 4px 12px rgba(0,0,0,0.15)); line-height:1;">🌍</div>`;
           
        // Show question count if cached
        const cached = cachedQBanks[q.id];
        const qCount = cached ? (cached.questions || []).length : 0;
        const countLabel = qCount > 0 ? `<div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:12px;">${qCount.toLocaleString()} questions</div>` : '';
           
        const clickAttr = isLockedForUser ? "" : `onclick="window.selectQBank('${q.id}')"`;
        const cursorStyle = isLockedForUser ? "cursor:not-allowed; opacity:0.6;" : "cursor:pointer;";
        const hoverEffects = isLockedForUser ? "" : `onmouseover="this.style.transform='translateY(-8px)'; this.style.borderColor='var(--accent-cyan)'; this.style.boxShadow='0 20px 40px rgba(0,0,0,0.3), 0 0 20px rgba(6, 182, 212, 0.2)';" onmouseout="this.style.transform='translateY(0)'; this.style.borderColor='rgba(255,255,255,0.08)'; this.style.boxShadow='0 8px 32px rgba(0,0,0,0.2)';"`;
        
        const actionLabel = isLockedForUser ? 
          `<span style="color:var(--danger);"><i data-lucide="lock" style="width:16px;height:16px;margin-right:4px;vertical-align:-3px;"></i> Under Maintenance</span>` : 
          `<span>Select Bank</span><i data-lucide="arrow-right" style="width:18px;height:18px;"></i>`;

        html += `
          <div class="qbank-exam-card" style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:20px; padding:32px 24px; transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1); display:flex; flex-direction:column; align-items:center; text-align:center; position:relative; overflow:hidden; box-shadow:0 8px 32px rgba(0,0,0,0.2); ${cursorStyle}" ${clickAttr} ${hoverEffects}>
             ${flagHtml}
             <h3 style="font-size:1.4rem; font-weight:700; margin-bottom:8px; color:var(--text-primary); letter-spacing:0.2px;">${window.escapeHtml ? window.escapeHtml(q.name) : q.name}</h3>
             ${countLabel}
             <div style="color:var(--accent-cyan); font-size:0.95rem; font-weight:600; display:flex; align-items:center; gap:8px; margin-top:auto; padding-top:15px; text-transform:uppercase; letter-spacing:1px;">
               ${actionLabel}
             </div>
          </div>`;
      }
      
      html += `</div></div>`;
      area.innerHTML = html;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    } catch (e) {
      area.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);">Failed to load QBanks: ${e.message}</div>`;
    }
  };

  // --- QBank Home Dashboard ---
  window.openQBank = async function () {
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    
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
    document.querySelectorAll('nav a').forEach(a => {
        a.classList.remove('bg-secondary-container', 'text-on-secondary-container');
        a.classList.add('text-on-surface-variant');
    });
    const homeTab = document.querySelector('nav a[data-path="home"]');
    if (homeTab) {
        homeTab.classList.remove('text-on-surface-variant');
        homeTab.classList.add('bg-secondary-container', 'text-on-secondary-container');
    }

    area.innerHTML = `
      <div class="flex flex-col justify-center items-center h-64 gap-4">
        <div class="w-48 h-1 bg-surface-container rounded-full overflow-hidden relative">
            <div class="absolute top-0 left-0 h-full w-full bg-primary rounded-full animate-[loading-bar-indeterminate_1.5s_infinite_ease-in-out] origin-left"></div>
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
        window.openQBankSelection();
        return;
      }
      const activeQBankId = window.db.selectedQBankId;

      await window.preloadQBank();
      qbanks = cachedCategories || [];
      
      if (qbanks.length === 0) {
        area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">No QBanks available yet. Admins can create them in the Admin Panel.</div>';
        return;
      }

      const activeQBankMeta = qbanks.find(qb => qb.id === activeQBankId) || qbanks[0];
      if (activeQBankMeta && activeQBankMeta.isLocked) {
        // If they somehow had this saved and it's now locked, force them to the selection screen
        localStorage.removeItem("activeQBank");
        return window.openQBankSelection();
      }
      
      const activeQBankName = activeQBankMeta ? activeQBankMeta.name : "Your QBank";
      
      let totalQuestions = 0;
      let totalAnswered = 0;
      let totalCorrect = 0;
      let totalMarked = 0;
      let subjectStats = {};
      
      const qData = cachedQBanks[activeQBankId];
      if (qData) {
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

      let continueSessionHtml = '';
      if (lastSession && lastSession.qbankId) {
        const lastBankName = lastSession.qbankName || "QBank";
        const lastSubject = lastSession.subject || "All Subjects";
        continueSessionHtml = `
          <h3 class="font-title-md text-[20px] mb-2 font-bold">Continue Session</h3>
          <p class="font-body-md opacity-90 mb-6">Resume your session on ${window.escapeHtml ? window.escapeHtml(lastBankName) : lastBankName}.</p>
        `;
      } else {
        continueSessionHtml = `
          <h3 class="font-title-md text-[20px] mb-2 font-bold">Start Session</h3>
          <p class="font-body-md opacity-90 mb-6">Start a new practice block to test your knowledge.</p>
        `;
      }

      let reviewIncorrectsText = totalMarked > 0 
        ? `${totalMarked.toLocaleString()} questions marked for review.` 
        : `No questions marked for review yet.`;
      
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
             ${countLabel}
             <div style="color:var(--accent-cyan); font-size:0.95rem; font-weight:600; display:flex; align-items:center; gap:8px; margin-top:auto; padding-top:15px; text-transform:uppercase; letter-spacing:1px;">
               ${actionLabel}
             </div>
          </div>`;
      }
      
      html += `</div></div>`;
      area.innerHTML = html;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    } catch (e) {
      area.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);">Failed to load QBanks: ${e.message}</div>`;
    }
  };

  // --- QBank Home Dashboard ---
  window.openQBank = async function () {
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    
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
    document.querySelectorAll('nav a').forEach(a => {
        a.classList.remove('bg-secondary-container', 'text-on-secondary-container');
        a.classList.add('text-on-surface-variant');
    });
    const homeTab = document.querySelector('nav a[data-path="home"]');
    if (homeTab) {
        homeTab.classList.remove('text-on-surface-variant');
        homeTab.classList.add('bg-secondary-container', 'text-on-secondary-container');
    }

    area.innerHTML = `
      <div class="flex flex-col justify-center items-center h-64 gap-4">
        <div class="w-48 h-1 bg-surface-container rounded-full overflow-hidden relative">
            <div class="absolute top-0 left-0 h-full w-full bg-primary rounded-full animate-[loading-bar-indeterminate_1.5s_infinite_ease-in-out] origin-left"></div>
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
        window.openQBankSelection();
        return;
      }
      const activeQBankId = window.db.selectedQBankId;

      await window.preloadQBank();
      qbanks = cachedCategories || [];
      
      if (qbanks.length === 0) {
        area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">No QBanks available yet. Admins can create them in the Admin Panel.</div>';
        return;
      }

      const activeQBankMeta = qbanks.find(qb => qb.id === activeQBankId) || qbanks[0];
      if (activeQBankMeta && activeQBankMeta.isLocked) {
        // If they somehow had this saved and it's now locked, force them to the selection screen
        localStorage.removeItem("activeQBank");
        return window.openQBankSelection();
      }
      
      const activeQBankName = activeQBankMeta ? activeQBankMeta.name : "Your QBank";
      
      let totalQuestions = 0;
      let totalAnswered = 0;
      let totalCorrect = 0;
      let totalMarked = 0;
      let subjectStats = {};
      
      const qData = cachedQBanks[activeQBankId];
      if (qData) {
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

      let continueSessionHtml = '';
      if (lastSession && lastSession.qbankId) {
        const lastBankName = lastSession.qbankName || "QBank";
        const lastSubject = lastSession.subject || "All Subjects";
        continueSessionHtml = `
          <h3 class="font-title-md text-[20px] mb-2 font-bold">Continue Session</h3>
          <p class="font-body-md opacity-90 mb-6">Resume your session on ${window.escapeHtml ? window.escapeHtml(lastBankName) : lastBankName}.</p>
        `;
      } else {
        continueSessionHtml = `
          <h3 class="font-title-md text-[20px] mb-2 font-bold">Start Session</h3>
          <p class="font-body-md opacity-90 mb-6">Start a new practice block to test your knowledge.</p>
        `;
      }

      let reviewIncorrectsText = totalMarked > 0 
        ? `${totalMarked.toLocaleString()} questions marked for review.` 
        : `No questions marked for review yet.`;
      
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
        // Normalize the array to handle both flat resources (old schema) and nested categories (new schema)
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
            normalizedResources.push({ isCategory: true, title: "General Resources", items: uncategorized });
        }
        
        let catsHtml = normalizedResources.map((cat, catIdx) => {
            if (!cat.items || cat.items.length === 0) return '';
            
            let itemsHtml = cat.items.map(r => {
                let icon = 'link';
                let color = 'text-primary';
                let actionAttr = `href="${window.escapeHtml ? window.escapeHtml(r.url) : r.url}" target="_blank"`;
                
                if (r.type === 'youtube') { 
                    icon = 'play_circle'; 
                    color = 'text-[#ef4444]'; 
                    actionAttr = `href="javascript:void(0)" onclick="window.openYouTubeModal('${window.escapeHtml ? window.escapeHtml(r.url) : r.url}')"`;
                }
                if (r.type === 'pdf') { icon = 'picture_as_pdf'; color = 'text-[#3b82f6]'; }
                if (r.type === 'flashcards') { icon = 'style'; color = 'text-[#eab308]'; }
                
                return `
                <a ${actionAttr} class="flex items-center gap-3 p-4 rounded-xl bg-surface-container hover:bg-surface-container-high transition-colors group border border-transparent hover:border-outline-variant/30">
                  <div class="w-10 h-10 rounded-full bg-surface-container-highest flex items-center justify-center flex-shrink-0 group-hover:scale-105 transition-transform">
                    <span class="material-symbols-outlined ${color}">${icon}</span>
                  </div>
                  <div class="flex-1 min-w-0">
                    <h4 class="font-title-sm text-sm text-on-surface truncate font-medium">${window.escapeHtml ? window.escapeHtml(r.title) : r.title}</h4>
                    ${r.description ? `<p class="font-label-sm text-[11px] text-on-surface-variant truncate opacity-80 mt-0.5">${window.escapeHtml ? window.escapeHtml(r.description) : r.description}</p>` : `<p class="font-label-sm text-[11px] text-on-surface-variant truncate opacity-70">${r.type.toUpperCase()}</p>`}
                  </div>
                  <span class="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity">${r.type === 'youtube' ? 'play_arrow' : 'open_in_new'}</span>
                </a>`;
            }).join('');
            
            return `
            <div class="mb-6 last:mb-0">
                <h3 class="font-title-md text-on-surface mb-3 flex items-center gap-2"><span class="material-symbols-outlined text-on-surface-variant text-[18px]">folder_open</span> ${window.escapeHtml ? window.escapeHtml(cat.title) : cat.title}</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    ${itemsHtml}
                </div>
            </div>
            `;
        }).join('');
        
        if (catsHtml.trim().length > 0) {
            resourcesHtml = `
            <div id="qbank-resources-widget" class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm border border-outline-variant/30 mt-gutter">
              <div class="flex items-center gap-3 mb-6 border-b border-outline-variant/20 pb-4">
                <span class="material-symbols-outlined text-primary text-[28px]" style="font-variation-settings: 'FILL' 1;">video_library</span>
                <div>
                    <h2 class="font-headline-lg text-[22px] text-on-surface">Study Resources & Playlists</h2>
                    <p class="text-sm text-on-surface-variant mt-1">Curated materials to help you master this QBank.</p>
                </div>
              </div>
              <div>
                ${catsHtml}
              </div>
            </div>
            `;
        }
      }

      let safeBankName = activeQBankName.replace(/'/g, "\\'");
      let html = `<div class="p-gutter w-full"><div class="flex flex-col w-full gap-stack-lg animate-[fade-in_0.5s_ease-out]">
<section class="relative w-full rounded-2xl bg-surface-container-high overflow-hidden shadow-sm">
<div class="absolute inset-0 bg-cover bg-center opacity-10 mix-blend-multiply" style="background-image: url('https://lh3.googleusercontent.com/aida-public/AB6AXuBxdoS0_KQ64qJpevsMKnar3LCnoHZuMS8hXkAYf_xhnb92yzLJGmVzxcUZHVPowBNc3UrmgwbSH8BgIgGZQ3FA-NWmYP_65Cs_PRAPUUyhDVsgCicejHGWZidCEGPBpLdA5hYHqnCFJkXQ7QORnKipCfMXmaYGaB4uCjuF6nMDKM5oe2C7O4yh-Q--r8yvtRdledsDpereeKwxTBwEAPQmvU1G1bVyRP7iC4dAP0dMkMGliefCiXOQ3Qxv37tScI4NB_U')"></div>
<div class="absolute inset-0 bg-gradient-to-r from-surface-container-high via-surface-container-high/80 to-transparent"></div>
<div class="relative p-8 md:p-12 max-w-2xl flex justify-between items-center w-full">
<div>
<p class="font-label-caps text-label-caps text-primary tracking-[0.1em] mb-4 flex items-center">
  CLINICAL INTELLIGENCE
  <button class="ml-4 px-2.5 py-1 bg-primary/10 hover:bg-primary/20 text-primary rounded-full text-[10px] font-bold uppercase transition-colors" onclick="window.openQBankSelection()">
    Change QBank
  </button>
</p>
<h1 class="font-headline-xl text-headline-xl text-on-surface mb-2">${window.escapeHtml ? window.escapeHtml(activeQBankName) : activeQBankName} Dashboard</h1>
<p class="font-body-lg text-body-lg text-on-surface-variant max-w-md">Track your mastery, resume active sessions, and explore targeted medical question banks to refine your diagnostic accuracy.</p>
</div>
<div class="hidden md:flex flex-col items-center bg-surface-container-lowest/50 backdrop-blur-md p-6 rounded-2xl border border-surface-container-highest">
<span class="font-label-caps text-label-caps text-on-surface-variant mb-2">GLOBAL PERCENTILE</span>
<div class="text-4xl font-headline-xl text-primary font-bold">82<span class="text-xl">nd</span></div>
<div class="flex items-center gap-1 text-sm mt-1 text-primary-container">
<span class="material-symbols-outlined text-[16px]">arrow_upward</span> Top 18%
</div>
</div>
</div>
</section>
<section class="grid grid-cols-2 md:grid-cols-5 gap-gutter">
<div class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm hover:-translate-y-1 transition-transform duration-300 group">
<div class="flex items-center gap-3 mb-4">
<div class="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center group-hover:bg-primary-container transition-colors">
<span class="material-symbols-outlined text-on-surface-variant group-hover:text-on-primary-container">format_list_numbered</span>
</div>
<p class="font-label-sm text-label-sm text-on-surface-variant">Total Questions</p>
</div>
<p class="font-headline-xl text-headline-xl text-on-surface">${totalQuestions.toLocaleString()}</p>
</div>
<div class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm hover:-translate-y-1 transition-transform duration-300 group">
<div class="flex items-center gap-3 mb-4">
<div class="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center group-hover:bg-primary-container transition-colors">
<span class="material-symbols-outlined text-on-surface-variant group-hover:text-on-primary-container">done_all</span>
</div>
<p class="font-label-sm text-label-sm text-on-surface-variant">Answered</p>
</div>
<p class="font-headline-xl text-headline-xl text-on-surface">${totalAnswered.toLocaleString()}</p>
<div class="mt-2 h-1.5 w-full bg-surface-container-highest rounded-full overflow-hidden">
<div class="h-full bg-primary w-[37%] rounded-full"></div>
</div>
</div>
<div class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm hover:-translate-y-1 transition-transform duration-300 group">
<div class="flex items-center gap-3 mb-4">
<div class="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center group-hover:bg-primary-container transition-colors">
<span class="material-symbols-outlined text-on-surface-variant group-hover:text-on-primary-container">show_chart</span>
</div>
<p class="font-label-sm text-label-sm text-on-surface-variant">Avg Score (%)</p>
</div>
<p class="font-headline-xl text-headline-xl text-primary">${globalScore}%</p>
<p class="text-xs text-on-surface-variant mt-2 flex items-center gap-1"><span class="material-symbols-outlined text-[14px] text-primary">trending_up</span> +2.4% this week</p>
</div>
<div class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm hover:-translate-y-1 transition-transform duration-300 group">
<div class="flex items-center gap-3 mb-4">
<div class="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center group-hover:bg-error-container transition-colors">
<span class="material-symbols-outlined text-on-surface-variant group-hover:text-on-error-container">bookmark</span>
</div>
<p class="font-label-sm text-label-sm text-on-surface-variant">Marked for Review</p>
</div>
<p class="font-headline-xl text-headline-xl text-on-surface">${totalMarked.toLocaleString()}</p>
</div>
<div class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm hover:-translate-y-1 transition-transform duration-300 group col-span-2 md:col-span-1">
<div class="flex items-center gap-3 mb-4">
<div class="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center group-hover:bg-secondary-container transition-colors">
<span class="material-symbols-outlined text-on-surface-variant group-hover:text-on-secondary-container">local_fire_department</span>
</div>
<p class="font-label-sm text-label-sm text-on-surface-variant">Day Streak</p>
</div>
<p class="font-headline-xl text-headline-xl text-on-surface">12</p>
<div class="flex gap-1 mt-2">
<div class="h-2 w-full rounded-full bg-primary"></div>
<div class="h-2 w-full rounded-full bg-primary"></div>
<div class="h-2 w-full rounded-full bg-primary"></div>
<div class="h-2 w-full rounded-full bg-primary"></div>
<div class="h-2 w-full rounded-full bg-surface-container"></div>
</div>
</div>
</section>
<div class="grid grid-cols-1 lg:grid-cols-3 gap-gutter">
<div class="lg:col-span-2 flex flex-col gap-gutter">
<div class="grid grid-cols-1 md:grid-cols-3 gap-gutter">
<button class="relative overflow-hidden bg-primary text-on-primary rounded-2xl p-8 text-left shadow-md hover:shadow-xl hover:-translate-y-1 transition-all group group-hover" onclick="window.qbankContinueLast()">
<div class="absolute -right-8 -top-8 w-32 h-32 bg-on-primary opacity-10 rounded-full blur-2xl group-hover:scale-150 transition-transform duration-700"></div>
<span class="material-symbols-outlined text-[40px] mb-4" style="font-variation-settings: 'FILL' 1;">play_circle</span>
${continueSessionHtml}
<div class="flex items-center gap-2 font-label-caps text-label-caps tracking-widest">
                RESUME NOW <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
</div>
</button>
<button class="relative overflow-hidden bg-surface-container-highest text-on-surface rounded-2xl p-8 text-left shadow-sm hover:shadow-md hover:-translate-y-1 transition-all group border border-transparent hover:border-primary/20" onclick="window.startQBankSession('${activeQBankId}', '${safeBankName}')">
<span class="material-symbols-outlined text-[40px] text-primary mb-4" style="font-variation-settings: 'FILL' 1;">category</span>
<h3 class="font-title-md text-[20px] mb-2 font-bold">Specialities</h3>
<p class="font-body-md text-on-surface-variant mb-6">Browse subjects and focus your practice on specific topics.</p>
<div class="flex items-center gap-2 font-label-caps text-label-caps text-primary tracking-widest">
                BROWSE <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
</div>
</button>
<button class="relative overflow-hidden bg-surface-container-highest text-on-surface rounded-2xl p-8 text-left shadow-sm hover:shadow-md hover:-translate-y-1 transition-all group border border-transparent hover:border-primary/20" onclick="window.qbankContinueMarked()">
<span class="material-symbols-outlined text-[40px] text-primary mb-4" style="font-variation-settings: 'FILL' 1;">style</span>
<h3 class="font-title-md text-[20px] mb-2 font-bold">Review Incorrects</h3>
<p class="font-body-md text-on-surface-variant mb-6">${reviewIncorrectsText}</p>
<div class="flex items-center gap-2 font-label-caps text-label-caps text-primary tracking-widest">
                START REVIEW <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
</div>
</button>
</div>

<div class="grid grid-cols-1 md:grid-cols-2 gap-gutter mt-gutter">
${activeQBankMeta.isPartyLocked ? `
<button class="relative overflow-hidden bg-surface-container-highest text-on-surface rounded-2xl p-8 text-left shadow-sm border border-transparent opacity-60 cursor-not-allowed">
<span class="material-symbols-outlined text-[40px] mb-4" style="color:var(--text-muted); font-variation-settings: 'FILL' 1;">lock</span>
<h3 class="font-title-md text-[20px] mb-2 font-bold">Host Answer Party</h3>
<p class="font-body-md text-on-surface-variant mb-6">This feature is temporarily disabled for this QBank.</p>
<div class="flex items-center gap-2 font-label-caps text-label-caps tracking-widest text-on-surface-variant">
                DISABLED
</div>
</button>
` : `
<button class="relative overflow-hidden bg-surface-container-highest text-on-surface rounded-2xl p-8 text-left shadow-sm hover:shadow-md hover:-translate-y-1 transition-all group border border-transparent hover:border-[var(--accent-purple)]" onclick="window.pendingPartyCreation = true; window.startQBankSession('${activeQBankId}', 'Answer Party');">
<span class="material-symbols-outlined text-[40px] mb-4" style="color:var(--accent-purple); font-variation-settings: 'FILL' 1;">groups</span>
<h3 class="font-title-md text-[20px] mb-2 font-bold">Host Answer Party</h3>
<p class="font-body-md text-on-surface-variant mb-6">Study with friends in real-time. Share a code to compete together.</p>
<div class="flex items-center gap-2 font-label-caps text-label-caps tracking-widest" style="color:var(--accent-purple);">
                HOST PARTY <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
</div>
</button>
`}
<button class="relative overflow-hidden bg-surface-container-highest text-on-surface rounded-2xl p-8 text-left shadow-sm hover:shadow-md hover:-translate-y-1 transition-all group border border-transparent hover:border-[var(--accent-cyan)]" onclick="window.qbankPrompt('Enter 6-digit Party Code:', code => { if (code) window.QBankParty.joinParty(code).then(() => { window.QBankParty.attachParty(code); window.qbankToast('Joined Party!'); }).catch(e => window.qbankToast(e.message, true)); })">
<span class="material-symbols-outlined text-[40px] mb-4" style="color:var(--accent-cyan); font-variation-settings: 'FILL' 1;">login</span>
<h3 class="font-title-md text-[20px] mb-2 font-bold">Join Answer Party</h3>
<p class="font-body-md text-on-surface-variant mb-6">Enter a code from your friend to join their session.</p>
<div class="flex items-center gap-2 font-label-caps text-label-caps tracking-widest" style="color:var(--accent-cyan);">
                JOIN PARTY <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
</div>
</button>
</div>
${resourcesHtml}
<div class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm border border-outline-variant/30 mt-gutter">
<div class="flex items-center justify-between mb-6">
<h2 class="font-headline-lg text-[20px] text-on-surface">Specialty Mastery</h2>
<button class="text-sm font-medium text-primary hover:underline" onclick="window.openPerformance && window.openPerformance()">View Detailed Analytics</button>
</div>
<div class="space-y-4">
${specialtyHtml}
</div>
</div>
</div>
<div class="flex flex-col gap-gutter">
<div id="dashboard-planner-widget"></div>
<div class="flex flex-col">
<div class="flex items-center justify-between mb-4">
<h2 class="font-headline-lg text-[20px] text-on-surface">Recent Activity</h2>
<button class="text-primary hover:text-primary-container transition-colors"><span class="material-symbols-outlined">more_horiz</span></button>
</div>
<div class="bg-surface-container-lowest rounded-2xl p-2 shadow-sm flex flex-col gap-1 border border-outline-variant/30">
  ${recentActivityHtml}
</div>
</div>
</div>
</div>
<style>
@keyframes fade-in {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
}
</style></div></div>`;
      area.innerHTML = html;
      // Attach renderDashboardPlannerWidget
      if (window.renderDashboardPlannerWidget) window.renderDashboardPlannerWidget();

      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      
    } catch (e) {
      area.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);">Failed to load QBanks: ${e.message}</div>`;
    }
  };

  // --- Browse All Banks (original category grid) ---
  window.openQBankCategories = async function () {
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";
    
    if (!qbanks || qbanks.length === 0) {
      area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">No QBanks available.</div>';
      return;
    }
    
    let html = `<div style="max-width:1000px; margin:0 auto; padding:40px 20px;">
      <div style="display:flex; align-items:center; margin-bottom:30px;">
        <button class="btn-dark-pill" style="padding:8px 16px; margin-right:15px; display:flex; align-items:center; gap:8px;" onclick="window.openQBank()">
          <i data-lucide="arrow-left" style="width:16px;height:16px;"></i> Home
        </button>
        <div>
          <h2 style="margin:0; font-size:1.5rem; font-weight:700;">Choose Your Exam</h2>
          <p style="margin:4px 0 0 0; font-size:0.9rem; color:var(--text-muted);">Select from ${qbanks.length} available question bank${qbanks.length !== 1 ? 's' : ''}</p>
        </div>
      </div>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:24px;">`;
    
    const isAdmin = window.checkAdmin ? await window.checkAdmin() : false;
    const flagMap = { usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg" };
    for (const q of qbanks) {
      const isLockedForUser = q.isLocked;
      const countryCode = flagMap[q.country];
      const flagHtml = countryCode 
         ? `<img src="https://flagcdn.com/w80/${countryCode}.png" alt="${countryCode}" style="width:64px; height:auto; border-radius:4px; margin-bottom:20px; box-shadow:0 4px 12px rgba(0,0,0,0.15);">`
         : `<div style="font-size:4rem; margin-bottom:20px; filter: drop-shadow(0 4px 12px rgba(0,0,0,0.15)); line-height:1;">🌍</div>`;
         
      // Show question count if cached
      const cached = cachedQBanks[q.id];
      const qCount = cached ? (cached.questions || []).length : 0;
      const countLabel = qCount > 0 ? `<div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:12px;">${qCount.toLocaleString()} questions</div>` : '';
         
      const clickAttr = isLockedForUser ? "" : `onclick="window.startQBankSession('${q.id}', '${window.escapeHtml ? window.escapeHtml(q.name).replace(/'/g, "\\\\'") : q.name.replace(/'/g, "\\\\'")}')"`;
      const cursorStyle = isLockedForUser ? "cursor:not-allowed; opacity:0.6;" : "cursor:pointer;";
      const hoverEffects = isLockedForUser ? "" : `onmouseover="this.style.transform='translateY(-8px)'; this.style.borderColor='var(--accent-cyan)'; this.style.boxShadow='0 20px 40px rgba(0,0,0,0.3), 0 0 20px rgba(6, 182, 212, 0.2)';" onmouseout="this.style.transform='translateY(0)'; this.style.borderColor='rgba(255,255,255,0.08)'; this.style.boxShadow='0 8px 32px rgba(0,0,0,0.2)';"`;
      
      const actionLabel = isLockedForUser ? 
        `<span style="color:var(--danger);"><i data-lucide="lock" style="width:16px;height:16px;margin-right:4px;vertical-align:-3px;"></i> Under Maintenance</span>` : 
        `<span>Start Practicing</span><i data-lucide="arrow-right" style="width:18px;height:18px;"></i>`;

      html += `
        <div class="qbank-exam-card" style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:20px; padding:32px 24px; transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1); display:flex; flex-direction:column; align-items:center; text-align:center; position:relative; overflow:hidden; box-shadow:0 8px 32px rgba(0,0,0,0.2); ${cursorStyle}" ${clickAttr} ${hoverEffects}>
           ${flagHtml}
           <h3 style="font-size:1.4rem; font-weight:700; margin-bottom:8px; color:var(--text-primary); letter-spacing:0.2px;">${window.escapeHtml ? window.escapeHtml(q.name) : q.name}</h3>
           ${countLabel}
           <div style="color:var(--accent-cyan); font-size:0.95rem; font-weight:600; display:flex; align-items:center; gap:8px; margin-top:auto; padding-top:15px; text-transform:uppercase; letter-spacing:1px;">
             ${actionLabel}
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

  window.startQBankSession = async function (qbankId, qbankName, targetSubject = null, reviewIncorrectsOnly = false) {
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";
    
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
            <div class="w-48 h-1 bg-surface-container rounded-full overflow-hidden relative">
                <div class="absolute top-0 left-0 h-full w-full bg-primary rounded-full animate-[loading-bar-indeterminate_1.5s_infinite_ease-in-out] origin-left"></div>
            </div>
            <div class="text-on-surface-variant text-sm">Downloading questions...</div>
          </div>`;
         const qCat = (cachedCategories || []).find(c => c.id === qbankId);
         const catUpdated = qCat ? qCat.updatedAt : 0;
         
         const idbData = await getCachedQBank(qbankId);
         if (idbData && idbData.updatedAt === catUpdated && idbData.questions && idbData.questions.length > 0) {
            const res = await apiGet("get_questions", { qbankId, onlyProgress: true });
            cachedQBanks[qbankId] = { questions: idbData.questions, progress: res.progress || {} };
         } else {
            const res = await apiGet("get_questions", { qbankId });
            cachedQBanks[qbankId] = { questions: res.questions || [], progress: res.progress || {} };
            setCachedQBank(qbankId, { updatedAt: catUpdated, questions: res.questions || [] });
         }
         
         qData = cachedQBanks[qbankId];
      }
      
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
        const chap = (q.data && q.data.chapter) || null;
        
        if (!subjectStats[sub]) subjectStats[sub] = { total: 0, answered: 0, correct: 0, chapters: {} };
        subjectStats[sub].total++;
        totalQ++;
        
        if (chap) {
           if (!subjectStats[sub].chapters[chap]) subjectStats[sub].chapters[chap] = { total: 0, answered: 0, correct: 0 };
           subjectStats[sub].chapters[chap].total++;
        }
        
        if (progress[q.id] && progress[q.id].correct !== undefined) {
          subjectStats[sub].answered++;
          totalAns++;
          if (progress[q.id].correct) {
             subjectStats[sub].correct++;
             totalCorrect++;
          }
          if (chap) {
             subjectStats[sub].chapters[chap].answered++;
             if (progress[q.id].correct) {
                 subjectStats[sub].chapters[chap].correct++;
             }
          }
        }
      });
      
      window.qbankSubjectStats = subjectStats;
      let subjectList = Object.keys(subjectStats).filter(s => s !== "Uncategorized");
      subjectList.sort((a, b) => {
        const isCasA = a.toLowerCase().includes("cas clinique");
        const isCasB = b.toLowerCase().includes("cas clinique");
        if (isCasA && !isCasB) return -1;
        if (!isCasA && isCasB) return 1;
        return a.localeCompare(b);
      });
      
      if (targetSubject !== null || reviewIncorrectsOnly || (qbankName === "Answer Party" && !window.pendingPartyCreation)) {
          window.startQBankFiltered(targetSubject, reviewIncorrectsOnly);
          return;
      }
      
      if (subjectList.length === 0) {
        // No subjects, start directly
        window.startQBankFiltered(null);
      } else {
        window.getScoreDisplay = (correct, answered) => {
           if (answered === 0) return { text: '0%', color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)' };
           const score = Math.round((correct / answered) * 100);
           const color = score >= 80 ? '#22c55e' : (score >= 50 ? '#eab308' : '#f43f5e');
           const bg = score >= 80 ? 'rgba(34,197,94,0.1)' : (score >= 50 ? 'rgba(234,179,8,0.1)' : 'rgba(244,63,94,0.1)');
           return { text: `${score}%`, color, bg };
        };

        const globalScoreUI = window.getScoreDisplay(totalCorrect, totalAns);

        // Show subject selection
        let html = `<div style="width:100%; margin:0; padding:20px;">
          <div style="display:flex; align-items:center; margin-bottom:25px;">
             <button class="btn-dark-pill" style="padding:8px 16px; margin-right:15px; display:flex; align-items:center; gap:8px;" onclick="window.openQBank()">
               <i data-lucide="arrow-left" style="width:16px;height:16px;"></i> Back
             </button>
             <h2 style="margin:0;">Select Sub-Category</h2>
          </div>
          <input type="text" class="login-input" placeholder="Search sub-categories..." style="width:100%; margin-bottom:15px; padding:12px; font-size:1rem;" oninput="window.filterQBankSubjects(this.value)">
          <div id="qbank-subject-list-container" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:12px;">
            <button class="btn-dark-pill" style="padding:16px; font-size:1.1rem; text-align:left; justify-content:space-between; align-items:center; display:flex; border:1px solid rgba(255,255,255,0.05); border-radius:12px; height:100%;" onclick="window.startQBankFiltered(null)">
              <div>
                <div>All Subjects (Random Mix)</div>
                <div style="display:flex; gap:10px; align-items:center; margin-top:8px;">
                  <div style="font-size:0.85rem; color:var(--text-muted);">${totalAns} / ${totalQ} answered</div>
                  <div style="font-size:0.8rem; font-weight:700; color:${globalScoreUI.color}; background:${globalScoreUI.bg}; padding:2px 8px; border-radius:12px;">Score: ${globalScoreUI.text}</div>
                </div>
              </div>
              <i data-lucide="shuffle"></i>
            </button>`;
        
        subjectList.forEach(sub => {
          const stats = subjectStats[sub];
          const subSafe = window.escapeHtml ? window.escapeHtml(sub).replace(/'/g, "\\'") : sub;
          
          const isCas = sub.toLowerCase().includes("cas clinique");
          const markHtml = isCas ? `<div style="font-size:0.7rem; background:rgba(34,211,238,0.15); color:var(--accent-cyan); padding:2px 6px; border-radius:4px; font-weight:700; display:inline-block; margin-bottom:6px;">SPECIAL</div>` : "";
          const titleStyle = isCas ? "color:var(--accent-cyan); font-weight:700;" : "color:var(--text-primary);";
          
          const scoreUI = window.getScoreDisplay(stats.correct, stats.answered);

          html += `
            <button class="btn-dark-pill qbank-subject-btn" data-subject="${subSafe}" style="padding:16px; font-size:1.05rem; text-align:left; display:flex; flex-direction:column; justify-content:space-between; align-items:flex-start; border:1px solid ${isCas ? 'rgba(34,211,238,0.3)' : 'rgba(255,255,255,0.05)'}; border-radius:12px; height:100%; gap:8px;" onclick="window.openQBankChapter('${subSafe}')">
              <div style="width:100%;">
                ${markHtml}
                <div style="line-height:1.3; ${titleStyle}">${window.escapeHtml ? window.escapeHtml(sub) : sub}</div>
              </div>
              <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
                <div style="display:flex; gap:10px; align-items:center;">
                  <div style="font-size:0.85rem; color:var(--text-muted);">${stats.answered} / ${stats.total}</div>
                  <div style="font-size:0.75rem; font-weight:700; color:${scoreUI.color}; background:${scoreUI.bg}; padding:2px 6px; border-radius:10px;">${scoreUI.text}</div>
                </div>
                <i data-lucide="chevron-right" style="width:16px;height:16px;opacity:0.5;"></i>
              </div>
            </button>`;
        });
        html += `</div></div>`;
        area.innerHTML = html;
        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      }
      
    } catch (e) {
      area.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);">Failed to load questions: ${e.message}</div>`;
    }
  };

  window.openQBankChapter = function(subject) {
      if (!window.qbankSubjectStats || !window.qbankSubjectStats[subject]) {
          return window.startQBankFiltered(subject);
      }
      
      const stats = window.qbankSubjectStats[subject];
      const chapters = Object.keys(stats.chapters || {});
      
      if (chapters.length === 0) {
          // No chapters, just start the subject
          return window.startQBankFiltered(subject);
      }
      
      const area = document.getElementById("qbank-home-content");
      if (!area) return;
      
      const globalScoreUI = window.getScoreDisplay(stats.correct, stats.answered);
      
      let html = `<div style="width:100%; margin:0; padding:20px;">
          <div style="display:flex; align-items:center; margin-bottom:25px;">
             <button class="btn-dark-pill" style="padding:8px 16px; margin-right:15px; display:flex; align-items:center; gap:8px;" onclick="window.startQBankSession('${currentQBankId}', document.getElementById('qbank-active-name').textContent)">
               <i data-lucide="arrow-left" style="width:16px;height:16px;"></i> Back to Subjects
             </button>
             <h2 style="margin:0;">${window.escapeHtml ? window.escapeHtml(subject) : subject} - Chapters</h2>
          </div>
          <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:12px;">
            <button class="btn-dark-pill" style="padding:16px; font-size:1.1rem; text-align:left; justify-content:space-between; align-items:center; display:flex; border:1px solid rgba(255,255,255,0.05); border-radius:12px; height:100%;" onclick="window.startQBankFiltered('${window.escapeHtml(subject).replace(/'/g, "\\'")}')">
              <div>
                <div>All Chapters (Random Mix)</div>
                <div style="display:flex; gap:10px; align-items:center; margin-top:8px;">
                  <div style="font-size:0.85rem; color:var(--text-muted);">${stats.answered} / ${stats.total} answered</div>
                  <div style="font-size:0.8rem; font-weight:700; color:${globalScoreUI.color}; background:${globalScoreUI.bg}; padding:2px 8px; border-radius:12px;">Score: ${globalScoreUI.text}</div>
                </div>
              </div>
              <i data-lucide="shuffle"></i>
            </button>`;
            
      chapters.sort().forEach(chap => {
          const chapStats = stats.chapters[chap];
          const chapSafe = window.escapeHtml ? window.escapeHtml(chap).replace(/'/g, "\\'") : chap;
          const subSafe = window.escapeHtml ? window.escapeHtml(subject).replace(/'/g, "\\'") : subject;
          const scoreUI = window.getScoreDisplay(chapStats.correct, chapStats.answered);
          
          html += `
            <button class="btn-dark-pill" style="padding:16px; font-size:1.05rem; text-align:left; display:flex; flex-direction:column; justify-content:space-between; align-items:flex-start; border:1px solid rgba(255,255,255,0.05); border-radius:12px; height:100%; gap:8px;" onclick="window.startQBankFiltered('${subSafe}', '${chapSafe}')">
              <div style="width:100%;">
                <div style="line-height:1.3; color:var(--text-primary);">${window.escapeHtml ? window.escapeHtml(chap) : chap}</div>
              </div>
              <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
                <div style="display:flex; gap:10px; align-items:center;">
                  <div style="font-size:0.85rem; color:var(--text-muted);">${chapStats.answered} / ${chapStats.total}</div>
                  <div style="font-size:0.75rem; font-weight:700; color:${scoreUI.color}; background:${scoreUI.bg}; padding:2px 6px; border-radius:10px;">${scoreUI.text}</div>
                </div>
                <i data-lucide="chevron-right" style="width:16px;height:16px;opacity:0.5;"></i>
              </div>
            </button>`;
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

  window.startQBankFiltered = function(subject, chapter = null, reviewIncorrectsOnly = false) {
    if (typeof chapter === 'boolean') {
        reviewIncorrectsOnly = chapter;
        chapter = null;
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
    saveQBankSession(currentQBankId, qbName, (subject || "All Subjects") + (chapter ? ` - ${chapter}` : ""));
    
    if (subject) {
      currentQuestions = allQuestions.filter(q => q.data && q.data.subject === subject && (!chapter || q.data.chapter === chapter));
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
      return;
    }
    
    const q = currentQuestions[currentIndex];
    const data = q.data || {};
    
    const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
    const isMultiple = correctIndices.length > 1;
    
    const inPartyMode = window.QBankParty && window.QBankParty.state.party;
    let optionsHtml = '';
    if (data.options) {
      optionsHtml = data.options.map((opt, i) => `
        <label class="usmle-option qbank-option-btn" id="qbank-opt-${i}" ${!isMultiple && !inPartyMode ? `onclick="window.qbankSelectOption(${i}); event.preventDefault();"` : ""} style="display:flex; align-items:flex-start; margin-bottom:12px; cursor:pointer;">
          <input type="${isMultiple ? 'checkbox' : 'radio'}" name="qbank-radio" value="${i}" style="margin-top:6px; margin-right:12px;" ${!isMultiple && !inPartyMode ? 'onclick="event.preventDefault()"' : ''}>
          <span class="usmle-option-letter" style="margin-right:12px;">${String.fromCharCode(65 + i)}</span>
          <span class="usmle-option-text" style="flex:1;">${window.escapeHtml ? window.escapeHtml(opt) : opt}</span>
        </label>
      `).join('');
    }

    let submitHtml = '';
    if (inPartyMode) {
      submitHtml = `<button id="qbank-submit-btn" class="btn-action primary" style="margin-top:10px; width:100%; padding:12px;" onclick="window.qbankPartyLockAnswer()">Lock Answer</button>`;
    } else if (isMultiple) {
      submitHtml = `<button id="qbank-submit-btn" class="btn-action primary" style="margin-top:10px; width:100%; padding:12px;" onclick="window.qbankSelectOption()">Submit Answer</button>`;
    }

    area.innerHTML = `
      <div style="max-width:800px; margin:0 auto; padding:20px; text-align:left;">
        <div class="usmle-question-card">
          <div class="usmle-question-num" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
            <div style="display:flex; align-items:center; gap:12px;">
              <button class="btn-dark-pill" style="padding:4px 8px; font-size:0.8rem; display:flex; align-items:center; gap:4px; height:27px; color:var(--text-secondary); border: 1px solid rgba(255,255,255,0.05);" onclick="window.openQBank()" title="Return to QBank Home">
                <i data-lucide="arrow-left" style="width:14px;height:14px;"></i> Leave
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
                     <i data-lucide="bookmark" style="width:14px;height:14px;${isMarked ? 'fill:var(--accent-cyan);' : ''}"></i> ${isMarked ? 'Marked' : 'Mark'}
                   </button>
                   <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:${hasNote ? 'var(--accent-cyan)' : 'var(--text-secondary)'}; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankToggleNoteUI()">
                     <i data-lucide="file-text" style="width:14px;height:14px;${hasNote ? 'fill:var(--accent-cyan);' : ''}"></i> ${hasNote ? 'Edit Note' : 'Add Note'}
                   </button>
                   <button class="btn-dark-pill" id="qbank-highlighter-btn" style="padding:4px 10px; font-size:0.8rem; color:${highActive ? 'var(--accent-cyan)' : 'var(--text-secondary)'}; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankToggleHighlighter()">
                     <i data-lucide="highlighter" style="width:14px;height:14px;${highActive ? 'stroke:var(--accent-cyan);' : ''}"></i> Highlighter
                   </button>
                   <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:var(--text-secondary); display:flex; align-items:center; gap:4px; height:27px;" onclick="window.generateAIFlashcard('${q.id}')" title="Generate AI Flashcard for this question">
                     <i data-lucide="brain" style="width:14px;height:14px;"></i> AI Flashcard
                   </button>
                   <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:#ef4444; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankReportQuestion('${q.id}')" title="Report an error in this question">
                     <i data-lucide="flag" style="width:14px;height:14px;"></i> Report
                   </button>
                 `;
               })()}
               <span title="${isMultiple ? 'Question à Choix Multiples (Multiple Answers)' : 'Question à Choix Simple (Single Answer)'}" style="font-size:0.8rem; padding:4px 10px; background:${isMultiple ? 'rgba(168,85,247,0.15)' : 'rgba(6,182,212,0.15)'}; border:1px solid ${isMultiple ? 'rgba(168,85,247,0.3)' : 'rgba(6,182,212,0.3)'}; border-radius:12px; color:${isMultiple ? '#a855f7' : '#06b6d4'}; font-weight:700; cursor:help; letter-spacing:0.5px;">${isMultiple ? 'QCM' : 'QCS'}</span>
               ${data.subject ? `<span style="font-size:0.8rem; padding:4px 10px; background:rgba(255,255,255,0.1); border-radius:12px; color:var(--text-secondary); text-transform:uppercase;">${window.escapeHtml ? window.escapeHtml(data.subject) : data.subject}</span>` : ""}
               <span style="font-size:0.8rem; padding:4px 10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:12px; color:var(--text-secondary); font-family:monospace;">ID: ${data.code ? (window.escapeHtml ? window.escapeHtml(data.code) : data.code) : ("Q-" + q.id.substring(0, 5).toUpperCase())}</span>
               ${(data.tags || []).map(t => `<span style="font-size:0.75rem; padding:3px 8px; background:rgba(167, 139, 250, 0.15); border:1px solid rgba(167, 139, 250, 0.3); border-radius:12px; color:#a78bfa;">#${window.escapeHtml ? window.escapeHtml(t) : t}</span>`).join("")}

               ${window.isQBankAdmin ? `
                 <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:#f43f5e; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankAdminDelete('${q.id}')">
                   <i data-lucide="trash-2" style="width:14px;height:14px;"></i> Delete
                 </button>
                 <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:#38bdf8; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankAdminEdit('${q.id}')">
                   <i data-lucide="edit-3" style="width:14px;height:14px;"></i> Edit
                 </button>
               ` : ''}
            </div>
          </div>
          
          ${(() => {
             const p = window.qbankProgress[q.id] || {};
             if (!p.note) return "";
             return `
             <div id="qbank-note-container" style="background:rgba(255,255,100,0.05); border-left:3px solid #facc15; padding:12px; margin-bottom:15px; border-radius:0 8px 8px 0; margin-top:15px;">
               <div style="font-size:0.8rem; color:#facc15; font-weight:700; margin-bottom:4px; display:flex; align-items:center; gap:4px;"><i data-lucide="sticky-note" style="width:12px;height:12px;"></i> MY NOTE</div>
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
            ${q.highlightedHTML ? q.highlightedHTML : (window.escapeHtml ? window.escapeHtml(q.text) : q.text)}
          </h2>
          <div class="usmle-options" id="qbank-options-container">
            ${optionsHtml}
          </div>
          ${submitHtml}
          
          <div id="qbank-explanation-container" class="usmle-explanation" style="display:none; margin-top:30px;">
             <div id="qbank-result-header" style="font-weight:bold; margin-bottom:12px; font-size:1.1rem;"></div>
             <div style="margin-bottom:16px; font-size:0.9rem; color:var(--text-muted); display:flex; align-items:center;">
               <i data-lucide="clock" style="width:14px;height:14px; margin-right:4px;"></i> Time Taken: <span id="qbank-time-taken-text" style="margin-left:4px; font-weight:600; color:var(--text-primary);"></span>
             </div>
             <h3 style="font-size:1rem; margin-bottom:8px; color:var(--text-primary);">Explanation</h3>
             <div style="font-size:0.95rem; line-height:1.6; color:var(--text-secondary); padding:10px; background:rgba(0,0,0,0.1); border-radius:8px;">
               ${(() => {
                 if (!data.explanation) return "No explanation provided.";
                 if (window.marked && window.DOMPurify) {
                   return window.DOMPurify.sanitize(window.marked.parse(data.explanation));
                 }
                 return window.escapeHtml ? window.escapeHtml(data.explanation) : data.explanation;
               })()}
             </div>
             
             <!-- AI Chat Area -->
             <div style="margin-top:20px; border-top:1px solid var(--border-color, rgba(0,0,0,0.1)); padding-top:20px;">
               <button class="btn-dark-pill" style="color:var(--accent-cyan); display:flex; align-items:center; gap:8px;" onclick="window.qbankToggleChat()">
                 <i data-lucide="bot" style="width:18px;height:18px;"></i> Ask AI Tutor
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
          </div>
        </div>
      </div>
    `;
    
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    startTimer();
    
    window.qbankRenderSidebar();
  };

  window.qbankSelectOption = async function (selectedIndex) {
    if (!qbankTimer) return; // already answered
    stopTimer();
    
    currentQuestionTimeMs = Date.now() - questionStartTime;
    const q = currentQuestions[currentIndex];
    const data = q.data || {};
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
    if (isMultiple) {
      if (selectedIndices.length === correctIndices.length) {
        const sortedSelected = [...selectedIndices].sort();
        const sortedCorrect = [...correctIndices].sort();
        isCorrect = sortedSelected.every((v, i) => v === sortedCorrect[i]);
      }
    } else {
      isCorrect = correctIndices.includes(selectedIndex);
    }
    
    // Highlight UI
    const container = document.getElementById("qbank-options-container");
    const labels = container.querySelectorAll(".qbank-option-btn");
    labels.forEach((label, i) => {
      label.style.pointerEvents = "none";
      const input = label.querySelector("input");
      if (input) input.disabled = true;
      
      if (correctIndices.includes(i)) {
        label.classList.add("correct");
        label.style.background = "rgba(34,197,94,0.1)";
        label.style.border = "1px solid #22c55e";
        label.style.borderRadius = "8px";
        label.style.padding = "8px";
      } else if (selectedIndices.includes(i) && !correctIndices.includes(i)) {
        label.classList.add("incorrect");
        label.style.background = "rgba(244,63,94,0.1)";
        label.style.border = "1px solid #f43f5e";
        label.style.borderRadius = "8px";
        label.style.padding = "8px";
      }
    });

    const explContainer = document.getElementById("qbank-explanation-container");
    const resultHeader = document.getElementById("qbank-result-header");
    
    if (isCorrect) {
      resultHeader.innerHTML = '<span style="color:#22c55e;"><i data-lucide="check-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Correct</span>';
    } else {
      resultHeader.innerHTML = '<span style="color:#f43f5e;"><i data-lucide="x-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Incorrect</span>';
    }
    
    document.getElementById("qbank-time-taken-text").textContent = formatTime(currentQuestionTimeMs);
    explContainer.style.display = "block";
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

    // Update local progress so sidebar icon shows immediately
    const p = window.qbankProgress[q.id] || {};
    p.correct = isCorrect;
    p.timeTakenMs = currentQuestionTimeMs;
    window.qbankProgress[q.id] = p;
    window.qbankRenderSidebar();

    // Submit progress silently
    if (currentQBankId) {
      syncQueue.push({
        qbankId: currentQBankId,
        questionId: q.id,
        correct: isCorrect,
        timeTakenMs: currentQuestionTimeMs
      });
    }
  };
  
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
    
    // Optimistic UI update
    p.marked = newMarked;
    window.qbankProgress[q.id] = p;
    window.qbankRenderCurrent();
    
    // Background save
    if (currentQBankId) {
      syncQueue.push({
        qbankId: currentQBankId,
        questionId: q.id,
        marked: newMarked
      });
    }
  };

  window.qbankReportQuestion = async function(id) {
    if (!currentQBankId) return;
    
    // Create UI modal dynamically
    const modalId = "qbank-report-modal";
    let modal = document.getElementById(modalId);
    if (!modal) {
      modal = document.createElement("div");
      modal.id = modalId;
      modal.style.position = "fixed";
      modal.style.top = "0";
      modal.style.left = "0";
      modal.style.width = "100vw";
      modal.style.height = "100vh";
      modal.style.backgroundColor = "rgba(0,0,0,0.6)";
      modal.style.display = "none";
      modal.style.alignItems = "center";
      modal.style.justifyContent = "center";
      modal.style.zIndex = "9999";
      modal.style.backdropFilter = "blur(4px)";
      
      modal.innerHTML = `
        <div style="background:var(--bg-card, #1e293b); padding:24px; border-radius:16px; border:1px solid rgba(255,255,255,0.1); width:90%; max-width:400px; box-shadow:0 10px 40px rgba(0,0,0,0.5);">
          <h3 style="font-size:1.2rem; font-weight:700; margin-bottom:10px; color:var(--text-primary);">Report Question</h3>
          <p style="font-size:0.9rem; color:var(--text-secondary); margin-bottom:15px;">What is wrong with this question? Please provide details so we can fix it.</p>
          <textarea id="qbank-report-reason-input" class="login-input" style="width:100%; height:100px; padding:12px; margin-bottom:20px; font-size:0.9rem; resize:vertical;" placeholder="E.g. The correct answer should be C, not B because..."></textarea>
          <div style="display:flex; justify-content:flex-end; gap:10px;">
            <button class="btn-dark-pill" style="padding:8px 16px;" onclick="document.getElementById('${modalId}').style.display='none'">Cancel</button>
            <button id="qbank-report-submit-btn" class="btn-action primary" style="padding:8px 16px; background:#ef4444; border-color:#ef4444;">Submit Report</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }
    
    const input = document.getElementById("qbank-report-reason-input");
    const submitBtn = document.getElementById("qbank-report-submit-btn");
    input.value = "";
    modal.style.display = "flex";
    input.focus();
    
    submitBtn.onclick = async () => {
       const reason = input.value.trim();
       if (!reason) {
         alert("Please enter a reason.");
         return;
       }
       submitBtn.disabled = true;
       submitBtn.textContent = "Submitting...";
       try {
         await apiPost("report_question", {
           qbankId: currentQBankId,
           questionId: id,
           reason: reason
         });
         modal.style.display = "none";
         // Show a nice inline success message instead of standard alert if possible, or just alert.
         const successMsg = document.createElement("div");
         successMsg.textContent = "Thank you! The question has been reported to the admins.";
         successMsg.style.position = "fixed";
         successMsg.style.bottom = "20px";
         successMsg.style.right = "20px";
         successMsg.style.padding = "12px 20px";
         successMsg.style.background = "#22c55e";
         successMsg.style.color = "#fff";
         successMsg.style.borderRadius = "8px";
         successMsg.style.zIndex = "10000";
         successMsg.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
         document.body.appendChild(successMsg);
         setTimeout(() => document.body.removeChild(successMsg), 4000);
       } catch(e) {
         alert("Failed to report question: " + e.message);
       } finally {
         submitBtn.disabled = false;
         submitBtn.textContent = "Submit Report";
       }
    };
  };

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
      syncQueue.push({
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
        userMessage: val
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

  window.qbankAdminEdit = async function(questionId) {
    const q = allQuestions.find(q => q.id === questionId);
    if (!q) return;
    const currentJson = JSON.stringify({ questionText: q.text, ...q.data }, null, 2);
    const newJson = prompt("Edit Question JSON:", currentJson);
    if (!newJson || newJson === currentJson) return;
    
    try {
      const parsed = JSON.parse(newJson);
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      const res = await fetch(`/api/admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "update_qbank_question", qbankId: currentQBankId, questionId, questionText: parsed.questionText || "", dataJson: JSON.stringify(parsed) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to edit");
      
      // Update locally
      q.text = parsed.questionText || "";
      delete parsed.questionText;
      q.data = parsed;
      q.highlightedHTML = null; // Clear highlight cache
      window.qbankRenderCurrent();
      alert("Question updated successfully.");
    } catch (e) {
      alert("Edit failed: " + e.message);
    }
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
      document.querySelectorAll('nav a').forEach(a => {
          a.classList.remove('bg-secondary-container', 'text-on-secondary-container', 'font-semibold');
          a.classList.add('text-on-surface-variant');
      });
      const pt = document.querySelector('nav a[data-path="performance"]');
      if (pt) {
          pt.classList.remove('text-on-surface-variant');
          pt.classList.add('bg-secondary-container', 'text-on-secondary-container', 'font-semibold');
      }

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
              
              const colorClass = spec.score >= 80 ? 'bg-primary' : (spec.score >= 50 ? 'bg-primary/70' : 'bg-error/70');
              const textClass = spec.score >= 80 ? 'text-primary' : (spec.score >= 50 ? 'text-on-surface' : 'text-error');
              
              specialtyListHtml += `
              <div class="bg-surface-container-lowest border border-outline-variant/30 rounded-2xl p-6 shadow-sm flex flex-col hover:-translate-y-1 transition-transform group">
                  <div class="flex items-start justify-between mb-2">
                      <div>
                          <h3 class="font-title-md text-[18px] text-on-surface mb-1">${window.escapeHtml ? window.escapeHtml(spec.name) : spec.name}</h3>
                          <p class="font-label-sm text-on-surface-variant">${spec.answered} / ${spec.total} Answered</p>
                      </div>
                      <div class="text-right">
                          <span class="font-headline-lg ${textClass}">${spec.score}%</span>
                      </div>
                  </div>
                  
                  <div class="w-full bg-surface-container rounded-full h-2 mb-4">
                    <div class="${colorClass} h-2 rounded-full" style="width: ${spec.score}%"></div>
                  </div>

                  <div class="mt-auto pt-4 border-t border-outline-variant/30 flex justify-between items-center">
                      <div class="flex gap-4 text-[12px] text-on-surface-variant">
                          <div class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-primary"></span> ${spec.correct} Correct</div>
                          <div class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-error"></span> ${spec.incorrect} Incorrect</div>
                      </div>
                      <button class="px-3 py-1.5 text-[12px] font-bold uppercase rounded-lg border border-outline-variant hover:bg-surface-container transition-colors text-primary flex items-center gap-1"
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
                  <p class="font-label-caps text-primary tracking-[0.1em] mb-2">DETAILED ANALYTICS</p>
                  <h1 class="font-headline-xl text-on-surface">My Performance</h1>
              </div>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm border border-outline-variant/30 lg:col-span-1 flex flex-col justify-center items-center text-center">
                  <span class="material-symbols-outlined text-[48px] text-primary mb-4">workspace_premium</span>
                  <h2 class="font-headline-lg text-[42px] text-on-surface mb-2">${globalScore}%</h2>
                  <p class="font-label-caps text-on-surface-variant mb-6">GLOBAL ACCURACY</p>
                  <div class="flex w-full justify-between px-6 py-4 bg-surface-container rounded-xl">
                      <div>
                          <div class="font-title-md">${totalAnswered}</div>
                          <div class="text-[11px] text-on-surface-variant uppercase font-bold tracking-wider">Answered</div>
                      </div>
                      <div class="w-[1px] bg-outline-variant/50"></div>
                      <div>
                          <div class="font-title-md">${totalCorrect}</div>
                          <div class="text-[11px] text-on-surface-variant uppercase font-bold tracking-wider">Correct</div>
                      </div>
                      <div class="w-[1px] bg-outline-variant/50"></div>
                      <div>
                          <div class="font-title-md">${totalQuestions - totalAnswered}</div>
                          <div class="text-[11px] text-on-surface-variant uppercase font-bold tracking-wider">Remaining</div>
                      </div>
                  </div>
              </div>

              <div class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm border border-outline-variant/30 lg:col-span-2">
                  <h3 class="font-title-md mb-4 text-on-surface">Accuracy by Specialty</h3>
                  <div class="relative h-[250px] w-full">
                      <canvas id="performanceChart"></canvas>
                  </div>
              </div>
          </div>

          <div>
              <h3 class="font-headline-lg text-[22px] text-on-surface mb-4 mt-4">Specialty Breakdown</h3>
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
                          backgroundColor: 'rgba(0, 84, 94, 0.7)',
                          borderColor: 'rgba(0, 84, 94, 1)',
                          borderWidth: 1,
                          borderRadius: 4
                      }]
                  },
                  options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      scales: {
                          y: {
                              beginAtZero: true,
                              max: 100,
                              grid: {
                                  color: 'rgba(111, 121, 123, 0.1)'
                              },
                              ticks: {
                                  color: '#6f797b',
                                  font: { family: 'Inter', size: 11 }
                              }
                          },
                          x: {
                              grid: {
                                  display: false
                              },
                              ticks: {
                                  color: '#6f797b',
                                  font: { family: 'Inter', size: 11 }
                              }
                          }
                      },
                      plugins: {
                          legend: {
                              display: false
                          },
                          tooltip: {
                              backgroundColor: '#00545e',
                              titleFont: { family: 'Manrope', size: 13 },
                              bodyFont: { family: 'Inter', size: 12 },
                              padding: 10,
                              displayColors: false
                          }
                      }
                  }
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
  
  window.qbankRevealPartyAnswers = function() {
       const q = currentQuestions[currentIndex];
       const data = q.data || {};
       const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
       
       let u = null;
       if (window.firebase && window.firebase.auth) u = window.firebase.auth().currentUser;
       const uid = u ? u.uid : null;
       
       const myLock = window.QBankParty.state.members.find(m => m.uid === uid)?.lockedAnswer || [];
       
       let isCorrect = false;
       if (myLock.length === correctIndices.length && myLock.every(v => correctIndices.includes(v))) {
           isCorrect = true;
       }
       
       if (isCorrect && window.lastScoredQuestionId !== q.id) {
           window.lastScoredQuestionId = q.id;
           window.QBankParty.updateScore(100);
       }
       
       const inputs = document.getElementsByName("qbank-radio");
       inputs.forEach(r => {
           r.disabled = true;
           const val = parseInt(r.value, 10);
           const label = r.closest('label');
           if (correctIndices.includes(val)) {
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

  window.openQBankResourcesTab = function() {
      // First ensure we are on the home view
      if (typeof window.goHome === 'function') window.goHome();
      setTimeout(() => {
          const el = document.getElementById('qbank-resources-widget');
          if (el) {
              el.scrollIntoView({behavior: 'smooth', block: 'center'});
              el.style.transition = 'box-shadow 0.3s ease';
              el.style.boxShadow = '0 0 0 4px var(--primary)';
              setTimeout(() => {
                  el.style.boxShadow = 'none';
              }, 1500);
          } else {
              window.qbankToast("No resources available for this QBank or no QBank selected.", true);
          }
      }, 100);
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
