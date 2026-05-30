// Scores and ranks candidate papers against the queried reference.
import type { PaperCandidate, ParsedReference } from "@shared/types";
import { normalizeTitle } from "@shared/refparse";

function tokens(s: string): Set<string> {
  return new Set(normalizeTitle(s).split(" ").filter((t) => t.length > 1));
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

function lastName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

/** Fraction of reference author surnames found among candidate authors, 0..1.
 * Only uses the first 2 authors from each side — references often truncate with "et al."
 * so comparing more authors than we have reliable data for hurts more than it helps. */
function authorOverlap(ref: ParsedReference, cand: PaperCandidate): number {
  if (!ref.authors?.length || !cand.authors.length) return 0;
  // Cap to first 2 on both sides.
  const refAuthors = ref.authors.slice(0, 2);
  const candLast = new Set(cand.authors.slice(0, 2).map(lastName));
  let hits = 0;
  for (const a of refAuthors) {
    const ln = lastName(a);
    if (ln && candLast.has(ln)) hits++;
  }
  return hits / refAuthors.length;
}

export function scoreCandidate(ref: ParsedReference, cand: PaperCandidate): PaperCandidate {
  const notes: string[] = [];

  // Identifier exact matches dominate.
  if (ref.doi && cand.doi && ref.doi.toLowerCase() === cand.doi.toLowerCase()) {
    return withArxivPdf({ ...cand, confidence: 1, matchNotes: ["DOI exact match"] });
  }
  if (
    ref.arxivId &&
    cand.arxivId &&
    ref.arxivId.replace(/v\d+$/, "") === cand.arxivId.replace(/v\d+$/, "")
  ) {
    return withArxivPdf({ ...cand, confidence: 0.98, matchNotes: ["arXiv ID match"] });
  }

  const titleSim = titleSimilarity(ref.title, cand.title);
  const authorSim = authorOverlap(ref, cand);

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
 * If a candidate has an arXiv ID but no open-access PDF URL, fill in the arXiv PDF URL.
 * Exported so other modules can apply it after merging candidates.
 */
export function withArxivPdf(cand: PaperCandidate): PaperCandidate {
  if (cand.pdfUrl || !cand.arxivId) return cand;
  return { ...cand, pdfUrl: `https://arxiv.org/pdf/${cand.arxivId}` };
}

/** Deduplicate by DOI/arXiv id/normalized title, keeping the highest-confidence entry. */
export function dedupe(cands: PaperCandidate[]): PaperCandidate[] {
  const byKey = new Map<string, PaperCandidate>();
  for (const c of cands) {
    const key =
      (c.doi && `doi:${c.doi.toLowerCase()}`) ||
      (c.arxivId && `arxiv:${c.arxivId.replace(/v\d+$/, "")}`) ||
      `title:${normalizeTitle(c.title)}`;
    const existing = byKey.get(key);
    if (!existing || c.confidence > existing.confidence) {
      // Prefer the entry that has a PDF when confidence ties.
      if (existing && c.confidence === existing.confidence && !c.pdfUrl && existing.pdfUrl) continue;
      byKey.set(key, existing ? mergeCandidate(existing, c) : c);
    } else if (existing && !existing.pdfUrl && c.pdfUrl) {
      byKey.set(key, { ...existing, pdfUrl: c.pdfUrl });
    }
  }
  return [...byKey.values()];
}

/** Merge complementary fields (e.g. one source has a PDF, another an abstract). */
function mergeCandidate(a: PaperCandidate, b: PaperCandidate): PaperCandidate {
  const merged = {
    ...b,
    pdfUrl: b.pdfUrl ?? a.pdfUrl,
    abstract: b.abstract ?? a.abstract,
    doi: b.doi ?? a.doi,
    arxivId: b.arxivId ?? a.arxivId,
    venue: b.venue ?? a.venue,
  };
  return withArxivPdf(merged);
}

export function rank(ref: ParsedReference, cands: PaperCandidate[]): {
  candidates: PaperCandidate[];
  bestIndex: number;
} {
  const scored = dedupe(cands.map((c) => scoreCandidate(ref, c)));
  scored.sort((a, b) => b.confidence - a.confidence);
  return { candidates: scored, bestIndex: scored.length ? 0 : -1 };
}
