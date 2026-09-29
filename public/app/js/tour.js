// Lightweight guided tour with spotlight overlay.
// Usage: window.startOmnoteTour(persistKey?) — persistKey stores completion in localStorage.
(function () {
    const STEPS = [
        {
            selector: '#sidebar-toggle-btn, [onclick="toggleSidebar()"]',
            title: 'Your workspace',
            body: 'Open the sidebar anytime to switch subjects, browse your documents, and jump into a study session.',
        },
        {
            selector: '#theme-toggle-btn',
            title: 'Light or dark, your choice',
            body: 'Click here to switch between light and dark mode — pick what feels easiest on your eyes.',
        },
        {
            selector: '.btn-action.primary, #empty-upload-btn',
            title: 'Bring in your material',
            body: 'Upload any PDF and OmNote instantly builds a study plan, smart summaries, flashcards, and quizzes.',
        },
        {
            selector: '.btn-upload-top',
            title: 'Ready when you are',
            body: 'This is your quick-upload button. Tap it whenever you want to start a new study session.',
            pulse: true,
        },
    ];

    let overlay, spotlight, tooltip, currentIndex = 0, persistKey = null;

    function findTarget(step) {
        const sels = step.selector.split(',').map(s => s.trim());
        for (const s of sels) {
            const el = document.querySelector(s);
            if (el && el.offsetParent !== null) return el;
        }
        return null;
    }

    function positionSpotlight(el) {
        const r = el.getBoundingClientRect();
        const pad = 8;
        spotlight.style.top = (r.top - pad) + 'px';
        spotlight.style.left = (r.left - pad) + 'px';
        spotlight.style.width = (r.width + pad * 2) + 'px';
        spotlight.style.height = (r.height + pad * 2) + 'px';

        // Tooltip position: below if room, else above
        const tipH = 180;
        const below = r.bottom + tipH + 20 < window.innerHeight;
        tooltip.style.top = (below ? r.bottom + 18 : r.top - tipH - 18) + 'px';
        let left = r.left + r.width / 2 - 170;
        left = Math.max(16, Math.min(left, window.innerWidth - 356));
        tooltip.style.left = left + 'px';
    }

    function renderStep() {
        const step = STEPS[currentIndex];
        const target = findTarget(step);
        if (!target) {
            // Skip missing target
            if (currentIndex < STEPS.length - 1) {
                currentIndex++;
                renderStep();
                return;
            }
            endTour(true);
            return;
        }

        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => positionSpotlight(target), 100);

        spotlight.classList.toggle('pulse', !!step.pulse);

        tooltip.innerHTML = `
            <div class="tour-step-count">Step ${currentIndex + 1} of ${STEPS.length}</div>
            <div class="tour-step-title">${step.title}</div>
            <div class="tour-step-body">${step.body}</div>
            <div class="tour-step-actions">
                <button class="tour-btn-skip" data-tour-action="skip">Skip tour</button>
                <div style="flex:1"></div>
                ${currentIndex > 0 ? '<button class="tour-btn-back" data-tour-action="back">Back</button>' : ''}
                <button class="tour-btn-next" data-tour-action="next">
                    ${currentIndex === STEPS.length - 1 ? 'Got it' : 'Next'}
                </button>
            </div>
        `;

        tooltip.querySelectorAll('[data-tour-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const a = e.currentTarget.getAttribute('data-tour-action');
                if (a === 'skip') endTour(true);
                else if (a === 'back') { currentIndex--; renderStep(); }
                else if (a === 'next') {
                    if (currentIndex === STEPS.length - 1) endTour(true);
                    else { currentIndex++; renderStep(); }
                }
            });
        });
    }

    function onResize() {
        const step = STEPS[currentIndex];
        if (!step) return;
        const target = findTarget(step);
        if (target) positionSpotlight(target);
    }

    function endTour(markDone) {
        if (overlay) overlay.remove();
        overlay = spotlight = tooltip = null;
        window.removeEventListener('resize', onResize);
        window.removeEventListener('scroll', onResize, true);
        if (markDone && persistKey) {
            try { localStorage.setItem(persistKey, '1'); } catch (e) {}
        }
    }

    window.startOmnoteTour = function (key) {
        if (overlay) return; // already running
        persistKey = key || null;
        currentIndex = 0;

        overlay = document.createElement('div');
        overlay.id = 'omn-tour-overlay';
        overlay.innerHTML = `
            <div id="omn-tour-spotlight"></div>
            <div id="omn-tour-tooltip"></div>
            <button id="omn-tour-close" aria-label="Close tour"><i data-lucide="x"></i></button>
        `;
        document.body.appendChild(overlay);
        spotlight = overlay.querySelector('#omn-tour-spotlight');
        tooltip = overlay.querySelector('#omn-tour-tooltip');
        overlay.querySelector('#omn-tour-close').addEventListener('click', () => endTour(true));

        window.addEventListener('resize', onResize);
        window.addEventListener('scroll', onResize, true);
        renderStep();
    };
})();
