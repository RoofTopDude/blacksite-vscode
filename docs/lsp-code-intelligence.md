# LSP Code-Intelligence Layer — Design Spec

Status: proposed · Owner: Blacksite VS Code extension · Target: phase 1 core, phase 2 advanced

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
lsp-service.ts (new)   class LspService implements LspProvider
                       - position resolution (symbol | line | matchText)
                       - executeCommand("vscode.execute*Provider", ...)
                       - output normalization + budgeting
                       - mutating ops route through WorkspaceEditApplier (preview+approve)
        │
        ▼
chat-provider.ts       construct LspService(workspaceRoot); pass lspProvider
webview/react/lib/format.ts   TOOL_GROUPS "Code Intelligence", labels, previews, result cards
```

### Provider interface (keeps `vscode` types out of AgentSession)

```ts
export interface LspContext { autoApprove: boolean; signal?: AbortSignal; }

export interface LspProvider {
  dispatch(op: string, payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult>;
}

export type LspResult =
  | { ok: true; [k: string]: unknown; autoApproveAll?: boolean }
  | { ok: false; error: string; ambiguous?: boolean; candidates?: SymbolRef[] };
```

`op` is the runtime type minus the `lsp.` prefix (e.g. `navigate`, `symbols`,
`rename`). The dispatch branch in `agent-session.ts` mirrors the `editor.apply_edit`
branch: it forwards `this._autoApprove`, honors `autoApproveAll` on the way back,
and strips that field before returning the result to the model.

### Shared workspace-edit applier

`rename`, `actions` (apply), and `format` all produce a `vscode.WorkspaceEdit`
spanning ≥1 files. Factor a `WorkspaceEditApplier` (extract from / share with
`DiffEditService`) that:
1. summarizes the edit (files touched, total edits),
2. for a single file → opens the native `vscode.diff` preview,
3. for multiple files → shows a summary modal listing files + edit counts, with
   an "Open diff" affordance per file,
4. prompts **Apply / Apply All / Reject** (reusing the session auto-approve flag),
5. on approve calls `vscode.workspace.applyEdit(edit)` then saves touched docs,
6. returns `{ applied, files, edits, autoApproveAll }`.

This unifies the approval UX across `file_edit` and every mutating LSP op.

## 3. Position targeting — the core UX problem

LSP providers take `(uri, Position)`. An LLM doesn't reliably know character
offsets, so every tool accepts a flexible **target** and resolves it
server-side. Resolution is the heart of "as capable as possible."

```ts
interface Target {
  path: string;            // absolute or workspace-relative
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
   - >1 match → `{ ok:false, ambiguous:true, candidates:[{name,kind,line,container}] }`
     so the model re-calls with `kind`/`container`/`line`. (Read-only navigations
     may instead auto-pick when the model passes `firstMatch:true`.)
2. **line + matchText**: column = indexOf(matchText) on that line.
3. **line + column**: used directly.
4. **line only**: first non-whitespace character on the line.

A single `_resolveTarget(target): { uri, position, symbol? } | Ambiguous`
helper backs every tool. This makes the natural agent phrasing — "find
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

Eight tools. Navigation providers with identical I/O are consolidated under a
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
  includeDeclaration?: boolean, includeBody?: boolean, limit?: number, context?: number, firstMatch?: boolean }
```
Maps to `vscode.execute{Definition|TypeDefinition|Declaration|Implementation|Reference}Provider`.
Returns `{ ok, kind, target:<resolved>, locations: CodeLocation[], truncated? }`.
Handles both `Location` and `LocationLink` results.

### 5.3 `code_hierarchy` — call & type graphs (read)
```
{ target: Target, kind: "callers"|"callees"|"supertypes"|"subtypes", limit?: number }
```
- callers/callees → `vscode.prepareCallHierarchy` then `provideIncomingCalls` /
  `provideOutgoingCalls`.
- supertypes/subtypes → `vscode.prepareTypeHierarchy` then `provideSupertypes` /
  `provideSubtypes`.
Returns hierarchy items as `CodeLocation`s plus, for calls, the call-site ranges.
Invaluable for "what calls this?" before changing a signature.

### 5.4 `code_hover` — types, signatures, docs (read)
```
{ target: Target }
```
`vscode.executeHoverProvider`. Returns `{ ok, text, symbol?, kind?, range }`.
The agent's "what is this and what's its type" without re-reading the file.
Optionally enrich with `vscode.executeSignatureHelpProvider` when the target is
inside a call expression.

### 5.5 `code_diagnostics` — the verification loop (read)
```
{ path?: string, severity?: "error"|"warning"|"info"|"hint", limit?: number }
```
Reads **live language-server diagnostics** via `vscode.languages.getDiagnostics`
(single file or whole workspace), normalized with snippets + related info +
source. This closes the **edit → diagnose → fix** loop the agent currently
lacks. Distinct from `report_problems` (which *writes* the agent's own findings).

### 5.6 `code_rename` — safe repo-wide rename (mutating)
```
{ target: Target, newName: string }
```
`vscode.prepareRename` (validate position) → `vscode.executeDocumentRenameProvider`
→ a `WorkspaceEdit`. Routed through `WorkspaceEditApplier` for preview + approval.
Returns `{ ok, files, edits, newName }`. Symbol-aware, language-correct — strictly
better than a find/replace.

### 5.7 `code_actions` — use the language's quick-fixes & refactors (mutating)
```
{ path: string, line: number, endLine?: number, only?: string, apply?: string }
```
- List: `vscode.executeCodeActionProvider(uri, range, only?)` → titled actions
  (quickfix, refactor, source.organizeImports, source.fixAll, …).
- Apply: when `apply` (a title or title prefix) is given, take that action's
  `.edit` (apply via `WorkspaceEditApplier`) and/or execute its `.command`.
Returns the available actions, or the applied result.
> Limitation: actions returned by the command may be **unresolved** (lazy
> `.edit`). VS Code exposes no public `resolveCodeAction`. Strategy: prefer
> actions that ship an eager `.edit`; for command-only actions, execute the
> `.command`; surface a clear note when an action can't be resolved headlessly.

### 5.8 `code_format` — format on demand (mutating)
```
{ path: string, range?: {startLine,endLine} }
```
`vscode.executeFormatDocumentProvider` / `executeFormatRangeProvider` → `TextEdit[]`,
applied via `WorkspaceEditApplier`. Lets the agent format after editing instead
of hand-aligning whitespace.

### Phase-2 / optional tools
- `code_completions` — `executeCompletionItemProvider` ("what members does this
  object expose"). Useful but largely covered by hover + symbols.
- `code_inlay_hints` — `executeInlayHintProvider` (inferred types for a range) —
  great for understanding untyped code.
- `code_signature` — standalone signature help.

## 6. Mutating edits: preview & approval

All of `code_rename`, `code_actions(apply)`, `code_format` mutate the tree and so
**must** pass through `WorkspaceEditApplier` (§2). Read tools never prompt.

Two capability multipliers built into the edit results:
1. **Auto-attached post-edit diagnostics.** After any mutating op (and after the
   existing `file_edit`), include fresh `code_diagnostics` for the touched files
   in the tool result. The agent instantly sees whether the change introduced an
   error — tightening the self-correction loop without an extra round-trip.
2. **Auto-approve continuity.** Reuse the session `_autoApprove` flag so a
   refactor that renames + organizes imports + formats doesn't prompt at every
   step once the user clicks "Apply All."

## 7. Cross-cutting concerns

- **Language-server warm-up.** `execute*Provider` commands can return `[]` while
  the server is still indexing a freshly opened file. Wrap navigation/reference
  calls in `_withWarmup(fn)`: open the document, then if the first result is
  empty, poll up to ~5×400ms before concluding "no results." Workspace-symbol
  queries similarly improve as the index builds — note this in the tool result
  (`indexing:true`) rather than asserting emptiness.
- **Document loading.** Always `openTextDocument(uri)` (no need to reveal) so the
  owning language extension activates and providers run. Operate on in-memory
  content for dirty/unsaved buffers.
- **Multi-root.** Resolve relative paths against all `workspace.workspaceFolders`;
  emit paths relative to the nearest root.
- **Cancellation & timeouts.** Race each command against the session `signal` and
  a per-op timeout (~8s nav, ~15s workspace symbols); on timeout return a soft
  error the model can retry, never hang the turn.
- **Errors.** No provider for a language → `{ ok:false, error:"No <feature>
  provider for <lang>. Is the language extension installed?" }`. Always actionable.
- **Path safety.** Resolve and confirm targets stay within workspace roots
  (consistent with the runtime's path policy); reject escapes.

## 8. Settings & toggles

- Each `code_*` tool appears in the existing tool-toggle list under a new
  **Code Intelligence** group (webview `TOOL_GROUPS`), individually disableable
  via the existing `disabledTools` mechanism.
- Optional `blacksite.codeIntel.enabled` config (default true) to gate the whole
  group, and `blacksite.codeIntel.maxResults` for the default budget.
- Tools are only offered to the model when `lspProvider` is present (gated in
  `_getTools()`), exactly like `file_edit`/browser tools.

## 9. Webview surfacing

- `TOOL_GROUPS`: add `{ label:'Code Intelligence', tools:[…] }`.
- `TOOL_LABELS`: `code_navigate:'Navigate'`, `code_symbols:'Symbols'`,
  `code_hover:'Hover'`, `code_rename:'Rename Symbol'`, `code_actions:'Code Action'`,
  `code_diagnostics:'Diagnostics'`, `code_hierarchy:'Hierarchy'`, `code_format:'Format'`.
- `toolInputPreview`: show `target.symbol || path:line` + `kind`.
- `toolResultPresentation`: e.g. references → `N references · M files`; rename →
  `renamed → newName · N files`; diagnostics → `E errors, W warnings`.
- Locations in results are already clickable in chat via the `file:line` markdown
  convention.

## 10. Phasing

**Phase 1 (MVP, highest value):** `code_symbols`, `code_navigate`,
`code_hover`, `code_diagnostics`. Pure read; no approval plumbing. Delivers
go-to-def / find-refs / types / verify-loop — ~80% of the value.

**Phase 2 (mutating):** `WorkspaceEditApplier`, `code_rename`, `code_actions`,
`code_format`, plus auto-attached post-edit diagnostics.

**Phase 3 (advanced):** `code_hierarchy`, `code_completions`, `code_inlay_hints`,
multi-file per-hunk diff review.

## 11. Testing & verification

- Unit: position resolution (symbol/line/matchText, ambiguity, dotted members);
  output normalization (Location vs LocationLink, Hover markdown flattening);
  budgeting/truncation.
- Integration in an Extension Host against a TS fixture workspace: definition,
  references, rename (assert WorkspaceEdit spans expected files), code action
  "organize imports", format, diagnostics after an injected type error.
- Warm-up: open a fresh file and assert the retry path eventually returns results.
- Manual: drive each tool from chat against this monorepo; confirm clickable
  locations and the edit→diagnose→fix loop on a deliberately broken edit.

## 12. Open decisions

1. **Ambiguity policy for read navigations** — auto-pick first match (with a note)
   vs. always return candidates. Proposed: return candidates, but honor
   `firstMatch:true` for one-hop ergonomics.
2. **Consolidation vs. discreteness** — `code_navigate(kind)` groups 5 providers;
   acceptable, or split `code_definition`/`code_references` for clarity? Proposed:
   keep consolidated; the `kind` enum is self-documenting.
3. **Unresolved code actions** — accept the headless-resolve limitation, or add a
   fallback that opens the action in the editor for the user? Proposed: accept +
   clear messaging in phase 2; revisit.
4. **Auto-attached diagnostics scope** — only changed files (proposed) vs. whole
   workspace, which is noisier but catches ripple effects.
```
