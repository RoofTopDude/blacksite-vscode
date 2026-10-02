/**
 * What an approval answer is allowed to cover.
 *
 * "Allow All" used to flip one session-wide flag. It never reset, so a click on an edit diff in
 * the first turn silently pre-approved destructive commands, code execution and external service
 * mutations for the rest of the conversation. A grant is now keyed by what was actually approved:
 * its category (file edits, commands, service mutations, sequences) and its tier, and it lasts
 * until the current turn ends. Approving all *edits* this turn says nothing about `git push`.
 *
 * Unrecognized commands are narrower still. Their tier is a guess made about an executable
 * nobody has vetted, so an "Allow All" on one covers repeat runs of that same executable only.
 */

import { inlineCodeSnippet, normalizeCommandName } from "@blacksite/local-runtime";

export type ApprovalCategory = "edit" | "command" | "service" | "sequence";

/** Runtime-backed file operations. They reach the gate through the same confirmation protocol as
 *  shell commands, but approving them is approving an edit, so they share the edit grants. */
const RUNTIME_FILE_TOOLS = new Set(["file_write", "file_delete", "file_copy", "file_mkdir", "file_move"]);

export function approvalCategory(toolName: string, runtimeType: string): ApprovalCategory {
  if (runtimeType.startsWith("editor.") || runtimeType.startsWith("lsp.")) return "edit";
  if (runtimeType.startsWith("service.")) return "service";
  if (runtimeType.startsWith("sequence.")) return "sequence";
  if (RUNTIME_FILE_TOOLS.has(toolName)) return "edit";
  return "command";
}

export interface ApprovalScope {
  category: ApprovalCategory;
  tier: string;
  /** Set for an unrecognized executable: the normalized binary name the grant is pinned to. */
  unrecognizedBinary?: string;
  /** Set for inline code (`python -c "…"`): the interpreter the grant is pinned to. A grant for
   *  ordinary commands never covers a snippet, whose code is only visible in its own prompt. */
  inlineCodeBinary?: string;
}

export function approvalGrantKey(scope: ApprovalScope): string {
  const base = `${scope.category}:${scope.tier || "unknown"}`;
  if (scope.inlineCodeBinary) return `${base}:inline:${scope.inlineCodeBinary}`;
  return scope.unrecognizedBinary ? `${base}:unrecognized:${scope.unrecognizedBinary}` : base;
}

/** The grant key for an approval raised by a command-style tool call. */
export function commandApprovalScope(
  toolName: string,
  runtimeType: string,
  tier: string,
  payload: Record<string, unknown>,
  unrecognizedCommand: boolean | undefined,
): ApprovalScope {
  const category = approvalCategory(toolName, runtimeType);
  const command = String(payload["command"] ?? "");
  const args = Array.isArray(payload["args"]) ? payload["args"].map((arg) => String(arg)) : [];
  if (inlineCodeSnippet(command, args) !== undefined) return { category, tier, inlineCodeBinary: normalizeCommandName(command) };
  if (!unrecognizedCommand) return { category, tier };
  return { category, tier, unrecognizedBinary: executableIdentity(String(payload["command"] ?? "")) };
}

/**
 * The identity an unrecognized-command grant is pinned to. A path-style command keeps its whole
 * normalized path — `./build.sh` and `vendor/build.sh` are different programs — while a bare name
 * uses the same normalization as the command allowlists. An empty command gets a key that can
 * never match another call.
 */
function executableIdentity(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return `unnamed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (/[\\/]/.test(trimmed)) return trimmed.replace(/\\/g, "/").toLowerCase();
  return normalizeCommandName(trimmed);
}

/** "Allow All" answers granted during one turn. Cleared when the next turn starts. */
export class TurnApprovalGrants {
  private readonly _keys = new Set<string>();

  has(scope: ApprovalScope): boolean {
    return this._keys.has(approvalGrantKey(scope));
  }

  grant(scope: ApprovalScope): void {
    this._keys.add(approvalGrantKey(scope));
  }

  clear(): void {
    this._keys.clear();
  }

  get size(): number {
    return this._keys.size;
  }
}
