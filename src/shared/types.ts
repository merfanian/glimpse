// Shared domain types used across content script, background worker, and UI.

/** A parsed reference extracted from the source document. */
export interface ParsedReference {
  /** Raw reference entry text as it appears in the bibliography. */
  raw: string;
  doi?: string;
  arxivId?: string;
  title?: string;
  authors?: string[];
  year?: number;
}

/** A candidate paper found by an external source. */
export interface PaperCandidate {
  source: "crossref" | "arxiv" | "semanticscholar";
  title: string;
  authors: string[];
  year?: number;
  doi?: string;
  arxivId?: string;
  abstract?: string;
  /** Direct URL to an (ideally open-access) PDF, if known. */
  pdfUrl?: string;
  /** Landing/abstract page URL. */
  url?: string;
  venue?: string;
  /** Match confidence 0..1 relative to the query reference. */
  confidence: number;
  /** Human-readable reasons contributing to the confidence score. */
  matchNotes: string[];
}

/** Result of a lookup for a given reference. */
export interface LookupResult {
  reference: ParsedReference;
  candidates: PaperCandidate[];
  /** Index of the best candidate in `candidates`, or -1 if none. */
  bestIndex: number;
}

export interface FetchedPdf {
  /** Object URL created from the fetched bytes, valid in the requesting page. */
  objectUrl?: string;
  /** Base64 data when an object URL cannot be transferred directly. */
  dataBase64?: string;
  contentType?: string;
  byteLength?: number;
}
