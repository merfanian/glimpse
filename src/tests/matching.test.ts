import { describe, it, expect } from "vitest";
import { scoreCandidate, dedupe, rank, withArxivPdf } from "../../src/background/matching";
import type { PaperCandidate, ParsedReference } from "@shared/types";

function makeCandidate(overrides: Partial<PaperCandidate> = {}): PaperCandidate {
  return {
    source: "semanticscholar",
    title: "A Paper Title",
    authors: ["Smith", "Jones"],
    year: 2023,
    confidence: 0,
    matchNotes: [],
    ...overrides,
  };
}

function makeRef(overrides: Partial<ParsedReference> = {}): ParsedReference {
  return {
    raw: "Smith, Jones (2023). A Paper Title.",
    title: "A Paper Title",
    authors: ["Smith", "Jones"],
    year: 2023,
    ...overrides,
  };
}

describe("scoreCandidate — identifier exact match", () => {
  it("DOI exact match returns confidence 1", () => {
    const ref = makeRef({ doi: "10.1234/test" });
    const cand = makeCandidate({ doi: "10.1234/test" });
    const result = scoreCandidate(ref, cand);
    expect(result.confidence).toBe(1);
    expect(result.matchNotes).toContain("DOI exact match");
  });

  it("DOI match is case-insensitive", () => {
    const ref = makeRef({ doi: "10.1234/TEST" });
    const cand = makeCandidate({ doi: "10.1234/test" });
    const result = scoreCandidate(ref, cand);
    expect(result.confidence).toBe(1);
  });

  it("arXiv ID match returns confidence 0.98", () => {
    const ref = makeRef({ arxivId: "1706.03762" });
    const cand = makeCandidate({ arxivId: "1706.03762" });
    const result = scoreCandidate(ref, cand);
    expect(result.confidence).toBe(0.98);
  });

  it("arXiv ID match ignores version suffix", () => {
    const ref = makeRef({ arxivId: "1706.03762v1" });
    const cand = makeCandidate({ arxivId: "1706.03762v2" });
    const result = scoreCandidate(ref, cand);
    expect(result.confidence).toBe(0.98);
  });
});

