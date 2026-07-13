# LSP Code-Intelligence Layer — Design Spec

Status: shipped with reliability, safety, and orchestration hardening · Owner: Blacksite VS Code extension

Reliability, safety, and orchestration hardening is tracked in
[`lsp-reliability-implementation-plan.md`](./lsp-reliability-implementation-plan.md).

## 1. Goal & thesis

Give the agent the same code understanding a human gets from the IDE: jump to
definitions, find all references, see types and signatures, rename symbols
safely, run the language's own quick-fixes, and read live language-server
diagnostics as a feedback loop. This is the single capability a terminal CLI
agent cannot replicate, and the extension is already sitting on top of the full
VS Code language-feature surface — we just need to expose it as tools.

Today the agent navigates code with `file_search` (regex) and `file_glob`. It
greps, guesses, and re-reads. With LSP tools it reasons about code structurally:
*find references before refactoring*, *go-to-definition instead of grep*,
*type-aware edits*, *repo-wide rename*, and *edit → diagnose → fix* loops.

### Non-goals
- Inline ghost-text completions (Copilot-style) — different product surface.
- Reimplementing language servers. We only consume what VS Code exposes.
- Guaranteeing every language behaves identically — capability degrades
  gracefully to whatever providers the user's installed extensions supply.

## 2. Architecture & wiring

Reuses the exact provider pattern already used by `editProvider` /
`diagnosticsProvider` / `memoryProvider`.

```
tools/definitions.ts   CODE_INTEL_TOOLS  (schemas, runtimeType "lsp.*")
        │
        ▼
agent-session.ts       AgentSessionOptions.lspProvider?: LspProvider
                       _getTools(): gate CODE_INTEL_TOOLS on lspProvider
                       dispatch: runtimeType.startsWith("lsp.") → lspProvider.dispatch(op, payload, ctx)
        │
        ▼
lsp-service.ts         thin operation orchestration + output normalization
        ├── WorkspaceIdentity       root/path/URI safety
        ├── TargetResolver          exact target + document version
        ├── ProviderExecutor        typed outcomes + total deadline
        ├── DiagnosticSnapshotter   freshness + coverage + delta
        ├── ActionRegistry          stable version-bound handles
        └── MutationCoordinator     prepare → approve → apply → verify queue
                       │
                       ▼
WorkspaceEditApplier  text/resource inspection, preview, approval, revalidation, save
        │
        ▼
chat-provider.ts       construct LspService(workspaceRoot); pass lspProvider
webview/react/lib/format.ts   TOOL_GROUPS "Code Intelligence", labels, previews, result cards
```

### Provider interface (keeps `vscode` types out of AgentSession)

```ts
export interface LspContext {
  autoApprove: boolean;
  signal?: AbortSignal;
  transactionId?: string;
}

export interface LspProvider {
  dispatch(op: string, payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult>;
}

export type LspResult =
  | { ok: true; notice?: string; [k: string]: unknown; autoApproveAll?: boolean }
  | { ok: false; error: string; ambiguous?: boolean; candidates?: SymbolRef[] };
```

`op` is the runtime type minus the `lsp.` prefix (e.g. `navigate`, `symbols`,
`rename`). The dispatch branch in `agent-session.ts` mirrors the `editor.apply_edit`
branch: it forwards `this._autoApprove`, honors `autoApproveAll` on the way back,
and strips that field before returning the result to the model.

### Shared workspace-edit applier

`rename`, `actions` (apply), `format`, `insert`, `replace`, batch replace, and
generic file edits share `WorkspaceEditApplier`. It:
1. summarizes the edit (files touched, total edits),
2. opens bounded native `vscode.diff` previews for text resources,
3. inspects create/delete/rename and snippet operations where VS Code exposes them,
4. requires explicit approval for resource-only, destructive, overwrite-capable,
   and otherwise opaque resource operations,
5. validates every URI and rechecks document versions before preview and apply,
6. applies, saves, and reports persistence failures as uncertain,
7. returns structured counts, operation details, touched URIs, and approval state.

This unifies the approval UX across `file_edit` and every mutating LSP op.

## 3. Position targeting — the core UX problem

