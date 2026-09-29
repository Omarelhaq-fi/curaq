// PDF Upload and Processing Logic

// In-memory cache of local PDF object URLs per document (session only)
window.pdfUrlCache = window.pdfUrlCache || {};

// ---------- IndexedDB persistence for uploaded PDFs (no server) ----------
const PDF_IDB_NAME = 'omnote-pdfs';
const PDF_IDB_STORE = 'files';
const PDF_MAX_PERSIST_BYTES = 50 * 1024 * 1024; // 50MB cap per doc

function _openPdfIDB() {
    return new Promise((resolve, reject) => {
        try {
            const req = indexedDB.open(PDF_IDB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(PDF_IDB_STORE)) db.createObjectStore(PDF_IDB_STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        } catch (e) { reject(e); }
    });
}

async function _idbPut(key, blob) {
    const db = await _openPdfIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(PDF_IDB_STORE, 'readwrite');
        tx.objectStore(PDF_IDB_STORE).put(blob, key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function _idbGet(key) {
    const db = await _openPdfIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(PDF_IDB_STORE, 'readonly');
        const req = tx.objectStore(PDF_IDB_STORE).get(key);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

async function _idbDelete(key) {
    try {
        const db = await _openPdfIDB();
        return new Promise((resolve) => {
            const tx = db.transaction(PDF_IDB_STORE, 'readwrite');
            tx.objectStore(PDF_IDB_STORE).delete(key);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); resolve(); };
        });
    } catch (_) { /* ignore */ }
}

async function _persistPdfFile(docId, file) {
    if (!docId || !file) return;
    if (file.size > PDF_MAX_PERSIST_BYTES) {
        console.warn(`[pdf] Skipping IDB persist for ${file.name} (${(file.size/1024/1024).toFixed(1)}MB > 50MB cap)`);
        return;
    }
    try {
        if (navigator.storage && navigator.storage.persist) {
            try { await navigator.storage.persist(); } catch (_) {}
        }
        await _idbPut(docId, file);
    } catch (e) {
        console.warn('[pdf] Failed to persist PDF to IndexedDB:', e);
    }
}

window.deletePersistedPdf = function (docId) { return _idbDelete(docId); };

let _pdfRenderToken = 0;

// ---------- Background-tab keepalive for long OCR jobs ----------
let _ocrWakeLock = null;
let _ocrKeepAudio = null;
let _ocrKeepAudioCtx = null;
let _ocrKeepOsc = null;
let _ocrRunning = false;
let _ocrHiddenDuringRun = false;
let _ocrVisibilityToastTimer = null;

function _showOcrVisibilityToast(message) {
    try {
        const old = document.getElementById('ocr-visibility-toast');
        if (old) old.remove();
        const toast = document.createElement('div');
        toast.id = 'ocr-visibility-toast';
        toast.className = 'ocr-visibility-toast';
        toast.setAttribute('role', 'alert');
        toast.innerHTML = `
          <div class="ocr-visibility-toast__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <path d="M12 8v5"></path>
              <path d="M12 16h.01"></path>
            </svg>
          </div>
          <div class="ocr-visibility-toast__body">
            <strong>Keep this tab open</strong>
            <span>${message}</span>
          </div>
        `;
        document.body.appendChild(toast);
        clearTimeout(_ocrVisibilityToastTimer);
        _ocrVisibilityToastTimer = setTimeout(() => toast.remove(), 6500);
    } catch (_) {}
}

async function _acquireWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            _ocrWakeLock = await navigator.wakeLock.request('screen');
            _ocrWakeLock.addEventListener?.('release', () => { _ocrWakeLock = null; });
        }
    } catch (_) { /* denied when hidden — audio fallback covers it */ }
}

function _startSilentAudio() {
    try {
        if (_ocrKeepAudio || _ocrKeepAudioCtx) return;
        // Start immediately from the user's click path. If this is delayed until
        // after awaited work, browsers can reject playback and then freeze OCR
        // workers when the tab is hidden.
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
            const ctx = new AudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = 440;
            gain.gain.value = 0.0006;
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            ctx.resume?.().catch?.(() => {});
            _ocrKeepAudioCtx = ctx;
            _ocrKeepOsc = osc;
        }
        // 1s of near-silent PCM WAV, looped — a second keepalive path for
        // browsers that treat WebAudio differently in background tabs.
        const sampleRate = 8000, samples = sampleRate;
        const buffer = new ArrayBuffer(44 + samples * 2);
        const view = new DataView(buffer);
        const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
        w(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); w(8, 'WAVE');
        w(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
        view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
        view.setUint16(34, 16, true); w(36, 'data'); view.setUint32(40, samples * 2, true);
        const blob = new Blob([buffer], { type: 'audio/wav' });
        const audio = new Audio(URL.createObjectURL(blob));
        audio.loop = true;
        audio.volume = 0.001; // effectively silent but counts as playing
        audio.play().catch(() => {});
        _ocrKeepAudio = audio;
    } catch (_) {}
}

