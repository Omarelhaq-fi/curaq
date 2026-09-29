// Editor, Rem, Flashcard & SRS Review Logic

// ============================================================
// ADD REM — Core function to add a rem (note/flashcard) to the db
// ============================================================
window.addRem = function (docId, text, indent, parentId, sourceText, topic) {
    const id = crypto.randomUUID().replace(/-/g,'').slice(0,9);
    const rem = {
        id: id,
        docId: docId,
        text: text || '',
        indent: indent || 0,
        parentId: parentId || null,
        isFlashcard: false,
        front: '',
        back: '',
        sourceText: sourceText || '',
        topic: topic || null,
        ease: 2.5,
        interval: 0,
        nextReview: 0,
        created: Date.now()
    };
    db.rems.push(rem);
    return rem;
};

// Add a manual flashcard directly (used by the Flashcards tab)
window.addFlashcardRem = function (docId, front, back, topic) {
    const id = crypto.randomUUID().replace(/-/g,'').slice(0,9);
    const rem = {
        id: id,
        docId: docId,
        text: (back || '').trim() ? (front || '') + ' == ' + back : (front || ''),
        indent: 0,
        parentId: null,
        isFlashcard: true,
        front: front || '',
        back: back || '',
        sourceText: '',
        topic: topic || null,
        manual: true,
        ease: 2.5,
        interval: 0,
        nextReview: Date.now(),
        created: Date.now()
    };
    db.rems.push(rem);
    return rem;
};

