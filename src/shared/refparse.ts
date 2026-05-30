// Heuristic parser that extracts structured fields from a raw bibliography entry.
import type { ParsedReference } from "./types";

const DOI_RE = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
const ARXIV_RE = /arxiv[:\s]*((?:\d{4}\.\d{4,5})(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i;
const ARXIV_BARE_RE = /\b(\d{4}\.\d{4,5})(v\d+)?\b/;
const YEAR_RE = /\b(19|20)\d{2}\b/;

/** Trim trailing punctuation/whitespace from a fragment. */
function clean(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^[\s,.;:]+|[\s,.;:]+$/g, "").trim();
}

/** Strip a trailing DOI that was captured greedily (e.g. ending with a period). */
function normalizeDoi(doi: string): string {
  return doi.replace(/[.,;]+$/, "");
}

/**
 * Attempt to pull a title out of a reference string. Bibliography styles vary widely;
 * we use a couple of common signals (quoted titles, or the sentence following the
 * author/year block) and otherwise leave it undefined so callers can fall back to DOI.
 */
function guessTitle(raw: string): string | undefined {
  const quoted = raw.match(/[“"]([^“”"]{8,})[”"]/);
  if (quoted) return clean(quoted[1]);

  // Pattern: Authors (Year). Title. Venue...
  const afterYear = raw.match(/\((?:19|20)\d{2}[a-z]?\)\.?\s*([^.]{8,}?)\.\s/);
  if (afterYear) return clean(afterYear[1]);

  // Pattern: Authors. Title, Year.  (NeurIPS/arXiv-style: "Smith et al. Great paper, 2024.")
  const beforeYear = raw.match(/\.\s+([^.]{20,}?),\s*(?:19|20)\d{2}[a-z]?\s*\.?\s*$/);
  if (beforeYear) return clean(beforeYear[1]);

  // General: split on sentence boundaries, skipping short fragments (initials, "et al.").
  // Handles references like "Y. K. Li et al. Long title here, 2024."
  const segments = raw
    .split(/(?<=\.)\s+/)
    .map(clean)
    .filter(Boolean);
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.length >= 20 && /[a-z]/.test(seg) && !(/^\d/).test(seg)) return seg;
  }
  return undefined;
}

/** Extract a rough author surname list from the leading portion of the entry. */
function guessAuthors(raw: string): string[] | undefined {
  const head = raw.split(/\((?:19|20)\d{2}/)[0] ?? raw.slice(0, 120);
  // Surnames: capitalized words, possibly with initials following.
  const matches = head.match(/[A-Z][a-zA-Z'’-]+(?=,|\sand\b|\s[A-Z]\.)/g);
  if (!matches || matches.length === 0) return undefined;
  const uniq = Array.from(new Set(matches.map(clean))).slice(0, 12);
  return uniq.length ? uniq : undefined;
}

export function parseReference(raw: string): ParsedReference {
  const text = clean(raw);
  const ref: ParsedReference = { raw: text };

  const doiMatch = text.match(DOI_RE);
  if (doiMatch) ref.doi = normalizeDoi(doiMatch[0]);

  const arxivMatch = text.match(ARXIV_RE);
  if (arxivMatch) {
    ref.arxivId = arxivMatch[1];
  } else if (!ref.doi) {
    const bare = text.match(ARXIV_BARE_RE);
    if (bare) ref.arxivId = bare[1] + (bare[2] ?? "");
  }

  const yearMatch = text.match(YEAR_RE);
  if (yearMatch) ref.year = Number(yearMatch[0]);

  const title = guessTitle(text);
  if (title) ref.title = title;

  const authors = guessAuthors(text);
  if (authors) ref.authors = authors;

  return ref;
}

/**
 * Returns true if the raw extracted text looks like a bibliography entry.
 *
 * Filters out section headings, figure/table/algorithm captions, theorem
 * environments and other link destinations that are not bibliography references.
 *
 * Rules (all must pass):
 *  1. Length ≥ 40: real entries are always multi-sentence; headings are short.
 *  2. Doesn't start with a known non-bibliography keyword (Figure, Table, …).
 *  3. Contains a year (19xx/20xx): virtually all scientific bibliography entries do.
 */
export function looksLikeBibEntry(raw: string): boolean {
  if (raw.length < 40) return false;
  if (/^(figure|fig\.|table|tab\.|algorithm|alg\.|theorem|thm\.|lemma|lem\.|corollary|cor\.|proposition|prop\.|definition|def\.|remark|rem\.|proof|example|appendix|chapter|section)\s/i.test(raw)) return false;
  return /\b(19|20)\d{2}\b/.test(raw);
}

/** Normalize a title for fuzzy comparison. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns true if (destKey, parsedRef) looks like a bibliography entry rather
 * than a section / figure / table / equation / theorem / appendix link.
 *
 * Two independent signals are used:
 *
 * 1. Destination-name prefix — hyperref encodes the link type in the name
 *    (e.g. "section.2", "figure.3", "table.1", "equation.4"). Matching one of
 *    these known non-bibliography prefixes immediately rejects the entry.
 *
 * 2. Content signal — bibliography entries almost always carry a publication
 *    year (1900–2099), a DOI, or an arXiv ID. Section headings and captions
 *    rarely contain any of these (and when they do, signal 1 is the safety net).
 *
 * Both signals must agree to accept a destination as a bibliography entry:
 * the name must NOT be a known non-bibliography prefix AND the parsed reference
 * must contain at least one of year / DOI / arXiv.
 */
export function isBibliographyEntry(destKey: string, ref: ParsedReference): boolean {
  // --- Signal 1: destination key name ---
  // hyperref names follow the pattern "<type>.<counter>" (all lowercase).
  // Reject the common non-bibliography types.
  const k = destKey.toLowerCase();
  const NON_BIB_PREFIX =
    /^(section|subsection|subsubsection|figure|table|algorithm|theorem|lemma|corollary|proposition|definition|remark|example|appendix|equation|listing|page|toc|lof|lot|doc|fig\b|tab\b|alg\b|thm\b|lem\b|cor\b|prop\b|defn?\b|rem\b|ex\b)/;
  if (NON_BIB_PREFIX.test(k)) return false;

  // --- Signal 2: content ---
  return !!(ref.doi || ref.arxivId || ref.year);
}
