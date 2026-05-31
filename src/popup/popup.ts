// Popup script: detect current tab PDF, handle file picker and drag-and-drop.
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

/** Send file bytes to the background, get back a key, open viewer. */
async function openFileInViewer(file: File): Promise<void> {
  setStatus("Reading file…", false);
  const buf = await file.arrayBuffer();
  // Quick sanity check
  const magic = String.fromCharCode(...new Uint8Array(buf.slice(0, 5)));
  if (magic !== "%PDF-") {
    setStatus("That file doesn't look like a PDF.");
    return;
  }

  // Convert to base64 in chunks to avoid call-stack overflow on large files
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const data = btoa(binary);

  setStatus("Opening…", false);
  const resp = await chrome.runtime.sendMessage({ type: "storeLocalPdf", data, name: file.name });
  if (!resp?.ok) {
    setStatus(resp?.error ?? "Failed to store PDF");
    return;
  }

  const viewerUrl = chrome.runtime.getURL(`viewer.html?localKey=${resp.key as string}`);
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

  // File input
  const fileInput = el<HTMLInputElement>("file-input");
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void openFileInViewer(file);
  });

  // Drop zone click → trigger file input
  const dropZone = el("drop-zone");
  dropZone.addEventListener("click", (e) => {
    // Only if not clicking the choose-label itself (it already triggers input)
    if ((e.target as HTMLElement).closest("#choose-label")) return;
    fileInput.click();
  });
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
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
    if (file) void openFileInViewer(file);
  });
}

void main();
