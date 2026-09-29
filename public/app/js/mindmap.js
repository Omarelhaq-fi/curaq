// Mind Map — AI-generated concept graph per document.
// Uses vis-network (already loaded in index.html).
(function () {
    let network = null;
    let currentDocId = null;

    function fs() { return (typeof fsdb !== 'undefined') ? fsdb : (window.fsdb || null); }
    function uid() { try { return firebase.auth().currentUser?.uid; } catch { return null; } }

    function activeDoc() {
        return window.getActiveDoc ? window.getActiveDoc() : null;
    }

    function persistDoc() {
        if (window.firebase && firebase.auth().currentUser && window.syncDbToCloud && window.db) {
            window.syncDbToCloud(window.db);
        }
    }

    function ensureContainer() {
        const view = document.getElementById('mindmap-view');
        if (!view) return null;
        let net = document.getElementById('mindmap-network');
        if (!net) {
            view.innerHTML = `
                <div class="mm-toolbar">
                    <div class="mm-title"><i data-lucide="map"></i> Mind Map</div>
                    <div class="mm-actions">
                        <button class="btn-action" id="mm-generate-btn" onclick="window.generateMindMap()"><i data-lucide="sparkles"></i> Generate from Document</button>
                        <button class="btn-action" onclick="window.mindMapAddNode()"><i data-lucide="plus"></i> Add Node</button>
                        <button class="btn-action" onclick="window.mindMapFit()"><i data-lucide="maximize"></i> Fit</button>
                        <button class="btn-action" onclick="window.mindMapExportPng()"><i data-lucide="download"></i> PNG</button>
                    </div>
                </div>
                <div id="mindmap-empty" class="mm-empty">
                    <i data-lucide="map" style="width:56px; height:56px; color:var(--text-muted);"></i>
                    <h3>No mind map yet</h3>
                    <p style="color:var(--text-muted); max-width:420px; text-align:center;">
                        Generate an AI-powered concept graph from this document's chunks, or start adding your own nodes.
                    </p>
                </div>
                <div id="mindmap-network" style="width:100%; height:100%; display:none;"></div>
                <div id="mindmap-form" class="mm-note-panel" style="display:none; left:20px; right:auto; top:70px; width:320px;">
                    <div class="mm-note-head">
                        <strong id="mm-form-title">Add node</strong>
                        <button class="btn-icon" onclick="window.mindMapCloseForm()"><i data-lucide="x"></i></button>
                    </div>
                    <div style="display:flex; flex-direction:column; gap:8px; margin-top:10px;">
                        <label style="font-size:0.75rem; color:var(--text-muted);">Label</label>
                        <input id="mm-form-label" type="text" placeholder="Node label" style="padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--bg-input, transparent); color:var(--text-primary); font-size:0.9rem;" />
                        <label style="font-size:0.75rem; color:var(--text-muted);">Note (optional)</label>
                        <textarea id="mm-form-note" rows="3" placeholder="Short note…" style="padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--bg-input, transparent); color:var(--text-primary); font-size:0.85rem; resize:vertical;"></textarea>
                        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:6px;">
                            <button class="btn-action" onclick="window.mindMapCloseForm()">Cancel</button>
                            <button class="btn-action" id="mm-form-save" onclick="window.mindMapSaveForm()" style="background:linear-gradient(135deg,#8b5cf6,#6366f1); color:#fff; border-color:transparent;">Save</button>
                        </div>
                    </div>
                </div>
                <div id="mindmap-note" class="mm-note-panel" style="display:none;">
                    <div class="mm-note-head">
                        <strong id="mm-note-label">Node</strong>
                        <button class="btn-icon" onclick="window.mindMapCloseNote()"><i data-lucide="x"></i></button>
                    </div>
                    <div id="mm-note-body" style="color:var(--text-secondary); font-size:0.9rem; line-height:1.5; margin:8px 0 12px;"></div>
                    <div id="mm-note-source" style="font-size:0.75rem; color:var(--text-dim); font-style:italic;"></div>
                    <div style="display:flex; gap:8px; margin-top:12px;">
                        <button class="btn-action" onclick="window.mindMapEditNode()"><i data-lucide="pencil"></i> Edit</button>
                        <button class="btn-action" onclick="window.mindMapDeleteNode()" style="background:rgba(244,63,94,0.15); border-color:rgba(244,63,94,0.4);"><i data-lucide="trash-2"></i></button>
                    </div>
                </div>
            `;
            if (window.lucide) window.lucide.createIcons();
            net = document.getElementById('mindmap-network');
        }
        return net;
    }

    function buildNetwork(graph) {
        const container = ensureContainer();
        if (!container) return;
        if (network) { try { network.destroy(); } catch {} network = null; }

        const isLight = document.body.classList.contains('app-light-mode');
        const nodes = new vis.DataSet((graph.nodes || []).map(n => ({
            id: n.id,
            label: n.label || '?',
            title: n.note || '',
            shape: n.type === 'root' ? 'ellipse' : n.type === 'section' ? 'box' : 'dot',
            color: n.type === 'root'
                ? { background: '#8b5cf6', border: '#a78bfa', highlight: { background: '#7c3aed', border: '#c4b5fd' } }
                : n.type === 'section'
                    ? { background: '#0ea5e9', border: '#38bdf8', highlight: { background: '#0284c7', border: '#7dd3fc' } }
                    : { background: isLight ? '#e0f2fe' : '#1e293b', border: '#22d3ee', highlight: { background: '#0891b2', border: '#67e8f9' } },
            font: { color: n.type === 'concept' ? (isLight ? '#0f172a' : '#e2e8f0') : '#ffffff', size: n.type === 'root' ? 20 : n.type === 'section' ? 16 : 13, face: 'Inter, system-ui' },
            size: n.type === 'root' ? 28 : n.type === 'section' ? 22 : 14,
            widthConstraint: n.type === 'root' ? 220 : n.type === 'section' ? 180 : 140,
        })));
        const edges = new vis.DataSet((graph.edges || []).map(e => ({
            from: e.from, to: e.to,
            color: { color: isLight ? '#94a3b8' : '#475569', opacity: 0.7 },
            width: 1.4,
            smooth: { type: 'cubicBezier', roundness: 0.4 },
        })));

        const options = {
            physics: {
                enabled: true,
                solver: 'forceAtlas2Based',
                forceAtlas2Based: { gravitationalConstant: -60, centralGravity: 0.008, springLength: 130, springConstant: 0.08 },
                stabilization: { iterations: 200 },
            },
            interaction: { hover: true, tooltipDelay: 200, zoomView: true, dragView: true },
            layout: { improvedLayout: true },
            nodes: { borderWidth: 2, shadow: true },
        };

        network = new vis.Network(container, { nodes, edges }, options);
        network.on('click', (params) => {
            if (params.nodes && params.nodes.length) openNoteFor(params.nodes[0]);
            else closeNote();
        });
        network.on('doubleClick', (params) => {
            if (params.nodes && params.nodes.length) {
                const nid = params.nodes[0];
                const n = (graph.nodes || []).find(x => x.id === nid);
                if (n && n.sectionId != null && window.switchToSection) {
                    window.switchToSection(parseInt(n.sectionId, 10));
                }
            }
        });
        window._mmDataset = { nodes, edges };

        document.getElementById('mindmap-empty').style.display = 'none';
        container.style.display = 'block';
    }

    function openNoteFor(nodeId) {
        const doc = activeDoc();
        if (!doc?.mindmap) return;
        const n = (doc.mindmap.nodes || []).find(x => x.id === nodeId);
        if (!n) return;
        window._mmSelected = nodeId;
        document.getElementById('mm-note-label').textContent = n.label || '';
        document.getElementById('mm-note-body').textContent = n.note || '(no notes)';
        document.getElementById('mm-note-source').textContent = n.source ? `“${n.source}”` : '';
        document.getElementById('mindmap-note').style.display = 'block';
    }
    function closeNote() {
        window._mmSelected = null;
        const p = document.getElementById('mindmap-note');
        if (p) p.style.display = 'none';
    }
    window.mindMapCloseNote = closeNote;

    function openForm(mode) {
        const form = document.getElementById('mindmap-form');
        if (!form) return;
        const doc = activeDoc();
        const labelInput = document.getElementById('mm-form-label');
        const noteInput = document.getElementById('mm-form-note');
        const title = document.getElementById('mm-form-title');
        window._mmFormMode = mode;
        if (mode === 'edit' && doc?.mindmap && window._mmSelected) {
            const n = doc.mindmap.nodes.find(x => x.id === window._mmSelected);
            if (!n) return;
            title.textContent = 'Edit node';
            labelInput.value = n.label || '';
            noteInput.value = n.note || '';
        } else {
            title.textContent = window._mmSelected ? 'Add child node' : 'Add node';
            labelInput.value = '';
            noteInput.value = '';
        }
        form.style.display = 'block';
        setTimeout(() => labelInput.focus(), 50);
    }
    window.mindMapCloseForm = function () {
        const form = document.getElementById('mindmap-form');
        if (form) form.style.display = 'none';
    };
    window.mindMapSaveForm = function () {
        const doc = activeDoc();
        if (!doc) return;
        const label = (document.getElementById('mm-form-label').value || '').trim();
        const note = (document.getElementById('mm-form-note').value || '').trim();
        if (!label) return;
        if (!doc.mindmap) doc.mindmap = { nodes: [], edges: [] };
        if (window._mmFormMode === 'edit' && window._mmSelected) {
            const n = doc.mindmap.nodes.find(x => x.id === window._mmSelected);
            if (n) { n.label = label; n.note = note; }
        } else {
            const userAdded = (doc.mindmap.nodes || []).filter(n => n.id && n.id.startsWith('u')).length;
            const cap = (window.FREE_LIMITS && window.FREE_LIMITS.mindmapUserNodes) || 5;
            if (window.gateFreeLimit && !window.gateFreeLimit({
                current: userAdded, limit: cap,
                label: 'Unlimited mind-map nodes',
                subtitle: `Free plan is limited to ${cap} custom nodes per mind map. Upgrade for unlimited nodes.`,
            })) return;
            const id = 'u' + crypto.randomUUID().replace(/-/g,'').slice(0,6);
            doc.mindmap.nodes.push({ id, label, type: 'concept', parent: null, note, sectionId: null });
            if (window._mmSelected) doc.mindmap.edges.push({ from: window._mmSelected, to: id });
        }
        persistDoc();
        window.mindMapCloseForm();
        buildNetwork(doc.mindmap);
    };
    window.mindMapAddNode = function () {
        const doc = activeDoc();
        if (!doc) return alert('Open a document first');
        openForm('add');
    };
    window.mindMapEditNode = function () {
        if (!window._mmSelected) return;
        openForm('edit');
    };
    window.mindMapDeleteNode = function () {
        const doc = activeDoc();
        if (!doc?.mindmap || !window._mmSelected) return;
        if (!confirm('Delete this node and its links?')) return;
        const id = window._mmSelected;
        doc.mindmap.nodes = doc.mindmap.nodes.filter(x => x.id !== id);
        doc.mindmap.edges = (doc.mindmap.edges || []).filter(e => e.from !== id && e.to !== id);
        persistDoc();
        closeNote();
        buildNetwork(doc.mindmap);
    };
    window.mindMapFit = function () { if (network) network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } }); };
    window.mindMapExportPng = function () {
        if (!network) return;
        const canvas = document.querySelector('#mindmap-network canvas');
        if (!canvas) return;
        const link = document.createElement('a');
        link.download = `mindmap-${(activeDoc()?.title || 'doc').replace(/\s+/g, '-')}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
    };

    window.generateMindMap = async function () {
        const doc = activeDoc();
        if (!doc) return alert('Open a document first');
        if (!doc.sections || doc.sections.length === 0) {
            return alert('This document has no sections yet — upload a PDF to build the study plan first.');
        }
        if (window.gatePaidOnly && !window.gatePaidOnly('AI mind-map generation',
            'Auto-generating a mind map from your document is a Pro feature. Free users can still build mind maps manually (up to 5 nodes).')) return;
        const btn = document.getElementById('mm-generate-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle" class="lucide-spin"></i> Generating…'; if (window.lucide) window.lucide.createIcons(); }
        try {
            const sectionsList = doc.sections.map((s, i) => `${i} | ${s.title}`).join('\n');
            const docText = (doc.pdfContextText || doc.sections.map(s => `## ${s.title}\n${s.chunkText || ''}`).join('\n\n')).slice(0, 120000);
            const res = await window.aiTask('mindmap_from_doc', {
                docTitle: doc.title || 'Untitled',
                sectionsList,
                docText,
            }, { temperature: 0.4 });
            if (typeof res !== 'string') throw new Error(res?._error || 'AI error');
            let json;
            try { json = JSON.parse(res); }
            catch {
                const m = res.match(/\{[\s\S]*\}/);
                if (!m) throw new Error('Could not parse mind map JSON');
                json = JSON.parse(m[0]);
            }
            if (!json.nodes || !json.edges) throw new Error('Bad mind-map shape');
            doc.mindmap = json;
            persistDoc();
            buildNetwork(json);
        } catch (e) {
            alert('Failed to generate mind map: ' + (e.message || e));
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="sparkles"></i> Regenerate'; if (window.lucide) window.lucide.createIcons(); }
        }
    };

    window.renderMindMap = function () {
        ensureContainer();
        currentDocId = activeDoc()?.id || null;
        const doc = activeDoc();
        if (doc?.mindmap?.nodes?.length) {
            buildNetwork(doc.mindmap);
            const btn = document.getElementById('mm-generate-btn');
            if (btn) { btn.innerHTML = '<i data-lucide="sparkles"></i> Regenerate'; if (window.lucide) window.lucide.createIcons(); }
        } else {
            const netEl = document.getElementById('mindmap-network');
            const empty = document.getElementById('mindmap-empty');
            if (netEl) netEl.style.display = 'none';
            if (empty) empty.style.display = 'flex';
        }
    };
})();
