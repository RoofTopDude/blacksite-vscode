/* Lightweight markdown → HTML renderer ported from the legacy webview.
   Output is consumed via dangerouslySetInnerHTML; all interpolation is routed
   through esc(), and code-copy is wired by the host component via event
   delegation on the `.cb-copy` button (no inline onclick). */

import { esc } from "./format";

const B_OPEN = "";
const B_CLOSE = "";

function renderInlineHelpers(str: string): string {
  let out = str;
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  out = out.replace(/___(.+?)___/g, "<strong><em>$1</em></strong>");
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__(.+?)__/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  out = out.replace(/_([^_\n]+)_/g, "<em>$1</em>");
  return out;
}

export function renderInline(text: string): string {
  const escaped = esc(text);
  const placeholders: string[] = [];

  // 1. Inline code
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    const id = placeholders.length;
    placeholders.push(`<code class="ic">${code}</code>`);
    return `${B_OPEN}PH${id}${B_CLOSE}`;
  });

  // 2. Links [Label](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    const id = placeholders.length;
    const formattedLabel = renderInlineHelpers(label);
    placeholders.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${formattedLabel}</a>`);
    return `${B_OPEN}PH${id}${B_CLOSE}`;
  });

  // 3. Formatting on the rest
  out = renderInlineHelpers(out);

  // 4. Restore placeholders
  const phRe = new RegExp(`${B_OPEN}PH(\\d+)${B_CLOSE}`, "g");
  while (out.includes(`${B_OPEN}PH`)) {
    out = out.replace(phRe, (_m, id: string) => placeholders[+id] ?? "");
  }
  return out;
}

export function renderMd(raw: string): string {
  if (!raw) return "";
  const blocks: string[] = [];
  const blockRe = new RegExp(`^${B_OPEN}B\\d+${B_CLOSE}$`);
  const md = raw.replace(/```(\w*)\r?\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const id = blocks.length;
    const language = lang || "text";
    blocks.push(
      `<div class="cb"><div class="cb-header"><span class="cb-lang">${esc(language)}</span>` +
      `<button class="cb-copy" type="button">Copy</button></div>` +
      `<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre></div>`,
    );
    return `${B_OPEN}B${id}${B_CLOSE}`;
  });
  const lines = md.split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (blockRe.test(line.trim())) { out.push(line.trim()); index++; continue; }
    const heading = line.match(/^(#{1,3}) (.+)$/);
    if (heading) { out.push(`<h${heading[1]!.length}>${renderInline(heading[2]!)}</h${heading[1]!.length}>`); index++; continue; }
    if (/^---+$/.test(line.trim())) { out.push("<hr>"); index++; continue; }
    if (line.startsWith("> ")) {
      const block: string[] = [];
      while (index < lines.length && lines[index]!.startsWith("> ")) { block.push(lines[index]!.slice(2)); index++; }
      out.push(`<blockquote>${block.map(renderInline).join("<br>")}</blockquote>`);
      continue;
    }
    if (/^[-*+] /.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*+] /.test(lines[index]!)) { items.push(`<li>${renderInline(lines[index]!.replace(/^[-*+] /, ""))}</li>`); index++; }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\. /.test(lines[index]!)) { items.push(`<li>${renderInline(lines[index]!.replace(/^\d+\. /, ""))}</li>`); index++; }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (line.trim() === "") { out.push(""); index++; continue; }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() !== "" &&
      !/^(#{1,3} |[-*+] |\d+\. |> |---+$)/.test(lines[index]!) &&
      !blockRe.test(lines[index]!.trim())
    ) {
      paragraph.push(renderInline(lines[index]!));
      index++;
    }
    if (paragraph.length) out.push(`<p>${paragraph.join("<br>")}</p>`);
  }
  const restoreRe = new RegExp(`${B_OPEN}B(\\d+)${B_CLOSE}`, "g");
  return out.join("\n").replace(restoreRe, (_m, id: string) => blocks[+id] ?? "");
}
