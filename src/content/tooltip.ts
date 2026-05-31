// A small "Show preview" affordance shown next to a hovered citation link.
// Rendered as a plain DOM element in the page (styled via tooltip.css).
export class PreviewTooltip {
  private el: HTMLDivElement;
  private hideTimer: number | null = null;

  constructor(private readonly onActivate: () => void) {
    this.el = document.createElement("div");
    this.el.className = "rp-tooltip";
    this.el.setAttribute("role", "button");
    this.el.tabIndex = 0;
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

    this.el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hide(true);
      this.onActivate();
    });
    this.el.addEventListener("pointerenter", () => this.cancelHide());
    this.el.addEventListener("pointerleave", () => this.scheduleHide());

    document.documentElement.appendChild(this.el);
  }

  show(anchor: DOMRect): void {
    this.cancelHide();

    this.el.style.top = `${window.scrollY + anchor.bottom + 6}px`;
    this.el.style.left = `${window.scrollX + anchor.left}px`;

    // Remove and re-add the visible class to restart the entrance animation
    // even when the tooltip is already showing (e.g. anchor changed).
    this.el.classList.remove("rp-tooltip-visible");
    void this.el.offsetWidth; // force reflow so the browser sees the removed class
    this.el.classList.add("rp-tooltip-visible");
  }

  scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = window.setTimeout(() => this.hide(), 700);
  }

  cancelHide(): void {
    if (this.hideTimer != null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  hide(immediate = false): void {
    if (immediate) this.cancelHide();
    this.el.classList.remove("rp-tooltip-visible");
  }

  isVisible(): boolean {
    return this.el.classList.contains("rp-tooltip-visible");
  }
}
