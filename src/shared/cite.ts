// Citation formatting for the panel's "Cite" menu. Generated locally from the paper's
// metadata: instant, works offline, and sends nothing anywhere.
import type { PaperCandidate } from "./types";

const PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "da", "di", "du", "la", "le", "dos", "das", "ter", "ten"]);

interface Name {
  first: string; // given names, possibly initials
  last: string; // family name, including particles ("van der Berg")
}

/** Split "Ashish Vaswani", "D. P. Kingma", "Vaswani, Ashish", "Ludwig van Beethoven". */
export function splitName(full: string): Name {
  const name = full.replace(/\s+/g, " ").trim();
  if (name.includes(",")) {
    const [last, first] = name.split(",", 2).map((s) => s.trim());
    return { first: first ?? "", last };
  }
  const parts = name.split(" ");
  if (parts.length === 1) return { first: "", last: parts[0] };
  // Family name = last token plus any lowercase particles right before it.
  let i = parts.length - 1;
  while (i > 1 && PARTICLES.has(parts[i - 1].toLowerCase())) i--;
  return { first: parts.slice(0, i).join(" "), last: parts.slice(i).join(" ") };
}

function initials(first: string): string {
  return first
    .split(/[\s]+/)
    .filter(Boolean)
    .map((p) => p.split("-").map((q) => (q[0] ? `${q[0].toUpperCase()}.` : "")).join("-"))
    .join(" ");
}

/** Escape characters that have meaning in BibTeX/LaTeX. */
function tex(s: string): string {
  return s.replace(/\\/g, "\\textbackslash{}").replace(/([&%$#_{}])/g, "\\$1").replace(/~/g, "\\textasciitilde{}").replace(/\^/g, "\\textasciicircum{}");
}

function ascii(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]/g, "");
}

const STOPWORDS = new Set(["a", "an", "the", "on", "of", "for", "in", "to", "and", "with", "towards", "toward", "via", "is", "are"]);

/** "vaswani2017attention" — family name + year + first significant title word. */
export function citeKey(c: PaperCandidate): string {
  const last = c.authors[0] ? ascii(splitName(c.authors[0]).last.split(" ").pop() ?? "").toLowerCase() : "";
  const plainTitle = c.title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const word = (plainTitle.match(/[a-z0-9]+/g) ?? []).find((w) => !STOPWORDS.has(w) && w.length > 1) ?? "";
  return `${last || "paper"}${c.year ?? ""}${ascii(word).toLowerCase()}` || "paper";
}

// Venue names that denote conference proceedings, including the long forms Semantic
// Scholar uses without the word "conference" ("Neural Information Processing Systems").
const CONFERENCE = new RegExp(
  "\\b(conference|proceedings|proc\\.|symposium|workshop|meeting|congress|" +
    "information processing systems|learning representations|pattern recognition|" +
    "empirical methods|computational linguistics|artificial intelligence|knowledge discovery|" +
    "neurips|nips|icml|iclr|cvpr|iccv|eccv|acl|emnlp|naacl|aaai|ijcai|kdd|sigmod|vldb|icde|chi|uist|sigir|www)\\b",
  "i",
);

function arxivIdOf(c: PaperCandidate): string | undefined {
  return c.arxivId ?? c.doi?.match(/^10\.48550\/arxiv\.(.+)$/i)?.[1];
}

export function toBibtex(c: PaperCandidate): string {
  const arxiv = arxivIdOf(c);
  const venue = c.venue && !/^arxiv(\.org)?$/i.test(c.venue.trim()) ? c.venue.trim() : undefined;
  const type = venue ? (CONFERENCE.test(venue) ? "inproceedings" : "article") : arxiv ? "misc" : "article";

  const fields: Array<[string, string]> = [["title", tex(c.title)]];
  if (c.authors.length) {
    fields.push(["author", c.authors.map((a) => {
      const n = splitName(a);
      return tex(n.first ? `${n.last}, ${n.first}` : n.last);
    }).join(" and ")]);
  }
  if (venue) fields.push([type === "inproceedings" ? "booktitle" : "journal", tex(venue)]);
  if (c.year) fields.push(["year", String(c.year)]);
  if (c.doi && !/^10\.48550\//i.test(c.doi)) fields.push(["doi", c.doi]);
  if (arxiv) {
    fields.push(["eprint", arxiv.replace(/v\d+$/, "")], ["archivePrefix", "arXiv"]);
  }
  const url = c.url ?? (arxiv ? `https://arxiv.org/abs/${arxiv}` : undefined);
  if (url) fields.push(["url", url]);

  const width = Math.max(...fields.map(([k]) => k.length));
  const body = fields.map(([k, v]) => `  ${k.padEnd(width)} = {${v}}`).join(",\n");
  return `@${type}{${citeKey(c)},\n${body}\n}\n`;
}

/** A compact APA-like reference: "Vaswani, A., Shazeer, N., et al. (2017). Title. Venue. https://doi.org/…" */
export function toPlainCitation(c: PaperCandidate): string {
  const names = c.authors.map((a) => {
    const n = splitName(a);
    return n.first ? `${n.last}, ${initials(n.first)}` : n.last;
  });
  let authors = "";
  if (names.length === 1) authors = names[0];
  else if (names.length === 2) authors = `${names[0]}, & ${names[1]}`;
  else if (names.length > 2) authors = names.length > 3 ? `${names.slice(0, 3).join(", ")}, et al.` : `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;

  const parts: string[] = [];
  if (authors) parts.push(authors.endsWith(".") ? authors : `${authors}.`);
  parts.push(`(${c.year ?? "n.d."}).`);
  parts.push(/[.?!]$/.test(c.title) ? c.title : `${c.title}.`);
  const arxiv = arxivIdOf(c);
  if (c.venue && !/^arxiv(\.org)?$/i.test(c.venue.trim())) parts.push(`${c.venue.trim()}.`);
  else if (arxiv) parts.push(`arXiv:${arxiv.replace(/v\d+$/, "")}.`);
  const link = c.doi && !/^10\.48550\//i.test(c.doi) ? `https://doi.org/${c.doi}` : (c.url ?? (arxiv ? `https://arxiv.org/abs/${arxiv}` : undefined));
  if (link) parts.push(link);
  return parts.join(" ");
}
