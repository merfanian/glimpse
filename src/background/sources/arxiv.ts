// arXiv client: queries the Atom API by id or title. Parsed with regex since the
// MV3 service worker has no DOMParser.
import type { PaperCandidate, ParsedReference } from "@shared/types";

const API = "https://export.arxiv.org/api/query";

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(entry: string, name: string): string | undefined {
  const m = entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : undefined;
}

function allTags(entry: string, name: string): string[] {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(entry))) out.push(decode(m[1]));
  return out;
}

function parseEntry(entry: string): PaperCandidate | null {
  const title = tag(entry, "title");
  if (!title) return null;
  const summary = tag(entry, "summary");
  const idUrl = tag(entry, "id") ?? "";
  const idMatch = idUrl.match(/abs\/([^v]+(?:v\d+)?)/);
  const arxivId = idMatch ? idMatch[1] : undefined;

  const authors: string[] = [];
  const authorBlocks = entry.match(/<author>[\s\S]*?<\/author>/gi) ?? [];
  for (const b of authorBlocks) {
    const name = tag(b, "name");
    if (name) authors.push(name);
  }

  const published = tag(entry, "published");
  const year = published ? Number(published.slice(0, 4)) : undefined;

  // DOI sometimes present.
  const doi = allTags(entry, "arxiv:doi")[0];

  const pdfUrl = arxivId ? `https://arxiv.org/pdf/${arxivId}` : undefined;
  const url = arxivId ? `https://arxiv.org/abs/${arxivId}` : idUrl;

  return {
    source: "arxiv",
    title,
    authors,
    year,
    doi,
    arxivId,
    abstract: summary,
    pdfUrl,
    url,
    venue: "arXiv",
    confidence: 0,
    matchNotes: [],
  };
}

function parseFeed(xml: string): PaperCandidate[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/gi) ?? [];
  return entries
    .map(parseEntry)
    .filter((c): c is PaperCandidate => c !== null);
}

const TIMEOUT_MS = 10_000;

export async function arxivById(id: string): Promise<PaperCandidate | null> {
  const res = await fetch(`${API}?id_list=${encodeURIComponent(id)}&max_results=1`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const xml = await res.text();
  return parseFeed(xml)[0] ?? null;
}

export async function arxivSearch(ref: ParsedReference): Promise<PaperCandidate[]> {
  if (!ref.title) return [];
  const q = `ti:"${ref.title.replace(/"/g, "")}"`;
  const res = await fetch(
    `${API}?search_query=${encodeURIComponent(q)}&max_results=5`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!res.ok) return [];
  return parseFeed(await res.text());
}
