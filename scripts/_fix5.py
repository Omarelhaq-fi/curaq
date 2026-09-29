# -*- coding: utf-8 -*-
# 1) bootstrap_access: legacy/no-country users -> fail-open (all banks allowed)
# 2) list_access_requests: drop orderBy (avoids composite index), sort in JS
import io

# ---------- server: qbank.ts ----------
p = 'src/routes/api/qbank.ts'
s = io.open(p, encoding='utf-8').read()

old = '''            const mainIds = allBanks.filter(b => b.kind !== "exam_prep" && b.country === country).map(b => b.id);
            const prepIds = allBanks.filter(b => b.kind === "exam_prep" && (b.country === country || grants.includes(b.id))).map(b => b.id);

            return json({ profileCountry: country, mainIds, prepIds, grants }, 200, cors);'''
new = '''            // Legacy accounts (created before the country picker) have no
            // country on file — fail open so they are never locked out.
            let mainIds: string[];
            let prepIds: string[];
            if (!country) {
              mainIds = allBanks.filter(b => b.kind !== "exam_prep").map(b => b.id);
              prepIds = allBanks.filter(b => b.kind === "exam_prep").map(b => b.id);
            } else {
              mainIds = allBanks.filter(b => b.kind !== "exam_prep" && b.country === country).map(b => b.id);
              prepIds = allBanks.filter(b => b.kind === "exam_prep" && (b.country === country || grants.includes(b.id))).map(b => b.id);
            }

            return json({ profileCountry: country, mainIds, prepIds, grants }, 200, cors);'''
assert old in s, "bootstrap block not found"
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print("qbank.ts: fail-open for country-less accounts")

# ---------- server: admin.ts ----------
p2 = 'src/routes/api/admin.ts'
a = io.open(p2, encoding='utf-8').read()

old_q = '''                  structuredQuery: {
                    from: [{ collectionId: "access_requests" }],
                    where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } },
                    orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
                    limit: 200,
                  },'''
new_q = '''                  structuredQuery: {
                    from: [{ collectionId: "access_requests" }],
                    where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } },
                    limit: 200,
                  },'''
assert old_q in a, "admin query not found"
a = a.replace(old_q, new_q)

old_sort = '''            const requests = (rows || [])
              .filter((r: any) => r.document)
              .map((r: any) => {
                const f = r.document.fields || {};
                return {
                  id: r.document.name.split("/").pop(),
                  uid: String(f.uid?.stringValue || ""),
                  email: String(f.email?.stringValue || ""),
                  qbankId: String(f.qbankId?.stringValue || ""),
                  bankName: banks[String(f.qbankId?.stringValue || "")] || "(deleted bank)",
                  reason: String(f.reason?.stringValue || ""),
                  status: String(f.status?.stringValue || ""),
                  createdAt: String(f.createdAt?.timestampValue || ""),
                };
              });
            return json({ requests }, 200, cors);'''
new_sort = '''            const requests = (rows || [])
              .filter((r: any) => r.document)
              .map((r: any) => {
                const f = r.document.fields || {};
                return {
                  id: r.document.name.split("/").pop(),
                  uid: String(f.uid?.stringValue || ""),
                  email: String(f.email?.stringValue || ""),
                  qbankId: String(f.qbankId?.stringValue || ""),
                  bankName: banks[String(f.qbankId?.stringValue || "")] || "(deleted bank)",
                  reason: String(f.reason?.stringValue || ""),
                  status: String(f.status?.stringValue || ""),
                  createdAt: String(f.createdAt?.timestampValue || ""),
                };
              })
              .sort((x: any, y: any) => String(y.createdAt).localeCompare(String(x.createdAt)));
            return json({ requests }, 200, cors);'''
assert old_sort in a
a = a.replace(old_sort, new_sort)
io.open(p2, 'w', encoding='utf-8', newline='').write(a)
print("admin.ts: index-free query + JS sorting")

# ---------- client safety net ----------
p3 = 'public/app/js/qbank.js'
q = io.open(p3, encoding='utf-8').read()
old_gate1 = 'const isAllowedMain = (id) => !acc || acc.grants.includes(id) || acc.mainIds.includes(id);'
new_gate1 = 'const isAllowedMain = (id) => !acc || !acc.country || acc.grants.includes(id) || acc.mainIds.includes(id);'
assert old_gate1 in q
q = q.replace(old_gate1, new_gate1)

old_gate2 = 'const prepAllowed = (id) => !acc || acc.grants.includes(id) || acc.prepIds.includes(id);'
new_gate2 = 'const prepAllowed = (id) => !acc || !acc.country || acc.grants.includes(id) || acc.prepIds.includes(id);'
assert old_gate2 in q
q = q.replace(old_gate2, new_gate2)

io.open(p3, 'w', encoding='utf-8', newline='').write(q)
print("qbank.js: client fail-open guards")
