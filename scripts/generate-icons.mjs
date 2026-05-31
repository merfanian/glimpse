// Generates the manifest icons from the source artwork assets/icons/glimpse.png.
// Trims the surrounding whitespace and renders centred square PNGs at each size
// using ImageMagick (`magick`/`convert`). When ImageMagick is unavailable (e.g.
// a bare CI runner) the committed PNGs are reused so the build never fails.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "assets/icons/glimpse.png");
const outDir = resolve(root, "assets/icons");
const sizes = [16, 32, 48, 128];

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

for (const size of sizes) {
  const out = resolve(outDir, `icon-${size}.png`);
  if (cmd && existsSync(src)) {
    execFileSync(cmd, [
      src,
      "-fuzz", "6%", "-trim", "+repage",
      "-resize", `${size}x${size}`,
      "-background", "white", "-gravity", "center", "-extent", `${size}x${size}`,
      "-strip", out,
    ]);
    rendered++;
  } else if (!existsSync(out)) {
    console.error(`[icons] ImageMagick not found and missing ${out}. Install imagemagick.`);
    process.exit(1);
  }
}

console.log(
  rendered === sizes.length
    ? `[icons] rendered ${sizes.join(", ")}px icons from glimpse.png`
    : "[icons] ImageMagick not found; using committed PNG icons"
);
