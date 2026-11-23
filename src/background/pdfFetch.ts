// Fetches a PDF and returns its bytes as base64 so they can be passed back to the
// requesting content script / extension page.
import type { FetchedPdf } from "@shared/types";
import { warn } from "@shared/debug";

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

const MAX_BYTES = 60 * 1024 * 1024; // safety cap
const FETCH_TIMEOUT_MS = 45_000;

/** The PDF spec allows junk before the header; readers accept "%PDF-" within the first 1 KB. */
export function looksLikePdf(buf: ArrayBuffer): boolean {
  const head = new Uint8Array(buf.slice(0, 1024));
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

function toFetched(buf: ArrayBuffer): FetchedPdf {
  if (buf.byteLength > MAX_BYTES) throw new Error("PDF is too large to preview");
  if (!looksLikePdf(buf)) throw new Error("The link did not return a PDF (probably a landing or login page)");
  return { dataBase64: arrayBufferToBase64(buf), contentType: "application/pdf", byteLength: buf.byteLength };
}

/**
 * Read a local file:// URL. Chrome's service worker cannot fetch file:// at all, so this
 * only succeeds where the platform allows it (Firefox background page with file access).
 * Callers fall back to a file picker.
 */
async function fetchLocalPdf(url: string): Promise<FetchedPdf> {
  if (typeof XMLHttpRequest === "undefined") {
    throw new Error("Local files can't be read from the background worker");
  }
  const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.timeout = FETCH_TIMEOUT_MS;
    xhr.onload = () => {
      if (xhr.status === 0 || xhr.status === 200) resolve(xhr.response as ArrayBuffer);
      else reject(new Error(`HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Could not read the local file"));
    xhr.ontimeout = () => reject(new Error("Timed out reading the local file"));
    xhr.send();
  });
  return toFetched(buf);
}

export async function fetchPdf(url: string): Promise<FetchedPdf> {
  if (url.startsWith("file:")) return fetchLocalPdf(url);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      credentials: "include",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error;
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new Error("Timed out downloading the PDF");
    throw new Error(`Network error: ${e?.message ?? String(err)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(res.url || url).hostname}`);

  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > MAX_BYTES) throw new Error("PDF is too large to preview");

  const buf = await res.arrayBuffer();
  try {
    return toFetched(buf);
  } catch (err) {
    warn("response did not look like a PDF:", res.url, res.headers.get("content-type"), buf.byteLength, "bytes");
    throw err;
  }
}

/** Try each URL in order; return the first that yields a real PDF. */
export async function fetchFirstPdf(urls: string[]): Promise<{ pdf: FetchedPdf; url: string }> {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      return { pdf: await fetchPdf(url), url };
    } catch (err) {
      errors.push(String((err as Error)?.message ?? err));
    }
  }
  if (errors.length === 0) throw new Error("No PDF link available");
  // Most useful message first: the primary URL's failure.
  throw new Error(errors.length === 1 ? errors[0] : `${errors[0]} (and ${errors.length - 1} other source${errors.length > 2 ? "s" : ""} failed)`);
}
