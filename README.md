# Glimpse

Hover a citation in a paper, click **Show preview**, and instantly see the cited paper's
PDF (or abstract) in a draggable, resizable floating panel — without leaving the page.

Works in **Overleaf**, **pdf.js-based PDF viewers**, and its own bundled viewer, on
**Chrome, Edge and Firefox**. Fully client-side: no backend, no account, no tracking. Looks
papers up via **Semantic Scholar**, **arXiv**, **Crossref**, and **OpenAlex** (fallback).

## Install

**From the extension stores** (recommended) — coming soon to the Chrome Web Store,
Microsoft Edge Add-ons, and Firefox Add-ons (AMO).

**From a GitHub Release** — every tagged release attaches ready-to-install packages:
download `glimpse-chrome.zip`, `glimpse-edge.zip`, or `glimpse-firefox.zip` from the
[Releases page](https://github.com/merfanian/glimpse/releases), then follow
[Load unpacked](#load-unpacked) below (unzip first for Chrome/Edge).

## How it works

1. A tiny loader script (≈2 KB) runs on pages and only looks for a supported viewer. When it
   finds one — at load, or on the first hover over a pdf.js link for viewers that render
   late — the background injects the full content script into that frame only.
2. The extension reads the PDF's internal hyperref links to find the exact bibliography
   entry a citation points to (column-aware, including entries that wrap across columns).
3. It parses the entry for DOI / arXiv ID / title / authors / year.
4. It queries Semantic Scholar and arXiv (plus Crossref for DOIs) in parallel, falling back
   to OpenAlex and Crossref search when nothing convincing comes back, and ranks candidates
   by confidence. Rate-limited requests are retried once; misses are never cached.
5. It shows the best match with a confidence banner (and selectable alternatives), and
   renders the open-access PDF page-by-page on demand, or the abstract + metadata.

Panel tips: drag the header to move, drag either bottom corner to resize (position and size
are remembered), press <kbd>Esc</kbd> to close.

## Project layout

```
src/
  shared/        Types, messaging, settings, reference parser, bibliography extraction
  content/       loader.ts (tiny, every page) + full content script (injected on demand):
                 hover detection, PDF parsing, tooltip; pageFetch.ts = page main-world bridge
    panel/       Preact preview-panel UI + lazy PDF page renderer (in a shadow root)
  background/    Service worker: source clients, matching/ranking, PDF fetch, cache
    sources/     Semantic Scholar / arXiv / Crossref / OpenAlex clients
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
on the extension's details page; otherwise (and always on Firefox, which never lets
extensions read local files) the viewer asks you to pick the file. You can also drop a PDF
onto the popup or anywhere on the viewer.

The toolbar popup recognises PDF tabs even without a `.pdf` URL (e.g. `arxiv.org/pdf/…`).

**When you open a PDF in the browser's own viewer** (Glimpse can't run inside it), the
behaviour is set in the popup or settings — *When I open a PDF*:

- **Suggest Glimpse** (default) — Chrome/Edge show a small *Open in Glimpse* card over the
  PDF; Firefox, which allows nothing over its viewer, shows a Glimpse button in the
  address bar. The toolbar button also gets a *PDF* badge.
- **Open in Glimpse** — PDFs open straight in the bundled viewer (Firefox redirects before
  the PDF renders; Chrome/Edge switch the tab as soon as the PDF is detected).
- **Do nothing** — use the toolbar button when you want Glimpse.

Downloads, PDFs returned by form submissions, and embedded PDFs are never touched. In the
viewer, **Open in browser's viewer** goes back to the native viewer for that PDF (e.g. to
print or fill a form), and **Download** saves it.

## Troubleshooting

Debug logging is compiled out of release builds. Build with `node scripts/build.mjs
--target=chrome --dev` (or `--target=firefox --dev`, or `npm run watch`) to get unminified
code that logs to the page's DevTools console, prefixed with `[Glimpse]`:

- `starting on … -> environment: overleaf | pdfjs` — the page was recognized and activated.
- `detector start; … initial pdfUrl = …` — the PDF URL it located (or `null`).
- `building reference index from …` / `index built: N citation link(s) …` — PDF parsing result.

Common cases:
- **Nothing happens on a PDF tab** → you're in the browser's **built-in PDF viewer**,
  which extensions cannot access. Click the **Glimpse toolbar button** to reopen
  the PDF in the bundled viewer, or use a pdf.js-based viewer or Overleaf instead.
- **Firefox: popup says "Glimpse needs access to websites"** → click *Allow access*
  (Firefox lets you withhold host access from MV3 extensions; without it nothing runs).
- **No tooltip on hover in Overleaf** → the PDF's link/annotation layer wasn't found; please
  report the console output.
- **Tooltip shows but preview errors** → the console + panel show why (e.g. the PDF URL
  couldn't be fetched, or the link has no bibliography destination).

Click the toolbar button on a supported page: the popup says whether Glimpse is active there.

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
