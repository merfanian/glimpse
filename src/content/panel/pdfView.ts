// Lazy, page-by-page PDF renderer for the preview panel.
//
// Pages are laid out immediately as correctly-sized placeholders; only pages near the
// visible area are rendered (top-most first), pages far off-screen are released, and on
// resize the previous bitmap stays visible (CSS-scaled) until the sharp one replaces it.
import * as pdfjs from "pdfjs-dist";
import { pdfWorkerReady, USE_MAIN_WORLD } from "../pdfWorkerSetup";
import { mainWorldClose, mainWorldOpen, mainWorldRender } from "../pdfReference";

interface PageSize {
  width: number;
  height: number;
}

interface Backend {
  sizes: PageSize[];
  /** Render 0-based page `index` at `cssWidth` CSS px; returns a <canvas> or <img>. */
  render(index: number, cssWidth: number, dpr: number): Promise<HTMLElement>;
  destroy(): void;
}

/** pdf.js in this JS context (Chrome/Edge content scripts, all extension pages). */
async function openDirect(bytes: Uint8Array): Promise<Backend> {
  await pdfWorkerReady;
  const doc = await pdfjs.getDocument({
    data: bytes.slice(), // pdf.js transfers (detaches) the buffer it is given
    disableRange: true,
    disableStream: true,
    isEvalSupported: false,
  }).promise;
  const sizes = await Promise.all(
    Array.from({ length: doc.numPages }, async (_, i) => {
      const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
      return { width: vp.width, height: vp.height };
    }),
  );
  return {
    sizes,
    async render(index, cssWidth, dpr) {
      const page = await doc.getPage(index + 1);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (cssWidth / natural.width) * dpr });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Canvas unavailable");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
      return canvas;
    },
    destroy() {
      void doc.destroy();
    },
  };
}

/** Firefox content scripts: pdf.js runs in the page's main world, returns blob URLs. */
async function openMainWorld(bytes: Uint8Array): Promise<Backend> {
  const { docId, sizes } = await mainWorldOpen(bytes);
  return {
    sizes,
    async render(index, cssWidth, dpr) {
      const url = await mainWorldRender(docId, index + 1, cssWidth, dpr);
      const img = document.createElement("img");
      img.alt = `Page ${index + 1}`;
      img.src = url;
      try {
        await img.decode();
      } catch {
        /* still usable; the browser will paint it when ready */
      }
      return img;
    },
    destroy() {
      mainWorldClose(docId);
    },
  };
}

export function openPdfBackend(bytes: Uint8Array): Promise<Backend> {
  return USE_MAIN_WORLD ? openMainWorld(bytes) : openDirect(bytes);
}

interface PageSlot {
  el: HTMLDivElement;
  size: PageSize;
  near: boolean;
  renderedWidth: number;
}

export class PdfPagesView {
  private slots: PageSlot[] = [];
  private width = 0;
  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private resizeTimer: number | null = null;
  private pumping = false;
  private destroyed = false;
  private lastReportedPage = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly backend: Backend,
    private readonly onPageChange?: (page: number, total: number) => void,
  ) {}

  get numPages(): number {
    return this.backend.sizes.length;
  }

  mount(): void {
    this.width = this.measure();
    const frag = document.createDocumentFragment();
    this.backend.sizes.forEach((size, i) => {
      const el = document.createElement("div");
      el.className = "rp-pdf-page";
      el.dataset.index = String(i);
      el.style.aspectRatio = `${size.width} / ${size.height}`;
      el.style.width = `${this.width}px`;
      frag.appendChild(el);
      this.slots.push({ el, size, near: false, renderedWidth: 0 });
    });
    this.container.appendChild(frag);

    // "Near" = within ~1.5 viewports; those get rendered, the rest are released.
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const slot = this.slots[Number((e.target as HTMLElement).dataset.index)];
          if (!slot) continue;
          slot.near = e.isIntersecting;
          if (!slot.near && slot.renderedWidth) {
            slot.el.replaceChildren();
            slot.renderedWidth = 0;
          }
        }
        void this.pump();
      },
      { root: this.container, rootMargin: "150% 0px" },
    );
    for (const s of this.slots) this.io.observe(s.el);

    this.ro = new ResizeObserver(() => {
      if (this.resizeTimer != null) clearTimeout(this.resizeTimer);
      // Placeholders track the width immediately; re-rendering waits for the drag to settle.
      const w = this.measure();
      if (Math.abs(w - this.width) < 2) return;
      this.width = w;
      for (const s of this.slots) s.el.style.width = `${w}px`;
      this.resizeTimer = window.setTimeout(() => void this.pump(), 160);
    });
    this.ro.observe(this.container);

    this.container.addEventListener("scroll", this.onScroll, { passive: true });
    this.onScroll();
  }

  private measure(): number {
    const cs = getComputedStyle(this.container);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    return Math.max(160, Math.floor(this.container.clientWidth - pad));
  }

  private onScroll = (): void => {
    if (!this.onPageChange || this.slots.length === 0) return;
    const mid = this.container.scrollTop + this.container.clientHeight / 3;
    let page = 1;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].el.offsetTop <= mid) page = i + 1;
      else break;
    }
    if (page !== this.lastReportedPage) {
      this.lastReportedPage = page;
      this.onPageChange(page, this.slots.length);
    }
  };

  /** Render near pages whose bitmap is missing or at the wrong width, one at a time. */
  private async pump(): Promise<void> {
    if (this.pumping || this.destroyed) return;
    this.pumping = true;
    try {
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      for (;;) {
        if (this.destroyed) return;
        const i = this.slots.findIndex((s) => s.near && s.renderedWidth !== this.width);
        if (i < 0) return;
        const slot = this.slots[i];
        const w = this.width;
        try {
          const node = await this.backend.render(i, w, dpr);
          if (this.destroyed) return;
          node.classList.add("rp-pdf-bitmap");
          if (slot.near) slot.el.replaceChildren(node);
          slot.el.classList.remove("rp-pdf-page-error");
        } catch (err) {
          if (this.destroyed) return;
          slot.el.classList.add("rp-pdf-page-error");
          slot.el.textContent = `Couldn't render page ${i + 1}: ${String((err as Error)?.message ?? err)}`;
        }
        slot.renderedWidth = slot.near ? w : 0;
      }
    } finally {
      this.pumping = false;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.io?.disconnect();
    this.ro?.disconnect();
    if (this.resizeTimer != null) clearTimeout(this.resizeTimer);
    this.container.removeEventListener("scroll", this.onScroll);
    this.backend.destroy();
  }
}