LSP providers take `(uri, Position)`. An LLM doesn't reliably know character
offsets, so every tool accepts a flexible **target** and resolves it
server-side. Resolution is the heart of "as capable as possible."

```ts
interface Target {
  path: string;            // absolute or workspace-relative
  rootId?: string;         // required when a relative path exists in multiple roots
  symbol?: string;         // e.g. "fetchModels" or "ChatProvider.send"
  kind?: string;           // optional disambiguation: "function" | "method" | "class" | ...
  line?: number;           // 1-based fallback
  column?: number;         // 1-based, optional
  matchText?: string;      // substring on `line` to locate the column robustly
}
```

Resolution order:
1. **symbol** (preferred): load document symbols for `path`, flatten the tree,
   match by name (supporting `Container.member` dotted form and optional `kind`).
   Use the symbol's `selectionRange.start`.
   - 0 matches → `{ ok:false, error:"symbol not found", candidates:<nearest names> }`.
   - >1 match → `{ ok:false, ambiguous:true, candidates:[{id,qualifiedName,kind,
     path,rootId,line,endLine,container}] }` so the model re-calls with an exact
     discriminator. Read-only navigations may opt into `firstMatch:true`; every
     mutating operation rejects it.
2. **line + matchText**: column = indexOf(matchText) on that line. A missing
   anchor fails with the current line text rather than silently moving the target.
3. **line + column**: used directly.
4. **line only**: first non-whitespace character on the line.

A single `TargetResolver` returns the URI, position, range, stable symbol
identity, confidence, and current document version. This makes the natural agent phrasing — "find
references to `fetchModels` in model-fetcher.ts" — work without the model ever
computing a column.

## 4. Output model & budgeting

Normalize every VS Code shape to compact, agent-friendly JSON with **relative
paths, 1-based line/column, and a source snippet** so the agent rarely needs a
follow-up `file_read`.

```ts
interface CodeLocation {
  path: string;            // workspace-relative
  line: number; column: number;
  endLine?: number; endColumn?: number;
  snippet: string;         // the source line (trimmed), or N-line window
  symbol?: string; kind?: string; container?: string;
}
```

Budgeting (results can be enormous — references to a popular symbol):
- Default cap **100** locations, configurable per call via `limit` (max 500).
- Group by file; include `{ truncated: true, totalFound }` when capped.
- Snippets default to the single matching line; `context` (0–3) widens the window.
- For definitions, `includeBody:true` returns the full symbol range (capped at
  ~200 lines) so the agent reads the implementation in one hop.

Hover/markdown is flattened to plain text (strip code-fence noise, keep the
signature + first paragraph of docs).

## 5. Tool catalog

Twelve tools. Navigation providers with identical I/O are consolidated under a
`kind` discriminator to avoid tool-list noise; distinct output shapes get their
own tool.

### 5.1 `code_symbols` — map the code (read)
Document symbol tree, or workspace-wide symbol search.
```
{ path?: string, query?: string, limit?: number }
```
- `path` set → `vscode.executeDocumentSymbolProvider` → nested tree
  (name, kind, line range, children).
- `query` set → `vscode.executeWorkspaceSymbolProvider` → flat matches across repo.
- Returns `{ ok, symbols: [...], truncated? }`. The agent's "table of contents."

### 5.2 `code_navigate` — jump around (read)
```
{ target: Target, kind: "definition"|"typeDefinition"|"declaration"|"implementation"|"references",
  includeBody?: boolean, limit?: number, context?: number }
```
Maps to `vscode.execute{Definition|TypeDefinition|Declaration|Implementation|Reference}Provider`.
Returns `{ ok, kind, target:<resolved>, locations: CodeLocation[], truncated? }`.
Handles both `Location` and `LocationLink` results.

### 5.3 `code_hierarchy` — call & type graphs (read)
```
{ target: Target, kind: "callers"|"callees"|"supertypes"|"subtypes",
  depth?: 1|2|3|4, limit?: number }
```
- callers/callees → `vscode.prepareCallHierarchy` then `provideIncomingCalls` /
  `provideOutgoingCalls`.
- supertypes/subtypes → `vscode.prepareTypeHierarchy` then `provideSupertypes` /
  `provideSubtypes`.