function _stopKeepalive() {
    try { _ocrWakeLock?.release?.(); } catch (_) {}
    _ocrWakeLock = null;
    try { _ocrKeepOsc?.stop?.(); } catch (_) {}
    _ocrKeepOsc = null;
    try { _ocrKeepAudioCtx?.close?.(); } catch (_) {}
    _ocrKeepAudioCtx = null;
    try { _ocrKeepAudio?.pause?.(); } catch (_) {}
    if (_ocrKeepAudio?.src) { try { URL.revokeObjectURL(_ocrKeepAudio.src); } catch (_) {} }
    _ocrKeepAudio = null;
}

async function _startKeepalive() {
    _startSilentAudio();
    await _acquireWakeLock();
    // Re-acquire wake lock when tab becomes visible again
    document.addEventListener('visibilitychange', _onVisChange);
    window.addEventListener('beforeunload', _onBeforeUnload);
}

async function _onVisChange() {
    if (!_ocrRunning) return;
    if (document.visibilityState === 'hidden') {
        _ocrHiddenDuringRun = true;
        _setTabTitle('Keep tab open — OCR may pause', true);
        return;
    }
    if (document.visibilityState === 'visible' && !_ocrWakeLock) {
        await _acquireWakeLock();
    }
    // If audio was paused by the browser, resume
    if (_ocrKeepAudio && _ocrKeepAudio.paused) {
        try { await _ocrKeepAudio.play(); } catch (_) {}
    }
    if (_ocrKeepAudioCtx && _ocrKeepAudioCtx.state === 'suspended') {
        try { await _ocrKeepAudioCtx.resume(); } catch (_) {}
    }
    if (_ocrHiddenDuringRun) {
        _ocrHiddenDuringRun = false;
        _showOcrVisibilityToast('OCR can pause or become very slow when the tab is not active. Stay on this page until the scan finishes.');
        _applyScanUpdate({
            message: 'Please keep this tab open — OCR may pause while you are away.',
            tone: 'accent',
        });
    }
}
function _onBeforeUnload(e) {
    if (_ocrRunning) { e.preventDefault(); e.returnValue = 'OCR is in progress. Leave anyway?'; return e.returnValue; }
}

function _endKeepalive() {
    _ocrRunning = false;
    window.__omnoteOcrRunning = false;
    _ocrHiddenDuringRun = false;
    clearTimeout(_ocrVisibilityToastTimer);
    document.removeEventListener('visibilitychange', _onVisChange);
    window.removeEventListener('beforeunload', _onBeforeUnload);
    _stopKeepalive();
    _restoreTabTitle();
}


// Yield without relying on requestAnimationFrame (paused when tab hidden)
const _yieldTick = () => new Promise(r => setTimeout(r, 0));

function _setPdfScanStatus(message, tone = 'muted') {
    const accordion = document.getElementById('accordion-container');
    if (!accordion) return;
    _scanLoaderMounted = false;
    const color = tone === 'accent' ? 'var(--accent-violet)' : tone === 'error' ? 'var(--accent-rose)' : 'var(--text-muted)';
    accordion.innerHTML = `<div style="padding: 20px; color: ${color}; text-align: center;">${message}</div>`;
}

// Try to derive a 0-100 percent from status strings emitted by the OCR worker.
function _parseScanPercent(msg) {
    if (!msg) return null;
    const m = String(msg).match(/(\d{1,3})\s*%/);
    if (!m) return null;
    const p = Math.max(0, Math.min(100, parseInt(m[1], 10)));
    return isNaN(p) ? null : p;
}

// Rich state so tab-visibility re-renders never lose current page/pct.
let _lastScanStatus = {
    message: 'Warming up the scanner…',
    tone: 'muted',
    percent: null,   // overall %
    page: null,      // currently active page number (single)
    pagePct: null,   // % of the active page
    done: 0,         // completed pages
    total: 0,        // total pages in job
    activePages: [], // [{page, pct}]
};
let _scanLoaderMounted = false;

// Tab-title progress ("OCR 3/12 · 45% — OmNote"), throttled.
let _origDocTitle = null;
let _titleThrottleTs = 0;
function _setTabTitle(str, force = false) {
    try {
        if (_origDocTitle == null) _origDocTitle = document.title;
        const now = Date.now();
        if (!force && now - _titleThrottleTs < 450) return;
        _titleThrottleTs = now;
        const base = (_origDocTitle || 'OmNote').replace(/^OCR[^|]*[|—-]\s*/, '');
        document.title = str ? `${str} — ${base}` : base;
    } catch (_) {}
}
function _restoreTabTitle() {
    try {
        if (_origDocTitle != null) document.title = _origDocTitle;
        _origDocTitle = null;
    } catch (_) {}
}

