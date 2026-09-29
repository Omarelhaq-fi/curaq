// Medical Library — per-bank UBooks-style reader (units → chapters → lessons).
// Storage: qbanks/{bankId}/books/{bookId} via /api/qbank list_books/get_book.
// Reads-conscious: book lists stale-while-revalidate in IDB; bodies cached
// FOREVER in IDB keyed by book updatedAt (immutable per version). Progress
// (done lessons, resume point) lives in localStorage per bank+book.
(function () {
  const memList = {}; // bankId -> { at, books }
  const LIST_TTL = 2 * 60_000;
  let current = null; // { bankId, bankName, book, bookId, progress }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  async function apiGetAuth(action, params) {
    const u = window.firebase && firebase.auth && firebase.auth().currentUser;
    if (!u) throw new Error("Not signed in");
    const token = await u.getIdToken();
    const qs = new URLSearchParams({ action, ...(params || {}) }).toString();
    const res = await fetch(`/api/qbank?${qs}`, { headers: { Authorization: "Bearer " + token } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }

  function idbGet(key) {
    try {
      if (window.idbKvGet) return window.idbKvGet(key);
    } catch (_) {}
    return Promise.resolve(null);
  }
  function idbSet(key, val) {
    try {
      if (window.idbKvSet) return window.idbKvSet(key, val);
    } catch (_) {}
    return Promise.resolve();
  }

  function progKey(bankId, bookId) {
    return `omnote_lib_prog::${bankId}::${bookId}`;
  }
  function loadProgress(bankId, bookId) {
    try {
      const p = JSON.parse(localStorage.getItem(progKey(bankId, bookId)) || "null");
      if (p && typeof p === "object") return { done: p.done || {}, last: p.last || null };
    } catch (_) {}
    return { done: {}, last: null };
  }
  function saveProgress(bankId, bookId, p) {
    try { localStorage.setItem(progKey(bankId, bookId), JSON.stringify(p)); } catch (_) {}
  }

  function lessonKey(ui, ci, li) { return `${ui}:${ci}:${li}`; }
  function countLessons(book) {
    let n = 0;
    for (const u of (book.units || [])) for (const c of (u.chapters || [])) n += (c.lessons || []).length;
    return n;
  }

  function rich(md) {
    try {
      if (window.marked && window.DOMPurify) return window.DOMPurify.sanitize(window.marked.parse(String(md || "")));
      if (window.renderRichText) return window.renderRichText(String(md || ""));
    } catch (_) {}
    return esc(String(md || ""));
  }

  // ---------- Entry ----------
  window.openLibraryTab = async function () {
    if (window.hideAllMainViews) window.hideAllMainViews();
    const view = document.getElementById("library-view");
    if (!view) return;
    view.style.display = "flex";
    view.style.flexDirection = "column";
    if (window.setQBankNav) window.setQBankNav("library");
    view.innerHTML = `<div style="max-width:1100px; margin:0 auto; width:100%; padding-bottom:40px;">
      <h2 style="font-size:1.6rem; font-weight:700; color:var(--text-primary); display:flex; align-items:center; gap:10px; margin:0 0 4px 0;">
        <i class="fa-solid fa-book-open" style="color:var(--accent-cyan);"></i> Medical Library
      </h2>
      <p style="color:var(--text-muted); margin:0 0 20px 0; font-size:0.92rem;">One book collection per bank — pick a bank, then a book.</p>
      <div id="library-body"><div style="color:var(--text-muted); text-align:center; padding:30px;">Loading…</div></div>
    </div>`;
    if (window.lucide && window.lucide.createIcons) { try { window.lucide.createIcons(); } catch (_) {} }
    try {
      if (window.preloadQBank) await window.preloadQBank();
      if (window.bootstrapAccess) await window.bootstrapAccess();
    } catch (e) { console.warn("library preload failed", e); }
    renderBankPicker();
  };

  function accessibleBanks() {
    let cats = [];
    try {
      if (window.getQBankList) cats = window.getQBankList() || [];
    } catch (_) {}
    return (cats || [])
      .filter((q) => q && q.kind !== "exam_prep")
      .filter((q) => !window.qbankCanOpen || window.qbankCanOpen(q.id));
  }

  function renderBankPicker() {
    const body = document.getElementById("library-body");
    if (!body) return;
    const banks = accessibleBanks();
    if (!banks.length) {
      body.innerHTML = `<div style="color:var(--text-muted); text-align:center; padding:30px;">No banks available. Start a QBank first.</div>`;
      return;
    }
    body.innerHTML = `
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px;">
        <select id="library-bank" class="login-input" style="min-width:240px;" onchange="window.openLibraryBooks(this.value)">
          ${banks.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("")}
        </select>
      </div>
      <div id="library-books"></div>`;
    window.openLibraryBooks(banks[0].id);
  }

  window.openLibraryBooks = async function (bankId) {
    const box = document.getElementById("library-books");
    if (!box) return;
    const banks = accessibleBanks();
    const bank = banks.find((b) => b.id === bankId) || banks[0];
    if (!bank) return;
    box.innerHTML = `<div style="color:var(--text-muted); padding:16px 0;">Loading books…</div>`;
    const now = Date.now();
    const mem = memList[bank.id];
    const paint = (books) => {
      if (!books || !books.length) {
        box.innerHTML = `<div style="color:var(--text-muted); padding:16px 0;">No books in <b>${esc(bank.name)}</b> yet.</div>`;
        return;
      }
      box.innerHTML = `<div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:14px;">` + books.map((b) => `
        <button onclick="window.openLibraryBook('${esc(bank.id)}','${esc(b.id)}')" style="text-align:left; background:var(--bg-card); border:1px solid var(--border-color); border-radius:12px; padding:16px; cursor:pointer;">
          <div style="font-weight:700; color:var(--text-primary); margin-bottom:4px;"><i class="fa-solid fa-book" style="color:var(--accent-cyan); margin-right:6px;"></i>${esc(b.title)}</div>
          <div style="font-size:0.8rem; color:var(--text-muted);">${b.lessonCount || 0} lessons${b.subject ? ` · ${esc(b.subject)}` : ""}</div>
        </button>`).join("") + `</div>`;
    };
    // Stale-while-revalidate: instant IDB/memory paint, background refresh.
    let painted = false;
    if (mem && now - mem.at < LIST_TTL && mem.books) { paint(mem.books); painted = true; }
    if (!painted) {
      try {
        const saved = await idbGet(`library_list:${bank.id}`);
        if (saved && Array.isArray(saved.books)) { paint(saved.books); painted = true; }
      } catch (_) {}
    }
    try {
      const res = await apiGetAuth("list_books", { qbankId: bank.id });
      const books = res.books || [];
      memList[bank.id] = { at: Date.now(), books };
      idbSet(`library_list:${bank.id}`, { books }).catch(() => {});
      paint(books);
    } catch (e) {
      if (!painted) box.innerHTML = `<div style="color:var(--danger);">Failed to load books: ${esc(e.message)}</div>`;
    }
  };

  // ---------- Reader ----------
  window.openLibraryBook = async function (bankId, bookId) {
    const view = document.getElementById("library-view");
    if (!view) return;
    view.scrollTop = 0;
    const banks = accessibleBanks();
    const bank = banks.find((b) => b.id === bankId) || { id: bankId, name: bankId };
    const body = document.getElementById("library-body") || view.firstElementChild;
    body.innerHTML = `<div style="color:var(--text-muted); text-align:center; padding:30px;">Loading book…</div>`;
    try {
      // Resolve version without a body fetch: reuse the cached list.
      let meta = null;
      const mem = memList[bankId];
      if (mem && mem.books) meta = mem.books.find((b) => b.id === bookId) || null;
      if (!meta) {
        try {
          const saved = await idbGet(`library_list:${bankId}`);
          if (saved && Array.isArray(saved.books)) meta = saved.books.find((b) => b.id === bookId) || null;
        } catch (_) {}
      }
      const v = (meta && meta.updatedAt) || 0;
      const cacheKey = `library_book:${bankId}:${bookId}:${v}`;
      let book = v ? await idbGet(cacheKey) : null;
      if (!book) {
        const res = await apiGetAuth("get_book", { qbankId: bankId, bookId });
        book = res.book;
        if (book && book.updatedAt) idbSet(`library_book:${bankId}:${bookId}:${book.updatedAt}`, book).catch(() => {});
      }
      if (!book) throw new Error("Book not found");
      current = { bankId, bankName: bank.name || bankId, book, bookId, progress: loadProgress(bankId, bookId) };
      renderReader();
    } catch (e) {
      body.innerHTML = `<div style="padding:20px;"><button class="btn-dark-pill" onclick="window.openLibraryTab()">← Back to library</button><div style="color:var(--danger); margin-top:12px;">Failed to load book: ${esc(e.message)}</div></div>`;
    }
  };

  function progressStats() {
    const total = countLessons(current.book);
    const done = Object.keys(current.progress.done || {}).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return { total, done, pct };
  }

  function renderReader() {
    const body = document.getElementById("library-body");
    if (!body || !current) return;
    const st = progressStats();
    const lastLabel = current.progress.last ? ` · Last: ${esc(lessonTitleByKey(current.progress.last))}` : "";
    body.innerHTML = `
      <div style="margin-bottom:14px;"><button class="btn-dark-pill" onclick="window.openLibraryTab()">← All books</button></div>
      <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:14px; padding:18px 20px; margin-bottom:14px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div>
            <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.06em;">${esc(current.bankName)}</div>
            <h2 style="margin:2px 0 6px 0; font-size:1.4rem; color:var(--text-primary);">${esc(current.book.title)}</h2>
            <div style="font-size:0.85rem; color:var(--text-muted);" id="lib-prog-text">${st.done} / ${st.total} lessons complete · ${st.pct}%${lastLabel}</div>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;" id="lib-resume-wrap">
            ${current.progress.last ? `<button class="btn-action primary" style="padding:8px 16px;" onclick="window.libraryResume()">Resume</button>` : ""}
            <button class="btn-dark-pill" onclick="window.libraryExpandAll()">Expand all</button>
          </div>
        </div>
        <div style="height:8px; background:rgba(128,128,128,0.15); border-radius:99px; margin-top:12px; overflow:hidden;">
          <div id="lib-prog-bar" style="height:100%; width:${st.pct}%; background:var(--accent-cyan); border-radius:99px; transition:width .3s;"></div>
        </div>
        <div style="margin-top:12px;">
          <input id="library-search" class="login-input" placeholder="Search lessons…" style="width:100%;" oninput="window.librarySearch(this.value)">
        </div>
      </div>
      <div id="library-tree">
        ${(current.book.units || []).map((u, ui) => `
          <div class="lib-unit" data-ui="${ui}" style="margin-bottom:10px; border:1px solid var(--border-color); border-radius:12px; overflow:hidden;">
            <button onclick="window.libraryToggleUnit(${ui})" style="width:100%; text-align:left; background:rgba(128,128,128,0.06); border:none; padding:14px 16px; font-weight:700; color:var(--text-primary); cursor:pointer; font-size:1rem;">
              ${esc(u.title || ("Unit " + (ui + 1)))} <span style="float:right; color:var(--text-muted);">▾</span>
            </button>
            <div id="lib-unit-${ui}" style="display:none; padding:6px 10px 12px 10px;">
              ${(u.chapters || []).map((ch, ci) => `
                <div class="lib-chapter" data-ui="${ui}" data-ci="${ci}" style="margin:8px 4px; border-left:3px solid var(--accent-cyan); padding-left:12px;">
                  <button onclick="window.libraryToggleChapter(${ui},${ci})" style="background:none; border:none; padding:6px 0; font-weight:600; color:var(--text-primary); cursor:pointer; text-align:left; font-size:0.95rem;">
                    ${esc(ch.title || ("Chapter " + (ci + 1)))} <span style="color:var(--text-muted); font-weight:400;">(${(ch.lessons || []).length})</span>
                  </button>
                  <div id="lib-ch-${ui}-${ci}" style="display:none;">
                    ${(ch.lessons || []).map((l, li) => `
                      <div class="lib-lesson" data-key="${lessonKey(ui, ci, li)}" data-title="${esc((l.title || "").toLowerCase())}" style="display:flex; gap:8px; align-items:flex-start; padding:8px 4px; border-top:1px solid rgba(128,128,128,0.12);">
                        <input type="checkbox" ${current.progress.done[lessonKey(ui, ci, li)] ? "checked" : ""} onchange="window.libraryToggleDone(${ui},${ci},${li},this.checked)" title="Mark complete" style="margin-top:4px; width:16px; height:16px; accent-color:var(--accent-cyan); cursor:pointer;">
                        <button onclick="window.libraryToggleLesson(${ui},${ci},${li})" style="flex:1; background:none; border:none; text-align:left; cursor:pointer; color:var(--text-primary); font-size:0.92rem; padding:2px 0;">
                          ${esc(l.title || ("Lesson " + (li + 1)))}
                        </button>
                      </div>
                      <div id="lib-lesson-${lessonKey(ui, ci, li)}" style="display:none; padding:4px 4px 12px 28px; font-size:0.92rem; line-height:1.7; color:var(--text-secondary);"></div>
                    `).join("")}
                  </div>
                </div>`).join("")}
            </div>
          </div>`).join("")}
      </div>`;
    if (window.lucide && window.lucide.createIcons) { try { window.lucide.createIcons(); } catch (_) {} }
  }

  function lessonTitleByKey(key) {
    try {
      const [ui, ci, li] = key.split(":").map(Number);
      const l = current.book.units[ui].chapters[ci].lessons[li];
      return (l && l.title) || key;
    } catch (_) { return key; }
  }

  window.libraryToggleUnit = function (ui) {
    const el = document.getElementById(`lib-unit-${ui}`);
    if (el) el.style.display = el.style.display === "none" ? "block" : "none";
  };
  window.libraryToggleChapter = function (ui, ci) {
    const el = document.getElementById(`lib-ch-${ui}-${ci}`);
    if (el) el.style.display = el.style.display === "none" ? "block" : "none";
  };
  window.libraryToggleLesson = function (ui, ci, li) {
    const key = lessonKey(ui, ci, li);
    const el = document.getElementById(`lib-lesson-${key}`);
    if (!el) return;
    if (el.style.display === "none") {
      try {
        const l = current.book.units[ui].chapters[ci].lessons[li];
        el.innerHTML = rich(l.body);
        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      } catch (_) {}
      el.style.display = "block";
      current.progress.last = key;
      saveProgress(current.bankId, current.bookId, current.progress);
      try {
        const wrap = document.getElementById("lib-resume-wrap");
        if (wrap && !wrap.querySelector(".btn-action")) {
          const b = document.createElement("button");
          b.className = "btn-action primary";
          b.style.cssText = "padding:8px 16px;";
          b.textContent = "Resume";
          b.onclick = window.libraryResume;
          wrap.prepend(b);
        }
      } catch (_) {}
    } else {
      el.style.display = "none";
    }
  };
  window.libraryToggleDone = function (ui, ci, li, done) {
    const key = lessonKey(ui, ci, li);
    if (done) current.progress.done[key] = 1;
    else delete current.progress.done[key];
    saveProgress(current.bankId, current.bookId, current.progress);
    // In-place header update (no re-render — keeps the tree open).
    try {
      const st = progressStats();
      const t = document.getElementById("lib-prog-text");
      if (t) t.textContent = `${st.done} / ${st.total} lessons complete · ${st.pct}%`;
      const bar = document.getElementById("lib-prog-bar");
      if (bar) bar.style.width = st.pct + "%";
    } catch (_) {}
  };
  window.libraryExpandAll = function () {
    document.querySelectorAll('[id^="lib-unit-"], [id^="lib-ch-"]').forEach((el) => { el.style.display = "block"; });
  };
  window.libraryResume = function () {
    const key = current && current.progress.last;
    if (!key) return;
    const [ui, ci, li] = key.split(":").map(Number);
    const u = document.getElementById(`lib-unit-${ui}`);
    const ch = document.getElementById(`lib-ch-${ui}-${ci}`);
    if (u) u.style.display = "block";
    if (ch) ch.style.display = "block";
    window.libraryToggleLesson(ui, ci, li);
    setTimeout(() => {
      const el = document.getElementById(`lib-lesson-${key}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  };
  window.librarySearch = function (q) {
    const needle = String(q || "").toLowerCase().trim();
    document.querySelectorAll(".lib-lesson").forEach((row) => {
      const hit = !needle || (row.getAttribute("data-title") || "").includes(needle);
      row.style.display = hit ? "flex" : "none";
      const body = document.getElementById(`lib-lesson-${row.getAttribute("data-key")}`);
      if (body) body.style.display = "none";
      if (hit && needle) {
        let p = row.parentElement;
        while (p) {
          if (p.id && (p.id.startsWith("lib-unit-") || p.id.startsWith("lib-ch-"))) p.style.display = "block";
          p = p.parentElement;
        }
      }
    });
  };
})();
