// Background service worker: handles reference lookups across sources and PDF fetching.
import type { Message, LookupRequest, FetchPdfRequest } from "@shared/messages";
import type { PaperCandidate, LookupResult } from "@shared/types";
import { getSettings } from "@shared/settings";
import { crossrefByDoi } from "./sources/crossref";
import { arxivById } from "./sources/arxiv";
import { s2Match, s2ByDoi, s2ByArxiv, s2Search } from "./sources/semanticScholar";
import { withArxivPdf } from "./matching";
import { fetchPdf } from "./pdfFetch";
import { getCapturedPdf, installPdfCapture, isOverleafCompilePdf } from "./pdfCapture";
import { TtlCache } from "./cache";

const PDF_URL_RE = /\.pdf($|[?#])/i;

installPdfCapture();

function viewerUrl(target: string): string {
  return chrome.runtime.getURL(`viewer.html?file=${encodeURIComponent(target)}`);
}

/** Open the given PDF URL in the bundled viewer (in the current tab when possible). */
function openInViewer(target: string, tabId?: number): void {
  const url = viewerUrl(target);
  if (tabId != null) {
    void chrome.tabs.update(tabId, { url });
  } else {
    void chrome.tabs.create({ url });
  }
}

// Toolbar button: reopen the current tab's PDF in the bundled viewer.
chrome.action?.onClicked.addListener((tab) => {
  if (!tab.id) return;
  const url = tab.url ?? "";
  if (PDF_URL_RE.test(url) && !url.startsWith(chrome.runtime.getURL(""))) {
    openInViewer(url, tab.id);
  } else {
    // Not obviously a PDF: open the viewer anyway so the user can paste/choose.
    void chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
  }
});

// Context menu: open a linked or current PDF in the bundled viewer.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus?.create({
    id: "rp-open-link",
    title: "Open PDF in ReferencePreviewer",
    contexts: ["link"],
    targetUrlPatterns: ["*://*/*.pdf", "*://*/*.pdf?*", "file:///*.pdf"],
  });
  chrome.contextMenus?.create({
    id: "rp-open-page",
    title: "Open this PDF in ReferencePreviewer",
    contexts: ["page"],
    documentUrlPatterns: ["*://*/*.pdf", "*://*/*.pdf?*", "file:///*.pdf"],
  });
});

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "rp-open-link" && info.linkUrl) {
    openInViewer(info.linkUrl);
  } else if (info.menuItemId === "rp-open-page" && info.pageUrl) {
    openInViewer(info.pageUrl, tab?.id);
  }
});

const lookupCache = new TtlCache<LookupResult>(30 * 60 * 1000);

function cacheKey(req: LookupRequest): string {
  const r = req.reference;
  return r.doi ?? r.arxivId ?? (r.title ? `t:${r.title.toLowerCase()}` : `raw:${r.raw}`);
}

async function settled<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    console.warn("[ReferencePreviewer] source error:", err);
    return null;
  }
}

async function doLookup(req: LookupRequest): Promise<LookupResult> {
  const cached = lookupCache.get(cacheKey(req));
  if (cached) return cached;

  const settings = await getSettings();
  const ref = req.reference;
  const email = settings.contactEmail;

  // ── Step 1: parallel fetch ──
  // s2Match needs a clean title; s2Search is the fallback when title parsing failed.
  const useMatch = !!ref.title;
  const [s2, crossrefResult, arxivResult] = await Promise.all([
    settled(useMatch ? s2Match(ref) : s2Search(ref).then((r) => r[0] ?? null)),
    ref.doi ? settled(crossrefByDoi(ref.doi, email)) : Promise.resolve(null),
    ref.arxivId && !ref.doi ? settled(arxivById(ref.arxivId)) : Promise.resolve(null),
  ]);

  // ── Step 2: build a single best candidate ──
  // S2 is authoritative for identity; Crossref augments with publisher PDF/metadata.
  let best: PaperCandidate | null = s2;

  if (best) {
    if (crossrefResult) {
      best = {
        ...best,
        doi: best.doi ?? crossrefResult.doi,
        pdfUrl: best.pdfUrl || crossrefResult.pdfUrl || best.pdfUrl,
        abstract: best.abstract ?? crossrefResult.abstract,
        venue: best.venue ?? crossrefResult.venue,
      };
    }
  } else if (crossrefResult) {
    best = { ...crossrefResult, confidence: ref.doi ? 1.0 : 0 };
  } else if (arxivResult) {
    best = { ...arxivResult, confidence: ref.arxivId ? 0.98 : 0 };
  }

  // ── Step 3: arXiv PDF fallback ──
  if (best) best = withArxivPdf(best);

  // ── Step 4: if still no PDF, try fetching the S2 record by id to get openAccessPdf ──
  if (best && !best.pdfUrl) {
    const s2Extra = await settled(
      best.doi ? s2ByDoi(best.doi) : best.arxivId ? s2ByArxiv(best.arxivId) : Promise.resolve(null),
    );
    if (s2Extra?.pdfUrl) best = withArxivPdf({ ...best, pdfUrl: s2Extra.pdfUrl });
    else best = withArxivPdf(best); // one last try now that we may have arxivId from crossref
  }

  const candidates: PaperCandidate[] = best ? [best] : [];
  const result: LookupResult = {
    reference: ref,
    candidates,
    bestIndex: candidates.length ? 0 : -1,
  };
  lookupCache.set(cacheKey(req), result);
  return result;
}

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === "lookup") {
    doLookup(message as LookupRequest)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true; // async response
  }
  if (message.type === "fetchPdf") {
    const url = (message as FetchPdfRequest).url;
    getCapturedPdf(url)
      .then((captured) => {
        if (captured) return captured;
        // No cached capture: fall through to direct fetch.
        // Both Chrome and Firefox background pages have <all_urls> host_permissions,
        // so they can fetch Overleaf compile CDN URLs directly. filterResponseData
        // capture is an optimisation (avoids re-downloading an already-loaded PDF);
        // if it isn't ready yet, a direct fetch is the correct fallback.
        return fetchPdf(url);
      })
      .then((pdf) => sendResponse({ ok: true, pdf }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }
  return false;
});
