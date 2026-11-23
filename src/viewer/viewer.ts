// Bundled PDF viewer built from pdf.js viewer components. Renders the text + annotation
// (link) layers so the standard citation-detection logic works on local/remote PDFs.
import * as pdfjs from "pdfjs-dist";
import { EventBus, PDFViewer, PDFLinkService } from "pdfjs-dist/web/pdf_viewer.mjs";
import { startDetection } from "../content/start";
import { pdfWorkerReady } from "../content/pdfWorkerSetup";
import { base64ToUint8Array } from "../content/pdfReference";
import { log, errorLog } from "@shared/debug";
import { idbPopPdf, idbPutPdf } from "@shared/idb";
import { sendMessage } from "@shared/messages";
import type { FetchPdfRequest, FetchPdfResponse, OpenNativeRequest } from "@shared/messages";

/** Read a file:// URL from this extension page. Works in Chrome/Edge when
 * "Allow access to file URLs" is enabled; Firefox never allows it. */
function readLocalFile(url: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => {
      const buf = xhr.response as ArrayBuffer | null;
      if ((xhr.status === 0 || xhr.status === 200) && buf && buf.byteLength > 0) resolve(new Uint8Array(buf));
      else reject(new Error(`HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("blocked"));
    try {
      xhr.send();
    } catch (err) {
      reject(err as Error);
    }
  });
}

function fileAccessHint(): Promise<string> {
  return new Promise((resolve) => {
    const generic =
      "Browsers don't let extensions open local files directly. Choose the file below to open it in Glimpse.";
    try {
      if (__BROWSER__ !== "firefox" && chrome.extension?.isAllowedFileSchemeAccess) {
        chrome.extension.isAllowedFileSchemeAccess((allowed) => {
          resolve(
            allowed
              ? generic
              : "To open local PDFs automatically, enable \u201cAllow access to file URLs\u201d on Glimpse's " +
                  "extension details page. For now, choose the file below.",
          );
        });
        return;
      }
    } catch {
      /* fall through */
    }
    resolve(generic);
  });
}

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

/** Show a load failure with a way out to the browser's own viewer. */
function setLoadError(msg: string, nativeUrl: string | null): void {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = `${msg} `;
  if (nativeUrl && /^(https?|file):/i.test(nativeUrl)) {
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = "Open in browser's viewer";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openInBrowserViewer(nativeUrl);
    });
    el.appendChild(a);
  }
}

function openInBrowserViewer(url: string): void {
  // The background marks this tab+URL so it isn't redirected straight back here.
  void sendMessage<OpenNativeRequest, never>({ type: "openNative", url });
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
  await pdfWorkerReady;
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
    pdfViewer.currentScaleValue = "1"; // open at 100%
  });

  const localKey = new URLSearchParams(location.search).get("localKey");
  const fileUrl = getFileParam();
  const titleEl = document.getElementById("doc-title");

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

  let detectionStarted = false;

  const btnDownload = document.getElementById("btn-download") as HTMLButtonElement;
  const btnNative = document.getElementById("btn-native") as HTMLButtonElement;
  let currentDoc: pdfjs.PDFDocumentProxy | null = null;
  let downloadName = "document.pdf";

  btnDownload.addEventListener("click", async () => {
    if (!currentDoc) return;
    const data = await currentDoc.getData();
    const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });

  if (fileUrl && /^(https?|file):/i.test(fileUrl)) {
    btnNative.classList.remove("hidden");
    btnNative.addEventListener("click", () => openInBrowserViewer(fileUrl));
  }

  async function showDocument(doc: pdfjs.PDFDocumentProxy, fallbackName: string): Promise<void> {
    currentDoc = doc;
    downloadName = /\.pdf$/i.test(fallbackName) ? fallbackName : `${fallbackName}.pdf`;
    btnDownload.disabled = false;
    pdfViewer.setDocument(doc);
    linkService.setDocument(doc, null);
    setStatus(`${doc.numPages} page${doc.numPages === 1 ? "" : "s"}`);
    if (!detectionStarted) {
      detectionStarted = true;
      startDetection("pdfjs", doc);
    }
    // Prefer the paper's real title over a URL fragment like "1706.03762".
    try {
      const meta = await doc.getMetadata();
      const t = (meta.info as { Title?: string } | undefined)?.Title?.trim();
      const name = t && t.length > 3 && !/^untitled|\.(dvi|tex|docx?)$/i.test(t) ? t : fallbackName;
      if (titleEl) titleEl.textContent = name;
      document.title = `${name} — Glimpse`;
    } catch {
      /* metadata is optional */
    }
  }

  async function loadPdfBytes(bytes: Uint8Array, name = "PDF"): Promise<void> {
    const doc = await pdfjs.getDocument({ data: bytes, disableRange: true, disableStream: true }).promise;
    await showDocument(doc, name);
  }

  function showFilePicker(): void {
    const overlay = document.getElementById("file-picker-overlay");
    const hint = document.getElementById("file-picker-hint");
    const input = document.getElementById("file-input") as HTMLInputElement;
    if (!overlay || !hint || !input) return;

    void fileAccessHint().then((h) => (hint.textContent = h));
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
        loadPdfBytes(new Uint8Array(buf), file.name).catch((err: unknown) => {
          setStatus(`Failed to load PDF: ${String((err as Error)?.message ?? err)}`);
        });
      };
      reader.onerror = () => setStatus("Failed to read file");
      reader.readAsArrayBuffer(file);
    });
  }

  // ── Load PDF based on source ──
  setStatus("Loading…");
  log("viewer loading", localKey ? `localKey:${localKey}` : (fileUrl ?? "landing"));

  if (!localKey && !fileUrl) {
    // Landing page: no PDF specified — show the file picker overlay with drag-and-drop.
    const overlay = document.getElementById("file-picker-overlay")!;
    const hint = document.getElementById("file-picker-hint")!;
    const input = document.getElementById("file-input") as HTMLInputElement;
    hint.textContent = "Choose a PDF from your computer, or drag and drop it here.";
    overlay.classList.remove("hidden");
    setStatus("Open a PDF");
    document.title = "Glimpse";
    if (titleEl) titleEl.textContent = "Glimpse";

    const loadFromFile = (file: File) => {
      overlay.classList.add("hidden");
      setStatus("Loading…");
      document.title = `${file.name} — Glimpse`;
      if (titleEl) titleEl.textContent = file.name;
      const reader = new FileReader();
      reader.onload = () => loadPdfBytes(new Uint8Array(reader.result as ArrayBuffer), file.name)
        .catch((err: unknown) => setStatus(`Failed to load: ${String((err as Error)?.message ?? err)}`));
      reader.onerror = () => setStatus("Failed to read file");
      reader.readAsArrayBuffer(file);
    };

    input.addEventListener("change", () => { if (input.files?.[0]) loadFromFile(input.files[0]); });

    return;
  }

  if (localKey) {
    try {
      const entry = await idbPopPdf(localKey);
      if (!entry) throw new Error("this file link has expired — open the file again from the Glimpse button");
      if (titleEl) titleEl.textContent = entry.name;
      document.title = `${entry.name} — Glimpse`;
      await loadPdfBytes(entry.data, entry.name);
    } catch (err) {
      errorLog("viewer failed to load local PDF", err);
      setStatus(`Failed to load PDF: ${String((err as Error)?.message ?? err)}`);
    }
  } else if (fileUrl) {
    let name = "PDF";
    try {
      name = decodeURIComponent(new URL(fileUrl).pathname.split("/").pop() || "PDF");
    } catch {
      /* keep default */
    }
    if (titleEl) titleEl.textContent = name;
    document.title = `${name} — Glimpse`;
    try {
      if (fileUrl.startsWith("file:")) {
        let bytes: Uint8Array | null = null;
        try {
          bytes = await readLocalFile(fileUrl);
        } catch {
          const resp = await sendMessage<FetchPdfRequest, FetchPdfResponse>({ type: "fetchPdf", urls: [fileUrl] });
          if (resp.ok && resp.pdf.dataBase64) bytes = base64ToUint8Array(resp.pdf.dataBase64);
        }
        if (bytes) await loadPdfBytes(bytes, name);
        else showFilePicker();
      } else {
        let doc: pdfjs.PDFDocumentProxy;
        try {
          const task = pdfjs.getDocument({ url: fileUrl, withCredentials: true, disableRange: true, disableStream: true });
          task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
            if (total > 0) setStatus(`Loading… ${Math.min(99, Math.round((loaded / total) * 100))}%`);
          };
          doc = await task.promise;
        } catch (err) {
          // e.g. CORS / missing host permission in this page: let the background fetch it.
          log("direct load failed, retrying via background:", err);
          setStatus("Loading…");
          const resp = await sendMessage<FetchPdfRequest, FetchPdfResponse>({ type: "fetchPdf", urls: [fileUrl] });
          if (!resp.ok || !resp.pdf.dataBase64) throw new Error(resp.ok ? "empty response" : resp.error);
          doc = await pdfjs.getDocument({
            data: base64ToUint8Array(resp.pdf.dataBase64),
            disableRange: true,
            disableStream: true,
          }).promise;
        }
        await showDocument(doc, name);
      }
    } catch (err) {
      errorLog("viewer failed to load PDF", err);
      setLoadError(`Couldn't load this PDF (${String((err as Error)?.message ?? err)}).`, fileUrl);
    }
  }
}

// Dropping a PDF anywhere opens it here (instead of the browser navigating away).
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  e.preventDefault();
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    setStatus("That file isn't a PDF");
    return;
  }
  void file.arrayBuffer().then(async (buf) => {
    const key = await idbPutPdf(new Uint8Array(buf), file.name);
    location.href = chrome.runtime.getURL(`viewer.html?localKey=${key}`);
  });
});

void main();

