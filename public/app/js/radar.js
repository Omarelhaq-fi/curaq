// Weak Spot Radar — mastery heatmap, "Today's 5" drill, forgetting-curve forecast,
// weakest topics and an AI-written weekly insight.
// Pure client-side scoring on top of window.db.rems (SRS flashcards) and
// doc.recallBank (recall prompts) — no schema changes.
(function () {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const WEEK_MS = 7 * DAY_MS;
    const INSIGHT_KEY = 'omnote.radar.weeklyInsight';
    function loadInsight() {
        try { return JSON.parse(localStorage.getItem(INSIGHT_KEY) || 'null'); } catch { return null; }
    }
    function saveInsight(v) {
        try { localStorage.setItem(INSIGHT_KEY, JSON.stringify(v)); } catch {}
    }
    const state = {
        rendered: false,
        lastInsight: loadInsight(), // { html, generatedAt }
        loadingInsight: false,
    };


    // ---------------- Scoring ----------------
    // Convert a card's SRS state into a 0-100 mastery score.
    function scoreCard(card) {
        if (!card) return 0;
        const reps = card.reps || 0;
        const lapses = card.lapses || 0;
        const ease = card.ease || 2.5;
        const interval = card.interval || 0;

        if (reps === 0) return 15;
        // Base: interval maturity (0 at new, ~90 at 30d+).
        let base = Math.min(90, Math.round((interval / 21) * 90));
        // Ease bonus/penalty (2.5 = neutral).
        base += Math.round((ease - 2.5) * 20);
        // Lapse penalty
        base -= Math.min(40, lapses * 8);
        return Math.max(0, Math.min(100, base));
    }

    function scoreDoc(docId) {
        const rems = ((window.db && window.db.rems) || []).filter(r => r.isFlashcard && r.docId === docId);
        const doc = (window.db?.documents || []).find(d => d.id === docId);
        const bank = doc?.recallBank || [];

        const cardScores = rems.map(scoreCard);
        const recallScores = bank
            .filter(p => p.srs && p.srs.reps > 0)
            .map(p => scoreCard(p.srs));

        const all = cardScores.concat(recallScores);
        if (all.length === 0) return { score: null, cardCount: rems.length, recallCount: bank.length };
        const avg = Math.round(all.reduce((a, b) => a + b, 0) / all.length);
        return { score: avg, cardCount: rems.length, recallCount: bank.length };
    }

    function scoreSection(doc, secIdx) {
        const rems = ((window.db && window.db.rems) || [])
            .filter(r => r.isFlashcard && r.docId === doc.id && r.sectionIdx === secIdx);
        const bank = (doc.recallBank || []).filter(p => p.sectionIdx === secIdx);
        const parts = rems.map(scoreCard)
            .concat(bank.filter(p => p.srs && p.srs.reps > 0).map(p => scoreCard(p.srs)));
        if (parts.length === 0) return null;
        return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
    }

    // Cards forecast to be forgotten in next N days (retrievability < 0.7).
    function forgettingRisk(days) {
        const rems = (window.db?.rems || []).filter(r => r.isFlashcard && !r.leech);
        const now = Date.now();
        const horizon = now + days * DAY_MS;
        return rems.filter(r => r.nextReview && r.nextReview > now && r.nextReview <= horizon).length;
    }

    // Today's 5: worst-mastery due-or-nearly-due items across all docs.
    function todaysFive() {
        const rems = (window.db?.rems || []).filter(r => r.isFlashcard && !r.leech);
        const soonCutoff = Date.now() + 2 * DAY_MS;
        const candidates = rems
            .filter(r => !r.nextReview || r.nextReview <= soonCutoff)
            .map(r => ({ card: r, score: scoreCard(r) }))
            .sort((a, b) => a.score - b.score)
            .slice(0, 5);
        return candidates;
    }

    function overallScore() {
        const docs = (window.db?.documents || []);
        const perDoc = docs.map(d => scoreDoc(d.id)).filter(x => x.score !== null);
        if (perDoc.length === 0) return null;
        return Math.round(perDoc.reduce((a, b) => a + b.score, 0) / perDoc.length);
    }

    function weakestSections(limit = 5) {
        const out = [];
        const docs = (window.db?.documents || []);
        for (const d of docs) {
            (d.sections || []).forEach((s, i) => {
                const sc = scoreSection(d, i);
                if (sc !== null) out.push({ docId: d.id, docTitle: d.title, secIdx: i, secTitle: s.title || `Section ${i + 1}`, score: sc });
            });
        }
        out.sort((a, b) => a.score - b.score);
        return out.slice(0, limit);
    }

    function tone(score) {
        if (score === null || score === undefined) return { color: 'rgba(148,163,184,0.65)', label: 'new' };
        if (score < 30) return { color: '#f43f5e', label: 'critical' };
        if (score < 55) return { color: '#f97316', label: 'weak' };
        if (score < 75) return { color: '#eab308', label: 'okay' };
        if (score < 90) return { color: '#06b6d4', label: 'strong' };
        return { color: '#10b981', label: 'mastered' };
    }

    function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    window.radarWeakestSections = weakestSections;

    // ---------------- View ----------------
    window.showRadarView = function () {
        const ids = ['home-view', 'workspace', 'scheduler-view', 'stats-view', 'recall-view'];
        ids.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
        let rv = document.getElementById('radar-view');
        if (!rv) {
            rv = document.createElement('div');
            rv.id = 'radar-view';
            document.getElementById('app-wrapper').appendChild(rv);
        }
        rv.style.display = 'block';

        document.body.classList.remove('doc-open');
        document.body.classList.remove('scheduler-open');
        document.body.classList.remove('stats-open');
        document.body.classList.remove('recall-open');
        document.body.classList.add('radar-open');

        const topGroup = document.getElementById('top-doc-title-group');
        if (topGroup) topGroup.style.display = 'none';
        const navTabs = document.getElementById('main-nav-tabs');
        if (navTabs) navTabs.style.display = 'none';

        renderRadar();
    };

    function renderRadar() {
        const rv = document.getElementById('radar-view');
        if (!rv) return;
        const overall = overallScore();
        const risk7 = forgettingRisk(7);
        const risk3 = forgettingRisk(3);
        const drill = todaysFive();
        const weak = weakestSections(6);
        const docs = (window.db?.documents || []);

        const overallTone = tone(overall);
        const ring = overall === null ? 0 : overall;

        rv.innerHTML = `
        <div class="sched-shell radar-shell">
            <div class="sched-header">
                <div>
                    <div class="sched-kicker"><span class="sched-kicker-dot" style="background:#f43f5e;"></span> Mastery intelligence</div>
                    <h1 class="sched-title">Weak Spot Radar</h1>
                    <p class="sched-subtitle">See exactly where your memory is fragile — and fix it with one drill.</p>
                </div>
                <div class="sched-actions">
                    <button class="btn-action primary" onclick="window.radarStartTodaysFive()"><span class="btn-ico"><i data-lucide="target"></i></span> Drill Today's 5</button>
                </div>
            </div>

            <div class="radar-top-grid">
                <div class="radar-hero-card">
                    <div class="radar-ring" style="--ring:${ring}; --ring-color:${overallTone.color};">
                        <div class="radar-ring-inner">
                            <div class="radar-ring-value">${overall === null ? '—' : overall}</div>
                            <div class="radar-ring-label">${overall === null ? 'no data yet' : 'overall mastery'}</div>
                        </div>
                    </div>
                    <div class="radar-hero-meta">
                        <div class="radar-hero-title">${overall === null ? 'Start reviewing to see your mastery' : overallTone.label.toUpperCase()}</div>
                        <div class="radar-hero-desc">${overall === null
                                ? 'Grade a few flashcards or run an Active Recall session — your score will start filling in.'
                                : overall < 55
                                    ? 'Your recall is fragile in several places. Focus on the weakest topics below.'
                                    : overall < 80
                                        ? 'Solid, but a few sections are drifting. Fix them before the exam.'
                                        : 'Excellent retention — keep the streak going with short daily drills.'}</div>
                    </div>
                </div>
                <div class="radar-side-stats">
                    <div class="radar-stat-card critical"><div class="radar-stat-label"><i data-lucide="flame"></i> Forgetting in 3 days</div><div class="radar-stat-value">${risk3}</div><div class="radar-stat-sub">cards falling below the curve</div></div>
                    <div class="radar-stat-card warn"><div class="radar-stat-label"><i data-lucide="alert-triangle"></i> Forgetting in 7 days</div><div class="radar-stat-value">${risk7}</div><div class="radar-stat-sub">plan a review this week</div></div>
                </div>
            </div>

            <div class="radar-section">
                <div class="radar-section-head">
                    <h2>Today's 5 — worst mastery first</h2>
                    <button class="btn-dark-pill" onclick="window.radarStartTodaysFive()"><i data-lucide="play"></i> Start</button>
                </div>
                ${drill.length === 0
                ? `<div class="radar-empty">No due cards right now — you're ahead of the curve.</div>`
                : `<div class="radar-drill-list">${drill.map(d => {
                    const t = tone(d.score);
                    const doc = docs.find(x => x.id === d.card.docId);
                    return `<div class="radar-drill-item">
                                <div class="radar-drill-score" style="background:${t.color}20;color:${t.color};border-color:${t.color}55;">${d.score}</div>
                                <div class="radar-drill-body">
                                    <div class="radar-drill-front">${escapeHtml(((window.clozePlain ? window.clozePlain(d.card.front || '') : (d.card.front || ''))).slice(0, 140))}</div>
                                    <div class="radar-drill-doc">${escapeHtml(doc?.title || 'Document')}</div>
                                </div>
                            </div>`;
                }).join('')}</div>`}
            </div>

            <div class="radar-section">
                <div class="radar-section-head">
                    <h2>Mastery per document</h2>
                    <span class="radar-legend">
                        <span><i style="background:#f43f5e"></i>critical</span>
                        <span><i style="background:#f97316"></i>weak</span>
                        <span><i style="background:#eab308"></i>okay</span>
                        <span><i style="background:#06b6d4"></i>strong</span>
                        <span><i style="background:#10b981"></i>mastered</span>
                    </span>
                </div>
                ${docs.length === 0
                ? `<div class="radar-empty">No documents yet — upload one to start tracking mastery.</div>`
                : `<div class="radar-doc-grid">${docs.map(d => {
                    const s = scoreDoc(d.id);
                    const t = tone(s.score);
                    return `<div class="radar-doc-tile" onclick="window.switchDocument('${d.id}')">
                                <div class="radar-doc-title">${escapeHtml(d.title || 'Untitled')}</div>
                                <div class="radar-doc-bar"><div class="radar-doc-fill" style="width:${s.score ?? 4}%;background:${t.color};"></div></div>
                                <div class="radar-doc-meta">
                                    <span style="color:${t.color};font-weight:800;">${s.score === null ? '— ' : s.score} ${s.score !== null ? '/ 100' : ''}</span>
                                    <span>${s.cardCount} cards · ${s.recallCount} recall</span>
                                </div>
                            </div>`;
                }).join('')}</div>`}
            </div>

            <div class="radar-section">
                <div class="radar-section-head"><h2>Weakest topics right now</h2></div>
                ${weak.length === 0
                ? `<div class="radar-empty">Not enough graded reviews yet — do a few flashcards or recall prompts to unlock this.</div>`
                : `<div class="radar-weak-list">${weak.map(w => {
                    const t = tone(w.score);
                    return `<div class="radar-weak-item" onclick="window.switchDocument('${w.docId}')">
                                <div class="radar-weak-bar" style="background:${t.color};"></div>
                                <div class="radar-weak-body">
                                    <div class="radar-weak-sec">${escapeHtml(w.secTitle)}</div>
                                    <div class="radar-weak-doc">${escapeHtml(w.docTitle)}</div>
                                </div>
                                <div class="radar-weak-score" style="color:${t.color};">${w.score}</div>
                            </div>`;
                }).join('')}</div>`}
            </div>

            <div class="radar-section">
                <div class="radar-section-head">
                    <h2>Your weekly AI insight</h2>
                    ${(() => {
                        if (window.isFreePlan && window.isFreePlan() &&
                            window.FREE_LIMITS && window.FREE_LIMITS.radarInsight === false) {
                            return `<button class="btn-action primary" onclick="window.gatePaidOnly && window.gatePaidOnly('Weekly AI insight','Personal weekly briefings from your AI coach are a Pro feature.')"><span class="btn-ico"><i data-lucide="lock"></i></span> Pro feature</button>`;
                        }
                        const last = state.lastInsight?.generatedAt || 0;
                        const nextAt = last + WEEK_MS;
                        const canGen = !state.loadingInsight && Date.now() >= nextAt;
                        if (canGen) {
                            return `<button class="btn-action primary" onclick="window.radarGenerateInsight()"><span class="btn-ico"><i data-lucide="brain"></i></span> ${state.lastInsight ? 'Regenerate' : 'Generate insight'}</button>`;
                        }
                        if (state.loadingInsight) {
                            return `<button class="btn-action primary" disabled><span class="btn-ico"><i data-lucide="brain"></i></span> Generating…</button>`;
                        }
                        const days = Math.max(1, Math.ceil((nextAt - Date.now()) / DAY_MS));
                        return `<span class="radar-insight-lock">Next insight in ${days} day${days === 1 ? '' : 's'}</span>`;
                    })()}
                </div>

                <div id="radar-insight-box" class="radar-insight-box">
                    ${state.loadingInsight
                ? `<div class="radar-empty">Reading your mastery snapshot…</div>`
                : (state.lastInsight
                    ? `<div class="radar-insight-html">${state.lastInsight.html}</div><div class="radar-insight-meta">Generated ${new Date(state.lastInsight.generatedAt).toLocaleString()}</div>`
                    : `<div class="radar-empty">Click <b>Generate insight</b> for a personal weekly briefing from your AI coach.</div>`)}
                </div>
            </div>
        </div>`;

        if (window.lucide?.createIcons) window.lucide.createIcons();
    }

    // ---------------- Today's 5 drill ----------------
    window.radarStartTodaysFive = function () {
        if (window.gatePaidOnly && !window.gatePaidOnly("Today's 5 drill",
            "Drilling your 5 highest-risk cards is a Pro feature. Free users can still review due cards from the Active Recall Studio.")) return;
        const drill = todaysFive();
        if (drill.length === 0) return alert("You're all caught up — nothing to drill right now.");
        const ids = drill.map(x => x.card.id);
        if (typeof window.startReviewSession === 'function') {
            const cards = drill.map(x => x.card);
            window.startReviewSession(cards, { title: "Today's 5" });
            return;
        }
        // Fallback: rely on the global "review due" flow — it uses the same SRS queue.
        if (typeof window.startReviewDueAll === 'function') {
            window.startReviewDueAll();
            return;
        }
        alert("Review flow not available.");
    };

    // ---------------- Weekly AI insight ----------------
    function buildSnapshot() {
        const overall = overallScore();
        const docs = (window.db?.documents || []).map(d => {
            const s = scoreDoc(d.id);
            return { title: d.title, score: s.score, cards: s.cardCount, recall: s.recallCount };
        }).filter(x => x.score !== null).sort((a, b) => a.score - b.score);
        const weak = weakestSections(6);
        const streak = (window.db?.pomoStats?.streak) || 0;
        const stats = (window.db?.srsStats) || {};
        let weekReviewed = 0, weekRemembered = 0;
        const cutoff = Date.now() - 7 * DAY_MS;
        for (const [k, v] of Object.entries(stats)) {
            const ts = new Date(k + 'T00:00:00').getTime();
            if (isNaN(ts) || ts < cutoff) continue;
            weekReviewed += v.reviewed || 0;
            weekRemembered += (v.good || 0) + (v.easy || 0);
        }
        const recallAcc = weekReviewed > 0 ? Math.round((weekRemembered / weekReviewed) * 100) : null;
        return {
            overallMastery: overall,
            streakDays: streak,
            weekReviewCount: weekReviewed,
            weekRecallAccuracy: recallAcc,
            forgettingRisk7d: forgettingRisk(7),
            weakestDocuments: docs.slice(0, 5),
            weakestTopics: weak.map(w => ({ doc: w.docTitle, section: w.secTitle, score: w.score })),
        };
    }

    window.radarGenerateInsight = async function () {
        if (window.gatePaidOnly && !window.gatePaidOnly('Weekly AI insight',
            'Personal weekly briefings from your AI coach are a Pro feature.')) return;
        if (state.loadingInsight) return;
        const last = state.lastInsight?.generatedAt || 0;
        if (last && Date.now() - last < WEEK_MS) {
            const days = Math.ceil((last + WEEK_MS - Date.now()) / DAY_MS);
            alert(`Weekly insight already generated. You can regenerate in ${days} day${days === 1 ? '' : 's'}.`);
            return;
        }
        if (typeof window.aiTask !== 'function') return alert('AI client not ready.');
        state.loadingInsight = true;
        renderRadar();
        try {
            const snapshot = buildSnapshot();
            const res = await window.aiTask('weekly_insight', {
                snapshot: JSON.stringify(snapshot),
            }, { temperature: 0.5, lang: 'auto' });
            if (typeof res !== 'string') throw new Error(res?._error || 'AI error');
            const clean = res.replace(/```html\s*|```/g, '').trim();
            state.lastInsight = { html: clean, generatedAt: Date.now() };
            saveInsight(state.lastInsight);
        } catch (e) {
            state.lastInsight = { html: `<div style="color:#f43f5e;">Could not generate insight: ${escapeHtml(e.message || String(e))}</div>`, generatedAt: Date.now() };
            // don't persist failures — allow retry
        } finally {
            state.loadingInsight = false;
            renderRadar();
        }
    };



    // ---------------- Cross-view hygiene ----------------
    // Wrap other switchers so they clear the Radar view when leaving.
    function wrap(name) {
        const orig = window[name];
        if (typeof orig !== 'function' || orig.__radarWrapped) return;
        window[name] = function () {
            const rv = document.getElementById('radar-view');
            if (rv) rv.style.display = 'none';
            document.body.classList.remove('radar-open');
            return orig.apply(this, arguments);
        };
        window[name].__radarWrapped = true;
    }
    function installHooks() {
        wrap('showHomeView');
        wrap('showSchedulerView');
        wrap('showStatsView');
        wrap('showRecallView');
        wrap('switchDocument');
    }
    // Late-bind because other modules load after us in some cases.
    document.addEventListener('DOMContentLoaded', () => setTimeout(installHooks, 0));
    setTimeout(installHooks, 500);
})();
