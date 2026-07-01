import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { LocalRuntime } from "@blacksite/local-runtime";
import type { UiPreferenceEntry } from "./memory-store.js";
import { summarizeBaseContextForPrompt } from "./base-context-store.js";
import { summarizePlanningStateForPrompt } from "./planning-store.js";

const CONTEXT_FILE = ".blacksite/context.md";
const MEMORY_FILE = ".blacksite/memory.md";
const UI_PREFERENCES_FILE = ".blacksite/ui-preferences.json";

export interface McpServerInfo {
  name: string;
  transport: "stdio" | "http";
  target: string;
}

export interface WorkspaceSnapshot {
  workspaceRoot: string;
  allRoots: string[];
  openFiles: string[];
  activeFile?: string;
  activeLine?: number;
  diagnosticSummary: string;
  diagnosticDetails: string;
  gitStatusSummary: string;
  baseContext: string;
  structuredBaseContext: string;
  projectMemory: string;
  uiPreferenceSummary: string;
  planningSummary: string;
  mcpServers?: McpServerInfo[];
}

function summarizeUiPreference(preference: UiPreferenceEntry): string {
  const subject = preference.elementKey
    || preference.componentName
    || preference.elementType
    || "ui-element";
  const selection = preference.selection?.optionLabel
    || preference.selection?.optionId
    || "preferred selection recorded";
  const tokens = Array.isArray(preference.technicalDetails?.tokens)
      ? preference.technicalDetails?.tokens?.slice(0, 4).join(", ")
      : "";
  const cssProps = preference.technicalDetails?.cssProperties
    ? Object.entries(preference.technicalDetails.cssProperties)
      .slice(0, 4)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ")
    : "";
  const notes = Array.isArray(preference.technicalDetails?.notes)
    ? preference.technicalDetails.notes.slice(0, 2).join("; ")
    : "";
  const details = [tokens ? `tokens: ${tokens}` : "", cssProps ? `css: ${cssProps}` : "", notes ? `notes: ${notes}` : ""]
    .filter(Boolean)
    .join(" | ");
  return details ? `- ${subject}: ${selection} (${details})` : `- ${subject}: ${selection}`;
}

function readUiPreferenceSummary(workspaceRoot: string): string {
  try {
    const uiPreferencesPath = path.join(workspaceRoot, UI_PREFERENCES_FILE);
    if (!fs.existsSync(uiPreferencesPath)) return "";
    const raw = fs.readFileSync(uiPreferencesPath, "utf8").slice(0, 50_000);
    const parsed = JSON.parse(raw) as { preferences?: unknown };
    const preferences = Array.isArray(parsed.preferences)
      ? parsed.preferences as UiPreferenceEntry[]
      : [];
    if (preferences.length === 0) return "";

    const recent = preferences
      .slice()
      .sort((left, right) => {
        const leftTime = Date.parse(left.lastConfirmedAt ?? "");
        const rightTime = Date.parse(right.lastConfirmedAt ?? "");
        return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
      })
      .slice(0, 8);
    return recent.map(summarizeUiPreference).join("\n");
  } catch {
    return "";
  }
}

