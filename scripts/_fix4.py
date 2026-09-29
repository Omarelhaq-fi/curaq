# -*- coding: utf-8 -*-
# qbank.js: locked card fully clickable + lucide icons (part 2, corrected anchors)
import io

p = 'public/app/js/qbank.js'
q = io.open(p, encoding='utf-8').read()

# 1) whole-card click for locked banks
old_click = '''        const allowed = isAllowedMain(q.id);
        const clickAttr = allowed ? `onclick="window.selectQBank('${q.id}')"` : "";'''
new_click = '''        const allowed = isAllowedMain(q.id);
        const safeQName = (window.escapeHtml ? window.escapeHtml(q.name) : q.name).replace(/'/g, "\\'");
        const clickAttr = allowed ? `onclick="window.selectQBank('${q.id}')"` : `onclick="window.qbankRequestAccess('${q.id}', '${safeQName}')"`;
        const cursorStyle = "pointer";'''
assert old_click in q
q = q.replace(old_click, new_click)

# 2) replace the amber <button> CTA with a styled chip + lucide lock; badge -> lucide
old_cta = '''          : `<button class="btn-action primary" style="margin-top:auto; padding:9px 18px; border:none; background:linear-gradient(135deg,#f59e0b,#d97706);" onclick="event.stopPropagation(); window.qbankRequestAccess('${q.id}', '${(window.escapeHtml ? window.escapeHtml(q.name) : q.name).replace(/'/g, "\\'")}')">
               \U0001F512 Request Access
             </button>
             <div style="font-size:0.72rem; color:var(--text-muted); margin-top:8px;">Not part of your country's plan</div>`;
        const lockBadge = allowed ? "" : `<div style="position:absolute; top:14px; right:14px; font-size:1.1rem;">\U0001F512</div>`;'''
new_cta = '''          : `<div style="display:flex; flex-direction:column; align-items:center; gap:6px; margin-top:auto; padding-top:15px;">
               <span style="display:inline-flex; align-items:center; gap:7px; padding:9px 18px; border-radius:999px; background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.4); color:#fbbf24; font-weight:700; font-size:0.88rem;">
                 <i data-lucide="lock" style="width:15px;height:15px;"></i> Request Access
               </span>
               <span style="font-size:0.72rem; color:var(--text-muted);">Not part of your country's plan</span>
             </div>`;
        const lockBadge = allowed ? "" : `<div style="position:absolute; top:14px; right:14px; color:#fbbf24;"><i data-lucide="lock" style="width:17px;height:17px;"></i></div>`;'''
assert old_cta in q, "cta not found"
q = q.replace(old_cta, new_cta)

# 3) cursor always pointer + lift hover on locked cards
old_cur = 'cursor:${allowed ? "pointer" : "default"};'
assert old_cur in q
q = q.replace(old_cur, 'cursor:pointer;')

old_hov = '''onmouseover="this.style.borderColor='rgba(245,158,11,0.5);'"'''
assert old_hov in q
q = q.replace(old_hov, '''onmouseover="this.style.transform='translateY(-4px)'; this.style.borderColor='rgba(245,158,11,0.55);'"''')
old_hov2 = '''onmouseout="this.style.borderColor='rgba(255,255,255,0.08);'"'''
if old_hov2 in q:
    q = q.replace(old_hov2, '''onmouseout="this.style.transform='translateY(0)'; this.style.borderColor='rgba(255,255,255,0.08);'"''', 1)

# 4) exam-prep tile label: drop emoji, lucide lock icon after text
old_go = '<div class="ep-bank-go" style="color:#f59e0b;">\U0001F512 Request Access</div>'
new_go = '<div class="ep-bank-go" style="color:#f59e0b;">Request Access <i data-lucide="lock" style="width:13px;height:13px;"></i></div>'
assert old_go in q, "ep go not found"
q = q.replace(old_go, new_go)

io.open(p, 'w', encoding='utf-8', newline='').write(q)
print("qbank.js part2 applied")