function _computeBlendedOverall(state) {
    const total = state.total || 0;
    if (!total) return null;
    const done = state.done || 0;
    let partial = 0;
    const active = Array.isArray(state.activePages) ? state.activePages : [];
    for (const a of active) {
        const pct = Math.max(0, Math.min(100, Number(a && a.pct) || 0));
        partial += pct / 100;
    }
    const pct = Math.max(0, Math.min(100, Math.round(((done + partial) / total) * 100)));
    return pct;
}

function _mountScanLoader() {
    const accordion = document.getElementById('accordion-container');
    if (!accordion) return;
    accordion.innerHTML = `
      <div class="scan-loader" role="status" aria-live="polite">
        <div class="scan-loader__ring" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>
            <path d="M14 3v5h5"/>
            <path d="M9 13h6M9 17h4"/>
          </svg>
        </div>
        <div class="scan-loader__title">Preparing your file</div>
        <div class="scan-loader__msg" data-scan-msg>Warming up the scanner…</div>
        <div class="scan-loader__bar" data-scan-bar>
          <div class="scan-loader__bar-fill is-indeterminate" data-scan-fill style="width:100%"></div>
        </div>
        <div class="scan-loader__meta">
          <span class="scan-loader__pill" data-scan-pill hidden>
            <span class="scan-loader__dot"></span> Tab hidden — OCR may pause
          </span>
          <span class="scan-loader__hint">This can take a moment for scanned PDFs.</span>
        </div>
        <div class="scan-loader__warning">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M12 8v5"></path>
            <path d="M12 16h.01"></path>
          </svg>
          <span>Keep OmNote open until OCR finishes. Switching tabs can pause browser OCR.</span>
        </div>
      </div>
    `;
    _scanLoaderMounted = true;
}

function _renderScanStatus(forceTitle = false) {
    const accordion = document.getElementById('accordion-container');
    if (!accordion) return;
    if (!_scanLoaderMounted || !accordion.querySelector('.scan-loader')) {
        _mountScanLoader();
    }
    const msgEl = accordion.querySelector('[data-scan-msg]');
    const fillEl = accordion.querySelector('[data-scan-fill]');
    const pillEl = accordion.querySelector('[data-scan-pill]');
    const loaderEl = accordion.querySelector('.scan-loader');
    if (msgEl) msgEl.textContent = _lastScanStatus.message || '';
    if (loaderEl) {
        loaderEl.classList.toggle('is-accent', _lastScanStatus.tone === 'accent');
        loaderEl.classList.toggle('is-error', _lastScanStatus.tone === 'error');
    }
    if (fillEl) {
        const p = _lastScanStatus.percent;
        if (p == null) {
            fillEl.classList.add('is-indeterminate');
            fillEl.style.width = '100%';
        } else {
            fillEl.classList.remove('is-indeterminate');
            fillEl.style.width = p + '%';
        }
    }
    if (pillEl) pillEl.hidden = !document.hidden;

    // Tab title reflects overall + current page.
    if (_ocrRunning) {
        const st = _lastScanStatus;
        let title = 'OCR starting…';
        if (st.total) {
            const overall = st.percent != null ? st.percent : 0;
            const active = Array.isArray(st.activePages) ? st.activePages.filter(p => p && p.pct < 100) : [];
            const moving = active
                .slice()
                .sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0))[0];
            if (moving && moving.page != null) {
                title = `OCR ${moving.page}/${st.total} · ${Math.round(Number(moving.pct) || 0)}% (${overall}%)`;
            } else if (st.page != null && st.pagePct != null) {
                title = `OCR ${st.page}/${st.total} · ${st.pagePct}% (${overall}%)`;
            } else if (st.page != null) {
                title = `OCR ${st.page}/${st.total} · ${overall}%`;
            } else if (st.done != null) {
                title = `OCR ${st.done}/${st.total} · ${overall}%`;
            } else {
                title = `OCR ${overall}%`;
            }
        }
        _setTabTitle(title, forceTitle);
    }
}

function _updateScanStatus(message, tone = 'muted') {
    const percent = _parseScanPercent(message);
    _lastScanStatus = {
        ..._lastScanStatus,
        message,
        tone,
        percent: percent != null ? percent : _lastScanStatus.percent,
    };
    _renderScanStatus(true);
}

// Apply structured worker updates (preferred over parsing strings).
function _applyScanUpdate(patch) {
    _lastScanStatus = { ..._lastScanStatus, ...patch };
    const blended = _computeBlendedOverall(_lastScanStatus);
    if (blended != null) _lastScanStatus.percent = blended;
    _renderScanStatus(true);
}

document.addEventListener('visibilitychange', () => {
    if (!_ocrRunning) return;
    // Re-render so the latest status (not a stale "Preparing…" message) is visible on return.
    _renderScanStatus(true);
});


