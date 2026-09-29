/* OmNote — Study Together (Party Mode) inside Book Mode
 * Real-time synced Pomodoro sessions via Firestore.
 * Uses shared party lofi backgrounds and optional host custom uploads.
 */
(function () {
  console.log("[StudyParty] module loading…");
  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const HEARTBEAT_MS = 20000;
  const STALE_MS = 65000;
  const MAX_CUSTOM_BYTES = 700 * 1024;

  const PARTY_SCENES = [
    { id: "library", label: "Library",  url: "/app/images/party-library.jpg" },
    { id: "cafe",    label: "Cafe",     url: "/app/images/party-cafe.jpg" },
    { id: "dorm",    label: "Dorm",     url: "/app/images/party-dorm.jpg" },
    { id: "studio",  label: "Studio",   url: "/app/images/party-studio.jpg" },
    { id: "cabin",   label: "Cabin",    url: "/app/images/party-cabin.jpg" },
  ];
  const DEFAULT_PARTY_SCENE = "library";

  if (window.__hmr_study_detachParty) {
    try { window.__hmr_study_detachParty(); } catch (e) {}
  }

  let state = {
    code: null,
    isHost: false,
    party: null,
    members: [],
    unsubscribeParty: null,
    unsubscribeMembers: null,
    heartbeat: null,
    localOverrideBg: null, // {type,value} for member-only preview override
    prevPersonalBg: null,
    tickerHandle: null,
  };

  function fs() { return firebase.firestore(); }
  function auth() { return firebase.auth(); }
  function currentUser() { return auth().currentUser; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function partyRef(code) { return fs().collection("studyParties").doc(code); }
  function memberRef(code, uid) { return partyRef(code).collection("members").doc(uid); }

  function newCode() {
    let s = "";
    for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return s;
  }
  async function reserveCode() {
    for (let i = 0; i < 6; i++) {
      const c = newCode();
      const snap = await partyRef(c).get();
      if (!snap.exists) return c;
    }
    throw new Error("Could not generate a party code, try again.");
  }

  function userName() {
    try {
      if (window.db && window.db.settings && window.db.settings.displayName) return window.db.settings.displayName;
    } catch (_) {}
    const u = currentUser();
    if (!u) return "Guest";
    if (u.displayName) return u.displayName;
    if (u.email) return u.email.split("@")[0];
    return "Studier";
  }
  function userAvatar() {
    try {
      if (window.db && window.db.settings && window.db.settings.avatar) return window.db.settings.avatar;
    } catch (_) {}
    return "avatar-1";
  }

  // -------------- Backgrounds --------------
  function resolveBg(bg) {
    if (!bg) return PARTY_SCENES.find(s => s.id === DEFAULT_PARTY_SCENE);
    if (bg.type === "preset") {
      return PARTY_SCENES.find(s => s.id === bg.value) || PARTY_SCENES[0];
    }
    if (bg.type === "custom" && bg.value) {
      return { id: "custom", label: "Custom", url: bg.value };
    }
    return PARTY_SCENES[0];
  }
  function applyBg(bg) {
    const el = document.querySelector("#book-mode-overlay .book-bg");
    if (!el) return;
    const r = resolveBg(bg);
    el.style.backgroundImage = `url("${r.url}")`;
  }

  // -------------- Create / Join / Leave --------------
  async function createParty(durationMin) {
    const u = currentUser();
    if (!u) throw new Error("Please sign in to host a party.");
    // Free tier: gate hosting
    if (window.isFreePlan && window.isFreePlan()) {
      if (window.showLockedFeature) window.showLockedFeature("Hosting a party", "Become a Supporter to host synced study sessions.");
      throw new Error("Hosting requires Pro.");
    }
    const code = await reserveCode();
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const expiresAt = firebase.firestore.Timestamp.fromMillis(Date.now() + 6 * 60 * 60 * 1000);
    await partyRef(code).set({
      hostUid: u.uid,
      hostName: userName(),
      hostAvatar: userAvatar(),
      status: "waiting",
      phase: "focus",
      durationSec: Math.max(60, (durationMin || 25) * 60),
      startedAt: null,
      pausedAt: null,
      remainingSec: null,
      background: { type: "preset", value: DEFAULT_PARTY_SCENE },
      createdAt: now,
      expiresAt,
      memberCount: 1,
    });
    await memberRef(code, u.uid).set({
      name: userName(), avatar: userAvatar(),
      joinedAt: now, lastSeen: now, state: "focusing",
    });
    return code;
  }

  async function joinParty(rawCode) {
    const u = currentUser();
    if (!u) throw new Error("Please sign in to join a party.");
    const code = String(rawCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 6) throw new Error("Party code must be 6 characters.");
    const snap = await partyRef(code).get();
    if (!snap.exists) throw new Error("Party not found. Check the code.");
    const p = snap.data();
    if (p.status === "ended") throw new Error("This party has already ended.");
    const now = firebase.firestore.FieldValue.serverTimestamp();
    await memberRef(code, u.uid).set({
      name: userName(), avatar: userAvatar(),
      joinedAt: now, lastSeen: now, state: p.status === "running" ? "focusing" : "idle",
    }, { merge: true });
    return code;
  }

  async function attachParty(code) {
    detachParty();
    state.code = code;
    try { localStorage.setItem("omn-party-code", code); } catch (_) {}
    state.isHost = false;
    // Snapshot party
    state.unsubscribeParty = partyRef(code).onSnapshot(snap => {
      if (!snap.exists) { onPartyGone(); return; }
      state.party = snap.data();
      const u = currentUser();
      state.isHost = !!(u && state.party.hostUid === u.uid);
      // Apply shared background unless member has overridden locally
      if (!state.localOverrideBg) applyBg(state.party.background);
      renderPanel();
      renderTimer();
    });
    // Snapshot members
    state.unsubscribeMembers = partyRef(code).collection("members").onSnapshot(qs => {
      const list = [];
      qs.forEach(d => list.push({ uid: d.id, ...d.data() }));
      state.members = list;
      renderMembers();
    });
    // Heartbeat
    beat();
    state.heartbeat = setInterval(beat, HEARTBEAT_MS);
    // Local ticker for timer countdown
    if (state.tickerHandle) clearInterval(state.tickerHandle);
    state.tickerHandle = setInterval(renderTimer, 500);
  }

  async function beat() {
    const u = currentUser(); if (!u || !state.code) return;
    try {
      await memberRef(state.code, u.uid).set({
        lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (_) {}
  }

  function onPartyGone() {
    toast("Party ended by host.");
    leaveParty(true);
  }

  async function leaveParty(silent) {
    const u = currentUser();
    const code = state.code;
    detachParty();
    if (code && u) {
      try { await memberRef(code, u.uid).delete(); } catch (_) {}
    }
    // Clear local storage so we don't auto-rejoin
    try { localStorage.removeItem("omn-party-code"); } catch (_) {}
    // Restore personal background
    try {
      if (state.prevPersonalBg && typeof window.setSelectedBookBg === "function") {
        window.setSelectedBookBg(state.prevPersonalBg);
      } else if (typeof window.setSelectedBookBg === "function") {
        window.setSelectedBookBg(null); // no-op fallback
      }
    } catch (_) {}
    state.prevPersonalBg = null;
    state.localOverrideBg = null;
    renderPanel();
    if (!silent) toast("Left the party.");
  }
  function detachParty() {
    if (state.unsubscribeParty) { state.unsubscribeParty(); state.unsubscribeParty = null; }
    if (state.unsubscribeMembers) { state.unsubscribeMembers(); state.unsubscribeMembers = null; }
    if (state.heartbeat) { clearInterval(state.heartbeat); state.heartbeat = null; }
    if (state.tickerHandle) { clearInterval(state.tickerHandle); state.tickerHandle = null; }
    state.code = null; state.party = null; state.members = []; state.isHost = false;
  }
  window.__hmr_study_detachParty = detachParty;

  // -------------- Host controls --------------
  async function hostStart(newPhase, newDurationMin) {
    if (!state.isHost) return;
    const updates = {
      status: "running",
      startedAt: firebase.firestore.FieldValue.serverTimestamp(),
      pausedAt: null,
      remainingSec: null,
    };
    if (newPhase) updates.phase = newPhase;
    if (newDurationMin) updates.durationSec = Math.max(60, newDurationMin * 60);
    await partyRef(state.code).update(updates);
  }
  async function hostPause() {
    if (!state.isHost || !state.party || state.party.status !== "running") return;
    const remaining = computeRemainingSec();
    await partyRef(state.code).update({
      status: "paused",
      pausedAt: firebase.firestore.FieldValue.serverTimestamp(),
      remainingSec: remaining,
    });
  }
  async function hostResume() {
    if (!state.isHost || !state.party || state.party.status !== "paused") return;
    const remaining = state.party.remainingSec || state.party.durationSec;
    // Shift startedAt so that remaining reflects properly
    const newStart = firebase.firestore.Timestamp.fromMillis(Date.now() - (state.party.durationSec - remaining) * 1000);
    await partyRef(state.code).update({
      status: "running",
      startedAt: newStart,
      pausedAt: null,
      remainingSec: null,
    });
  }
  async function hostEnd() {
    if (!state.isHost) return;
    try { await partyRef(state.code).update({ status: "ended" }); } catch (_) {}
    try { await partyRef(state.code).delete(); } catch (_) {}
    leaveParty(false);
  }
  async function hostSetBackground(bg) {
    if (!state.isHost) return;
    await partyRef(state.code).update({ background: bg });
  }
  async function hostSetDuration(min) {
    if (!state.isHost || !state.party || state.party.status === "running") return;
    await partyRef(state.code).update({ durationSec: Math.max(60, min * 60) });
  }

  function computeRemainingSec() {
    if (!state.party) return 0;
    if (state.party.status === "paused") return state.party.remainingSec || state.party.durationSec;
    if (state.party.status !== "running" || !state.party.startedAt) return state.party.durationSec;
    const started = state.party.startedAt.toMillis ? state.party.startedAt.toMillis() : Date.now();
    const elapsed = Math.floor((Date.now() - started) / 1000);
    return Math.max(0, state.party.durationSec - elapsed);
  }

  function fmt(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  // -------------- Custom background upload --------------
  async function pickAndUploadCustom() {
    if (!state.isHost) return;
    if (window.isFreePlan && window.isFreePlan()) {
      window.showLockedFeature && window.showLockedFeature("Custom backgrounds", "Become a Supporter to upload your own party background.");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const dataUrl = await compressImage(file, 1280, 0.75);
        if (dataUrl.length > MAX_CUSTOM_BYTES * 1.4) {
          toast("Image too large, please pick a smaller one.");
          return;
        }
        await hostSetBackground({ type: "custom", value: dataUrl });
        toast("Background updated for everyone.");
      } catch (e) {
        toast("Upload failed: " + (e.message || e));
      }
    };
    input.click();
  }

  function compressImage(file, maxW, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = () => reject(new Error("read failed"));
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("image load failed"));
      reader.readAsDataURL(file);
    });
  }

  // -------------- UI: Panel --------------
  function ensurePanel() {
    let p = document.getElementById("study-party-panel");
    if (p) return p;
    p = document.createElement("div");
    p.id = "study-party-panel";
    p.className = "sp-panel hidden";
    p.innerHTML = `
      <div class="sp-panel-inner">
        <div class="sp-panel-head">
          <div class="sp-panel-title"><i data-lucide="users"></i><span>Study Together</span></div>
          <button class="sp-close" id="sp-close" title="Close"><i data-lucide="x"></i></button>
        </div>
        <div class="sp-panel-body" id="sp-body"></div>
      </div>`;
    document.body.appendChild(p);
    p.querySelector("#sp-close").addEventListener("click", () => togglePanel(false));
    return p;
  }
  function togglePanel(force) {
    const p = ensurePanel();
    const showing = force == null ? p.classList.contains("hidden") : !!force;
    p.classList.toggle("hidden", !showing);
    if (showing) renderPanel();
    if (window.lucide) window.lucide.createIcons();
  }

  function renderPanel() {
    const body = document.getElementById("sp-body");
    if (!body) return;
    if (!currentUser()) {
      body.innerHTML = `<div class="sp-empty">Please sign in to use Study Together.</div>`;
      return;
    }
    if (!state.code || !state.party) {
      let savedCode = null;
      try { savedCode = localStorage.getItem("omn-party-code"); } catch (_) {}
      if (savedCode) {
        body.innerHTML = `
          <div class="sp-section" style="text-align:center;">
            <div class="sp-section-title">You were in a party</div>
            <div class="sp-note">It looks like you got disconnected or refreshed the page.</div>
            <div class="sp-code-card" style="margin-top:16px;">
              <div class="sp-code-value" style="font-size:2rem; width:100%; text-align:center;">${esc(savedCode)}</div>
            </div>
            <div class="sp-row sp-row-wrap" style="margin-top:24px; justify-content:center; gap:16px;">
              <button class="sp-btn sp-btn-secondary" id="sp-reconnect-leave"><i data-lucide="x"></i><span>Leave</span></button>
              <button class="sp-btn sp-btn-primary" id="sp-reconnect"><i data-lucide="plug"></i><span>Reconnect</span></button>
            </div>
          </div>`;
        if (window.lucide) window.lucide.createIcons();
        document.getElementById("sp-reconnect").onclick = async () => {
          try {
            await attachParty(savedCode);
            // Verify party actually exists
            const snap = await partyRef(savedCode).get();
            if (!snap.exists) {
               throw new Error("Party has ended or code is invalid.");
            }
            // Re-announce ourselves as a member
            const u = currentUser();
            if (u) {
               await memberRef(savedCode, u.uid).set({
                 name: userName(), avatar: userAvatar(),
                 joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
                 lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
                 state: snap.data().status === "running" ? "focusing" : "idle",
               }, { merge: true });
            }
            savePrevBgOnce();
            toast("Reconnected to party.");
          } catch (e) { 
            try { localStorage.removeItem("omn-party-code"); } catch (_) {}
            toast(e.message || String(e)); 
            renderPanel();
          }
        };
        document.getElementById("sp-reconnect-leave").onclick = () => {
          try { localStorage.removeItem("omn-party-code"); } catch (_) {}
          renderPanel();
        };
        return;
      }

      body.innerHTML = `
        <div class="sp-section">
          <div class="sp-section-title">Host a new party</div>
          <div class="sp-row">
            <label class="sp-label">Duration</label>
            <select id="sp-duration" class="sp-input">
              <option value="25">25 minutes</option>
              <option value="45">45 minutes</option>
              <option value="50" selected>50 minutes</option>
              <option value="60">60 minutes</option>
              <option value="90">90 minutes</option>
            </select>
          </div>
          <button class="sp-btn sp-btn-primary" id="sp-create"><i data-lucide="plus-circle"></i><span>Create party</span></button>
        </div>
        <div class="sp-divider"><span>or</span></div>
        <div class="sp-section">
          <div class="sp-section-title">Join with a code</div>
          <div class="sp-row">
            <input id="sp-join-code" class="sp-input sp-code-input" maxlength="6" placeholder="ABC123" autocomplete="off"/>
            <button class="sp-btn sp-btn-secondary" id="sp-join"><i data-lucide="log-in"></i><span>Join</span></button>
          </div>
        </div>`;
      if (window.lucide) window.lucide.createIcons();
      document.getElementById("sp-create").onclick = async () => {
        try {
          const d = parseInt(document.getElementById("sp-duration").value, 10) || 50;
          const code = await createParty(d);
          await attachParty(code);
          savePrevBgOnce();
          toast("Party created: " + code);
        } catch (e) { toast(e.message || String(e)); }
      };
      document.getElementById("sp-join").onclick = async () => {
        try {
          const raw = document.getElementById("sp-join-code").value;
          const code = await joinParty(raw);
          await attachParty(code);
          savePrevBgOnce();
          toast("Joined party " + code);
        } catch (e) { toast(e.message || String(e)); }
      };
      return;
    }

    // Inside a party
    const p = state.party;
    const remaining = computeRemainingSec();
    const canHost = state.isHost;
    const phaseLabelMap = { focus: "Focusing", shortBreak: "Short Break", longBreak: "Long Break" };
    const currentPhaseLabel = phaseLabelMap[p.phase] || "Focusing";
    const statusLabel = p.status === "running" ? currentPhaseLabel : p.status === "paused" ? "Paused" : p.status === "ended" ? "Ended" : "Waiting to start";
    const bg = p.background || { type: "preset", value: DEFAULT_PARTY_SCENE };
    const usingCustom = bg.type === "custom";

    body.innerHTML = `
      <div class="sp-code-card" style="flex-direction:column; align-items:stretch; gap:12px;">
        <div class="sp-row" style="justify-content:space-between; width:100%;">
          <div style="flex:1; overflow:hidden;">
            <div class="sp-code-label">Invite Link</div>
            <div class="sp-code-value" style="font-size:0.85rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${window.location.origin + window.location.pathname + "?party=" + esc(state.code)}
            </div>
          </div>
          <button class="sp-btn sp-btn-ghost" id="sp-copy" title="Copy"><i data-lucide="copy"></i></button>
        </div>
        <div style="background:var(--bg-secondary, rgba(139, 92, 246, 0.1)); border: 1px solid var(--border-color, rgba(139, 92, 246, 0.2)); padding:8px 12px; border-radius:8px; display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:0.8rem; color:var(--text-muted, #888); font-weight:600; text-transform:uppercase;">Or enter code</span>
          <span style="font-family:monospace; font-size:1.1rem; font-weight:700; letter-spacing:0.1em; color:var(--text-primary); user-select:all; cursor:pointer;" title="Double click to copy">${esc(state.code)}</span>
        </div>
      </div>

      <div class="sp-status-card">
        <div class="sp-status-line"><span class="sp-dot sp-dot-${p.status}"></span><span>${esc(statusLabel)}</span></div>
        <div class="sp-status-timer">${fmt(remaining)}</div>
        <div class="sp-status-sub">${esc(Math.round(p.durationSec / 60))}-minute session · hosted by ${esc(p.hostName || "host")}</div>
      </div>

      ${canHost ? `
      <div class="sp-section">
        <div class="sp-section-title">Host controls</div>
        <div class="sp-row sp-row-wrap" style="gap:8px;">
          ${p.status === "waiting" || p.status === "paused" ? `
            <button class="sp-btn sp-btn-primary" id="sp-start-focus"><i data-lucide="play"></i><span>${p.status === "paused" && p.phase === "focus" ? "Resume Focus" : "Focus"}</span></button>
            <button class="sp-btn sp-btn-secondary" id="sp-start-sbreak"><i data-lucide="coffee"></i><span>Short Break</span></button>
            <button class="sp-btn sp-btn-secondary" id="sp-start-lbreak"><i data-lucide="coffee"></i><span>Long Break</span></button>
          ` : ""}
          ${p.status === "running" ? `<button class="sp-btn sp-btn-secondary" id="sp-pause"><i data-lucide="pause"></i><span>Pause</span></button>` : ""}
          <button class="sp-btn sp-btn-danger" id="sp-end"><i data-lucide="power"></i><span>End party</span></button>
        </div>
        ${p.status === "waiting" ? `
        <div class="sp-row" style="margin-top:10px;">
          <label class="sp-label">Duration</label>
          <select id="sp-duration-h" class="sp-input">
            <option value="25" ${p.durationSec === 1500 ? "selected" : ""}>25 min</option>
            <option value="45" ${p.durationSec === 2700 ? "selected" : ""}>45 min</option>
            <option value="50" ${p.durationSec === 3000 ? "selected" : ""}>50 min</option>
            <option value="60" ${p.durationSec === 3600 ? "selected" : ""}>60 min</option>
            <option value="90" ${p.durationSec === 5400 ? "selected" : ""}>90 min</option>
          </select>
        </div>` : ""}
      </div>` : `
      <div class="sp-section">
        <div class="sp-section-title">Waiting for host</div>
        <div class="sp-note">The host controls start, pause, and end for everyone.</div>
        <button class="sp-btn sp-btn-danger" id="sp-leave"><i data-lucide="log-out"></i><span>Leave party</span></button>
      </div>`}

      <div class="sp-section">
        <div class="sp-section-title">Party scene ${canHost ? "" : "<span class='sp-hint'>(host's choice)</span>"}</div>
        <div class="sp-thumbs">
          ${PARTY_SCENES.map(s => `
            <button class="sp-thumb ${!usingCustom && bg.value === s.id ? "active" : ""}" data-scene="${s.id}" title="${s.label}" style="background-image:url('${s.url}')" ${canHost ? "" : "disabled"}>
              <span>${s.label}</span>
            </button>`).join("")}
        </div>
        ${canHost ? `
          <div class="sp-row sp-row-wrap" style="margin-top:8px;">
            <button class="sp-btn sp-btn-ghost" id="sp-custom"><i data-lucide="upload"></i><span>Upload custom</span></button>
            ${usingCustom ? `<button class="sp-btn sp-btn-ghost" id="sp-reset-bg"><i data-lucide="rotate-ccw"></i><span>Reset to lofi</span></button>` : ""}
          </div>` : `
          <div class="sp-row" style="margin-top:8px;">
            ${state.localOverrideBg ? `<button class="sp-btn sp-btn-ghost" id="sp-follow-host"><i data-lucide="rotate-ccw"></i><span>Back to party scene</span></button>`
              : `<button class="sp-btn sp-btn-ghost" id="sp-personal"><i data-lucide="eye"></i><span>Preview my own scene</span></button>`}
          </div>`}
      </div>

      <div class="sp-section">
        <div class="sp-section-title">In the room <span class="sp-badge">${state.members.length}</span></div>
        <div class="sp-members" id="sp-members"></div>
      </div>`;

    if (window.lucide) window.lucide.createIcons();

    document.getElementById("sp-copy").onclick = () => {
      try {
        const link = window.location.origin + window.location.pathname + "?party=" + state.code;
        navigator.clipboard.writeText(link); 
        toast("Invite link copied"); 
      } catch (_) {}
    };
    const durH = document.getElementById("sp-duration-h");
    const startFocusBtn = document.getElementById("sp-start-focus");
    if (startFocusBtn) startFocusBtn.onclick = () => {
      const min = durH ? parseInt(durH.value, 10) : 25;
      (p.status === "paused" && p.phase === "focus" ? hostResume() : hostStart("focus", min)).catch(e => toast(e.message));
    };
    const startSBreakBtn = document.getElementById("sp-start-sbreak");
    if (startSBreakBtn) startSBreakBtn.onclick = () => hostStart("shortBreak", 5).catch(e => toast(e.message));
    const startLBreakBtn = document.getElementById("sp-start-lbreak");
    if (startLBreakBtn) startLBreakBtn.onclick = () => hostStart("longBreak", 15).catch(e => toast(e.message));
    const pauseBtn = document.getElementById("sp-pause");
    if (pauseBtn) pauseBtn.onclick = () => hostPause().catch(e => toast(e.message));
    const endBtn = document.getElementById("sp-end");
    if (endBtn) endBtn.onclick = () => { if (confirm("End the party for everyone?")) hostEnd().catch(e => toast(e.message)); };
    const leaveBtn = document.getElementById("sp-leave");
    if (leaveBtn) leaveBtn.onclick = () => leaveParty(false);
    if (durH) durH.onchange = () => hostSetDuration(parseInt(durH.value, 10) || 25).catch(e => toast(e.message));

    body.querySelectorAll(".sp-thumb").forEach(t => {
      t.onclick = () => {
        if (!canHost) return;
        hostSetBackground({ type: "preset", value: t.dataset.scene }).catch(e => toast(e.message));
      };
    });
    const custom = document.getElementById("sp-custom");
    if (custom) custom.onclick = pickAndUploadCustom;
    const resetBg = document.getElementById("sp-reset-bg");
    if (resetBg) resetBg.onclick = () => hostSetBackground({ type: "preset", value: DEFAULT_PARTY_SCENE }).catch(e => toast(e.message));
    const personal = document.getElementById("sp-personal");
    if (personal) personal.onclick = () => {
      // Use user's currently-saved book-mode background as personal preview
      const saved = (typeof window.getSelectedBookBg === "function") ? window.getSelectedBookBg() : null;
      if (saved) { state.localOverrideBg = { type: "preset", value: saved.id }; applyBg(state.localOverrideBg); renderPanel(); }
    };
    const follow = document.getElementById("sp-follow-host");
    if (follow) follow.onclick = () => { state.localOverrideBg = null; applyBg(state.party.background); renderPanel(); };

    renderMembers();
  }

  function savePrevBgOnce() {
    if (state.prevPersonalBg) return;
    try {
      if (typeof window.getSelectedBookBg === "function") {
        state.prevPersonalBg = window.getSelectedBookBg();
      }
    } catch (_) {}
  }

  function renderMembers() {
    const el = document.getElementById("sp-members");
    if (!el) return;
    const now = Date.now();
    const live = state.members.filter(m => {
      const ts = m.lastSeen && m.lastSeen.toMillis ? m.lastSeen.toMillis() : now;
      return now - ts < STALE_MS;
    });
    if (!live.length) { el.innerHTML = `<div class="sp-note">No one is here yet.</div>`; return; }
    const hostUid = state.party && state.party.hostUid;
    el.innerHTML = live.map(m => {
      const isHost = m.uid === hostUid;
      const status = m.state || "idle";
      return `
        <div class="sp-member">
          <div class="sp-avatar sp-avatar-${esc(m.avatar || "avatar-1")}"></div>
          <div class="sp-member-info">
            <div class="sp-member-name">${esc(m.name || "Studier")} ${isHost ? `<span class="sp-host-tag">host</span>` : ""}</div>
            <div class="sp-member-sub"><span class="sp-dot sp-dot-${status}"></span><span>${esc(status)}</span></div>
          </div>
        </div>`;
    }).join("");
  }

  function renderTimer() {
    const el = document.querySelector("#sp-body .sp-status-timer");
    const remaining = computeRemainingSec();
    if (el && state.party) el.textContent = fmt(remaining);
    // Also drive the main book-mode clock while in a party
    if (state.party) {
      const clock = document.getElementById("book-clock");
      const phase = document.getElementById("book-phase");
      if (clock) clock.textContent = fmt(remaining);
      const phaseLabelMap = { focus: "focusing", shortBreak: "short break", longBreak: "long break" };
      const currentPhaseLabel = phaseLabelMap[state.party.phase] || "focusing";
      if (phase) phase.textContent = "party · " + (state.party.status === "running" ? currentPhaseLabel : state.party.status);

      // Drive the topbar pomo pill as well!
      const pillTime = document.getElementById("pomo-pill-time");
      const pillPlay = document.getElementById("pomo-pill-play");
      const pill = document.getElementById("pomo-pill");
      if (pillTime && pillPlay && pill) {
        pillTime.textContent = fmt(remaining);
        const wantsRunning = state.party.status === "running";
        const isCurrentlyRunning = pill.classList.contains("running");
        
        if (wantsRunning !== isCurrentlyRunning) {
          if (wantsRunning) {
            pillPlay.innerHTML = '<i data-lucide="pause"></i>';
            pill.classList.add("running");
          } else {
            pillPlay.innerHTML = '<i data-lucide="play"></i>';
            pill.classList.remove("running");
            if (document.title.startsWith('⏱') && !window.__omnoteOcrRunning) {
              document.title = 'OmNote — Intelligent Learning Platform';
            }
          }
          if (window.lucide) window.lucide.createIcons({root: pillPlay});
        }
        
        if (wantsRunning && !window.__omnoteOcrRunning) {
          document.title = `⏱ ${fmt(remaining)} — Party`;
        }

        pill.classList.remove("phase-focus", "phase-short", "phase-long");
        if (state.party.phase === "shortBreak") {
          pill.classList.add("phase-short");
        } else if (state.party.phase === "longBreak") {
          pill.classList.add("phase-long");
        } else {
          pill.classList.add("phase-focus");
        }
        if (window.lucide) window.lucide.createIcons({root: pillPlay});
      }
    }
    // Auto-pause when countdown hits zero (host only, to avoid multi-writes)
    if (state.isHost && state.party && state.party.status === "running" && remaining === 0) {
      hostPause().catch(() => {});
    }
  }

  function togglePartyState() {
      if (!state.isHost || !state.party) {
          toast("Only the host can pause/resume the party.");
          return;
      }
      if (state.party.status === 'running') {
          hostPause().catch(e => toast(e.message));
      } else if (state.party.status === 'paused') {
          hostResume().catch(e => toast(e.message));
      } else {
          hostStart().catch(e => toast(e.message));
      }
  }

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "sp-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2500);
  }

  // Public API for book-mode.js
  window.StudyParty = {
    togglePanel,
    isInParty: () => !!state.code,
    leaveParty,
    getSharedBackground: () => state.party ? state.party.background : null,
    applySharedBackground: applyBg,
    togglePartyState,
    PARTY_SCENES,
    DEFAULT_PARTY_SCENE,
  };
  console.log("[StudyParty] module ready, window.StudyParty =", Object.keys(window.StudyParty));

  // Auto-leave on tab close
  window.addEventListener("beforeunload", () => {
    if (state.code && currentUser()) {
      try { memberRef(state.code, currentUser().uid).delete(); } catch (_) {}
    }
  });

  // Auto-join from URL parameter ?party=XYZ
  const urlParams = new URLSearchParams(window.location.search);
  const partyToJoin = urlParams.get("party");
  if (partyToJoin) {
    let joined = false;
    auth().onAuthStateChanged(async u => {
      if (joined) return;
      if (u && !state.code) {
        joined = true;
        try {
          const code = await joinParty(partyToJoin);
          await attachParty(code);
          savePrevBgOnce();
          togglePanel(true);
          toast("Joined party from invite link!");
        } catch (e) {
          togglePanel(true);
          toast("Invite link error: " + (e.message || String(e)));
        }
        const url = new URL(window.location.href);
        url.searchParams.delete('party');
        window.history.replaceState({}, document.title, url.toString());
      } else if (!u) {
        togglePanel(true);
        toast("Sign in to join the party!");
      }
    });
  }
})();
