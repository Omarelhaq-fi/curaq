// What's New — shows a one-time patch notes modal to the user.
(function () {
    const VERSION = '2026.07.18';
    const STORAGE_KEY = 'omnote_whatsnew_seen_' + VERSION;

    const FEATURES = [
        { icon: '<i data-lucide="calendar-days"></i>', title: 'Scheduler', desc: 'Plan study sessions and exams on a glassmorphic monthly calendar with day details and upcoming events.' },
        { icon: '<i data-lucide="bar-chart-3"></i>', title: 'Full Stats Page', desc: 'A dedicated Study Stats view with focus insights, 7-day charts, streaks, and per-document totals.' },
        { icon: '<i data-lucide="timer"></i>', title: 'Pomodoro Timer', desc: 'Focus/break sessions with custom durations, synced to Firestore. Partial time is saved even on skip, reset, or refresh.' },
        { icon: '<i data-lucide="globe"></i>', title: 'Interface Language', desc: 'Full UI translation (English, Arabic RTL, Spanish, French) — separate from AI content language.' },
        { icon: '<i data-lucide="graduation-cap"></i>', title: 'AI Tutor Redesign', desc: 'Modernized chat with quick suggestion chips (Summarize, Explain Simply, Quiz me) and Enter-to-send.' },
        { icon: '<i data-lucide="user"></i>', title: 'Profile Circle', desc: 'Quick access to profile settings from the topbar with your avatar or initial.' },
        { icon: '<i data-lucide="lightbulb"></i>', title: 'Smart Popovers on PDFs', desc: 'Select text directly on PDFs to trigger Explain / Add Card — with smart flip positioning to stay in view.' },
    ];

    function esc(s) {
        return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function hasSeen() {
        try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { return false; }
    }
    function markSeen() {
        try { localStorage.setItem(STORAGE_KEY, '1'); } catch (e) {}
        const btn = document.getElementById('whatsnew-btn');
        if (btn) btn.classList.remove('has-update');
    }

    function ensureModal() {
        if (document.getElementById('whatsnew-modal')) return;
        const wrap = document.createElement('div');
        wrap.className = 'modal';
        wrap.id = 'whatsnew-modal';
        wrap.innerHTML = `
            <div class="modal-content whatsnew-modal">
                <div class="whatsnew-header">
                    <div class="whatsnew-badge"><i data-lucide="sparkles"></i> What's New</div>
                    <h2 class="whatsnew-title">Fresh updates in OmNote</h2>
                    <p class="whatsnew-sub">Version ${esc(VERSION)} · here's everything we've shipped recently.</p>
                </div>
                <div class="whatsnew-list">
                    ${FEATURES.map(f => `
                        <div class="whatsnew-item">
                            <div class="whatsnew-ico">${f.icon}</div>
                            <div class="whatsnew-body">
                                <div class="whatsnew-item-title">${esc(f.title)}</div>
                                <div class="whatsnew-item-desc">${esc(f.desc)}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <div class="whatsnew-actions">
                    <button class="btn-primary whatsnew-close" onclick="window.closeWhatsNew()">Got it — thanks!</button>
                </div>
            </div>`;
        document.body.appendChild(wrap);
        wrap.addEventListener('click', (e) => { if (e.target === wrap) window.closeWhatsNew(); });
    }

    window.openWhatsNew = function () {
        ensureModal();
        const m = document.getElementById('whatsnew-modal');
        if (m) m.classList.add('active');
    };
    window.closeWhatsNew = function () {
        const m = document.getElementById('whatsnew-modal');
        if (m) m.classList.remove('active');
        markSeen();
    };

    function initButton() {
        const btn = document.getElementById('whatsnew-btn');
        if (!btn) return;
        if (!hasSeen()) btn.classList.add('has-update');
    }

    document.addEventListener('DOMContentLoaded', initButton);

})();
