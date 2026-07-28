// Builds the whole product site into site/.
//
//   1. site/icons.svg          — the lucide sprite (scripts/build-icons.mjs)
//   2. site/*.html             — hand-written page bodies in site/pages/
//   3. site/docs/*.html        — every published markdown document
//
// All three go through the same shell in scripts/site-chrome.mjs, which is
// what keeps the header, footer, navigation, and asset versioning identical
// across the site. Nothing here is committed — site/pages/ and docs/ are the
// sources of truth (see .gitignore).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";

import { page, icon, escapeHtml, REPO, RELEASES, LICENSING_EMAIL } from "./site-chrome.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = resolve(root, "docs");
const siteDir = resolve(root, "site");
const pagesDir = resolve(siteDir, "pages");
const outDocs = resolve(siteDir, "docs");

/* ── what gets published ──────────────────────────────────────────────────
   An explicit list rather than a glob: docs/ also holds internal working
   documents, and what appears on the site should be a deliberate choice
   rather than a side effect of a file existing.

   Deliberately not published:
     responsiveness-and-file-size-review.md — a living internal review that
     catalogues known weak points in detail. Still readable in the repo.

   `group` drives the docs index sections; order within a group is the order
   here, and is also the order of the prev/next pager. */
const PUBLISHED = [
  // ── Guides: written for someone using Blacksite ──
  {
    file: "guide/getting-started.md",
    title: "Getting Started",
    blurb: "Install, connect a provider, let the index build, and make a first request that teaches you something about your own repository.",
    group: "Start here",
    icon: "play",
  },
  {
    file: "guide/providers-and-models.md",
    title: "Providers, Keys & Models",
    blurb: "Anthropic, OpenAI, OpenRouter, and Bedrock. Where keys live, how thinking effort works, and why prompt caching decides what a session costs.",
    group: "Start here",
    icon: "key-round",
  },
  {
    file: "guide/working-with-chat.md",
    title: "Working with Chat",
    blurb: "The agent loop in practice: request profiles, slash commands, attachments, question cards, approvals, compaction, and subagents.",
    group: "Using Blacksite",
    icon: "message-square",
  },
  {
    file: "guide/map-guide.md",
    title: "Using the Codebase Map",
    blurb: "What the map shows, how to navigate it, the queries the agent runs against it, and how notes turn knowledge into graph edges.",
    group: "Using Blacksite",
    icon: "map",
  },
  {
    file: "guide/plans-and-context.md",
    title: "Plans, Context & Memory",
    blurb: "Four durable surfaces for what outlives a conversation — and which one to reach for when.",
    group: "Using Blacksite",
    icon: "list-todo",
  },
  {
    file: "guide/data-workbench.md",
    title: "Data Workbench",
    blurb: "An embedded SQLite workbench the agent can use too — reading through the same layer you do, and never executing a write.",
    group: "Using Blacksite",
    icon: "database",
  },
  {
    file: "guide/tool-reference.md",
    title: "Tool Reference",
    blurb: "Every family of tool the agent can call, and what knowing they exist changes about how you ask for things.",
    group: "Reference",
    icon: "wrench",
  },
  {
    file: "guide/settings-and-commands.md",
    title: "Settings & Commands",
    blurb: "All 26 blacksite.* settings and every command, explained rather than merely listed.",
    group: "Reference",
    icon: "settings",
  },
  {
    file: "guide/approvals-and-safety.md",
    title: "Approvals & Safety",
    blurb: "Where the gates sit, what the three permission lists do, what leaves your machine, and the one setting to think hard about.",
    group: "Reference",
    icon: "shield-check",
  },
  {
    file: "guide/troubleshooting.md",
    title: "Troubleshooting",
    blurb: "Symptoms, likely causes, and what to try — from a missing model in the picker to a map that goes blank.",
    group: "Reference",
    icon: "circle-help",
  },

  // ── Design documents: written while building it ──
  {
    file: "codebase-map.md",
    title: "Codebase Map",
    blurb: "How the map is indexed, laid out, and rendered — from file discovery through the WebGL scene graph.",
    group: "Architecture",
    icon: "waypoints",
  },
  {
    file: "lsp-code-intelligence.md",
    title: "LSP Code Intelligence",
    blurb: "The design spec for talking to VS Code's language servers instead of guessing at semantics.",
    group: "Architecture",
    icon: "file-code",
  },
  {
    file: "agent-environment.md",
    title: "Provider-Neutral Agent Environment",
    blurb: "Why the agent loop is written against a normalized event stream rather than any one provider's API.",
    group: "Architecture",
    icon: "globe",
  },
  // docs/agent-system-prompt-review.md and docs/lsp-reliability-implementation-plan.md are
  // deliberately absent. They are internal working documents — an engineering review and a
  // delivery plan, written for the people building this — and they read as such: findings,
  // milestones, exit criteria. The published site is for people using the product, so it
  // carries the guide and the design documents only.
];

