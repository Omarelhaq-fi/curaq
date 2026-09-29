// Flashcard CSV import → "Exam Prep Decks".
// Creates standalone decks (db.decks) whose cards live in db.rems as
// flashcards tagged with deckId + topic="Exam Prep". Fully client-side;
// syncs through the normal saveDb() cloud pipeline.
(function () {
    function esc(s) {
        return String(s == null ? '' : '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // ---------- CSV parser (RFC4180: quotes, escaped quotes, CRLF) ----------
    function parseCSV(text) {
        const rows = [];
        let row = [], field = '', inQuotes = false, i = 0;
        text = String(text || '').replace(/^\uFEFF/, ''); // strip BOM
        while (i < text.length) {
            const ch = text[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                    inQuotes = false; i++; continue;
                }
                field += ch; i++; continue;
            }
            if (ch === '"') { inQuotes = true; i++; continue; }
            if (ch === ',') { row.push(field); field = ''; i++; continue; }
            if (ch === '\r') { i++; continue; }
            if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
            field += ch; i++;
        }
        if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
        return rows.filter(r => r.some(c => String(c).trim() !== ''));
    }

    function ensureDecksArray() {
        if (!window.db) window.db = {};
        if (!Array.isArray(window.db.decks)) window.db.decks = [];
        return window.db.decks;
    }

    function makeCard(deckId, front, back, idx) {
        const id = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + idx).replace(/-/g, '').slice(0, 9);
        return {
            id,
            docId: null,
            deckId,
            text: (back || '').trim() ? (front || '') + ' == ' + back : (front || ''),
            indent: 0,
            parentId: null,
            isFlashcard: true,
            front: front || '',
            back: back || '',
            sourceText: '',
            topic: 'Exam Prep',
            deckIdRef: deckId,
            manual: true,
            ease: 2.5,
            interval: 0,
            nextReview: Date.now(),
            created: Date.now()
        };
    }

    // ---------- Import flow ----------
    window.openDeckImportModal = function () {
        const old = document.getElementById('deck-import-modal');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'deck-import-modal';
        overlay.className = 'dim-overlay';
        overlay.innerHTML = `
            <div class="deck-import-modal">
                <div class="dim-head">
                    <div>
                        <div class="dim-title">🃏 Import Exam Prep Deck</div>
                        <div class="dim-sub">CSV with columns: Front, Back (header row optional)</div>
                    </div>
                    <button type="button" class="dim-close">×</button>
                </div>
                <label class="dim-label">Deck name</label>
                <input type="text" id="deck-import-name" class="login-input" placeholder="e.g. Pediatrics — Final Exam 2025" />
                <label class="dim-label">CSV file</label>
                <input type="file" id="deck-import-file" accept=".csv,text/csv" class="dim-file" />
                <div class="dim-format">
                    <b>Expected format</b> (first column = front, second = back; extra columns ignored):
                    <pre>Front,Back
"Definition of shock?","Inadequate tissue perfusion"
Symptom of Kawasaki disease,Strawberry tongue</pre>
                    Quotes are optional — use them when a cell contains commas or newlines.
                </div>
                <div class="dim-status" id="deck-import-status"></div>
                <div class="dim-foot">
                    <button type="button" class="btn-dark-pill dim-cancel">Cancel</button>
                    <button type="button" id="deck-import-go" class="btn-action primary">Import Deck</button>
                </div>
            </div>
            <style>${CSS}</style>`;
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';

        const close = () => { overlay.remove(); document.body.style.overflow = ''; };
        overlay.querySelector('.dim-close').addEventListener('click', close);
        overlay.querySelector('.dim-cancel').addEventListener('click', close);
        overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });

        overlay.querySelector('#deck-import-go').addEventListener('click', async () => {
            const nameEl = document.getElementById('deck-import-name');
            const fileEl = document.getElementById('deck-import-file');
            const statusEl = document.getElementById('deck-import-status');
            const name = (nameEl.value || '').trim();
            const file = fileEl.files && fileEl.files[0];

            if (!name) { alert('Give the deck a name.'); return; }
            if (!file) { alert('Choose a CSV file.'); return; }
            if (!window.db) { alert('App not ready yet — try again.'); return; }

            statusEl.textContent = 'Reading file…';
            try {
                const text = await file.text();
                const rows = parseCSV(text);
                if (!rows.length) throw new Error('The file appears to be empty.');

                // Detect & drop header row
                let startIdx = 0;
                const first = rows[0].map(c => c.trim().toLowerCase());
                if ((first[0] === 'front' && first[1] === 'back') || first[0] === 'front' || first[0] === 'question') {
                    startIdx = 1;
                }

                const decks = ensureDecksArray();
                const deckId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)).replace(/-/g, '').slice(0, 12);

                let added = 0, skipped = 0;
                for (let r = startIdx; r < rows.length; r++) {
                    const front = (rows[r][0] || '').trim();
                    const back = (rows[r][1] !== undefined ? rows[r][1] : '').trim();
                    if (!front && !back) { skipped++; continue; }
                    window.db.rems.push(makeCard(deckId, front, back, r));
                    added++;
                }

                if (added === 0) throw new Error('No valid cards found (need at least a Front per row).');

                decks.push({
                    id: deckId,
                    name,
                    createdAt: Date.now(),
                    cardCount: added,
                    kind: 'exam_prep'
                });

                if (typeof saveDb === 'function') saveDb();
                close();

                alert(`✅ Imported "${name}"\n\n${added} cards added${skipped ? ` · ${skipped} empty rows skipped` : ''}.`);
                // Refresh explorer if open
                if (document.getElementById('flashcards-explorer-view')?.style.display !== 'none'
                    && typeof window.openFlashcardsExplorer === 'function') {
                    window.openFlashcardsExplorer();
                }
            } catch (err) {
                statusEl.textContent = '';
                alert('Import failed: ' + (err.message || err));
            }
        });
    };

    // ---------- Explorer section: "Exam Prep Decks" ----------
    const origExplorer = window.renderFlashcardsExplorer;
    window.renderFlashcardsExplorer = function () {
        // Render original grouped-by-specialty UI first
        origExplorer.apply(this, arguments);

        // Then inject the Exam Prep Decks section + import button
        const container = document.getElementById('flashcards-explorer-content');
        if (!container || !window.db) return;

        const decks = Array.isArray(window.db.decks) ? window.db.decks : [];

        // Import button at top
        const btn = document.createElement('div');
        btn.innerHTML = `
            <div style="display:flex; justify-content:center; margin-bottom:26px;">
                <button class="btn-action primary" onclick="window.openDeckImportModal()" style="display:inline-flex; align-items:center; gap:8px; padding:11px 22px;">
                    ⬆ Import Exam Prep Deck (CSV)
                </button>
            </div>`;
        container.prepend(btn);

        if (decks.length === 0) return;

        const now = Date.now();
        let html = `<div style="max-width:1000px; margin:34px auto 0;">
            <h3 style="font-family:'Outfit',sans-serif; font-size:1.25rem; font-weight:800; color:var(--text-primary); display:flex; align-items:center; gap:10px; margin-bottom:16px;">
                🎓 Exam Prep Decks <span style="font-size:0.75rem; font-weight:700; color:var(--accent-cyan); background:rgba(14,124,134,0.12); padding:3px 10px; border-radius:999px;">${decks.length}</span>
            </h3>
            <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:14px;">`;

        for (const deck of decks) {
            const cards = (window.db.rems || []).filter(r => r.isFlashcard && r.deckIdRef === deck.id);
            const due = cards.filter(c => window.srs && window.srs.isDue(c, now)).length;
            html += `
            <div style="background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:16px; padding:20px; display:flex; flex-direction:column; gap:8px;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
                    <i class="material-symbols-outlined" style="color:#a78bfa; font-size:28px;">school</i>
                    ${due > 0 ? `<span style="font-size:0.72rem; font-weight:700; color:#facc15; background:rgba(250,204,21,0.12); padding:3px 10px; border-radius:999px;">${due} due</span>` : ''}
                </div>
                <div style="font-family:'Outfit',sans-serif; font-weight:700; font-size:1.02rem; color:var(--text-primary); line-height:1.35;">${esc(deck.name)}</div>
                <div style="font-size:0.8rem; color:var(--text-muted);">${cards.length} card${cards.length === 1 ? '' : 's'}</div>
                <div style="display:flex; gap:8px; margin-top:auto; padding-top:10px;">
                    <button class="btn-dark-pill" style="flex:1; color:#a78bfa;" onclick="window.reviewDeck('${deck.id}')">Study</button>
                    <button class="btn-dark-pill" style="color:var(--danger);" title="Delete deck" onclick="window.deleteExamPrepDeck('${deck.id}')">🗑</button>
                </div>
            </div>`;
        }
        html += `</div></div>`;

        const section = document.createElement('div');
        section.innerHTML = html;
        container.appendChild(section);
    };

    // ---------- Review & delete ----------
    window.reviewDeck = function (deckId) {
        const deck = (window.db.decks || []).find(d => d.id === deckId);
        const cards = (window.db.rems || []).filter(r => r.isFlashcard && r.deckIdRef === deckId);
        if (!deck || cards.length === 0) { alert('This deck has no cards.'); return; }
        const shuffled = cards.slice();
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        if (typeof window.startReviewWithCards === 'function') {
            window.startReviewWithCards(shuffled);
        } else {
            alert('Reviewer is still loading.');
        }
    };

    window.deleteExamPrepDeck = function (deckId) {
        const decks = window.db.decks || [];
        const deck = decks.find(d => d.id === deckId);
        if (!deck) return;
        if (!confirm(`Delete "${deck.name}" and all its cards? This cannot be undone.`)) return;
        window.db.decks = decks.filter(d => d.id !== deckId);
        window.db.rems = (window.db.rems || []).filter(r => !(r.deckIdRef === deckId));
        if (typeof saveDb === 'function') saveDb();
        window.renderFlashcardsExplorer();
    };

    const CSS = `
    .dim-overlay { position:fixed; inset:0; background:rgba(6,25,31,0.72); z-index:99999; display:flex; align-items:center; justify-content:center; padding:24px; backdrop-filter:blur(5px); font-family:'Figtree',sans-serif; }
    .deck-import-modal { background:var(--bg-elevated,#12222a); color:var(--text-primary,#e6eef1); border:1px solid rgba(45,212,191,0.16); border-radius:16px; width:min(560px,100%); max-height:90vh; overflow-y:auto; padding:26px 28px; display:flex; flex-direction:column; gap:8px; box-shadow:0 40px 100px -30px rgba(4,18,22,0.85); }
    .dim-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; padding-bottom:14px; border-bottom:1px solid rgba(255,255,255,0.07); }
    .dim-title { font-family:'Outfit',sans-serif; font-size:1.25rem; font-weight:800; color:var(--text-primary,#fff); }
    .dim-sub { font-size:0.82rem; color:var(--text-muted,#7d97a3); margin-top:4px; }
    .dim-close { background:transparent; border:none; color:var(--text-muted,#7d97a3); font-size:28px; cursor:pointer; line-height:1; border-radius:8px; width:34px; height:34px; transition:all .15s ease; }
    .dim-close:hover { color:#fff; background:rgba(244,63,94,0.15); }
    .dim-label { display:block; font-size:0.72rem; font-weight:700; letter-spacing:0.09em; text-transform:uppercase; color:var(--accent-cyan,#2dd4bf); margin-top:12px; margin-bottom:5px; }
    .dim-file { margin-top:4px; color:var(--text-secondary); font-size:0.9rem; }
    .dim-format { margin-top:12px; padding:12px 14px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.09); border-radius:10px; font-size:0.78rem; color:var(--text-secondary); line-height:1.55; }
    .dim-format pre { margin:8px 0 0; padding:10px 12px; background:rgba(0,0,0,0.3); border-radius:8px; font-size:0.75rem; overflow-x:auto; color:#b8d3da; }
    .dim-status { font-size:0.82rem; color:#facc15; min-height:18px; }
    .dim-foot { display:flex; justify-content:flex-end; gap:10px; margin-top:14px; }
    `;
})();