async function _extractPdfInBackground({ file, startPage, endPage, needsOCR, ocrLangSelected, scale }) {
    if (!file || !window.Worker) throw new Error('Background OCR worker unavailable.');
    const data = await file.arrayBuffer();
    // OCR stays fully client-side. Keep at least two local OCR lanes where
    // possible so page N+1 is already moving when the tab is hidden.
    const cores = (navigator.hardwareConcurrency || 2);
    const concurrency = needsOCR ? Math.max(2, Math.min(2, cores)) : 1;
    return new Promise((resolve, reject) => {
        const worker = new Worker('js/ocr-worker.js');
        let settled = false;
        const cleanup = () => { try { worker.terminate(); } catch (_) {} };
        worker.onerror = (event) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(event.message || 'Background scanner failed.'));
        };
        worker.onmessage = (event) => {
            const msg = event.data || {};
            if (msg.type === 'progress') {
                const done = msg.done || 0;
                const total = msg.total || 0;
                if (msg.mode === 'scan-start') {
                    _applyScanUpdate({
                        message: needsOCR ? `Preparing OCR pages (${done}/${total})` : `Reading pages (${done}/${total})`,
                        tone: needsOCR ? 'accent' : 'muted', done, total,
                        page: msg.page || startPage, pagePct: 0,
                        activePages: msg.page ? [{ page: msg.page, pct: 0 }] : [],
                    });
                } else if (msg.mode === 'ocr-init') {
                    _applyScanUpdate({
                        message: `Starting OCR engine (${msg.workers} worker${msg.workers > 1 ? 's' : ''})…`,
                        tone: 'accent', done, total, activePages: [],
                    });
                } else if (msg.mode === 'ocr' || msg.mode === 'ocr-page' || msg.mode === 'ocr-retry' || msg.mode === 'ocr-error') {
                    const page = msg.page;
                    const pagePct = Math.max(0, Math.min(100, msg.pagePct || 0));
                    const existing = Array.isArray(_lastScanStatus.activePages) ? _lastScanStatus.activePages : [];
                    const active = existing.filter(p => p && p.page !== page && p.pct < 100);
                    if (pagePct < 100) active.unshift({ page, pct: pagePct });
                    const statusVerb = msg.mode === 'ocr-retry'
                        ? 'Restarting OCR for page'
                        : msg.mode === 'ocr-error'
                            ? 'Skipping difficult page'
                            : 'OCR page';
                    _applyScanUpdate({
                        message: `${statusVerb} ${page} — ${pagePct}% of page (${done}/${total} done)`,
                        tone: 'accent', done, total, page, pagePct, activePages: active,
                    });
                } else if (msg.mode === 'heartbeat') {
                    const activePages = (msg.activePages || [])
                        .map(p => ({ page: p.page, pct: Math.max(0, Math.min(100, p.pct || 0)) }))
                        .sort((a, b) => (b.pct || 0) - (a.pct || 0));
                    const primary = activePages[0] || {};
                    _applyScanUpdate({
                        message: activePages.length
                            ? `Working on ${activePages.map(p => `p.${p.page} ${p.pct}%`).join(', ')} (${done}/${total} done)`
                            : _lastScanStatus.message,
                        tone: 'accent', done, total,
                        page: primary.page != null ? primary.page : _lastScanStatus.page,
                        pagePct: primary.pct != null ? primary.pct : _lastScanStatus.pagePct,
                        activePages,
                    });
                } else if (msg.mode === 'text') {
                    _applyScanUpdate({
                        message: `Extracted page ${msg.page} (${done}/${total})`,
                        tone: 'muted', done, total, page: msg.page, pagePct: 100, activePages: [],
                    });
                } else if (msg.mode === 'queued') {
                    _applyScanUpdate({
                        message: `Scanning pages (${done}/${total})`,
                        tone: 'muted', done, total,
                    });
                }
            } else if (msg.type === 'done') {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(msg.text || '');
            } else if (msg.type === 'error') {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(msg.message || 'Background scanner failed.'));
            }
        };

        worker.postMessage({ data, startPage, endPage, needsOCR, ocrLang: ocrLangSelected, scale, concurrency }, [data]);
    });
}

