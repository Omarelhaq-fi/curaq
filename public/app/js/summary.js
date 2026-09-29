// Custom Text Selection Popover Logic

let currentSelection = "";
let popoverActive = false;

window.addEventListener('mouseup', handleTextSelection);
window.addEventListener('mousedown', hidePopoverIfClickOutside);

// ============ Touch (mobile/tablet) support ============
// Show our popover on touch selections instead of the native copy/paste callout.
(function injectTouchCalloutCss(){
    try {
        const style = document.createElement('style');
        style.textContent = `#summary-content, #pdf-viewer, .review-modal-content, .textLayer { -webkit-touch-callout: none; }`;
        document.head.appendChild(style);
    } catch(_) {}
})();

function isTouchDevice() {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

function showPopoverForCurrentSelection() {
    const popover = document.getElementById('selection-popover');
    if (!popover) return;
    const sel = window.getSelection();
    const text = sel && sel.toString().trim();
    if (text && text.length >= 1 && isSelectionInsideSummary(sel)) {
        currentSelection = text;
        try {
            const range = sel.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            if (rect && (rect.width || rect.height)) showPopoverAtRect(rect);
        } catch(_) {}
    }
}

window.addEventListener('touchend', (e) => {
    if (!isTouchDevice()) return; // only phones/tablets need touch selection handling
    const popover = document.getElementById('selection-popover');
    if (popover && popover.contains(e.target)) return;
    setTimeout(showPopoverForCurrentSelection, 60);
}, { passive: true });

// Suppress the long-press context menu inside our owned regions on touch devices,
// so only our custom popover appears.
document.addEventListener('contextmenu', (e) => {
    if (!isTouchDevice()) return;
    let node = e.target;
    while (node && node.nodeName !== 'BODY') {
        if (node.id === 'summary-content' || node.id === 'pdf-viewer' ||
            (node.classList && (node.classList.contains('review-modal-content') || node.classList.contains('textLayer')))) {
            e.preventDefault();
            return;
        }
        node = node.parentNode;
    }
});

function handleTextSelection(e) {
    const popover = document.getElementById('selection-popover');

    // Ignore clicks inside the popover itself (guard against null when element absent)
    if (!popover) return;
    if (popover.contains(e.target)) return;

    // Get selection
    const selection = window.getSelection();
    const text = selection.toString().trim();

    if (text.length >= 1 && isSelectionInsideSummary(selection)) {
        currentSelection = text;
        showPopover(e, selection);
    } else {
        hidePopover();
    }
}

function isSelectionInsideSummary(selection) {
    let node = selection.anchorNode;
    while (node && node.nodeName !== 'BODY') {
        if (node.id === 'summary-content' || node.id === 'pdf-viewer' || (node.classList && (node.classList.contains('review-modal-content') || node.classList.contains('textLayer')))) return true;
        node = node.parentNode;
    }
    return false;
}

function showPopover(e, selection) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    showPopoverAtRect(rect);
}

function showPopoverAtRect(rect) {
    const popover = document.getElementById('selection-popover');

    popover.style.visibility = 'hidden';
    popover.classList.add('active');

    const popW = popover.offsetWidth || 460;
    const popH = popover.offsetHeight || 320;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 10;

    let topVp = rect.bottom + 10;
    if (topVp + popH > vh - margin) {
        const aboveTop = rect.top - popH - 10;
        if (aboveTop >= margin) {
            topVp = aboveTop;
        } else {
            topVp = Math.max(margin, vh - popH - margin);
        }
    }

    let leftVp = rect.left + (rect.width / 2) - (popW / 2);
    if (leftVp < margin) leftVp = margin;
    if (leftVp + popW > vw - margin) leftVp = vw - popW - margin;

    popover.style.top = (topVp + window.scrollY) + 'px';
    popover.style.left = (leftVp + window.scrollX) + 'px';

    document.querySelectorAll('.popover-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.popover-btn')[0].classList.add('active');
    document.getElementById('popover-content').innerHTML = '<div style="color:var(--text-muted)">Click "Explain" to get an AI breakdown.</div>';

    popover.style.visibility = '';
    popoverActive = true;
}

