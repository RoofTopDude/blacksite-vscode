/* Lightweight markdown → HTML renderer.
   Output consumed via dangerouslySetInnerHTML; all user content is routed
   through esc(). Code-copy wired via event delegation on .cb-copy buttons.
   File links (.file-link) are intercepted by Markdown.tsx and dispatched
   to the extension host to open the file in the editor. */

import { esc } from "./format";

// Unicode Private Use Area sentinels — never appear in normal text, so they
// can't collide with agent output and corrupt placeholder substitution.
const B_OPEN = "";
const B_CLOSE = "";

// ── Inline helpers ────────────────────────────────────────────────────────────

function renderInlineFormatting(str: string): string {
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
  const ph: string[] = [];

  const slot = (html: string): string => {
    const id = ph.length;
    ph.push(html);
    return `${B_OPEN}PH${id}${B_CLOSE}`;
  };

  // 1. Inline code
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) =>
    slot(`<code class="ic">${code}</code>`),
  );

  // 2. Images ![alt](url) — before links to prevent partial match on ![
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) =>
    slot(`<img src="${url}" alt="${alt}" class="md-img" loading="lazy">`),
  );

  // 3. Links [label](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    const fmtLabel = renderInlineFormatting(label);
    if (/^(?:https?:|mailto:|ftp:|#)/.test(url)) {
      return slot(`<a href="${url}" target="_blank" rel="noopener noreferrer">${fmtLabel}</a>`);
    }
    // File link — extract optional line number: path/to/file.ts#L42 or #42
    const lineMatch = url.match(/#L?(\d+)$/);
    const lineNum = lineMatch ? lineMatch[1] : "";
    const filePath = lineMatch ? url.slice(0, lineMatch.index) : url;
    return slot(
      `<a href="#" class="file-link" data-file-open="${filePath}" data-file-line="${lineNum}">${fmtLabel}</a>`,
    );
  });

  // 4. Apply bold/italic to everything not in a placeholder
  out = renderInlineFormatting(out);

  // 5. Restore placeholders
  const phRe = new RegExp(`${B_OPEN}PH(\\d+)${B_CLOSE}`, "g");
  let safety = 0;
  while (out.includes(`${B_OPEN}PH`) && safety++ < 200) {
    out = out.replace(phRe, (_m, id: string) => ph[+id] ?? "");
  }
  return out;
}

// ── Table helpers ─────────────────────────────────────────────────────────────

type ColAlign = "left" | "center" | "right" | "";

function parseRow(line: string): string[] {
  return line.split("|").slice(1, -1).map((c) => c.trim());
}

function parseSep(line: string): ColAlign[] {
  return line.split("|").slice(1, -1).map((c) => {
    const t = c.trim();
    if (t.startsWith(":") && t.endsWith(":")) return "center";
    if (t.endsWith(":")) return "right";
    if (t.startsWith(":")) return "left";
    return "";
  });
}

function buildTable(headers: string[], aligns: ColAlign[], rows: string[][]): string {
  const th = headers
    .map((h, i) => {
      const a = aligns[i] ? ` style="text-align:${aligns[i]}"` : "";
      return `<th${a}>${renderInline(h)}</th>`;
    })
    .join("");
  const trs = rows
    .map((row) =>
      `<tr>${headers.map((_, i) => {
        const a = aligns[i] ? ` style="text-align:${aligns[i]}"` : "";
        return `<td${a}>${renderInline(row[i] ?? "")}</td>`;
      }).join("")}</tr>`,
    )
    .join("");
  return `<table class="md-table"><thead><tr>${th}</tr></thead>${trs ? `<tbody>${trs}</tbody>` : ""}</table>`;
}

function isTableSep(line: string): boolean {
  return /^\s*\|[\s\-:|]+\|\s*$/.test(line);
}

// ── Block renderer ─────────────────────────────────────────────────────────────

function _render(raw: string, depth: number): string {
  if (!raw || depth > 3) return "";
  const blocks: string[] = [];

  const blockSlot = (html: string): string => {
    const id = blocks.length;
    blocks.push(html);
    return `${B_OPEN}B${id}${B_CLOSE}`;
  };

  // ① Extract ```doc blocks — recursive render inside a styled card
  let md = raw.replace(/```doc(?:ument)?\r?\n([\s\S]*?)```/g, (_m, content: string) =>
    blockSlot(`<div class="doc-block">${_render(content.trimEnd(), depth + 1)}</div>`),
  );

  // ② Extract regular fenced code blocks
  md = md.replace(/```(\w*)\r?\n([\s\S]*?)```/g, (_m, lang: string, code: string) =>
    blockSlot(
      `<div class="cb"><div class="cb-header">` +
      `<span class="cb-lang">${esc(lang || "text")}</span>` +
      `<button class="cb-copy" type="button">Copy</button></div>` +
      `<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre></div>`,
    ),
  );

  const blockRe = new RegExp(`^${B_OPEN}B\\d+${B_CLOSE}$`);
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Block placeholder passthrough
    if (blockRe.test(line.trim())) { out.push(line.trim()); i++; continue; }

    // Headings h1–h3
    const hm = line.match(/^(#{1,3}) (.+)$/);
    if (hm) { out.push(`<h${hm[1]!.length}>${renderInline(hm[2]!)}</h${hm[1]!.length}>`); i++; continue; }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { out.push("<hr>"); i++; continue; }

    // Blockquote
    if (line.startsWith("> ")) {
      const bqLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) { bqLines.push(lines[i]!.slice(2)); i++; }
      out.push(`<blockquote>${bqLines.map(renderInline).join("<br>")}</blockquote>`);
      continue;
    }

    // Table: current line has pipes and next line is a separator
    if (line.trim().startsWith("|") && isTableSep(lines[i + 1] ?? "")) {
      const headers = parseRow(line);
      const aligns = parseSep(lines[i + 1]!);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) { rows.push(parseRow(lines[i]!)); i++; }
      out.push(buildTable(headers, aligns, rows));
      continue;
    }

    // Unordered list (with task-list checkbox detection)
    if (/^[-*+] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+] /.test(lines[i]!)) {
        const content = lines[i]!.replace(/^[-*+] /, "");
        const task = content.match(/^\[([ xX])\] (.*)$/);
        if (task) {
          const done = task[1] !== " ";
          items.push(
            `<li class="task-item"><input type="checkbox" class="task-cb"${done ? " checked" : ""} disabled> ${renderInline(task[2]!)}</li>`,
          );
        } else {
          items.push(`<li>${renderInline(content)}</li>`);
        }
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i]!)) {
        items.push(`<li>${renderInline(lines[i]!.replace(/^\d+\. /, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Blank line
    if (line.trim() === "") { out.push(""); i++; continue; }

    // Paragraph — accumulate lines until a structural element starts
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(#{1,3} |[-*+] |\d+\. |> |---+$)/.test(lines[i]!) &&
      !blockRe.test(lines[i]!.trim()) &&
      !(lines[i]!.trim().startsWith("|") && isTableSep(lines[i + 1] ?? ""))
    ) {
      para.push(renderInline(lines[i]!));
      i++;
    }
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
    else i++;
  }

  const restoreRe = new RegExp(`${B_OPEN}B(\\d+)${B_CLOSE}`, "g");
  return out.join("\n").replace(restoreRe, (_m, id: string) => blocks[+id] ?? "");
}

export function renderMd(raw: string): string {
  return _render(raw, 0);
}
