// Pure, dependency-free bibliography-entry extraction from pdf.js text items.
// Shared by the content script / bundled viewer (pdfReference.ts) and the page
// main-world bridge (pageFetch.ts) so both paths behave identically.

/**
 * Extract the `top` (PDF user-space Y) from an explicit destination array, honoring the
 * destination's fit type. The top coordinate lives at a different index per type:
 *
 *   [ref, /XYZ,   left, top, zoom]            -> index 3
 *   [ref, /FitH,  top]                        -> index 2
 *   [ref, /FitBH, top]                        -> index 2
 *   [ref, /FitR,  left, bottom, right, top]   -> index 5
 *   [ref, /Fit | /FitV | /FitB | /FitBV, ...] -> no usable top (return null)
 */
export function destTop(explicit: unknown[]): number | null {
  const fit = explicit[1] as { name?: string } | string | undefined;
  const name = typeof fit === "object" && fit ? fit.name : fit;
  let idx: number;
  switch (name) {
    case "XYZ":
      idx = 3;
      break;
    case "FitH":
    case "FitBH":
      idx = 2;
      break;
    case "FitR":
      idx = 5;
      break;
    default:
      return null;
  }
  const value = explicit[idx];
  return typeof value === "number" ? value : null;
}

/**
 * Extract the `left` (PDF user-space X) from an explicit destination, if available.
 * Only XYZ [ref, /XYZ, left, top, zoom] and FitR [ref, /FitR, left, ...] carry a left.
 */
export function destLeft(explicit: unknown[]): number | null {
  const fit = explicit[1] as { name?: string } | string | undefined;
  const name = typeof fit === "object" && fit ? fit.name : fit;
  if (name !== "XYZ" && name !== "FitR") return null;
  const value = explicit[2]; // left is always at index 2 for both types
  return typeof value === "number" ? value : null;
}

export interface TextItem {
  /** Advance width in PDF units, when known (pdf.js TextItem.width). */
  w?: number;
  x: number;
  y: number;
  str: string;
}

/**
 * Sort text items into visual reading order (top-to-bottom, left-to-right).
 * Groups items within 3 pts of Y into the same "line band" and sorts by X ascending
 * within each band. This ensures reference markers like "[2]" (which may have a
 * slightly lower Y than the adjacent text due to PDF floating-point arithmetic)
 * still appear before the entry text in the output.
 */
export function sortItemsIntoLines(items: TextItem[]): TextItem[] {
  const byY = [...items].sort((a, b) => b.y - a.y);
  const bands: TextItem[][] = [];
  for (const it of byY) {
    const last = bands[bands.length - 1];
    if (last && Math.abs(last[0].y - it.y) <= 3) last.push(it);
    else bands.push([it]);
  }
  return bands.flatMap((b) => b.sort((a, c) => a.x - c.x));
}

/**
 * Detect a column separator X on a page by finding the largest horizontal gap
 * among the leftmost-X positions of each visual line.
 *
 * Returns the X separator if a gap > 40 pts is found (indicating two columns),
 * otherwise returns null (single-column layout).
 */
export function columnSeparatorByLineStarts(items: TextItem[]): number | null {
  // Build visual lines (items already sorted y-desc, x-asc by callers)
  const lineMinX: number[] = [];
  let lineY: number | null = null;
  let minX = Infinity;
  for (const it of items) {
    if (lineY === null || Math.abs(it.y - lineY) > 3) {
      if (minX !== Infinity) lineMinX.push(minX);
      lineY = it.y;
      minX = it.x;
    } else {
      minX = Math.min(minX, it.x);
    }
  }
  if (minX !== Infinity) lineMinX.push(minX);
  if (lineMinX.length < 4) return null;

  const sorted = [...lineMinX].sort((a, b) => a - b);
  let maxGap = 0;
  let separatorX = -1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > maxGap) {
      maxGap = gap;
      separatorX = (sorted[i - 1] + sorted[i]) / 2;
    }
  }
  return maxGap >= 40 ? separatorX : null;
}

/**
 * Extract the bibliography entry text starting at the destination position.
 * Collects lines starting at `top` (or page top when null), stopping at the next
 * reference marker or a large vertical gap.
 *
 * `left`: the X position from the destination (XYZ/FitR); used for column-aware
 * filtering on multi-column pages so items from an adjacent column are excluded.
 * Column filtering is applied BEFORE band-sorting so cross-column items at similar
 * Y values are never mixed into the same line band.
 */
