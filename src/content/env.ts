// Environment detection. Dependency-free: imported by the tiny loader content script
// that runs on every page, so it must stay small.

export type Environment = "overleaf" | "pdfjs" | null;

/** Shared state between the loader and the full content script (same isolated world). */
export interface GlimpseGlobal {
  /** Loader already asked the background to inject the full script. */
  activated?: boolean;
  /** Full content script has started. */
  started?: boolean;
  env?: Environment;
  /** Citation link the user was hovering when lazy activation kicked in. */
  pendingTarget?: Element | null;
}

export function glimpseGlobal(): GlimpseGlobal {
  const g = globalThis as { __glimpse?: GlimpseGlobal };
  return (g.__glimpse ??= {});
}

export function isOverleafHost(host = location.hostname): boolean {
  return host === "overleaf.com" || host.endsWith(".overleaf.com");
}

/** True for the browser's built-in PDF viewer document, which extensions can't script. */
export function isNativePdfDocument(): boolean {
  return document.contentType === "application/pdf";
}

const PDFJS_DOM = "#viewer.pdfViewer, .pdfViewer, #viewerContainer";
/** A citation link rendered by pdf.js's annotation layer. */
export const ANNOTATION_LINK = ".annotationLayer a, .linkAnnotation a";

export function detectEnvironment(): Environment {
  if (isNativePdfDocument()) return null;
  if (isOverleafHost()) {
    // Only project editors / read-only shares contain a PDF preview.
    return /^\/(project|read)\//.test(location.pathname) ? "overleaf" : null;
  }
  if (document.querySelector(PDFJS_DOM)) return "pdfjs";
  return null;
}
