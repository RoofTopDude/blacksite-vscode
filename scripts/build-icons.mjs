// Generates site/icons.svg — an inline SVG sprite of <symbol> definitions.
//
// The icons are lifted from lucide-react, which the extension's own webviews
// already use, so a glyph on the marketing site is literally the same shape the
// product draws. Hand-transcribing path data is how those two drift apart, so
// this reads the installed package instead.
//
// Output is generated, not committed (see .gitignore). build-docs.mjs inlines
// the result into every generated page; the hand-written pages inline it via
// the same helper in scripts/site-chrome.mjs.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconDir = resolve(root, "node_modules/lucide-react/dist/esm/icons");

/** name-on-the-site → lucide icon file. Keep this list tight; every entry ships. */
const ICONS = {
  // chrome + navigation
  menu: "menu",
  x: "x",
  search: "search",
  copy: "copy",
  check: "check",
  download: "download",
  "external-link": "external-link",
  "arrow-right": "arrow-right",
  "arrow-up-right": "arrow-up-right",
  "arrow-up": "arrow-up",
  "chevron-right": "chevron-right",
  "chevron-down": "chevron-down",
  plus: "plus",
  minus: "minus",
  crosshair: "crosshair",

  // the extension's own chrome — same glyphs the webviews render
  sparkles: "sparkles",
  "git-branch-plus": "git-branch-plus",
  "scan-search": "scan-search",
  bug: "bug",
  history: "rotate-ccw-clock",
  info: "info",
  settings: "settings",
  paperclip: "paperclip",
  "corner-down-left": "corner-down-left",
  "square-pen": "square-pen",

  // surfaces + transcript roles
  "message-square": "message-square",
  user: "user",
  "list-todo": "list-todo",
  layers: "layers",
  database: "database",
  map: "map",
  "notebook-pen": "notebook-pen",

  // tools + activity
  "file-text": "file-text",
  "file-code": "file-code",
  "file-pen": "file-pen",
  "folder-tree": "folder-tree",
  terminal: "terminal",
  waypoints: "waypoints",
  "git-branch": "git-branch",
  "flask-conical": "flask-conical",
  brain: "brain",
  globe: "globe",
  wrench: "wrench",
  table: "table",
  "circle-check-big": "circle-check-big",
  "loader-circle": "loader-circle",
  play: "play",
  "rotate-ccw": "rotate-ccw",

  // concepts
  "shield-check": "shield-check",
  lock: "lock",
  "key-round": "key-round",
  zap: "zap",
  gauge: "gauge",
  compass: "compass",
  workflow: "workflow",
  "book-open": "book-open",
  "graduation-cap": "graduation-cap",
  lightbulb: "lightbulb",
  "triangle-alert": "triangle-alert",
  "circle-help": "circle-question-mark",
  "list-checks": "list-checks",
  eye: "eye",
  clock: "clock",
  keyboard: "keyboard",
  "panel-left": "panel-left",
};

/** GitHub has no lucide glyph and the brand mark is a filled shape, not a stroke. */
const CUSTOM = {
  github: {
    fill: true,
    body:
      '<path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.2 11.39.6.11.82-.26.82-.58l-.01-2.05c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.22l-.01 3.29c0 .32.21.7.82.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z"/>',
  },
};

/** Pull the icon's node array out of the ESM module and re-emit it as SVG elements. */
function readIconBody(file) {
  let path = resolve(iconDir, `${file}.mjs`);
  if (!existsSync(path)) throw new Error(`lucide icon not found: ${file}`);

  // Some names are aliases that just re-export another module.
  let source = readFileSync(path, "utf8");
  const alias = source.match(/export \{ default \} from '\.\/([\w-]+)\.mjs'/);
  if (alias) {
    path = resolve(iconDir, `${alias[1]}.mjs`);
    source = readFileSync(path, "utf8");
  }

  const nodes = source.match(/const __iconNode = (\[[\s\S]*?\]);\n/);
  if (!nodes) throw new Error(`could not parse icon node for ${file}`);

  // The node array is plain data with unquoted keys — evaluate it rather than
  // writing a parser for a shape lucide controls.
  const parsed = new Function(`return ${nodes[1]}`)();

  return parsed
    .map(([tag, attrs]) => {
      const rendered = Object.entries(attrs)
        .filter(([key]) => key !== "key")
        .map(([key, value]) => `${key}="${value}"`)
        .join(" ");
      return `<${tag} ${rendered}/>`;
    })
    .join("");
}

function build() {
  const symbols = [];

  for (const [name, file] of Object.entries(ICONS)) {
    symbols.push(
      `<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
        `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${readIconBody(file)}</symbol>`,
    );
  }

  for (const [name, def] of Object.entries(CUSTOM)) {
    symbols.push(
      `<symbol id="i-${name}" viewBox="0 0 24 24" fill="${def.fill ? "currentColor" : "none"}" ` +
        `stroke="none">${def.body}</symbol>`,
    );
  }

  const sprite =
    `<svg xmlns="http://www.w3.org/2000/svg" class="bs-sprite" aria-hidden="true" focusable="false">` +
    symbols.join("") +
    `</svg>\n`;

  writeFileSync(resolve(root, "site/icons.svg"), sprite, "utf8");
  console.log(`  -> site/icons.svg (${symbols.length} symbols, ${(sprite.length / 1024).toFixed(1)} kB)`);
}

build();
