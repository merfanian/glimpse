// Message contracts between the content script and the background worker.
import type { LookupResult, ParsedReference, FetchedPdf } from "./types";

export type Message =
  | LookupRequest
  | FetchPdfRequest;

export interface LookupRequest {
  type: "lookup";
  reference: ParsedReference;
}

export interface FetchPdfRequest {
  type: "fetchPdf";
  url: string;
}

export interface LookupResponse {
  ok: true;
  result: LookupResult;
}

export interface FetchPdfResponse {
  ok: true;
  pdf: FetchedPdf;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export type Response<T> = T | ErrorResponse;

/** Promise wrapper around chrome.runtime.sendMessage. */
export function sendMessage<TReq extends Message, TRes>(message: TReq): Promise<Response<TRes>> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message ?? "Unknown messaging error" });
        return;
      }
      resolve(response as Response<TRes>);
    });
  });
}
