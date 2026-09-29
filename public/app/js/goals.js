// Study Goals & Streaks — extends db.studyStats with a daily focus target,
// computes streaks based on days where the goal was met, exposes helpers
// used by the Stats view and sidebar chip.
(function () {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const DEFAULT_GOAL_MIN = 30;

    function fs() { return (typeof fsdb !== 'undefined') ? fsdb : (window.fsdb || null); }
    function uid() { try { return firebase.auth().currentUser?.uid; } catch { return null; } }
    function persistDb() {
        if (window.firebase && firebase.auth().currentUser && window.syncDbToCloud && window.db) {
            window.syncDbToCloud(window.db);
        }
    }

    function ensureGoals() {
        if (!window.db) return null;
        if (!window.db.goals) {
            window.db.goals = {
                dailyFocusMin: DEFAULT_GOAL_MIN,
                weeklyReviewCount: 50,
            };
        }
        return window.db.goals;
    }

    // Minutes focused today from pomodoro sessions (accessed via window state) OR from db.studyStats
    function minutesForDate(dateKey) {
        // Aggregate from Pomodoro sessions stored on window (if timer.js exposed) OR use studyStats fallback
        let mins = 0;
        try {
            const sessions = window._pomoSessions || [];
            for (const s of sessions) {
                const key = new Date(s.startedAt).toISOString().split('T')[0];
                if (key === dateKey) mins += (s.minutes || 0);
            }
        } catch {}
        if (mins > 0) return mins;
        const stats = (window.db && window.db.studyStats) || {};
        return stats[dateKey]?.minutes || 0;
    }

    function todayKey() { return new Date().toISOString().split('T')[0]; }

    function computeStreak() {
        const goals = ensureGoals();
        if (!goals) return 0;
        const target = goals.dailyFocusMin || DEFAULT_GOAL_MIN;
        let streak = 0;
        const now = new Date();
        // Start from today; if today not met yet, still count backwards from yesterday.
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        // Check today first
        const todayMins = minutesForDate(start.toISOString().split('T')[0]);
        let cursor = new Date(start);
        if (todayMins >= target) { streak = 1; cursor = new Date(start.getTime() - DAY_MS); }
        else { cursor = new Date(start.getTime() - DAY_MS); }
        // Walk backwards
        for (let i = 0; i < 365; i++) {
            const k = cursor.toISOString().split('T')[0];
            if (minutesForDate(k) >= target) { streak++; cursor = new Date(cursor.getTime() - DAY_MS); }
            else break;
        }
        return streak;
    }

    function todayProgress() {
        const goals = ensureGoals();
        const target = goals?.dailyFocusMin || DEFAULT_GOAL_MIN;
        const mins = minutesForDate(todayKey());
        return { mins, target, pct: Math.min(100, Math.round((mins / target) * 100)) };
    }

    function weekReviewCount() {
        const stats = (window.db && window.db.srsStats) || {};
        const cutoff = Date.now() - 7 * DAY_MS;
        let n = 0;
        for (const [k, v] of Object.entries(stats)) {
            const ts = new Date(k + 'T00:00:00').getTime();
            if (isNaN(ts) || ts < cutoff) continue;
            n += v.reviewed || 0;
        }
        return n;
    }

    window.studyGoals = {
        ensureGoals, computeStreak, todayProgress, weekReviewCount, minutesForDate, todayKey,
    };

    window.openGoalsEditor = function () {
        if (window.gatePaidOnly && !window.gatePaidOnly('Custom study goals',
            'Editing daily focus target and weekly review goals is a Pro feature. Free users have a default 30-minute daily goal.')) return;
        const g = ensureGoals();
        const modal = document.getElementById('goals-modal');
        if (!modal) return;
        document.getElementById('goal-daily-input').value = g.dailyFocusMin;
        document.getElementById('goal-weekly-input').value = g.weeklyReviewCount;
        modal.classList.add('active');
    };
    window.saveGoals = function () {
        const g = ensureGoals();
        const d = parseInt(document.getElementById('goal-daily-input').value, 10);
        const w = parseInt(document.getElementById('goal-weekly-input').value, 10);
        if (Number.isFinite(d) && d > 0) g.dailyFocusMin = d;
        if (Number.isFinite(w) && w > 0) g.weeklyReviewCount = w;
        persistDb();
        window.closeModal && window.closeModal('goals-modal');
        window.renderGoalsCard && window.renderGoalsCard();
        window.updateStreakChip && window.updateStreakChip();
    };

    window.renderGoalsCard = function () {
        const card = document.getElementById('goals-card');
        if (!card) return;
        const g = ensureGoals();
        const t = todayProgress();
        const streak = computeStreak();
        const wr = weekReviewCount();
        const wpct = Math.min(100, Math.round((wr / (g.weeklyReviewCount || 1)) * 100));
        card.innerHTML = `
            <div class="goals-head">
                <div>
                    <div class="goals-title"><i data-lucide="target"></i> Study Goals</div>
                    <div class="goals-sub">Daily focus target & weekly reviews</div>
                </div>
                <button class="btn-action" onclick="window.openGoalsEditor()"><i data-lucide="pencil"></i> Edit</button>
            </div>
            <div class="goals-grid">
                <div class="goal-tile">
                    <div class="goal-tile-label"><i data-lucide="flame"></i> Streak</div>
                    <div class="goal-tile-value">${streak} <span class="goal-tile-unit">${streak === 1 ? 'day' : 'days'}</span></div>
                    <div class="goal-tile-hint">Hit ${g.dailyFocusMin}m every day to grow it</div>
                </div>
                <div class="goal-tile">
                    <div class="goal-tile-label"><i data-lucide="book-open"></i> Today</div>
                    <div class="goal-tile-value">${t.mins} <span class="goal-tile-unit">/ ${t.target}m</span></div>
                    <div class="goal-bar"><div class="goal-bar-fill ${t.pct >= 100 ? 'done' : ''}" style="width:${t.pct}%;"></div></div>
                </div>
                <div class="goal-tile">
                    <div class="goal-tile-label"><i data-lucide="brain"></i> This week's reviews</div>
                    <div class="goal-tile-value">${wr} <span class="goal-tile-unit">/ ${g.weeklyReviewCount}</span></div>
                    <div class="goal-bar"><div class="goal-bar-fill ${wpct >= 100 ? 'done' : ''}" style="width:${wpct}%;"></div></div>
                </div>
            </div>`;
        if (window.lucide) window.lucide.createIcons();
    };

    window.updateStreakChip = function () {
        const chip = document.getElementById('streak-chip');
        if (!chip) return;
        const streak = computeStreak();
        if (streak > 0) {
            chip.style.display = 'inline-flex';
            chip.innerHTML = `<i data-lucide="flame" style="width:16px; height:16px; color:#f59e0b;"></i> <strong style="margin:0 6px;">${streak}</strong> day${streak === 1 ? '' : 's'}`;
            if (window.lucide) window.lucide.createIcons();
        } else {
            chip.style.display = 'none';
        }
    };

    // Hook into stats view refresh
    const origShowStats = window.showStatsView;
    if (origShowStats) {
        window.showStatsView = function () {
            origShowStats.apply(this, arguments);
            setTimeout(() => { window.renderGoalsCard && window.renderGoalsCard(); }, 50);
        };
    }
    // Update chip periodically
    setInterval(() => { try { window.updateStreakChip && window.updateStreakChip(); } catch {} }, 60_000);
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => { window.updateStreakChip && window.updateStreakChip(); }, 2000);
    });
})();
