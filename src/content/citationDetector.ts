// Watches for hovers over internal citation links in a pdf.js-based viewer (Overleaf,
// generic pdf.js pages, the bundled viewer), surfaces a "Preview" affordance, and resolves
// the hovered link to its bibliography entry.
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
import type { Environment } from "./env";

export type { Environment } from "./env";

export interface DetectorCallbacks {
  showTooltip(anchorRect: DOMRect): void;
  /** Hide after a grace period (the user may be moving onto the tooltip). */
  hideTooltip(): void;
  /** Hide right away (scroll, Escape, …) unless the pointer is on the tooltip. */
  hideTooltipNow(): void;
  tooltipVisible(): boolean;
  openLoading(): void;
  openPanel(ref: ParsedReference): void;
  openError(title: string, detail: string): void;
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

  // Last resort: a PDF the page itself downloaded (self-hosted Overleaf, custom viewers).
  try {
    const hit = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .map((e) => e.name)
      .filter((n) => /\.pdf($|[?#])/i.test(n))
      .pop();
    if (hit) return hit;
  } catch {
    /* ignore */
  }
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

/** Page hit at the centre of the link (independent of where the pointer is now). */
function anchorPageHit(anchor: HTMLElement): PageHit | null {
  const r = anchor.getBoundingClientRect();
  return resolvePageHit(anchor, r.left + r.width / 2, r.top + r.height / 2);
}

export class CitationDetector {
  private index: ReferenceIndex | null = null;
  private indexPromise: Promise<ReferenceIndex | null> | null = null;
  private indexError = "";
  private pdfUrl: string | null = null;
  private preloadedDoc: PDFDocumentProxy | null = null;
  private perfObserver: PerformanceObserver | null = null;

  /** Anchor the visible tooltip belongs to (what "Preview" will open). */
  private currentAnchor: HTMLElement | null = null;
  /** Anchor under the pointer, waiting for the hover-intent delay. */
  private pendingAnchor: HTMLElement | null = null;
  private pendingTimer: number | null = null;

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
    document.addEventListener("pointerout", this.handlePointerOut, true);
    // The tooltip is positioned in viewport coordinates; any scroll makes it stale.
    document.addEventListener("scroll", this.handleScroll, { capture: true, passive: true });
    window.addEventListener("blur", this.handleScroll);
  }

  stop(): void {
    this.perfObserver?.disconnect();
    this.perfObserver = null;
    this.cancelPending();
    document.removeEventListener("pointerover", this.handlePointerOver, true);
    document.removeEventListener("pointerout", this.handlePointerOut, true);
    document.removeEventListener("scroll", this.handleScroll, true);
    window.removeEventListener("blur", this.handleScroll);
  }

  /** Treat `el` as hovered right now (used when lazy activation was triggered by a hover). */
  primeHover(el: Element): void {
    const anchor = this.citationAnchor(el);
    if (anchor && anchor.isConnected && anchor.matches(":hover")) this.considerAnchor(anchor, 0);
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

  /**
   * Returns true if the given anchor resolves to a known bibliography entry in the
   * current index, using the same href + coordinate fallback as previewCurrent().
   * When the index isn't ready yet, returns true (optimistic — we don't filter yet),
   * UNLESS the href can be immediately identified as a non-bibliography destination
   * from its dest-key prefix alone (section.*, figure.*, table.*, …).
   */
  private isKnownReference(anchor: HTMLElement): boolean {
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
    const hit = anchorPageHit(anchor);
    if (hit && findReferenceAt(this.index, hit.pageNumber, hit.normX, hit.normY)) return true;
    return false;
  }

  private cancelPending(): void {
    if (this.pendingTimer != null) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingAnchor = null;
  }

  /**
   * Hover intent: show the tooltip for `anchor` after a short delay, so sweeping the
   * pointer across text doesn't flash it, and so crossing a neighbouring citation on the
   * way to an already-visible tooltip doesn't steal it. Unlike a hard time lock, a
   * deliberate hover over a different citation (e.g. the "2" in "[1, 2]") always wins.
   */
  private considerAnchor(anchor: HTMLElement, delay?: number): void {
    if (!this.isKnownReference(anchor)) return;
    if (anchor === this.currentAnchor && this.cb.tooltipVisible()) {
      this.cancelPending();
      this.cb.showTooltip(anchor.getBoundingClientRect()); // keeps it open, re-anchors
      return;
    }
    if (anchor === this.pendingAnchor) return;
    this.cancelPending();
    this.pendingAnchor = anchor;
    const wait = delay ?? (this.cb.tooltipVisible() ? 260 : 90);
    this.pendingTimer = window.setTimeout(() => {
      this.pendingTimer = null;
      if (this.pendingAnchor !== anchor || !anchor.isConnected) return;
      this.pendingAnchor = null;
      this.currentAnchor = anchor;
      this.cb.showTooltip(anchor.getBoundingClientRect());
    }, wait);
  }

  private handlePointerOver = (e: Event): void => {
    const target = e.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const anchor = this.citationAnchor(target);
    if (!anchor) return;
    this.considerAnchor(anchor);
  };

  private handlePointerOut = (e: Event): void => {
    const target = e.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const anchor = this.citationAnchor(target);
    if (!anchor) return;
    const related = (e as PointerEvent).relatedTarget as Node | null;
    if (related && anchor.contains(related)) return; // moving within the link
    if (anchor === this.pendingAnchor) this.cancelPending();
    if (anchor === this.currentAnchor) this.cb.hideTooltip();
  };

  private handleScroll = (): void => {
    this.cancelPending();
    if (this.cb.tooltipVisible()) this.cb.hideTooltipNow();
  };

  /** Invoked when the user activates the "Preview" tooltip. */
  async previewCurrent(): Promise<void> {
    const anchor = this.currentAnchor;
    if (!anchor) return;

    // Building the index can take a few seconds on first use; show progress right away.
    let index = this.index;
    if (!index) {
      this.cb.openLoading();
      index = await this.ensureIndex();
    }
    if (!index) {
      this.cb.openError(
        "Couldn't read this PDF's bibliography",
        this.indexError || "The PDF could not be loaded. Try again in a moment.",
      );
      return;
    }

    // Primary: resolve by the anchor's href fragment (most reliable — not sensitive to
    // cursor position at the time the user clicks the tooltip).
    const href = anchor.getAttribute("href") ?? "";
    let ref = findReferenceByHref(index, href);

    // Fallback: coordinate-based lookup (in case href is empty or unmatched).
    if (!ref) {
      const hit = anchorPageHit(anchor);
      if (hit) ref = findReferenceAt(index, hit.pageNumber, hit.normX, hit.normY);
    }

    if (!ref) {
      log("no ref found; href =", href, "; byDest keys sample:", [...index.byDest.keys()].slice(0, 5));
      this.cb.openError(
        "This link isn't a bibliography reference",
        "It points somewhere else in the document (a section, figure or equation), or its " +
          "bibliography entry couldn't be read from the PDF.",
      );
      return;
    }

    log("resolved reference:", ref);
    this.cb.openPanel(ref);
  }
}
