// Real Spaced Repetition (SM-2) for OmNote flashcards.
// Pure functions — no Firestore imports. Operates on a card object in place
// (via the returned patch) so the caller can persist through saveDb().
(function () {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const LEECH_THRESHOLD = 8;

    function ensureSrs(card) {
        if (!card) return;
        if (typeof card.ease !== 'number') card.ease = 2.5;
        if (typeof card.interval !== 'number') card.interval = 0;
        if (typeof card.reps !== 'number') card.reps = 0;
        if (typeof card.lapses !== 'number') card.lapses = 0;
        if (typeof card.nextReview !== 'number') card.nextReview = 0; // 0 => new / due now
        if (typeof card.leech !== 'boolean') card.leech = false;
    }

    // Apply SM-2 to a card in place based on a rating.
    // rating: 'again' (0) | 'hard' (3) | 'good' (4) | 'easy' (5)
    function gradeCard(card, rating, now) {
        ensureSrs(card);
        now = now || Date.now();
        const q = rating === 'again' ? 0 : rating === 'hard' ? 3 : rating === 'easy' ? 5 : 4;

        if (q < 3) {
            // Lapse — re-queue soon, reset interval, drop ease.
            card.reps = 0;
            card.lapses = (card.lapses || 0) + 1;
            card.interval = 0;
            card.ease = Math.max(1.3, (card.ease || 2.5) - 0.2);
            card.nextReview = now + 10 * 60 * 1000; // 10 min
            if (card.lapses >= LEECH_THRESHOLD) card.leech = true;
        } else {
            card.reps = (card.reps || 0) + 1;
            const modifier = q === 3 ? 1.2 : q === 5 ? 1.3 : 1.0;
            let nextInterval;
            if (card.reps === 1) nextInterval = 1;
            else if (card.reps === 2) nextInterval = 6;
            else nextInterval = Math.max(1, Math.round((card.interval || 1) * (card.ease || 2.5) * modifier));
            card.interval = nextInterval;
            // SM-2 ease update
            const delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
            card.ease = Math.max(1.3, (card.ease || 2.5) + delta);
            card.nextReview = now + nextInterval * DAY_MS;
        }
        card.lastReviewed = now;
    }

    function isDue(card, now) {
        if (!card || !card.isFlashcard) return false;
        if (card.leech) return false; // suspended until user unflags
        now = now || Date.now();
        // New cards (nextReview undefined / 0) are due immediately.
        return !card.nextReview || card.nextReview <= now;
    }

    function daysUntil(card) {
        if (!card || !card.nextReview) return 0;
        const diff = card.nextReview - Date.now();
        if (diff <= 0) return 0;
        return Math.max(1, Math.round(diff / DAY_MS));
    }

    // Human-readable "next review in …" label.
    function nextReviewLabel(card) {
        if (!card) return '';
        if (!card.nextReview || card.nextReview <= Date.now()) return 'due now';
        const diff = card.nextReview - Date.now();
        const mins = Math.round(diff / 60000);
        if (mins < 60) return `in ${mins}m`;
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return `in ${hrs}h`;
        const days = Math.round(hrs / 24);
        return `in ${days}d`;
    }

    // Build the due queue across every doc.
    function buildDueQueueAll() {
        if (!window.db || !Array.isArray(window.db.rems)) return [];
        const now = Date.now();
        const due = window.db.rems.filter(r => r.isFlashcard && !r.leech && isDue(r, now));
        // Randomize order so the same doc doesn't dominate.
        for (let i = due.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [due[i], due[j]] = [due[j], due[i]];
        }
        return due;
    }

    function dueCountAll() {
        if (!window.db || !Array.isArray(window.db.rems)) return 0;
        const now = Date.now();
        let c = 0;
        for (const r of window.db.rems) if (r.isFlashcard && !r.leech && isDue(r, now)) c++;
        return c;
    }

    // Log a grade into a per-day rollup for the Stats page.
    function logGrade(rating) {
        if (!window.db) return;
        if (!window.db.srsStats) window.db.srsStats = {};
        const today = new Date().toISOString().split('T')[0];
        const day = window.db.srsStats[today] || { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 };
        day.reviewed++;
        if (day[rating] !== undefined) day[rating]++;
        window.db.srsStats[today] = day;
    }

    function retentionSummary() {
        const stats = (window.db && window.db.srsStats) || {};
        const today = new Date().toISOString().split('T')[0];
        const t = stats[today] || { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 };
        // Last 7 days
        let reviewed = 0, remembered = 0;
        const cutoff = Date.now() - 7 * DAY_MS;
        for (const [k, v] of Object.entries(stats)) {
            const ts = new Date(k + 'T00:00:00').getTime();
            if (isNaN(ts) || ts < cutoff) continue;
            reviewed += v.reviewed || 0;
            remembered += (v.good || 0) + (v.easy || 0);
        }
        const retention = reviewed > 0 ? Math.round((remembered / reviewed) * 100) : null;
        const rems = (window.db && window.db.rems) || [];
        const mastered = rems.filter(r => r.isFlashcard && (r.interval || 0) >= 21).length;
        const leeches = rems.filter(r => r.isFlashcard && r.leech).length;
        return { todayReviewed: t.reviewed || 0, weekReviewed: reviewed, retention, mastered, leeches };
    }

    window.srs = {
        ensureSrs, gradeCard, isDue, daysUntil, nextReviewLabel,
        buildDueQueueAll, dueCountAll, logGrade, retentionSummary,
        LEECH_THRESHOLD
    };

    // Convenience for other modules already calling this name.
    window.updateSRSQueue = window.updateSRSQueue || function () {
        // refresh sidebar "Review Due" badge if present
        const badge = document.getElementById('review-due-badge');
        if (badge) {
            const n = window.srs.dueCountAll();
            badge.textContent = n;
            badge.style.display = n > 0 ? 'inline-flex' : 'none';
        }
    };
})();
