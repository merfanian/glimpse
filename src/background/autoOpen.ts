// What happens when a PDF opens in the browser's built-in viewer.
//
// Extensions can't run code inside the built-in viewers (Chrome/Edge PDFium, Firefox's
// privileged pdf.js page), so Glimpse either suggests or performs a switch to its own
// viewer, depending on the `pdfMode` setting:
//
//  "suggest" (default)
//    • Chrome/Edge: a small "Open in Glimpse" card floats over the PDF (suggest.ts,
//      injected into the viewer's host document — content scripts do run there).
//    • Firefox: nothing can be drawn over its viewer, so a Glimpse button appears in the
//      address bar (page action) — one click opens the PDF in Glimpse.
//    • Both: a "PDF" badge on the toolbar button.
//  "auto"
//    • Firefox: a blocking onHeadersReceived listener redirects before rendering (no
//      flash, no history entry, Back works normally).
//    • Chrome/Edge: no blocking webRequest in MV3, so tabs.update() on the same signal;
//      the loader's "nativePdf" message covers file:// PDFs, which webRequest can't see.
//  "off": only the toolbar popup's "Open in Glimpse" button.
//
// Never touched: downloads (Content-Disposition: attachment), non-GET responses (form
// results), embedded PDFs, and PDFs the user sent back to the browser's viewer.
import { getSettings, saveSettings } from "@shared/settings";

const PDF_TYPE = /^\s*application\/(x-)?pdf\b/i;

export function viewerUrl(target: string): string {
  return chrome.runtime.getURL(`viewer.html?file=${encodeURIComponent(target)}`);
}

function stripHash(url: string): string {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
}

function key(tabId: number, url: string): string {
  return `${tabId} ${stripHash(url)}`;
}

/** tab+url the user explicitly sent to the browser's viewer → expiry. */
const nativeBypass = new Map<string, number>();
/**
 * tab+url we already redirected. On Chrome the PDF may have been committed to history
 * before tabs.update() ran; without this, pressing Back would bounce straight back into
 * Glimpse. A second visit in the same tab therefore shows the browser's viewer.
 */
const redirected = new Set<string>();
/** Tabs whose current top-level document is a PDF in the browser's viewer → its URL. */
const pdfTabs = new Map<number, string>();

function remember(set: Set<string>, k: string): void {
  set.add(k);
  if (set.size > 500) set.delete(set.values().next().value as string);
}

function bypassed(tabId: number, url: string): boolean {
  const until = nativeBypass.get(key(tabId, url));
  return !!until && until > Date.now();
}

async function shouldRedirect(tabId: number, url: string): Promise<boolean> {
  if (tabId < 0 || !/^(https?|file):/i.test(url)) return false;
  if (bypassed(tabId, url)) return false;
  const k = key(tabId, url);
  if (redirected.has(k)) return false;
  const settings = await getSettings();
  if (settings.pdfMode !== "auto") return false;
  remember(redirected, k);
  return true;
}

type Header = { name: string; value?: string };

function isRenderablePdf(details: { method: string; statusCode: number; responseHeaders?: Header[] }): boolean {
  if (details.method !== "GET") return false;
  if (details.statusCode < 200 || details.statusCode >= 300) return false;
  let pdf = false;
  for (const h of details.responseHeaders ?? []) {
    const name = h.name.toLowerCase();
    if (name === "content-type" && PDF_TYPE.test(h.value ?? "")) pdf = true;
    if (name === "content-disposition" && /^\s*attachment/i.test(h.value ?? "")) return false;
  }
  return pdf;
}

interface PageActionApi {
  show(tabId: number): Promise<void>;
  hide(tabId: number): Promise<void>;
  onClicked: { addListener(cb: (tab: chrome.tabs.Tab) => void): void };
}

function pageAction(): PageActionApi | undefined {
  return (globalThis as { browser?: { pageAction?: PageActionApi } }).browser?.pageAction;
}

/** Mark a tab as showing a PDF in the browser's viewer: badge (+ Firefox page action). */
async function flagPdfTab(tabId: number): Promise<void> {
  const settings = await getSettings();
  if (settings.pdfMode === "off") return;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
    await chrome.action.setBadgeText({ tabId, text: "PDF" });
    await chrome.action.setTitle({ tabId, title: "Glimpse — open this PDF in Glimpse to preview citations" });
  } catch {
    /* tab closed */
  }
  void pageAction()?.show(tabId).catch(() => undefined);
}