describe("scoreCandidate — title and author similarity", () => {
  it("identical title and authors scores high", () => {
    const ref = makeRef();
    const cand = makeCandidate();
    const result = scoreCandidate(ref, cand);
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it("different title scores low", () => {
    const ref = makeRef({ title: "Attention is All You Need" });
    const cand = makeCandidate({ title: "Completely Different Topic About Bananas" });
    const result = scoreCandidate(ref, cand);
    expect(result.confidence).toBeLessThan(0.3);
  });

  it("year match adds bonus", () => {
    const ref = makeRef({ title: "Same Title Here", year: 2023 });
    const sameYear = makeCandidate({ title: "Same Title Here", year: 2023 });
    const diffYear = makeCandidate({ title: "Same Title Here", year: 2019 });
    const sameScore = scoreCandidate(ref, sameYear);
    const diffScore = scoreCandidate(ref, diffYear);
    expect(sameScore.confidence).toBeGreaterThan(diffScore.confidence);
  });

  it("year mismatch > 1 applies penalty", () => {
    const ref = makeRef({ title: "A Unique Paper", year: 2020 });
    const similar = makeCandidate({ title: "A Unique Paper", year: 2021 }); // off by 1 — no penalty
    const distant = makeCandidate({ title: "A Unique Paper", year: 2015 }); // off by 5 — penalty
    const s1 = scoreCandidate(ref, similar);
    const s2 = scoreCandidate(ref, distant);
    expect(s1.confidence).toBeGreaterThan(s2.confidence);
  });
});

describe("withArxivPdf", () => {
  it("fills in arXiv PDF URL when missing", () => {
    const cand = makeCandidate({ arxivId: "1706.03762" });
    const result = withArxivPdf(cand);
    expect(result.pdfUrl).toBe("https://arxiv.org/pdf/1706.03762");
  });

  it("does not override existing pdfUrl", () => {
    const cand = makeCandidate({ arxivId: "1706.03762", pdfUrl: "https://example.com/paper.pdf" });
    const result = withArxivPdf(cand);
    expect(result.pdfUrl).toBe("https://example.com/paper.pdf");
  });

  it("returns unchanged when no arxivId", () => {
    const cand = makeCandidate();
    const result = withArxivPdf(cand);
    expect(result.pdfUrl).toBeUndefined();
  });
});

describe("dedupe", () => {
  it("deduplicates by DOI", () => {
    const cands: PaperCandidate[] = [
      makeCandidate({ doi: "10.1234/test", confidence: 0.8 }),
      makeCandidate({ doi: "10.1234/test", confidence: 0.6 }),
    ];
    const result = dedupe(cands);
    expect(result).toHaveLength(1);
  });

  it("keeps highest-confidence entry when deduping by DOI", () => {
    const cands: PaperCandidate[] = [
      makeCandidate({ doi: "10.1234/test", confidence: 0.6, title: "Low" }),
      makeCandidate({ doi: "10.1234/test", confidence: 0.9, title: "High" }),
    ];
    const result = dedupe(cands);
    expect(result[0].confidence).toBe(0.9);
  });

  it("deduplicates by normalized title when no id", () => {
    const cands: PaperCandidate[] = [
      makeCandidate({ title: "Attention Is All You Need", confidence: 0.8 }),
      makeCandidate({ title: "attention is all you need", confidence: 0.7 }),
    ];
    const result = dedupe(cands);
    expect(result).toHaveLength(1);
  });

  it("preserves pdfUrl from lower-confidence entry when merging", () => {
    const cands: PaperCandidate[] = [
      makeCandidate({ doi: "10.1234/t", confidence: 0.9, pdfUrl: undefined }),
      makeCandidate({ doi: "10.1234/t", confidence: 0.5, pdfUrl: "https://arxiv.org/pdf/123" }),
    ];
    const result = dedupe(cands);
    expect(result).toHaveLength(1);
    expect(result[0].pdfUrl).toBe("https://arxiv.org/pdf/123");
  });

  it("keeps distinct entries separate", () => {
    const cands: PaperCandidate[] = [
      makeCandidate({ doi: "10.1234/a", title: "Paper A", confidence: 0.8 }),
      makeCandidate({ doi: "10.5678/b", title: "Paper B", confidence: 0.7 }),
    ];
    const result = dedupe(cands);
    expect(result).toHaveLength(2);
  });
});

describe("rank", () => {
  it("returns sorted candidates best-first", () => {
    const ref = makeRef();
    const cands: PaperCandidate[] = [
      makeCandidate({ title: "Unrelated Paper Here", confidence: 0 }),
      makeCandidate({ title: "A Paper Title", confidence: 0 }),
    ];
    const { candidates, bestIndex } = rank(ref, cands);
    expect(bestIndex).toBe(0);
    expect(candidates[0].confidence).toBeGreaterThanOrEqual(candidates[1].confidence);
  });

  it("returns bestIndex -1 for empty input", () => {
    const { bestIndex } = rank(makeRef(), []);
    expect(bestIndex).toBe(-1);
  });

  it("DOI exact match wins over title-only match", () => {
    // ref: title matches cand1, but DOI matches cand2
    const ref = makeRef({ doi: "10.1234/x", title: "Attention Is All You Need" });
    const cands: PaperCandidate[] = [
      // Title matches but wrong authors — score ~ 0.75
      makeCandidate({ title: "Attention Is All You Need", authors: ["Johnson", "Williams"], year: 2021 }),
      // DOI exact match — score = 1.0
      makeCandidate({ doi: "10.1234/x", title: "Transformer Architecture Paper" }),
    ];
    const { candidates } = rank(ref, cands);
    expect(candidates[0].doi).toBe("10.1234/x");
  });
});

describe("robust ranking (bad title parse, merged sources)", () => {
  it("scores a correct candidate highly even when the parsed title is garbage", () => {
    const ref: ParsedReference = {
      raw: "Dzmitry Bahdanau, Kyunghyun Cho, and Yoshua Bengio. 2014. Neural machine translation by jointly learning to align and translate. CoRR.",
      title: "CoRR", // simulated mis-parse
      authors: ["Bahdanau", "Cho"],
      year: 2014,
    };
    const good = scoreCandidate(ref, makeCandidate({ title: "Neural Machine Translation by Jointly Learning to Align and Translate", authors: ["Dzmitry Bahdanau", "Kyunghyun Cho"], year: 2014 }));
    const bad = scoreCandidate(ref, makeCandidate({ title: "Effective Approaches to Attention-based Neural Machine Translation", authors: ["Minh-Thang Luong"], year: 2015 }));
    expect(good.confidence).toBeGreaterThan(0.85);
    expect(bad.confidence).toBeLessThan(0.5);
  });

  it("treats an arXiv-issued DOI as an arXiv id match", () => {
    const ref: ParsedReference = { raw: "x", arxivId: "1706.03762" };
    const r = scoreCandidate(ref, makeCandidate({ doi: "10.48550/arXiv.1706.03762" }));
    expect(r.confidence).toBe(0.98);
    expect(r.pdfUrl).toBe("https://arxiv.org/pdf/1706.03762");
  });

  it("merges records bridged by different identifiers into one paper", () => {
    const a = makeCandidate({ source: "crossref", doi: "10.1/x", title: "Paper A", confidence: 0.9, abstract: "short" });
    const b = makeCandidate({ source: "semanticscholar", doi: "10.1/x", arxivId: "1234.5678", title: "Paper A", confidence: 0.8 });
    const c = makeCandidate({ source: "arxiv", arxivId: "1234.5678", title: "Paper A (preprint)", confidence: 0.7, abstract: "a much longer abstract" });
    const out = dedupe([a, b, c]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("crossref");
    expect(out[0].arxivId).toBe("1234.5678");
    expect(out[0].abstract).toBe("a much longer abstract");
    expect(out[0].pdfUrls).toContain("https://arxiv.org/pdf/1234.5678");
  });

  it("orders PDF links: arXiv first, publisher text-mining APIs last", () => {
    const a = makeCandidate({ doi: "10.1/y", title: "T", confidence: 0.9, pdfUrl: "https://api.elsevier.com/content/article/x" });
    const b = makeCandidate({ doi: "10.1/y", title: "T", confidence: 0.5, pdfUrl: "https://example.org/oa.pdf", arxivId: "2101.00001" });
    const [m] = dedupe([a, b]);
    expect(m.pdfUrls?.[0]).toBe("https://arxiv.org/pdf/2101.00001");
    expect(m.pdfUrls?.[m.pdfUrls.length - 1]).toBe("https://api.elsevier.com/content/article/x");
  });
});
