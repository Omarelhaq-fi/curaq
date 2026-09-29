// Pomodoro Timer + Stats — floating pill widget + full modal
(function () {
    const DEFAULTS = {
        focusMin: 25,
        shortMin: 5,
        longMin: 15,
        longEvery: 4,
        autoStart: false,
        sound: true,
    };

    const state = {
        settings: { ...DEFAULTS },
        sessions: [],           // { startedAt, minutes, docId, docTitle }
        loaded: false,
        phase: 'focus',         // 'focus' | 'short' | 'long'
        running: false,
        secondsLeft: DEFAULTS.focusMin * 60,
        totalSeconds: DEFAULTS.focusMin * 60,
        completedFocus: 0,      // completed focus sessions in current cycle
        interval: null,
        startedAt: null,        // ms timestamp when the current focus phase started
    };

    const RING_R = 88;
    const RING_C = 2 * Math.PI * RING_R;

    // ---------------- Firestore ----------------
    function fs() {
        return (typeof fsdb !== 'undefined') ? fsdb : (window.fsdb || null);
    }
    function uid() {
        try { return firebase.auth().currentUser && firebase.auth().currentUser.uid; }
        catch { return null; }
    }

    async function loadFromCloud() {
        const db = fs(); const u = uid();
        if (!db || !u) return;
        try {
            const snap = await db.collection('users').doc(u).collection('meta').doc('pomodoro').get();
            if (snap.exists) {
                const d = snap.data() || {};
                if (d.settings) state.settings = { ...DEFAULTS, ...d.settings };
                if (Array.isArray(d.sessions)) state.sessions = d.sessions;
                else if (typeof d.sessionsJson === 'string') {
                    try { state.sessions = JSON.parse(d.sessionsJson) || []; } catch { state.sessions = []; }
                }
            }
        } catch (e) { console.warn('Pomo load failed', e); }
        state.loaded = true;
        window._pomoSessions = state.sessions;
        applySettingsToState();
        renderAll();
        try { window.updateStreakChip && window.updateStreakChip(); } catch {}
        try { window.renderGoalsCard && window.renderGoalsCard(); } catch {}
    }

    async function saveSettings() {
        const db = fs(); const u = uid();
        if (!db || !u) return;
        try {
            await db.collection('users').doc(u).collection('meta').doc('pomodoro').set({
                settings: state.settings,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
        } catch (e) { console.warn('Pomo save settings failed', e); }
    }

    async function saveSessions() {
        window._pomoSessions = state.sessions;
        try { window.updateStreakChip && window.updateStreakChip(); } catch {}
        try { window.renderGoalsCard && window.renderGoalsCard(); } catch {}
        const db = fs(); const u = uid();
        if (!db || !u) return;
        try {
            // Keep last 500 sessions
            const trimmed = state.sessions.slice(-500);
            await db.collection('users').doc(u).collection('meta').doc('pomodoro').set({
                sessionsJson: JSON.stringify(trimmed),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
        } catch (e) { console.warn('Pomo save sessions failed', e); }
    }

    // ---------------- Core timer ----------------
    function applySettingsToState() {
        if (!state.running) {
            state.totalSeconds = phaseSeconds(state.phase);
            state.secondsLeft = state.totalSeconds;
        }
    }
    function phaseSeconds(p) {
        if (p === 'short') return state.settings.shortMin * 60;
        if (p === 'long') return state.settings.longMin * 60;
        return state.settings.focusMin * 60;
    }
    function phaseLabel(p) {
        if (p === 'short') return 'Short Break';
        if (p === 'long') return 'Long Break';
        return 'Focus';
    }
    function fmt(sec) {
        sec = Math.max(0, Math.floor(sec));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function tick() {
        state.secondsLeft -= 1;
        if (state.secondsLeft <= 0) {
            onPhaseComplete();
            return;
        }
        renderTimer();
    }

    function start() {
        if (state.running) return;
        state.running = true;
        if (state.phase === 'focus' && !state.startedAt) {
            state.startedAt = Date.now();
        }
        state.interval = setInterval(tick, 1000);
        renderAll();
    }
    function pause() {
        if (!state.running) return;
        state.running = false;
        clearInterval(state.interval);
        state.interval = null;
        renderAll();
    }
    function reset() {
        logPartialFocus();
        pause();
        state.startedAt = null;
        state.totalSeconds = phaseSeconds(state.phase);
        state.secondsLeft = state.totalSeconds;
        renderAll();
    }

    function goToPhase(p) {
        state.phase = p;
        state.totalSeconds = phaseSeconds(p);
        state.secondsLeft = state.totalSeconds;
        state.startedAt = null;
    }

    // Log any partial focus minutes (>=1) when a focus phase is interrupted
    // (skip, reset, tab close/refresh). Prevents lost studied time.
    function logPartialFocus() {
        if (state.phase !== 'focus') return;
        if (!state.startedAt) return;
        const elapsedSec = Math.max(0, (state.totalSeconds || 0) - (state.secondsLeft || 0));
        const minutes = Math.floor(elapsedSec / 60);
        if (minutes < 1) { state.startedAt = null; return; }
        const doc = (window.getActiveDoc && window.getActiveDoc()) || null;
        state.sessions.push({
            startedAt: state.startedAt || Date.now(),
            minutes,
            partial: true,
            docId: doc ? (doc.id || doc.docId || null) : null,
            docTitle: doc ? (doc.title || doc.name || 'Untitled') : null,
        });
        state.startedAt = null;
        saveSessions();
    }

    function onPhaseComplete() {
        pause();
        chime();
        if (state.phase === 'focus') {
            // Log completed focus session
            const minutes = Math.round(phaseSeconds('focus') / 60);
            const doc = (window.getActiveDoc && window.getActiveDoc()) || null;
            state.sessions.push({
                startedAt: state.startedAt || Date.now(),
                minutes,
                docId: doc ? (doc.id || doc.docId || null) : null,
                docTitle: doc ? (doc.title || doc.name || 'Untitled') : null,
            });
            state.startedAt = null;
            saveSessions();
            state.completedFocus += 1;
            const next = (state.completedFocus % state.settings.longEvery === 0) ? 'long' : 'short';
            goToPhase(next);
        } else {
            goToPhase('focus');
        }
        renderAll();
        if (state.settings.autoStart) start();
        notify(`${phaseLabel(state.phase)} started`);
    }

    function skip() {
        // Skip current phase — log any partial focus minutes so time isn't lost
        logPartialFocus();
        pause();
        if (state.phase === 'focus') {
            const next = ((state.completedFocus + 1) % state.settings.longEvery === 0) ? 'long' : 'short';
            goToPhase(next);
        } else {
            goToPhase('focus');
        }
        renderAll();
    }

    // Save partial focus time on tab close / refresh / navigation
    window.addEventListener('beforeunload', () => {
        try { logPartialFocus(); } catch {}
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && state.running && state.phase === 'focus') {
            // Persist a snapshot; keep timer running for when tab returns
            try { logPartialFocusSnapshot(); } catch {}
        }
    });

    // Snapshot variant that logs partial minutes without resetting startedAt,
    // and shifts startedAt forward so we don't double-count on next flush.
    function logPartialFocusSnapshot() {
        if (state.phase !== 'focus' || !state.startedAt) return;
        const elapsedSec = Math.max(0, (state.totalSeconds || 0) - (state.secondsLeft || 0));
        const minutes = Math.floor(elapsedSec / 60);
        if (minutes < 1) return;
        const doc = (window.getActiveDoc && window.getActiveDoc()) || null;
        state.sessions.push({
            startedAt: state.startedAt,
            minutes,
            partial: true,
            docId: doc ? (doc.id || doc.docId || null) : null,
            docTitle: doc ? (doc.title || doc.name || 'Untitled') : null,
        });
        // Advance startedAt & totalSeconds baseline so remaining time won't be re-logged
        state.startedAt = Date.now();
        state.totalSeconds = state.secondsLeft;
        saveSessions();
    }


    function chime() {
        if (!state.settings.sound) return;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'sine'; o.frequency.value = 660;
            g.gain.value = 0.001;
            o.connect(g); g.connect(ctx.destination);
            const now = ctx.currentTime;
            g.gain.linearRampToValueAtTime(0.15, now + 0.03);
            g.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
            o.start(now); o.stop(now + 1);
        } catch {}
    }

    function notify(msg) {
        try {
            if ('Notification' in window && Notification.permission === 'granted') {
                new Notification('OmNote Pomodoro', { body: msg });
            }
        } catch {}
    }

    // ---------------- Rendering ----------------
    function renderPill() {
        if (window.StudyParty && window.StudyParty.isInParty()) return;
        const time = document.getElementById('pomo-pill-time');
        const play = document.getElementById('pomo-pill-play');
        const pill = document.getElementById('pomo-pill');
        if (!time || !play || !pill) return;
        if (state.running) {
            time.textContent = fmt(state.secondsLeft);
            play.textContent = '⏸';
            pill.classList.add('running');
        } else {
            time.textContent = state.secondsLeft === state.totalSeconds && state.phase === 'focus' && !state.startedAt
                ? 'Pomodoro'
                : fmt(state.secondsLeft);
            play.textContent = '▶';
            pill.classList.remove('running');
        }
        pill.classList.remove('phase-focus','phase-short','phase-long');
        pill.classList.add('phase-' + state.phase);

        // Browser tab title
        if (window.__omnoteOcrRunning) {
            return;
        }
        if (state.running) {
            document.title = `⏱ ${fmt(state.secondsLeft)} — ${phaseLabel(state.phase)}`;
        } else if (document.title.startsWith('⏱')) {
            document.title = 'OmNote — Intelligent Learning Platform';
        }
    }

    function renderTimer() {
        if (window.StudyParty && window.StudyParty.isInParty()) return;
        renderPill();
        const bigTime = document.getElementById('pomo-big-time');
        const info = document.getElementById('pomo-session-info');
        const badge = document.getElementById('pomo-phase-badge');
        const ring = document.getElementById('pomo-ring-big-fg');
        const mainBtn = document.getElementById('pomo-main-btn');
        const docInfo = document.getElementById('pomo-doc-info');

        if (bigTime) bigTime.textContent = fmt(state.secondsLeft);
        if (info) {
            const idx = (state.completedFocus % state.settings.longEvery) + (state.phase === 'focus' ? 1 : 0);
            const cur = Math.min(state.settings.longEvery, Math.max(1, idx));
            info.textContent = `Session ${cur} of ${state.settings.longEvery}`;
        }
        if (badge) {
            badge.textContent = phaseLabel(state.phase);
            badge.className = 'pomo-phase-badge phase-' + state.phase;
        }
        if (ring) {
            const pct = state.totalSeconds > 0 ? (state.secondsLeft / state.totalSeconds) : 1;
            ring.style.strokeDasharray = RING_C;
            ring.style.strokeDashoffset = RING_C * (1 - pct);
        }
        if (mainBtn) mainBtn.textContent = state.running ? 'Pause' : 'Start';
        if (docInfo) {
            const doc = window.getActiveDoc && window.getActiveDoc();
            docInfo.textContent = doc ? `Studying: ${doc.title || doc.name || 'Untitled'}` : '';
        }
    }

    function renderSettings() {
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
        set('pomo-set-focus', state.settings.focusMin);
        set('pomo-set-short', state.settings.shortMin);
        set('pomo-set-long', state.settings.longMin);
        set('pomo-set-every', state.settings.longEvery);
        chk('pomo-set-autostart', state.settings.autoStart);
        chk('pomo-set-sound', state.settings.sound);
    }

    function renderStats(scope) {
        const IDS = scope === 'page'
            ? { today: 'stats-today', week: 'stats-week', total: 'stats-total', streak: 'stats-streak', count: 'stats-count', chart: 'stats-chart', perDoc: 'stats-per-doc' }
            : { today: 'pomo-stat-today', week: 'pomo-stat-week', total: 'pomo-stat-total', streak: 'pomo-stat-streak', count: 'pomo-stat-count', chart: 'pomo-chart', perDoc: 'pomo-per-doc' };

        const now = new Date();
        const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const weekAgo = today0 - 6 * 86400000;
        let today = 0, week = 0, total = 0;
        const perDay = new Array(7).fill(0);
        const perDoc = new Map();

        state.sessions.forEach(s => {
            total += s.minutes;
            const t = s.startedAt || 0;
            if (t >= today0) today += s.minutes;
            if (t >= weekAgo) {
                week += s.minutes;
                const d = new Date(t);
                const day0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
                const idx = Math.floor((day0 - weekAgo) / 86400000);
                if (idx >= 0 && idx < 7) perDay[idx] += s.minutes;
            }
            if (s.docTitle) {
                perDoc.set(s.docTitle, (perDoc.get(s.docTitle) || 0) + s.minutes);
            }
        });

        const fmtMin = (m) => m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`;
        const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        setTxt(IDS.today, fmtMin(today));
        setTxt(IDS.week, fmtMin(week));
        setTxt(IDS.total, fmtMin(total));
        setTxt(IDS.count, String(state.sessions.length));

        let streak = 0;
        const daySet = new Set(state.sessions.map(s => {
            const d = new Date(s.startedAt || 0);
            return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        }));
        let cursor = today0;
        if (!daySet.has(cursor)) cursor -= 86400000;
        while (daySet.has(cursor)) { streak++; cursor -= 86400000; }
        setTxt(IDS.streak, `${streak} day${streak === 1 ? '' : 's'}`);

        const chart = document.getElementById(IDS.chart);
        if (chart) {
            const max = Math.max(1, ...perDay);
            const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
            chart.innerHTML = perDay.map((v, i) => {
                const d = new Date(weekAgo + i * 86400000);
                const h = Math.round((v / max) * 100);
                return `<div class="pomo-bar-col">
                    <div class="pomo-bar-val">${v || ''}</div>
                    <div class="pomo-bar" style="height:${Math.max(4, h)}%"></div>
                    <div class="pomo-bar-lbl">${dayNames[d.getDay()]}</div>
                </div>`;
            }).join('');
        }

        const perDocEl = document.getElementById(IDS.perDoc);
        if (perDocEl) {
            const sorted = Array.from(perDoc.entries()).sort((a,b)=>b[1]-a[1]).slice(0, scope === 'page' ? 10 : 5);
            if (sorted.length === 0) {
                perDocEl.innerHTML = '<div class="pomo-empty">No study sessions logged yet.</div>';
            } else {
                const maxV = sorted[0][1] || 1;
                perDocEl.innerHTML = sorted.map(([title, mins]) => `
                    <div class="pomo-doc-row">
                        <div class="pomo-doc-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
                        <div class="pomo-doc-bar-wrap"><div class="pomo-doc-bar" style="width:${(mins/maxV)*100}%"></div></div>
                        <div class="pomo-doc-mins">${fmtMin(mins)}</div>
                    </div>
                `).join('');
            }
        }
    }
    window.renderPomoStats = renderStats;


    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function renderAll() {
        renderTimer();
        renderSettings();
        renderStats();
    }

    // ---------------- Modal ----------------
    window.openPomoModal = function () {
        const m = document.getElementById('pomo-modal');
        if (!m) return;
        m.style.display = 'flex';
        renderAll();
        if ('Notification' in window && Notification.permission === 'default') {
            try { Notification.requestPermission(); } catch {}
        }
    };
    window.closePomoModal = function () {
        const m = document.getElementById('pomo-modal');
        if (m) m.style.display = 'none';
    };
    window.switchPomoTab = function (tab) {
        document.querySelectorAll('.pomo-tab').forEach(b => b.classList.toggle('active', b.dataset.pomoTab === tab));
        document.querySelectorAll('.pomo-panel').forEach(p => p.classList.toggle('active', p.dataset.pomoPanel === tab));
        if (tab === 'stats') renderStats();
        if (tab === 'settings') renderSettings();
        if (tab === 'timer') renderTimer();
    };

    // ---------------- Full-page Stats View ----------------
    window.showStatsView = function () {
        const home = document.getElementById('home-view');
        const ws = document.getElementById('workspace');
        const sv = document.getElementById('scheduler-view');
        const stv = document.getElementById('stats-view');
        const rv = document.getElementById('recall-view');
        if (home) home.style.display = 'none';
        if (ws) ws.style.display = 'none';
        if (sv) sv.style.display = 'none';
        if (rv) rv.style.display = 'none';
        if (stv) stv.style.display = 'block';
        document.body.classList.remove('doc-open');
        document.body.classList.remove('scheduler-open');
        document.body.classList.remove('recall-open');
        document.body.classList.add('stats-open');

        const topGroup = document.getElementById('top-doc-title-group');
        if (topGroup) topGroup.style.display = 'none';
        const navTabs = document.getElementById('main-nav-tabs');
        if (navTabs) navTabs.style.display = 'none';

        // Free plan: still show real stats so users can see their progress,
        // but pin a small upgrade banner at the top of the view.
        const shell = stv ? stv.querySelector('.sched-shell') : null;
        if (shell) {
            const existing = shell.querySelector('#stats-free-banner');
            if (window.isFreePlan && window.isFreePlan()) {
                if (!existing) {
                    const banner = document.createElement('div');
                    banner.id = 'stats-free-banner';
                    banner.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 16px;margin:0 0 16px;border-radius:14px;background:linear-gradient(135deg,rgba(6,182,212,0.14),rgba(139,92,246,0.14));border:1px solid rgba(139,92,246,0.35);font-size:0.85rem;';
                    banner.innerHTML = `
                        <div style="font-size:1.3rem;color:var(--text-primary);"><i data-lucide="bar-chart-3"></i></div>
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:700;color:var(--text-primary);">You're on the Free preview</div>
                            <div style="color:var(--text-muted);font-size:0.78rem;margin-top:2px;">You can see today, this week, and top docs. Become a Supporter for full history, custom goals, and streak insights.</div>
                        </div>
                        <button onclick="window.showUpgradeModal && window.showUpgradeModal('pro_required')" style="background:linear-gradient(90deg,#06b6d4,#8b5cf6);border:none;color:#fff;padding:8px 14px;border-radius:10px;font-weight:700;font-size:0.78rem;cursor:pointer;white-space:nowrap;">Become a Supporter</button>`;
                    shell.insertBefore(banner, shell.firstChild.nextSibling);
                }
            } else if (existing) {
                existing.remove();
            }
        }

        renderStats('page');
        try { window.renderGoalsCard && window.renderGoalsCard(); } catch {}
        try { window.updateStreakChip && window.updateStreakChip(); } catch {}
    };

    // ---------------- Exposed controls ----------------
    window.togglePomo = function () { 
        if (window.StudyParty && window.StudyParty.isInParty()) {
            window.StudyParty.togglePartyState();
            return;
        }
        // Lazy cloud load: the boot-time fetch is skipped when the timer
        // UI isn't on the page, so pull state on first real use instead.
        try { if (!state.loaded) loadFromCloud(); } catch (_) {}
        state.running ? pause() : start(); 
    };
    window.resetPomo = function () { reset(); };
    window.skipPomo = function () { skip(); };
    window.toggleTimer = window.togglePomo; // back-compat

    window.savePomoSettings = async function () {
        const val = (id, dflt) => {
            const el = document.getElementById(id);
            const n = el ? parseInt(el.value, 10) : dflt;
            return Number.isFinite(n) && n > 0 ? n : dflt;
        };
        const chk = (id) => { const el = document.getElementById(id); return !!(el && el.checked); };
        state.settings = {
            focusMin: val('pomo-set-focus', 25),
            shortMin: val('pomo-set-short', 5),
            longMin: val('pomo-set-long', 15),
            longEvery: val('pomo-set-every', 4),
            autoStart: chk('pomo-set-autostart'),
            sound: chk('pomo-set-sound'),
        };
        applySettingsToState();
        renderAll();
        await saveSettings();
        const btn = document.querySelector('.pomo-form-actions .primary');
        if (btn) {
            const orig = btn.innerHTML;
            btn.innerHTML = 'Saved <i data-lucide="check"></i>';
            try { window.lucide && window.lucide.createIcons(); } catch(e){}
            setTimeout(() => btn.innerHTML = orig, 1200);
        }
    };
    window.resetPomoSettings = function () {
        state.settings = { ...DEFAULTS };
        applySettingsToState();
        renderAll();
    };

    // ---------------- Init ----------------
    function init() {
        applySettingsToState();
        renderAll();
        // Wait for auth then load — but ONLY when the timer UI actually
        // exists on the page. Otherwise this is 1 wasted Firestore read
        // on every boot for a dormant feature.
        try {
            firebase.auth().onAuthStateChanged(u => {
                if (u && document.getElementById('pomo-pill')) loadFromCloud();
            });
        } catch {}
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
