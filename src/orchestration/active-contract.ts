/**
 * A contract in force for one running lane, and the edit-path half of its enforcement.
 *
 * The lane's AgentSession checks each call's named targets before it runs; this file checks the
 * files an editor or language-server edit actually touches, which a rename or code action does
 * not name in its input. Both halves share one {@link ActiveWorkContract}, so a path approved at
 * one boundary is not asked about again at the other.
 *
 * An out-of-territory write is a gate, not a wall: it goes to whoever decides this lane's
 * approvals — the user, the chat's reviewer in auto mode, a loop's continuation reviewer — and
 * an approval lets the lane write there for the rest of its run. The receipt lists every path an
 * approval granted, so widening is always visible afterwards.
 */

import type { EditProvider, EditProviderOptions } from "../diff-edit-service.js";
import type { LspContext, LspProvider } from "../lsp-service.js";
import type { EditApprovalProvider, EditApprovalRequest } from "../workspace-edit-applier.js";
import { outOfScope, scopeGateDescription, type ScopeContext } from "./contract-scope.js";
import type { WorkContract } from "./work-contract.js";

export interface ActiveWorkContract {
  contract: WorkContract;
  /** Paths outside the territory an approval has let this lane write. */
  granted: Set<string>;
  /** Calls stopped because an out-of-territory write was not approved. */
  refused: Array<{ toolName: string; reason: string }>;
  /** Out-of-territory targets seen while the contract only observes. */
  observedOutOfScope: Set<string>;
}

export function activateContract(contract: WorkContract): ActiveWorkContract {
  return { contract, granted: new Set(), refused: [], observedOutOfScope: new Set() };
}

/** Ask whoever decides this lane's approvals about an out-of-territory write. */
export type ScopeGate = (toolName: string, description: string, paths: readonly string[]) => Promise<boolean>;

/**
 * Settle the out-of-territory part of an edit. Returns true when it may proceed. Shared by the
 * session's pre-dispatch check and the edit wrappers below.
 */
export async function settleScope(
  active: ActiveWorkContract,
  toolName: string,
  targets: readonly string[],
  context: ScopeContext,
  gate: ScopeGate,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const out = outOfScope(active.contract, targets, active.granted, context);
  if (out.length === 0) return { ok: true };
  if (active.contract.enforcement === "observe") {
    for (const file of out) active.observedOutOfScope.add(file);
    return { ok: true };
  }
  const description = scopeGateDescription(out, active.contract.objective);
  let approved = false;
  try {
    approved = await gate(toolName, description, out);
  } catch {
    approved = false;
  }
  if (approved) {
    for (const file of out) active.granted.add(file);
    return { ok: true };
  }
  const reason = `Not written: ${out.slice(0, 8).join(", ")} ${out.length === 1 ? "is" : "are"} outside this lane's work contract and the write was not approved. `
    + "Keep the change inside the contract's files, or report what else needs to change.";
  active.refused.push({ toolName, reason });
  return { ok: false, reason };
}

/** Would the applier have asked anyone about this edit, given the caller's original options? */
function wouldAsk(request: EditApprovalRequest, originalAutoApprove: boolean): boolean {
  return !originalAutoApprove || (request.resourceOperations ?? 0) > 0 || (request.snippetEdits ?? 0) > 0;
}

function contractRouting<T extends EditProviderOptions | LspContext>(
  options: T,
  active: ActiveWorkContract,
  toolName: string,
  context: ScopeContext,
  gate: ScopeGate,
): T {
  const originalAuto = options.autoApprove;
  const inner = options.approvalProvider;
  const approvalProvider: EditApprovalProvider = async (request) => {
    const scope = await settleScope(active, toolName, request.paths ?? [], context, gate);
    if (!scope.ok) return "reject";
    // Everything else exactly as the caller asked: no prompt where none was due.
    if (!wouldAsk(request, originalAuto)) return "apply";
    return inner ? inner(request) : null;
  };
  return {
    ...options,
    // The applier skips its approval step entirely under autoApprove, which would skip the scope
    // check too. Turn it off and reproduce the caller's own decision in the provider above.
    autoApprove: false,
    approvalProvider,
    shouldPreview: (request: EditApprovalRequest) => {
      if (!wouldAsk(request, originalAuto)) return false;
      return options.shouldPreview ? options.shouldPreview(request) : options.showPreview !== false;
    },
  };
}

export function createContractEditProvider(
  delegate: EditProvider,
  active: ActiveWorkContract,
  context: ScopeContext,
  gate: ScopeGate,
): EditProvider {
  return {
    applyEdit: (input, opts) => delegate.applyEdit(input, contractRouting(opts, active, "file_edit", context, gate)),
    applyBatchEdits: (input, opts) => delegate.applyBatchEdits(input, contractRouting(opts, active, "file_edit_batch", context, gate)),
    applyJsonEdit: (input, opts) => delegate.applyJsonEdit(input, contractRouting(opts, active, "json_edit", context, gate)),
    ...(delegate.movePath
      ? { movePath: (input, opts) => delegate.movePath!(input, contractRouting(opts, active, "file_move", context, gate)) }
      : {}),
  };
}

export function createContractLspProvider(
  delegate: LspProvider,
  active: ActiveWorkContract,
  context: ScopeContext,
  gate: ScopeGate,
): LspProvider {
  return {
    dispatch: (op, payload, ctx) => delegate.dispatch(op, payload, contractRouting(ctx, active, `code_${op}`, context, gate)),
  };
}