Returns the compatible one-hop list plus a bounded `graph` containing stable
node IDs, ranges, traversal depth, directed edges, call-site ranges, failures,
budgets, and truncation state. Nodes are deduplicated and cycles do not recurse.

### 5.4 `code_hover` — types, signatures, docs (read)
```
{ target: Target }
```
`vscode.executeHoverProvider`, run in parallel with `vscode.executeSignatureHelpProvider`
(not warmup-wrapped — an empty signature-help result is a normal outcome, not a
cold-server symptom). Returns `{ ok, text, symbol?, kind?, range }`, where `text`
is the hover content with the active parameter of any in-scope call signature
bolded ahead of it. The agent's "what is this and what's its type" without
re-reading the file.

### 5.5 `code_diagnostics` — the verification loop (read)
```
{ path?: string, rootId?: string,
  severity?: "error"|"warning"|"info"|"hint", limit?: number,
  activateWorkspace?: boolean, activationLimit?: number }
```
Reads diagnostics published through `vscode.languages.getDiagnostics`. Results
are `DiagnosticSnapshot`s: `status`, `scope`, filtered `counts`, `allCounts`,
problems, freshness, document versions, and measured coverage. A default
workspace read is always `published_workspace`/`partial`; explicit bounded
activation opens eligible source files but still does not replace compiler,
linter, or test verification. Post-edit snapshots additionally contain
introduced, resolved, and persisting diagnostics after a quiescence window.

### 5.6 `code_rename` — safe repo-wide rename (mutating)
```
{ target: Target, newName: string }
```
`vscode.prepareRename` validates the position first — its rejection carries a
specific, actionable reason (e.g. "You cannot rename this element"), surfaced
as-is rather than swallowed to a generic error — then `vscode.executeDocumentRenameProvider`
produces a `WorkspaceEdit`. Routed through `WorkspaceEditApplier` for preview + approval.
Returns `{ ok, files, edits, newName }`. Symbol-aware, language-correct — strictly
better than a find/replace.

### 5.7 `code_actions` — use the language's quick-fixes & refactors (mutating)
```
{ path: string, line: number, endLine?: number, only?: string, apply?: string }
```
- List: `vscode.executeCodeActionProvider(uri, range, only?)` → actions with an
  opaque `actionId`, title, kind, preferred/disabled state, edit/command flags,
  and source document version.
- Apply: pass the short-lived `actionId` (preferred), or an exact unique title
  during the compatibility window. Prefixes are rejected rather than guessed.
  Handles are URI/version-bound and disabled actions cannot run.
Returns the available actions, or the applied result.
Text edits use the shared preview transaction. Command-only and edit-plus-command
actions disclose that their complete diff is unavailable, require explicit
approval, preserve command failure/timeout state, and observe document/create/
rename/delete events to expand touched-file diagnostics and receipts.

### 5.8 `code_format` — format on demand (mutating)
```
{ path: string, range?: {startLine,endLine} }
```
`vscode.executeFormatDocumentProvider` / `executeFormatRangeProvider` → `TextEdit[]`,
applied via `WorkspaceEditApplier`. Lets the agent format after editing instead
of hand-aligning whitespace.

### 5.9 `code_insert` — targeted insertion (mutating)

```
{ target: Target, position: "before"|"after"|"start"|"end", text: string }
```

Inserts `text` relative to a resolved symbol or line, then routes through
`WorkspaceEditApplier` for preview + approval. Not an LSP wrapper — it reuses
the shared target-resolution machinery (§3) so the agent can add imports,
methods, or branches without a brittle full-file text match.

### 5.10 `code_replace` — exact target-range replacement (mutating)

```
{ target: Target, text: string, endLine?: number }
```

Replaces the resolved symbol range, or an explicit validated line range. It does
not claim language-specific body-only semantics. The document version is bound
to preview/application and stale edits return a conflict.

### 5.11 `code_replace_batch` — coordinated target-range replacement (mutating)

```
{ edits: [{ target: Target, text: string, endLine?: number }] }
```