const GROUP_ICON = {
  "Start here": "play",
  "Using Blacksite": "compass",
  Reference: "book-open",
  Architecture: "waypoints",
};

const GROUP_NOTE = {
  "Start here": "From nothing installed to a first useful request.",
  "Using Blacksite": "How to drive each surface well.",
  Reference: "Look things up. Every setting, tool, and gate.",
  Architecture: "Design documents written while building it.",
  "Engineering notes": "Working notes, kept because they are still true.",
};

/* ── markdown ─────────────────────────────────────────────────────────────
   markdown-it and highlight.js are already runtime dependencies of the
   extension, so publishing documentation adds no packages to install. */
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight(str, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : null;
    const code = language
      ? hljs.highlight(str, { language, ignoreIllegals: true }).value
      : md.utils.escapeHtml(str);

    // The copy button lives in the header rail; app.js wires the behaviour.
    return `<div class="bs-code"><div class="bs-code-bar"><span class="bs-code-lang">${
      escapeHtml(lang || "text")
    }</span><button type="button" class="bs-copy" data-copy>${icon("copy")}<span data-copy-label>Copy</span></button></div><pre class="hljs"><code>${code}</code></pre></div>`;
  },
});

/** Wrap markdown tables so a wide one scrolls inside itself, never the page. */
md.renderer.rules.table_open = () => '<div class="bs-table-scroll"><table>';
md.renderer.rules.table_close = () => "</table></div>";

/** Blockquotes become the site's callout, with `> **Warning.**` styled hot. */
md.renderer.rules.blockquote_open = () => '<blockquote class="bs-note">';
md.renderer.rules.blockquote_close = () => "</blockquote>";

/** Slug that matches how GitHub anchors headings, so in-document links survive. */
function slugify(text) {
  return text.trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
}

/** Give every heading a stable id plus a hover anchor, and collect the TOC. */
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
    if (level >= 2) {
      inline.children.push(
        Object.assign(new inline.constructor("html_inline", "", 0), {
          content: `<a class="bs-anchor" href="#${id}" aria-label="Link to this section">#</a>`,
        }),
      );
    }
    toc.push({ level, text, id });
  });

  return toc;
}

