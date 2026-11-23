// Loads the current document's PDF with pdf.js and extracts the bibliography entry
// that a hovered internal (hyperref) citation link points to. Also hosts the client side
// of the page main-world bridge (pageFetch.ts).
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { parseReference, isBibliographyEntry } from "@shared/refparse";
import type { ParsedReference } from "@shared/types";
import { sendMessage } from "@shared/messages";
import type { FetchPdfRequest, FetchPdfResponse } from "@shared/messages";
import { pdfWorkerReady } from "./pdfWorkerSetup";
import { destLeft, destTop, extractTextFromItems, type TextItem } from "@shared/bibExtract";

export { destTop, extractTextFromItems } from "@shared/bibExtract";
import { log } from "@shared/debug";

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

export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

function describeError(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

// ── Page main-world bridge ──────────────────────────────────────────────────
// pageFetch.ts runs in the host page's own JS context. It is injected lazily, only once
// something actually needs it — never on pages that merely load the content script.

let bridgePromise: Promise<void> | null = null;

export function ensureBridge(): Promise<void> {
  if (bridgePromise) return bridgePromise;
  if (typeof chrome === "undefined" || typeof chrome.runtime?.getURL !== "function") {
    return (bridgePromise = Promise.resolve());
  }
  bridgePromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("pagefetch.js");
    script.onload = () => {
      script.remove();
      resolve();
    };
    script.onerror = () => {
      script.remove();
      bridgePromise = null;
      reject(new Error("The page blocked Glimpse's helper script"));
    };
    (document.head ?? document.documentElement).appendChild(script);
  });
  return bridgePromise;
}

let callSeq = 0;

/**
 * Request/response with the main-world bridge over window.postMessage. Payloads are
 * plain data only (binary as base64) so nothing crosses Firefox's Xray boundary.
 *
 * NOTE: Don't check ev.source === window: in Firefox content scripts `window` is an Xray
 * wrapper and is never === the event's source. The typed `source` + random id suffice.
 */
export async function bridgeCall<T extends object>(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  await ensureBridge();
  return new Promise<T>((resolve, reject) => {
    const id = `glimpse-${++callSeq}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${type.toLowerCase()} timed out`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    }
    function onMessage(ev: MessageEvent) {
      const d = ev.data as ({ source?: string; id?: string; ok?: boolean; error?: string } & T) | null;
      if (!d || d.source !== `${type}_RES` || d.id !== id) return;
      cleanup();
      if (!d.ok) reject(new Error(d.error ?? `${type} failed`));
      else resolve(d);
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: `${type}_REQ`, id, ...payload }, "*");
  });
}

/**
 * Build the reference index inside the page's main world, reusing the page's already
 * loaded pdf.js document when there is one. On Firefox, `pdfUrl` makes the bridge load
 * the PDF itself (bytes pre-fetched by the background, e.g. from Overleaf capture).
 */
export async function buildReferenceIndexFromPage(
  pdfUrl?: string,
  timeoutMs = 20000,
): Promise<ReferenceIndex> {
  let pdfDataBase64: string | undefined;
  if (pdfUrl && __BROWSER__ === "firefox") {
    const resp = await sendMessage<FetchPdfRequest, FetchPdfResponse>({ type: "fetchPdf", urls: [pdfUrl] });
    if (resp.ok && resp.pdf.dataBase64) pdfDataBase64 = resp.pdf.dataBase64;
  }
  const d = await bridgeCall<{ index?: SerializedReferenceIndex }>(
    "RP_PAGE_INDEX",
    { pdfUrl, pdfDataBase64 },
    timeoutMs,
  );
  if (!d.index) throw new Error("page-context reference indexing returned no data");
  return {
    entries: d.index.entries,
    pageSizes: new Map(d.index.pageSizes),
    byDest: new Map(d.index.byDest),
  };
}