export async function gatherWorkspaceSnapshot(
  workspaceRoot: string,
  runtime: LocalRuntime,
): Promise<WorkspaceSnapshot> {
  const allRoots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [workspaceRoot];

  const activeEditor = vscode.window.activeTextEditor;
  const activeFile = activeEditor
    ? path.relative(workspaceRoot, activeEditor.document.fileName).replace(/\\/g, "/")
    : undefined;
  const activeLine = activeEditor ? activeEditor.selection.active.line + 1 : undefined;

  const openFiles = vscode.workspace.textDocuments
    .filter((d) => !d.isUntitled && d.uri.scheme === "file")
    .map((d) => path.relative(workspaceRoot, d.uri.fsPath).replace(/\\/g, "/"))
    .filter((p) => !p.startsWith(".."))
    .slice(0, 20);

  const allDiagnostics = vscode.languages.getDiagnostics();
  let errorCount = 0;
  let warnCount = 0;
  const topErrors: string[] = [];
  for (const [uri, diags] of allDiagnostics) {
    const relPath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, "/");
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) {
        errorCount++;
        if (topErrors.length < 8) {
          topErrors.push(`${relPath}:${d.range.start.line + 1} — ${d.message}`);
        }
      } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
        warnCount++;
      }
    }
  }
  const diagnosticSummary = errorCount + warnCount > 0
    ? `${errorCount} error(s), ${warnCount} warning(s) in workspace`
    : "No diagnostics";
  const diagnosticDetails = topErrors.join("\n");

  let gitStatusSummary = "";
  try {
    const resp = await runtime.handleMessage({ type: "workspace.git", payload: { op: "status" } });
    const data = (resp as { result?: { ok?: boolean; code?: string; message?: string; data?: { branch?: string; staged?: unknown[]; unstaged?: unknown[]; untracked?: unknown[] } } }).result;
    if (data?.ok && data.data) {
      const s = data.data;
      gitStatusSummary = `Branch: ${s.branch ?? "?"} | Staged: ${s.staged?.length ?? 0} | Unstaged: ${s.unstaged?.length ?? 0} | Untracked: ${s.untracked?.length ?? 0}`;
    } else if (data && data.ok === false && /not a git repository/i.test(data.message ?? "")) {
      // Tell the agent up front so it does not waste turns probing git_op in a non-repo workspace.
      gitStatusSummary = "Not a git repository (git tools will fail here unless you init one).";
    }
  } catch { /* git may not be available */ }

  let baseContext = "";
  try {
    const contextPath = path.join(workspaceRoot, CONTEXT_FILE);
    if (fs.existsSync(contextPath)) {
      baseContext = fs.readFileSync(contextPath, "utf8").slice(0, 4000);
    }
  } catch { /* ignore */ }

  const structuredBaseContext = summarizeBaseContextForPrompt(workspaceRoot);

  let projectMemory = "";
  try {
    const memoryPath = path.join(workspaceRoot, MEMORY_FILE);
    if (fs.existsSync(memoryPath)) {
      // Keep the most recent notes (the file grows append-only) within a budget.
      projectMemory = fs.readFileSync(memoryPath, "utf8").slice(-4000);
    }
  } catch { /* ignore */ }

  const uiPreferenceSummary = readUiPreferenceSummary(workspaceRoot);
  const planningSummary = summarizePlanningStateForPrompt(workspaceRoot);

  return {
    workspaceRoot,
    allRoots,
    openFiles,
    activeFile: activeFile && !activeFile.startsWith("..") ? activeFile : undefined,
    activeLine,
    diagnosticSummary,
    diagnosticDetails,
    gitStatusSummary,
    baseContext,
    structuredBaseContext,
    projectMemory,
    uiPreferenceSummary,
    planningSummary,
  };
}

