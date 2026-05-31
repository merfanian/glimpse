// Build script for the Glimpse extension.
// Bundles content script, background service worker, and options page with esbuild,
// copies the pdf.js worker and static assets, and writes a per-browser manifest.
import { build, context } from "esbuild";
import { rmSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const targetArg = args.find((a) => a.startsWith("--target="));
const target = targetArg ? targetArg.split("=")[1] : "chrome"; // chrome | firefox
const outdir = resolve(root, "dist", target);

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const jsx = {
  jsx: "automatic",
  jsxImportSource: "preact",
};

/** Common esbuild options. */
const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  target: ["chrome114", "firefox115"],
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"),
    __EXT_VERSION__: JSON.stringify(pkg.version),
    __BROWSER__: JSON.stringify(target),
  },
  ...jsx,
};

const entries = [
  // Content script must be a classic (IIFE) script.
  {
    entryPoints: { content: resolve(root, "src/content/index.ts") },
    format: "iife",
  },
  // Background: built as IIFE so it works as both an MV3 service_worker (Chrome/Edge)
  // and a background script (Firefox).
  {
    entryPoints: { background: resolve(root, "src/background/index.ts") },
    format: "iife",
  },
  // Options page UI.
  {
    entryPoints: { options: resolve(root, "src/options/options.tsx") },
    format: "iife",
  },
  // Bundled PDF viewer (pdf.js components).
  {
    entryPoints: { viewer: resolve(root, "src/viewer/viewer.ts") },
    format: "iife",
  },
  // Toolbar popup.
  {
    entryPoints: { popup: resolve(root, "src/popup/popup.ts") },
    format: "iife",
  },
  // Page main-world fetch bridge (runs in the host page's JS context).
  {
    entryPoints: { pagefetch: resolve(root, "src/content/pageFetch.ts") },
    format: "iife",
  },
];

function buildManifest() {
  const base = {
    manifest_version: 3,
    name: "Glimpse",
    version: pkg.version,
    description: pkg.description,
    icons: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
    permissions: ["storage", "contextMenus", "tabs"],
    host_permissions: ["<all_urls>"],
    action: {
      default_title: "Glimpse — PDF Preview",
      default_popup: "popup.html",
      default_icon: {
        16: "icons/icon-16.png",
        32: "icons/icon-32.png",
        48: "icons/icon-48.png",
        128: "icons/icon-128.png",
      },
    },
    options_ui: {
      page: "options.html",
      open_in_tab: true,
    },
    content_scripts: [
      {
        matches: ["http://*/*", "https://*/*", "file:///*"],
        js: ["content.js"],
        css: ["content.css"],
        run_at: "document_idle",
        all_frames: true,
      },
    ],
    web_accessible_resources: [
      {
        resources: [
          "panel.css",
          "pdf.worker.js",
          "pagefetch.js",
          "viewer.html",
          "viewer.js",
          "viewer.css",
          "tooltip.css",
          "pdf_viewer.css",
          "images/*",
          "icons/*",
        ],
        matches: ["<all_urls>"],
      },
    ],
  };

  if (target === "firefox") {
    base.permissions.push("webRequest", "webRequestBlocking", "webRequestFilterResponse");
    // Explicit file:// host permission — required for background fetch of local PDFs.
    // This also makes the "Allow access to local files" toggle appear in about:addons.
    base.host_permissions.push("file:///*");
    base.background = { scripts: ["background.js"] };
    base.browser_specific_settings = {
      gecko: {
        id: "glimpse@merfanian.github.io",
        strict_min_version: "115.0",
        data_collection_permissions: {
          required: [],
          optional: [],
        },
      },
    };
  } else {
    // chrome / edge
    base.background = { service_worker: "background.js" };
  }

  writeFileSync(resolve(outdir, "manifest.json"), JSON.stringify(base, null, 2));
}

function copyStatic() {
  // pdf.js worker
  const workerCandidates = [
    resolve(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
    resolve(root, "node_modules/pdfjs-dist/build/pdf.worker.mjs"),
    resolve(root, "node_modules/pdfjs-dist/build/pdf.worker.min.js"),
  ];
  const worker = workerCandidates.find((p) => existsSync(p));
  if (worker) {
    copyFileSync(worker, resolve(outdir, "pdf.worker.js"));
  } else {
    console.warn("[build] pdf.js worker not found; run npm install first.");
  }

  // Options HTML
  copyFileSync(resolve(root, "src/options/options.html"), resolve(outdir, "options.html"));
  copyFileSync(resolve(root, "src/options/options.css"), resolve(outdir, "options.css"));

  // Bundled viewer page + its styles.
  copyFileSync(resolve(root, "src/viewer/viewer.html"), resolve(outdir, "viewer.html"));
  copyFileSync(resolve(root, "src/viewer/viewer.css"), resolve(outdir, "viewer.css"));
  copyFileSync(resolve(root, "src/content/tooltip.css"), resolve(outdir, "tooltip.css"));

  // pdf.js viewer component stylesheet + its image assets.
  const pdfViewerCss = resolve(root, "node_modules/pdfjs-dist/web/pdf_viewer.css");
  if (existsSync(pdfViewerCss)) copyFileSync(pdfViewerCss, resolve(outdir, "pdf_viewer.css"));
  const imagesSrc = resolve(root, "node_modules/pdfjs-dist/web/images");
  if (existsSync(imagesSrc)) {
    cpSync(imagesSrc, resolve(outdir, "images"), { recursive: true });
  }

  // Panel CSS (web-accessible so the content script can inject it into the page/shadow root)
  const panelCss = resolve(root, "src/content/panel/panel.css");
  if (existsSync(panelCss)) copyFileSync(panelCss, resolve(outdir, "panel.css"));

  // Popup HTML + CSS
  copyFileSync(resolve(root, "src/popup/popup.html"), resolve(outdir, "popup.html"));
  copyFileSync(resolve(root, "src/popup/popup.css"), resolve(outdir, "popup.css"));

  // Icons (rendered from glimpse.png by scripts/generate-icons.mjs)
  const iconsDir = resolve(root, "assets/icons");
  if (existsSync(iconsDir)) {
    mkdirSync(resolve(outdir, "icons"), { recursive: true });
    for (const size of [16, 32, 48, 128]) {
      const src = resolve(iconsDir, `icon-${size}.png`);
      if (existsSync(src)) copyFileSync(src, resolve(outdir, `icons/icon-${size}.png`));
    }
  }
}

async function run() {
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });

  if (watch) {
    for (const e of entries) {
      const ctx = await context({ ...common, ...e, outdir });
      await ctx.watch();
    }
    copyStatic();
    buildManifest();
    console.log(`[build] watching (${target}) -> ${outdir}`);
  } else {
    for (const e of entries) {
      await build({ ...common, ...e, outdir });
    }
    copyStatic();
    buildManifest();
    console.log(`[build] done (${target}) -> ${outdir}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
