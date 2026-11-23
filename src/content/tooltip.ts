// The small "Preview" chip shown next to a hovered citation link. Lives in Glimpse's
// shadow root (so page CSS can't touch it) and is positioned in viewport coordinates.
export class PreviewTooltip {
  private el: HTMLDivElement;
  private hideTimer: number | null = null;
  private hovered = false;

  constructor(
    parent: ShadowRoot | HTMLElement,
    private readonly onActivate: () => void,
  ) {
    this.el = document.createElement("div");
    this.el.className = "rp-tooltip";
    this.el.setAttribute("role", "button");
    this.el.setAttribute("aria-label", "Preview cited paper");
    this.el.tabIndex = -1;
    this.el.innerHTML = `
      <div class="rp-tooltip-chip">
        <svg class="rp-tooltip-icon" width="13" height="13" viewBox="0 0 20 20"
             fill="none" stroke="currentColor" stroke-width="2.2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="5.8"/>
          <line x1="13.2" y1="13.2" x2="18" y2="18"/>
        </svg>
        <span>Preview</span>
      </div>`;

    const activate = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.hide(true);
      this.onActivate();
    };
    this.el.addEventListener("click", activate);
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") activate(e);
    });
    // Don't let pdf.js / Overleaf treat a press on the chip as a text-selection start.
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.el.addEventListener("pointerenter", () => {
      this.hovered = true;
      this.cancelHide();
    });
    this.el.addEventListener("pointerleave", () => {
      this.hovered = false;
      this.scheduleHide();
    });

    parent.appendChild(this.el);
  }

  show(anchor: DOMRect): void {
    this.cancelHide();
    const wasVisible = this.isVisible();

    // Measure (visible but transparent) to clamp within the viewport.
    this.el.classList.add("rp-tooltip-measure");
    const w = this.el.offsetWidth || 84;
    const h = this.el.offsetHeight || 24;
    this.el.classList.remove("rp-tooltip-measure");

    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const GAP = 5;
    let top = anchor.bottom + GAP;
    let above = false;
    if (top + h > vh - 4) {
      top = anchor.top - h - GAP; // flip above when there's no room below
      above = true;
    }
    const left = Math.min(Math.max(4, anchor.left), Math.max(4, vw - w - 4));
    this.el.style.top = `${Math.max(4, top)}px`;
    this.el.style.left = `${left}px`;
    this.el.classList.toggle("rp-tooltip-above", above);

    if (!wasVisible) {
      // Restart the entrance animation only when appearing, not when moving between links.
      this.el.classList.remove("rp-tooltip-visible");
      void this.el.offsetWidth;
    }
    this.el.classList.add("rp-tooltip-visible");
  }

  scheduleHide(delay = 450): void {
    if (this.hovered) return;
    this.cancelHide();
    this.hideTimer = window.setTimeout(() => this.hide(), delay);
  }

  cancelHide(): void {
    if (this.hideTimer != null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  hide(immediate = false): void {
    if (immediate) this.cancelHide();
    this.hovered = false;
    this.el.classList.remove("rp-tooltip-visible");
  }

  isVisible(): boolean {
    return this.el.classList.contains("rp-tooltip-visible");
  }

  isHovered(): boolean {
    return this.hovered;
  }
}
