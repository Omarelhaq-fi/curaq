// public/app/js/qbank-party.js
(function () {
  console.log("[QBankParty] module loading…");
  
  window.qbankToast = function(msg, isError = false) {
    const t = document.createElement("div");
    t.style.position = "fixed";
    t.style.bottom = "20px";
    t.style.left = "50%";
    t.style.transform = "translateX(-50%)";
    t.style.background = isError ? "var(--accent-red)" : "var(--primary)";
    t.style.color = "#fff";
    t.style.padding = "10px 20px";
    t.style.borderRadius = "8px";
    t.style.zIndex = "999999";
    t.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";
    t.style.transition = "opacity 0.3s";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
        t.style.opacity = "0";
        setTimeout(() => t.remove(), 300);
    }, 3000);
  };

  window.qbankPrompt = function(msg, callback) {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.top = "0"; overlay.style.left = "0"; overlay.style.width = "100%"; overlay.style.height = "100%";
    overlay.style.background = "rgba(0,0,0,0.5)";
    overlay.style.zIndex = "999999";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    
    const modal = document.createElement("div");
    modal.style.background = "var(--bg-card, #1e293b)";
    modal.style.padding = "24px";
    modal.style.borderRadius = "12px";
    modal.style.width = "300px";
    modal.style.boxShadow = "0 8px 24px rgba(0,0,0,0.4)";
    modal.style.border = "1px solid rgba(255,255,255,0.1)";
    modal.style.color = "var(--text-primary, #fff)";
    
    const title = document.createElement("div");
    title.textContent = msg;
    title.style.marginBottom = "16px";
    title.style.fontWeight = "bold";
    
    const input = document.createElement("input");
    input.type = "text";
    input.className = "form-control";
    input.style.width = "100%";
    input.style.marginBottom = "16px";
    
    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.justifyContent = "flex-end";
    btnRow.style.gap = "8px";
    
    const cancel = document.createElement("button");
    cancel.className = "btn-secondary";
    cancel.textContent = "Cancel";
    cancel.onclick = () => { overlay.remove(); callback(null); };
    
    const ok = document.createElement("button");
    ok.className = "btn-primary";
    ok.textContent = "OK";
    ok.onclick = () => { overlay.remove(); callback(input.value); };
    
    btnRow.appendChild(cancel);
    btnRow.appendChild(ok);
    modal.appendChild(title);
    modal.appendChild(input);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    input.focus();
    input.onkeydown = (e) => { if (e.key === "Enter") ok.onclick(); if (e.key === "Escape") cancel.onclick(); };
  };

  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; 

  if (window.__hmr_qbank_detachParty) {
    try { window.__hmr_qbank_detachParty(); } catch (e) {}
  }

  let state = {
    code: null,
    isHost: false,
    party: null,
    members: [],
    messages: [],
    unsubscribeParty: null,
    unsubscribeMembers: null,
    unsubscribeChat: null,
    timeLimitSec: null,
    questionTimerHandle: null,
    questionStartTime: 0,
    hasLocked: false,
    revealedOthers: false,
  };

  function fs() { return window.firebase.firestore(); }
  function auth() { return window.firebase.auth(); }
  function currentUser() { return auth().currentUser; }
  function partyRef(code) { return fs().collection("answerParties").doc(code); }
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
    const u = currentUser();
    if (!u) return "Guest";
    if (u.displayName) return u.displayName;
    if (u.email) return u.email.split("@")[0];
    return "Studier";
  }

  // API Methods
  async function createParty(qbankId, subject, timeLimitSec = 0) {
    const u = currentUser();
    if (!u) throw new Error("Please sign in to host an Answer Party.");
    
    const code = await reserveCode();
    const now = firebase.firestore.FieldValue.serverTimestamp();
    
    await partyRef(code).set({
      hostUid: u.uid,
      hostName: userName(),
      status: "waiting", // waiting | playing | revealing
      qbankId: qbankId,
      subject: subject || "All",
      currentQuestionId: null,
      questionStartTime: null,
      timeLimitSec: timeLimitSec,
      createdAt: now,
    });
    
    await memberRef(code, u.uid).set({
      name: userName(),
      score: 0,
      lockedAnswer: null,
      ready: true,
    });
    
    return code;
  }

  async function joinParty(rawCode) {
    const u = currentUser();
    if (!u) throw new Error("Please sign in to join.");
    const code = String(rawCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 6) throw new Error("Party code must be 6 characters.");
    
    const snap = await partyRef(code).get();
    if (!snap.exists) throw new Error("Party not found.");
    
    const p = snap.data();
    if (p.status === "ended") throw new Error("This party has ended.");
    
    await memberRef(code, u.uid).set({
      name: userName(),
      score: 0,
      lockedAnswer: null,
      ready: true,
    }, { merge: true });
    
    return code;
  }

  async function attachParty(code) {
    detachParty();
    state.code = code;
    
    state.unsubscribeParty = partyRef(code).onSnapshot(snap => {
      if (!snap.exists) {
        onPartyEnded();
        return;
      }
      const p = snap.data();
      const u = currentUser();
      state.isHost = !!(u && p.hostUid === u.uid);
      
      const prevQ = state.party ? state.party.currentQuestionId : null;
      const prevStatus = state.party ? state.party.status : null;
      
      state.party = p;
      state.timeLimitSec = p.timeLimitSec || null;
      
      if (prevQ !== p.currentQuestionId) {
         state.hasLocked = false;
         state.revealedOthers = false;
      }
      
      updatePartyUI();
      
      // If we joined a party and the modal isn't open, or we're on the wrong QBank, open it
      const qbankModal = document.getElementById("qbank-modal");
      if (p.qbankId && ((window.db && window.db.selectedQBankId !== p.qbankId) || (qbankModal && qbankModal.style.display === "none"))) {
         if (typeof window.startQBankSession === 'function') {
            window.db = window.db || {};
            window.db.selectedQBankId = p.qbankId;
            const targetSubj = (p.subject && p.subject !== "All" && p.subject !== "All Subjects") ? p.subject : null;
            window.startQBankSession(p.qbankId, "Answer Party", targetSubj);
         }
      }
      
      if (typeof window.qbankPartyStateChanged === 'function') {
         window.qbankPartyStateChanged(prevQ !== p.currentQuestionId, prevStatus !== p.status);
      }
    });

    state.unsubscribeMembers = partyRef(code).collection("members").onSnapshot(qs => {
      const list = [];
      qs.forEach(d => list.push({ uid: d.id, ...d.data() }));
      state.members = list;
      
      updatePartyUI();
      
      if (typeof window.qbankPartyMembersChanged === 'function') {
         window.qbankPartyMembersChanged();
      }
      checkAllLocked();
    });

    state.unsubscribeChat = partyRef(code).collection("chat").orderBy("timestamp", "asc").limitToLast(50).onSnapshot(qs => {
      const msgs = [];
      qs.forEach(d => msgs.push({ id: d.id, ...d.data() }));
      state.messages = msgs;
      updateChatUI();
    });
  }

  function updatePartyUI() {
    const sidebar = document.getElementById('qbank-party-sidebar');
    if (!sidebar) return;
    sidebar.style.display = 'flex';
    
    document.getElementById('qbank-party-code-display').textContent = state.code || '';
    
    const hostControls = document.getElementById('qbank-party-host-controls');
    if (state.isHost) {
       hostControls.style.display = 'block';
       if (state.party && state.party.status === 'waiting') {
           hostControls.innerHTML = `<button class="btn-action primary" style="width:100%;" onclick="window.QBankParty.hostStartSession(window.currentQuestions && window.currentIndex !== undefined ? window.currentQuestions[window.currentIndex]?.id : window.currentQuestions?.[0]?.id)">Start Session</button>`;
       } else if (state.party && state.party.status === 'playing') {
           hostControls.innerHTML = `<div style="font-size:0.85rem; text-align:center; color:var(--text-muted);">Waiting for players to lock answers...</div>`;
       } else if (state.party && state.party.status === 'revealing') {
           hostControls.innerHTML = `<button class="btn-action primary" style="width:100%;" onclick="window.QBankParty.hostNextQuestion()">Next Question</button>`;
       }
    } else {
       hostControls.style.display = 'none';
    }
    
    // Leaderboard
    const board = document.getElementById('qbank-party-leaderboard');
    if (board) {
      board.innerHTML = state.members.sort((a,b)=> (b.score||0)-(a.score||0)).map(m => {
         const isMe = currentUser() && m.uid === currentUser().uid;
         let statusIcon = '';
         if (state.party && state.party.status === 'playing') {
             if (m.lockedAnswer !== null) statusIcon = '<i data-lucide="check-circle" style="color:#22c55e; width:16px; height:16px;"></i>';
             else statusIcon = '<i data-lucide="loader" class="spin" style="color:var(--text-muted); width:16px; height:16px;"></i>';
         } else if (state.party && state.party.status === 'revealing' && state.revealedOthers) {
             // Show what they answered
             statusIcon = `<span style="font-size:0.8rem; background:var(--surface-container-high); padding:2px 6px; border-radius:4px;">Ans: ${JSON.stringify(m.lockedAnswer)}</span>`;
         }
         return `
         <div style="display:flex; justify-content:space-between; align-items:center; background:var(--surface-container); padding:8px 12px; border-radius:8px; ${isMe ? 'border:1px solid var(--primary);' : ''}">
           <div style="display:flex; align-items:center; gap:8px;">
             ${statusIcon}
             <div style="font-weight:600; font-size:0.95rem;">${escapeHtml(m.name)}</div>
           </div>
           <div style="font-weight:bold; color:var(--primary);">${m.score || 0}</div>
         </div>
         `;
      }).join('');
      if (window.lucide) window.lucide.createIcons();
    }
  }
  
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  function updateChatUI() {
     const history = document.getElementById('qbank-party-chat-history');
     if (!history) return;
     history.innerHTML = state.messages.map(m => {
        const isMe = currentUser() && m.uid === currentUser().uid;
        return `
        <div style="display:flex; flex-direction:column; align-items:${isMe ? 'flex-end' : 'flex-start'}; margin-bottom:4px;">
           <span style="font-size:0.75rem; color:var(--text-muted); margin-bottom:2px;">${escapeHtml(m.name)}</span>
           <div style="background:${isMe ? 'var(--primary)' : 'var(--surface-container-high)'}; color:${isMe ? '#fff' : 'var(--text-on-surface)'}; padding:6px 10px; border-radius:12px; max-width:85%; word-break:break-word;">
              ${escapeHtml(m.text)}
           </div>
        </div>
        `;
     }).join('');
     history.scrollTop = history.scrollHeight;
  }

  function detachParty() {
    if (state.unsubscribeParty) { state.unsubscribeParty(); state.unsubscribeParty = null; }
    if (state.unsubscribeMembers) { state.unsubscribeMembers(); state.unsubscribeMembers = null; }
    if (state.unsubscribeChat) { state.unsubscribeChat(); state.unsubscribeChat = null; }
    state.code = null; state.party = null; state.members = []; state.messages = []; state.isHost = false;
  }
  window.__hmr_qbank_detachParty = detachParty;

  function onPartyEnded() {
    window.qbankToast("The host has ended the party.", true);
    leaveParty();
    if (typeof window.goHome === 'function') window.goHome();
  }

  async function leaveParty() {
    const u = currentUser();
    const code = state.code;
    detachParty();
    if (code && u) {
      try { await memberRef(code, u.uid).delete(); } catch (_) {}
    }
    // Clean up UI
    if (typeof window.qbankPartyLeft === 'function') window.qbankPartyLeft();
  }
  
  async function hostStartSession(firstQuestionId) {
    if (!state.isHost || !firstQuestionId) {
        window.qbankToast("Cannot start: No questions available.", true);
        return;
    }
    
    // Clear all locks just in case
    const batch = fs().batch();
    // Clear locked status of members
    state.members.forEach(m => {
       batch.update(memberRef(state.code, m.uid), { locked: false, lockedAnswer: null });
    });
    
    batch.update(partyRef(state.code), {
       status: "playing",
       currentQuestionId: firstQuestionId,
       questionStartTime: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    await batch.commit();
  }
  
  async function hostNextQuestion() {
     if (!state.isHost) return;
     
     // Find the next question ID locally from window.currentQuestions
     if (!window.currentQuestions || window.currentQuestions.length === 0) return;
     
     let nextIndex = window.currentIndex + 1;
     if (nextIndex >= window.currentQuestions.length) {
         // Party is over, or loop around? Let's just alert
         window.qbankToast("No more questions!", true);
         return;
     }
     
     const nextQuestionId = window.currentQuestions[nextIndex].id;
     
     // Clear all locks
     const batch = fs().batch();
     state.members.forEach(m => {
       batch.update(memberRef(state.code, m.uid), { locked: false, lockedAnswer: null });
     });
     
     batch.update(partyRef(state.code), {
        status: "playing",
        currentQuestionId: nextQuestionId,
        questionStartTime: firebase.firestore.FieldValue.serverTimestamp()
     });
     
     await batch.commit();
  }
  
  async function hostEndParty() {
     if (!state.isHost) return;
     try { await partyRef(state.code).update({ status: "ended" }); } catch (_) {}
     try { await partyRef(state.code).delete(); } catch (_) {}
     leaveParty();
  }

  async function lockAnswer(selectedIndices) {
    if (!state.code || !currentUser()) return;
    state.hasLocked = true;
    await memberRef(state.code, currentUser().uid).update({
       lockedAnswer: selectedIndices
    });
  }

  async function updateScore(increment) {
    if (!state.code || !currentUser()) return;
    const uid = currentUser().uid;
    const me = state.members.find(m => m.uid === uid);
    const newScore = (me ? (me.score || 0) : 0) + increment;
    await memberRef(state.code, uid).update({ score: newScore });
  }

  async function sendChatMessage(text) {
     if (!state.code || !currentUser() || !text.trim()) return;
     await partyRef(state.code).collection("chat").add({
        uid: currentUser().uid,
        name: userName(),
        text: text.trim(),
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
     });
  }

  async function checkAllLocked() {
    if (!state.isHost || !state.party || state.party.status !== "playing") return;
    
    // Check if everyone has locked
    const allLocked = state.members.every(m => m.lockedAnswer !== null);
    if (allLocked && state.members.length > 0) {
       await partyRef(state.code).update({ status: "revealing" });
    }
  }
  
  function revealOthers() {
      state.revealedOthers = true;
      updatePartyUI();
  }

  window.QBankParty = {
    state,
    createParty,
    joinParty,
    leaveParty,
    attachParty,
    hostStartSession,
    hostNextQuestion,
    hostEndParty,
    lockAnswer,
    updateScore,
    sendChatMessage,
    revealOthers
  };
})();
