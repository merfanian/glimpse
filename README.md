# Glimpse

Hover a citation in a paper, click **Show preview**, and instantly see the cited paper's
PDF (or abstract) in a draggable, resizable floating panel — without leaving the page.

Works in **Overleaf** and **pdf.js-based PDF viewers**. Fully client-side: no backend, no
account, no tracking. Looks papers up via **Crossref**, **arXiv**, and **Semantic Scholar**.

## Install

**From the extension stores** (recommended) — coming soon to the Chrome Web Store,
Microsoft Edge Add-ons, and Firefox Add-ons (AMO).

**From a GitHub Release** — every tagged release attaches ready-to-install packages:
download `glimpse-chrome.zip`, `glimpse-edge.zip`, or `glimpse-firefox.zip` from the
[Releases page](https://github.com/merfanian/glimpse/releases), then follow
[Load unpacked](#load-unpacked) below (unzip first for Chrome/Edge).

## How it works

1. The extension reads the PDF's internal hyperref links to find the exact bibliography
   entry a citation points to.
2. It parses the entry for DOI / arXiv ID / title / authors / year.
3. It queries Crossref, arXiv, and Semantic Scholar, then ranks candidates by confidence.
4. It shows the best match with a confidence banner (and selectable alternatives), embedding
   the open-access PDF when available or falling back to the abstract + metadata.

## Project layout

```
src/
  shared/        Types, messaging, settings, reference parser (shared everywhere)
  content/       Content script: env detection, hover detection, PDF parsing, tooltip
    panel/       Preact preview-panel UI (mounted in a shadow root)
  background/    Service worker: source clients, matching/ranking, PDF fetch, cache
    sources/     Crossref / arXiv / Semantic Scholar clients
  viewer/        Bundled pdf.js viewer page (for local / native-viewer PDFs)
  options/       Preact options page
scripts/         esbuild build, icon generator, packaging
```

## Local PDFs & the built-in viewer

Browsers render local (`file://`) and many remote PDFs in their **native PDF viewer**
(PDFium), which extensions cannot script — so hover previews can't work there directly.
Glimpse ships its own **bundled pdf.js viewer** to cover those cases:

- Click the **Glimpse toolbar button** while a `.pdf` tab is open to reopen it in
  the bundled viewer (where hover previews work).
- Right-click a **link to a PDF** → **Open PDF in Glimpse**, or right-click a PDF
  page → **Open this PDF in Glimpse**.
- The bundled viewer renders the text + link layers, so the same citation detection applies.

To open local `file://` PDFs this way in Chrome/Edge, enable **Allow access to file URLs**
on the extension's details page.

> A fully automatic redirect of every PDF into the bundled viewer was intentionally **not**
> added: there's no reliable way to exclude the viewer's own requests from a static redirect
> rule, risking redirect loops. Explicit toolbar/context-menu opening is used instead.

## Troubleshooting

The extension logs to the page's DevTools console, prefixed with `[Glimpse]`.
Open DevTools (F12) → Console and look for lines such as:

- `bootstrap on … -> environment: overleaf | pdfjs | null` — whether the page was recognized.
- `detector start; … initial pdfUrl = …` — the PDF URL it located (or `null`).
- `building reference index from …` / `index built: N citation link(s) …` — PDF parsing result.

Common cases:
- **`environment: null`** on a PDF tab → you're in the browser's **built-in PDF viewer**,
  which extensions cannot access. Click the **Glimpse toolbar button** to reopen
  the PDF in the bundled viewer, or use a pdf.js-based viewer or Overleaf instead.
- **No tooltip on hover in Overleaf** → the PDF's link/annotation layer wasn't found; please
  report the console output.
- **Tooltip shows but preview errors** → the console + panel show why (e.g. the PDF URL
  couldn't be fetched, or the link has no bibliography destination).

Toggle logging via `DEBUG` in `src/shared/debug.ts`.

## Build

Requires Node 18+.

```bash
npm install
npm run build:chrome     # -> dist/chrome
npm run build:firefox    # -> dist/firefox
npm run package          # builds both and writes dist/<target>.zip
npm run typecheck        # tsc --noEmit
npm run watch            # rebuild Chrome target on change
```

The same Manifest V3 source builds for Chrome, Edge, and Firefox. The only per-browser
difference is the background declaration (`service_worker` for Chrome/Edge, `scripts` plus a
`browser_specific_settings.gecko` id for Firefox), handled automatically by the build script.

## Releases & store publishing

CI (`.github/workflows/ci.yml`) type-checks, tests, and builds on every push/PR.

Releases are automated by `.github/workflows/release.yml`. Push a version tag to cut one:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The workflow takes the version from the tag, builds all three targets, attaches
`glimpse-chrome.zip`, `glimpse-edge.zip`, and `glimpse-firefox.zip` to a GitHub Release,
and — when the matching repository secrets are configured — uploads the new version to each
extension store. Each store is independent: if its secrets are absent, that publish step is
skipped (the GitHub Release still happens).

| Store | Secrets |
| --- | --- |
| Chrome Web Store | `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN` |
| Microsoft Edge Add-ons | `EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY` |
| Firefox AMO | `FIREFOX_JWT_ISSUER`, `FIREFOX_JWT_SECRET` |

Add these under **Settings → Secrets and variables → Actions**. A first manual submission per
store (to create the listing / obtain the IDs) is required before automated updates work.

## Load unpacked

**Chrome / Edge**
1. Go to `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select `dist/chrome`.

**Firefox**
1. Go to `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → select `dist/firefox/manifest.json`.

> Firefox temporary add-ons are removed on restart. For a persistent install, sign the zip
> via [AMO](https://addons.mozilla.org/developers/).

To read local `file://` PDFs in Chrome/Edge, enable **Allow access to file URLs** on the
extension's details page.

## Options

Open the extension's options page to configure:
- **Crossref contact email** — opts into Crossref's "polite pool" for better rate limits.
- **Where to run** — toggle Overleaf and/or pdf.js viewers.
- **Data sources** — enable/disable Crossref, arXiv, Semantic Scholar.

## Limitations

- Only **pdf.js-based** viewers and Overleaf are supported. The native Chrome/Edge PDF
  viewer is a closed component; open such PDFs in the **bundled viewer** (toolbar button /
  context menu) to enable previews.
- Reference resolution relies on the PDF containing **internal hyperref links** (most LaTeX/
  arXiv PDFs do). PDFs without link annotations won't surface previews.
- Embedded preview requires an **open-access PDF**; otherwise the panel shows the abstract.
- Public APIs are rate-limited. Results are cached in-memory for the session.

## Safari

Not built here. Safari requires a separate Xcode/macOS packaging step
(`xcrun safari-web-extension-converter dist/chrome`). The MV3 source is largely compatible.

## License

MIT
