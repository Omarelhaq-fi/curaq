# -*- coding: utf-8 -*-
# 1) Move access-moderation code inside admin.js IIFE (fixes "api is not defined")
# 2) Locked bank cards: whole card clickable -> request modal
# 3) Replace lock emojis with Lucide icons
import io

# ---------- admin.js ----------
p = 'public/app/js/admin.js'
a = io.open(p, encoding='utf-8').read()

marker = "  // ---------- ACCESS REQUESTS MODERATION ----------"
i_m = a.find(marker)
assert i_m > 0
block = a[i_m:]
a = a[:i_m].rstrip() + "\n"

# re-insert before the final IIFE close
close_marker = "\n})();"
i_c = a.rfind(close_marker)
assert i_c > 0
a = a[:i_c] + "\n" + block.rstrip() + "\n" + a[i_c:]
io.open(p, 'w', encoding='utf-8', newline='').write(a)
print("admin.js: moderation moved inside IIFE")

# ---------- qbank.js ----------
p2 = 'public/app/js/qbank.js'
q = io.open(p2, encoding='utf-8').read()

# picker: whole locked card opens the request flow; lucide lock badge
old_card = '''        // Access gating: allowed banks open; others offer a request button
        const allowed = isAllowedMain(q.id);
        const clickAttr = allowed ? `onclick="window.selectQBank('${q.id}')"` : "";'''
new_card = '''        // Access gating: allowed banks open; others offer a request action
        const allowed = isAllowedMain(q.id);
        const safeQName = (window.escapeHtml ? window.escapeHtml(q.name) : q.name).replace(/'/g, "\\'");
        const clickAttr = allowed ? `onclick="window.selectQBank('${q.id}')"` : `onclick="window.qbankRequestAccess('${q.id}', '${safeQName}')"`;
        const cursorStyle = allowed ? "pointer" : "pointer";'''
assert old_card in q, "picker gating block not found"
q = q.replace(old_card, new_card)

old_cta = '''          ? `<div style="color:var(--accent-cyan); font-size:0.95rem; font-weight:600; display:flex; align-items:center; gap:8px; margin-top:auto; padding-top:15px; text-transform:uppercase; letter-spacing:1px;">
               <span>Select Bank</span>
               <i data-lucide="arrow-right" style="width:18px;height:18px;"></i>
             </div>`
          : `<button class="btn-action primary" style="margin-top:auto; padding:9px 18px; border:none; background:linear-gradient(135deg,#f59e0b,#d97706);" onclick="event.stopPropagation(); window.qbankRequestAccess('${q.id}', '${(window.escapeHtml ? window.escapeHtml(q.name) : q.name).replace(/'/g, "\\'")}')">
               \U0001F512 Request Access
             </button>
             <div style="font-size:0.72rem; color:var(--text-muted); margin-top:8px;">Not part of your country's plan</div>`;
        const lockBadge = allowed ? "" : `<div style="position:absolute; top:14px; right:14px; font-size:1.1rem;">\U0001F512</div>`;'''
new_cta = '''          ? `<div style="color:var(--accent-cyan); font-size:0.95rem; font-weight:600; display:flex; align-items:center; gap:8px; margin-top:auto; padding-top:15px; text-transform:uppercase; letter-spacing:1px;">
               <span>Select Bank</span>
               <i data-lucide="arrow-right" style="width:18px;height:18px;"></i>
             </div>`
          : `<div style="display:flex; flex-direction:column; align-items:center; gap:6px; margin-top:auto; padding-top:15px;">
               <span style="display:inline-flex; align-items:center; gap:7px; padding:9px 18px; border-radius:999px; background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.4); color:#fbbf24; font-weight:700; font-size:0.88rem;">
                 <i data-lucide="lock" style="width:15px;height:15px;"></i> Request Access
               </span>
               <span style="font-size:0.72rem; color:var(--text-muted);">Not part of your country's plan</span>
             </div>`;
        const lockBadge = allowed ? "" : `<div style="position:absolute; top:14px; right:14px; color:#fbbf24;"><i data-lucide="lock" style="width:17px;height:17px;"></i></div>`;'''
assert old_cta in q, "cta block not found"
q = q.replace(old_cta, new_cta)

old_cursor = 'const cursorStyle = allowed ? "pointer" : "pointer";'
if old_cursor not in q:
    pass  # already handled above

old_html = '''cursor:${allowed ? "pointer" : "default"};'''
new_html = '''cursor:pointer;'''
assert old_html in q
q = q.replace(old_html, new_html)

# hover for locked cards: amber glow like unlocked teal
old_hover = '''onmouseover="this.style.borderColor='rgba(245,158,11,0.5);'" onmouseout="this.style.borderColor='rgba(255,255,255,0.08);'"'''
new_hover = '''onmouseover="this.style.transform='translateY(-4px)'; this.style.borderColor='rgba(245,158,11,0.55);'" onmouseout="this.style.transform='translateY(0)'; this.style.borderColor='rgba(255,255,255,0.08);'"'''
assert old_hover in q
q = q.replace(old_hover, new_hover)

# exam prep tile: remove emoji from text label (icon already lucide)
old_go = '<div class="ep-bank-go" style="color:#f59e0b;">\U0001F512 Request Access</div>'
new_go = '<div class="ep-bank-go" style="color:#f59e0b;">Request Access <i data-lucide="lock" style="width:13px;height:13px;"></i></div>'
assert old_go in q, "ep go label not found"
q = q.replace(old_go, new_go)

io.open(p2, 'w', encoding='utf-8', newline='').write(q)
print("qbank.js: card clickable + lucide icons")