// ============ PDF iframe text selection support ============
(function attachPdfIframeSelection() {
    const iframe = document.getElementById('pdf-iframe');
    if (!iframe) return;

    let attachedDoc = null;

    function attach() {
        try {
            const doc = iframe.contentDocument;
            if (!doc || doc === attachedDoc) return;
            attachedDoc = doc;

            doc.addEventListener('mouseup', () => {
                setTimeout(() => {
                    try {
                        const sel = iframe.contentWindow.getSelection();
                        const text = sel && sel.toString().trim();
                        if (!text || text.length < 1) return;
                        const range = sel.getRangeAt(0);
                        const r = range.getBoundingClientRect();
                        const ifr = iframe.getBoundingClientRect();
                        const rect = {
                            top: ifr.top + r.top,
                            bottom: ifr.top + r.bottom,
                            left: ifr.left + r.left,
                            right: ifr.left + r.right,
                            width: r.width,
                            height: r.height,
                        };
                        currentSelection = text;
                        showPopoverAtRect(rect);
                    } catch (_) { /* cross-origin or no selection */ }
                }, 10);
            });
        } catch (_) { /* cross-origin */ }
    }

    iframe.addEventListener('load', attach);
    attach();
    setInterval(attach, 1500);
})();


function hidePopover() {
    const popover = document.getElementById('selection-popover');
    if (!popover) return;
    popover.classList.remove('active');
    popoverActive = false;
    currentSelection = "";
}

function hidePopoverIfClickOutside(e) {
    if (!popoverActive) return;
    const popover = document.getElementById('selection-popover');
    if (!popover || !popover.contains(e.target)) {
        // We defer hide so mouseup has a chance to catch a new selection
        setTimeout(() => {
            const sel = window.getSelection().toString().trim();
            if (!sel) hidePopover();
        }, 10);
    }
}

// AI Integration for Popover
window.explainText = async function () {
    if (!currentSelection) return;

    document.querySelectorAll('.popover-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.popover-btn')[0].classList.add('active');

    const contentDiv = document.getElementById('popover-content');
    contentDiv.innerHTML = '<div style="color:var(--accent-active)">Analyzing sentence...</div>';

    const reply = await window.aiTask("fast_explain", { sentence: currentSelection });
    if (typeof reply === "string" && reply.trim()) {
        contentDiv.innerHTML = window.safeHTML(reply);
    } else {
        const msg = (reply && reply._error) ? reply._error : "Failed to explain text.";
        console.warn("[fast_explain] failed:", reply);
        contentDiv.innerHTML = `<div style="color:#f43;font-size:0.85rem;line-height:1.4;">${window.safeHTML ? window.safeHTML(msg) : window.escapeHTML(msg)}</div>`;
    }

}

window.docExplainText = async function () {
    if (!currentSelection) return;
    
    const textToExplain = currentSelection; // Save it before hidePopover clears it

    hidePopover(); // Hide the selection menu

    if (typeof window.openFullscreen === 'function') {
        window.openFullscreen('doc-explain-modal');
    } else {
        const m = document.getElementById('doc-explain-modal');
        if (m) m.style.display = 'flex';
    }

    const modalContainer = document.getElementById('doc-explain-modal-container');
    if (modalContainer) modalContainer.style.maxWidth = '600px';

    const contentDiv = document.getElementById('doc-explain-modal-content');
    contentDiv.innerHTML = '<div style="color:var(--accent-active); text-align: center; margin-top: 20px;">Analyzing as a senior tutor...</div>';

    const reply = await window.aiTask("smart_explain_sentence", { sentence: textToExplain });
    if (reply && !reply._error) {
        let cleanReply = String(reply).replace(/```html/gi, '').replace(/```/g, '').trim();
        contentDiv.innerHTML = window.safeHTML(cleanReply);
    } else {
        contentDiv.innerHTML = (window.aiErrorHTML ? window.aiErrorHTML(reply) : '<div style="color:#aab0c6;text-align:center;padding:16px;">AI unavailable. Try again.</div>');
    }

}

