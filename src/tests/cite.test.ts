import { describe, it, expect } from "vitest";
import { citeKey, splitName, toBibtex, toPlainCitation } from "@shared/cite";
import type { PaperCandidate } from "@shared/types";

function cand(over: Partial<PaperCandidate>): PaperCandidate {
  return { source: "semanticscholar", title: "A Title", authors: [], confidence: 1, matchNotes: [], ...over };
}

const transformer = cand({
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit"],
  year: 2017,
  venue: "Neural Information Processing Systems",
  arxivId: "1706.03762",
  url: "https://arxiv.org/abs/1706.03762",
});

describe("splitName", () => {
  it("handles given-family, initials, comma form and particles", () => {
    expect(splitName("Ashish Vaswani")).toEqual({ first: "Ashish", last: "Vaswani" });
    expect(splitName("D. P. Kingma")).toEqual({ first: "D. P.", last: "Kingma" });
    expect(splitName("Vaswani, Ashish")).toEqual({ first: "Ashish", last: "Vaswani" });
    expect(splitName("Ludwig van Beethoven")).toEqual({ first: "Ludwig", last: "van Beethoven" });
    expect(splitName("Plato")).toEqual({ first: "", last: "Plato" });
  });
});

describe("citeKey", () => {
  it("is family name + year + first significant title word", () => {
    expect(citeKey(transformer)).toBe("vaswani2017attention");
    expect(citeKey(cand({ title: "On the Role of Bidirectionality", authors: ["Mikel Artetxe"], year: 2022 }))).toBe("artetxe2022role");
    expect(citeKey(cand({ title: "Ünïcode Wörds", authors: ["Jürgen Schmidhuber"], year: 1997 }))).toBe("schmidhuber1997unicode");
  });
});

describe("toBibtex", () => {
  it("uses @inproceedings for conference venues, with authors in Last, First form", () => {
    const b = toBibtex(transformer);
    expect(b.startsWith("@inproceedings{vaswani2017attention,")).toBe(true);
    expect(b).toContain("author        = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob}");
    expect(b).toContain("booktitle     = {Neural Information Processing Systems}");
    expect(b).toContain("eprint        = {1706.03762}");
    expect(b).toContain("archivePrefix = {arXiv}");
    expect(b.trim().endsWith("}")).toBe(true);
  });

  it("uses @article for journals and keeps the DOI", () => {
    const b = toBibtex(cand({ title: "Long Short-Term Memory", authors: ["Sepp Hochreiter", "Jürgen Schmidhuber"], year: 1997, venue: "Neural Computation", doi: "10.1162/neco.1997.9.8.1735" }));
    expect(b.startsWith("@article{hochreiter1997long,")).toBe(true);
    expect(b).toContain("journal = {Neural Computation}");
    expect(b).toContain("doi     = {10.1162/neco.1997.9.8.1735}");
  });

  it("uses @misc for arXiv-only preprints and drops arXiv's own DOI", () => {
    const b = toBibtex(cand({ title: "Layer Normalization", authors: ["Jimmy Lei Ba"], year: 2016, venue: "arXiv", doi: "10.48550/arXiv.1607.06450" }));
    expect(b.startsWith("@misc{ba2016layer,")).toBe(true);
    expect(b).toContain("eprint        = {1607.06450}");
    expect(b).not.toContain("doi");
  });

  it("escapes LaTeX special characters", () => {
    const b = toBibtex(cand({ title: "Q&A over 100% of data_sets", authors: ["A B"], year: 2020 }));
    expect(b).toContain("title  = {Q\\&A over 100\\% of data\\_sets}");
  });
});

describe("toPlainCitation", () => {
  it("formats an APA-like reference with et al. beyond three authors", () => {
    expect(toPlainCitation(transformer)).toBe(
      "Vaswani, A., Shazeer, N., Parmar, N., et al. (2017). Attention Is All You Need. Neural Information Processing Systems. https://arxiv.org/abs/1706.03762",
    );
  });

  it("links the DOI and handles two authors", () => {
    expect(toPlainCitation(cand({ title: "Long Short-Term Memory", authors: ["Sepp Hochreiter", "Jürgen Schmidhuber"], year: 1997, venue: "Neural Computation", doi: "10.1162/neco.1997.9.8.1735" }))).toBe(
      "Hochreiter, S., & Schmidhuber, J. (1997). Long Short-Term Memory. Neural Computation. https://doi.org/10.1162/neco.1997.9.8.1735",
    );
  });
});
