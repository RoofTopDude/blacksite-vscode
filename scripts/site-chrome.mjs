// The one definition of the site's page shell: <head>, header, footer, icon
// sprite, and the shared scripts.
//
// Every page on the site — hand-written or generated from markdown — is
// rendered through `page()` here, which is what keeps the header, footer,
// navigation, and asset versioning identical across all of them. Editing the
// chrome in one place used to mean editing it in six.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const REPO = "https://github.com/RoofTopDude/blacksite-vscode";
export const RELEASES = `${REPO}/releases/latest`;
export const LICENSING_EMAIL = "mgriffith@blacksite-agent.com";

/** Bumped whenever the CSS/JS changes shape, to bust Pages' aggressive caching. */
export const ASSET_VERSION = "20260728-alive";

/** The ◈ mark as a data URI, so the tab icon costs no request and no file. */
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="7" fill="#09090b"/>' +
      '<g transform="rotate(-30 16 16)" fill="none" stroke="#c4b5fd" stroke-width="2">' +
      '<rect x="4.5" y="14" width="7" height="7" transform="rotate(45 8 17.5)"/>' +
      '<rect x="12.5" y="7" width="7" height="7" transform="rotate(45 16 10.5)"/>' +
      '<rect x="20.5" y="14" width="7" height="7" transform="rotate(45 24 17.5)"/>' +
      "</g></svg>",
  );

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** An <svg><use> reference into the inlined sprite. `size` is a CSS length. */
export function icon(name, { size, cls = "" } = {}) {
  const style = size ? ` style="width:${size};height:${size}"` : "";
  const className = cls ? `bs-icon ${cls}` : "bs-icon";
  return `<svg class="${className}" aria-hidden="true"${style}><use href="#i-${name}"/></svg>`;
}

/** Read the generated sprite. build-site.mjs writes it before rendering pages. */
export function sprite() {
  return readFileSync(resolve(root, "site/icons.svg"), "utf8").trim();
}

/**
 * Primary navigation. `key` matches the `active` passed to page(), and `href`
 * is written relative to the site root — page() re-bases it for nested pages.
 */
const NAV = [
  { key: "product", href: "index.html", label: "Product" },
  { key: "learn", href: "learn.html", label: "Learn" },
  { key: "docs", href: "docs/", label: "Docs" },
  { key: "pricing", href: "pricing.html", label: "Pricing" },
  { key: "licensing", href: "licensing.html", label: "Licensing" },
];

const FOOTER_COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "index.html#map", label: "Codebase Map" },
      { href: "index.html#surfaces", label: "The six views" },
      { href: "index.html#workflow", label: "How it works" },
      { href: RELEASES, label: "Download VSIX", external: true },
    ],
  },
  {
    title: "Learn",
    links: [
      { href: "learn.html", label: "Concepts" },
      { href: "docs/getting-started.html", label: "Getting started" },
      { href: "docs/", label: "All documentation" },
      { href: "docs/troubleshooting.html", label: "Troubleshooting" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "licensing.html", label: "Licensing" },
      { href: "privacy.html", label: "Privacy" },
      { href: `${REPO}/blob/main/LICENSE.md`, label: "PolyForm NC 1.0.0", external: true },
      { href: REPO, label: "Source", external: true },
    ],
  },
];

/** Rewrite a root-relative href for a page nested `depth` directories down. */
function rebase(href, depth) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  return depth > 0 ? "../".repeat(depth) + href : href;
}

function header(active, depth) {
  const links = NAV.map((item) => {
    const cls = item.key === active ? ' class="is-active"' : "";
    return `<a href="${rebase(item.href, depth)}"${cls}>${item.label}</a>`;
  }).join("");

  return `<header class="bs-header" data-header>
  <div class="bs-wrap">
    <a class="bs-brand" href="${rebase("index.html", depth)}" aria-label="Blacksite home">
      <span class="bs-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>BLACKSITE</span>
    </a>
    <button class="bs-menu-btn" type="button" data-menu-btn aria-expanded="false" aria-controls="bs-nav" aria-label="Open navigation">
      ${icon("menu")}
    </button>
    <nav class="bs-nav" id="bs-nav" data-nav aria-label="Primary">
      ${links}
      <a href="${REPO}" rel="noopener">GitHub ${icon("arrow-up-right")}</a>
    </nav>
    <a class="bs-btn bs-btn-primary bs-btn-sm bs-header-cta" href="${RELEASES}" data-release-download>
      ${icon("download")} Download
    </a>
  </div>
</header>`;
}

function footer(depth) {
  const columns = FOOTER_COLUMNS.map(
    (col) => `<div>
        <h4>${col.title}</h4>
        <nav>${col.links
          .map(
            (l) =>
              `<a href="${rebase(l.href, depth)}"${l.external ? ' rel="noopener"' : ""}>${l.label}${
                l.external ? " " + icon("arrow-up-right") : ""
              }</a>`,
          )
          .join("")}</nav>
      </div>`,
  ).join("\n      ");

  return `<footer class="bs-footer">
  <div class="bs-wrap">
      <div class="bs-footer-brand">
        <a class="bs-brand" href="${rebase("index.html", depth)}">
          <span class="bs-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>BLACKSITE</span>
        </a>
        <p>Workspace intelligence for people building software. Bring your own key; nothing is proxied.</p>
      </div>
      ${columns}
  </div>
  <div class="bs-wrap">
    <div class="bs-footer-base">
      <span>&copy; ${new Date().getFullYear()} Morgan Griffith · Source-available under PolyForm Noncommercial 1.0.0</span>
      <span>Commercial licensing: <a href="mailto:${LICENSING_EMAIL}">${LICENSING_EMAIL}</a></span>
    </div>
  </div>
</footer>`;
}

/**
 * Render a complete page.
 *
 * @param {object} options
 * @param {string} options.title       <title>, without the " — Blacksite" suffix
 * @param {string} options.description meta description
 * @param {string} options.body        everything inside <main>
 * @param {string} [options.active]    nav key to mark current
 * @param {number} [options.depth]     directories below the site root
 * @param {string[]} [options.scripts] extra scripts, root-relative
 * @param {string} [options.bodyClass] extra class on <body>
 * @param {string} [options.beforeMain] markup between <body> and <main>
 */
export function page({
  title,
  description,
  body,
  active = "",
  depth = 0,
  scripts = [],
  bodyClass = "",
  beforeMain = "",
}) {
  const asset = (file) => `${rebase(file, depth)}?v=${ASSET_VERSION}`;
  const allScripts = ["app.js", ...scripts]
    .map((s) => `<script src="${asset(s)}" defer></script>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#09090b">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)} — Blacksite</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:site_name" content="Blacksite">
<meta property="og:title" content="${escapeHtml(title)} — Blacksite">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${FAVICON}">
<link rel="preload" href="${rebase("fonts/lexend-latin.woff2", depth)}" as="font" type="font/woff2" crossorigin>
<script>document.documentElement.classList.add("bs-js")</script>
<link rel="stylesheet" href="${asset("style.css")}">
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ""}>
${sprite()}
<a class="bs-skip" href="#main">Skip to content</a>
<div class="bs-page">
${header(active, depth)}
${beforeMain}
<main class="bs-main" id="main">
${body}
</main>
${footer(depth)}
</div>
<button class="bs-totop" type="button" data-totop aria-label="Back to top">${icon("arrow-up")}</button>
${allScripts}
</body>
</html>
`;
}