// ============================================================
// RENDER REMS — Renders the outliner-style editor in the notes view
// ============================================================
window.renderRems = function () {
    const container = document.getElementById('editor-container');
    if (!container || !activeDocId) return;

    const docRems = db.rems.filter(r => r.docId === activeDocId && !r.isFlashcard);
    container.innerHTML = '';

    if (docRems.length === 0) {
        // Add a blank rem so the editor isn't empty
        window.addRem(activeDocId, '', 0);
        if (typeof saveDb === 'function') saveDb();
        window.renderRems();
        return;
    }

    docRems.forEach((rem, idx) => {
        const row = document.createElement('div');
        row.className = 'rem-row';
        row.style.paddingLeft = (rem.indent * 24) + 'px';
        row.setAttribute('data-rem-id', rem.id);
        row.style.display = 'flex';
        row.style.alignItems = 'flex-start';
        row.style.gap = '6px';
        row.style.marginBottom = '2px';
        row.style.position = 'relative';
        row.style.animation = 'fadeIn 0.15s ease';

        // Bullet
        const bullet = document.createElement('div');
        bullet.style.width = '6px';
        bullet.style.height = '6px';
        bullet.style.borderRadius = '50%';
        bullet.style.marginTop = '10px';
        bullet.style.flexShrink = '0';
        bullet.style.transition = 'all 0.2s';

        if (rem.isFlashcard) {
            bullet.style.background = 'var(--accent-amber)';
            bullet.style.boxShadow = '0 0 6px rgba(245,158,11,0.4)';
        } else {
            bullet.style.background = 'var(--text-dim)';
        }

        // Input
        const input = document.createElement('div');
        input.contentEditable = true;
        input.className = 'rem-input';
        input.style.flex = '1';
        input.style.background = 'transparent';
        input.style.border = 'none';
        input.style.color = 'var(--text-primary)';
        input.style.outline = 'none';
        input.style.fontFamily = 'inherit';
        input.style.fontSize = '0.95rem';
        input.style.lineHeight = '1.6';
        input.style.padding = '4px 8px';
        input.style.borderRadius = '4px';
        input.style.transition = 'background 0.2s';
        input.style.minHeight = '28px';
        input.style.wordBreak = 'break-word';

        input.textContent = rem.text;

        // Focus styling
        input.addEventListener('focus', () => {
            input.style.background = 'rgba(255,255,255,0.03)';
        });

        input.addEventListener('blur', () => {
            input.style.background = 'transparent';
            const newText = input.textContent || input.innerText;
            if (newText !== rem.text) {
                rem.text = newText;
                if (typeof saveDb === 'function') saveDb();
            }
        });

        // Keyboard: Enter to add new rem, Tab/Shift+Tab for indent
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const newRem = window.addRem(activeDocId, '', rem.indent);
                // Insert after current rem
                const currentIdx = db.rems.indexOf(rem);
                const newRemObj = db.rems.pop(); // remove from end
                db.rems.splice(currentIdx + 1, 0, newRemObj); // insert after current
                if (typeof saveDb === 'function') saveDb();
                window.renderRems();
                // Focus on new rem
                setTimeout(() => {
                    const newRow = document.querySelector(`[data-rem-id="${newRem.id}"] .rem-input`);
                    if (newRow) newRow.focus();
                }, 50);
            }

            if (e.key === 'Tab') {
                e.preventDefault();
                if (e.shiftKey) {
                    rem.indent = Math.max(0, rem.indent - 1);
                } else {
                    rem.indent = Math.min(5, rem.indent + 1);
                }
                if (typeof saveDb === 'function') saveDb();
                window.renderRems();
            }

            if (e.key === 'Backspace' && (input.textContent || input.innerText).trim() === '') {
                e.preventDefault();
                if (docRems.length > 1) {
                    db.rems = db.rems.filter(r => r.id !== rem.id);
                    if (typeof saveDb === 'function') saveDb();
                    window.renderRems();
                    // Focus previous rem
                    const prevIdx = Math.max(0, idx - 1);
                    setTimeout(() => {
                        const inputs = container.querySelectorAll('.rem-input');
                        if (inputs[prevIdx]) inputs[prevIdx].focus();
                    }, 50);
                }
            }
        });

        // Delete button (visible on hover)
        const delBtn = document.createElement('button');
        delBtn.textContent = '×';
        delBtn.style.background = 'transparent';
        delBtn.style.border = 'none';
        delBtn.style.color = 'var(--text-dim)';
        delBtn.style.cursor = 'pointer';
        delBtn.style.fontSize = '1rem';
        delBtn.style.padding = '4px 6px';
        delBtn.style.borderRadius = '4px';
        delBtn.style.opacity = '0';
        delBtn.style.transition = 'all 0.2s';

        row.addEventListener('mouseenter', () => { delBtn.style.opacity = '1'; });
        row.addEventListener('mouseleave', () => { delBtn.style.opacity = '0'; });

        delBtn.addEventListener('click', () => {
            if (docRems.length > 1) {
                db.rems = db.rems.filter(r => r.id !== rem.id);
                if (typeof saveDb === 'function') saveDb();
                if (typeof updateSRSQueue === 'function') updateSRSQueue();
                window.renderRems();
            }
        });

        row.appendChild(bullet);
        row.appendChild(input);
        row.appendChild(delBtn);
        container.appendChild(row);
    });
};

// ============================================================
// SRS REVIEW — Spaced repetition review session
// ============================================================
let reviewQueue = [];
let currentReviewIdx = 0;
let reviewFlaggedSet = new Set();

// Open / close the USMLE full-screen overlay
window.openFullscreen = function(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
};
window.closeFullscreen = function(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
    if (id === 'qbank-modal') {
        const sidebar = document.getElementById('qbank-sidebar');
        if (sidebar) sidebar.style.display = 'none';
    }
};

