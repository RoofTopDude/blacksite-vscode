/* Pure mapping from agent tool calls to Codebase Map trace targets.
   Mirrors the tool → path-field knowledge in
   src/webview/react/lib/tool-presentation.ts (toolInputPreview). */

import { normalizeGraphPath } from "./graph-model.js";

export type TraceKind = "read" | "write" | "edit" | "shell" | "nav";

export interface ToolTrace {
  path: string;
  kind: TraceKind;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function targetPath(input: Record<string, unknown>): string {
  const target = input.target;
  if (target && typeof target === "object" && !Array.isArray(target)) {
    return str((target as Record<string, unknown>).path);
  }
  return "";
}

/** Extract the files a tool call touches, with the activity kind used for
    trace coloring. Paths are normalized but NOT validated against the node
    set — the graph provider filters to known nodes. */
export function activityToTraces(toolName: string, input: Record<string, unknown> | undefined): ToolTrace[] {
  if (!input || typeof input !== "object") return [];
  const push = (out: ToolTrace[], path: string, kind: TraceKind): void => {
    const normalized = normalizeGraphPath(path);
    if (normalized) out.push({ path: normalized, kind });
  };
  const out: ToolTrace[] = [];

  switch (toolName) {
    case "file_read":
      push(out, str(input.path), "read");
      break;
    case "file_write":
    case "file_delete":
      push(out, str(input.path), "write");
      break;
    case "file_edit":
    case "code_insert":
      push(out, str(input.path), "edit");
      break;
    case "file_edit_batch": {
      if (Array.isArray(input.edits)) {
        for (const edit of input.edits) {
          if (edit && typeof edit === "object") {
            push(out, str((edit as Record<string, unknown>).path), "edit");
          }
        }
      }
      break;
    }
    case "shell_run":
    case "process_start":
      push(out, str(input.cwd), "shell");
      break;
    case "git_op":
      push(out, str(input.path) || str(input.cwd), "shell");
      break;
    case "code_navigate":
    case "code_hover":
    case "code_rename":
      push(out, targetPath(input), "nav");
      break;
    case "code_symbols":
    case "code_diagnostics":
    case "code_actions":
    case "code_format":
      push(out, str(input.path), "nav");
      break;
    default:
      break;
  }
  return out;
}

/** A short "intent" detail for a live tool call — the specific thing the agent is
    doing that the file name alone doesn't convey (the shell command, the git op,
    a batch's edit count). Empty when the file name already says enough (a plain
    read/edit/write). Feeds the Codebase Map's live-activity chip so following the
    agent reads as "running · npm test" rather than just "running · repo". */
export function activityIntent(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== "object") return "";
  const first = (...values: unknown[]): string => {
    for (const value of values) { const s = str(value); if (s) return s; }
    return "";
  };
  switch (toolName) {
    case "shell_run":
    case "process_start": {
      const command = str(input.command);
      const args = Array.isArray(input.args)
        ? input.args.filter((a): a is string => typeof a === "string").slice(0, 2).join(" ")
        : "";
      return [command, args].filter(Boolean).join(" ").slice(0, 48);
    }
    case "git_op":
      return first(input.op, input.branch, input.name).slice(0, 48);
    case "file_edit_batch":
      return Array.isArray(input.edits) ? `${input.edits.length} files` : "";
    case "code_navigate":
    case "code_hover":
    case "code_rename": {
      const target = input.target;
      const symbol = target && typeof target === "object" ? str((target as Record<string, unknown>).symbol) : "";
      return (symbol || str(input.kind)).slice(0, 40);
    }
    default:
      return "";
  }
}
