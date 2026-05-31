// Runs in the PAGE's main world (not the isolated content-script world).
//
// Injected dynamically via <script src> by the content script. The dynamic injection
// approach is used instead of manifest `world:"MAIN"` for maximum cross-browser
// reliability and to avoid Firefox Xray-wrapper issues with the `world` manifest field.
//
// Some viewers (notably Overleaf) serve their PDF from a different registrable domain
// (e.g. overleafusercontent.com). Their compile URLs are only fetchable from the page's
// own JS context: a background or isolated content-script fetch doesn't carry the right
// origin/cookies and returns HTTP 404.
//
// This bridge does the fetch with page-context credentials and returns bytes as base64
// over window.postMessage so no binary objects cross the Xray compartment boundary.
//
// Firefox Xray fix: For Firefox, pdf.js running in the content-script's isolated
// compartment triggers "Permission denied to access property autoAllocateChunkSize"
// because Firefox's Xray security wrappers block cross-compartment ReadableStream usage.
// The fix is to run ALL pdf.js operations here in the MAIN world (page JS context),
// where there are NO Xray restrictions. We bundle pdf.js into this script for Firefox
// (DCE eliminates it for Chrome where the content-script approach works fine).

import { parseReference, isBibliographyEntry } from "@shared/refparse";
import type { ParsedReference } from "@shared/types";

// Firefox-only: set up pdfjs with a fake worker in the MAIN world (page context).
// In the page context there are no Xray wrapper restrictions, so ReadableStream works.
// We use a fake worker (LoopbackPort, single-threaded) to avoid needing a worker URL
// that would be subject to the page's worker-src CSP.
let pagePdfWorkerReady: Promise<void> = Promise.resolve();
if (__BROWSER__ === "firefox") {
  pagePdfWorkerReady = import("pdfjs-dist/build/pdf.worker.mjs").then((worker) => {
    (window as unknown as Record<string, unknown>).pdfjsWorker = {
      WorkerMessageHandler: (worker as { WorkerMessageHandler: unknown }).WorkerMessageHandler,
    };
  });
}

interface PageIndexEntry {
  srcPage: number;
  rect: [number, number, number, number];
  destKey: string;
  reference: ParsedReference;
}

interface PageReferenceIndex {
  entries: PageIndexEntry[];
  pageSizes: Array<[number, { width: number; height: number }]>;
  byDest: Array<[string, ParsedReference]>;
}

interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  getDestination(dest: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

interface PdfPageLike {
  getViewport(opts: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[] }> }>;
  getAnnotations(opts: { intent: "display" }): Promise<
    Array<{ subtype?: string; dest?: unknown; rect?: unknown }>
  >;
}

