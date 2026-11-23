// Full content script (content-main.js). Not listed in the manifest: the lightweight
// loader (loader.ts) asks the background to inject it only into frames that contain a
// supported PDF viewer.
import { detectEnvironment, glimpseGlobal } from "./env";
import { startDetection } from "./start";
import { log } from "@shared/debug";

const state = glimpseGlobal();

if (!state.started) {
  state.started = true;
  const env = state.env ?? detectEnvironment() ?? "pdfjs";
  log("starting on", location.href, "-> environment:", env);
  const detector = startDetection(env);
  if (state.pendingTarget) {
    detector.primeHover(state.pendingTarget);
    state.pendingTarget = null;
  }
}
