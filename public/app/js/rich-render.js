// Renders question content that may be plain text OR sanitized HTML.
// - Plain text  -> escaped, newlines preserved
// - HTML        -> DOMPurify-sanitized and rendered as-is
// Output is wrapped in .qbank-rich so qbankEnhanceImages can cap image sizes
// and add click-to-zoom. Also renders structured explanation blocks
// (tables / criteria / compare / note) via window.renderExplanationBlocks.
(function () {
  const ALLOWED = [
    "b", "strong", "i", "em", "u", "s", "sub", "sup",
    "p", "br", "ul", "ol", "li", "a", "span", "img",
    "table", "thead", "tbody", "tr", "th", "td", "caption", "hr", "blockquote",
  ];

  const looksLikeHtml = (s) => /<\/?(b|strong|i|em|u|s|sub|sup|p|br|ul|ol|li|a|span|img)\b[^>]*>/i.test(s);

  window.renderRichText = function (raw) {
    if (raw == null) return "";
    const s = String(raw);

    // Legacy plain-text questions: escape exactly like before
    if (!looksLikeHtml(s)) {
      const plain = window.escapeHtml ? window.escapeHtml(s) : s;
      return '<div class="qbank-rich">' + plain.replace(/\n/g, "<br>") + "</div>";
    }

    let inner;
    if (window.DOMPurify && typeof window.DOMPurify.sanitize === "function") {
      inner = window.DOMPurify.sanitize(s, {
        ALLOWED_TAGS: ALLOWED,
        ALLOWED_ATTR: ["href", "src", "alt", "width", "height", "colspan", "rowspan"],
      });
    } else {
      inner = window.escapeHtml ? window.escapeHtml(s) : s;
    }
    return '<div class="qbank-rich">' + inner + "</div>";
  };

  // ---------- Explanation blocks ----------
  const escB = (x) => String(x == null ? "" : x)
    .replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const mdB = (x, inline = false) => {
    let s = String(x == null ? "" : x);
    if (window.marked && window.DOMPurify) {
      return window.DOMPurify.sanitize(inline ? window.marked.parseInline(s) : window.marked.parse(s));
    }
    return escB(s);
  };

  window.renderExplanationBlocks = function (blocks) {
    if (!Array.isArray(blocks) || !blocks.length) return "";
    const parts = [];
    for (const b of blocks.slice(0, 6)) {
      if (!b || typeof b !== "object") continue;
      const title = b.title ? `<div class="eb-title">${escB(b.title)}</div>` : "";

      if (b.type === "table" && Array.isArray(b.headers) && Array.isArray(b.rows)) {
        parts.push(`<div class="eb-block">${title}<div class="eb-tablewrap"><table class="eb-table">
          <thead><tr>${b.headers.map(h => `<th>${mdB(h, true)}</th>`).join("")}</tr></thead>
          <tbody>${b.rows.map(r => `<tr>${(Array.isArray(r) ? r : []).map(c => `<td>${mdB(c, true)}</td>`).join("")}</tr>`).join("")}</tbody>
        </table></div>${b.note ? `<div class="eb-note">${mdB(b.note)}</div>` : ""}</div>`);
      } else if (b.type === "criteria" && Array.isArray(b.items)) {
        parts.push(`<div class="eb-block">${title}<ol class="eb-criteria">${b.items.map(i => `<li>${mdB(i, true)}</li>`).join("")}</ol>${b.note ? `<div class="eb-note">${mdB(b.note)}</div>` : ""}</div>`);
      } else if (b.type === "compare" && Array.isArray(b.pairs)) {
        parts.push(`<div class="eb-block">${title}<div class="eb-tablewrap"><table class="eb-table eb-compare">
          <thead><tr><th>${mdB(b.leftLabel || "A", true)}</th><th>${mdB(b.rightLabel || "B", true)}</th></tr></thead>
          <tbody>${b.pairs.map(p => `<tr><td>${mdB(p && p[0], true)}</td><td>${mdB(p && p[1], true)}</td></tr>`).join("")}</tbody>
        </table></div></div>`);
      } else if (b.type === "note" && b.text) {
        const tone = ["info", "warning", "key"].includes(b.tone) ? b.tone : "info";
        parts.push(`<div class="eb-block eb-notebox eb-${tone}">${title}${mdB(b.text)}</div>`);
      }
    }
    return parts.length ? `<div class="eb-wrap">${parts.join("")}</div><hr class="eb-divider"/>` : "";
  };

  const EB_CSS = `
  .eb-wrap { margin: 0 0 12px; }
  .eb-block { background: var(--surface-color, rgba(255,255,255,0.03)); border: 1px solid var(--border-color, rgba(255,255,255,0.09)); border-radius: 12px; padding: 14px; margin-bottom: 10px; }
  .eb-title { font-family: 'Outfit', sans-serif; font-weight: 800; font-size: 0.95rem; color: var(--accent-cyan, #2dd4bf); margin-bottom: 9px; }
  .eb-tablewrap { overflow-x: auto; }
  .eb-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  .eb-table th { background: rgba(14,124,134,0.18); color: inherit; text-align: left; padding: 8px 11px; font-weight: 800; border-bottom: 2px solid rgba(14,124,134,0.5); white-space: nowrap; }
  .eb-table td { padding: 7px 11px; border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.07)); }
  .eb-table tr:last-child td { border-bottom: none; }
  .eb-compare td:nth-child(1) { width: 50%; }
  .eb-criteria { margin: 0; padding-left: 22px; line-height: 1.75; }
  .eb-note { font-size: 0.78rem; color: var(--text-muted, #8fa9b4); margin-top: 8px; font-style: italic; }
  .eb-notebox { border-left: 4px solid #2dd4bf; background: rgba(45,212,191,0.07); font-weight: 600; }
  .eb-warning { border-left-color: #f59e0b !important; background: rgba(245,158,11,0.08) !important; }
  .eb-key { border-left-color: #34d399 !important; background: rgba(52,211,153,0.08) !important; }
  .eb-divider { border: none; border-top: 1px dashed var(--border-color, rgba(255,255,255,0.15)); margin: 14px 0; }

  body.app-light-mode .eb-block { background: #fbfcfd; border-color: #dbe3e7; }
  body.app-light-mode .eb-title { color: #0e7c86; }
  body.app-light-mode .eb-table th { background: #e6f4f5; color: #0b6770; border-bottom-color: rgba(14,124,134,0.4); }
  body.app-light-mode .eb-table td { border-color: #e4eaee; color: #334e59; }
  body.app-light-mode .eb-notebox { border-left-color: #0e7c86; background: #e6f4f5; color: #0a3d4a; }
  body.app-light-mode .eb-warning { border-left-color: #f59e0b !important; background: #fdf3e3 !important; }
  body.app-light-mode .eb-key { border-left-color: #0f8a5f !important; background: #e8f4ee !important; }
  `;
  if (!document.getElementById("eb-css")) {
    const st = document.createElement("style");
    st.id = "eb-css";
    st.textContent = EB_CSS;
    document.head.appendChild(st);
  }

  // ---------- Structured Explanation Formatter ----------
  // Parses raw explanation text that contains patterns like:
  //   "General Explication: ...", "Option A: ...", "Option B: ..."
  // into visually distinct, color-coded cards.
  window.formatExplanationSections = function (html, options, correctIndices) {
    if (!html || typeof html !== "string") return html;

    // Work on the text content to detect patterns (strip tags for matching)
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const rawText = tmp.textContent || tmp.innerText || "";

    // Patterns: "General Explication:", "Explication générale:", "General Comment:", "Key Lesson:"
    const generalPatterns = [
      /General\s+Explic(?:ation|ation\s*générale)\s*:\s*/i,
      /Explication\s+g[ée]n[ée]rale\s*:\s*/i,
      /General\s+Comment\s*:\s*/i,
      /Key\s+Lesson\s*:\s*/i,
    ];
    // Option patterns: "Option A:", "Option A.", "A:", "A."
    const optionPattern = /Option\s+([A-E])\s*[:.]|^([A-E])\s*[:.](?=\s)/gim;

    // Check if the raw text has these patterns
    let hasStructure = false;
    for (const p of generalPatterns) {
      if (p.test(rawText)) { hasStructure = true; break; }
    }
    if (!hasStructure && !optionPattern.test(rawText)) return html;

    // Parse sections from raw text
    const sections = [];
    let text = rawText;

    // Extract general section
    let generalText = "";
    for (const p of generalPatterns) {
      const m = text.match(p);
      if (m) {
        const startIdx = m.index + m[0].length;
        // Find where the next "Option X:" starts
        const restText = text.substring(startIdx);
        const nextOpt = restText.match(/Option\s+[A-E]\s*[:.]|^[A-E]\s*[:.]/im);
        if (nextOpt) {
          generalText = restText.substring(0, nextOpt.index).trim();
          text = text.substring(0, m.index) + restText.substring(nextOpt.index);
        } else {
          generalText = restText.trim();
          text = text.substring(0, m.index);
        }
        break;
      }
    }

    // Extract per-option sections
    const optSections = [];
    const optRegex = /(?:Option\s+)?([A-E])\s*[:.]\s*/gi;
    const matches = [];
    let match;
    // Reset and scan the remaining text
    const scanText = generalText ? text + " " + rawText.substring(rawText.indexOf(generalText) + generalText.length) : text;
    
    // Re-scan full text for option patterns
    const fullOptRegex = /(?:Option\s+)([A-E])\s*[:.]\s*/gi;
    let optMatch;
    const optPositions = [];
    while ((optMatch = fullOptRegex.exec(rawText)) !== null) {
      optPositions.push({ letter: optMatch[1].toUpperCase(), index: optMatch.index, matchEnd: optMatch.index + optMatch[0].length });
    }

    for (let i = 0; i < optPositions.length; i++) {
      const pos = optPositions[i];
      const endIdx = (i + 1 < optPositions.length) ? optPositions[i + 1].index : rawText.length;
      const content = rawText.substring(pos.matchEnd, endIdx).trim();
      if (content) {
        optSections.push({ letter: pos.letter, content });
      }
    }

    // If we couldn't parse anything meaningful, fall back
    if (!generalText && optSections.length === 0) return html;

    // Build structured HTML (UWorld style)
    let out = '<div class="uw-explanation">';

    let introText = rawText;
    if (generalText) introText = introText.replace(generalText, "");
    for (const opt of optSections) {
      introText = introText.replace(opt.content, "");
    }
    // Remove headers
    introText = introText.replace(/(?:Option\s+)?([A-E])\s*[:.]\s*/gi, "");
    for (const p of generalPatterns) {
      introText = introText.replace(p, "");
    }
    introText = introText.trim();

    if (introText) {
      out += `<div class="uw-intro" style="margin-bottom: 20px;">${window.escapeHtml ? window.escapeHtml(introText) : introText}</div>`;
    }

    if (generalText) {
      out += `<div class="uw-objective" style="margin-bottom: 24px;">
        <strong>Educational objective:</strong><br>
        ${window.escapeHtml ? window.escapeHtml(generalText) : generalText}
      </div>`;
    }

    if (optSections.length > 0) {
      out += `<div class="uw-options">`;
      for (const opt of optSections) {
        let content = opt.content.replace(/^(Correct|Incorrect)\s+option\.?\s*/i, "").trim();
        out += `<div class="uw-option-item">
          <strong>(Choice ${opt.letter})</strong> ${window.escapeHtml ? window.escapeHtml(content) : content}
        </div>`;
      }
      out += `</div>`;
    }

    out += `</div>`;

    return out;
  };

  const EXPL_CSS = `
  /* --- UWorld Style Explanation Styles --- */
  .uw-explanation {
    font-size: 0.95rem;
    line-height: 1.6;
    color: var(--text-primary, #333);
    margin-top: 10px;
  }
  .uw-options {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin-bottom: 24px;
  }
  .uw-option-item {
    padding: 0;
  }
  .uw-objective {
    background-color: var(--surface-container, #f3f4f6);
    border: 1px solid var(--border-color, #e5e7eb);
    padding: 16px;
    border-radius: 4px;
    margin-top: 16px;
  }
  .uw-objective strong {
    font-weight: 700;
  }
  
  /* Light mode overrides */
  body.app-light-mode .uw-explanation {
    color: #1a3a42;
  }
  body.app-light-mode .uw-objective {
    background-color: #f3f6f8;
    border-color: #e4eaee;
  }
  
  /* Dark mode overrides */
  body:not(.app-light-mode) .uw-explanation {
    color: #e2e8f0;
  }
  body:not(.app-light-mode) .uw-objective {
    background-color: #1f2937;
    border-color: #374151;
  }
  `;
  if (!document.getElementById("expl-fmt-css")) {
    const st2 = document.createElement("style");
    st2.id = "expl-fmt-css";
    st2.textContent = EXPL_CSS;
    document.head.appendChild(st2);
  }
})();
