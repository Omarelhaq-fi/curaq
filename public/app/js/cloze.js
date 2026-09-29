/* Cloze deletion rendering — turns {{c1::answer}} / {{c1::answer::hint}} into
   hidden blanks on the question side and highlighted answers on the reveal side. */
(function () {
  const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)\}\}/g;

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parts(body) {
    const idx = body.indexOf('::');
    if (idx === -1) return { answer: body, hint: '' };
    return { answer: body.slice(0, idx), hint: body.slice(idx + 2) };
  }

  window.hasCloze = function hasCloze(text) {
    CLOZE_RE.lastIndex = 0;
    return CLOZE_RE.test(String(text || ''));
  };

  /* Plain text with the cloze markers removed (answers kept). */
  window.clozePlain = function clozePlain(text) {
    return String(text || '').replace(CLOZE_RE, (_m, _n, body) => parts(body).answer);
  };

  /* Question side: answers hidden behind blanks. */
  window.clozeMaskHtml = function clozeMaskHtml(text) {
    const src = String(text || '');
    let out = '';
    let last = 0;
    let m;
    CLOZE_RE.lastIndex = 0;
    while ((m = CLOZE_RE.exec(src)) !== null) {
      out += esc(src.slice(last, m.index));
      const { hint } = parts(m[2]);
      out += `<span class="cloze-blank" data-c="${esc(m[1])}">${hint ? esc(hint) : '[ … ]'}</span>`;
      last = m.index + m[0].length;
    }
    out += esc(src.slice(last));
    return out;
  };

  /* Reveal side: answers shown, highlighted. */
  window.clozeRevealHtml = function clozeRevealHtml(text) {
    const src = String(text || '');
    let out = '';
    let last = 0;
    let m;
    CLOZE_RE.lastIndex = 0;
    while ((m = CLOZE_RE.exec(src)) !== null) {
      out += esc(src.slice(last, m.index));
      out += `<span class="cloze-answer">${esc(parts(m[2]).answer)}</span>`;
      last = m.index + m[0].length;
    }
    out += esc(src.slice(last));
    return out;
  };

  /* Just the deleted answers, in c-order. */
  window.clozeAnswers = function clozeAnswers(text) {
    const src = String(text || '');
    const found = [];
    let m;
    CLOZE_RE.lastIndex = 0;
    while ((m = CLOZE_RE.exec(src)) !== null) {
      found.push({ n: parseInt(m[1], 10) || 0, a: parts(m[2]).answer });
    }
    found.sort((x, y) => x.n - y.n);
    return found.map((f) => f.a);
  };

  window.escapeClozeHtml = esc;
})();

