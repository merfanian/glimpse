// Point install buttons at the visitor's browser. Store links live here: when the Chrome
// and Edge listings go live, set their URLs below and the page updates everywhere.
const STORES = {
  firefox: "https://addons.mozilla.org/en-US/firefox/addon/glimpse-citation-preview-tool/",
  chrome: null, // e.g. "https://chromewebstore.google.com/detail/glimpse/<id>"
  edge: null, // e.g. "https://microsoftedge.microsoft.com/addons/detail/<id>"
};
function detectBrowser() {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Edg\//.test(ua)) return "edge";
  if (/Chrome\//.test(ua)) return "chrome";
  return null;
}

const NAMES = { firefox: "Firefox", chrome: "Chrome", edge: "Edge" };
const browser = detectBrowser();

// Store cards: switch "Soon" to "Available" once a listing URL is configured.
for (const [key, url] of Object.entries(STORES)) {
  const card = document.getElementById(`store-${key}`);
  if (!card) continue;
  if (url) {
    card.href = url;
    const status = card.querySelector(".store-status");
    status.textContent = "Available";
    status.className = "store-status live";
    card.querySelector("small").textContent =
      key === "firefox" ? "Get it on Firefox Add-ons" : key === "chrome" ? "Get it on the Chrome Web Store" : "Get it on Edge Add-ons";
  }
  if (key === browser) card.classList.add("is-yours");
}

// Main CTAs: go straight to the visitor's store when it's live, else to the install section.
if (browser) {
  for (const btn of document.querySelectorAll('[data-store="auto"]')) {
    if (STORES[browser]) {
      btn.href = STORES[browser];
      btn.textContent = `Add to ${NAMES[browser]} — it's free`;
    } else {
      btn.textContent = `Install for ${NAMES[browser]}`;
    }
  }
}
