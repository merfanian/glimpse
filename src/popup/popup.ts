// Popup script: detect whether the current tab shows a PDF, offer to reopen it in the
// bundled viewer, and accept local PDFs via drag-and-drop.
import { idbPutPdf } from "@shared/idb";
import type { ProbeResponse } from "@shared/messages";
import { getSettings, saveSettings, type Settings } from "@shared/settings";

declare const __EXT_VERSION__: string;

const PDF_URL_RE = /\.pdf($|[?#])/i;
const ALL_SITES = { origins: ["<all_urls>"] };

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

function openViewerTab(url = chrome.runtime.getURL("viewer.html")): void {
  void chrome.tabs.create({ url });
  window.close();
}

/** Store file in IndexedDB, get back a key, open viewer in a new tab. */
async function openFileInViewer(file: File): Promise<void> {
  setStatus("Reading file…", false);
  const buf = await file.arrayBuffer();
  const head = String.fromCharCode(...new Uint8Array(buf.slice(0, 1024)));
  if (!head.includes("%PDF-")) {
    setStatus("That file doesn't look like a PDF.");
    return;
  }
  setStatus("Opening…", false);
  const key = await idbPutPdf(new Uint8Array(buf), file.name);
  openViewerTab(chrome.runtime.getURL(`viewer.html?localKey=${key}`));
}

/** Ask the tab's loader content script what it sees (Chrome/Edge native viewer included). */
function probeTab(tabId: number): Promise<ProbeResponse | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 400);
    try {
      chrome.tabs.sendMessage(tabId, { type: "probe" }, { frameId: 0 }, (res: ProbeResponse | undefined) => {
        clearTimeout(timer);
        void chrome.runtime.lastError; // no content script (e.g. Firefox's PDF viewer)
        resolve(res ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** Ask the server: many PDF URLs have no .pdf suffix (arxiv.org/pdf/1706.03762). */
async function headIsPdf(url: string): Promise<boolean> {
  if (!/^https?:/i.test(url)) return false;
  try {
    const res = await fetch(url, { method: "HEAD", credentials: "include", signal: AbortSignal.timeout(1500) });
    return /application\/pdf/i.test(res.headers.get("content-type") ?? "");
  } catch {
    return false;
  }
}

function displayName(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    return last || u.hostname;
  } catch {
    return "PDF";
  }
}

async function checkPermissions(): Promise<void> {
  if (!chrome.permissions?.contains) return;
  let granted = true;
  try {
    granted = await chrome.permissions.contains(ALL_SITES);
  } catch {
    return;
  }
  if (granted) return;
  const section = el("section-permission");
  section.classList.remove("hidden");
  el("btn-grant").addEventListener("click", () => {
    // Must be called synchronously from the click (user gesture).
    void chrome.permissions.request(ALL_SITES).then((ok) => {
      if (ok) section.classList.add("hidden");
    });
  });
}

async function main(): Promise<void> {
  el("version-label").textContent = `v${__EXT_VERSION__}`;

  el("btn-settings").addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
    window.close();
  });

  // The file dialog would close the popup (killing this script), so choosing a file
  // happens in the viewer tab, which has its own picker. Drag-and-drop works here.
  el("choose-label").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openViewerTab();
  });
  const dropZone = el("drop-zone");
  dropZone.addEventListener("click", () => openViewerTab());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openViewerTab();
    }
  });

  const idle = el("drop-zone-idle");
  const over = el("drop-zone-over");
  const resetDrop = () => {
    dropZone.classList.remove("dragover");
    idle.classList.remove("hidden");
    over.classList.add("hidden");
  };
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
    idle.classList.add("hidden");
    over.classList.remove("hidden");
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null || !document.contains(e.relatedTarget as Node)) resetDrop();
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    resetDrop();
    clearStatus();
    const file = e.dataTransfer?.files[0];
    if (file) {
      openFileInViewer(file).catch((err: unknown) => {
        setStatus(`Failed to open: ${String((err as Error)?.message ?? err)}`);
      });
    }
  });

  void checkPermissions();

  // "When I open a PDF" segmented control.
  const modeButtons = Array.from(el("pdf-mode").querySelectorAll<HTMLButtonElement>("button[data-value]"));
  const showMode = (mode: Settings["pdfMode"]) => {
    for (const b of modeButtons) b.setAttribute("aria-checked", String(b.dataset.value === mode));
  };
  void getSettings().then((s) => showMode(s.pdfMode));
  for (const b of modeButtons) {
    b.addEventListener("click", async () => {
      const mode = b.dataset.value as Settings["pdfMode"];
      showMode(mode);
      const s = await getSettings();
      await saveSettings({ ...s, pdfMode: mode });
    });
  }

  // ── Current tab ──
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url ?? "";
  if (!tab || !tabUrl || tabUrl.startsWith(chrome.runtime.getURL(""))) return;

  const probe = tab.id != null ? await probeTab(tab.id) : null;
  if (probe?.env) {
    el("section-active").classList.remove("hidden");
    return;
  }
  const isPdf = probe?.isPdf || PDF_URL_RE.test(tabUrl) || (await headIsPdf(tabUrl));
  if (!isPdf) return;

  el<HTMLSpanElement>("current-filename").textContent = displayName(tabUrl);
  el("section-current").classList.remove("hidden");
  el("section-divider").classList.remove("hidden");
  el("btn-open-current").addEventListener("click", () => {
    const viewerUrl = chrome.runtime.getURL(`viewer.html?file=${encodeURIComponent(tabUrl)}`);
    if (tab.id != null) void chrome.tabs.update(tab.id, { url: viewerUrl });
    else void chrome.tabs.create({ url: viewerUrl });
    window.close();
  });
}

void main();
