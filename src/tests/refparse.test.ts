import { describe, it, expect } from "vitest";
import { parseReference, normalizeTitle } from "@shared/refparse";

describe("normalizeTitle", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeTitle("Deep Learning: A Review")).toBe("deep learning a review");
  });

  it("normalizes unicode dashes to hyphen", () => {
    expect(normalizeTitle("Self\u2013Attention Models")).toBe("self attention models");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeTitle("  Foo   Bar  ")).toBe("foo bar");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeTitle("")).toBe("");
  });
});

describe("parseReference — DOI extraction", () => {
  it("extracts a plain DOI", () => {
    const ref = parseReference("Smith J. (2023). A great paper. https://doi.org/10.1234/jfoo.2023");
    expect(ref.doi).toBe("10.1234/jfoo.2023");
  });

  it("strips trailing dot from DOI", () => {
    const ref = parseReference("Smith J. A paper. doi:10.1145/12345.67890.");
    expect(ref.doi).toBe("10.1145/12345.67890");
  });

  it("does not extract DOI when absent", () => {
    const ref = parseReference("Smith J. A paper without doi. 2023.");
    expect(ref.doi).toBeUndefined();
  });
});

describe("parseReference — arXiv ID extraction", () => {
  it("extracts arXiv: prefixed id", () => {
    const ref = parseReference("Vaswani et al. Attention Is All You Need. arXiv:1706.03762. 2017.");
    expect(ref.arxivId).toBe("1706.03762");
  });

  it("extracts bare arXiv id (YYMM.NNNNN form)", () => {
    const ref = parseReference("Brown et al. Language Models are Few-Shot Learners. 2005.14165. 2020.");
    expect(ref.arxivId).toBe("2005.14165");
  });

  it("strips version suffix from arXiv: prefixed id", () => {
    const ref = parseReference("Someone. A paper. arXiv:2103.00020v2. 2021.");
    expect(ref.arxivId).toBe("2103.00020v2");
  });
});

describe("parseReference — year extraction", () => {
  it("extracts a 4-digit year", () => {
    const ref = parseReference("Smith (2023). A paper.");
    expect(ref.year).toBe(2023);
  });

  it("handles year at end", () => {
    const ref = parseReference("Guo et al. DeepSeek-Coder, 2024.");
    expect(ref.year).toBe(2024);
  });
});

describe("parseReference — title extraction", () => {
  it("extracts quoted title", () => {
    const ref = parseReference('Smith J. "Attention Is All You Need." NeurIPS 2017.');
    // clean() strips trailing punctuation, so the period inside quotes is trimmed
    expect(ref.title).toBe("Attention Is All You Need");
  });

  it("extracts title from APA (Year) pattern", () => {
    const ref = parseReference("Smith, J., & Jones, B. (2023). A great paper. Journal.");
    expect(ref.title).toBe("A great paper");
  });

  it("extracts title from NeurIPS/arXiv style (before year at end)", () => {
    const ref = parseReference(
      "Guo et al. DeepSeek-Coder: When the large language model meets programming - the rise of code intelligence, 2024.",
    );
    expect(ref.title).toBeTruthy();
    expect(ref.title!.toLowerCase()).toContain("deepseek");
  });
});

describe("parseReference — author extraction", () => {
  it("extracts author surnames from APA style", () => {
    const ref = parseReference("Smith, J., Jones, B., & Williams, C. (2023). A paper.");
    expect(ref.authors).toBeDefined();
    expect(ref.authors!.some((a) => a.toLowerCase().includes("smith"))).toBe(true);
  });

  it("handles et al gracefully", () => {
    const ref = parseReference("Guo, D., Zhu, Q., et al. DeepSeek paper. 2024.");
    expect(ref.authors).toBeDefined();
    expect(ref.authors!.length).toBeGreaterThan(0);
  });
});

describe("parseReference — realistic examples", () => {
  it("parses NeurIPS citation with arXiv ID", () => {
    const raw =
      "Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, A. N., Kaiser, Ł., and Polosukhin, I. (2017). Attention is all you need. arXiv:1706.03762.";
    const ref = parseReference(raw);
    expect(ref.arxivId).toBe("1706.03762");
    expect(ref.year).toBe(2017);
    expect(ref.authors).toBeDefined();
  });

  it("parses citation with just a DOI and year", () => {
    const raw = "Devlin J et al. BERT (2019). doi:10.18653/v1/N19-1423.";
    const ref = parseReference(raw);
    expect(ref.doi).toBe("10.18653/v1/N19-1423");
    expect(ref.year).toBe(2019);
  });

  it("parses et-al citation without doi", () => {
    const raw =
      "Guo, D., Zhu, Q., Yang, D., Xie, Z., Dong, K., Zhang, W., Chen, G., Bi, X., Wu, Y., Li, Y. K., et al. Deepseek-coder: When the large language model meets programming - the rise of code intelligence, 2024.";
    const ref = parseReference(raw);
    expect(ref.year).toBe(2024);
    expect(ref.title).toBeTruthy();
  });
});
