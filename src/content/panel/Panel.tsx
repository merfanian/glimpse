/** @jsxImportSource preact */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import * as preact from "preact";
import * as pdfjs from "pdfjs-dist";
import { pdfWorkerReady } from "../pdfWorkerSetup";
import { renderPdfPagesInMainWorld } from "../pdfReference";
import type { RenderedPdfPages } from "../pdfReference";
import { sendMessage } from "@shared/messages";
import type {
  LookupRequest,
  LookupResponse,
  FetchPdfRequest,
  FetchPdfResponse,
} from "@shared/messages";
import type { ParsedReference, PaperCandidate, LookupResult } from "@shared/types";

interface PanelProps {
  reference: ParsedReference;
  onClose: () => void;
}

type Phase = "lookup" | "ready" | "error";
type ViewMode = "abstract" | "pdf";
type PdfLoadPhase = "idle" | "fetching" | "ready" | "error";

function confidenceLabel(c: number): { text: string; cls: string } {
  if (c >= 0.9) return { text: `High match (${Math.round(c * 100)}%)`, cls: "rp-conf-high" };
  if (c >= 0.6) return { text: `Likely match (${Math.round(c * 100)}%)`, cls: "rp-conf-med" };
  return { text: `Low confidence (${Math.round(c * 100)}%)`, cls: "rp-conf-low" };
}

