// Popup script: detect current tab PDF, handle file picker and drag-and-drop.
import { idbPutPdf } from "@shared/idb";

declare const __EXT_VERSION__: string;

const PDF_URL_RE = /\.pdf($|[?#])/i;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setStatus(msg: string, isError = true): void {
  const bar = el("status-bar");
  const text = el("status-text");
  bar.classList.remove("hidden", "info");
  if (!isError) bar.classList.add("info");
  text.textContent = msg;
}

function clearStatus(): void {
  el("status-bar").classList.add("hidden");
}

/** Store file in IndexedDB, get back a key, open viewer in a new tab. */
async function openFileInViewer(file: File): Promise<void> {
  setStatus("Reading file…", false);
  const buf = await file.arrayBuffer();
  // Quick sanity check
  const magic = String.fromCharCode(...new Uint8Array(buf.slice(0, 5)));
  if (magic !== "%PDF-") {
    setStatus("That file doesn't look like a PDF.");
    return;
  }

  setStatus("Opening…", false);
  const key = await idbPutPdf(new Uint8Array(buf), file.name);
  const viewerUrl = chrome.runtime.getURL(`viewer.html?localKey=${key}`);
  await chrome.tabs.create({ url: viewerUrl });
  window.close();
}

async function main(): Promise<void> {
  // Version label
  el("version-label").textContent = `v${__EXT_VERSION__}`;

  // Settings button
  el("btn-settings").addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
    window.close();
  });

  // Detect current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url ?? "";
  const isViewerPage = tabUrl.startsWith(chrome.runtime.getURL(""));
  const isCurrentPdf = PDF_URL_RE.test(tabUrl) && !isViewerPage;

  if (isCurrentPdf) {
    const filename = decodeURIComponent(tabUrl.split("/").pop()?.split("?")[0] ?? "PDF");
    el<HTMLSpanElement>("current-filename").textContent = filename;
    el("section-current").classList.remove("hidden");
    el("section-divider").classList.remove("hidden");

    el("btn-open-current").addEventListener("click", () => {
      const viewerUrl = chrome.runtime.getURL(`viewer.html?file=${encodeURIComponent(tabUrl)}`);
      if (tab.id != null) {
        void chrome.tabs.update(tab.id, { url: viewerUrl });
      } else {
        void chrome.tabs.create({ url: viewerUrl });
      }
      window.close();
    });
  }

  // File input — in popup context, clicking the choose label (for="file-input")
  // will open a native file dialog which closes the popup, killing the JS context.
  // Instead, intercept the label click and open the viewer as a full tab (which has
  // its own working file picker). Drag-and-drop still works in the popup directly.
  const chooseLabelEl = el("choose-label");
  chooseLabelEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const viewerUrl = chrome.runtime.getURL("viewer.html");
    void chrome.tabs.create({ url: viewerUrl });
    window.close();
  });

  // Drop zone click → open viewer tab (file picker lives there, not in the popup)
  const dropZone = el("drop-zone");
  dropZone.addEventListener("click", () => {
    const viewerUrl = chrome.runtime.getURL("viewer.html");
    void chrome.tabs.create({ url: viewerUrl });
    window.close();
  });

  const idle = el("drop-zone-idle");
  const over = el("drop-zone-over");

  // Drag and drop on the popup body
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
    idle.classList.add("hidden");
    over.classList.remove("hidden");
  });
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  document.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null || !document.contains(e.relatedTarget as Node)) {
      dropZone.classList.remove("dragover");
      idle.classList.remove("hidden");
      over.classList.add("hidden");
    }
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    idle.classList.remove("hidden");
    over.classList.add("hidden");
    clearStatus();
    const file = e.dataTransfer?.files[0];
    if (file) {
      openFileInViewer(file).catch((err: unknown) => {
        setStatus(`Failed to open: ${String((err as Error)?.message ?? err)}`);
      });
    }
  });
}

void main();
