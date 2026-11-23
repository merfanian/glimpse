// Background worker: reference lookups across sources, PDF fetching, on-demand injection
// of the heavy content script, and context menus.
import type { Message, FetchPdfRequest } from "@shared/messages";
import type { PaperCandidate, LookupResult, ParsedReference } from "@shared/types";
import { getSettings, type Settings } from "@shared/settings";
import { crossrefByDoi, crossrefSearch } from "./sources/crossref";
import { arxivById, arxivSearch } from "./sources/arxiv";
import { s2Match, s2ByDoi, s2ByArxiv, s2Search } from "./sources/semanticScholar";
import { openAlexByDoi, openAlexSearch } from "./sources/openalex";
import { rank } from "./matching";
import { fetchFirstPdf } from "./pdfFetch";
import { getCapturedPdf, installPdfCapture } from "./pdfCapture";
import { TtlCache } from "./cache";
import { handleNativePdf, handleOpenInGlimpse, installAutoOpen, openNative } from "./autoOpen";

installPdfCapture();
installAutoOpen();

// ── Context menus ───────────────────────────────────────────────────────────
// Menus persist across restarts in both browsers, but re-creating them on startup makes
// us robust to profiles where they were lost. removeAll() avoids duplicate-id errors.
const PDF_PATTERNS = ["*://*/*.pdf", "*://*/*.pdf?*", "*://*/*.PDF", "file:///*.pdf", "file:///*.PDF"];

function setupMenus(): void {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: "rp-open-link",
      title: "Open PDF in Glimpse",
      contexts: ["link"],
      targetUrlPatterns: PDF_PATTERNS,
    });
    chrome.contextMenus.create({
      id: "rp-open-page",
      title: "Open this PDF in Glimpse",
      contexts: ["page"],
      documentUrlPatterns: PDF_PATTERNS,
    });
  });
}
chrome.runtime.onInstalled.addListener(setupMenus);
chrome.runtime.onStartup?.addListener(setupMenus);

function viewerUrl(target: string): string {
  return chrome.runtime.getURL(`viewer.html?file=${encodeURIComponent(target)}`);
}

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "rp-open-link" && info.linkUrl) {
    void chrome.tabs.create({ url: viewerUrl(info.linkUrl), index: tab ? tab.index + 1 : undefined });
  } else if (info.menuItemId === "rp-open-page" && info.pageUrl) {
    const url = viewerUrl(info.pageUrl);
    if (tab?.id != null) void chrome.tabs.update(tab.id, { url });
    else void chrome.tabs.create({ url });
  }
});

// ── Lookup ──────────────────────────────────────────────────────────────────
const lookupCache = new TtlCache<LookupResult>(30 * 60 * 1000);
const inflight = new Map<string, Promise<LookupResult>>();

/** Confidence at which we stop querying further sources. */
const GOOD_ENOUGH = 0.85;
/** Alternatives below this are noise and not shown. */
const MIN_ALTERNATIVE = 0.3;
const MAX_CANDIDATES = 5;

function cacheKey(r: ParsedReference): string {
  return (r.doi ?? r.arxivId ?? (r.title ? `t:${r.title.toLowerCase()}` : `raw:${r.raw}`)).slice(0, 500);
}

type SourceResult = PaperCandidate | PaperCandidate[] | null;

async function settled(p: Promise<SourceResult>, label: string): Promise<PaperCandidate[]> {
  try {
    const v = await p;
    return v == null ? [] : Array.isArray(v) ? v : [v];
  } catch (err) {
    console.warn(`[Glimpse] ${label} failed:`, (err as Error)?.message ?? err);
    return [];
  }
}

/**
 * Run source queries in parallel, re-ranking as each one lands. Resolves early once a
 * candidate is GOOD_ENOUGH (so one slow / rate-limited source doesn't hold up the panel),
 * otherwise when every source has answered. Every task's completion is also recorded in
 * `settledTasks`, so late answers (e.g. Semantic Scholar's TL;DR) can be delivered later.
 */
function collect(
  ref: ParsedReference,
  pool: PaperCandidate[],
  tasks: Array<[string, () => Promise<SourceResult>]>,
  settledTasks: Promise<unknown>[],
): Promise<void> {
  if (tasks.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let pending = tasks.length;
    for (const [label, run] of tasks) {
      const done = settled(run(), label).then((found) => {
        pool.push(...found);
        pending--;
        const best = rank(ref, pool).candidates[0];
        if (pending === 0 || (best && best.confidence >= GOOD_ENOUGH && (!!best.abstract || pending === 0))) {
          resolve();
        }
      });
      settledTasks.push(done);
    }
  });
}

function finalize(ref: ParsedReference, pool: PaperCandidate[]): LookupResult {
  const candidates = rank(ref, pool)
    .candidates.filter((c, i) => i === 0 || c.confidence >= MIN_ALTERNATIVE)
    .slice(0, MAX_CANDIDATES);
  return { reference: ref, candidates, bestIndex: candidates.length ? 0 : -1 };
}

interface LookupRun {
  /** Answer as soon as a confident match is known. */
  result: LookupResult;
  /** The same lookup once every source has answered (adds late details like TL;DRs). */
  complete: Promise<LookupResult>;
}