async function _extractPdfOnMainThread({ pdf, startPage, endPage, needsOCR, ocrLangSelected, scale }) {
    let fullText = '';
    if (!needsOCR) {
        const totalPagesToScan = endPage - startPage + 1;
        let pagesScanned = 0;
        for (let i = startPage; i <= endPage; i++) {
            pagesScanned++;
            _updateScanStatus(`Extracting page ${i} — ${Math.round((pagesScanned/totalPagesToScan)*100)}% (${pagesScanned}/${totalPagesToScan})`);
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(' ');
            fullText += pageText + "\n";
            await _yieldTick();
        }
        return fullText;
    }

    const totalPagesToScan = endPage - startPage + 1;
    let pagesScanned = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    _updateScanStatus('Starting OCR engine…', 'accent');
    const worker = await Tesseract.createWorker(ocrLangSelected, 1, {
        langPath: 'https://tessdata.projectnaptha.com/4.0.0_fast',
        logger: (m) => {
            if (m && m.status === 'recognizing text' && typeof m.progress === 'number') {
                const pct = Math.round(m.progress * 100);
                const overall = Math.round(((pagesScanned - 1 + m.progress) / totalPagesToScan) * 100);
                _updateScanStatus(`OCR page ${pagesScanned + startPage - 1} (${pct}% of page) — ${overall}% overall (${pagesScanned}/${totalPagesToScan})`, 'accent');
            }
        },
    });
    await worker.setParameters({
        tessedit_pageseg_mode: '3',
    });

    try {
        for (let i = startPage; i <= endPage; i++) {
            pagesScanned++;
            _updateScanStatus(`OCR page ${i} — ${Math.round((pagesScanned/totalPagesToScan)*100)}% (${pagesScanned}/${totalPagesToScan})`, 'accent');
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale });
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            await page.render({ canvasContext: ctx, viewport: viewport }).promise;
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            for (let p = 0; p < data.length; p += 4) {
                const avg = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114);
                const color = avg > 150 ? 255 : 0;
                data[p] = color;
                data[p + 1] = color;
                data[p + 2] = color;
            }
            ctx.putImageData(imageData, 0, 0);
            const ret = await worker.recognize(canvas);
            fullText += ret.data.text + "\n";
            await _yieldTick();
        }
        return fullText;
    } finally {
        await worker.terminate();
    }
}

window.attachPdfToViewer = async function (url) {
    const overlay = document.getElementById('upload-overlay');
    const container = document.getElementById('pdf-viewer');
    if (overlay) overlay.style.display = 'none';
    if (!container || !window.pdfjsLib) return;

    const myToken = ++_pdfRenderToken;
    container.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center;">Loading PDF...</div>';
    container.style.display = 'block';

    try {
        const pdf = await window.pdfjsLib.getDocument(url).promise;
        if (myToken !== _pdfRenderToken) return;
        container.innerHTML = '';

        const cw = container.clientWidth || 800;
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            if (myToken !== _pdfRenderToken) return;
            const page = await pdf.getPage(pageNum);
            const viewport1 = page.getViewport({ scale: 1 });
            const scale = Math.min(2, Math.max(1, (cw - 24) / viewport1.width));
            const viewport = page.getViewport({ scale });

            const pageWrap = document.createElement('div');
            pageWrap.className = 'pdf-page';
            pageWrap.style.width = viewport.width + 'px';
            pageWrap.style.height = viewport.height + 'px';

            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            pageWrap.appendChild(canvas);

            const textLayerDiv = document.createElement('div');
            textLayerDiv.className = 'textLayer';
            textLayerDiv.style.width = viewport.width + 'px';
            textLayerDiv.style.height = viewport.height + 'px';
            pageWrap.appendChild(textLayerDiv);

            container.appendChild(pageWrap);

            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            if (myToken !== _pdfRenderToken) return;

            const textContent = await page.getTextContent();
            window.pdfjsLib.renderTextLayer({
                textContent,
                container: textLayerDiv,
                viewport,
                textDivs: [],
            });
        }
    } catch (e) {
        console.warn('[pdf] render failed:', e);
        container.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center;">Failed to render PDF.</div>';
    }
};

window.restorePdfForActiveDoc = async function () {
    const id = (typeof activeDocId !== 'undefined') ? activeDocId : null;
    const overlay = document.getElementById('upload-overlay');
    const container = document.getElementById('pdf-viewer');

    if (id && window.pdfUrlCache[id]) {
        window.attachPdfToViewer(window.pdfUrlCache[id]);
        return;
    }

    if (id) {
        try {
            const blob = await _idbGet(id);
            if (blob) {
                const url = URL.createObjectURL(blob);
                window.pdfUrlCache[id] = url;
                window.attachPdfToViewer(url);
                return;
            }
        } catch (e) { console.warn('[pdf] IDB restore failed:', e); }
    }

    _pdfRenderToken++;
    if (container) { container.innerHTML = ''; container.style.display = 'none'; }
    if (overlay) overlay.style.display = 'flex';
};

// Browse a PDF locally without triggering AI extraction / study plan
window.browseLocalPdf = function (event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) { alert('Please choose a valid PDF file.'); return; }
    const fileURL = URL.createObjectURL(file);
    if (activeDocId) {
        window.pdfUrlCache[activeDocId] = fileURL;
        _persistPdfFile(activeDocId, file);
    }
    if (window.switchLeftView) {
        const leftTabs = document.querySelectorAll('#left-pane-tabs .left-tab-item');
        if (leftTabs[0]) window.switchLeftView('pdf-view', leftTabs[0]);
    }
    window.attachPdfToViewer(fileURL);
};