export function Panel({ reference, onClose }: PanelProps) {
  const defaultViewRef = useRef<ViewMode>("abstract");
  const panelRef = useRef<HTMLDivElement>(null);

  // Lookup state
  const [phase, setPhase] = useState<Phase>("lookup");
  const [error, setError] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [selected, setSelected] = useState(-1);
  const [showAlternatives, setShowAlternatives] = useState(false);

  // View / PDF state
  const [viewMode, setViewMode] = useState<ViewMode>("abstract");
  const [pdfLoadPhase, setPdfLoadPhase] = useState<PdfLoadPhase>("idle");
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfError, setPdfError] = useState("");

  // Load default view setting once.
  useEffect(() => {
    chrome.storage.sync.get("settings", (stored) => {
      const dv = (stored?.settings as Record<string, unknown>)?.defaultView;
      if (dv === "pdf") defaultViewRef.current = "pdf";
    });
  }, []);

  // Reset and run lookup whenever reference changes.
  useEffect(() => {
    let cancelled = false;
    setPhase("lookup");
    setError("");
    setResult(null);
    setSelected(-1);
    setShowAlternatives(false);
    setViewMode("abstract");
    setPdfBytes(null);
    setPdfLoadPhase("idle");
    setPdfError("");

    (async () => {
      const resp = await sendMessage<LookupRequest, LookupResponse>({
        type: "lookup",
        reference,
      });
      if (cancelled) return;
      if (!resp.ok) {
        setError(resp.error);
        setPhase("error");
        return;
      }
      setResult(resp.result);
      setSelected(resp.result.bestIndex);
      setPhase("ready");
      if (defaultViewRef.current === "pdf") setViewMode("pdf");
    })();

    return () => { cancelled = true; };
  }, [reference]);

  // Reset PDF state when the selected candidate changes.
  useEffect(() => {
    setPdfBytes(null);
    setPdfLoadPhase("idle");
    setPdfError("");
    if (viewMode === "pdf") setViewMode("abstract");
  }, [selected]);

  const candidate: PaperCandidate | undefined =
    result && selected >= 0 ? result.candidates[selected] : undefined;

  // Lazily fetch PDF when PDF mode is activated.
  useEffect(() => {
    if (viewMode !== "pdf" || phase !== "ready") return;
    if (pdfBytes || pdfLoadPhase !== "idle") return;

    if (!candidate?.pdfUrl) {
      setPdfError("No PDF available for this paper.");
      setPdfLoadPhase("error");
      return;
    }

    setPdfLoadPhase("fetching");
    console.log(
      "[RefPrev][cs] preview PDF fetch:",
      JSON.stringify({ source: candidate.source, url: candidate.pdfUrl, title: candidate.title }),
    );
    sendMessage<FetchPdfRequest, FetchPdfResponse>({
      type: "fetchPdf",
      url: candidate.pdfUrl,
    }).then((resp) => {
      if (!resp.ok) {
        console.warn("[RefPrev][cs] preview PDF fetch failed:", resp.error);
        setPdfError(resp.error);
        setPdfLoadPhase("error");
        return;
      }
      if (!resp.pdf.dataBase64) {
        setPdfError("No PDF data returned.");
        setPdfLoadPhase("error");
        return;
      }
      // Decode base64 → Uint8Array for pdfjs canvas rendering.
      const bin = atob(resp.pdf.dataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      setPdfBytes(bytes);
      setPdfLoadPhase("ready");
    });
  }, [viewMode, phase, candidate?.pdfUrl]);

  const openInNewTab = () => {
    const url = candidate?.url ?? candidate?.pdfUrl;
    if (url) window.open(url, "_blank", "noopener");
  };

  const conf = candidate ? confidenceLabel(candidate.confidence) : null;
  const showWarning =
    !!candidate && (candidate.confidence < 0.9 || (result?.candidates.length ?? 0) > 1);

  const paperTitle =
    candidate?.title ?? reference.title ?? reference.doi ?? reference.raw.slice(0, 80);

  return (
    <div class="rp-panel" ref={panelRef}>
      <PanelHeader title={paperTitle} onClose={onClose} />

      <div class="rp-body">
        {phase === "lookup" && (
          <div class="rp-status">Searching…</div>
        )}

        {phase === "error" && (
          <div class="rp-status rp-error">
            <p>Couldn't find this reference.</p>
            <p class="rp-error-detail">{error}</p>
            <p class="rp-raw">{reference.raw}</p>
          </div>
        )}

        {phase === "ready" && !candidate && (
          <div class="rp-status rp-error">
            <p>No matching paper found.</p>
            <p class="rp-raw">{reference.raw}</p>
          </div>
        )}

        {phase === "ready" && candidate && (
          <>
            {conf && (
              <div class={`rp-banner ${showWarning ? "rp-banner-warn" : ""}`}>
                <span class={`rp-conf ${conf.cls}`}>{conf.text}</span>
                {(result?.candidates.length ?? 0) > 1 && (
                  <button
                    class="rp-link-btn"
                    onClick={() => setShowAlternatives((v) => !v)}
                  >
                    {showAlternatives
                      ? "Hide alternatives"
                      : `Other matches (${result!.candidates.length - 1})`}
                  </button>
                )}
              </div>
            )}

            {showAlternatives && result && (
              <ul class="rp-alts">
                {result.candidates.map((c, i) => (
                  <li
                    key={`${c.source}-${i}`}
                    class={i === selected ? "rp-alt rp-alt-active" : "rp-alt"}
                    onClick={() => {
                      setSelected(i);
                      setShowAlternatives(false);
                    }}
                  >
                    <span class="rp-alt-conf">{Math.round(c.confidence * 100)}%</span>
                    <span class="rp-alt-title">{c.title}</span>
                    <span class="rp-alt-meta">{c.year ?? "—"} · {c.source}</span>
                  </li>
                ))}
              </ul>
            )}

            {viewMode === "abstract" && (
              <div class="rp-abstract-view">
                <h2 class="rp-paper-title">{candidate.title}</h2>
                <p class="rp-paper-meta">
                  {candidate.authors.slice(0, 3).join(", ")}
                  {candidate.authors.length > 3 ? " et al." : ""}
                  {candidate.year ? ` · ${candidate.year}` : ""}
                  {candidate.venue ? ` · ${candidate.venue}` : ""}
                </p>
                <div class="rp-abstract-body">
                  {candidate.abstract ? (
                    <p class="rp-abstract-text">{candidate.abstract}</p>
                  ) : (
                    <p class="rp-muted">No abstract available.</p>
                  )}
                </div>
              </div>
            )}

            {viewMode === "pdf" && (
              <div class="rp-pdf-view">
                {pdfLoadPhase === "fetching" && (
                  <div class="rp-pdf-loading">Fetching PDF…</div>
                )}
                {pdfLoadPhase === "error" && (
                  <div class="rp-status rp-error">{pdfError}</div>
                )}
                {pdfLoadPhase === "ready" && pdfBytes && (
                  <PdfCanvasRenderer bytes={pdfBytes} />
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div class="rp-footer">
        <ResizeGrip panelRef={panelRef} />
        <div class="rp-footer-btns">
          {phase === "ready" && candidate && (
            <>
              {viewMode === "abstract" ? (
                candidate.pdfUrl && (
                  <button class="rp-btn" onClick={() => setViewMode("pdf")}>
                    Show full PDF
                  </button>
                )
              ) : (
                <button class="rp-btn rp-btn-secondary" onClick={() => setViewMode("abstract")}>
                  ← Abstract
                </button>
              )}
              <button class="rp-btn rp-btn-secondary" onClick={openInNewTab}>
                Open in new tab
              </button>
            </>
          )}
          <button class="rp-btn rp-btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bottom-left resize grip (CSS resize handle is always bottom-right which is
// inaccessible when the panel is docked to the right edge of the screen).
// ---------------------------------------------------------------------------

function ResizeGrip({ panelRef }: { panelRef: preact.RefObject<HTMLDivElement> }) {
  const gripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const grip = gripRef.current;
    if (!grip) return;

    let startX = 0, startY = 0, startW = 0, startH = 0, startLeft = 0;

    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startW = rect.width;
      startH = rect.height;
      startLeft = rect.left;
      // Anchor right edge so expanding left doesn't move the panel rightward
      panel.style.right = "auto";
      panel.style.left = `${startLeft}px`;
      grip.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      if (!grip.hasPointerCapture(e.pointerId)) return;
      const panel = panelRef.current;
      if (!panel) return;
      const dx = e.clientX - startX; // negative = grow left
      const dy = e.clientY - startY; // positive = grow down
      const newW = Math.max(360, startW - dx);
      const newH = Math.max(260, startH + dy);
      const newLeft = startLeft + (startW - newW);
      panel.style.width = `${newW}px`;
      panel.style.height = `${newH}px`;
      panel.style.left = `${newLeft}px`;
    };

    const onUp = (e: PointerEvent) => {
      try { grip.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };

    grip.addEventListener("pointerdown", onDown);
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    return () => {
      grip.removeEventListener("pointerdown", onDown);
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
    };
  }, [panelRef]);

  return <div class="rp-resize-grip" ref={gripRef} />;
}

// ---------------------------------------------------------------------------
// Canvas-based PDF renderer for Chrome/Edge (no iframe — works inside shadow DOM)
// ---------------------------------------------------------------------------

type CanvasState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; numPages: number };

function PdfChromeRenderer({ bytes }: { bytes: Uint8Array }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasState, setCanvasState] = useState<CanvasState>({ kind: "loading" });
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const isRenderingRef = useRef(false);
  const rerenderQueuedRef = useRef(false);

  const renderAll = useCallback(async () => {
    const doc = docRef.current;
    const container = containerRef.current;
    if (!doc || !container) return;

    if (isRenderingRef.current) {
      rerenderQueuedRef.current = true;
      return;
    }
    isRenderingRef.current = true;

    const availableWidth = Math.max(container.clientWidth - 8, 200);
    const dpr = window.devicePixelRatio || 1;

    for (let i = 1; i <= doc.numPages; i++) {
      const canvas = container.children[i - 1] as HTMLCanvasElement | null;
      if (!canvas || canvas.tagName !== "CANVAS") break;

      const page = await doc.getPage(i);
      const naturalVp = page.getViewport({ scale: 1 });
      const scale = (availableWidth / naturalVp.width) * dpr;
      const viewport = page.getViewport({ scale });

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
      }
    }

    isRenderingRef.current = false;
    if (rerenderQueuedRef.current) {
      rerenderQueuedRef.current = false;
      void renderAll();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCanvasState({ kind: "loading" });
    docRef.current?.destroy();
    docRef.current = null;

    pdfWorkerReady
      .then(() =>
        pdfjs.getDocument({
          data: bytes.slice(),
          disableRange: true,
          disableStream: true,
          isEvalSupported: false,
        }).promise,
      )
      .then((doc) => {
        if (cancelled) { doc.destroy(); return; }
        docRef.current = doc;
        setCanvasState({ kind: "ready", numPages: doc.numPages });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setCanvasState({ kind: "error", message: (err as Error).message ?? String(err) });
      });

    return () => {
      cancelled = true;
      docRef.current?.destroy();
      docRef.current = null;
    };
  }, [bytes]);

  useEffect(() => {
    if (canvasState.kind !== "ready") return;
    void renderAll();
  }, [canvasState, renderAll]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let timer: number;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void renderAll(), 150);
    });
    ro.observe(container);
    return () => { ro.disconnect(); clearTimeout(timer); };
  }, [renderAll]);

  return (
    <div class="rp-pdf-canvas-container" ref={containerRef}>
      {canvasState.kind === "loading" && (
        <div class="rp-pdf-loading">Rendering PDF…</div>
      )}
      {canvasState.kind === "error" && (
        <div class="rp-status rp-error">{canvasState.message}</div>
      )}
      {canvasState.kind === "ready" &&
        Array.from({ length: canvasState.numPages }, (_, i) => (
          <canvas key={i} class="rp-pdf-page" />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Firefox PDF renderer: delegates all rendering to the page's MAIN world via
// the pageFetch.ts bridge to avoid Xray-wrapper restrictions on DOM APIs that
// pdf.js calls internally (font measurement, canvas operations, etc.).
// The MAIN world has no Xray restrictions, so pdf.js renders correctly there.
// ---------------------------------------------------------------------------

type FirefoxRenderState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; pages: RenderedPdfPages };

function PdfFirefoxRenderer({ bytes }: { bytes: Uint8Array }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<FirefoxRenderState>({ kind: "loading" });
  const revokeRef = useRef<string[]>([]);
  // Keep a ref so the stable renderAtCurrentWidth callback always sees the latest bytes.
  const bytesRef = useRef(bytes);
  bytesRef.current = bytes;
  // Prevent concurrent renders; queue one re-render if a resize arrives while rendering.
  const isRenderingRef = useRef(false);
  const rerenderQueuedRef = useRef(false);

  // Revoke all blob URLs on unmount.
  useEffect(() => {
    return () => {
      revokeRef.current.forEach(u => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
    };
  }, []);

  // Stable callback — reads container width at call time, like Chrome's renderAll().
  const renderAtCurrentWidth = useCallback(async () => {
    if (isRenderingRef.current) {
      rerenderQueuedRef.current = true;
      return;
    }
    isRenderingRef.current = true;
    const availableWidth = Math.max((containerRef.current?.clientWidth ?? 0) - 8, 300) || 680;
    try {
      const pages = await renderPdfPagesInMainWorld(bytesRef.current, availableWidth);
      revokeRef.current.forEach(u => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
      revokeRef.current = pages.pageUrls;
      setState({ kind: "ready", pages });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message ?? String(err) });
    } finally {
      isRenderingRef.current = false;
      if (rerenderQueuedRef.current) {
        rerenderQueuedRef.current = false;
        void renderAtCurrentWidth();
      }
    }
  }, []); // stable — only uses refs

  // Re-render from scratch when bytes change (new paper selected).
  useEffect(() => {
    setState({ kind: "loading" });
    revokeRef.current.forEach(u => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
    revokeRef.current = [];
    void renderAtCurrentWidth();
  }, [bytes, renderAtCurrentWidth]);

  // Re-render when the panel is resized (mirrors Chrome's ResizeObserver logic).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let timer: number;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void renderAtCurrentWidth(), 150);
    });
    ro.observe(container);
    return () => { ro.disconnect(); clearTimeout(timer); };
  }, [renderAtCurrentWidth]);

  return (
    <div class="rp-pdf-canvas-container" ref={containerRef}>
      {state.kind === "loading" && (
        <div class="rp-pdf-loading">Rendering PDF…</div>
      )}
      {state.kind === "error" && (
        <div class="rp-status rp-error">{state.message}</div>
      )}
      {state.kind === "ready" && state.pages.pageUrls.map((url, i) => {
        const dim = state.pages.pageDimensions[i];
        return (
          <img
            key={i}
            src={url}
            class="rp-pdf-page"
            width={dim?.cssWidth}
            height={dim?.cssHeight}
            alt={`Page ${i + 1}`}
          />
        );
      })}
    </div>
  );
}

// Dispatches to the browser-appropriate renderer.
function PdfCanvasRenderer({ bytes }: { bytes: Uint8Array }) {
  if (__BROWSER__ === "firefox") {
    return <PdfFirefoxRenderer bytes={bytes} />;
  }
  return <PdfChromeRenderer bytes={bytes} />;
}

// ---------------------------------------------------------------------------
// Panel header with drag support
// ---------------------------------------------------------------------------

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const headerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const panel = header.closest(".rp-panel") as HTMLElement | null;
    if (!panel) return;

    let startX = 0, startY = 0, originLeft = 0, originTop = 0, dragging = false;

    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(".rp-close")) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      originLeft = rect.left; originTop = rect.top;
      startX = e.clientX; startY = e.clientY;
      panel.style.right = "auto";
      panel.style.left = `${originLeft}px`;
      panel.style.top = `${originTop}px`;
      header.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      panel.style.left = `${originLeft + (e.clientX - startX)}px`;
      panel.style.top = `${originTop + (e.clientY - startY)}px`;
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      try { header.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };

    header.addEventListener("pointerdown", onDown);
    header.addEventListener("pointermove", onMove);
    header.addEventListener("pointerup", onUp);
    return () => {
      header.removeEventListener("pointerdown", onDown);
      header.removeEventListener("pointermove", onMove);
      header.removeEventListener("pointerup", onUp);
    };
  }, []);

  const short = title.length > 80 ? title.slice(0, 80) + "…" : title;

  return (
    <div class="rp-header" ref={headerRef}>
      <span class="rp-header-title" title={title}>{short}</span>
      <button class="rp-close" onClick={onClose} aria-label="Close">✕</button>
    </div>
  );
}
