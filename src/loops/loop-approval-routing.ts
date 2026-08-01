/**
 * Request-scoped approval routing for unattended loop lanes.
 *
 * Runtime-backed tools already expose confirmation requirements through AgentSession's
 * approvalProvider. Editor and language-server mutations are different: they reach the shared
 * WorkspaceEditApplier directly. These wrappers give those paths the same continuation reviewer
 * without changing the global interactive provider or leaking policy between concurrent lanes.
 */

import type { ApprovalDecision } from "../approval-gate.js";
import type { EditProvider, EditProviderOptions } from "../diff-edit-service.js";
import type { LspContext, LspProvider } from "../lsp-service.js";
import type { EditApprovalProvider, EditApprovalRequest } from "../workspace-edit-applier.js";

export type UnattendedApprovalPolicy = (
  tier: string,
  toolName: string,
  description: string,
) => ApprovalDecision | null | Promise<ApprovalDecision | null>;

/** Make a review refusal terminal for this lane so its worker slot returns to the supervisor. */
export function stopLaneOnApprovalDenial(
  policy: UnattendedApprovalPolicy,
  stop: (reason: string) => void,
): UnattendedApprovalPolicy {
  return async (tier, toolName, description) => {
    const decision = await policy(tier, toolName, description);
    if (!decision || decision === "deny") stop("Blocked by automated continuation review.");
    return decision ?? "deny";
  };
}

function reviewDescription(request: EditApprovalRequest): string {
  return [
    request.summary,
    request.destructive ? "This operation can overwrite or remove an existing workspace resource." : "",
    request.unpreviewableCommand
      ? `The command '${request.unpreviewableCommand}' cannot be represented as a previewable workspace edit.`
      : "",
  ].filter(Boolean).join("\n");
}

/** Convert a continuation verdict into the applier's one-shot decision vocabulary. */
export function loopEditApprovalProvider(
  policy: UnattendedApprovalPolicy,
  toolName: string,
): EditApprovalProvider {
  return async (request) => {
    const decision = await policy(
      request.destructive ? "destructive" : "write",
      toolName,
      reviewDescription(request),
    );
    // Never persist or widen a workspace permission from an unattended run. Each mutation is
    // independently reviewed, even if a future policy implementation returns allow_all.
    // Null means no unattended policy claimed the request. Deny here instead of allowing the
    // shared applier to fall through to a native modal that can strand the loop.
    return !decision || decision === "deny" ? "reject" : "apply";
  };
}

function reviewedOptions(
  opts: EditProviderOptions,
  policy: UnattendedApprovalPolicy,
  toolName: string,
): EditProviderOptions {
  return {
    ...opts,
    autoApprove: false,
    approvalProvider: loopEditApprovalProvider(policy, toolName),
    showPreview: false,
  };
}

export function createLoopEditProvider(delegate: EditProvider, policy: UnattendedApprovalPolicy): EditProvider {
  return {
    applyEdit: (input, opts) => delegate.applyEdit(input, reviewedOptions(opts, policy, "file_edit")),
    applyBatchEdits: (input, opts) => delegate.applyBatchEdits(input, reviewedOptions(opts, policy, "file_edit_batch")),
    applyJsonEdit: (input, opts) => delegate.applyJsonEdit(input, reviewedOptions(opts, policy, "json_edit")),
    ...(delegate.movePath
      ? { movePath: (input, opts) => delegate.movePath!(input, reviewedOptions(opts, policy, "file_move")) }
      : {}),
  };
}

const LSP_TOOL_NAMES: Readonly<Record<string, string>> = {
  rename: "code_rename",
  actions: "code_actions",
  format: "code_format",
  insert: "code_insert",
  replace: "code_replace",
  replaceBatch: "code_replace_batch",
};

export function createLoopLspProvider(delegate: LspProvider, policy: UnattendedApprovalPolicy): LspProvider {
  return {
    dispatch: (op: string, payload: Record<string, unknown>, ctx: LspContext) => delegate.dispatch(op, payload, {
      ...ctx,
      // The applier calls this only when the operation actually mutates. Read-only code tools
      // therefore remain fast and do not spend a reviewer call.
      autoApprove: false,
      approvalProvider: loopEditApprovalProvider(policy, LSP_TOOL_NAMES[op] ?? `code_${op}`),
      showPreview: false,
    }),
  };
}
