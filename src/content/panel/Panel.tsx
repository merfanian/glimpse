/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { sendMessage } from "@shared/messages";
import type {
  LookupRequest,
  LookupDetailsRequest,
  LookupResponse,
  FetchPdfRequest,
  FetchPdfResponse,
} from "@shared/messages";
import type { ParsedReference, PaperCandidate, LookupResult } from "@shared/types";
import { getSettings } from "@shared/settings";
import { base64ToUint8Array } from "../pdfReference";
import { openPdfBackend, PdfPagesView } from "./pdfView";
import { toBibtex, toPlainCitation } from "@shared/cite";

// ─────────────────────────────────────────────────────────────────────────────
// Geometry (position + size), remembered across panels and page loads
// ─────────────────────────────────────────────────────────────────────────────

export interface Geometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

const MIN_W = 320;
const MIN_H = 240;
const MARGIN = 8;

function viewport(): { vw: number; vh: number } {
  return {
    vw: document.documentElement.clientWidth || window.innerWidth,
    vh: document.documentElement.clientHeight || window.innerHeight,
  };
}

function defaultGeometry(): Geometry {
  const { vw, vh } = viewport();
  const width = Math.min(Math.max(420, Math.round(vw * 0.36)), 760);
  const height = Math.min(Math.round(vh * 0.84), 980);
  return { left: vw - width - 24, top: Math.max(MARGIN, Math.round(vh * 0.06)), width, height };
}

/** Keep the whole panel on screen (shrinking it if the window got smaller). */
export function clampGeometry(g: Geometry): Geometry {
  const { vw, vh } = viewport();
  const width = Math.max(Math.min(g.width, vw - 2 * MARGIN), Math.min(MIN_W, vw - 2 * MARGIN));
  const height = Math.max(Math.min(g.height, vh - 2 * MARGIN), Math.min(MIN_H, vh - 2 * MARGIN));
  const left = Math.min(Math.max(MARGIN, g.left), Math.max(MARGIN, vw - width - MARGIN));
  const top = Math.min(Math.max(MARGIN, g.top), Math.max(MARGIN, vh - height - MARGIN));
  return { left, top, width, height };
}

let savedGeometry: Geometry | null = null;
const GEOMETRY_KEY = "panelGeometry";

export function loadSavedGeometry(): void {
  try {
    chrome.storage.local.get(GEOMETRY_KEY, (v) => {
      void chrome.runtime.lastError;
      const g = v?.[GEOMETRY_KEY] as Geometry | undefined;
      if (g && [g.left, g.top, g.width, g.height].every((n) => typeof n === "number" && isFinite(n))) {
        savedGeometry ??= g;
      }
    });
  } catch {
    /* storage unavailable */
  }
}

function persistGeometry(g: Geometry): void {
  savedGeometry = g;
  try {
    void chrome.storage.local.set({ [GEOMETRY_KEY]: g });
  } catch {
    /* ignore */
  }
}

