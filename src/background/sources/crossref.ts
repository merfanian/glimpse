// Crossref client: DOI lookup and bibliographic query.
import type { PaperCandidate, ParsedReference } from "@shared/types";

const BASE = "https://api.crossref.org/works";

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: { given?: string; family?: string }[];
  issued?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  abstract?: string;
  URL?: string;
  link?: { URL: string; "content-type"?: string; "intended-application"?: string }[];
  score?: number;
}

function mailtoParam(email: string): string {
  return email ? `&mailto=${encodeURIComponent(email)}` : "";
}

function stripJats(s?: string): string | undefined {
  if (!s) return undefined;
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toCandidate(item: CrossrefItem): PaperCandidate | null {
  const title = item.title?.[0];
  if (!title && !item.DOI) return null;
  const authors = (item.author ?? [])
    .map((a) => [a.given, a.family].filter(Boolean).join(" ").trim())
    .filter(Boolean);
  const year = item.issued?.["date-parts"]?.[0]?.[0];

  let pdfUrl: string | undefined;
  for (const l of item.link ?? []) {
    if (l["content-type"] === "application/pdf") {
      pdfUrl = l.URL;
      break;
    }
  }

  return {
    source: "crossref",
    title: title ?? "(untitled)",
    authors,
    year,
    doi: item.DOI,
    abstract: stripJats(item.abstract),
    pdfUrl,
    url: item.DOI ? `https://doi.org/${item.DOI}` : item.URL,
    venue: item["container-title"]?.[0],
    confidence: 0,
    matchNotes: [],
  };
}

const TIMEOUT_MS = 10_000;

export async function crossrefByDoi(doi: string, email: string): Promise<PaperCandidate | null> {
  const res = await fetch(`${BASE}/${encodeURIComponent(doi)}?1=1${mailtoParam(email)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { message?: CrossrefItem };
  return json.message ? toCandidate(json.message) : null;
}

export async function crossrefSearch(
  ref: ParsedReference,
  email: string,
): Promise<PaperCandidate[]> {
  const query = ref.title ?? ref.raw.slice(0, 200);
  const params = new URLSearchParams({
    "query.bibliographic": query,
    rows: "5",
  });
  if (ref.authors?.length) params.set("query.author", ref.authors.join(" "));

  const res = await fetch(`${BASE}?${params.toString()}${mailtoParam(email)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { message?: { items?: CrossrefItem[] } };
  return (json.message?.items ?? [])
    .map(toCandidate)
    .filter((c): c is PaperCandidate => c !== null);
}
