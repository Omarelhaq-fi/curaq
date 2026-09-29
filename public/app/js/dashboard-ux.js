// OmNote — dashboard shell UX: docked sidebar rail, topbar overflow menu,
// and the home overview (stats, continue studying, today's plan, weak spots).
// Read-only over existing globals — no data mutation.
(function () {
  'use strict';

  const DAY = 86400000;
  const DESKTOP = 1024;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function isDesktop() { return window.innerWidth >= DESKTOP; }
  function icons() { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); }

  // ---------------------------------------------------------------
  // Sidebar: drawer on mobile, collapsible rail on desktop
  // ---------------------------------------------------------------
  function installSidebar() {
    const openDrawer = () => {
      document.getElementById('sidebar-overlay')?.classList.add('active');
      document.getElementById('sidebar-menu')?.classList.add('active');
    };
    const closeDrawer = () => {
      document.getElementById('sidebar-overlay')?.classList.remove('active');
      document.getElementById('sidebar-menu')?.classList.remove('active');
    };

    window.closeSidebar = function () {
      if (isDesktop()) return; // stays docked on desktop
      closeDrawer();
    };
    window.toggleSidebar = function () {
      if (isDesktop()) {
        document.body.classList.toggle('sidebar-rail');
        try {
          localStorage.setItem('omnote.sidebarRail',
            document.body.classList.contains('sidebar-rail') ? '1' : '0');
        } catch (_) {}
        return;
      }
      const menu = document.getElementById('sidebar-menu');
      if (menu && menu.classList.contains('active')) closeDrawer();
      else openDrawer();
    };

    try {
      if (localStorage.getItem('omnote.sidebarRail') === '1') {
        document.body.classList.add('sidebar-rail');
      }
    } catch (_) {}

    window.addEventListener('resize', () => { if (isDesktop()) closeDrawer(); });
  }

  // ---------------------------------------------------------------
  // Topbar overflow menu
  // ---------------------------------------------------------------
  function installOverflow() {
    const wrap = document.getElementById('topbar-more');
    const btn = document.getElementById('topbar-more-btn');
    if (!wrap || !btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      wrap.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) wrap.classList.remove('open');
    });
    wrap.querySelectorAll('.btn-icon').forEach((b) => {
      if (b !== btn) b.addEventListener('click', () => wrap.classList.remove('open'));
    });
  }

  // ---------------------------------------------------------------
  // Data helpers (read-only)
  // ---------------------------------------------------------------
  function db() { return window.db || {}; }
  function docs() { return db().documents || []; }
  function rems() { return db().rems || []; }
  function todayISO() { return new Date().toISOString().split('T')[0]; }

  function dueCount() {
    try { return window.srs ? window.srs.dueCountAll() : 0; } catch (_) { return 0; }
  }
  function dueForDoc(id) {
    const now = Date.now();
    return rems().filter((r) => r.isFlashcard && !r.leech && r.docId === id
      && (!r.nextReview || r.nextReview <= now)).length;
  }
  function summary() {
    try { return window.srs ? window.srs.retentionSummary() : {}; } catch (_) { return {}; }
  }
  function streak() {
    try { return window.studyGoals ? window.studyGoals.computeStreak() : 0; } catch (_) { return 0; }
  }
  function weekMinutes() {
    if (!window.studyGoals) return 0;
    let total = 0;
    for (let i = 0; i < 7; i++) {
      const key = new Date(Date.now() - i * DAY).toISOString().split('T')[0];
      try { total += window.studyGoals.minutesForDate(key) || 0; } catch (_) {}
    }
    return total;
  }
  function todayItems() {
    const iso = todayISO();
    return (db().schedule || []).filter((i) => i.date === iso);
  }
  function weakSpots() {
    const byDoc = {};
    rems().forEach((r) => {
      if (!r.isFlashcard) return;
      const bad = (r.lapses || 0) >= 2 || r.leech;
      if (!bad) return;
      byDoc[r.docId] = (byDoc[r.docId] || 0) + 1;
    });
    return Object.entries(byDoc)
      .map(([id, n]) => ({ id, n, title: (docs().find((d) => d.id === id) || {}).title || 'Untitled' }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 5);
  }
  function recentDocs() {
    return docs().slice().sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 4)
      .map((d) => {
        const cards = rems().filter((r) => r.isFlashcard && r.docId === d.id);
        const mastered = cards.filter((r) => (r.interval || 0) >= 21).length;
        const pct = cards.length ? Math.round((mastered / cards.length) * 100) : 0;
        return { doc: d, cards: cards.length, pct, due: dueForDoc(d.id) };
      });
  }

  // ---------------------------------------------------------------
  // Home overview
  // ---------------------------------------------------------------
  function statsHtml() {
    const s = summary();
    const due = dueCount();
    const st = streak();
    const mins = weekMinutes();
    const hrs = mins >= 60 ? (mins / 60).toFixed(1) : null;
    return `
      <div class="dash-stats">
        <button class="dash-stat clickable ${due > 0 ? 'warn' : ''}" onclick="window.startReviewDueAll && window.startReviewDueAll()">
          <div class="dash-stat-label"><i data-lucide="brain"></i> Due today</div>
          <div class="dash-stat-value">${due}<span class="unit"> cards</span></div>
          <div class="dash-stat-hint">${due > 0 ? 'Tap to start reviewing' : 'You are all caught up'}</div>
        </button>
        <div class="dash-stat">
          <div class="dash-stat-label"><i data-lucide="flame"></i> Streak</div>
          <div class="dash-stat-value">${st}<span class="unit"> ${st === 1 ? 'day' : 'days'}</span></div>
          <div class="dash-stat-hint">Consecutive days on target</div>
        </div>
        <div class="dash-stat accent">
          <div class="dash-stat-label"><i data-lucide="check-check"></i> Mastered</div>
          <div class="dash-stat-value">${s.mastered || 0}</div>
          <div class="dash-stat-hint">Cards with 21+ day intervals</div>
        </div>
        <div class="dash-stat">
          <div class="dash-stat-label"><i data-lucide="clock"></i> This week</div>
          <div class="dash-stat-value">${hrs || mins}<span class="unit"> ${hrs ? 'hrs' : 'min'}</span></div>
          <div class="dash-stat-hint">${s.weekReviewed || 0} reviews logged</div>
        </div>
      </div>`;
  }

  function continueHtml() {
    const items = recentDocs();
    if (!items.length) return '';
    return `
      <div class="dash-card">
        <div class="dash-card-title"><i data-lucide="book-open"></i> Continue studying</div>
        <div class="dash-list">
          ${items.map(({ doc, cards, pct, due }) => `
            <div class="dash-row" style="cursor:pointer;" data-doc="${esc(doc.id)}">
              <div class="dash-row-main">
                <div class="dash-row-title">${esc(doc.title || 'Untitled')}</div>
                <div class="dash-row-sub">${pct}% mastered · ${cards} cards</div>
              </div>
              ${due > 0 ? `<span class="dash-chip srs">${due} due</span>` : '<button class="dash-mini-btn">Study</button>'}
            </div>`).join('')}
        </div>
      </div>`;
  }

  function schedulerHtml() {
    const items = (db().schedule || []).sort((a,b) => (a.date || '').localeCompare(b.date || ''));
    const now = todayISO();
    const upcoming = items.filter(i => (i.date || '') >= now).slice(0, 5);
    const rows = upcoming.map(i => {
      let dateText = i.date === now ? 'Today' : i.date;
      return `
        <div class="dash-row">
          <div class="dash-row-main">
            <div class="dash-row-title">${esc(i.title || 'Event')}</div>
            <div class="dash-row-sub">${dateText} ${i.time ? '· ' + esc(i.time) : ''}</div>
          </div>
          <span class="dash-chip ${i.type === 'exam' ? 'exam' : ''}">${i.type === 'exam' ? 'Exam' : 'Study'}</span>
        </div>`;
    });
    
    return `
      <div class="dash-card">
        <div class="dash-card-title" style="justify-content: space-between;">
           <span style="display:flex; align-items:center; gap:8px;"><i data-lucide="calendar-days"></i> Scheduler</span>
           <div style="display:flex; gap:4px;">
               <button class="dash-mini-btn" title="Add Study" onclick="window.openSchedulerAdd && window.openSchedulerAdd('study')"><i data-lucide="book-marked" style="width:14px;height:14px;"></i></button>
               <button class="dash-mini-btn" title="Add Exam" onclick="window.openSchedulerAdd && window.openSchedulerAdd('exam')"><i data-lucide="target" style="width:14px;height:14px;"></i></button>
               <button class="dash-mini-btn" title="Open Calendar" onclick="window.showSchedulerView && window.showSchedulerView()"><i data-lucide="maximize" style="width:14px;height:14px;"></i></button>
           </div>
        </div>
        <div class="dash-list">
          ${rows.length ? rows.join('') : '<div class="dash-empty">Nothing scheduled coming up.</div>'}
        </div>
      </div>`;
  }

  function planHtml() {
    const items = todayItems();
    const due = dueCount();
    const rows = [];
    if (due > 0) {
      rows.push(`
        <div class="dash-row">
          <div class="dash-row-main">
            <div class="dash-row-title">Review ${due} due card${due === 1 ? '' : 's'}</div>
            <div class="dash-row-sub">Spaced repetition queue</div>
          </div>
          <button class="dash-mini-btn" onclick="window.startReviewDueAll && window.startReviewDueAll()">Start</button>
        </div>`);
    }
    items.forEach((i) => {
      rows.push(`
        <div class="dash-row">
          <div class="dash-row-main">
            <div class="dash-row-title">${esc(i.title || 'Study session')}</div>
            <div class="dash-row-sub">${esc(i.time || 'Any time')}${i.duration ? ' · ' + esc(String(i.duration)) + ' min' : ''}</div>
          </div>
          <span class="dash-chip ${i.type === 'exam' ? 'exam' : ''}">${i.type === 'exam' ? 'Exam' : 'Study'}</span>
        </div>`);
    });
    return `
      <div class="dash-card">
        <div class="dash-card-title"><i data-lucide="calendar-check"></i> Today's plan</div>
        <div class="dash-list">
          ${rows.length ? rows.join('') : '<div class="dash-empty">Nothing scheduled for today.</div>'}
        </div>
      </div>`;
  }

  function weakHtml() {
    let spotsHtml = '';
    if (window.radarWeakestSections) {
      const weakSections = window.radarWeakestSections(5).filter(s => s.score < 80); // Only show if score is less than 80
      if (weakSections.length) {
        spotsHtml = weakSections.map(s => `
          <div class="dash-row">
            <div class="dash-row-main">
              <div class="dash-row-title">${esc(s.secTitle)}</div>
              <div class="dash-row-sub">${esc(s.docTitle)} · Score: ${s.score}</div>
            </div>
            <button class="dash-mini-btn" data-doc="${esc(s.docId)}">Drill</button>
          </div>`).join('');
      }
    } else {
      // Fallback
      const spots = weakSpots();
      if (spots.length) {
        spotsHtml = spots.map((s) => `
          <div class="dash-row">
            <div class="dash-row-main">
              <div class="dash-row-title">${esc(s.title)}</div>
              <div class="dash-row-sub">${s.n} struggling card${s.n === 1 ? '' : 's'}</div>
            </div>
            <button class="dash-mini-btn" data-doc="${esc(s.id)}">Drill</button>
          </div>`).join('');
      }
    }

    return `
      <div class="dash-card">
        <div class="dash-card-title"><i data-lucide="radar"></i> Weak spots</div>
        <div class="dash-list">
          ${spotsHtml ? spotsHtml : '<div class="dash-empty">No weak spots yet — keep reviewing.</div>'}
        </div>
      </div>`;
  }

  function renderOverview() {
    const home = document.getElementById('home-view');
    const host = document.getElementById('dash-overview');
    if (!home || !host) return;
    if (!docs().length) { host.innerHTML = ''; return; }

    host.innerHTML = `
      <div class="dash-section">
        <div class="dash-cols">
          ${continueHtml()}
          ${planHtml()}
        </div>
      </div>
      <div class="dash-section">${statsHtml()}</div>
      <div class="dash-section">
        <div class="dash-cols">
          ${schedulerHtml()}
          ${weakHtml()}
        </div>
      </div>`;

    host.querySelectorAll('[data-doc]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-doc');
        if (id && window.switchDocument) window.switchDocument(id);
      });
    });
    icons();
  }
  window.renderDashboardOverview = renderOverview;

  function hookHomeView() {
    const original = window.showHomeView;
    if (typeof original !== 'function') return false;
    if (original.__dashWrapped) return true;
    const wrapped = function () {
      const out = original.apply(this, arguments);
      try { renderOverview(); } catch (e) { console.warn('overview render failed', e); }
      return out;
    };
    wrapped.__dashWrapped = true;
    window.showHomeView = wrapped;
    return true;
  }

  function onReady(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  onReady(() => {
    installSidebar();
    installOverflow();
    if (!hookHomeView()) {
      const t = setInterval(() => { if (hookHomeView()) clearInterval(t); }, 300);
      setTimeout(() => clearInterval(t), 15000);
    }
    // Refresh overview when the home view is visible and data changes.
    setInterval(() => {
      const home = document.getElementById('home-view');
      if (home && home.style.display !== 'none' && document.getElementById('dash-overview')) {
        renderOverview();
      }
    }, 30000);
  });
})();
