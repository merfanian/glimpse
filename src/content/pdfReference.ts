// Loads the current document's PDF with pdf.js and extracts the bibliography entry
// that a hovered internal (hyperref) citation link points to.
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { parseReference } from "@shared/refparse";
import type { ParsedReference } from "@shared/types";
import { sendMessage } from "@shared/messages";
import type { FetchPdfRequest, FetchPdfResponse } from "@shared/messages";
import { pdfWorkerReady } from "./pdfWorkerSetup";
import { log, warn } from "@shared/debug";

export interface LinkAnnotationEntry {
  /** 1-based page where the citation link appears. */
  srcPage: number;
  /** Link rectangle in PDF user-space coords [x1, y1, x2, y2]. */
  rect: [number, number, number, number];
  /** The raw PDF destination key (string name or JSON-encoded array). */
  destKey: string;
  /** The reference parsed from the link's destination. */
  reference: ParsedReference;
}

export interface ReferenceIndex {
  doc?: PDFDocumentProxy;
  entries: LinkAnnotationEntry[];
  pageSizes: Map<number, { width: number; height: number }>;
  /** Fast lookup by dest key (the href fragment value pdf.js puts on <a> elements). */
  byDest: Map<string, ParsedReference>;
}

interface SerializedReferenceIndex {
  entries: LinkAnnotationEntry[];
  pageSizes: Array<[number, { width: number; height: number }]>;
  byDest: Array<[string, ParsedReference]>;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function describeError(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

/**
 * Inject the page main-world fetch bridge (pageFetch.ts) as a <script> tag so it runs
 * in the host page's own JS compartment. This avoids Firefox Xray issues and lets the
 * bridge use the page's credentials for cross-site PDFs (e.g. Overleaf compile URLs).
 *
 * Runs once at module load; the bridge has its own guard against double-injection.
 */
const bridgeReady: Promise<void> = (() => {
  // Guard for test / non-extension environments where chrome is not available.
  if (typeof chrome === "undefined" || typeof chrome.runtime?.getURL !== "function") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("pagefetch.js");
    script.onload = () => resolve();
    script.onerror = () => {
      warn("failed to inject page-world bridge");
      resolve(); // don't block; fall back to background fetch
    };
    (document.documentElement ?? document.head ?? document.body).appendChild(script);
  });
})();

/**
 * Fetch a PDF via the page's main-world bridge (see pageFetch.ts). Required for viewers
 * like Overleaf whose PDF lives on a separate registrable domain reachable only from the
 * page's own credentialed JS context.
 */
function pageFetchPdf(url: string, timeoutMs = 15000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const id = `rp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("page-world fetch timed out"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    }

    function onMessage(ev: MessageEvent) {
      // NOTE: Do NOT check ev.source === window here. In Firefox isolated content scripts,
      // `window` is an Xray wrapper while `ev.source` is the raw page window — they are
      // never === even for messages from the same window. Rely on the typed `source` field.
      const d = ev.data as
        | { source?: string; id?: string; ok?: boolean; base64?: string; error?: string }
        | null;
      if (!d || d.source !== "RP_PAGE_FETCH_RES" || d.id !== id) return;
      cleanup();
      if (!d.ok) {
        reject(new Error(d.error ?? "page-world fetch failed"));
        return;
      }
      if (!d.base64) {
        reject(new Error("page-world fetch returned no data"));
        return;
      }
      resolve(base64ToUint8Array(d.base64));
    }

    window.addEventListener("message", onMessage);
    window.postMessage({ source: "RP_PAGE_FETCH_REQ", id, url }, "*");
  });
}

export async function buildReferenceIndexFromPage(
  pdfUrl?: string,
  timeoutMs = 20000,
): Promise<ReferenceIndex> {
  // For Firefox with a URL: pre-fetch bytes via the background (which uses pdfCapture's
  // assembled range chunks). Overleaf CDN URLs can't be XHR'd from MAIN world due to CORS,
  // but the background service worker already has the bytes intercepted from the browser load.
  let pdfDataBase64: string | undefined;
  if (pdfUrl && __BROWSER__ === "firefox" && typeof chrome !== "undefined") {
    try {
      const resp = (await sendMessage<FetchPdfRequest, FetchPdfResponse>({
        type: "fetchPdf",
        url: pdfUrl,
      })) as { ok: boolean; pdf?: { dataBase64: string } };
      if (resp.ok && resp.pdf?.dataBase64) pdfDataBase64 = resp.pdf.dataBase64;
    } catch {
      // Background unavailable or capture not ready; let pageFetch try its own fetch.
    }
  }

  return new Promise((resolve, reject) => {
    const id = `rp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("page-context reference indexing timed out"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    }

    function onMessage(ev: MessageEvent) {
      const d = ev.data as
        | { source?: string; id?: string; ok?: boolean; index?: SerializedReferenceIndex; error?: string }
        | null;
      if (!d || d.source !== "RP_PAGE_INDEX_RES" || d.id !== id) return;
      cleanup();
      if (!d.ok) {
        reject(new Error(d.error ?? "page-context reference indexing failed"));
        return;
      }
      if (!d.index) {
        reject(new Error("page-context reference indexing returned no data"));
        return;
      }
      resolve({
        entries: d.index.entries,
        pageSizes: new Map(d.index.pageSizes),
        byDest: new Map(d.index.byDest),
      });
    }

    window.addEventListener("message", onMessage);
    void bridgeReady.then(() => {
      window.postMessage({ source: "RP_PAGE_INDEX_REQ", id, pdfUrl, pdfDataBase64 }, "*");
    });
  });
}

