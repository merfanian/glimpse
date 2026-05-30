// A small "Show preview" affordance shown next to a hovered citation link.
// Rendered as a plain DOM element in the page (styled via content.css).
export class PreviewTooltip {
  private el: HTMLDivElement;
  private hideTimer: number | null = null;

  constructor(private readonly onActivate: () => void) {
    this.el = document.createElement("div");
    this.el.className = "rp-tooltip";
    this.el.setAttribute("role", "button");
    this.el.tabIndex = 0;
    this.el.innerHTML = `<span class="rp-tooltip-icon" aria-label="Show preview">🔍</span>`;
    this.el.style.display = "none";

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
    this.el.style.display = "flex";
    const top = window.scrollY + anchor.bottom + 4;
    const left = window.scrollX + anchor.left;
    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }

  scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = window.setTimeout(() => this.hide(), 300);
  }

  cancelHide(): void {
    if (this.hideTimer != null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  hide(immediate = false): void {
    if (immediate) this.cancelHide();
    this.el.style.display = "none";
  }
}
