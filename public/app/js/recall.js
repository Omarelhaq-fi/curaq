// Active Recall Studio — AI-generated open-ended prompts, AI-graded answers,
// grades feed directly into the SRS queue as first-class review items.
(function () {
    function recallLang() {
        try {
            const l = (typeof window.getUserLanguage === 'function') ? window.getUserLanguage() : null;
            return l || 'auto';
        } catch (_) { return 'auto'; }
    }
    const state = {
        prompts: [],       // current session queue
        idx: 0,
        session: [],
        loading: false,
        selectedDocId: null,   // user MUST pick a doc before every session
    };

    function activeDoc() {
        if (state.selectedDocId && window.db?.documents) {
            const d = window.db.documents.find(x => x.id === state.selectedDocId);
            if (d) return d;
        }
        return null;
    }
    function persistDb() {
        if (window.firebase && firebase.auth().currentUser && window.syncDbToCloud && window.db) {
            window.syncDbToCloud(window.db);
        }
    }
    function genId() { return 'r' + crypto.randomUUID().replace(/-/g,'').slice(0,7); }

    window.recallPickDoc = function (id) {
        state.selectedDocId = id;
        state.prompts = []; state.idx = 0; state.session = []; state.lastFeedback = null;
        renderStudio();
    };
    window.recallChangeDoc = function () {
        state.selectedDocId = null;
        state.prompts = []; state.idx = 0; state.session = []; state.lastFeedback = null;
        renderStudio();
    };

    // ---------------- Prompt bank ----------------
    // Stored in doc.recallBank = [ { id, kind, prompt, ideal, source, sectionIdx, srs:{...} } ]
    function bankFor(doc) {
        if (!doc.recallBank) doc.recallBank = [];
        return doc.recallBank;
    }

    async function generatePromptsForSection(doc, secIdx) {
        const sec = doc.sections[secIdx];
        if (!sec) return [];
        if (!sec.chunkText) return [];
        const res = await window.aiTask('recall_prompts_from_chunk', {
            title: sec.title || '',
            chunkText: sec.chunkText,
        }, { temperature: 0.4, lang: recallLang() });
        if (typeof res !== 'string') throw new Error(res?._error || 'AI error');
        let json;
        try { json = JSON.parse(res); }
        catch { const m = res.match(/\{[\s\S]*\}/); if (m) json = JSON.parse(m[0]); else throw new Error('Bad JSON'); }
        const OPEN_KINDS = ['short', 'explain', 'compare', 'mechanism', 'apply'];
        const items = (json.prompts || []).filter(p => {
            // Open questions only — cloze lives in flashcards now.
            if (!p || !p.prompt) return false;
            if (p.kind === 'cloze') return false;
            return !/\{\{c\d+::/.test(String(p.prompt));
        }).map(p => ({
            id: genId(),
            kind: OPEN_KINDS.includes(p.kind) ? p.kind : 'short',
            prompt: p.prompt,
            ideal: p.ideal,
            source: p.source || '',
            sectionIdx: secIdx,
            title: sec.title || '',
        }));
        return items;
    }

    window.recallGenerateForDoc = async function () {
        const doc = activeDoc();
        if (!doc) return alert('Open a document first');
        if (!doc.sections?.length) return alert('This document has no sections yet.');
        if (doc.recallPrepared || bankFor(doc).length > 0) {
            return alert('This document already has a recall session prepared.');
        }
        state.preparing = true;
        state.prepareProgress = { done: 0, total: doc.sections.length };
        renderStudio();
        try {
            const bank = bankFor(doc);
            for (let i = 0; i < doc.sections.length; i++) {
                if (!bank.some(x => x.sectionIdx === i)) {
                    const items = await generatePromptsForSection(doc, i).catch(e => { console.warn(e); return []; });
                    items.forEach(it => {
                        it.srs = { ease: 2.5, interval: 0, reps: 0, lapses: 0, nextReview: 0, leech: false };
                        bank.push(it);
                    });
                }
                state.prepareProgress.done = i + 1;
                const bar = document.getElementById('recall-prep-bar');
                const lbl = document.getElementById('recall-prep-label');
                if (bar) bar.style.width = `${(state.prepareProgress.done / state.prepareProgress.total) * 100}%`;
                if (lbl) lbl.textContent = `${state.prepareProgress.done} / ${state.prepareProgress.total} sections`;
            }
            doc.recallPrepared = true;
            persistDb();
        } catch (e) {
            alert('Failed: ' + (e.message || e));
        } finally {
            state.preparing = false;
            renderStudio();
        }
    };

    // ---------------- Session ----------------
    function dueQueue(doc) {
        const now = Date.now();
        return bankFor(doc).filter(p => !p.srs || !p.srs.nextReview || p.srs.nextReview <= now);
    }

    window.recallStartSession = function () {
        const doc = activeDoc();
        if (!doc) return;
        const q = dueQueue(doc);
        if (!q.length) { alert('No due recall prompts. Come back later or generate more.'); return; }
        // shuffle
        for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[q[i], q[j]] = [q[j], q[i]]; }
        state.prompts = q;
        state.idx = 0;
        state.session = [];
        renderStudio();
    };

    window.recallSkip = function () {
        state.idx++;
        renderStudio();
    };

    function normalize(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim(); }

    function gradeClozeLocal(p) {
        // Collect all cloze answers from the prompt {{cN::answer}} in order of N
        const map = {};
        String(p.prompt || '').replace(/\{\{c(\d+)::([^}]+)\}\}/g, (_, n, ans) => { map[n] = ans; return _; });
        const cnums = Object.keys(map).map(n => parseInt(n, 10)).sort((a, b) => a - b);
        let correct = 0;
        const missing = [];
        cnums.forEach(n => {
            const el = document.getElementById(`cloze-c${n}`);
            const user = el ? el.value : '';
            if (normalize(user) === normalize(map[n])) correct++;
            else missing.push(map[n]);
        });
        const total = cnums.length || 1;
        const pct = correct / total;
        const score = Math.round(pct * 5);
        const verdict = pct >= 1 ? 'easy' : pct >= 0.75 ? 'good' : pct >= 0.5 ? 'hard' : 'again';
        return {
            score, verdict, missing,
            feedback: correct === total ? 'Perfect — every blank filled correctly.' : `You got ${correct}/${total} blanks. Review the missing terms and try again.`
        };
    }

    window.recallSubmit = async function () {
        const p = state.prompts[state.idx];
        if (!p) return;
        // Cloze uses local exact/normalized grading (no AI call)
        if (p.kind === 'cloze') {
            const g = gradeClozeLocal(p);
            applyGrade(p, g);
            state.lastFeedback = g;
            renderStudio();
            return;
        }
        const answerEl = document.getElementById('recall-answer');
        if (!answerEl) return;
        const answer = answerEl.value.trim();
        if (!answer) return alert('Type your answer first.');
        state.loading = true;
        renderStudio();
        try {
            const res = await window.aiTask('grade_recall', {
                prompt: p.prompt, ideal: p.ideal, answer,
            }, { temperature: 0.1, lang: recallLang() });
            let g;
            if (typeof res === 'string') {
                try { g = JSON.parse(res); } catch { const m = res.match(/\{[\s\S]*\}/); g = m ? JSON.parse(m[0]) : null; }
            }
            if (!g) throw new Error(res?._error || 'Grading failed');
            applyGrade(p, g);
            state.lastFeedback = g;
        } catch (e) {
            state.lastFeedback = { score: 0, verdict: 'again', feedback: 'Grader failed: ' + (e.message || e), missing: [] };
        } finally {
            state.loading = false;
            renderStudio();
        }
    };

    function applyGrade(p, g) {
        const doc = activeDoc();
        const bank = bankFor(doc);
        const item = bank.find(x => x.id === p.id);
        if (item) {
            if (!item.srs) item.srs = { ease: 2.5, interval: 0, reps: 0, lapses: 0, nextReview: 0, leech: false };
            const shim = { isFlashcard: true, ease: item.srs.ease, interval: item.srs.interval, reps: item.srs.reps, lapses: item.srs.lapses, nextReview: item.srs.nextReview, leech: item.srs.leech };
            window.srs.gradeCard(shim, g.verdict || 'good');
            item.srs = { ease: shim.ease, interval: shim.interval, reps: shim.reps, lapses: shim.lapses, nextReview: shim.nextReview, leech: shim.leech };
            item.lastGrade = { score: g.score, verdict: g.verdict, at: Date.now() };
        }
        state.session.push({ id: p.id, score: g.score, verdict: g.verdict, feedback: g.feedback, missing: g.missing });
        if (window.srs?.logGrade) window.srs.logGrade(g.verdict || 'good');
        persistDb();
    }

    window.recallNext = function () {
        state.lastFeedback = null;
        state.idx++;
        renderStudio();
    };

    // ---------------- View ----------------
    window.showRecallView = function () {
        const home = document.getElementById('home-view');
        const ws = document.getElementById('workspace');
        const sv = document.getElementById('scheduler-view');
        const stv = document.getElementById('stats-view');
        const rv = document.getElementById('recall-view');
        if (home) home.style.display = 'none';
        if (ws) ws.style.display = 'none';
        if (sv) sv.style.display = 'none';
        if (stv) stv.style.display = 'none';
        if (rv) rv.style.display = 'block';
        document.body.classList.remove('doc-open');
        document.body.classList.remove('scheduler-open');
        document.body.classList.remove('stats-open');
        document.body.classList.add('recall-open');
        const topGroup = document.getElementById('top-doc-title-group');
        if (topGroup) topGroup.style.display = 'none';
        const navTabs = document.getElementById('main-nav-tabs');
        if (navTabs) navTabs.style.display = 'none';
        // Force the user to explicitly pick a document every time they open the studio.
        state.selectedDocId = null;
        state.prompts = []; state.idx = 0; state.session = []; state.lastFeedback = null;
        renderStudio();
    };

    window.recallClose = function () {
        const rv = document.getElementById('recall-view');
        if (rv) rv.style.display = 'none';
        document.body.classList.remove('recall-open');
        
        const activeD = window.getActiveDoc && window.getActiveDoc();
        if (activeD) {
            // Restore workspace
            const ws = document.getElementById('workspace');
            if (ws) ws.style.display = 'flex';
            document.body.classList.add('doc-open');
            const topGroup = document.getElementById('top-doc-title-group');
            if (topGroup) topGroup.style.display = 'flex';
            const navTabs = document.getElementById('main-nav-tabs');
            if (navTabs) navTabs.style.display = 'flex';
        } else {
            // No doc was open, return to home
            if (window.showHomeView) window.showHomeView();
        }
    };

    function renderStudio() {
        const rv = document.getElementById('recall-view');
        if (!rv) return;
        const doc = activeDoc();
        if (!doc) {
            const docs = (window.db?.documents || []);
            const rows = docs.map(d => {
                const bank = d.recallBank || [];
                const now = Date.now();
                const due = bank.filter(p => !p.srs?.nextReview || p.srs.nextReview <= now).length;
                const hasSections = !!(d.sections && d.sections.length);
                return { d, total: bank.length, due, hasSections };
            });
            const totalPrompts = rows.reduce((a, r) => a + r.total, 0);
            const totalDue = rows.reduce((a, r) => a + r.due, 0);
            const readyDocs = rows.filter(r => r.hasSections).length;
            rv.innerHTML = `
                <div class="sched-shell recall-studio">
                    <div class="recall-hero">
                        <button class="btn-icon" style="position:absolute; top:20px; right:20px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#fff; z-index:10;" onclick="window.recallClose()" title="Close Active Recall"><i data-lucide="x"></i></button>
                        <div class="recall-hero-orb"></div>
                        <div class="recall-hero-inner">
                            <div class="sched-kicker"><span class="sched-kicker-dot"></span> Free recall · Premium</div>
                            <h1 class="sched-title">Active Recall Studio</h1>
                            <p class="sched-subtitle">Pick a document to start — prompts are generated and graded in that document's own language.</p>
                            <div class="recall-hero-stats">
                                <div class="recall-hero-stat"><span class="rhs-num">${readyDocs}</span><span class="rhs-lbl">Ready</span></div>
                                <div class="recall-hero-stat"><span class="rhs-num">${totalPrompts}</span><span class="rhs-lbl">Prompts</span></div>
                                <div class="recall-hero-stat ${totalDue > 0 ? 'is-due' : ''}"><span class="rhs-num">${totalDue}</span><span class="rhs-lbl">Due today</span></div>
                            </div>
                        </div>
                    </div>
                    <div class="recall-doc-grid recall-doc-grid-lg">
                        ${rows.length === 0 ? `<div class="mm-empty" style="padding:60px; grid-column:1/-1;"><i data-lucide="target" style="width:56px; height:56px; color:var(--text-muted);"></i><h3>No documents yet</h3><p style="color:var(--text-muted); text-align:center;">Upload a document first, then come back here.</p></div>`
                    : rows.map(r => {
                        const pct = r.total > 0 ? Math.max(6, Math.round(((r.total - r.due) / r.total) * 100)) : 0;
                        const status = !r.hasSections ? 'needs' : (r.total === 0 ? 'empty' : (r.due === 0 ? 'mastered' : 'due'));
                        const statusLabel = status === 'needs' ? 'Needs processing' : status === 'empty' ? 'Not prepared' : status === 'mastered' ? 'All caught up' : `${r.due} due now`;
                        const statusIcon = status === 'needs' ? 'alert-circle' : status === 'empty' ? 'sparkles' : status === 'mastered' ? 'check-circle-2' : 'flame';
                        return `
                            <div class="recall-doc-card premium status-${status} ${!r.hasSections ? 'disabled' : ''}"
                                 ${r.hasSections ? `onclick="window.recallPickDoc('${r.d.id}')"` : 'title="Process this document first (generate its study plan)."'}>
                                <div class="recall-doc-glow"></div>
                                <div class="recall-doc-head">
                                    <div class="recall-doc-icon"><i data-lucide="book-open-text"></i></div>
                                    <span class="recall-doc-status"><i data-lucide="${statusIcon}"></i>${statusLabel}</span>
                                </div>
                                <div class="recall-doc-title">${escapeHtml(r.d.title || 'Untitled')}</div>
                                <div class="recall-doc-progress"><div class="recall-doc-progress-fill" style="width:${pct}%"></div></div>
                                <div class="recall-doc-meta">
                                    <span><i data-lucide="layers"></i> ${r.total} prompts</span>
                                    <span class="recall-doc-cta">${r.hasSections ? 'Open' : 'Locked'} <i data-lucide="arrow-right"></i></span>
                                </div>
                            </div>`;
                    }).join('')}
                    </div>
                </div>`;
            if (window.lucide) window.lucide.createIcons();
            return;
        }
        const bank = bankFor(doc);
        const dueCount = dueQueue(doc).length;
        const inSession = state.prompts.length > 0 && state.idx < state.prompts.length;
        const done = state.prompts.length > 0 && state.idx >= state.prompts.length;
        const prepared = doc.recallPrepared || bank.length > 0;
        const preparing = !!state.preparing;
        const masteredCount = bank.filter(p => (p.srs?.interval || 0) >= 21).length;
        const learningCount = Math.max(0, bank.length - masteredCount - dueCount);
        const masteryPct = bank.length ? Math.round((masteredCount / bank.length) * 100) : 0;
        const startDisabled = (dueCount === 0 || preparing);
        rv.innerHTML = `
            <div class="sched-shell">
                <div class="recall-hero ${preparing ? 'is-preparing' : ''}">
                    <button class="btn-icon" style="position:absolute; top:20px; right:20px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#fff; z-index:10;" onclick="window.recallClose()" title="Close Active Recall"><i data-lucide="x"></i></button>
                    <div class="recall-hero-glow"></div>
                    <div class="recall-hero-top">
                        <div class="recall-hero-lede">
                            <div class="recall-hero-kicker">
                                <span class="recall-hero-badge"><i data-lucide="sparkles"></i> Premium</span>
                                <span class="recall-hero-doc" title="${escapeHtml(doc.title || 'Untitled')}"><i data-lucide="file-text"></i> ${escapeHtml(doc.title || 'Untitled')}</span>
                            </div>
                            <h1 class="recall-hero-title">Active Recall Studio</h1>
                            <p class="recall-hero-sub">Adaptive prompts tuned to what you're about to forget.</p>
                        </div>
                        <div class="recall-hero-actions">
                            <button class="recall-btn ghost" onclick="window.recallChangeDoc()" ${preparing ? 'disabled' : ''}><i data-lucide="arrow-left"></i><span>Change document</span></button>
                            ${!prepared ? `<button class="recall-btn soft" id="recall-generate-btn" onclick="window.recallGenerateForDoc()" ${preparing ? 'disabled' : ''}>${preparing ? '<i data-lucide="loader-circle" class="lucide-spin"></i><span>Preparing…</span>' : '<i data-lucide="wand-2"></i><span>Prepare session</span>'}</button>` : ''}
                            <button class="recall-btn primary" onclick="window.recallStartSession()" ${startDisabled ? 'disabled' : ''}>
                                <i data-lucide="play"></i>
                                <span>Start session</span>
                                <span class="recall-btn-count">${dueCount}</span>
                            </button>
                        </div>
                    </div>
                    <div class="recall-hero-stats">
                        <div class="recall-stat"><div class="recall-stat-icon due"><i data-lucide="alarm-clock"></i></div><div><div class="recall-stat-val">${dueCount}</div><div class="recall-stat-lbl">Due now</div></div></div>
                        <div class="recall-stat"><div class="recall-stat-icon learn"><i data-lucide="brain"></i></div><div><div class="recall-stat-val">${learningCount}</div><div class="recall-stat-lbl">Learning</div></div></div>
                        <div class="recall-stat"><div class="recall-stat-icon mastered"><i data-lucide="trophy"></i></div><div><div class="recall-stat-val">${masteredCount}</div><div class="recall-stat-lbl">Mastered</div></div></div>
                        <div class="recall-stat"><div class="recall-stat-icon total"><i data-lucide="layers"></i></div><div><div class="recall-stat-val">${bank.length}</div><div class="recall-stat-lbl">Prompts</div></div></div>
                    </div>
                    <div class="recall-hero-progress">
                        <div class="recall-hero-progress-head"><span>Mastery</span><span>${masteryPct}%</span></div>
                        <div class="recall-hero-progress-bar"><div style="width:${masteryPct}%"></div></div>
                    </div>
                </div>
                <div class="recall-body">
                    ${preparing ? renderPreparing() : (inSession ? renderPrompt() : done ? renderDoneCard() : renderIdleCard(doc, bank, dueCount, prepared))}
                </div>
            </div>`;
        if (window.lucide) window.lucide.createIcons();
    }

    function renderPrompt() {
        const p = state.prompts[state.idx];
        const total = state.prompts.length;
        const fb = state.lastFeedback;
        const kindMeta = {
            short:     { icon: 'pencil-line',   label: 'Short answer' },
            apply:     { icon: 'stethoscope', label: 'Apply' },
            explain:   { icon: 'message-square-quote', label: 'Explain' },
            compare:   { icon: 'git-compare',   label: 'Compare' },
            mechanism: { icon: 'workflow',      label: 'Mechanism' },
        };
        const meta = kindMeta[p.kind] || kindMeta.short;
        const isCloze = p.kind === 'cloze';

        // Build the prompt / body area depending on kind
        const promptHtml = isCloze
            ? renderClozePrompt(p.prompt)
            : `<div class="recall-prompt">${escapeHtml(p.prompt)}</div>`;

        const inputHtml = isCloze
            ? `<div class="recall-cloze-hint"><i data-lucide="info"></i> Fill every blank, then submit.</div>`
            : `<textarea id="recall-answer" class="recall-answer" placeholder="Type your answer from memory. Don't peek." rows="6" ${state.loading ? 'disabled' : ''}></textarea>`;

        return `
            <div class="recall-card">
                <div class="recall-progress"><div class="recall-progress-fill" style="width:${((state.idx) / total) * 100}%;"></div></div>
                <div class="recall-meta">
                    <span class="recall-kind"><i data-lucide="${meta.icon}"></i> ${meta.label}</span>
                    <span>${state.idx + 1} / ${total}</span>
                </div>
                ${promptHtml}
                ${fb ? `
                    <div class="recall-feedback recall-fb-${fb.verdict || 'good'}">
                        <div class="recall-fb-head">
                            <span class="recall-fb-badge"><i data-lucide="${verdictIcon(fb.verdict)}"></i> ${fb.score}/5 · ${fb.verdict}</span>
                        </div>
                        <div class="recall-fb-body">${escapeHtml(fb.feedback || '')}</div>
                        ${fb.missing?.length ? `<div class="recall-fb-missing"><strong>Missed:</strong> ${fb.missing.map(escapeHtml).join(' · ')}</div>` : ''}
                        <details class="recall-fb-ideal"><summary>Reference answer</summary><div>${escapeHtml(clozeAnswerText(p))}</div>${p.source ? `<div class="recall-fb-source">"${escapeHtml(p.source)}"</div>` : ''}</details>
                        <div style="display:flex; gap:8px; margin-top:12px; justify-content:flex-end;">
                            <button class="btn-action primary" onclick="window.recallNext()"><i data-lucide="arrow-right"></i> Next</button>
                        </div>
                    </div>` : `
                    ${inputHtml}
                    <div style="display:flex; gap:8px; justify-content:space-between; margin-top:12px;">
                        <button class="btn-action" onclick="window.recallSkip()" ${state.loading ? 'disabled' : ''}>Skip</button>
                        <button class="btn-action primary" onclick="window.recallSubmit()" ${state.loading ? 'disabled' : ''}>
                            ${state.loading ? '<i data-lucide="loader-circle" class="lucide-spin"></i> Grading…' : '<i data-lucide="check"></i> Submit'}
                        </button>
                    </div>`}
            </div>
        `;
    }

    function renderClozePrompt(text) {
        const html = escapeHtml(text).replace(/\{\{c(\d+)::([^}]+)\}\}/g,
            (_, n) => `<input type="text" id="cloze-c${n}" class="recall-cloze-input" autocomplete="off" spellcheck="false" placeholder="…" />`);
        return `<div class="recall-prompt recall-cloze">${html}</div>`;
    }

    function clozeAnswerText(p) {
        if (p.kind !== 'cloze') return p.ideal || '';
        const answers = [];
        String(p.prompt || '').replace(/\{\{c(\d+)::([^}]+)\}\}/g, (_, n, ans) => { answers.push(`c${n}: ${ans}`); return _; });
        return answers.join(' · ') || (p.ideal || '');
    }

    function renderDoneCard() {
        const s = state.session;
        const avg = s.length ? (s.reduce((a, b) => a + (b.score || 0), 0) / s.length).toFixed(1) : 0;
        const good = s.filter(x => x.verdict === 'good' || x.verdict === 'easy').length;
        return `
            <div class="recall-card recall-done">
                <div style="display:flex; justify-content:center;"><i data-lucide="party-popper" style="width:56px; height:56px; color:#22d3ee;"></i></div>
                <h2 style="text-align:center; margin:12px 0 4px;">Session complete</h2>
                <p style="text-align:center; color:var(--text-muted);">${s.length} prompts · ${good} solid · avg ${avg}/5</p>
                <div style="display:flex; gap:8px; justify-content:center; margin-top:20px;">
                    <button class="btn-action primary" onclick="window.recallStartSession()"><i data-lucide="rotate-cw"></i> Another Round</button>
                </div>
            </div>
        `;
    }

    function renderPreparing() {
        const p = state.prepareProgress || { done: 0, total: 1 };
        const pct = Math.round((p.done / Math.max(1, p.total)) * 100);
        return `
            <div class="recall-card" style="text-align:center;">
                <div style="display:flex; justify-content:center; margin-bottom:12px;"><i data-lucide="loader-circle" class="lucide-spin" style="width:48px; height:48px; color:var(--brand, #22d3ee);"></i></div>
                <h2 style="margin:0 0 6px;">Preparing session…</h2>
                <p style="color:var(--text-muted); margin:0 0 18px;">Mining prompts from every chunk. This runs once per document.</p>
                <div class="recall-progress" style="height:10px; border-radius:6px; overflow:hidden;"><div id="recall-prep-bar" class="recall-progress-fill" style="width:${pct}%; height:100%; transition:width .3s;"></div></div>
                <div id="recall-prep-label" style="margin-top:10px; color:var(--text-muted); font-size:.85rem;">${p.done} / ${p.total} sections</div>
            </div>`;
    }

    function renderIdleCard(doc, bank, dueCount, prepared) {
        if (!prepared) {
            return `<div class="mm-empty" style="padding:40px;"><i data-lucide="target" style="width:48px; height:48px; color:var(--text-muted);"></i><h3>Ready when you are</h3><p style="color:var(--text-muted); text-align:center;">Click <strong>Prepare session</strong> to mine open questions (short answer, explain, compare, mechanism, apply) from every chunk. Runs once per document.</p></div>`;
        }
        return `<div class="mm-empty" style="padding:40px;"><i data-lucide="check-circle-2" style="width:48px; height:48px; color:#22d3ee;"></i><h3>Session ready</h3><p style="color:var(--text-muted); text-align:center;">${bank.length} prompts prepared · <strong style="color:#f43f5e;">${dueCount} due now</strong>.<br/>Hit <strong>Start Session</strong> to begin.</p></div>`;
    }

    function renderBankList(bank) {
        if (bank.length === 0) {
            return `<div class="mm-empty" style="padding:40px;"><i data-lucide="target" style="width:48px; height:48px; color:var(--text-muted);"></i><h3>No recall prompts yet</h3><p style="color:var(--text-muted); text-align:center;">Click <strong>Prepare session</strong> to mine open questions (short answer, explain, compare, mechanism, apply) from every chunk.</p></div>`;
        }
        const bySec = {};
        bank.forEach(p => { (bySec[p.sectionIdx] = bySec[p.sectionIdx] || []).push(p); });
        return `<div class="recall-bank">${Object.keys(bySec).map(sIdx => `
            <div class="recall-bank-sec">
                <div class="recall-bank-head"><i data-lucide="book-open"></i> ${escapeHtml(bySec[sIdx][0].title || 'Section')}</div>
                ${bySec[sIdx].map(p => {
            const due = !p.srs?.nextReview || p.srs.nextReview <= Date.now();
            const kindIcon = { short: 'pencil-line', apply: 'stethoscope', explain: 'message-square-quote', compare: 'git-compare', mechanism: 'workflow' }[p.kind] || 'circle';
            const preview = p.kind === 'cloze' ? String(p.prompt).replace(/\{\{c\d+::([^}]+)\}\}/g, '____') : p.prompt;
            return `<div class="recall-bank-item"><span class="recall-bank-dot ${due ? 'due' : ''}"></span><i data-lucide="${kindIcon}" class="recall-bank-kind"></i><span class="recall-bank-prompt">${escapeHtml(preview)}</span><span class="recall-bank-when">${due ? 'due now' : window.srs.nextReviewLabel({ nextReview: p.srs.nextReview })}</span></div>`;
        }).join('')}
            </div>`).join('')}</div>`;
    }

    function verdictIcon(v) { return v === 'easy' ? 'sparkles' : v === 'good' ? 'check' : v === 'hard' ? 'triangle-alert' : 'x'; }
    function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
})();
