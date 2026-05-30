/** @jsxImportSource preact */

interface ErrorPanelProps {
  title: string;
  detail: string;
  onClose: () => void;
}

/** A minimal panel shown when a citation can't be previewed. */
export function ErrorPanel({ title, detail, onClose }: ErrorPanelProps) {
  return (
    <div class="rp-panel rp-panel-compact">
      <div class="rp-header">
        <span class="rp-header-title">{title}</span>
        <button class="rp-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div class="rp-body">
        <div class="rp-status rp-error rp-error-window">
          <p class="rp-error-summary">Failed to read the PDF.</p>
          <pre class="rp-error-message">{detail}</pre>
        </div>
      </div>
      <div class="rp-footer">
        <button class="rp-btn rp-btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
