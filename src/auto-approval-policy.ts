/**
 * Auto mode for chat approvals.
 *
 * In "ask" mode every gated operation waits for the user. In "auto" mode the harness settles the
 * routine ones itself and still hands the user everything else:
 *
 *  - **Workspace edits apply without a prompt** — they are reversible with Rewind — unless they are
 *    destructive, run an unpreviewable code-action command, or touch a protected path.
 *  - **Commands go to the reviewer**, the same no-tools model the Ticket Loops use, with the user's
 *    own words in front of it. It allows only what is clearly part of the request; anything else
 *    escalates to the user. It never denies: refusing is the user's call.
 *  - **Some things always ask**: destructive operations, external-service mutations, sequences, and
 *    anything touching a protected path. Browser input and web-domain access have their own gates
 *    and are untouched by auto mode.
 *
 * An auto approval is one-shot. It never becomes an "Allow all" grant or an always-allow rule.
 */

import type { ApprovalCategory } from "./approval-scope.js";
import type { EditProvider, EditProviderOptions } from "./diff-edit-service.js";
import type { LspContext, LspProvider } from "./lsp-service.js";
import type { EditApprovalProvider, EditApprovalRequest } from "./workspace-edit-applier.js";

export type ApprovalMode = "ask" | "auto";

/**
 * Paths an automatic approval never writes. Each either configures the agent itself (so an edit
 * would widen what it may do next), runs code on some later event (git hooks, CI, dev containers,
 * editor tasks), or holds credentials.
 */
const PROTECTED_PATH_PATTERNS: readonly RegExp[] = [
  /^\.git(\/|$)/,
  /^\.blacksite(\/|$)/,
  /^\.vscode(\/|$)/,
  /^\.claude(\/|$)/,
  /^\.agents(\/|$)/,
  /^\.github\/(workflows|actions)(\/|$)/,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.circleci(\/|$)/,
  /^azure-pipelines\.ya?ml$/,
  /(^|\/)jenkinsfile$/,
  /^\.husky(\/|$)/,
  /^\.devcontainer(\/|$)/,
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)\.(npmrc|pypirc|netrc)$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
];

export function isProtectedPath(relPath: string): boolean {
  const normalized = relPath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
  if (!normalized) return false;
  return PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** The workspace paths a runtime-confirmed file tool writes, read from its arguments. */
export function runtimeEditTargets(toolName: string, input: Record<string, unknown>): string[] {
  const text = (value: unknown): string[] => (typeof value === "string" && value.trim() ? [value.trim()] : []);
  switch (toolName) {
    case "file_write":
    case "file_delete":
    case "file_mkdir":
      return text(input["path"]);
    case "file_copy":
      return text(input["destination"]);
    case "file_move":
      return [...text(input["source"]), ...text(input["destination"])];
    default:
      return [];
  }
}

export interface AutoApprovalRequest {
  category: ApprovalCategory;
  tier: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** The deterministic part of auto mode. "review" means: ask the model reviewer. */
export type AutoTriage =
  | { action: "allow"; reason: string }
  | { action: "escalate"; reason: string }
  | { action: "review" };

export function triageAutoApproval(request: AutoApprovalRequest): AutoTriage {
  if (request.tier === "destructive") {
    return { action: "escalate", reason: "Auto mode never approves destructive operations." };
  }
  if (request.category === "service") {
    return { action: "escalate", reason: "Auto mode never approves changes to external services." };
  }
  if (request.category === "sequence") {
    return { action: "escalate", reason: "Auto mode never approves recorded sequences." };
  }
  if (request.category === "edit") {
    const targets = runtimeEditTargets(request.toolName, request.input);
    const guarded = targets.find(isProtectedPath);
    if (guarded) return { action: "escalate", reason: `${guarded} is a protected path, so auto mode leaves it to you.` };
    if (targets.length === 0) return { action: "escalate", reason: "Auto mode could not tell which files this changes." };
    return { action: "allow", reason: "Workspace edit, reversible with Rewind." };
  }
  return { action: "review" };
}

/** Triage for an editor or language-server edit, from what the applier reports about it. */
export function triageAutoEdit(request: EditApprovalRequest): { action: "allow" | "escalate"; reason: string } {
  if (request.destructive) {
    return { action: "escalate", reason: "It can overwrite or delete a file, and auto mode never approves that." };
  }
  if (request.unpreviewableCommand) {
    return { action: "escalate", reason: "It runs a code-action command whose changes cannot be previewed." };
  }
  const paths = request.paths ?? [];
  const guarded = paths.find(isProtectedPath);
  if (guarded) return { action: "escalate", reason: `${guarded} is a protected path, so auto mode leaves it to you.` };
  if (paths.length === 0) return { action: "escalate", reason: "Auto mode could not tell which files this changes." };
  return { action: "allow", reason: "Workspace edit, reversible with Rewind." };
}

export interface AutoModeEditDeps {
  mode: () => ApprovalMode;
  /** The person, for everything auto mode will not settle: the chat's own approval card. */
  escalate: EditApprovalProvider;
}

function autoModeOptions<T extends EditProviderOptions | LspContext>(options: T, deps: AutoModeEditDeps): T {
  // Ask mode, or an "Allow all this turn" the user already gave: the ordinary path applies.
  if (deps.mode() !== "auto" || options.autoApprove) return options;
  const approvalProvider: EditApprovalProvider = async (request) => {
    const triage = triageAutoEdit(request);
    if (triage.action === "allow") return "apply";
    return deps.escalate({ ...request, summary: `${request.summary}\n\nAuto mode: ${triage.reason}` });
  };
  return {
    ...options,
    approvalProvider,
    // Preview only what a person will be asked about; automatic edits would otherwise flash tabs.
    shouldPreview: (request: EditApprovalRequest) => triageAutoEdit(request).action === "escalate",
  };
}

export function createAutoModeEditProvider(delegate: EditProvider, deps: AutoModeEditDeps): EditProvider {
  return {
    applyEdit: (input, opts) => delegate.applyEdit(input, autoModeOptions(opts, deps)),
    applyBatchEdits: (input, opts) => delegate.applyBatchEdits(input, autoModeOptions(opts, deps)),
    applyJsonEdit: (input, opts) => delegate.applyJsonEdit(input, autoModeOptions(opts, deps)),
    ...(delegate.movePath
      ? { movePath: (input, opts) => delegate.movePath!(input, autoModeOptions(opts, deps)) }
      : {}),
  };
}

export function createAutoModeLspProvider(delegate: LspProvider, deps: AutoModeEditDeps): LspProvider {
  return {
    dispatch: (op, payload, ctx) => delegate.dispatch(op, payload, autoModeOptions(ctx, deps)),
  };
}
