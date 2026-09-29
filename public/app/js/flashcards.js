// Flashcards Tab — manual add, list, reorder, delete, review, inline edit
(function () {
    function esc(s) {
        return (s || '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function currentDocId() {
        try { return activeDocId; } catch (_) { return null; }
    }

    function docFlashcards() {
        const id = currentDocId();
        if (!window.db || !id) return [];
        return db.rems.filter(r => r.isFlashcard && r.docId === id);
    }

    /* ── Cloze-aware syntax highlighting for display inside the editor ── */
    function clozeHighlightHtml(text) {
        const src = String(text || '');
        const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)\}\}/g;
        let out = '';
        let last = 0;
        let m;
        while ((m = CLOZE_RE.exec(src)) !== null) {
            out += esc(src.slice(last, m.index));
            const body = m[2];
            const colonIdx = body.indexOf('::');
            const answer = colonIdx === -1 ? body : body.slice(0, colonIdx);
            const hint = colonIdx === -1 ? '' : body.slice(colonIdx + 2);
            out += `<span class="fc-cloze-tag">{{c${m[1]}::</span>`;
            out += `<span class="fc-cloze-answer">${esc(answer)}</span>`;
            if (hint) out += `<span class="fc-cloze-tag">::${esc(hint)}</span>`;
            out += `<span class="fc-cloze-tag">}}</span>`;
            last = m.index + m[0].length;
        }
        out += esc(src.slice(last));
        return out;
    }

    window.renderFlashcardsList = function () {
        const container = document.getElementById('flashcards-list');
        if (!container) return;

        if (!currentDocId()) {
            container.innerHTML = `<div style="color:var(--text-muted); text-align:center; margin-top:60px;">Open a document to manage flashcards.</div>`;
            return;
        }

        const cards = docFlashcards();
        if (cards.length === 0) {
            container.innerHTML = `
                <div style="border:1px dashed var(--border-subtle); border-radius:14px; padding:40px; text-align:center; color:var(--text-muted);">
                    <div style="font-size:2rem; margin-bottom:10px;">🃏</div>
                    <div style="font-weight:600; color:var(--text-primary); margin-bottom:6px;">No flashcards yet</div>
                    <div style="font-size:0.85rem;">Click <strong>＋ Add Flashcard</strong> to create your first card,<br/>or generate them automatically from a section.</div>
                </div>`;
            return;
        }

        container.innerHTML = cards.map((c, i) => {
            const front = c.front || c.text || '';
            const isCloze = c.cardType === 'cloze' || (window.hasCloze && window.hasCloze(front));
            const hasBack = !!String(c.back || '').trim();
            return `
            <div class="flashcard-item" data-id="${c.id}" style="background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:14px; padding:16px 18px; margin-bottom:12px; display:flex; gap:14px; align-items:flex-start;">
                <div style="display:flex; flex-direction:column; gap:4px;">
                    <button class="fc-move" title="Move up" onclick="window.moveFlashcard('${c.id}', -1)" style="background:rgba(255,255,255,0.05); border:1px solid var(--border-subtle); color:var(--text-primary); width:28px; height:28px; border-radius:8px; cursor:pointer; font-size:0.9rem;">▲</button>
                    <button class="fc-move" title="Move down" onclick="window.moveFlashcard('${c.id}', 1)" style="background:rgba(255,255,255,0.05); border:1px solid var(--border-subtle); color:var(--text-primary); width:28px; height:28px; border-radius:8px; cursor:pointer; font-size:0.9rem;">▼</button>
                </div>
                <div style="flex:1; min-width:0;">
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                        <span style="background:var(--accent-amber, #f59e0b); color:#000; font-size:0.7rem; font-weight:800; padding:2px 8px; border-radius:999px;">#${i + 1}</span>
                        <span style="background:${isCloze ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.06)'}; color:${isCloze ? '#a78bfa' : 'var(--text-dim)'}; font-size:0.7rem; font-weight:700; padding:2px 8px; border-radius:999px; border:1px solid ${isCloze ? 'rgba(139,92,246,0.3)' : 'var(--border-subtle)'};">${isCloze ? 'Cloze' : 'Basic'}</span>
                        ${c.topic ? `<span style="color:var(--text-dim); font-size:0.75rem;">${esc(c.topic)}</span>` : ''}
                    </div>
                    <!-- Front field: editable textarea, hidden by default; highlighted display shown -->
                    <div class="fc-field-wrap" data-field="front" data-id="${c.id}">
                        <div class="fc-field-display fc-front-display" data-id="${c.id}" data-field="front">${isCloze ? clozeHighlightHtml(front) : esc(front)}</div>
                        <textarea class="fc-field-editor" data-id="${c.id}" data-field="front" style="display:none;">${esc(front)}</textarea>
                    </div>
                    ${isCloze ? `<div class="fc-cloze-preview" style="font-size:0.85rem; color:var(--text-muted); padding:0 8px 6px; white-space:pre-wrap;">${window.clozeMaskHtml ? window.clozeMaskHtml(front) : esc(front)}</div>` : ''}
                    ${(!isCloze || hasBack) ? `
                    <div style="height:1px; background:var(--border-subtle); margin:6px 0;"></div>
                    <div class="fc-field-wrap" data-field="back" data-id="${c.id}">
                        <div class="fc-field-display fc-back-display" data-id="${c.id}" data-field="back">${esc(c.back || '')}</div>
                        <textarea class="fc-field-editor" data-id="${c.id}" data-field="back" style="display:none;">${esc(c.back || '')}</textarea>
                    </div>` : ''}
                </div>
                <div style="display:flex; flex-direction:column; gap:4px;">
                    <button title="Edit card" class="fc-edit-btn" onclick="window.toggleFlashcardEdit('${c.id}')" style="background:rgba(6,182,212,0.1); border:1px solid rgba(6,182,212,0.3); color:var(--accent-cyan, #06b6d4); width:32px; height:32px; border-radius:8px; cursor:pointer; font-size:1rem; display:flex; align-items:center; justify-content:center;"><i data-lucide="pencil"></i></button>
                    <button title="Delete card" onclick="window.deleteFlashcard('${c.id}')" style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); color:#ef4444; width:32px; height:32px; border-radius:8px; cursor:pointer; font-size:1rem; display:flex; align-items:center; justify-content:center;"><i data-lucide="trash-2"></i></button>
                </div>
            </div>
        `;}).join('');

        // Re-initialize Lucide icons
        if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();

        // Wire up click-to-edit on display fields
        container.querySelectorAll('.fc-field-display').forEach(el => {
            el.addEventListener('click', () => {
                const id = el.getAttribute('data-id');
                const field = el.getAttribute('data-field');
                startFieldEdit(id, field);
            });
        });
    };

    /* Toggle edit mode for a card */
    window.toggleFlashcardEdit = function(id) {
        const item = document.querySelector(`.flashcard-item[data-id="${id}"]`);
        if (!item) return;
        const wraps = item.querySelectorAll('.fc-field-wrap');
        const firstWrap = wraps[0];
        if (!firstWrap) return;
        const editor = firstWrap.querySelector('.fc-field-editor');
        if (editor && editor.style.display !== 'none') {
            // Already editing — commit and close
            wraps.forEach(w => commitFieldEdit(w));
        } else {
            // Open all fields for editing
            wraps.forEach(w => {
                const field = w.getAttribute('data-field');
                startFieldEdit(id, field);
            });
        }
    };

    function startFieldEdit(id, field) {
        const wrap = document.querySelector(`.fc-field-wrap[data-id="${id}"][data-field="${field}"]`);
        if (!wrap) return;
        const display = wrap.querySelector('.fc-field-display');
        const editor = wrap.querySelector('.fc-field-editor');
        if (!display || !editor) return;
        if (editor.style.display !== 'none') return; // already editing

        // Get raw value from db
        const card = db.rems.find(r => r.id === id);
        if (!card) return;
        editor.value = card[field] || '';
        display.style.display = 'none';
        editor.style.display = 'block';
        editor.focus();

        // Auto-resize
        autoResizeTextarea(editor);
        editor.addEventListener('input', () => autoResizeTextarea(editor));

        // Commit on blur
        editor.addEventListener('blur', () => commitFieldEdit(wrap), { once: true });

        // Commit on Escape
        editor.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                editor.blur();
            }
        });
    }

    function commitFieldEdit(wrap) {
        const display = wrap.querySelector('.fc-field-display');
        const editor = wrap.querySelector('.fc-field-editor');
        if (!display || !editor) return;
        if (editor.style.display === 'none') return; // not editing

        const id = wrap.getAttribute('data-id');
        const field = wrap.getAttribute('data-field');
        const card = db.rems.find(r => r.id === id);
        if (!card) return;

        const val = editor.value.trim();
        if (card[field] !== val) {
            card[field] = val;
            card.text = String(card.back || '').trim()
                ? (card.front || '') + ' == ' + card.back
                : (card.front || '');
            if (field === 'front' && window.hasCloze && window.hasCloze(val)) card.cardType = 'cloze';
            if (typeof saveDb === 'function') saveDb();
        }

        // Switch back to display mode
        editor.style.display = 'none';
        display.style.display = 'block';

        // Re-render the whole list for consistency (cloze preview etc.)
        window.renderFlashcardsList();
    }

    function autoResizeTextarea(el) {
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
    }

    /* ── Edit card from review session ── */
    window.editCurrentReviewCard = function() {
        if (typeof reviewQueue === 'undefined' || typeof currentReviewIdx === 'undefined') return;
        const card = reviewQueue[currentReviewIdx];
        if (!card) return;

        const isCloze = !!(window.hasCloze && window.hasCloze(card.front));

        // Build edit UI in the question area
        const frontEl = document.getElementById('card-front');
        if (!frontEl) return;

        const existingEditor = document.getElementById('review-inline-editor');
        if (existingEditor) { existingEditor.remove(); return; } // toggle off

        const editor = document.createElement('div');
        editor.id = 'review-inline-editor';
        editor.className = 'review-inline-editor';
        editor.innerHTML = `
            <div class="rie-header">
                <span><i data-lucide="pencil" style="width:14px;height:14px;vertical-align:-2px;"></i> Edit Flashcard</span>
                <button class="rie-close" onclick="window.closeReviewEditor()">×</button>
            </div>
            <div class="rie-body">
                <label class="rie-label">Front ${isCloze ? '<span style="color:#a78bfa; font-size:0.7rem; margin-left:6px;">CLOZE — use {{c1::answer}} syntax</span>' : ''}</label>
                <textarea id="rie-front" class="rie-textarea" rows="3">${esc(card.front || '')}</textarea>
                ${!isCloze ? `
                <label class="rie-label" style="margin-top:12px;">Back (Answer)</label>
                <textarea id="rie-back" class="rie-textarea" rows="2">${esc(card.back || '')}</textarea>
                ` : ''}
                ${String(card.explanation || '').trim() ? `
                <label class="rie-label" style="margin-top:12px;">Explanation</label>
                <textarea id="rie-explanation" class="rie-textarea" rows="2">${esc(card.explanation || '')}</textarea>
                ` : ''}
            </div>
            <div class="rie-footer">
                <button class="rie-btn rie-btn-cancel" onclick="window.closeReviewEditor()">Cancel</button>
                <button class="rie-btn rie-btn-save" onclick="window.saveReviewEdit()">Save Changes</button>
            </div>
        `;
        frontEl.parentNode.insertBefore(editor, frontEl.nextSibling);
        if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();

        // Auto-resize textareas
        editor.querySelectorAll('.rie-textarea').forEach(ta => {
            ta.style.height = 'auto';
            ta.style.height = ta.scrollHeight + 'px';
            ta.addEventListener('input', () => {
                ta.style.height = 'auto';
                ta.style.height = ta.scrollHeight + 'px';
            });
        });

        // Focus on front
        const frontTa = document.getElementById('rie-front');
        if (frontTa) frontTa.focus();
    };

    window.closeReviewEditor = function() {
        const editor = document.getElementById('review-inline-editor');
        if (editor) editor.remove();
    };

    window.saveReviewEdit = function() {
        if (typeof reviewQueue === 'undefined' || typeof currentReviewIdx === 'undefined') return;
        const card = reviewQueue[currentReviewIdx];
        if (!card) return;

        const frontTa = document.getElementById('rie-front');
        const backTa = document.getElementById('rie-back');
        const explTa = document.getElementById('rie-explanation');

        if (frontTa) card.front = frontTa.value.trim();
        if (backTa) card.back = backTa.value.trim();
        if (explTa) card.explanation = explTa.value.trim();

        // Update cardType if cloze syntax was added/removed
        if (window.hasCloze && window.hasCloze(card.front)) {
            card.cardType = 'cloze';
        } else {
            card.cardType = 'basic';
        }

        card.text = String(card.back || '').trim()
            ? (card.front || '') + ' == ' + card.back
            : (card.front || '');

        if (typeof saveDb === 'function') saveDb();

        // Close editor and refresh the card display
        window.closeReviewEditor();
        if (typeof showReviewCard === 'function') showReviewCard();
        else {
            // Refresh front
            const frontEl = document.getElementById('card-front');
            if (frontEl) {
                if (window.hasCloze && window.hasCloze(card.front)) frontEl.innerHTML = window.clozeMaskHtml(card.front);
                else frontEl.textContent = card.front;
            }
        }
    };

    window.openAddFlashcardModal = function () {
        if (!currentDocId()) { alert('Open a document first.'); return; }
        const f = document.getElementById('new-flashcard-front');
        const b = document.getElementById('new-flashcard-back');
        if (f) f.value = '';
        if (b) b.value = '';
        window.openModal('add-flashcard-modal');
        setTimeout(() => f && f.focus(), 50);
    };

    window.submitManualFlashcard = function () {
        const f = (document.getElementById('new-flashcard-front').value || '').trim();
        const b = (document.getElementById('new-flashcard-back').value || '').trim();
        const isCloze = !!(window.hasCloze && window.hasCloze(f));
        if (!f || (!b && !isCloze)) { alert('Please fill both the front and back (or use {{c1::…}} cloze syntax on the front).'); return; }
        const rem = window.addFlashcardRem(currentDocId(), f, b, 'Manual');
        if (rem && isCloze) rem.cardType = 'cloze';
        if (typeof saveDb === 'function') saveDb();
        window.closeModal('add-flashcard-modal');
        window.renderFlashcardsList();
        if (typeof updateSRSQueue === 'function') updateSRSQueue();
    };

    window.deleteFlashcard = function (id) {
        if (!confirm('Delete this flashcard?')) return;
        const idx = db.rems.findIndex(r => r.id === id);
        if (idx === -1) return;
        db.rems.splice(idx, 1);
        if (typeof saveDb === 'function') saveDb();
        window.renderFlashcardsList();
        if (typeof updateSRSQueue === 'function') updateSRSQueue();
    };

    // Reorder within the flashcards list for the current doc (only reorders among flashcards)
    window.moveFlashcard = function (id, dir) {
        const cards = docFlashcards();
        const pos = cards.findIndex(c => c.id === id);
        if (pos === -1) return;
        const swapPos = pos + dir;
        if (swapPos < 0 || swapPos >= cards.length) return;

        const a = cards[pos];
        const b = cards[swapPos];
        const ai = db.rems.indexOf(a);
        const bi = db.rems.indexOf(b);
        db.rems[ai] = b;
        db.rems[bi] = a;

        if (typeof saveDb === 'function') saveDb();
        window.renderFlashcardsList();
    };

    // Review all of the current doc's flashcards
    window.startFlashcardsReview = function () {
        if (!currentDocId()) return;
        const cards = docFlashcards();
        if (typeof window.startReviewWithCards === 'function') {
            window.startReviewWithCards(cards);
        }
    };

    // Flashcards Explorer Logic
    window.openFlashcardsExplorer = function() {
        if (window.hideAllMainViews) window.hideAllMainViews();

        
        // Show explorer view
        const explorerView = document.getElementById("flashcards-explorer-view");
        if (explorerView) explorerView.style.display = "block";
        
        // Update Sidebar active state
        if (window.setQBankNav) window.setQBankNav('flashcards');

        if (typeof window.closeSidebar === 'function') window.closeSidebar();
        
        renderFlashcardsExplorer();
    };

    window.startSpecialtyReview = function(subject, onlyDue) {
        if (!window.db || !window.db.rems) return;
        let cards = window.db.rems.filter(r => r.isFlashcard && r.subject === subject);
        
        if (onlyDue && window.srs) {
            const now = Date.now();
            cards = cards.filter(r => window.srs.isDue(r, now));
        }

        if (cards.length === 0) {
            alert(onlyDue ? "No cards due for this specialty right now!" : "No flashcards found for this specialty.");
            return;
        }

        // Randomize
        for (let i = cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [cards[i], cards[j]] = [cards[j], cards[i]];
        }

        if (typeof window.startReviewWithCards === 'function') {
            window.startReviewWithCards(cards);
        }
    };

    function renderFlashcardsExplorer() {
        const container = document.getElementById('flashcards-explorer-content');
        if (!container) return;
        
        if (!window.db || !window.db.rems) {
            container.innerHTML = `<div class="text-center p-12 text-on-surface-variant">Loading flashcards...</div>`;
            return;
        }
        
        const now = Date.now();
        
        // Group flashcards by subject
        const specialtyMap = {}; // { subject: { total: number, due: number } }
        let totalDue = 0;
        let totalCards = 0;
        
        window.db.rems.forEach(r => {
            if (r.isFlashcard && r.subject) {
                if (!specialtyMap[r.subject]) {
                    specialtyMap[r.subject] = { total: 0, due: 0 };
                }
                specialtyMap[r.subject].total++;
                totalCards++;
                
                if (window.srs && window.srs.isDue(r, now)) {
                    specialtyMap[r.subject].due++;
                    totalDue++;
                }
            }
        });
        
        const subjects = Object.keys(specialtyMap).sort((a, b) => specialtyMap[b].total - specialtyMap[a].total);

        let html = `
            <div class="flex justify-between items-end mb-8">
                <div>
                    <h1 class="text-3xl font-headline-xl text-on-surface tracking-tight" style="color:#111827;">Flashcards Explorer</h1>
                    <p class="text-lg mt-2" style="color:#6b7280;">Browse and study your generated QBank flashcards by specialty.</p>
                </div>
                <button class="px-6 py-3 rounded-full font-bold shadow-md hover:shadow-lg transition-all" style="background:#007a7a; color:white; border:none; cursor:pointer;" onmouseover="this.style.background='#006666'" onmouseout="this.style.background='#007a7a'" onclick="window.startReviewDueAll && window.startReviewDueAll()">
                    Review All Due (${totalDue})
                </button>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        `;
        
        if (subjects.length === 0) {
            html += `
                <div class="col-span-full bg-surface-container-low border border-outline-variant/30 rounded-2xl p-12 text-center">
                    <div class="w-16 h-16 bg-surface-container-highest rounded-full flex items-center justify-center mx-auto mb-4">
                        <i data-lucide="inbox" class="text-on-surface-variant" style="width:28px;height:28px;"></i>
                    </div>
                    <h3 class="text-xl font-bold text-on-surface mb-2">No Specialty Flashcards Yet</h3>
                    <p class="text-on-surface-variant">Generate AI flashcards from QBank questions to see them organized here by specialty.</p>
                </div>
            `;
        } else {
            subjects.forEach(subject => {
                const stats = specialtyMap[subject];
                html += `
                    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:16px; padding:24px; box-shadow:0 1px 3px rgba(0,0,0,0.05); transition:all 0.2s;" onmouseover="this.style.boxShadow='0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)'; this.style.transform='translateY(-2px)';" onmouseout="this.style.boxShadow='0 1px 3px rgba(0,0,0,0.05)'; this.style.transform='translateY(0)';">
                        <h3 class="text-[1.2rem] font-bold mb-4 relative z-10 leading-tight" style="color:#111827;">${esc(subject)}</h3>
                        
                        <div class="flex gap-4 mb-6 relative z-10">
                            <div class="flex-1 rounded-xl p-3 text-center border" style="background:#f8fafc; border-color:#e2e8f0;">
                                <div class="text-2xl font-bold" style="color:#111827;">${stats.total}</div>
                                <div class="text-[0.75rem] font-bold uppercase tracking-wider mt-1" style="color:#6b7280;">Total Cards</div>
                            </div>
                            <div class="flex-1 rounded-xl p-3 text-center border" style="${stats.due > 0 ? 'background:#fff1f2; border-color:#ffe4e6;' : 'background:#f8fafc; border-color:#e2e8f0;'}">
                                <div class="text-2xl font-bold" style="${stats.due > 0 ? 'color:#e11d48;' : 'color:#111827;'}">${stats.due}</div>
                                <div class="text-[0.75rem] font-bold uppercase tracking-wider mt-1" style="${stats.due > 0 ? 'color:#e11d48;' : 'color:#6b7280;'}">Review Due</div>
                            </div>
                        </div>
                        
                        <div class="mt-auto flex gap-3 relative z-10">
                            <button class="flex-1 py-2.5 px-4 rounded-xl font-bold transition-colors text-sm cursor-pointer" style="background:#f1f5f9; color:#475569; border:none;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f1f5f9'" onclick="window.startSpecialtyReview('${esc(subject).replace(/'/g, "\\'")}', false)">
                                Study All
                            </button>
                            ${stats.due > 0 ? `
                                <button class="flex-1 py-2.5 px-4 rounded-xl font-bold shadow-sm transition-all text-sm cursor-pointer" style="background:#007a7a; color:white; border:none;" onmouseover="this.style.background='#006666'" onmouseout="this.style.background='#007a7a'" onclick="window.startSpecialtyReview('${esc(subject).replace(/'/g, "\\'")}', true)">
                                    Review Due
                                </button>
                            ` : `
                                <button class="flex-1 py-2.5 px-4 rounded-xl font-bold text-sm cursor-not-allowed" style="background:#f8fafc; color:#94a3b8; border:none;" disabled>
                                    All Caught Up
                                </button>
                            `}
                        </div>
                    </div>
                `;
            });
        }
        
        html += `</div>`;
        container.innerHTML = html;
        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    }
})();