window.handleFileUpload = async function (event) {
    const file = event.target.files[0];
    if (file && file.name.toLowerCase().endsWith('.pdf')) {

        if (!activeDocId) {
            const docId = crypto.randomUUID().replace(/-/g,'').slice(0,9);
            const subjectId = db.subjects && db.subjects.length > 0 ? db.subjects[0].id : 's1';
            const cleanTitle = file.name.replace(/\.pdf$/i, '');
            db.documents.push({ id: docId, title: cleanTitle, created: Date.now(), pdfContextText: "", sections: [], subjectId, sourceType: 'pdf' });
            if (window.addRem) window.addRem(docId, "", 0);
            saveDb();
            window.switchDocument(docId);
        } else {
            const doc = getActiveDoc();
            if (doc) {
                if (doc.title === 'Untitled Document') doc.title = file.name.replace(/\.pdf$/i, '');
                doc.sourceType = 'pdf';
                saveDb();
                if (window.refreshAppUI) window.refreshAppUI();
                if (window.applyDocSourceTypeUI) window.applyDocSourceTypeUI();
            }
        }

        const fileURL = URL.createObjectURL(file);
        if (activeDocId) {
            window.pdfUrlCache[activeDocId] = fileURL;
            _persistPdfFile(activeDocId, file);
        }


        // Switch to PDF View using new left pane tabs
        if (window.switchLeftView) {
            const leftTabs = document.querySelectorAll('#left-pane-tabs .left-tab-item');
            window.switchLeftView('pdf-view', leftTabs[0]);
        }

        // Hide overlay, show iframe
        window.attachPdfToViewer(fileURL);


        // Show loading in Study Plan
        if (window.switchRightView) window.switchRightView('learn-view', document.querySelectorAll('.right-tabs .right-tab-item')[1]);
        const accordion = document.getElementById('accordion-container');
        accordion.innerHTML = '<div style="padding: 20px; color: var(--text-muted); text-align: center;">Reading document...</div>';

        // Extract text
        try {
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

            // Enforce max 100-page upload limit
            if (pdf.numPages > 100) {
                accordion.innerHTML = '<div style="padding: 20px; color: var(--text-muted); text-align: center;">Upload cancelled.</div>';
                alert('This PDF has ' + pdf.numPages + ' pages. The maximum allowed is 100 pages per file. Please split the PDF and try again.');
                return;
            }


            
            // Check if first page has text
            const page1 = await pdf.getPage(1);
            const textContent = await page1.getTextContent();
            const hasText = textContent.items.length > 10;
            
            // Store globally temporarily so the modal can access it
            window.currentPendingPdf = pdf;
            window.currentPendingFilename = file.name;
            window.currentPendingPdfFile = file;
            
            // Open Modal
            document.getElementById('upload-start-page').value = 1;
            document.getElementById('upload-end-page').value = Math.min(10, pdf.numPages);
            document.getElementById('upload-max-pages').innerText = `(Max: ${pdf.numPages})`;

            // Preselect document language from user's AI language preference
            try {
                const userLang = (typeof window.getUserLanguage === 'function') ? window.getUserLanguage() : 'en';
                const APP_TO_OCR = { en:'eng', ar:'ara', es:'spa', fr:'fra' };
                const preselect = APP_TO_OCR[userLang] || 'eng';
                const sel = document.getElementById('upload-doc-lang');
                if (sel) sel.value = preselect;
            } catch (_) {}

            if (hasText) {
                document.getElementById('upload-modal-title').innerText = "Scan Document Settings";
                window.currentPendingNeedsOCR = false;
            } else {
                document.getElementById('upload-modal-title').innerText = "OCR Settings (Scanned PDF Detected)";
                window.currentPendingNeedsOCR = true;
            }

            window.openModal('upload-settings-modal');

        } catch (error) {
            console.error("PDF Read Error", error);
            accordion.innerHTML = '<div style="padding: 20px; color: var(--accent-rose); text-align: center;">Error reading PDF file. Please ensure it is not corrupted or password protected.</div>';
        }
    } else {
        alert("Please upload a valid PDF file.");
    }
}