// Guard: if injected twice (e.g. via both manifest and dynamic injection), only run once.
interface BridgedWindow extends Window { __rpBridgeActive?: boolean; }
if (!(window as BridgedWindow).__rpBridgeActive) {
  (window as BridgedWindow).__rpBridgeActive = true;

  const REQ = "RP_PAGE_FETCH_REQ";
  const RES = "RP_PAGE_FETCH_RES";
  const INDEX_REQ = "RP_PAGE_INDEX_REQ";
  const INDEX_RES = "RP_PAGE_INDEX_RES";
  const RENDER_REQ = "RP_PAGE_RENDER_REQ";
  const RENDER_RES = "RP_PAGE_RENDER_RES";

  function bytesToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(bin);
  }

  type PdfAppWindow = Window & {
    PDFViewerApplication?: {
      pdfDocument?: PdfDocumentLike;
      pdfViewer?: { pdfDocument?: PdfDocumentLike };
    };
    pdfViewer?: { pdfDocument?: PdfDocumentLike };
  };

  function docFromWindow(w: PdfAppWindow): PdfDocumentLike | null {
    return (
      w.PDFViewerApplication?.pdfDocument ??
      w.PDFViewerApplication?.pdfViewer?.pdfDocument ??
      w.pdfViewer?.pdfDocument ??
      null
    );
  }

  function currentPdfDocument(): PdfDocumentLike | null {
    // First: check the current window (standard pdf.js viewer pages).
    const direct = docFromWindow(window as PdfAppWindow);
    if (direct) return direct;

    // Overleaf (and some other sites) embed the pdf.js viewer inside a child iframe.
    // Same-origin iframes are accessible; cross-origin ones throw on contentWindow access.
    for (const iframe of Array.from(document.querySelectorAll("iframe"))) {
      try {
        const iw = iframe.contentWindow as PdfAppWindow | null;
        if (!iw) continue;
        const doc = docFromWindow(iw);
        if (doc) return doc;
      } catch {
        /* cross-origin iframe — skip */
      }
    }

    return null;
  }

  // The `top` coordinate lives at a different index per destination fit type, so we must
  // not assume `XYZ`. Reading explicit[3] for a `FitH`/`FitR` destination yields a wrong
  // (or null) top, which makes the caller scan from the top of the page and return the
  // wrong bibliography entry.
  //   [ref, /XYZ, left, top, zoom] -> 3 ; [ref, /FitH|/FitBH, top] -> 2
  //   [ref, /FitR, left, bottom, right, top] -> 5 ; /Fit|/FitV|/FitB|/FitBV -> none
  function destTop(explicit: unknown[]): number | null {
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

  // Extract left (X) from XYZ and FitR destinations.
  function destLeft(explicit: unknown[]): number | null {
    const fit = explicit[1] as { name?: string } | string | undefined;
    const name = typeof fit === "object" && fit ? fit.name : fit;
    if (name !== "XYZ" && name !== "FitR") return null;
    const value = explicit[2];
    return typeof value === "number" ? value : null;
  }

  // Sort text items into visual reading order (top-to-bottom, left-to-right within
  // each line band). Groups items within 3 pts of Y into the same band and sorts by
  // X ascending within the band, ensuring [N] markers (x=57) precede entry text (x=70)
  // even when their Y values differ by a tiny floating-point amount.
  function sortItemsIntoLines(
    items: Array<{ x: number; y: number; str: string }>,
  ): Array<{ x: number; y: number; str: string }> {
    const byY = [...items].sort((a, b) => b.y - a.y);
    const bands: (typeof items)[] = [];
    for (const it of byY) {
      const last = bands[bands.length - 1];
      if (last && Math.abs(last[0].y - it.y) <= 3) last.push(it);
      else bands.push([it]);
    }
    return bands.flatMap((b) => b.sort((a, c) => a.x - c.x));
  }

  // Detect a column separator X by finding the largest gap in line-start X positions.
  // Returns null if no clear two-column structure is found (gap < 40 pts).
  function detectColumnSeparator(items: Array<{ x: number; y: number; str: string }>): number | null {
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
    let sep = -1;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap > maxGap) { maxGap = gap; sep = (sorted[i - 1] + sorted[i]) / 2; }
    }
    return maxGap >= 40 ? sep : null;
  }

  async function resolveDest(
    doc: PdfDocumentLike,
    dest: unknown,
  ): Promise<{ pageIndex: number; top: number | null; left: number | null } | null> {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : Array.isArray(dest) ? dest : null;
    if (!explicit || explicit.length === 0) return null;

    try {
      const pageIndex = await doc.getPageIndex(explicit[0]);
      return { pageIndex, top: destTop(explicit), left: destLeft(explicit) };
    } catch {
      return null;
    }
  }

  async function extractEntryText(
    doc: PdfDocumentLike,
    pageIndex: number,
    top: number | null,
    left: number | null,
  ): Promise<string> {
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const items: Array<{ y: number; x: number; str: string }> = [];
    for (const it of content.items) {
      if (typeof it.str !== "string" || it.str.length === 0 || !Array.isArray(it.transform)) continue;
      items.push({ x: it.transform[4], y: it.transform[5], str: it.str });
    }

    const startY = top == null ? viewport.height : top;

    // Detect column separator from ALL page items for reliable gap detection.
    const sep = left !== null ? detectColumnSeparator(items) : null;

    // Apply column filter BEFORE band-sort.
    // Left col (left < sep): keep items left of separator.
    // Right col (left >= sep): keep items within 40 pts of the destination's X to
    // exclude "gap" items that fall between columns due to floating-point Y grouping.
    const COL_MARGIN = 20;
    const colItems =
      sep !== null && left !== null
        ? items.filter((i) => (left < sep ? i.x < sep : i.x >= left - COL_MARGIN))
        : items;

    // Band-sort only within the target column, then Y-filter.
    const below = sortItemsIntoLines(colItems).filter((i) => i.y <= startY + 2);

    const lines: Array<{ y: number; x: number; str: string }> = [];
    for (const it of below) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= 3) {
        last.str += (last.str.endsWith(" ") ? "" : " ") + it.str;
      } else {
        lines.push({ ...it });
      }
    }

    const collected: string[] = [];
    let prevY: number | null = null;
    // For [N]-style numbered references, the XYZ destination lands ~8 pts above the
    // actual [N] marker, so the last line(s) of the previous entry may appear first.
    // Edge case: when line spacing equals the 8pt hyperref margin, the destination top
    // lands exactly on the previous entry's [N] marker. Skip any [N] within 1 pt of
    // startY — it belongs to the previous entry, not the target.
    const hasNumberMarker = lines.some((l) => /^(\[\d+\]|\(\d+\)|\d+\.)\s/.test(l.str.trim()));
    let pastFirstMarker = !hasNumberMarker; // author-year style: start immediately
    for (const line of lines) {
      const text = line.str.trim();
      if (!text) continue;
      if (!pastFirstMarker) {
        if (/^(\[\d+\]|\(\d+\)|\d+\.)\s/.test(text)) {
          if (startY - line.y <= 1) continue; // [N] at the very top of range → previous entry, skip
          pastFirstMarker = true;
        } else {
          continue; // skip pre-marker tail from previous entry
        }
      }
      if (collected.length > 0 && /^(\[\d+\]|\(\d+\)|\d+\.)\s/.test(text)) break;
      if (prevY != null && prevY - line.y > 28 && collected.length > 0) break;
      collected.push(text);
      prevY = line.y;
      if (collected.join(" ").length > 900) break;
    }

    return collected.join(" ").replace(/\s+/g, " ").trim();
  }

  async function buildPageReferenceIndex(docIn?: PdfDocumentLike): Promise<PageReferenceIndex> {
    let doc = docIn;
    if (!doc) {
      // pdf.js initialises asynchronously after page load (Overleaf and some standalone
      // viewers). Poll briefly so we don't fail immediately if called before the viewer
      // is ready, but keep the total overhead small so Firefox's capture-based fallback
      // path can start quickly when the iframe PDF isn't accessible.
      for (let i = 0; i < 5 && !doc; i++) {
        if (i > 0) await new Promise<void>((r) => setTimeout(r, 200));
        doc = currentPdfDocument() ?? undefined;
      }
      if (!doc) throw new Error("No loaded pdf.js document found in page context");
    }

    const entries: PageIndexEntry[] = [];
    const pageSizes = new Map<number, { width: number; height: number }>();
    const destCache = new Map<string, ParsedReference>();
    const byDest = new Map<string, ParsedReference>();

    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      pageSizes.set(p, { width: viewport.width, height: viewport.height });

      const annotations = await page.getAnnotations({ intent: "display" });
      for (const a of annotations) {
        if (a.subtype !== "Link" || !a.dest || !Array.isArray(a.rect)) continue;
        const rect = a.rect;
        if (rect.length !== 4 || !rect.every((v): v is number => typeof v === "number")) continue;
        const destKey = typeof a.dest === "string" ? a.dest : JSON.stringify(a.dest);

        let reference = destCache.get(destKey);
        if (!reference) {
          const resolved = await resolveDest(doc, a.dest);
          if (!resolved) continue;
          const raw = await extractEntryText(doc, resolved.pageIndex, resolved.top, resolved.left);
          if (!raw || raw.length < 8) continue;
          reference = parseReference(raw);
          // Cache even rejected entries to avoid re-extracting text for subsequent
          // links pointing to the same destination.
          destCache.set(destKey, reference);
        }

        // Filter non-bibliography destinations (sections, figures, tables, etc.)
        // using dest-key prefix + content signals (year/DOI/arXivId).
        if (!isBibliographyEntry(destKey, reference)) continue;

        entries.push({ srcPage: p, rect: rect as [number, number, number, number], destKey, reference });
        if (!byDest.has(destKey)) byDest.set(destKey, reference);
      }
    }

    return { entries, pageSizes: [...pageSizes.entries()], byDest: [...byDest.entries()] };
  }

  window.addEventListener("message", (ev: MessageEvent) => {
    // In the MAIN world, ev.source === window is a reliable identity check.
    if (ev.source !== window) return;
    const data = ev.data as { source?: string; id?: string; url?: string; pdfUrl?: string } | null;
    if (!data || typeof data.id !== "string") return;

    // Render cited-paper PDF pages in the MAIN world (no Xray restrictions) and return
    // blob URLs. Only needed for Firefox — Chrome renders fine in the content script.
    if (__BROWSER__ === "firefox" && data.source === RENDER_REQ) {
      const { id, pdfDataBase64, availableWidth } = data as {
        id: string;
        pdfDataBase64: string;
        availableWidth: number;
      };
      void (async () => {
        try {
          await pagePdfWorkerReady;
          const { getDocument } = await import("pdfjs-dist");
          const bytes = Uint8Array.from(atob(pdfDataBase64), (c) => c.charCodeAt(0));
          const doc = await getDocument({
            data: bytes,
            disableRange: true,
            disableStream: true,
            isEvalSupported: false,
          }).promise;

          const dpr = window.devicePixelRatio || 1;
          const pageUrls: string[] = [];
          const pageDimensions: Array<{ cssWidth: number; cssHeight: number }> = [];

          for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const naturalVp = page.getViewport({ scale: 1 });
            const scale = (availableWidth / naturalVp.width) * dpr;
            const viewport = page.getViewport({ scale });

            const cssWidth = Math.round(viewport.width / dpr);
            const cssHeight = Math.round(viewport.height / dpr);

            const offscreen = new OffscreenCanvas(viewport.width, viewport.height);
            const ctx = offscreen.getContext("2d");
            if (ctx) {
              ctx.fillStyle = "white";
              ctx.fillRect(0, 0, viewport.width, viewport.height);
              await page.render({
                canvasContext: ctx as unknown as CanvasRenderingContext2D,
                viewport,
              }).promise;
            }

            const blob = await offscreen.convertToBlob({ type: "image/jpeg", quality: 0.92 });
            pageUrls.push(URL.createObjectURL(blob));
            pageDimensions.push({ cssWidth, cssHeight });
          }

          doc.destroy();
          window.postMessage({ source: RENDER_RES, id, ok: true, pageUrls, pageDimensions }, "*");
        } catch (err) {
          window.postMessage(
            { source: RENDER_RES, id, ok: false, error: String((err as Error)?.message ?? err) },
            "*",
          );
        }
      })();
      return;
    }

    if (data.source === INDEX_REQ) {
      const { id, pdfUrl, pdfDataBase64 } = data as {
        id: string;
        pdfUrl?: string;
        pdfDataBase64?: string;
      };
      void (async () => {
        try {
          let index: PageReferenceIndex;
          if (__BROWSER__ === "firefox") {
            if (pdfDataBase64) {
              // Use bytes pre-fetched by the content script from background (pdfCapture).
              // Avoids CORS issues: Overleaf CDN URLs can't be XHR'd cross-origin.
              await pagePdfWorkerReady;
              const { getDocument } = await import("pdfjs-dist");
              const bytes = Uint8Array.from(atob(pdfDataBase64), (c) => c.charCodeAt(0));
              const loadTask = getDocument({
                data: bytes,
                disableRange: true,
                disableStream: true,
                isEvalSupported: false,
              });
              const doc = await loadTask.promise;
              index = await buildPageReferenceIndex(doc as unknown as PdfDocumentLike);
              doc.destroy();
            } else if (pdfUrl) {
              // Fallback: try fetching directly from MAIN world (may fail for cross-origin Overleaf).
              await pagePdfWorkerReady;
              const { getDocument } = await import("pdfjs-dist");
              const res = await fetch(pdfUrl, { credentials: "include" });
              if (!res.ok) throw new Error(`PDF fetch failed (HTTP ${res.status})`);
              const bytes = new Uint8Array(await res.arrayBuffer());
              const loadTask = getDocument({
                data: bytes,
                disableRange: true,
                disableStream: true,
                isEvalSupported: false,
              });
              const doc = await loadTask.promise;
              index = await buildPageReferenceIndex(doc as unknown as PdfDocumentLike);
              doc.destroy();
            } else {
              index = await buildPageReferenceIndex();
            }
          } else {
            index = await buildPageReferenceIndex();
          }
          window.postMessage({ source: INDEX_RES, id, ok: true, index }, "*");
        } catch (err) {
          window.postMessage(
            { source: INDEX_RES, id, ok: false, error: String((err as Error)?.message ?? err) },
            "*",
          );
        }
      })();
      return;
    }

    if (data.source !== REQ || typeof data.url !== "string") return;

    const { id, url } = data;
    void (async () => {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) {
          window.postMessage({ source: RES, id, ok: false, error: `HTTP ${res.status}` }, "*");
          return;
        }
        const base64 = bytesToBase64(await res.arrayBuffer());
        window.postMessage({ source: RES, id, ok: true, base64 }, "*");
      } catch (err) {
        window.postMessage(
          { source: RES, id, ok: false, error: String((err as Error)?.message ?? err) },
          "*",
        );
      }
    })();
  });
}
