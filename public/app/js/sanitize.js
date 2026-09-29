// Sanitize AI/user-provided HTML before injecting via innerHTML.
// Uses DOMPurify (loaded from CDN in index.html). If unavailable, falls back
// to text-only rendering (safe but ugly) — never leaves output unsanitized.
(function () {
  const DEFAULT_CFG = {
    ALLOWED_TAGS: [
      "a","b","i","em","strong","u","p","br","hr","span","div","mark",
      "ul","ol","li","blockquote","code","pre",
      "h1","h2","h3","h4","h5","h6","table","thead","tbody","tr","td","th",
      "img"
    ],
    ALLOWED_ATTR: ["href","title","class","style","alt","src","target","rel"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data:image\/[a-z]+;base64,):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    FORBID_TAGS: ["script","iframe","object","embed","form","input","button","link","meta","style"],
    FORBID_ATTR: ["onerror","onload","onclick","onmouseover","onfocus","onblur","onchange","onsubmit","onkeydown","onkeyup","onkeypress","srcdoc","formaction","xlink:href"],
    ALLOW_DATA_ATTR: false,
  };

  function textFallback(html) {
    const d = document.createElement("div");
    d.textContent = String(html == null ? "" : html);
    return d.innerHTML;
  }

  window.safeHTML = function safeHTML(html, override) {
    if (html == null) return "";
    const s = String(html);
    if (window.DOMPurify && typeof window.DOMPurify.sanitize === "function") {
      const cfg = override ? Object.assign({}, DEFAULT_CFG, override) : DEFAULT_CFG;
      // Force target=_blank rel=noopener on links.
      if (!window.__omnPurifyHooked) {
        window.__omnPurifyHooked = true;
        window.DOMPurify.addHook("afterSanitizeAttributes", function (node) {
          if (node.tagName === "A" && node.getAttribute("href")) {
            node.setAttribute("target", "_blank");
            node.setAttribute("rel", "noopener noreferrer");
          }
        });
      }
      return window.DOMPurify.sanitize(s, cfg);
    }
    console.warn("[sanitize] DOMPurify missing — falling back to text-only render");
    return textFallback(s);
  };

  // Convenience for setting innerHTML on an element with sanitized markdown.
  window.setSafeHTML = function setSafeHTML(el, html, override) {
    if (!el) return;
    el.innerHTML = window.safeHTML(html, override);
  };

  // Escape a string for safe interpolation into HTML text/attribute context.
  window.escapeHTML = function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };
})();
