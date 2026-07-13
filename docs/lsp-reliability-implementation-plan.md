# LSP Reliability, Safety, and Orchestration — Implementation Plan

Status: implemented (2026-07-13)

Companion design: [`lsp-code-intelligence.md`](./lsp-code-intelligence.md)

Scope: Blacksite VS Code extension code-intelligence tools and their shared edit/diagnostic infrastructure

## Implementation outcome

The production implementation now routes every model provider and delegated session through the same host-side contracts:

- `WorkspaceIdentity` resolves multi-root paths, rejects traversal/external URIs, and root-qualifies model-facing locations.
- `TargetResolver` returns stable symbol candidates, validates 1-based coordinates and stale text anchors, and rejects `firstMatch` for mutations.
- `ProviderExecutor` distinguishes valid empty results from timeout, error, cancellation, and unavailability under one total deadline.
- Diagnostic snapshots report readiness, scope, filtered/unfiltered counts, coverage, document versions, quiescence, and introduced/resolved/persisting deltas.
- `MutationCoordinator.forWorkspace()` serializes the entire mutation lifecycle across parent and delegated sessions.
- Workspace edits inspect text, snippet, and create/delete/rename operations where VS Code exposes them; unknown resource shapes remain opaque and require explicit approval.
- Code-action handles are document-version-bound and short-lived; command-backed actions require approval and observe touched document/file events.
- Hierarchy reads support bounded depth, cycle-safe node/edge graphs, call-site ranges, provider deadlines, and node/edge budgets.
- Privacy-conscious structured telemetry records outcomes and coverage without source text, diagnostic messages, command arguments, or paths.
- Focused LSP unit tests and a real VS Code Extension Host TypeScript fixture are available through `npm run test:lsp`.

The manual Python/Rust/multi-provider release smoke matrix remains a release-process activity rather than an automated implementation dependency. True cancellation of an already-started VS Code provider command remains impossible through the public command API; cancellation stops local waiting and retries and is reported honestly.

## 1. Objective

Make every model provider and every delegated agent operate against the same truthful, safe, and transactionally consistent code-intelligence environment.

The existing LSP layer remains the foundation. This plan strengthens the contracts around it so an agent can tell the difference between:

- a successful query with no matches;
- an unavailable or unsupported provider;
- a language server that is still indexing;
- a provider error or timeout;
- diagnostics that are current, stale, or only partially representative;
- a reviewed edit and an unpreviewable command-side mutation.

The completed work must preserve provider neutrality: Anthropic, OpenAI, OpenRouter, Bedrock, and delegated sessions continue to receive the same `CODE_INTEL_TOOLS` definitions and use the same host-side `LspProvider` implementation.

## 2. Success criteria

The project is complete when all of the following are true:

1. No empty LSP result is silently used as proof that a provider succeeded.
2. A diagnostics result never says or visually implies “clean” unless its freshness and coverage contract permits that conclusion.
3. Resource operations and command-backed code actions cannot mutate the workspace without an explicit, intelligible approval path.
4. LSP targets and provider-produced edits cannot escape the open workspace without a separate external-edit approval policy.
5. Symbol ambiguity, stale `matchText`, duplicate multi-root paths, and stale document versions fail closed instead of selecting an arbitrary target.
6. Concurrent parent/subagent mutations are serialized across preparation, preview, and application, not only during the final `applyEdit` call.
7. Every mutating `code_*` tool returns a consistent mutation receipt and post-edit diagnostic snapshot.
8. The core LSP service, target resolver, diagnostics collector, provider executor, and edit transaction behavior have direct unit coverage and Extension Host integration coverage.
9. Existing providers and stored conversations remain compatible with additive result fields and transitional input aliases.

## 3. Non-goals

- Reimplementing language servers or the LSP protocol.
- Claiming whole-project correctness from VS Code diagnostics alone.
- Making provider commands truly cancellable when the public VS Code command API does not expose a `CancellationToken`.
- Adding speculative completion, semantic-token, or code-lens tools before the reliability work is complete.
- Replacing project-native compiler, linter, or test verification with LSP diagnostics.

