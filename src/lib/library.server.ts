// Concept Library ("Study Book") — recycles per-question info (explanations,
// generated study concepts) into an AMBOSS/UWorld-style book tree:
// Bank → Subject → Chapter → Articles.
//
// Rules:
// - Titles come ONLY from transforming the concept text itself (heading, then
//   first sentence, then subject/chapter fallback). Question codes, ids and
//   question text are NEVER stored or displayed.
// - Duplicates are skipped: exact slug match, or same-subject word-overlap
//   (Jaccard) above threshold. A repeat only merges its source id (capped).
// - Ordering is insertion order inside alphabetically sorted
//   subject/chapter groups, so rebuilds are stable without any AI calls.

export type LibraryNode = {
  id: string; // slug derived from the title — never a question reference
  title: string;
  excerpt: string;
  tags: string[];
  sources: string[]; // question ids merged into this article (capped)
  updatedAt: string;
};

export type LibraryChapter = { name: string; count: number; nodes: LibraryNode[] };
export type LibrarySubject = { name: string; count: number; chapters: LibraryChapter[] };

export type LibraryTree = {
  version: 2;
  updatedAt: string;
  nodeCount: number;
  subjects: LibrarySubject[];
};

export type FileInput = {
  subject: unknown;
  chapter: unknown;
  tags: unknown;
  title?: unknown;
  excerpt?: unknown;
  body: unknown;
  questionId: unknown;
};

export const UNCATEGORIZED = "Uncategorized";
export const GENERAL_CHAPTER = "General";
const MAX_SOURCES = 25;

const STOPWORDS = new Set(
  "a,an,the,and,or,but,of,at,by,for,with,about,into,through,during,before,after,above,below,to,from,up,down,in,out,on,off,over,under,again,further,then,once,here,there,when,where,why,how,all,any,both,each,few,more,most,other,some,such,no,nor,not,only,own,same,so,than,too,very,can,will,just,should,now,is,are,was,were,be,been,being,have,has,had,having,do,does,did,doing,would,could,ought,i,you,he,she,it,we,they,them,his,her,its,our,their,this,that,these,those,as,also,which,who,whom,what,whose,because,until,while,both,between,among,within,without,may,might,must,shall,onto,per,via,et,al,vs,amongst,upon,every,including,includes,included,using,used,often,usually,typically,generally,commonly,particularly,especially,however,therefore,thus,hence,although,though,despite,towards,among,across,including, manufacture".split(
    ",",
  ),
);

export function normSubject(s: unknown): string {
  const t = String(s || "").trim();
  return t || UNCATEGORIZED;
}

export function normChapter(c: unknown): string {
  const t = String(c || "").trim();
  return t || GENERAL_CHAPTER;
}

