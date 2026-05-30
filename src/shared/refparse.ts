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
 * The set of hyperref-style destination-key prefixes that indicate a
 * NON-bibliography destination (sections, figures, tables, equations, …).
 *
 * Exported so callers can pre-filter link hrefs before the full index is built.
 */
const NON_BIB_PREFIX =
  /^(section|subsection|subsubsection|figure|table|algorithm|theorem|lemma|corollary|proposition|definition|remark|example|appendix|equation|listing|page|toc|lof|lot|doc|fig\b|tab\b|alg\b|thm\b|lem\b|cor\b|prop\b|defn?\b|rem\b|ex\b)/;

/**
 * Returns true if the destination key is recognisably NOT a bibliography entry
 * (e.g. "section.2", "figure.3", "table.1", "equation.4" — hyperref standard).
 *
 * Useful for fast pre-filtering of link hrefs even before the reference index
 * is fully built.
 */
export function isNonBibliographyDestKey(destKey: string): boolean {
  return NON_BIB_PREFIX.test(destKey.toLowerCase());
}

/**
 * Returns true if (destKey, parsedRef) looks like a bibliography entry rather
 * than a section / figure / table / equation / theorem / appendix link.
 *
 * Three independent signals are applied in order:
 *
 * 1. Destination-name prefix — hyperref encodes the link type in the name
 *    (e.g. "section.2", "figure.3", "table.1"). Matching a known non-bibliography
 *    prefix immediately rejects the entry.
 *
 * 2. Raw-text content pre-filter — if the extracted text is very short (< 40 chars)
 *    or starts with a heading-style keyword, it is not a bibliography entry.
 *
 * 3. Structured content signal — bibliography entries almost always carry a DOI,
 *    an arXiv ID, or a year that appears in a bibliography-style context (in
 *    parentheses, or accompanied by detected author names). Section body text that
 *    merely *mentions* a year in passing will not have the accompanying structure.
 */
export function isBibliographyEntry(destKey: string, ref: ParsedReference): boolean {
  // Signal 1: destination key prefix
  if (isNonBibliographyDestKey(destKey)) return false;

  // Signal 2: raw text pre-filter (catches non-hyperref PDFs where the dest key
  // is an opaque JSON string and we must rely on text content alone)
  const raw = ref.raw.trimStart();
  if (raw.length < 40) return false;
  // Starts with a heading keyword + optional number — definitely not bibliography
  if (/^(figure|fig\.|table|tab\.|algorithm|alg\.|theorem|thm\.|section|sec\.|appendix|proof|lemma|lem\.|corollary|cor\.|proposition|prop\.|definition|def\.|remark|rem\.|example)\b/i.test(raw)) return false;

  // Signal 3: definitive identifiers — accept immediately
  if (ref.doi || ref.arxivId) return true;

  // Signal 3 (continued): year is common in body text, so require it to appear in
  // a bibliography-style context: in parentheses "(YYYY)" (APA/MLA/Nature style),
  // OR accompanied by detected author names, OR at the end of an entry (NeurIPS/
  // arXiv style — "..., YYYY."), OR the text starts with a numbered entry marker.
  if (ref.year) {
    // Year in parentheses: "(2023)" or "(2023a)" — typical of most bib styles
    if (/\((?:19|20)\d{2}[a-z]?\)/.test(raw)) return true;
    // Parsed authors found: author-year entries
    if (ref.authors && ref.authors.length > 0) return true;
    // Starts with a numbered entry marker: "[5]" or "(5)" — numbered bib styles
    if (/^(\[\d+\]|\(\d+\))\s/.test(raw)) return true;
    // Year appears at the very end of the entry (e.g. "..., 2024." or "..., 2024")
    if (/,\s*(?:19|20)\d{2}[a-z]?\s*\.?\s*$/.test(raw)) return true;
  }

  return false;
}