function renderToc(toc) {
  if (toc.length < 3) return "";
  const items = toc
    .filter((h) => h.level <= 3)
    .map((h) => `<li class="lvl-${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join("\n        ");

  return `<nav class="bs-toc" data-toc aria-label="On this page">
      <div class="bs-toc-title">On this page</div>
      <ul>
        ${items}
      </ul>
    </nav>`;
}

/* ── page-body templating ─────────────────────────────────────────────────
   The hand-written bodies in site/pages/ use three placeholders so a repo
   URL or an icon name is written once here rather than pasted everywhere. */
function expand(html) {
  return html
    .replace(/\{\{icon:([\w-]+)\}\}/g, (_, name) => icon(name))
    .replace(/\{\{RELEASES\}\}/g, RELEASES)
    .replace(/\{\{REPO\}\}/g, REPO)
    .replace(/\{\{EMAIL\}\}/g, LICENSING_EMAIL);
}

/* ── hand-written pages ───────────────────────────────────────────────────── */
const PAGES = [
  {
    file: "index.html",
    title: "Blacksite — See the system. Ship the work.",
    description:
      "An agentic coding environment for VS Code that understands your whole codebase: architecture, relationships, plans, data, and the work already in flight.",
    active: "product",
    scripts: ["demo.js", "map-demo.js", "release-download.js"],
  },
  {
    file: "learn.html",
    title: "How it works",
    description:
      "The concepts behind an AI coding agent — agent loops, tool schemas, provider neutrality, context compaction, prompt caching, static analysis, graph layout, and LSP — and how Blacksite implements each one.",
    active: "learn",
  },
  {
    file: "pricing.html",
    title: "Pricing",
    description:
      "Free for noncommercial use under PolyForm Noncommercial 1.0.0. Commercial licenses are per seat, with a 30-day evaluation first.",
    active: "pricing",
  },
  {
    file: "licensing.html",
    title: "Licensing",
    description:
      "Blacksite is source-available, not open source. The noncommercial grant, the commercial agreement, the evaluation license, and the CLA.",
    active: "licensing",
  },
  {
    file: "privacy.html",
    title: "Privacy",
    description:
      "What Blacksite sends, where it goes, what stays on your machine, and how your API keys are stored. No server in the path and no telemetry.",
    active: "",
  },
];

function buildPages() {
  for (const entry of PAGES) {
    const source = resolve(pagesDir, entry.file);
    if (!existsSync(source)) throw new Error(`site/pages/${entry.file} is missing.`);

    writeFileSync(
      resolve(siteDir, entry.file),
      page({
        title: entry.title,
        description: entry.description,
        body: expand(readFileSync(source, "utf8")),
        active: entry.active,
        depth: 0,
        scripts: entry.scripts ?? [],
      }),
      "utf8",
    );
    console.log(`  site/pages/${entry.file} -> site/${entry.file}`);
  }
}

/* ── documents ────────────────────────────────────────────────────────────── */
function buildDocs() {
  // Emptied rather than merged into. A document dropped from PUBLISHED would otherwise
  // leave its previously generated page behind and keep serving it — reachable by URL,
  // and linked from any stale sibling that still names it.
  rmSync(outDocs, { recursive: true, force: true });
  mkdirSync(outDocs, { recursive: true });

  // Every markdown file under docs/, one level deep, keyed by its basename so
  // cross-document links written for GitHub can be rewritten to siblings.
  const available = new Map();
  for (const entry of readdirSync(docsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) available.set(entry.name, entry.name);
    else if (entry.isDirectory()) {
      for (const nested of readdirSync(resolve(docsDir, entry.name))) {
        if (nested.endsWith(".md")) available.set(nested, `${entry.name}/${nested}`);
      }
    }
  }

  const built = [];

  for (const [index, entry] of PUBLISHED.entries()) {
    const sourcePath = resolve(docsDir, entry.file);
    if (!existsSync(sourcePath)) {
      throw new Error(`docs/${entry.file} is in the publish list but does not exist.`);
    }

    const source = readFileSync(sourcePath, "utf8");
    const tokens = md.parse(source, {});
    const toc = withHeadingAnchors(tokens);
    let html = md.renderer.render(tokens, md.options, {});

    // Links written for GitHub point at .md files; on the site every document
    // is a flat sibling .html under docs/, regardless of its source directory.
    html = html.replace(/href="([^"]+)\.md(#[^"]*)?"/g, (match, path, hash) =>
      available.has(`${basename(path)}.md`) ? `href="${basename(path)}.html${hash ?? ""}"` : match,
    );

    const slug = basename(entry.file).replace(/\.md$/, "");
    const previous = PUBLISHED[index - 1];
    const next = PUBLISHED[index + 1];

    const pager = [previous, next].some(Boolean)
      ? `<nav class="bs-doc-pager" aria-label="Document navigation">
        ${previous ? `<a href="${basename(previous.file).replace(/\.md$/, "")}.html"><span>${icon("arrow-right")} Previous</span><strong>${escapeHtml(previous.title)}</strong></a>` : "<span></span>"}
        ${next ? `<a class="bs-next" href="${basename(next.file).replace(/\.md$/, "")}.html"><span>Next ${icon("arrow-right")}</span><strong>${escapeHtml(next.title)}</strong></a>` : ""}
      </nav>`
      : "";

    const body = `<div class="bs-wrap bs-doc-layout">
    ${renderToc(toc)}
    <article class="bs-doc">
      <p class="bs-doc-crumb"><a href="./">Docs</a> ${icon("chevron-right")} ${escapeHtml(entry.group)}</p>
      ${html}
      <div class="bs-doc-foot">
        <span>Source: <a href="${REPO}/blob/main/docs/${entry.file}">docs/${entry.file}</a></span>
        <span>${toc.length} sections</span>
      </div>
      ${pager}
    </article>
  </div>`;

    writeFileSync(
      resolve(outDocs, `${slug}.html`),
      page({
        title: entry.title,
        description: entry.blurb,
        body,
        active: "docs",
        depth: 1,
        beforeMain: '<span class="bs-progress" data-progress></span>',
      }),
      "utf8",
    );

    // The index card's filter text includes every heading, so searching for a
    // term that only appears deep in a document still finds the document.
    built.push({
      ...entry,
      slug,
      headings: toc.length,
      search: `${entry.title} ${entry.blurb} ${entry.group} ${toc.map((h) => h.text).join(" ")}`
        .toLowerCase()
        .replace(/\s+/g, " "),
    });
    console.log(`  docs/${entry.file} -> site/docs/${slug}.html (${toc.length} headings)`);
  }

  buildDocsIndex(built);
}

function buildDocsIndex(built) {
  const groups = [...new Set(built.map((d) => d.group))];

  const sections = groups
    .map((group) => {
      const cards = built
        .filter((d) => d.group === group)
        .map(
          (d) => `        <a class="bs-card bs-doc-card" href="${d.slug}.html" data-doc-card="${escapeHtml(d.search)}">
          <span class="bs-chip bs-chip-accent">${icon(d.icon)} ${escapeHtml(group)}</span>
          <h3>${escapeHtml(d.title)}</h3>
          <p>${escapeHtml(d.blurb)}</p>
          <footer>Read ${icon("arrow-right")} <em>${d.headings} sections</em></footer>
        </a>`,
        )
        .join("\n");

      return `    <section class="bs-doc-group" data-doc-group>
      <h2>${icon(GROUP_ICON[group] ?? "book-open")} ${escapeHtml(group)} <em>${escapeHtml(GROUP_NOTE[group] ?? "")}</em></h2>
      <div class="bs-grid">
${cards}
      </div>
    </section>`;
    })
    .join("\n\n");

  const body = `<section class="bs-section bs-section-tight">
  <div class="bs-wrap">
    <p class="bs-eyebrow">${icon("book-open")} Documentation</p>
    <h1 style="margin:16px 0 22px">Everything, <em>written down.</em></h1>
    <p class="bs-lede">Guides for using Blacksite, a reference for everything it exposes, and the design documents written while building it. New to the ideas behind agentic coding tools? Start with <a href="../learn.html">Learn</a>.</p>

    <label class="bs-field bs-doc-search">
      ${icon("search")}
      <input type="search" placeholder="Filter documentation…  (press /)" data-doc-search aria-label="Filter documentation">
    </label>

${sections}

    <p class="bs-doc-empty" data-doc-empty>Nothing matches that. Try a broader term, or ${
      ""
    }<a href="${REPO}/issues">open an issue</a> if something you expected to find is missing.</p>
  </div>
</section>`;

  writeFileSync(
    resolve(outDocs, "index.html"),
    page({
      title: "Documentation",
      description:
        "Guides, reference material, and design documents for the Blacksite VS Code extension.",
      body,
      active: "docs",
      depth: 1,
    }),
    "utf8",
  );

  console.log(`  -> site/docs/index.html (${built.length} documents, ${groups.length} groups)`);
}

/* ── run ──────────────────────────────────────────────────────────────────── */
console.log("Building icon sprite…");
execFileSync(process.execPath, [resolve(root, "scripts/build-icons.mjs")], { stdio: "inherit" });

console.log("Building pages…");
buildPages();

console.log("Building documents…");
buildDocs();

console.log("Site build complete.");