## 4. Target architecture

```text
CODE_INTEL_TOOLS
        │
        ▼
AgentSession (provider-neutral dispatch and AbortSignal)
        │
        ▼
LspService (thin operation orchestration)
        ├── WorkspaceIdentity      path/root validation and display identity
        ├── TargetResolver         symbol/line resolution with confidence
        ├── ProviderExecutor       outcome, deadlines, warm-up, telemetry
        ├── DiagnosticSnapshotter  baseline, quiescence, freshness, coverage
        └── MutationCoordinator    prepare → validate → approve → apply → verify
                    │
                    ▼
            WorkspaceEditApplier
            text + resource + command mutation plan
```

`LspService` should stop accumulating low-level policy. It should translate tool payloads into calls to these components and normalize their results for the model.

### 4.1 Core contracts

#### Provider outcome

```ts
type ProviderOutcome<T> =
  | { status: "ok"; value: T; durationMs: number; attempts: number; warmedUp?: boolean }
  | { status: "timeout"; durationMs: number; attempts: number }
  | { status: "error"; message: string; durationMs: number; attempts: number }
  | { status: "cancelled"; durationMs: number; attempts: number }
  | { status: "unavailable"; reason?: string; durationMs: number; attempts: number };
```

Rules:

- Only `status: "ok"` may be interpreted as a provider response.
- An empty `value` is distinct from timeout, error, cancellation, and unavailability.
- Warm-up retries only successful-but-empty read queries.
- A single total deadline covers all attempts; the current nine-second timeout must not reset for every retry.
- Cancellation stops local waiting and further retries. Results must state that VS Code may still finish an already-started command internally.

#### Workspace identity

```ts
interface WorkspacePath {
  rootId: string;
  path: string;
  uri: vscode.Uri;
}
```

Rules:

- Relative input that matches multiple roots is ambiguous.
- Absolute input outside all roots is rejected by default.
- Model-facing locations include `rootId` whenever more than one workspace root is open.
- Every URI in a provider-produced mutation is validated, not only the original target.

#### Resolved target

```ts
interface ResolvedTarget {
  workspacePath: WorkspacePath;
  documentVersion: number;
  position: vscode.Position;
  range: vscode.Range;
  symbol?: {
    id: string;
    name: string;
    qualifiedName: string;
    kind: string;
    container?: string;
  };
  confidence: "exact-symbol" | "exact-text" | "explicit-position" | "line-anchor";
}
```

Rules:

- Missing `matchText` is an error containing the current line text.
- `line` participates in duplicate-symbol disambiguation.
- `firstMatch` is rejected for mutations.
- Candidate responses include stable IDs, qualified names, ranges, and containers.
- A mutation revalidates `documentVersion` before preview and apply.

#### Diagnostic snapshot

```ts
interface DiagnosticSnapshot {
  status: "ready" | "partial" | "unknown" | "timed_out" | "cancelled";
  scope: "file" | "published_workspace" | "activated_workspace";
  counts: SeverityCounts;
  allCounts?: SeverityCounts;
  problems: NormalizedDiagnostic[];
  freshness: {
    observedDiagnosticChange: boolean;
    waitedMs: number;
    documentVersions: Record<string, number>;
  };
  coverage: {
    requestedFiles?: number;
    activatedFiles?: number;
    diagnosticUris: number;
    capped?: boolean;
  };
  delta?: {
    introduced: NormalizedDiagnostic[];
    resolved: NormalizedDiagnostic[];
    persisting: NormalizedDiagnostic[];
  };
}
```

Rules:

- `counts` describes the requested severity filter. `allCounts` may describe the unfiltered collection.
- Workspace cache reads use `scope: "published_workspace"` and cannot be `ready` for whole-project verification.
- Post-edit collection records a baseline and waits for a quiet period, not merely the first event.
- A timeout is returned as state, not converted to a successful empty result.
- Related information, tags, diagnostic code, full range, source, and one-line snippet are preserved.

