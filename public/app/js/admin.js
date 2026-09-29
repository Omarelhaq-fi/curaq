// Admin panel — server-verified via /api/admin whoami.
// All privileged reads/writes go through /api/admin. This client file has
// NO hardcoded admin email and cannot open the UI without server confirmation.

(function () {
  let isAdminCache = false;
  let whoamiChecked = false;
  let whoamiPromise = null; // in-flight dedupe: concurrent boot callers share one request

  function authToken() {
    const u = window.firebase && firebase.auth && firebase.auth().currentUser;
    // Force refresh so a freshly-verified email is reflected in email_verified claim.
    return u ? u.getIdToken(true) : Promise.reject(new Error("Not signed in"));
  }

  async function api(path, opts = {}) {
    const token = await authToken();
    const headers = Object.assign(
      { "Content-Type": "application/json", Authorization: "Bearer " + token },
      opts.headers || {},
    );
    const r = await fetch(path, Object.assign({}, opts, { headers }));
    let data = null;
    try { data = await r.json(); } catch { /* ignore */ }
    if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
    return data;
  }
  window.checkAdmin = async function(force) {
    if (whoamiChecked && !force) return isAdminCache;
    if (!force && whoamiPromise) return whoamiPromise;
    // NOTE: do NOT trust sessionStorage here — a previous server-side bypass
    // poisoned cached '1' values for non-admins. Always verify with the server.
    // Clear any legacy cached value so stale admin flags disappear on next load.
    try { sessionStorage.removeItem('exora_is_admin'); } catch (_) {}
    whoamiPromise = (async () => {
      try {
        const res = await api("/api/admin?action=whoami", { method: "GET" });
        isAdminCache = !!res.admin;
        whoamiChecked = true;
        window.isAdminCache = isAdminCache;
        window.isQBankAdmin = isAdminCache;
        return isAdminCache;
      } catch (e) {
        return false;
      } finally {
        whoamiPromise = null;
      }
  window.adminLibraryBackfill = async function (btn) {
    if (!window.__adminLibraryBank) return;
    if (!confirm("Scan every question once to seed the concepts digest? After this, exports cost 1 read.")) return;
    const orig = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.textContent = "Backfilling…"; }
    try {
      const res = await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "backfill_concepts_digest", qbankId: window.__adminLibraryBank }),
      });
      alert(`Digest seeded: ${res.withConcepts} concepts from ${res.total} questions. Exports are now 1 read.`);
    } catch (e) {
      alert("Backfill failed: " + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    }
  };

})();
    return whoamiPromise;
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmt(n) { return Number(n || 0).toLocaleString(); }

  window.showAdminButton = async function () {
    const btn = document.getElementById("admin-panel-btn");
    if (!btn) return;
    const ok = await window.checkAdmin(false);
    btn.style.display = ok ? "flex" : "none";
  };

  window.openAdminPanel = async function () {
    const ok = await window.checkAdmin();
    if (!ok) { alert("Admin only."); return; }
    const m = document.getElementById("admin-modal");
    if (m) m.style.display = "flex";
    window.switchAdminTab("keys");
  };

  window.closeAdminPanel = function () {
    const m = document.getElementById("admin-modal");
    if (m) m.style.display = "none";
  };

  window.toggleAdminMaximize = function() {
    const el = document.getElementById("admin-modal-content");
    if (el.style.maxWidth === "100vw") {
      el.style.maxWidth = "900px";
      el.style.height = "90vh";
      el.style.borderRadius = "16px";
    } else {
      el.style.maxWidth = "100vw";
      el.style.height = "100vh";
      el.style.borderRadius = "0";
    }
  };

  window.switchAdminTab = function (tab) {
    document.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
    const activeTab = document.querySelector(`.admin-tab[data-tab="${tab}"]`);
    if (activeTab) activeTab.classList.add("active");
    document.querySelectorAll(".admin-tab-panel").forEach((p) => (p.style.display = "none"));
    const panel = document.getElementById(`admin-panel-${tab}`);
    if (panel) panel.style.display = "block";
    if (tab === "keys") loadAdminProviders();
    if (tab === "capacity") loadAdminCapacity();
    if (tab === "functions") loadAdminFunctions();

    if (tab === "maintenance") loadAdminMaintenance();
    if (tab === "users") loadAdminUsers();
    if (tab === "notifications") loadAdminNotifications();
    if (tab === "stats") loadAdminStats();
    if (tab === "qbank") loadAdminQBank();
    if (tab === "library") loadAdminLibrary();
    if (tab === "feedback") loadAdminFeedback();
    if (tab === "reports") loadAdminReports();
    if (tab === "support") loadAdminSupport();
    if (tab === "peerstats") loadAdminPeerStats();
    if (tab === "access" && typeof window.loadAccessRequests === "function") loadAccessRequests();
    if (window.lucide && window.lucide.createIcons) { try { window.lucide.createIcons(); } catch (_) {} }
  };

  // ---------- AI PROVIDERS ----------
  // Full-pool editor: enable/disable, priority, per-key add/remove and test.
  // Draft edits are held in memory until "Save changes" fires one set_ai_providers POST.
  let providersState = null;      // { providers, meta, defaults }
  let providersDraft = null;      // partial patch keyed by providerId
  // Roles have been removed, model ordering is purely handled in AI Functions tab.

  async function loadAdminProviders() {
    const box = document.getElementById("admin-keys-content");
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Loading providers…</div>';
    try {
      providersState = await api("/api/admin?action=get_ai_providers", { method: "GET" });
      providersDraft = providersDraft || {};
      renderProvidersEditor(box);
    } catch (e) {
      box.innerHTML = `<div style="color:#f43;padding:20px;">${escapeHtml(e.message)}</div>`;
    }
  }

  function providerEffective(id) {
    const base = providersState.providers[id];
    const patch = providersDraft[id] || {};
    return {
      enabled: patch.enabled !== undefined ? patch.enabled : base.enabled,
      priority: patch.priority !== undefined ? patch.priority : base.priority,
      // keys entries are { masked, hash?, raw? } — masked is always shown, hash/raw let save preserve or add.
      keys: patch.keys ? patch.keys.slice() : (base.keys || []).map(k => ({ masked: k.masked, hash: k.hash })),
    };
  }

  function renderProvidersEditor(box) {
    const meta = providersState.meta;
    const ids = Object.keys(providersState.providers).sort((a, b) => providerEffective(a).priority - providerEffective(b).priority);
    const cards = ids.map((id) => {
      const eff = providerEffective(id);
      const m = meta[id] || { label: id, defaultRpd: 0, defaultRpm: 0 };
      const keyRows = (eff.keys || []).map((k, i) => `
        <div style="display:flex;gap:8px;align-items:center;background:rgba(255,255,255,0.03);padding:8px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;flex-direction:column;gap:2px;">
            <button onclick="window.moveAdminProviderKey('${id}',${i},-1)" title="Move Up" style="background:transparent;border:none;padding:0;color:var(--text-muted);cursor:pointer;font-size:0.65rem;line-height:1;margin-bottom:-2px;">▲</button>
            <button onclick="window.moveAdminProviderKey('${id}',${i},1)" title="Move Down" style="background:transparent;border:none;padding:0;color:var(--text-muted);cursor:pointer;font-size:0.65rem;line-height:1;margin-top:-2px;">▼</button>
          </div>
          <code style="flex:1;font-size:0.78rem;color:var(--text-secondary);">${escapeHtml(k.masked || "•••")}</code>
          <span id="admin-keytest-${id}-${i}" style="font-size:0.7rem;color:var(--text-muted);"></span>
          <button class="btn-dark-pill" style="padding:4px 10px;font-size:0.72rem;" onclick="window.testAdminKey('${id}',${i})">Test</button>
          <button class="btn-dark-pill" style="padding:4px 10px;font-size:0.72rem;color:#f43;" onclick="window.removeAdminProviderKey('${id}',${i})">Remove</button>
        </div>`).join("") || `<div style="color:var(--text-muted);font-size:0.82rem;padding:8px 0;">No keys — add one below.</div>`;
      return `
        <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:16px;margin-bottom:14px;">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
            <div style="display:flex;flex-direction:column;gap:2px;border-right:1px solid rgba(255,255,255,0.1);padding-right:12px;">
               <button onclick="window.moveAdminProvider('${id}', -1)" title="Move Provider Up" style="background:transparent;border:none;color:var(--text-secondary);cursor:pointer;font-size:0.85rem;">▲</button>
               <button onclick="window.moveAdminProvider('${id}', 1)" title="Move Provider Down" style="background:transparent;border:none;color:var(--text-secondary);cursor:pointer;font-size:0.85rem;">▼</button>
            </div>
            <div style="flex:1;min-width:200px;">
              <div style="font-weight:700;color:var(--text-primary);font-size:1rem;">${escapeHtml(m.label)}</div>
              <div style="font-size:0.72rem;color:var(--text-muted);">Free tier ≈ ${m.defaultRpd} req/day · ${m.defaultRpm} req/min · ${eff.keys.length} key${eff.keys.length===1?"":"s"}</div>
            </div>
            <label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;color:var(--text-secondary);">
              Priority <input type="number" min="1" max="100" value="${eff.priority}" onchange="window.updateAdminProviderPriority('${id}',this.value)" style="width:50px;padding:4px 6px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:var(--text-primary);font-size:0.75rem;text-align:center;" title="Lower number = tried first">
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.8rem;color:var(--text-secondary);">
              <input type="checkbox" ${eff.enabled ? "checked" : ""} onchange="window.updateAdminProviderEnabled('${id}',this.checked)"> Enabled
            </label>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">${keyRows}</div>
          <div style="display:flex;gap:8px;">
            <input id="admin-newkey-${id}" placeholder="Paste new ${escapeHtml(m.label)} key" style="flex:1;padding:9px 12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:var(--text-primary);font-family:monospace;font-size:0.82rem;">
            <button class="btn-action primary" style="padding:9px 16px;" onclick="window.addAdminProviderKey('${id}')">+ Add</button>
          </div>
        </div>`;
    }).join("");
    box.innerHTML = `
      <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:20px;line-height:1.5;">
        Providers are tried in priority order (lower = tried first). Changes are held as a draft — click <b>Save changes</b> to publish. Existing keys are masked; saving with a masked entry drops it from the pool.
      </div>
      ${cards}
      <div style="display:flex;gap:10px;position:sticky;bottom:0;background:linear-gradient(180deg,transparent,var(--bg-primary) 40%);padding:14px 0 4px;">
        <button class="btn-action primary" style="padding:11px 22px;" onclick="window.saveAdminProviders()">Save changes</button>
        <button class="btn-dark-pill" style="padding:11px 18px;" onclick="window.discardAdminProviders()">Discard</button>
      </div>`;
    if (window.lucide && window.lucide.createIcons) { try { window.lucide.createIcons(); } catch (_) {} }
  }

  window.updateAdminProviderEnabled = (id, on) => {
    providersDraft[id] = providersDraft[id] || {};
    providersDraft[id].enabled = !!on;
  };
  window.updateAdminProviderPriority = (id, v) => {
    providersDraft[id] = providersDraft[id] || {};
    providersDraft[id].priority = Math.max(1, Math.min(100, parseInt(v, 10) || 50));
  };
  function draftKeysFor(id) {
    if (providersDraft[id] && Array.isArray(providersDraft[id].keys)) return providersDraft[id].keys;
    // Seed draft from persisted (hash-referenced) entries so save preserves them.
    const arr = (providersState.providers[id].keys || []).map(k => ({ masked: k.masked, hash: k.hash }));
    providersDraft[id] = providersDraft[id] || {};
    providersDraft[id].keys = arr;
    return arr;
  }
  window.addAdminProviderKey = async (id) => {
    const input = document.getElementById("admin-newkey-" + id);
    if (!input) return;
    const k = input.value.trim();
    if (!k || k.length < 10) return alert("Key looks too short.");
    const keys = draftKeysFor(id);
    // Store both raw (for save) and masked (for display + Test button).
    const masked = k.length > 10 ? k.slice(0, 4) + "…" + k.slice(-4) : "•••";
    keys.push({ raw: k, masked });
    input.value = "";
    renderProvidersEditor(document.getElementById("admin-keys-content"));
    // Auto-save so a page refresh doesn't lose the new key.
    try { await window.saveAdminProviders({ silent: true }); } catch (_) {}
  };
  window.removeAdminProviderKey = (id, i) => {
    if (!confirm("Remove this key from the pool?")) return;
    const keys = draftKeysFor(id);
    keys.splice(i, 1);
    renderProvidersEditor(document.getElementById("admin-keys-content"));
  };
  window.moveAdminProviderKey = (id, index, dir) => {
    const keys = draftKeysFor(id);
    const targetIdx = index + dir;
    if (targetIdx < 0 || targetIdx >= keys.length) return;
    const temp = keys[index];
    keys[index] = keys[targetIdx];
    keys[targetIdx] = temp;
    renderProvidersEditor(document.getElementById("admin-keys-content"));
  };
  window.moveAdminProvider = (id, dir) => {
    const ids = Object.keys(providersState.providers).sort((a, b) => providerEffective(a).priority - providerEffective(b).priority);
    const idx = ids.indexOf(id);
    if (idx === -1) return;
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= ids.length) return;
    
    const currentId = ids[idx];
    const targetId = ids[targetIdx];
    
    providersDraft[currentId] = providersDraft[currentId] || {};
    providersDraft[targetId] = providersDraft[targetId] || {};
    
    let pCur = providerEffective(currentId).priority;
    let pTarg = providerEffective(targetId).priority;
    
    if (pCur === pTarg) {
      pCur = dir < 0 ? pCur - 1 : pCur + 1;
    }
    
    providersDraft[currentId].priority = pTarg;
    providersDraft[targetId].priority = pCur;
    
    renderProvidersEditor(document.getElementById("admin-keys-content"));
  };
  window.testAdminKey = async (id, i) => {
    const el = document.getElementById(`admin-keytest-${id}-${i}`);
    if (el) { el.textContent = "…testing"; el.style.color = "var(--text-muted)"; }
    try {
      // Prefer sending the raw draft key so freshly-added (unsaved) keys can be tested.
      const eff = providerEffective(id);
      const entry = (eff.keys || [])[i];
      const payload = { action: "test_ai_key", provider: id, keyIndex: i };
      if (entry && typeof entry.raw === "string") payload.key = entry.raw;
      const r = await api("/api/admin", { method: "POST", body: JSON.stringify(payload) });
      if (r && r.outcome === "ok") {
        if (el) { el.textContent = `✓ ${r.ms || 0}ms`; el.style.color = "#4ade80"; el.title = r.message || `HTTP ${r.status}`; }
      } else if (r && r.outcome === "rate_limited") {
        if (el) { el.textContent = `⚠ rate-limited (${r.status})`; el.style.color = "#f59e0b"; el.title = r.message || ""; }
      } else {
        const label = r && r.outcome === "not_found" ? "model not found" : ((r && r.outcome) || "failed");
        const status = r && r.status ? ` ${r.status}` : "";
        if (el) { el.textContent = `✗ ${label}${status}`; el.style.color = "#f43"; el.title = (r && r.message) || ""; }
      }
    } catch (e) {
      if (el) { el.textContent = "✗ " + e.message; el.style.color = "#f43"; }
    }
  };
  // (duplicate window.testAdminKey removed — the first definition above sends the raw draft key correctly.)
  window.saveAdminProviders = async (opts) => {
    const silent = !!(opts && opts.silent);
    if (!providersDraft || !Object.keys(providersDraft).length) {
      if (!silent) alert("No changes to save.");
      return;
    }
    const cleaned = {};
    for (const [id, p] of Object.entries(providersDraft)) {
      const q = { ...p };
      if (Array.isArray(q.keys)) {
        // Transform key entries: send { hash } to preserve, { raw } to add.
        q.keys = q.keys
          .map(k => {
            if (typeof k === "string") {
              return (!k.includes("…") && !k.includes("•")) ? { raw: k } : null;
            }
            if (k && typeof k === "object") {
              if (k.raw) return { raw: k.raw };
              if (k.hash) return { hash: k.hash };
            }
            return null;
          })
          .filter(Boolean);
      }
      cleaned[id] = q;
    }
    try {
      await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "set_ai_providers", providersConfig: cleaned }) });
      providersDraft = {};
      loadAdminProviders();
    } catch (e) { if (!silent) alert("Save failed: " + e.message); else console.warn("[admin] auto-save failed:", e.message); }
  };
  window.discardAdminProviders = () => {
    providersDraft = {};
    loadAdminProviders();
  };

  // ---------- AI CAPACITY ----------
  async function loadAdminCapacity() {
    const box = document.getElementById("admin-capacity-content");
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Loading capacity…</div>';
    try {
      const snap = await api("/api/admin?action=get_ai_capacity", { method: "GET" });
      renderCapacity(box, snap);
    } catch (e) {
      box.innerHTML = `<div style="color:#f43;padding:20px;">${escapeHtml(e.message)}</div>`;
    }
  }
  function renderCapacity(box, snap) {
    const bar = (used, total) => {
      const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
      const color = pct >= 90 ? "#f43" : pct >= 70 ? "#f59e0b" : "#22c55e";
      return `<div style="background:rgba(255,255,255,0.06);border-radius:6px;height:8px;overflow:hidden;margin-top:4px;"><div style="width:${pct}%;height:100%;background:${color};transition:width .3s;"></div></div>
              <div style="font-size:0.72rem;color:var(--text-muted);margin-top:3px;">${(used||0).toLocaleString()} / ${(total||0).toLocaleString()} (${pct}%)</div>`;
    };
    const totalsCallsToday = (snap.totals && snap.totals.rpd) || 0;
    const totalsTokens = (snap.totals && snap.totals.tokens) || 0;
    const totalRpdBudget = snap.totalRpdBudget || 0;
    const budgetPct = totalRpdBudget > 0 ? Math.round((totalsCallsToday / totalRpdBudget) * 100) : 0;
    const alertColor = (lvl) => lvl === "danger" ? { bg: "rgba(244,63,94,0.12)", bd: "rgba(244,63,94,0.35)" }
      : lvl === "warn" ? { bg: "rgba(245,158,11,0.10)", bd: "rgba(245,158,11,0.30)" }
      : { bg: "rgba(59,130,246,0.10)", bd: "rgba(59,130,246,0.30)" };
    const alerts = (snap.alerts || []).map(a => {
      const c = alertColor(a.level || "info");
      return `<div style="padding:10px 12px;background:${c.bg};border:1px solid ${c.bd};border-radius:8px;margin-bottom:8px;font-size:0.85rem;color:var(--text-primary);">${escapeHtml(a.message || "")}</div>`;
    }).join("");
    const providers = (snap.perProvider || []).map(p => {
      const keys = (p.keys || []).map(k => {
        const cooling = k.coolUntil && k.coolUntil > Date.now();
        const dead = !!k.dead;
        const state = dead ? `<span style="color:#f43;">dead</span>`
          : cooling ? `<span style="color:#f59e0b;">cooling (${k.coolReason||"?"})</span>`
          : `<span style="color:#22c55e;">ready</span>`;
        return `<div style="display:flex;justify-content:space-between;gap:8px;font-size:0.75rem;padding:4px 0;border-top:1px dashed rgba(255,255,255,0.06);">
          <span style="font-family:monospace;color:var(--text-muted);">${escapeHtml(k.masked||"")}</span>
          <span>${state}</span>
          <span style="color:var(--text-muted);">${(k.rpdUsed||0).toLocaleString()}/${(k.rpdCap||0).toLocaleString()} req · ${(k.tokensUsed||0).toLocaleString()} tok · ${(k.rpm||0)} rpm</span>
        </div>`;
      }).join("");
      return `
      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:14px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:8px;">
          <div>
            <div style="font-weight:700;color:var(--text-primary);">${escapeHtml(p.label||p.id)}</div>
            <div style="font-size:0.72rem;color:var(--text-muted);">${p.keyCount||0} keys (${p.usableKeyCount||0} usable) · priority ${p.priority} · ${p.enabled?"enabled":"disabled"}</div>
          </div>
          <div style="font-size:0.85rem;color:var(--text-secondary);">${(p.usedRpd||0).toLocaleString()} / ${(p.totalRpd||0).toLocaleString()} req today</div>
        </div>
        <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:6px;">Daily request budget</div>
        ${bar(p.usedRpd||0, p.totalRpd||0)}
        ${keys ? `<div style="margin-top:8px;">${keys}</div>` : ""}
      </div>`;
    }).join("");
    box.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:18px;">
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px;">
          <div style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;">Calls today</div>
          <div style="font-size:1.6rem;font-weight:700;color:var(--text-primary);">${totalsCallsToday.toLocaleString()}</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px;">
          <div style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;">Total daily budget</div>
          <div style="font-size:1.6rem;font-weight:700;color:var(--text-primary);">${totalRpdBudget.toLocaleString()}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">${budgetPct}% used</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px;">
          <div style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;">Tokens today</div>
          <div style="font-size:1.6rem;font-weight:700;color:var(--text-primary);">${totalsTokens.toLocaleString()}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">UTC day ${escapeHtml(snap.day||"")}</div>
        </div>
      </div>
      ${alerts ? `<div style="margin-bottom:14px;">${alerts}</div>` : ""}
      ${providers || '<div style="color:var(--text-muted);padding:20px;text-align:center;">No providers configured.</div>'}
      <button class="btn-dark-pill" style="padding:8px 16px;margin-top:8px;" onclick="window.loadAdminCapacity()">Refresh</button>
    `;
  }
  window.loadAdminCapacity = loadAdminCapacity;

  // ---------- AI FUNCTIONS (per-task chain health checker) ----------
  let functionsState = null; // { tasks: [{task,label,chain,baseChain,customChain}] }
  const functionsRuns = {};  // task -> last result
  const functionsStepRuns = {}; // task -> { index -> result }
  let functionsDraft = {};   // task -> ChainStep[]

  async function loadAdminFunctions() {
    const box = document.getElementById("admin-functions-content");
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Loading AI functions…</div>';
    try {
      if (!providersState) {
        providersState = await api("/api/admin?action=get_ai_providers", { method: "GET" });
      }
      functionsState = await api("/api/admin?action=list_ai_functions", { method: "GET" });
      functionsDraft = {};
      renderFunctions(box);
    } catch (e) {
      box.innerHTML = `<div style="color:#f43;padding:20px;">${escapeHtml(e.message)}</div>`;
    }
  }

  function effectiveChainFor(t) {
    if (functionsDraft[t.task]) return functionsDraft[t.task];
    if (t.customChain && t.customChain.length > 0) return t.customChain;
    return t.baseChain || [];
  }

  function stepChip(s) {
    if (s.skipped) {
      const label = s.skipped === "no-key" ? "no key" : s.skipped;
      return `<span title="${escapeHtml(label)}" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,0.05);color:var(--text-muted);font-size:0.7rem;">⊘ ${escapeHtml(s.provider)}·${escapeHtml(s.model)}</span>`;
    }
    const ok = s.ok;
    const bg = ok ? "rgba(34,197,94,0.15)" : s.status === 429 ? "rgba(245,158,11,0.15)" : s.status >= 500 ? "rgba(249,115,22,0.15)" : "rgba(244,63,94,0.15)";
    const fg = ok ? "#4ade80" : s.status === 429 ? "#f59e0b" : s.status >= 500 ? "#fb923c" : "#f87171";
    const mark = ok ? "✓" : s.status === 429 ? "⚠" : s.status >= 500 ? "⛔" : "✗";
    const detail = ok ? `${s.ms}ms` : `${s.status || "err"}`;
    const title = s.message ? escapeHtml(s.message) : "";
    return `<span title="${title}" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:999px;background:${bg};color:${fg};font-size:0.7rem;font-family:monospace;">${mark} ${escapeHtml(s.provider)}·${escapeHtml(s.model)} <b style="opacity:0.85;">${detail}</b></span>`;
  }

  function stepIcon(s) {
    if (s.skipped) {
      const label = s.skipped === "no-key" ? "no key" : s.skipped;
      return `<span title="${escapeHtml(label)}" style="color:var(--text-muted);font-size:0.8rem;margin-left:4px;">⊘ ${escapeHtml(label)}</span>`;
    }
    const ok = s.ok;
    const fg = ok ? "#4ade80" : s.status === 429 ? "#f59e0b" : s.status >= 500 ? "#fb923c" : "#f87171";
    const mark = ok ? "✓" : s.status === 429 ? "⚠" : s.status >= 500 ? "⛔" : "✗";
    const detail = ok ? `${s.ms}ms` : `${s.status || "err"}`;
    const title = s.message ? escapeHtml(s.message) : "";
    return `<span title="${title}" style="color:${fg};font-size:0.8rem;font-family:monospace;font-weight:bold;margin-left:4px;white-space:nowrap;">${mark} <span style="font-weight:normal;opacity:0.8;font-size:0.7rem;">${detail}</span></span>`;
  }

  function renderFunctions(box) {
    box = box || document.getElementById("admin-functions-content");
    if (!box) return;
    const tasks = (functionsState && functionsState.tasks) || [];
    
    const provs = providersState ? Object.keys(providersState.providers).filter(id => providersState.providers[id].enabled) : [];
    
    const rows = tasks.map((t) => {
      const chain = effectiveChainFor(t);
      const isCustom = functionsDraft[t.task] !== undefined || (t.customChain && t.customChain.length > 0);
      
      const chainHtml = chain.map((c, i) => `
        <div style="display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.03);padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);margin-bottom:4px;">
          <div style="display:flex;flex-direction:column;gap:2px;">
            <button onclick="window.moveAdminFunctionStep('${t.task}',${i},-1)" title="Move Up" style="background:transparent;border:none;padding:0;color:var(--text-muted);cursor:pointer;font-size:0.65rem;line-height:1;margin-bottom:-2px;">▲</button>
            <button onclick="window.moveAdminFunctionStep('${t.task}',${i},1)" title="Move Down" style="background:transparent;border:none;padding:0;color:var(--text-muted);cursor:pointer;font-size:0.65rem;line-height:1;margin-top:-2px;">▼</button>
          </div>
          <select onchange="window.updateAdminFunctionStep('${t.task}',${i},'provider',this.value)" style="padding:4px 8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:0.75rem;min-width:100px;">
            ${provs.map(p => `<option value="${escapeHtml(p)}" ${c.provider === p ? "selected" : ""}>${escapeHtml(p)}</option>`).join("")}
          </select>
          <select onchange="window.updateAdminFunctionStep('${t.task}',${i},'model',this.value)" style="flex:1;padding:4px 8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:0.75rem;">
            ${(providersState && providersState.meta[c.provider]?.catalog || []).map(m => `<option value="${escapeHtml(m)}" ${c.model === m ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")}
            ${providersState && providersState.meta[c.provider]?.catalog?.includes(c.model) ? "" : `<option value="${escapeHtml(c.model)}" selected>${escapeHtml(c.model)}</option>`}
          </select>
          <button class="btn-dark-pill" style="padding:4px 10px;font-size:0.72rem;" onclick="window.checkAiFunction('${t.task}', 'test_step', ${i})">Test</button>
          ${functionsStepRuns[t.task]?.[i] ? stepIcon(functionsStepRuns[t.task][i]) : ""}
          <div style="flex:0.1;"></div>
          <button class="btn-dark-pill" style="padding:4px 10px;font-size:0.72rem;color:#f43;" onclick="window.removeAdminFunctionStep('${t.task}',${i})">Remove</button>
        </div>
      `).join("");

      const run = functionsRuns[t.task];
      let runHtml = "";
      if (run) {
         runHtml = `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;">${run.steps.map(stepChip).join("")}</div>
         <div style="margin-top:4px;font-size:0.7rem;color:var(--text-muted);">${run.firstSuccessIndex >= 0 ? `First success: step ${run.firstSuccessIndex + 1}` : "No step succeeded"} · ${run.elapsedMs}ms</div>`;
      }

      return `
        <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:12px 14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
            <div style="min-width:0;flex:1;">
              <div style="font-weight:700;color:var(--text-primary);">${escapeHtml(t.label)} <span style="font-family:monospace;color:var(--text-muted);font-size:0.7rem;font-weight:400;margin-left:6px;">${escapeHtml(t.task)}</span>
              ${isCustom ? `<span style="margin-left:8px;padding:2px 6px;background:rgba(234,179,8,0.15);color:#eab308;font-size:0.65rem;border-radius:4px;">Custom Chain</span>` : ""}
              </div>
            </div>
            <div style="display:flex;gap:6px;">
              <button class="btn-dark-pill" style="padding:6px 12px;font-size:0.75rem;" onclick="window.addAdminFunctionStep('${t.task}')">+ Add Step</button>
              <button class="btn-dark-pill" style="padding:6px 12px;font-size:0.75rem;" onclick="window.resetAdminFunctionChain('${t.task}')" title="Reset to default base chain">Reset</button>
            </div>
          </div>
          <div style="margin-bottom:8px;">${chainHtml || `<div style="font-size:0.75rem;color:var(--text-muted);">No fallback steps. Add one above.</div>`}</div>
          <div style="display:flex;gap:6px;border-top:1px solid rgba(255,255,255,0.05);padding-top:8px;">
            <button class="btn-dark-pill" style="padding:6px 12px;font-size:0.75rem;" onclick="window.checkAiFunction('${t.task}','first_success')">Run check</button>
            <button class="btn-dark-pill" style="padding:6px 12px;font-size:0.75rem;" onclick="window.checkAiFunction('${t.task}','full_chain')">Full chain</button>
          </div>
          ${runHtml}
        </div>`;
    }).join("");
    
    box.innerHTML = `
      <div style="margin-bottom:12px;padding:12px 14px;background:rgba(6,182,212,0.06);border:1px solid rgba(6,182,212,0.2);border-radius:8px;font-size:0.8rem;color:var(--text-secondary);">
        Each AI function has an ordered fallback chain across providers/models. You can completely customize the route per-task. 
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <button class="btn-action primary" style="padding:9px 16px;" onclick="window.saveAdminFunctions(event)">Save Changes</button>
        <button class="btn-dark-pill" style="padding:9px 16px;" onclick="window.checkAllAiFunctions('first_success')">Check all</button>
        <button class="btn-dark-pill" style="padding:9px 16px;" onclick="window.loadAdminFunctions()">Discard & Reload</button>
      </div>
      ${rows || '<div style="color:var(--text-muted);padding:20px;text-align:center;">No tasks.</div>'}`;
  }

  window.loadAdminFunctions = loadAdminFunctions;
  window.addAdminFunctionStep = (task) => {
    const t = functionsState.tasks.find(x => x.task === task);
    const chain = [...effectiveChainFor(t)];
    const p = providersState ? Object.keys(providersState.providers).filter(id => providersState.providers[id].enabled)[0] : "gemini";
    const m = providersState && providersState.meta[p]?.catalog?.[0] || "";
    chain.push({ provider: p, model: m });
    functionsDraft[task] = chain;
    renderFunctions();
  };
  window.removeAdminFunctionStep = (task, i) => {
    const t = functionsState.tasks.find(x => x.task === task);
    const chain = [...effectiveChainFor(t)];
    chain.splice(i, 1);
    functionsDraft[task] = chain;
    renderFunctions();
  };
  window.moveAdminFunctionStep = (task, i, dir) => {
    const t = functionsState.tasks.find(x => x.task === task);
    const chain = [...effectiveChainFor(t)];
    const tgt = i + dir;
    if (tgt < 0 || tgt >= chain.length) return;
    const temp = chain[i];
    chain[i] = chain[tgt];
    chain[tgt] = temp;
    functionsDraft[task] = chain;
    renderFunctions();
  };
  window.updateAdminFunctionStep = (task, i, field, val) => {
    const t = functionsState.tasks.find(x => x.task === task);
    const chain = [...effectiveChainFor(t)];
    chain[i][field] = val;
    if (field === 'provider' && providersState) {
        chain[i].model = providersState.meta[val]?.catalog?.[0] || "";
    }
    functionsDraft[task] = chain;
    renderFunctions();
  };
  window.resetAdminFunctionChain = (task) => {
    functionsDraft[task] = [];
    renderFunctions();
  };
  window.saveAdminFunctions = async (event) => {
    const btn = event.target;
    const oldText = btn.textContent;
    btn.textContent = "Saving...";
    btn.disabled = true;
    try {
      const chains = {};
      functionsState.tasks.forEach(t => {
        if (functionsDraft[t.task] !== undefined) {
          if (functionsDraft[t.task].length > 0) chains[t.task] = functionsDraft[t.task];
        } else if (t.customChain && t.customChain.length > 0) {
          chains[t.task] = t.customChain;
        }
      });
      await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "set_ai_custom_chains", chains }) });
      await loadAdminFunctions();
    } catch (e) {
      alert("Failed to save: " + e.message);
    } finally {
      btn.textContent = oldText;
      btn.disabled = false;
    }
  };
  window.checkAiFunction = async function (task, mode, stepIndex = undefined) {
    try {
      const r = await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "check_ai_function", task, mode, stepIndex }) });
      if (stepIndex !== undefined) {
        if (!functionsStepRuns[task]) functionsStepRuns[task] = {};
        functionsStepRuns[task][stepIndex] = r.steps[0];
      } else {
        functionsRuns[task] = r;
      }
      renderFunctions();
    } catch (e) {
      alert("Check failed: " + e.message);
    }
  };
  window.checkAllAiFunctions = async function (mode) {
    const box = document.getElementById("admin-functions-content");
    if (box) box.insertAdjacentHTML("afterbegin", '<div id="admin-fn-running" style="padding:8px 12px;background:rgba(6,182,212,0.12);border:1px solid rgba(6,182,212,0.25);border-radius:6px;margin-bottom:10px;font-size:0.8rem;color:var(--text-primary);">Running checks…</div>');
    try {
      const r = await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "check_all_ai_functions", mode }) });
      for (const res of (r.results || [])) functionsRuns[res.task] = res;
      renderFunctions(box);
    } catch (e) { alert("Check failed: " + e.message); }
  };




  // ---------- MAINTENANCE ----------
  const MAINT_GROUPS = [
    { id: "chunk_plan",  label: "Study Plan generation",     desc: "Chunking a new document into sections." },
    { id: "summary",     label: "Summaries",                 desc: "Topic summaries + Smart Explain Summary." },
    { id: "flashcards",  label: "Flashcards",                desc: "Auto-generated flashcards from text." },
    { id: "mcq",         label: "MCQs / Exams",              desc: "Practice questions and answer explanations." },
    { id: "explain",     label: "Explain (Fast + Smart)",    desc: "Text selection popover explanations." },
    { id: "chat",        label: "AI Tutor Chat",             desc: "Free chat / legacy passthrough." },
    { id: "insight",     label: "Weekly Insight (Radar)",    desc: "AI weekly briefing generated on the Weak Spot Radar." },
  ];

  async function loadAdminMaintenance() {
    const box = document.getElementById("admin-maintenance-content");
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Loading…</div>';
    try {
      const [data, authData] = await Promise.all([
        api("/api/admin?action=get_api_keys", { method: "GET" }),
        api("/api/admin?action=get_auth_settings", { method: "GET" }).catch(() => ({ settings: { requireEmailVerification: true } })),
      ]);
      const m = data.maintenance || { global: false, groups: {} };
      const authS = authData.settings || { requireEmailVerification: true };
      const toggle = (checked, on) =>
        `<label style="position:relative;display:inline-block;width:44px;height:24px;">
           <input type="checkbox" ${checked ? "checked" : ""} onchange="${on}" style="opacity:0;width:0;height:0;">
           <span style="position:absolute;cursor:pointer;inset:0;background:${checked ? "linear-gradient(90deg,#f43,#f97316)" : "rgba(255,255,255,0.12)"};border-radius:24px;transition:.2s;">
             <span style="position:absolute;height:18px;width:18px;left:${checked ? "23px" : "3px"};top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 2px 6px rgba(0,0,0,0.35);"></span>
           </span>
         </label>`;
      const toggleBlue = (checked, on) =>
        `<label style="position:relative;display:inline-block;width:44px;height:24px;">
           <input type="checkbox" ${checked ? "checked" : ""} onchange="${on}" style="opacity:0;width:0;height:0;">
           <span style="position:absolute;cursor:pointer;inset:0;background:${checked ? "linear-gradient(90deg,#06b6d4,#8b5cf6)" : "rgba(255,255,255,0.12)"};border-radius:24px;transition:.2s;">
             <span style="position:absolute;height:18px;width:18px;left:${checked ? "23px" : "3px"};top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 2px 6px rgba(0,0,0,0.35);"></span>
           </span>
         </label>`;
      let html = `
        <div style="padding:14px 16px;margin-bottom:14px;background:${authS.requireEmailVerification ? "rgba(6,182,212,0.10)" : "rgba(255,255,255,0.03)"};border:1px solid ${authS.requireEmailVerification ? "rgba(6,182,212,0.32)" : "rgba(255,255,255,0.08)"};border-radius:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div>
            <div style="font-weight:800;color:#fff;font-size:0.98rem;">Require email verification</div>
            <div style="font-size:0.78rem;color:var(--text-muted);margin-top:3px;">When on, users must verify their email before using AI features or subscribing. Admins are always exempt.</div>
          </div>
          ${toggleBlue(authS.requireEmailVerification, "window.toggleRequireEmailVerification(this.checked)")}
        </div>
        <div style="padding:14px 16px;margin-bottom:18px;background:${m.global ? "rgba(244,63,94,0.12)" : "rgba(255,255,255,0.03)"};border:1px solid ${m.global ? "rgba(244,63,94,0.35)" : "rgba(255,255,255,0.08)"};border-radius:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div>
            <div style="font-weight:800;color:#fff;font-size:0.98rem;">Global AI Maintenance</div>
            <div style="font-size:0.78rem;color:var(--text-muted);margin-top:3px;">Blocks EVERY AI request for all non-admin users.</div>
          </div>
          ${toggle(m.global, "window.toggleMaintenance('__global__', this.checked)")}
        </div>
        <div style="font-size:0.78rem;color:var(--text-muted);margin:0 0 8px;text-transform:uppercase;letter-spacing:0.06em;">Per-feature toggles</div>
        <div style="display:flex;flex-direction:column;gap:8px;">`;
      for (const g of MAINT_GROUPS) {
        const on = !!m.groups[g.id];
        html += `
          <div style="padding:12px 14px;background:${on ? "rgba(244,63,94,0.08)" : "rgba(255,255,255,0.03)"};border:1px solid ${on ? "rgba(244,63,94,0.28)" : "rgba(255,255,255,0.08)"};border-radius:10px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <div style="min-width:0;">
              <div style="font-weight:700;color:var(--text-primary);font-size:0.9rem;">${escapeHtml(g.label)}</div>
              <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">${escapeHtml(g.desc)}</div>
            </div>
            ${toggle(on, `window.toggleMaintenance('${g.id}', this.checked)`)}
          </div>`;
      }
      html += `</div>`;
      box.innerHTML = html;
    } catch (e) {
      box.innerHTML = `<div style="color:#f43;padding:20px;">${escapeHtml(e.message)}</div>`;
    }
  }

  window.toggleMaintenance = async function (groupId, on) {
    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "set_maintenance", groupId, on: !!on }),
      });
      loadAdminMaintenance();
    } catch (e) { alert("Failed: " + e.message); loadAdminMaintenance(); }
  };

  window.toggleRequireEmailVerification = async function (on) {
    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "set_auth_settings", authSettings: { requireEmailVerification: !!on } }),
      });
      loadAdminMaintenance();
    } catch (e) { alert("Failed: " + e.message); loadAdminMaintenance(); }
  };

  // ---------- USERS ----------
  async function loadAdminUsers() {
    const box = document.getElementById("admin-users-content");
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Loading…</div>';
    try {
      const data = await api("/api/admin?action=list_users", { method: "GET" });
      const users = data.users || [];
      let proCount = 0, aplusCount = 0, totalCredits = 0;
      users.forEach((u) => {
        const notExpired = !u.proUntil || new Date(u.proUntil).getTime() > Date.now();
        if (u.plan === "pro" && notExpired) proCount++;
        if (u.plan === "aplus" && notExpired) aplusCount++;
        totalCredits += Number(u.creditsUsedThisMonth || 0);
      });
      const search = document.createElement("div");
      search.style.cssText = "display:flex;gap:12px;margin-bottom:14px;align-items:center;flex-wrap:wrap;";
      search.innerHTML = `
        <input id="admin-user-search" placeholder="Search by email…" oninput="window.filterAdminUsers()" style="flex:1;min-width:200px;padding:10px 12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:0.85rem;">
        <div style="display:flex;gap:14px;font-size:0.78rem;color:var(--text-muted);">
          <span><b style="color:var(--text-primary)">${users.length}</b> users</span>
          <span><b style="color:#67e8f9">${proCount}</b> Supporter</span>
          <span><b style="color:#fbbf24">${aplusCount}</b> Supporter+</span>
          <span><b style="color:var(--text-primary)">${fmt(totalCredits)}</b> credits used this month</span>
        </div>`;
      const list = document.createElement("div");
      list.id = "admin-user-rows";
      list.style.cssText = "display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow-y:auto;";

      users.forEach((u) => {
        const proUntil = u.proUntil ? new Date(u.proUntil) : null;
        const notExpired = !proUntil || proUntil.getTime() > Date.now();
        const plan = (u.plan === "pro" || u.plan === "aplus") && notExpired ? u.plan : "free";
        const isPaid = plan !== "free";
        const credits = Number(u.credits || 0);
        const bonus = Number(u.creditsBonus || 0);
        const allotment = Number(u.creditsAllotment || 0);
        const usedM = Number(u.creditsUsedThisMonth || 0);
        const email = u.email || "(no email)";
        const lastIso = [u.lastActiveIso, u.lastSeenIso, u.lastLoginIso].filter(Boolean).sort().pop() || "";
        const last = lastIso ? new Date(lastIso).toLocaleString() : "—";

        const row = document.createElement("div");
        row.className = "admin-user-row";
        row.dataset.email = email.toLowerCase();
        row.style.cssText = "padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;";

        const left = document.createElement("div");
        left.style.cssText = "min-width:0;flex:1;";
        const header = document.createElement("div");
        header.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
        const emailEl = document.createElement("b");
        emailEl.style.cssText = "color:var(--text-primary);word-break:break-all;";
        emailEl.textContent = email;
        header.appendChild(emailEl);
        const badge = document.createElement("span");
        if (plan === "aplus") { badge.style.cssText = "background:linear-gradient(90deg,#f59e0b,#ef4444);color:#fff;padding:2px 8px;border-radius:999px;font-size:0.65rem;font-weight:800;"; badge.textContent = "SUPPORTER+"; }
        else if (plan === "pro") { badge.style.cssText = "background:linear-gradient(90deg,#06b6d4,#8b5cf6);color:#fff;padding:2px 8px;border-radius:999px;font-size:0.65rem;font-weight:800;"; badge.textContent = "SUPPORTER"; }
        else { badge.style.cssText = "background:rgba(255,255,255,0.08);color:var(--text-secondary);padding:2px 8px;border-radius:999px;font-size:0.65rem;font-weight:700;"; badge.textContent = "FREE"; }
        header.appendChild(badge);
        left.appendChild(header);
        if (isPaid && proUntil) {
          const until = document.createElement("div");
          until.style.cssText = "font-size:0.7rem;color:var(--text-muted);";
          until.textContent = "until " + proUntil.toLocaleDateString();
          left.appendChild(until);
        }
        const meta = document.createElement("div");
        meta.style.cssText = "font-size:0.7rem;color:var(--text-muted);margin-top:3px;";
        const creditPart = allotment > 0
          ? `${fmt(credits)} / ${fmt(allotment)} credits`
          : `${fmt(credits)} credits`;
        const bonusPart = bonus > 0 ? ` · +${fmt(bonus)} bonus` : "";
        const qbankPart = u.qbankAnswerCount > 0 ? ` · ${fmt(u.qbankAnswerCount)} qbank answers` : "";
        meta.textContent = `${creditPart}${bonusPart}${qbankPart} · ${fmt(usedM)} used this month · seen ${last}`;
        left.appendChild(meta);

        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
        const mkBtn = (label, color, act) => {
          const b = document.createElement("button");
          b.className = "btn-dark-pill";
          b.style.cssText = "padding:5px 10px;font-size:0.72rem;" + (color ? "color:" + color + ";" : "");
          b.textContent = label;
          b.addEventListener("click", () => window.adminUserAction(u.uid, act));
          return b;
        };
        if (plan !== "pro") actions.appendChild(mkBtn("→ Supporter", "#67e8f9", "upgrade"));
        if (plan !== "aplus") actions.appendChild(mkBtn("→ Supporter+", "#fbbf24", "upgrade_aplus"));
        if (isPaid) actions.appendChild(mkBtn("Downgrade", null, "downgrade"));
        actions.appendChild(mkBtn("Refill", null, "reset_quota"));
        actions.appendChild(mkBtn("+ Credits", null, "grant_bonus"));
        actions.appendChild(mkBtn("Delete Data", "#f43", "delete_user"));

        row.appendChild(left);
        row.appendChild(actions);
        list.appendChild(row);
      });

      box.innerHTML = "";
      box.appendChild(search);
      box.appendChild(list);
    } catch (e) {
      box.innerHTML = `<div style="color:#f43;padding:20px;">${escapeHtml(e.message)}</div>`;
    }
  }

  window.filterAdminUsers = function () {
    const q = (document.getElementById("admin-user-search").value || "").toLowerCase();
    document.querySelectorAll(".admin-user-row").forEach((r) => {
      r.style.display = r.dataset.email.includes(q) ? "" : "none";
    });
  };

  window.adminUserAction = async function (uid, action) {
    const payload = { uid, action };
    if (action === "upgrade" || action === "upgrade_aplus") {
      const tierLabel = action === "upgrade_aplus" ? "ULTIMATE" : "Pro";
      const d = prompt(`Grant ${tierLabel} for how many days?`, "30");
      if (!d) return;
      payload.days = parseInt(d, 10) || 30;
    }
    if (action === "grant_bonus") {
      const b = prompt("How many bonus credits to grant? (persist across months)", "1000");
      if (!b) return;
      payload.bonus = parseInt(b, 10) || 1000;
    }
    if (action === "downgrade" && !confirm("Downgrade this user to Free?")) return;
    if (action === "reset_quota" && !confirm("Refill this user's monthly credits to their plan's allotment?")) return;
    if (action === "delete_user" && !confirm("Clear this user's OmNote data document? (Auth account will remain.)")) return;
    try {
      await api("/api/admin", { method: "POST", body: JSON.stringify(payload) });
      loadAdminUsers();
    } catch (e) { alert("Failed: " + e.message); }
  };

  window.adminResetUser = function (uid) { return window.adminUserAction(uid, "delete_user"); };

  // ---------- CREDITS (uses "quotas" panel id from HTML) ----------
  let creditConfigDraft = null;

  async function loadAdminCredits() {
    const box = document.getElementById("admin-quotas-content");
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Loading…</div>';
    try {
      const data = await api("/api/admin?action=get_credit_config", { method: "GET" });
      const cfg = data.config || data.defaults;
      creditConfigDraft = {
        plans: { ...(cfg.plans || {}) },
        multipliers: { ...(cfg.multipliers || {}) },
        featureCaps: cfg.featureCaps ? JSON.parse(JSON.stringify(cfg.featureCaps)) : { free: {}, pro: {}, aplus: {} },
      };
      renderCreditsEditor(box, data.defaults);
    } catch (e) {
      box.innerHTML = `<div style="color:#f43;padding:20px;">${escapeHtml(e.message)}</div>`;
    }
  }

  function renderCreditsEditor(box, defaults) {
    const planColor = { free: "#94a3b8", pro: "#67e8f9", aplus: "#fbbf24" };
    const planLabel = { free: "FREE", pro: "PRO", aplus: "ULTIMATE" };
    const plans = creditConfigDraft.plans;

    let planCards = "";
    for (const p of ["free", "pro", "aplus"]) {
      const v = plans[p] ?? (defaults.plans && defaults.plans[p]) ?? 0;
      planCards += `
        <div style="padding:14px;border-radius:12px;background:rgba(255,255,255,0.03);border:1px solid ${planColor[p]}55;">
          <div style="color:${planColor[p]};font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;font-weight:800;">${planLabel[p]}</div>
          <label style="font-size:0.72rem;color:var(--text-muted);display:block;margin:8px 0 4px;">Credits per month</label>
          <input type="number" min="0" step="100" value="${v}"
            onchange="window.updateCreditPlan('${p}', this.value)"
            style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:0.95rem;font-weight:700;">
        </div>`;
    }

    const mults = creditConfigDraft.multipliers;
    const multRows = Object.entries(mults).map(([model, mult]) => `
      <div style="display:flex;gap:8px;align-items:center;background:rgba(255,255,255,0.03);padding:8px 10px;border-radius:8px;">
        <input value="${escapeHtml(model)}" onchange="window.renameCreditMultiplier('${escapeHtml(model)}', this.value)"
          style="flex:1;padding:6px 10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#fff;font-family:monospace;font-size:0.82rem;">
        <input type="number" min="0.01" step="0.1" value="${mult}" onchange="window.updateCreditMultiplier('${escapeHtml(model)}', this.value)"
          style="width:90px;padding:6px 10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#fff;font-size:0.82rem;">
        <span style="color:var(--text-muted);font-size:0.72rem;">×</span>
        <button class="btn-dark-pill" style="padding:4px 10px;font-size:0.7rem;color:#f43;" onclick="window.removeCreditMultiplier('${escapeHtml(model)}')">Remove</button>
      </div>`).join("");

    const featureLabels = {
      chunk_plan: "Study Plan",
      summary: "Summaries",
      flashcards: "Flashcards",
      mcq: "MCQs",
      explain: "Explain",
      chat: "AI Tutor",
      insight: "Weekly Insight"
    };
    
    let capsTable = `<div style="overflow-x:auto; margin-bottom: 22px;"><table style="width:100%; min-width: 600px; border-collapse: collapse; font-size: 0.85rem; text-align: left;">
      <thead>
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">
          <th style="padding: 10px; color: var(--text-muted); font-weight: 600;">Feature</th>
          <th style="padding: 10px; color: ${planColor.free};">Free <span style="font-size:0.7rem;font-weight:400;">(D / M)</span></th>
          <th style="padding: 10px; color: ${planColor.pro};">Supporter <span style="font-size:0.7rem;font-weight:400;">(D / M)</span></th>
          <th style="padding: 10px; color: ${planColor.aplus};">Supporter+ <span style="font-size:0.7rem;font-weight:400;">(D / M)</span></th>
        </tr>
      </thead>
      <tbody>`;
    
    for (const [key, label] of Object.entries(featureLabels)) {
      capsTable += `<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
        <td style="padding: 10px; font-weight: 600; color: #fff;">${label} <br><span style="font-size:0.7rem;color:var(--text-muted);font-weight:400;">${key}</span></td>`;
      for (const p of ["free", "pro", "aplus"]) {
        const v = creditConfigDraft.featureCaps[p]?.[key] || defaults.featureCaps?.[p]?.[key] || { daily: 0, monthly: 0 };
        capsTable += `<td style="padding: 10px;">
          <input type="number" value="${v.daily}" min="0" onchange="window.updateFeatureCap('${p}', '${key}', 'daily', this.value)" style="width:50px; padding:4px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:#fff; text-align:center;" title="Daily Cap (0=Unlimited)"> / 
          <input type="number" value="${v.monthly}" min="0" onchange="window.updateFeatureCap('${p}', '${key}', 'monthly', this.value)" style="width:60px; padding:4px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:#fff; text-align:center;" title="Monthly Cap (0=Unlimited)">
        </td>`;
      }
      capsTable += `</tr>`;
    }
    capsTable += `</tbody></table></div>`;

    box.innerHTML = `
      <div style="margin-bottom:14px;color:var(--text-secondary);font-size:0.88rem;line-height:1.55;">
        Credits meter <b>real token usage</b>: <code>credits = ceil(tokens / 1000) × modelMultiplier</code> (floor 1).<br>
        Baseline is Gemini 3.1 Flash Lite (~$0.19 / 1M tokens) — 1 credit ≈ $0.00019 raw cost.
      </div>

      <div style="margin-bottom:8px;font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Monthly credit allotments</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:22px;">
        ${planCards}
      </div>

      <div style="margin-bottom:8px;font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Per-Plan Feature Caps (0 = unlimited)</div>
      ${capsTable}

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Model cost multipliers</div>
        <button class="btn-dark-pill" style="padding:5px 10px;font-size:0.72rem;" onclick="window.addCreditMultiplier()">+ Add model</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px;">
        ${multRows || `<div style="color:var(--text-muted);font-size:0.85rem;padding:12px;">No multipliers — defaults apply (1.0×).</div>`}
      </div>

      <div style="display:flex;gap:10px;margin-top:20px;">
        <button class="btn-action primary" style="padding:10px 20px;" onclick="window.saveAdminCredits()">Save credits config</button>
        <button class="btn-dark-pill" style="padding:10px 16px;" onclick="window.resetAdminCredits()">Reset to defaults</button>
      </div>`;
  }

  window.updateCreditPlan = function (plan, value) {
    creditConfigDraft.plans[plan] = Math.max(0, parseInt(value, 10) || 0);
  };
  window.updateCreditMultiplier = function (model, value) {
    const v = parseFloat(value);
    if (v > 0) creditConfigDraft.multipliers[model] = v;
  };
  window.renameCreditMultiplier = function (oldModel, newModel) {
    const clean = String(newModel || "").trim();
    if (!clean || clean === oldModel) return;
    creditConfigDraft.multipliers[clean] = creditConfigDraft.multipliers[oldModel];
    delete creditConfigDraft.multipliers[oldModel];
    loadAdminCredits();
  };
  window.removeCreditMultiplier = function (model) {
    delete creditConfigDraft.multipliers[model];
    loadAdminCredits();
  };
  window.addCreditMultiplier = function () {
    const model = prompt("Model id (e.g. gemini-2.5-flash):", "");
    if (!model) return;
    creditConfigDraft.multipliers[model.trim()] = 1.0;
    loadAdminCredits();
  };
  window.updateFeatureCap = function(plan, key, type, value) {
    if (!creditConfigDraft.featureCaps[plan]) creditConfigDraft.featureCaps[plan] = {};
    if (!creditConfigDraft.featureCaps[plan][key]) creditConfigDraft.featureCaps[plan][key] = { daily: 0, monthly: 0 };
    creditConfigDraft.featureCaps[plan][key][type] = Math.max(0, parseInt(value, 10) || 0);
  };
  window.saveAdminCredits = async function () {
    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "set_credit_config", config: creditConfigDraft }),
      });
      alert("Credits config saved.");
    } catch (e) { alert("Failed: " + e.message); }
  };
  window.resetAdminCredits = function () {
    if (!confirm("Reset to hardcoded defaults? (You'll still need to click Save.)")) return;
    loadAdminCredits();
  };

  // ---------- PAYMENTS ----------
  let paymentsDraft = null;

  async function loadAdminPayments() {
    const box = document.getElementById("admin-payments-content");
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Loading…</div>';
    try {
      const data = await api("/api/admin?action=get_payments_settings", { method: "GET" });
      paymentsDraft = JSON.parse(JSON.stringify(data.settings));
      renderPaymentsEditor(box, !!data.kashierConfigured);
    } catch (e) {
      box.innerHTML = `<div style="color:#f43;padding:20px;">${escapeHtml(e.message)}</div>`;
    }
  }

  function renderPaymentsEditor(box, kashierConfigured) {
    const s = paymentsDraft;
    const statusChip = kashierConfigured
      ? '<span style="background:rgba(16,185,129,0.15);color:#6ee7b7;border:1px solid rgba(16,185,129,0.35);padding:3px 10px;border-radius:999px;font-size:0.7rem;font-weight:700;"><i data-lucide="check-circle-2" style="width:12px;height:12px;vertical-align:-2px;"></i> Kashier keys configured</span>'
      : '<span style="background:rgba(245,158,11,0.15);color:#fcd34d;border:1px solid rgba(245,158,11,0.35);padding:3px 10px;border-radius:999px;font-size:0.7rem;font-weight:700;"><i data-lucide="alert-triangle" style="width:12px;height:12px;vertical-align:-2px;"></i> Kashier keys missing</span>';
    const masterChip = s.enabled
      ? '<span style="background:rgba(16,185,129,0.15);color:#6ee7b7;border:1px solid rgba(16,185,129,0.35);padding:3px 10px;border-radius:999px;font-size:0.7rem;font-weight:700;">LIVE</span>'
      : '<span style="background:rgba(244,63,94,0.15);color:#fca5a5;border:1px solid rgba(244,63,94,0.35);padding:3px 10px;border-radius:999px;font-size:0.7rem;font-weight:700;">DISABLED</span>';

    const toggleRow = (id, label, sub, checked) => `
      <label for="${id}" style="display:flex;justify-content:space-between;align-items:center;gap:14px;padding:12px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;cursor:pointer;">
        <div style="min-width:0;">
          <div style="font-weight:700;color:var(--text-primary);font-size:0.9rem;">${label}</div>
          <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px;">${sub}</div>
        </div>
        <input id="${id}" type="checkbox" ${checked ? "checked" : ""} style="width:18px;height:18px;cursor:pointer;accent-color:#06b6d4;">
      </label>`;

    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
        <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Payment wall</div>
        ${masterChip}${statusChip}
      </div>

      <div style="margin-bottom:14px;color:var(--text-secondary);font-size:0.85rem;line-height:1.55;">
        Toggle the payment wall globally or per plan / currency. When disabled, upgrade attempts return the message below and the checkout button won't open Kashier.
      </div>

      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px;">
        ${toggleRow("pay-enabled", "Master switch", "Turn the whole payment wall on or off.", s.enabled)}
      </div>

      <div style="margin:8px 0;font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Plans available for purchase</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-bottom:18px;">
        ${toggleRow("pay-plan-pro", "Pro plan", "Allow users to buy the Pro tier.", s.allowedPlans.pro)}
        ${toggleRow("pay-plan-aplus", "Ultimate plan", "Allow users to buy the Ultimate tier.", s.allowedPlans.aplus)}
      </div>

      <div style="margin:8px 0;font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Currencies accepted</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-bottom:18px;">
        ${toggleRow("pay-cur-usd", "USD", "Charge international users in US dollars.", s.allowedCurrencies.USD)}
        ${toggleRow("pay-cur-egp", "EGP", "Charge Egyptian users in local currency.", s.allowedCurrencies.EGP)}
      </div>

      <div style="margin:8px 0;font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Message shown when payments are disabled</div>
      <textarea id="pay-reason" rows="2" maxlength="400" style="width:100%;padding:10px 12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:0.85rem;font-family:inherit;resize:vertical;margin-bottom:18px;">${escapeHtml(s.reason || "")}</textarea>

      <div style="display:flex;gap:10px;">
        <button class="btn-action primary" style="padding:10px 20px;" onclick="window.saveAdminPayments()">Save payment settings</button>
        <button class="btn-dark-pill" style="padding:10px 16px;" onclick="loadAdminPayments()">Reload</button>
      </div>
    `;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }

  window.saveAdminPayments = async function () {
    if (!paymentsDraft) return;
    const patch = {
      enabled: !!document.getElementById("pay-enabled")?.checked,
      reason: (document.getElementById("pay-reason")?.value || "").trim(),
      allowedPlans: {
        pro: !!document.getElementById("pay-plan-pro")?.checked,
        aplus: !!document.getElementById("pay-plan-aplus")?.checked,
      },
      allowedCurrencies: {
        USD: !!document.getElementById("pay-cur-usd")?.checked,
        EGP: !!document.getElementById("pay-cur-egp")?.checked,
      },
    };
    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "set_payments_settings", payments: patch }),
      });
      alert("Payment settings saved.");
      loadAdminPayments();
    } catch (e) { alert("Failed: " + e.message); }
  };
  window.loadAdminPayments = loadAdminPayments;

  // ---------- NOTIFICATIONS ----------
  let notifUsersCache = [];

  async function loadAdminNotifications() {
    const box = document.getElementById("admin-notifications-content");
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Loading…</div>';
    try {
      const [usersRes, sentRes] = await Promise.all([
        api("/api/admin?action=list_users", { method: "GET" }),
        api("/api/notifications?action=list_sent", { method: "GET" }),
      ]);
      notifUsersCache = (usersRes.users || []).map((u) => ({
        uid: u.uid, email: u.email || "", plan: u.plan || "free", proUntil: u.proUntil || null,
      }));
      renderNotifPanel(box, sentRes.notifications || []);
    } catch (e) {
      box.innerHTML = `<div style="color:#f43;padding:20px;">${escapeHtml(e.message)}</div>`;
    }
  }

  function renderNotifPanel(box, sent) {
    box.innerHTML = `
      <div class="notif-admin-wrap">
        <div class="notif-admin-card">
          <div class="notif-admin-title"><i data-lucide="megaphone"></i> Compose notification</div>

          <div class="notif-form-grid">
            <label class="notif-field">
              <span>Title</span>
              <input id="na-title" maxlength="120" placeholder="e.g. New feature: Study Together" />
            </label>
            <label class="notif-field">
              <span>Type</span>
              <select id="na-type">
                <option value="info">Info</option>
                <option value="success">Success</option>
                <option value="warning">Warning</option>
                <option value="promo">Promo</option>
              </select>
            </label>
            <label class="notif-field notif-field-full">
              <span>Message</span>
              <textarea id="na-body" maxlength="600" rows="3" placeholder="Short message users see in their bell…"></textarea>
            </label>
            <label class="notif-field">
              <span>Link (optional)</span>
              <select id="na-link-kind">
                <option value="">No link</option>
                <option value="url">External URL</option>
                <option value="tab">Open app tab</option>
              </select>
            </label>
            <label class="notif-field">
              <span id="na-link-value-label">Link value</span>
              <input id="na-link-value" placeholder="https://…" />
            </label>
          </div>

          <div class="notif-audience">
            <div class="notif-audience-label">Audience</div>
            <div class="notif-audience-row">
              <label><input type="radio" name="na-aud" value="all" checked /> Everyone</label>
              <label><input type="radio" name="na-aud" value="plan" /> By plan</label>
              <label><input type="radio" name="na-aud" value="users" /> Specific users</label>
            </div>
            <div id="na-aud-plan" class="notif-audience-sub" style="display:none;">
              <label><input type="checkbox" value="free" /> Free</label>
              <label><input type="checkbox" value="pro" /> Pro</label>
              <label><input type="checkbox" value="aplus" /> Ultimate</label>
            </div>
            <div id="na-aud-users" class="notif-audience-sub" style="display:none;">
              <input id="na-user-search" placeholder="Search users by email…" />
              <div id="na-user-list" class="notif-user-list"></div>
              <div class="notif-user-count"><span id="na-user-count">0</span> selected</div>
            </div>
          </div>

          <div class="notif-actions">
            <button class="btn-primary" id="na-send"><i data-lucide="send"></i> Send</button>
            <span id="na-status" class="notif-status"></span>
          </div>
        </div>

        <div class="notif-admin-card">
          <div class="notif-admin-title"><i data-lucide="history"></i> Recent broadcasts</div>
          <div id="na-history" class="notif-history"></div>
        </div>
      </div>
    `;

    // Link kind changes placeholder
    const linkKind = box.querySelector("#na-link-kind");
    const linkValue = box.querySelector("#na-link-value");
    const linkLabel = box.querySelector("#na-link-value-label");
    function syncLinkUI() {
      if (linkKind.value === "url") {
        linkValue.placeholder = "https://…";
        linkLabel.textContent = "URL";
        linkValue.disabled = false;
      } else if (linkKind.value === "tab") {
        linkValue.placeholder = "study-plan | summary | ai-tutor | review";
        linkLabel.textContent = "Tab name";
        linkValue.disabled = false;
      } else {
        linkValue.value = "";
        linkValue.placeholder = "No link";
        linkLabel.textContent = "Link value";
        linkValue.disabled = true;
      }
    }
    linkKind.addEventListener("change", syncLinkUI);
    syncLinkUI();

    // Audience toggles
    const audPlan = box.querySelector("#na-aud-plan");
    const audUsers = box.querySelector("#na-aud-users");
    box.querySelectorAll('input[name="na-aud"]').forEach((r) => {
      r.addEventListener("change", () => {
        const v = box.querySelector('input[name="na-aud"]:checked').value;
        audPlan.style.display = v === "plan" ? "flex" : "none";
        audUsers.style.display = v === "users" ? "block" : "none";
        if (v === "users") renderUserPicker("");
      });
    });

    // User picker
    const selected = new Set();
    function renderUserPicker(q) {
      const list = box.querySelector("#na-user-list");
      const term = (q || "").trim().toLowerCase();
      const rows = notifUsersCache
        .filter((u) => !term || (u.email || "").toLowerCase().includes(term) || u.uid.includes(term))
        .slice(0, 100);
      list.innerHTML = rows.map((u) => `
        <label class="notif-user-row">
          <input type="checkbox" data-uid="${escapeHtml(u.uid)}" ${selected.has(u.uid) ? "checked" : ""}/>
          <span class="notif-user-email">${escapeHtml(u.email || "(no email)")}</span>
          <span class="notif-user-plan">${escapeHtml(u.plan)}</span>
        </label>
      `).join("") || `<div style="padding:14px;color:var(--text-muted);font-size:0.8rem;">No users</div>`;
      list.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        cb.addEventListener("change", () => {
          const uid = cb.dataset.uid;
          if (cb.checked) selected.add(uid); else selected.delete(uid);
          box.querySelector("#na-user-count").textContent = String(selected.size);
        });
      });
    }
    box.querySelector("#na-user-search").addEventListener("input", (e) => renderUserPicker(e.target.value));

    // Send handler
    box.querySelector("#na-send").addEventListener("click", async () => {
      const btn = box.querySelector("#na-send");
      const status = box.querySelector("#na-status");
      const title = box.querySelector("#na-title").value.trim();
      const bodyTxt = box.querySelector("#na-body").value.trim();
      const type = box.querySelector("#na-type").value;
      const linkK = linkKind.value;
      const linkV = linkValue.value.trim();
      const audMode = box.querySelector('input[name="na-aud"]:checked').value;
      if (!title || !bodyTxt) { status.textContent = "Title and message are required."; status.style.color = "#f87171"; return; }

      let audience;
      if (audMode === "all") audience = { mode: "all" };
      else if (audMode === "plan") {
        const plans = [...box.querySelectorAll("#na-aud-plan input:checked")].map((el) => el.value);
        if (!plans.length) { status.textContent = "Pick at least one plan."; status.style.color = "#f87171"; return; }
        audience = { mode: "plan", plans };
      } else {
        if (selected.size === 0) { status.textContent = "Select at least one user."; status.style.color = "#f87171"; return; }
        audience = { mode: "users", userIds: [...selected] };
      }
      const link = linkK ? { kind: linkK, value: linkV } : null;

      btn.disabled = true;
      status.textContent = "Sending…";
      status.style.color = "var(--text-muted)";
      try {
        const res = await api("/api/notifications", {
          method: "POST",
          body: JSON.stringify({ action: "send", title, body: bodyTxt, type, link, audience }),
        });
        status.textContent = `Sent to ${res.recipientCount} user${res.recipientCount === 1 ? "" : "s"}.`;
        status.style.color = "#22c55e";
        box.querySelector("#na-title").value = "";
        box.querySelector("#na-body").value = "";
        linkValue.value = "";
        loadAdminNotifications();
      } catch (e) {
        status.textContent = e.message;
        status.style.color = "#f87171";
      } finally {
        btn.disabled = false;
      }
    });

    // History render
    const histBox = box.querySelector("#na-history");
    if (!sent.length) {
      histBox.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:0.85rem;">No broadcasts yet.</div>`;
    } else {
      histBox.innerHTML = sent.map((n) => {
        const when = n.createdAt ? new Date(n.createdAt).toLocaleString() : "";
        return `
          <div class="notif-hist-row">
            <div class="notif-hist-body">
              <div class="notif-hist-top">
                <span class="notif-hist-type notif-hist-type-${escapeHtml(n.type)}">${escapeHtml(n.type)}</span>
                <b>${escapeHtml(n.title)}</b>
              </div>
              <div class="notif-hist-msg">${escapeHtml(n.body)}</div>
              <div class="notif-hist-meta">${escapeHtml(n.audienceSummary)} · ${escapeHtml(when)} · by ${escapeHtml(n.createdByEmail)}</div>
            </div>
            <button class="btn-dark-pill notif-hist-del" data-id="${escapeHtml(n.id)}"><i data-lucide="trash-2"></i></button>
          </div>`;
      }).join("");
      histBox.querySelectorAll(".notif-hist-del").forEach((b) => {
        b.addEventListener("click", async () => {
          if (!confirm("Delete this broadcast from history?\n(Per-user copies already delivered are kept.)")) return;
          try {
            await api("/api/notifications", { method: "POST", body: JSON.stringify({ action: "delete", id: b.dataset.id }) });
            loadAdminNotifications();
          } catch (e) { alert("Failed: " + e.message); }
        });
      });
    }

    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }
  window.loadAdminNotifications = loadAdminNotifications;

  // Mirror user to /users_index so it exists for server reads.
  window.mirrorUserToIndex = async function (user) {
    if (!user || !window.fsdb) return;
    try {
      await fsdb.collection("users_index").doc(user.uid).set(
        {
          email: user.email || "",
          lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (e) {
      console.warn("users_index mirror failed:", e && e.message);
    }
  };

  function attachAuthListener() {
    if (!window.firebase || !firebase.auth) {
      setTimeout(attachAuthListener, 200);
      return;
    }
    firebase.auth().onAuthStateChanged(function (user) {
      if (user) {
        whoamiChecked = false; whoamiPromise = null; // re-verify on account switch — never reuse previous account's result
        window.mirrorUserToIndex(user);
        window.showAdminButton();
      } else {
        whoamiChecked = false; isAdminCache = false;
        window.isAdminCache = false;
        window.isQBankAdmin = false;
        try { sessionStorage.removeItem('exora_is_admin'); } catch (_) {}
        const btn = document.getElementById("admin-panel-btn");
        if (btn) btn.style.display = "none";
        const w = document.getElementById('admin-diagnostic-widget');
        if (w) w.remove();
      }
    });
  }
  attachAuthListener();

  // ---------- STATS ----------
  function relTime(iso) {
    if (!iso) return "never";
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3600_000) return Math.floor(diff / 60_000) + "m ago";
    if (diff < 86400_000) return Math.floor(diff / 3600_000) + "h ago";
    if (diff < 30 * 86400_000) return Math.floor(diff / 86400_000) + "d ago";
    return new Date(iso).toLocaleDateString();
  }

  // Newest of AI usage (lastSeenIso), in-app interaction (lastActiveIso)
  // and Firebase Auth sign-in / token refresh (lastLoginIso)
  function lastActivityIso(u) {
    if (!u) return "";
    return [u.lastActiveIso, u.lastSeenIso, u.lastLoginIso]
      .filter(Boolean)
      .sort()
      .pop() || "";
  }


  async function loadAdminStats() {
    const box = document.getElementById("admin-stats-content");
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Loading stats…</div>';
    try {
      const [ov, usersData, breakdown] = await Promise.all([
        api("/api/admin?action=stats_overview", { method: "GET" }),
        api("/api/admin?action=list_users", { method: "GET" }),
        api("/api/admin?action=stats_qbank_breakdown", { method: "GET" }).catch(() => null),
      ]);
      renderStatsTab(box, ov, usersData.users || [], breakdown || null);
    } catch (e) {
      box.innerHTML = `<div style="color:#f43;padding:20px;">${escapeHtml(e.message)}</div>`;
    }
  }

  function statCard(label, value, sub, accent) {
    const color = accent || "var(--accent-cyan)";
    return `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;">
      <div style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">${escapeHtml(label)}</div>
      <div style="font-size:1.8rem;font-weight:800;color:${color};margin-top:6px;line-height:1.1;">${escapeHtml(value)}</div>
      ${sub ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;">${escapeHtml(sub)}</div>` : ""}
    </div>`;
  }

  // Most-answered leaderboards (Top QBanks / Subjects / Categories).
  // Counts accumulate from new answers via server-side counters; answers
  // submitted before this shipped are not included.
  function boardCol(title, accent, items) {
    const top = (items || []).slice(0, 8);
    const max = top.length ? Math.max(...top.map((i) => i.answers)) : 0;
    const rows = top.map((i) => {
      const pct = max ? Math.max(4, Math.round((i.answers / max) * 100)) : 0;
      return `<div style="margin-bottom:9px;">
        <div style="display:flex;justify-content:space-between;gap:8px;font-size:0.76rem;margin-bottom:3px;">
          <span style="color:var(--text-primary);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(i.label)}</span>
          <span style="color:var(--text-secondary);font-variant-numeric:tabular-nums;flex-shrink:0;">${fmt(i.answers)}</span>
        </div>
        <div style="height:6px;border-radius:999px;background:rgba(255,255,255,0.07);overflow:hidden;">
          <div style="height:100%;width:${pct}%;border-radius:999px;background:${accent};"></div>
        </div>
      </div>`;
    }).join("");
    return `<div style="flex:1;min-width:220px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px 16px;">
      <div style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:12px;">${escapeHtml(title)}</div>
      ${rows || `<div style="font-size:0.76rem;color:var(--text-muted);padding:6px 0;">No answers counted yet.</div>`}
    </div>`;
  }

  function breakdownBoards(bd) {
    if (!bd) return "";
    const banks = (bd.banks || []).map((b) => ({ label: b.name || b.bankId, answers: b.answers }));
    const subjects = (bd.subjects || []).map((s) => ({ label: s.name, answers: s.answers }));
    const chapters = (bd.chapters || []).map((c) => ({
      label: c.subject ? `${c.subject} · ${c.chapter}` : c.chapter,
      answers: c.answers,
    }));
    const empty = !banks.length && !subjects.length && !chapters.length;
    return `<div style="margin-bottom:20px;">
      <div style="font-size:0.78rem;font-weight:700;color:var(--text-primary);margin-bottom:2px;">Most answered</div>
      <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:12px;">${empty ? "Counts start from new answers — ask a question to seed the boards." : `Across ${fmt(bd.total || 0)} counted answers`}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${boardCol("Top QBanks", "#22d3ee", banks)}
        ${boardCol("Top Subjects", "#a78bfa", subjects)}
        ${boardCol("Top Categories", "#f59e0b", chapters)}
      </div>
    </div>`;
  }

  function renderStatsTab(box, ov, users, breakdown) {
    // App-wide totals (fall back to summing the user list if aggregation is missing).
    const sumQ = users.reduce((a, u) => a + Number(u.qbankAnswerCount || 0), 0);
    const sumF = users.reduce((a, u) => a + Number(u.flashcardCount || 0), 0);
    const totalQ = Number(ov.totalQbankAnswers || 0) || sumQ;
    const totalF = Number(ov.totalFlashcards || 0) || sumF;
    const totalU = Number(ov.totalUsers || 0) || users.length;

    const cards = [
      statCard("Total Users", fmt(totalU), "registered accounts", "#a78bfa"),
      statCard("Active · 30 min", fmt(ov.active30m || 0), `of ${fmt(totalU)} · ${fmt(ov.active24h || 0)} in 24h`, "#22d3ee"),
      statCard("Flashcards", fmt(totalF), "app-wide total", "#f59e0b"),
      statCard("QBank Answers", fmt(totalQ), "questions answered app-wide", "#06b6d4"),
    ].join("");

    const withMeta = users.map((u) => ({
      u,
      q: Number(u.qbankAnswerCount || 0),
      f: Number(u.flashcardCount || 0),
      last: lastActivityIso(u),
    }));

    const rowsHtml = (list) => list.map(({ u, q, f, last }) => {
      return `<tr data-uid="${escapeHtml(u.uid)}" data-email="${escapeHtml((u.email || "").toLowerCase())}" data-q="${q}" data-f="${f}" data-last="${escapeHtml(last || "")}" style="border-top:1px solid rgba(255,255,255,0.06);cursor:pointer;">
        <td style="padding:10px 8px;color:var(--text-primary);word-break:break-all;">${escapeHtml(u.email || "(no email)")}${u.noProfile ? `<div style="font-size:0.64rem;color:var(--text-muted);">signed in · no data yet</div>` : ""}</td>
        <td style="padding:10px 8px;color:var(--text-secondary);text-align:right;font-variant-numeric:tabular-nums;">${fmt(f)}</td>
        <td style="padding:10px 8px;color:var(--text-secondary);text-align:right;font-variant-numeric:tabular-nums;font-weight:700;">${fmt(q)}</td>
        <td style="padding:10px 8px;color:var(--text-secondary);white-space:nowrap;">${escapeHtml(relTime(last))}${u.lastActionLabel ? `<div style="font-size:0.66rem;color:var(--text-muted);">${escapeHtml(u.lastActionLabel)}</div>` : ""}</td>
        <td style="padding:10px 8px;text-align:right;"><button class="btn-dark-pill" style="padding:5px 10px;font-size:0.7rem;" data-open-uid="${escapeHtml(u.uid)}">Details</button></td>
      </tr>`;
    }).join("");

    box.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px;">${cards}</div>
      ${breakdownBoards(breakdown)}
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">
        <input id="admin-stats-search" placeholder="Search by email…" style="flex:1;min-width:220px;padding:10px 12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:0.85rem;">
        <select id="admin-stats-sort" style="padding:10px 12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:0.8rem;">
          <option value="active">Sort: most active</option>
          <option value="qbank">Sort: most QBank answers</option>
          <option value="flash">Sort: most flashcards</option>
        </select>
        <button class="btn-dark-pill" id="admin-stats-refresh" style="padding:9px 14px;font-size:0.75rem;">Refresh</button>
      </div>
      <div style="max-height:50vh;overflow-y:auto;border:1px solid rgba(255,255,255,0.08);border-radius:12px;">
        <table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
          <thead><tr style="background:rgba(255,255,255,0.04);">
            <th style="padding:10px 8px;text-align:left;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">User</th>
            <th style="padding:10px 8px;text-align:right;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">Flashcards</th>
            <th style="padding:10px 8px;text-align:right;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">QBank Answers</th>
            <th style="padding:10px 8px;text-align:left;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">Last Active</th>
            <th style="padding:10px 8px;"></th>
          </tr></thead>
          <tbody id="admin-stats-rows">${rowsHtml(withMeta) || '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-muted);">No users yet.</td></tr>'}</tbody>
        </table>
      </div>
      <div id="admin-stats-detail"></div>
    `;

    const applyFilter = () => {
      const q = (document.getElementById("admin-stats-search").value || "").toLowerCase();
      const sort = document.getElementById("admin-stats-sort").value;
      let list = withMeta.filter(({ u }) => (u.email || "").toLowerCase().includes(q));
      if (sort === "qbank") list.sort((a, b) => b.q - a.q);
      else if (sort === "flash") list.sort((a, b) => b.f - a.f);
      else list.sort((a, b) => String(b.last || "").localeCompare(String(a.last || "")));
      document.getElementById("admin-stats-rows").innerHTML = rowsHtml(list) || '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-muted);">No matches.</td></tr>';
      bindRows();
    };
    const search = document.getElementById("admin-stats-search");
    if (search) search.oninput = applyFilter;
    const sortSel = document.getElementById("admin-stats-sort");
    if (sortSel) sortSel.onchange = applyFilter;
    const refresh = document.getElementById("admin-stats-refresh");
    if (refresh) refresh.onclick = () => loadAdminStats();
    const bindRows = () => {
      box.querySelectorAll("[data-open-uid]").forEach((b) => {
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openUserStatsDetail(b.getAttribute("data-open-uid"));
        });
      });
      box.querySelectorAll("#admin-stats-rows tr[data-uid]").forEach((tr) => {
        tr.addEventListener("click", () => openUserStatsDetail(tr.getAttribute("data-uid")));
      });
    };
    bindRows();
  }

  async function openUserStatsDetail(uid) {
    const host = document.getElementById("admin-stats-detail");
    if (!host) return;
    host.innerHTML = `<div style="margin-top:16px;padding:20px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;color:var(--text-muted);text-align:center;">Loading user…</div>`;
    try {
      const d = await api(`/api/admin?action=stats_user_detail&uid=${encodeURIComponent(uid)}`, { method: "GET" });
      const fc = Number(d.flashcardCount ?? d.totalFlashcards ?? 0);
      const qa = Number(d.qbankAnswers ?? 0);
      const tops = Array.isArray(d.topSubjects) ? d.topSubjects.slice(0, 5) : [];
      const topMax = tops.length ? Math.max(...tops.map((t) => Number(t.answers) || 0)) : 0;
      const topsHtml = tops.map((t) => {
        const n = Number(t.answers) || 0;
        const pct = topMax ? Math.max(4, Math.round((n / topMax) * 100)) : 0;
        return `<div style="margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;gap:8px;font-size:0.76rem;margin-bottom:3px;">
            <span style="color:var(--text-primary);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(t.subject)}</span>
            <span style="color:var(--text-secondary);font-variant-numeric:tabular-nums;flex-shrink:0;">${fmt(n)}</span>
          </div>
          <div style="height:6px;border-radius:999px;background:rgba(255,255,255,0.07);overflow:hidden;">
            <div style="height:100%;width:${pct}%;border-radius:999px;background:#a78bfa;"></div>
          </div>
        </div>`;
      }).join("");
      host.innerHTML = `
        <div style="margin-top:16px;padding:20px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
            <div>
              <div style="font-weight:700;color:var(--text-primary);word-break:break-all;">${escapeHtml(d.email || "(no email)")}</div>
              <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px;">uid: ${escapeHtml(d.uid)} · last active ${escapeHtml(relTime(lastActivityIso(d)))}${d.lastActionLabel ? " (" + escapeHtml(d.lastActionLabel) + ")" : ""}</div>
            </div>
            <button class="btn-dark-pill" style="padding:6px 12px;font-size:0.75rem;" onclick="document.getElementById('admin-stats-detail').innerHTML='';">Close</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;">
            ${statCard("Flashcards", fmt(fc), "user total", "#f59e0b")}
            ${statCard("QBank Answers", fmt(qa), "questions answered", "#06b6d4")}
            ${statCard("Last Active", relTime(lastActivityIso(d)), d.lastActionLabel ? escapeHtml(d.lastActionLabel) : "last seen", "#22d3ee")}
          </div>
          ${topsHtml ? `<div style="margin-top:14px;">
            <div style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:8px;">Most answered subjects</div>
            ${topsHtml}
          </div>` : ""}
        </div>
      `;
      host.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      host.innerHTML = `<div style="margin-top:16px;padding:16px;color:#f43;border:1px solid rgba(255,50,50,0.2);border-radius:10px;">${escapeHtml(e.message)}</div>`;
    }
  }

  // ---------- FEEDBACK ----------
  // In-app rating popup (stars + optional comment). One showing per account
  // (server-enforced), global on/off lock here, stats + responses below.
  async function loadAdminFeedback() {
    const box = document.getElementById("admin-feedback-content");
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Loading feedback…</div>';
    try {
      const data = await api("/api/admin?action=feedback_overview", { method: "GET" });
      renderFeedbackTab(box, data);
    } catch (e) {
      box.innerHTML = `<div style="color:#f43;padding:20px;">${escapeHtml(e.message)}</div>`;
    }
  }

  function starsVisual(n) {
    const v = Math.max(0, Math.min(5, Number(n) || 0));
    let s = "";
    for (let i = 1; i <= 5; i++) {
      s += `<span style="color:${i <= v ? "#f59e0b" : "rgba(255,255,255,0.15)"};font-size:0.95rem;">★</span>`;
    }
    return `<span style="white-space:nowrap;">${s}</span>`;
  }

  function renderFeedbackTab(box, data) {
    // Stale backend (deployed before feedback_overview existed) answers
    // {ok:true} with no payload — say so instead of showing empty stats.
    if (!data || !data.stats || !data.items) {
      box.innerHTML = `<div style="margin-bottom:16px;padding:14px 16px;border-radius:12px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);color:var(--text-primary);font-size:0.82rem;">The server is running an older build without the feedback API. Deploy the latest build, then reopen this tab.</div>`;
      return;
    }
    const warnBanner = data.warning ? `<div style="margin-bottom:16px;padding:14px 16px;border-radius:12px;background:rgba(244,63,94,0.08);border:1px solid rgba(244,63,94,0.3);color:var(--text-primary);font-size:0.78rem;word-break:break-word;">${escapeHtml(data.warning)}</div>` : "";
    const stats = data.stats || { total: 0, avg: 0, dist: {}, withComments: 0 };
    const dist = stats.dist || {};
    const maxD = Math.max(1, ...[1, 2, 3, 4, 5].map((k) => Number(dist[String(k)] || 0)));
    const distRows = [5, 4, 3, 2, 1].map((k) => {
      const n = Number(dist[String(k)] || 0);
      const pct = Math.max(n ? 4 : 0, Math.round((n / maxD) * 100));
      return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:7px;font-size:0.78rem;">
        <span style="color:var(--text-secondary);width:34px;flex-shrink:0;">${k} ★</span>
        <div style="flex:1;height:8px;border-radius:999px;background:rgba(255,255,255,0.07);overflow:hidden;">
          <div style="height:100%;width:${pct}%;border-radius:999px;background:#f59e0b;"></div>
        </div>
        <span style="color:var(--text-secondary);width:44px;text-align:right;font-variant-numeric:tabular-nums;">${fmt(n)}</span>
      </div>`;
    }).join("");

    const rowsHtml = (data.items || []).map((it) => {
      const when = it.createdAtIso || (it.createdAt ? new Date(it.createdAt).toLocaleString() : "—");
      return `<tr style="border-top:1px solid rgba(255,255,255,0.06);">
        <td style="padding:10px 8px;white-space:nowrap;">${starsVisual(it.stars)}</td>
        <td style="padding:10px 8px;color:var(--text-primary);max-width:340px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(it.comment || "—")}</td>
        <td style="padding:10px 8px;color:var(--text-secondary);word-break:break-all;">${escapeHtml(it.email || "(no email)")}</td>
        <td style="padding:10px 8px;color:var(--text-secondary);text-align:right;font-variant-numeric:tabular-nums;">${fmt(it.answers || 0)}</td>
        <td style="padding:10px 8px;color:var(--text-secondary);white-space:nowrap;">${escapeHtml(when)}</td>
        <td style="padding:10px 8px;text-align:right;"><button class="btn-dark-pill" style="padding:5px 10px;font-size:0.7rem;color:#f43;" data-fb-del="${escapeHtml(it.uid)}|${escapeHtml(it.id)}">Delete</button></td>
      </tr>`;
    }).join("");

    const enabled = data.enabled !== false;
    const pushActive = data.pushActive === true;
    const pushAt = data.pushAt ? new Date(data.pushAt).toLocaleString() : null;
    const audience = data.pushAudience === null || data.pushAudience === undefined ? "…" : fmt(data.pushAudience);
    box.innerHTML = `
      ${warnBanner}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px 16px;margin-bottom:16px;">
        <div>
          <div style="font-weight:700;color:var(--text-primary);">Feedback popup ${enabled ? "unlocked" : "locked"}</div>
          <div style="font-size:0.74rem;color:var(--text-muted);margin-top:2px;">${enabled ? "Eligible users (5+ answers) see it once per account." : "Nobody sees the popup while locked."}</div>
        </div>
        <button class="btn-action ${enabled ? "" : "primary"}" id="admin-feedback-toggle" style="padding:10px 18px;">${enabled ? "Lock popup" : "Unlock popup"}</button>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.25);border-radius:12px;padding:14px 16px;margin-bottom:16px;">
        <div>
          <div style="font-weight:700;color:var(--text-primary);">Push to 5+ answered users ${pushActive ? "(active)" : ""}</div>
          <div style="font-size:0.74rem;color:var(--text-muted);margin-top:2px;">Push the popup once to users with 5 or more answered questions (≈${audience} accounts). Each account still sees it only once, ever. Nothing shows automatically — only while a push is active.${pushAt ? ` Last push: ${escapeHtml(pushAt)}.` : ""}${enabled ? "" : " Unlock the popup first — nothing shows while locked."}</div>
        </div>
        <button class="btn-action ${pushActive ? "" : "primary"}" id="admin-feedback-push" style="padding:10px 18px;" ${enabled ? "" : "disabled"}>${pushActive ? "Stop push" : "Push feedback now"}</button>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px 16px;margin-bottom:16px;">
        <div style="font-size:0.74rem;color:var(--text-muted);flex:1;min-width:200px;">Testing? Clear one account's once-forever flag so the popup can show to it again (while a push is active).</div>
        <input id="admin-feedback-reset-email" placeholder="user@email.com" style="width:220px;padding:9px 12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:0.8rem;">
        <button class="btn-dark-pill" id="admin-feedback-reset" style="padding:9px 14px;font-size:0.75rem;">Reset account</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px;">
        ${statCard("Responses", fmt(stats.total), "submitted ratings", "#f59e0b")}
        ${statCard("Average", stats.total ? stats.avg + " ★" : "—", "mean star rating", "#a78bfa")}
        ${statCard("With Comment", fmt(stats.withComments), "optional comments left", "#22d3ee")}
      </div>
      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px 16px;margin-bottom:16px;">
        <div style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:10px;">Star distribution</div>
        ${distRows}
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">
        <input id="admin-feedback-search" placeholder="Search email or comment…" style="flex:1;min-width:220px;padding:10px 12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:0.85rem;">
        <button class="btn-dark-pill" id="admin-feedback-refresh" style="padding:9px 14px;font-size:0.75rem;">Refresh</button>
      </div>
      <div style="max-height:50vh;overflow-y:auto;border:1px solid rgba(255,255,255,0.08);border-radius:12px;">
        <table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
          <thead><tr style="background:rgba(255,255,255,0.04);">
            <th style="padding:10px 8px;text-align:left;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">Rating</th>
            <th style="padding:10px 8px;text-align:left;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">Comment</th>
            <th style="padding:10px 8px;text-align:left;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">User</th>
            <th style="padding:10px 8px;text-align:right;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">Answers</th>
            <th style="padding:10px 8px;text-align:left;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">Date</th>
            <th style="padding:10px 8px;"></th>
          </tr></thead>
          <tbody id="admin-feedback-rows">${rowsHtml || '<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text-muted);">No feedback yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    document.getElementById("admin-feedback-toggle").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "set_feedback_settings", enabled: !enabled }) });
        loadAdminFeedback();
      } catch (e) {
        alert("Failed: " + e.message);
        btn.disabled = false;
      }
    });
    const pushBtn = document.getElementById("admin-feedback-push");
    if (pushBtn && !pushBtn.disabled) pushBtn.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      if (pushActive || confirm(`Push the feedback popup once to ~${audience} users with 5 or more answered questions? Each account will see it only once, ever.`)) {
        btn.disabled = true;
        try {
          await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "set_feedback_settings", pushActive: !pushActive }) });
          loadAdminFeedback();
        } catch (e) {
          alert("Failed: " + e.message);
          btn.disabled = false;
        }
      }
    });
    document.getElementById("admin-feedback-refresh").addEventListener("click", loadAdminFeedback);
    const resetBtn = document.getElementById("admin-feedback-reset");
    if (resetBtn) resetBtn.addEventListener("click", async () => {
      const input = document.getElementById("admin-feedback-reset-email");
      const email = (input.value || "").trim();
      if (!email) { alert("Enter the account email first."); return; }
      resetBtn.disabled = true;
      try {
        await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "reset_feedback", email }) });
        alert("Reset done — that account will see the popup on next app open (while a push is active).");
        loadAdminFeedback();
      } catch (e) {
        alert("Reset failed: " + e.message);
        resetBtn.disabled = false;
      }
    });
    const search = document.getElementById("admin-feedback-search");
    if (search) search.oninput = () => {
      const q = search.value.toLowerCase();
      document.querySelectorAll("#admin-feedback-rows tr").forEach((r) => {
        r.style.display = r.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    };
    box.querySelectorAll("[data-fb-del]").forEach((b) => {
      b.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const [fuid, fid] = (b.getAttribute("data-fb-del") || "").split("|");
        if (!fuid || !fid || !confirm("Delete this feedback response?")) return;
        try {
          await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "delete_feedback", uid: fuid, id: fid }) });
          loadAdminFeedback();
        } catch (e) {
          alert("Delete failed: " + e.message);
        }
      });
    });
  }

  // ---------- SUPPORT ----------
  let supportState = { status: "all", tickets: [], currentId: null, thread: null };

  async function loadAdminSupport() {
    const box = document.getElementById("admin-support-content");
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Loading tickets…</div>';
    try {
      const data = await api(`/api/support?action=admin_list&status=${encodeURIComponent(supportState.status)}`, { method: "GET" });
      supportState.tickets = data.tickets || [];
      renderSupportTab(box);
    } catch (e) {
      box.innerHTML = `<div style="color:#f43;padding:20px;">${escapeHtml(e.message)}</div>`;
    }
  }

  function renderSupportTab(box) {
    const filterBtn = (v, label) => `<button class="btn-dark-pill support-filter ${supportState.status === v ? "is-active" : ""}" data-filter="${v}" style="padding:6px 12px;font-size:0.75rem;">${label}</button>`;
    const rows = supportState.tickets.map((t) => `
      <tr data-open="${escapeHtml(t.id)}" style="border-top:1px solid rgba(255,255,255,0.06);cursor:pointer;${t.adminUnread ? "background:rgba(6,182,212,0.06);" : ""}">
        <td style="padding:10px 8px;color:var(--text-primary);">
          <div style="font-weight:600;">${escapeHtml(t.subject)}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">${escapeHtml(t.lastMessagePreview || "")}</div>
        </td>
        <td style="padding:10px 8px;color:var(--text-secondary);white-space:nowrap;">${escapeHtml(t.email)}</td>
        <td style="padding:10px 8px;color:var(--text-secondary);white-space:nowrap;">${escapeHtml(t.category)}</td>
        <td style="padding:10px 8px;white-space:nowrap;">
          <span style="padding:3px 8px;border-radius:999px;font-size:0.7rem;font-weight:700;text-transform:uppercase;${t.status === "resolved" ? "background:rgba(34,197,94,0.15);color:#22c55e;" : "background:rgba(6,182,212,0.15);color:#22d3ee;"}">${escapeHtml(t.status)}</span>
        </td>
        <td style="padding:10px 8px;color:var(--text-secondary);white-space:nowrap;">${escapeHtml(relTime(t.lastMessageAt || t.createdAt))}</td>
      </tr>
    `).join("");

    box.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
        ${filterBtn("all", "All")}
        ${filterBtn("open", "Open")}
        ${filterBtn("resolved", "Resolved")}
        <button class="btn-dark-pill" id="admin-support-refresh" style="padding:6px 12px;font-size:0.75rem;margin-left:auto;">Refresh</button>
      </div>
      <div style="max-height:50vh;overflow-y:auto;border:1px solid rgba(255,255,255,0.08);border-radius:12px;">
        <table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
          <thead><tr style="background:rgba(255,255,255,0.04);">
            <th style="padding:10px 8px;text-align:left;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">Ticket</th>
            <th style="padding:10px 8px;text-align:left;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">User</th>
            <th style="padding:10px 8px;text-align:left;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">Category</th>
            <th style="padding:10px 8px;text-align:left;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">Status</th>
            <th style="padding:10px 8px;text-align:left;color:var(--text-muted);font-weight:700;font-size:0.7rem;text-transform:uppercase;">Updated</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-muted);">No tickets.</td></tr>'}</tbody>
        </table>
      </div>
      <div id="admin-support-thread"></div>
    `;
    box.querySelectorAll(".support-filter").forEach((b) => {
      b.addEventListener("click", () => {
        supportState.status = b.getAttribute("data-filter");
        loadAdminSupport();
      });
    });
    box.querySelector("#admin-support-refresh").addEventListener("click", loadAdminSupport);
    box.querySelectorAll("tr[data-open]").forEach((tr) => {
      tr.addEventListener("click", () => openAdminThread(tr.getAttribute("data-open")));
    });
  }

  async function openAdminThread(id) {
    const host = document.getElementById("admin-support-thread");
    if (!host) return;
    host.innerHTML = '<div style="margin-top:16px;padding:16px;color:var(--text-muted);text-align:center;">Loading conversation…</div>';
    try {
      const data = await api(`/api/support?action=thread&id=${encodeURIComponent(id)}`, { method: "GET" });
      supportState.currentId = id;
      supportState.thread = data;
      renderAdminThread(host);
    } catch (e) {
      host.innerHTML = `<div style="margin-top:16px;color:#f43;">${escapeHtml(e.message)}</div>`;
    }
  }

  function renderAdminThread(host) {
    const t = supportState.thread.ticket;
    const msgs = (supportState.thread.messages || []).map((m) => `
      <div style="display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:10px;max-width:85%;${m.from === "admin" ? "align-self:flex-end;background:linear-gradient(135deg,rgba(6,182,212,0.15),rgba(139,92,246,0.15));border:1px solid rgba(6,182,212,0.3);" : "align-self:flex-start;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);"}">
        <div style="display:flex;justify-content:space-between;gap:10px;font-size:0.7rem;color:var(--text-muted);">
          <strong style="color:var(--text-primary);">${m.from === "admin" ? "You (Admin)" : escapeHtml(m.authorEmail || "User")}</strong>
          <span>${escapeHtml(new Date(m.createdAt || Date.now()).toLocaleString())}</span>
        </div>
        <div style="color:var(--text-primary);font-size:0.85rem;line-height:1.4;white-space:pre-wrap;">${escapeHtml(m.text)}</div>
      </div>
    `).join("");
    host.innerHTML = `
      <div style="margin-top:16px;padding:16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px;">
          <div>
            <div style="font-weight:700;color:var(--text-primary);">${escapeHtml(t.subject)}</div>
            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px;">${escapeHtml(t.email)} · ${escapeHtml(t.category)} · ${escapeHtml(t.status)}</div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn-dark-pill" id="admin-support-toggle" style="padding:6px 12px;font-size:0.75rem;">${t.status === "resolved" ? "Reopen" : "Mark resolved"}</button>
            <button class="btn-dark-pill" id="admin-support-delete" style="padding:6px 12px;font-size:0.75rem;color:#f43;">Delete</button>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;max-height:340px;overflow-y:auto;padding:8px;background:rgba(0,0,0,0.15);border-radius:10px;margin-bottom:10px;">${msgs || '<div style="color:var(--text-muted);text-align:center;padding:20px;">No messages.</div>'}</div>
        <div style="display:flex;gap:8px;">
          <textarea id="admin-support-reply" placeholder="Reply to user…" maxlength="4000" style="flex:1;min-height:70px;padding:10px 12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:var(--text-primary);font-family:inherit;font-size:0.85rem;resize:vertical;"></textarea>
          <button class="btn-action primary" id="admin-support-send" style="padding:10px 18px;align-self:flex-end;">Send</button>
        </div>
      </div>
    `;
    document.getElementById("admin-support-send").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      const ta = document.getElementById("admin-support-reply");
      const text = (ta.value || "").trim();
      if (!text || btn.disabled) return;
      btn.disabled = true;
      try {
        await api("/api/support", { method: "POST", body: JSON.stringify({ action: "reply", id: supportState.currentId, message: text }) });
        ta.value = "";
        await openAdminThread(supportState.currentId);
        loadAdminSupport();
      } catch (e) { alert(e.message); }
      finally { btn.disabled = false; }
    });
    document.getElementById("admin-support-toggle").addEventListener("click", async () => {
      const newStatus = t.status === "resolved" ? "open" : "resolved";
      try {
        await api("/api/support", { method: "POST", body: JSON.stringify({ action: "admin_set_status", id: supportState.currentId, status: newStatus }) });
        await openAdminThread(supportState.currentId);
        loadAdminSupport();
      } catch (e) { alert(e.message); }
    });
    document.getElementById("admin-support-delete").addEventListener("click", async () => {
      if (!confirm("Delete this ticket and all messages?")) return;
      try {
        await api("/api/support", { method: "POST", body: JSON.stringify({ action: "admin_delete", id: supportState.currentId }) });
        supportState.currentId = null;
        supportState.thread = null;
        document.getElementById("admin-support-thread").innerHTML = "";
        loadAdminSupport();
      } catch (e) { alert(e.message); }
    });
  }

  // --- AI Model Debug Widget (Admin Only) ---
  window.showAdminAiDebug = function(meta) {
    if (!meta || !meta.provider) return;

    let widget = document.getElementById("admin-ai-debug-widget");
    if (!widget) {
      widget = document.createElement("div");
      widget.id = "admin-ai-debug-widget";
      widget.style.position = "fixed";
      widget.style.bottom = "20px";
      widget.style.right = "20px";
      widget.style.backgroundColor = "var(--bg-card)";
      widget.style.border = "1px solid var(--border)";
      widget.style.borderRadius = "8px";
      widget.style.padding = "10px 14px";
      widget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";
      widget.style.zIndex = "999999";
      widget.style.fontFamily = "var(--font-sans)";
      widget.style.fontSize = "0.75rem";
      widget.style.color = "var(--text-primary)";
      widget.style.cursor = "pointer";
      widget.style.userSelect = "none";
      document.body.appendChild(widget);
    }

    const summaryStr = `🤖 ${meta.provider} · ${meta.model} (${meta.ms}ms)`;

    let chainHtml = "";
    if (meta.chain && Array.isArray(meta.chain) && meta.chain.length > 0) {
      const isOverriding = !!window.adminAiOverride;
      chainHtml = `<div id="admin-ai-debug-dropdown" style="display:none; margin-top:10px; border-top:1px solid var(--border); padding-top:8px;">
        <div style="font-weight:600; margin-bottom:6px; color:var(--text-secondary);">Override next run for ${meta.task}:</div>
        ${meta.chain.map((c, i) => `
          <div class="admin-ai-debug-option" data-provider="${c.provider}" data-model="${c.model}" style="padding:4px 6px; border-radius:4px; margin-bottom:2px; transition:background-color 0.1s; display:flex; justify-content:space-between;">
            <span>${c.provider}</span> <span style="color:var(--text-muted);">${c.model}</span>
          </div>
        `).join('')}
        <div class="admin-ai-debug-clear" style="padding:4px 6px; border-radius:4px; margin-top:4px; text-align:center; color:var(--danger); font-weight:500;">
          ${isOverriding ? "Clear Override" : "Close"}
        </div>
      </div>`;
    }

    widget.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-weight:500;">${window.adminAiOverride ? '<span style="color:var(--accent);">[Forced]</span>' : 'Last Action:'}</span> 
        <span style="color:var(--text-secondary);">${summaryStr}</span>
      </div>
      ${chainHtml}
    `;

    // Dropdown toggle
    widget.onclick = function(e) {
      if (e.target.closest('.admin-ai-debug-option') || e.target.closest('.admin-ai-debug-clear')) return;
      const dd = document.getElementById("admin-ai-debug-dropdown");
      if (dd) dd.style.display = dd.style.display === "none" ? "block" : "none";
    };

    // Option click handlers
    const options = widget.querySelectorAll('.admin-ai-debug-option');
    options.forEach(opt => {
      opt.addEventListener('mouseenter', () => opt.style.backgroundColor = "var(--bg-hover)");
      opt.addEventListener('mouseleave', () => opt.style.backgroundColor = "transparent");
      opt.onclick = function() {
        const p = this.dataset.provider;
        const m = this.dataset.model;
        window.adminAiOverride = { provider: p, model: m };
        widget.innerHTML = `<div style="display:flex; align-items:center; gap:8px;">
          <span style="color:var(--accent); font-weight:600;">Next action forced to:</span>
          <span>${p} · ${m}</span>
        </div>`;
      };
    });

    const clearBtn = widget.querySelector('.admin-ai-debug-clear');
    if (clearBtn) {
      clearBtn.addEventListener('mouseenter', () => clearBtn.style.backgroundColor = "var(--bg-hover)");
      clearBtn.addEventListener('mouseleave', () => clearBtn.style.backgroundColor = "transparent");
      clearBtn.onclick = function() {
        window.adminAiOverride = null;
        widget.style.display = "none";
      };
    }
  };

  // ---------- QBANK ----------
  // ---------- QBANK RESOURCES REVAMP ----------
  window.adminQBankResources = window.adminQBankResources || {};

  window.adminOpenResourcesModal = function(qbankId, qbankName) {
    let modal = document.getElementById("admin-resources-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "admin-resources-modal";
      modal.className = "modal";
      document.body.appendChild(modal);
    }
    
    // Migrate flat resources to a root category if needed
    let resArr = window.adminQBankResources[qbankId] || [];
    if (resArr.length > 0 && !resArr[0].isCategory) {
        window.adminQBankResources[qbankId] = [
            { id: Date.now().toString(36), isCategory: true, title: "General Resources", type: "category", items: resArr }
        ];
    }
    
    window.renderAdminResourcesModalUI(qbankId, qbankName);
    modal.style.display = "flex";
  };
  
  window.renderAdminResourcesModalUI = function(qbankId, qbankName) {
      const modal = document.getElementById("admin-resources-modal");
      if(!modal) return;
      const resArr = window.adminQBankResources[qbankId] || [];
      
      let html = `
        <div class="modal-content" style="max-width: 850px; width: 100%; max-height: 90vh; display: flex; flex-direction: column;">
          <button class="exam-close-btn" onclick="document.getElementById('admin-resources-modal').style.display='none'"><i data-lucide="x"></i></button>
          <div class="exam-title" style="margin-bottom: 18px;"><i data-lucide="library"></i> Manage Study Resources: ${escapeHtml(qbankName)}</div>
          
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom:16px;">
            <div style="display:flex; gap:12px;">
                <input type="text" id="admin-res-newcat-input" class="login-input" placeholder="New Category Name (e.g. Cardiology)" style="margin:0; min-width:250px; font-size:0.85rem; padding:8px 12px;">
                <button class="btn-action primary" style="padding:8px 16px;" onclick="window.adminAddResourceCategory('${escapeHtml(qbankId)}', '${escapeHtml(qbankName).replace(/'/g, "\\'")}')"><i data-lucide="folder-plus"></i> Add Category</button>
            </div>
            <button class="btn-dark-pill" style="color:var(--accent-cyan); padding:8px 24px; font-weight:bold;" onclick="window.adminSaveQBankSettings('${escapeHtml(qbankId)}'); document.getElementById('admin-resources-modal').style.display='none';">Save & Close</button>
          </div>
          
          <div style="flex: 1; overflow-y: auto; display:flex; flex-direction:column; gap: 16px; padding-right:8px;" id="admin-resources-tree">
            ${resArr.map((cat, catIndex) => {
                let itemsHtml = (cat.items || []).map((item, itemIndex) => {
                    let icon = 'link';
                    let color = 'var(--text-primary)';
                    if (item.type === 'youtube') { icon = 'play-circle'; color = '#ef4444'; }
                    if (item.type === 'pdf') { icon = 'file-text'; color = '#3b82f6'; }
                    if (item.type === 'flashcards') { icon = 'credit-card'; color = '#eab308'; }
                    return `
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; background:rgba(255,255,255,0.03); padding:12px 16px; border-radius:8px; margin-top:8px; border:1px solid rgba(255,255,255,0.02);">
                            <div style="display:flex; flex-direction:column; gap:6px; flex:1; overflow:hidden;">
                                <div style="display:flex; align-items:center; gap:8px;">
                                    <i data-lucide="${icon}" style="color:${color}; width:18px; height:18px;"></i>
                                    <strong style="color:var(--text-primary); font-size:0.95rem;">${escapeHtml(item.title)}</strong>
                                </div>
                                ${item.description ? `<div style="font-size:0.85rem; color:var(--text-muted); line-height:1.5; margin-left:26px;">${escapeHtml(item.description)}</div>` : ''}
                                <a href="${escapeHtml(item.url)}" target="_blank" style="color:var(--accent-cyan); font-size:0.75rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:inline-block; max-width:400px; opacity:0.8; margin-left:26px; transition:opacity 0.2s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.8'">${escapeHtml(item.url)}</a>
                            </div>
                            <button class="btn-dark-pill" style="color:var(--danger); padding:6px 12px; font-size:0.8rem; margin-left:16px;" onclick="window.adminRemoveResourceItem('${escapeHtml(qbankId)}', '${escapeHtml(qbankName).replace(/'/g, "\\'")}', ${catIndex}, ${itemIndex})">Remove</button>
                        </div>
                    `;
                }).join('');
                
                return `
                <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05); border-radius:12px; padding:20px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:12px;">
                        <div style="display:flex; align-items:center; gap:10px; font-size:1.15rem; font-weight:bold; color:var(--text-primary);">
                            <i data-lucide="folder"></i> ${escapeHtml(cat.title)}
                        </div>
                        <div style="display:flex; gap:10px;">
                            <button class="btn-dark-pill" style="color:var(--danger); padding:6px 12px; font-size:0.8rem;" onclick="window.adminRemoveResourceCategory('${escapeHtml(qbankId)}', '${escapeHtml(qbankName).replace(/'/g, "\\'")}', ${catIndex})">Delete Category</button>
                        </div>
                    </div>
                    
                    <div style="margin-bottom:16px; background:rgba(0,0,0,0.2); padding:16px; border-radius:8px; border:1px solid rgba(255,255,255,0.03);">
                        <div style="font-size:0.85rem; font-weight:bold; color:var(--text-secondary); margin-bottom:12px;">Add New Item to "${escapeHtml(cat.title)}"</div>
                        <div style="display:grid; grid-template-columns: 1fr 2fr 100px; gap:8px; margin-bottom:8px;">
                            <input type="text" id="admin-res-title-${catIndex}" class="login-input" placeholder="Item Title" style="margin:0; font-size:0.85rem; padding:8px 12px;">
                            <input type="text" id="admin-res-url-${catIndex}" class="login-input" placeholder="https://..." style="margin:0; font-size:0.85rem; padding:8px 12px;">
                            <select id="admin-res-type-${catIndex}" class="login-input" style="margin:0; font-size:0.85rem; padding:8px;">
                                <option value="youtube">YouTube</option>
                                <option value="pdf">PDF</option>
                                <option value="flashcards">Flashcards</option>
                                <option value="link">Link</option>
                            </select>
                        </div>
                        <div style="display:flex; gap:8px;">
                            <input type="text" id="admin-res-desc-${catIndex}" class="login-input" placeholder="Optional description or instructions for the student..." style="margin:0; font-size:0.85rem; padding:8px 12px; flex:1;">
                            <button class="btn-dark-pill" style="color:var(--accent-purple); padding:8px 24px; font-weight:bold;" onclick="window.adminAddResourceItem('${escapeHtml(qbankId)}', '${escapeHtml(qbankName).replace(/'/g, "\\'")}', ${catIndex})">Add</button>
                        </div>
                    </div>
                    
                    <div>${itemsHtml || '<div style="color:var(--text-muted); font-size:0.85rem; padding:8px; font-style:italic;">No resources in this category yet. Use the form above to add one.</div>'}</div>
                </div>
                `;
            }).join('') || '<div style="text-align:center; color:var(--text-muted); padding:60px 20px; font-size:1.1rem; border:1px dashed rgba(255,255,255,0.1); border-radius:12px;">No resources found. Create your first category above to start organizing study materials!</div>'}
          </div>
        </div>
      `;
      modal.innerHTML = html;
      if (window.lucide) window.lucide.createIcons();
  };
  
  window.adminAddResourceCategory = function(qbankId, qbankName) {
      const input = document.getElementById("admin-res-newcat-input");
      const title = input.value;
      if(!title || !title.trim()) return alert("Enter a category name.");
      if (!window.adminQBankResources[qbankId]) window.adminQBankResources[qbankId] = [];
      window.adminQBankResources[qbankId].push({
          id: Date.now().toString(36),
          isCategory: true,
          type: "category",
          title: title.trim(),
          items: []
      });
      window.renderAdminResourcesModalUI(qbankId, qbankName);
  };
  
  window.adminRemoveResourceCategory = function(qbankId, qbankName, catIndex) {
      if(confirm("Are you sure you want to delete this entire category AND all its resources?")) {
          window.adminQBankResources[qbankId].splice(catIndex, 1);
          window.renderAdminResourcesModalUI(qbankId, qbankName);
      }
  };
  
  window.adminAddResourceItem = function(qbankId, qbankName, catIndex) {
      const typeSelect = document.getElementById(`admin-res-type-${catIndex}`);
      const titleInput = document.getElementById(`admin-res-title-${catIndex}`);
      const urlInput = document.getElementById(`admin-res-url-${catIndex}`);
      const descInput = document.getElementById(`admin-res-desc-${catIndex}`);
      
      const type = typeSelect.value;
      const title = titleInput.value.trim();
      let url = urlInput.value.trim();
      const desc = descInput.value.trim();
      
      if(!title) return alert("Please provide a title for this resource.");
      if(!url) return alert("Please provide a valid URL.");
      
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'https://' + url;
      }
      
      window.adminQBankResources[qbankId][catIndex].items.push({
          id: Date.now().toString(36) + Math.random().toString(36).substr(2),
          type: type,
          title: title,
          url: url,
          description: desc
      });
      window.renderAdminResourcesModalUI(qbankId, qbankName);
  };
  
  window.adminRemoveResourceItem = function(qbankId, qbankName, catIndex, itemIndex) {
      if(confirm("Remove this resource item?")) {
          window.adminQBankResources[qbankId][catIndex].items.splice(itemIndex, 1);
          window.renderAdminResourcesModalUI(qbankId, qbankName);
      }
  };

  async function loadAdminQBank() {
    const list = document.getElementById("admin-qbank-list");
    const select = document.getElementById("admin-qbank-select");
    if (!list || !select) return;
    
    list.innerHTML = '<div style="color:var(--text-muted);text-align:center;">Loading...</div>';
    try {
      const res = await api("/api/admin?action=list_qbanks", { method: "GET" });
      let qbanks = res.qbanks || [];
      qbanks = qbanks.filter(q => q.kind !== "exam_prep");
      
      if (qbanks.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);">No QBanks created yet.</div>';
        select.innerHTML = '<option value="">No QBanks available</option>';
      } else {
        const flags = { global: "🌍", usa: "🇺🇸", uk: "🇬🇧", australia: "🇦🇺", canada: "🇨🇦", india: "🇮🇳", europe: "🇪🇺", tunisia: "🇹🇳", algeria: "🇩🇿", egypt: "🇪🇬" };
        list.innerHTML = qbanks.map(q => {
          const flag = flags[q.country] || "🌍";
          const currentSubcats = (q.subcategories || "").replace(/'/g, "\\'");
          return `
          <div style="padding:12px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; display:flex; flex-direction:column; gap:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <div>
                <div style="font-weight:600; color:var(--text-primary); display:flex; align-items:center; gap:8px;">
                  <span>${flag}</span>${escapeHtml(q.name)}
                  <span id="admin-qbank-count-${escapeHtml(q.id)}" style="font-size:0.75rem; background:var(--accent-cyan); color:#000; padding:2px 8px; border-radius:12px; font-weight:800; display:none;">0 Qs</span>
                </div>
                <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;" title="${escapeHtml(q.subcategories || 'None')}">Rules: ${escapeHtml(q.subcategories || "None")}</div>
              </div>
              <div>
                <button class="btn-dark-pill" style="color:var(--accent-purple); margin-right:8px;" onclick="document.getElementById('admin-qbank-edit-${escapeHtml(q.id)}').style.display='flex'">Settings</button>
                <button class="btn-dark-pill" style="color:#34d399; margin-right:8px;" onclick="window.adminOpenGlobalBatchImport('${escapeHtml(q.id)}', '${escapeHtml(q.name).replace(/'/g, "\\'")}')">Batch Import</button>
                <button id="admin-qbank-publish-${escapeHtml(q.id)}" class="btn-dark-pill" style="color:#fcd34d; margin-right:8px;" onclick="window.adminPublishQBankChunks('${escapeHtml(q.id)}', 'admin-qbank-publish-${escapeHtml(q.id)}')">Publish Chunks</button>
                <button class="btn-dark-pill" style="color:var(--accent-cyan); margin-right:8px;" onclick="window.adminManageQBank('${escapeHtml(q.id)}', '${escapeHtml(q.name).replace(/'/g, "\\'")}')">Manage Questions</button>
                <button class="btn-dark-pill" style="color:var(--danger);" onclick="window.adminDeleteQBank('${escapeHtml(q.id)}')">Delete</button>
              </div>
            <div id="admin-qbank-edit-${escapeHtml(q.id)}" style="display:none; flex-direction:column; gap:10px; align-items:stretch; margin-top:4px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.05);">
              <input type="text" id="admin-qbank-input-${escapeHtml(q.id)}" class="login-input" value="${escapeHtml(q.subcategories || "")}" placeholder="Comma-separated rules...">
              <div style="display:flex; gap:20px; align-items:center; font-size:0.9rem; color:var(--text-secondary);">
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                  <input type="checkbox" id="admin-qbank-locked-${escapeHtml(q.id)}" ${q.isLocked ? "checked" : ""} style="appearance:auto; width:16px; height:16px; cursor:pointer; accent-color:var(--accent-cyan);"> Under Maintenance (Locked)
                </label>
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                  <input type="checkbox" id="admin-qbank-partylocked-${escapeHtml(q.id)}" ${q.isPartyLocked ? "checked" : ""} style="appearance:auto; width:16px; height:16px; cursor:pointer; accent-color:var(--accent-cyan);"> Disable Answer Party
                </label>
              </div>
              <div style="margin-top:2px; margin-bottom:4px; padding:10px 0;">
                <button class="btn-dark-pill" style="color:var(--primary-container); border:1px solid var(--primary-container); padding:8px 16px; width:100%; display:flex; justify-content:center; align-items:center; gap:8px;" onclick="window.adminOpenResourcesModal('${escapeHtml(q.id)}', '${escapeHtml(q.name).replace(/'/g, "\\'")}')">
                    <i data-lucide="library" style="width:18px;height:18px;"></i> Manage Study Resources
                </button>
              </div>
              <div style="display:flex; gap:10px;">
                <button class="btn-dark-pill" style="color:var(--accent-cyan);" onclick="window.adminSaveQBankSettings('${escapeHtml(q.id)}')">Save Settings</button>
                <button class="btn-dark-pill" onclick="document.getElementById('admin-qbank-edit-${escapeHtml(q.id)}').style.display='none'">Cancel</button>
              </div>
            </div>
          </div>
        `}).join('');
        
        select.innerHTML = '<option value="">Select QBank...</option>' + qbanks.map(q => {
          const flag = flags[q.country] || "🌍";
          return `<option value="${escapeHtml(q.id)}">${flag} ${escapeHtml(q.name)}</option>`
        }).join('');
        
        // Asynchronously fetch counts
        qbanks.forEach(async q => {
          window.adminQBankResources[q.id] = q.resources || [];
          try {
            const countRes = await api(`/api/admin?action=get_qbank_question_count&qbankId=${q.id}`, { method: "GET" });
            const countEl = document.getElementById(`admin-qbank-count-${q.id}`);
            if (countEl) {
              countEl.textContent = `${countRes.count} Qs`;
              countEl.style.display = "inline-block";
            }
          } catch (e) { console.error("Failed to fetch count for", q.name, e); }
        });
      }
    } catch (e) {
      list.innerHTML = `<div style="color:#f43;">Error: ${escapeHtml(e.message)}</div>`;
    }
  }
  window.loadAdminQBank = loadAdminQBank;

  window.adminPublishQBankChunks = async function(id, btnId) {
     const btn = document.getElementById(btnId);
     if (btn) {
         btn.disabled = true;
         btn.innerText = "Publishing...";
     }
     try {
       const res = await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "publish_qbank_chunks", qbankId: id }) });
       if (res.ok) {
           alert("Successfully published " + res.totalQuestions + " questions into " + res.chunksGenerated + " chunks!");
       } else {
           alert("Failed to publish: " + (res.error || "Unknown error"));
       }
     } catch (e) {
       alert("Error publishing: " + e.message);
     }
     if (btn) {
         btn.disabled = false;
         btn.innerText = "Publish Chunks";
     }
  };

  window.adminCreateQBank = async function() {
    const input = document.getElementById("admin-qbank-name-input");
    const countrySel = document.getElementById("admin-qbank-country-input");
    const subcatsInput = document.getElementById("admin-qbank-create-subcats");
    const name = input.value.trim();
    const country = countrySel ? countrySel.value : "global";
    const subcategories = subcatsInput ? subcatsInput.value.trim() : "";
    
    if (!name) return alert("Enter a name");
    try {
      await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "create_qbank", qbankName: name, country, subcategories }) });
      input.value = "";
      if (subcatsInput) subcatsInput.value = "";
      loadAdminQBank();
    } catch (e) { alert("Failed: " + e.message); }
  };

  window.adminSaveQBankSettings = async function(id) {
    const input = document.getElementById(`admin-qbank-input-${id}`);
    const lockedInput = document.getElementById(`admin-qbank-locked-${id}`);
    const partyLockedInput = document.getElementById(`admin-qbank-partylocked-${id}`);
    if (!input) return;
    try {
      await api("/api/admin", { 
        method: "POST", 
        body: JSON.stringify({ 
          action: "edit_qbank_settings", 
          qbankId: id, 
          subcategories: input.value.trim(),
          isLocked: lockedInput ? lockedInput.checked : false,
          isPartyLocked: partyLockedInput ? partyLockedInput.checked : false,
          resources: window.adminQBankResources[id] || []
        }) 
      });
      loadAdminQBank();
    } catch (e) { alert("Failed: " + e.message); }
  };

  window.adminDeleteQBank = async function(id) {
    if (!confirm("Are you sure? This will delete the category.")) return;
    try {
      await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "delete_qbank", qbankId: id }) });
      loadAdminQBank();
    } catch (e) { alert("Failed: " + e.message); }
  };

  let currentAdminQBankId = null;
  let currentAdminQuestions = [];

  window.adminManageQBank = async function(id, name) {
    document.getElementById("admin-qbank-list").style.display = "none";
    document.getElementById("admin-qbank-manage-area").style.display = "block";
    document.getElementById("admin-qbank-manage-title").textContent = `Questions in ${name}`;
    currentAdminQBankId = id;
    
    const list = document.getElementById("admin-qbank-manage-list");
    list.innerHTML = `
      <div style="margin-bottom:15px; display:flex; justify-content:flex-end; gap:8px;">
         <button class="btn-action primary" style="font-size:0.8rem; padding:6px 12px;" onclick="window.adminOpenBatchImport('${id}')">Batch Import (TXT)</button>
         <button class="btn-dark-pill" style="font-size:0.8rem; color:var(--text-secondary);" onclick="window.adminBackfillQBankCodes('${id}')">Backfill Missing Codes</button>
         <button class="btn-dark-pill" style="font-size:0.8rem; color:#f59e0b;" onclick="window.adminRegenerateQBankCodes('${id}')">♻ Regenerate All IDs</button>
      </div>
      <div id="admin-batch-import-area" style="display:none; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:16px; margin-bottom:15px;"></div>
      <div id="admin-qbank-manage-list-content" style="color:var(--text-muted);text-align:center;">Loading questions...</div>
    `;
    const listContent = document.getElementById("admin-qbank-manage-list-content");
    
    try {
      const res = await api(`/api/admin`, { method: "POST", body: JSON.stringify({ action: "list_qbank_questions", qbankId: id }) });
      const questions = res.questions || [];
      currentAdminQuestions = questions;
      
      if (questions.length === 0) {
        listContent.innerHTML = '<div style="color:var(--text-muted);">No questions added to this QBank yet.</div>';
      } else {
        listContent.innerHTML = questions.map(q => {
           let parsedData = {};
           try { parsedData = JSON.parse(q.data); } catch(e){}
           const snippet = escapeHtml(q.questionText).substring(0, 100) + "...";
           
           let reportsHtml = "";
           if (q.reported && q.reports && q.reports.length > 0) {
             const reasons = q.reports.map(r => window.formatReportReason(r.reason?.stringValue)).join(" | ");
             reportsHtml = `
               <div style="margin-top:10px; padding:10px; background:rgba(244,63,94,0.1); border:1px solid rgba(244,63,94,0.2); border-radius:8px;">
                 <div style="color:#f43f5e; font-size:0.85rem; font-weight:700; margin-bottom:5px;"><i data-lucide="flag" style="width:14px;height:14px;vertical-align:-2px;"></i> Reported (${q.reports.length})</div>
                 <div style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:8px;">${escapeHtml(reasons)}</div>
                 <button class="btn-dark-pill" style="font-size:0.75rem; padding:4px 8px;" onclick="window.adminClearQBankReports('${id}', '${q.id}')">Clear Reports</button>
               </div>
             `;
           }

           const codeBadge = parsedData.code ? `<span style="font-size:0.75rem; padding:2px 6px; background:rgba(255,255,255,0.1); border-radius:4px; margin-right:8px; font-family:monospace;">${escapeHtml(parsedData.code)}</span>` : "";
           const tagsHtml = (parsedData.tags || []).map(t => `<span style="font-size:0.7rem; padding:2px 6px; background:rgba(167, 139, 250, 0.15); border:1px solid rgba(167, 139, 250, 0.3); border-radius:4px; color:#a78bfa; margin-right:4px;">#${escapeHtml(t)}</span>`).join("");
           const subjectBadge = parsedData.subject && parsedData.subject !== "Uncategorized" ? `<span style="font-size:0.7rem; padding:2px 6px; background:rgba(34, 211, 238, 0.15); border:1px solid rgba(34, 211, 238, 0.3); border-radius:4px; color:#22d3ee; margin-right:4px;">${escapeHtml(parsedData.subject)}</span>` : "";

           return `
            <div style="padding:12px; background:rgba(255,255,255,0.03); border:1px solid ${q.reported ? 'rgba(244,63,94,0.3)' : 'rgba(255,255,255,0.08)'}; border-radius:8px; display:flex; flex-direction:column; gap:10px;">
              <div style="font-size:0.95rem; color:var(--text-primary); display:flex; gap:10px; align-items:flex-start;">
                <input type="checkbox" class="qbank-delete-checkbox" value="${q.id}" style="margin-top:4px; cursor:pointer;">
                <div style="flex:1;">
                   <div style="margin-bottom:6px;">${codeBadge}${subjectBadge}${tagsHtml}</div>
                   <span>${snippet}</span>
                </div>
              </div>
              ${reportsHtml}
              <div id="admin-qbank-editor-${q.id}" style="display:none; padding:15px; background:rgba(0,0,0,0.2); border-radius:8px; gap:10px; flex-direction:column; margin-bottom:10px;">
                 <label style="font-size:0.8rem; color:var(--text-secondary);">Question Text</label>
                 <textarea id="edit-qtext-${q.id}" class="login-input" rows="3">${escapeHtml(q.questionText)}</textarea>
                 
                 <label style="font-size:0.8rem; color:var(--text-secondary);">Subject</label>
                 <input type="text" id="edit-qsubject-${q.id}" class="login-input" value="${escapeHtml(parsedData.subject || '')}">
                 
                 <label style="font-size:0.8rem; color:var(--text-secondary);">Chapter</label>
                 <input type="text" id="edit-qchapter-${q.id}" class="login-input" value="${escapeHtml(parsedData.chapter || '')}">
                 
                 <label style="font-size:0.8rem; color:var(--text-secondary);">Tags (comma separated)</label>
                 <input type="text" id="edit-qtags-${q.id}" class="login-input" value="${escapeHtml((parsedData.tags || []).join(', '))}">
                 
                 <label style="font-size:0.8rem; color:var(--text-secondary);">Options & Correct Answers</label>
                 <div id="edit-qoptions-${q.id}" style="display:flex; flex-direction:column; gap:5px;">
                    ${(parsedData.options || []).map((opt, i) => `
                      <div class="edit-qoption-row" style="display:flex; gap:8px; align-items:center;">
                         <input type="checkbox" class="edit-qoption-correct" ${parsedData.correctIndices?.includes(i) ? 'checked' : ''} style="cursor:pointer; width:16px; height:16px;">
                         <input type="text" class="login-input edit-qoption-text" style="flex:1;" value="${escapeHtml(opt)}">
                         <button class="btn-dark-pill" style="padding:4px 8px; color:var(--danger);" onclick="this.parentElement.remove()">X</button>
                      </div>
                    `).join('')}
                 </div>
                 <button class="btn-dark-pill" style="align-self:flex-start; margin-top:5px; font-size:0.75rem;" onclick="window.adminAddQBankOption('${q.id}')">+ Add Option</button>
                 
                 <label style="font-size:0.8rem; color:var(--text-secondary); margin-top:10px;">Explanation</label>
                 <textarea id="edit-qexplanation-${q.id}" class="login-input" rows="3">${escapeHtml(parsedData.explanation || '')}</textarea>
              </div>
              <textarea id="admin-qbank-qdata-${q.id}" style="display:none;">${escapeHtml(q.data)}</textarea>
              <div style="display:flex; gap:8px;">
                <button class="btn-dark-pill" onclick="window.adminEditQuestion('${id}', '${q.id}')">✎ Edit Question</button>
                <button class="btn-dark-pill" style="color:var(--danger);" onclick="window.adminDeleteQBankQuestion('${q.id}')">Delete</button>
              </div>
            </div>
           `;
        }).join('');
      }
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    } catch(e) {
      listContent.innerHTML = `<div style="color:#f43;">Error: ${escapeHtml(e.message)}</div>`;
    }
  };

  window.adminCloseManageQBank = function() {
    document.getElementById("admin-qbank-list").style.display = "flex";
    document.getElementById("admin-qbank-manage-area").style.display = "none";
    currentAdminQBankId = null;
  };

  // Shared rich-text editor launcher. Works from both Manage Questions
  // (currentAdminQuestions) and Reported Questions (fetches on demand).
  window.adminEditQuestion = async function(qbankId, questionId, isReported) {
    let raw = null;
    // Fast path: question list already in memory
    if (!isReported && currentAdminQBankId === qbankId) {
      const found = currentAdminQuestions.find(q => q.id === questionId);
      if (found) raw = found;
    }
    if (!raw) {
      try {
        const res = await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "list_qbank_questions", qbankId }) });
        raw = (res.questions || []).find(q => q.id === questionId);
      } catch (e) { return alert("Failed to load question: " + e.message); }
    }
    if (!raw) return alert("Question not found.");

    let parsedData = {};
    try { parsedData = JSON.parse(raw.data); } catch (e) {}

    window.openRichQuestionEditor({
      qbankId,
      questionId,
      questionText: raw.questionText,
      data: parsedData,
      onSave: async (payload) => {
        await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "update_qbank_question", qbankId, questionId, ...payload }) });
        // Sync the live session cache so students/editors see changes instantly
        try {
          const parsed = JSON.parse(payload.dataJson);
          delete parsed.questionText;
          window.qbankPatchCachedQuestion && window.qbankPatchCachedQuestion(qbankId, questionId, payload.questionText, parsed);
          const local = currentAdminQuestions.find(q => q.id === questionId);
          if (local) { local.questionText = payload.questionText; local.data = payload.dataJson; }
        } catch (e) {}
        alert("Question updated successfully.");
        if (!isReported && currentAdminQBankId === qbankId) {
          window.adminManageQBank(qbankId, document.getElementById("admin-qbank-manage-title").textContent.replace("Questions in ", ""));
        } else {
          loadAdminReports();
        }
      }
    });
  };

  window.adminToggleEditQBankQuestion = function(id) {
    const editor = document.getElementById(`admin-qbank-editor-${id}`);
    const saveBtn = document.getElementById(`admin-qbank-savebtn-${id}`);
    const isVisible = editor.style.display !== "none";
    
    editor.style.display = isVisible ? "none" : "flex";
    saveBtn.style.display = isVisible ? "none" : "block";
  };

  window.adminAddQBankOption = function(id) {
    const container = document.getElementById(`edit-qoptions-${id}`);
    const div = document.createElement("div");
    div.className = "edit-qoption-row";
    div.style.cssText = "display:flex; gap:8px; align-items:center;";
    div.innerHTML = `
       <input type="checkbox" class="edit-qoption-correct" style="cursor:pointer; width:16px; height:16px;">
       <input type="text" class="login-input edit-qoption-text" style="flex:1;" value="">
       <button class="btn-dark-pill" style="padding:4px 8px; color:var(--danger);" onclick="this.parentElement.remove()">X</button>
    `;
    container.appendChild(div);
  };

  window.adminSaveQBankQuestion = async function(id) {
    if (!currentAdminQBankId) return;
    
    const qtext = document.getElementById(`edit-qtext-${id}`).value;
    const subject = document.getElementById(`edit-qsubject-${id}`).value;
    const chapter = document.getElementById(`edit-qchapter-${id}`).value;
    const tagsStr = document.getElementById(`edit-qtags-${id}`).value;
    const tags = tagsStr.split(',').map(s => s.trim()).filter(s => s);
    const explanation = document.getElementById(`edit-qexplanation-${id}`).value;
    
    const optionsContainer = document.getElementById(`edit-qoptions-${id}`);
    const rows = optionsContainer.querySelectorAll('.edit-qoption-row');
    let options = [];
    let correctIndices = [];
    
    rows.forEach((row, idx) => {
       const isCorrect = row.querySelector('.edit-qoption-correct').checked;
       const text = row.querySelector('.edit-qoption-text').value;
       options.push(text);
       if (isCorrect) correctIndices.push(idx);
    });
    
    // Retain previous hidden properties (like code and createdAt)
    const originalDataRaw = document.getElementById(`admin-qbank-qdata-${id}`).value;
    let originalData = {};
    try { originalData = JSON.parse(originalDataRaw); } catch(e){}
    
    const newData = {
      ...originalData,
      subject,
      chapter,
      tags,
      options,
      correctIndices,
      explanation
    };

    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({
          action: "update_qbank_question",
          qbankId: currentAdminQBankId,
          questionId: id,
          questionText: qtext,
          dataJson: JSON.stringify(newData)
        })
      });
      alert("Question updated successfully.");
      window.adminManageQBank(currentAdminQBankId, document.getElementById("admin-qbank-manage-title").textContent.replace("Questions in ", ""));
    } catch(e) {
      alert("Failed: " + e.message);
    }
  };

  window.adminClearQBankReports = async function(qbankId, questionId) {
    if (!confirm("Clear all reports for this question?")) return;
    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "clear_qbank_question_reports", qbankId, questionId })
      });
      window.adminManageQBank(currentAdminQBankId, document.getElementById("admin-qbank-manage-title").textContent.replace("Questions in ", ""));
    } catch(e) {
      alert("Failed to clear reports: " + e.message);
    }
  };

  window.adminBackfillQBankCodes = async function(qbankId) {
    if (!confirm("This will assign a random code to all questions in this QBank that don't have one. Continue?")) return;
    try {
      const res = await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "backfill_qbank_codes", qbankId, mode: "missing" })
      });
      alert(`Backfilled codes for ${res.updatedCount || 0} questions.`);
      window.adminManageQBank(currentAdminQBankId, document.getElementById("admin-qbank-manage-title").textContent.replace("Questions in ", ""));
    } catch (e) {
      alert("Failed to backfill: " + e.message);
    }
  };

  window.adminRegenerateQBankCodes = async function(qbankId) {
    if (!confirm(
      "REGENERATE ALL IDS?\n\n" +
      "Every question in this QBank will get a brand-new unique system ID.\n" +
      "Old IDs (including duplicates shared with other banks) stop working.\n\n" +
      "Recommended if this bank was imported with source-file IDs.\n\nContinue?"
    )) return;
    try {
      const res = await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "backfill_qbank_codes", qbankId, mode: "regenerate" })
      });
      alert(`Regenerated ${res.updatedCount || 0} question IDs. Every question now has a fresh unique system ID.`);
      window.adminManageQBank(currentAdminQBankId, document.getElementById("admin-qbank-manage-title").textContent.replace("Questions in ", ""));
    } catch (e) {
      alert("Failed to regenerate: " + e.message);
    }
  };

  window.adminDeleteQBankQuestion = async function(id) {
    if (!currentAdminQBankId) return;
    if (!confirm("Delete this question permanently?")) return;
    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({
          action: "delete_multiple_qbank_questions",
          qbankId: currentAdminQBankId,
          questionIds: [id]
        })
      });
      window.adminManageQBank(currentAdminQBankId, document.getElementById("admin-qbank-manage-title").textContent.replace("Questions in ", ""));
      if (document.getElementById("admin-panel-reports").style.display !== "none") {
         loadAdminReports();
      }
    } catch(e) {
      alert("Failed: " + e.message);
    }
  };

  const AI_PROMPT_GUIDE_TEXT = `You are an expert medical professor creating high-yield Multiple Choice Questions (MCQs) for a medical QBank. 

Generate [NUMBER] clinical questions about [TOPIC/SUBCATEGORY]. 
You MUST format your response EXACTLY following this strict text structure. Do not use markdown tables or JSON. Use plain text exactly as shown below.

STRICT FORMAT RULES:
1. Start each subcategory with: \`  -> Subject: [Name of Subject]\`
2. Start each chapter (sub-subcategory) with: \`  -> Chapter: [Name of Chapter]\`
3. Start each question with: \`Question [Number] [Code: random_5_chars] (Année: [Year]):\`
4. Write the question text on the next line.
5. List options A to E. 
6. For the correct option(s), append exactly \` ✅ (CORRECT)\` immediately after the option text.
7. For every option (both correct and incorrect), append an explanation arrow exactly formatted as: \` -> Note: [Explanation for this specific option]\`
8. Add a general explanation at the end starting exactly with: \`Explication générale: [Overall explanation and clinical pearls]\`
9. Add a separator exactly as: \`--------------------------------------------------\`

EXAMPLE OF THE EXACT REQUIRED FORMAT:

  -> Subject: Cardiologie - Douleurs Thoraciques
  -> Chapter: Urgences Cardiologiques
Question 1 [Code: a1b2c] (Année: 2024):
Un patient de 60 ans présente une douleur thoracique typique... Quel est le diagnostic le plus probable ?
  A. Péricardite aiguë -> Note: La douleur de la péricardite est soulagée par l'antéflexion, ce qui n'est pas le cas ici.
  B. Syndrome coronarien aigu ✅ (CORRECT) -> Note: Douleur rétrosternale constrictive irradiant vers le bras gauche, typique du SCA.
  C. Dissection aortique -> Note: La douleur serait migratrice et asymétrie tensionnelle présente.
  D. Embolie pulmonaire -> Note: L'ECG ne montre pas de signes droits (S1Q3).
  E. Pneumothorax -> Note: L'auscultation pulmonaire est normale.
Explication générale: Leçon clé: Le SCA doit toujours être suspecté en premier devant une douleur thoracique constrictive chez un patient à risque. Piège à éviter: Ne pas attendre la troponine pour faire un ECG.

--------------------------------------------------`;

  // Multi-File Sequential Batch Import State & Helper Functions
  let activeBatchFilesQueue = [];
  let isBatchImportingRunning = false;

  function renderBatchImportQueue(prefix) {
    const queueList = document.getElementById(`${prefix}-queue-list`);
    const countBadge = document.getElementById(`${prefix}-queue-count`);
    if (!queueList) return;

    if (countBadge) countBadge.textContent = `${activeBatchFilesQueue.length} file(s) in queue`;

    if (activeBatchFilesQueue.length === 0) {
      queueList.innerHTML = `<div style="text-align:center; padding:15px; color:var(--text-muted); font-size:0.85rem; background:rgba(0,0,0,0.15); border-radius:6px; border:1px dashed rgba(255,255,255,0.1);">No files added to queue yet. Click "Choose Files" above to select one or multiple .txt files.</div>`;
      return;
    }

    queueList.innerHTML = activeBatchFilesQueue.map((item, idx) => {
      let statusBadge = `<span style="font-size:0.75rem; padding:2px 8px; border-radius:12px; background:rgba(255,255,255,0.1); color:var(--text-secondary);">Pending</span>`;
      if (item.status === 'importing') {
        statusBadge = `<span style="font-size:0.75rem; padding:2px 8px; border-radius:12px; background:rgba(6,182,212,0.2); color:#22d3ee; font-weight:bold;">Importing...</span>`;
      } else if (item.status === 'done') {
        statusBadge = `<span style="font-size:0.75rem; padding:2px 8px; border-radius:12px; background:rgba(34,197,94,0.2); color:#4ade80; font-weight:bold;">✅ Done (${item.imported} imported${item.duplicatesSkipped > 0 ? ', ' + item.duplicatesSkipped + ' dupes skipped' : ''})</span>`;
      } else if (item.status === 'error') {
        statusBadge = `<span style="font-size:0.75rem; padding:2px 8px; border-radius:12px; background:rgba(244,63,94,0.2); color:#f43f5e; font-weight:bold;">❌ Error: ${escapeHtml(item.errorMsg)}</span>`;
      }

      const fileSizeKb = item.file && item.file.size ? Math.round(item.file.size / 1024) : 0;
      const sizeStr = fileSizeKb > 1024 ? (fileSizeKb / 1024).toFixed(1) + ' MB' : fileSizeKb + ' KB';

      return `
        <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; background:rgba(0,0,0,0.2); border:1px solid rgba(255,255,255,0.06); border-radius:8px; margin-bottom:8px;">
          <div style="flex:1; min-width:200px;">
            <div style="font-size:0.85rem; font-weight:600; color:var(--text-primary); display:flex; align-items:center; gap:6px;">
              📄 ${escapeHtml(item.file ? item.file.name : 'Raw Text')} <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal;">(${sizeStr})</span>
            </div>
            <div style="margin-top:4px;">${statusBadge}</div>
          </div>

          <div style="display:flex; align-items:center; gap:8px; flex:1; max-width:320px;">
            <label style="font-size:0.75rem; color:var(--text-muted); white-space:nowrap;">Subcategory:</label>
            <input type="text" class="login-input batch-file-subcat-input" data-idx="${idx}" value="${escapeHtml(item.subcategory)}" placeholder="e.g. Cardiologie" style="font-size:0.8rem; padding:4px 8px; flex:1;" ${isBatchImportingRunning ? 'disabled' : ''}>
          </div>

          <div>
            ${!isBatchImportingRunning ? `<button class="btn-dark-pill" style="font-size:0.75rem; color:var(--danger); padding:4px 8px;" onclick="window.adminRemoveBatchFile(${idx}, '${prefix}')">Remove</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    queueList.querySelectorAll('.batch-file-subcat-input').forEach(inp => {
      inp.addEventListener('input', function(e) {
        const idx = parseInt(e.target.getAttribute('data-idx'));
        if (activeBatchFilesQueue[idx]) {
          activeBatchFilesQueue[idx].subcategory = e.target.value;
        }
      });
    });
  }

  window.adminRemoveBatchFile = function(idx, prefix) {
    if (isBatchImportingRunning) return;
    activeBatchFilesQueue.splice(idx, 1);
    renderBatchImportQueue(prefix);
  };

  window.adminApplyGlobalSubcategory = function(prefix) {
    const globalInput = document.getElementById(`${prefix}-global-subcat-input`);
    if (!globalInput) return;
    const val = globalInput.value.trim();
    if (!val) return alert("Enter a subcategory name to apply to all files in queue.");

    activeBatchFilesQueue.forEach(item => {
      item.subcategory = val;
    });
    renderBatchImportQueue(prefix);
  };

  window.adminClearBatchQueue = function(prefix) {
    if (isBatchImportingRunning) return;
    activeBatchFilesQueue = [];
    renderBatchImportQueue(prefix);
  };

  window.adminStartSequentialBatchImport = async function(qbankId, prefix, onSuccessCallback) {
    const textPastedInput = document.getElementById(`${prefix}-text`);
    const textPasted = textPastedInput ? textPastedInput.value.trim() : "";
    const fileSubcatGlobalInput = document.getElementById(`${prefix}-subcategory`);
    const fileSubcatGlobal = fileSubcatGlobalInput ? fileSubcatGlobalInput.value.trim() : "";

    if (activeBatchFilesQueue.length === 0 && textPasted) {
      activeBatchFilesQueue.push({
        id: 'pasted-' + Date.now(),
        file: { name: 'Pasted Raw Text', size: textPasted.length },
        rawText: textPasted,
        subcategory: fileSubcatGlobal || 'Uncategorized',
        status: 'pending',
        imported: 0,
        duplicatesSkipped: 0,
        totalFound: 0,
        errorMsg: ''
      });
    }

    if (activeBatchFilesQueue.length === 0) {
      return alert("Please select one or multiple .txt files, or paste formatted questions first.");
    }

    if (isBatchImportingRunning) return;
    isBatchImportingRunning = true;

    const btn = document.getElementById(`${prefix}-btn`);
    const oldBtnText = btn ? btn.textContent : "Import Questions";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Processing Queue...";
    }

    const progressContainer = document.getElementById(`${prefix}-progress-container`);
    const progressBar = document.getElementById(`${prefix}-progress-bar`);
    const progressStatus = document.getElementById(`${prefix}-progress-status`);

    if (progressContainer) progressContainer.style.display = 'block';

    let totalImportedAll = 0;
    let totalFoundAll = 0;
    let totalDuplicatesAll = 0;
    let failedCount = 0;

    const totalFiles = activeBatchFilesQueue.length;

    for (let i = 0; i < totalFiles; i++) {
      const item = activeBatchFilesQueue[i];
      item.status = 'importing';
      renderBatchImportQueue(prefix);

      const percent = Math.round(((i) / totalFiles) * 100);
      if (progressBar) progressBar.style.width = `${percent}%`;
      if (progressStatus) progressStatus.textContent = `Importing file ${i + 1} of ${totalFiles}: ${item.file.name}...`;

      try {
        let fileContent = item.rawText;
        if (!fileContent && item.file) {
          fileContent = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = e => reject(new Error("Failed to read file " + item.file.name));
            reader.readAsText(item.file);
          });
        }

        const res = await api("/api/admin", {
          method: "POST",
          body: JSON.stringify({
            action: "batch_import_qbank_txt",
            qbankId,
            rawText: fileContent,
            fileSubcategory: item.subcategory ? item.subcategory.trim() : "",
            skipDuplicates: true
          })
        });

        item.status = 'done';
        item.imported = res.imported || 0;
        item.duplicatesSkipped = res.duplicatesSkipped || 0;
        item.totalFound = res.totalFound || 0;

        totalImportedAll += item.imported;
        totalFoundAll += item.totalFound;
        totalDuplicatesAll += item.duplicatesSkipped;
      } catch (e) {
        item.status = 'error';
        item.errorMsg = e.message || "Upload failed";
        failedCount++;
      }

      renderBatchImportQueue(prefix);
    }

    if (progressBar) progressBar.style.width = '100%';
    if (progressStatus) {
      progressStatus.innerHTML = `<span style="color:#4ade80; font-weight:bold;">🎉 Batch import complete! ${totalImportedAll} questions imported across ${totalFiles - failedCount} file(s). ${totalDuplicatesAll > 0 ? '(' + totalDuplicatesAll + ' duplicates skipped)' : ''}</span>`;
    }

    isBatchImportingRunning = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldBtnText;
    }

    if (onSuccessCallback) {
      onSuccessCallback();
    }
  };

  function createBatchImportFormHTML(prefix, qbankId, isModal) {
    return `
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:12px;">
        Upload multiple <code>.txt</code> subject files or paste formatted questions. Subcategories are automatically set from filenames.
        <button class="btn-dark-pill" style="font-size:0.7rem; padding:2px 8px; margin-left:8px; color:var(--accent-cyan);" onclick="window.adminToggleAIPromptGuideForm('${prefix}')">View AI Prompt Guide</button>
      </div>

      <div id="${prefix}-ai-prompt-guide-container" style="display:none; padding:12px; background:rgba(6,182,212,0.1); border:1px solid rgba(6,182,212,0.2); border-radius:8px; margin-bottom:15px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <strong style="color:var(--text-primary); font-size:0.9rem;">Copy-Paste this to your AI:</strong>
          <button class="btn-action primary" style="font-size:0.75rem; padding:4px 10px;" onclick="window.adminCopyPromptGuide()">Copy to Clipboard</button>
        </div>
        <textarea readonly style="width:100%; height:120px; background:rgba(0,0,0,0.2); border:1px solid rgba(255,255,255,0.1); border-radius:6px; color:var(--text-primary); font-family:monospace; font-size:0.8rem; padding:8px; resize:vertical;">${escapeHtml(AI_PROMPT_GUIDE_TEXT)}</textarea>
      </div>

      <!-- File Select Dropzone & Input -->
      <div style="padding:15px; background:rgba(255,255,255,0.02); border:2px dashed rgba(255,255,255,0.15); border-radius:10px; margin-bottom:14px; text-align:center;">
        <input type="file" id="${prefix}-file-input" accept=".txt" multiple style="display:none;">
        <div style="font-size:0.9rem; color:var(--text-primary); font-weight:600; margin-bottom:6px;">Select one or multiple .txt files</div>
        <div style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:12px;">Choose multiple files (e.g. Cardiologie.txt, Pneumologie.txt) to queue them up.</div>
        <button class="btn-action primary" type="button" style="font-size:0.85rem; padding:8px 16px;" onclick="document.getElementById('${prefix}-file-input').click()">📁 Select TXT Files...</button>
      </div>

      <!-- File Queue Area -->
      <div style="margin-bottom:16px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
          <div style="font-size:0.85rem; font-weight:700; color:var(--text-primary); display:flex; align-items:center; gap:8px;">
            <span>Queue</span>
            <span id="${prefix}-queue-count" style="font-size:0.75rem; background:rgba(6,182,212,0.2); color:#22d3ee; padding:2px 8px; border-radius:10px;">0 file(s) in queue</span>
          </div>

          <div style="display:flex; gap:6px; align-items:center;">
            <input type="text" id="${prefix}-global-subcat-input" class="login-input" placeholder="Bulk subcategory..." style="font-size:0.75rem; padding:4px 8px; width:140px;">
            <button class="btn-dark-pill" style="font-size:0.75rem; padding:4px 8px; color:var(--accent-cyan);" onclick="window.adminApplyGlobalSubcategory('${prefix}')">Apply to All</button>
            <button class="btn-dark-pill" style="font-size:0.75rem; padding:4px 8px; color:var(--text-muted);" onclick="window.adminClearBatchQueue('${prefix}')">Clear Queue</button>
          </div>
        </div>

        <div id="${prefix}-queue-list" style="max-height: 350px; overflow-y: auto; padding-right: 4px;"></div>
      </div>

      <!-- Optional Raw Text Area -->
      <details style="margin-bottom:14px;">
        <summary style="font-size:0.8rem; color:var(--text-secondary); cursor:pointer; padding:6px 0; font-weight:600;">Or Paste Formatted Raw Text Directly</summary>
        <div style="margin-top:8px;">
          <textarea id="${prefix}-text" class="login-input" rows="6" placeholder="Paste questions here..." style="font-family:monospace; font-size:0.85rem; margin-bottom:8px;"></textarea>
          <div style="display:flex; align-items:center; gap:8px;">
            <label style="font-size:0.8rem; color:var(--text-secondary); white-space:nowrap;">Subcategory for pasted text:</label>
            <input type="text" id="${prefix}-subcategory" class="login-input" placeholder="e.g. Cardiologie" style="flex:1; font-size:0.8rem; padding:4px 8px;">
          </div>
        </div>
      </details>

      <!-- Progress Indicator -->
      <div id="${prefix}-progress-container" style="display:none; margin-bottom:14px; padding:12px; background:rgba(0,0,0,0.3); border-radius:8px; border:1px solid rgba(255,255,255,0.08);">
        <div id="${prefix}-progress-status" style="font-size:0.85rem; color:var(--text-primary); margin-bottom:8px;">Starting import...</div>
        <div style="width:100%; height:8px; background:rgba(255,255,255,0.1); border-radius:4px; overflow:hidden;">
          <div id="${prefix}-progress-bar" style="width:0%; height:100%; background:linear-gradient(90deg, #06b6d4 0%, #3b82f6 100%); transition:width 0.3s ease;"></div>
        </div>
      </div>

      <button id="${prefix}-btn" class="btn-action primary" style="width:100%; font-weight:bold; padding:10px 16px;" onclick="window.adminStartSequentialBatchImport('${qbankId}', '${prefix}', ${isModal ? 'function(){ loadAdminQBank(); }' : 'function(){ window.adminManageQBank(\'' + qbankId + '\', document.getElementById(\'admin-qbank-manage-title\').textContent.replace(\'Questions in \', \'\')); }'})">Import All Files (Sequential)</button>
    `;
  }

  function setupBatchImportEvents(prefix) {
    activeBatchFilesQueue = [];
    renderBatchImportQueue(prefix);

    const fileInp = document.getElementById(`${prefix}-file-input`);
    if (fileInp) {
      fileInp.addEventListener("change", function(e) {
        const files = Array.from(e.target.files);
        files.forEach(f => {
          const defaultSubcat = f.name.replace(/\.[^/.]+$/, '').trim();
          activeBatchFilesQueue.push({
            id: 'file-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
            file: f,
            subcategory: defaultSubcat,
            status: 'pending',
            imported: 0,
            duplicatesSkipped: 0,
            totalFound: 0,
            errorMsg: ''
          });
        });
        renderBatchImportQueue(prefix);
        e.target.value = "";
      });
    }
  }

  window.adminToggleAIPromptGuideForm = function(prefix) {
    const container = document.getElementById(`${prefix}-ai-prompt-guide-container`);
    if (container) container.style.display = container.style.display === "none" ? "block" : "none";
  };

  window.adminOpenBatchImport = function(qbankId) {
    const area = document.getElementById("admin-batch-import-area");
    if (!area) return;
    area.style.display = "block";
    const prefix = "admin-batch-import";
    area.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="margin:0; font-size:1.1rem; color:var(--text-primary);">Batch Import Questions (TXT)</h3>
        <button class="btn-dark-pill" style="font-size:0.75rem;" onclick="document.getElementById('admin-batch-import-area').style.display='none'">Close</button>
      </div>
      ${createBatchImportFormHTML(prefix, qbankId, false)}
    `;
    setupBatchImportEvents(prefix);
  };

  window.adminOpenGlobalBatchImport = function(qbankId, qbankName) {
    let modal = document.getElementById("admin-global-batch-import-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "admin-global-batch-import-modal";
      modal.className = "modal";
      document.body.appendChild(modal);
    }
    
    modal.style.display = "flex";
    const prefix = "admin-global-batch-import";
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 680px;">
        <button class="exam-close-btn" onclick="document.getElementById('admin-global-batch-import-modal').style.display='none'"><i data-lucide="x"></i></button>
        <div class="exam-title" style="margin-bottom: 18px;"><i data-lucide="upload"></i> Batch Import Questions: ${escapeHtml(qbankName)}</div>
        ${createBatchImportFormHTML(prefix, qbankId, true)}
        <div style="display:flex; gap:10px; justify-content:flex-end; margin-top: 16px;">
          <button class="btn-dark-pill" type="button" onclick="document.getElementById('admin-global-batch-import-modal').style.display='none'">Close</button>
        </div>
      </div>
    `;

    if (window.lucide) window.lucide.createIcons();
    setupBatchImportEvents(prefix);
  };

  window.adminToggleGlobalAIPromptGuide = function() {
    window.adminToggleAIPromptGuideForm('admin-global-batch-import');
  };

  window.adminToggleAIPromptGuide = function() {
    window.adminToggleAIPromptGuideForm('admin-batch-import');
  };

  window.adminCopyPromptGuide = function() {
    navigator.clipboard.writeText(AI_PROMPT_GUIDE_TEXT).then(() => {
      alert("AI Prompt Guide copied to clipboard!");
    }).catch(() => {
      alert("Failed to copy. Please select the text and copy manually.");
    });
  };

  async function loadAdminReports() {
    const list = document.getElementById("admin-reports-content");
    if (!list) return;
    list.innerHTML = '<div style="color:var(--text-muted);text-align:center;">Loading reported questions...</div>';
    
    try {
      const res = await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "list_reported_questions" }) });
      const questions = res.questions || [];
      
      if (questions.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);text-align:center;">No questions are currently reported!</div>';
      } else {
        list.innerHTML = questions.map(q => {
           let parsedData = {};
           try { parsedData = JSON.parse(q.data); } catch(e){}
           const snippet = escapeHtml(q.questionText).substring(0, 100) + "...";
           
           const reasons = (q.reports || []).map(r => window.formatReportReason(r.reason?.stringValue)).join(" | ");
           
           const codeBadge = parsedData.code ? `<span style="font-size:0.75rem; padding:2px 6px; background:rgba(255,255,255,0.1); border-radius:4px; margin-right:8px; font-family:monospace;">${escapeHtml(parsedData.code)}</span>` : "";
           
           return `
            <div style="padding:12px; background:rgba(255,255,255,0.03); border:1px solid rgba(244,63,94,0.3); border-radius:8px; display:flex; flex-direction:column; gap:10px;">
              <div style="font-size:0.95rem; color:var(--text-primary); display:flex; gap:10px; align-items:flex-start;">
                <div style="flex:1;">
                   <div style="margin-bottom:6px;">${codeBadge} <span style="font-size:0.75rem; color:var(--text-muted);">QBank: ${escapeHtml(q.qbankId)}</span></div>
                   <span>${snippet}</span>
                </div>
              </div>
              <div style="margin-top:10px; padding:10px; background:rgba(244,63,94,0.1); border:1px solid rgba(244,63,94,0.2); border-radius:8px;">
                 <div style="color:#f43f5e; font-size:0.85rem; font-weight:700; margin-bottom:5px;"><i data-lucide="flag" style="width:14px;height:14px;vertical-align:-2px;"></i> Reported (${q.reports?.length || 0})</div>
                 <div style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:8px;">${escapeHtml(reasons)}</div>
                 <div style="display:flex; gap:8px; flex-wrap:wrap;">
                   <button class="btn-dark-pill" style="font-size:0.75rem; padding:4px 8px;" onclick="window.adminEditQuestion('${q.qbankId}', '${q.id}', true)">✎ Edit Question</button>
                   <button class="btn-dark-pill" style="font-size:0.75rem; padding:4px 8px;" onclick="window.adminClearGlobalReports('${q.qbankId}', '${q.id}')">Clear Reports</button>
                   <button class="btn-dark-pill" style="font-size:0.75rem; padding:4px 8px; color:var(--danger);" onclick="window.adminDeleteGlobalQuestion('${q.qbankId}', '${q.id}')">Delete Question</button>
                 </div>
              </div>
            </div>
           `;
        }).join('');
        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      }
    } catch(e) {
      let errMsg = escapeHtml(e.message);
      // Auto-linkify Firestore index creation URLs
      errMsg = errMsg.replace(/(https:\/\/console\.firebase\.google\.com[^\s]+)/g, '<a href="$1" target="_blank" style="color:var(--accent-cyan); text-decoration:underline;">$1</a>');
      list.innerHTML = `<div style="color:#f43; background:rgba(244,63,94,0.1); padding:15px; border-radius:8px;">
        <div style="font-weight:bold; margin-bottom:10px;">Error Loading Reports</div>
        <div style="font-family:monospace; font-size:0.85rem; word-break:break-all;">${errMsg}</div>
        <div style="margin-top:10px; font-size:0.8rem; color:var(--text-secondary);">If this is a missing index error, click the link above to create it in the Firebase Console.</div>
      </div>`;
    }
  }
  window.loadAdminReports = loadAdminReports;

  window.adminClearGlobalReports = async function(qbankId, questionId) {
    if (!confirm("Clear all reports for this question?")) return;
    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "clear_qbank_question_reports", qbankId, questionId })
      });
      loadAdminReports();
    } catch(e) {
      alert("Failed to clear reports: " + e.message);
    }
  };

  window.adminDeleteGlobalQuestion = async function(qbankId, questionId) {
    if (!confirm("Delete this question permanently?")) return;
    window.qbankRemoveCachedQuestion && window.qbankRemoveCachedQuestion(qbankId, questionId);
    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({
          action: "delete_multiple_qbank_questions",
          qbankId: qbankId,
          questionIds: [questionId]
        })
      });
      loadAdminReports();
    } catch(e) {
      alert("Failed: " + e.message);
    }
  };

  window.adminSaveGlobalQBankQuestion = async function(qbankId, questionId) {
    const qtext = document.getElementById(`admin-qbank-qtext-${questionId}`).value;
    const qdata = document.getElementById(`admin-qbank-qdata-${questionId}`).value;
    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({
          action: "update_qbank_question",
          qbankId: qbankId,
          questionId: questionId,
          questionText: qtext,
          dataJson: qdata
        })
      });
      alert("Question updated successfully.");
      loadAdminReports();
    } catch(e) {
      alert("Failed: " + e.message);
    }
  };

  window.adminDeleteSelectedQBankQuestions = async function() {
    if (!currentAdminQBankId) return;
    const checkboxes = document.querySelectorAll(".qbank-delete-checkbox:checked");
    const ids = Array.from(checkboxes).map(c => c.value);
    
    if (ids.length === 0) return alert("No questions selected");
    ids.forEach(id => window.qbankRemoveCachedQuestion && window.qbankRemoveCachedQuestion(currentAdminQBankId, id));
    if (!confirm(`Delete ${ids.length} selected questions permanently?`)) return;
    
    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({
          action: "delete_multiple_qbank_questions",
          qbankId: currentAdminQBankId,
          questionIds: ids
        })
      });
      window.adminManageQBank(currentAdminQBankId, document.getElementById("admin-qbank-manage-title").textContent.replace("Questions in ", ""));
    } catch(e) {
      alert("Failed: " + e.message);
    }
  };

  window.adminScanDuplicates = function() {
    if (!currentAdminQuestions || currentAdminQuestions.length === 0) return alert("No questions to scan.");
    
    let seenTexts = new Set();
    let duplicateIds = [];
    
    for (const q of currentAdminQuestions) {
      const cleanText = q.questionText.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (seenTexts.has(cleanText)) {
        duplicateIds.push(q.id);
      } else {
        seenTexts.add(cleanText);
      }
    }
    
    if (duplicateIds.length === 0) {
      return alert("No duplicates found!");
    }
    
    let count = 0;
    const checkboxes = document.querySelectorAll(".qbank-delete-checkbox");
    checkboxes.forEach(c => {
      if (duplicateIds.includes(c.value)) {
        c.checked = true;
        count++;
      }
    });
    
    alert(`Found ${count} duplicate(s). They have been selected for you. Click 'Delete Selected' to remove them.`);
  };

  window.adminSelectBySubject = function() {
    if (!currentAdminQuestions || currentAdminQuestions.length === 0) return alert("No questions available.");
    const subject = prompt("Enter the exact sub-category (subject) name to select all its questions:");
    if (!subject) return;
    
    let matchIds = [];
    const lowerSub = subject.toLowerCase().trim();
    
    for (const q of currentAdminQuestions) {
      let parsed = {};
      try { parsed = JSON.parse(q.data); } catch(e){}
      const qSub = (parsed.subject || "").toLowerCase().trim();
      if (qSub === lowerSub) {
        matchIds.push(q.id);
      }
    }
    
    if (matchIds.length === 0) return alert("No questions found for subject: " + subject);
    
    let count = 0;
    const checkboxes = document.querySelectorAll(".qbank-delete-checkbox");
    checkboxes.forEach(c => {
      if (matchIds.includes(c.value)) {
        c.checked = true;
        count++;
      }
    });
    
    alert(`Found and selected ${count} question(s) in "${subject}". Click 'Delete Selected' to remove them.`);
  };

  let isAddingQBankQuestion = false;
  window.adminAddQBankQuestion = async function() {
    if (isAddingQBankQuestion) return;
    const select = document.getElementById("admin-qbank-select");
    const textarea = document.getElementById("admin-qbank-raw-input");
    const subcatsInput = document.getElementById("admin-qbank-subcategories-input");
    const status = document.getElementById("admin-qbank-add-status");
    
    const qbankId = select.value;
    const rawText = textarea.value.trim();
    const subcategories = subcatsInput ? subcatsInput.value.trim() : "";
    
    if (!qbankId) return alert("Select a QBank");
    if (!rawText) return alert("Enter raw question text");
    
    isAddingQBankQuestion = true;
    status.style.color = "var(--text-secondary)";
    status.textContent = "AI is processing your questions... Please wait.";
    
    try {
      const res = await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "add_qbank_question", qbankId, rawText, subcategories }) });
      status.style.color = "var(--accent-cyan)";
      const count = res.questionIds ? res.questionIds.length : 0;
      let msg = `${count} question(s) added successfully using ${res.provider} (${res.model})!`;
      if (res.duplicatesSkipped > 0) {
        msg += ` (${res.duplicatesSkipped} duplicate(s) skipped)`;
      }
      status.textContent = msg;
      textarea.value = "";
      setTimeout(() => { status.textContent = ""; }, 5000);
    } catch (e) {
      status.style.color = "var(--danger)";
      status.textContent = "Failed: " + e.message;
    } finally {
      isAddingQBankQuestion = false;
    }
  };

  // ---------- EXAM PREP SUB-BANKS MANAGEMENT ----------
  const EP_ADMIN_FLAGS = { global: "🌍", usa: "🇺🇸", uk: "🇬🇧", australia: "🇦🇺", canada: "🇨🇦", india: "🇮🇳", europe: "🇪🇺", tunisia: "🇹🇳", algeria: "🇩🇿", egypt: "🇪🇬", morocco: "🇲🇦" };

  window.loadAdminExamPrep = async function() {
    await window.adminRefreshExamPrepList();
  };

  window.adminCreateExamPrep = async function() {
    const nameEl = document.getElementById("admin-ep-name");
    const countryEl = document.getElementById("admin-ep-country");
    const collegeEl = document.getElementById("admin-ep-college");
    const yearEl = document.getElementById("admin-ep-year");
    const name = nameEl.value.trim();
    if (!name) return alert("Enter a name for the sub-bank.");
    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({
          action: "create_qbank",
          qbankName: name,
          country: countryEl ? countryEl.value : "global",
          college: collegeEl ? collegeEl.value.trim() : "",
          year: yearEl ? yearEl.value.trim() : "",
          kind: "exam_prep",
          subcategories: ""
        })
      });
      nameEl.value = "";
      if (collegeEl) collegeEl.value = "";
      if (yearEl) yearEl.value = "";
      window.adminRefreshExamPrepList();
    } catch (e) { alert("Failed: " + e.message); }
  };

  window.adminRefreshExamPrepList = async function() {
    const list = document.getElementById("admin-ep-list");
    if (!list) return;
    list.innerHTML = '<div style="color:var(--text-muted);">Loading...</div>';
    try {
      const res = await api("/api/admin?action=list_qbanks", { method: "GET" });
      const items = (res.qbanks || []).filter(q => q.kind === "exam_prep");
      if (items.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted); font-style:italic;">No exam prep banks yet. Create your first one above.</div>';
        return;
      }
      list.innerHTML = items.map(q => `
        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:14px 18px; display:flex; flex-direction:column; gap:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
            <div>
              <div style="font-weight:600; color:var(--text-primary); display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <span>${EP_ADMIN_FLAGS[q.country] || "🌍"}</span>
                <i data-lucide="graduation-cap" style="width:15px;height:15px;color:#a78bfa;"></i>
                ${escapeHtml(q.name)}
                <span id="admin-ep-count-${escapeHtml(q.id)}" style="font-size:0.75rem; background:var(--accent-purple); color:#000; padding:2px 8px; border-radius:12px; font-weight:800; display:none;">0 Qs</span>
              </div>
              <div style="font-size:0.78rem; color:var(--text-muted); margin-top:4px;">
                ${q.college ? `🏫 ${escapeHtml(q.college)} · ` : ""}${q.year ? `📅 ${escapeHtml(q.year)} · ` : ""}${EP_ADMIN_FLAGS[q.country] || ""} ${escapeHtml(q.country)}
              </div>
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              <button class="btn-dark-pill" style="color:#34d399;" onclick="window.adminOpenGlobalBatchImport('${escapeHtml(q.id)}', '${escapeHtml(q.name).replace(/'/g, "\\'")}')">Batch Import</button>
              <button id="admin-ep-publish-${escapeHtml(q.id)}" class="btn-dark-pill" style="color:#fcd34d;" onclick="window.adminPublishQBankChunks('${escapeHtml(q.id)}', 'admin-ep-publish-${escapeHtml(q.id)}')">Publish Chunks</button>
              <button class="btn-dark-pill" style="color:var(--accent-cyan);" onclick="window.adminManageQBank('${escapeHtml(q.id)}', '${escapeHtml(q.name).replace(/'/g, "\\'")}')">Manage Questions</button>
              <button class="btn-dark-pill" style="color:var(--accent-purple);" onclick="document.getElementById('admin-ep-edit-${escapeHtml(q.id)}').style.display='flex'">Edit</button>
              <button class="btn-dark-pill" style="color:var(--danger);" onclick="window.adminDeleteQBank('${escapeHtml(q.id)}')">Delete</button>
            </div>
          </div>
          <div id="admin-ep-edit-${escapeHtml(q.id)}" style="display:none; flex-direction:column; gap:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.05);">
            <input type="text" id="admin-ep-edit-name-${escapeHtml(q.id)}" class="login-input" value="${escapeHtml(q.name)}" placeholder="Name">
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
              <input type="text" id="admin-ep-edit-college-${escapeHtml(q.id)}" class="login-input" value="${escapeHtml(q.college || "")}" placeholder="College / University" style="flex:2; min-width:200px;">
              <input type="text" id="admin-ep-edit-year-${escapeHtml(q.id)}" class="login-input" value="${escapeHtml(q.year || "")}" placeholder="Year" style="width:120px;">
              <select id="admin-ep-edit-country-${escapeHtml(q.id)}" class="login-input" style="width:150px; cursor:pointer;">
                ${Object.keys(EP_ADMIN_FLAGS).map(c => `<option value="${c}" ${q.country === c ? "selected" : ""}>${EP_ADMIN_FLAGS[c]} ${c}</option>`).join("")}
              </select>
            </div>
            <div style="display:flex; gap:10px;">
              <button class="btn-dark-pill" style="color:var(--accent-cyan);" onclick="window.adminSaveExamPrepSettings('${escapeHtml(q.id)}')">Save</button>
              <button class="btn-dark-pill" onclick="document.getElementById('admin-ep-edit-${escapeHtml(q.id)}').style.display='none'">Cancel</button>
            </div>
          </div>
        </div>`).join("");

      // Async question counts
      items.forEach(async q => {
        try {
          const cRes = await api(`/api/admin?action=get_qbank_question_count&qbankId=${q.id}`, { method: "GET" });
          const el = document.getElementById(`admin-ep-count-${q.id}`);
          if (el) { el.textContent = `${cRes.count} Qs`; el.style.display = "inline-block"; }
        } catch (e) {}
      });

      if (window.lucide) window.lucide.createIcons();
    } catch (e) {
      list.innerHTML = `<div style="color:#f43;">Error: ${escapeHtml(e.message)}</div>`;
    }
  };

  window.adminSaveExamPrepSettings = async function(id) {
    const name = document.getElementById(`admin-ep-edit-name-${id}`).value.trim();
    const college = document.getElementById(`admin-ep-edit-college-${id}`).value.trim();
    const year = document.getElementById(`admin-ep-edit-year-${id}`).value.trim();
    const country = document.getElementById(`admin-ep-edit-country-${id}`).value;
    if (!name) return alert("Name cannot be empty.");
    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "edit_qbank_settings", qbankId: id, qbankName: name, college, year, country })
      });
      window.adminRefreshExamPrepList();
    } catch (e) { alert("Failed: " + e.message); }
  };

  // Load data when the Exam Prep admin tab opens
  const origSwitchAdminTab = window.switchAdminTab;
  window.switchAdminTab = function(tab) {
    origSwitchAdminTab(tab);
    if (tab === "examprep") window.loadAdminExamPrep();
  };


  // Formats a stored report reason: structured JSON (new) or plain text (legacy).
  window.formatReportReason = function(raw) {
    let out = "";
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === "object" && o.option) {
        const LABELS = {
          wrong_answer: "The answer is wrong",
          invalid_question: "Question is invalid / unclear",
          needs_explanation: "Needs a better explanation",
          typo: "Typo / formatting issue",
          other: "Other problem",
        };
        out = LABELS[o.option] || String(o.option);
        if (o.suggestedAnswer) out += " — suggests: “" + o.suggestedAnswer + "”";
        if (o.details) out += " — " + o.details;
        return out;
      }
    } catch (_) {}
    return String(raw || "");
  };

  // ---------- ACCESS REQUESTS MODERATION ----------
  window.loadAccessRequests = async function() {
    const listEl = document.getElementById("admin-access-list");
    if (!listEl) return;
    listEl.innerHTML = '<div style="color:var(--text-muted); padding:20px;">Loading requests…</div>';
    try {
      const res = await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "list_access_requests" }) });
      const reqs = res.requests || [];
      if (reqs.length === 0) {
        listEl.innerHTML = '<div style="color:var(--text-muted); padding:24px; text-align:center; border:1px dashed rgba(255,255,255,0.12); border-radius:12px;">No pending requests.</div>';
        return;
      }
      listEl.innerHTML = reqs.map(r => `
        <div class="acc-req-card" data-id="${r.id}" style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.09); border-radius:12px; padding:16px 18px;">
          <div style="display:flex; justify-content:space-between; gap:14px; flex-wrap:wrap;">
            <div style="min-width:0;">
              <div style="font-weight:700; color:var(--text-primary);">${window.escapeHtml ? window.escapeHtml(r.bankName) : r.bankName}</div>
              <div style="font-size:0.82rem; color:var(--text-muted); margin-top:3px;">${window.escapeHtml ? window.escapeHtml(r.email) : r.email} · ${new Date(r.createdAt).toLocaleString()}</div>
              <div style="margin-top:8px; font-size:0.9rem; color:var(--text-secondary); line-height:1.5;">“${window.escapeHtml ? window.escapeHtml(r.reason) : r.reason}”</div>
            </div>
            <div style="display:flex; gap:8px; align-items:flex-start;">
              <button class="btn-action primary" style="padding:7px 14px; font-size:0.85rem;" onclick="window.resolveAccessRequest('${r.id}','accept')">Accept</button>
              <button class="btn-dark-pill" style="color:#f87171;" onclick="window.resolveAccessRequest('${r.id}','reject')">Reject</button>
            </div>
          </div>
        </div>`).join("");
    } catch (e) {
      listEl.innerHTML = `<div style="color:var(--danger);">Failed to load: ${e.message}</div>`;
    }
  };

  window.resolveAccessRequest = async function(requestId, decision) {
    if (!confirm(decision === "accept"
      ? "Grant this student access to the bank and notify them?"
      : "Reject this request? The student will be notified.")) return;
    try {
      await api("/api/admin", { method: "POST", body: JSON.stringify({ action: "resolve_access_request", requestId, decision }) });
      alert(decision === "accept" ? "Access granted and student notified." : "Request rejected and student notified.");
      window.loadAccessRequests();
    } catch (e) {
      alert("Failed: " + e.message);
    }
  };

  // ---------- PEER STATS ----------
  async function loadAdminPeerStats() {
    const box = document.getElementById("admin-peerstats-content");
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Loading peer stats…</div>';
    try {
      // Get current threshold from server
      const data = await api("/api/admin?action=get_peer_stats_settings", { method: "GET" });
      const currentThreshold = data.settings?.threshold || 50;

      box.innerHTML = `
        <div style="max-width:600px;">
          <h3 style="color:#fff; margin-bottom:16px;">Peer Answer Statistics</h3>
          <p style="color:var(--text-muted); font-size:0.85rem; margin-bottom:20px;">
            Control when peer statistics become visible to users. Stats are hidden until a question receives enough answers.
          </p>
          
          <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:20px; margin-bottom:20px;">
            <label style="display:block; font-size:0.75rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px;">
              Minimum Answers Threshold
            </label>
            <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:12px;">
              Peer stats will be hidden until a question has at least this many total answers.
            </p>
            <div style="display:flex; gap:12px; align-items:center;">
              <input id="peer-threshold-input" type="number" min="1" max="1000" value="${currentThreshold}" 
                style="width:100px; padding:10px 12px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:8px; color:#fff; font-size:1rem; text-align:center;">
              <button class="btn-action primary" onclick="window.savePeerThreshold()" style="padding:10px 20px;">Save Threshold</button>
            </div>
          </div>
          
          <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:20px;">
            <h4 style="color:#fff; font-size:0.9rem; margin-bottom:12px;">How it works</h4>
            <ul style="color:var(--text-muted); font-size:0.8rem; line-height:1.6; padding-left:16px;">
              <li>Every answer submission is logged globally</li>
              <li>Percentages are calculated from total answers per question</li>
              <li>Stats show "Pending" until threshold is reached</li>
              <li>Once threshold is crossed, real percentages appear automatically</li>
            </ul>
          </div>
        </div>
      `;
    } catch (e) {
      box.innerHTML = `<div style="color:#f43;padding:20px;">Failed to load: ${e.message}</div>`;
    }
  }

  window.savePeerThreshold = async function() {
    const input = document.getElementById("peer-threshold-input");
    if (!input) return;
    const threshold = parseInt(input.value, 10);
    if (isNaN(threshold) || threshold < 1) {
      alert("Please enter a valid number (minimum 1)");
      return;
    }
    try {
      await api("/api/admin", { 
        method: "POST", 
        body: JSON.stringify({ 
          action: "set_peer_stats_settings", 
          settings: { threshold: threshold } 
        }) 
      });
      alert("Threshold saved successfully!");
      // Reload threshold in qbank.js if available
      if (window._loadPeerThreshold) window._loadPeerThreshold();
      loadAdminPeerStats(); // Reload to show updated value
    } catch (e) {
      alert("Failed to save: " + e.message);
    }
  };

  // ---------- MEDICAL LIBRARY (per-bank books) ----------
  // Each bank owns its book collection: qbanks/{bankId}/books/{bookId}.
  // Workflow: Export concepts (.txt) -> author book JSON -> Import book.
  window.__adminLibraryBank = null;

  async function loadAdminLibrary() {
    const c = document.getElementById("admin-library-content");
    if (!c) return;
    c.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">Loading banks…</div>';
    try {
      const res = await api("/api/admin?action=list_qbanks", { method: "GET" });
      const banks = (res.qbanks || []).filter((q) => q.kind !== "exam_prep");
      if (!banks.length) {
        c.innerHTML = '<div style="color:var(--text-muted);">No QBanks yet — create one in the QBank tab first.</div>';
        return;
      }
      if (!window.__adminLibraryBank || !banks.some((b) => b.id === window.__adminLibraryBank)) {
        window.__adminLibraryBank = banks[0].id;
      }
      const opts = banks.map((b) => `<option value="${escapeHtml(b.id)}" ${b.id === window.__adminLibraryBank ? "selected" : ""}>${escapeHtml(b.name)}</option>`).join("");
      c.innerHTML = `
        <h3 style="color:var(--text-primary); margin:0 0 4px 0;">Medical Library</h3>
        <p style="color:var(--text-muted); font-size:0.85rem; margin:0 0 16px 0;">Each bank has its own book collection. Export study concepts to author books, then import them as JSON.</p>
        <div style="display:flex; gap:10px; align-items:center; margin-bottom:16px; flex-wrap:wrap;">
          <select id="admin-library-bank" class="login-input" style="min-width:220px;" onchange="window.adminLibrarySetBank(this.value)">${opts}</select>
          <button class="btn-dark-pill" style="color:#34d399;" onclick="window.adminLibraryExportConcepts(this)">Export study concepts (.txt)</button>
          <button class="btn-dark-pill" style="color:#fcd34d;" onclick="window.adminLibraryBackfill(this)" title="One-time scan: seeds the digest from all questions so exports stay instant">Backfill digest</button>
        </div>
        <div id="admin-library-books" style="display:flex; flex-direction:column; gap:10px; margin-bottom:20px;"></div>
        <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:16px;">
          <div style="font-weight:700; color:var(--text-primary); margin-bottom:10px;">Import book (JSON)</div>
          <input type="file" id="admin-library-file" accept=".json,application/json" class="login-input" style="margin-bottom:10px;">
          <textarea id="admin-library-text" class="login-input" rows="6" style="width:100%; margin-bottom:10px;" placeholder='Paste one book object or an array of books…'></textarea>
          <div style="display:flex; gap:10px; align-items:center;">
            <input type="text" id="admin-library-title" class="login-input" placeholder="Title override (optional)" style="flex:1;">
            <button class="btn-action primary" onclick="window.adminLibraryImport(this)">Import book</button>
          </div>
          <div id="admin-library-status" style="font-size:0.85rem; margin-top:10px; min-height:18px;"></div>
          <details style="margin-top:10px; font-size:0.82rem; color:var(--text-muted);">
            <summary style="cursor:pointer; color:var(--accent-cyan);">JSON format</summary>
            <pre style="white-space:pre-wrap; background:rgba(0,0,0,0.25); padding:10px; border-radius:8px; margin-top:8px;">{
  "title": "Cardiology Library",
  "subject": "Cardiology",
  "units": [
    { "title": "Unit 1: Fundamentals",
      "chapters": [
        { "title": "Chapter 1: Heart Failure",
          "lessons": [
            { "title": "1.1 Definition", "body": "Markdown lesson text…" }
          ] } ] } ]
}</pre>
            <div style="margin-top:6px;">Shorthands: top-level <b>chapters</b> wraps into one unit; top-level <b>lessons</b> wraps into one unit + chapter. Re-importing the same title overwrites that book. Max ~900KB per book.</div>
          </details>
        </div>`;
      if (window.lucide && window.lucide.createIcons) { try { window.lucide.createIcons(); } catch (_) {} }
      await window.adminLibraryRefreshBooks();
    } catch (e) {
      c.innerHTML = `<div style="color:var(--danger);">Failed to load banks: ${escapeHtml(e.message)}</div>`;
    }
  }

  window.adminLibrarySetBank = async function (id) {
    window.__adminLibraryBank = id;
    await window.adminLibraryRefreshBooks();
  };

  window.adminLibraryRefreshBooks = async function () {
    const box = document.getElementById("admin-library-books");
    if (!box || !window.__adminLibraryBank) return;
    box.innerHTML = '<div style="color:var(--text-muted);">Loading books…</div>';
    try {
      const res = await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "list_library_books", qbankId: window.__adminLibraryBank }),
      });
      const books = res.books || [];
      if (!books.length) {
        box.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem;">No books in this bank yet — import one below.</div>';
        return;
      }
      box.innerHTML = books.map((b) => `
        <div style="padding:12px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; display:flex; justify-content:space-between; align-items:center; gap:10px;">
          <div>
            <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(b.title)}</div>
            <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${b.lessonCount || 0} lessons${b.subject ? ` · ${escapeHtml(b.subject)}` : ""}</div>
          </div>
          <button class="btn-dark-pill" style="color:var(--danger);" onclick="window.adminLibraryDeleteBook('${escapeHtml(b.id)}')">Delete</button>
        </div>`).join("");
    } catch (e) {
      box.innerHTML = `<div style="color:var(--danger);">Failed to load books: ${escapeHtml(e.message)}</div>`;
    }
  };

  window.adminLibraryImport = async function (btn) {
    const status = document.getElementById("admin-library-status");
    const say = (t, ok) => { if (status) { status.textContent = t; status.style.color = ok ? "#34d399" : "#f43f5e"; } };
    if (!window.__adminLibraryBank) { say("Pick a bank first.", false); return; }
    let rawText = "";
    const ta = document.getElementById("admin-library-text");
    const fi = document.getElementById("admin-library-file");
    try {
      if (fi && fi.files && fi.files[0]) rawText = await fi.files[0].text();
      else if (ta) rawText = ta.value;
    } catch (e) { say("Could not read file: " + e.message, false); return; }
    if (!rawText.trim()) { say("Paste JSON or choose a .json file first.", false); return; }
    const title = (document.getElementById("admin-library-title") || {}).value || "";
    if (btn) { btn.disabled = true; btn.textContent = "Importing…"; }
    say("Importing…", true);
    try {
      const res = await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "import_library_json", qbankId: window.__adminLibraryBank, rawText, bookTitle: title }),
      });
      const names = (res.books || []).map((b) => `${b.title} (${b.lessons} lessons)`).join(", ");
      say(`Imported ${res.imported} book(s): ${names}`, true);
      if (ta) ta.value = "";
      if (fi) fi.value = "";
      await window.adminLibraryRefreshBooks();
    } catch (e) {
      say("Import failed: " + e.message, false);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Import book"; }
    }
  };

  window.adminLibraryDeleteBook = async function (id) {
    if (!confirm("Delete this book? Students will lose access to it.")) return;
    try {
      await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "delete_library_book", qbankId: window.__adminLibraryBank, bookId: id }),
      });
      await window.adminLibraryRefreshBooks();
    } catch (e) {
      alert("Delete failed: " + e.message);
    }
  };

  window.adminLibraryExportConcepts = async function (btn) {
    if (!window.__adminLibraryBank) return;
    const orig = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.textContent = "Exporting…"; }
    try {
      const res = await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "export_study_concepts", qbankId: window.__adminLibraryBank }),
      });
      const blob = new Blob([res.text || ""], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = res.filename || "concepts.txt";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      alert(`Exported ${res.withConcepts} concepts.${res.backfilledAt ? ` Digest backfilled: ${res.backfilledAt}.` : " Digest never backfilled — run Backfill digest for full coverage of older concepts."} Served from digest — 1 read.`);
    } catch (e) {
      alert("Export failed: " + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    }
  };

})();