window.addCardFromSelection = async function () {
    if (!currentSelection) return;

    document.querySelectorAll('.popover-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.popover-btn')[2].classList.add('active'); // Index 2 is Add Card

    const contentDiv = document.getElementById('popover-content');
    contentDiv.innerHTML = '<div style="color:var(--accent-active)">Generating flashcard...</div>';

    const reply = await window.aiTask("flashcard_from_sentence", { sentence: currentSelection });
    if (reply && !reply._error) {
        try {
            let clean = String(reply).replace(/```json/gi, '').replace(/```/g, '').trim();
            const data = JSON.parse(clean);
            if (data.front && data.back && window.addFlashcardRem) {
                window.addFlashcardRem(activeDocId, data.front, data.back, 'Selection');
                if (window.saveDb) window.saveDb();
                if (window.renderRems) window.renderRems();
                if (window.renderFlashcardsList) window.renderFlashcardsList();
                if (window.updateSRSQueue) window.updateSRSQueue();

                contentDiv.innerHTML = `<div style="color:#22c55e; font-weight:bold;"><i data-lucide="check-circle-2"></i> Flashcard added!</div>
                                        <div style="margin-top:10px; color:var(--text-muted)">Q: ${window.clozeMaskHtml ? window.clozeMaskHtml(data.front) : data.front}<br>A: ${window.clozeRevealHtml ? window.clozeRevealHtml(data.back || data.front) : data.back}</div>`;
            }
        } catch (e) {
            contentDiv.innerHTML = '<div style="color:red">Failed to generate flashcard.</div>';
        }
    } else {
        contentDiv.innerHTML = '<div style="color:red">Failed to generate flashcard.</div>';
    }

}

window.copyExplanation = function () {
    const text = document.getElementById('popover-content').innerText;
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.querySelector('.btn-copy');
        const orig = btn.innerText;
        btn.innerText = 'Copied!';
        setTimeout(() => btn.innerText = orig, 2000);
    });
}

