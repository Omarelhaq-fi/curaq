// User-facing support ticket panel. Talks to /api/support only.
// Polls unread count every 60s and refreshes the open thread every 15s
// while the panel is visible.
(function () {
  let panel = null;
  let currentTicket = null; // { id, ticket, messages }
  let poller = null;
  let unreadPoller = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function timeAgo(iso) {
    if (!iso) return "";
    const d = new Date(iso).getTime();
    if (!d) return "";
    const s = Math.floor((Date.now() - d) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString();
  }

  async function authToken() {
    const u = window.firebase && firebase.auth && firebase.auth().currentUser;
    if (!u) throw new Error("Not signed in");
    return u.getIdToken();
  }
  async function api(path, opts) {
    const token = await authToken();
    const headers = Object.assign(
      { "Content-Type": "application/json", Authorization: "Bearer " + token },
      (opts && opts.headers) || {},
    );
    const r = await fetch(path, Object.assign({}, opts || {}, { headers }));
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || ("HTTP " + r.status));
    return data;
  }

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "support-panel";
    panel.className = "support-panel";
    panel.style.display = "none";
    panel.innerHTML = `
      <div class="support-head">
        <div class="support-title"><i data-lucide="life-buoy"></i> <span>Support</span></div>
        <button class="support-close" id="support-close" title="Close">×</button>
      </div>
      <div class="support-body" id="support-body"></div>
    `;
    document.body.appendChild(panel);
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    panel.querySelector("#support-close").addEventListener("click", closePanel);
    document.addEventListener("mousedown", (e) => {
      if (panel.style.display === "none") return;
      const path = (typeof e.composedPath === "function") ? e.composedPath() : [];
      if (path.includes(panel)) return;
      if (panel.contains(e.target)) return;
      const btn = document.getElementById("support-btn");
      if (btn && (btn.contains(e.target) || path.includes(btn))) return;
      closePanel();
    });
    return panel;
  }

  function positionPanel() {
    const btn = document.getElementById("support-btn");
    if (!btn || !panel) return;
    const rect = btn.getBoundingClientRect();
    const width = 420;
    let left = rect.right - width;
    if (left < 10) left = 10;
    panel.style.top = (rect.bottom + 8) + "px";
    panel.style.left = left + "px";
    panel.style.width = width + "px";
  }

  function closePanel() {
    if (!panel) return;
    panel.style.display = "none";
    stopThreadPoll();
    currentTicket = null;
  }

  function stopThreadPoll() {
    if (poller) { clearInterval(poller); poller = null; }
  }

  async function renderList() {
    ensurePanel();
    const host = panel.querySelector("#support-body");
    host.innerHTML = `<div class="support-loading">Loading…</div>`;
    let data;
    try { data = await api("/api/support?action=list", { method: "GET" }); }
    catch (e) { host.innerHTML = `<div class="support-error">${esc(e.message)}</div>`; return; }
    const tickets = data.tickets || [];
    const rows = tickets.map((t) => `
      <div class="support-row ${t.userUnread ? "is-unread" : ""}" data-open="${esc(t.id)}">
        <div class="support-row-top">
          <div class="support-row-subject">${esc(t.subject)}</div>
          <span class="support-status ${t.status === "resolved" ? "is-resolved" : "is-open"}">${t.status === "resolved" ? "Resolved" : "Open"}</span>
        </div>
        <div class="support-row-meta">
          <span>${esc(t.category)}</span>
          <span>·</span>
          <span>${esc(timeAgo(t.lastMessageAt || t.createdAt))}</span>
        </div>
        <div class="support-row-preview">${esc(t.lastMessagePreview || "")}</div>
      </div>
    `).join("");
    host.innerHTML = `
      <div class="support-toolbar">
        <button class="support-new-btn" id="support-new-btn"><i data-lucide="plus"></i> New ticket</button>
      </div>
      <div class="support-list">
        ${rows || `<div class="support-empty"><i data-lucide="messages-square"></i><div>No tickets yet. Open one to talk with the team.</div></div>`}
      </div>
    `;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    host.querySelectorAll("[data-open]").forEach((el) => {
      el.addEventListener("click", () => openThread(el.getAttribute("data-open")));
    });
    host.querySelector("#support-new-btn").addEventListener("click", renderNewForm);
  }

  function renderNewForm() {
    ensurePanel();
    const host = panel.querySelector("#support-body");
    host.innerHTML = `
      <div class="support-form">
        <button class="support-back" id="support-back"><i data-lucide="arrow-left"></i> Back</button>
        <label class="support-label">Category</label>
        <select id="support-cat" class="support-input">
          <option value="payment">Payment / Upgrade</option>
          <option value="bug">Bug report</option>
          <option value="account">Account</option>
          <option value="feature">Feature request</option>
          <option value="other" selected>Other</option>
        </select>
        <label class="support-label">Subject</label>
        <input id="support-subj" class="support-input" placeholder="Short summary" maxlength="140">
        <label class="support-label">Message</label>
        <textarea id="support-msg" class="support-input support-textarea" placeholder="Describe what you need help with…" maxlength="4000"></textarea>
        <button class="support-send" id="support-send"><i data-lucide="send"></i> Send</button>
        <div id="support-form-err" class="support-error" style="display:none;"></div>
      </div>
    `;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    host.querySelector("#support-back").addEventListener("click", renderList);
    host.querySelector("#support-send").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      const cat = host.querySelector("#support-cat").value;
      const subject = host.querySelector("#support-subj").value.trim();
      const message = host.querySelector("#support-msg").value.trim();
      const err = host.querySelector("#support-form-err");
      err.style.display = "none";
      if (!subject || !message) {
        err.textContent = "Please add a subject and message.";
        err.style.display = "block";
        btn.disabled = false;
        return;
      }
      try {
        const res = await api("/api/support", {
          method: "POST",
          body: JSON.stringify({ action: "create", category: cat, subject, message }),
        });
        openThread(res.id);
      } catch (e) {
        err.textContent = e.message;
        err.style.display = "block";
        btn.disabled = false;
      }
    });
  }

  async function openThread(id) {
    ensurePanel();
    const host = panel.querySelector("#support-body");
    host.innerHTML = `<div class="support-loading">Loading conversation…</div>`;
    try {
      const data = await api(`/api/support?action=thread&id=${encodeURIComponent(id)}`, { method: "GET" });
      currentTicket = { id, ticket: data.ticket, messages: data.messages || [] };
      renderThread();
      stopThreadPoll();
      poller = setInterval(refreshThread, 15000);
    } catch (e) {
      host.innerHTML = `<div class="support-error">${esc(e.message)}</div>`;
    }
  }

  async function refreshThread() {
    if (!currentTicket) return;
    try {
      const data = await api(
        `/api/support?action=thread&id=${encodeURIComponent(currentTicket.id)}`,
        { method: "GET" },
      );
      const before = currentTicket.messages.length;
      currentTicket.ticket = data.ticket;
      currentTicket.messages = data.messages || [];
      if (currentTicket.messages.length !== before) renderThread(true);
    } catch (_) { /* keep panel */ }
  }

  function renderThread(keepInput) {
    if (!panel || !currentTicket) return;
    const host = panel.querySelector("#support-body");
    const draft = keepInput
      ? (host.querySelector("#support-reply-input") || {}).value || ""
      : "";
    const t = currentTicket.ticket;
    const msgs = currentTicket.messages.map((m) => `
      <div class="support-msg ${m.from === "admin" ? "is-admin" : "is-user"}">
        <div class="support-msg-meta">
          <strong>${m.from === "admin" ? "Support" : "You"}</strong>
          <span>${esc(fmtTime(m.createdAt))}</span>
        </div>
        <div class="support-msg-text">${esc(m.text).replace(/\n/g, "<br>")}</div>
      </div>
    `).join("");
    host.innerHTML = `
      <div class="support-thread">
        <button class="support-back" id="support-back"><i data-lucide="arrow-left"></i> Back</button>
        <div class="support-thread-head">
          <div class="support-thread-subject">${esc(t.subject)}</div>
          <span class="support-status ${t.status === "resolved" ? "is-resolved" : "is-open"}">${t.status === "resolved" ? "Resolved" : "Open"}</span>
        </div>
        <div class="support-thread-scroll" id="support-thread-scroll">${msgs}</div>
        <div class="support-reply">
          <textarea id="support-reply-input" class="support-input support-textarea" placeholder="Type a reply…" maxlength="4000">${esc(draft)}</textarea>
          <button class="support-send" id="support-reply-send"><i data-lucide="send"></i></button>
        </div>
      </div>
    `;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    host.querySelector("#support-back").addEventListener("click", renderList);
    const scroll = host.querySelector("#support-thread-scroll");
    scroll.scrollTop = scroll.scrollHeight;
    host.querySelector("#support-reply-send").addEventListener("click", sendReply);
    host.querySelector("#support-reply-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendReply(); }
    });
  }

  async function sendReply() {
    if (!currentTicket) return;
    const input = document.getElementById("support-reply-input");
    const btn = document.getElementById("support-reply-send");
    if (!input || !btn || btn.disabled) return;
    const text = input.value.trim();
    if (!text) return;
    btn.disabled = true;
    try {
      await api("/api/support", {
        method: "POST",
        body: JSON.stringify({ action: "reply", id: currentTicket.id, message: text }),
      });
      input.value = "";
      await refreshThread();
    } catch (e) {
      alert(e.message);
    } finally {
      btn.disabled = false;
    }
  }

  window.toggleSupportPanel = function () {
    ensurePanel();
    const open = panel.style.display !== "none";
    if (open) { closePanel(); return; }
    positionPanel();
    panel.style.display = "flex";
    renderList();
  };

  window.openSupportNewTicket = function (opts) {
    opts = opts || {};
    ensurePanel();
    positionPanel();
    panel.style.display = "flex";
    renderNewForm();
    setTimeout(() => {
      const cat = panel.querySelector("#support-cat");
      const subj = panel.querySelector("#support-subj");
      const msg = panel.querySelector("#support-msg");
      if (cat && opts.category) cat.value = opts.category;
      if (subj && opts.subject) subj.value = opts.subject;
      if (msg && opts.message) msg.value = opts.message;
      if (subj) subj.focus();
    }, 30);
  };


  async function refreshBadge() {
    const badge = document.getElementById("support-btn-badge");
    if (!badge) return;
    try {
      const d = await api("/api/support?action=unread", { method: "GET" });
      const n = Number(d.count || 0);
      const total = Number(d.totalTickets || 0);

      // 99% of users have no tickets. Stop polling to save 1 read per minute!
      if (total === 0) {
         if (unreadPoller) { clearInterval(unreadPoller); unreadPoller = null; }
      }

      if (n <= 0) { badge.style.display = "none"; return; }
      badge.style.display = "inline-flex";
      badge.textContent = n > 9 ? "9+" : String(n);
    } catch (_) { badge.style.display = "none"; }
  }

  function init() {
    if (!window.firebase || !firebase.auth) return;
    firebase.auth().onAuthStateChanged((u) => {
      if (unreadPoller) { clearInterval(unreadPoller); unreadPoller = null; }
      if (!u) {
        closePanel();
        const badge = document.getElementById("support-btn-badge");
        if (badge) badge.style.display = "none";
        return;
      }
      refreshBadge();
      unreadPoller = setInterval(refreshBadge, 300000); // Poll every 5 minutes instead of 1 minute
    });
    window.addEventListener("resize", () => {
      if (panel && panel.style.display !== "none") positionPanel();
    });
  }
  document.addEventListener("DOMContentLoaded", init);
})();
