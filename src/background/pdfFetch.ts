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

/** Read a local file:// URL via fetch (requires the extension to have file:// host permission). */
async function fetchLocalPdf(url: string): Promise<FetchedPdf> {
  let buf: ArrayBuffer;
  try {
    // fetch() works for file:// URLs in extension background scripts when
    // "file:///*" is listed in host_permissions and the user has enabled
    // "Allow access to local files" in about:addons (Firefox) or
    // "Allow access to file URLs" in chrome://extensions (Chrome).
    const res = await fetch(url);
    buf = await res.arrayBuffer();
  } catch {
    // Fall back to XHR — file:// responses have status 0 on success.
    buf = await new Promise<ArrayBuffer>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      xhr.onload = () => {
        if (xhr.status === 0 || xhr.status === 200) resolve(xhr.response as ArrayBuffer);
        else reject(new Error(`HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("XHR failed"));
      xhr.send();
    });
  }
  const magic = new Uint8Array(buf.slice(0, 5)).reduce((s, b) => s + String.fromCharCode(b), "");
  if (magic !== "%PDF-") throw new Error("Resource is not a PDF");
  if (buf.byteLength > MAX_BYTES) throw new Error("PDF too large to preview");
  return { dataBase64: arrayBufferToBase64(buf), contentType: "application/pdf", byteLength: buf.byteLength };
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
