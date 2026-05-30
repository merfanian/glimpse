// Zips each built browser target in dist/ into dist/<target>.zip for distribution.
import { readdirSync, statSync, createWriteStream, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
if (!existsSync(distDir)) {
  console.error("No dist/ directory. Run the build first.");
  process.exit(1);
}

for (const name of readdirSync(distDir)) {
  const dir = resolve(distDir, name);
  if (!statSync(dir).isDirectory()) continue;
  const zipPath = resolve(distDir, `${name}.zip`);
  try {
    execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: dir });
    console.log(`[package] wrote ${zipPath}`);
  } catch (err) {
    console.error(`[package] failed to zip ${name}: ${err.message}`);
  }
}
