// Semantic Scholar Graph API client.
import type { PaperCandidate, ParsedReference } from "@shared/types";

const BASE = "https://api.semanticscholar.org/graph/v1/paper";
const FIELDS = "title,authors,year,abstract,openAccessPdf,externalIds,venue";

interface S2Paper {
  paperId?: string;
  title?: string;
  authors?: { name: string }[];
  year?: number;
  abstract?: string;
  openAccessPdf?: { url?: string } | null;
  externalIds?: { DOI?: string; ArXiv?: string } | null;
  venue?: string;
  matchScore?: number;
}

function toCandidate(p: S2Paper, confidence = 0): PaperCandidate | null {
  if (!p.title) return null;
  const pdfUrl = p.openAccessPdf?.url || undefined;
  return {
    source: "semanticscholar",
    title: p.title,
    authors: (p.authors ?? []).map((a) => a.name),
    year: p.year,
    doi: p.externalIds?.DOI,
    arxivId: p.externalIds?.ArXiv,
    abstract: p.abstract ?? undefined,
    pdfUrl,
    url: p.externalIds?.DOI
      ? `https://doi.org/${p.externalIds.DOI}`
      : p.externalIds?.ArXiv
        ? `https://arxiv.org/abs/${p.externalIds.ArXiv}`
        : undefined,
    venue: p.venue,
    confidence,
    matchNotes: [],
  };
}

const TIMEOUT_MS = 10_000;

async function getById(idExpr: string): Promise<PaperCandidate | null> {
  const res = await fetch(`${BASE}/${idExpr}?fields=${FIELDS}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return toCandidate((await res.json()) as S2Paper);
}

export function s2ByDoi(doi: string): Promise<PaperCandidate | null> {
  return getById(`DOI:${encodeURIComponent(doi)}`);
}

export function s2ByArxiv(id: string): Promise<PaperCandidate | null> {
  return getById(`arXiv:${encodeURIComponent(id)}`);
}

/**
 * S2 /paper/search/match: purpose-built for bibliography string matching.
 * IMPORTANT: must receive a clean title string — it fails on full raw reference text
 * (author names + year prefix confuse it with "Title match not found").
 * Score is normalized to 0–1 confidence using a cap at ~150.
 */
export async function s2Match(ref: ParsedReference): Promise<PaperCandidate | null> {
  // Requires a parsed title — raw reference text causes "Title match not found".
  if (!ref.title) return null;

  // Strip trailing year / punctuation that may have been swept up by title parsing.
  const title = ref.title
    .replace(/,?\s*(19|20)\d{2}[a-z]?\s*\.?$/, "")
    .replace(/\.$/, "")
    .trim();
  if (title.length < 5) return null;

  const params = new URLSearchParams({ query: title.slice(0, 300), fields: FIELDS });
  const res = await fetch(`${BASE}/search/match?${params.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const json = (await res.json()) as { data?: S2Paper[]; error?: string };
  if (json.error || !json.data?.length) return null;

  const paper = json.data[0];
  const raw = paper.matchScore ?? 100; // if no score, assume good since it matched
  const confidence = Math.min(0.99, raw / 150);
  return toCandidate(paper, confidence);
}

export async function s2Search(ref: ParsedReference): Promise<PaperCandidate[]> {
  const query = ref.title ?? ref.raw.slice(0, 200);
  const params = new URLSearchParams({ query, limit: "5", fields: FIELDS });
  const res = await fetch(`${BASE}/search?${params.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: S2Paper[] };
  return (json.data ?? [])
    .map((p) => toCandidate(p))
    .filter((c): c is PaperCandidate => c !== null);
}