// ── Main-world PDF rendering (Firefox content scripts) ──────────────────────
// pdf.js rendering in Firefox's isolated content-script compartment silently produces
// blank output (Xray wrappers break font loading / canvas internals), so the preview's
// pages are rendered in the page's main world, one page at a time, as image blob URLs.

export interface MainWorldDoc {
  docId: string;
  sizes: Array<{ width: number; height: number }>;
}

export async function mainWorldOpen(bytes: Uint8Array): Promise<MainWorldDoc> {
  const d = await bridgeCall<{ docId?: string; sizes?: MainWorldDoc["sizes"] }>(
    "RP_PAGE_OPEN",
    { pdfDataBase64: uint8ArrayToBase64(bytes) },
    60000,
  );
  if (!d.docId || !d.sizes) throw new Error("PDF could not be opened");
  return { docId: d.docId, sizes: d.sizes };
}

export async function mainWorldRender(
  docId: string,
  pageNumber: number,
  cssWidth: number,
  dpr: number,
): Promise<string> {
  const d = await bridgeCall<{ url?: string }>(
    "RP_PAGE_RENDER",
    { docId, pageNumber, cssWidth, dpr },
    30000,
  );
  if (!d.url) throw new Error("page render returned nothing");
  return d.url;
}

export function mainWorldClose(docId: string): void {
  void bridgeCall("RP_PAGE_CLOSE", { docId }, 5000).catch(() => undefined);
}

// ── Loading the document PDF in the content script ─────────────────────────

async function getPdfData(url: string): Promise<Uint8Array> {
  const failures: string[] = [];

  // 1. Direct content-script fetch — works in Chrome/Edge via host permissions.
  try {
    const res = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(30000) });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    failures.push(`HTTP ${res.status}`);
  } catch (err) {
    failures.push(`direct: ${describeError(err)}`);
  }

  // 2. Page main-world bridge — for cross-site PDFs (e.g. Overleaf signed compile URLs).
  try {
    const d = await bridgeCall<{ base64?: string }>("RP_PAGE_FETCH", { url }, 30000);
    if (d.base64) return base64ToUint8Array(d.base64);
    failures.push("bridge: no data");
  } catch (err) {
    failures.push(`bridge: ${describeError(err)}`);
  }

  // 3. Background worker — for public PDFs on external domains.
  const resp = await sendMessage<FetchPdfRequest, FetchPdfResponse>({ type: "fetchPdf", urls: [url] });
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

/** Resolve a pdf.js destination array/name to a concrete page index + top + left coordinates. */
async function resolveDest(
  doc: PDFDocumentProxy,
  dest: unknown,
): Promise<{ pageIndex: number; top: number | null; left: number | null } | null> {
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
  return { pageIndex, top: destTop(explicit), left: destLeft(explicit) };
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

  const resolvedDests = new Map<string, { pageIndex: number; top: number | null; left: number | null }>();
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
            w: typeof it["width"] === "number" ? (it["width"] as number) : undefined,
            str: it["str"] as string,
          }));
        // Sort top-to-bottom (PDF y grows upward); within-line X ordering is handled
        // inside extractTextFromItems after column filtering.
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
    const size = pageSizes.get(r.pageIndex + 1);
    const raw = extractTextFromItems(items, r.top, size?.height ?? 0, r.left, size?.width ?? 0);
    if (!raw || raw.length < 8) continue;
    const ref = parseReference(raw);
    if (!isBibliographyEntry(destKey, ref)) continue;
    destCache.set(destKey, ref);
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
  const candidates = [raw];
  // pdf.js builds these hrefs with the legacy escape(), not encodeURIComponent, so
  // non-ASCII dest names ("cite.M%FCller") must be unescape()d; try both decoders.
  try {
    candidates.push(decodeURIComponent(raw));
  } catch {
    /* not valid UTF-8 percent-encoding */
  }
  try {
    candidates.push(unescape(raw));
  } catch {
    /* ignore */
  }
  for (const key of candidates) {
    const hit = index.byDest.get(key);
    if (hit) return hit;
  }
  return null;
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
