// Detects the host viewer (Overleaf / pdf.js), locates the document PDF, and watches
// for hovers over internal citation links, surfacing a "Show preview" affordance.
import {
  loadDocument,
  buildReferenceIndex,
  buildReferenceIndexFromPage,
  findReferenceAt,
  findReferenceByHref,
  type ReferenceIndex,
} from "./pdfReference";
import type { ParsedReference } from "@shared/types";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { log, warn } from "@shared/debug";
import { isNonBibliographyDestKey } from "@shared/refparse";

export type Environment = "overleaf" | "pdfjs" | null;

export interface DetectorCallbacks {
  showTooltip(anchorRect: DOMRect): void;
  hideTooltip(): void;
  openPanel(ref: ParsedReference): void;
  openError(title: string, detail: string): void;
}

export function detectEnvironment(): Environment {
  const host = location.hostname;
  if (host.endsWith("overleaf.com")) return "overleaf";

  // pdf.js viewer signals: the standard viewer DOM, a .pdf document, or a file= param.
  if (document.querySelector("#viewer.pdfViewer, .pdfViewer, #viewerContainer")) return "pdfjs";
  if (/\.pdf($|[?#])/i.test(location.pathname + location.search)) return "pdfjs";
  if (new URLSearchParams(location.search).has("file")) return "pdfjs";
  return null;
}

/** Best-effort discovery of the URL of the PDF being displayed. */
export function findPdfUrl(env: Environment): string | null {
  // Explicit ?file= param used by the standard pdf.js viewer.
  const fileParam = new URLSearchParams(location.search).get("file");
  if (fileParam) {
    try {
      return new URL(fileParam, location.href).href;
    } catch {
      return fileParam;
    }
  }

  // The document itself is a PDF.
  if (/\.pdf($|[?#])/i.test(location.pathname)) return location.href;

  // Overleaf: the real PDF lives behind a signed build URL. Scrape it from the page.
  if (env === "overleaf") {
    const url = findOverleafPdfUrl();
    if (url) return url;
  }

  // Embedded PDF object/embed/iframe.
  const embed = document.querySelector<HTMLEmbedElement>(
    'embed[type="application/pdf"], object[type="application/pdf"]',
  );
  if (embed) {
    const src = (embed as HTMLEmbedElement).src || embed.getAttribute("data");
    if (src) return src;
  }
  const iframe = document.querySelector<HTMLIFrameElement>('iframe[src*=".pdf"], iframe[src^="blob:"]');
  if (iframe?.src) return iframe.src;

  return null;
}

/** Locate Overleaf's compiled PDF URL (signed build URL) from links/resources on the page. */
function findOverleafPdfUrl(): string | null {
  // The Overleaf PDF viewer pane often embeds the PDF in an iframe whose src IS the signed URL.
  const pdfIframe = document.querySelector<HTMLIFrameElement>(
    'iframe[src*="output.pdf"], iframe[src*="/build/"], iframe[src*=".pdf"]',
  );
  if (pdfIframe?.src) return pdfIframe.src;

  // The "Download PDF" anchor (href may be absolute or relative; .href gives absolute).
  const anchors = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="output.pdf"], a[href*="/build/"], a[data-ol-download-pdf]',
    ),
  );
  for (const a of anchors) {
    if (/output\.pdf/i.test(a.href)) return a.href;
  }

  // Performance resource entries: the PDF is loaded by Overleaf's JS, so it appears here.
  try {
    const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const hit = entries
      .map((e) => e.name)
      .filter((n) => /output\.pdf/i.test(n))
      .pop();
    if (hit) return hit;
  } catch {
    /* ignore */
  }

  // NOTE: intentionally no unsigned-path fallback — it always 404s on current Overleaf.
  return null;
}

interface PageHit {
  pageNumber: number;
  normX: number;
  normY: number;
}

/** Given a hovered element, resolve its pdf.js page number and normalized position. */
function resolvePageHit(target: Element, clientX: number, clientY: number): PageHit | null {
  const pageEl =
    target.closest<HTMLElement>("[data-page-number]") ??
    target.closest<HTMLElement>(".page") ??
    target.closest<HTMLElement>(".pdf-page");
  if (!pageEl) return null;

  let pageNumber = NaN;
  const attr = pageEl.getAttribute("data-page-number");
  if (attr) pageNumber = Number(attr);
  if (!Number.isFinite(pageNumber)) {
    // Overleaf sometimes encodes the page in an id.
    const idMatch = pageEl.id.match(/(\d+)/);
    if (idMatch) pageNumber = Number(idMatch[1]);
  }
  if (!Number.isFinite(pageNumber)) return null;

  const rect = pageEl.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    pageNumber,
    normX: (clientX - rect.left) / rect.width,
    normY: (clientY - rect.top) / rect.height,
  };
}

export class CitationDetector {
  private index: ReferenceIndex | null = null;
  private indexPromise: Promise<ReferenceIndex | null> | null = null;
  private indexError = "";
  private pdfUrl: string | null = null;
  private preloadedDoc: PDFDocumentProxy | null = null;
  private perfObserver: PerformanceObserver | null = null;

  private currentAnchor: HTMLElement | null = null;
  private lastX = 0;
  private lastY = 0;
  /** Timestamp (ms) of the last showTooltip call. Used to debounce anchor switches. */
  private tooltipShownAt = 0;

  constructor(
    private readonly env: Environment,
    private readonly cb: DetectorCallbacks,
  ) {}

  /** Provide an already-loaded PDF document (e.g. from the bundled viewer) to avoid refetching. */
  useDocument(doc: PDFDocumentProxy): void {
    this.preloadedDoc = doc;
  }

  private retryCount = 0;

  /** Reset index state (e.g. when the PDF URL changes after a recompile). */
  private resetIndex(): void {
    this.index = null;
    this.indexPromise = null;
    this.indexError = "";
    this.retryCount = 0;
  }

  start(): void {
    this.pdfUrl = findPdfUrl(this.env);
    log("detector start; env =", this.env, "; initial pdfUrl =", this.pdfUrl);

    // Begin building the index immediately when the URL is already known,
    // so it's ready before the user's first hover.
    if (this.pdfUrl || this.preloadedDoc) {
      void this.ensureIndex();
    }

    // On Overleaf, the signed PDF URL may not be in the DOM yet when the content script
    // starts. Watch for it via PerformanceObserver so we catch it the moment it loads.
    // Also watch for URL changes caused by recompile (new signed URL replaces old one).
    if (this.env === "overleaf") {
      try {
        this.perfObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const name = (entry as PerformanceResourceTiming).name;
            if (!/output\.pdf/i.test(name)) continue;
            if (name === this.pdfUrl) continue; // same URL, nothing to do

            const hadUrl = !!this.pdfUrl;
            this.pdfUrl = name;
            log("PDF URL updated via PerformanceObserver:", name);

            if (!hadUrl) {
              // First URL discovery — start index build.
              // Keep the observer active so we detect future recompiles too.
              void this.ensureIndex();
            } else {
              // URL changed (recompile) — reset index so it rebuilds with the new PDF.
              log("Overleaf recompiled; resetting reference index");
              this.resetIndex();
              void this.ensureIndex();
            }
          }
        });
        this.perfObserver.observe({ entryTypes: ["resource"] });
      } catch {
        /* PerformanceObserver not available */
      }
    }

    document.addEventListener("pointerover", this.handlePointerOver, true);
    document.addEventListener("pointermove", this.handlePointerMove, true);
    document.addEventListener("pointerout", this.handlePointerOut, true);
  }

  stop(): void {
    this.perfObserver?.disconnect();
    this.perfObserver = null;
    document.removeEventListener("pointerover", this.handlePointerOver, true);
    document.removeEventListener("pointermove", this.handlePointerMove, true);
    document.removeEventListener("pointerout", this.handlePointerOut, true);
  }

  private async ensureIndex(): Promise<ReferenceIndex | null> {
    if (this.index) return this.index;
    if (this.indexPromise) return this.indexPromise;

    if (this.preloadedDoc) {
      log("building reference index from preloaded document");
      this.indexPromise = (async () => {
        try {
          const idx = await buildReferenceIndex(this.preloadedDoc!);
          this.index = idx;
          if (idx.entries.length === 0) {
            this.indexError = "This PDF has no internal citation links (hyperref) to follow.";
          }
          return idx;
        } catch (err) {
          this.indexError = `Failed to read the PDF: ${String((err as Error)?.message ?? err)}`;
          warn(this.indexError, err);
          this.indexPromise = null; // allow retry
          return null;
        }
      })();
      return this.indexPromise;
    }

    this.indexPromise = (async () => {
      // Build the index via the page MAIN-world bridge.
      // Chrome: page-context scan only (reuses the already-loaded pdf.js document in page/iframe).
      // Firefox: race the page-context scan against the background-capture (pdfCapture) path
      //   in parallel. Whichever resolves first wins. This avoids the old sequential wait of
      //   up to 0.8s (page scan poll) + 8s (capture wait) — if the iframe PDF is already
      //   loaded the page-scan wins instantly; if the capture is ready, it wins instead.
      if (!this.pdfUrl) this.pdfUrl = findPdfUrl(this.env);
      {
        const pagePaths: Promise<ReferenceIndex>[] = [buildReferenceIndexFromPage()];
        if (__BROWSER__ === "firefox" && this.pdfUrl) {
          pagePaths.push(buildReferenceIndexFromPage(this.pdfUrl));
        }
        try {
          log("building reference index via page MAIN-world bridge");
          const idx = await Promise.any(pagePaths);
          this.index = idx;
          if (idx.entries.length === 0) {
            this.indexError = "This PDF has no internal citation links (hyperref) to follow.";
          }
          this.retryCount = 0;
          return idx;
        } catch (err) {
          warn("page-context reference indexing failed; trying direct document load", err);
        }
      }

      if (!this.pdfUrl) {
        this.indexError = "Could not locate the PDF file for this page.";
        warn(this.indexError);
        this.indexPromise = null; // allow retry once URL is discovered
        return null;
      }

      log("building reference index from", this.pdfUrl);
      try {
        const doc = await loadDocument(this.pdfUrl);
        const idx = await buildReferenceIndex(doc);
        this.index = idx;
        if (idx.entries.length === 0) {
          this.indexError = "This PDF has no internal citation links (hyperref) to follow.";
        }
        this.retryCount = 0;
        return idx;
      } catch (err) {
        this.indexError = `Failed to read the PDF: ${String((err as Error)?.message ?? err)}`;
        warn(this.indexError, err);
        this.indexPromise = null; // clear so a retry is possible (e.g. URL may have changed)
        // On Overleaf, transient failures (e.g. signed URL expired after recompile)
        // resolve on retry — schedule a few automatic retries with backoff.
        if (this.env === "overleaf" && this.retryCount < 5) {
          this.retryCount++;
          const delay = Math.min(2000 * this.retryCount, 8000);
          log(`Scheduling retry ${this.retryCount} in ${delay}ms`);
          setTimeout(() => { void this.ensureIndex(); }, delay);
        }
        return null;
      }
    })();
    return this.indexPromise;
  }

  /** Return the anchor element if it looks like an internal citation link, else null. */
  private citationAnchor(el: Element): HTMLElement | null {
    const a = el.closest<HTMLElement>("a");
    if (!a) return null;
    const inAnnotationLayer = !!a.closest(".annotationLayer, .linkAnnotation");
    const href = a.getAttribute("href") ?? "";
    const internal = href.startsWith("#") || href === "";
    const inViewer = !!a.closest(
      ".pdfViewer, .pdfjs-viewer, #viewerContainer, [data-page-number], .page, .pdf-page",
    );
    if (inAnnotationLayer) return a;
    if (inViewer && internal) return a;
    return null;
  }

  private handlePointerMove = (e: Event): void => {
    const me = e as PointerEvent;
    this.lastX = me.clientX;
    this.lastY = me.clientY;
  };

  /**
   * Returns true if the given anchor resolves to a known bibliography entry in the
   * current index, using the same href + coordinate fallback as previewCurrent().
   * When the index isn't ready yet, returns true (optimistic — we don't filter yet),
   * UNLESS the href can be immediately identified as a non-bibliography destination
   * from its dest-key prefix alone (section.*, figure.*, table.*, …).
   */
  private isKnownReference(anchor: HTMLElement, clientX: number, clientY: number): boolean {
    const href = anchor.getAttribute("href") ?? "";

    // Fast pre-filter: reject links whose href fragment is a hyperref-style
    // non-bibliography destination key (section.N, figure.N, table.N, …).
    // This works without the index being ready and catches the most common cases.
    if (href.startsWith("#")) {
      const fragment = (() => {
        try {
          return decodeURIComponent(href.slice(1));
        } catch {
          return href.slice(1);
        }
      })();
      if (isNonBibliographyDestKey(fragment)) return false;
    }

    if (!this.index) return true; // index still building — allow remaining links
    if (findReferenceByHref(this.index, href)) return true;
    const hit = resolvePageHit(anchor, clientX, clientY);
    if (hit && findReferenceAt(this.index, hit.pageNumber, hit.normX, hit.normY)) return true;
    return false;
  }

  private handlePointerOver = (e: Event): void => {
    const target = e.target as Element | null;
    if (!target) return;
    const anchor = this.citationAnchor(target);
    if (!anchor) return;

    const me = e as PointerEvent;
    this.lastX = me.clientX;
    this.lastY = me.clientY;

    if (!this.isKnownReference(anchor, me.clientX, me.clientY)) return;

    // If the tooltip was shown recently for a DIFFERENT anchor, ignore this event.
    // The user is likely moving their cursor toward the already-visible tooltip
    // and is inadvertently crossing an adjacent reference link. Switching the
    // tooltip immediately in that window would cause it to jump unpredictably.
    const SWITCH_LOCK_MS = 500;
    if (anchor !== this.currentAnchor && Date.now() - this.tooltipShownAt < SWITCH_LOCK_MS) {
      return;
    }

    this.currentAnchor = anchor;
    this.tooltipShownAt = Date.now();
    this.cb.showTooltip(anchor.getBoundingClientRect());
  };

  private handlePointerOut = (e: Event): void => {
    const target = e.target as Element | null;
    if (target && this.citationAnchor(target) === this.currentAnchor) {
      // Only schedule hide (and reset tracking) when leaving the anchor that owns
      // the current tooltip, not every anchor in the document.
      this.currentAnchor = null;
      this.cb.hideTooltip();
    }
  };

  /** Invoked when the user clicks the "Show preview" tooltip. */
  async previewCurrent(): Promise<void> {
    const anchor = this.currentAnchor;
    if (!anchor) return;

    const index = await this.ensureIndex();
    if (!index) {
      this.cb.openError("Can't preview this citation", this.indexError || "Unknown error.");
      return;
    }

    // Primary: resolve by the anchor's href fragment (most reliable — not sensitive to
    // cursor position at the time the user clicks the tooltip).
    const href = anchor.getAttribute("href") ?? "";
    let ref = findReferenceByHref(index, href);

    // Fallback: coordinate-based lookup (in case href is empty or unmatched).
    if (!ref) {
      const hit = resolvePageHit(anchor, this.lastX, this.lastY);
      if (hit) ref = findReferenceAt(index, hit.pageNumber, hit.normX, hit.normY);
    }

    if (!ref) {
      log("no ref found; href =", href, "; byDest keys sample:", [...index.byDest.keys()].slice(0, 5));
      this.cb.openError(
        "No reference found",
        "This link doesn't point to a bibliography entry, or it couldn't be read.",
      );
      return;
    }

    log("resolved reference:", ref);
    this.cb.openPanel(ref);
  }
}
