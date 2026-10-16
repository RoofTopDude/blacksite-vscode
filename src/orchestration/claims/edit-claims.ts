/**
 * Claims at the editor and language-server boundary, where an edit's real file list is known.
 *
 * A rename or a code action names no files in its input, so the session's own check before a call
 * cannot see where it will land. The applier does know — `request.paths` — at the moment it asks
 * for approval. This wrapper takes the claim there, on exactly those paths, and rejects the edit
 * when another lane holds one (enforce).
 *
 * It wraps outside the work-contract wrapper (active-contract.ts), the same way that one works:
 * turn the applier's auto-approve off so the approval step always runs, then reproduce the
 * caller's own decision after the claim check. The contract wrapper settles scope first and then
 * hands over to this one, so the order is scope, then claims, then whatever the caller asked.
 * Nothing is prompted that would not have been.
 */

import type { EditProvider, EditProviderOptions } from "../../diff-edit-service.js";
import type { LspContext, LspProvider } from "../../lsp-service.js";
import type { EditApprovalProvider, EditApprovalRequest } from "../../workspace-edit-applier.js";
import type { SessionClaims } from "./session-claims.js";

function wouldAsk(request: EditApprovalRequest, originalAutoApprove: boolean): boolean {
  return !originalAutoApprove || (request.resourceOperations ?? 0) > 0 || (request.snippetEdits ?? 0) > 0;
}

function claimRouting<T extends EditProviderOptions | LspContext>(options: T, claims: SessionClaims, toolName: string): T {
  const originalAuto = options.autoApprove;
  const inner = options.approvalProvider;
  const approvalProvider: EditApprovalProvider = async (request) => {
    // A move or a delete of a directory reaches everything under it.
    const prefix = (request.resourceOperations ?? 0) > 0;
    const claimed = claims.beforeWrite(toolName, request.paths ?? [], { prefix });
    if (!claimed.ok) return "reject";
    if (!wouldAsk(request, originalAuto)) return "apply";
    return inner ? inner(request) : null;
  };
  return {
    ...options,
    autoApprove: false,
    approvalProvider,
    shouldPreview: (request: EditApprovalRequest) => {
      if (!wouldAsk(request, originalAuto)) return false;
      return options.shouldPreview ? options.shouldPreview(request) : options.showPreview !== false;
    },
  };
}

export function createClaimEditProvider(delegate: EditProvider, claims: SessionClaims): EditProvider {
  return {
    applyEdit: (input, opts) => delegate.applyEdit(input, claimRouting(opts, claims, "file_edit")),
    applyBatchEdits: (input, opts) => delegate.applyBatchEdits(input, claimRouting(opts, claims, "file_edit_batch")),
    applyJsonEdit: (input, opts) => delegate.applyJsonEdit(input, claimRouting(opts, claims, "json_edit")),
    ...(delegate.movePath
      ? { movePath: (input, opts) => delegate.movePath!(input, claimRouting(opts, claims, "file_move")) }
      : {}),
  };
}

export function createClaimLspProvider(delegate: LspProvider, claims: SessionClaims): LspProvider {
  return {
    dispatch: (op, payload, ctx) => delegate.dispatch(op, payload, claimRouting(ctx, claims, `code_${op}`)),
  };
}
