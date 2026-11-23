// "Open in Glimpse?" card, injected by the background into the host document of
// Chrome's/Edge's built-in PDF viewer (pdfMode = "suggest"). Glimpse can't run inside
// that viewer, so this offers a one-click switch to Glimpse's own viewer.
import css from "./suggest.css";

const HOST_ID = "glimpse-suggest";

function send(always: boolean): void {
  try {
    chrome.runtime.sendMessage({ type: "openInGlimpse", always }, () => void chrome.runtime.lastError);
  } catch {
    /* extension reloaded */
  }
}

if (!document.getElementById(HOST_ID)) {
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; right: 0; bottom: 0; width: 0; height: 0;";
  const root = host.attachShadow({ mode: "open" });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement("style");
    style.textContent = css;
    root.appendChild(style);
  }

  const card = document.createElement("div");
  card.className = "card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Open this PDF in Glimpse");
  card.innerHTML = `
    <img class="logo" alt="" width="28" height="28">
    <div class="text">
      <div class="title">Preview this paper's citations?</div>
      <div class="sub">Open it in Glimpse to hover a citation and see the cited paper.</div>
      <div class="actions">
        <button class="primary" data-act="open">Open in Glimpse</button>
        <button class="link" data-act="always" title="Open every PDF in Glimpse from now on (change this in the Glimpse popup or settings)">Always</button>
      </div>
    </div>
    <button class="close" data-act="close" aria-label="Dismiss" title="Dismiss">
      <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>`;
  (card.querySelector(".logo") as HTMLImageElement).src = chrome.runtime.getURL("icons/icon-48.png");

  const dismiss = () => {
    card.classList.add("leaving");
    setTimeout(() => host.remove(), 180);
  };
  card.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "open") send(false);
    else if (act === "always") send(true);
    else if (act === "close") dismiss();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismiss();
  });

  root.appendChild(card);
  document.documentElement.appendChild(host);
}
