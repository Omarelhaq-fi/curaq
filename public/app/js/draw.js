// Tablet Drawing & Annotation Logic (with per-chunk persistence)

let currentDrawMode = null; // 'pen', 'highlight', or null
let isDrawing = false;
let lastX = 0;
let lastY = 0;
let strokeDirty = false;
let saveTimer = null;

function getActiveSection() {
    try {
        const doc = (typeof getActiveDoc === 'function') ? getActiveDoc() : null;
        if (!doc || !window.currentSummaryTopic) return null;
        return (doc.sections || []).find(s => s.title === window.currentSummaryTopic) || null;
    } catch (e) { return null; }
}

function persistAnnotation() {
    const canvas = document.getElementById('drawing-canvas');
    const sec = getActiveSection();
    if (!canvas || !sec) return;
    try {
        // Skip if canvas is empty
        const blank = document.createElement('canvas');
        blank.width = canvas.width; blank.height = canvas.height;
        const isEmpty = canvas.toDataURL() === blank.toDataURL();
        if (isEmpty) {
            if (sec.annotation) {
                delete sec.annotation;
                if (typeof saveDb === 'function') saveDb();
            }
            return;
        }
        sec.annotation = {
            png: canvas.toDataURL('image/png'),
            w: canvas.width,
            h: canvas.height,
        };
        if (typeof saveDb === 'function') saveDb();
    } catch (e) { /* ignore */ }
}

function scheduleSave() {
    strokeDirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { strokeDirty = false; persistAnnotation(); }, 600);
}

function loadAnnotationForCurrent() {
    const canvas = document.getElementById('drawing-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sec = getActiveSection();
    if (!sec || !sec.annotation || !sec.annotation.png) return;
    const img = new Image();
    img.onload = () => {
        // Draw scaled to current canvas size (preserves rough position on resize)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = sec.annotation.png;
}
window.loadAnnotationForCurrent = loadAnnotationForCurrent;

window.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('drawing-canvas');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    
    function resizeCanvas() {
        const pane = document.getElementById('left-pane');
        if (pane && canvas) {
            // Preserve existing drawing across resizes
            const prev = canvas.toDataURL();
            const hadContent = canvas.width > 0 && canvas.height > 0;
            canvas.width = pane.clientWidth;
            canvas.height = pane.clientHeight;
            if (hadContent) {
                const img = new Image();
                img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                img.src = prev;
            } else {
                loadAnnotationForCurrent();
            }
        }
    }
    
    window.addEventListener('resize', resizeCanvas);
    setTimeout(() => { resizeCanvas(); loadAnnotationForCurrent(); }, 500);

    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseout', stopDrawing);

    canvas.addEventListener('touchstart', startDrawing, { passive: false });
    canvas.addEventListener('touchmove', draw, { passive: false });
    canvas.addEventListener('touchend', stopDrawing);
    canvas.addEventListener('touchcancel', stopDrawing);
    
    function startDrawing(e) {
        if (!currentDrawMode) return;
        isDrawing = true;
        const pos = getPos(e);
        lastX = pos.x;
        lastY = pos.y;
        if (e.type === 'touchstart') e.preventDefault();
    }
    
    function draw(e) {
        if (!isDrawing || !currentDrawMode) return;
        const pos = getPos(e);
        const currentX = pos.x;
        const currentY = pos.y;
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(currentX, currentY);
        if (currentDrawMode === 'pen') {
            ctx.strokeStyle = '#f43f5e';
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalCompositeOperation = 'source-over';
        } else if (currentDrawMode === 'highlight') {
            ctx.strokeStyle = 'rgba(250, 204, 21, 0.4)';
            ctx.lineWidth = 20;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalCompositeOperation = 'multiply';
        }
        ctx.stroke();
        lastX = currentX;
        lastY = currentY;
        strokeDirty = true;
        if (e.type === 'touchmove') e.preventDefault();
    }
    
    function stopDrawing() {
        if (isDrawing && strokeDirty) scheduleSave();
        isDrawing = false;
    }
    
    function getPos(e) {
        const rect = canvas.getBoundingClientRect();
        let clientX = e.clientX;
        let clientY = e.clientY;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        }
        return { x: clientX - rect.left, y: clientY - rect.top };
    }
});

window.toggleDrawingMode = function(mode) {
    const canvas = document.getElementById('drawing-canvas');
    const penBtn = document.getElementById('tool-pen');
    const highlightBtn = document.getElementById('tool-highlight');
    penBtn.classList.remove('active');
    highlightBtn.classList.remove('active');
    if (currentDrawMode === mode) {
        currentDrawMode = null;
        canvas.style.pointerEvents = 'none';
    } else {
        currentDrawMode = mode;
        canvas.style.pointerEvents = 'auto';
        if (mode === 'pen') penBtn.classList.add('active');
        if (mode === 'highlight') highlightBtn.classList.add('active');
    }
};

window.clearCanvas = function() {
    const canvas = document.getElementById('drawing-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const sec = getActiveSection();
        if (sec && sec.annotation) {
            delete sec.annotation;
            if (typeof saveDb === 'function') saveDb();
        }
    }
};