window.startPdfProcessing = async function() {
    window.closeModal('upload-settings-modal');
    
    const pdf = window.currentPendingPdf;
    const filename = window.currentPendingFilename;
    const needsOCR = window.currentPendingNeedsOCR;
    
    if (!pdf) return;
    
    let startPage = parseInt(document.getElementById('upload-start-page').value) || 1;
    let endPage = parseInt(document.getElementById('upload-end-page').value) || pdf.numPages;
    
    // Validate
    startPage = Math.max(1, startPage);
    endPage = Math.min(pdf.numPages, endPage);
    if (startPage > endPage) {
        let temp = startPage;
        startPage = endPage;
        endPage = temp;
    }
    
    // Balanced OCR render scale — accurate enough for Tesseract, ~3-4x faster
    // than the old 3.75 effective scale that made OCR feel frozen.
    let scale = 2.0;

    // Resolve document language (OCR code + app lang code for AI)
    const OCR_TO_APP = { eng:'en', ara:'ar', spa:'es', fra:'fr', deu:'de', ita:'it', por:'pt', rus:'ru', tur:'tr', chi_sim:'zh' };
    const selEl = document.getElementById('upload-doc-lang');
    const ocrLangSelected = (selEl && selEl.value) || ((typeof window.getOcrLangCode === 'function') ? window.getOcrLangCode() : 'eng');
    const docAppLang = OCR_TO_APP[ocrLangSelected] || 'en';
    // Persist on the active doc so future AI tasks can reuse it
    try {
        const activeDoc = window.getActiveDoc ? window.getActiveDoc() : null;
        if (activeDoc) { activeDoc.docLang = docAppLang; if (typeof saveDb === 'function') saveDb(); }
    } catch (_) {}
    
    const accordion = document.getElementById('accordion-container');
    let fullText = "";

    _ocrRunning = true;
    window.__omnoteOcrRunning = true;
    _ocrHiddenDuringRun = false;
    if (needsOCR) {
        _showOcrVisibilityToast('Stay on OmNote until OCR finishes. Browser security can pause OCR when you switch tabs.');
    }
    const totalPagesToScan = Math.max(1, endPage - startPage + 1);
    _lastScanStatus = {
        message: needsOCR ? 'Warming up the OCR engine…' : 'Reading your document…',
        tone: 'accent', percent: 0, page: startPage, pagePct: 0,
        done: 0, total: totalPagesToScan,
        activePages: needsOCR ? [{ page: startPage, pct: 0 }] : [],
    };
    _scanLoaderMounted = false;
    _renderScanStatus(true);
    await _startKeepalive();

    try {
        try {
            fullText = await _extractPdfInBackground({
                file: window.currentPendingPdfFile,
                startPage,
                endPage,
                needsOCR,
                ocrLangSelected,
                scale,
            });
        } catch (workerError) {
            console.warn('[pdf] Background OCR unavailable, falling back to foreground scan:', workerError);
            _updateScanStatus('Background scanner unavailable. Continuing in foreground…', needsOCR ? 'accent' : 'muted');
            await _yieldTick();
            fullText = await _extractPdfOnMainThread({ pdf, startPage, endPage, needsOCR, ocrLangSelected, scale });
        }

        // Call AI to generate sections (pass chosen doc language so summaries match it)
        if (window.generateStudyPlan) {
            await window.generateStudyPlan(fullText, filename, docAppLang);
        }
    } catch (error) {
        console.error("PDF Processing Error", error);
        accordion.innerHTML = '<div style="padding: 20px; color: var(--accent-rose); text-align: center;">Error extracting PDF text. Please ensure the file is not corrupted or password protected.</div>';
    } finally {
        _endKeepalive();
    }
}

