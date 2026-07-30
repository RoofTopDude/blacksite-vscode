/* Full Markdown renderer for assistant output.
 *
 * The chat transcript renders untrusted model text, so Markdown is parsed with
 * markdown-it and then sanitised before it reaches dangerouslySetInnerHTML.
 * Keeping parsing here (rather than spread across the view) also lets the
 * streaming UI defer expensive re-renders without changing the final output.
 */

import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import hljsBash from "highlight.js/lib/languages/bash";
import hljsCss from "highlight.js/lib/languages/css";
import hljsDiff from "highlight.js/lib/languages/diff";
import hljsHtml from "highlight.js/lib/languages/xml";
import hljsJavascript from "highlight.js/lib/languages/javascript";
import hljsJson from "highlight.js/lib/languages/json";
import hljsMarkdown from "highlight.js/lib/languages/markdown";
import hljsPython from "highlight.js/lib/languages/python";
import hljsSql from "highlight.js/lib/languages/sql";
import hljsTypescript from "highlight.js/lib/languages/typescript";
import hljsYaml from "highlight.js/lib/languages/yaml";
import mdAbbr from "markdown-it-abbr";
import mdDeflist from "markdown-it-deflist";
import { full as mdEmoji } from "markdown-it-emoji";
import mdMark from "markdown-it-mark";
import mdSub from "markdown-it-sub";
import mdSup from "markdown-it-sup";
import mdTaskLists from "markdown-it-task-lists";

const FILE_LINE_SUFFIX = /#L?(\d+)$/;

export const SANITIZE_CONFIG = {
  RETURN_TRUSTED_TYPE: false as const,
  /* Every element the renderer rules below emit has to be listed here too. DOMPurify drops
     an unlisted tag and hoists its text in place of it, which fails silently: the code
     block's copy control would render as the word "Copy" with no element behind it for
     Markdown.tsx's click delegate to match. */
  ALLOWED_TAGS: [
    "p", "br", "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td", "hr", "img", "sup", "sub",
    "span", "div", "mark", "dl", "dt", "dd", "abbr", "input", "label",
    "details", "summary", "button",
  ],
  ALLOWED_ATTR: [
    "href", "target", "rel", "class", "alt", "src", "title", "align", "colspan", "rowspan",
    "checked", "disabled", "type", "id", "for", "loading", "decoding", "data-file-open", "data-file-line",
  ],
};

function registerLanguages(): void {
  hljs.registerLanguage("bash", hljsBash);
  hljs.registerLanguage("sh", hljsBash);
  hljs.registerLanguage("css", hljsCss);
  hljs.registerLanguage("diff", hljsDiff);
  hljs.registerLanguage("html", hljsHtml);
  hljs.registerLanguage("xml", hljsHtml);
  hljs.registerLanguage("javascript", hljsJavascript);
  hljs.registerLanguage("js", hljsJavascript);
  hljs.registerLanguage("json", hljsJson);
  hljs.registerLanguage("markdown", hljsMarkdown);
  hljs.registerLanguage("md", hljsMarkdown);
  hljs.registerLanguage("python", hljsPython);
  hljs.registerLanguage("py", hljsPython);
  hljs.registerLanguage("sql", hljsSql);
  hljs.registerLanguage("typescript", hljsTypescript);
  hljs.registerLanguage("ts", hljsTypescript);
  hljs.registerLanguage("tsx", hljsTypescript);
  hljs.registerLanguage("yaml", hljsYaml);
  hljs.registerLanguage("yml", hljsYaml);
}

