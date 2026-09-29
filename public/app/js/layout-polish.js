// OmNote UX layout polish — additive behaviors only.
// Scroll shadow, scroll-to-top, keyboard shortcuts, hint toast.
(function () {
  'use strict';

  function onReady(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  // ---- Sticky topbar shadow on scroll ----
  function initScrollShadow() {
    const main = document.querySelector('#main-content') || document.body;
    const target = main === document.body ? window : main;
    const getY = () => (target === window ? window.scrollY : main.scrollTop);
    let ticking = false;
    const update = () => {
      document.body.classList.toggle('is-scrolled', getY() > 8);
      ticking = false;
    };
    target.addEventListener('scroll', () => {
      if (!ticking) { requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    update();
  }

  // ---- Scroll-to-top button ----
  function initScrollToTop() {
    if (document.getElementById('scroll-to-top')) return;
    const btn = document.createElement('button');
    btn.id = 'scroll-to-top';
    btn.title = 'Back to top';
    btn.setAttribute('aria-label', 'Back to top');
    btn.innerHTML = '<i data-lucide="arrow-up"></i>';
    btn.addEventListener('click', () => {
      const main = document.querySelector('#main-content');
      if (main) main.scrollTo({ top: 0, behavior: 'smooth' });
      else window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    document.body.appendChild(btn);
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

    const main = document.querySelector('#main-content') || document.body;
    const target = main === document.body ? window : main;
    const getY = () => (target === window ? window.scrollY : main.scrollTop);
    target.addEventListener('scroll', () => {
      btn.classList.toggle('visible', getY() > 400);
    }, { passive: true });
  }

  // ---- Keyboard shortcuts (opt-in, non-intrusive) ----
  function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      const isEditable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
        || t.isContentEditable || (t.tagName === 'SELECT'));
      if (isEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Any open modal? skip. (offsetParent is null for position:fixed overlays,
      // so measure real visibility instead.)
      const isVisible = (el) => {
        if (!el) return false;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        return el.getClientRects().length > 0;
      };
      const anyModalOpen = Array.from(document.querySelectorAll(
        '#exam-modal, #review-modal, #focus-mode-overlay, #book-mode-overlay, .modal.show, .fullscreen-modal'))
        .some(isVisible);
      if (anyModalOpen) return;

      const tabs = document.querySelectorAll('.main-nav-tab');
      if (e.key === '1' && tabs[0]) { e.preventDefault(); tabs[0].click(); }
      else if (e.key === '2' && tabs[1]) { e.preventDefault(); tabs[1].click(); }
      else if (e.key === '3' && tabs[2]) { e.preventDefault(); tabs[2].click(); }
      else if (e.key === '4' && tabs[3]) { e.preventDefault(); tabs[3].click(); }
      else if (e.key === '?') { e.preventDefault(); showKbdHint(); }
      else if (e.key === '/') {
        const trigger = document.querySelector('[data-import-trigger]');
        if (trigger) { e.preventDefault(); trigger.click(); }
      }
    });
  }

  // ---- Keyboard shortcut hint toast ----
  let hintTimer = null;
  function showKbdHint() {
    let toast = document.getElementById('kbd-hint-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'kbd-hint-toast';
      toast.innerHTML =
        '<kbd>1-4</kbd> switch tabs · <kbd>/</kbd> import · <kbd>F</kbd> focus · ' +
        '<kbd>B</kbd> book · <kbd>?</kbd> this help';
      document.body.appendChild(toast);
    }
    toast.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => toast.classList.remove('show'), 3500);
  }
  window.showKbdHint = showKbdHint;

  onReady(() => {
    initScrollShadow();
    initScrollToTop();
    initKeyboardShortcuts();
  });
})();
