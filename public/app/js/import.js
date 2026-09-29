/* OmNote — Import from PDF / DOCX / PPTX / YouTube */
(function () {
  'use strict';

  // ---------- Import menu popover ----------
  function ensureMenu() {
    let menu = document.getElementById('omn-import-menu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'omn-import-menu';
    menu.className = 'omn-import-menu';
    menu.style.display = 'none';
    menu.innerHTML = `
      <button type="button" data-imp="pdf"><span class="imp-ico"><i data-lucide="file-text"></i></span><span>PDF document</span></button>
      <button type="button" data-imp="docx"><span class="imp-ico"><i data-lucide="pencil"></i></span><span>Word (.docx)</span></button>
      <button type="button" data-imp="pptx"><span class="imp-ico"><i data-lucide="bar-chart-3"></i></span><span>PowerPoint (.pptx)</span></button>
      
    `;
    document.body.appendChild(menu);
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-imp]');
      if (!btn) return;
      closeImportMenu();
      const k = btn.getAttribute('data-imp');
      if (k === 'pdf') document.getElementById('pdf-upload').click();
      else if (k === 'docx') document.getElementById('docx-upload').click();
      else if (k === 'pptx') document.getElementById('pptx-upload').click();
      else if (k === 'youtube') openYoutubeModal();
    });
    document.addEventListener('click', (e) => {
      if (menu.style.display === 'none') return;
      if (menu.contains(e.target)) return;
      if (e.target.closest('[data-import-trigger]')) return;
      closeImportMenu();
    });
    return menu;
  }

  window.openImportMenu = function (anchorEl) {
    const menu = ensureMenu();
    const r = anchorEl.getBoundingClientRect();
    menu.style.display = 'flex';
    // Position: below anchor, right-aligned to anchor's right edge, clamp within viewport
    const menuW = 240;
    let left = r.right - menuW;
    if (left < 8) left = 8;
    if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
    menu.style.left = left + 'px';
    menu.style.top = (r.bottom + 8) + 'px';
  };
  function closeImportMenu() {
    const m = document.getElementById('omn-import-menu');
    if (m) m.style.display = 'none';
  }
  window.closeImportMenu = closeImportMenu;

  // ---------- Shared: create doc from extracted text ----------
  async function createDocFromImportedText(text, title, sourceType) {
    if (!text || !text.trim()) {
      alert('No readable text was found in this source.');
      return;
    }
    // Reuse the same doc-creation shape as the PDF flow
    const cleanTitle = (title || 'Untitled').replace(/\.(docx|pptx)$/i, '').trim() || 'Untitled';

    if (!activeDocId) {
      const docId = crypto.randomUUID().replace(/-/g,'').slice(0,9);
      const subjectId = (db.subjects && db.subjects.length > 0) ? db.subjects[0].id : 's1';
      db.documents.push({
        id: docId, title: cleanTitle, created: Date.now(),
        pdfContextText: '', sections: [], subjectId, sourceType,
      });
      if (window.addRem) window.addRem(docId, '', 0);
      saveDb();
      window.switchDocument(docId);
    } else {
      const doc = getActiveDoc();
      if (doc) {
        if (doc.title === 'Untitled Document') doc.title = cleanTitle;
        doc.sourceType = sourceType;
        saveDb();
        if (window.refreshAppUI) window.refreshAppUI();
      }
    }

    applySourceTypeToUI();

    // Study Plan pane and loading state
    if (window.switchRightView) {
      const rTabs = document.querySelectorAll('.right-tabs .right-tab-item');
      if (rTabs[1]) window.switchRightView('learn-view', rTabs[1]);
    }
    // Switch to Notes on left since PDF tab is hidden for these sources
    if (window.switchLeftView) {
      const lTabs = document.querySelectorAll('#left-pane-tabs .left-tab-item');
      if (lTabs[2]) window.switchLeftView('notes-view', lTabs[2]);
    }
    const acc = document.getElementById('accordion-container');
    if (acc) acc.innerHTML = '<div style="padding: 20px; color: var(--text-muted); text-align: center;">Reading document...</div>';

    // Hand off to existing pipeline
    if (window.generateStudyPlan) await window.generateStudyPlan(text, cleanTitle);
  }

  // ---------- DOCX ----------
  async function ensureMammoth() {
    if (window.mammoth) return window.mammoth;
    await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.7.2/mammoth.browser.min.js');
    return window.mammoth;
  }
  window.handleDocxUpload = async function (event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) { alert('Please choose a valid .docx file.'); return; }
    try {
      showBusy('Extracting Word document…');
      const mammoth = await ensureMammoth();
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      const text = (result && result.value) || '';
      hideBusy();
      await createDocFromImportedText(text, file.name, 'docx');
    } catch (e) {
      hideBusy();
      console.error('[import:docx]', e);
      alert('Failed to read this .docx file. It may be corrupted or password-protected.');
    }
  };

  // ---------- PPTX ----------
  async function ensureJSZip() {
    if (window.JSZip) return window.JSZip;
    await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
    return window.JSZip;
  }
  window.handlePptxUpload = async function (event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (!/\.pptx$/i.test(file.name)) { alert('Please choose a valid .pptx file.'); return; }
    try {
      showBusy('Extracting slides…');
      const JSZip = await ensureJSZip();
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      // Collect slide files and sort by index (slide1, slide2, …)
      const entries = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
        .sort((a, b) => {
          const na = parseInt(a.match(/slide(\d+)\.xml/i)[1], 10);
          const nb = parseInt(b.match(/slide(\d+)\.xml/i)[1], 10);
          return na - nb;
        });
      if (!entries.length) {
        hideBusy();
        alert('No slides found in this .pptx file.');
        return;
      }
      if (entries.length > 100) {
        hideBusy();
        alert('This presentation has ' + entries.length + ' slides. The maximum allowed is 100 slides per file. Please split it and try again.');
        return;
      }

      const chunks = [];
      for (let i = 0; i < entries.length; i++) {
        showBusy(`Extracting slide ${i + 1} of ${entries.length}…`);
        const xml = await zip.file(entries[i]).async('string');
        const texts = [];
        const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
        let m;
        while ((m = re.exec(xml)) !== null) {
          const t = decodeXmlEntities(m[1]).replace(/\s+/g, ' ').trim();
          if (t) texts.push(t);
        }
        if (texts.length) chunks.push(`--- Slide ${i + 1} ---\n${texts.join('\n')}`);
      }
      const text = chunks.join('\n\n');
      hideBusy();
      await createDocFromImportedText(text, file.name, 'pptx');
    } catch (e) {
      hideBusy();
      console.error('[import:pptx]', e);
      alert('Failed to read this .pptx file. It may be corrupted.');
    }
  };

  // ---------- YouTube ----------
  function ensureYoutubeModal() {
    let modal = document.getElementById('youtube-import-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'youtube-import-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 520px;">
        <button class="exam-close-btn" onclick="window.closeModal('youtube-import-modal')"><i data-lucide="x"></i></button>
        <div class="exam-title" style="margin-bottom: 18px;"><i data-lucide="play"></i> Import from YouTube</div>
        <label style="display:block; font-size:0.9rem; color:var(--text-secondary); margin-bottom:8px;">
          Paste the YouTube link
        </label>
        <input id="yt-url-input" class="login-input" style="width:100%; margin:0 0 14px 0;"
               placeholder="https://www.youtube.com/watch?v=…" />
        <label style="display:block; font-size:0.9rem; color:var(--text-secondary); margin-bottom:8px;">
          Preferred transcript language (optional)
        </label>
        <select id="yt-lang-input" class="login-input" style="width:100%; margin:0 0 18px 0;">
          <option value="">Auto (first available)</option>
          <option value="en">English</option>
          <option value="ar">Arabic</option>
          <option value="es">Spanish</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="it">Italian</option>
          <option value="pt">Portuguese</option>
          <option value="ru">Russian</option>
          <option value="tr">Turkish</option>
          <option value="hi">Hindi</option>
          <option value="ja">Japanese</option>
          <option value="ko">Korean</option>
          <option value="zh">Chinese</option>
        </select>
        <div id="yt-status" style="font-size:0.85rem; color:var(--text-muted); min-height:1em; margin-bottom:10px;"></div>
        <div style="display:flex; gap:10px; justify-content:flex-end;">
          <button class="btn-dark-pill" type="button" onclick="window.closeModal('youtube-import-modal')">Cancel</button>
          <button class="btn-action primary" type="button" id="yt-import-btn">Import</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#yt-import-btn').addEventListener('click', runYoutubeImport);
    modal.querySelector('#yt-url-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runYoutubeImport();
    });
    return modal;
  }
  function openYoutubeModal() {
    ensureYoutubeModal();
    const status = document.getElementById('yt-status');
    if (status) status.textContent = '';
    const inp = document.getElementById('yt-url-input');
    if (inp) inp.value = '';
    window.openModal('youtube-import-modal');
    setTimeout(() => inp && inp.focus(), 50);
  }
  window.openYoutubeImportModal = openYoutubeModal;

  async function runYoutubeImport() {
    const url = (document.getElementById('yt-url-input').value || '').trim();
    const lang = (document.getElementById('yt-lang-input').value || '').trim();
    const status = document.getElementById('yt-status');
    const btn = document.getElementById('yt-import-btn');
    if (!url) { status.textContent = 'Please paste a YouTube URL.'; return; }
    btn.disabled = true;
    status.style.color = 'var(--text-muted)';
    status.textContent = 'Fetching transcript…';
    try {
      const res = await fetch('/api/public/youtube-transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, lang: lang || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        status.style.color = 'var(--accent-rose, #f87171)';
        status.textContent = data.error || `Failed (${res.status}).`;
        btn.disabled = false;
        return;
      }
      window.closeModal('youtube-import-modal');
      await createDocFromImportedText(
        data.transcript,
        data.title || 'YouTube video',
        'youtube'
      );
    } catch (e) {
      console.error('[import:youtube]', e);
      status.style.color = 'var(--accent-rose, #f87171)';
      status.textContent = 'Network error. Please try again.';
      btn.disabled = false;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Hide "Read PDF" tab for non-PDF docs ----------
  function applySourceTypeToUI() {
    const doc = getActiveDoc && getActiveDoc();
    const tabs = document.querySelectorAll('#left-pane-tabs .left-tab-item');
    const pdfTab = tabs && tabs[0];
    if (!pdfTab) return;
    const isPdf = !doc || !doc.sourceType || doc.sourceType === 'pdf';
    pdfTab.style.display = isPdf ? '' : 'none';
    // If the currently active view is the hidden pdf-view, switch to notes
    if (!isPdf) {
      const pdfView = document.getElementById('pdf-view');
      if (pdfView && pdfView.classList.contains('active') && window.switchLeftView) {
        window.switchLeftView('notes-view', tabs[2]);
      }
    }
  }
  window.applyDocSourceTypeUI = applySourceTypeToUI;

  // Hook into switchDocument to update UI whenever a doc becomes active
  const _origSwitch = window.switchDocument;
  if (_origSwitch) {
    window.switchDocument = function (id) {
      _origSwitch.call(this, id);
      setTimeout(applySourceTypeToUI, 0);
    };
  }

  // ---------- Utilities ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }
  function decodeXmlEntities(s) {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
  }
  function showBusy(msg) {
    let el = document.getElementById('omn-import-busy');
    if (!el) {
      el = document.createElement('div');
      el.id = 'omn-import-busy';
      el.className = 'omn-import-busy';
      el.innerHTML = '<div class="omn-import-busy-inner"><div class="omn-import-spin"></div><div id="omn-import-busy-msg"></div></div>';
      document.body.appendChild(el);
    }
    document.getElementById('omn-import-busy-msg').textContent = msg || 'Working…';
    el.style.display = 'flex';
  }
  function hideBusy() {
    const el = document.getElementById('omn-import-busy');
    if (el) el.style.display = 'none';
  }

  // Init on DOM ready
  document.addEventListener('DOMContentLoaded', () => {
    ensureMenu();
    // Backfill sourceType on existing docs
    if (db && Array.isArray(db.documents)) {
      db.documents.forEach((d) => { if (!d.sourceType) d.sourceType = 'pdf'; });
    }
    applySourceTypeToUI();
  });
})();
