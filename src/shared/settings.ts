// User-configurable settings, persisted via chrome.storage.sync.

export interface Settings {
  /** Contact email used for the Crossref "polite pool" (improves rate limits). */
  contactEmail: string;
  /** Whether the extension is enabled on Overleaf. */
  enableOverleaf: boolean;
  /** Whether the extension is enabled on generic pdf.js viewers. */
  enablePdfViewers: boolean;
  /** What to show first when a citation is clicked. */
  defaultView: "abstract" | "pdf";
  /** Enabled data sources. */
  sources: {
    crossref: boolean;
    arxiv: boolean;
    semanticScholar: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  contactEmail: "",
  enableOverleaf: true,
  enablePdfViewers: true,
  defaultView: "abstract",
  sources: {
    crossref: true,
    arxiv: true,
    semanticScholar: true,
  },
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get("settings");
  const s = (stored?.settings ?? {}) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    sources: { ...DEFAULT_SETTINGS.sources, ...(s.sources ?? {}) },
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings });
}