#### Mutation receipt

```ts
interface MutationReceipt {
  status: "applied" | "rejected" | "conflict" | "uncertain";
  transactionId: string;
  textEdits: number;
  resourceOperations: Array<{
    kind: "create" | "delete" | "rename";
    from?: WorkspacePath;
    to?: WorkspacePath;
  }>;
  commands: Array<{ id: string; title?: string; status: "completed" | "failed" | "timed_out" }>;
  touchedFiles: WorkspacePath[];
  saved: boolean;
  diagnostics: DiagnosticSnapshot;
}
```

## 5. Delivery strategy

The work is split into seven mergeable milestones. A milestone must meet its exit criteria before dependent work begins. Safety fixes intentionally precede capability expansion.

## Milestone 0 — Characterization and contract scaffolding

### Purpose

Create executable coverage for current behavior and introduce shared types without changing agent-visible semantics.

### Work

1. Add `src/lsp/` and extract testable helpers from `lsp-service.ts`:
   - `provider-outcome.ts`
   - `workspace-identity.ts`
   - `target-matching.ts`
   - `diagnostic-model.ts`
   - `mutation-model.ts`
2. Keep `LspProvider.dispatch()` and existing runtime names stable.
3. Add a deterministic VS Code mock for:
   - documents and versions;
   - workspace folders;
   - provider command resolution/rejection/timeout;
   - diagnostics and diagnostic-change events;
   - text and resource `WorkspaceEdit` operations.
4. Add characterization tests for every current `code_*` operation before modifying behavior.
5. Add an Extension Host test harness using `@vscode/test-electron` and a minimal TypeScript fixture workspace.
6. Add scripts:
   - `test:lsp:unit`
   - `test:lsp:integration`
   - `test:lsp`

### Primary files

- `src/lsp-service.ts`
- `src/lsp-queries.ts`
- `src/lsp-cancellation.ts`
- `src/post-edit-diagnostics.ts`
- `src/workspace-edit-applier.ts`
- `tests/unit/helpers/vscode-mock.ts`
- `package.json`
- new `tests/integration/lsp/` fixture and runner

### Exit criteria

- Existing behavior is captured, including known unsafe behavior marked with `it.fails` or explicit regression TODOs.
- `npm run compile` and `npm run test:unit` remain green.
- The Extension Host harness can prove definition, references, diagnostics, rename, format, and a code action against a TypeScript fixture.
- No production behavior changes are included in this milestone.

## Milestone 1 — Fail-closed targeting, workspace safety, and action identity

### Purpose

Remove the paths by which stale or ambiguous model input can select the wrong target or workspace.

### Work

#### Workspace identity

1. Replace `_resolveUri` and `_relPath` with `WorkspaceIdentity`.
2. Resolve relative paths across every open root.
3. Return an ambiguity result when multiple roots contain the same relative path.
4. Reject `..` escapes and absolute paths outside all roots.
5. Add `rootId` to normalized locations when the workspace has multiple roots.
6. Validate all URIs returned by navigation and all mutation URIs returned by providers.

#### Target resolver

1. Move target resolution into `TargetResolver`.
2. Make missing `matchText` an actionable error.
3. Use `line` as a distance/exact-line discriminator for duplicate symbols.
4. Return stable candidate IDs and qualified names.
5. Reject `firstMatch:true` in insert, replace, batch replace, rename, and applied code-action paths.
6. Validate 1-based line and column input rather than silently clamping out-of-range requests.
7. Rename the `code_replace` wording from “symbol body” to “symbol range,” unless a genuine body-range resolver is implemented.

#### Code-action identity

