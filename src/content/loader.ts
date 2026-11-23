// Lightweight loader content script — runs in every frame of every page, so it is kept
// tiny (no pdf.js, no UI). It only:
//   1. detects a supported PDF viewer (Overleaf / pdf.js), immediately or lazily on the
//      first hover over a pdf.js annotation link (viewers that render after load),
//   2. asks the background to inject the full content script into this frame,
//   3. answers the toolbar popup's "is this tab a PDF?" probe.
import {
  ANNOTATION_LINK,
  detectEnvironment,
  glimpseGlobal,
  isNativePdfDocument,
  isOverleafHost,
  type Environment,
} from "./env";
import { getSettings } from "@shared/settings";
import type { ProbeResponse } from "@shared/messages";

const state = glimpseGlobal();

async function activate(env: Exclude<Environment, null>): Promise<void> {
  if (state.activated) return;
  state.activated = true;
  state.env = env;
  const settings = await getSettings();
  if (env === "overleaf" && !settings.enableOverleaf) return;
  if (env === "pdfjs" && !settings.enablePdfViewers) return;
  try {
    chrome.runtime.sendMessage({ type: "activate" }, () => void chrome.runtime.lastError);
  } catch {
    /* extension reloaded; nothing to do */
  }
}

function onFirstAnnotationHover(e: Event): void {
  const t = e.target as Element | null;
  const link = t?.closest?.(ANNOTATION_LINK);
  if (!link) return;
  document.removeEventListener("pointerover", onFirstAnnotationHover, true);
  state.pendingTarget = link;
  void activate(isOverleafHost() ? "overleaf" : "pdfjs");
}

if (!state.activated && !state.started) {
  const env = detectEnvironment();
  if (env) {
    void activate(env);
  } else if (!isNativePdfDocument()) {
    document.addEventListener("pointerover", onFirstAnnotationHover, { capture: true, passive: true });
  } else if (window === window.top) {
    // Chrome/Edge built-in PDF viewer: the background may switch this tab to Glimpse's
    // viewer (needed for file:// PDFs, which webRequest can't see).
    try {
      chrome.runtime.sendMessage({ type: "nativePdf" }, () => void chrome.runtime.lastError);
    } catch {
      /* extension reloaded */
    }
  }
}

// Only the top frame answers the popup's probe (the popup addresses frameId 0).
if (window === window.top) {
  chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
    if (msg?.type !== "probe") return false;
    const res: ProbeResponse = {
      isPdf: isNativePdfDocument(),
      env: state.env ?? detectEnvironment(),
    };
    sendResponse(res);
    return false;
  });
}
