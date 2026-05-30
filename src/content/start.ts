// Shared wiring for citation detection, the hover tooltip, and the preview panel.
// Used by both the content script (in-page) and the bundled viewer.
import { CitationDetector, type Environment } from "./citationDetector";
import { PreviewTooltip } from "./tooltip";
import { createPanelController } from "./panel/mount";
import type { PDFDocumentProxy } from "pdfjs-dist";

export function startDetection(env: Environment, preloadedDoc?: PDFDocumentProxy): CitationDetector {
  const panel = createPanelController();

  const detector = new CitationDetector(env, {
    showTooltip: (rect) => tooltip.show(rect),
    hideTooltip: () => tooltip.scheduleHide(),
    openPanel: (ref) => panel.open(ref),
    openError: (title, detail) => panel.openError(title, detail),
  });

  if (preloadedDoc) detector.useDocument(preloadedDoc);

  const tooltip = new PreviewTooltip(() => {
    void detector.previewCurrent();
  });

  detector.start();
  return detector;
}
