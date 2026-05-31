// Fetches a remote PDF and returns its bytes as base64 so they can be passed back to
// the content script (which turns them into a blob URL for display).
import type { FetchedPdf } from "@shared/types";
import { warn } from "@shared/debug";

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB safety cap

/** Read a local file:// URL via XMLHttpRequest (fetch() doesn't work for file:// in extensions). */
function fetchLocalPdf(url: string): Promise<FetchedPdf> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => {
      // file:// requests return status 0 on success in most browsers/environments
      if (xhr.status === 0 || xhr.status === 200) {
        const buf = xhr.response as ArrayBuffer;
        const magic = new Uint8Array(buf.slice(0, 5)).reduce((s, b) => s + String.fromCharCode(b), "");
        if (magic !== "%PDF-") {
          reject(new Error("Resource is not a PDF"));
          return;
        }
        if (buf.byteLength > MAX_BYTES) {
          reject(new Error("PDF too large to preview"));
          return;
        }
        resolve({ dataBase64: arrayBufferToBase64(buf), contentType: "application/pdf", byteLength: buf.byteLength });
      } else {
        reject(new Error(`Failed to read local file (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Could not read local file — ensure the extension has 'Allow access to file URLs' enabled in about:addons"));
    xhr.send();
  });
}

export async function fetchPdf(url: string): Promise<FetchedPdf> {
  if (url.startsWith("file://")) return fetchLocalPdf(url);
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", credentials: "include" });
  } catch (err) {
    throw new Error(`PDF fetch network error: ${(err as Error).message ?? String(err)}`);
  }
  if (!res.ok) throw new Error(`PDF fetch failed (HTTP ${res.status}) for ${res.url || url}`);

  const contentType = res.headers.get("content-type") ?? "";
  const buf = await res.arrayBuffer();

  // Basic sanity check: many "pdf" links redirect to HTML landing pages.
  const looksPdf =
    contentType.includes("application/pdf") ||
    new Uint8Array(buf.slice(0, 5)).reduce((s, b) => s + String.fromCharCode(b), "") === "%PDF-";
  if (!looksPdf) {
    warn("response did not look like a PDF:", res.url, contentType, buf.byteLength, "bytes");
    throw new Error("Resource is not a PDF");
  }
  if (buf.byteLength > MAX_BYTES) throw new Error("PDF too large to preview");

  return {
    dataBase64: arrayBufferToBase64(buf),
    contentType: "application/pdf",
    byteLength: buf.byteLength,
  };
}