window.showImageForSelection = function () {
    if (!currentSelection) return;

    const term = currentSelection.trim();
    hidePopover();

    // Open Google Images in a small popup window over the app
    const url = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(term)}`;
    const windowFeatures = "width=1000,height=700,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes";
    window.open(url, 'ImageSearch', windowFeatures);
}
// Tablet Toolbar Integrations
window.tabletExplain = function() {
    const text = window.getSelection().toString().trim();
    if (!text || text.length < 1) return alert('Please select some text first.');
    currentSelection = text;
    
    const popover = document.getElementById('selection-popover');
    popover.style.transform = 'none';
    popover.style.top = (window.innerHeight / 2 - 100) + 'px';
    popover.style.left = (window.innerWidth / 2 - 225) + 'px';
    popover.classList.add('active');
    popoverActive = true;
    
    window.explainText();
};

window.tabletDocExplain = function() {
    const text = window.getSelection().toString().trim();
    if (!text || text.length < 1) return alert('Please select some text first.');
    currentSelection = text;
    
    // We don't need to show the popover since docExplainText handles its own modal now
    window.docExplainText();
};

// Wrap every text node inside the range with a fresh clone of `wrapper`.
// This safely handles selections that cross element boundaries (multiple
// lines, list items, paragraphs) without pulling block elements into a
// span or duplicating list bullets.
function wrapRangeTextNodes(range, wrapper) {
    const root = range.commonAncestorContainer;
    const rootEl = root.nodeType === 1 ? root : root.parentNode;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    if (!nodes.length) return false;

    nodes.forEach((node) => {
        let start = 0;
        let end = node.nodeValue.length;
        if (node === range.startContainer) start = range.startOffset;
        if (node === range.endContainer) end = range.endOffset;
        if (end <= start) return;

        // Split so we only wrap the selected slice of this text node
        let target = node;
        if (start > 0) target = target.splitText(start);
        if (end - start < target.nodeValue.length) target.splitText(end - start);

        const w = wrapper.cloneNode(false);
        target.parentNode.insertBefore(w, target);
        w.appendChild(target);
    });
    return true;
}

window.highlightSelection = function() {
    if (!currentSelection) return;
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const mark = document.createElement('mark');
    mark.style.backgroundColor = 'rgba(245, 158, 11, 0.4)';
    mark.style.color = 'inherit';
    mark.style.borderRadius = '2px';
    try {
        try {
            range.surroundContents(mark);
        } catch (_) {
            wrapRangeTextNodes(range, mark);
        }
        selection.removeAllRanges();
        if (window.saveEditedSummary) window.saveEditedSummary();
    } catch (e) {
        console.warn('highlight failed', e);
    }
    hidePopover();
};

window.addNoteToSelection = function() {
    if (!currentSelection) return;
    const note = prompt("Enter your note:");
    if (!note) return;
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const span = document.createElement('span');
    span.style.borderBottom = '2px dashed var(--accent-cyan)';
    span.style.cursor = 'help';
    span.title = note;
    try {
        try {
            range.surroundContents(span);
        } catch (_) {
            wrapRangeTextNodes(range, span);
        }
        selection.removeAllRanges();
        if (window.saveEditedSummary) window.saveEditedSummary();
    } catch (e) {
        console.warn('note failed', e);
    }
    hidePopover();
};

window.saveEditedSummary = function() {
    const contentDiv = document.getElementById('summary-content');
    if (!contentDiv || !window.currentSummaryTopic) return;
    
    const clone = contentDiv.cloneNode(true);
    const quizzes = clone.querySelectorAll('.section-quiz-wrap');
    quizzes.forEach(q => q.remove());
    
    const doc = window.getActiveDoc ? window.getActiveDoc() : null;
    if (doc && doc.sections) {
        const sec = doc.sections.find(s => s.title === window.currentSummaryTopic);
        if (sec) {
            sec.summaryCacheHTML = clone.innerHTML;
            if (typeof saveDb === 'function') saveDb();
        }
    }
};

window.editSelectionText = function() {
    if (!currentSelection) return;
    const newText = prompt("Edit text:", currentSelection);
    if (newText !== null) {
        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(newText));
        if (window.saveEditedSummary) window.saveEditedSummary();
    }
    hidePopover();
};

window.tabletFlashcard = function() {
    const text = window.getSelection().toString().trim();
    if (!text || text.length < 1) return alert('Please select some text first.');
    currentSelection = text;
    
    const popover = document.getElementById('selection-popover');
    popover.style.transform = 'none';
    popover.style.top = (window.innerHeight / 2 - 100) + 'px';
    popover.style.left = (window.innerWidth / 2 - 225) + 'px';
    popover.classList.add('active');
    popoverActive = true;
    
    window.addCardFromSelection();
};

window.tabletHighlight = function() {
    const text = window.getSelection().toString().trim();
    if (!text || text.length < 1) return alert('Please select some text first.');
    currentSelection = text;
    window.highlightSelection();
};



window.explainCurrentSummary = async function () {
    if (!window.currentSummaryTopic) return;
    const doc = window.getActiveDoc ? window.getActiveDoc() : null;
    if (!doc || !doc.sections) return;
    const sec = doc.sections.find(s => s.title === window.currentSummaryTopic);
    if (!sec || !sec.summaryCache) return;

    const textToExplain = sec.summaryCache; // The entire summary

    if (typeof window.openFullscreen === 'function') {
        window.openFullscreen('doc-explain-modal');
    } else {
        const m = document.getElementById('doc-explain-modal');
        if (m) m.style.display = 'flex';
    }

    const modalContainer = document.getElementById('doc-explain-modal-container');
    if (modalContainer) modalContainer.style.maxWidth = '1200px';

    const contentDiv = document.getElementById('doc-explain-modal-content');

    // If a previously generated Smart Explain exists for this section, show it
    if (sec.smartExplainCache) {
        contentDiv.innerHTML = sec.smartExplainCache;
        return;
    }

    contentDiv.innerHTML = '<div style="color:var(--accent-active); text-align: center; margin-top: 20px;">Analyzing the full summary... (may take a moment)</div>';

    const reply = await window.aiTask("smart_explain_summary", { text: textToExplain });
    if (reply && !reply._error) {
        let cleanReply = String(reply).replace(/```html/gi, '').replace(/```/g, '').trim();
        contentDiv.innerHTML = window.safeHTML(cleanReply);
        sec.smartExplainCache = cleanReply;
        if (typeof saveDb === 'function') saveDb();
    } else {
        contentDiv.innerHTML = (window.aiErrorHTML ? window.aiErrorHTML(reply) : '<div style="color:#aab0c6;text-align:center;padding:16px;">AI unavailable. Try again.</div>');
    }

}
