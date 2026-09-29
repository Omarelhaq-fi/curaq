/* OmNote — Focus Mode: hide sidebar+topbar, keep Pomodoro pill floating */
(function () {
  let active = false;
  let pomoOriginalParent = null;
  let pomoNextSibling = null;
  let exitChip = null;

  function ensureExitChip() {
    if (exitChip) return exitChip;
    exitChip = document.createElement('button');
    exitChip.id = 'focus-exit-chip';
    exitChip.type = 'button';
    exitChip.innerHTML = '<span><i data-lucide="x"></i></span><span>Exit focus</span>';
    exitChip.addEventListener('click', () => setFocusMode(false));
    document.body.appendChild(exitChip);
    return exitChip;
  }

  function movePomoOut() {
    const pill = document.getElementById('pomo-pill');
    if (!pill) return;
    pomoOriginalParent = pill.parentNode;
    pomoNextSibling = pill.nextSibling;
    pill.classList.add('pomo-pill-floating');
    document.body.appendChild(pill);
    // Restore saved position (if any)
    try {
      const saved = JSON.parse(localStorage.getItem('omn-pomo-pos') || 'null');
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        applyPomoPos(pill, saved.left, saved.top);
      }
    } catch (_) {}
    makePomoDraggable(pill);
  }

  function movePomoBack() {
    const pill = document.getElementById('pomo-pill');
    if (!pill || !pomoOriginalParent) return;
    pill.classList.remove('pomo-pill-floating');
    // Clear inline positioning so it fits back into the topbar layout
    pill.style.left = '';
    pill.style.top = '';
    pill.style.right = '';
    pill.style.bottom = '';
    if (pomoNextSibling && pomoNextSibling.parentNode === pomoOriginalParent) {
      pomoOriginalParent.insertBefore(pill, pomoNextSibling);
    } else {
      pomoOriginalParent.appendChild(pill);
    }
    pomoOriginalParent = null;
    pomoNextSibling = null;
  }

  function applyPomoPos(pill, left, top) {
    const pad = 6;
    const w = pill.offsetWidth || 160;
    const h = pill.offsetHeight || 40;
    const maxL = Math.max(pad, window.innerWidth - w - pad);
    const maxT = Math.max(pad, window.innerHeight - h - pad);
    const L = Math.min(Math.max(pad, left), maxL);
    const T = Math.min(Math.max(pad, top), maxT);
    pill.style.left = L + 'px';
    pill.style.top = T + 'px';
    pill.style.right = 'auto';
    pill.style.bottom = 'auto';
  }

  function makePomoDraggable(pill) {
    if (pill.dataset.draggableBound === '1') return;
    pill.dataset.draggableBound = '1';
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, origL = 0, origT = 0;

    const onDown = (e) => {
      // Skip drags starting on the play/pause control
      if (e.target.closest('#pomo-pill-play')) return;
      const pt = e.touches ? e.touches[0] : e;
      dragging = true;
      moved = false;
      const rect = pill.getBoundingClientRect();
      origL = rect.left;
      origT = rect.top;
      startX = pt.clientX;
      startY = pt.clientY;
      pill.classList.add('pomo-dragging');
    };
    const onMove = (e) => {
      if (!dragging) return;
      const pt = e.touches ? e.touches[0] : e;
      const dx = pt.clientX - startX;
      const dy = pt.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 4) moved = true;
      if (moved && e.cancelable) e.preventDefault();
      applyPomoPos(pill, origL + dx, origT + dy);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      pill.classList.remove('pomo-dragging');
      if (moved) {
        try {
          localStorage.setItem('omn-pomo-pos', JSON.stringify({
            left: parseFloat(pill.style.left) || 0,
            top: parseFloat(pill.style.top) || 0,
          }));
        } catch (_) {}
        // Suppress the click that would open the modal after a drag
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); pill.removeEventListener('click', swallow, true); };
        pill.addEventListener('click', swallow, true);
      }
    };

    pill.addEventListener('mousedown', onDown);
    pill.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
  }



  async function enterFullscreen() {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
    } catch (_) { /* user gesture required; ignore */ }
  }
  async function exitFullscreen() {
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch (_) { /* ignore */ }
  }

  function setFocusMode(on) {
    if (on === active) return;
    if (on && window.isBookModeActive && window.isBookModeActive()) {
      try { window.setBookMode(false); } catch (_) {}
    }
    active = !!on;
    document.body.classList.toggle('focus-mode', active);

    if (active) {
      movePomoOut();
      ensureExitChip().style.display = 'inline-flex';
      enterFullscreen();
    } else {
      movePomoBack();
      if (exitChip) exitChip.style.display = 'none';
      exitFullscreen();
    }
    const btn = document.getElementById('focus-mode-btn');
    if (btn) btn.classList.toggle('active', active);
  }

  function toggleFocusMode() { setFocusMode(!active); }

  // Sync when user leaves fullscreen via Esc / browser UI
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && active) {
      setFocusMode(false);
    }
  });

  // Keyboard: F toggles (ignore while typing), Esc exits
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
    if (typing) return;
    if (e.key === 'f' || e.key === 'F') {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      toggleFocusMode();
    } else if (e.key === 'Escape' && active) {
      setFocusMode(false);
    }
  });

  window.toggleFocusMode = toggleFocusMode;
  window.setFocusMode = setFocusMode;
})();
