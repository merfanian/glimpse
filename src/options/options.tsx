/** @jsxImportSource preact */
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from "@shared/settings";
import "./options.css";

function OptionsApp() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timer = useRef<number | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    void getSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  // Changes apply immediately (debounced so typing an email doesn't spam storage).
  useEffect(() => {
    if (!loaded || !dirty.current) return;
    if (timer.current != null) clearTimeout(timer.current);
    setSaved("saving");
    timer.current = window.setTimeout(() => {
      saveSettings(settings).then(
        () => setSaved("saved"),
        () => setSaved("error"),
      );
    }, 400);
  }, [settings, loaded]);

  const update = (patch: Partial<Settings>) => {
    dirty.current = true;
    setSettings((s) => ({ ...s, ...patch }));
  };
  const updateSource = (patch: Partial<Settings["sources"]>) => {
    dirty.current = true;
    setSettings((s) => ({ ...s, sources: { ...s.sources, ...patch } }));
  };

  return (
    <div class="page">
      <header class="brand">
        <img class="brand-logo" src="icons/icon-128.png" width="52" height="52" alt="" />
        <div class="brand-text">
          <h1>Glimpse</h1>
          <p class="sub">Hover a citation in a paper and preview the cited work, without losing your place.</p>
        </div>
        <span class={`save-state save-${saved}`} aria-live="polite">
          {saved === "saving" && "Saving…"}
          {saved === "saved" && "Saved"}
          {saved === "error" && "Couldn't save"}
        </span>
      </header>

      <section class="card">
        <div class="card-head">
          <h2>Opening PDFs</h2>
          <p>Glimpse can't run inside the browser's built-in PDF viewer. When you open a PDF there…</p>
        </div>
        <div class="choices" role="radiogroup" aria-label="When a PDF opens in the browser's viewer">
          {(
            [
              ["suggest", "Suggest Glimpse", "A small card on Chrome/Edge, an address-bar button on Firefox."],
              ["auto", "Open in Glimpse", "PDFs open straight in Glimpse's viewer."],
              ["off", "Do nothing", "Use the toolbar button when you want Glimpse."],
            ] as const
          ).map(([value, title, desc]) => (
            <label class={`choice ${settings.pdfMode === value ? "choice-on" : ""}`} key={value}>
              <input
                type="radio"
                name="pdfMode"
                value={value}
                checked={settings.pdfMode === value}
                onChange={() => update({ pdfMode: value })}
              />
              <span class="choice-title">{title}</span>
              <span class="choice-desc">{desc}</span>
            </label>
          ))}
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Preview</h2>
          <p>What the panel shows first when you open a citation.</p>
        </div>
        <div class="choices choices-2" role="radiogroup" aria-label="Default preview">
          {(
            [
              ["abstract", "Abstract", "Title, authors and abstract — instant."],
              ["pdf", "Full PDF", "Loads the open-access PDF right away."],
            ] as const
          ).map(([value, title, desc]) => (
            <label class={`choice ${settings.defaultView === value ? "choice-on" : ""}`} key={value}>
              <input
                type="radio"
                name="defaultView"
                value={value}
                checked={settings.defaultView === value}
                onChange={() => update({ defaultView: value })}
              />
              <span class="choice-title">{title}</span>
              <span class="choice-desc">{desc}</span>
            </label>
          ))}
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Where Glimpse runs</h2>
        </div>
        <Toggle
          label="Overleaf"
          desc="Citation previews in Overleaf's PDF preview."
          checked={settings.enableOverleaf}
          onChange={(v) => update({ enableOverleaf: v })}
        />
        <Toggle
          label="pdf.js-based viewers"
          desc="Websites that render PDFs with pdf.js."
          checked={settings.enablePdfViewers}
          onChange={(v) => update({ enablePdfViewers: v })}
        />
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Paper lookup</h2>
          <p>Glimpse queries these open scholarly databases directly from your browser.</p>
        </div>
        <Toggle label="Semantic Scholar" desc="Primary title matching." checked={settings.sources.semanticScholar} onChange={(v) => updateSource({ semanticScholar: v })} />
        <Toggle label="arXiv" desc="Preprints and their PDFs." checked={settings.sources.arxiv} onChange={(v) => updateSource({ arxiv: v })} />
        <Toggle label="Crossref" desc="DOIs and publisher metadata." checked={settings.sources.crossref} onChange={(v) => updateSource({ crossref: v })} />
        <Toggle label="OpenAlex" desc="Fallback when the others find nothing." checked={settings.sources.openAlex} onChange={(v) => updateSource({ openAlex: v })} />
        <label class="field">
          <span class="field-label">Contact email <em>optional</em></span>
          <input
            type="email"
            placeholder="you@university.edu"
            value={settings.contactEmail}
            onInput={(e) => update({ contactEmail: (e.target as HTMLInputElement).value })}
          />
          <span class="hint">
            Sent only to Crossref and OpenAlex, which give requests with a contact address more reliable rate limits.
          </span>
        </label>
      </section>

      <footer class="foot">
        Glimpse runs entirely in your browser — no account, no tracking. Changes save automatically.
      </footer>
    </div>
  );
}

function Toggle({ label, desc, checked, onChange }: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="toggle-row">
      <span class="toggle-text">
        <span class="toggle-label">{label}</span>
        {desc && <span class="toggle-desc">{desc}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        class="switch"
        checked={checked}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
    </label>
  );
}

const root = document.getElementById("root");
if (root) render(<OptionsApp />, root);
