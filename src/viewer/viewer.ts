// Bundled PDF viewer built from pdf.js viewer components. Renders the text + annotation
// (link) layers so the standard citation-detection logic works on local/remote PDFs.
import * as pdfjs from "pdfjs-dist";
import { EventBus, PDFViewer, PDFLinkService } from "pdfjs-dist/web/pdf_viewer.mjs";
import { startDetection } from "../content/start";
import { log, errorLog } from "@shared/debug";

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.js");

function getFileParam(): string | null {
  const raw = new URLSearchParams(location.search).get("file");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function setStatus(msg: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
}

// Zoom step used for +/- buttons (25% increments matching browser behaviour)
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

function nextZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    return ZOOM_STEPS.find((s) => s > current + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  } else {
    return [...ZOOM_STEPS].reverse().find((s) => s < current - 0.01) ?? ZOOM_STEPS[0];
  }
}

function formatZoomLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

async function main(): Promise<void> {
  const isPanelMode = new URLSearchParams(location.search).get("mode") === "panel";

  const container = document.getElementById("viewerContainer") as HTMLDivElement;
  const viewerEl = document.getElementById("viewer") as HTMLDivElement;

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const pdfViewer = new PDFViewer({
    container,
    viewer: viewerEl,
    eventBus,
    linkService,
  });
  linkService.setViewer(pdfViewer);

  eventBus.on("pagesinit", () => {
    pdfViewer.currentScaleValue = "page-width";
  });

  // Panel/embedded mode: receive PDF data and fit-width commands via postMessage.
  if (isPanelMode) {
    document.body.classList.add("rp-panel-mode");
    setStatus("Loading…");

    window.addEventListener("message", (e) => {
      if (e.data?.type === "loadPdf") {
        setStatus("Rendering…");
        try {
          const binary = atob(e.data.base64 as string);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          pdfjs
            .getDocument({ data: bytes, disableRange: true, disableStream: true })
            .promise.then((doc) => {
              pdfViewer.setDocument(doc);
              linkService.setDocument(doc, null);
              setStatus(`${doc.numPages} page${doc.numPages === 1 ? "" : "s"}`);
            })
            .catch((err: unknown) => {
              setStatus(`Error: ${(err as Error).message ?? String(err)}`);
            });
        } catch (err) {
          setStatus(`Decode error: ${(err as Error).message ?? String(err)}`);
        }
      } else if (e.data?.type === "fitWidth") {
        pdfViewer.currentScaleValue = "page-width";
      }
    });
    return;
  }

  // ── Full viewer mode ──
  const fileUrl = getFileParam();
  const titleEl = document.getElementById("doc-title");

  if (!fileUrl) {
    setStatus("No PDF specified. Open a PDF via the Glimpse toolbar button.");
    return;
  }
  if (titleEl) titleEl.textContent = decodeURIComponent(fileUrl.split("/").pop() || "PDF");
  document.title = `${titleEl?.textContent ?? "PDF"} — Glimpse`;

  // ── Toolbar controls ──
  const btnPrev = document.getElementById("btn-prev") as HTMLButtonElement;
  const btnNext = document.getElementById("btn-next") as HTMLButtonElement;
  const pageNumInput = document.getElementById("page-num") as HTMLInputElement;
  const pageCountEl = document.getElementById("page-count") as HTMLSpanElement;
  const btnZoomOut = document.getElementById("btn-zoom-out") as HTMLButtonElement;
  const btnZoomIn = document.getElementById("btn-zoom-in") as HTMLButtonElement;
  const zoomSelect = document.getElementById("zoom-select") as HTMLSelectElement;

  function updatePageUI(page: number, total: number): void {
    pageNumInput.value = String(page);
    pageNumInput.max = String(total);
    pageCountEl.textContent = String(total);
    btnPrev.disabled = page <= 1;
    btnNext.disabled = page >= total;
  }

  function updateZoomUI(scale: number, presetValue?: string): void {
    // Update the select to the matching preset, or add/update a custom % option
    const matchingPreset = presetValue && ["page-width", "page-fit", "auto"].includes(presetValue)
      ? presetValue : null;

    if (matchingPreset) {
      zoomSelect.value = matchingPreset;
    } else {
      // Find closest numeric option
      const label = formatZoomLabel(scale);
      const numericValue = String(Math.round(scale * 100) / 100);
      let found = false;
      for (const opt of zoomSelect.options) {
        if (opt.value === numericValue || opt.text === label) {
          zoomSelect.value = opt.value;
          found = true;
          break;
        }
      }
      if (!found) {
        // Add a temporary custom option
        const existing = zoomSelect.querySelector("option.custom-zoom");
        if (existing) existing.remove();
        const opt = document.createElement("option");
        opt.value = numericValue;
        opt.text = label;
        opt.className = "custom-zoom";
        opt.selected = true;
        zoomSelect.insertBefore(opt, zoomSelect.options[0]);
      }
    }
  }

  // Page nav buttons
  btnPrev.addEventListener("click", () => {
    if (pdfViewer.currentPageNumber > 1) pdfViewer.currentPageNumber--;
  });
  btnNext.addEventListener("click", () => {
    if (pdfViewer.currentPageNumber < pdfViewer.pagesCount) pdfViewer.currentPageNumber++;
  });

  // Page number input
  pageNumInput.addEventListener("change", () => {
    const n = parseInt(pageNumInput.value, 10);
    if (!isNaN(n) && n >= 1 && n <= pdfViewer.pagesCount) {
      pdfViewer.currentPageNumber = n;
    } else {
      pageNumInput.value = String(pdfViewer.currentPageNumber);
    }
  });
  pageNumInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") (e.target as HTMLElement).blur();
  });

  // Zoom select
  zoomSelect.addEventListener("change", () => {
    const val = zoomSelect.value;
    if (val === "page-width" || val === "page-fit" || val === "auto") {
      pdfViewer.currentScaleValue = val;
    } else {
      const n = parseFloat(val);
      if (!isNaN(n)) pdfViewer.currentScale = n;
    }
  });

  // Zoom buttons
  btnZoomOut.addEventListener("click", () => {
    pdfViewer.currentScale = nextZoom(pdfViewer.currentScale, -1);
  });
  btnZoomIn.addEventListener("click", () => {
    pdfViewer.currentScale = nextZoom(pdfViewer.currentScale, 1);
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === "=" || e.key === "+" || e.key === "ArrowUp")) {
      e.preventDefault();
      pdfViewer.currentScale = nextZoom(pdfViewer.currentScale, 1);
    } else if (ctrl && (e.key === "-" || e.key === "ArrowDown")) {
      e.preventDefault();
      pdfViewer.currentScale = nextZoom(pdfViewer.currentScale, -1);
    } else if (ctrl && e.key === "0") {
      e.preventDefault();
      pdfViewer.currentScale = 1;
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      if (pdfViewer.currentPageNumber > 1) pdfViewer.currentPageNumber--;
    } else if (e.key === "ArrowRight" || e.key === "PageDown") {
      if (pdfViewer.currentPageNumber < pdfViewer.pagesCount) pdfViewer.currentPageNumber++;
    } else if (e.key === "Home") {
      pdfViewer.currentPageNumber = 1;
    } else if (e.key === "End") {
      pdfViewer.currentPageNumber = pdfViewer.pagesCount;
    }
  });

  // Scroll-wheel zoom (Ctrl + scroll)
  container.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (e.deltaY < 0) {
      pdfViewer.currentScale = nextZoom(pdfViewer.currentScale, 1);
    } else {
      pdfViewer.currentScale = nextZoom(pdfViewer.currentScale, -1);
    }
  }, { passive: false });

  // Sync UI from pdf.js events
  eventBus.on("pagechanging", (evt: { pageNumber: number }) => {
    updatePageUI(evt.pageNumber, pdfViewer.pagesCount);
  });
  eventBus.on("scalechanging", (evt: { scale: number; presetValue?: string }) => {
    updateZoomUI(evt.scale, evt.presetValue);
  });
  eventBus.on("pagesinit", () => {
    updatePageUI(1, pdfViewer.pagesCount);
  });

  // ── PDF loading ──
  setStatus("Loading…");
  log("viewer loading", fileUrl);

  async function loadPdfBytes(bytes: Uint8Array): Promise<void> {
    const doc = await pdfjs
      .getDocument({ data: bytes, disableRange: true, disableStream: true })
      .promise;
    pdfViewer.setDocument(doc);
    linkService.setDocument(doc, null);
    setStatus(`${doc.numPages} page${doc.numPages === 1 ? "" : "s"}`);
    startDetection("pdfjs", doc);
  }

  function showFilePicker(): void {
    const overlay = document.getElementById("file-picker-overlay");
    const hint = document.getElementById("file-picker-hint");
    const input = document.getElementById("file-input") as HTMLInputElement;
    if (!overlay || !hint || !input) return;

    const filename = (fileUrl ?? "").split("/").pop() ?? "the PDF file";
    hint.textContent = `Browsers block direct access to local files. Please select "${decodeURIComponent(filename)}" to open it in Glimpse.`;
    overlay.classList.remove("hidden");
    setStatus("Choose file to open");

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      overlay.classList.add("hidden");
      setStatus("Loading…");
      const reader = new FileReader();
      reader.onload = () => {
        const buf = reader.result as ArrayBuffer;
        loadPdfBytes(new Uint8Array(buf)).catch((err: unknown) => {
          setStatus(`Failed to load PDF: ${String((err as Error)?.message ?? err)}`);
        });
      };
      reader.onerror = () => setStatus("Failed to read file");
      reader.readAsArrayBuffer(file);
    });
  }

  try {
    if (fileUrl.startsWith("file://")) {
      // Browsers sandbox extension pages from file:// URLs.
      // Try the background script first (works in Chrome with "Allow access to file URLs").
      // Fall back to the file picker on failure (works everywhere, no permissions needed).
      let loaded = false;
      try {
        const resp = await chrome.runtime.sendMessage({ type: "fetchPdf", url: fileUrl });
        if (resp?.ok) {
          const binary = atob(resp.pdf.dataBase64 as string);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          await loadPdfBytes(bytes);
          loaded = true;
        }
      } catch {
        // Background fetch failed — fall through to file picker
      }
      if (!loaded) showFilePicker();
    } else {
      const doc = await pdfjs
        .getDocument({ url: fileUrl, withCredentials: true, disableRange: true, disableStream: true })
        .promise;
      pdfViewer.setDocument(doc);
      linkService.setDocument(doc, null);
      setStatus(`${doc.numPages} page${doc.numPages === 1 ? "" : "s"}`);
      startDetection("pdfjs", doc);
    }
  } catch (err) {
    errorLog("viewer failed to load PDF", err);
    setStatus(`Failed to load PDF: ${String((err as Error)?.message ?? err)}`);
  }
}

void main();

