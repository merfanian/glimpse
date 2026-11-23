// User-configurable settings, persisted via chrome.storage.sync (falls back to local).

export interface Settings {
  /** Contact email used for the Crossref / OpenAlex "polite pool" (improves rate limits). */
  contactEmail: string;
  /** Whether the extension is enabled on Overleaf. */
  enableOverleaf: boolean;
  /** Whether the extension is enabled on generic pdf.js viewers. */
  enablePdfViewers: boolean;
  /**
   * What to do when a PDF opens in the browser's built-in viewer (where Glimpse can't run):
   * suggest opening it in Glimpse, open it in Glimpse automatically, or do nothing.
   */
  pdfMode: "suggest" | "auto" | "off";
  /** What to show first when a citation is clicked. */
  defaultView: "abstract" | "pdf";
  /** Enabled data sources. */
  sources: {
    crossref: boolean;
    arxiv: boolean;
    semanticScholar: boolean;
    openAlex: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  contactEmail: "",
  enableOverleaf: true,
  enablePdfViewers: true,
  pdfMode: "suggest",
  defaultView: "abstract",
  sources: {
    crossref: true,
    arxiv: true,
    semanticScholar: true,
    openAlex: true,
  },
};

function normalize(raw: unknown): Settings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    sources: { ...DEFAULT_SETTINGS.sources, ...(s.sources ?? {}) },
  };
}

/** storage.sync can be unavailable (Firefox with sync disabled, some enterprise policies). */
function storageArea(): chrome.storage.StorageArea | null {
  try {
    return chrome.storage?.sync ?? chrome.storage?.local ?? null;
  } catch {
    return null;
  }
}

export async function getSettings(): Promise<Settings> {
  try {
    const area = storageArea();
    if (!area) return normalize(null);
    const stored = await area.get("settings");
    return normalize(stored?.settings);
  } catch {
    try {
      const stored = await chrome.storage.local.get("settings");
      return normalize(stored?.settings);
    } catch {
      return normalize(null);
    }
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  try {
    await chrome.storage.sync.set({ settings });
  } catch {
    await chrome.storage.local.set({ settings });
  }
}