function normalizeLanguage(info: string): string {
  return info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

function isExternalLink(href: string): boolean {
  return /^(?:https?:|mailto:|ftp:|#)/i.test(href);
}

/** Canonical names only — aliases would just make highlightAuto score the same grammar twice. */
const AUTO_DETECT_LANGUAGES = [
  "typescript", "javascript", "python", "json", "bash", "sql", "yaml", "css", "xml", "diff",
];

/** Below this, highlight.js is guessing. Prose and pseudo-code score low, and mis-tinted
 *  English reads worse than plain text — so an uncertain guess declines to highlight. */
const AUTO_DETECT_MIN_RELEVANCE = 5;

interface DetectedCode { language: string; value: string }

/* Detection runs for both the highlight callback and the fence rule (which needs the
   detected name for its label). Memoised so the same block is not scored twice per
   render, and bounded so a long session cannot grow this without limit. */
const detectionCache = new Map<string, DetectedCode | null>();
const DETECTION_CACHE_LIMIT = 200;

/**
 * Best-effort language detection for a fence that carries no language tag.
 *
 * Reasoning output is where this earns its keep: a model working through a problem
 * dashes off ``` blocks without labelling them far more often than it does in a
 * finished reply, and those blocks would otherwise render as flat grey text.
 */
function detectCode(code: string): DetectedCode | null {
  const cached = detectionCache.get(code);
  if (cached !== undefined) return cached;
  let detected: DetectedCode | null = null;
  try {
    const auto = hljs.highlightAuto(code, AUTO_DETECT_LANGUAGES);
    if (auto.language && auto.value && auto.relevance >= AUTO_DETECT_MIN_RELEVANCE) {
      detected = { language: auto.language, value: auto.value };
    }
  } catch { /* fall through to unhighlighted */ }
  if (detectionCache.size >= DETECTION_CACHE_LIMIT) detectionCache.clear();
  detectionCache.set(code, detected);
  return detected;
}

function createMarkdownEngine(): MarkdownIt {
  registerLanguages();
  const engine = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: true,
    typographer: false,
    highlight(code: string, language: string): string {
      const lang = normalizeLanguage(language);
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; }
        catch { /* markdown-it safely escapes unsupported code below. */ }
      }
      if (!lang) return detectCode(code)?.value ?? "";
      return "";
    },
  });

  engine.use(mdDeflist);
  engine.use(mdAbbr);
  engine.use(mdMark);
  engine.use(mdSup);
  engine.use(mdSub);
  engine.use(mdTaskLists, { enabled: false, label: true, labelAfter: true });
  engine.use(mdEmoji);

  const defaultLinkOpen = engine.renderer.rules.link_open
    ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  engine.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index]!;
    const href = token.attrGet("href") ?? "";
    if (isExternalLink(href)) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
    } else if (href) {
      const match = href.match(FILE_LINE_SUFFIX);
      token.attrSet("href", "#");
      token.attrJoin("class", "file-link");
      token.attrSet("data-file-open", match ? href.slice(0, match.index) : href);
      if (match?.[1]) token.attrSet("data-file-line", match[1]);
    }
    return defaultLinkOpen(tokens, index, options, env, self);
  };

  // Inline images get the lightbox hook + fade-in styling (see .md-img in theme.css) and
  // load lazily — markdown-it's default image rule emits a bare <img> with no class, which
  // silently drops both, since Markdown.tsx's click delegate only recognizes ".md-img".
  const defaultImage = engine.renderer.rules.image
    ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  engine.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index]!;
    token.attrJoin("class", "md-img");
    token.attrSet("loading", "lazy");
    token.attrSet("decoding", "async");
    return defaultImage(tokens, index, options, env, self);
  };

  // Tables get their own horizontal scroll container. Without one, `width: 100%` plus
  // table-layout: auto resolves a narrow side panel by crushing whichever column loses
  // the fight for space down to a character or two. Given somewhere to scroll, the table
  // keeps a readable minimum width and overflows as a unit instead. Mirrors the fix the
  // docs site already carries for the same failure at mobile widths.
  engine.renderer.rules.table_open = () => '<div class="md-table-scroll"><table>';
  engine.renderer.rules.table_close = () => "</table></div>";

  const defaultFence = engine.renderer.rules.fence
    ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  engine.renderer.rules.fence = (tokens, index, options, _env, self) => {
    const token = tokens[index]!;
    const lang = normalizeLanguage(token.info);
    if (lang === "doc" || lang === "document") {
      return `<div class="doc-block">${engine.render(token.content.trim())}</div>`;
    }
    const rendered = defaultFence(tokens, index, options, _env, self);
    // An auto-detected block is labelled with what it was detected as, marked so the
    // label reads as an inference rather than something the model declared.
    const detected = lang ? null : detectCode(token.content);
    const label = lang || (detected ? `${detected.language} ·` : "text");
    return `<div class="cb"><div class="cb-header"><span class="cb-lang">${label}</span><button class="cb-copy" type="button">Copy</button></div>${rendered}</div>`;
  };

  return engine;
}

const markdownEngine = createMarkdownEngine();

/** Parse rich Markdown and strip everything the chat does not explicitly support. */
export function renderMd(raw: string): string {
  return DOMPurify.sanitize(markdownEngine.render(raw), SANITIZE_CONFIG);
}

/**
 * Tags an inline render may emit. Deliberately a subset of SANITIZE_CONFIG with every
 * block-level element removed: the fields rendered this way are normalized with the
 * planning store's `cleanText`, which collapses all whitespace, so they *cannot* hold
 * block structure. Rendering them through the block engine would advertise a capability
 * the store does not actually have. `img` is excluded for the same reason — an image is
 * not a thing a single collapsed line should be able to introduce.
 */
export const INLINE_SANITIZE_CONFIG = {
  RETURN_TRUSTED_TYPE: false as const,
  ALLOWED_TAGS: ["strong", "em", "del", "code", "a", "span", "mark", "sup", "sub", "abbr"],
  ALLOWED_ATTR: ["href", "target", "rel", "class", "title", "data-file-open", "data-file-line"],
};

/**
 * Render one line of Markdown with no block structure — emphasis, code spans, and links
 * only. `renderInline` skips markdown-it's block rules entirely, so headings, lists, and
 * fences are never parsed in the first place; the narrowed sanitize config is the second
 * line of defence for anything raw HTML could smuggle past it.
 */
export function renderMdInline(raw: string): string {
  return DOMPurify.sanitize(markdownEngine.renderInline(raw), INLINE_SANITIZE_CONFIG);
}

export interface BoundedMarkdown {
  text: string;
  truncated: boolean;
  /** Length of the original source, so a notice can state what was withheld. */
  totalChars: number;
}

/** Trailing fence marker count, used to detect a cut that landed inside a code block. */
function countFences(text: string): number {
  return (text.match(/^```/gm) ?? []).length;
}

/**
 * Bound a long document for inline preview.
 *
 * Cuts at the last paragraph break before the limit (then line, then word) so the preview
 * ends somewhere deliberate rather than mid-sentence. If the cut lands inside a fenced code
 * block — an odd number of fence markers precede it — a closing fence is appended, because
 * an unterminated fence would otherwise swallow the notice and every remaining line into one
 * grey code block.
 */
export function boundMarkdown(raw: string, maxChars: number): BoundedMarkdown {
  const totalChars = raw.length;
  if (!Number.isFinite(maxChars) || maxChars <= 0 || totalChars <= maxChars) {
    return { text: raw, truncated: false, totalChars };
  }
  const window = raw.slice(0, maxChars);
  const breakpoints = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")];
  // Only honour a breakpoint in the last quarter; an early one would discard most of the
  // budget to save a partial word.
  const cut = breakpoints.find((index) => index > maxChars * 0.75) ?? -1;
  let text = (cut > 0 ? window.slice(0, cut) : window).trimEnd();
  if (countFences(text) % 2 === 1) text += "\n```";
  return { text, truncated: true, totalChars };
}