function cleanInline(s: string): string {
  return s
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Significant lowercase words (len > 2, no stopwords). */
export function tokens(text: unknown): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Deterministic article id from the title (never a question reference). */
export function titleSlug(title: unknown, fallbackText = ""): string {
  const words = tokens(title);
  const use = words.length > 0 ? words : tokens(fallbackText);
  return use.slice(0, 6).join("-").slice(0, 100) || "note";
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Strip leading question/bank numbering like "1.1.3", "2)", "4 - ". */
export function stripNumbering(s: string): string {
  return String(s || "")
    .replace(/^[\d.\)\:\-\s]+(?=[A-Za-z#])/, "")
    .trim();
}

/** True when the text reads like a question stem, not a concept title. */
export function isQuestionLike(s: unknown): boolean {
  const core = stripNumbering(String(s || ""));
  if (!core) return true;
  if (/[?:]\s*$/.test(core)) return true;
  return /(which of the following|all except|is found in|is produced by|is present in|causes an|will have|most specific|marker for|except:|following causes|following is| suivantes|lequel|laquelle)\b/i.test(
    core,
  );
}

/**
 * Title purely from the concept text itself — NEVER question text/codes.
 * Heading first (numbering stripped), then the first sentence that does not
 * read like a question stem, then a subject·chapter fallback.
 */
export function deriveTitle(body: unknown, subject: string, chapter: string): string {
  const md = String(body || "");
  const m = md.match(/^#{1,6}\s+(.+?)\s*$/m);
  if (m) {
    const t = stripNumbering(cleanInline(m[1])).slice(0, 90);
    if (t.replace(/[^a-zA-Z0-9]/g, "").length >= 4 && !isQuestionLike(t)) return t;
  }
  const plain = md
    .replace(/^#{1,6}\s+.+$/gm, " ")
    .replace(/!\[.*?\]\(.*?\)/g, " ")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[*_`>#|~\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.split(/(?<=[.!?])\s+|\n+/).map((s) => stripNumbering(s));
  for (const s of sentences) {
    if (s.replace(/[^a-zA-Z0-9]/g, "").length < 15) continue;
    if (isQuestionLike(s)) continue;
    return s.length > 90 ? s.slice(0, 87).trimEnd() + "…" : s;
  }
  if (subject === UNCATEGORIZED && chapter === GENERAL_CHAPTER) return "Study note";
  return `${subject} · ${chapter}`;
}

/** Plain-text teaser (never the full article, never numbering). */
export function deriveExcerpt(body: unknown, max = 160): string {
  let t = String(body || "");
  t = t.replace(/^#{1,6}\s+.+$/gm, " ");
  t = t.replace(/!\[.*?\]\(.*?\)/g, " ");
  t = t.replace(/\[(.*?)\]\(.*?\)/g, "$1");
  t = t.replace(/[*_`>#|~\-]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  t = stripNumbering(t);
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t;
}

/** Recycled body is usable when it carries real info (not a placeholder). */
export function isUsableBody(body: unknown, minChars = 80): boolean {
  const t = String(body || "").trim();
  if (t.length < minChars) return false;
  return !/^no explanation/i.test(t);
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

export function emptyTree(): LibraryTree {
  return { version: 2, updatedAt: new Date().toISOString(), nodeCount: 0, subjects: [] };
}

function recount(lib: LibraryTree): void {
  for (const s of lib.subjects) {
    s.chapters = s.chapters.filter((c) => c.nodes.length > 0);
    for (const c of s.chapters) c.count = c.nodes.length;
    s.count = s.chapters.reduce((n, c) => n + c.count, 0);
  }
  lib.subjects = lib.subjects.filter((s) => s.count > 0);
  lib.nodeCount = lib.subjects.reduce((n, s) => n + s.count, 0);
  lib.version = 2;
  lib.updatedAt = new Date().toISOString();
}

function mergeSource(node: LibraryNode, questionId: string): boolean {
  const qid = String(questionId || "");
  if (!qid || node.sources.includes(qid)) return false;
  if (node.sources.length >= MAX_SOURCES) return false;
  node.sources.push(qid);
  node.updatedAt = new Date().toISOString();
  return true;
}

export type FileResult = { status: "added" | "duplicate"; dirty: boolean; node: LibraryNode };

function normTag(t: unknown): string {
  return String(t || "")
    .trim()
    .toLowerCase();
}

/**
 * Two recycled infos cover the same concept when their word overlap is high,
 * or when they share an admin tag AND overlap solidly (tags alone are not
 * enough — e.g. two cardiology topics can share "ecg" yet differ).
 */
function isDuplicateConcept(
  candTitle: string,
  candExcerpt: string,
  candTags: string[],
  node: LibraryNode,
): boolean {
  const candSet = new Set([...tokens(candTitle), ...tokens(candExcerpt)]);
  const nodeSet = new Set([...tokens(node.title), ...tokens(node.excerpt)]);
  if (jaccard(new Set(tokens(candTitle)), new Set(tokens(node.title))) >= 0.5) return true;
  const overlap = jaccard(candSet, nodeSet);
  if (overlap >= 0.32) return true;
  const nodeTags = new Set((node.tags || []).map(normTag));
  const sharedTag = candTags.map(normTag).some((t) => t && nodeTags.has(t));
  return sharedTag && overlap >= 0.22;
}

/**
 * File one recycled concept into the tree (mutates `lib`).
 * - Exact slug match → duplicate (source merged).
 * - Same-subject word overlap ≥ threshold → duplicate (source merged).
 * - Otherwise a new article is appended (insertion order = reading order).
 */
export function fileConcept(lib: LibraryTree, input: FileInput): FileResult {
  const sName = normSubject(input.subject);
  const cName = normChapter(input.chapter);
  const body = String(input.body || "");
  const title = String(input.title || "").trim() || deriveTitle(body, sName, cName);
  const excerpt = String(input.excerpt || "").trim() || deriveExcerpt(body);
  const tags = (Array.isArray(input.tags) ? input.tags : []).map((t) => String(t)).slice(0, 12);
  const qid = String(input.questionId || "");
  // Slug blends title + excerpt so identical infos share an id (exact dup)
  // while different infos never collide — slugs are internal only.
  const slug = titleSlug(`${title} ${excerpt}`.slice(0, 200), excerpt);

  for (const s of lib.subjects) {
    for (const c of s.chapters) {
      const hit = c.nodes.find((n) => n.id === slug);
      if (hit) {
        const dirty = mergeSource(hit, qid);
        if (dirty) recount(lib);
        return { status: "duplicate", dirty, node: hit };
      }
    }
  }

  const cand = { title, excerpt, tags };
  const sub = lib.subjects.find((s) => s.name === sName);
  if (sub) {
    for (const c of sub.chapters) {
      for (const n of c.nodes) {
        if (isDuplicateConcept(cand.title, cand.excerpt, cand.tags, n)) {
          const dirty = mergeSource(n, qid);
          if (dirty) recount(lib);
          return { status: "duplicate", dirty, node: n };
        }
      }
    }
  }

  let subject = sub;
  if (!subject) {
    subject = { name: sName, count: 0, chapters: [] };
    lib.subjects.push(subject);
    lib.subjects.sort((a, b) => {
      if (a.name === UNCATEGORIZED) return 1;
      if (b.name === UNCATEGORIZED) return -1;
      return byName(a.name, b.name);
    });
  }
  let chapter = subject.chapters.find((c) => c.name === cName);
  if (!chapter) {
    chapter = { name: cName, count: 0, nodes: [] };
    subject.chapters.push(chapter);
    subject.chapters.sort((a, b) => {
      if (a.name === GENERAL_CHAPTER) return -1;
      if (b.name === GENERAL_CHAPTER) return 1;
      return byName(a.name, b.name);
    });
  }
  const node: LibraryNode = {
    id: slug,
    title: title.slice(0, 120),
    excerpt: excerpt.slice(0, 220),
    tags,
    sources: qid ? [qid] : [],
    updatedAt: new Date().toISOString(),
  };
  chapter.nodes.push(node);
  recount(lib);
  return { status: "added", dirty: true, node };
}

/** Shrink excerpts until the tree fits a Firestore doc (~1 MiB limit). */
export function fitLibrarySize(lib: LibraryTree, maxBytes = 900_000): LibraryTree {
  let size = JSON.stringify(lib).length;
  if (size <= maxBytes) return lib;
  const next: LibraryTree = JSON.parse(JSON.stringify(lib));
  for (const excerptLen of [100, 60, 0]) {
    for (const s of next.subjects)
      for (const c of s.chapters)
        for (const n of c.nodes) n.excerpt = n.excerpt.slice(0, excerptLen);
    size = JSON.stringify(next).length;
    if (size <= maxBytes) break;
  }
  return next;
}

// ---------- Firestore REST codec (plain JSON <-> fields) ----------

export function fsEncode(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsEncode) } };
  if (typeof v === "object") {
    const fields: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>))
      fields[k] = fsEncode((v as Record<string, unknown>)[k]);
    return { mapValue: { fields } };
  }
  if (typeof v === "number")
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  return { stringValue: String(v) };
}

export function fsDecode(v: any): any {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return (v as any).stringValue ?? "";
  if ("integerValue" in v) return parseInt((v as any).integerValue, 10) || 0;
  if ("doubleValue" in v) return (v as any).doubleValue;
  if ("booleanValue" in v) return !!(v as any).booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return (v as any).timestampValue;
  if ("arrayValue" in v) return (((v as any).arrayValue || {}).values || []).map(fsDecode);
  if ("mapValue" in v) {
    const out: Record<string, unknown> = {};
    const fields = ((v as any).mapValue || {}).fields || {};
    for (const k of Object.keys(fields)) out[k] = fsDecode(fields[k]);
    return out;
  }
  return null;
}

export function libraryToFsFields(lib: LibraryTree): Record<string, unknown> {
  return {
    version: { integerValue: String(lib.version || 2) },
    updatedAt: { timestampValue: lib.updatedAt },
    nodeCount: { integerValue: String(lib.nodeCount) },
    subjects: fsEncode(lib.subjects),
  };
}

export function fsDocToLibrary(doc: any): LibraryTree | null {
  try {
    const f = doc?.fields || {};
    const subjects = fsDecode(f.subjects);
    if (!Array.isArray(subjects)) return null;
    return {
      version: 2,
      updatedAt: String(fsDecode(f.updatedAt) || new Date().toISOString()),
      nodeCount: Number(fsDecode(f.nodeCount)) || 0,
      subjects: subjects as LibrarySubject[],
    };
  } catch {
    return null;
  }
}

/** Stored index version (v1 = legacy question-id nodes, must be rebuilt). */
export function fsDocLibraryVersion(doc: any): number {
  try {
    return Number(fsDecode(doc?.fields?.version)) || 0;
  } catch {
    return 0;
  }
}