export function extractTextFromItems(
  allItems: TextItem[],
  top: number | null,
  pageHeight: number,
  left: number | null,
  pageWidth = 0,
): string {
  const startY = top ?? pageHeight;
  // Review copies (ACM `review`, ACL, IEEE drafts…) print line numbers in the margins on
  // their own vertical grid. Left in, they defeat column detection, become stray "lines"
  // inside entries, and hide the gaps that separate entries.
  // Bare page numbers in the header/footer band can sit right under the last line of a
  // column and would be read as part of the entry.
  const items = removeLineNumberColumns(allItems).filter(
    (i) => !(/^\d{1,4}$/.test(i.str.trim()) && (i.y < pageHeight * 0.12 || i.y > pageHeight * 0.88)),
  );

  // Detect column separator from ALL page items for reliable gap detection.
  // With item widths (always available from pdf.js) the extent-based gutter search is
  // authoritative, including its "no gutter → single column" verdict. The start-position
  // heuristics are only a fallback for callers that can't supply widths.
  const hasWidths = pageWidth > 0 && items.some((i) => typeof i.w === "number" && i.w > 0);
  const sep =
    left === null
      ? null
      : hasWidths
        ? columnSeparatorByCoverage(items, pageWidth, pageHeight)
        : columnSeparatorByLineStarts(items);

  // Apply column filter BEFORE band-sort so cross-column items at similar Y values
  // (e.g. a left-col journal name and a right-col [N] marker within 3 pts of Y) are
  // never grouped into the same line band.
  //
  // Both columns: use `left - COL_MARGIN` as the lower-X bound. This excludes
  // items significantly to the left of the destination (e.g. ACL-style line numbers
  // at x≈12 on the left margin when the left-column text starts at x≈70).
  // For the RIGHT column the lower bound also excludes opposite-column content.
  const COL_MARGIN = 20;
  const colItems =
    sep !== null && left !== null
      ? items.filter((i) =>
          left < sep
            ? i.x >= left - COL_MARGIN && i.x < sep   // left col: clamp both sides
            : i.x >= left - COL_MARGIN,                // right col: only lower bound needed
        )
      : items;

  // Y filter: keep only items at or below the destination top.
  const lines = assembleLines(colItems).filter((l) => l.y <= startY + 2);

  const collected: string[] = [];
  let prevY: number | null = null;
  // For [N]-style numbered references, the XYZ destination lands ~8 pts above the
  // actual [N] marker, so the last line(s) of the previous entry may appear first.
  // Edge case: when line spacing equals the 8pt hyperref margin, the destination top
  // lands exactly on the previous entry's [N] marker. Skip any [N] within 1 pt of
  // startY — it belongs to the previous entry, not the target.
  //
  // Restrict \d{1,3}\. (≤3 digits) so that years like "2021." never match as markers.
  const MARKER_RE = /^(\[\d+\]|\(\d+\)|\d{1,3}\.)\s/;
  // Numbered style needs several marker lines starting at the same x (the column edge).
  // A lone "420. URL https://…" — a wrapped URL/DOI tail — must not switch the whole page
  // into numbered mode (which skips everything above it) or cut an entry short.
  // Count markers over the whole column (not just below the destination: an entry at the
  // bottom of a column has no other markers below it). Labels are right-aligned ("[9]"
  // starts ~5pt right of "[10]"), hence the 12pt tolerance.
  const MARKER_TOL = 12;
  const markerXs = assembleLines(colItems)
    .filter((l) => MARKER_RE.test(l.str.trim()))
    .map((l) => l.x);
  const markerColumns = markerXs.filter(
    (x) => markerXs.filter((o) => Math.abs(o - x) <= MARKER_TOL).length >= 2,
  );
  const hasNumberMarker = markerColumns.length > 0;
  const isMarker = (l: TextItem, text: string): boolean =>
    MARKER_RE.test(text) && markerColumns.some((x) => Math.abs(l.x - x) <= MARKER_TOL);
  let pastFirstMarker = !hasNumberMarker; // author-year style: start immediately
  // For author-year format use a tighter gap threshold: entries are separated by
  // ~15-20 pt gaps while in-entry line spacing is ~11 pt.
  const gapThreshold = hasNumberMarker ? 28 : 14;
  // Why the loop ended: "entry" = a real boundary (next marker / inter-entry gap / cap).
  let ended: "entry" | "column" = "column";
  let breakLine: TextItem | null = null;
  for (const line of lines) {
    const text = line.str.trim();
    if (!text) continue;
    if (!pastFirstMarker) {
      if (isMarker(line, text)) {
        if (startY - line.y <= 1) continue; // [N] at the very top of range → previous entry, skip
        pastFirstMarker = true;
      } else {
        continue; // skip pre-marker tail from previous entry
      }
    }
    // Stop at the start of the next reference entry (e.g. "[12]", "(12)", "12.").
    if (collected.length > 0 && isMarker(line, text)) {
      ended = "entry";
      break;
    }
    // Stop on a vertical gap larger than the threshold.
    if (prevY != null && prevY - line.y > gapThreshold && collected.length > 0) {
      ended = "entry";
      breakLine = line;
      break;
    }
    collected.push(text);
    prevY = line.y;
    if (collected.join(" ").length > 2000) {
      ended = "entry";
      break;
    }
  }

  // A "gap" that is really the page footer (page number) means we hit the column bottom.
  if (breakLine && breakLine.y < pageHeight * 0.1 && breakLine.str.trim().length <= 12) ended = "column";

  // The entry ran off the bottom of the LEFT column and looks unfinished (complete
  // entries end with a period): continue with the hanging-indented lines at the top of
  // the right column. A non-indented line there starts the next entry, so we stop.
  const last = collected[collected.length - 1] ?? "";
  if (ended === "column" && collected.length > 0 && !/[.]\s*$/.test(last) && sep !== null && left !== null && left < sep) {
    let right = assembleLines(items.filter((i) => i.x >= sep)).filter(
      (l) => l.y < pageHeight * 0.94 && l.str.trim().length > 0, // skip running header
    );
    // A running header lower than the cutoff (ACM puts it at ~91%) is still recognisable:
    // it is set off from the column body by a gap far larger than the line spacing.
    if (right.length > 3) {
      const gaps = right.slice(1).map((l, i) => right[i].y - l.y).sort((a, b) => a - b);
      const typical = gaps[Math.floor(gaps.length / 2)];
      let start = 0;
      while (start < Math.min(3, right.length - 1) && right[start].y - right[start + 1].y > Math.max(12, typical * 2.5)) start++;
      right = right.slice(start);
    }
    if (right.length > 0) {
      const colLeft = Math.min(...right.map((l) => l.x));
      let prev: number | null = null;
      for (const line of right) {
        const text = line.str.trim();
        if (line.x <= colLeft + 2) break; // a non-indented line starts the next entry
        if (prev != null && prev - line.y > gapThreshold) break;
        collected.push(text);
        prev = line.y;
        if (collected.join(" ").length > 2000) break;
      }
    }
  }

  return joinLines(collected);
}

