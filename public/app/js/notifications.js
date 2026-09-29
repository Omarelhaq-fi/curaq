// Notification bell + panel driven by a Firestore snapshot listener.
// Admin sends broadcasts via /api/notifications; per-user copies land at
// users/{uid}/notifications and stream in here in real time.
(function () {
  let unsub = null;
  let items = [];
  let panel = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function typeMeta(type) {
    switch (type) {
      case "success": return { color: "#22c55e", icon: "check-circle" };
      case "warning": return { color: "#f59e0b", icon: "alert-triangle" };
      case "promo":   return { color: "#a855f7", icon: "sparkles" };
      default:        return { color: "#06b6d4", icon: "info" };
    }
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

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "notif-panel";
    panel.className = "notif-panel";
    panel.style.display = "none";
    panel.innerHTML = `
      <div class="notif-head">
        <div class="notif-title"><i data-lucide="bell"></i> Notifications</div>
        <button class="notif-markall" id="notif-markall" type="button">Mark all read</button>
      </div>
      <div class="notif-list" id="notif-list"></div>
    `;
    document.body.appendChild(panel);
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    panel.querySelector("#notif-markall").addEventListener("click", markAllRead);
    document.addEventListener("click", (e) => {
      if (panel.style.display === "none") return;
      if (panel.contains(e.target)) return;
      const btn = document.getElementById("notif-bell");
      if (btn && btn.contains(e.target)) return;
      panel.style.display = "none";
    });
    return panel;
  }

  function positionPanel() {
    const btn = document.getElementById("notif-bell");
    if (!btn || !panel) return;
    const rect = btn.getBoundingClientRect();
    const width = 380;
    let left = rect.right - width;
    if (left < 10) left = 10;
    panel.style.top = (rect.bottom + 8) + "px";
    panel.style.left = left + "px";
    panel.style.width = width + "px";
  }

  function renderList() {
    ensurePanel();
    const list = panel.querySelector("#notif-list");
    if (!items.length) {
      list.innerHTML = `
        <div class="notif-empty">
          <i data-lucide="bell-off"></i>
          <div>You're all caught up</div>
        </div>`;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      return;
    }
    list.innerHTML = items.map((n) => {
      const m = typeMeta(n.type);
      const linkPill = n.link
        ? `<span class="notif-linkpill"><i data-lucide="arrow-right"></i> ${
            esc(n.link.kind === "tab" ? "Open " + n.link.value : "Open link")
          }</span>`
        : "";
      return `
        <div class="notif-item ${n.read ? "is-read" : "is-unread"}"
             data-id="${esc(n.id)}"
             data-link-kind="${esc(n.link?.kind || "")}"
             data-link-value="${esc(n.link?.value || "")}">
          <div class="notif-item-icon" style="color:${m.color};background:${m.color}22;">
            <i data-lucide="${m.icon}"></i>
          </div>
          <div class="notif-item-body">
            <div class="notif-item-title">${esc(n.title)}</div>
            <div class="notif-item-msg">${esc(n.body)}</div>
            <div class="notif-item-meta">
              <span>${esc(timeAgo(n.createdAt))}</span>
              ${linkPill}
            </div>
          </div>
          <button class="notif-item-close" title="Dismiss" data-dismiss="${esc(n.id)}">×</button>
        </div>`;
    }).join("");
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    list.querySelectorAll(".notif-item").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-dismiss]")) return;
        onItemClick(el.dataset.id, el.dataset.linkKind, el.dataset.linkValue);
      });
    });
    list.querySelectorAll("[data-dismiss]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        dismissItem(el.dataset.dismiss);
      });
    });
  }

  function renderBadge() {
    const badge = document.getElementById("notif-bell-badge");
    if (!badge) return;
    const unread = items.filter((i) => !i.read).length;
    if (unread <= 0) { badge.style.display = "none"; return; }
    badge.style.display = "inline-flex";
    badge.textContent = unread > 9 ? "9+" : String(unread);
  }

  window.toggleNotifications = function() {
    ensurePanel();
    ensureListener(); // lazy-attach: first open pays the 1 read, boots pay 0
    if (panel.style.display === "none") {
      panel.style.display = "block";
      positionPanel();
      renderList();
    } else {
      panel.style.display = "none";
    }
  };

  async function markRead(id) {
    const user = firebase.auth().currentUser;
    if (!user) return;
    try {
      await firebase.firestore()
        .collection("users").doc(user.uid)
        .collection("notifications").doc(id)
        .update({ read: true, readAt: firebase.firestore.FieldValue.serverTimestamp() });
    } catch (e) { console.warn("[notif] mark read failed", e); }
  }

  async function markAllRead() {
    const user = firebase.auth().currentUser;
    if (!user) return;
    const db = firebase.firestore();
    const batch = db.batch();
    let n = 0;
    for (const it of items) {
      if (it.read) continue;
      const ref = db.collection("users").doc(user.uid)
        .collection("notifications").doc(it.id);
      batch.update(ref, {
        read: true,
        readAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      n++;
      if (n >= 400) break;
    }
    if (n > 0) { try { await batch.commit(); } catch (e) { console.warn("[notif] markall failed", e); } }
  }

  async function dismissItem(id) {
    const user = firebase.auth().currentUser;
    if (!user) return;
    try {
      await firebase.firestore()
        .collection("users").doc(user.uid)
        .collection("notifications").doc(id).delete();
    } catch (e) { console.warn("[notif] dismiss failed", e); }
  }

  function onItemClick(id, kind, value) {
    markRead(id);
    if (kind === "url" && value) {
      window.open(value, "_blank", "noopener,noreferrer");
    } else if (kind === "tab" && value) {
      if (value === "qbank" && typeof window.openQBank === "function") {
        window.openQBank();
      } else if (typeof window.switchMainTab === "function") {
        try { window.switchMainTab(value); } catch (e) { console.warn(e); }
      }
    }
    // Close the notification panel after clicking
    if (panel) panel.style.display = "none";
  }

  window.toggleNotifPanel = function () {
    ensurePanel();
    ensureListener(); // lazy-attach: first open pays the 1 read, boots pay 0
    const open = panel.style.display !== "none";
    if (open) { panel.style.display = "none"; return; }
    positionPanel();
    panel.style.display = "block";
    renderList();
  };

  function attachListener(uid) {
    if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
    attachedUid = uid;
    const db = firebase.firestore();
    unsub = db.collection("users").doc(uid).collection("notifications")
      .orderBy("createdAt", "desc").limit(30)
      .onSnapshot((snap) => {
        items = snap.docs.map((d) => {
          const x = d.data() || {};
          let createdAt = null;
          if (x.createdAt && typeof x.createdAt.toDate === "function") {
            createdAt = x.createdAt.toDate().toISOString();
          } else if (typeof x.createdAt === "string") {
            createdAt = x.createdAt;
          }
          return {
            id: d.id,
            title: x.title || "",
            body: x.body || "",
            type: x.type || "info",
            link: x.link && x.link.kind ? { kind: x.link.kind, value: x.link.value || "" } : null,
            read: !!x.read,
            createdAt,
          };
        });
        renderBadge();
        if (panel && panel.style.display !== "none") renderList();
      }, (err) => console.warn("[notif] listener error", err));
  }

  // Lazy listener: attaching on boot costs 1 read every session for a
  // badge most users never look at. First bell/panel open attaches it;
  // it then stays live for the rest of the session.
  let attachedUid = null;
  function ensureListener() {
    try {
      const u = window.firebase && firebase.auth && firebase.auth().currentUser;
      if (!u) return;
      if (unsub && attachedUid === u.uid) return;
      attachListener(u.uid);
    } catch (_) {}
  }

  function init() {
    if (!window.firebase || !firebase.auth) return;
    if (window.__notifAuthUnsub) { try { window.__notifAuthUnsub(); } catch (_) {} }
    window.__notifAuthUnsub = firebase.auth().onAuthStateChanged((u) => {
      if (u) {
        if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
        attachedUid = null;
        items = []; renderBadge();
      } else {
        if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
        attachedUid = null;
        items = []; renderBadge();
      }
    });

    window.addEventListener("resize", () => {
      if (panel && panel.style.display !== "none") positionPanel();
    });
  }
  document.addEventListener("DOMContentLoaded", init);
})();
