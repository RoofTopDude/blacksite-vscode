/* Mermaid source helpers shared by the extension host and the webviews.
 *
 * Pure text handling — no DOM, no vscode — so the host (CodeLens, the Open Diagram command,
 * message validation) and the webviews (the diagram viewer's title, the chat's Open action)
 * agree on what a diagram is without either loading Mermaid to find out.
 */

/** Mermaid's own default maxTextSize. It refuses anything longer, so there is no point
 *  carrying a longer source through a message, a panel, or persisted webview state. */
export const MAX_DIAGRAM_SOURCE_CHARS = 50_000;

export interface MermaidFence {
  /** The diagram source between the fences, with the fence's indentation removed. */
  source: string;
  /** Zero-based line of the opening fence. */
  startLine: number;
  /** Zero-based line of the closing fence, or the last line when the fence is never closed. */
  endLine: number;
}

const OPENING_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Every ```mermaid (or ~~~mermaid) fenced block in a Markdown document.
 *
 * Follows CommonMark's fence rules closely enough for a document an agent or a person wrote:
 * up to three spaces of indentation, a closing fence of the same character at least as long
 * as the opening one, and an unclosed fence running to the end of the document. Fences of
 * other languages are skipped whole, so a Mermaid example quoted inside a ```markdown block
 * is not mistaken for a diagram.
 */
export function findMermaidFences(text: string): MermaidFence[] {
  const lines = text.split(/\r?\n/);
  const fences: MermaidFence[] = [];
  let index = 0;
  while (index < lines.length) {
    const open = OPENING_FENCE.exec(lines[index]!);
    // A backtick fence's info string may not itself contain a backtick (CommonMark 4.5).
    if (!open || (open[2]!.startsWith("`") && open[3]!.includes("`"))) { index += 1; continue; }

    const indent = open[1]!.length;
    const marker = open[2]!;
    const language = open[3]!.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
    const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);

    let end = index + 1;
    while (end < lines.length && !closing.test(lines[end]!)) end += 1;
    const closed = end < lines.length;

    if (language === "mermaid") {
      const body = lines.slice(index + 1, closed ? end : lines.length)
        .map((line) => stripIndent(line, indent))
        .join("\n");
      fences.push({ source: body, startLine: index, endLine: closed ? end : lines.length - 1 });
    }
    index = closed ? end + 1 : lines.length;
  }
  return fences;
}

function stripIndent(line: string, indent: number): string {
  let removed = 0;
  while (removed < indent && line[removed] === " ") removed += 1;
  return line.slice(removed);
}

/** The fence whose block contains `line` (zero-based), if any. */
export function mermaidFenceAt(text: string, line: number): MermaidFence | undefined {
  return findMermaidFences(text).find((fence) => line >= fence.startLine && line <= fence.endLine);
}

/* Keyword → name for the diagram types Mermaid 11 ships. Matched against the first word of
   the first line that is not front matter, a comment, or a directive. */
const DIAGRAM_KINDS: Array<[RegExp, string]> = [
  [/^(?:flowchart|graph)(?:-elk)?$/i, "Flowchart"],
  [/^sequenceDiagram$/i, "Sequence diagram"],
  [/^classDiagram(?:-v2)?$/i, "Class diagram"],
  [/^stateDiagram(?:-v2)?$/i, "State diagram"],
  [/^erDiagram$/i, "Entity relationship diagram"],
  [/^journey$/i, "User journey"],
  [/^gantt$/i, "Gantt chart"],
  [/^pie$/i, "Pie chart"],
  [/^quadrantChart$/i, "Quadrant chart"],
  [/^requirementDiagram$/i, "Requirement diagram"],
  [/^gitGraph$/i, "Git graph"],
  [/^C4(?:Context|Container|Component|Dynamic|Deployment)$/, "C4 diagram"],
  [/^mindmap$/i, "Mind map"],
  [/^timeline$/i, "Timeline"],
  [/^zenuml$/i, "ZenUML sequence"],
  [/^sankey(?:-beta)?$/i, "Sankey diagram"],
  [/^xychart(?:-beta)?$/i, "XY chart"],
  [/^block(?:-beta)?$/i, "Block diagram"],
  [/^packet(?:-beta)?$/i, "Packet diagram"],
  [/^kanban$/i, "Kanban board"],
  [/^architecture(?:-beta)?$/i, "Architecture diagram"],
  [/^radar(?:-beta)?$/i, "Radar chart"],
  [/^treemap(?:-beta)?$/i, "Treemap"],
  [/^ishikawa(?:-beta)?$/i, "Fishbone diagram"],
  [/^venn(?:-beta)?$/i, "Venn diagram"],
  [/^treeView(?:-beta)?$/i, "Tree view"],
  [/^cynefin(?:-beta)?$/i, "Cynefin diagram"],
  [/^railroad(?:-(?:ebnf|abnf|peg))?(?:-beta)?$/i, "Railroad diagram"],
  [/^eventmodeling$/i, "Event model"],
  [/^swimlane(?:-beta)?$/i, "Swimlane diagram"],
  [/^wardley(?:-beta)?$/i, "Wardley map"],
];

