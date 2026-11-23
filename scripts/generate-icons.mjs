// Generates the manifest icons from the vector artwork:
//   assets/icons/glimpse.svg        → 48 and 128 px
//   assets/icons/glimpse-small.svg  → 16 and 32 px (simplified for legibility)
// Rendered with ImageMagick (`magick`/`convert`, librsvg delegate). When ImageMagick is
// unavailable (e.g. a bare CI runner) the committed PNGs are reused so builds never fail.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, "assets/icons");
const sources = { 16: "glimpse-small.svg", 32: "glimpse-small.svg", 48: "glimpse.svg", 128: "glimpse.svg" };

function magickCmd() {
  for (const cmd of ["magick", "convert"]) {
    try {
      execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
      return cmd;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const cmd = magickCmd();
let rendered = 0;

for (const [size, file] of Object.entries(sources)) {
  const src = resolve(dir, file);
  const out = resolve(dir, `icon-${size}.png`);
  if (cmd && existsSync(src)) {
    try {
      execFileSync(cmd, [
        "-background", "none", "-density", "600", src,
        "-resize", `${size}x${size}`, "-depth", "8", "-strip", out,
      ]);
      rendered++;
      continue;
    } catch (err) {
      console.warn(`[icons] couldn't render ${file}: ${err.message}`);
    }
  }
  if (!existsSync(out)) {
    console.error(`[icons] cannot render and missing ${out}. Install ImageMagick with SVG support.`);
    process.exit(1);
  }
}

console.log(
  rendered === Object.keys(sources).length
    ? "[icons] rendered 16, 32, 48, 128px icons from glimpse.svg / glimpse-small.svg"
    : "[icons] ImageMagick unavailable; using committed PNG icons",
);
