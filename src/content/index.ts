// Content script entry point: wires citation detection into supported in-page viewers.
import { detectEnvironment, type Environment } from "./citationDetector";
import { startDetection } from "./start";
import { getSettings } from "@shared/settings";
import { log, warn } from "@shared/debug";
import "./tooltip.css";

async function bootstrap(): Promise<void> {
  const env: Environment = detectEnvironment();
  log("bootstrap on", location.href, "-> environment:", env);

  if (!env) {
    if (/\.pdf($|[?#])/i.test(location.href) || document.contentType === "application/pdf") {
      warn(
        "This looks like the browser's built-in PDF viewer, which extensions cannot access. " +
          "Use the Glimpse toolbar button to reopen this PDF in the bundled viewer.",
      );
    }
    return;
  }

  const settings = await getSettings();
  if (env === "overleaf" && !settings.enableOverleaf) {
    log("disabled on Overleaf via settings");
    return;
  }
  if (env === "pdfjs" && !settings.enablePdfViewers) {
    log("disabled on pdf.js viewers via settings");
    return;
  }

  startDetection(env);
}

void bootstrap();
