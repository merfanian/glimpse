import { describe, it, expect } from "vitest";
import { destTop, findReferenceByHref, findReferenceAt } from "../content/pdfReference";
import type { ReferenceIndex } from "../content/pdfReference";
import type { ParsedReference } from "@shared/types";

function makeRef(title: string): ParsedReference {
  return { raw: title, title };
}

function makeIndex(entries: ReferenceIndex["entries"] = []): ReferenceIndex {
  const byDest = new Map<string, ParsedReference>();
  for (const e of entries) {
    if (!byDest.has(e.destKey)) byDest.set(e.destKey, e.reference);
  }
  const pageSizes = new Map<number, { width: number; height: number }>();
  pageSizes.set(1, { width: 612, height: 792 });
  return { entries, pageSizes, byDest };
}

// ---------------------------------------------------------------------------
// destTop
// ---------------------------------------------------------------------------

describe("destTop — XYZ destination", () => {
  it("extracts top from index 3", () => {
    expect(destTop([{}, { name: "XYZ" }, 72, 650, 0])).toBe(650);
  });

  it("returns null when top value is null", () => {
    expect(destTop([{}, { name: "XYZ" }, 72, null, 0])).toBeNull();
  });

  it("returns null when top value is missing", () => {
    expect(destTop([{}, { name: "XYZ" }])).toBeNull();
  });
});

describe("destTop — FitH destination", () => {
  it("extracts top from index 2", () => {
    expect(destTop([{}, { name: "FitH" }, 700])).toBe(700);
  });

  it("handles string fit name", () => {
    expect(destTop([{}, "FitH", 700])).toBe(700);
  });
});

describe("destTop — FitBH destination", () => {
  it("extracts top from index 2", () => {
    expect(destTop([{}, { name: "FitBH" }, 550])).toBe(550);
  });
});

describe("destTop — FitR destination", () => {
  it("extracts top from index 5 (left, bottom, right, top)", () => {
    // [ref, /FitR, left, bottom, right, top]
    expect(destTop([{}, { name: "FitR" }, 0, 100, 612, 720])).toBe(720);
  });

  it("returns null when top value missing", () => {
    expect(destTop([{}, { name: "FitR" }, 0, 100])).toBeNull();
  });
});

describe("destTop — unknown/Fit types", () => {
  it("returns null for /Fit", () => {
    expect(destTop([{}, { name: "Fit" }])).toBeNull();
  });

  it("returns null for /FitV", () => {
    expect(destTop([{}, { name: "FitV" }, 72])).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(destTop([])).toBeNull();
  });

  it("returns null for undefined fit type", () => {
    expect(destTop([{}])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findReferenceByHref
// ---------------------------------------------------------------------------

describe("findReferenceByHref", () => {
  const ref1 = makeRef("Paper One");
  const ref2 = makeRef("Paper Two");
  const index = makeIndex([
    { srcPage: 1, rect: [10, 10, 100, 20], destKey: "cite.smith2023", reference: ref1 },
    { srcPage: 1, rect: [10, 30, 100, 40], destKey: "cite.jones2022", reference: ref2 },
  ]);

  it("finds reference by exact fragment", () => {
    expect(findReferenceByHref(index, "#cite.smith2023")).toBe(ref1);
  });

  it("finds reference by URI-decoded fragment", () => {
    const idx = makeIndex([
      { srcPage: 1, rect: [0, 0, 100, 10], destKey: "cite.müller2020", reference: ref1 },
    ]);
    expect(findReferenceByHref(idx, "#cite.m%C3%BCller2020")).toBe(ref1);
  });

  it("returns null for non-fragment href", () => {
    expect(findReferenceByHref(index, "https://example.com")).toBeNull();
  });

  it("returns null for empty href", () => {
    expect(findReferenceByHref(index, "")).toBeNull();
  });

  it("returns null for unknown fragment", () => {
    expect(findReferenceByHref(index, "#cite.unknown")).toBeNull();
  });

  it("tries raw fragment first, then decoded", () => {
    // "+" in the raw key — only raw lookup should succeed
    const idx = makeIndex([
      { srcPage: 1, rect: [0, 0, 10, 10], destKey: "cite.a+b", reference: ref2 },
    ]);
    expect(findReferenceByHref(idx, "#cite.a+b")).toBe(ref2);
  });
});

// ---------------------------------------------------------------------------
// findReferenceAt
// ---------------------------------------------------------------------------

describe("findReferenceAt", () => {
  const ref1 = makeRef("Paper One");
  const ref2 = makeRef("Paper Two");
  // Page dimensions: width=612, height=792
  // Rects are in PDF coords (y grows upward)
  // A rect [50, 750, 200, 765] is near the top of the page in PDF space.
  const index = makeIndex([
    { srcPage: 1, rect: [50, 750, 200, 765], destKey: "a", reference: ref1 },
    { srcPage: 1, rect: [50, 400, 200, 415], destKey: "b", reference: ref2 },
  ]);

  it("finds a reference when the point is inside the rect", () => {
    // rect [50,750,200,765] in PDF space
    // normX = 125/612 ≈ 0.204, normY = (792-757)/792 ≈ 0.044 (DOM top-origin)
    const normX = 125 / 612;
    const normY = (792 - 757) / 792;
    expect(findReferenceAt(index, 1, normX, normY)).toBe(ref1);
  });

  it("finds a second reference at a different position", () => {
    const normX = 100 / 612;
    const normY = (792 - 407) / 792;
    expect(findReferenceAt(index, 1, normX, normY)).toBe(ref2);
  });

  it("returns null when no entry matches the point", () => {
    const normX = 0.5;
    const normY = 0.5;
    expect(findReferenceAt(index, 1, normX, normY)).toBeNull();
  });

  it("returns null for an unknown page", () => {
    expect(findReferenceAt(index, 99, 0.5, 0.5)).toBeNull();
  });

  it("returns null when entries are on a different page", () => {
    const normX = 125 / 612;
    const normY = (792 - 757) / 792;
    expect(findReferenceAt(index, 2, normX, normY)).toBeNull();
  });

  it("accepts point within 2-unit tolerance outside rect", () => {
    // rect [50,750,200,765]: point at PDF y=748 is 2 units below minY=750, within tolerance
    const normX = 125 / 612;
    const normY = (792 - 748) / 792;
    expect(findReferenceAt(index, 1, normX, normY)).toBe(ref1);
  });
});
