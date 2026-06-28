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
  diagnosticSummary: string;
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

  const openFiles = vscode.workspace.textDocuments
    .filter((d) => !d.isUntitled && d.uri.scheme === "file")
    .map((d) => path.relative(workspaceRoot, d.uri.fsPath).replace(/\\/g, "/"))
    .filter((p) => !p.startsWith(".."))
    .slice(0, 20);

  const allDiagnostics = vscode.languages.getDiagnostics();
  let errorCount = 0;
  let warnCount = 0;
  for (const [, diags] of allDiagnostics) {
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) errorCount++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnCount++;
    }
  }
  const diagnosticSummary = errorCount + warnCount > 0
    ? `${errorCount} error(s), ${warnCount} warning(s) in workspace`
    : "No diagnostics";

  let gitStatusSummary = "";
  try {
    const resp = await runtime.handleMessage({ type: "workspace.git", payload: { op: "status" } });
    const data = (resp as { result?: { ok?: boolean; data?: { branch?: string; staged?: unknown[]; unstaged?: unknown[]; untracked?: unknown[] } } }).result;
    if (data?.ok && data.data) {
      const s = data.data;
      gitStatusSummary = `Branch: ${s.branch ?? "?"} | Staged: ${s.staged?.length ?? 0} | Unstaged: ${s.unstaged?.length ?? 0} | Untracked: ${s.untracked?.length ?? 0}`;
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
    diagnosticSummary,
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

  if (snapshot.allRoots.length > 1) {
    parts.push("Workspace roots:");
    for (const r of snapshot.allRoots) parts.push(`  ${r}`);
  } else {
    parts.push(`Workspace root: ${snapshot.workspaceRoot}`);
  }

  if (snapshot.openFiles.length > 0) {
    parts.push("", "Open editors:", ...snapshot.openFiles.map((f) => `  ${f}`));
  }

  if (snapshot.diagnosticSummary) {
    parts.push("", `Diagnostics: ${snapshot.diagnosticSummary}`);
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

  // Only surface memory once it holds more than the default header stub.
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

  parts.push(
    "",
    "Guidelines:",
    "- Read files before editing them. Verify changes after writing.",
    "- Prefer code intelligence over text search: code_symbols to map a file, code_navigate to jump to definitions/implementations or find references, and code_hover to inspect a type or signature. Fall back to file_search only when those don't apply.",
    "- Make changes with file_edit (surgical, shows the user a diff) rather than rewriting whole files; use file_write for new files.",
    "- Use file_edit_batch for coordinated exact-string replacements across multiple files, and code_insert when you need to add code relative to a symbol or line without brittle whole-file matching.",
    "- After editing, call code_diagnostics to catch errors the language servers report, then fix them before finishing.",
    "- For shell commands, confirm the cwd and command before running.",
    "- Operations marked write/network/destructive will prompt the user for approval.",
    "- When writing code, prefer small focused changes. Run tests or lint after editing.",
    "- Use git_op status before commits. Use git_op diff to review changes.",
    "- To persist durable notes for future sessions, use memory_append (project memory) — it is read back into context on the next conversation.",
    "- Use Base Context for static, reusable project context that should stay available across conversations.",
    "- Before starting multi-phase work, use plan_list to check for an existing plan, then use plan_create / plan_update to track phases and plan state.",
    "- For concrete 3+ step execution, use todo_list before todo_create, then keep todo_update current while the work is actually happening.",
  );

  return parts.join("\n");
}

export function registerFileWatcher(
  workspaceRoot: string,
  onContextChange: () => void,
): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, "**/*.{ts,tsx,js,jsx,py,go,rs,json,md}"),
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