export function buildSystemPrompt(snapshot: WorkspaceSnapshot): string {
  const parts: string[] = [
    "You are Blacksite, an AI coding assistant integrated into VS Code.",
    "",
  ];

  // ── Workspace context ────────────────────────────────────────────────────────
  if (snapshot.allRoots.length > 1) {
    parts.push("Workspace roots:");
    for (const r of snapshot.allRoots) parts.push(`  ${r}`);
  } else {
    parts.push(`Workspace root: ${snapshot.workspaceRoot}`);
  }

  if (snapshot.activeFile) {
    const activeLabel = snapshot.activeLine
      ? `${snapshot.activeFile}:${snapshot.activeLine}`
      : snapshot.activeFile;
    parts.push(`Active file: ${activeLabel}`);
  }

  if (snapshot.openFiles.length > 0) {
    parts.push("", "Open editors:", ...snapshot.openFiles.map((f) => `  ${f}`));
  }

  if (snapshot.diagnosticSummary && snapshot.diagnosticSummary !== "No diagnostics") {
    parts.push("", `Diagnostics: ${snapshot.diagnosticSummary}`);
    if (snapshot.diagnosticDetails) {
      parts.push("Top errors:");
      for (const line of snapshot.diagnosticDetails.split("\n")) {
        parts.push(`  ${line}`);
      }
    }
  }

  if (snapshot.gitStatusSummary) {
    parts.push("", `Git: ${snapshot.gitStatusSummary}`);
  }

  if (snapshot.baseContext) {
    parts.push("", "Project context (.blacksite/context.md):", snapshot.baseContext);
  }

  if (snapshot.structuredBaseContext) {
    parts.push("", "Base Context (.blacksite/base-context.json — static cross-conversation topics and file anchors):", snapshot.structuredBaseContext);
  }

  if (snapshot.projectMemory && snapshot.projectMemory.replace(/#.*Memory/i, "").trim()) {
    parts.push("", "Project memory (.blacksite/memory.md — notes you saved in prior sessions):", snapshot.projectMemory.trim());
  }

  if (snapshot.uiPreferenceSummary) {
    parts.push("", "UI preference memory (.blacksite/ui-preferences.json):", snapshot.uiPreferenceSummary);
  }

  if (snapshot.planningSummary) {
    parts.push("", "Existing plans and task items (.blacksite/planning.json):", snapshot.planningSummary);
  }

  if (snapshot.mcpServers && snapshot.mcpServers.length > 0) {
    parts.push(
      "",
      "Configured MCP servers (use mcp_list_tools with the target below to discover tools, then mcp_call_tool):",
      ...snapshot.mcpServers.map((s) => `  ${s.name} [${s.transport}] → ${s.target}`),
    );
  }

  // ── Output formatting ────────────────────────────────────────────────────────
  parts.push(
    "",
    "## Output Formatting",
    "",
    "You are running inside a VS Code extension with a rich webview that renders Markdown fully.",
    "Use formatting deliberately to make your output clear and scannable.",
    "",
    "**Rich content you can produce:**",
    "- **Inline images**: `![description](https://url)` — embeds the image directly in the conversation. Use for diagrams, charts, architecture visuals, or any relevant online resource.",
    "- **File/line links**: `[filename.ts:42](path/to/file.ts#L42)` — clicking these opens the file in the editor at that line. Paths are relative to the workspace root. Always prefer these over plain filename mentions.",
    "  - Line numbers: append `#L<n>` to the path (e.g. `src/agent-session.ts#L294`).",
    "  - Example: `[See AgentSession.send](src/agent-session.ts#L743)`",
    "- **Tables**: Use standard Markdown pipe tables for comparisons, parameter lists, or structured data.",
    "- **Code blocks**: Always specify the language tag for syntax context (e.g. ` ```typescript `, ` ```python `).",
    "- **Document cards**: Open a ` ```doc ` block to render a styled analysis report, architecture summary, or reference card inline in the conversation. The contents are full Markdown.",
    "- **Headings**: Use `##` / `###` to organize responses with multiple sections.",
    "",
    "**When to use rich formatting:**",
    "- Reference a specific file/line → always use a file link.",
    "- Comparing multiple options or parameters → use a table.",
    "- Response has 3+ distinct sections → add headings.",
    "- Producing a comprehensive analysis or report → wrap in a ` ```doc ` block.",
    "- Mentioning a public diagram or visual → embed it with `![…](url)`.",
    "- Short conversational answers → plain prose is fine, no need to over-structure.",
    "",
    "**Narration during execution:**",
    "When you write explanatory text between tool calls (status updates, reasoning, plans), separate distinct thoughts with a blank line. This keeps narration readable — each paragraph renders with visible breathing room in the UI.",
  );

  // ── Execution guidelines ─────────────────────────────────────────────────────
  parts.push(
    "",
    "## Guidelines",
    "",
    "- Stay on the task until it is complete, blocked by a concrete external issue, or waiting on explicit user input/approval.",
    "- Read files before editing them. Verify changes after writing.",
    "- Prefer code intelligence over text search: code_symbols to map a file, code_navigate to jump to definitions/implementations or find references, and code_hover to inspect a type or signature. Fall back to file_search only when those don't apply.",
    "- Make changes with file_edit (surgical, shows the user a diff) rather than rewriting whole files; use file_write for new files.",
    "- Use file_edit_batch for coordinated exact-string replacements across multiple files, and code_insert when you need to add code relative to a symbol or line without brittle whole-file matching.",
    "- After editing, call code_diagnostics to catch errors the language servers report, then fix them before finishing.",
    "- After each tool result, decide the next step immediately. If more work is needed and no input is required, keep going instead of yielding an empty handoff.",
    "- For shell commands, confirm the cwd and command before running.",
    "- Operations marked write/network/destructive will prompt the user for approval.",
    "- When writing code, prefer small focused changes. Run tests or lint after editing.",
    "- Use git_op status before commits. Use git_op diff to review changes.",
    "- To persist durable notes for future sessions, use memory_append (project memory) — it is read back into context on the next conversation.",
    "- Use Base Context for static, reusable project context that should stay available across conversations.",
    "- Before starting multi-phase work, use plan_list to check for an existing plan; continue it with plan_update rather than creating a duplicate. Give phases clear objectives and steps concrete detail so the plan is actionable the moment the user approves it.",
    "- Keep the active plan in mind and current: as each step or phase finishes, call plan_update to set its status; add or remove steps/phases with plan_update (addPhases / addSteps / removeStepId / removePhaseId) when the work changes shape instead of recreating the plan. Status fields accept natural wording ('done', 'in progress', 'paused').",
    "- Never advance, modify, or act on a plan whose status is on_hold or cancelled unless the user explicitly resumes it.",
    "- For concrete 3+ step execution, use todo_list before todo_create, then keep todo_update current while the work is actually happening.",
  );

  // ── Environment & tooling ────────────────────────────────────────────────────
  // Encodes the harness constraints agents most often fight. Most wasted turns come
  // from retrying a call the environment will never allow instead of adapting.
  parts.push(
    "",
    "## Environment & tooling",
    "",
    "You run inside VS Code on the user's machine. Understand the tools you have before reaching for them — adapt to a constraint instead of retrying against it.",
    "",
    "- **Running commands:** shell_run executes a one-shot command and returns when it exits — use it for builds, tests, lint, installs, and scripts. process_start launches a long-running process (dev server, watcher, REPL) and returns a handleId you poll with process_read_output and stop with process_stop. Anything that does not exit on its own must go through process_start, not shell_run.",
    "- **Command restrictions:** inline-eval flags are blocked for security — `node -e`/`--eval`/`-r`, `python -c`, `ruby -e`, `php -r`, and the like. To run a snippet, write it to a file and execute the file (e.g. write `serve.cjs`, then run `node serve.cjs`). Only allowlisted binaries run at all. If a command is rejected, change approach — do not reissue the same call.",
    "- **Dev tooling** (npm, npx, vite, tsc, eslint, pytest, …) runs through shell_run / process_start on every platform, Windows shims included. Invoke them by name.",
    "- **Browser tools** (browser_navigate and friends) only exist when the browser runtime is installed. If a browser call reports it is unavailable, stop trying it — start a local server with process_start and give the user the URL instead.",
    "- **Searching is directory-scoped:** file_search and file_glob take a directory plus a pattern, never a single file path. To inspect one file, read it. Prefer code intelligence (code_symbols, code_navigate, code_hover) over text search wherever it applies.",
    "",
    "## Editing discipline",
    "",
    "- Make surgical changes with file_edit / file_edit_batch / code_insert. Reserve file_write for new files or genuinely small ones.",
    "- Never rewrite a large existing file in a single file_write: one response has an output-token budget, and a long write truncates mid-file and fails the call. Edit only the regions that change, or assemble a large new file across successive writes.",
    "- Before an edit, confirm oldString and newString actually differ — an identical-string edit is a wasted turn.",
    "- When any tool call fails, read the error and change the call. Repeating an identical failing call wastes the turn and the context budget.",
  );

  return parts.join("\n");
}

export function registerFileWatcher(
  workspaceRoot: string,
  onContextChange: () => void,
): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, "**/*.{ts,tsx,js,jsx,py,go,rs,json,md,yaml,yml,toml,sh,css,html,scss,less}"),
    false, false, false,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onContextChange, 2000);
  };
  watcher.onDidCreate(debounced);
  watcher.onDidChange(debounced);
  watcher.onDidDelete(debounced);
  return { dispose: () => { watcher.dispose(); if (timer) clearTimeout(timer); } };
}

