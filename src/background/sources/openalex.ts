// OpenAlex client: keyless, CORS-friendly, broad coverage; returns abstracts (as an
// inverted index) and open-access PDF locations. Used as a fallback source.
import type { PaperCandidate, ParsedReference } from "@shared/types";
import { apiFetch } from "./http";

const BASE = "https://api.openalex.org/works";
const SELECT =
  "id,title,display_name,publication_year,doi,ids,authorships,abstract_inverted_index," +
  "best_oa_location,primary_location,locations";

interface OaLocation {
  pdf_url?: string | null;
  landing_page_url?: string | null;
  source?: { display_name?: string | null } | null;
}

interface OaWork {
  id?: string;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  doi?: string | null;
  authorships?: { author?: { display_name?: string } }[];
  abstract_inverted_index?: Record<string, number[]> | null;
  best_oa_location?: OaLocation | null;
  primary_location?: OaLocation | null;
  locations?: OaLocation[] | null;
}

function rebuildAbstract(inv?: Record<string, number[]> | null): string | undefined {
  if (!inv) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions) words[p] = word;
  }
  const text = words.filter(Boolean).join(" ").trim();
  return text.length > 0 ? text : undefined;
}

function toCandidate(w: OaWork): PaperCandidate | null {
  const title = w.title ?? w.display_name;
  if (!title) return null;
  const doi = w.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") || undefined;

  const locations = [w.best_oa_location, w.primary_location, ...(w.locations ?? [])].filter(
    (l): l is OaLocation => !!l,
  );
  let arxivId: string | undefined;
  const pdfUrls: string[] = [];
  for (const l of locations) {
    if (l.pdf_url && !pdfUrls.includes(l.pdf_url)) pdfUrls.push(l.pdf_url);
    const m = (l.landing_page_url ?? l.pdf_url ?? "").match(/arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:\.pdf)?$/i);
    if (m && !arxivId) arxivId = m[1];
  }

  return {
    source: "openalex",
    title,
    authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? "").filter(Boolean),
    year: w.publication_year ?? undefined,
    doi,
    arxivId,
    abstract: rebuildAbstract(w.abstract_inverted_index),
    pdfUrl: pdfUrls[0],
    pdfUrls: pdfUrls.length ? pdfUrls : undefined,
    url: doi ? `https://doi.org/${doi}` : (w.primary_location?.landing_page_url ?? w.id),
    venue: w.primary_location?.source?.display_name ?? undefined,
    confidence: 0,
    matchNotes: [],
  };
}

function mailto(email: string): string {
  return email ? `&mailto=${encodeURIComponent(email)}` : "";
}

export async function openAlexSearch(ref: ParsedReference, email: string): Promise<PaperCandidate[]> {
  // `title.search` is precise but its value can't contain filter syntax (`,` `:` `|`).
  const params = ref.title
    ? `filter=${encodeURIComponent(`title.search:${ref.title.replace(/[,:|]+/g, " ").slice(0, 250)}`)}`
    : `search=${encodeURIComponent(ref.raw.slice(0, 250))}`;
  const res = await apiFetch(`${BASE}?${params}&per-page=5&select=${SELECT}${mailto(email)}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { results?: OaWork[] };
  return (json.results ?? []).map(toCandidate).filter((c): c is PaperCandidate => c !== null);
}

export async function openAlexByDoi(doi: string, email: string): Promise<PaperCandidate | null> {
  const res = await apiFetch(`${BASE}/doi:${encodeURIComponent(doi)}?select=${SELECT}${mailto(email)}`);
  if (!res.ok) return null;
  return toCandidate((await res.json()) as OaWork);
}
