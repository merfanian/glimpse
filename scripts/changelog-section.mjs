// Prints the CHANGELOG.md section for a version (without its "## [x.y.z]" heading).
// Usage: node scripts/changelog-section.mjs 1.2.0
// Exits 1 if the section is missing or empty, so a release can't ship without notes.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: node scripts/changelog-section.mjs <x.y.z>");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lines = readFileSync(resolve(root, "CHANGELOG.md"), "utf8").split("\n");
const escaped = version.replace(/\./g, "\\.");
const start = lines.findIndex((l) => new RegExp(`^## \\[?v?${escaped}\\]?(\\s|$)`).test(l));
if (start < 0) {
  console.error(`CHANGELOG.md has no "## [${version}]" section. Add release notes before tagging.`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join("\n").trim();
if (!body) {
  console.error(`CHANGELOG.md section for ${version} is empty.`);
  process.exit(1);
}
process.stdout.write(body + "\n");