/** Diagram types whose grammar has a `title` keyword. */
const TITLE_KEYWORD_KINDS = new Set([
  "Gantt chart", "Pie chart", "User journey", "Quadrant chart", "XY chart", "Timeline",
  "Radar chart", "Packet diagram", "Treemap", "C4 diagram", "Kanban board",
  "Venn diagram", "Cynefin diagram", "Railroad diagram", "Wardley map",
]);

export interface MermaidDescription {
  /** What kind of diagram this is, e.g. "Sequence diagram". "Diagram" when unrecognised. */
  kind: string;
  /** The author's own title, from front matter, a `title` line, or `accTitle`. */
  title?: string;
}

/** Name a diagram from its source without parsing it — for a tab title or a file name. */
export function describeMermaid(source: string): MermaidDescription {
  const lines = source.split(/\r?\n/);
  let index = 0;
  let title: string | undefined;

  // YAML front matter: `---` … `---` before the diagram, where `title:` lives.
  while (index < lines.length && !lines[index]!.trim()) index += 1;
  if (lines[index]?.trim() === "---") {
    const close = lines.findIndex((line, at) => at > index && line.trim() === "---");
    if (close > index) {
      for (const line of lines.slice(index + 1, close)) {
        const match = /^title:\s*(.+)$/.exec(line.trim());
        if (match) title = unquote(match[1]!);
      }
      index = close + 1;
    }
  }

  let kind = "Diagram";
  for (; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith("%%")) continue;
    const keyword = line.split(/[\s:;{]/, 1)[0] ?? "";
    kind = DIAGRAM_KINDS.find(([pattern]) => pattern.test(keyword))?.[1] ?? "Diagram";
    // `pie title Pets adopted` puts the title on the keyword line itself.
    const inline = /\btitle\s+(.+)$/.exec(line.slice(keyword.length));
    if (!title && inline && TITLE_KEYWORD_KINDS.has(kind)) title = unquote(inline[1]!);
    index += 1;
    break;
  }

  // `accTitle:` is valid in every diagram type. A bare `title …` line only means a title in
  // the types whose grammar has that keyword — in a flowchart it is just a node named title.
  const titleLine = TITLE_KEYWORD_KINDS.has(kind) ? /^(?:title\s+|accTitle\s*:\s*)(.+)$/ : /^accTitle\s*:\s*(.+)$/;
  for (; !title && index < lines.length; index += 1) {
    const match = titleLine.exec(lines[index]!.trim());
    if (match) title = unquote(match[1]!);
  }
  return title ? { kind, title: title.slice(0, 120) } : { kind };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}

/** "Request flow · Flowchart", or just "Flowchart" for an untitled diagram. */
export function diagramDisplayTitle(source: string): string {
  const { kind, title } = describeMermaid(source);
  return title ? `${title} · ${kind}` : kind;
}

/** A file name stem for an exported diagram: the title (or kind), lowercased and dashed. */
export function diagramFileStem(source: string): string {
  const { kind, title } = describeMermaid(source);
  const stem = (title ?? kind).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return stem || "diagram";
}
