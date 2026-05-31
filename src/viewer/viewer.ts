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

  // Full viewer mode.
  const fileUrl = getFileParam();
  const titleEl = document.getElementById("doc-title");

  if (!fileUrl) {
    setStatus("No PDF specified. Open a PDF via the Glimpse toolbar button.");
    return;
  }
  if (titleEl) titleEl.textContent = fileUrl.split("/").pop() || "PDF";
  document.title = `${titleEl?.textContent ?? "PDF"} — Glimpse`;

  setStatus("Loading…");
  log("viewer loading", fileUrl);

  try {
    const loadingTask = pdfjs.getDocument({
      url: fileUrl,
      withCredentials: true,
      disableRange: true,
      disableStream: true,
    });
    const doc = await loadingTask.promise;
    pdfViewer.setDocument(doc);
    linkService.setDocument(doc, null);
    setStatus(`${doc.numPages} page(s)`);

    // Reuse the loaded document for citation detection (no second download).
    startDetection("pdfjs", doc);
  } catch (err) {
    errorLog("viewer failed to load PDF", err);
    setStatus(`Failed to load PDF: ${String((err as Error)?.message ?? err)}`);
  }
}

void main();