/**
 * Join extracted lines, undoing end-of-line hyphenation ("rep- resentations" →
 * "representations") when the next line continues in lowercase. Hyphens before an
 * uppercase letter or digit ("human-\nAI", "GPT-\n3") are kept, without the space.
 */
export function joinLines(lines: string[]): string {
  let out = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/\p{L}-$/u.test(out)) {
      out = /^\p{Ll}/u.test(line) ? out.slice(0, -1) + line : out + line;
    } else {
      out += (out ? " " : "") + line;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Band-sort items into visual lines (top to bottom), merge each band into one line, and
 * strip margin line numbers. Some papers (e.g. ACL review copies) print line numbers in
 * the margins; after band-sort they land at the start (x≈12) or end (x≈566) of a line.
 */
function assembleLines(items: TextItem[]): TextItem[] {
  const lines: TextItem[] = [];
  for (const it of sortItemsIntoLines(items)) {
    const prev = lines[lines.length - 1];
    if (prev && Math.abs(prev.y - it.y) <= 3) {
      prev.str += (prev.str.endsWith(" ") ? "" : " ") + it.str;
    } else {
      lines.push({ ...it });
    }
  }
  for (const l of lines) {
    // "746 Vibhor…" → "Vibhor…", "…Wen 808" → "…Wen". "2021." is kept (a period follows).
    l.str = l.str.replace(/^\d{1,4} +(?=\D)/, "").replace(/ +\d{1,4}$/, "").trim();
  }
  return lines;
}

/**
 * Find the gutter between two text columns as the widest vertical strip, in the middle
 * of the page, that no text item's extent [x, x + width] crosses. Uses item widths, so a
 * left-column item that merely *starts* near the middle can't be mistaken for the right
 * column. Running headers / footers / page numbers (top & bottom 7%) are ignored since
 * they often sit right on the gutter.
 */
export function columnSeparatorByCoverage(items: TextItem[], pageWidth: number, pageHeight: number): number | null {
  if (!pageWidth || !pageHeight) return null;
  const body = items.filter(
    (i) =>
      typeof i.w === "number" &&
      i.w > 0 &&
      i.str.trim() !== "" &&
      // Page numbers / footnote marks often sit right in the gutter (ACM footers at ~9%).
      !/^\d{1,4}$/.test(i.str.trim()) &&
      i.y > pageHeight * 0.07 &&
      i.y < pageHeight * 0.93,
  );
  if (body.length < 20) return null;
  const BIN = 2;
  const n = Math.ceil(pageWidth / BIN) + 1;
  const cover = new Uint16Array(n);
  for (const it of body) {
    const a = Math.max(0, Math.floor(it.x / BIN));
    const b = Math.min(n, Math.ceil((it.x + (it.w as number)) / BIN));
    for (let k = a; k < b; k++) cover[k]++;
  }
  const lo = Math.floor((pageWidth * 0.3) / BIN);
  const hi = Math.min(n - 1, Math.ceil((pageWidth * 0.7) / BIN));
  let best: number | null = null;
  let bestLen = 0;
  let runStart = -1;
  for (let k = lo; k <= hi; k++) {
    if (cover[k] === 0) {
      if (runStart < 0) runStart = k;
      const len = k - runStart + 1;
      if (len > bestLen) {
        bestLen = len;
        best = ((runStart + k + 1) / 2) * BIN;
      }
    } else {
      runStart = -1;
    }
  }
  if (best == null || bestLen * BIN < 6) return null;
  const sep = best;
  const leftCount = body.filter((i) => i.x + (i.w as number) <= sep).length;
  const rightCount = body.filter((i) => i.x >= sep).length;
  if (leftCount < 10 || rightCount < 10) return null;

  // A real right column is left-aligned: its lines start at the column edge (or a
  // hanging indent just past it). A coincidental empty strip in single-column text
  // (short last lines of a reference list) has right-side "lines" starting anywhere.
  const starts = new Map<number, number>(); // y-band → min x right of the gutter
  for (const it of body) {
    if (it.x < sep) continue;
    const band = Math.round(it.y / 3);
    const cur = starts.get(band);
    if (cur === undefined || it.x < cur) starts.set(band, it.x);
  }
  const xs = [...starts.values()].sort((a, b) => a - b);
  if (xs.length < 4) return null;
  // The column edge is the leftmost start shared by several lines; a lone stray item
  // (caption fragment, symbol) must not define it.
  const support = Math.max(2, Math.ceil(xs.length * 0.05));
  const edge = xs.find((x) => xs.filter((o) => Math.abs(o - x) <= 2).length >= support) ?? xs[0];
  // ≤ 30pt covers "[18] " numbered markers plus a hanging indent.
  const aligned = xs.filter((x) => x - edge <= 30).length / xs.length;
  return aligned >= 0.6 ? sep : null;
}

/**
 * Drop margin line numbers: digit-only items stacked in a vertical column at one x that
 * count up (mostly by 1) from top to bottom. A column of numbers in a table rarely counts
 * up by exactly one, and needs to be this long to qualify.
 */
export function removeLineNumberColumns(items: TextItem[]): TextItem[] {
  const groups = new Map<number, TextItem[]>();
  for (const it of items) {
    if (!/^\d{1,5}$/.test(it.str.trim())) continue;
    const gx = Math.round(it.x / 3);
    const g = groups.get(gx);
    if (g) g.push(it);
    else groups.set(gx, [it]);
  }
  const drop = new Set<TextItem>();
  for (const g of groups.values()) {
    if (g.length < 8) continue;
    const seq = [...g].sort((a, b) => b.y - a.y).map((i) => Number(i.str.trim()));
    let steps = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] - seq[i - 1] === 1) steps++;
    if (steps / (seq.length - 1) >= 0.7) for (const it of g) drop.add(it);
  }
  return drop.size ? items.filter((it) => !drop.has(it)) : items;
}
