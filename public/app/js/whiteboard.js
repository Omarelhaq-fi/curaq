// OmNote Whiteboard — per-document canvas with pen/highlighter/eraser,
// shapes, text, images, lasso select, layers, undo/redo, page thumbnails.
// Persists to Firestore via the app's saveDb().

(function () {
    const uid = () => crypto.randomUUID().replace(/-/g,'').slice(0,8);

    // --- State ---
    let canvas, ctx, host, thumbsEl, layersEl, statusEl, textEditor, imageInput;
    let tool = 'pen', color = '#111827', size = 3;
    let view = { x: 0, y: 0, scale: 1 };          // pan/zoom
    let drawing = null;                            // active in-progress element
    let undoStack = [], redoStack = [];
    let saveTimer = null;
    let activePageId = null, activeLayerId = null;
    let selection = [];                            // array of element ids on active layer
    let lassoPath = null;
    let dragMode = null;                           // 'pan' | 'move-selection'
    let dragStart = null;
    let currentDocId = null;
    let raf = null;
    let showLayersPanel = false;
    let panSpaceHeld = false;

    // --- Access to app doc ---
    function activeDoc() {
        try { return window.getActiveDoc && window.getActiveDoc(); } catch (_) { return null; }
    }

    function ensureModel(doc) {
        if (!doc) return null;
        if (!doc.whiteboard || !doc.whiteboard.pages || doc.whiteboard.pages.length === 0) {
            const layerId = uid();
            const pageId = uid();
            doc.whiteboard = {
                pages: [{
                    id: pageId,
                    layers: [{ id: layerId, name: 'Layer 1', visible: true, locked: false, elements: [] }]
                }],
                activePageId: pageId
            };
        }
        activePageId = doc.whiteboard.activePageId || doc.whiteboard.pages[0].id;
        const page = doc.whiteboard.pages.find(p => p.id === activePageId) || doc.whiteboard.pages[0];
        activePageId = page.id;
        if (!activeLayerId || !page.layers.find(l => l.id === activeLayerId)) {
            activeLayerId = page.layers[0].id;
        }
        return doc.whiteboard;
    }

    function currentPage() {
        const doc = activeDoc(); if (!doc || !doc.whiteboard) return null;
        return doc.whiteboard.pages.find(p => p.id === activePageId);
    }
    function currentLayer() {
        const p = currentPage(); if (!p) return null;
        return p.layers.find(l => l.id === activeLayerId) || p.layers[0];
    }

    // --- Persistence (debounced) ---
    function markDirty() {
        setStatus('Editing…');
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try { window.saveDb && window.saveDb(); setStatus('Saved'); }
            catch (e) { setStatus('Save error'); console.error(e); }
        }, 700);
    }
    function setStatus(t) { if (statusEl) statusEl.textContent = t; }

    // --- Undo/Redo (snapshot of active page) ---
    function snapshot() {
        const p = currentPage(); if (!p) return null;
        return JSON.stringify(p.layers);
    }
    function pushUndo() {
        const s = snapshot(); if (s == null) return;
        undoStack.push(s);
        if (undoStack.length > 60) undoStack.shift();
        redoStack.length = 0;
    }
    function doUndo() {
        const p = currentPage(); if (!p || !undoStack.length) return;
        redoStack.push(snapshot());
        p.layers = JSON.parse(undoStack.pop());
        activeLayerId = p.layers[0].id;
        selection = [];
        render(); renderLayers(); renderThumbs(); markDirty();
    }
    function doRedo() {
        const p = currentPage(); if (!p || !redoStack.length) return;
        undoStack.push(snapshot());
        p.layers = JSON.parse(redoStack.pop());
        activeLayerId = p.layers[0].id;
        selection = [];
        render(); renderLayers(); renderThumbs(); markDirty();
    }

    // --- Coordinate mapping ---
    function toWorld(e) {
        const r = canvas.getBoundingClientRect();
        const x = (e.clientX - r.left) - view.x;
        const y = (e.clientY - r.top) - view.y;
        return { x: x / view.scale, y: y / view.scale };
    }

    // --- Rendering ---
    function resizeCanvas() {
        if (!canvas) return;
        const r = host.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(r.width * dpr);
        canvas.height = Math.floor(r.height * dpr);
        canvas.style.width = r.width + 'px';
        canvas.style.height = r.height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        render();
    }

    function render() {
        if (!ctx) return;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        ctx.save();
        ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
        ctx.clearRect(0, 0, w, h);
        // grid bg
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, w, h);
        drawGrid(w, h);
        ctx.translate(view.x, view.y);
        ctx.scale(view.scale, view.scale);

        const page = currentPage();
        if (page) {
            page.layers.forEach(layer => {
                if (!layer.visible) return;
                layer.elements.forEach(el => drawElement(ctx, el));
            });
        }
        if (drawing) drawElement(ctx, drawing);

        // selection outline + resize handles (handles only when a single item is selected)
        if (selection.length) {
            const layer = currentLayer();
            const single = selection.length === 1;
            selection.forEach(id => {
                const el = layer && layer.elements.find(e => e.id === id);
                if (!el) return;
                const b = elementBounds(el);
                if (!b) return;
                ctx.save();
                ctx.strokeStyle = '#8b5cf6';
                ctx.lineWidth = 1 / view.scale;
                ctx.setLineDash([6 / view.scale, 4 / view.scale]);
                ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
                ctx.restore();
                if (single && el.type !== 'stroke' && el.type !== 'arrow') {
                    const hs = HANDLE_SIZE / view.scale;
                    getHandles(el).forEach(h => {
                        ctx.save();
                        ctx.fillStyle = '#fff';
                        ctx.strokeStyle = '#8b5cf6';
                        ctx.lineWidth = 1.5 / view.scale;
                        ctx.setLineDash([]);
                        ctx.fillRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
                        ctx.strokeRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
                        ctx.restore();
                    });
                }
            });
        }
        if (lassoPath && lassoPath.length > 1) {
            ctx.save();
            ctx.strokeStyle = '#8b5cf6';
            ctx.lineWidth = 1 / view.scale;
            ctx.setLineDash([4 / view.scale, 3 / view.scale]);
            ctx.beginPath();
            ctx.moveTo(lassoPath[0].x, lassoPath[0].y);
            for (let i = 1; i < lassoPath.length; i++) ctx.lineTo(lassoPath[i].x, lassoPath[i].y);
            ctx.closePath();
            ctx.stroke();
            ctx.restore();
        }
        ctx.restore();
    }

    function drawGrid(w, h) {
        const step = 24;
        ctx.strokeStyle = 'rgba(15,23,42,0.06)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        const ox = view.x % step, oy = view.y % step;
        for (let x = ox; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
        for (let y = oy; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
        ctx.stroke();
    }

    function drawElement(c, el) {
        c.save();
        if (el.type === 'stroke') {
            c.strokeStyle = el.color;
            c.lineWidth = el.size;
            c.lineCap = 'round';
            c.lineJoin = 'round';
            if (el.mode === 'highlight') { c.globalAlpha = 0.35; c.lineWidth = el.size * 3; }
            c.beginPath();
            const pts = el.points;
            if (pts.length < 2) {
                c.arc(pts[0].x, pts[0].y, el.size / 2, 0, Math.PI * 2);
                c.fillStyle = el.color; c.fill();
            } else {
                c.moveTo(pts[0].x, pts[0].y);
                for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
                c.stroke();
            }
        } else if (el.type === 'rect') {
            c.strokeStyle = el.color; c.lineWidth = el.size;
            c.strokeRect(el.x, el.y, el.w, el.h);
        } else if (el.type === 'arrow') {
            c.strokeStyle = el.color; c.fillStyle = el.color; c.lineWidth = el.size;
            c.beginPath(); c.moveTo(el.x1, el.y1); c.lineTo(el.x2, el.y2); c.stroke();
            const ang = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
            const ah = 10 + el.size * 2;
            c.beginPath();
            c.moveTo(el.x2, el.y2);
            c.lineTo(el.x2 - ah * Math.cos(ang - 0.4), el.y2 - ah * Math.sin(ang - 0.4));
            c.lineTo(el.x2 - ah * Math.cos(ang + 0.4), el.y2 - ah * Math.sin(ang + 0.4));
            c.closePath(); c.fill();
        } else if (el.type === 'text') {
            c.fillStyle = el.color;
            c.font = `${el.size * 6}px system-ui, -apple-system, sans-serif`;
            c.textBaseline = 'top';
            (el.text || '').split('\n').forEach((line, i) => {
                c.fillText(line, el.x, el.y + i * el.size * 7);
            });
        } else if (el.type === 'image') {
            if (!el._img) {
                el._img = new Image();
                el._img.onload = () => scheduleRender();
                el._img.src = el.src;
            }
            if (el._img.complete) c.drawImage(el._img, el.x, el.y, el.w, el.h);
        }
        c.restore();
    }

    function elementBounds(el) {
        if (el.type === 'stroke') {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            el.points.forEach(p => { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; });
            const pad = el.size / 2;
            return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
        }
        if (el.type === 'rect') return { x: Math.min(el.x, el.x + el.w), y: Math.min(el.y, el.y + el.h), w: Math.abs(el.w), h: Math.abs(el.h) };
        if (el.type === 'arrow') return { x: Math.min(el.x1, el.x2), y: Math.min(el.y1, el.y2), w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) };
        if (el.type === 'text') return { x: el.x, y: el.y, w: Math.max(80, (el.text || '').length * el.size * 3), h: (el.text || '').split('\n').length * el.size * 7 };
        if (el.type === 'image') return { x: el.x, y: el.y, w: el.w, h: el.h };
        return null;
    }

    function translateElement(el, dx, dy) {
        if (el.type === 'stroke') el.points.forEach(p => { p.x += dx; p.y += dy; });
        else if (el.type === 'rect' || el.type === 'text' || el.type === 'image') { el.x += dx; el.y += dy; }
        else if (el.type === 'arrow') { el.x1 += dx; el.y1 += dy; el.x2 += dx; el.y2 += dy; }
    }

    function pointInPolygon(pt, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
            const intersect = ((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || 1e-9) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function scheduleRender() {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = null; render(); });
    }

    // --- Pointer / drawing ---
    const HANDLE_SIZE = 8; // in screen px

    function getHandles(el) {
        const b = elementBounds(el); if (!b) return [];
        return [
            { name: 'nw', x: b.x, y: b.y }, { name: 'n', x: b.x + b.w / 2, y: b.y }, { name: 'ne', x: b.x + b.w, y: b.y },
            { name: 'e', x: b.x + b.w, y: b.y + b.h / 2 }, { name: 'se', x: b.x + b.w, y: b.y + b.h },
            { name: 's', x: b.x + b.w / 2, y: b.y + b.h }, { name: 'sw', x: b.x, y: b.y + b.h }, { name: 'w', x: b.x, y: b.y + b.h / 2 },
        ];
    }
    function hitHandle(el, p) {
        const r = HANDLE_SIZE / view.scale;
        for (const h of getHandles(el)) {
            if (Math.abs(p.x - h.x) <= r && Math.abs(p.y - h.y) <= r) return h.name;
        }
        return null;
    }
    function hitElement(p) {
        const layer = currentLayer(); if (!layer) return null;
        for (let i = layer.elements.length - 1; i >= 0; i--) {
            const el = layer.elements[i];
            const b = elementBounds(el); if (!b) continue;
            if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return el;
        }
        return null;
    }
    function resizeElement(el, handle, dx, dy, shift) {
        if (el.type === 'stroke' || el.type === 'arrow') return; // skip complex resizes
        const b = elementBounds(el);
        let nx = b.x, ny = b.y, nw = b.w, nh = b.h;
        if (handle.includes('e')) nw = Math.max(4, b.w + dx);
        if (handle.includes('s')) nh = Math.max(4, b.h + dy);
        if (handle.includes('w')) { nx = b.x + dx; nw = Math.max(4, b.w - dx); }
        if (handle.includes('n')) { ny = b.y + dy; nh = Math.max(4, b.h - dy); }
        if (el.type === 'image' || shift) {
            const ratio = b.w / b.h;
            if (Math.abs(nw / (nh || 1) - ratio) > 0.001) {
                if (handle === 'e' || handle === 'w') nh = nw / ratio;
                else if (handle === 'n' || handle === 's') nw = nh * ratio;
                else nh = nw / ratio;
                if (handle.includes('n')) ny = b.y + b.h - nh;
                if (handle.includes('w')) nx = b.x + b.w - nw;
            }
        }
        if (el.type === 'rect') { el.x = nx; el.y = ny; el.w = nw; el.h = nh; }
        else if (el.type === 'image') { el.x = nx; el.y = ny; el.w = nw; el.h = nh; }
        else if (el.type === 'text') {
            el.x = nx; el.y = ny;
            // scale text size by height change
            const factor = nh / b.h;
            el.size = Math.max(1, Math.min(60, el.size * factor));
        }
    }

    function onPointerDown(e) {
        if (!currentPage()) return;
        if (e.pointerType === 'touch' && tool !== 'hand' && !panSpaceHeld && document.body.classList.contains('wb-pen-preferred')) return;
        const p = toWorld(e);

        if (tool === 'hand' || panSpaceHeld || e.button === 1) {
            canvas.setPointerCapture(e.pointerId);
            dragMode = 'pan';
            dragStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
            return;
        }

        // Lasso / select tool: allow handle-resize, click-select, drag-move, or lasso.
        if (tool === 'lasso') {
            const layer = currentLayer();
            // resize handle on single selection?
            if (selection.length === 1 && layer) {
                const el = layer.elements.find(x => x.id === selection[0]);
                if (el) {
                    const h = hitHandle(el, p);
                    if (h) {
                        canvas.setPointerCapture(e.pointerId);
                        pushUndo();
                        dragMode = 'resize';
                        dragStart = { x: p.x, y: p.y, handle: h, el };
                        return;
                    }
                }
            }
            const hit = hitElement(p);
            if (hit) {
                canvas.setPointerCapture(e.pointerId);
                if (!selection.includes(hit.id)) selection = [hit.id];
                pushUndo();
                dragMode = 'move-selection';
                dragStart = { x: p.x, y: p.y };
                scheduleRender();
                return;
            }
            canvas.setPointerCapture(e.pointerId);
            lassoPath = [p];
            selection = [];
            scheduleRender();
            return;
        }

        const layer = currentLayer();
        if (!layer || layer.locked) return;

        if (tool === 'text') {
            // Do NOT capture pointer — the contenteditable needs focus.
            const layer2 = currentLayer();
            if (layer2) {
                const hit = hitElement(p);
                if (hit && hit.type === 'text') { openTextEditor({ x: hit.x, y: hit.y }, hit); return; }
            }
            openTextEditor(p, null);
            return;
        }

        canvas.setPointerCapture(e.pointerId);

        if (tool === 'pen' || tool === 'highlighter') {
            drawing = { id: uid(), type: 'stroke', mode: tool === 'highlighter' ? 'highlight' : 'pen', color, size, points: [p] };
        } else if (tool === 'eraser') {
            eraseAt(p);
        } else if (tool === 'rect') {
            drawing = { id: uid(), type: 'rect', color, size, x: p.x, y: p.y, w: 0, h: 0 };
        } else if (tool === 'arrow') {
            drawing = { id: uid(), type: 'arrow', color, size, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
        } else if (tool === 'image' && imageInput) {
            imageInput.dataset.wx = p.x; imageInput.dataset.wy = p.y;
            imageInput.click();
        }
        scheduleRender();
    }

    function onPointerMove(e) {
        if (dragMode === 'pan') {
            view.x = dragStart.vx + (e.clientX - dragStart.x);
            view.y = dragStart.vy + (e.clientY - dragStart.y);
            scheduleRender();
            return;
        }
        if (dragMode === 'resize') {
            const p = toWorld(e);
            const dx = p.x - dragStart.x, dy = p.y - dragStart.y;
            resizeElement(dragStart.el, dragStart.handle, dx, dy, e.shiftKey);
            dragStart.x = p.x; dragStart.y = p.y;
            scheduleRender();
            return;
        }
        if (dragMode === 'move-selection') {
            const p = toWorld(e);
            const dx = p.x - dragStart.x, dy = p.y - dragStart.y;
            const layer = currentLayer();
            selection.forEach(id => {
                const el = layer.elements.find(x => x.id === id);
                if (el) translateElement(el, dx, dy);
            });
            dragStart = { x: p.x, y: p.y };
            scheduleRender();
            return;
        }
        if (!drawing && !lassoPath && tool !== 'eraser') return;
        const p = toWorld(e);
        if (tool === 'eraser' && e.buttons) { eraseAt(p); scheduleRender(); return; }
        if (lassoPath) { lassoPath.push(p); scheduleRender(); return; }
        if (!drawing) return;
        if (drawing.type === 'stroke') drawing.points.push(p);
        else if (drawing.type === 'rect') { drawing.w = p.x - drawing.x; drawing.h = p.y - drawing.y; }
        else if (drawing.type === 'arrow') { drawing.x2 = p.x; drawing.y2 = p.y; }
        scheduleRender();
    }

    function onPointerUp(e) {
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        if (dragMode === 'resize' || dragMode === 'move-selection') { dragMode = null; markDirty(); renderThumbs(); return; }
        if (dragMode) { dragMode = null; return; }
        if (lassoPath) {
            const layer = currentLayer();
            if (layer && lassoPath.length > 2) {
                selection = layer.elements.filter(el => {
                    const b = elementBounds(el); if (!b) return false;
                    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
                    return pointInPolygon({ x: cx, y: cy }, lassoPath);
                }).map(el => el.id);
            }
            lassoPath = null;
            scheduleRender();
            return;
        }
        if (!drawing) return;
        const layer = currentLayer();
        if (layer && !layer.locked) {
            pushUndo();
            layer.elements.push(drawing);
            markDirty();
            renderThumbs();
        }
        drawing = null;
        scheduleRender();
    }

    function eraseAt(p) {
        const layer = currentLayer(); if (!layer || layer.locked) return;
        const before = layer.elements.length;
        layer.elements = layer.elements.filter(el => {
            const b = elementBounds(el); if (!b) return true;
            const hit = p.x >= b.x - 6 && p.x <= b.x + b.w + 6 && p.y >= b.y - 6 && p.y <= b.y + b.h + 6;
            return !hit;
        });
        if (layer.elements.length !== before) { pushUndo(); markDirty(); renderThumbs(); }
    }

    // --- Text editing ---
    function openTextEditor(p, existing) {
        const screenX = p.x * view.scale + view.x;
        const screenY = p.y * view.scale + view.y;
        textEditor.style.display = 'block';
        textEditor.style.left = screenX + 'px';
        textEditor.style.top = screenY + 'px';
        textEditor.style.color = color;
        textEditor.style.fontSize = ((existing ? existing.size : size) * 6) + 'px';
        textEditor.textContent = existing ? existing.text : '';
        let committed = false;
        const commit = () => {
            if (committed) return; committed = true;
            const text = textEditor.textContent.replace(/\u200b/g, '').trim();
            textEditor.style.display = 'none';
            textEditor.removeEventListener('blur', commit);
            textEditor.removeEventListener('keydown', onKey);
            if (!text) {
                if (existing) { const l = currentLayer(); l.elements = l.elements.filter(e => e !== existing); markDirty(); render(); }
                return;
            }
            const layer = currentLayer(); if (!layer) return;
            pushUndo();
            if (existing) { existing.text = text; existing.color = color; existing.size = size; }
            else layer.elements.push({ id: uid(), type: 'text', color, size, x: p.x, y: p.y, text });
            markDirty(); renderThumbs(); render();
        };
        const onKey = (ev) => {
            if (ev.key === 'Escape') { ev.preventDefault(); commit(); }
            else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); commit(); }
        };
        textEditor.addEventListener('blur', commit);
        textEditor.addEventListener('keydown', onKey);
        // Defer focus so the pointerdown that opened us doesn't steal it back.
        setTimeout(() => {
            textEditor.focus();
            try {
                const range = document.createRange();
                range.selectNodeContents(textEditor);
                range.collapse(false);
                const sel = window.getSelection();
                sel.removeAllRanges(); sel.addRange(range);
            } catch (_) {}
        }, 0);
    }

    // --- Image insertion ---
    function handleImagePick(file) {
        if (!file) return;
        if (file.size > 800 * 1024) { alert('Image too large (max 800KB).'); return; }
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const layer = currentLayer(); if (!layer) return;
                pushUndo();
                const x = parseFloat(imageInput.dataset.wx || '40');
                const y = parseFloat(imageInput.dataset.wy || '40');
                const max = 400;
                let w = img.width, h = img.height;
                if (w > max) { h = h * (max / w); w = max; }
                layer.elements.push({ id: uid(), type: 'image', src: reader.result, x, y, w, h });
                markDirty(); renderThumbs(); render();
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    }

    // --- Pages ---
    function addPage() {
        const doc = activeDoc(); if (!doc) return;
        ensureModel(doc);
        const currentPages = (doc.whiteboard.pages || []).length;
        if (window.gateFreeLimit && !window.gateFreeLimit({
            current: currentPages,
            limit: (window.FREE_LIMITS && window.FREE_LIMITS.whiteboardPages) || 1,
            label: 'Multi-page whiteboard',
            subtitle: 'Free plan is limited to 1 whiteboard page per document. Become a Supporter for unlimited pages.',
        })) return;
        const layerId = uid();
        const pageId = uid();
        doc.whiteboard.pages.push({ id: pageId, layers: [{ id: layerId, name: 'Layer 1', visible: true, locked: false, elements: [] }] });
        activePageId = pageId; activeLayerId = layerId;
        doc.whiteboard.activePageId = pageId;
        undoStack = []; redoStack = []; selection = [];
        markDirty(); renderThumbs(); renderLayers(); render();
    }
    function switchPage(id) {
        const doc = activeDoc(); if (!doc) return;
        activePageId = id; doc.whiteboard.activePageId = id;
        const p = currentPage(); if (p) activeLayerId = p.layers[0].id;
        undoStack = []; redoStack = []; selection = [];
        markDirty(); renderThumbs(); renderLayers(); render();
    }
    function deletePage(id) {
        const doc = activeDoc(); if (!doc || !doc.whiteboard) return;
        if (doc.whiteboard.pages.length <= 1) { alert('Cannot delete the only page.'); return; }
        if (!confirm('Delete this page?')) return;
        doc.whiteboard.pages = doc.whiteboard.pages.filter(p => p.id !== id);
        if (activePageId === id) activePageId = doc.whiteboard.pages[0].id;
        doc.whiteboard.activePageId = activePageId;
        const p = currentPage(); activeLayerId = p.layers[0].id;
        undoStack = []; redoStack = [];
        markDirty(); renderThumbs(); renderLayers(); render();
    }
    function clearPage() {
        const p = currentPage(); if (!p) return;
        if (!confirm('Clear all content on this page?')) return;
        pushUndo();
        p.layers.forEach(l => l.elements = []);
        selection = [];
        markDirty(); renderThumbs(); render();
    }

    // --- Layers ---
    function addLayer() {
        const p = currentPage(); if (!p) return;
        pushUndo();
        const id = uid();
        p.layers.push({ id, name: 'Layer ' + (p.layers.length + 1), visible: true, locked: false, elements: [] });
        activeLayerId = id;
        markDirty(); renderLayers(); render();
    }
    function deleteLayer(id) {
        const p = currentPage(); if (!p) return;
        if (p.layers.length <= 1) { alert('Cannot delete the only layer.'); return; }
        if (!confirm('Delete this layer?')) return;
        pushUndo();
        p.layers = p.layers.filter(l => l.id !== id);
        if (activeLayerId === id) activeLayerId = p.layers[0].id;
        markDirty(); renderLayers(); render();
    }
    function moveLayer(id, dir) {
        const p = currentPage(); if (!p) return;
        const i = p.layers.findIndex(l => l.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= p.layers.length) return;
        pushUndo();
        [p.layers[i], p.layers[j]] = [p.layers[j], p.layers[i]];
        markDirty(); renderLayers(); render();
    }

    // --- UI rendering ---
    function renderThumbs() {
        if (!thumbsEl) return;
        const doc = activeDoc(); if (!doc || !doc.whiteboard) { thumbsEl.innerHTML = ''; return; }
        thumbsEl.innerHTML = '';
        doc.whiteboard.pages.forEach((page, idx) => {
            const wrap = document.createElement('div');
            wrap.className = 'wb-page-thumb' + (page.id === activePageId ? ' active' : '');
            const c = document.createElement('canvas');
            c.width = 220; c.height = 140;
            wrap.appendChild(c);
            const label = document.createElement('div');
            label.className = 'wb-page-label';
            label.innerHTML = `<span>Page ${idx + 1}</span>`;
            const del = document.createElement('button');
            del.className = 'wb-page-del'; del.innerHTML = '<i data-lucide="x"></i>';
            del.onclick = (e) => { e.stopPropagation(); deletePage(page.id); };
            label.appendChild(del);
            wrap.appendChild(label);
            wrap.onclick = () => switchPage(page.id);
            thumbsEl.appendChild(wrap);
            drawThumbnail(c, page);
        });
    }
    function drawThumbnail(c, page) {
        const tc = c.getContext('2d');
        tc.fillStyle = '#f8fafc'; tc.fillRect(0, 0, c.width, c.height);
        // fit content to thumb
        let minX = 0, minY = 0, maxX = 800, maxY = 500;
        let has = false;
        page.layers.forEach(l => l.elements.forEach(el => {
            const b = elementBounds(el); if (!b) return;
            if (!has) { minX = b.x; minY = b.y; maxX = b.x + b.w; maxY = b.y + b.h; has = true; }
            else {
                if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y;
                if (b.x + b.w > maxX) maxX = b.x + b.w; if (b.y + b.h > maxY) maxY = b.y + b.h;
            }
        }));
        const pad = 20;
        const w = Math.max(200, maxX - minX + pad * 2), h = Math.max(120, maxY - minY + pad * 2);
        const s = Math.min(c.width / w, c.height / h);
        tc.save();
        tc.translate(-minX * s + pad * s, -minY * s + pad * s);
        tc.scale(s, s);
        page.layers.forEach(l => { if (l.visible) l.elements.forEach(el => drawElement(tc, el)); });
        tc.restore();
    }
    function renderLayers() {
        if (!layersEl) return;
        const p = currentPage(); if (!p) { layersEl.innerHTML = ''; return; }
        layersEl.innerHTML = '';
        [...p.layers].reverse().forEach(layer => {
            const row = document.createElement('div');
            row.className = 'wb-layer-item' + (layer.id === activeLayerId ? ' active' : '');
            row.innerHTML = `
                <button title="${layer.visible ? 'Hide' : 'Show'}">${layer.visible ? '<i data-lucide="eye"></i>' : '<i data-lucide="eye-off"></i>'}</button>
                <button title="${layer.locked ? 'Unlock' : 'Lock'}">${layer.locked ? '<i data-lucide="lock"></i>' : '<i data-lucide="unlock"></i>'}</button>
                <div class="wb-layer-name">${layer.name}</div>
                <button title="Up">▲</button>
                <button title="Down">▼</button>
                <button title="Delete"><i data-lucide="trash-2"></i></button>
            `;
            const [bVis, bLock, nameEl, bUp, bDown, bDel] = row.querySelectorAll('button, .wb-layer-name');
            bVis.onclick = () => { pushUndo(); layer.visible = !layer.visible; markDirty(); renderLayers(); render(); };
            bLock.onclick = () => { layer.locked = !layer.locked; renderLayers(); };
            nameEl.onclick = () => { activeLayerId = layer.id; renderLayers(); };
            nameEl.ondblclick = () => { const n = prompt('Layer name', layer.name); if (n) { layer.name = n; markDirty(); renderLayers(); } };
            bUp.onclick = () => moveLayer(layer.id, +1);
            bDown.onclick = () => moveLayer(layer.id, -1);
            bDel.onclick = () => deleteLayer(layer.id);
            layersEl.appendChild(row);
        });
    }

    // --- Init / bind ---
    function applyToSelection(patch) {
        if (!selection.length) return;
        const layer = currentLayer(); if (!layer) return;
        pushUndo();
        let changed = false;
        selection.forEach(id => {
            const el = layer.elements.find(x => x.id === id);
            if (!el) return;
            if (patch.color != null && 'color' in el) { el.color = patch.color; changed = true; }
            if (patch.size != null) {
                if (el.type === 'stroke' || el.type === 'rect' || el.type === 'arrow' || el.type === 'text') {
                    el.size = patch.size; changed = true;
                }
            }
        });
        if (changed) { markDirty(); renderThumbs(); render(); }
        else undoStack.pop();
    }

    function bindOnce() {
        if (canvas) return;
        canvas = document.getElementById('wb-canvas');
        if (!canvas) return;
        ctx = canvas.getContext('2d');
        host = document.getElementById('wb-canvas-host');
        thumbsEl = document.getElementById('wb-pages-list');
        layersEl = document.getElementById('wb-layers-list');
        statusEl = document.getElementById('wb-status');
        textEditor = document.getElementById('wb-text-editor');
        imageInput = document.getElementById('wb-image-input');

        // toolbar
        document.querySelectorAll('.wb-tool').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.wb-tool').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                tool = btn.dataset.tool;
                host.classList.remove('tool-hand', 'tool-text', 'tool-lasso');
                if (tool === 'hand') host.classList.add('tool-hand');
                if (tool === 'text') host.classList.add('tool-text');
                if (tool === 'lasso') host.classList.add('tool-lasso');
            };
        });
        document.querySelectorAll('.wb-swatch').forEach(sw => {
            sw.onclick = () => {
                if (!sw.dataset.color) return; // color picker label handled separately
                document.querySelectorAll('.wb-swatch').forEach(b => b.classList.remove('active'));
                sw.classList.add('active');
                color = sw.dataset.color;
                applyToSelection({ color });
            };
        });
        document.getElementById('wb-size').oninput = (e) => { size = parseInt(e.target.value, 10) || 3; applyToSelection({ size }); };
        const picker = document.getElementById('wb-color-picker');
        if (picker) picker.oninput = (e) => {
            color = e.target.value;
            document.querySelectorAll('.wb-swatch').forEach(b => b.classList.remove('active'));
            picker.parentElement.classList.add('active');
            applyToSelection({ color });
        };
        document.getElementById('wb-undo').onclick = doUndo;
        document.getElementById('wb-redo').onclick = doRedo;
        document.getElementById('wb-clear').onclick = clearPage;
        document.getElementById('wb-fit').onclick = () => { view = { x: 0, y: 0, scale: 1 }; render(); };
        document.getElementById('wb-add-page').onclick = addPage;
        document.getElementById('wb-add-layer').onclick = addLayer;
        document.getElementById('wb-toggle-layers').onclick = () => {
            showLayersPanel = !showLayersPanel;
            document.getElementById('wb-layers').style.display = showLayersPanel ? 'flex' : 'none';
        };
        if (imageInput) imageInput.onchange = (e) => { handleImagePick(e.target.files && e.target.files[0]); imageInput.value = ''; };

        // pointer
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointercancel', onPointerUp);
        canvas.addEventListener('wheel', (e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            const r = canvas.getBoundingClientRect();
            const cx = e.clientX - r.left, cy = e.clientY - r.top;
            const wx = (cx - view.x) / view.scale, wy = (cy - view.y) / view.scale;
            view.scale = Math.max(0.2, Math.min(4, view.scale * factor));
            view.x = cx - wx * view.scale; view.y = cy - wy * view.scale;
            scheduleRender();
        }, { passive: false });

        // keyboard
        document.addEventListener('keydown', (e) => {
            if (!isWhiteboardActive()) return;
            if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
            if (e.target === textEditor) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (selection.length) {
                    pushUndo();
                    const l = currentLayer();
                    l.elements = l.elements.filter(el => !selection.includes(el.id));
                    selection = []; markDirty(); renderThumbs(); render();
                    e.preventDefault();
                }
                return;
            }
            const map = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', r: 'rect', a: 'arrow', t: 'text' };
            const t = map[e.key.toLowerCase()];
            if (t) { const btn = document.querySelector(`.wb-tool[data-tool="${t}"]`); if (btn) btn.click(); }
            if (e.code === 'Space') { panSpaceHeld = true; host.classList.add('tool-hand'); }
        });
        document.addEventListener('keyup', (e) => {
            if (e.code === 'Space') { panSpaceHeld = false; if (tool !== 'hand') host.classList.remove('tool-hand'); }
        });

        // resize
        const ro = new ResizeObserver(() => resizeCanvas());
        ro.observe(host);
    }

    function isWhiteboardActive() {
        const v = document.getElementById('whiteboard-view');
        return v && v.classList.contains('active');
    }

    // Public: called when user opens the whiteboard tab
    window.whiteboardActivate = function () {
        bindOnce();
        const doc = activeDoc();
        if (!doc) return;
        if (currentDocId !== doc.id) {
            currentDocId = doc.id;
            undoStack = []; redoStack = []; selection = [];
            activeLayerId = null;
        }
        ensureModel(doc);
        resizeCanvas();
        renderThumbs();
        renderLayers();
        render();
        setStatus('Saved');
    };

    // Refresh if doc changes while tab open
    const origSwitch = window.switchDocument;
    if (typeof origSwitch === 'function') {
        window.switchDocument = function (id) {
            currentDocId = null;
            undoStack = []; redoStack = []; selection = [];
            const r = origSwitch.apply(this, arguments);
            if (isWhiteboardActive()) window.whiteboardActivate();
            return r;
        };
    }
})();
