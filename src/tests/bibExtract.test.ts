import { describe, it, expect } from "vitest";
import { columnSeparatorByCoverage, extractTextFromItems, joinLines, removeLineNumberColumns, type TextItem } from "@shared/bibExtract";

const W = 612;
const H = 792;

/** One text item per line; `lines` are [x, y, text] (y in PDF space, top ≈ 720). */
function items(lines: Array<[number, number, string]>, width = 210): TextItem[] {
  return lines
    .map(([x, y, str]) => ({ x, y, w: width, str }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
}

/** A two-column page: left column at x=72, right column at x=320, 11pt leading. */
function twoColumnPage(left: string[], right: string[]): TextItem[] {
  const out: Array<[number, number, string]> = [];
  left.forEach((t, i) => out.push([t.startsWith("  ") ? 80 : 72, 720 - i * 11, t.trim()]));
  right.forEach((t, i) => out.push([t.startsWith("  ") ? 328 : 320, 720 - i * 11, t.trim()]));
  return items(out);
}

const filler = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => (i % 3 === 0 ? `${prefix} Author${i}. 2019. Some title ${i}.` : `  continued text ${i}.`));

describe("joinLines", () => {
  it("undoes end-of-line hyphenation before a lowercase continuation", () => {
    expect(joinLines(["Deep contextualized word rep-", "resentations. In NAACL."])).toBe(
      "Deep contextualized word representations. In NAACL.",
    );
  });

  it("keeps real hyphens before uppercase / digits, without inserting a space", () => {
    expect(joinLines(["controllable human-", "AI interaction"])).toBe("controllable human-AI interaction");
    expect(joinLines(["GPT-", "3 results"])).toBe("GPT-3 results");
  });

  it("joins ordinary lines with single spaces", () => {
    expect(joinLines(["a  b", "", " c "])).toBe("a b c");
  });
});

describe("columnSeparatorByCoverage", () => {
  it("finds the gutter of a two-column page", () => {
    const page = twoColumnPage(filler(40, "L"), filler(40, "R"));
    const sep = columnSeparatorByCoverage(page, W, H);
    expect(sep).not.toBeNull();
    expect(sep!).toBeGreaterThan(72 + 210);
    expect(sep!).toBeLessThan(320);
  });

  it("returns null for single-column text", () => {
    const single = items(Array.from({ length: 40 }, (_, i) => [72, 720 - i * 11, `full width line ${i}`]), 460);
    expect(columnSeparatorByCoverage(single, W, H)).toBeNull();
  });

  it("rejects a coincidental empty strip whose right side isn't left-aligned", () => {
    // Short left fragments + right fragments starting at scattered x positions.
    const lines: Array<[number, number, string]> = [];
    for (let i = 0; i < 30; i++) {
      lines.push([72, 720 - i * 11, `left ${i}`]);
      lines.push([330 + ((i * 37) % 160), 720 - i * 11, `word ${i}`]);
    }
    expect(columnSeparatorByCoverage(items(lines, 60), W, H)).toBeNull();
  });
});

describe("extractTextFromItems", () => {
  it("continues an unfinished entry from the bottom of the left column into the right column", () => {
    const left = [...filler(30, "L"), "Tom B. Brown, Benjamin Mann, Nick Ryder, Melanie", "  Subbiah, Jared Kaplan, Prafulla Dhariwal, Amanda"];
    const right = ["  Askell, and Dario Amodei. 2020. Language models are", "  few-shot learners. In NeurIPS.", "Next Author. 2021. Another paper.", ...filler(30, "R")];
    const page = twoColumnPage(left, right);
    const top = 720 - 30 * 11 + 2; // the Brown entry's destination
    const raw = extractTextFromItems(page, top, H, 72, W);
    expect(raw).toContain("Tom B. Brown");
    expect(raw).toContain("Language models are few-shot learners");
    expect(raw).not.toContain("Next Author");
  });

  it("does not continue an entry that ended with a period", () => {
    const left = [...filler(30, "L"), "Ada Lovelace. 1843. Notes on the engine."];
    const right = ["  dangling continuation that belongs elsewhere", ...filler(30, "R")];
    const raw = extractTextFromItems(twoColumnPage(left, right), 720 - 30 * 11 + 2, H, 72, W);
    expect(raw).toBe("Ada Lovelace. 1843. Notes on the engine.");
  });
});

describe("review copies: margin line numbers and gutter page numbers (ACM acmart review)", () => {
  /** Two columns on an 8pt text grid plus margin line numbers on their own 11pt grid. */
  function reviewPage(withFooterInGutter: boolean): TextItem[] {
    const out: TextItem[] = [];
    for (let i = 0; i < 40; i++) {
      const y = 700 - i * 8;
      const first = i % 3 === 0;
      out.push({ x: first ? 57 : 70, y, w: first ? 237 : 224, str: first ? `[${i / 3 + 1}] Left Author${i}. 2019. Left title ${i}.` : `left continued ${i}` });
      out.push({ x: first ? 318 : 334, y, w: first ? 240 : 224, str: first ? `[${i / 3 + 20}] Right Author${i}. 2020. Right title ${i}.` : `right continued ${i}` });
    }
    for (let i = 0; i < 30; i++) {
      out.push({ x: 28, y: 705 - i * 11, w: 11, str: String(1399 + i) });
      out.push({ x: 578, y: 705 - i * 11, w: 11, str: String(1457 + i) });
    }
    if (withFooterInGutter) out.push({ x: 302.7, y: 72.7, w: 6.5, str: "13" });
    return out.sort((a, b) => b.y - a.y || a.x - b.x);
  }

  it("removes margin line-number columns but keeps ordinary numbers", () => {
    const page = reviewPage(false);
    page.push({ x: 120, y: 300, w: 10, str: "42" });
    const kept = removeLineNumberColumns(page);
    expect(kept.some((i) => i.str === "1400" || i.str === "1460")).toBe(false);
    expect(kept.some((i) => i.str === "42")).toBe(true);
  });

  it("still finds the gutter with line numbers and a page number sitting in it", () => {
    const page = removeLineNumberColumns(reviewPage(true));
    const sep = columnSeparatorByCoverage(page, W, H);
    expect(sep).not.toBeNull();
    expect(sep!).toBeGreaterThan(294);
    expect(sep!).toBeLessThan(318);
  });

  it("extracts a right-column entry without left-column text or line numbers", () => {
    const raw = extractTextFromItems(reviewPage(true), 700 + 2, H, 317.9, W);
    expect(raw.startsWith("[20] Right Author0. 2020. Right title 0.")).toBe(true);
    expect(raw).not.toMatch(/Left|14\d\d/);
  });
});

describe("numbered-style detection", () => {
  it("a wrapped URL tail like '420. URL …' doesn't make an author-year page 'numbered'", () => {
    const lines: Array<[number, number, string]> = [
      [108, 700, "A. Author and B. Author. First paper title. In Venue, 2020."],
      [108, 680, "C. Raffel, N. Shazeer, and P. J. Liu. Exploring the limits of transfer learning."],
      [118, 669, "arXiv preprint arXiv:1910.10683, 2019."],
      [108, 650, "D. Someone. A paper with a long URL. In EMNLP, pages 1–10, 2020. doi: 10.18653/v1/2020.emnlp-main."],
      [118, 639, "420. URL https://aclanthology.org/2020.emnlp-main.420."],
      [108, 620, "K. Song and T.-Y. Liu. Mass: Masked sequence to sequence pre-training. 2019."],
    ];
    const raw = extractTextFromItems(items(lines, 390), 685, H, 83, W);
    expect(raw).toBe("C. Raffel, N. Shazeer, and P. J. Liu. Exploring the limits of transfer learning. arXiv preprint arXiv:1910.10683, 2019.");
  });

  it("right-aligned labels ([9] vs [10]) count as one marker column", () => {
    const lines: Array<[number, number, string]> = [];
    for (let n = 1; n <= 14; n++) lines.push([n < 10 ? 113 : 108, 720 - n * 22, `[${n}] Author${n}. Title number ${n}. Venue, 20${10 + n}.`]);
    const raw = extractTextFromItems(items(lines, 380), 720 - 9 * 22 + 6, H, 108, W);
    expect(raw).toBe("[9] Author9. Title number 9. Venue, 2019.");
  });
});
