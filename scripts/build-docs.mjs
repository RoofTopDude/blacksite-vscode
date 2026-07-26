// Renders docs/*.md into site/docs/*.html at Pages build time.
//
// Uses markdown-it and highlight.js, both already runtime dependencies of the
// extension, so publishing documentation adds no new packages to install.
//
// Output is generated, not committed (see .gitignore) — the markdown in docs/
// stays the single source of truth.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = resolve(root, "docs");
const outDir = resolve(root, "site/docs");

// Explicit allowlist rather than a glob: docs/ also holds internal working
// documents, and what gets published on the site should be a deliberate choice
// rather than a side effect of a file existing.
//
// Deliberately not published:
//   responsiveness-and-file-size-review.md — a living internal review that
//   catalogues known weak points in detail. Still readable in the repo; add it
//   to this list if you want it on the site too.
const PUBLISHED = [
  {
    file: "codebase-map.md",
    title: "Codebase Map",
    blurb: "How the map is indexed, laid out, and rendered — from file discovery through the WebGL scene graph.",
    group: "Architecture",
  },
  {
    file: "lsp-code-intelligence.md",
    title: "LSP Code Intelligence",
    blurb: "The design spec for talking to VS Code's language servers instead of guessing at semantics.",
    group: "Architecture",
  },
  {
    file: "agent-environment.md",
    title: "Provider-Neutral Agent Environment",
    blurb: "Why the agent loop is written against a normalized event stream rather than any one provider's API.",
    group: "Architecture",
  },
  {
    file: "agent-system-prompt-review.md",
    title: "System Prompt & Request Profiles",
    blurb: "A review of what the agent is told, and how request profiles shape each turn.",
    group: "Engineering notes",
  },
  {
    file: "lsp-reliability-implementation-plan.md",
    title: "LSP Reliability Plan",
    blurb: "Orchestration, safety, and reliability work for the code-intelligence layer.",
    group: "Engineering notes",
  },
];

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        /* fall through to the escaped default */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

/** Slug that matches how GitHub anchors headings, so in-document links survive. */
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/** Collect headings and give each one a stable id for the table of contents. */
function withHeadingAnchors(tokens) {
  const toc = [];
  const seen = new Map();

  tokens.forEach((token, index) => {
    if (token.type !== "heading_open") return;
    const level = Number(token.tag.slice(1));
    if (level > 3) return;

    const inline = tokens[index + 1];
    if (!inline || inline.type !== "inline") return;

    const text = inline.content.replace(/`/g, "");
    let id = slugify(text);
    // Duplicate headings are common in long specs; suffix them the way GitHub does.
    const count = seen.get(id) ?? 0;
    seen.set(id, count + 1);
    if (count > 0) id = `${id}-${count}`;

    token.attrSet("id", id);
    toc.push({ level, text, id });
  });

  return toc;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function chrome(activeHref) {
  const link = (href, label) =>
    `<a href="${href}"${href === activeHref ? ' class="active"' : ""}>${label}</a>`;
  return `<header class="site">
  <div class="wrap">
    <a class="brand" href="../">Black<span>site</span></a>
    <nav class="site">
      ${link("../#features", "Features")}
      ${link("../learn.html", "Learn")}
      ${link("./", "Docs")}
      ${link("../pricing.html", "Pricing")}
      ${link("../privacy.html", "Privacy")}
      <a href="https://github.com/RoofTopDude/blacksite-vscode">Source</a>
    </nav>
  </div>
</header>`;
}

const FOOTER = `<footer class="site">
  <div class="wrap">
    <div>&copy; Morgan Griffith</div>
    <nav>
      <a href="../">Home</a>
      <a href="../learn.html">Learn</a>
      <a href="./">Docs</a>
      <a href="https://github.com/RoofTopDude/blacksite-vscode">GitHub</a>
    </nav>
  </div>
</footer>`;

function page({ title, description, body, active }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Blacksite</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="stylesheet" href="../style.css">
</head>
<body>
${chrome(active)}
${body}
${FOOTER}
</body>
</html>
`;
}

function renderToc(toc) {
  if (toc.length < 3) return "";
  const items = toc
    .filter((h) => h.level <= 3)
    .map((h) => `<li class="lvl-${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join("\n        ");
  return `<nav class="toc" aria-label="On this page">
      <div class="toc-title">On this page</div>
      <ul>
        ${items}
      </ul>
    </nav>`;
}

function build() {
  mkdirSync(outDir, { recursive: true });

  const available = new Set(readdirSync(docsDir).filter((f) => f.endsWith(".md")));
  const built = [];

  for (const entry of PUBLISHED) {
    if (!available.has(entry.file)) {
      throw new Error(`docs/${entry.file} is in the publish list but does not exist.`);
    }

    const source = readFileSync(resolve(docsDir, entry.file), "utf8");
    const tokens = md.parse(source, {});
    const toc = withHeadingAnchors(tokens);
    let html = md.renderer.render(tokens, md.options, {});

    // Cross-document links written for GitHub point at .md files; on the site
    // those are sibling .html pages.
    html = html.replace(/href="([^"]+)\.md(#[^"]*)?"/g, (match, path, hash) =>
      available.has(`${basename(path)}.md`) ? `href="${basename(path)}.html${hash ?? ""}"` : match,
    );

    const slug = entry.file.replace(/\.md$/, "");
    const body = `<section class="doc">
  <div class="wrap doc-layout">
    ${renderToc(toc)}
    <article class="doc-body">
      <p class="doc-breadcrumb"><a href="./">Docs</a> / ${escapeHtml(entry.group)}</p>
      ${html}
      <p class="doc-source">
        Source: <a href="https://github.com/RoofTopDude/blacksite-vscode/blob/main/docs/${entry.file}">docs/${entry.file}</a>
      </p>
    </article>
  </div>
</section>`;

    writeFileSync(
      resolve(outDir, `${slug}.html`),
      page({ title: entry.title, description: entry.blurb, body, active: "./" }),
      "utf8",
    );

    built.push({ ...entry, slug, headings: toc.length });
    console.log(`  docs/${entry.file} -> site/docs/${slug}.html (${toc.length} headings)`);
  }

  const groups = [...new Set(built.map((d) => d.group))];
  const index = groups
    .map(
      (group) => `      <h2>${escapeHtml(group)}</h2>
      <div class="grid">
${built
  .filter((d) => d.group === group)
  .map(
    (d) => `        <a class="card card-link" href="${d.slug}.html">
          <h3>${escapeHtml(d.title)}</h3>
          <p>${escapeHtml(d.blurb)}</p>
        </a>`,
  )
  .join("\n")}
      </div>`,
    )
    .join("\n\n");

  const indexBody = `<section class="hero" style="padding-bottom:24px">
  <div class="wrap">
    <h1>Documentation</h1>
    <p class="lede">
      The design documents written while building Blacksite. These are the working specs, not
      marketing copy &mdash; they describe how the thing is actually put together.
    </p>
  </div>
</section>

<section style="padding-top:16px">
  <div class="wrap">
${index}

    <p class="note" style="margin-top:40px">
      New to the ideas behind this? Start with <a href="../learn.html">Learn</a>, which explains the
      concepts these documents assume.
    </p>
  </div>
</section>`;

  writeFileSync(
    resolve(outDir, "index.html"),
    page({
      title: "Documentation",
      description: "Design documents and engineering notes from building the Blacksite VS Code extension.",
      body: indexBody,
      active: "./",
    }),
    "utf8",
  );

  console.log(`  -> site/docs/index.html (${built.length} documents)`);
}

build();