window.startReview = function () {
    if (!activeDocId) return;
    const now = Date.now();
    // SM-2: due = never reviewed OR nextReview <= now; leeches suspended.
    reviewQueue = db.rems.filter(r => r.isFlashcard && r.docId === activeDocId && !r.leech && (!r.nextReview || r.nextReview <= now));

    if (reviewQueue.length === 0) {
        // Nothing due — fall back to reviewing every card of this doc.
        const all = db.rems.filter(r => r.isFlashcard && r.docId === activeDocId && !r.leech);
        if (all.length === 0) { alert("No flashcards yet in this document."); return; }
        reviewQueue = all.slice();
    }
    if (window.srs) reviewQueue.forEach(c => window.srs.ensureSrs(c));

    reviewFlaggedSet = new Set();
    reviewQueue.forEach((c, i) => { if (c.flagged) reviewFlaggedSet.add(i); });
    currentReviewIdx = 0;
    buildReviewSidebar();
    showReviewCard();
    window.openFullscreen('review-modal');
};

// Library-wide "Review Due" — pulls cards from every doc.
window.startReviewDueAll = function () {
    if (!window.srs) return;
    const due = window.srs.buildDueQueueAll();
    if (due.length === 0) { alert('No cards due right now — nice work!'); return; }
    due.forEach(c => window.srs.ensureSrs(c));
    reviewQueue = due;
    reviewFlaggedSet = new Set();
    reviewQueue.forEach((c, i) => { if (c.flagged) reviewFlaggedSet.add(i); });
    currentReviewIdx = 0;
    buildReviewSidebar();
    showReviewCard();
    window.openFullscreen('review-modal');
};

window.startChunkReview = function (topic) {
    if (!activeDocId) return;
    
    reviewQueue = db.rems.filter(r => r.isFlashcard && r.docId === activeDocId && (r.topic === topic || (r.topic && r.topic.includes(topic))));

    if (reviewQueue.length === 0) {
        alert("No flashcards found for this section! Generate them first.");
        return;
    }

    reviewFlaggedSet = new Set();
    reviewQueue.forEach((c, i) => { if (c.flagged) reviewFlaggedSet.add(i); });
    currentReviewIdx = 0;
    buildReviewSidebar();
    showReviewCard();
    window.openFullscreen('review-modal');
};

// Start review with an arbitrary set of cards (used by the Flashcards tab)
window.startReviewWithCards = function (cards) {
    if (!cards || cards.length === 0) { alert('No flashcards to review yet.'); return; }
    reviewQueue = cards.slice();
    reviewFlaggedSet = new Set();
    reviewQueue.forEach((c, i) => { if (c.flagged) reviewFlaggedSet.add(i); });
    currentReviewIdx = 0;
    buildReviewSidebar();
    showReviewCard();
    window.openFullscreen('review-modal');
};

function buildReviewSidebar() {
    const sidebar = document.getElementById('review-sidebar');
    if (!sidebar) return;
    sidebar.innerHTML = '';
    reviewQueue.forEach((card, idx) => {
        const item = document.createElement('div');
        item.className = 'usmle-sidebar-item' + (idx === currentReviewIdx ? ' active' : '');
        item.id = `review-sidebar-item-${idx}`;
        item.textContent = idx + 1;
        item.onclick = () => { currentReviewIdx = idx; buildReviewSidebar(); showReviewCard(); };
        sidebar.appendChild(item);
    });
}

