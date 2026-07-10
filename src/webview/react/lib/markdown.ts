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

const SANITIZE_CONFIG = {
  RETURN_TRUSTED_TYPE: false as const,
  ALLOWED_TAGS: [
    "p", "br", "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td", "hr", "img", "sup", "sub",
    "span", "div", "mark", "dl", "dt", "dd", "abbr", "input", "label",
    "details", "summary",
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

  const defaultFence = engine.renderer.rules.fence
    ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  engine.renderer.rules.fence = (tokens, index, options, _env, self) => {
    const token = tokens[index]!;
    const lang = normalizeLanguage(token.info);
    if (lang === "doc" || lang === "document") {
      return `<div class="doc-block">${engine.render(token.content.trim())}</div>`;
    }
    const rendered = defaultFence(tokens, index, options, _env, self);
    const label = lang || "text";
    return `<div class="cb"><div class="cb-header"><span class="cb-lang">${label}</span><button class="cb-copy" type="button">Copy</button></div>${rendered}</div>`;
  };

  return engine;
}

const markdownEngine = createMarkdownEngine();

/** Parse rich Markdown and strip everything the chat does not explicitly support. */
export function renderMd(raw: string): string {
  return DOMPurify.sanitize(markdownEngine.render(raw), SANITIZE_CONFIG);
}
