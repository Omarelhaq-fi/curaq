// Country -> major -> college catalogue + per-college QBank associations.
//
// Stored as one JSON document (sys/academic_structure) so the admin panel can
// edit the whole tree atomically and every access check needs at most one
// small Firestore read (cached in-process for 60s). QBank IDs are only
// associated through the qbankIds/prepIds arrays; the Subject/Chapter/Part
// taxonomy of a bank is never changed by this structure.

export interface AcademicCountry {
  id: string;
  name: string;
  code: string;
  source?: "admin" | "user";
}

export interface AcademicMajor {
  id: string;
  countryId: string;
  name: string;
  source?: "admin" | "user";
}

export interface AcademicCollege {
  id: string;
  countryId: string;
  majorId: string;
  name: string;
  qbankIds: string[];
  prepIds: string[];
  source?: "admin" | "user";
}

export interface AcademicStructure {
  countries: AcademicCountry[];
  majors: AcademicMajor[];
  colleges: AcademicCollege[];
  updatedAt: number;
}

export interface AcademicSelection {
  country: AcademicCountry;
  major: AcademicMajor;
  college: AcademicCollege;
  changed: boolean;
  structure: AcademicStructure;
}

const ACADEMIC_DOC = "sys/academic_structure";
const CACHE_TTL_MS = 60_000;

const DEFAULT_COUNTRIES: AcademicCountry[] = [
  { id: "egypt", name: "Egypt", code: "eg" },
  { id: "tunisia", name: "Tunisia", code: "tn" },
  { id: "algeria", name: "Algeria", code: "dz" },
  { id: "morocco", name: "Morocco", code: "ma" },
  { id: "saudi", name: "Saudi Arabia", code: "sa" },
  { id: "global", name: "International", code: "" },
];

let structureCache: { data: AcademicStructure; time: number } | null = null;

function text(value: unknown, max = 120): string {
  return String(value == null ? "" : value).trim().replace(/\s+/g, " ").slice(0, max);
}

function slug(value: string): string {
  const s = text(value, 80)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "item";
}

function uniqueId(prefix: string, seed: string, used: Set<string>): string {
  const base = `${prefix}-${slug(seed)}`.slice(0, 64);
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n++;
  }
  used.add(id);
  return id;
}

function bankIds(value: unknown, used?: Set<string>): string[] {
  const out: string[] = [];
  const seen = used || new Set<string>();
  for (const raw of Array.isArray(value) ? value : []) {
    const id = text(raw, 100);
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 500) break;
  }
  return out;
}

export function defaultAcademicStructure(): AcademicStructure {
  return {
    countries: DEFAULT_COUNTRIES.map((c) => ({ ...c })),
    majors: [],
    colleges: [],
    updatedAt: 0,
  };
}

export function normalizeAcademicStructure(raw: unknown): AcademicStructure {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const countries: AcademicCountry[] = [];
  const countryIds = new Set<string>();
  for (const item of Array.isArray(input.countries) ? input.countries : []) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const name = text(r.name, 100);
    if (!name) continue;
    let id = text(r.id, 64);
    if (!id || !/^[a-z0-9_-]+$/i.test(id)) id = uniqueId("country", name, countryIds);
    if (countryIds.has(id)) id = uniqueId("country", name, countryIds);
    countryIds.add(id);
    const code = text(r.code, 8).toLowerCase().replace(/[^a-z]/g, "");
    countries.push({
      id,
      name,
      code,
      source: r.source === "user" ? "user" : "admin",
    });
    if (countries.length >= 200) break;
  }
  if (!countries.length) countries.push(...defaultAcademicStructure().countries);

  const majors: AcademicMajor[] = [];
  const majorIds = new Set<string>();
  for (const item of Array.isArray(input.majors) ? input.majors : []) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const countryId = text(r.countryId, 64);
    const name = text(r.name, 120);
    if (!countryIds.has(countryId) || !name) continue;
    let id = text(r.id, 64);
    if (!id || !/^[a-z0-9_-]+$/i.test(id)) id = uniqueId("major", `${countryId}-${name}`, majorIds);
    if (majorIds.has(id)) id = uniqueId("major", `${countryId}-${name}`, majorIds);
    majorIds.add(id);
    majors.push({
      id,
      countryId,
      name,
      source: r.source === "user" ? "user" : "admin",
    });
    if (majors.length >= 2000) break;
  }

  const colleges: AcademicCollege[] = [];
  const collegeIds = new Set<string>();
  for (const item of Array.isArray(input.colleges) ? input.colleges : []) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const majorId = text(r.majorId, 64);
    const major = majors.find((m) => m.id === majorId);
    const name = text(r.name, 160);
    if (!major || !name) continue;
    let id = text(r.id, 64);
    if (!id || !/^[a-z0-9_-]+$/i.test(id)) id = uniqueId("college", `${majorId}-${name}`, collegeIds);
    if (collegeIds.has(id)) id = uniqueId("college", `${majorId}-${name}`, collegeIds);
    collegeIds.add(id);
    colleges.push({
      id,
      countryId: major.countryId,
      majorId,
      name,
      qbankIds: bankIds(r.qbankIds),
      prepIds: bankIds(r.prepIds),
      source: r.source === "user" ? "user" : "admin",
    });
    if (colleges.length >= 5000) break;
  }

  const updatedAt = Number(input.updatedAt) || 0;
  return { countries, majors, colleges, updatedAt };
}

