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
import { destLeft, destTop, extractTextFromItems, type TextItem } from "@shared/bibExtract";
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
  getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number }> }>;
  getAnnotations(opts: { intent: "display" }): Promise<
    Array<{ subtype?: string; dest?: unknown; rect?: unknown }>
  >;
}

// Guard: if injected twice (e.g. via both manifest and dynamic injection), only run once.
interface BridgedWindow extends Window { __rpBridgeActive?: boolean; }
if (!(window as BridgedWindow).__rpBridgeActive) {
  (window as BridgedWindow).__rpBridgeActive = true;

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
    const items: TextItem[] = [];
    for (const it of content.items) {
      if (typeof it.str !== "string" || it.str.length === 0 || !Array.isArray(it.transform)) continue;
      items.push({ x: it.transform[4], y: it.transform[5], w: typeof it.width === "number" ? it.width : undefined, str: it.str });
    }
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    return extractTextFromItems(items, top, viewport.height, left, viewport.width);
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

  // ── Request handling ─────────────────────────────────────────────────────
  // Every request is { source: "<TYPE>_REQ", id, ...payload } and is answered with
  // { source: "<TYPE>_RES", id, ok, ...result | error }.

  type Payload = Record<string, unknown> & { id: string };

  function reply(type: string, id: string, result: Record<string, unknown>): void {
    window.postMessage({ source: `${type}_RES`, id, ok: true, ...result }, "*");
  }
  function fail(type: string, id: string, err: unknown): void {
    window.postMessage(
      { source: `${type}_RES`, id, ok: false, error: String((err as Error)?.message ?? err) },
      "*",
    );
  }

  // Firefox-only: pdf.js is bundled into this script only for Firefox (the literal
  // __BROWSER__ check lets esbuild drop it from Chrome/Edge builds).
  async function openPdfBytes(pdfDataBase64: string): Promise<import("pdfjs-dist").PDFDocumentProxy> {
    if (__BROWSER__ === "firefox") {
      await pagePdfWorkerReady;
      const { getDocument } = await import("pdfjs-dist");
      const bytes = Uint8Array.from(atob(pdfDataBase64), (c) => c.charCodeAt(0));
      return getDocument({ data: bytes, disableRange: true, disableStream: true, isEvalSupported: false })
        .promise;
    }
    throw new Error("unsupported in this browser");
  }

  // Firefox-only document handles for the preview panel's page-by-page rendering.
  type OpenDoc = {
    doc: import("pdfjs-dist").PDFDocumentProxy;
    urls: Map<number, string>;
  };
  const openDocs = new Map<string, OpenDoc>();
  let docSeq = 0;

  const handlers: Record<string, (p: Payload) => Promise<Record<string, unknown>>> = {
    async RP_PAGE_FETCH(p) {
      const res = await fetch(String(p.url), { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { base64: bytesToBase64(await res.arrayBuffer()) };
    },

    async RP_PAGE_INDEX(p) {
      const pdfDataBase64 = p.pdfDataBase64 as string | undefined;
      const pdfUrl = p.pdfUrl as string | undefined;
      if (__BROWSER__ === "firefox" && (pdfDataBase64 || pdfUrl)) {
        let b64 = pdfDataBase64;
        if (!b64 && pdfUrl) {
          // Fallback: fetch from the page context (may fail cross-origin on Overleaf).
          const res = await fetch(pdfUrl, { credentials: "include" });
          if (!res.ok) throw new Error(`PDF fetch failed (HTTP ${res.status})`);
          b64 = bytesToBase64(await res.arrayBuffer());
        }
        const doc = await openPdfBytes(b64!);
        try {
          return { index: await buildPageReferenceIndex(doc as unknown as PdfDocumentLike) };
        } finally {
          void doc.destroy();
        }
      }
      return { index: await buildPageReferenceIndex() };
    },
  };

  if (__BROWSER__ === "firefox") {
    handlers.RP_PAGE_OPEN = async (p) => {
      const doc = await openPdfBytes(String(p.pdfDataBase64));
      const sizes: Array<{ width: number; height: number }> = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
        sizes.push({ width: vp.width, height: vp.height });
      }
      const docId = `d${++docSeq}`;
      openDocs.set(docId, { doc, urls: new Map() });
      return { docId, sizes };
    };

    handlers.RP_PAGE_RENDER = async (p) => {
      const entry = openDocs.get(String(p.docId));
      if (!entry) throw new Error("document closed");
      const pageNumber = Number(p.pageNumber);
      const dpr = Math.min(Math.max(Number(p.dpr) || 1, 1), 3);
      const page = await entry.doc.getPage(pageNumber);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (Number(p.cssWidth) / natural.width) * dpr });
      const w = Math.max(1, Math.floor(viewport.width));
      const h = Math.max(1, Math.floor(viewport.height));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, w, h);
      await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
      page.cleanup();
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      const url = URL.createObjectURL(blob);
      // The panel swaps the <img> to the new URL immediately; revoke the old one later.
      const old = entry.urls.get(pageNumber);
      if (old) setTimeout(() => URL.revokeObjectURL(old), 5000);
      entry.urls.set(pageNumber, url);
      return { url };
    };

    handlers.RP_PAGE_CLOSE = async (p) => {
      const entry = openDocs.get(String(p.docId));
      if (entry) {
        openDocs.delete(String(p.docId));
        const urls = [...entry.urls.values()];
        setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 1000);
        void entry.doc.destroy();
      }
      return {};
    };
  }

  window.addEventListener("message", (ev: MessageEvent) => {
    // In the MAIN world, ev.source === window is a reliable identity check.
    if (ev.source !== window) return;
    const data = ev.data as Payload & { source?: unknown } | null;
    if (!data || typeof data.id !== "string" || typeof data.source !== "string") return;
    if (!data.source.endsWith("_REQ")) return;
    const type = data.source.slice(0, -4);
    const handler = handlers[type];
    if (!handler) return;
    handler(data).then(
      (result) => reply(type, data.id, result),
      (err) => fail(type, data.id, err),
    );
  });
}
