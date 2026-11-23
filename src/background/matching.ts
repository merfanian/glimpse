// Scores and ranks candidate papers against the queried reference.
import type { PaperCandidate, ParsedReference } from "@shared/types";
import { normalizeTitle } from "@shared/refparse";

function tokenList(s: string): string[] {
  return normalizeTitle(s).split(" ").filter((t) => t.length > 1);
}

function tokens(s: string): Set<string> {
  return new Set(tokenList(s));
}

/** Token-overlap (Jaccard) similarity of two titles, 0..1. */
function titleSimilarity(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * How completely the candidate's title appears inside the raw reference text, 0..1.
 * Robust to bad title extraction: whatever the parser guessed, a correct candidate's
 * title words are almost always present verbatim in the bibliography entry. Short titles
 * are discounted because a handful of common words match nearly any entry.
 */
function titleContainment(candTitle: string, raw: string): number {
  const ct = tokenList(candTitle);
  if (ct.length < 3) return 0;
  const rawNorm = ` ${normalizeTitle(raw)} `;
  // Exact phrase present → full credit.
  if (rawNorm.includes(` ${ct.join(" ")} `)) return ct.length >= 4 ? 1 : 0.85;
  const rt = new Set(tokenList(raw));
  let hits = 0;
  for (const t of ct) if (rt.has(t)) hits++;
  const frac = hits / ct.length;
  const lengthFactor = Math.min(1, ct.length / 6);
  return frac * (0.7 + 0.3 * lengthFactor) * 0.95;
}

function lastName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

/** Fraction of reference author surnames found among candidate authors, 0..1.
 * Only uses the first 2 authors from each side — references often truncate with "et al."
 * so comparing more authors than we have reliable data for hurts more than it helps. */
function authorOverlap(ref: ParsedReference, cand: PaperCandidate): number {
  if (!ref.authors?.length || !cand.authors.length) return 0;
  const refAuthors = ref.authors.slice(0, 2);
  const candLast = new Set(cand.authors.slice(0, 2).map(lastName));
  let hits = 0;
  for (const a of refAuthors) {
    const ln = lastName(a);
    if (ln && candLast.has(ln)) hits++;
  }
  return hits / refAuthors.length;
}

/** Candidate first-author surname appears in the raw reference text. */
function firstAuthorInRaw(ref: ParsedReference, cand: PaperCandidate): boolean {
  const ln = cand.authors[0] ? lastName(cand.authors[0]) : "";
  if (ln.length < 2) return false;
  return normalizeTitle(ref.raw).split(" ").includes(normalizeTitle(ln));
}

/** arXiv-issued DOIs ("10.48550/arXiv.1706.03762") encode the arXiv id. */
export function arxivIdFromDoi(doi?: string): string | undefined {
  const m = doi?.match(/^10\.48550\/arxiv\.(.+)$/i);
  return m ? m[1] : undefined;
}

function sameArxiv(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return a.replace(/v\d+$/, "").toLowerCase() === b.replace(/v\d+$/, "").toLowerCase();
}

export function scoreCandidate(ref: ParsedReference, cand: PaperCandidate): PaperCandidate {
  const notes: string[] = [];
  const candArxiv = cand.arxivId ?? arxivIdFromDoi(cand.doi);

  // Identifier exact matches dominate.
  if (ref.doi && cand.doi && ref.doi.toLowerCase() === cand.doi.toLowerCase()) {
    return withArxivPdf({ ...cand, confidence: 1, matchNotes: ["DOI exact match"] });
  }
  if (ref.arxivId && sameArxiv(ref.arxivId, candArxiv)) {
    return withArxivPdf({ ...cand, confidence: 0.98, matchNotes: ["arXiv ID match"] });
  }

  const titleSim = Math.max(
    titleSimilarity(ref.title, cand.title),
    titleContainment(cand.title, ref.raw),
  );
  let authorSim = authorOverlap(ref, cand);
  if (authorSim === 0 && firstAuthorInRaw(ref, cand)) authorSim = 0.5;

  let score = titleSim * 0.75 + authorSim * 0.2;
  if (titleSim > 0.5) notes.push(`title ${Math.round(titleSim * 100)}%`);
  if (authorSim > 0) notes.push(`authors ${Math.round(authorSim * 100)}%`);

  // Year agreement bonus / penalty.
  if (ref.year && cand.year) {
    if (ref.year === cand.year) {
      score += 0.05;
      notes.push("year matches");
    } else if (Math.abs(ref.year - cand.year) > 1) {
      score -= 0.1;
      notes.push("year differs");
    }
  }

  return withArxivPdf({ ...cand, confidence: Math.max(0, Math.min(1, score)), matchNotes: notes });
}

/**
 * Normalise a candidate's PDF URLs: arXiv id → arXiv PDF, keep a de-duplicated ordered
 * list in `pdfUrls` with `pdfUrl` as the first entry. Exported for use after merges.
 */
export function withArxivPdf(cand: PaperCandidate): PaperCandidate {
  const arxivId = cand.arxivId ?? arxivIdFromDoi(cand.doi);
  const urls: string[] = [];
  const push = (u?: string) => {
    if (u && !urls.includes(u)) urls.push(u);
  };
  push(cand.pdfUrl);
  for (const u of cand.pdfUrls ?? []) push(u);
  if (arxivId) push(`https://arxiv.org/pdf/${arxivId}`);
  if (urls.length === 0) return arxivId && !cand.arxivId ? { ...cand, arxivId } : cand;
  return { ...cand, arxivId, pdfUrl: urls[0], pdfUrls: urls };
}

/**
 * Lower is better. arXiv is reliably fetchable; publisher "text-mining" API links listed
 * in Crossref usually need an institutional token, so they go last.
 */
export function pdfUrlPriority(url: string): number {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return 3;
  }
  if (host.endsWith("arxiv.org")) return 0;
  if (/(^|\.)api\.|onlinelibrary\.wiley\.com\/doi\/full-xml|tdm/i.test(host + new URL(url).pathname)) return 2;
  return 1;
}