async function doLookup(ref: ParsedReference, settings: Settings): Promise<LookupRun> {
  const src = settings.sources;
  const email = settings.contactEmail.trim();
  const pool: PaperCandidate[] = [];
  const settledTasks: Promise<unknown>[] = [];

  // Stage 1 — identifiers and the precise title matchers.
  const stage1: Array<[string, () => Promise<SourceResult>]> = [];
  if (ref.doi) {
    if (src.crossref) stage1.push(["crossref:doi", () => crossrefByDoi(ref.doi!, email)]);
    if (src.semanticScholar) stage1.push(["s2:doi", () => s2ByDoi(ref.doi!)]);
  }
  if (ref.arxivId) {
    if (src.arxiv) stage1.push(["arxiv:id", () => arxivById(ref.arxivId!)]);
    else if (src.semanticScholar) stage1.push(["s2:arxiv", () => s2ByArxiv(ref.arxivId!)]);
  }
  if (ref.title) {
    if (src.semanticScholar) stage1.push(["s2:match", () => s2Match(ref)]);
    if (src.arxiv) stage1.push(["arxiv:search", () => arxivSearch(ref)]);
  } else if (src.semanticScholar) {
    stage1.push(["s2:search", () => s2Search(ref)]);
  }
  await collect(ref, pool, stage1, settledTasks);

  // Stage 2 — broad bibliographic search when nothing convincing was found yet.
  let best = rank(ref, pool).candidates[0];
  if (!best || best.confidence < GOOD_ENOUGH) {
    const stage2: Array<[string, () => Promise<SourceResult>]> = [];
    if (src.openAlex) stage2.push(["openalex:search", () => openAlexSearch(ref, email)]);
    if (src.crossref) stage2.push(["crossref:search", () => crossrefSearch(ref, email)]);
    if (!ref.title && src.semanticScholar && !stage1.some(([l]) => l === "s2:search")) {
      stage2.push(["s2:search", () => s2Search(ref)]);
    }
    await collect(ref, pool, stage2, settledTasks);
    best = rank(ref, pool).candidates[0];
  }

  // Stage 3 — enrich a confident match that lacks an abstract or a PDF link.
  if (best && best.confidence >= 0.6 && (!best.abstract || !best.pdfUrl) && best.doi) {
    const enrich: Array<[string, () => Promise<SourceResult>]> = [];
    if (src.openAlex) enrich.push(["openalex:doi", () => openAlexByDoi(best!.doi!, email)]);
    if (src.semanticScholar && !ref.doi) enrich.push(["s2:doi", () => s2ByDoi(best!.doi!)]);
    // Enrichment results describe the same paper: give them the best's confidence so they
    // merge into it instead of ranking separately.
    const extra: PaperCandidate[] = [];
    await collect(ref, extra, enrich, []);
    for (const c of extra) pool.push({ ...c, title: best.title });
  }

  return {
    result: finalize(ref, pool),
    complete: Promise.all(settledTasks).then(() => finalize(ref, pool)),
  };
}

/** Complete results (all sources answered), kept briefly for the panel's follow-up request. */
const completeLookups = new TtlCache<Promise<LookupResult>>(10 * 60 * 1000);

async function lookup(req: { reference: ParsedReference }): Promise<LookupResult> {
  const key = cacheKey(req.reference);
  const cached = lookupCache.get(key);
  if (cached) return cached;
  const running = inflight.get(key);
  if (running) return running;

  const p = (async () => {
    const settings = await getSettings();
    const { result, complete } = await doLookup(req.reference, settings);
    // Don't cache misses: they are often transient (rate limits, network blips).
    if (result.candidates.length > 0) lookupCache.set(key, result);
    completeLookups.set(key, complete);
    // Once every source has answered, cache the fuller result for later previews.
    void complete.then((full) => {
      if (full.candidates.length > 0) lookupCache.set(key, full);
    });
    return result;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The complete result for a reference that was looked up recently (else the cached one). */
async function lookupDetails(req: { reference: ParsedReference }): Promise<LookupResult> {
  const key = cacheKey(req.reference);
  const complete = completeLookups.get(key);
  if (complete) return complete;
  return lookup(req);
}

// ── Messaging ───────────────────────────────────────────────────────────────
function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  switch (message?.type) {
    case "lookup":
      lookup(message)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: errorText(err) }));
      return true;

    case "lookupDetails":
      lookupDetails(message)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: errorText(err) }));
      return true;

    case "fetchPdf": {
      const urls = (message as FetchPdfRequest).urls.filter(Boolean);
      (async () => {
        if (urls[0]) {
          const captured = await getCapturedPdf(urls[0]);
          if (captured) return { pdf: captured, url: urls[0] };
        }
        return fetchFirstPdf(urls);
      })()
        .then(({ pdf, url }) => sendResponse({ ok: true, pdf, url }))
        .catch((err) => sendResponse({ ok: false, error: errorText(err) }));
      return true;
    }

    case "nativePdf":
      void handleNativePdf(sender);
      return false;

    case "openInGlimpse":
      void handleOpenInGlimpse(sender, !!message.always);
      return false;

    case "openNative":
      openNative(sender, message.url);
      return false;

    case "activate": {
      // The lightweight loader found a supported viewer: inject the full content script
      // into exactly that frame. Keeps ~0.4–1.7 MB of pdf.js out of every other page.
      const tabId = sender.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false, error: "no tab" });
        return false;
      }
      chrome.scripting
        .executeScript({
          target: { tabId, frameIds: [sender.frameId ?? 0] },
          files: ["content-main.js"],
        })
        .then(() => sendResponse({ ok: true }))
        .catch((err: unknown) => sendResponse({ ok: false, error: errorText(err) }));
      return true;
    }
  }
  return false;
});
