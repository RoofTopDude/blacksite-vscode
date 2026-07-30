import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const archivePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, `${sourceManifest.name}-${sourceManifest.version}.vsix`);

if (!fs.existsSync(archivePath)) {
  throw new Error(`VSIX not found: ${archivePath}`);
}

const entries = unzipSync(fs.readFileSync(archivePath));
const names = Object.keys(entries);
const required = [
  "extension/package.json",
  "extension/out/extension.js",
  "extension/out/webview/shell.html",
  "extension/node_modules/playwright-core/package.json",
  "extension/readme.md",
  "extension/changelog.md",
];
for (const name of required) {
  if (!entries[name]) throw new Error(`VSIX is missing required entry: ${name}`);
}

const forbiddenPrefixes = [
  "extension/.blacksite/",
  "extension/.github/",
  "extension/.vscode/",
  "extension/docs/",
  "extension/packages/",
  "extension/scripts/",
  "extension/site/",
  "extension/src/",
  "extension/tests/",
];
const forbidden = names.find((name) => forbiddenPrefixes.some((prefix) => name.startsWith(prefix))
  || name.endsWith(".js.map")
  || name.endsWith(".vsix")
  || name.endsWith(".zip"));
if (forbidden) {
  throw new Error(`VSIX contains a forbidden development artifact: ${forbidden}`);
}

const packagedManifest = JSON.parse(strFromU8(entries["extension/package.json"]));
if (packagedManifest.name !== sourceManifest.name || packagedManifest.version !== sourceManifest.version) {
  throw new Error(
    `VSIX manifest ${packagedManifest.name}@${packagedManifest.version} does not match `
    + `${sourceManifest.name}@${sourceManifest.version}.`,
  );
}

console.log(`Verified ${path.basename(archivePath)} (${names.length} entries, no development artifacts).`);
