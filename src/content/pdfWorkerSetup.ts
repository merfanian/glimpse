// Cross-browser pdf.js worker configuration.
//
// Extension pages (bundled viewer) and Chrome/Edge content scripts: load the bundled
// worker file as a real Web Worker (fast, off the main thread).
//
// Firefox *content scripts*: a Worker spawned from a content script runs in a separate
// compartment, and Firefox's Xray wrappers deny pdf.js access to cross-compartment
// ReadableStream internals ("Permission denied to access property autoAllocateChunkSize").
// There, rendering is delegated to the page's main world (see pageFetch.ts), and any
// pdf.js use left in the content script runs single-threaded via `globalThis.pdfjsWorker`.

import * as pdfjs from "pdfjs-dist";

/** Running inside one of our own extension pages (viewer, popup, options). */
export const IN_EXTENSION_PAGE =
  typeof location !== "undefined" && /^(chrome|moz)-extension:$/.test(location.protocol);

/** Firefox content scripts must do pdf.js rendering in the page's main world. */
export const USE_MAIN_WORLD = __BROWSER__ === "firefox" && !IN_EXTENSION_PAGE;

export const pdfWorkerReady: Promise<void> = (() => {
  // Spelled out (not USE_MAIN_WORLD) so esbuild drops the 1.3 MB worker from Chrome builds.
  if (__BROWSER__ === "firefox" && !IN_EXTENSION_PAGE) {
    return import("pdfjs-dist/build/pdf.worker.mjs").then((worker) => {
      (globalThis as Record<string, unknown>).pdfjsWorker = {
        WorkerMessageHandler: (worker as { WorkerMessageHandler: unknown }).WorkerMessageHandler,
      };
    });
  }
  // Guard for test environments where chrome is not available.
  if (typeof chrome !== "undefined" && typeof chrome.runtime?.getURL === "function") {
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.js");
  }
  return Promise.resolve();
})();
