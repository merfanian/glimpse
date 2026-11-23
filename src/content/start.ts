// Shared wiring for citation detection, the hover tooltip, and the preview panel.
// Used by both the full content script (in-page) and the bundled viewer.
import { CitationDetector, type Environment } from "./citationDetector";
import { PreviewTooltip } from "./tooltip";
import { createUi } from "./panel/mount";
import type { PDFDocumentProxy } from "pdfjs-dist";

export function startDetection(env: Environment, preloadedDoc?: PDFDocumentProxy): CitationDetector {
  const ui = createUi();
  const panel = ui.panel;

  let detector: CitationDetector | null = null;
  const tooltip = new PreviewTooltip(ui.root, () => {
    void detector?.previewCurrent();
  });

  detector = new CitationDetector(env, {
    showTooltip: (rect) => tooltip.show(rect),
    hideTooltip: () => tooltip.scheduleHide(),
    hideTooltipNow: () => {
      if (!tooltip.isHovered()) tooltip.hide(true);
    },
    tooltipVisible: () => tooltip.isVisible(),
    openLoading: () => panel.openLoading(),
    openPanel: (ref) => panel.open(ref),
    openError: (title, detail) => panel.openError(title, detail),
  });

  if (preloadedDoc) detector.useDocument(preloadedDoc);
  detector.start();
  return detector;
}