1. Listing returns an opaque `actionId`, title, kind, preferred state, disabled reason, command presence, edit presence, and document version.
2. Applying by `actionId` uses a short-lived cache and verifies document version.
3. Exact-title input remains a transitional alias; ambiguous titles/prefixes return candidates instead of selecting the first.
4. Disabled actions cannot be applied.

### Primary files

- `src/lsp-service.ts`
- new `src/lsp/workspace-identity.ts`
- new `src/lsp/target-resolver.ts`
- new `src/lsp/action-registry.ts`
- `src/tools/definitions.ts`
- `src/webview/react/lib/tool-presentation.ts`
- `src/workspace-paths.ts` if the generic workspace guard is expanded for multi-root reuse

### Exit criteria

- Duplicate-root paths, duplicate symbols, missing `matchText`, invalid lines, and outside-workspace paths all fail closed.
- A mutation cannot use `firstMatch`.
- No prefix collision can apply an arbitrary code action.
- Every regression has a unit test.

## Milestone 2 — Typed provider execution, bounded warm-up, and truthful errors

### Purpose

Separate a valid empty result from provider failure and put a hard upper bound on operation latency.

### Work

1. Replace `execProvider(): T | undefined` with `ProviderExecutor.execute(): ProviderOutcome<T>`.
2. Preserve the original provider rejection message in `status: "error"`.
3. Enforce a total deadline across warm-up attempts.
4. Retry only read-only providers and only after `status: "ok"` with an empty value.
5. Use an abortable backoff delay.
6. Stop all further retries immediately on cancellation.
7. Add operation metadata to read results:
   - `providerStatus`;
   - `durationMs`;
   - `attempts`;
   - `warmedUp`;
   - optional `notice`.
8. Do not report `formatted:false`, `ranEditorCommand:true`, or empty navigation as a definitive success after timeout/error.
9. Treat `prepareRename` timeout as unknown/failure, not permission to proceed.
10. Keep raw VS Code command execution behind one module so the Codebase Map and agent tools share the same outcome semantics.

### Compatibility

- Existing successful result fields remain.
- New status metadata is additive.
- Existing callers in the Codebase Map migrate in the same milestone; no temporary second executor should remain.

### Primary files

- `src/lsp-queries.ts`
- `src/lsp-cancellation.ts`
- `src/lsp-service.ts`
- `src/graph-provider.ts`
- `src/graph/language-support.ts`
- `src/graph/symbol-indexer.ts`
- new `src/lsp/provider-executor.ts`

### Exit criteria

- Tests distinguish empty, unavailable, error, timeout, cancellation, and warm-up success.
- An operation cannot exceed its configured total deadline by starting a fresh full deadline on every retry.
- Command failure cannot be returned as successful application.
- Provider outcome metadata reaches the model and UI.

## Milestone 3 — Diagnostics snapshots, freshness, coverage, and deltas

### Purpose

Make diagnostics useful as evidence without claiming more completeness than VS Code can provide.

### Work

#### Direct `code_diagnostics`

1. Move collection to `DiagnosticSnapshotter`.
2. File scope:
   - reject unreadable/outside-workspace paths;
   - open the document;
   - record document version and baseline diagnostics;
   - wait for diagnostic quiescence with a maximum deadline;
   - return freshness state.
3. Workspace scope:
   - label the default result `published_workspace`;
   - filter diagnostics to workspace roots;
   - report URI/file coverage rather than implying all files were analyzed;
   - optionally support an explicit bounded activation mode that opens eligible source files with capped concurrency.
4. Apply severity filtering consistently: `counts` reflects returned severity scope and `allCounts` reflects all published severities.
5. Sort deterministically by severity, root, path, line, column, source, and code.
6. Preserve related information, tags, code target, ranges, and snippets.

#### Post-edit diagnostics

1. Capture a diagnostic baseline before mutation.
2. After save, wait until matching events have been quiet for a small stability window or the deadline is reached.
3. Fingerprint diagnostics by URI, range, severity, source, code, and message.
4. Return introduced, resolved, and persisting problems.
5. Open newly created or renamed destination documents before waiting.
6. Make waiting cancellation-aware.
7. Attach the same receipt to format, rename, actions, insert, replace, batch replace, and generic file mutations.

