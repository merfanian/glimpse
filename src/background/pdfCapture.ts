import type { FetchedPdf } from "@shared/types";

interface StreamFilter {
  ondata: ((event: { data: ArrayBuffer }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  write(data: ArrayBuffer): void;
  close(): void;
  disconnect(): void;
}

interface FirefoxWebRequest {
  filterResponseData(requestId: string): StreamFilter;
}

interface FirefoxBrowser {
  webRequest?: FirefoxWebRequest;
}

interface PendingCapture {
  promise: Promise<FetchedPdf | null>;
  resolve(pdf: FetchedPdf | null): void;
}

interface RangeAssembly {
  totalSize: number;
  chunks: Map<number, ArrayBuffer>; // byte offset → chunk data
  receivedBytes: number;
}

const OVERLEAF_COMPILE_PDF_RE =
  /^https:\/\/compiles\.overleafusercontent\.com\/.*\/output\/output\.pdf(?:[?#]|$)/i;
const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;
const CAPTURE_WAIT_MS = 8000;

// All three maps keyed by normalizeOverleafUrl(url) — stable across redirect hops.
const capturedPdfs = new Map<string, FetchedPdf>();
const pendingCaptures = new Map<string, PendingCapture>();
const rangeAssemblies = new Map<string, RangeAssembly>();

// requestId → { key, start, totalSize } populated by onHeadersReceived for 206 responses.
const requestRangeMeta = new Map<string, { key: string; start: number; totalSize: number }>();

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

function concatChunks(chunks: ArrayBuffer[], totalBytes: number): ArrayBuffer {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) {
    merged.set(new Uint8Array(c), offset);
    offset += c.byteLength;
  }
  return merged.buffer;
}

function assembleOrderedChunks(assembly: RangeAssembly): ArrayBuffer {
  const result = new Uint8Array(assembly.totalSize);
  for (const [offset, data] of assembly.chunks) {
    result.set(new Uint8Array(data), offset);
  }
  return result.buffer;
}

function looksLikePdf(buf: ArrayBuffer): boolean {
  const header = new Uint8Array(buf.slice(0, 5));
  return String.fromCharCode(...header) === "%PDF-";
}

/**
 * Normalize an Overleaf compile URL to a stable cache key, independent of whether the
 * URL is the original compile-server URL or the redirected CDN cache URL.
 *
 * Original URL:  /build/19e74adfd4e-d3616194bd0c2b82/output/output.pdf
 * CDN cache URL: /build/4c78b847-...-19e74adfd4e-d3616194bd0c2b82/output/output.pdf
 *
 * Both normalize to "projectId:19e74adfd4e-d3616194bd0c2b82".
 */
function normalizeOverleafUrl(url: string): string {
  const m = /\/project\/([^/]+)\/.*?\/build\/([^/?#]+)\/output\/output\.pdf/i.exec(url);
  if (!m) return url;
  const projectId = m[1];
  const buildSeg = m[2];
  // CDN cache URLs prepend a UUID prefix: "uuid1-uuid2-HASH1-HASH2"
  // Original build hash is always the last two dash-separated segments.
  const parts = buildSeg.split("-");
  const originalHash =
    parts.length > 2 ? `${parts[parts.length - 2]}-${parts[parts.length - 1]}` : buildSeg;
  return `${projectId}:${originalHash}`;
}

export function isOverleafCompilePdf(url: string): boolean {
  return OVERLEAF_COMPILE_PDF_RE.test(url);
}

function getOrCreatePending(key: string): PendingCapture {
  const existing = pendingCaptures.get(key);
  if (existing) return existing;
  let resolve!: (pdf: FetchedPdf | null) => void;
  const promise = new Promise<FetchedPdf | null>((res) => {
    resolve = res;
  });
  const pending = { promise, resolve };
  pendingCaptures.set(key, pending);
  return pending;
}

export async function getCapturedPdf(url: string): Promise<FetchedPdf | null> {
  if (!isOverleafCompilePdf(url)) return null;

  const key = normalizeOverleafUrl(url);

  const cached = capturedPdfs.get(key);
  if (cached) return cached;

  const pending = pendingCaptures.get(key);
  if (pending) {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), CAPTURE_WAIT_MS));
    return Promise.race<FetchedPdf | null>([pending.promise, timeout]);
  }

  return null;
}

export function installPdfCapture(): void {
  if (__BROWSER__ !== "firefox") return;

  const browserApi = (globalThis as { browser?: FirefoxBrowser }).browser;
  const webRequest = browserApi?.webRequest;
  const filterResponseData = webRequest?.filterResponseData;
  if (typeof filterResponseData !== "function" || !chrome.webRequest?.onBeforeRequest) {
    console.warn("[Glimpse] Firefox PDF response capture unavailable");
    return;
  }

  // ── Step 1: Read Content-Range headers to know each range chunk's byte offset ──
  // Must be registered before onBeforeRequest so the meta is ready when filter.onstop fires.
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (!isOverleafCompilePdf(details.url)) return;
      if (details.statusCode !== 206) return; // only partial-content responses

      const headers =
        (details as { responseHeaders?: Array<{ name: string; value?: string }> })
          .responseHeaders ?? [];
      const rangeHeader = headers.find((h) => h.name.toLowerCase() === "content-range");
      if (!rangeHeader?.value) return;

      const m = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(rangeHeader.value);
      if (!m) return;

      requestRangeMeta.set(details.requestId, {
        key: normalizeOverleafUrl(details.url),
        start: parseInt(m[1], 10),
        totalSize: parseInt(m[3], 10),
      });
    },
    { urls: ["https://compiles.overleafusercontent.com/*"] },
    ["responseHeaders"],
  );