Resolves all targets before mutation, rejects overlap, binds every document
version, previews one atomic WorkspaceEdit, and returns per-target locations plus
one transaction/diagnostic receipt.

### 5.12 `code_inlay_hints` — inferred types & parameter names (read)

```
{ path: string, range?: {startLine,endLine}, limit?: number }
```

`vscode.executeInlayHintProvider(uri, range)` — unlike `code_format`, this
command has no whole-document overload, so a full-document range is
synthesized when `range` is omitted. Returns `{ ok, hints: [{line,column,label,kind}] }`.
Most valuable for untyped or dynamically-typed code (Python, JS) where
inferred types aren't visible in the source text.

### Still open

- `code_completions` — `executeCompletionItemProvider` ("what members does this
  object expose"). Useful but largely covered by hover + symbols.
- `code_signature` — a standalone signature-help tool, if signature help ever
  needs to be queried independently of hover.

## 6. Mutating edits: preview & approval

All mutating `code_*` operations run through one per-workspace
`MutationCoordinator`, which serializes target/version preparation, diagnostic
baseline, provider edit resolution, path validation, preview, approval,
revalidation, apply/save, and diagnostic collection. Read tools remain concurrent.

Two capability multipliers built into the edit results:
1. **Auto-attached post-edit diagnostics.** After any mutating op (and after the
   existing `file_edit`), include fresh `code_diagnostics` for the touched files
   in the tool result. The agent instantly sees whether the change introduced an
   error — tightening the self-correction loop without an extra round-trip.
2. **Auto-approve continuity.** Reuse the session `_autoApprove` flag so a
   refactor that renames + organizes imports + formats doesn't prompt at every
   step once the user clicks "Apply All." Resource operations and unpreviewable
   commands still require explicit review.

Every mutation result, including rejection/conflict/uncertainty, carries a
transaction receipt with text-edit count, exact or opaque resource operations,
command outcomes, touched files, save state, and a diagnostic snapshot.

## 7. Cross-cutting concerns

- **Provider outcomes and warm-up.** All provider commands use `ProviderExecutor`
  and return `ok`, `timeout`, `error`, `cancelled`, or `unavailable`. Only a
  successful empty read may warm up. One total nine-second deadline covers all
  attempts and abortable backoff, so retries cannot multiply the latency budget.
  Read results expose compact status, duration, attempt, and warm-up metadata.
- **Document loading.** Always `openTextDocument(uri)` (no need to reveal) so the
  owning language extension activates and providers run. Operate on in-memory
  content for dirty/unsaved buffers.
- **Multi-root.** `WorkspaceIdentity` searches every root. Duplicate relative
  paths return candidates and require `rootId`; model-facing paths are root-qualified.
- **Cancellation & timeouts.** Cancellation stops local waiting, backoff, and
  retries immediately. VS Code's public execute-provider commands do not accept
  a cancellation token, so an already-started command may finish internally;
  command-backed mutation timeouts are therefore reported as uncertain.
- **Errors.** An empty result whose language has a known, uninstalled recommended
  extension gets an actionable explanation (`lsp-provider-hint.ts`'s
  `noProviderNotice`, backed by `graph/language-support.ts`'s `missingExtensionFor`
  — a cheap, synchronous check, not the Map's expensive empirical probe). Ops that
  already treated empty as failure (`code_hover`, `code_rename`) get the hint in
  place of their generic message; ops where empty is often a legitimate correct
  answer (`code_navigate`, `code_hierarchy`, `code_symbols`, `code_actions`,
  `code_format`) stay `ok:true` and gain an optional `notice` field alongside the
  empty result, rather than being reinterpreted as a failure.
- **Path safety.** Inputs and every provider-produced text/resource URI must stay
  within an open workspace root. Traversal, non-file URIs, and external absolute
  paths fail closed.
- **Operation caches and bounds.** Symbol bodies share a URI/version cache within
  a navigation operation; location loading uses bounded concurrency; hierarchy
  traversal has total time, depth, node, and edge budgets.
- **Telemetry.** Structured logs retain provider state, duration/attempts,
  result/truncation counts, diagnostic readiness/coverage, and mutation outcome,
  but omit source text, diagnostic messages, command arguments, and paths.

## 8. Settings & toggles

- Each `code_*` tool appears in the existing tool-toggle list under a new
  **Code Intelligence** group (webview `TOOL_GROUPS`), individually disableable
  via the existing `disabledTools` mechanism.
- Not built: `blacksite.codeIntel.enabled`/`maxResults` config. Tools are always
  offered to the model when `lspProvider` is present (gated in `_getTools()`),
  exactly like `file_edit`/browser tools; individual `code_*` tools remain
  disableable via the existing `disabledTools` toggle list, which was judged
  sufficient — no separate group-level switch has been needed.

## 9. Webview surfacing

- `TOOL_GROUPS` (`format.ts`): `"Code Intel"` includes all ten tools, `code_inlay_hints` included.
- `TOOL_LABELS`: `code_navigate:'Navigate'`, `code_symbols:'Symbols'`,
  `code_hover:'Hover'`, `code_rename:'Rename Symbol'`, `code_actions:'Code Action'`,
  `code_diagnostics:'Diagnostics'`, `code_hierarchy:'Hierarchy'`, `code_format:'Format'`,
  `code_inlay_hints:'Inlay Hints'`.
- `toolInputPreview` / `toolIntentPhrase` (`tool-presentation.ts`): show
  `target.symbol || path:line` + `kind`; `code_inlay_hints` shows `path` + range.
- `toolResultPresentation`: e.g. references → `N references · M files`; rename →
  `renamed → newName · N files`; diagnostics → `E errors, W warnings`. When a
  result carries a `notice` (§7) and its primary array is empty, the notice text
  replaces the usual empty-state preview instead of a bare "No results".
- `tool-icons.ts`: `code_inlay_hints` grouped into the `"code"` bucket with the rest.
- Locations in results are already clickable in chat via the `file:line` markdown
  convention.

## 10. Phasing

**Phase 1 (MVP, highest value) — shipped:** `code_symbols`, `code_navigate`,
`code_hover`, `code_diagnostics`. Pure read; no approval plumbing. Delivers
go-to-def / find-refs / types / verify-loop.

**Phase 2 (mutating) — shipped:** `WorkspaceEditApplier`, `code_rename`
(now with a `prepareRename` preflight), `code_actions`, `code_format`,
`code_insert`, plus auto-attached post-edit diagnostics.

**Phase 3 (advanced) — shipped for the measured scope:** `code_hierarchy` now
supports bounded graph depth, `code_inlay_hints` preserves tooltip/padding/edit
metadata, and hover is enriched with signature help. Completion/member discovery
and standalone signature tools remain intentionally deferred until usage shows a
gap that hover, symbols, and navigation do not cover.

## 11. Testing & verification

- `npm run test:lsp:unit`: provider outcomes/deadlines, multi-root identity,
  target ambiguity/versioning, action handles, diagnostic quiescence/deltas,
  resource inspection/approval, mutation serialization, hierarchy cycles,
  navigation caches, command touch observation, UI state, and private telemetry.
- `npm run test:lsp:integration`: production build plus a clean VS Code
  Extension Host/TypeScript fixture covering document symbols, definition,
  implementation, references, hover, signature help, diagnostic introduction
  and resolution, organize imports, changed/unchanged formatting, and cross-file rename.
- `npm run test:lsp` runs both suites. The runner isolates the fixture and profile
  in temporary paths and sanitizes `ELECTRON_RUN_AS_NODE` for VS Code terminals.

## 12. Resolved decisions and deliberate limits

1. Read ambiguity returns candidates unless `firstMatch:true`; mutations always
   require exact disambiguation.
2. `code_navigate(kind)` remains consolidated because the request/result contract
   is identical across its five providers.
3. Code-action listing requests resolved items through VS Code's supported
   `itemResolveCount`; unresolved command portions remain explicit, approved,
   and observed rather than represented as previewable text edits.
4. Post-edit diagnostics follow planned and observed touched files. Whole-workspace
   published diagnostics remain a separate partial-coverage read.
5. WorkspaceEdit resource-operation inspection uses VS Code's Extension Host
   representation defensively. Unknown future shapes remain opaque, destructive,
   and approval-required rather than being guessed.
```