// ── Selection / file / diagnostic context helpers ─────────────

export interface InjectedContext {
  text: string;
  label: string;
}

export function getSelectionContext(): InjectedContext | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return null;
  const sel  = editor.selection;
  const text = editor.document.getText(sel);
  if (!text.trim()) return null;
  const file  = path.basename(editor.document.fileName);
  const start = sel.start.line + 1;
  const end   = sel.end.line + 1;
  const label = start === end ? `${file}:${start}` : `${file}:${start}-${end}`;
  return { text, label };
}

export function getFileContext(uri: vscode.Uri): InjectedContext | null {
  try {
    const raw   = fs.readFileSync(uri.fsPath, "utf8").slice(0, 20_000);
    const label = path.basename(uri.fsPath);
    const ext   = path.extname(uri.fsPath).slice(1) || "text";
    return { text: `\`\`\`${ext}\n${raw}\n\`\`\``, label };
  } catch {
    return null;
  }
}

export function getDiagnosticContext(uri: vscode.Uri, diagnostic: vscode.Diagnostic): InjectedContext {
  const file     = path.basename(uri.fsPath);
  const line     = diagnostic.range.start.line + 1;
  const severity = vscode.DiagnosticSeverity[diagnostic.severity];
  const label    = `${file}:${line} (${severity})`;
  const text     = `${severity} at ${file}:${line} — ${diagnostic.message}`;
  return { text, label };
}
