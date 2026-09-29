# -*- coding: utf-8 -*-
# Admin UI: Regenerate All IDs button + confirm; bump admin.js version
import io

p = 'public/app/js/admin.js'
s = io.open(p, encoding='utf-8').read()

if "adminRegenerateQBankCodes" in s:
    print("already present")
else:
    old = '''  window.adminBackfillQBankCodes = async function(qbankId) {
    if (!confirm("This will assign a random code to all questions in this QBank that don't have one. Continue?")) return;
    try {
      const res = await api("/api/admin", {
        method: "POST",
        body: JSON.stringify({ action: "backfill_qbank_codes", qbankId })
      });
      alert(`Backfilled codes for ${res.updatedCount || 0} questions.`);
      window.adminManageQBank(currentAdminQBankId, document.getElementById("admin-qbank-manage-title").textContent.replace("Questions in ", ""));
    } catch (e) {
      alert("Failed to backfill: " + e.message);
    }'''
    new = '''  window.adminBackfillQBankCodes = async function(qbankId) {
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
      "REGENERATE ALL IDS?\\n\\n" +
      "Every question in this QBank will get a brand-new unique system ID.\\n" +
      "Old IDs (including duplicates shared with other banks) stop working.\\n\\n" +
      "Recommended if this bank was imported with source-file IDs.\\n\\nContinue?"
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
    }'''
    assert old in s, "backfill fn not found"
    s = s.replace(old, new)
    io.open(p, 'w', encoding='utf-8', newline='').write(s)
    print("admin.js: regenerate handler added")

# index.html: add the button next to Backfill + bump version
p2 = 'public/app/index.html'
h = io.open(p2, encoding='utf-8').read()
old_btn = '''<button class="btn-dark-pill" style="font-size:0.8rem; color:var(--text-secondary);" onclick="window.adminBackfillQBankCodes('${id}')">Backfill Missing Codes</button>'''
new_btn = '''<button class="btn-dark-pill" style="font-size:0.8rem; color:var(--text-secondary);" onclick="window.adminBackfillQBankCodes('${id}')">Backfill Missing Codes</button>
         <button class="btn-dark-pill" style="font-size:0.8rem; color:#f59e0b;" onclick="window.adminRegenerateQBankCodes('${id}')">♻ Regenerate All IDs</button>'''
assert old_btn in h, "backfill button not found"
h = h.replace(old_btn, new_btn)
h = h.replace('js/admin.js?v=10', 'js/admin.js?v=11')
io.open(p2, 'w', encoding='utf-8', newline='').write(h)
print("index.html: button added, admin.js bumped")
