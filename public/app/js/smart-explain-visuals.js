// Smart Explain — inline medical visuals.
//
// Pipeline:
//   1. The smart_explain_visuals task reads the finished explanation and returns
//      a list of { anchor, kind, prompt, caption, ... } items. There is no cap:
//      a dense summary can request as many visuals as it needs.
//   2. A skeleton <figure> is inserted at each anchor, immediately, so the text
//      stays readable while images render.
//   3. /api/ai-image generates each visual with Google "Nano Banana" (Gemini
//      native image) and stores it in R2. Images fill in progressively.
//
// Interrupted runs are resumable: the pending <figure> carries its own brief
// in data-se-* attributes, so reopening a cached explanation finishes the job
// without paying for a second planning call.

(function () {
  "use strict";

  const MAX_PARALLEL = 3;
  const MAX_RETRIES = 2;
  const CACHE_SOFT_LIMIT = 420_000;

  const KIND_LABEL = {
    anatomy: "Anatomy",
    mechanism: "Mechanism",
    pathology: "Pathology",
    histology: "Histology",
    radiology: "Radiology",
    clinical_photo: "Clinical photo",
    procedure: "Procedure",
    comparison: "Comparison",
    flowchart: "Flowchart",
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function esc(s) {
    if (typeof window.escapeHTML === "function") return window.escapeHTML(s);
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[\u2018\u2019\u201c\u201d"'`´]/g, "")
      .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseJsonReply(reply) {
    let text = String(reply == null ? "" : reply)
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    try {
      return JSON.parse(text);
    } catch (_) {
      try {
        // Some models emit literal control characters inside JSON strings.
        return JSON.parse(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, " "));
      } catch (_) {
        return null;
      }
    }
  }

  function normalizeVisual(raw) {
    if (!raw || typeof raw !== "object") return null;
    const prompt = String(raw.prompt || raw.image_prompt || "").trim();
    if (prompt.length < 20) return null;
    const anchor = String(raw.anchor || raw.after || raw.section || "").trim();
    if (!anchor) return null;
    const kind = String(raw.kind || raw.type || "anatomy").toLowerCase().replace(/[\s-]+/g, "_");
    const aspect = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"].includes(String(raw.aspect || ""))
      ? String(raw.aspect)
      : "4:3";
    const size = ["1K", "2K", "4K"].includes(String(raw.size || "")) ? String(raw.size) : "2K";
    return {
      id: "",
      anchor,
      kind,
      modality: String(raw.modality || "").trim().slice(0, 120),
      title: String(raw.title || raw.caption || "Medical visual").trim().slice(0, 200),
      caption: String(raw.caption || raw.title || "").trim().slice(0, 700),
      prompt: prompt.slice(0, 7_000),
      alt: String(raw.alt || raw.caption || raw.title || "Medical illustration").trim().slice(0, 500),
      aspect,
      size,
    };
  }

  function dedupeVisuals(list) {
    const seen = new Set();
    const out = [];
    for (const item of list || []) {
      const v = normalizeVisual(item);
      if (!v) continue;
      const key = norm(v.prompt).slice(0, 240);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    return out;
  }

  function kindLabel(v) {
    const kind = String(v.kind || "");
    if (kind === "radiology" && v.modality) return v.modality;
    return KIND_LABEL[kind] || "Medical visual";
  }

  function buildFigure(v) {
    const label = kindLabel(v);
    const fig = document.createElement("figure");
    fig.className = "se-figure is-pending";
    fig.setAttribute("data-se-state", "pending");
    fig.setAttribute("data-se-id", v.id);
    fig.setAttribute("data-se-prompt", v.prompt);
    fig.setAttribute("data-se-kind", v.kind);
    fig.setAttribute("data-se-modality", v.modality);
    fig.setAttribute("data-se-title", v.title);
    fig.setAttribute("data-se-caption", v.caption);
    fig.setAttribute("data-se-alt", v.alt);
    fig.setAttribute("data-se-aspect", v.aspect);
    fig.setAttribute("data-se-size", v.size);

    const loading = document.createElement("div");
    loading.className = "se-figure-loading";
    loading.innerHTML =
      '<span class="se-figure-shimmer"></span>' +
      '<span class="se-figure-status"><span class="se-figure-spinner"></span>Generating ' +
      esc(label) +
      " visual…</span>";
    fig.appendChild(loading);

    const cap = document.createElement("figcaption");
    cap.className = "se-figure-caption-wrap";
    const badge = document.createElement("span");
    badge.className = "se-figure-badge";
    badge.textContent = "AI · " + label;
    const text = document.createElement("span");
    text.className = "se-figure-caption";
    text.textContent = v.caption || v.title || "";
    cap.appendChild(badge);
    if (text.textContent) cap.appendChild(text);
    fig.appendChild(cap);
    return fig;
  }

  function figureToVisual(fig) {
    return {
      id: fig.getAttribute("data-se-id") || "",
      anchor: "",
      kind: fig.getAttribute("data-se-kind") || "anatomy",
      modality: fig.getAttribute("data-se-modality") || "",
      title: fig.getAttribute("data-se-title") || "",
      caption: fig.getAttribute("data-se-caption") || "",
      prompt: fig.getAttribute("data-se-prompt") || "",
      alt: fig.getAttribute("data-se-alt") || "",
      aspect: fig.getAttribute("data-se-aspect") || "4:3",
      size: fig.getAttribute("data-se-size") || "2K",
    };
  }

  function addMarker(root, className) {
    if (root.querySelector("." + className)) return;
    const marker = document.createElement("span");
    marker.className = "se-visual-marker " + className;
    marker.setAttribute("aria-hidden", "true");
    root.appendChild(marker);
  }

  function removeMarker(root, className) {
    const marker = root.querySelector("." + className);
    if (marker) marker.remove();
  }

  function locateAnchor(root, anchor) {
    const target = norm(anchor);
    if (!target) return null;
    const blocks = Array.from(
      root.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th"),
    ).filter((el) => !el.closest(".se-figure"));
    let best = null;
    let bestLen = Infinity;

    for (const el of blocks) {
      const text = norm(el.textContent);
      if (!text) continue;
      if (text.includes(target) || (target.length > 40 && target.includes(text) && text.length >= 30)) {
        if (text.length < bestLen) {
          best = el;
          bestLen = text.length;
        }
      }
    }
    if (best) return best;

    const words = target.split(" ").slice(0, 10).join(" ");
    if (words && words !== target) {
      for (const el of blocks) {
        const text = norm(el.textContent);
        if (text.includes(words) && text.length < bestLen) {
          best = el;
          bestLen = text.length;
        }
      }
    }
    return best;
  }

  function insertFigure(root, v) {
    const fig = buildFigure(v);
    const anchorEl = locateAnchor(root, v.anchor);
    if (anchorEl) {
      const tag = anchorEl.tagName;
      if (tag === "LI" || tag === "TD" || tag === "TH") {
        anchorEl.appendChild(fig);
      } else {
        const last = anchorEl.__seLastFigure;
        if (last && last.parentNode) last.insertAdjacentElement("afterend", fig);
        else anchorEl.insertAdjacentElement("afterend", fig);
        anchorEl.__seLastFigure = fig;
      }
    } else {
      // Fallback: just before the memory-hooks section, otherwise at the end.
      const candidates = Array.from(root.querySelectorAll("h1, h2, h3, h4, p"));
      const memory = candidates.find((el) => /memory hooks?/i.test(el.textContent || ""));
      if (memory) memory.insertAdjacentElement("beforebegin", fig);
      else root.appendChild(fig);
    }
    return fig;
  }

  function findFigure(root, id) {
    const figures = root.querySelectorAll(".se-figure");
    for (let i = 0; i < figures.length; i++) {
      if (figures[i].getAttribute("data-se-id") === id) return figures[i];
    }
    return null;
  }

  function setFigureDone(fig, v, result) {
    const src = result.url || result.dataUrl;
    if (!src) {
      fig.remove();
      return;
    }
    const label = kindLabel(v);
    fig.classList.remove("is-pending", "is-error");
    fig.classList.add("is-done");
    fig.setAttribute("data-se-state", "done");
    fig.innerHTML = "";

    const link = document.createElement("a");
    link.className = "se-figure-link";
    link.href = src;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = "Open full-size image";

    const img = document.createElement("img");
    img.className = "se-figure-img";
    img.src = src;
    img.alt = v.alt || v.title || "Medical illustration";
    img.loading = "lazy";
    img.decoding = "async";
    link.appendChild(img);

    const cap = document.createElement("figcaption");
    cap.className = "se-figure-caption-wrap";
    const badge = document.createElement("span");
    badge.className = "se-figure-badge";
    badge.textContent = "AI · " + label;
    const text = document.createElement("span");
    text.className = "se-figure-caption";
    text.textContent = v.caption || v.title || "";
    const note = document.createElement("span");
    note.className = "se-figure-note";
    note.textContent = "AI-generated educational visual — verify against your textbook.";

    cap.appendChild(badge);
    if (text.textContent) cap.appendChild(text);
    cap.appendChild(note);
    fig.appendChild(link);
    fig.appendChild(cap);
  }

  async function getIdToken() {
    if (!window.firebase || !window.firebase.auth) throw new Error("Firebase not loaded");
    const user = window.firebase.auth().currentUser;
    if (!user) throw new Error("Not signed in");
    return await user.getIdToken();
  }

  async function requestImage(v) {
    let token;
    try {
      token = await getIdToken();
    } catch (e) {
      return { _error: e.message || "Auth failed" };
    }

    const payload = {
      prompt: v.prompt,
      kind: v.kind,
      modality: v.modality || undefined,
      title: v.title || undefined,
      aspect: v.aspect,
      size: v.size,
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let resp;
      let data = null;
      try {
        resp = await fetch("/api/ai-image", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
          body: JSON.stringify(payload),
        });
        try { data = await resp.json(); } catch (_) { data = null; }
      } catch (e) {
        if (attempt < MAX_RETRIES) {
          await sleep(1200 + attempt * 1600);
          continue;
        }
        return { _error: e.message || "Network error" };
      }

      if (resp.ok && data && (data.url || data.dataUrl)) return data;

      if (resp.status === 429 || resp.status === 502 || resp.status === 503) {
        if (attempt < MAX_RETRIES) {
          const wait = data && data.retryAfter
            ? Math.min(30_000, Number(data.retryAfter) * 1000)
            : 2200 * (attempt + 1);
          await sleep(wait);
          continue;
        }
      }
      return { _error: (data && data.error) || "HTTP " + resp.status };
    }
    return { _error: "Image generation timed out" };
  }

  async function planVisuals(root) {
    if (typeof window.aiTask !== "function") return null;
    const text = String(root.innerText || root.textContent || "").trim();
    if (text.length < 80) return [];

    let reply;
    try {
      reply = await window.aiTask("smart_explain_visuals", { text });
    } catch (_) {
      return null;
    }
    if (!reply || reply._error) return null;

    const parsed = parseJsonReply(reply);
    if (!parsed) return null;
    const list = Array.isArray(parsed.visuals)
      ? parsed.visuals
      : Array.isArray(parsed.images)
        ? parsed.images
        : Array.isArray(parsed)
          ? parsed
          : [];
    return dedupeVisuals(list);
  }

  async function runPool(items, limit, worker) {
    let next = 0;
    const runners = [];
    const count = Math.min(Math.max(1, limit), items.length);
    for (let i = 0; i < count; i++) {
      runners.push((async () => {
        while (next < items.length) {
          const index = next++;
          await worker(items[index], index);
        }
      })());
    }
    await Promise.all(runners);
  }

  /**
   * Add inline medical visuals to an explanation.
   *
   * @param {string} html  Sanitized explanation HTML.
   * @param {object} [opts]
   * @param {HTMLElement} [opts.container] Defaults to #doc-explain-modal-content.
   * @param {(html:string)=>void} [opts.onChange] Called whenever the HTML changes
   *        (placeholders inserted, each image finished). Use it to persist cache.
   * @returns {Promise<string>} The final HTML.
   */
  window.smartExplainVisuals = async function smartExplainVisuals(html, opts) {
    opts = opts || {};
    const container = opts.container || document.getElementById("doc-explain-modal-content");
    if (!container) return html;
    if (window.smartExplainVisualsEnabled === false) return html;
    if (typeof window.aiTask !== "function") return html;

    const safe = typeof window.safeHTML === "function" ? window.safeHTML(html) : String(html || "");
    const scrollTop = container.scrollTop;
    container.innerHTML = safe;
    container.scrollTop = scrollTop;

    function notify() {
      if (typeof opts.onChange === "function") {
        try { opts.onChange(container.innerHTML); } catch (_) { /* persistence must never break rendering */ }
      }
    }

    // Resume an interrupted run from cached pending figures.
    let pending = Array.from(container.querySelectorAll('.se-figure[data-se-state="pending"]'));
    let visuals = pending.map(figureToVisual);

    if (!pending.length) {
      if (container.querySelector('.se-figure[data-se-state="done"]')) {
        return container.innerHTML;
      }
      if (container.querySelector(".se-visual-none")) {
        return container.innerHTML;
      }
      removeMarker(container, "se-visual-failed");
      if (container.querySelector(".se-visual-planned")) {
        // A previous run planned visuals but none survived; don't hammer the
        // image API every time the same cached explanation is opened.
        return container.innerHTML;
      }

      let list;
      try {
        list = await planVisuals(container);
      } catch (_) {
        list = null;
      }
      if (list === null) return container.innerHTML;
      if (!list.length) {
        addMarker(container, "se-visual-none");
        notify();
        return container.innerHTML;
      }

      addMarker(container, "se-visual-planned");
      visuals = list.map((v, i) => {
        v.id = "se-" + Date.now().toString(36) + "-" + i + "-" + Math.random().toString(36).slice(2, 7);
        return v;
      });
      visuals.forEach((v) => insertFigure(container, v));
      notify();
    }

    let done = 0;
    let failed = 0;

    await runPool(visuals, MAX_PARALLEL, async (v) => {
      const fig = findFigure(container, v.id);
      if (!fig) return;
      const result = await requestImage(v);
      if (!result || result._error) {
        failed++;
        fig.remove();
        return;
      }
      done++;
      setFigureDone(fig, v, result);
      notify();
    });

    const stillPending = container.querySelectorAll('.se-figure[data-se-state="pending"]').length;
    if (stillPending === 0 && done === 0 && failed > 0) {
      removeMarker(container, "se-visual-planned");
      addMarker(container, "se-visual-failed");
    } else {
      removeMarker(container, "se-visual-failed");
    }
    notify();
    return container.innerHTML;
  };

  // Keep Firestore's 1 MB per-document limit safe when R2 is not configured:
  // base64 images are dropped from the cloud-cached copy before saving.
  window.sePruneHtmlForCache = function sePruneHtmlForCache(html) {
    const text = String(html == null ? "" : html);
    if (text.length <= CACHE_SOFT_LIMIT) return text;
    return text
      .replace(/<a\b[^>]*>\s*<img\b[^>]*\bsrc="data:image\/[^"]+"[^>]*>\s*<\/a>/gi, "")
      .replace(/<img\b[^>]*\bsrc="data:image\/[^"]+"[^>]*>/gi, "")
      .replace(/<figure\b[^>]*class="[^"]*se-figure[^"]*"[^>]*>[\s\S]*?<\/figure>/gi, "")
      .replace(/<span\b[^>]*class="[^"]*se-visual-marker[^"]*"[^>]*><\/span>/gi, "");
  };
})();
