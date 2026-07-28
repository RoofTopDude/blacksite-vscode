/* Pure formatting/label helpers ported verbatim from the legacy webview HTML
   implementation. Framework-agnostic — no DOM access. */

/* eslint-disable @typescript-eslint/no-explicit-any */

export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function readStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readNum(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

export function shortText(value: unknown, max = 120): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/**
 * Like shortText, but keeps the END of the value.
 *
 * For a readout that updates while text streams in, the newest characters are the
 * informative ones. Trimming the tail instead would pin the view to the start of the
 * line, so a value that is still growing would look frozen.
 */
export function tailText(value: unknown, max = 120): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `…${normalized.slice(normalized.length - (max - 1))}` : normalized;
}

export function shortPath(value: unknown, max = 60): string {
  const input = readStr(value);
  if (!input) return "";
  const normalized = input.replace(/\\/g, "/");
  if (normalized.length <= max) return normalized;
  const tail = normalized.split("/").slice(-3).join("/");
  return tail.length + 3 <= max ? `...${tail}` : `...${normalized.slice(-(max - 3))}`;
}

export function formatBytes(bytes: unknown): string {
  const num = readNum(bytes);
  if (num == null || num <= 0) return "";
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(num >= 10 * 1024 ? 0 : 1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(num >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function formatDuration(ms: unknown): string {
  const num = readNum(ms);
  if (num == null) return "";
  if (num < 1000) return `${Math.max(Math.round(num), 0)}ms`;
  if (num < 60000) return `${(num / 1000).toFixed(num >= 10000 ? 0 : 1)}s`;
  const minutes = Math.floor(num / 60000);
  const seconds = Math.round((num % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Elapsed time for a span that may still be in progress. `endedAt` wins when set
 * (the span is finished); otherwise elapsed is measured against `now`, so a caller
 * re-rendering with an advancing `now` sees the duration tick upward live instead
 * of freezing at whatever it read when the span started. Returns null when there
 * is no start time to measure from.
 */
export function liveElapsedMs(startedAt: number | null | undefined, endedAt: number | null | undefined, now: number): number | null {
  if (startedAt == null) return null;
  const end = endedAt ?? now;
  return Math.max(end - startedAt, 0);
}

/** "iteration 3 of 40" — empty string when there's nothing meaningful to show. */
export function iterationProgressLabel(iterations: number, maxIterations: number | undefined): string {
  if (!iterations || iterations < 1) return "";
  if (!maxIterations || maxIterations < 1) return countLabel(iterations, "iteration");
  return `iteration ${iterations} of ${maxIterations}`;
}

export function formatTokenCount(value: unknown): string {
  const num = readNum(value);
  if (num == null || num <= 0) return "0";
  if (num >= 1000000) return `${(num / 1000000).toFixed(num >= 10000000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(num >= 100000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(Math.round(num));
}

/** Format a USD spend estimate: enough precision that fractional-cent per-turn costs are still
    meaningful, without a wall of trailing zeros once a session's spend crosses a dollar. */
export function formatCostUsd(value: unknown): string {
  const num = readNum(value);
  if (num == null || num <= 0) return "$0.00";
  if (num < 0.01) return `$${num.toFixed(4)}`;
  if (num < 1) return `$${num.toFixed(3)}`;
  return `$${num.toFixed(2)}`;
}

export function formatClock(ts: unknown): string {
  const num = readNum(ts);
  if (num == null || num <= 0) return "";
  try {
    return new Date(num).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** "just now" / "5m ago" / "3h ago" / "2d ago"; falls back to a locale date
 *  beyond a week, when relative phrasing stops aiding recall. */
export function formatRelativeTime(ts: unknown, now = Date.now()): string {
  const num = readNum(ts);
  if (num == null || num <= 0) return "";
  const seconds = Math.max(0, Math.round((now - num) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  try {
    return new Date(num).toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export function countLabel(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : plural || `${singular}s`}`;
}

export function diagSuffix(result: any): string {
  const d = result && result.diagnostics;
  if (!d) return "";
  if (d.errors) return countLabel(d.errors, "error");
  if (d.warnings) return countLabel(d.warnings, "warning");
  if (d.status === "partial") return "diagnostics partial";
  if (d.status === "timed_out") return "diagnostics timed out";
  if (d.status === "unknown") return "diagnostics unconfirmed";
  if (d.status === "cancelled") return "diagnostics cancelled";
  return "no problems";
}

export function hostLabel(urlStr: unknown): string {
  const input = readStr(urlStr);
  if (!input) return "";
  try {
    const parsed = new URL(input);
    return shortText(`${parsed.hostname}${parsed.pathname}`, 70);
  } catch {
    return shortText(input, 70);
  }
}

export function joinParts(parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

export function humanizeWord(word: unknown): string {
  const lower = String(word || "").toLowerCase();
  if (!lower) return "";
  const map: Record<string, string> = {
    mcp: "MCP", git: "Git", api: "API", pr: "PR", prs: "PRs", mr: "MR", mrs: "MRs",
    jira: "Jira", github: "GitHub", gitlab: "GitLab", jql: "JQL", cql: "CQL", soql: "SOQL", id: "ID",
  };
  if (map[lower]) return map[lower];
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function toolDisplayName(name: unknown): string {
  const toolName = readStr(name);
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  return toolName.split("_").filter(Boolean).map(humanizeWord).join(" ") || "Tool";
}

export type ToolState = "ok" | "fail" | "warn" | "pending" | "running";

export function toolStateText(state: ToolState | string): string {
  switch (state) {
    case "ok": return "OK";
    case "fail": return "ERR";
    case "warn": return "WARN";
    case "pending": return "WAIT";
    default: return "RUN";
  }
}

export function countLines(text: unknown): number {
  const value = typeof text === "string" ? text.replace(/\r\n/g, "\n") : "";
  if (!value) return 0;
  return value.split("\n").length;
}

export function diffLineStats(before: unknown, after: unknown): { additions: number; deletions: number } {
  const oldLines = String(before || "").replace(/\r\n/g, "\n").split("\n");
  const newLines = String(after || "").replace(/\r\n/g, "\n").split("\n");
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  let i = m;
  let j = n;
  let additions = 0;
  let deletions = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      additions++; j--;
    } else {
      deletions++; i--;
    }
  }
  return { additions, deletions };
}

export interface ToolFileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface ToolChange {
  verb: string;
  path: string;
  secondary: string;
  additions: number;
  deletions: number;
  /** Each file affected by a multi-file tool call. Single-file changes use the
   *  top-level fields so existing callers stay compact. */
  files?: ToolFileChange[];
}

function batchFileChanges(edits: unknown): ToolFileChange[] {
  if (!Array.isArray(edits)) return [];
  const byPath = new Map<string, ToolFileChange>();
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") continue;
    const item = edit as Record<string, unknown>;
    const path = readStr(item.path);
    if (!path) continue;
    const stats = diffLineStats(item.oldString, item.newString);
    const existing = byPath.get(path);
    if (existing) {
      existing.additions += stats.additions;
      existing.deletions += stats.deletions;
    } else {
      byPath.set(path, { path, additions: stats.additions, deletions: stats.deletions });
    }
  }
  return [...byPath.values()];
}

function mutationFileChanges(output: any): ToolFileChange[] {
  const raw = Array.isArray(output?.mutation?.changes)
    ? output.mutation.changes
    : output?.mutation?.touchedFiles;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((change): ToolFileChange[] => {
    if (!change || typeof change !== "object") return [];
    const item = change as Record<string, unknown>;
    const path = readStr(item.path);
    if (!path) return [];
    return [{
      path,
      additions: Math.max(readNum(item.additions) ?? 0, 0),
      deletions: Math.max(readNum(item.deletions) ?? 0, 0),
    }];
  });
}

function summarizedFileChange(verb: string, files: ToolFileChange[], secondary = ""): ToolChange | null {
  if (!files.length) return null;
  return {
    verb,
    path: files.length === 1 ? files[0]!.path : countLabel(files.length, "file"),
    secondary,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    files,
  };
}

export function toolChangePresentation(toolName: string, input: any, result: any): ToolChange | null {
  const data = input && typeof input === "object" ? input : {};
  const output = result && typeof result === "object" ? result : {};
  const targetPath = readStr(data.path || output.path || output.worktreePath);
  // Once a tool reports failure, remove its planned change from the transcript
  // and conversation ledger. Before completion, the preview remains useful.
  if (result != null && output.ok === false) return null;
  switch (toolName) {
    case "file_edit": {
      if (!targetPath) return null;
      const stats = diffLineStats(data.oldString, data.newString);
      const repetitions = data.replaceAll ? Math.max(readNum(output.replacements) ?? 1, 1) : 1;
      return {
        verb: "Editing",
        path: targetPath,
        secondary: data.replaceAll ? "Replace all" : (output.replacements != null ? countLabel(output.replacements, "replacement") : ""),
        additions: stats.additions * repetitions,
        deletions: stats.deletions * repetitions,
      };
    }
    case "file_edit_batch": {
      const files = batchFileChanges(data.edits);
      if (!files.length) return null;
      return {
        verb: "Editing",
        path: countLabel(files.length, "file"),
        secondary: output.replacements != null ? countLabel(output.replacements, "replacement") : "",
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
        files,
      };
    }
    case "file_write": {
      if (!targetPath) return null;
      return {
        verb: "Writing",
        path: targetPath,
        secondary: readNum(output.bytesWritten) != null ? formatBytes(output.bytesWritten) : "",
        additions: countLines(data.content),
        deletions: 0,
      };
    }
    case "file_delete": {
      if (!targetPath) return null;
      return { verb: "Deleting", path: targetPath, secondary: "", additions: 0, deletions: 0 };
    }
    case "file_move": {
      const destination = readStr(data.destination || output.destination);
      const source = readStr(data.source || output.source);
      if (!destination && !source) return null;
      return { verb: "Moving", path: destination || source, secondary: source && destination ? `from ${source}` : "", additions: 0, deletions: 0 };
    }
    case "file_copy": {
      const destination = readStr(data.destination || output.destination);
      const source = readStr(data.source || output.source);
      if (!destination && !source) return null;
      return { verb: "Copying", path: destination || source, secondary: source && destination ? `from ${source}` : "", additions: 0, deletions: 0 };
    }
    case "json_edit": {
      if (!targetPath) return null;
      const lineChanges = output.lineChanges && typeof output.lineChanges === "object"
        ? output.lineChanges as Record<string, unknown>
        : {};
      return {
        verb: "Editing",
        path: targetPath,
        secondary: output.operations != null ? countLabel(output.operations, "operation") : "",
        additions: Math.max(readNum(lineChanges.additions) ?? 0, 0),
        deletions: Math.max(readNum(lineChanges.deletions) ?? 0, 0),
      };
    }
    case "code_insert": {
      const insertPath = readStr(data.target?.path || output.path);
      if (!insertPath) return null;
      const changedFiles = mutationFileChanges(output);
      if (changedFiles.length) return summarizedFileChange("Inserting", changedFiles, output.line != null ? `line ${output.line}` : "");
      return {
        verb: "Inserting",
        path: insertPath,
        secondary: output.line != null ? `line ${output.line}` : "",
        additions: countLines(data.text),
        deletions: 0,
      };
    }
    case "code_rename": {
      const renamePath = readStr(data.target?.path || data.path);
      if (!renamePath) return null;
      const changedFiles = mutationFileChanges(output);
      const secondary = joinParts([
        data.newName ? `to ${shortText(data.newName, 28)}` : "",
        output.files != null ? countLabel(output.files, "file") : "",
        output.edits != null ? countLabel(output.edits, "edit") : "",
      ]);
      if (changedFiles.length) return summarizedFileChange("Renaming", changedFiles, secondary);
      return {
        verb: "Renaming",
        path: renamePath,
        secondary: joinParts([
          data.newName ? `→ ${shortText(data.newName, 28)}` : "",
          output.files != null ? countLabel(output.files, "file") : "",
          output.edits != null ? countLabel(output.edits, "edit") : "",
        ]),
        additions: 0,
        deletions: 0,
      };
    }
    case "code_actions": {
      const actionPath = readStr(data.path);
      if (!actionPath || (!readStr(data.apply) && output.files == null && output.edits == null)) return null;
      const changedFiles = mutationFileChanges(output);
      const secondary = joinParts([
        readStr(data.apply || output.title),
        output.files != null ? countLabel(output.files, "file") : "",
        output.edits != null ? countLabel(output.edits, "edit") : "",
      ]);
      if (changedFiles.length) return summarizedFileChange("Applying", changedFiles, secondary);
      return {
        verb: "Applying",
        path: actionPath,
        secondary: joinParts([
          readStr(data.apply || output.title),
          output.files != null ? countLabel(output.files, "file") : "",
          output.edits != null ? countLabel(output.edits, "edit") : "",
        ]),
        additions: 0,
        deletions: 0,
      };
    }
    case "code_replace": {
      const replacePath = readStr(data.target?.path || output.path);
      if (!replacePath) return null;
      const changedFiles = mutationFileChanges(output);
      if (changedFiles.length) {
        return summarizedFileChange("Replacing", changedFiles, joinParts([
          readStr(output.symbol) || (data.target?.symbol ? readStr(data.target.symbol) : ""),
          output.startLine != null && output.endLine != null ? `lines ${output.startLine}-${output.endLine}` : "",
        ]));
      }
      const startLine = readNum(output.startLine);
      const endLine = readNum(output.endLine);
      return {
        verb: "Replacing",
        path: replacePath,
        secondary: joinParts([
          readStr(output.symbol) || (data.target?.symbol ? readStr(data.target.symbol) : ""),
          output.startLine != null && output.endLine != null ? `lines ${output.startLine}-${output.endLine}` : "",
        ]),
        additions: countLines(data.text),
        deletions: startLine != null && endLine != null ? Math.max(endLine - startLine + 1, 0) : 0,
      };
    }
    case "code_replace_batch": {
      const changedFiles = mutationFileChanges(output);
      if (changedFiles.length) return summarizedFileChange("Replacing", changedFiles, output.edits != null ? countLabel(output.edits, "symbol") : "");
      const edits = Array.isArray(data.edits) ? data.edits : [];
      const results = Array.isArray(output.results) ? output.results : [];
      const files = new Map<string, ToolFileChange>();
      for (const [index, edit] of edits.entries()) {
        if (!edit || typeof edit !== "object") continue;
        const item = edit as Record<string, unknown>;
        const resultItem = results[index] && typeof results[index] === "object"
          ? results[index] as Record<string, unknown>
          : {};
        const target = item.target && typeof item.target === "object" ? item.target as Record<string, unknown> : {};
        const path = readStr(target.path || resultItem.path);
        if (!path) continue;
        const startLine = readNum(resultItem.startLine);
        const endLine = readNum(resultItem.endLine);
        const current = files.get(path) ?? { path, additions: 0, deletions: 0 };
        current.additions += countLines(item.text);
        current.deletions += startLine != null && endLine != null ? Math.max(endLine - startLine + 1, 0) : 0;
        files.set(path, current);
      }
      const batchChanges = [...files.values()];
      if (!batchChanges.length) return null;
      return {
        verb: "Replacing",
        path: countLabel(batchChanges.length, "file"),
        secondary: output.edits != null ? countLabel(output.edits, "symbol") : "",
        additions: batchChanges.reduce((total, file) => total + file.additions, 0),
        deletions: batchChanges.reduce((total, file) => total + file.deletions, 0),
        files: batchChanges,
      };
    }
    case "code_format": {
      const formatPath = readStr(data.path);
      if (!formatPath || output.formatted === false) return null;
      const changedFiles = mutationFileChanges(output);
      if (changedFiles.length) return summarizedFileChange("Formatting", changedFiles, output.edits != null ? countLabel(output.edits, "edit") : "");
      return {
        verb: "Formatting",
        path: formatPath,
        secondary: output.edits != null ? countLabel(output.edits, "edit") : "",
        additions: 0,
        deletions: 0,
      };
    }
    default:
      return null;
  }
}

export function stopReasonLabel(reason: unknown): string {
  const value = readStr(reason);
  if (!value) return "";
  if (value === "stop") return "complete";
  if (value === "end_turn") return "complete";
  if (value === "max_tokens") return "max tokens";
  if (value === "max_iterations") return "max iterations";
  if (value === "tool_use") return "tool loop";
  return value.replace(/_/g, " ");
}

export interface ToolGroupDef {
  label: string;
  tools: string[];
}

export const TOOL_GROUPS: ToolGroupDef[] = [
  { label: "Files", tools: ["file_list", "file_read", "file_edit", "file_edit_batch", "json_edit", "file_write", "file_delete", "file_mkdir", "file_move", "file_copy", "file_glob", "file_search"] },
  { label: "Shell", tools: ["shell_run", "process_start", "process_status", "process_read_output", "process_send_input", "process_stop"] },
  { label: "Git", tools: ["git_op", "worktree_op"] },
  { label: "Planning", tools: ["plan_create", "plan_update", "plan_list", "plan_doc_write", "plan_doc_read", "plan_doc_list", "todo_create", "todo_update", "todo_status", "todo_list"] },
  { label: "Tickets", tools: ["ticket_file", "ticket_update", "ticket_list", "ticket_comment", "ticket_next", "ticket_promote"] },
  { label: "Delegation", tools: ["subagent_spawn", "subagent_followup"] },
  { label: "Code Intel", tools: ["code_insert", "code_replace", "code_replace_batch", "code_symbols", "code_navigate", "code_hierarchy", "code_hover", "code_diagnostics", "code_rename", "code_actions", "code_format", "code_inlay_hints"] },
  { label: "Codebase Map", tools: ["map_overview", "map_find", "map_relationships", "map_impact", "map_path", "map_note_add", "map_note_list", "map_note_update", "map_note_remove"] },
  { label: "Memory", tools: ["memory_append", "memory_read", "memory_search"] },
  { label: "Data", tools: ["db_list_objects", "db_describe_object", "db_preview_rows", "db_run_read_query", "db_preview_write_query", "db_vector_search", "db_list_saved_queries"] },
  { label: "Reference", tools: ["reference_list", "reference_read", "reference_query_spreadsheet", "reference_zoom_image", "reference_vector_search", "reference_context_read", "reference_context_write"] },
  { label: "Transcript", tools: ["transcript_read", "transcript_document"] },
  { label: "Diagnostics", tools: ["report_problems"] },
  { label: "Recovery", tools: ["tool_output_page", "tool_output_search"] },
  { label: "Tests", tools: ["test_detect", "test_run"] },
  { label: "Browser", tools: ["browser_navigate", "browser_click", "browser_type", "browser_screenshot", "browser_get_text", "browser_evaluate", "browser_run_script"] },
  { label: "GitHub", tools: ["github_list_issues", "github_get_issue", "github_create_issue", "github_list_prs", "github_get_pr", "github_create_pr", "github_list_branches", "github_get_file", "github_search_code", "github_add_comment"] },
  { label: "GitLab", tools: ["gitlab_list_issues", "gitlab_get_issue", "gitlab_create_issue", "gitlab_list_mrs", "gitlab_get_mr", "gitlab_create_mr", "gitlab_list_branches"] },
  { label: "Jira", tools: ["jira_list_issues", "jira_get_issue", "jira_create_issue", "jira_update_issue", "jira_add_comment", "jira_list_projects"] },
  { label: "Confluence", tools: ["confluence_search", "confluence_get_page", "confluence_create_page", "confluence_update_page", "confluence_list_spaces"] },
  { label: "Salesforce", tools: ["salesforce_query", "salesforce_get_object", "salesforce_create_object", "salesforce_update_object", "salesforce_list_objects"] },
  { label: "MCP", tools: ["mcp_list_tools", "mcp_call_tool"] },
];

export const ALL_TOOL_NAMES: string[] = TOOL_GROUPS.flatMap((g) => g.tools);

export const TOOL_LABELS: Record<string, string> = {
  map_overview: "Map Overview",
  map_find: "Map Search",
  map_relationships: "Map Relationships",
  map_impact: "Map Blast Radius",
  map_path: "Map Route",
  map_note_add: "Add Map Note",
  map_note_list: "List Map Notes",
  map_note_update: "Update Map Note",
  map_note_remove: "Remove Map Note",
  shell_run: "Shell Command",
  process_start: "Process Start",
  process_status: "Process Status",
  process_read_output: "Process Output",
  process_send_input: "Process Input",
  process_stop: "Process Stop",
  file_list: "List Files",
  file_read: "Read File",
  file_edit: "Edit File",
  file_edit_batch: "Batch Edit",
  json_edit: "JSON Edit",
  file_write: "Write File",
  file_delete: "Delete Path",
  file_mkdir: "Create Directory",
  file_glob: "File Glob",
  file_search: "File Search",
  git_op: "Git Operation",
  plan_create: "Create Plan",
  plan_update: "Update Plan",
  plan_list: "List Plans",
  plan_doc_write: "Write Plan Doc",
  plan_doc_read: "Read Plan Doc",
  plan_doc_list: "List Plan Docs",
  ticket_file: "File Ticket",
  ticket_update: "Update Ticket",
  ticket_list: "List Tickets",
  ticket_comment: "Comment on Ticket",
  ticket_next: "Next Ticket",
  ticket_promote: "Promote Ticket",
  todo_create: "Create Task Items",
  todo_update: "Update Task Items",
  todo_status: "Task Items Status",
  todo_list: "List Task Items",
  code_insert: "Insert Code",
  code_replace: "Replace Code",
  code_replace_batch: "Batch Replace Code",
  code_symbols: "Symbols",
  code_navigate: "Navigate",
  code_hierarchy: "Hierarchy",
  code_hover: "Hover",
  code_diagnostics: "LSP Diagnostics",
  code_rename: "Rename Symbol",
  code_actions: "Code Action",
  code_format: "Format",
  code_inlay_hints: "Inlay Hints",
  memory_append: "Remember",
  memory_read: "Recall Memory",
  tool_output_page: "Continue Output",
  tool_output_search: "Search Output",
  report_problems: "Report Problems",
  test_detect: "Detect Tests",
  test_run: "Run Tests",
  worktree_op: "Worktree",
  subagent_spawn: "Delegate Lane",
  subagent_followup: "Follow Up Lane",
  github_op: "GitHub",
  gitlab_op: "GitLab",
  jira_op: "Jira",
  confluence_op: "Confluence",
  salesforce_op: "Salesforce",
  mcp_list_tools: "MCP Tools",
  mcp_call_tool: "MCP Call",
  question_card: "Question",
  browser_navigate: "Browser Navigate",
  browser_click: "Browser Click",
  browser_type: "Browser Type",
  browser_screenshot: "Browser Screenshot",
  browser_get_text: "Browser Extract Text",
  browser_evaluate: "Browser Evaluate",
  browser_run_script: "Browser Script",
  approval: "Approval",
  transcript_document: "Transcript Document",
};
