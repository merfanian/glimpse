/** @jsxImportSource preact */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from "@shared/settings";
import "./options.css";

function OptionsApp() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);

  const update = (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setSaved(false);
  };
  const updateSource = (patch: Partial<Settings["sources"]>) => {
    setSettings((s) => ({ ...s, sources: { ...s.sources, ...patch } }));
    setSaved(false);
  };

  const onSave = async () => {
    await saveSettings(settings);
    setSaved(true);
  };

  return (
    <div class="wrap">
      <header class="brand">
        <img class="brand-logo" src="icons/icon-128.png" width="44" height="44" alt="" />
        <div class="brand-text">
          <h1>Glimpse</h1>
          <p class="sub">Preview cited papers by hovering citations in Overleaf and PDF viewers.</p>
        </div>
      </header>

      <section>
        <h2>Crossref polite pool</h2>
        <label class="field">
          <span>Contact email (optional)</span>
          <input
            type="email"
            placeholder="you@example.com"
            value={settings.contactEmail}
            onInput={(e) => update({ contactEmail: (e.target as HTMLInputElement).value })}
          />
        </label>
        <p class="hint">
          Providing an email opts into Crossref's polite pool for more reliable rate limits.
        </p>
      </section>

      <section>
        <h2>Preview style</h2>
        <p class="hint">What to show first when you click a citation.</p>
        <label class="check">
          <input
            type="radio"
            name="defaultView"
            value="abstract"
            checked={settings.defaultView !== "pdf"}
            onChange={() => update({ defaultView: "abstract" })}
          />
          <span>Abstract — show title, authors, and abstract</span>
        </label>
        <label class="check">
          <input
            type="radio"
            name="defaultView"
            value="pdf"
            checked={settings.defaultView === "pdf"}
            onChange={() => update({ defaultView: "pdf" })}
          />
          <span>Full PDF — load the PDF immediately</span>
        </label>
      </section>

      <section>
        <h2>Where to run</h2>
        <label class="check">
          <input
            type="checkbox"
            checked={settings.enableOverleaf}
            onChange={(e) => update({ enableOverleaf: (e.target as HTMLInputElement).checked })}
          />
          <span>Overleaf</span>
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={settings.enablePdfViewers}
            onChange={(e) => update({ enablePdfViewers: (e.target as HTMLInputElement).checked })}
          />
          <span>pdf.js-based PDF viewers</span>
        </label>
      </section>

      <section>
        <h2>Data sources</h2>
        <label class="check">
          <input
            type="checkbox"
            checked={settings.sources.crossref}
            onChange={(e) => updateSource({ crossref: (e.target as HTMLInputElement).checked })}
          />
          <span>Crossref</span>
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={settings.sources.arxiv}
            onChange={(e) => updateSource({ arxiv: (e.target as HTMLInputElement).checked })}
          />
          <span>arXiv</span>
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={settings.sources.semanticScholar}
            onChange={(e) =>
              updateSource({ semanticScholar: (e.target as HTMLInputElement).checked })
            }
          />
          <span>Semantic Scholar</span>
        </label>
      </section>

      <div class="actions">
        <button onClick={onSave}>Save</button>
        {saved && <span class="saved">Saved ✓</span>}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(<OptionsApp />, root);