export interface RenderedPdfPages {
  pageUrls: string[];
  pageDimensions: Array<{ cssWidth: number; cssHeight: number }>;
}

/**
 * Render a PDF's pages in the page's MAIN world (via pageFetch.ts bridge) and return
 * per-page blob URLs + CSS dimensions. Used exclusively by Firefox, where pdf.js rendering
 * in the isolated content-script compartment silently produces blank output due to Xray
 * wrapper restrictions on DOM APIs that pdf.js calls internally.
 */
export function renderPdfPagesInMainWorld(
  bytes: Uint8Array,
  availableWidth: number,
  timeoutMs = 120000,
): Promise<RenderedPdfPages> {
  return new Promise((resolve, reject) => {
    const id = `rp-render-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("PDF rendering timed out"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    }

    function onMessage(ev: MessageEvent) {
      const d = ev.data as {
        source?: string;
        id?: string;
        ok?: boolean;
        pageUrls?: string[];
        pageDimensions?: Array<{ cssWidth: number; cssHeight: number }>;
        error?: string;
      } | null;
      if (!d || d.source !== "RP_PAGE_RENDER_RES" || d.id !== id) return;
      cleanup();
      if (!d.ok) {
        reject(new Error(d.error ?? "PDF rendering failed"));
        return;
      }
      resolve({
        pageUrls: d.pageUrls ?? [],
        pageDimensions: d.pageDimensions ?? [],
      });
    }

    window.addEventListener("message", onMessage);

    // Encode bytes to base64 in chunks to avoid call-stack overflow on large PDFs.
    let base64: string;
    {
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
      }
      base64 = btoa(binary);
    }

    void bridgeReady.then(() => {
      window.postMessage(
        { source: "RP_PAGE_RENDER_REQ", id, pdfDataBase64: base64, availableWidth },
        "*",
      );
    });
  });
}


async function getPdfData(url: string): Promise<Uint8Array> {
  const failures: string[] = [];

  // 1. Direct content-script fetch — works in Chrome/Edge via host permissions.
  try {
    const res = await fetch(url, { credentials: "include" });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    failures.push(`HTTP ${res.status}`);
  } catch (err) {
    failures.push(`direct: ${describeError(err)}`);
  }

  // 2. Page main-world bridge — for cross-site PDFs (e.g. Overleaf signed compile URLs).
  try {
    await bridgeReady;
    return await pageFetchPdf(url);
  } catch (err) {
    failures.push(`bridge: ${describeError(err)}`);
  }

  // 3. Background service worker — for public PDFs on external domains.
  const resp = await sendMessage<FetchPdfRequest, FetchPdfResponse>({ type: "fetchPdf", url });
  if (!resp.ok) {
    throw new Error(`${resp.error}; earlier: ${failures.join("; ")}`);
  }
  if (!resp.pdf.dataBase64) throw new Error("No PDF data returned");
  return base64ToUint8Array(resp.pdf.dataBase64);
}

export async function loadDocument(url: string): Promise<PDFDocumentProxy> {
  await pdfWorkerReady;
  const data = await getPdfData(url);
  const task = pdfjs.getDocument({
    data,
    // Disable range requests and streaming to avoid Firefox extension restrictions
    // on ReadableStream's autoAllocateChunkSize property.
    disableRange: true,
    disableStream: true,
    isEvalSupported: false,
  });
  return task.promise;
}

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

/** Resolve a pdf.js destination array/name to a concrete page index + top coordinate. */
async function resolveDest(
  doc: PDFDocumentProxy,
  dest: unknown,
): Promise<{ pageIndex: number; top: number | null } | null> {
  let explicit: unknown[] | null = null;
  if (typeof dest === "string") {
    explicit = await doc.getDestination(dest);
  } else if (Array.isArray(dest)) {
    explicit = dest;
  }
  if (!explicit || explicit.length === 0) return null;

  const ref = explicit[0];
  let pageIndex: number;
  try {
    pageIndex = await doc.getPageIndex(ref as Parameters<typeof doc.getPageIndex>[0]);
  } catch {
    return null;
  }
  return { pageIndex, top: destTop(explicit) };
}

interface TextItem {
  x: number;
  y: number;
  str: string;
}

/**
 * Extract the bibliography entry text starting at the destination position.
 * Items must be pre-sorted top-to-bottom, left-to-right.
 * Collects lines starting at `top` (or page top when null), stopping at the next
 * reference marker or a large vertical gap.
 */
function extractTextFromItems(items: TextItem[], top: number | null, pageHeight: number): string {
  const startY = top ?? pageHeight;
  const below = items.filter((i) => i.y <= startY + 2);

  // Group into lines by y proximity.
  const lines: TextItem[] = [];
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
  for (const line of lines) {
    const text = line.str.trim();
    if (!text) continue;
    // Stop at the start of the next reference entry (e.g. "[12]", "(12)", "12.").
    if (collected.length > 0 && /^(\[\d+\]|\(\d+\)|\d+\.)\s/.test(text)) break;
    // Stop on an unusually large vertical gap (new block/section).
    if (prevY != null && prevY - line.y > 28 && collected.length > 0) break;
    collected.push(text);
    prevY = line.y;
    if (collected.join(" ").length > 900) break;
  }

  return collected.join(" ").replace(/\s+/g, " ").trim();
}

const CONCURRENCY = 8;

/** Build an index of every internal-link annotation mapped to its destination reference. */
export async function buildReferenceIndex(doc: PDFDocumentProxy): Promise<ReferenceIndex> {
  const pageSizes = new Map<number, { width: number; height: number }>();
  const byDest = new Map<string, ParsedReference>();

  // Phase 1: collect all link annotations across all pages in parallel batches.
  const rawLinks: Array<{
    srcPage: number;
    rect: [number, number, number, number];
    destKey: string;
    dest: unknown;
  }> = [];

  for (let base = 1; base <= doc.numPages; base += CONCURRENCY) {
    const batch = Array.from(
      { length: Math.min(CONCURRENCY, doc.numPages - base + 1) },
      (_, i) => base + i,
    );
    await Promise.all(
      batch.map(async (p) => {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: 1 });
        pageSizes.set(p, { width: viewport.width, height: viewport.height });
        const anns = await page.getAnnotations({ intent: "display" });
        for (const a of anns as Array<Record<string, unknown>>) {
          if (a["subtype"] !== "Link" || !a["dest"] || !Array.isArray(a["rect"])) continue;
          const dest = a["dest"];
          const destKey = typeof dest === "string" ? dest : JSON.stringify(dest);
          rawLinks.push({
            srcPage: p,
            rect: a["rect"] as [number, number, number, number],
            destKey,
            dest,
          });
        }
      }),
    );
  }

  // Phase 2: resolve all unique destinations in parallel batches.
  const uniqueDests = new Map<string, unknown>();
  for (const l of rawLinks) {
    if (!uniqueDests.has(l.destKey)) uniqueDests.set(l.destKey, l.dest);
  }

  const resolvedDests = new Map<string, { pageIndex: number; top: number | null }>();
  const destEntries = [...uniqueDests.entries()];
  for (let base = 0; base < destEntries.length; base += CONCURRENCY) {
    const batch = destEntries.slice(base, base + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ([destKey, dest]) => ({ destKey, r: await resolveDest(doc, dest) })),
    );
    for (const { destKey, r } of results) {
      if (r) resolvedDests.set(destKey, r);
    }
  }

  // Phase 3: fetch text content for all unique reference pages in parallel batches.
  const uniquePageIndices = new Set<number>();
  for (const r of resolvedDests.values()) uniquePageIndices.add(r.pageIndex);

  const textContent = new Map<number, TextItem[]>(); // keyed by 0-based page index
  const pageIndexArr = [...uniquePageIndices];
  for (let base = 0; base < pageIndexArr.length; base += CONCURRENCY) {
    const batch = pageIndexArr.slice(base, base + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (pageIndex) => {
        const page = await doc.getPage(pageIndex + 1);
        const tc = await page.getTextContent();
        const items: TextItem[] = (tc.items as Array<Record<string, unknown>>)
          .filter(
            (it) =>
              typeof it["str"] === "string" &&
              (it["str"] as string).length > 0 &&
              Array.isArray(it["transform"]),
          )
          .map((it) => ({
            x: (it["transform"] as number[])[4],
            y: (it["transform"] as number[])[5],
            str: it["str"] as string,
          }));
        // Sort top-to-bottom (PDF y grows upward), then left-to-right.
        items.sort((a, b) => b.y - a.y || a.x - b.x);
        return { pageIndex, items };
      }),
    );
    for (const { pageIndex, items } of results) {
      textContent.set(pageIndex, items);
    }
  }

  // Phase 4: parse each unique dest → ParsedReference.
  const destCache = new Map<string, ParsedReference>();
  for (const [destKey, r] of resolvedDests) {
    const items = textContent.get(r.pageIndex);
    if (!items) continue;
    const pageH = pageSizes.get(r.pageIndex + 1)?.height ?? 0;
    const raw = extractTextFromItems(items, r.top, pageH);
    if (!raw || raw.length < 8) continue;
    destCache.set(destKey, parseReference(raw));
  }

  // Phase 5: build entries array from cached results.
  const entries: LinkAnnotationEntry[] = [];
  for (const { srcPage, rect, destKey } of rawLinks) {
    const reference = destCache.get(destKey);
    if (!reference) continue;
    entries.push({ srcPage, rect, destKey, reference });
    if (!byDest.has(destKey)) byDest.set(destKey, reference);
  }

  log(
    `buildReferenceIndex: ${entries.length} link(s),`,
    `${uniqueDests.size} unique dest(s),`,
    `${uniquePageIndices.size} ref page(s)`,
  );
  return { doc, entries, pageSizes, byDest };
}

/**
 * Look up the reference for an anchor's href value (e.g. "#cite.author2023").
 * pdf.js renders internal link annotations as <a href="#destName">.
 * We try both the raw fragment and a URI-decoded variant for robustness.
 */
export function findReferenceByHref(
  index: ReferenceIndex,
  href: string,
): ParsedReference | null {
  if (!href || !href.startsWith("#")) return null;
  const raw = href.slice(1);
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  return index.byDest.get(decoded) ?? index.byDest.get(raw) ?? null;
}

/**
 * Find the reference for a hovered point on a given page, expressed in normalized
 * page coordinates (0..1, origin top-left as in the DOM).
 * Used as a fallback when href-based lookup is unavailable.
 */
export function findReferenceAt(
  index: ReferenceIndex,
  srcPage: number,
  normX: number,
  normY: number,
): ParsedReference | null {
  const size = index.pageSizes.get(srcPage);
  if (!size) return null;
  const x = normX * size.width;
  // Convert DOM-top-origin to PDF-bottom-origin.
  const y = (1 - normY) * size.height;

  for (const e of index.entries) {
    if (e.srcPage !== srcPage) continue;
    const [x1, y1, x2, y2] = e.rect;
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);
    if (x >= minX - 2 && x <= maxX + 2 && y >= minY - 2 && y <= maxY + 2) {
      return e.reference;
    }
  }
  return null;
}