#### UI and prompt behavior

1. Show “No problems” only for an appropriately ready file snapshot.
2. Show “0 published problems · coverage partial” for workspace cache reads.
3. Show timeout/unknown state as neutral or warning, never green success.
4. Update the system prompt to say that LSP workspace diagnostics are published coverage and that compiler/linter/test tools provide stronger whole-project verification.

### Primary files

- `src/post-edit-diagnostics.ts`
- `src/lsp-service.ts`
- new `src/lsp/diagnostic-snapshotter.ts`
- `src/chat-provider.ts`
- `src/diff-edit-service.ts`
- `src/tools/definitions.ts`
- `src/workspace-context.ts`
- `src/webview/react/lib/tool-presentation.ts`

### Exit criteria

- Empty, stale, partial, timed-out, and ready diagnostic states render differently.
- Workspace diagnostics never imply complete workspace analysis without measured coverage.
- Post-edit results identify introduced versus pre-existing diagnostics.
- `code_format` returns the same diagnostic receipt as other mutations.
- Tests cover zero-event timeout, single intermediate event, multiple events before quiescence, cancellation, severity filtering, and newly created files.

## Milestone 4 — Transactional mutations and complete approval

### Purpose

Make mutations safe under resource operations, command-backed actions, user edits, and parallel delegated agents.

### Work

#### Mutation coordinator

1. Add a global per-workspace mutation coordinator shared by parent and child sessions.
2. Queue the complete mutation lifecycle:
   - capture baseline and versions;
   - resolve target/provider edit;
   - validate paths and resource operations;
   - build preview;
   - obtain approval;
   - revalidate versions;
   - apply;
   - save;
   - collect diagnostic delta.
3. Keep read-only LSP calls concurrent.
4. If a document changes before apply, return `status: "conflict"` and re-resolve once only when the operation is deterministic and still targets the same symbol ID.

#### Workspace edit inspection

1. Inspect and count text edits, file creates, deletes, renames, and snippet edits.
2. Never apply a resource-only edit directly.
3. Present resource operations in the approval request.
4. Require elevated confirmation for delete, overwrite, recursive delete, or external-workspace operations.
5. Put preview cleanup in `finally` so rejected/failed approval cannot leak proposed documents or tabs.
6. Report save failures and leave the receipt `uncertain` when persistence cannot be confirmed.

#### Command-backed code actions

1. Treat commands as mutation-plan entries, not a side effect after text-edit approval.
2. Display command ID, title, arguments summary, and the fact that no complete diff is available.
3. Require explicit approval for command-only and edit-plus-command actions unless a reviewed safe-command allowlist applies.
4. Observe document/file change events while the command runs and include discovered touched files in the receipt.
5. If the command times out, return `uncertain`; do not claim it failed cleanly because the underlying VS Code command may still complete.
6. Collect diagnostics for both planned and observed touched files.

### Primary files

- `src/workspace-edit-applier.ts`
- `src/lsp-service.ts`
- new `src/lsp/mutation-coordinator.ts`
- new `src/lsp/workspace-edit-inspector.ts`
- `src/chat-provider.ts`
- `src/agent-session.ts`

### Exit criteria

- Resource-only edits require approval and appear in the mutation receipt.
- Command-backed actions cannot execute outside the approved plan.
- Two concurrent subagents cannot apply ranges prepared against the same stale document version.
- User edits during an approval produce a conflict instead of a misplaced edit.
- All mutations return consistent touched-file, save, command, and diagnostic information.

## Milestone 5 — Read-tool fidelity and performance

### Purpose

Improve architectural understanding after the reliability foundation is enforceable.

### Work

1. `code_symbols`:
   - always open path-scoped documents before querying;
   - use bounded warm-up;
   - return provider outcome metadata;
   - cache symbols per URI/version within one operation.