export function publicAcademicStructure(structure: AcademicStructure) {
  return {
    countries: structure.countries.map((c) => ({ id: c.id, name: c.name, code: c.code })),
    majors: structure.majors.map((m) => ({ id: m.id, countryId: m.countryId, name: m.name })),
    colleges: structure.colleges.map((c) => ({
      id: c.id,
      countryId: c.countryId,
      majorId: c.majorId,
      name: c.name,
    })),
    updatedAt: structure.updatedAt,
  };
}

export function invalidateAcademicStructureCache(): void {
  structureCache = null;
}

export async function loadAcademicStructure(
  sa: { project_id: string },
  token: string,
  force = false,
): Promise<AcademicStructure> {
  if (!force && structureCache && Date.now() - structureCache.time < CACHE_TTL_MS) {
    return structureCache.data;
  }
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${ACADEMIC_DOC}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) {
    const data = defaultAcademicStructure();
    structureCache = { data, time: Date.now() };
    return data;
  }
  if (!res.ok) throw new Error(`Failed to load academic structure: ${res.status}`);
  const doc = await res.json();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(doc.fields?.data?.stringValue || "null");
  } catch {
    parsed = null;
  }
  const data = normalizeAcademicStructure(parsed);
  structureCache = { data, time: Date.now() };
  return data;
}

export async function saveAcademicStructure(
  sa: { project_id: string },
  token: string,
  raw: unknown,
): Promise<AcademicStructure> {
  const structure = normalizeAcademicStructure(raw);
  structure.updatedAt = Date.now();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${ACADEMIC_DOC}?updateMask.fieldPaths=data&updateMask.fieldPaths=updatedAt`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        data: { stringValue: JSON.stringify(structure) },
        updatedAt: { integerValue: String(structure.updatedAt) },
      },
    }),
  });
  if (!res.ok) throw new Error(`Failed to save academic structure: ${res.status}`);
  structureCache = { data: structure, time: Date.now() };
  return structure;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Resolve a student's chosen country/major/college. Missing major/college
 * choices are added to the catalogue as `source: "user"` so admins can later
 * attach banks to them. Selection fields are validated against the tree.
 */
export function resolveAcademicSelection(
  structure: AcademicStructure,
  input: {
    countryId?: unknown;
    majorId?: unknown;
    majorName?: unknown;
    collegeId?: unknown;
    collegeName?: unknown;
  },
): AcademicSelection {
  const wantedCountry = text(input.countryId, 64).toLowerCase();
  let country = structure.countries.find(
    (c) => c.id.toLowerCase() === wantedCountry || (c.code && c.code === wantedCountry),
  );
  if (!country) throw new Error("Please select a valid country.");
  let changed = false;

  let college: AcademicCollege | undefined;
  const collegeId = text(input.collegeId, 64);
  if (collegeId) {
    college = structure.colleges.find((c) => c.id === collegeId);
    if (!college) throw new Error("Selected college was not found. Please choose again.");
    const cm = structure.majors.find((m) => m.id === college!.majorId);
    if (!cm) throw new Error("The selected college has no valid major.");
    const ownCountry = structure.countries.find((c) => c.id === cm.countryId);
    // Defense in depth: a malicious client could enumerate public college IDs
    // and submit one from another country to inherit that college's access.
    // Reject any explicit country choice that does not own the college.
    if (
      ownCountry &&
      wantedCountry &&
      ownCountry.id.toLowerCase() !== wantedCountry &&
      !(ownCountry.code && ownCountry.code === wantedCountry)
    ) {
      throw new Error("The selected college does not belong to that country.");
    }
    country = ownCountry || country;
  }

  let major: AcademicMajor | undefined;
  if (college) {
    major = structure.majors.find((m) => m.id === college!.majorId);
  } else {
    const majorId = text(input.majorId, 64);
    if (majorId) {
      major = structure.majors.find((m) => m.id === majorId && m.countryId === country.id);
      if (!major) throw new Error("Selected major was not found in that country.");
    } else {
      const majorName = text(input.majorName, 120);
      if (majorName.length < 2) throw new Error("Please select or add your major.");
      major = structure.majors.find((m) => m.countryId === country.id && sameName(m.name, majorName));
      if (!major) {
        const used = new Set(structure.majors.map((m) => m.id));
        major = {
          id: uniqueId("major", `${country.id}-${majorName}`, used),
          countryId: country.id,
          name: majorName,
          source: "user",
        };
        structure.majors.push(major);
        changed = true;
      }
    }
  }
  if (!major) throw new Error("Please select or add your major.");

  if (!college) {
    const collegeName = text(input.collegeName, 160);
    if (collegeName.length < 2) throw new Error("Please select or add your college.");
    college = structure.colleges.find(
      (c) => c.majorId === major!.id && sameName(c.name, collegeName),
    );
    if (!college) {
      const used = new Set(structure.colleges.map((c) => c.id));
      college = {
        id: uniqueId("college", `${major.id}-${collegeName}`, used),
        countryId: country.id,
        majorId: major.id,
        name: collegeName,
        qbankIds: [],
        prepIds: [],
        source: "user",
      };
      structure.colleges.push(college);
      changed = true;
    }
  }

  return { country, major, college, changed, structure };
}

export function collegeBankIds(
  structure: AcademicStructure,
  collegeId: string,
): { mainIds: string[]; prepIds: string[] } {
  const college = structure.colleges.find((c) => c.id === collegeId);
  if (!college) return { mainIds: [], prepIds: [] };
  return {
    mainIds: Array.isArray(college.qbankIds) ? college.qbankIds.slice() : [],
    prepIds: Array.isArray(college.prepIds) ? college.prepIds.slice() : [],
  };
}