function applyGeometry(el: HTMLElement, g: Geometry): void {
  el.style.left = `${g.left}px`;
  el.style.top = `${g.top}px`;
  el.style.width = `${g.width}px`;
  el.style.height = `${g.height}px`;
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell: frame, dragging, resizing, Escape. Persists while its content changes.
// ─────────────────────────────────────────────────────────────────────────────

export function PanelShell({ onClose, children }: { onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const geom = useRef<Geometry>(clampGeometry(savedGeometry ?? defaultGeometry()));

  useEffect(() => {
    const panel = ref.current!;
    applyGeometry(panel, geom.current);

    type Mode = { kind: "move" } | { kind: "resize"; dir: "sw" | "se" };
    let mode: Mode | null = null;
    let sx = 0, sy = 0;
    let start: Geometry = geom.current;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      const grip = t.closest<HTMLElement>("[data-resize]");
      if (grip) {
        mode = { kind: "resize", dir: grip.dataset.resize as "sw" | "se" };
      } else if (t.closest(".rp-header") && !t.closest("button, a, input")) {
        mode = { kind: "move" };
      } else {
        return;
      }
      e.preventDefault();
      sx = e.clientX;
      sy = e.clientY;
      start = { ...geom.current };
      panel.setPointerCapture(e.pointerId);
      panel.classList.add("rp-panel-busy");
    };

    const onMove = (e: PointerEvent) => {
      if (!mode) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      const { vw, vh } = viewport();
      let g: Geometry;
      if (mode.kind === "move") {
        g = clampGeometry({ ...start, left: start.left + dx, top: start.top + dy });
      } else if (mode.dir === "se") {
        g = {
          ...start,
          width: Math.min(Math.max(MIN_W, start.width + dx), vw - start.left - MARGIN),
          height: Math.min(Math.max(MIN_H, start.height + dy), vh - start.top - MARGIN),
        };
      } else {
        const right = start.left + start.width;
        const width = Math.min(Math.max(MIN_W, start.width - dx), right - MARGIN);
        g = {
          ...start,
          left: right - width,
          width,
          height: Math.min(Math.max(MIN_H, start.height + dy), vh - start.top - MARGIN),
        };
      }
      geom.current = g;
      applyGeometry(panel, g);
    };

    const onUp = (e: PointerEvent) => {
      if (!mode) return;
      mode = null;
      panel.classList.remove("rp-panel-busy");
      try {
        panel.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      persistGeometry(geom.current);
    };

    const onResize = () => {
      geom.current = clampGeometry(geom.current);
      applyGeometry(panel, geom.current);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const insidePanel = e.composedPath().includes(panel);
      if (!insidePanel && isEditable(e.target)) return; // e.g. typing in Overleaf's editor
      onClose();
    };

    panel.addEventListener("pointerdown", onDown);
    panel.addEventListener("pointermove", onMove);
    panel.addEventListener("pointerup", onUp);
    panel.addEventListener("pointercancel", onUp);
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKey, true);
    return () => {
      panel.removeEventListener("pointerdown", onDown);
      panel.removeEventListener("pointermove", onMove);
      panel.removeEventListener("pointerup", onUp);
      panel.removeEventListener("pointercancel", onUp);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div class="rp-panel" ref={ref} role="dialog" aria-label="Glimpse citation preview">
      {children}
      <div class="rp-grip rp-grip-sw" data-resize="sw" title="Drag to resize" aria-hidden="true" />
      <div class="rp-grip rp-grip-se" data-resize="se" title="Drag to resize" aria-hidden="true" />
    </div>
  );
}

const logoUrl = (() => {
  try {
    return chrome.runtime.getURL("icons/icon-48.png");
  } catch {
    return "";
  }
})();

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div class="rp-header" title="Drag to move">
      {logoUrl && <img class="rp-header-logo" src={logoUrl} width={18} height={18} alt="" />}
      <span class="rp-header-title" title={title}>
        {title}
      </span>
      <button class="rp-close" onClick={onClose} aria-label="Close preview" title="Close (Esc)">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div class="rp-loading" role="status">
      <span class="rp-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function scholarUrl(reference: ParsedReference, candidate?: PaperCandidate): string {
  const q = candidate?.title ?? reference.title ?? reference.raw.slice(0, 250);
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`;
}

/** Copy text to the clipboard; falls back to execCommand on non-secure (http) pages. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* not a secure context, or no permission */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function CiteMenu({ candidate }: { candidate: PaperCandidate }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<"" | "ok" | "fail">("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (ref.current && !e.composedPath().includes(ref.current)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(""), 1800);
    return () => clearTimeout(t);
  }, [done]);

  const copy = async (text: string) => {
    setOpen(false);
    setDone((await copyText(text)) ? "ok" : "fail");
  };

  return (
    <div class="rp-cite" ref={ref}>
      <button
        class="rp-btn rp-btn-secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Copy a citation for this paper"
        onClick={() => setOpen((v) => !v)}
      >
        {done === "ok" ? "Copied ✓" : done === "fail" ? "Copy failed" : "Cite"}
      </button>
      {open && (
        <div class="rp-cite-menu" role="menu">
          <button role="menuitem" class="rp-cite-item" onClick={() => void copy(toBibtex(candidate))}>
            <span class="rp-cite-item-title">Copy BibTeX</span>
            <span class="rp-cite-item-desc">For LaTeX / Overleaf</span>
          </button>
          <button role="menuitem" class="rp-cite-item" onClick={() => void copy(toPlainCitation(candidate))}>
            <span class="rp-cite-item-title">Copy citation</span>
            <span class="rp-cite-item-desc">Formatted text reference</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ExternalIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" class="rp-ext-icon">
      <path d="M5 2H2v8h8V7M7 2h3v3M10 2L5.5 6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple views
// ─────────────────────────────────────────────────────────────────────────────

export function LoadingView({ onClose }: { onClose: () => void }) {
  return (
    <>
      <Header title="Glimpse" onClose={onClose} />
      <div class="rp-body">
        <Spinner label="Reading this PDF's bibliography…" />
      </div>
    </>
  );
}

export function ErrorView({ title, detail, onClose }: { title: string; detail: string; onClose: () => void }) {
  return (
    <>
      <Header title="Glimpse" onClose={onClose} />
      <div class="rp-body rp-scroll">
        <div class="rp-message">
          <p class="rp-message-title">{title}</p>
          <p class="rp-message-detail">{detail}</p>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference view: lookup → abstract / PDF
// ─────────────────────────────────────────────────────────────────────────────

type LookupState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "done"; result: LookupResult };

type PdfState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; bytes: Uint8Array; url: string };

function identity(c: PaperCandidate): string[] {
  const keys: string[] = [];
  if (c.doi) keys.push(`doi:${c.doi.toLowerCase()}`);
  if (c.arxivId) keys.push(`arxiv:${c.arxivId.replace(/v\d+$/, "").toLowerCase()}`);
  keys.push(`title:${c.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`);
  return keys;
}

/**
 * Patch late details (TL;DR, abstract, PDF links) into the candidates already on screen,
 * without reordering them or changing which one is selected.
 */
function mergeDetails(shown: LookupResult, full: LookupResult): LookupResult {
  const byKey = new Map<string, PaperCandidate>();
  for (const c of full.candidates) for (const k of identity(c)) if (!byKey.has(k)) byKey.set(k, c);
  let changed = false;
  const candidates = shown.candidates.map((c) => {
    const match = identity(c).map((k) => byKey.get(k)).find(Boolean);
    if (!match) return c;
    const patch: Partial<PaperCandidate> = {};
    if (!c.tldr && match.tldr) patch.tldr = match.tldr;
    if (!c.abstract && match.abstract) patch.abstract = match.abstract;
    if (!c.pdfUrl && match.pdfUrl) {
      patch.pdfUrl = match.pdfUrl;
      patch.pdfUrls = match.pdfUrls;
    }
    if (Object.keys(patch).length === 0) return c;
    changed = true;
    return { ...c, ...patch };
  });
  return changed ? { ...shown, candidates } : shown;
}

/** Below this, the best candidate is offered as a "possible match" rather than shown. */
const MIN_SHOWN_CONFIDENCE = 0.45;

function confidenceLabel(c: number): { text: string; cls: string } {
  const pct = Math.round(c * 100);
  if (c >= 0.85) return { text: `Strong match · ${pct}%`, cls: "rp-conf-high" };
  if (c >= 0.6) return { text: `Likely match · ${pct}%`, cls: "rp-conf-med" };
  return { text: `Uncertain match · ${pct}%`, cls: "rp-conf-low" };
}

function pdfUrlsOf(c?: PaperCandidate): string[] {
  if (!c) return [];
  const urls = c.pdfUrls?.length ? c.pdfUrls : c.pdfUrl ? [c.pdfUrl] : [];
  return urls.filter(Boolean);
}

function authorLine(c: PaperCandidate): string {
  return c.authors.slice(0, 6).join(", ") + (c.authors.length > 6 ? ", et al." : "");
}

const SOURCE_NAMES: Record<PaperCandidate["source"], string> = {
  semanticscholar: "Semantic Scholar",
  arxiv: "arXiv",
  crossref: "Crossref",
  openalex: "OpenAlex",
};

export function ReferenceView({ reference, onClose }: { reference: ParsedReference; onClose: () => void }) {
  const [lookup, setLookup] = useState<LookupState>({ status: "loading" });
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<"abstract" | "pdf">("abstract");
  const [showAlts, setShowAlts] = useState(false);
  const [pdf, setPdf] = useState<PdfState>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  /** The user explicitly chose a low-confidence candidate from "Possible matches". */
  const [picked, setPicked] = useState(false);
  const [pageInfo, setPageInfo] = useState<{ page: number; total: number } | null>(null);
  // Finished PDF downloads per candidate (by URL list), so switching views/candidates is instant.
  const pdfCache = useRef(new Map<string, Promise<PdfState>>());

  // ── Lookup (re-runs for a new reference or on Retry) ──
  useEffect(() => {
    let cancelled = false;
    setLookup({ status: "loading" });
    setSelected(0);
    setShowAlts(false);
    setView("abstract");
    setPageInfo(null);
    void Promise.all([
      sendMessage<LookupRequest, LookupResponse>({ type: "lookup", reference }),
      getSettings(),
    ]).then(([resp, settings]) => {
      if (cancelled) return;
      if (!resp.ok) {
        setLookup({ status: "error", error: resp.error });
        return;
      }
      const best = Math.max(0, resp.result.bestIndex);
      setLookup({ status: "done", result: resp.result });
      setSelected(best);
      setPicked(false);
      const top = resp.result.candidates[best];
      if (settings.defaultView === "pdf" && top && top.confidence >= MIN_SHOWN_CONFIDENCE && pdfUrlsOf(top).length) {
        setView("pdf");
      }
      // The first answer arrives as soon as one source is confident; slower sources (notably
      // Semantic Scholar, the only one with TL;DRs) may still add details. Fetch them.
      if (resp.result.candidates.length === 0 || resp.result.candidates.some((c) => !c.tldr)) {
        void sendMessage<LookupDetailsRequest, LookupResponse>({ type: "lookupDetails", reference }).then((more) => {
          if (cancelled || !more.ok) return;
          setLookup((cur) => {
            if (cur.status !== "done") return cur;
            if (cur.result.candidates.length === 0) return { status: "done", result: more.result };
            return { status: "done", result: mergeDetails(cur.result, more.result) };
          });
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reference, attempt]);

  const candidates = lookup.status === "done" ? lookup.result.candidates : [];
  const selectedCandidate: PaperCandidate | undefined = candidates[selected];
  // A weak guess is not presented as "the" paper; it's offered under "Possible matches".
  const candidate: PaperCandidate | undefined =
    selectedCandidate && (selectedCandidate.confidence >= MIN_SHOWN_CONFIDENCE || picked) ? selectedCandidate : undefined;
  const urls = pdfUrlsOf(candidate);
  const pdfKey = urls.join("\n");

  // ── PDF download for the selected candidate (only while the PDF view is shown) ──
  useEffect(() => {
    if (view !== "pdf" || !candidate) return;
    if (!pdfKey) {
      setPdf({ status: "error", error: "No open-access PDF is known for this paper." });
      return;
    }
    let cancelled = false;
    let p = pdfCache.current.get(pdfKey);
    if (!p) {
      p = sendMessage<FetchPdfRequest, FetchPdfResponse>({ type: "fetchPdf", urls }).then(
        (resp): PdfState => {
          if (!resp.ok) return { status: "error", error: resp.error };
          if (!resp.pdf.dataBase64) return { status: "error", error: "The PDF download was empty." };
          return { status: "ready", bytes: base64ToUint8Array(resp.pdf.dataBase64), url: resp.url };
        },
      );
      pdfCache.current.set(pdfKey, p);
      // Failures aren't cached so Retry really retries.
      void p.then((s) => s.status === "error" && pdfCache.current.delete(pdfKey));
    }
    setPdf({ status: "loading" });
    void p.then((s) => {
      if (!cancelled) setPdf(s);
    });
    return () => {
      cancelled = true;
    };
  }, [view, pdfKey, attempt]);

  useEffect(() => setPageInfo(null), [view, pdfKey]);

  const retry = () => setAttempt((n) => n + 1);

  const headerTitle =
    candidate?.title ?? (lookup.status === "loading" ? reference.title ?? "Looking up…" : "Glimpse");

  return (
    <>
      <Header title={headerTitle} onClose={onClose} />

      <div class="rp-body">
        {lookup.status === "loading" && (
          <div class="rp-scroll">
            <div class="rp-skeleton" role="status" aria-label="Finding this paper">
              <div class="rp-skel rp-skel-title" />
              <div class="rp-skel rp-skel-title2" />
              <div class="rp-skel rp-skel-meta" />
              <div class="rp-skel rp-skel-line" />
              <div class="rp-skel rp-skel-line" />
              <div class="rp-skel rp-skel-line short" />
            </div>
            <ReferenceBox reference={reference} open />
          </div>
        )}

        {lookup.status === "error" && (
          <div class="rp-scroll">
            <div class="rp-message">
              <p class="rp-message-title">The lookup failed</p>
              <p class="rp-message-detail">{lookup.error}</p>
            </div>
            <ReferenceBox reference={reference} open />
          </div>
        )}

        {lookup.status === "done" && !candidate && (
          <div class="rp-scroll">
            <div class="rp-message">
              <p class="rp-message-title">No confident match found</p>
              <p class="rp-message-detail">
                Semantic Scholar, arXiv, Crossref and OpenAlex didn't return a paper that clearly
                matches this reference. It may be a report, book or web page.
              </p>
            </div>
            <ReferenceBox reference={reference} open />
            {candidates.length > 0 && (
              <div class="rp-possible">
                <p class="rp-section-label">Possible matches</p>
                <ul class="rp-alts rp-alts-inline">
                  {candidates.map((c, i) => (
                    <li
                      key={`${c.source}-${i}`}
                      class="rp-alt"
                      title="Show this paper"
                      onClick={() => {
                        setSelected(i);
                        setPicked(true);
                      }}
                    >
                      <span class="rp-alt-conf">{Math.round(c.confidence * 100)}%</span>
                      <span class="rp-alt-title">{c.title}</span>
                      <span class="rp-alt-meta">{c.year ?? "—"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {lookup.status === "done" && candidate && (
          <>
            <ConfidenceBanner
              candidate={candidate}
              count={candidates.length}
              showAlts={showAlts}
              onToggle={() => setShowAlts((v) => !v)}
            />
            {showAlts && (
              <ul class="rp-alts" role="listbox">
                {candidates.map((c, i) => (
                  <li
                    key={`${c.source}-${i}`}
                    role="option"
                    aria-selected={i === selected}
                    class={i === selected ? "rp-alt rp-alt-active" : "rp-alt"}
                    onClick={() => {
                      setSelected(i);
                      setPicked(true);
                      setShowAlts(false);
                    }}
                  >
                    <span class="rp-alt-conf">{Math.round(c.confidence * 100)}%</span>
                    <span class="rp-alt-title">{c.title}</span>
                    <span class="rp-alt-meta">{c.year ?? "—"}</span>
                  </li>
                ))}
              </ul>
            )}

            {view === "abstract" ? (
              <div class="rp-scroll rp-abstract-view">
                <h2 class="rp-paper-title">
                  {candidate.url ? (
                    <a href={candidate.url} target="_blank" rel="noopener noreferrer">
                      {candidate.title}
                    </a>
                  ) : (
                    candidate.title
                  )}
                </h2>
                {candidate.authors.length > 0 && <p class="rp-paper-authors">{authorLine(candidate)}</p>}
                {(candidate.year || candidate.venue) && (
                  <div class="rp-chips">
                    {candidate.year && <span class="rp-chip rp-chip-year">{candidate.year}</span>}
                    {candidate.venue && (
                      <span class="rp-chip" title={candidate.venue}>
                        {candidate.venue}
                      </span>
                    )}
                  </div>
                )}
                {candidate.tldr && (
                  <div class="rp-tldr">
                    <p class="rp-tldr-label">
                      TL;DR <span class="rp-tldr-source">· Semantic Scholar</span>
                    </p>
                    <p class="rp-tldr-text">{candidate.tldr}</p>
                  </div>
                )}
                <p class="rp-section-label">Abstract</p>
                {candidate.abstract ? (
                  <p class="rp-abstract-text">{candidate.abstract}</p>
                ) : (
                  <p class="rp-muted">No abstract available from the metadata sources.</p>
                )}
                <ReferenceBox reference={reference} />
              </div>
            ) : (
              <PdfPane
                state={pdf}
                candidate={candidate}
                reference={reference}
                onRetry={retry}
                onPage={(page, total) => setPageInfo({ page, total })}
              />
            )}
          </>
        )}
      </div>

      <div class="rp-footer">
        {lookup.status === "done" && candidate ? (
          <>
            <div class="rp-segmented" role="tablist" aria-label="Preview mode">
              <button
                role="tab"
                aria-selected={view === "abstract"}
                class={view === "abstract" ? "rp-seg rp-seg-on" : "rp-seg"}
                onClick={() => setView("abstract")}
              >
                Abstract
              </button>
              <button
                role="tab"
                aria-selected={view === "pdf"}
                class={view === "pdf" ? "rp-seg rp-seg-on" : "rp-seg"}
                disabled={urls.length === 0}
                title={urls.length ? "Show the full PDF" : "No open-access PDF found"}
                onClick={() => setView("pdf")}
              >
                Full PDF
              </button>
            </div>
            {view === "pdf" && pageInfo && (
              <span class="rp-page-info">
                {pageInfo.page} / {pageInfo.total}
              </span>
            )}
            <span class="rp-spacer" />
            <CiteMenu candidate={candidate} />
            {candidate.url && (
              <a class="rp-btn rp-btn-secondary" href={candidate.url} target="_blank" rel="noopener noreferrer">
                Open <ExternalIcon />
              </a>
            )}
          </>
        ) : (
          <>
            <span class="rp-spacer" />
            {lookup.status !== "loading" && (
              <>
                <button class="rp-btn rp-btn-secondary" onClick={retry}>
                  Retry
                </button>
                <a class="rp-btn" href={scholarUrl(reference)} target="_blank" rel="noopener noreferrer">
                  Search Google Scholar <ExternalIcon />
                </a>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ReferenceBox({ reference, open = false }: { reference: ParsedReference; open?: boolean }) {
  return (
    <details class="rp-ref" open={open}>
      <summary>As cited in this paper</summary>
      <p class="rp-ref-raw">{reference.raw}</p>
    </details>
  );
}

function ConfidenceBanner({
  candidate,
  count,
  showAlts,
  onToggle,
}: {
  candidate: PaperCandidate;
  count: number;
  showAlts: boolean;
  onToggle: () => void;
}) {
  const conf = confidenceLabel(candidate.confidence);
  return (
    <div class="rp-banner">
      <span class={`rp-pill ${conf.cls}`} title={candidate.matchNotes.join(", ") || undefined}>
        {conf.text}
      </span>
      <span class="rp-source">via {SOURCE_NAMES[candidate.source] ?? candidate.source}</span>
      {count > 1 && (
        <button class="rp-link-btn" onClick={onToggle} aria-expanded={showAlts}>
          {showAlts ? "Hide alternatives" : `${count - 1} other match${count > 2 ? "es" : ""}`}
        </button>
      )}
    </div>
  );
}

function PdfPane({
  state,
  candidate,
  reference,
  onRetry,
  onPage,
}: {
  state: PdfState;
  candidate: PaperCandidate;
  reference: ParsedReference;
  onRetry: () => void;
  onPage: (page: number, total: number) => void;
}) {
  if (state.status === "error") {
    const direct = pdfUrlsOf(candidate)[0];
    return (
      <div class="rp-scroll">
        <div class="rp-message">
          <p class="rp-message-title">Couldn't load the PDF here</p>
          <p class="rp-message-detail">{state.error}</p>
          <div class="rp-actions">
            <button class="rp-btn rp-btn-secondary" onClick={onRetry}>
              Retry
            </button>
            {direct && (
              <a class="rp-btn rp-btn-secondary" href={direct} target="_blank" rel="noopener noreferrer">
                Open PDF in new tab <ExternalIcon />
              </a>
            )}
            <a class="rp-btn rp-btn-secondary" href={scholarUrl(reference, candidate)} target="_blank" rel="noopener noreferrer">
              Google Scholar <ExternalIcon />
            </a>
          </div>
        </div>
      </div>
    );
  }
  if (state.status !== "ready") {
    return (
      <div class="rp-pdf-view">
        <Spinner label="Downloading PDF…" />
      </div>
    );
  }
  return <PdfDocument bytes={state.bytes} onPage={onPage} />;
}

function PdfDocument({ bytes, onPage }: { bytes: Uint8Array; onPage: (page: number, total: number) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ kind: "opening" } | { kind: "ready" } | { kind: "error"; message: string }>({
    kind: "opening",
  });
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  const report = useCallback((p: number, t: number) => onPageRef.current(p, t), []);

  useEffect(() => {
    let view: PdfPagesView | null = null;
    let cancelled = false;
    setStatus({ kind: "opening" });
    openPdfBackend(bytes).then(
      (backend) => {
        if (cancelled || !containerRef.current) {
          backend.destroy();
          return;
        }
        view = new PdfPagesView(containerRef.current, backend, report);
        view.mount();
        setStatus({ kind: "ready" });
      },
      (err: unknown) => {
        if (!cancelled) setStatus({ kind: "error", message: String((err as Error)?.message ?? err) });
      },
    );
    return () => {
      cancelled = true;
      view?.destroy();
      if (containerRef.current) containerRef.current.replaceChildren();
    };
  }, [bytes, report]);

  return (
    <div class="rp-pdf-view">
      {status.kind === "opening" && <Spinner label="Rendering PDF…" />}
      {status.kind === "error" && (
        <div class="rp-message rp-message-dark">
          <p class="rp-message-title">This PDF couldn't be displayed</p>
          <p class="rp-message-detail">{status.message}</p>
        </div>
      )}
      <div class="rp-pdf-pages" ref={containerRef} />
    </div>
  );
}
