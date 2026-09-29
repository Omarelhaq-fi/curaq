// Rich question editor v2 — textarea-based (guaranteed editing).
// Formatting buttons wrap the selected text in simple HTML tags; images are
// uploaded through /api/admin upload_image (imgbb proxy) and inserted at the
// caret. Live preview renders the sanitized result. Fully theme-aware:
// matches the dashboard's light & dark modes.
(function () {
  const IMGBB_FALLBACK_KEY = "2be2ea92506e46944e941ac5f061c526";

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = String(s == null ? "" : s);
    return d.innerHTML;
  }

  function sanitize(html) {
    const s = String(html == null ? "" : html).trim();
    if (!s) return "";
    if (!/[<]/.test(s)) return s; // plain text, untouched
    if (window.DOMPurify && window.DOMPurify.sanitize) {
      return window.DOMPurify.sanitize(s, {
        ALLOWED_TAGS: ["b","strong","i","em","u","s","sub","sup","p","br",
                       "ul","ol","li","a","span","img"],
        ALLOWED_ATTR: ["href","src","alt","style","target","rel"],
      });
    }
    return s;
  }

  async function uploadImage(file) {
    if (!file) throw new Error("No file selected");
    if (!/^image\//.test(file.type)) throw new Error("Not an image");
    if (file.size > 6 * 1024 * 1024) throw new Error("Image too large (max 6 MB)");

    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(new Error("Could not read file"));
      r.readAsDataURL(file);
    });

    // 1) Server proxy preferred
    try {
      const headers = { "Content-Type": "application/json" };
      try {
        if (window.firebase && firebase.auth().currentUser) {
          headers.Authorization = `Bearer ${await firebase.auth().currentUser.getIdToken()}`;
        }
      } catch (e) {}
      const res = await fetch("/api/admin", {
        method: "POST", headers,
        body: JSON.stringify({ action: "upload_image", imageBase64: dataUrl }),
      });
      if (res.ok) {
        const d = await res.json();
        if (d && d.url) return d.url;
      }
    } catch (e) { /* fall through */ }

    // 2) Direct imgbb fallback
    const fd = new URLSearchParams();
    fd.set("image", dataUrl.replace(/^data:[^,]+,/, ""));
    const r2 = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_FALLBACK_KEY}`, { method: "POST", body: fd });
    const d2 = await r2.json().catch(() => null);
    if (!d2 || !d2.success) throw new Error((d2 && d2.error && d2.error.message) || "Image upload failed");
    return d2.data.url;
  }

  // ---------- Field factory ----------
  function createField(opts) {
    const root = document.createElement("div");
    root.className = "fr-field";
    root.innerHTML = `
      <div class="fr-toolbar">
        <button type="button" data-t="b"><b>B</b></button>
        <button type="button" data-t="i"><i>I</i></button>
        <button type="button" data-t="u"><u>U</u></button>
        <button type="button" data-t="s"><s>S</s></button>
        <span class="fr-sep"></span>
        <button type="button" data-t="sup" title="Superscript">x²</button>
        <button type="button" data-t="sub" title="Subscript">x₂</button>
        <span class="fr-sep"></span>
        <button type="button" data-ins="ul" title="Bullet list">• List</button>
        <button type="button" data-ins="ol" title="Numbered list">1. List</button>
        <span class="fr-sep"></span>
        <button type="button" data-act="link" title="Insert link">🔗</button>
        <button type="button" data-act="image" title="Upload image (or paste / drop)">🖼 Image</button>
        <button type="button" data-act="strip" title="Remove all formatting in this field">⌫ Format</button>
        <span class="fr-sep"></span>
        <button type="button" data-act="preview" title="Toggle preview">👁</button>
        <span class="fr-status"></span>
      </div>
      <textarea class="fr-area login-input" rows="${opts.rows || 4}" placeholder="${esc(opts.placeholder || "")}"></textarea>
      <div class="fr-preview" style="display:none;"></div>
      <input type="file" accept="image/*" style="display:none;" />
    `;
    if (opts.value != null) root.querySelector(".fr-area").value = opts.value;

    const area = root.querySelector(".fr-area");
    const previewEl = root.querySelector(".fr-preview");
    const statusEl = root.querySelector(".fr-status");
    const fileInput = root.querySelector('input[type="file"]');

    const grow = () => { area.style.height = "auto"; area.style.height = Math.min(420, area.scrollHeight + 4) + "px"; };
    area.addEventListener("input", grow);
    setTimeout(grow, 0);

    const setStatus = (m) => { statusEl.textContent = m || ""; };

    function replaceSelection(insertText, selectInserted) {
      const start = area.selectionStart, end = area.selectionEnd;
      const v = area.value;
      area.value = v.slice(0, start) + insertText + v.slice(end);
      area.focus();
      if (selectInserted) area.setSelectionRange(start, start + insertText.length);
      else area.setSelectionRange(start + insertText.length, start + insertText.length);
      grow();
    }

    function wrapSelection(tag, closeTag) {
      const start = area.selectionStart, end = area.selectionEnd;
      const sel = area.value.slice(start, end);
      if (!sel.trim()) {
        replaceSelection(`<${tag}>${closeTag}`, false);
        area.setSelectionRange(start + `<${tag}>`.length, start + `<${tag}>`.length);
        return;
      }
      const before = area.value.slice(Math.max(0, start - tag.length - 3), start);
      if (before.endsWith(`<${tag}>`) && area.value.slice(end, end + closeTag.length) === closeTag) {
        area.value = area.value.slice(0, start - `<${tag}>`.length) + sel + area.value.slice(end + closeTag.length);
        area.focus();
        area.setSelectionRange(start - `<${tag}>`.length, end - `<${tag}>`.length);
        return;
      }
      replaceSelection(`<${tag}>${sel}${closeTag}`, true);
      area.setSelectionRange(start + `<${tag}>`.length, end + `<${tag}>`.length);
    }

    function insertAtCaret(html) { replaceSelection(html, false); }

    async function handleFiles(files) {
      const f = files && files[0];
      if (!f) return;
      setStatus("Uploading image…");
      try {
        const url = await uploadImage(f);
        insertAtCaret(`\n<img src="${url}" alt="image" style="max-width:100%;border-radius:8px;">\n`);
        setStatus("");
      } catch (err) {
        setStatus("");
        alert("Image upload failed: " + (err.message || err));
      }
    }

    area.addEventListener("paste", (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length && /^image\//.test(files[0].type)) { e.preventDefault(); handleFiles(files); }
    });
    area.addEventListener("dragover", (e) => e.preventDefault());
    area.addEventListener("drop", (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length && /^image\//.test(files[0].type)) { e.preventDefault(); handleFiles(files); }
    });
    fileInput.addEventListener("change", () => { handleFiles(fileInput.files); fileInput.value = ""; });

    root.querySelector(".fr-toolbar").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      e.preventDefault();
      const t = btn.dataset.t;
      const ins = btn.dataset.ins;
      const act = btn.dataset.act;

      if (t === "b") wrapSelection("b", "</b>");
      else if (t === "i") wrapSelection("i", "</i>");
      else if (t === "u") wrapSelection("u", "</u>");
      else if (t === "s") wrapSelection("s", "</s>");
      else if (t === "sup") wrapSelection("sup", "</sup>");
      else if (t === "sub") wrapSelection("sub", "</sub>");
      else if (ins === "ul") {
        const items = (area.value.slice(area.selectionStart, area.selectionEnd).split("\n").filter(Boolean));
        const lis = (items.length ? items : ["item"]).map(x => `<li>${esc(x)}</li>`).join("");
        insertAtCaret(`<ul>${lis}</ul>`);
      }
      else if (ins === "ol") {
        const items = (area.value.slice(area.selectionStart, area.selectionEnd).split("\n").filter(Boolean));
        const lis = (items.length ? items : ["item"]).map(x => `<li>${esc(x)}</li>`).join("");
        insertAtCaret(`<ol>${lis}</ol>`);
      }
      else if (act === "link") {
        const url = prompt("Link URL:", "https://");
        if (!url) return;
        const sel = area.value.slice(area.selectionStart, area.selectionEnd);
        const label = sel.trim() || prompt("Link text:") || url;
        insertAtCaret(`<a href="${esc(url)}">${esc(label)}</a>`);
      }
      else if (act === "image") fileInput.click();
      else if (act === "strip") {
        const d = document.createElement("div");
        d.innerHTML = area.value;
        area.value = d.textContent || "";
        area.focus(); grow();
      }
      else if (act === "preview") {
        const showing = previewEl.style.display !== "none";
        if (showing) { previewEl.style.display = "none"; area.style.display = "block"; }
        else {
          const html = sanitize(area.value);
          previewEl.innerHTML =
            /[<]/.test(html)
              ? html
              : (window.escapeHtml ? window.escapeHtml(html) : html).replace(/\n/g, "<br>");
          previewEl.style.display = "block";
          area.style.display = "none";
        }
      }
    });

    return { el: root, getValue: () => area.value };
  }

  // ---------- Modal ----------
  // ctx = { qbankId, questionId, questionText, data(parsed), onSave(payload) }
  window.openRichQuestionEditor = function (ctx) {
    const old = document.getElementById("rich-question-editor");
    if (old) old.remove();

    const d = ctx.data || {};
    const overlay = document.createElement("div");
    overlay.id = "rich-question-editor";
    overlay.className = "rqe-overlay";
    // Theme-aware: follow the dashboard's light/dark mode
    if (document.body.classList.contains("app-light-mode")) {
      overlay.classList.add("in-light");
    }

    const optionRows = (d.options || []).map((opt, i) => ({
      opt,
      correct: Array.isArray(d.correctIndices) ? d.correctIndices.includes(i) : false,
    }));

    overlay.innerHTML = `
      <div class="rqe-modal">
        <div class="rqe-head">
          <div>
            <div class="rqe-title">Edit Question</div>
            <div class="rqe-sub">${esc(ctx.questionId)} · ${esc(ctx.qbankLabel || ctx.qbankId)}</div>
          </div>
          <button type="button" class="rqe-close" title="Close">×</button>
        </div>

        <label class="rqe-label">Question body</label>
        <div id="rqe-q-holder"></div>

        <div class="rqe-two-col">
          <div>
            <label class="rqe-label">Subject</label>
            <input id="rqe-subject" class="login-input" value="${esc(d.subject || "")}" />
          </div>
          <div>
            <label class="rqe-label">Chapter</label>
            <input id="rqe-chapter" class="login-input" value="${esc(d.chapter || "")}" />
          </div>
        </div>

        <label class="rqe-label">Tags (comma separated)</label>
        <input id="rqe-tags" class="login-input" value="${esc((d.tags || []).join(", "))}" />

        <label class="rqe-label">Options — tick the correct answer(s)</label>
        <div id="rqe-options"></div>
        <button type="button" id="rqe-add-opt" class="btn-dark-pill rqe-add-btn">+ Add Option</button>

        <label class="rqe-label">Explanation</label>
        <div id="rqe-exp-holder"></div>

        <div class="rqe-aib">
          <div class="rqe-aib-head">
            <span class="rqe-aib-title">✨ Explanation Builder</span>
            <span class="rqe-aib-hint">Generate tables, criteria, comparisons — no screenshots needed</span>
          </div>
          <div class="rqe-aib-row">
            <select id="rqe-aib-kind">
              <option value="table">Table</option>
              <option value="criteria">Criteria checklist</option>
              <option value="compare">Compare two things</option>
              <option value="note">Note / mnemonic</option>
            </select>
            <input id="rqe-aib-topic" type="text" placeholder="Topic, e.g. Prediabetes diagnostic thresholds (ADA)" />
          </div>
          <div class="rqe-aib-status" id="rqe-aib-status"></div>
          <div id="rqe-aib-preview"></div>
          <button type="button" id="rqe-aib-insert" class="btn-action primary" style="display:none; margin-top:8px;">＋ Insert Block Below</button>
        </div>

        <div class="rqe-foot">
          <span class="rqe-hint">Select text then press B/I/U/x²… to format. Paste or drop images to embed them.</span>
          <div style="display:flex; gap:10px;">
            <button type="button" class="btn-dark-pill rqe-cancel">Cancel</button>
            <button type="button" id="rqe-save" class="btn-action primary">Save Changes</button>
          </div>
        </div>
      </div>
      <style>${CSS}</style>
    `;

    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";

    const bodyField = createField({ value: ctx.questionText || "", placeholder: "Type the question… Use the toolbar to format, or paste images.", rows: 5 });
    const expField  = createField({ value: d.explanation || "", placeholder: "Explain the answer…", rows: 5 });
    overlay.querySelector("#rqe-q-holder").appendChild(bodyField.el);
    overlay.querySelector("#rqe-exp-holder").appendChild(expField.el);

    // ---- AI Explanation Builder (blocks stored as data.explanationBlocks) ----
    let aibBlocks = Array.isArray(d.explanationBlocks) ? d.explanationBlocks.slice(0, 6) : [];
    let pendingBlock = null;
    const aibStatus = overlay.querySelector("#rqe-aib-status");
    const aibPreview = overlay.querySelector("#rqe-aib-preview");
    const aibInsert = overlay.querySelector("#rqe-aib-insert");

    function renderAibList() {
      if (!aibBlocks.length) { aibPreview.innerHTML = ""; return; }
      aibPreview.innerHTML = `<div class="rqe-aib-list">` + aibBlocks.map((b, i) =>
        `<div class="rqe-aib-item"><span class="rqe-aib-item-label">${esc(b.type)}: ${esc(b.title || b.text || "").slice(0, 60)}</span><button type="button" data-aibdel="${i}" class="btn-dark-pill" title="Remove block">✕</button></div>`
      ).join("") + `</div>`;
      aibPreview.querySelectorAll("[data-aibdel]").forEach(btn => {
        btn.addEventListener("click", () => { aibBlocks.splice(Number(btn.dataset.aibdel), 1); renderAibList(); });
      });
    }

    overlay.querySelector("#rqe-aib-go")?.remove(); // (button lives in row below)
    overlay.querySelectorAll(".rqe-aib-row").length; // no-op guard

    // Generate button is injected in the row via markup id below
    const genBtn = document.createElement("button");
    genBtn.type = "button";
    genBtn.id = "rqe-aib-go";
    genBtn.className = "btn-dark-pill";
    genBtn.textContent = "✨ Generate";
    overlay.querySelector(".rqe-aib-row").appendChild(genBtn);

    genBtn.addEventListener("click", async () => {
      const kind = overlay.querySelector("#rqe-aib-kind").value;
      const topic = overlay.querySelector("#rqe-aib-topic").value.trim();
      if (topic.length < 5) { aibStatus.textContent = "Describe the topic first (a few words)."; return; }
      if (aibBlocks.length >= 6) { aibStatus.textContent = "Maximum 6 blocks per question."; return; }
      genBtn.disabled = true;
      aibStatus.textContent = "Generating with AI…";
      try {
        const token = await firebase.auth().currentUser.getIdToken();
        const res = await fetch("/api/admin", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "ai_generate_block", kind, topic }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || ("HTTP " + res.status));
        pendingBlock = out.block;
        aibStatus.textContent = "Looks good? Click Insert.";
        aibPreview.insertAdjacentHTML("afterbegin", window.renderExplanationBlocks([pendingBlock]));
        aibInsert.style.display = "inline-block";
        aibInsert.onclick = () => {
          if (pendingBlock) { aibBlocks.push(pendingBlock); pendingBlock = null; }
          aibInsert.style.display = "none";
          aibStatus.textContent = "";
          renderAibList();
        };
      } catch (err) {
        aibStatus.textContent = "Failed: " + (err.message || err);
      } finally {
        genBtn.disabled = false;
      }
    });
    renderAibList();


    const optWrap = overlay.querySelector("#rqe-options");
    function relabel() {
      optWrap.querySelectorAll(".rqe-opt-row").forEach((row, i) => {
        row.querySelector(".rqe-letter").textContent = String.fromCharCode(65 + i);
      });
    }
    function addOptionRow(val, correct) {
      const row = document.createElement("div");
      row.className = "rqe-opt-row";
      row.innerHTML = `
        <label class="rqe-radio-wrap" title="Mark as correct">
          <input type="checkbox" class="rqe-opt-correct" ${correct ? "checked" : ""}/>
          <span class="rqe-letter"></span>
        </label>
        <textarea class="login-input rqe-opt-text" rows="2" placeholder="Option text…">${esc(val || "")}</textarea>
        <button type="button" class="btn-dark-pill rqe-opt-del" title="Remove option">×</button>
      `;
      row.querySelector(".rqe-opt-del").addEventListener("click", () => { row.remove(); relabel(); });
      optWrap.appendChild(row);
      relabel();
    }
    (optionRows.length ? optionRows : [{ opt: "", correct: false }, { opt: "", correct: false }])
      .forEach(r => addOptionRow(r.opt, r.correct));
    overlay.querySelector("#rqe-add-opt").addEventListener("click", () => addOptionRow("", false));

    const close = () => { overlay.remove(); document.body.style.overflow = ""; };
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".rqe-close").addEventListener("click", close);
    overlay.querySelector(".rqe-cancel").addEventListener("click", close);
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    });

    overlay.querySelector("#rqe-save").addEventListener("click", async () => {
      const rawBody = bodyField.getValue();
      const rawExp = expField.getValue();

      const questionText = /[<]/.test(rawBody) ? sanitize(rawBody) : rawBody.trim();
      const explanation = /[<]/.test(rawExp) ? sanitize(rawExp) : rawExp.trim();

      const subject = overlay.querySelector("#rqe-subject").value.trim();
      const chapter = overlay.querySelector("#rqe-chapter").value.trim();
      const tags = overlay.querySelector("#rqe-tags").value.split(",").map(s => s.trim()).filter(Boolean);

      const rows = [...optWrap.querySelectorAll(".rqe-opt-row")];
      const options = [];
      const correctIndices = [];
      let emptyIdx = null;

      rows.forEach((row, i) => {
        const v = row.querySelector(".rqe-opt-text").value.trim();
        if (!v && emptyIdx === null) emptyIdx = i;
        options.push(v);
        if (row.querySelector(".rqe-opt-correct").checked) correctIndices.push(i);
      });

      if (!rawBody.trim()) return alert("Question body cannot be empty.");
      if (emptyIdx !== null) return alert(`Option ${String.fromCharCode(65 + emptyIdx)} is empty — add text or remove it.`);
      if (options.length < 2) return alert("At least two options are required.");
      if (correctIndices.length === 0) return alert("Tick at least one correct answer.");

      const saveBtn = overlay.querySelector("#rqe-save");
      saveBtn.textContent = "Saving…";
      saveBtn.disabled = true;
      try {
        await ctx.onSave({
          questionText,
          dataJson: JSON.stringify({
            ...(d || {}),
            subject,
            chapter,
            tags,
            options,
            correctIndices,
            explanation,
            ...(aibBlocks.length ? { explanationBlocks: aibBlocks } : {}),
          }),
        });
        close();
      } catch (err) {
        alert("Failed: " + (err?.message || err));
        saveBtn.textContent = "Save Changes";
        saveBtn.disabled = false;
      }
    });
  };

  /* ================= THEME-AWARE STYLES ================= */
  /* Design tokens: dark defaults; .in-light remaps to the dashboard light theme */
  const CSS = `
  .rqe-overlay {
    --ra-overlay: rgba(6,25,31,0.72);
    --ra-modal-bg: #12222a;
    --ra-text: #e6eef1;
    --ra-muted: #7d97a3;
    --ra-dim: #56707c;
    --ra-border: rgba(255,255,255,0.11);
    --ra-border-soft: rgba(255,255,255,0.07);
    --ra-surface: rgba(255,255,255,0.04);
    --ra-surface-focus: rgba(255,255,255,0.06);
    --ra-accent: #2dd4bf;
    --ra-accent-deep: #0e7c86;
    --ra-toolbar-bg: rgba(14,124,134,0.12);
    --ra-toolbar-btn: #b8d3da;
    --ra-toolbar-btn-hover-bg: rgba(45,212,191,0.16);
    --ra-toolbar-btn-hover: #ffffff;
    --ra-preview-bg: rgba(4,18,22,0.45);
    --ra-opt-bg: rgba(255,255,255,0.02);
    --ra-correct-bg: rgba(15,138,95,0.09);
    --ra-correct-border: rgba(52,211,153,0.5);
    --ra-correct: #34d399;
    --ra-pill-bg: rgba(255,255,255,0.06);
    --ra-pill-border: rgba(255,255,255,0.12);
    --ra-pill-text: #cfe0e6;
    --ra-pill-hover-bg: rgba(255,255,255,0.11);
    --ra-close-hover-bg: rgba(244,63,94,0.15);

    position: fixed; inset: 0; z-index: 99999;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
    background: var(--ra-overlay);
    backdrop-filter: blur(5px);
    font-family: 'Figtree', sans-serif;
  }
  /* ---- LIGHT MODE (dashboard light theme) ---- */
  .rqe-overlay.in-light {
    --ra-overlay: rgba(10,61,74,0.42);
    --ra-modal-bg: #ffffff;
    --ra-text: #0a3d4a;
    --ra-muted: #6b7f88;
    --ra-dim: #90a2ab;
    --ra-border: #dbe3e7;
    --ra-border-soft: #e4eaee;
    --ra-surface: #ffffff;
    --ra-surface-focus: #fbfcfd;
    --ra-accent: #0e7c86;
    --ra-accent-deep: #0b6770;
    --ra-toolbar-bg: #e6f4f5;
    --ra-toolbar-btn: #334e59;
    --ra-toolbar-btn-hover-bg: rgba(14,124,134,0.13);
    --ra-toolbar-btn-hover: #0b6770;
    --ra-preview-bg: #f4f6f8;
    --ra-opt-bg: #fbfcfd;
    --ra-correct-bg: #e8f4ee;
    --ra-correct-border: rgba(15,138,95,0.55);
    --ra-correct: #0f8a5f;
    --ra-pill-bg: #f4f6f8;
    --ra-pill-border: #dbe3e7;
    --ra-pill-text: #334e59;
    --ra-pill-hover-bg: #eef4f6;
    --ra-close-hover-bg: #fbeae7;
  }

  .rqe-modal { background: var(--ra-modal-bg); color: var(--ra-text); border: 1px solid var(--ra-border); border-radius: 16px; width: min(900px, 100%); max-height: 92vh; overflow-y: auto; padding: 26px 28px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 40px 100px -30px rgba(4,18,22,0.55); }
  .rqe-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; padding-bottom: 14px; border-bottom: 1px solid var(--ra-border-soft); }
  .rqe-title { font-family: 'Outfit', sans-serif; font-size: 1.3rem; font-weight: 800; color: var(--ra-text); display: flex; align-items: center; gap: 10px; letter-spacing: -0.01em; }
  .rqe-title::before { content: "✎"; color: var(--ra-accent); font-size: 1.05rem; }
  .rqe-sub { font-size: 0.75rem; color: var(--ra-muted); font-family: monospace; margin-top: 3px; }
  .rqe-close { background: transparent; border: none; color: var(--ra-muted); font-size: 28px; cursor: pointer; line-height: 1; border-radius: 8px; width: 34px; height: 34px; transition: all .15s ease; flex-shrink: 0; }
  .rqe-close:hover { color: var(--ra-text); background: var(--ra-close-hover-bg); }

  .rqe-label { display: block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: var(--ra-accent); margin-top: 12px; margin-bottom: 5px; }

  /* Unified inputs */
  .rqe-modal .login-input,
  .rqe-modal input[type="text"],
  .rqe-modal textarea.login-input,
  .rqe-modal textarea {
    background: var(--ra-surface) !important;
    border: 1px solid var(--ra-border) !important;
    color: var(--ra-text) !important;
    width: 100%; box-sizing: border-box; resize: vertical;
    border-radius: 9px;
    caret-color: var(--ra-accent);
    font-family: 'Figtree', sans-serif;
    box-shadow: none;
  }
  .rqe-modal .login-input:focus,
  .rqe-modal input[type="text"]:focus,
  .rqe-modal textarea:focus {
    outline: none !important;
    border-color: var(--ra-accent) !important;
    box-shadow: 0 0 0 3px rgba(14,124,134,0.15) !important;
    background: var(--ra-surface-focus) !important;
  }
  .rqe-modal .login-input::placeholder,
  .rqe-modal textarea::placeholder { color: var(--ra-dim); }
  .rqe-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 620px) { .rqe-two-col { grid-template-columns: 1fr; } }

  /* Formatted fields (body / explanation) */
  .fr-field { border: 1px solid var(--ra-border); border-radius: 10px; overflow: hidden; background: var(--ra-surface); margin: 2px 0 6px; transition: border-color .15s ease, box-shadow .15s ease; }
  .fr-field:focus-within { border-color: var(--ra-accent); box-shadow: 0 0 0 3px rgba(14,124,134,0.12); }
  .fr-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; padding: 6px 8px; background: var(--ra-toolbar-bg); border-bottom: 1px solid var(--ra-border-soft); }
  .fr-toolbar button { background: transparent; border: none; color: var(--ra-toolbar-btn); font-family: inherit; font-size: 0.78rem; font-weight: 600; padding: 5px 9px; border-radius: 6px; cursor: pointer; transition: background .12s ease, color .12s ease; min-width: 28px; }
  .fr-toolbar button:hover { background: var(--ra-toolbar-btn-hover-bg); color: var(--ra-toolbar-btn-hover); }
  .fr-sep { width: 1px; height: 16px; background: var(--ra-border); margin: 0 5px; }
  .fr-status { font-size: 0.72rem; color: #b8760b; margin-left: 8px; font-weight: 600; }
  .fr-area { border: none !important; box-shadow: none !important; border-radius: 0 !important; background: transparent !important; min-height: 96px; padding: 12px 14px; font-size: 0.95rem; line-height: 1.65; color: var(--ra-text) !important; display: block; resize: vertical; }
  .fr-area:focus { outline: none !important; box-shadow: inset 0 0 0 2px rgba(14,124,134,0.35) !important; background: transparent !important; }
  .fr-preview { padding: 12px 14px; min-height: 60px; font-size: 0.95rem; line-height: 1.65; color: var(--ra-text); background: var(--ra-preview-bg); white-space: normal; }
  .fr-preview img { max-width: 100%; border-radius: 8px; border: 1px solid var(--ra-border-soft); }

  /* Options */
  .rqe-opt-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; background: var(--ra-opt-bg); border: 1px solid var(--ra-border); border-radius: 10px; margin-bottom: 8px; transition: border-color .15s ease, background .15s ease; }
  .rqe-opt-row:focus-within { border-color: var(--ra-accent); }
  .rqe-opt-row:has(.rqe-opt-correct:checked) { border-color: var(--ra-correct-border); background: var(--ra-correct-bg); }
  .rqe-radio-wrap { display: flex; flex-direction: column; align-items: center; gap: 3px; cursor: pointer; padding-top: 6px; }
  .rqe-letter { font-family: 'Outfit', sans-serif; font-weight: 800; font-size: 0.85rem; color: var(--ra-muted); }
  .rqe-opt-correct { accent-color: #0f8a5f; width: 17px; height: 17px; cursor: pointer; }
  .rqe-opt-row .rqe-opt-correct:checked ~ .rqe-letter { color: var(--ra-correct); }
  .rqe-modal .rqe-opt-text { flex: 1; min-width: 0; border: none !important; box-shadow: none !important; background: transparent !important; padding: 8px 10px; min-height: 44px; }
  .rqe-opt-row:focus-within .rqe-opt-text { box-shadow: none !important; }
  .rqe-opt-del { opacity: 0.55; transition: opacity .15s ease, color .15s ease; }
  .rqe-opt-del:hover { opacity: 1; color: #c0392b !important; }

  .rqe-foot { display: flex; justify-content: space-between; align-items: center; gap: 14px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--ra-border-soft); flex-wrap: wrap; }
  .rqe-hint { font-size: 0.74rem; color: var(--ra-dim); max-width: 420px; line-height: 1.5; }

  /* Buttons — match dashboard */
  .rqe-overlay .btn-action.primary {
    background: linear-gradient(135deg, #14929d, #0e7c86) !important;
    border: none; color: #fff !important; font-weight: 700;
    padding: 10px 26px; border-radius: 9px; cursor: pointer;
    transition: filter .15s ease;
  }
  .rqe-overlay .btn-action.primary:hover { filter: brightness(1.12); }
  .rqe-overlay .btn-action.primary:disabled { opacity: 0.6; cursor: wait; }
  .rqe-overlay .btn-dark-pill {
    background: var(--ra-pill-bg); border: 1px solid var(--ra-pill-border); color: var(--ra-pill-text);
    padding: 8px 16px; border-radius: 9px; cursor: pointer;
    font-family: inherit; font-size: 0.85rem; transition: all .15s ease;
  }
  .rqe-overlay .btn-dark-pill:hover { background: var(--ra-pill-hover-bg); color: var(--ra-accent); border-color: var(--ra-accent); }

  /* AI Explanation Builder */
  .rqe-aib { margin-top: 14px; border: 1px dashed var(--ra-accent); border-radius: 12px; padding: 14px; background: var(--ra-surface); }
  .rqe-aib-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .rqe-aib-title { font-weight: 800; font-size: 0.92rem; color: var(--ra-accent); }
  .rqe-aib-hint { font-size: 0.74rem; color: var(--ra-dim); }
  .rqe-aib-row { display: flex; gap: 8px; }
  .rqe-aib-row select { flex: 0 0 auto; background: var(--ra-toolbar-bg); border: 1px solid var(--ra-border); color: var(--ra-text); padding: 9px 10px; border-radius: 9px; font-family: inherit; font-size: 0.88rem; cursor: pointer; }
  .rqe-aib-row input { flex: 1; min-width: 0; background: var(--ra-surface) !important; border: 1px solid var(--ra-border) !important; color: var(--ra-text) !important; padding: 9px 11px !important; border-radius: 9px; font-size: 0.9rem; }
  .rqe-aib-row input:focus { outline: none; border-color: var(--ra-accent) !important; box-shadow: 0 0 0 3px rgba(14,124,134,0.15); }
  .rqe-aib-status { min-height: 17px; font-size: 0.8rem; color: #f59e0b; margin-top: 7px; font-weight: 600; }
  .rqe-aib-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .rqe-aib-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; background: var(--ra-opt-bg); border: 1px solid var(--ra-border); border-radius: 9px; padding: 7px 10px; font-size: 0.82rem; }
  .rqe-aib-item-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ra-text); }
  #rqe-aib-preview .eb-wrap { margin-top: 10px; }
  `;
})();
