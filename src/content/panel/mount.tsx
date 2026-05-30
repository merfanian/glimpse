// Mounts the preview panel into an isolated shadow root so host page styles don't leak in.
import { render } from "preact";
import { Panel } from "./Panel";
import { ErrorPanel } from "./ErrorPanel";
import type { ParsedReference } from "@shared/types";

const HOST_ID = "reference-previewer-root";

export interface PanelController {
  open(reference: ParsedReference): void;
  openError(title: string, detail: string): void;
  close(): void;
}

export function createPanelController(): PanelController {
  let host = document.getElementById(HOST_ID) as HTMLDivElement | null;
  let shadow: ShadowRoot;

  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: "open" });

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("panel.css");
    shadow.appendChild(link);

    const container = document.createElement("div");
    container.className = "rp-container";
    shadow.appendChild(container);
  } else {
    shadow = host.shadowRoot as ShadowRoot;
  }

  const container = shadow.querySelector(".rp-container") as HTMLElement;

  const close = () => {
    render(null, container);
  };

  const open = (reference: ParsedReference) => {
    render(<Panel reference={reference} onClose={close} />, container);
  };

  const openError = (title: string, detail: string) => {
    render(<ErrorPanel title={title} detail={detail} onClose={close} />, container);
  };

  return { open, openError, close };
}
