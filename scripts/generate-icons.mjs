// Generates the manifest icons (48px, 128px) from assets/logo.svg.
// Renders with rsvg-convert or Inkscape when available. If no renderer is
// present (e.g. a bare CI runner), the committed PNGs in assets/icons/ are
// reused, so the build never fails for lack of a rasteriser.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = resolve(root, "assets/logo.svg");
const outDir = resolve(root, "assets/icons");
const sizes = [48, 128];

function has(cmd) {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function render(size, out) {
  if (has("rsvg-convert")) {
    execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), svg, "-o", out]);
    return true;
  }
  if (has("inkscape")) {
    execFileSync("inkscape", [svg, "-w", String(size), "-h", String(size), "-o", out]);
    return true;
  }
  return false;
}

let rendered = 0;
for (const size of sizes) {
  const out = resolve(outDir, `icon-${size}.png`);
  if (render(size, out)) {
    rendered++;
  } else if (!existsSync(out)) {
    console.error(`[icons] no SVG renderer and missing ${out}. Install librsvg2-bin or Inkscape.`);
    process.exit(1);
  }
}

console.log(
  rendered === sizes.length
    ? "[icons] rendered 48px and 128px icons from assets/logo.svg"
    : "[icons] no renderer found; using committed PNG icons"
);
