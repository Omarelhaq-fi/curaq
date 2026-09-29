// Scheduler — study sessions + exams on a monthly calendar
(function () {
    let viewDate = new Date(); // any date within the currently visible month
    let selectedISO = null;    // YYYY-MM-DD selected day
    let currentType = 'study'; // form state

    function esc(s) {
        return (s || '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function fromISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
    function todayISO() { return toISO(new Date()); }

    function items() {
        if (!window.db) return [];
        if (!Array.isArray(db.schedule)) db.schedule = [];
        return db.schedule;
    }
    // Virtual scheduler items derived from SRS due dates. Read-only.
    function srsVirtualItems() {
        if (!window.db || !Array.isArray(db.rems)) return [];
        const now = Date.now();
        const todayStr = todayISO();
        const buckets = {}; // iso -> count
        for (const r of db.rems) {
            if (!r.isFlashcard || r.leech) continue;
            let iso;
            if (!r.nextReview || r.nextReview <= now) iso = todayStr; // overdue → today
            else {
                const d = new Date(r.nextReview);
                iso = toISO(d);
            }
            buckets[iso] = (buckets[iso] || 0) + 1;
        }
        return Object.entries(buckets).map(([iso, n]) => ({
            id: 'srs:' + iso,
            type: 'srs',
            title: `Review ${n} card${n === 1 ? '' : 's'}`,
            date: iso,
            time: '',
            duration: null,
            docId: null,
            notes: '',
            virtual: true,
            count: n,
        }));
    }
    function allItems() { return items().concat(srsVirtualItems()); }
    function itemsOn(iso) {
        return allItems().filter(i => i.date === iso).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    }
    function docTitle(id) {
        if (!id || !window.db) return '';
        const d = (db.documents || []).find(x => x.id === id);
        return d ? d.title : '';
    }
    function daysUntil(iso) {
        const t0 = new Date(); t0.setHours(0, 0, 0, 0);
        const t1 = fromISO(iso); t1.setHours(0, 0, 0, 0);
        return Math.round((t1 - t0) / 86400000);
    }
    function relativeLabel(iso) {
        const d = daysUntil(iso);
        if (d === 0) return 'Today';
        if (d === 1) return 'Tomorrow';
        if (d === -1) return 'Yesterday';
        if (d > 0 && d <= 7) return 'In ' + d + ' days';
        if (d < 0) return Math.abs(d) + 'd ago';
        return fromISO(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    // ---- Public: show view ----
    window.showSchedulerView = function () {
        const home = document.getElementById('home-view');
        const ws = document.getElementById('workspace');
        const sv = document.getElementById('scheduler-view');
        const rv = document.getElementById('recall-view');
        if (home) home.style.display = 'none';
        if (ws) ws.style.display = 'none';
        if (sv) sv.style.display = 'block';
        const stv = document.getElementById('stats-view');
        if (stv) stv.style.display = 'none';
        if (rv) rv.style.display = 'none';
        document.body.classList.remove('doc-open');
        document.body.classList.remove('stats-open');
        document.body.classList.remove('recall-open');
        document.body.classList.add('scheduler-open');

        const topGroup = document.getElementById('top-doc-title-group');
        if (topGroup) topGroup.style.display = 'none';
        const navTabs = document.getElementById('main-nav-tabs');
        if (navTabs) navTabs.style.display = 'none';

        if (!selectedISO) selectedISO = todayISO();
        viewDate = fromISO(selectedISO);
        renderCalendar();
        renderDayList();
        renderUpcoming();
    };

    // ---- Calendar rendering ----
    function renderCalendar() {
        const grid = document.getElementById('sched-cal-grid');
        const titleEl = document.getElementById('sched-cal-title');
        if (!grid || !titleEl) return;

        const year = viewDate.getFullYear();
        const month = viewDate.getMonth();
        titleEl.textContent = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

        const first = new Date(year, month, 1);
        const startDow = first.getDay(); // 0=Sun
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const daysInPrev = new Date(year, month, 0).getDate();
        const cells = [];

        // leading days (from previous month)
        for (let i = startDow - 1; i >= 0; i--) {
            cells.push({ day: daysInPrev - i, month: month - 1, muted: true });
        }
        // current month
        for (let d = 1; d <= daysInMonth; d++) {
            cells.push({ day: d, month: month, muted: false });
        }
        // trailing to complete a 6-row grid (42 cells)
        while (cells.length < 42) {
            const last = cells[cells.length - 1];
            const nd = last.day + 1;
            cells.push({ day: nd, month: last.month + (last.muted ? 0 : 1), muted: true });
        }

        const today = todayISO();
        grid.innerHTML = cells.map(c => {
            const dt = new Date(year, c.month, c.day);
            const iso = toISO(dt);
            const dayItems = itemsOn(iso);
            const isToday = iso === today;
            const isSelected = iso === selectedISO;
            const cls = [
                'sched-cell',
                c.muted ? 'muted' : '',
                isToday ? 'today' : '',
                isSelected ? 'selected' : '',
            ].filter(Boolean).join(' ');

            const chips = dayItems.slice(0, 3).map(it => {
                const t = it.type === 'exam' ? 'exam' : (it.type === 'srs' ? 'srs' : 'study');
                const icon = t === 'srs' ? '<i data-lucide="brain"></i> ' : '';
                return `<div class="sched-cell-chip ${t}" title="${esc(it.title)}">${icon}${it.time ? esc(it.time) + ' ' : ''}${esc(it.title)}</div>`;
            }).join('');
            const more = dayItems.length > 3 ? `<div class="sched-cell-more">+${dayItems.length - 3} more</div>` : '';

            return `<div class="${cls}" data-iso="${iso}" onclick="window.schedSelectDay('${iso}')">
                <div class="sched-cell-day">${c.day}</div>
                <div class="sched-cell-items">${chips}${more}</div>
            </div>`;
        }).join('');
    }

    window.schedNav = function (dir) {
        if (dir === 0) {
            viewDate = new Date();
            selectedISO = todayISO();
        } else {
            viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + dir, 1);
        }
        renderCalendar();
        renderDayList();
    };

    window.schedSelectDay = function (iso) {
        selectedISO = iso;
        const d = fromISO(iso);
        if (d.getMonth() !== viewDate.getMonth() || d.getFullYear() !== viewDate.getFullYear()) {
            viewDate = d;
        }
        renderCalendar();
        renderDayList();
    };

    // ---- Day panel ----
    function renderDayList() {
        const listEl = document.getElementById('sched-day-list');
        const titleEl = document.getElementById('sched-day-title');
        if (!listEl || !titleEl) return;

        if (!selectedISO) {
            titleEl.textContent = 'Select a day';
            listEl.innerHTML = `<div class="sched-empty">Pick a day on the calendar to see or add items.</div>`;
            return;
        }
        const d = fromISO(selectedISO);
        titleEl.textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

        const list = itemsOn(selectedISO);
        if (list.length === 0) {
            listEl.innerHTML = `<div class="sched-empty">Nothing scheduled. Click ＋ to add.</div>`;
            return;
        }
        listEl.innerHTML = list.map(it => itemRow(it)).join('');
    }

    function renderUpcoming() {
        const el = document.getElementById('sched-upcoming');
        if (!el) return;
        const today = todayISO();
        const in7 = toISO(new Date(Date.now() + 7 * 86400000));
        const list = allItems()
            .filter(i => i.date >= today && i.date <= in7)
            .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
        if (list.length === 0) {
            el.innerHTML = `<div class="sched-empty">Nothing scheduled in the next 7 days.</div>`;
            return;
        }
        el.innerHTML = list.map(it => itemRow(it, true)).join('');
    }

    function itemRow(it, showDate) {
        // Virtual SRS review item — read-only, opens review filtered to that day.
        if (it.virtual && it.type === 'srs') {
            const when = showDate ? `<span class="sched-tag">${esc(relativeLabel(it.date))}</span>` : '';
            const count = `<span class="sched-tag"><i data-lucide="brain"></i> ${it.count} due</span>`;
            return `
                <div class="sched-item srs" onclick="window.startReviewForDate('${it.date}')" style="cursor:pointer">
                    <div class="sched-item-ico"><i data-lucide="brain"></i></div>
                    <div class="sched-item-main">
                        <div class="sched-item-title">${esc(it.title)}</div>
                        <div class="sched-item-meta">${when}${count}</div>
                    </div>
                    <button class="sched-item-del" onclick="event.stopPropagation(); window.startReviewForDate('${it.date}')" title="Start review" style="background:transparent;border:none;font-size:18px;cursor:pointer">▶</button>
                </div>`;
        }
        const t = it.type === 'exam' ? 'exam' : 'study';
        const emoji = t === 'exam' ? '<i data-lucide="target"></i>' : '<i data-lucide="book-open"></i>';
        const linked = it.docId ? `<span class="sched-tag"><i data-lucide="file-text"></i> ${esc(docTitle(it.docId))}</span>` : '';
        const dur = (t === 'study' && it.duration) ? `<span class="sched-tag">⏱ ${it.duration}m</span>` : '';
        const when = showDate ? `<span class="sched-tag">${esc(relativeLabel(it.date))}${it.time ? ' · ' + esc(it.time) : ''}</span>`
                              : (it.time ? `<span class="sched-tag"><i data-lucide="clock"></i> ${esc(it.time)}</span>` : '');
        return `
            <div class="sched-item ${t}" onclick="window.editScheduleItem('${it.id}')">
                <div class="sched-item-ico">${emoji}</div>
                <div class="sched-item-main">
                    <div class="sched-item-title">${esc(it.title || '(untitled)')}</div>
                    <div class="sched-item-meta">${when}${dur}${linked}</div>
                    ${it.notes ? `<div class="sched-item-notes">${esc(it.notes)}</div>` : ''}
                </div>
                <button class="sched-item-del" onclick="event.stopPropagation(); window.deleteScheduleItemById('${it.id}')" title="Delete"><i data-lucide="trash-2"></i></button>
            </div>`;
    }

    // ---- Modal / CRUD ----
    function fillDocSelect() {
        const sel = document.getElementById('sched-doc');
        if (!sel) return;
        const docs = (window.db && db.documents) ? db.documents : [];
        sel.innerHTML = `<option value="">— None —</option>` +
            docs.map(d => `<option value="${d.id}">${esc(d.title || 'Untitled')}</option>`).join('');
    }

    window.setSchedType = function (t) {
        if (t === 'exam' && window.isFreePlan && window.isFreePlan() &&
            window.FREE_LIMITS && window.FREE_LIMITS.examEvents === false) {
            window.showLockedFeature && window.showLockedFeature(
                'Exam scheduling',
                'Exam-type events are a Pro feature. Free users can still add study sessions.'
            );
            t = 'study';
        }
        currentType = t;
        const s = document.getElementById('sched-type-study');
        const e = document.getElementById('sched-type-exam');
        if (s) s.classList.toggle('active', t === 'study');
        if (e) e.classList.toggle('active', t === 'exam');
        const durWrap = document.getElementById('sched-duration-wrap');
        if (durWrap) durWrap.style.display = t === 'study' ? '' : 'none';
        const titleEl = document.getElementById('sched-modal-title');
        if (titleEl) { titleEl.innerHTML = t === 'exam' ? '<i data-lucide="target"></i> Exam' : '<i data-lucide="book-open"></i> Study Session'; try { window.lucide && window.lucide.createIcons(); } catch(e){} }
    };

    window.openSchedulerAdd = function (type) {
        const currentCount = items().length;
        const cap = (window.FREE_LIMITS && window.FREE_LIMITS.scheduleItems) || 5;
        if (window.gateFreeLimit && !window.gateFreeLimit({
            current: currentCount, limit: cap,
            label: 'Unlimited scheduler items',
            subtitle: `Free plan is limited to ${cap} scheduled items. Become a Supporter for an unlimited planner.`,
        })) return;
        fillDocSelect();
        document.getElementById('sched-edit-id').value = '';
        document.getElementById('sched-title').value = '';
        document.getElementById('sched-date').value = selectedISO || todayISO();
        document.getElementById('sched-time').value = '';
        document.getElementById('sched-duration').value = '60';
        document.getElementById('sched-doc').value = '';
        document.getElementById('sched-notes').value = '';
        document.getElementById('sched-delete-btn').style.display = 'none';
        window.setSchedType(type || 'study');
        window.openModal('scheduler-modal');
        setTimeout(() => document.getElementById('sched-title').focus(), 50);
    };

    window.editScheduleItem = function (id) {
        const it = items().find(i => i.id === id);
        if (!it) return;
        fillDocSelect();
        document.getElementById('sched-edit-id').value = it.id;
        document.getElementById('sched-title').value = it.title || '';
        document.getElementById('sched-date').value = it.date || todayISO();
        document.getElementById('sched-time').value = it.time || '';
        document.getElementById('sched-duration').value = it.duration || '';
        document.getElementById('sched-doc').value = it.docId || '';
        document.getElementById('sched-notes').value = it.notes || '';
        document.getElementById('sched-delete-btn').style.display = '';
        window.setSchedType(it.type || 'study');
        window.openModal('scheduler-modal');
    };

    window.saveScheduleItem = function () {
        const id = document.getElementById('sched-edit-id').value;
        const title = (document.getElementById('sched-title').value || '').trim();
        const date = document.getElementById('sched-date').value;
        const time = document.getElementById('sched-time').value;
        const duration = parseInt(document.getElementById('sched-duration').value, 10);
        const docId = document.getElementById('sched-doc').value || null;
        const notes = (document.getElementById('sched-notes').value || '').trim();

        if (!title) { alert('Please enter a title.'); return; }
        if (!date) { alert('Please pick a date.'); return; }

        const arr = items();
        if (id) {
            const it = arr.find(i => i.id === id);
            if (!it) return;
            it.type = currentType;
            it.title = title;
            it.date = date;
            it.time = time || '';
            it.duration = currentType === 'study' && !isNaN(duration) ? duration : null;
            it.docId = docId;
            it.notes = notes;
        } else {
            arr.push({
                id: crypto.randomUUID().replace(/-/g,'').slice(0,9),
                type: currentType,
                title, date, time: time || '',
                duration: currentType === 'study' && !isNaN(duration) ? duration : null,
                docId, notes,
                created: Date.now(),
            });
        }
        if (typeof saveDb === 'function') saveDb();
        window.closeModal('scheduler-modal');
        selectedISO = date;
        viewDate = fromISO(date);
        renderCalendar();
        renderDayList();
        renderUpcoming();
    };

    window.deleteScheduleItem = function () {
        const id = document.getElementById('sched-edit-id').value;
        if (!id) return;
        window.deleteScheduleItemById(id, true);
        window.closeModal('scheduler-modal');
    };

    window.deleteScheduleItemById = function (id, skipConfirm) {
        if (!skipConfirm && !confirm('Delete this item?')) return;
        const arr = items();
        const idx = arr.findIndex(i => i.id === id);
        if (idx === -1) return;
        arr.splice(idx, 1);
        if (typeof saveDb === 'function') saveDb();
        renderCalendar();
        renderDayList();
        renderUpcoming();
    };

    // Start a review session filtered to cards due on/before a given ISO date.
    // For "today" we include everything overdue too.
    window.startReviewForDate = function (iso) {
        if (!window.db || !Array.isArray(db.rems)) return;
        const now = Date.now();
        const todayStr = todayISO();
        const target = fromISO(iso); target.setHours(23, 59, 59, 999);
        const targetMs = target.getTime();
        const queue = db.rems.filter(r => {
            if (!r.isFlashcard || r.leech) return false;
            if (iso === todayStr) return !r.nextReview || r.nextReview <= targetMs;
            if (!r.nextReview) return false;
            const d = new Date(r.nextReview);
            return toISO(d) === iso;
        });
        if (queue.length === 0) { alert('No cards to review for this day.'); return; }
        if (window.srs) queue.forEach(c => window.srs.ensureSrs(c));
        if (typeof window.startReviewWithCards === 'function') {
            window.startReviewWithCards(queue);
        }
    };

    // Public refresh hook so other modules can trigger a re-render after grading.
    window.refreshSchedulerView = function () {
        const sv = document.getElementById('scheduler-view');
        if (!sv || sv.style.display === 'none') return;
        renderCalendar();
        renderDayList();
        renderUpcoming();
    };
})();