2. `code_navigate`:
   - deduplicate normalized locations;
   - sort and group by root/file;
   - use bounded concurrency for snippet loading;
   - implement or remove the documented `includeDeclaration` option.
3. `code_hierarchy`:
   - return call-site ranges;
   - add optional depth with node/edge output;
   - deduplicate nodes and detect cycles;
   - enforce node/edge budgets.
4. `code_hover`:
   - normalize markdown intentionally;
   - return range, symbol kind, provider status, and truncation metadata;
   - avoid cutting structured output without marking truncation.
5. `code_inlay_hints`:
   - preserve tooltips, label-part locations, padding, and text-edit availability;
   - do not execute hint commands automatically.
6. Add standalone signature-help and completion/member-discovery tools only after measuring whether hover/navigation leave a material capability gap.
7. Add per-operation caches keyed by URI and document version; do not cache across edits without invalidation.

### Primary files

- `src/lsp-service.ts`
- `src/lsp-queries.ts`
- `src/tools/definitions.ts`
- `src/webview/react/lib/tool-presentation.ts`
- optional new operation modules under `src/lsp/operations/`

### Exit criteria

- Read results are deterministic, deduplicated, root-qualified, and explicit about truncation/provider state.
- Hierarchy output can represent a bounded architectural graph instead of only a one-hop list.
- A 500-location navigation does not perform unbounded sequential provider/document work.
- Added capabilities have measured agent value and direct tests.

## Milestone 6 — Rollout, observability, and documentation convergence

### Purpose

Ship the behavior safely, measure it, and make the design documentation match reality.

### Work

1. Add structured, privacy-conscious LSP execution events to the existing execution logger:
   - operation;
   - provider status;
   - duration and attempts;
   - result count and truncation;
   - diagnostic readiness/coverage;
   - mutation conflict/rejection/application;
   - no source text, diagnostic message, command arguments, or absolute paths.
2. Add debug logging for action cache expiry, path rejection, version conflict, and quiescence timeout.
3. Roll out additive result fields first, then change UI wording, then enable fail-closed mutation behavior.
4. Keep exact-title code-action application for one compatibility window with a deprecation notice; remove prefix matching immediately because it is unsafe.
5. Update `lsp-code-intelligence.md` from aspirational language to the implemented contracts.
6. Update `agent-environment.md`, tool descriptions, system prompt, and changelog.
7. Run manual verification against TypeScript/JavaScript, Python, Rust, and one multi-root fixture with duplicate paths.

### Exit criteria

- Documentation, schemas, implementation, UI, and tests describe the same behavior.
- Execution telemetry can answer how frequently providers time out, warm up, return empty, conflict, or produce partial diagnostics.
- No provider-specific adapter contains LSP behavior or special cases.
- The full compile, unit, Extension Host integration, packaging, and manual smoke suites pass.

## 6. Test matrix

### Unit tests

| Area | Required cases |
|---|---|
| Provider executor | success, valid empty, rejection, timeout, cancellation, warm-up success, total deadline |
| Workspace identity | single root, duplicate relative path, outside absolute path, traversal, non-file URI, root-qualified display |
| Target resolution | exact symbol, dotted symbol, overload ambiguity, line disambiguation, missing `matchText`, invalid line/column, mutation `firstMatch` rejection |
| Action registry | duplicate title, prefix collision, disabled action, stale document version, expired handle, edit+command action |
| Diagnostic snapshot | baseline/delta, severity counts, quiescence, timeout, cancellation, related info, deterministic ordering |
| Edit inspector | text edits, create/delete/rename, resource-only edit, outside-root URI, overwrite/delete risk |
| Mutation coordinator | parallel operations, user version change, revalidation, rejection, save failure, command timeout uncertainty |
| Presentation | ready clean, partial empty, timed out, introduced errors, resource-operation summary, command warning |

### Extension Host integration tests

Use a committed fixture workspace and the built-in TypeScript language features to test:

1. document symbols after opening a previously unopened file;
2. definition, implementation, and references;
3. hover and signature help;
4. file diagnostics after introducing and fixing a type error;
5. workspace published-diagnostics coverage metadata;
6. rename across multiple files;
7. organize-imports code action;
8. formatting with and without changes;
9. document version conflict between preview and apply;
10. a synthetic provider extension returning create/rename/delete resource operations;
11. a synthetic command-backed action that edits a second file;
12. multi-root duplicate paths.

### Provider-neutral contract tests

Run the same scripted `AgentSession` tool call through each provider adapter’s tool-call accumulator and assert that:

- the tool schema is equivalent;
- the normalized payload reaches the same `LspProvider.dispatch` call;
- additive result metadata survives serialization;
- cancellation reaches the shared signal;
- delegated sessions expose the same LSP tools and result contracts.

These tests do not need live model API calls.

## 7. Pull-request sequence

Keep changes reviewable and avoid a single high-risk rewrite:

1. **PR 1 — LSP characterization harness and core types**
2. **PR 2 — Workspace identity and target resolver hardening**
3. **PR 3 — Stable code-action handles and ambiguity removal**
4. **PR 4 — Provider outcome executor and total warm-up deadline**
5. **PR 5 — Diagnostic snapshots, deltas, and truthful UI states**
6. **PR 6 — WorkspaceEdit resource-operation inspection and approval**
7. **PR 7 — Mutation coordinator, version conflicts, and command-backed actions**
8. **PR 8 — Read-tool fidelity, hierarchy graph, and performance**
9. **PR 9 — Telemetry, documentation convergence, and compatibility cleanup**

Each PR must include its tests and may not leave two competing implementations of the same policy active.

## 8. Risk register

| Risk | Mitigation |
|---|---|
| VS Code does not expose true cancellation for execute-provider commands | Stop waiting/retrying locally; surface uncertainty; never claim cancellation stopped an already-started mutation command |
| Some servers never republish an unchanged empty diagnostic set | Return freshness `unknown`/`timed_out`; do not turn absence of an event into proof of cleanliness |
| Workspace activation is expensive in monorepos | Keep published-cache mode cheap; make activation explicit, capped, language-aware, and cancellable |
| Provider `WorkspaceEdit` internals expose resource operations poorly | Build tests against the targeted VS Code version; use a single inspector and treat uninspectable operations as requiring elevated approval |
| New fail-closed behavior causes more agent retries | Return precise candidates, current source/version, and corrective next-call instructions |
| Global mutation serialization reduces parallel throughput | Serialize mutations only; keep all read/intelligence calls concurrent; correctness wins over overlapping writes |
| Code-action handles become stale | Short TTL, document-version binding, and actionable refresh errors |
| Additive result metadata increases model tokens | Keep status metadata compact; page large problem/location arrays through existing result paging |

## 9. Definition of done

The LSP hardening program is done only when:

- all milestone exit criteria pass;
- no known unsafe characterization test remains marked failing;
- all mutating code-intelligence paths use the mutation coordinator;
- all provider calls use typed outcomes;
- diagnostics use the snapshot contract;
- workspace/path identity is root-aware and enforced;
- the design spec and tool descriptions no longer claim unsupported guarantees;
- `npm run compile`, `npm run typecheck:webview`, `npm run test:unit`, LSP Extension Host integration tests, build, and package checks are green;
- manual multi-provider and multi-root smoke testing is recorded in the release checklist.

## 10. Recommended first implementation slice

Start with PR 1 and PR 2 together only if review capacity permits. The first production behavior change should be the fail-closed targeting/path slice because it is bounded, immediately reduces incorrect edits, and creates the abstractions needed by diagnostics and transactional mutation work.

Do not begin hierarchy/completion expansion until Milestones 1–4 are complete. More LSP surface area without trustworthy outcomes and mutation boundaries would increase apparent capability faster than actual reliability.
