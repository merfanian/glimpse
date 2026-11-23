// Message contracts between content scripts / extension pages and the background worker.
import type { LookupResult, ParsedReference, FetchedPdf } from "./types";

export type Message =
  | LookupRequest
  | LookupDetailsRequest
  | FetchPdfRequest
  | ActivateRequest
  | NativePdfRequest
  | OpenNativeRequest
  | OpenInGlimpseRequest;

export interface LookupRequest {
  type: "lookup";
  reference: ParsedReference;
}

/** Same reference again, answered once every source has responded (late TL;DRs etc.). */
export interface LookupDetailsRequest {
  type: "lookupDetails";
  reference: ParsedReference;
}

export interface FetchPdfRequest {
  type: "fetchPdf";
  /** Candidate URLs, tried in order until one yields a real PDF. */
  urls: string[];
}

/** Sent by the lightweight loader when it finds a supported viewer in its frame. */
export interface ActivateRequest {
  type: "activate";
}

/** Sent by the loader when its frame is the browser's built-in PDF viewer (Chrome/Edge). */
export interface NativePdfRequest {
  type: "nativePdf";
}

/** Sent by the Glimpse viewer: show this PDF in the browser's own viewer instead. */
export interface OpenNativeRequest {
  type: "openNative";
  url: string;
}

/** Sent by the "Open in Glimpse?" suggestion shown over the browser's PDF viewer. */
export interface OpenInGlimpseRequest {
  type: "openInGlimpse";
  /** Also switch the PDF setting to "open automatically". */
  always?: boolean;
}

/** Sent by the popup to a tab's loader script to ask what it sees. */
export interface ProbeRequest {
  type: "probe";
}

export interface ProbeResponse {
  isPdf: boolean;
  env: string | null;
}

export interface LookupResponse {
  ok: true;
  result: LookupResult;
}

export interface FetchPdfResponse {
  ok: true;
  pdf: FetchedPdf;
  /** The URL that actually produced the PDF. */
  url: string;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export type Response<T> = T | ErrorResponse;

export const CONTEXT_INVALIDATED =
  "Glimpse was updated or reloaded. Reload this page to keep using it.";

/**
 * Promise wrapper around chrome.runtime.sendMessage that never throws or hangs on
 * messaging failures (e.g. "Extension context invalidated" after an extension update).
 */
export function sendMessage<TReq extends Message, TRes>(message: TReq): Promise<Response<TRes>> {
  return new Promise((resolve) => {
    try {
      if (!chrome.runtime?.id) {
        resolve({ ok: false, error: CONTEXT_INVALIDATED });
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          const msg = err.message ?? "Unknown messaging error";
          resolve({ ok: false, error: /invalidated|Receiving end/i.test(msg) ? CONTEXT_INVALIDATED : msg });
          return;
        }
        if (response == null) {
          resolve({ ok: false, error: "No response from the Glimpse background worker." });
          return;
        }
        resolve(response as Response<TRes>);
      });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      resolve({ ok: false, error: /invalidated/i.test(msg) ? CONTEXT_INVALIDATED : msg });
    }
  });
}
