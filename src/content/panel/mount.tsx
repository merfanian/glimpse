/** @jsxImportSource preact */
// Creates Glimpse's isolated UI root: one shadow root (so host-page CSS can't leak in)
// holding the hover tooltip and the preview panel.
import { render, type ComponentChildren } from "preact";
import { PanelShell, ReferenceView, ErrorView, LoadingView, loadSavedGeometry } from "./Panel";
import type { ParsedReference } from "@shared/types";
import { IN_EXTENSION_PAGE } from "../pdfWorkerSetup";
import panelCss from "./panel.css";

const HOST_ID = "glimpse-root";

export interface PanelController {
  /** Show the panel immediately with a spinner (e.g. while the bibliography is read). */
  openLoading(): void;
  open(reference: ParsedReference): void;
  openError(title: string, detail: string): void;
  close(): void;
  isOpen(): boolean;
}

export interface GlimpseUi {
  root: ShadowRoot;
  panel: PanelController;
}

/**
 * Style the shadow root. Constructable stylesheets are synchronous (no flash of unstyled
 * UI) and exempt from page CSP; Firefox content scripts can't adopt sheets across the Xray
 * boundary, so there we use a <link> to the extension's copy, falling back to <style>.
 */
function applyStyles(root: ShadowRoot, host: HTMLElement): void {
  if (__BROWSER__ !== "firefox" || IN_EXTENSION_PAGE) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(panelCss);
      root.adoptedStyleSheets = [sheet];
      return;
    } catch {
      /* fall through */
    }
  }
  host.style.visibility = "hidden";
  const reveal = () => host.style.removeProperty("visibility");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("panel.css");
  link.onload = reveal;
  link.onerror = () => {
    link.remove();
    const style = document.createElement("style");
    style.textContent = panelCss;
    root.prepend(style);
    reveal();
  };
  root.prepend(link);
  setTimeout(reveal, 3000); // never leave the UI invisible
}

export function createUi(): GlimpseUi {
  document.getElementById(HOST_ID)?.remove(); // stale root from a previous (reloaded) extension
  const host = document.createElement("div");
  host.id = HOST_ID;
  // Inline styles so page CSS targeting `div` can't move or hide the host.
  host.style.cssText = "all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;";
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  applyStyles(root, host);

  const container = document.createElement("div");
  container.className = "rp-container";
  root.appendChild(container);

  loadSavedGeometry();

  let open = false;
  const close = () => {
    open = false;
    render(null, container);
  };
  const show = (content: ComponentChildren) => {
    open = true;
    render(<PanelShell onClose={close}>{content}</PanelShell>, container);
  };

  return {
    root,
    panel: {
      openLoading: () => show(<LoadingView onClose={close} />),
      open: (reference) => show(<ReferenceView reference={reference} onClose={close} />),
      openError: (title, detail) => show(<ErrorView title={title} detail={detail} onClose={close} />),
      close,
      isOpen: () => open,
    },
  };
}
