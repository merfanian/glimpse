// Cross-browser pdf.js worker configuration.
//
// Chrome/Edge: load the bundled worker file as a real Web Worker (fast, off-thread).
//
// Firefox: a real Worker spawned from a content script runs in a separate compartment.
// pdf.js's MessageHandler streams data between threads using `ReadableStream`, and Firefox's
// Xray security wrappers deny access to cross-compartment stream internals (the
// "Permission denied to access property autoAllocateChunkSize" error). To avoid this we run
// pdf.js entirely on the main thread by registering the worker's message handler on
// `globalThis.pdfjsWorker`; pdf.js then uses an in-process LoopbackPort (single compartment),
// which sidesteps the Xray restriction completely.

import * as pdfjs from "pdfjs-dist";

export const pdfWorkerReady: Promise<void> = (() => {
  if (__BROWSER__ === "firefox") {
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