function unflagTab(tabId: number): void {
  void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
  void chrome.action.setTitle({ tabId, title: "Glimpse — PDF Preview" }).catch(() => undefined);
  void pageAction()?.hide(tabId).catch(() => undefined);
}

export function openTabInGlimpse(tabId: number, url: string): void {
  if (!/^(https?|file):/i.test(url)) return;
  remember(redirected, key(tabId, url));
  void chrome.tabs.update(tabId, { url: viewerUrl(url) }).catch(() => undefined);
}

export function installAutoOpen(): void {
  const filter = { urls: ["http://*/*", "https://*/*"], types: ["main_frame" as chrome.webRequest.ResourceType] };

  if (__BROWSER__ === "firefox") {
    // Firefox accepts a Promise from blocking listeners.
    chrome.webRequest.onHeadersReceived.addListener(
      ((details: chrome.webRequest.WebResponseHeadersDetails) => {
        if (details.tabId >= 0) pdfTabs.delete(details.tabId);
        if (!isRenderablePdf(details)) return {};
        return shouldRedirect(details.tabId, details.url).then((go) => {
          if (go) return { redirectUrl: viewerUrl(details.url) };
          if (details.tabId >= 0) pdfTabs.set(details.tabId, stripHash(details.url));
          return {};
        });
      }) as unknown as (d: chrome.webRequest.WebResponseHeadersDetails) => chrome.webRequest.BlockingResponse,
      filter,
      ["blocking", "responseHeaders"],
    );

    // Firefox shows the page action / badge once the PDF tab has finished loading
    // (navigation resets per-tab UI, so flagging at header time would be lost).
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
      if (info.status !== "complete" && !info.url) return;
      const url = tab.url ? stripHash(tab.url) : "";
      if (pdfTabs.get(tabId) === url && url) void flagPdfTab(tabId);
      else if (info.url) unflagTab(tabId);
    });
    pageAction()?.onClicked.addListener((tab) => {
      if (tab.id != null && tab.url) openTabInGlimpse(tab.id, tab.url);
    });
  } else {
    chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        if (!isRenderablePdf(details)) return;
        void shouldRedirect(details.tabId, details.url).then((go) => {
          if (go) void chrome.tabs.update(details.tabId, { url: viewerUrl(details.url) }).catch(() => undefined);
        });
      },
      filter,
      ["responseHeaders"],
    );
  }

  chrome.tabs.onRemoved.addListener((tabId) => {
    pdfTabs.delete(tabId);
    const prefix = `${tabId} `;
    for (const k of redirected) if (k.startsWith(prefix)) redirected.delete(k);
    for (const k of nativeBypass.keys()) if (k.startsWith(prefix)) nativeBypass.delete(k);
  });
}

/**
 * The loader reports that its top frame is Chrome's/Edge's built-in PDF viewer.
 * "auto": switch to Glimpse. "suggest": badge + the floating suggestion card.
 */
export async function handleNativePdf(sender: chrome.runtime.MessageSender): Promise<void> {
  const tabId = sender.tab?.id;
  const url = sender.url ?? sender.tab?.url;
  if (tabId == null || !url || sender.frameId) return;
  if (await shouldRedirect(tabId, url)) {
    void chrome.tabs.update(tabId, { url: viewerUrl(url) }).catch(() => undefined);
    return;
  }
  const { pdfMode } = await getSettings();
  if (pdfMode === "off") return;
  await flagPdfTab(tabId);
  // Don't nag about a PDF the user just chose to view in the browser's viewer.
  if (pdfMode === "suggest" && !bypassed(tabId, url)) {
    await chrome.scripting
      .executeScript({ target: { tabId, frameIds: [0] }, files: ["suggest.js"] })
      .catch(() => undefined);
  }
}

/** The suggestion card's buttons. */
export async function handleOpenInGlimpse(sender: chrome.runtime.MessageSender, always: boolean): Promise<void> {
  const tabId = sender.tab?.id;
  const url = sender.url ?? sender.tab?.url;
  if (always) {
    const s = await getSettings();
    await saveSettings({ ...s, pdfMode: "auto" });
  }
  if (tabId != null && url) openTabInGlimpse(tabId, url);
}

/** "Open in browser's viewer" from the Glimpse viewer. */
export function openNative(sender: chrome.runtime.MessageSender, url: string): void {
  const tabId = sender.tab?.id;
  if (!/^(https?|file):/i.test(url)) return;
  if (tabId == null) {
    void chrome.tabs.create({ url });
    return;
  }
  nativeBypass.set(key(tabId, url), Date.now() + 30 * 60 * 1000);
  void chrome.tabs.update(tabId, { url });
}