function updateReviewSidebarActive() {
    document.querySelectorAll('.usmle-sidebar-item').forEach((el, idx) => {
        el.classList.toggle('active', idx === currentReviewIdx);
        if (reviewFlaggedSet.has(idx)) el.classList.add('flagged');
        else el.classList.remove('flagged');
    });
    // scroll active into view
    const activeEl = document.getElementById(`review-sidebar-item-${currentReviewIdx}`);
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

window.reviewNavPrev = function() {
    if (currentReviewIdx > 0) {
        currentReviewIdx--;
        updateReviewSidebarActive();
        showReviewCard();
    }
};

window.reviewNavNext = function() {
    if (currentReviewIdx < reviewQueue.length - 1) {
        currentReviewIdx++;
        updateReviewSidebarActive();
        showReviewCard();
    }
};

window.toggleReviewFlag = function() {
    const btn = document.getElementById('review-flag-btn');
    const card = reviewQueue[currentReviewIdx];
    if (reviewFlaggedSet.has(currentReviewIdx)) {
        reviewFlaggedSet.delete(currentReviewIdx);
        if (card) card.flagged = false;
        if (btn) btn.classList.remove('flagged');
    } else {
        reviewFlaggedSet.add(currentReviewIdx);
        if (card) card.flagged = true;
        if (btn) btn.classList.add('flagged');
    }
    if (typeof saveDb === 'function') saveDb();
    updateReviewSidebarActive();
};


function showReviewCard() {
    if (currentReviewIdx >= reviewQueue.length) {
        window.closeFullscreen('review-modal');
        alert('Review session complete!');
        if (typeof refreshAppUI === 'function') refreshAppUI();
        return;
    }

    const card = reviewQueue[currentReviewIdx];
    const doc = db.documents.find(d => d.id === card.docId);

    // Close any open inline editor
    if (typeof window.closeReviewEditor === 'function') window.closeReviewEditor();

    // Update top bar info
    const countEl = document.getElementById('review-count');
    if (countEl) countEl.textContent = currentReviewIdx + 1;
    const docTitleEl = document.getElementById('review-doc-title');
    if (docTitleEl) docTitleEl.textContent = doc ? doc.title : 'Document';
    const navCounter = document.getElementById('review-nav-counter');
    if (navCounter) navCounter.textContent = `${currentReviewIdx + 1} / ${reviewQueue.length}`;
    const statusText = document.getElementById('review-status-text');
    if (statusText) statusText.textContent = 'Press Space to reveal answer';

    // Flag state
    const flagBtn = document.getElementById('review-flag-btn');
    if (flagBtn) {
        flagBtn.classList.toggle('flagged', reviewFlaggedSet.has(currentReviewIdx));
    }

    // Set question text (cloze deletions rendered as hidden blanks)
    const frontEl = document.getElementById('card-front');
    if (frontEl) {
        if (window.hasCloze && window.hasCloze(card.front)) frontEl.innerHTML = window.clozeMaskHtml(card.front);
        else frontEl.textContent = card.front;
    }

    // Reset answer area
    const backEl = document.getElementById('card-back');
    if (backEl) {
        backEl.innerHTML = '';
        backEl.style.display = 'none';
    }



    // Reset buttons
    const showBtn = document.getElementById('btn-show-answer');
    if (showBtn) showBtn.style.display = 'inline-block';
    const srsButtons = document.getElementById('srs-buttons');
    if (srsButtons) srsButtons.style.display = 'none';
    const docExplainBtn = document.getElementById('btn-doc-explain-card');
    if (docExplainBtn) docExplainBtn.style.display = 'none';
    const srsMeta = document.getElementById('card-srs-meta');
    if (srsMeta) srsMeta.style.display = 'none';

    // Show source if available
    const sourcesBlock = document.getElementById('card-sources-block');
    const sourceText = document.getElementById('card-source-text');
    if (card.sourceText && card.sourceText.trim()) {
        if (sourceText) sourceText.textContent = card.sourceText;
        if (sourcesBlock) sourcesBlock.style.display = 'none'; // Hidden until answer shown
    } else {
        if (sourcesBlock) sourcesBlock.style.display = 'none';
    }
    
    // Update sidebar active
    updateReviewSidebarActive();
}

/* Builds the AnKing-style back of a card:
   completed sentence / answer, "Why?" explanation, related bullets. */
window.renderCardBackHtml = function (card) {
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const front = card.front || '';
    const isCloze = !!(window.hasCloze && window.hasCloze(front));
    let html = '';

    if (isCloze) {
        const answers = window.clozeAnswers ? window.clozeAnswers(front) : [];
        if (answers.length) {
            html += `<div class="card-back-answer"><span class="card-back-label">Answer:</span> ${answers.map(a => `<span class="cloze-answer">${esc(a)}</span>`).join(' · ')}</div>`;
        }
        html += `<div class="card-back-sentence">${window.clozeRevealHtml ? window.clozeRevealHtml(front) : esc(front)}</div>`;
        if (String(card.back || '').trim()) {
            html += `<div class="card-back-note">${esc(card.back)}</div>`;
        }
    } else {
        html += `<div class="card-back-answer"><span class="card-back-label">Answer:</span> <span class="cloze-answer">${esc(card.back || '')}</span></div>`;
    }

    if (String(card.explanation || '').trim()) {
        const explHtml = (window.marked && window.marked.parse) ? window.marked.parse(card.explanation) : card.explanation;
        html += `<div class="card-back-why"><div class="card-back-label">Why?</div><div class="ai-concept-breakdown">${explHtml}</div></div>`;
    }
    const extras = Array.isArray(card.extras) ? card.extras.filter(x => String(x || '').trim()) : [];
    if (extras.length) {
        html += `<div class="card-back-extras"><div class="card-back-label">Related</div><ul>${extras.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
    }
    return html;
};

window.showAnswer = function () {
    const card = reviewQueue[currentReviewIdx];
    if (!card) return;

    // Reveal answer in the styled reveal box
    const backEl = document.getElementById('card-back');
    if (backEl) {
        backEl.innerHTML = window.renderCardBackHtml(card);
        backEl.style.display = 'block';
    }


    const showBtn = document.getElementById('btn-show-answer');
    if (showBtn) showBtn.style.display = 'none';
    const srsButtons = document.getElementById('srs-buttons');
    if (srsButtons) srsButtons.style.display = 'flex';
    
    const docExplainBtn = document.getElementById('btn-doc-explain-card');
    if (docExplainBtn) docExplainBtn.style.display = 'inline-flex';

    const statusText = document.getElementById('review-status-text');
    if (statusText) statusText.textContent = '1=Again  2=Hard  3=Good  4=Easy';

    // Show sources if available
    if (card.sourceText && card.sourceText.trim()) {
        const sourcesBlock = document.getElementById('card-sources-block');
        if (sourcesBlock) sourcesBlock.style.display = 'block';
    }

    // Show SM-2 meta (reps · ease · next projections)
    const meta = document.getElementById('card-srs-meta');
    if (meta && window.srs) {
        window.srs.ensureSrs(card);
        const reps = card.reps || 0;
        const ease = (card.ease || 2.5).toFixed(2);
        const nextGood = card.reps === 0 ? '1d' : card.reps === 1 ? '6d' : Math.max(1, Math.round((card.interval || 1) * (card.ease || 2.5))) + 'd';
        meta.style.display = 'block';
        meta.innerHTML = `seen <strong>${reps}×</strong> · ease <strong>${ease}</strong> · if Good → <strong>${nextGood}</strong>${card.lapses ? ` · lapses ${card.lapses}` : ''}${card.leech ? ' · <i data-lucide="bug"></i> leech' : ''}`;
    }
};

window.submitReview = function (rating) {
    const card = reviewQueue[currentReviewIdx];
    if (!card) return;

    // SM-2 grading via srs.js. Accepts 'again' | 'hard' | 'good' | 'easy'.
    // Also tolerates legacy names ('forgot' → 'again', 'disable' → suspend as leech).
    if (rating === 'forgot') rating = 'again';
    if (rating === 'disable') {
        card.leech = true;
        card.nextReview = Date.now() + 365 * 24 * 60 * 60 * 1000;
    } else if (window.srs) {
        window.srs.gradeCard(card, rating);
        window.srs.logGrade(rating);
    }

    if (typeof saveDb === 'function') saveDb();
    if (typeof updateSRSQueue === 'function') updateSRSQueue();
    if (typeof window.refreshSchedulerView === 'function') window.refreshSchedulerView();

    // Mark sidebar item; color hint by rating
    const sidebarItem = document.getElementById(`review-sidebar-item-${currentReviewIdx}`);
    if (sidebarItem) {
        sidebarItem.classList.add('answered');
        sidebarItem.setAttribute('data-rating', rating);
    }

    // "Again" cards get re-queued to the end of THIS session.
    if (rating === 'again') {
        reviewQueue.push(card);
    }

    currentReviewIdx++;
    if (currentReviewIdx >= reviewQueue.length) {
        window.closeFullscreen('review-modal');
        alert('Review session complete!');
        if (typeof refreshAppUI === 'function') refreshAppUI();
    } else {
        buildReviewSidebar();
        updateReviewSidebarActive();
        showReviewCard();
    }
};

window.explainCurrentFlashcard = function() {
    const card = reviewQueue[currentReviewIdx];
    if (!card) return;
    
    let textToExplain = (window.clozePlain ? window.clozePlain(card.front) : card.front) + " → " + (window.clozePlain ? window.clozePlain(card.back) : card.back);
    
    // Check if the user has selected specific text
    const selection = window.getSelection().toString().trim();
    if (selection.length > 0) {
        textToExplain = selection;
    }
    
    if (typeof window.openModal === 'function') {
        window.openFullscreen('doc-explain-modal');
    } else {
        const m = document.getElementById('doc-explain-modal');
        if (m) m.style.display = 'flex';
    }

    const contentDiv = document.getElementById('doc-explain-modal-content');
    contentDiv.innerHTML = '<div style="color:var(--accent-active); text-align: center; margin-top: 20px;">Analyzing as a senior tutor...</div>';

    window.aiTask("smart_explain_sentence", { sentence: textToExplain }).then(reply => {
        if (reply && !reply._error) {
            let cleanReply = String(reply).replace(/```html/gi, '').replace(/```/g, '').trim();
            contentDiv.innerHTML = cleanReply;
        } else {
            contentDiv.innerHTML = (window.aiErrorHTML ? window.aiErrorHTML(reply) : '<div style="color:#aab0c6;text-align:center;padding:16px;">AI unavailable. Try again.</div>');
        }
    });

};

// ============================================================
// HELPERS
// ============================================================
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Initialize on DOM ready
window.addEventListener('DOMContentLoaded', () => {
    // renderRems will be called by refreshAppUI in app.js
    
    // Flashcard keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        const reviewModal = document.getElementById('review-modal');
        if (reviewModal && reviewModal.style.display !== 'none') {
            const btnShowAnswer = document.getElementById('btn-show-answer');
            const srsButtons = document.getElementById('srs-buttons');
            
            if (btnShowAnswer && btnShowAnswer.style.display !== 'none') {
                if (e.code === 'Space') {
                    e.preventDefault();
                    window.showAnswer();
                }
            } else if (srsButtons && srsButtons.style.display !== 'none') {
                if (e.key === '1') { e.preventDefault(); window.submitReview('again'); }
                else if (e.key === '2') { e.preventDefault(); window.submitReview('hard'); }
                else if (e.key === '3') { e.preventDefault(); window.submitReview('good'); }
                else if (e.key === '4') { e.preventDefault(); window.submitReview('easy'); }
            }
            
            // Arrow key navigation
            if (e.key === 'ArrowLeft') { e.preventDefault(); window.reviewNavPrev(); }
            if (e.key === 'ArrowRight') { e.preventDefault(); window.reviewNavNext(); }
            // 'E' to edit (only when not already editing inside a textarea)
            if ((e.key === 'e' || e.key === 'E') && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
                e.preventDefault();
                if (typeof window.editCurrentReviewCard === 'function') window.editCurrentReviewCard();
            }
        }
        
        // Escape closes any open fullscreen
        if (e.key === 'Escape') {
            const reviewModal = document.getElementById('review-modal');
            const examModal = document.getElementById('exam-modal');
            if (reviewModal && reviewModal.style.display !== 'none') window.closeFullscreen('review-modal');
            if (examModal && examModal.style.display !== 'none') window.closeFullscreen('exam-modal');
        }
    });
});