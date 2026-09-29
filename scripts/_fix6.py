# -*- coding: utf-8 -*-
# 1) Admins bypass country gating entirely
# 2) Client fail-open when profile has no country
import io

p = 'public/app/js/qbank.js'
s = io.open(p, encoding='utf-8').read()

# --- bootstrapAccess: admins get NO access object (= allow everywhere) ---
old_boot = '''      const res = await apiGet("bootstrap_access");
      window.db.access = {
        country: res.profileCountry || "",
        mainIds: Array.isArray(res.mainIds) ? res.mainIds : [],
        prepIds: Array.isArray(res.prepsIds || res.prepIds) ? res.prepsIds || res.prepIds : [],
        grants: Array.isArray(res.grants) ? res.grants : [],
      };'''
new_boot = '''      const res = await apiGet("bootstrap_access");
      // Admins are never gated
      let isAdmin = false;
      try { isAdmin = window.checkAdmin ? await window.checkAdmin() : false; } catch (_) {}
      if (isAdmin) {
        delete window.db.access;
        return null;
      }
      window.db.access = {
        country: res.profileCountry || "",
        mainIds: Array.isArray(res.mainIds) ? res.mainIds : [],
        prepIds: Array.isArray(res.prepsIds || res.prepIds) ? res.prepsIds || res.prepIds : [],
        grants: Array.isArray(res.grants) ? res.grants : [],
      };'''
assert old_boot in s, "boot block"
s = s.replace(old_boot, new_boot)

# --- picker gate: fail-open without country ---
old_g1 = 'const isAllowedMain = (id) => !acc || acc.grants.includes(id) || acc.mainIds.includes(id);'
new_g1 = 'const isAllowedMain = (id) => !acc || !acc.country || acc.grants.includes(id) || acc.mainIds.includes(id);'
assert old_g1 in s, "gate1"
s = s.replace(old_g1, new_g1)

# --- exam-prep gate: same ---
old_g2 = 'const prepAllowed = (id) => !acc || acc.grants.includes(id) || acc.prepIds.includes(id);'
new_g2 = 'const prepAllowed = (id) => !acc || !acc.country || acc.grants.includes(id) || acc.prepIds.includes(id);'
assert old_g2 in s, "gate2"
s = s.replace(old_g2, new_g2)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print("qbank.js: admin bypass + fail-open")