  // ── Step 2: Install response body filters to capture PDF bytes ──
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!isOverleafCompilePdf(details.url)) return;

      const key = normalizeOverleafUrl(details.url);
      getOrCreatePending(key);

      const filter = filterResponseData.call(webRequest, details.requestId);
      const { requestId } = details;
      const localChunks: ArrayBuffer[] = [];
      let localTotal = 0;

      filter.ondata = (event) => {
        const chunk = event.data;
        localTotal += chunk.byteLength;
        if (localTotal <= MAX_CAPTURE_BYTES) localChunks.push(chunk);
        filter.write(chunk);
      };

      filter.onstop = () => {
        try {
          filter.close();
        } catch {
          /* ignore double-close */
        }

        try {
          const pending = pendingCaptures.get(key);
          if (!pending) {
            requestRangeMeta.delete(requestId);
            return;
          }

          if (localTotal === 0) {
            // Empty body — redirect hop or 404 on this request. Another request in the
            // chain (the redirect target) will supply the actual bytes. Do not resolve.
            requestRangeMeta.delete(requestId);
            return;
          }

          const rangeMeta = requestRangeMeta.get(requestId);
          requestRangeMeta.delete(requestId);

          if (rangeMeta) {
            // ── Partial Content (206): place chunk at its byte offset ──
            let assembly = rangeAssemblies.get(key);
            if (!assembly) {
              assembly = {
                totalSize: rangeMeta.totalSize,
                chunks: new Map(),
                receivedBytes: 0,
              };
              rangeAssemblies.set(key, assembly);
            }
            assembly.totalSize = rangeMeta.totalSize; // update in case an earlier chunk had a different value

            if (localTotal <= MAX_CAPTURE_BYTES) {
              const chunkData = concatChunks(localChunks, localTotal);
              assembly.chunks.set(rangeMeta.start, chunkData);
              assembly.receivedBytes += localTotal;

              if (assembly.receivedBytes >= assembly.totalSize) {
                // All range bytes received — assemble and resolve.
                // NOTE: Don't apply looksLikePdf to the assembled buffer. For range
                // responses, offset 0 may have been served from browser HTTP cache on a
                // prior page load and therefore not intercepted by filterResponseData,
                // leaving zeros at the start of the assembly. We trust the data because
                // the URL already matched OVERLEAF_COMPILE_PDF_RE; pdf.js will reject it
                // if it's not a valid PDF anyway.
                rangeAssemblies.delete(key);
                const fullData = assembleOrderedChunks(assembly);
                const pdf: FetchedPdf = {
                  dataBase64: arrayBufferToBase64(fullData),
                  contentType: "application/pdf",
                  byteLength: assembly.totalSize,
                };
                capturedPdfs.set(key, pdf);    // store BEFORE deleting pending
                pendingCaptures.delete(key);   // so any concurrent getCapturedPdf finds the cache
                pending.resolve(pdf);
              }
              // else: still waiting for more range chunks
            } else {
              // Individual chunk exceeds limit — abort assembly for this key.
              rangeAssemblies.delete(key);
              pendingCaptures.delete(key);
              pending.resolve(null);
            }
          } else {
            // ── Full response (200 OK) ──
            pendingCaptures.delete(key);
            rangeAssemblies.delete(key);

            if (localTotal > MAX_CAPTURE_BYTES) {
              pending.resolve(null);
              return;
            }

            const data = concatChunks(localChunks, localTotal);
            if (!looksLikePdf(data)) {
              pending.resolve(null);
              return;
            }

            const pdf: FetchedPdf = {
              dataBase64: arrayBufferToBase64(data),
              contentType: "application/pdf",
              byteLength: localTotal,
            };
            capturedPdfs.set(key, pdf);    // store before delete
            pendingCaptures.delete(key);
            pending.resolve(pdf);
          }
        } catch (err) {
          requestRangeMeta.delete(requestId);
          const pending = pendingCaptures.get(key);
          if (pending) {
            pendingCaptures.delete(key);
            rangeAssemblies.delete(key);
            pending.resolve(null);
          }
          void err;
        }
      };

      filter.onerror = () => {
        requestRangeMeta.delete(requestId);
        try {
          filter.disconnect();
        } catch {
          /* ignore */
        }
        // Non-fatal: other range requests for the same key may still succeed.
      };
    },
    { urls: ["https://compiles.overleafusercontent.com/*"] },
    ["blocking"],
  );
}