window.renderAccordionSections = function () {
    const container = document.getElementById('accordion-container');
    if (!container) return;

    container.innerHTML = '';

    const doc = window.getActiveDoc ? window.getActiveDoc() : null;
    if (!doc || !doc.sections || doc.sections.length === 0) {
        container.innerHTML = '<div style="padding: 20px; color: var(--text-muted); text-align: center;">Upload a PDF to generate a study plan.</div>';
        return;
    }

    const globalActions = document.createElement('div');
    globalActions.style.display = 'flex';
    globalActions.style.flexDirection = 'column';
    globalActions.style.gap = '10px';
    globalActions.style.marginBottom = '20px';
    
    let topRow = '<div style="display:flex; gap:10px; flex-wrap:wrap;">';
    const hasFullExam = doc.fullExam && doc.fullExam.questions && doc.fullExam.questions.length > 0;
    const bestFull = (doc.fullExamAttempts || []).reduce((b, a) => (a.percent > b ? a.percent : b), -1);
    topRow += `<button class="btn-action" style="flex:1; min-width:220px; padding: 12px; font-size: 1rem; background: rgba(124,58,237,0.18); color: #a78bfa; border: 1px solid rgba(124,58,237,0.35);" onclick="window.openFullDocExam()"><i data-lucide="graduation-cap"></i> Full Document Exam${hasFullExam ? ` (${doc.fullExam.questions.length} Q)` : ''}${bestFull >= 0 ? ` — best ${bestFull}%` : ''}</button>`;
    if (doc.customExam && doc.customExam.questions && doc.customExam.questions.length > 0) {
        topRow += `<button class="btn-action" style="flex:1; padding: 12px; font-size: 1rem; background: rgba(16,185,129,0.2); color: var(--accent-emerald); border: 1px solid rgba(16,185,129,0.3);" onclick="window.retakeCustomExam()"><i data-lucide="check-circle-2"></i> Retake Saved Exam</button>`;
    }
    topRow += '</div>';

    globalActions.innerHTML = topRow;
    container.appendChild(globalActions);

    doc.sections.forEach((sec, idx) => {
        const item = document.createElement('div');
        item.className = 'accordion-item';
        if (idx === 0) item.classList.add('expanded');
        item.style.animationDelay = `${idx * 0.06}s`;

        let mastery = 0;
        if (sec.summaryRead) mastery += 33;
        if (sec.flashcardsGenerated) mastery += 33;
        if (sec.examTaken) mastery += 34;

        item.style.setProperty('--mastery', `${mastery}%`);
        let badgeClass = 'progress-badge';
        let badgeText = `${mastery}%`;
        if (mastery === 100) {
            item.classList.add('mastered');
            badgeClass += ' mastered';
            badgeText = '<i data-lucide="star" style="width:12px;height:12px;vertical-align:-2px;"></i> Mastered';
        } else if (mastery > 0) {
            item.classList.add('in-progress');
            badgeClass += ' in-progress';
        }

        item.innerHTML = `
            <div class="accordion-header" onclick="toggleAccordion(this)">
                <span class="header-left">
                    <input type="checkbox" ${sec.isStudied ? 'checked' : ''} 
                           onclick="event.stopPropagation(); window.toggleStudied(this, '${sec.title.replace(/'/g, "\\'")}')" 
                           title="Mark as studied"
                           class="chunk-check">
                    <span class="acc-num">${idx + 1}</span>
                    <span class="acc-title">${sec.title}</span>
                </span>
                <span class="header-right"><span class="${badgeClass}">${badgeText}</span><span class="acc-chevron"><i data-lucide="chevron-down" style="width:14px;height:14px;"></i></span></span>
            </div>

            <div class="accordion-content">
                
                <div class="next-step-block">
                    <div class="next-step-header">Next Step</div>
                    <div class="next-step-body">
                        <div class="next-step-title"><i data-lucide="book-open" style="width:16px;height:16px;vertical-align:-3px;"></i> Read</div>
                        <div style="display:flex; gap:10px;">
                            ${sec.summaryRead ? 
                                `<button class="btn-dark-pill" style="border-color:var(--accent-emerald); color:var(--accent-emerald)" onclick="readSummary('${sec.title.replace(/'/g, "\\'")}')"><i data-lucide="check" style="width:14px;height:14px;vertical-align:-2px;"></i> Summary Read</button>` : 
                                `<button class="btn-dark-pill" onclick="readSummary('${sec.title.replace(/'/g, "\\'")}')"><i data-lucide="file-text" style="width:14px;height:14px;vertical-align:-2px;"></i> Read Summary</button>`}
                            <button class="btn-dark-pill" onclick="window.switchLeftView('pdf-view', document.querySelectorAll('#left-pane-tabs .left-tab-item')[0])"><i data-lucide="file" style="width:14px;height:14px;vertical-align:-2px;"></i> Read PDF</button>
                        </div>
                    </div>
                </div>

                <div class="action-cards-grid">
                    <div class="action-card card-purple">
                        <span style="font-weight:700; display:flex; align-items:center; gap:8px;"><i data-lucide="layers"></i> Flashcards</span>
                        ${sec.flashcardsGenerated ? `<button class="btn-action" style="background: rgba(16,185,129,0.2); color: var(--accent-emerald); border: 1px solid rgba(16,185,129,0.3);" onclick="startChunkReview('${sec.title.replace(/'/g, "\\'")}')"><i data-lucide="check" style="width:14px;height:14px;vertical-align:-2px;"></i> Cards Generated (Practice)</button>` : `<button class="btn-action" onclick="generateCards('${sec.title.replace(/'/g, "\\'")}')">Generate Cards</button>`}
                    </div>
                    <div class="action-card card-green">
                        <span style="font-weight:700; display:flex; align-items:center; gap:8px;"><i data-lucide="help-circle"></i> Quiz</span>
                        ${sec.examTaken ? `<button class="btn-action" style="background: rgba(16,185,129,0.2); color: var(--accent-emerald); border: 1px solid rgba(16,185,129,0.3);" onclick="generateQuiz('${sec.title.replace(/'/g, "\\'")}')"><i data-lucide="check" style="width:14px;height:14px;vertical-align:-2px;"></i> Exam Taken</button>` : `<button class="btn-action" onclick="generateQuiz('${sec.title.replace(/'/g, "\\'")}')">Take Exam</button>`}
                    </div>
                </div>
                
            </div>
        `;
        container.appendChild(item);
    });
}

window.toggleStudied = function(checkbox, secTitle) {
    const doc = window.getActiveDoc ? window.getActiveDoc() : null;
    if (!doc || !doc.sections) return;
    const sec = doc.sections.find(s => s.title === secTitle);
    if (sec) {
        sec.isStudied = checkbox.checked;
        if (typeof saveDb === 'function') saveDb();
    }
};