function identityKeys(c: PaperCandidate): string[] {
  const keys: string[] = [];
  if (c.doi) keys.push(`doi:${c.doi.toLowerCase()}`);
  const ax = c.arxivId ?? arxivIdFromDoi(c.doi);
  if (ax) keys.push(`arxiv:${ax.replace(/v\d+$/, "").toLowerCase()}`);
  const t = normalizeTitle(c.title);
  if (t.length > 0) keys.push(`title:${t}`);
  return keys;
}

/**
 * Deduplicate candidates that refer to the same paper (sharing ANY of DOI / arXiv id /
 * normalised title), merging complementary fields. The highest-confidence record wins
 * identity; the others contribute missing abstract / PDF links / ids.
 */
export function dedupe(cands: PaperCandidate[]): PaperCandidate[] {
  const groups: PaperCandidate[][] = [];
  const keyToGroup = new Map<string, number>();

  for (const c of cands) {
    const keys = identityKeys(c);
    const hits = [...new Set(keys.map((k) => keyToGroup.get(k)).filter((g): g is number => g != null))];
    let gi: number;
    if (hits.length === 0) {
      gi = groups.length;
      groups.push([c]);
    } else {
      gi = hits[0];
      groups[gi].push(c);
      // Merge any other groups bridged by this candidate into gi.
      for (const other of hits.slice(1)) {
        groups[gi].push(...groups[other]);
        groups[other] = [];
        for (const [k, g] of keyToGroup) if (g === other) keyToGroup.set(k, gi);
      }
    }
    for (const k of keys) keyToGroup.set(k, gi);
  }

  return groups.filter((g) => g.length > 0).map(mergeGroup);
}

/** Merge complementary fields (e.g. one source has a PDF, another an abstract). */
function mergeGroup(group: PaperCandidate[]): PaperCandidate {
  // Stable sort: highest confidence first; ties prefer the record that has a PDF.
  const sorted = [...group].sort(
    (a, b) => b.confidence - a.confidence || Number(!!b.pdfUrl) - Number(!!a.pdfUrl),
  );
  const best = sorted[0];
  const pick = <K extends keyof PaperCandidate>(k: K): PaperCandidate[K] =>
    sorted.map((c) => c[k]).find((v) => v != null && v !== "") as PaperCandidate[K];

  const pdfUrls: string[] = [];
  for (const c of sorted) {
    for (const u of [c.pdfUrl, ...(c.pdfUrls ?? [])]) if (u && !pdfUrls.includes(u)) pdfUrls.push(u);
  }
  const mergedArxiv = pick("arxivId") ?? sorted.map((c) => arxivIdFromDoi(c.doi)).find(Boolean);
  const arxivPdf = mergedArxiv ? `https://arxiv.org/pdf/${mergedArxiv}` : undefined;
  if (arxivPdf && !pdfUrls.includes(arxivPdf)) pdfUrls.push(arxivPdf);
  pdfUrls.sort((a, b) => pdfUrlPriority(a) - pdfUrlPriority(b)); // stable
  const abstracts = sorted.map((c) => c.abstract).filter((a): a is string => !!a);
  return withArxivPdf({
    ...best,
    doi: pick("doi"),
    arxivId: pick("arxivId"),
    // The longest abstract is usually the complete one (Crossref often truncates).
    abstract: abstracts.sort((a, b) => b.length - a.length)[0],
    tldr: pick("tldr"),
    venue: pick("venue"),
    year: pick("year"),
    url: pick("url"),
    authors: best.authors.length ? best.authors : (pick("authors") ?? []),
    pdfUrl: pdfUrls[0],
    pdfUrls: pdfUrls.length ? pdfUrls : undefined,
  });
}

export function rank(ref: ParsedReference, cands: PaperCandidate[]): {
  candidates: PaperCandidate[];
  bestIndex: number;
} {
  const scored = dedupe(cands.map((c) => scoreCandidate(ref, c)));
  scored.sort((a, b) => b.confidence - a.confidence);
  return { candidates: scored, bestIndex: scored.length ? 0 : -1 };
}
