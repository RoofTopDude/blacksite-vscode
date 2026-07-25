# Blacksite VS Code Extension — Responsiveness & File-Size Review

**Status:** Living document — first pass 2026-07-22. Re-run the relevant section's methodology after major
refactors instead of hand-editing stale numbers away; update the "Last verified" line per section.
**Owner:** update as remediation work lands. Check items off inline rather than deleting history — the point
of this doc is to track what changed, not just what's currently true.

## Why this doc exists

Two goals, requested together because they compound:

1. **Responsiveness & friction review** — find anything hurting perceived (visual/UI smoothness) or actual
   (wall-clock/CPU/memory) responsiveness, and anywhere a *small* change could let the extension comfortably
   support more users / bigger workspaces / lower-spec machines. This is explicitly **not** a mandate to cut
   anything already built — every finding below is framed as an opportunity, not a verdict. Several were
   investigated and turned out to already be well-handled; those are recorded too, so future passes don't
   re-litigate them.
2. **File-size / maintainability catalog** — the 50 largest source files, a split-difficulty rating for each,
   and a deep remediation writeup for the 5 most congested.

A third section was folded in mid-review at the user's request: the **code-change review experience**
(how proposed diffs are surfaced and approved) — both a UX/consistency pass and an "educational" angle
(surfacing the agent's reasoning behind a change, and letting the user ask about a diff directly).

### At a glance

- **219 source files, ~64,600 lines.** The top 50 files (§3.1) account for ~72% of that — size is
  concentrated, not evenly spread.
- **5 files rated Very High or High congestion** and got a full remediation write-up (§3.2):
  `agent-session.ts`, `chat-provider.ts`, and `scene/renderer.ts` (Very High), plus `graph-indexer.ts` and
  `relationship-indexer.ts` (High). Two notable **non**-findings: `theme.css` and `GraphApp.tsx` — the
  #4 and #3 largest files in the extension — both rated Medium or better; they're long because they cover
  a lot of surface area, not because they're tangled. That distinction drove the whole selection.
- **The single most-repeated pattern in the review** isn't in any one file: per-turn context re-gathering
  (workspace snapshot, active plans, base-context topics) is synchronously re-read and re-parsed from disk
  on every tool-call round-trip, not once per message — flagged independently by two different subsystem
  reviews (§1.3, §1.4) before being connected here. See the top of [§1.8](#18-prioritized-small-change-big-leverage-roll-up).
- **The Codebase Map's Services-relationship rebuild** (§1.5) is the single highest-severity individual
  finding: it has no incremental mode and can re-scan the entire workspace corpus synchronously on nearly
  every save.
- **Nothing here found the extension broken.** Every subsystem had at least one "already well-engineered,
  don't touch" callout (§1.2, and per-subsystem positive notes throughout) — this codebase has clearly been
  through real hardening passes already. The findings below are additive opportunities on top of that
  baseline, consistent with the brief: nothing recommends cutting a feature, a provider, a language, or a
  visual to get there.

## How this review was done

- Mechanical inventory (`find` + `wc -l` over `src/**/*.{ts,tsx,js,jsx,css}`, excluding `node_modules`/`out`)
  for the file-size catalog — deterministic, not a judgment call.
- Five parallel subsystem reviews (agent core & tools, host services & providers, graph indexing engine,
  Map webview rendering, chat/planning/settings webview UI), each reading every file in its bucket in full
  and reporting structural maps, split-difficulty ratings, and subsystem-scoped responsiveness findings
  with file:line citations.
- Direct inspection (by the lead reviewer, not delegated) of: `extension.ts` activation flow, `esbuild.mjs` /
  `vite.webview.config.mjs` build config, actual built bundle sizes under `out/webview/`, `theme.css`
  structure, the webview HTML shell/CSP/font-loading path, and the full diff-approval pipeline
  (`diff-edit-service.ts`, `workspace-edit-applier.ts`, the `ToolLog.tsx` approval card, tool schemas).
- Every finding below is expected to cite a concrete `file:line`. Anything that reads as a general concern
  without one should be treated as unverified and re-checked before acting on it.

---

## Table of contents

1. [Responsiveness & friction review](#1-responsiveness--friction-review)
   - [1.1 Cross-cutting findings](#11-cross-cutting-findings-webview-lifecycle-bundles-build)
   - [1.2 What's already well-engineered (don't touch)](#12-whats-already-well-engineered--leave-alone)
   - [1.3 Subsystem: Agent core & tool-execution loop](#13-subsystem-agent-core--tool-execution-loop)
   - [1.4 Subsystem: Host services & providers](#14-subsystem-host-services--providers)
   - [1.5 Subsystem: Codebase Map indexing engine](#15-subsystem-codebase-map-indexing-engine-host-side)
   - [1.6 Subsystem: Codebase Map rendering (webview)](#16-subsystem-codebase-map-rendering-webview)
   - [1.7 Subsystem: Chat/Planning/Settings UI](#17-subsystem-chatplanningsettings-webview-ui)
   - [1.8 Prioritized "small change, big leverage" roll-up](#18-prioritized-small-change-big-leverage-roll-up)
2. [Code-change review experience](#2-code-change-review-experience)
3. [File-size & split-difficulty catalog](#3-file-size--split-difficulty-catalog)
   - [3.1 Top 50 largest files](#31-top-50-largest-files)
   - [3.2 Top 5 most congested — deep dives](#32-top-5-most-congested--deep-dives)

---

## 1. Responsiveness & friction review

### 1.1 Cross-cutting findings (webview lifecycle, bundles, build)

*Last verified: 2026-07-22, against the built `out/webview/` artifacts and `src/extension.ts`.*

#### Finding: all 5 sidebar webviews retain context (and stay fully alive) once opened
`src/extension.ts:152-176` registers all five webview views (`blacksite.chat`, `blacksite.plans`,
`blacksite.baseContext`, `blacksite.data`, `blacksite.map`) with `webviewOptions: { retainContextWhenHidden: true }`.
That's a deliberate, reasonable choice per-view (nobody wants their chat scrollback or Map camera position
reset every time they switch sidebar tabs) — but it's applied uniformly to all five, which means once a user
has opened all five tabs in a session, **all five webview contexts stay resident simultaneously** — five
separate Chromium-ish contexts, five separate React trees, five bundles' worth of parsed JS held in memory,
none of which VS Code will ever reclaim until the view container itself is disposed.
- **Severity:** medium · **Type:** actual (memory/CPU floor), and indirectly "expand usage" (lower-spec machines)
- **Direction, not a mandate:** the two views with genuinely expensive-to-rebuild state are Chat (scrollback,
  in-flight turn) and Map (camera position, layout). Base-Context, Data, and Notes are comparatively cheap to
  re-mount from their persisted store on next reveal. Worth a deliberate per-view decision rather than the
  current blanket `true` — this is exactly the kind of change that costs nothing feature-wise if done
  carefully (state already lives in durable stores, not just React state, per `base-context-store.ts` /
  `data-provider.ts`).

#### Finding: every one of the 6 webview bundles ships the *entire* `theme.css`, including CSS it never uses
Confirmed empirically, not just by reading the Vite config: the built `graph.js`, `data.js`, `planning.js`,
`notes.js`, and `base-context.js` bundles all contain `.map-live-pulse` (a Map-only pulse animation class),
and conversely `graph.js`/`data.js`/`planning.js`/`notes.js`/`base-context.js` all contain `.welcome-orb`
(the chat-only empty-state hero). `theme.css` (`src/webview/react/theme.css`) is 77KB raw / 2459 lines,
and roughly a third of its top-level selectors (106 of ~318) are Map-prefixed alone — none of that is
relevant to, say, the Base-Context panel, which pays to parse it anyway.
- **Severity:** low-medium · **Type:** actual (parse/CSSOM cost × 6 bundles, compounded by finding above
  when several stay resident at once) · **Confidence:** high (directly observed in build output)
- **Why this is a good candidate to act on first:** unlike most findings in this doc, this one is close to
  risk-free. It's a packaging change, not a behavior change — no visual output moves. `vite.webview.config.mjs`
  already builds 6 separate entries (`src/webview/react/apps/*/main.tsx`); splitting `theme.css` into a
  shared core (tokens, resets, primitives used everywhere — buttons, chips, signal dots, scrollbars) plus
  one partial per app (`theme.map.css`, `theme.chat.css`, `theme.data.css`, …), each entry importing only
  core + its own partial, would cut injected CSS per webview without touching a single pixel of what
  actually renders.

#### Finding: the chat webview's own bundle is the heaviest of the six — heavier than the WebGL Map view
Built sizes (`out/webview/*.js`, raw / gzip): `webview.js` (chat) **634KB / 190KB gzip**, `graph.js` (Map,
includes pixi.js) 508KB / 135KB gzip, then `data.js` 148KB, `planning.js` 145KB, `notes.js` 136KB,
`base-context.js` 131KB — plus a shared `bridge-*.js` chunk (194KB raw) common to all six. That the
Map — a WebGL scene graph library plus custom renderer — is *smaller* than the chat bundle is worth a closer
look at what's inside `webview.js` specifically; the subsystem review in §1.7 covers this from the source
side. Note this is **not** a highlight.js problem — that's already imported lean (`highlight.js/lib/core` +
11 explicit languages, see §1.2) — the weight is elsewhere.
- **Severity:** informational baseline for §1.7, low severity on its own (local bundle, not fetched over a
  real network — parse/init cost, not transfer cost, is what matters here)

#### Finding: two heavy, feature-specific dependencies load eagerly at activation — despite the codebase already knowing how to avoid this
`chat-provider.ts:29` (`import { Jimp } from "jimp"`) and, transitively, `reference-tools.ts:15-16`
(`import { json as jqJson } from "jq-wasm"` and its own `import { Jimp } from "jimp"`) are static top-level
imports. `ChatProvider` is unconditionally constructed in `activate()` (`extension.ts:128`), and it
statically imports `ReferenceToolService` from `reference-tools.ts` (`chat-provider.ts:42`) — so both
modules' top-level code runs during activation for every user, every session, whether or not that session
ever calls an image-handling or jq-style-query tool. `jq-wasm` in particular instantiates a WASM binary,
which is not free.
- **Severity:** low-medium (unmeasured — flagged for verification, not asserted as a fixed cost) · **Type:**
  actual (activation latency) · **"Expand usage" angle:** a lighter, faster activation path benefits every
  user on every VS Code launch, not just an edge case.
- **Why this is a confident recommendation despite being unmeasured:** the codebase has already solved
  *exactly* this problem, correctly, for a third heavy/optional dependency. `chromium-runner.ts:100-109`
  loads `playwright-core` via a dynamic `await import("playwright-core")` **only when a browser tool is
  actually invoked**, with an explicit comment ("Dynamic import so playwright-core stays external to the
  esbuild bundle") and a cheap `require.resolve` availability probe (`chromium-runner.ts:32`) that checks
  installability *without* loading the full module. `ChromiumRunner`'s constructor itself
  (`chat-provider.ts:543`) is instantiated eagerly and is cheap — only the actual launch path pays
  playwright's cost. Applying that same already-proven pattern to `jimp` and `jq-wasm` (dynamic `import()`
  inside the specific tool handlers that need them, instead of a module-top-level import) is a small,
  precedented, low-risk change — not a new technique for this codebase, just a consistency fix.

#### Finding: build/activation hygiene is solid
`esbuild.mjs` externalizes native-binary and ESM-shim-incompatible deps (`playwright-core`, `jq-wasm`)
rather than trying to bundle them, and ships a minimal `DOMMatrix` polyfill scoped to exactly the
`pdfjs-dist` text-extraction path that needs it (`esbuild.mjs:25-51`) instead of pulling in a full canvas
shim. `extension.ts` defers non-critical startup work (checkpoint-resume prompt at `+1500ms`, update check
at `+2500ms`, both via `setTimeout` with their own error containment so a failure can't crash activation).
No finding here — recorded so a future pass doesn't need to re-check it.

### 1.2 What's already well-engineered — leave alone

Recorded explicitly per the "don't assume it's broken" instruction, so this doesn't get re-flagged or
"fixed" by accident in a future pass:

- **`highlight.js`** is imported via `highlight.js/lib/core` with 11 explicit `languages/*` imports
  (`src/webview/react/lib/markdown.ts:11-22`) — not the full ~190-language bundle. This was the first
  hypothesis for why `webview.js` is the heaviest bundle; it's ruled out.
- **`useLiveClock`** (`src/webview/react/lib/use-live-clock.ts`) only creates its `setInterval` while
  `active` is true and tears it down on deactivation/unmount — an idle chat has zero background timers.
  This is the *only* other `setInterval` in the entire `src` tree besides a short bounded poll in
  `chromium-runner.ts:94` (50ms, waiting on a launch flag, self-clearing). Polling is essentially absent
  from this codebase — this is not where any responsiveness problem lives.
- **Webview font loading** (`src/webview/shell.html:8-29`): a single variable-weight Lexend font (weight
  range 100–900 in two `@font-face` rules split by Unicode range) bundled locally under `out/webview/fonts`
  with `font-display: swap` — no Google Fonts network dependency, no FOUT risk, no per-weight static file
  bloat.
- **`theme.css` animation hygiene**: despite its size, essentially every `@keyframes` block animates only
  `transform`/`opacity` (compositor-friendly, not layout-triggering) — the "breathing dot," "sheen sweep,"
  and card-entrance animations that give the UI its "living" feel are cheap by construction. Multiple rules
  correctly respect `@media (prefers-reduced-motion: reduce)`. Zero `!important` in the whole file. The
  file's size is a *surface-area* story (many distinct features sharing one file — see §1.1 for the
  packaging angle on that), not a quality problem.
- **`provider-retry.ts`** exists specifically because the provider/network layer was already hardened in a
  prior pass — don't re-diagnose retry/backoff behavior from scratch; check this module first.
- **The Codebase Map's render-cap settings** (`blacksite.graph.performanceProfile`,
  `maxIndexedFiles`/`maxRenderedStars`/`maxRelationshipEdges` in `package.json:329-367`) show this
  subsystem has already had at least one dedicated scale-hardening pass. §1.5/§1.6 findings below are
  additive to that work, not a rediscovery of the same problem.
- **The agent run loop's resource bounds are already deliberate and mostly tight**: compaction has a
  circuit breaker and a bounded blocking-wait that overlaps with background work
  (`agent-session.ts:2065-2169`), checkpoint writes already throttle full-history persistence to every
  10th save (`agent-session.ts:214-220, 2279-2297`), tool-result overflow is FIFO-bounded at 30 entries
  (`agent-session.ts:200-202, 1883-1893`), and post-edit diagnostic collection uses a genuine debounced
  quiescence wait rather than a fixed sleep (`post-edit-diagnostics.ts:190-220`). §1.3 findings below are
  real but incremental against this baseline, not evidence of a shaky foundation.
- **`playwright-core` (browser automation) is already lazy-loaded correctly**: `chromium-runner.ts:100-109`
  loads it via a dynamic `await import("playwright-core")` only when a browser tool actually runs, with a
  cheap `require.resolve` availability probe (`chromium-runner.ts:32`) that checks installability without
  loading the full module. This is the pattern the `jimp`/`jq-wasm` finding above recommends extending —
  it's proven correct elsewhere in this same codebase, not a new technique.

### 1.3 Subsystem: Agent core & tool-execution loop

*Files reviewed: `agent-session.ts`, `chat-provider.ts`, `tools/definitions.ts`, `workspace-context.ts`,
`diff-edit-service.ts`, `post-edit-diagnostics.ts`, `workspace-edit-applier.ts`, `agent-memory-index.ts`,
`graph-agent-gateway.ts`, `execution-logger.ts`. Last verified: 2026-07-22.*

This is the highest-stakes bucket in the review — it contains the two largest files in the extension
(`agent-session.ts` at 5718 lines, `chat-provider.ts` at 3607) — and both turn out to be genuine "Very High"
split-difficulty congestion cases, not just large-by-volume. Both are carried through to the top-5 deep
dive in [§3.2](#32-top-5-most-congested--deep-dives) rather than repeated here. The other 8 files in this
bucket rated Low or Low-Medium difficulty — cohesive, single-purpose modules that happen to be large (or in
`execution-logger.ts`'s case, long mainly because it exhaustively switches over every `AgentEvent` variant,
a 1:1 match with real complexity rather than accidental sprawl).

- **[actual] [high]** `workspace-context.ts:233-328` (`gatherWorkspaceSnapshot`), called from
  `agent-session.ts:2346` — the full workspace snapshot (project-shape file probes, instruction-file reads,
  a full-workspace diagnostics scan, a git-status shell-out) is re-gathered on **every loop iteration** —
  every tool-call round-trip inside a turn, not once per user message. A turn with 15 tool calls triggers
  15 full snapshots. Diagnostics and git status genuinely need to stay live turn-to-turn; project shape
  (`describeProjectShape`, workspace-context.ts:139-180) and instruction files
  (`readWorkspaceInstructions`, workspace-context.ts:95-137) essentially never change mid-session. Scales
  with both workspace size (more to probe) and turn length (more iterations paying for it). — *Direction:*
  cache the project-shape/instruction-file results, invalidated by the file watcher that already exists in
  this same file for exactly this purpose (`registerFileWatcher`, workspace-context.ts:606-623) but isn't
  currently wired to this path.
- **[actual] [medium]** `agent-session.ts:1082` (`_fullHistory`) / `4756-4769` (`stripImagesForPersistence`)
  — image blocks (up to ~3.5MB raw per attachment, `chat-provider.ts:2459`) accumulate in `_fullHistory`
  for the whole session; it's documented as "never trimmed by compression." The code already knows old
  images are dead weight once compacted — `stripImagesForPersistence`'s own comment says compression and
  the memory index "both drop image blocks, so a restored session would never show them to the model
  again" — but that stripping only runs at checkpoint/persistence boundaries, never against the
  compacted-away tail of `_fullHistory` still sitting in process memory. A long, screenshot-heavy session
  holds every image it ever saw. — *Direction:* apply the same stripping to the `_fullHistory` prefix right
  after a compaction pass completes, since that's the moment the code already treats those messages as
  no longer consulted.
- **[actual] [medium]** `agent-session.ts:3299-3305` (+ parallel-subagent path near 2870-2874) — tool
  results are fully `JSON.stringify`'d before `_capToolResult` (agent-session.ts:1883-1893) truncates them.
  Most tools bound their own output via schema limits in `tools/definitions.ts`, but `git_op`
  (`tools/definitions.ts:885-909`) and `shell_run` (`tools/definitions.ts:119-135`) declare no output-size
  cap, so a large diff or verbose shell command pays a full synchronous stringify before any truncation. —
  *Direction:* bound raw output for the specific tools that currently have no discipline of their own.
- **[visual] [low-medium]** `chat-provider.ts:2488-2532, 2541-2582` — up to 8 attached images are decoded
  and iteratively downscaled **sequentially** (`await` inside a `for` loop), so a multi-screenshot send
  pays combined Jimp decode/encode/resize latency serially instead of in parallel. The two downscale loops
  (`_buildAttachmentImageBlocks` and `_buildAttachmentVisionFallbackNotes`) are also near-duplicates of
  each other. — *Direction:* bounded-concurrency (2-3 at a time) for the per-image pipeline; consider
  sharing the decode/downscale loop between the two call sites.
- **[actual] [low]** `execution-logger.ts:48-49, 57-58` — `.blacksite/execution.log`/`.jsonl` are
  append-only for the life of the workspace, no rotation or size cap. Given long-running-session reliability
  is an explicit goal for this project, a long-lived workspace could grow a large log file that's slower to
  open/tail later. Disk growth, not memory, and low severity given how deliberately bounded everything else
  nearby is (`_resultOverflow`, checkpoint cadence). — *Direction:* size- or date-based rotation.
- **[actual] [low]** `agent-session.ts:3474-3484, 5023-5032` — the Anthropic strict-tool-schema conversion
  for all ~140 advertised tools is recomputed from scratch on every provider turn (called every loop
  iteration from `_streamTurnAnthropic`/`_streamTurnBedrockMantle`), even though the schemas are static
  unless `disabledTools` or a learned unsupported-flag changes. Likely sub-millisecond per call, but pure
  waste repeated across a long session. — *Direction:* memoize, invalidate only when the advertised tool
  set changes.
- **[visual] [low]** `chat-provider.ts:2877-2899` (`_searchWorkspaceFiles`) — re-scores up to 4000 cached
  file paths synchronously on every `request_files` message; the 30s cache keeps it off the disk-scan path
  and each pass is cheap alone. Unconfirmed from this file whether the webview debounces keystrokes before
  sending `request_files` — worth checking on the webview side, since undebounced per-keystroke calls would
  add up even though no single call is expensive.

Two additional structural notes worth carrying forward (not responsiveness findings, but relevant to how
`tools/definitions.ts` and `workspace-edit-applier.ts` are described in §3.1): `tools/definitions.ts` rated
**Low** split difficulty despite being the third-largest file reviewed here — it's ~140 declarative tool
schemas across 19 independent family arrays plus a self-contained validation/coercion module, with almost
no shared mutable state. `workspace-edit-applier.ts` (the shared apply/preview/approval pipeline discussed
in depth in [§2](#2-code-change-review-experience)) rated **Low-Medium** — one cohesive class around one
job, with its nested `ProposedContentProvider` (workspace-edit-applier.ts:28-43) as a clean, low-risk
extraction if ever worth doing.

### 1.4 Subsystem: Host services & providers

*Files reviewed: `lsp-service.ts`, `planning-store.ts`, `data-provider.ts`, `model-fetcher.ts`,
`update-service.ts`, `bedrock-client.ts`, `provider-retry.ts`, `bedrock-models.ts`, `data/legacy-import.ts`,
`base-context-store.ts`. Last verified: 2026-07-22.*

The standout structural finding here isn't a single file — it's a **repeated pattern across two unrelated
stores**: `planning-store.ts` and `base-context-store.ts` both synchronously read, parse, and fully
re-normalize their entire on-disk document on every access, including the per-turn prompt-summary path that
runs before every provider round-trip. That's promoted to the top of the roll-up below. `lsp-service.ts`
(Medium difficulty — six sibling concerns already extracted to `src/lsp/*.ts`, this is the intentionally-
retained orchestration residue) and `planning-store.ts`'s `updatePlan` method specifically (High pocket
inside an otherwise Medium file) are the two runner-up congestion candidates from this bucket — both
considered for [§3.2](#32-top-5-most-congested--deep-dives) and set aside in favor of stronger candidates
elsewhere (see that section for the reasoning). Six of the ten files here rated Low difficulty, several
explicitly called out as already at a sensible size for what they do (`provider-retry.ts` in particular —
"the textbook example of a well-sized module in this codebase").

- **[actual] [high]** `planning-store.ts:1058-1062` (+`863-867`, `1004-1031`) and
  `base-context-store.ts:137-168` — `summarizePlanningStateForPrompt`/`summarizeBaseContextForPrompt` run
  from `workspace-context.ts`'s `gatherWorkspaceSnapshot` on **every provider round-trip** (see the matching
  finding in [§1.3](#13-subsystem-agent-core--tool-execution-loop) — this is the same hot path, different
  stores). Each call synchronously reads + `JSON.parse`s + fully re-normalizes the entire document (every
  plan/phase/step/block/doc, or every base-context topic plus up to 3 file reads per attached topic) from
  scratch, uncached, every time — and neither `plans[]`/`phases[]` nor base-context topic count is capped,
  unlike the sub-collections that already are (`MAX_BLOCKS`/`MAX_DOCS`/`MAX_TOPIC_FILES`). This compounds
  with turn length (more round-trips) and workspace history (more accumulated plans/topics), and blocks the
  single-threaded extension host while it happens. — *Direction:* cache the parsed/normalized document in
  memory inside each store, invalidated on the store's own `write()` (which already sees every mutation) —
  a pure optimization, no behavior change, since nothing outside the store can change the file.
- **[actual] [medium]** `bedrock-client.ts:467-485` (`invokeBedrockEmbedding`), reached from
  `data-provider.ts:142-150`/`249-261` — takes `signal?: AbortSignal` as optional with **no internal
  fallback timeout**, and its real caller for the Data workbench embedder passes no signal at all. A
  stalled connection (VPN/proxy/flaky network) leaves the awaiting call pending forever — the surrounding
  `try/catch` rescues rejections, not hangs — so a "vector_search" request in the Data view never resolves
  and can't be cancelled. — *Direction:* give it a default internal timeout when no signal is supplied,
  mirroring `bedrock-models.ts`'s `bedrockGetJson` or `model-fetcher.ts`'s `get()`, both already in this
  same bucket.
- **[actual] [medium]** `model-fetcher.ts:380-385` (`getMaxOutputTokens`) via
  `chat-provider.ts:792-793, 3267-3287` — new-session creation resolves context-length and
  max-output-tokens with two sequential `await`s (not `Promise.all`), and on a cold cache both can trigger
  a live fetch to the same provider. For Anthropic specifically, the live fetch fires even when the
  id-based fallback table already has an accurate, network-free answer — the code already trusts that same
  table enough to skip the fetch entirely for `openai`/`bedrock` (`chat-provider.ts:3277`, comment: "avoid
  a network request that cannot improve it") but doesn't extend that short-circuit to Anthropic. This sits
  on the critical path to first-token latency for every new session on a cold cache. — *Direction:* extend
  the existing provider short-circuit to cover any case where the id-based fallback already resolved, and
  run the two `_resolve*` calls concurrently for what's left.
- **[actual] [low-medium]** `model-fetcher.ts:154-169` (`get()`) and `bedrock-models.ts:176-210`
  (`bedrockGetJson`) — single-attempt HTTP with a timeout but no retry/backoff, unlike the purpose-built
  `provider-retry.ts` sitting in the same directory. A transient blip while fetching the model catalog
  surfaces as a hard failure/fallback instead of a quiet recovery — inconsistent with how the rest of the
  provider layer behaves. — *Direction:* route these through the existing `retryAsync` with a short policy;
  mostly a call-site change, no new infrastructure needed.
- **[actual] [low-medium]** `extension.ts:92` → `data-provider.ts:63-99` → `data/database-manager.ts:49-64`
  — the embedded SQLite database opens, applies durability PRAGMAs, and runs pending migrations
  **synchronously on the `activate()` call stack**, before any webview provider is registered. One-time
  cost after first migration, already try/caught so failure degrades gracefully — but it's the one piece of
  eager activation work in this bucket that isn't deferred, unlike its two siblings in the very same file
  (checkpoint-resume and update-check both already run behind `setTimeout`, `extension.ts:395-416`). On a
  slow disk this directly delays how soon VS Code considers the extension active. — *Direction:* apply the
  same `setTimeout` pattern already used twice in this file, or open the database lazily on first Data-view
  use — the webview already handles an "unavailable" status cleanly.
- **[visual] [low]** `data-provider.ts:479-499` (`_ensureSidecarReady`) — fixed 1s-interval polling for up
  to 15s with no fast initial check, backoff, or intermediate progress feedback, when a user explicitly
  switches to the optional pgvector sidecar backend. Narrow impact (opt-in, advanced setting) but the wait
  currently looks identical to a hang. — *Direction:* faster initial poll + backoff, or surface intermediate
  status between attempts.

**Worth naming as already solid:** `provider-retry.ts` and the streaming half of `bedrock-client.ts`
(idle-timeout-guarded reader, frame-desync bounds) are genuinely well-hardened. Model-list fetching is
already lazy — triggered by explicit webview messages with a loading placeholder, never during activation.
Bedrock's two control-plane listing calls already run via `Promise.all`. `update-service.ts` is fully
timeout-bounded and already deferred out of the activation path. The LSP `ActionRegistry` cache self-prunes
on a TTL and never grows unbounded.

### 1.5 Subsystem: Codebase Map indexing engine (host-side)

*Files reviewed: `graph/relationship-indexer.ts`, `graph/graph-indexer.ts`, `graph/layout.ts`,
`graph/project-topology.ts`, `graph/resolve-imports.ts`, `graph/import-scan.ts`, `graph-provider.ts`,
`graph-annotation-store.ts`, `graph/graph-model.ts`, `graph/client-config.ts`. Last verified: 2026-07-22.*

The file-scanning/import-resolution/layout pipeline itself (`graph-indexer.ts`'s scanning, `layout.ts`,
`import-scan.ts`, `resolve-imports.ts`, `project-topology.ts`, `graph-model.ts`) shows real, deliberate
scale-hardening: chunked I/O, chunked layout ticking, a documented algorithmic switch to a linear-time
packing mode above 6000 nodes, capped/bounded clustering, oversized-file windowing. The two places that
sit **outside** that already-hardened core are where this review's leverage actually concentrates: the
**relationship/Services-lens rebuild path**, which has no incremental mode at all, and the **host→webview
IPC boundary**, which always sends full graph state. Both findings below are additive — neither needs
removing a language detector or a visual feature to address.

- **[actual] [high]** `graph/relationship-snapshot.ts:103-145` (`_currentKey`/`_ensureFresh`) +
  `graph/relationship-indexer.ts` (confirmed zero `await`/`yieldToLoop`/`setImmediate` calls anywhere in
  the file) — **the Services-lens rebuild is effectively never incremental.** `_currentKey()` includes the
  indexer's `indexedAt` timestamp, which changes on essentially every debounced edit to an already-indexed
  file (`graph-indexer.ts:1044, 1116`), so nearly any save invalidates it. Once invalidated, `_ensureFresh`
  re-reads **every** indexed file (not just the dirty ones) and calls `buildServiceRelationships` with
  `maxEdges = Infinity` — disabling its own early-exit truncation — and since the function contains no
  yield points, once it starts it runs as one uninterrupted block on the extension host's single thread.
  At the `large`/`extreme` performance profiles (up to 150k-250k indexed files), this is precisely the
  scenario this review was asked to stress-test: a workspace big enough to need those profiles is big
  enough for this full-corpus, multi-regex-per-file rescan to take real wall-clock time — and it can
  retrigger on the very next keystroke-driven save. — *Direction:* an incremental mode that only re-scans
  dirty files' signals and merges them into the retained set (mirroring how `graph-indexer.ts`'s
  `_applyDirty` already does this for imports), and/or periodic yield points inside the per-file loop so a
  full pass genuinely can't monopolize the event loop.
- **[actual] [high]** `graph-provider.ts:121-122, 514-540` + `graph/graph-indexer.ts:940, 1156` — **`graph_state` is never sent incrementally.** Both a full rebuild and a single-file debounced edit
  produce and post an identically-shaped full `nodes`/`edges`/`relationshipEdges` payload, with no
  diffing, on every `indexer`/`RelationshipSnapshot` change event. Given the configured range (a workspace
  can legitimately reach 50,000-100,000 rendered nodes and 75,000-150,000 relationship edges per
  `config.ts`'s profile caps), even a conservative per-item JSON footprint puts a single payload in the
  tens-of-megabytes range — re-sent on every debounced save, not just on demand. This is the concrete,
  quantified version of the IPC-payload question this review set out to check. — *Direction:* distinguish
  a "full" snapshot emission from a "delta" one (added/updated/removed node and edge ids) so the common
  single-file-edit case posts a small delta instead of the complete graph.
- **[actual] [medium]** `graph/graph-indexer.ts:1016-1019, 1026, 1125-1138` (`_applyDirty`) — incremental
  bookkeeping costs scale with total corpus/edge-set size, not the number of files actually touched:
  `_corpusFiles` is a plain array used with `.indexOf()`/`.splice()`/`.includes()` (each O(corpus size))
  once per dirty file, then unconditionally `.sort()`'d; in/out-degree is recomputed by scanning the
  **entire** edge array, and every rendered node's `z` is re-derived, on every incremental pass. At the top
  of the configured range this turns a one-file edit into O(corpus) work on every debounce tick while the
  user is actively typing. — *Direction:* back `_corpusFiles` membership checks with a `Set`, and maintain
  running degree counters adjusted only for nodes whose edges actually changed.
- **[actual] [medium]** `graph/relationship-indexer.ts:558-581, 1037-1049, 1361-1443` — several regex
  passes run unconditionally per file rather than being gated by the file's actual language up front,
  unlike `import-scan.ts`'s `collectSpecs`, which dispatches once per file by language before running any
  language-specific regex. A Go file still runs the JS-shaped HTTP/decorator patterns; a Python file still
  runs the generic route regex. Pure multiplier waste layered on top of the full-corpus rescans above —
  every avoidable regex exec across tens of thousands of files adds aggregate CPU time to the same
  blocking pass. — *Direction:* a lightweight per-file language dispatch at the top of the collector
  functions, mirroring `collectSpecs`'s existing shape.
- **[actual] [low]** `graph/layout.ts:710` vs. `graph-indexer.ts:911-914` — the large-graph packing path
  computes all three hierarchy levels fully synchronously with no internal yield, unlike the below-
  threshold d3-force path which is already chunked. The algorithm is intentionally linear by design, so
  this is unlikely to be a practical stutter source even at 100k+ nodes — flagged as the one place in the
  layout module without a safety-margin yield, in case profiling ever shows otherwise.
- **[actual] [low]** `graph-provider.ts:513` — `_refreshLanguageSupport` re-invokes from every
  `_postState()` call, gated only by an in-flight flag rather than "did the indexed language mix actually
  change." Minor; would compound with more frequent `graph_state` posts if those become more frequent for
  other reasons.

**What's already well-engineered here:** `ProviderIndex`'s blocking/candidate index (`relationship-indexer.ts:1778`)
already replaces an O(providers×consumers) cross product with a real, well-reasoned prior optimization.
`scanWindows` (`import-scan.ts:198`) already chunks oversized files into overlapping windows rather than
truncating or paying an unbounded single-pass cost. `assignClusters`/`splitByImportCommunity`
(`graph-model.ts:225-370`) already bound their own cost (5-iteration cap, operates only on the oversized
bucket) — this is the fix referenced in prior project history and holds up on inspection. The
`LARGE_GRAPH_LAYOUT_THRESHOLD = 6000` switch to linear-time packing is a clear, deliberate, documented
scale decision, not an accident.

### 1.6 Subsystem: Codebase Map rendering (webview)

*Files reviewed: `webview/react/apps/graph/GraphApp.tsx`, `webview/react/apps/graph/scene/renderer.ts`,
`webview/react/lib/graph/view-model.ts`, `webview/react/apps/graph/store.ts`. Last verified: 2026-07-22.*

This is where the review's single clearest "Very High" congestion case outside the agent-core bucket lives:
`renderer.ts` (2411 lines) — described by its reviewer as matching the split-difficulty rubric's hardest
category "almost exactly," with ~30 shared mutable closure bindings read/written by ~45 nested functions and
no dependency-injection boundary. It's carried through to
[§3.2](#32-top-5-most-congested--deep-dives). The notable *negative* result here is `GraphApp.tsx` — at
2536 lines it's the **third-largest file in the entire extension**, larger than `renderer.ts` itself, yet
it rated only **Medium** difficulty: it's "closer to an entire small app's UI living in one module" (a
search bar, minimap, three inspector-card variants, a ~600-line control rail, a legend, an LSP-onboarding
panel) but almost every piece is a self-contained function component with props-only coupling, not shared
mutable state — file-length congestion, not architectural entanglement. That distinction is exactly why
`GraphApp.tsx` is *not* one of the top-5 deep dives despite being bigger than three files that are: size
alone isn't the signal this review is selecting on (see the `theme.css` note in §1.1 for the same pattern
found elsewhere). `view-model.ts` (Medium — a library of pure functions bundling 5-6 distinct sub-domains
in file-written order, including a duplicated union-find implementation worth deduping) and `store.ts`
(Low) round out the bucket.

Nearly every finding below traces back to one root cause, reported independently by this bucket's reviewer
without prompting: **the Map's own state store has no field-level selector**, so the highest-frequency event
in the whole webview — camera movement during pan/zoom/fly, up to ~40 times a second — triggers a full
React re-render of the entire `GraphApp` tree on top of whatever pixi is already doing on canvas.

- **[visual] [high]** `renderer.ts:2317-2327` (`setState`) + `:2111-2119` (`frame`) + `:648-838`
  (`rebuildNodes`) — clicking any star or typing a search character sets the same `structureChanged` flag
  as an actual topology change, triggering the *full* rebuild-nodes/edges/background/zones cascade next
  frame even though the underlying node/edge arrays are the exact same references. Click-to-select and
  search-as-you-type are two of the most common Map interactions, so on a large graph each keystroke or
  click costs an O(N log N + E) rebuild instead of the O(N) emphasis-only update it actually needs. —
  *Direction:* extend the finer-grained dirty flag pattern that already exists for `hoverChanged` two lines
  below to also cover `search`/`selectedNodeId`.
- **[visual] [high]** `store.ts:175-192` (`bump`/`useGraphStore`) + `GraphApp.tsx:2208` — no per-field
  selector means every `bump()` — including camera motion at up to ~40/sec during drag/zoom/fly — re-renders
  `GraphApp` and, by default, every one of its ~15 unmemoized child overlays, a full React reconciliation
  pass competing for main-thread time with the pixi ticker for pixels that pure panning doesn't actually
  need React for at all (`PixiStage.tsx:34-36` already gates renderer pushes on `view` reference changes,
  proving the camera-vs-view distinction is already recognized elsewhere in the code). The fix pattern is
  already proven in this same file — `MinimapDots` is `memo`'d against stable `useMemo`'d props specifically
  to survive a camera-driven re-render — it's just not applied anywhere else yet. — *Direction:* `memo` the
  camera-independent panels; several callback props would need `useCallback` stabilization first
  (`flyToAltitude`, `focusNode`, an inline arrow-function prop) for `memo` to actually pay off.
- **[actual] [medium]** `GraphApp.tsx:753` (`NodeCard`) — calls `useGraphStore()` itself instead of taking
  `view` as a prop from its already-subscribed parent — a second, fully independent subscription that
  re-executes the whole file-inspector panel on every camera tick, hover, and search keystroke while a file
  is selected. Purely mechanical to fix (its own `useMemo`s are already correctly keyed). — *Direction:*
  have `GraphApp` pass `view`/`pendingSymbolPath` down as props, matching every other overlay.
- **[visual] [medium]** `GraphApp.tsx:240-299` (`LabelsOverlay`) — the territory/hub/subgroup label
  candidate array is built directly in the render body (not memoized) and fed into a priority-sort-then-
  greedy-overlap packer, on every render — which, per the finding above, means every camera tick while
  panning. The underlying candidate data is already correctly memoized upstream; only the screen-projection-
  and-packing step is not. — *Direction:* label occlusion doesn't need 1:1 parity with pan framerate —
  consider throttling this specific overlay's effective update rate independently of `GraphApp`'s.
- **[actual] [low-medium]** `renderer.ts:1902-1917` (`motionPass`) + `lib/graph/motion.ts:23-33`
  (`approachPoint`) — allocates two fresh objects per visible node per frame, even once fully settled,
  whenever the ticker is kept alive by ambient twinkle (any graph ≤5,000 nodes — the common case). For a
  mid-size idle workspace that's tens of thousands of short-lived allocations per second to support a
  feature that only actually needs a fresh alpha per frame, not a fresh position object. — *Direction:*
  short-circuit once a node's live position already equals its layout target, mirroring how the
  simplified-motion path already short-circuits.
- **[actual] [low]** `renderer.ts:885-887` (`applyEmphasis`, `hoverNeighbors`) — a fresh O(edges) scan on
  every hover-enter event, on top of the main O(nodes) loop; the code's own comment already flags this as a
  deliberate tradeoff, not an oversight. Fine at default caps; worth watching only at the "extreme"
  performance tier (up to 100,000 rendered stars) with the mouse sweeping a dense cluster. — *Direction, if
  it ever shows up in profiling:* a precomputed adjacency map built once during the structural rebuild.

**What's already solid here (confirmed by reading, not assumed) — a genuinely long list, worth stating
plainly:** viewport culling exists and is threshold-gated, backed by a spatial grid; ambient twinkle and
full node-motion are independently capped by node count; edge redraw only happens on a genuine LOD-strategy
crossing, not every camera frame; the animation ticker fully stops when the webview is hidden or nothing is
animating; camera persistence to `localStorage` is trailing-debounced specifically to avoid jank during
drag; sprite/badge/texture cleanup on node removal is thorough with no leak found across rebuilds or
teardown; `PixiStage`'s effect already only calls into the renderer when the view object reference actually
changes, so a pure camera pan never re-pushes state into pixi in the first place; and every `.map-*`
keyframe animation in `theme.css` animates only `opacity`/`transform` with `prefers-reduced-motion`
opt-outs already in place. The opportunities above are about tightening an already-hardened system, not
fixing something broken.

### 1.7 Subsystem: Chat/Planning/Settings webview UI

*Files reviewed: `webview/react/lib/store.ts`, `lib/chat-model.ts`, `lib/tool-presentation.ts`,
`apps/planning/PlanningApp.tsx`, `lib/format.ts`, `components/chat/InputDock.tsx`,
`components/chat/ToolLog.tsx`, `components/settings/SubagentPanel.tsx`, `lib/protocol.ts`,
`components/chat/QuestionCard.tsx`, `apps/notes/NotesApp.tsx`, `components/settings/ModelPickerList.tsx`,
`components/chat/QuickSettings.tsx`, `components/settings/GenerationPanel.tsx`. Last verified: 2026-07-22.*

The clearest signal from this bucket: 11 of 14 files rated Low difficulty, several explicitly called out as
*already doing the right thing* and worth crediting rather than re-diagnosing — `Markdown.tsx` (outside
this bucket's file list but verified directly, since it's the streaming-render path everything else here
feeds into) already skips markdown/highlight parsing entirely while a turn is streaming and only pays that
cost once via a correctly-keyed `useMemo`; `NotesApp.tsx` and `ModelPickerList.tsx` already memoize their
derived lists correctly; `InputDock.tsx` already debounces the mention-file request instead of firing on
every keystroke. `store.ts` (High difficulty) is the one real structural congestion point, and it's also
the root cause of every render-cadence finding below — not a coincidence, since every finding traces back
to the same architectural gap: no field-level selector on the store's `useSyncExternalStore` subscription.

- **[actual] [medium]** `components/chat/Transcript.tsx` + `Turn.tsx` + `store.ts:141-167` — no component in
  the entire chat render tree uses `React.memo` (confirmed: the only `memo()` call anywhere in
  `webview/react` is in the unrelated Map's `GraphApp.tsx`), and `useStore()` exposes the whole store
  through one unselectored version counter — 24 files call it directly. Since `bump()` fires roughly every
  16ms while any turn is streaming, every subscriber re-renders on every tick: every mounted `Turn` (up to
  the transcript's window of 30) and its full subtree, not just the one turn actually growing. This is
  substantially mitigated today by `Markdown.tsx`'s own memoization (a completed turn doesn't re-parse), so
  it currently shows up as CPU/battery overhead rather than visible jank — but it's the highest-leverage
  structural opportunity found in this bucket. — *Direction:* a per-turn revision counter (mirroring the
  `pendingSeq` pattern `chat-model.ts` already uses elsewhere) bumped only at that turn's own mutation call
  sites, then `React.memo(Turn)` with a custom comparator on `(turn, rev)` — explicitly **not** a bare
  `React.memo(Turn)`, since `chat-model.ts` mutates `Turn` objects in place (e.g. `appendText`,
  `chat-model.ts:248`), so the object reference never changes and naive reference-equality memoization
  would silently freeze the live turn's own streaming updates. This nuance matters — get it wrong and the
  fix breaks live streaming rather than just failing to help.
- **[actual] [low]** `components/chat/PendingBar.tsx:18` / `lib/chat-model.ts:695` (`pendingItemsOf`) — a
  full turns×lanes×tool-calls scan plus a sort, called directly in the always-mounted composer's render
  body with no `useMemo`, at streaming cadence (up to ~60/sec). Cost scales with total turns×tool-calls in
  the conversation. — *Direction:* wrap in `useMemo`, or track pending-item membership incrementally in
  `chat-model.ts` at the same call sites that already flip `approvalState`/`answeredKeys`.
- **[actual] [low]** `components/chat/ToolLog.tsx:93` (`DetailCard`) — calls `tokenizeJson(value)` (a full
  `JSON.parse` + `JSON.stringify` + lex pass) directly in the render body with no `useMemo`. Bounded to
  12,000 chars per card, but combined with the first finding, a store bump anywhere re-triggers this for
  every currently-expanded detail card. — *Direction:* `useMemo(() => tokenizeJson(value), [value])`.
- **[actual] [low]** `lib/store.ts:164-167` (`useStore`) — the architectural root of the three findings
  above: no selector/slice support, so e.g. a Settings panel open in the background re-renders at streaming
  cadence while an unrelated turn streams, even though nothing settings-relevant changed. Low severity
  today (Settings panels are cheap to re-render), but it's the structural ceiling the other findings bump
  into. — *Direction:* an optional `useStoreSlice<T>(selector)` overload alongside the existing `useStore()`,
  migrating the highest-traffic subscribers (`Transcript`, `InputDock`) first.
- **[actual] [low]** `apps/planning/PlanningApp.tsx:543` — fully replaces the planning document on every
  `planning_state` push rather than patching incrementally, and nothing in the file is memoized, so any
  single plan's update re-renders every card in the document. Low-risk today (plan counts are
  human-authored and naturally small, plus a manual "Clear completed" release valve already exists) —
  flagged as forward-looking, not a live problem. — *Direction, with a caveat:* `React.memo(PlanCard)` keyed
  on object reference is likely safe here (unlike chat's `Turn`) *provided* `planning-store.ts` replaces
  plan objects wholesale on update rather than mutating in place — worth confirming that host-side
  assumption before relying on it.
- **[informational]** `components/chat/Transcript.tsx:11-12, 58-62` — the transcript's windowing
  (`WINDOW_INITIAL=30`, `WINDOW_STEP=50`) only grows via "Show earlier" and never shrinks back down until
  the next clear/history-restore, so a session where the user pages back repeatedly in one sitting
  permanently mounts however many turns they've paged through. Narrow impact; no action needed unless it
  becomes a real complaint.

**Positive findings worth preserving (verified, not assumed):** `Markdown.tsx` skips `markdown-it`/
`highlight.js` entirely while a turn is streaming, rendering plain text, and only runs the full parse once
via a correctly-keyed `useMemo` after the turn settles, with `useDeferredValue` keeping token arrival from
blocking input — this is exactly the pattern the review set out to verify, and it's already correct.
`InputDock.tsx`'s mention-autocomplete already debounces the file-search postMessage by 90ms instead of
firing per keystroke. `NotesApp.tsx`'s filter/group/count derivations are already correctly `useMemo`'d, and
its git-history drawer is lazily loaded on first expand with duplicate-fetch guarding. `ModelPickerList.tsx`
and `QuickSettings.tsx`'s filtered-model lists are both already correctly memoized. `SubagentPanel.tsx`'s
model-picker refresh is already TTL-guarded through the same shared mechanism `QuickSettings` uses, so
repeated open/close doesn't hammer the provider API.

### 1.8 Prioritized "small change, big leverage" roll-up

Two patterns showed up independently in more than one subsystem review, without prompting — that
independent repetition is itself signal, and neither was visible from inside any single bucket:

- **Per-turn context re-gathering.** `workspace-context.ts`'s `gatherWorkspaceSnapshot` (§1.3) re-reads
  project shape and instruction files from disk on every tool-call round-trip, and it pulls in
  `planning-store.ts` and `base-context-store.ts` (§1.4), both of which separately re-parse their *entire*
  on-disk document from scratch on every call rather than caching. Three stores, one hot path, one shape of
  fix (in-memory cache invalidated on write/file-watcher) — this is arguably the single highest-value fix
  in the whole review because it closes three "high"-severity findings with one pattern applied three times.
- **Render-heavy stores with no field-level selector.** The Map's `apps/graph/store.ts` (§1.6) and the
  chat webview's `lib/store.ts` (§1.7) both expose their entire state through one unselectored
  `useSyncExternalStore` subscription, so every subscriber re-renders on every change — camera motion at
  ~40Hz for the Map, streaming ticks at ~16ms for chat. The Map instance is the more severe of the two (full
  React reconciliation racing the pixi ticker for main-thread time during the most common gesture); chat's
  is mitigated today by `Markdown.tsx`'s own memoization. Same architectural gap, same fix shape
  (`useStoreSlice`), two independent webviews.

The full ranked list, ordered by impact × ease rather than by subsystem:

**Tier 1 — cheap, low-risk, do first:**

1. Split `theme.css` into a shared core + one partial per webview app (§1.1) — packaging-only, zero visual
   risk, cuts injected CSS on 5 of 6 bundles that currently ship styles they never use.
2. Apply the already-proven `playwright-core` dynamic-`import()` pattern to `jimp`/`jq-wasm` (§1.1) —
   precedented elsewhere in this exact codebase, speeds every activation.
3. Cache the three per-turn re-reads described above (§1.3 + §1.4) — closes the review's most-repeated
   finding.
4. Extend the Map's `hoverChanged`-style fine-grained dirty flag to also cover `search`/`selectedNodeId`
   (§1.6) — the pattern already exists two lines away in the same function.
5. Extend the existing Anthropic-fallback short-circuit for `getMaxOutputTokens` the same way it's already
   applied to `openai`/`bedrock` (§1.4) — a scope change to an existing conditional, cuts a network
   round-trip from new-session latency.

**Tier 2 — real payoff, worth deliberate scheduling:**

6. Give the Services-relationship rebuild an incremental mode and internal yield points (§1.5) — stands
   alone as a pure performance fix; the review's single highest-severity finding.
7. Make `graph_state` emission delta-aware instead of always sending the full node/edge arrays (§1.5) —
   pairs naturally with #6, same rebuild path.
8. Give both render-heavy stores (Map + chat) field-level selectors and apply `React.memo` to the
   camera-/stream-independent panels (§1.6, §1.7) — do the Map first (higher severity, and `MinimapDots`
   already proves the pattern works in that exact file).
9. Back `graph-indexer.ts`'s `_applyDirty` corpus-membership checks with a `Set` instead of array
   `indexOf`/`splice` (§1.5).
10. Make a deliberate per-view call on `retainContextWhenHidden` instead of the current blanket `true`
    across all 5 sidebar webviews (§1.1).

**Tier 3 — good hygiene, low urgency:**

11. Bound `git_op`/`shell_run` tool output before the stringify-then-cap step, matching the discipline other
    tools already have via schema limits (§1.3).
12. Give `invokeBedrockEmbedding` a default timeout when no `AbortSignal` is supplied (§1.4).
13. Route `model-fetcher.ts`/`bedrock-models.ts` through the existing `retryAsync` (§1.4) — infrastructure
    already exists, this is a call-site change.
14. Defer the SQLite database open behind `setTimeout`, matching its two siblings in the same file (§1.4).
15. Add rotation to `.blacksite/execution.log`/`.jsonl` (§1.3).

---

## 2. Code-change review experience

*Requested mid-review: make the diff-review flow cleaner and more engaging, keep it visually consistent
with the rest of the extension's "living" language (the Map's bloom/shimmer, the chat's breathing status
dots), and explore surfacing the agent's reasoning + letting the user ask about a diff directly.
Last verified: 2026-07-22, by direct reading of the full approval pipeline.*

### 2.1 How a code change is reviewed today (as-built, traced end to end)

1. The agent calls `file_edit` / `file_edit_batch` / `json_edit` (schemas in `src/tools/definitions.ts`).
   These schemas take **only** `path`, `oldString`/`newString` (or JSON-pointer operations), `replaceAll`,
   `expectedReplacements` — there is no field anywhere for the model to attach *why* it's making the change.
2. `DiffEditService` (`src/diff-edit-service.ts`) validates and builds a `vscode.WorkspaceEdit`, then hands
   it to the shared `WorkspaceEditApplier.apply()` (`src/workspace-edit-applier.ts:76-84`).
3. `WorkspaceEditApplier._previewAndConfirm()` (`src/workspace-edit-applier.ts:174-228`) does two things
   **in parallel, on two disconnected UI surfaces**:
   - Opens up to `MAX_PREVIEW_DIFFS = 6` (`workspace-edit-applier.ts:26`) **native VS Code diff editor
     tabs** via `vscode.commands.executeCommand("vscode.diff", ...)` (`workspace-edit-applier.ts:187`),
     comparing the live document against a virtual `blacksite-proposed:` document. These are real,
     non-preview tabs that briefly occupy the main editor area, and are force-closed the instant a decision
     is made (`_closeProposedDiffs()`, `workspace-edit-applier.ts:230-235`) — win or lose, they vanish.
   - Calls the registered `EditApprovalProvider` — wired in `chat-provider.ts:546` to
     `_requestEditApproval()` (`chat-provider.ts:3482-3498`), which posts a `stream_approval_pending`
     message into the chat webview with **only a plain-text summary string**
     (`"Apply changes to N file(s)\n\n<path> — <k> edit(s)\n..."`, built at `chat-provider.ts:3486`) — no
     diff content, no line-level detail beyond the edit count.
4. The webview renders that as an inline card (`ApprovalActions` / `ApprovalButtons` in
   `src/webview/react/components/chat/ToolLog.tsx:150-192`) — a text description plus
   Approve / Approve-all / Always-allow / Deny buttons. It never renders a diff; the only diff *content* a
   user ever sees lives in the native tabs from step 3, which are gone the moment they click a button.
5. After acceptance, the completed tool call's persisted result is the mechanical `EditResult` shape
   (`{ ok, path, replacements, diagnostics }` — see `diff-edit-service.ts:32-34`) — no patch/diff is
   retained. Scrolling back through a chat transcript later shows *that* N replacements happened in a file,
   never *what* changed or *why*.

### 2.2 What this means in practice

- **The decision and the content live in two different places at the same time.** To actually read what
  you're approving, you have to glance away from the chat panel to editor tabs that VS Code opened on your
  behalf and will delete out from under you the moment you answer. That's a context switch on every single
  edit, several times a session.
- **The moment of highest attention (approving a file change) is the one moment styled entirely by generic
  VS Code chrome** — a native modal-style diff tab with no relationship to Blacksite's dark palette, motion
  language, or signal/tone system that every other surface in the extension uses. It's the one place the
  "living code" feeling currently breaks.
- **There is no "why" anywhere in the data model.** Not because it's hidden — it's genuinely never
  captured. The model's rationale for an edit exists only as loose prose somewhere earlier in the chat
  turn, with no structural link from that prose to the specific edit it explains. A user who wants "why did
  it do this" has to scroll up and guess which sentence matches which diff.
- **Nothing is replayable.** Once a diff is approved (or rejected), its content is gone. There's no
  "what did that edit actually do" affordance later in the transcript short of opening source control
  separately.

### 2.3 Proposed direction (small, additive, no loss of capability)

None of these require removing the native-diff-tab path — it stays available as a power-user "open full
diff editor" escape hatch (its side-by-side editing and familiarity are real value for large/complex diffs).
The proposal is to make the **in-chat card** the primary, sufficient surface for the common case, rather
than a thin wrapper around a decision that's really being made somewhere else.

1. **Render diff content in the approval card itself**, reusing infrastructure that already exists rather
   than inventing new machinery: `ToolLog.tsx` already has a JSON tokenizer/highlighter
   (`tokenizeJson`, `src/webview/react/lib/json-highlight.ts`, used at `ToolLog.tsx:12`) and the tone/chip
   system (`signal.tsx`) used throughout. A compact unified-diff view (colored +/- lines, per-file
   additions/deletions counts as `Chip`s — the same `Chip` component already used for approval counts at
   `ToolLog.tsx:390`) would let most edits be reviewed and approved without ever leaving the chat panel.
   Reserve the native diff tabs for edits over some size threshold, or behind an explicit
   "Open in Diff Editor" button on the card for anyone who wants the full editor.
2. **Give the pending-approval state the same "alive" treatment as the rest of the UI.** `theme.css`
   already has the exact visual vocabulary for this — `live-action-ping`/`live-action-sweep`
   (`theme.css:2363-2374`, a soft pulse + sheen already used for in-flight tool calls) and
   `welcome-orb-breathe` (`theme.css:2405-2409`, a breathing glow). Applying the same pulse language to a
   pending edit card (rather than the current static border) would make "this needs your attention" read
   as part of the same living system as everything else, instead of a plain form waiting for input.
3. **Persist a compact diff/patch summary on the completed `ToolCall` result**, not just the replacement
   count, so scrolling back through history still shows *what* changed. This is additive to the existing
   `EditResult` shape, not a replacement of it.
4. **Add an optional, structured rationale field to the edit tool schemas** — `file_edit`, `file_edit_batch`,
   `json_edit` in `src/tools/definitions.ts` currently have no such field (confirmed by reading their full
   parameter schemas). A small additive parameter (e.g. `rationale: str("One sentence: why this change,
   in relation to the current task")`) costs nothing to existing behavior — models that don't populate it
   behave exactly as today — but gives the UI a structural place to show a "Why" line directly under the
   diff, instead of asking the user to reconstruct it from surrounding chat prose. This directly answers
   the "surface the agent's reasoning" ask and is the cheapest possible version of it (one optional string).
5. **Add an explicit "Explain this diff" affordance** on both the pending-approval card and the completed
   edit entry. The codebase already has this *exact* interaction pattern for editor selections —
   `blacksite.explainSelection` (`extension.ts:288-297`) calls `chatProvider.injectContext(text, label)`
   and focuses chat. An "Explain this diff" button would do the same thing with the diff hunk (plus,
   if 4 lands, its rationale) as the injected context, asking the model to walk through the specific
   change — the "interaction option to request an explanation specifically in relation to the diff" asked
   for. This is a reuse of an established pattern, not a new subsystem.

### 2.4 Suggested sequencing

Roughly cheapest-and-most-isolated first, since each is independently shippable:
1. §2.3.2 (pulse/glow treatment on the pending card) — pure CSS, zero data-model change, immediately
   visible "living" win.
2. §2.3.4 (optional `rationale` schema field) — additive schema change, no UI required yet to land it; the
   model can start populating it before the UI consumes it.
3. §2.3.1 (inline diff rendering in the card) — the biggest single UX win, moderate effort (diff formatting
   + a compact renderer using already-existing tokenization/tone components).
4. §2.3.3 (persist diff summary on completed calls) — pairs naturally with 3 since you'd already have the
   formatted diff in hand at approval time.
5. §2.3.5 ("Explain this diff") — straightforward once 3/4 exist to source content from; trivial if built
   directly on the existing `injectContext` path.

---

## 3. File-size & split-difficulty catalog

### 3.1 Top 50 largest files

Mechanical inventory (`src/**/*.{ts,tsx,js,jsx,css}`, line count via `wc -l`). Purpose/responsibilities/
split-difficulty columns filled in from the subsystem reviews as they land.

| # | File | Lines | Purpose | Split difficulty |
|---|------|------:|---------|-------------------|
| 1 | `src/agent-session.ts` | 5718 | The agent run/turn loop: tool dispatch, streaming across 4 provider protocols (Anthropic/Bedrock Converse/Bedrock Mantle/OpenAI+Responses), compaction, checkpointing, message-format conversion | **Very High** — see [§3.2](#32-top-5-most-congested--deep-dives) |
| 2 | `src/chat-provider.ts` | 3607 | Webview provider: settings, `AgentSession` wiring, ~60-case message dispatch, attachment ingestion, streaming translation, model-catalog fetch | **Very High** — see [§3.2](#32-top-5-most-congested--deep-dives) |
| 3 | `src/webview/react/apps/graph/GraphApp.tsx` | 2536 | Top-level Map React component: search, minimap, 3 inspector-card variants, control rail, legend, LSP-onboarding panel | Medium, despite being the #3-largest file in the extension — almost every piece is a self-contained, props-only component, not shared state (file-length congestion, not entanglement — see §1.6) |
| 4 | `src/webview/react/theme.css` | 2459 | Design-token/style sheet shared by all 6 webview apps — see §1.1/§1.2 | Low-Medium — well-segmented by feature-area comment banners; splitting is a packaging change (see §1.1), not an untangling job |
| 5 | `src/webview/react/apps/graph/scene/renderer.ts` | 2411 | pixi.js v8 scene owner: WebGL lifecycle, sprite/texture management, camera/interaction state machine, animation ticker | **Very High** — see [§3.2](#32-top-5-most-congested--deep-dives) |
| 6 | `src/graph/relationship-indexer.ts` | 2407 | Cross-service relationship detection: ~10 language/framework API-provider and HTTP-client-consumer detectors, matched/scored/ranked into graph edges | Medium overall, **High** core — see [§3.2](#32-top-5-most-congested--deep-dives) |
| 7 | `src/planning-store.ts` | 1955 | Durable plan/phase/step/doc + ad-hoc todo-run store, normalization, prompt-summary formatting | Medium overall, High pocket in `updatePlan` (~300-line flat mutation dispatch) — runner-up, see §1.4 |
| 8 | `src/tools/definitions.ts` | 1924 | ~140 tool schemas (19 family arrays) + validation/coercion/typo-correction for the agent's tool-calling surface | Low — declarative data + independent pure functions; family arrays don't reference each other |
| 9 | `src/webview/react/lib/graph/view-model.ts` | 1701 | Pure reducer + derived-state/query library for the Map: filtering, search, clustering, service-graph derivation, edge bundling, label math | Medium — no shared mutable state (all pure functions), but bundles 5-6 distinct sub-domains in file-written order and duplicates a union-find implementation that should be shared |
| 10 | `src/lsp-service.ts` | 1557 | Agent-facing code-intelligence dispatch: symbols/navigate/hierarchy/hover/diagnostics/rename/actions/format/inlayHints over VS Code's language-provider APIs | Medium — 5 sibling concerns already extracted to `src/lsp/*.ts`; `_actions` (183 lines, code-actions+edits+commands+receipts interleaved) is the one High-leaning pocket |
| 11 | `src/graph/graph-indexer.ts` | 1182 | Host orchestrator for the Map: file enumeration, import-scan driving, layout, cache persistence, incremental workspace watching | **High** — runner-up, see [§3.2](#32-top-5-most-congested--deep-dives) |
| 12 | `src/graph/layout.ts` | 982 | Seeded d3-force layout (small/medium graphs) + linear-time phyllotaxis packing fallback (large graphs) | Low-Medium — two cleanly-dispatched modes, no shared mutable state; already well-factored internally |
| 13 | `src/graph/project-topology.ts` | 919 | Manifest parsing across 8 build ecosystems (npm/.NET/Maven/Gradle/Go/Cargo/Python/Bazel) into a cross-ecosystem project graph | Low — one function per ecosystem, identical signature, zero cross-coupling |
| 14 | `src/webview/react/lib/store.ts` | 912 | Central chat-webview store: message-bridge reducer (~30 incoming types) + ~60 actions incl. all provider-setting mutations | High — runner-up, see §1.7 and [§3.2](#32-top-5-most-congested--deep-dives) |
| 15 | `src/graph/resolve-imports.ts` | 818 | ~20 independent per-language specifier→file resolvers, one dispatcher | Low — nearly every resolver fully independent, shares only small tie-break helpers |
| 16 | `src/webview/react/lib/chat-model.ts` | 796 | Plain-data conversation model: types, constructors, streaming mutators, memory-bound guards, history-restore, derived selectors | Medium — mostly pure functions on parameters (not closures), but shared `Turn`/`ChatState` types are imported by name across the chat UI |
| 17 | `src/webview/react/lib/tool-presentation.ts` | 665 | Pure toolName→label/preview/state formatters (4 near-parallel switches over the same ~45 tool names) | Low — every function pure/stateless; real but minor cross-switch repetition of the same tool taxonomy |
| 18 | `src/workspace-context.ts` | 663 | Builds the per-turn "workspace state" prompt block + static system prompt + selection/file/diagnostic context helpers | Low — independent top-level functions on plain data, no shared mutable state (see §1.3 for a responsiveness finding here) |
| 19 | `src/webview/react/apps/planning/PlanningApp.tsx` | 651 | Standalone Planning webview: ~15 presentational subcomponents + status helpers + root state/message-handling | Low — file-length congestion (component density), not behavioral coupling; every subcomponent is plain-props |
| 20 | `src/webview/react/lib/format.ts` | 593 | Formatting helpers: byte/duration/token/cost/time, tool-name taxonomy, an O(m·n) LCS diff engine, tool-change presentation | Low — nearly every export pure/independent; diff block and tool-taxonomy block are the two natural seams |
| 21 | `src/diff-edit-service.ts` | 579 | Surgical exact-string / batch / JSON-pointer edits — validation + resolution; delegates preview/approval/apply to `WorkspaceEditApplier` (see §2.1) | Low-Medium — the whitespace/EOL/gutter-tolerant matching engine (lines 364-579) is pure and independent of the class, a near copy-paste move; the class itself is cohesive around one job |
| 22 | `src/webview/react/components/chat/InputDock.tsx` | 570 | Composer: mention/slash-command autocomplete, attachments (drag/drop/paste), blueprint prompts, send/queue/cancel | Medium — mention + slash autocomplete are entangled in one `onKeyDown`; attachment helpers are already independent |
| 23 | `src/graph/import-scan.ts` | 563 | Pure regex-based import/reference extraction, one collector per language, dispatched centrally | Low — independent per-language regex constants + small collectors; `scanWindows` already handles oversized files well |
| 24 | `src/graph-provider.ts` | 559 | Map webview `WebviewViewProvider`: IPC boundary, on-demand LSP symbol expansion, live agent-activity trace forwarding | Medium — `_expandSymbols` and live-activity forwarding are extractable; core state-wiring should stay together |
| 25 | `src/data-provider.ts` | 513 | Bootstraps the embedded SQLite data workbench + `WebviewViewProvider` for the Data view (query editor, table preview, vector search, pgvector-sidecar management) | Medium — the vector-backend-switching logic (container detection, sidecar readiness, pgvector client lifecycle) is stateful but weakly coupled to the rest; a clean `VectorBackendController` extraction |
| 26 | `src/model-fetcher.ts` | 501 | Live model-catalog fetching (Anthropic/OpenRouter/OpenAI) + static fallback tables, pricing, context/output-limit resolution | Low — no class, no shared mutable state; already organized into independent, banner-delimited per-provider sections |
| 27 | `src/update-service.ts` | 496 | GitHub-releases self-update flow: startup/manual check, VSIX download, CLI-driven install | Low — pure parsing/comparison utilities are already zero-coupled to the class; already well-hardened (see §1.4) |
| 28 | `src/bedrock-client.ts` | 485 | AWS Bedrock wire protocol: SigV4 signing, Converse/Mantle request building, streaming event-frame decoding, embeddings | Low — no class, no shared state; independent pure-function clusters (signing/request-building/stream-decoding/embeddings), several already exported for fuzz-testing |
| 29 | `src/graph-annotation-store.ts` | 442 | Durable user/agent Map-note store (`.blacksite/graph.json`) + `map_note_*` agent-tool dispatch | Low — cohesive single-purpose store, hard-capped at 500 annotations regardless of workspace size |
| 30 | `src/graph/graph-model.ts` | 432 | Shared pure data model (`GraphNode`/`GraphEdge`/`GraphSnapshot`) + path utilities + adaptive clustering algorithm | Low — independent pure functions/types; foundational (imported everywhere) so low-risk but also low-necessity to split |
| 31 | `src/webview/react/apps/graph/store.ts` | 424 | Map webview state store: `GraphViewState`+`Camera`, host-message ingestion, `localStorage` persistence (prefs/camera/saved-views), ~30 actions | Low — persistence helpers are already near-independent of the actions block; the `state`/`bump`/`listeners` core is legitimate shared-store coupling, not incidental |
| 32 | `src/webview/react/components/chat/ToolLog.tsx` | 422 | Renders the tool-call log, including the edit-approval card (see §2.1) | Low — genuinely cohesive single-purpose file; clean `ToolLog → ToolGroup → ToolEntry → DetailCard` props-only tree |
| 33 | `src/extension.ts` | 421 | Activation entry point — DI wiring for all stores/providers/webviews, command registration, config-driven policy sync | Low — already clean: mostly flat command registrations and constructor wiring, minimal internal logic to untangle. Not a congestion candidate. |
| 34 | `src/webview/react/components/settings/SubagentPanel.tsx` | 395 | Subagent settings: provider/model override, concurrency, builtin+user profile library | Low — 5 clean pieces, only the root touches the store |
| 35 | `src/webview/react/lib/protocol.ts` | 391 | The **chat panel's** (chat/history/settings) postMessage contract — confirmed not a cross-webview protocol; Planning/Notes/Map each define their own | Low — pure type declarations, zero runtime cost; ~10 importers means a split needs a re-export barrel |
| 36 | `src/webview/react/components/chat/QuestionCard.tsx` | 385 | Resolved question-card UI (transcript + docked PendingBar): option selection, paging, submit/decline | Low — clean tree, props-only coupling |
| 37 | `src/graph/client-config.ts` | 357 | Parses .env/docker-compose/K8s/appsettings/nginx/CRA-proxy config into a client-config index for relationship verification | Low — one parser per format behind a small dispatcher, sharing only the index type |
| 38 | `src/webview/react/apps/notes/NotesApp.tsx` | 356 | Standalone Map-Notes-timeline webview: filterable, day-grouped annotation history with per-file git drawers | Low — props-only tree; already correctly `useMemo`'d filter/group logic (see §1.7) |
| 39 | `src/provider-retry.ts` | 343 | Shared transient-failure toolkit: error classification, typed error carriers, backoff computation, `retryAsync`, context-overflow/output-limit classifiers | Low — "the textbook example of a well-sized module in this codebase" per its reviewer; no congestion signal at all |
| 40 | `src/bedrock-models.ts` | 342 | Live Bedrock model listing (foundation models + inference profiles) mapped to the shared `ModelInfo` picker shape | Low — no class, no shared state; mapping/listing/sorting already independent small functions |
| 41 | `src/post-edit-diagnostics.ts` | 339 | Post-edit diagnostic collection: baseline capture, before/after delta, debounced quiescence wait for the LSP to settle | Low — tight, already well-scoped independent functions, no shared mutable state |
| 42 | `src/workspace-edit-applier.ts` | 327 | Shared preview/approval/version-check/apply/save primitive for every `vscode.WorkspaceEdit` in the extension (see §2.1) | Low-Medium — one cohesive class around one job; nested `ProposedContentProvider` (lines 28-43) is a clean, low-risk extraction if ever worth doing |
| 43 | `src/data/legacy-import.ts` | 317 | One-time idempotent projection of legacy `.blacksite/*` JSON/markdown artifacts into relational `core_*` tables | Low — arguably already at the practical floor; four fully independent parsers, already gated to run once per workspace |
| 44 | `src/webview/react/components/settings/ModelPickerList.tsx` | 314 | Shared reusable model-browser widget (search + org/capability filter chips + sort), used by Settings and SubagentPanel | Low — already a well-factored, reusable leaf component; correctly `useMemo`'d |
| 45 | `src/agent-memory-index.ts` | 314 | Semantic memory index (tool calls, transcript chunks, memory notes) via `VectorStore` + `EmbeddingService` | Low — one class, but its 3 "collections" are clearly parallel index+search pairs, not entangled state |
| 46 | `src/webview/react/components/chat/QuickSettings.tsx` | 312 | Docked chip row: model switcher, temperature popover, thinking-budget/reasoning-effort/flex-tier controls | Low — model-switcher and temperature popovers already independent blocks within one component |
| 47 | `src/graph-agent-gateway.ts` | 308 | Agent-facing dispatch for `graph.*` tool calls (map_overview/map_relationships/map_note_* CRUD) | Low — thin 3-method router; ~2/3 of the file is already free formatting functions with no class coupling |
| 48 | `src/execution-logger.ts` | 302 | Agent execution telemetry → OutputChannel + human-readable `.log` + machine-readable `.jsonl` | Low — single-purpose class; its long event-switch is a 1:1 match with `AgentEvent`'s variant count, not accidental complexity |
| 49 | `src/webview/react/components/settings/GenerationPanel.tsx` | 300 | Full Settings "Generation" tab: ~13 independently-gated capability rows (thinking, reasoning effort, service tier, cache TTL, …) | Low — genuinely one settings form; each field block fully independent, no shared local state |
| 50 | `src/base-context-store.ts` | 286 | Durable, user-curated "Base Context" topics (title/notes/attached-file snippets) + prompt-summary formatter | Low — good-sized single-purpose store mirroring `planning-store.ts`'s shape at roughly a seventh of the size; no sub-clusters worth extracting |

**Total across these 50 files:** ~46,600 lines (of ~64,600 across all 219 `src` source files — the top 50
account for roughly 72% of total line volume, i.e. size is concentrated, not evenly spread).

### 3.2 Top 5 most congested — deep dives

**Selection method:** all 50 files in §3.1 were rated independently on the same Low/Medium/High/Very High
rubric ([§ methodology](#how-this-review-was-done)). The 5 below are the files where size **and** rated
congestion **and** real responsiveness stakes line up — not simply the 5 largest files. Two deliberate
exclusions worth stating plainly: `theme.css` (#4 by size) and `GraphApp.tsx` (#3 by size, larger than
`renderer.ts`) both rated Low/Medium — large by surface area, not by entanglement — and are covered in
§1.1/§1.6 instead of here. Three files were genuine runners-up and are worth a follow-up pass once the
5 below are underway: `planning-store.ts` (Medium overall, High in its ~300-line `updatePlan` method),
`webview/react/lib/store.ts` (High overall, but at 912 lines and with its worst finding topping out at
"medium" severity, the smallest-stakes of the High-rated files), and `lsp-service.ts` (Medium, with 5
sibling concerns already proven extractable by precedent).

Every option below is an internal restructuring with **no intended behavior change** — nothing here
proposes removing a capability, a provider, a language detector, or a visual feature. Each file's remedy
menu is ordered cheapest/safest first; treat the later options as available, not urgent.

---

#### 1. `src/agent-session.ts` — 5718 lines — Very High

**Why it's here:** the largest file in the extension by a wide margin, and independently rated Very High
by the same rubric applied to all 50 — one class spanning ~3450 lines with dozens of instance fields that
most of its methods read or write, wrapped around one central state machine. `send()` alone — the main turn
loop — is ~1100 lines and inlines tool dispatch, approval gating, subagent-lane grouping, compaction
triggers, and continuation recovery.

**What's tangled together:** session/checkpoint state management; the main turn loop; tool dispatch (a
large inline routing chain across ~30 runtime types); approval- and question-card-gate integration;
compaction orchestration (background vs. blocking, circuit breaker, emergency shedding); **five** separate
provider HTTP-streaming implementations (Anthropic, Bedrock Converse, Bedrock Mantle, OpenAI, OpenAI
Responses API), each with its own SSE/event-frame parser; bidirectional message-format conversion between
the internal model and every wire format; thinking/reasoning-effort planning per provider dialect;
prompt-cache breakpoint placement; tool-result capping/paging; duplicate-tool-round loop detection;
subagent lane orchestration; strict-tool-schema conversion.

**Test-coverage reality check:** genuinely strong — **16 dedicated spec files, ~3362 lines of tests**,
covering almost exactly the seams identified below: compaction (2 specs), disabled-tools, long-horizon runs,
mid-stream retry, note-enforcement, pairing-and-caching, the Responses API path, service-tier fallback,
stall-nudge, subagent-plan-link, summarize-result, token-truncation, tool-output-paging, workspace-context,
plus a dedicated soak test. This meaningfully de-risks extraction here relative to the other files below —
most proposed seams already have a behavioral safety net.

**Remediation options, cheapest to most involved:**
1. **Near-zero risk — move the pure message-conversion functions.** The block at the bottom of the file
   (`toOpenAIMessages`, `toBedrockMessages`, `toResponsesInputItems`, cache-breakpoint helpers,
   `toStrictToolSchema`, stop-reason normalizers — roughly lines 4548-5470) already takes no `this`. This
   is a same-day move to `provider-wire-formats.ts` that shrinks the file by ~900 lines with essentially no
   behavioral risk.
2. **Medium risk — extract the compaction subsystem.** Lines 1959-2169 plus ~10 related fields are already
   cohesive and talk to the rest of the class through a small surface — a plausible `CompactionController`.
   Every `send()` call site touching it would need updating, but the compaction test suite exists
   specifically to catch regressions here.
3. **Medium risk — one class per provider behind a shared interface.** The five streaming methods
   (`_streamTurnAnthropic`, `_streamTurnBedrock`, `_streamTurnBedrockMantle`, `_streamTurnOpenAI`,
   `_streamTurnOpenAIResponses`, plus their SSE parsers, roughly lines 3424-4439) already communicate via a
   normalized `ProviderTurnStreamEvent`, but each closes over `this.opts`/`this._planThinking()`/session
   flags — extraction needs a small injected context object, not just a file move.
4. **Leave `send()` itself for last, and expect to shrink around it rather than flatten it.** The main loop
   is exactly the rubric's "interleaved state machine" case — tool dispatch, gating, subagent grouping, and
   recovery are sequenced inline for real reasons (ordering matters). The realistic goal is reducing what
   `send()` has to orchestrate directly (by options 1-3 above succeeding first), not rewriting the loop.

**Suggested sequencing:** 1 → 3 → 2, letting `send()`'s line count fall out as a side effect rather than
attacking it directly.

---

#### 2. `src/chat-provider.ts` — 3607 lines — Very High

**Why it's here:** the second-largest file in the extension, independently rated Very High — one class with
~90 methods and several long-lived `Map`s (`_pendingQuestionCards`, `_pendingApprovals`,
`_liveSubagentSessions`, `_modelCache`, `_pendingAttachments`).

**What's tangled together:** webview lifecycle and postMessage plumbing; settings schema read/write/
migration across 4 providers (~20 fields each); `AgentSession` construction (`_createSession` assembles a
~50-field options object); delegated-lane orchestration (`_runDelegatedLane` builds and runs a second,
child `AgentSession`); the entire webview message dispatch (`_onMessage`, ~715 lines, ~60 `case`s);
attachment ingestion (images/audio/documents/data/archives, including Jimp downscaling, decompression-bomb
protection, and audio transcription); streaming-event translation; model-catalog fetching/pricing; session
persistence; question-card/approval-gate bookkeeping; a hand-rolled one-shot "assistant text" helper
duplicated across all 4 providers.

**Test-coverage reality check — the key asymmetry versus `agent-session.ts`:** only **one** dedicated spec,
`chat-provider.image-guards.spec.ts` (66 lines) — thin relative to the file's size and Very-High rating.
Unlike `agent-session.ts`, most of this file's behavior (settings migration, the 60-case dispatch,
attachment ingestion) currently has no automated safety net. **Treat this as the reason to sequence
differently here:** write characterization tests for whichever piece is extracted first, before extracting
it — don't rely on "it compiled" the way the compaction extraction above can partly rely on existing specs.

**Remediation options, cheapest to most involved:**
1. **Low risk, and fixes a §1.3 responsiveness finding for free — extract attachment ingestion.**
   `classifyAttachment`, `probePngDimensions`, `_buildAttachmentImageBlocks`,
   `_buildAttachmentVisionFallbackNotes`, `_buildAttachmentAudioNotes`, `_transcribeAudioAttachment`,
   `_ingestAttachment`, `_handleRequestAttachFiles` (~330 lines) are already near-self-contained, needing
   only `_referenceStore`/`_database`/`_secrets`/`_post` as constructor deps. Since this is the same code
   §1.3 flags for sequential (rather than concurrent) image downscaling, doing the extraction and the
   concurrency fix together is more efficient than two separate passes.
2. **Low-medium risk — extract settings plumbing.** `_readSettings`/`_writeSettings`/`_providerSettings`/
   `_defaultProviderSettings`/`_openrouterProviderPreferences`/`_syncVisibleSettingsToConfig`
   (~150 lines) are already near-isolated to `globalState`/`vscode.workspace.getConfiguration` — a clean
   `SettingsStore` candidate.
3. **Medium risk, biggest single win — restructure `_onMessage`.** Most of its ~60 cases share one shape
   ("validate payload → mutate settings → `_writeSettings` → reset session"). Grouping these into a handful
   of per-topic handlers (settings mutation, attachments, session history, subagent config) behind a
   slimmer dispatch table is the largest available line-count reduction in the file — but write tests for
   the cases being moved first, per the coverage gap above.
4. **Not recommended — `_createSession`/`_runDelegatedLane`.** Their length is essentially the number of
   fields `AgentSessionOptions` accepts, not excess responsibility; shrinking them further would likely
   relocate complexity rather than reduce it.

**Suggested sequencing:** write a handful of characterization tests for whichever of 1/2 you start with,
then 1 → 2 → 3. Skip 4.

---

#### 3. `src/webview/react/apps/graph/scene/renderer.ts` — 2411 lines — Very High

**Why it's here:** independently rated Very High by its reviewer as matching the rubric's hardest category
"almost exactly" — ~30 shared mutable closure bindings (`view`, `camera`, `stateDirty`, `cameraDirty`, ~15
id-keyed `Map`s) read and/or written by roughly 45 nested functions, with no dependency-injection boundary:
every helper closes over the same top-level bindings rather than taking them as parameters.

**What's tangled together:** WebGL/pixi app lifecycle and texture baking; scene-graph assembly; the
structural-rebuild pipeline (`rebuildNodes`, `rebuildSymbols`); the camera/interaction state machine; five
distinct per-frame animation sub-layers (general motion easing, the agent-activity shimmer trace, ambient
relationship/symbol-relation pulses, the focus ring, live-activity rings); viewport-culling/LOD policy; and
the public `GraphRenderer` command surface, all sharing one factory closure.

**Test-coverage reality check — the most important caveat in this whole section:** there is **no dedicated
`renderer.spec.ts`**. Several of the pure logic modules it depends on are tested (`graph-motion.spec.ts`
79 lines, `graph-canvas-navigation.spec.ts` 206 lines, `graph-live-activity.spec.ts` 92 lines,
`graph-traces.spec.ts` 147 lines) — modest but real coverage of the *helpers*. The renderer's own
orchestration (`frame()`'s dispatch, `rebuildNodes()`, `motionPass()`) is inherently hard to unit-test
imperative pixi/WebGL code and appears to have no direct automated coverage at all. **Manual/visual QA is
load-bearing for any change here** — automated tests will not catch a dropped frame, a wrong z-order, or a
sprite that fails to clean up.

**Remediation options, cheapest to most involved:**
1. **Near-zero risk — move the 6 pure texture factories** (`makeGlowTexture`, `makeBadgeDotTexture`, etc.,
   ~100 lines) to `scene/textures.ts`. Zero closure coupling, verifiable by visual inspection alone.
2. **Near-zero risk — move the pure drawing primitives** (`drawDashedLine`, `drawRoundedPolygon`,
   `traceEdgeArc`) to `scene/draw-primitives.ts`. Same shape as #1.
3. **The real fix, and a prerequisite for anything past this — introduce an explicit `RendererState`
   object.** Move the ~30 closure variables into one object threaded as a parameter through the functions
   that need it, instead of implicitly closed over. This is a genuine refactor, not a file move, and
   nothing below it should be attempted first.
4. **Defer — do not split `frame()`/`rebuildNodes()`/`drawEdges()`/`motionPass()` into separate files
   before #3 lands.** They currently only work because they all share one closure; splitting them earlier
   would just relocate the coupling, not remove it.

**Suggested sequencing:** 1 and 2 anytime, independently, low-stakes. Treat 3 as a deliberate,
well-resourced effort rather than something to slot into a spare afternoon — and consider using the §1.6
`structureChanged`-on-select/search finding (a real bug: search and selection trigger the same full rebuild
as an actual topology change) as the first slice of that work, since fixing it properly requires exactly
the finer-grained dirty-state model that #3 would formalize anyway. That gives the refactor a concrete,
testable-by-hand acceptance criterion instead of being restructuring for its own sake.

---

#### 4. `src/graph/graph-indexer.ts` — 1182 lines — High

**Why it's here:** rated High overall (not just in one pocket) — a single class with 15+ private methods
sharing significant mutable instance state (`_snapshot`, `_indexedFiles`, `_indexedImportEdges`,
`_corpusFiles`, `_cachedResolveCtx`, `_cachedTopology`). The class's own comments document a past bug class
from exactly this coupling (the `_effectiveMaxRenderedStars` field's doc explains how a naive change would
silently break the incremental path) — this is a file that has already bitten the team once.

**What's tangled together:** file enumeration/discovery with exclude globs and profile auto-escalation;
import-scan orchestration; resolve-context construction (a full variant and a separately-maintained,
carefully-reduced incremental variant); project-topology and git-stats orchestration; full-rebuild
orchestration (`_rebuildOnce`, the largest method); incremental-update orchestration (`_applyDirty`, a
parallel, partially-duplicated path); cache read/write with schema versioning; filesystem watching.

**Test-coverage reality check:** only one dedicated spec, `graph-indexer-capacity.spec.ts` (42 lines — thin,
mostly profile/cap logic), but the *inputs* to this class are extensively tested elsewhere (file-discovery,
corpus, tsconfig-paths, go-modules, python/php index, workspace-roots — dozens of adjacent specs). The
orchestrator's own `_rebuildOnce`/`_applyDirty` control flow — where the documented past bug lived — has
thin direct coverage.

**Remediation options, cheapest to most involved:**
1. **Zero risk — the free-standing exports.** `autoEscalatedProfile` and `renderedImportProjection` are
   already independent functions; move any time.
2. **Low-medium risk — extract the resolve-context builders.** `_loadTsAliases`/`_loadGoModules`/
   `_loadCSharpIndex`/`_loadPhpIndex`/`_loadPythonIndex`/`_loadPyReExports` (~225 lines) into free functions
   taking `(roots, fileSet)` — each already has good per-ecosystem test coverage from the adjacent specs
   above, which lowers the risk here specifically.
3. **Low-medium risk — extract cache I/O** (`_cachePath`/`normalizeCache`/`_writeCache`/`_writeCorpus`)
   into `graph-cache.ts`.
4. **The one place to slow down — `_rebuildOnce`/`_applyDirty`.** This is both where the documented past
   bug lived *and* where the §1.5 performance findings live (array-based `_corpusFiles` membership checks
   costing O(corpus) per dirty file; full edge-array rescans for degree bookkeeping; always-full,
   never-incremental `graph_state` emission). That overlap is useful: fixing the §1.5 performance findings
   **is** the first safe, narrowly-scoped increment of untangling this method, because it comes with a
   concrete, testable goal ("dirty-file updates should cost O(dirty), not O(corpus)") rather than being an
   open-ended cleanup.

**Suggested sequencing:** 1-3 any time. Write characterization tests around `_applyDirty`'s current
dirty-file behavior, then tackle the §1.5 performance findings as the real first pass through #4 — that
work and the structural untangling are the same work, not two separate projects.

---

#### 5. `src/graph/relationship-indexer.ts` — 2407 lines — Medium overall, High core

**Why it's here:** the #6 largest file in the extension, and while its overall rating is Medium (roughly
60% of it — the per-language provider/consumer collectors — is already cleanly factored into small, pure,
independent functions), its ~500-line matching/scoring/ranking core (`buildServiceRelationships`,
`ProviderIndex`, path-shape matching, confidence functions) is genuinely High-difficulty and tightly tuned.
More importantly, this file anchors the **single highest-severity finding in the entire review**: the
Services-lens rebuild has no incremental mode and no internal yield points, so it can re-scan the entire
corpus synchronously on nearly every save (§1.5).

**What's tangled together:** service-boundary detection; API-provider extraction across ~10
languages/frameworks (OpenAPI, gRPC, GraphQL, ASP.NET, NestJS/Express/Flask/FastAPI/Django, Go, Spring/
JAX-RS, Laravel/Slim/Symfony, actix/Rocket/axum); API-consumer extraction across ~7 client libraries;
client-config cross-referencing; event pub/sub and SQL/ORM data-signal extraction; a path-shape parsing/
alignment engine; candidate ranking and confidence scoring; a bespoke inverted/blocking index
(`ProviderIndex`) keeping matching sub-quadratic; router-mount prefix propagation; top-level orchestration.

**Test-coverage reality check — the best-tested file of the runner-up tier:** `graph-relationships.spec.ts`
is **1367 lines** — substantial, real behavioral coverage of exactly the matching/scoring engine that's
rated High-difficulty. This is a meaningfully stronger safety net than `graph-indexer.ts` or `renderer.ts`
have for their respective hard cores.

**Remediation options, cheapest to most involved — note the order here is deliberately different from the
other four files, because the highest-value change isn't a structural split:**
1. **Do this first, and treat it as higher priority than any file-organization work below:** give
   `buildServiceRelationships` (or its caller, `relationship-snapshot.ts`) an incremental mode that only
   re-scans dirty files' signals and merges them into the retained set — mirroring what
   `graph-indexer.ts`'s `_applyDirty` already does for imports — and/or add periodic yield points inside
   the per-file loop so a full pass can't monopolize the event loop even when one is genuinely needed. This
   is a performance fix, not a refactor, but it matters more than anything else identified for this file.
2. **Low risk — move the per-language collectors.** Every `collect*Provider`/`collect*Consumer` function
   or independent `(file, service, ...)` with no shared mutable state beyond a few generic helpers — a
   natural move to `service-lens/providers/*.ts` / `service-lens/consumers/*.ts`. Worth doing at the same
   time as the §1.5 finding that these collectors currently run unconditionally regardless of the file's
   actual language (a Go file still runs JS-shaped regex) — add the per-file language gate as part of the
   same pass, using `import-scan.ts`'s existing `collectSpecs` dispatch as the template.
3. **Higher risk, only with the existing test suite as your acceptance bar — the matching/scoring core.**
   `ProviderIndex`, `matchPathShapes`, the confidence functions, and `buildServiceRelationships`'s
   orchestration are tuned together; treat "the full `graph-relationships.spec.ts` suite still passes,
   unchanged" as the bar for any change here, not just "it compiles." A natural, low-pressure trigger for
   finally splitting this core out is the next time a new language/framework detector gets added, rather
   than doing the split as a standalone exercise.

**Suggested sequencing:** 1, independently and soon (it's a performance fix that stands on its own). 2 any
time after, ideally bundled with the language-gating fix. 3 only when there's a specific reason to touch
that code anyway.
