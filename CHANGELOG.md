# Changelog

All notable changes to the Blacksite VS Code extension are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## 0.9.6

### Added

- **Python and PHP import-resolution parity.** The Map's per-language layout quality
  traced back entirely to import-edge recall (the force layout is driven only by
  `kind: "import"` edges): Python previously dropped single-segment absolute imports
  (`import utils`) and skipped star re-exports (`from .sub import *`) outright, and PHP
  had no PSR-4 `namespace`/`use` scanning at all — only literal `require`/`include`.
  Python now resolves single-segment imports when the name is workspace-unique and
  follows star re-exports via a new module-name index (`graph/python-index.ts`); PHP
  gets a whole-codebase namespace/type index (`graph/php-index.ts`) with the same
  small-namespace-fans-out / large-namespace-needs-a-referenced-type precision gate C#
  already used, closing what was the single largest per-language gap in the indexer.
- **LSP onboarding parity.** Dart, Kotlin, Scala, Lua, and Elixir now get an install
  recommendation in the "Light up more relationships" panel — previously tracked but
  silently unable to ever prompt an install.
- **Services lens never links to documentation.** A `.md`/`.mdx`/`.txt`/`.rst`/`.adoc`
  file can no longer become an API/event/data/config edge's source or target — a
  README's example curl commands or route tables could previously read as a real
  cross-service relationship.
- **Connectivity measurement helper** (`graph/connectivity-stats.ts`) for objective
  per-neighborhood average-degree/orphan-rate comparisons, so future per-language import
  work can be measured rather than eyeballed.

## 0.9.5

### Added

- **Map Notes timeline.** A new editor tab (Map toolbar → "Notes timeline", the node
  card's Notes → "Timeline" button, or the `Blacksite: Open Map Notes Timeline` command)
  presents every working-memory note as a scrollable, day-grouped timeline: full revision
  trails for notes refined across sessions, clickable file/relation endpoint chips,
  live search plus file-note/relation filters, and per-file git history with one-click
  commit-vs-parent diffs in VS Code's native diff editor. "Show on map" flies the Map's
  camera straight to the noted file's star.
- **Color-coded link-type filters.** The Map's file lens grew a "Link types" section:
  imports, calls, references, inheritance, and notes each render as a chip carrying the
  exact hue its edges are drawn with, plus a live edge count — toggling a chip shows or
  hides precisely that relationship family on the canvas. Call/reference/supertype edges
  from the background symbol sweep now filter independently instead of riding the
  imports toggle.
- **Host→Map navigation.** A new `focus_node` message lets other surfaces (the Notes
  timeline today) bring the Map forward and fly to a file's star, queued safely when the
  Map webview hasn't resolved yet.

### Changed

- **Agent Map guidance consolidated.** The system prompt now teaches an explicit
  orient → inspect → work → record Codebase Map workflow, with a concrete note-taking
  strategy: record the durable non-obvious "why", choose file vs relation notes
  deliberately, refine existing notes instead of duplicating, and prune notes an edit
  invalidates. The `map_note_add` tool description encodes the same quality bar.

## 0.9.0

### Added

- **Provider-neutral live agent environment.** Every parent and delegated model turn now
  receives a freshly rebuilt workspace block rather than a snapshot captured only at the
  start of the user message or delegated lane. Post-tool decisions therefore see current
  diagnostics, git state, plans, memory, repository guidance, and architectural context;
  transient refresh failures retain the last known-good block instead of stopping work.
- **Repository instruction discovery.** Root `.blacksite/instructions.md`, `AGENTS.md`,
  `CLAUDE.md`, `GEMINI.md`, and `.github/copilot-instructions.md` files are loaded for every
  provider, with scoped instructions from the active file's ancestor chain layered in.
- **`map_overview` architecture tool and automatic orientation.** Surfaces Codebase Map
  coverage, detected projects and project references, major areas, dependency hubs,
  cross-service flows, and recent map knowledge. A compact form is injected into the live
  workspace block, while the structured tool supports deeper architectural work on demand.
- **Provider-neutral LSP reliability layer.** Typed provider outcomes now separate valid
  empty results from errors, timeouts, cancellation, and unavailability under one total
  deadline. Multi-root identity and exact target resolution fail closed; diagnostics report
  freshness, coverage, and introduced/resolved/persisting deltas; mutations are serialized
  per workspace and return transaction receipts. Stable code-action IDs replace unsafe
  prefix selection, command-backed actions disclose/observe unpreviewable changes, and
  create/delete/rename operations require explicit review. `code_hierarchy` also supports
  bounded, cycle-safe depth graphs with call-site ranges.
- **LSP Extension Host verification.** `npm run test:lsp` combines focused unit coverage
  with a clean VS Code/TypeScript fixture for symbols, navigation, hover/signature help,
  diagnostic publication/resolution, organize imports, formatting, and cross-file rename.
- **`code_replace` tool.** Rewrites a symbol's exact language-server range — or an explicit line range —
  by targeting it the same way code_insert does (preferably by symbol), instead of
  reproducing the existing text as a file_edit `oldString`. The language server supplies
  the exact current range, so a whole-function/method/class rewrite no longer risks a
  failed or wrong exact-string match on a large block. Shows a diff for approval and
  returns diagnostics like every other mutating code_* tool; fully wired into the chat
  transcript's icon/label/activity presentation alongside code_insert.
- **Plan phase `rationale` field.** `plan_create`/`plan_update` accept a `rationale` /
  `phaseRationale` field alongside the existing objective/risks/acceptanceCriteria —
  a durable, cross-session place to record *why* a design was chosen over the
  alternatives considered, surfaced in the prompt summary and the Planning webview
  (not just left in chat text, which compaction or a later session can't see).
- **Architecture guidance in the static system prompt.** Two new guidelines: survey
  2-3 existing analogous implementations before designing a new module/boundary/
  abstraction, and capture non-obvious design rationale via `phaseRationale` rather
  than only in chat.
- **`code_replace_batch` tool.** The batch sibling `code_replace` was missing: rewrite
  several symbols' bodies (or explicit line ranges) across one or more files in a
  single reviewed diff, each resolved independently exactly like `code_replace`. Edits
  within the same file must not target overlapping ranges. Removes the need for one
  `code_replace` call and approval per symbol in a coordinated multi-file refactor.
- **`json_edit` tool.** Structural JSON edits by RFC 6901 JSON Pointer (`set` / `merge` /
  `remove`) instead of exact-text matching — immune to the reformatting, key reordering,
  or stray whitespace differences that make `file_edit` brittle on config files
  (`package.json`, `tsconfig.json`, `.vscode/settings.json`, etc.). Preserves the file's
  existing indent style and trailing newline; only supports plain JSON (falls back to
  `file_edit` for JSON-with-comments). Backed by a new pure, independently unit-tested
  `json-pointer.ts` engine.
- **"Unlimited" Max Tokens.** Settings → Generation has an Unlimited switch next to Max
  Tokens: when on, the configured number is ignored and the harness requests a generous
  output budget instead (escalating up to 200,000 tokens on truncation, versus 65,536
  normally) — still clamped to any real, documented provider ceiling (e.g. Bedrock Claude's
  64,000), since no provider actually accepts a literally unlimited request. Applies to
  delegated subagent lanes on the same provider too.
- **Windowed `file_read` (`offset` / `limit` / `lineNumbers`).** Reads now return a window
  of a file rather than all-or-nothing, with the file's true total `lines`, the
  `startLine`/`endLine` being held, and `hasMore`. Page on with `offset: endLine + 1`, or
  jump straight to a known line. `lineNumbers` is opt-in (a numbered line copied into
  `file_edit`'s `oldString` would never match, so it must never be the default).
- **`file_read` sees images.** Reading a `.png`/`.jpg`/`.gif`/`.webp`/`.bmp` returns the
  actual picture as a vision block (with the same describe-via-fallback-model path
  `browser_screenshot` uses when the model has no vision), instead of decoding the binary
  as UTF-8 and handing the model mojibake. Binary non-images are refused with a clear
  reason rather than garbage.
- **`file_search` gains context lines, output modes, glob includes, and multiline.**
  `outputMode: 'files_with_matches'` (cheap "where does this live") and `'count'` (cheap
  blast-radius sizing) join the default `'content'`, which can now attach `contextLines`
  around each hit. Multi-line patterns are supported via `multiline`.
- **`file_glob` sorts most-recently-modified first**, so the files a task is actually about
  surface at the head of a truncated result set.

### Fixed

- **LSP diagnostics no longer imply project-wide cleanliness.** File snapshots distinguish
  ready, unknown, timed-out, and cancelled freshness; workspace cache reads are explicitly
  partial and show measured coverage. Empty partial/unknown results render as warnings or
  neutral evidence rather than a green “No problems” conclusion.
- **LSP mutation races and opaque side effects now fail closed.** Target/document versions
  are revalidated around approval, parent and delegated mutations share one workspace queue,
  outside-root provider edits are blocked, resource-only edits cannot bypass approval, and
  command failures/timeouts are never reported as successful application.
- **`code_insert` never lit up the Codebase Map's live-activity trace.** The trace
  extractor read a top-level `path` field that tool never sends (it addresses its file
  via `target.path`), so `code_insert` calls silently never appeared in the map's edit
  trail. Fixed alongside `code_replace`/`code_replace_batch`, which use the same
  targeting shape.
- **Plan phase rationale could be lost forever.** It only lived on a plan, and clearing
  completed plans or archiving one deleted it with no trace. `clearCompleted` and
  `archivePlan` now fold any recorded phase rationale into `.blacksite/memory.md` (read
  back into every prompt) before the plan is removed, so a captured design decision
  survives the plan the way it would if the agent had called `memory_append` itself.
- **Agent could get stuck in long read/probe loops without ever editing.** Execution logs
  showed turns burning 10+ minutes and dozens of iterations re-reading the same large file,
  paging through truncated results, or shelling out to PowerShell for text substitution —
  sometimes never calling an edit tool for the whole turn, until the user cancelled or the
  provider errored out. The harness now tracks consecutive non-edit iterations and, after 6
  in a row, injects a reminder to commit to an edit (file_edit/code_insert/code_replace/
  code_replace_batch/json_edit) or say what's blocking it, instead of continuing to probe —
  capped at 3 per turn so a model that ignores it doesn't get spammed. A failed edit attempt
  (e.g. file_edit's ambiguous-match error) still counts as engaging with the task and resets
  the counter, so only genuine read-only stalls trigger it.
- **The Codebase Map note-enforcement nudge only recognized `file_edit`/`file_edit_batch`.**
  Editing exclusively through `file_write`, `code_insert`, `code_replace`,
  `code_replace_batch`, or `json_edit` never marked the file dirty, so the "you edited
  without leaving a note" reminder silently never fired for those tools — a gap that grew
  with every edit tool this release added. All of them are now tracked the same way.
- **`file_edit` now recovers from line-number prefixes in `oldString`.** A model that rebuilds
  a snippet from a numbered source — a `lineNumbers` read, a `file_search` hit, a paged output
  dump, a pasted editor gutter — sends back an `oldString` the file cannot possibly contain,
  and the edit dies with "oldString was not found". The harness now detects a uniform
  line-number gutter (`42<tab>text`, `42: text`, `42 | text`; consecutive numbering required)
  and retries without it, joining the existing whitespace-tolerant fallback. Two safety rules
  make this non-destructive: a stripped candidate is only adopted if it is **actually found in
  the file** (so text that merely looks numbered — an object literal with keys `1:`, `2:` — can
  never redirect an edit), and when `oldString` needed stripping, `newString` is stripped too,
  since otherwise the edit would "succeed" while writing line numbers into the source. The
  result carries a `notice` so the repair is visible rather than silent.
- **A response cut off mid-text by the output token limit just became the final answer.**
  The existing truncation recovery only handled a tool call cut off mid-JSON; a plain-text
  response with no tool call in flight had no recovery path at all and silently ended the
  turn with the truncated text as "done." It now escalates the output budget and asks the
  model to continue from exactly where it left off, bounded by the same retry cap as the
  tool-call case.

## 0.8.1

### Fixed

- **Reasoning-effort table corrected for GPT-5.6.** 0.8.0 shipped gpt-5.2+ with a ladder
  that included `minimal` and lacked `max`; the real GPT-5.6 family (gpt-5.6, plus the
  -terra/-luna/-sol variants) drops `minimal` (gone for good since 5.1) and adds `max` as
  a new top rung above `xhigh`. The picker and clamping logic now reflect this, in both
  the host and webview capability tables. For the record: "ultra mode" is a separate
  multi-agent orchestration feature (parallel subagents via a different API surface), not
  a `reasoning_effort` value — it is intentionally not part of this ladder.

## 0.8.0

### Added

- **OpenAI Flex service tier.** Settings → Generation (and a one-tap ⚡ Flex chip in chat
  quick-settings) can pin OpenAI runs to the `flex` processing tier — flagship models at
  reduced rates with queued, capacity-dependent latency. The harness compensates for the
  tier's semantics: a 5-minute stream-idle allowance (vs. 60s standard) so server-side
  queueing isn't misread as a stalled socket, and an automatic one-turn fallback to the
  standard tier when flex capacity is unavailable after the normal retry cycle. `priority`
  and explicit `default` tiers are selectable too; Auto sends no tier and leaves the
  account default in charge.
- **Full reasoning-depth ladder for newer GPT models.** Reasoning effort now spans
  none / minimal / low / medium / high / x-high. The pickers show exactly the rungs the
  selected model family accepts (o-series: low–high; gpt-5: +minimal; gpt-5.1: +none,
  codex-max +x-high; gpt-5.2+ including 5.6: the full ladder), and unknown newer families
  default to the full ladder so new depth levels are usable the day a model ships.
  Requests clamp a persisted rung to the nearest one the active model supports — switching
  from gpt-5.6 (x-high) to o3 can never turn the saved setting into a 400-per-turn
  failure.
- **gpt-6+ readiness.** Reasoning-model detection matches any `gpt-N` with N ≥ 5 instead
  of pinning to ids known today, so future majors get `max_completion_tokens`/effort
  handling automatically.

## 0.7.0

### Added

- **Tool-input auto-repair.** Near-miss tool arguments are now coerced before validation
  and dispatch instead of bouncing back as errors: numeric strings for number fields,
  "true"/"false" for booleans, numbers for string fields (GitHub issue numbers), whole
  JSON-stringified arrays/objects, and wrong-case enum values ("Status" → "status") —
  recursively, including array items like `browser_run_script` steps. Each repaired call
  executes immediately instead of costing a full model turn to correct.
- **Nested argument validation.** `validateToolInput` now walks nested objects and array
  items, so a malformed entry deep inside `file_edit_batch.edits` or
  `browser_run_script.steps` is answered with a precise, path-qualified error
  ("edits[1].newString is required.") instead of failing opaquely at runtime.
- **Enum-constrained dispatch keys.** Exact-match fields (`git_op` op/action,
  `code_navigate`/`code_hierarchy` kind, `code_insert` position, `code_diagnostics`
  severity, `worktree_op` op, browser waitFor/action) now advertise real JSON-schema
  enums, guiding the model to valid values and turning garbage into a clean, correctable
  validation error.
- **"Did you mean" for unknown tools.** A call to a near-miss tool name ("file_reed",
  "fileRead") now gets the closest advertised tool suggested in the error.
- **OpenRouter prompt caching.** Claude/Gemini models driven through OpenRouter now get
  Anthropic-style `cache_control` breakpoints: one on the static system+tools prefix, one
  rolling on the latest user message, with the volatile per-turn workspace block kept past
  the breakpoints so it can never invalidate them. Previously these runs re-billed the
  entire prompt every turn.
- **OpenAI cache routing.** Direct-OpenAI requests carry a stable per-session
  `prompt_cache_key`, steering every request of a conversation to the same cache shard
  for materially higher automatic-cache hit rates on long runs.
- **Cache hit-rate in session stats.** The Session tokens row now shows what share of all
  prompt tokens were served from cache (⚡ count · percent).
- **Live tool toggles.** Disabling a tool in settings now takes effect on the
  already-running session immediately — advertised tool list and dispatch both — not just
  on the next conversation.

### Fixed

- **Compaction outcome reporting.** A compaction pass that legitimately had nothing to do
  (not enough history, or tool calls too interleaved to cut cleanly) is no longer
  misreported as a failure with a stale error message; skipped/failed/timed-out outcomes
  now produce accurate diagnostics, and manual compaction explains a skip.
- **Stop responsiveness during compaction.** Cancelling a run no longer waits out an
  in-flight blocking compaction pass — the wait aborts immediately while the pass
  finishes in the background.

### Changed

- **Welcome surface.** The empty-transcript state is now a proper landing hero — brand
  glow, breathing gradient orb, and chip-styled shortcut hints — matching the panel's
  design language.

## 0.6.0

### Added

- **browser_run_script.** One tool call runs a whole browser sequence — navigate, click,
  type, wait, screenshot, get_text, evaluate (max 25 steps) — against the same page, and
  returns every step's result together with each screenshot attached as a real image in
  step order. A multi-step visual walkthrough now costs one round trip instead of one per
  step. New `wait` step (selector-based or fixed timeout) for settling animations.
- **Project shape in the workspace state.** The per-turn "Current workspace state" block now
  opens with a deterministic Project shape section — stack manifests, package manager,
  detected test framework, and monorepo layout — so the agent knows what it's working with
  from turn one instead of spending opening turns on test_detect / manifest reads.
- **Post-write diagnostics.** file_write results now carry the same `diagnostics` field
  file_edit and the mutating code_* tools already attach, closing the write → diagnose loop
  in a single turn. System-prompt guidance updated to read the inline field instead of
  spending a code_diagnostics call after every edit.
- **Consistent file ids.** file_read/file_write results echo `relativePath` — the same
  workspace-relative forward-slash id the Codebase Map, code_* tools, and git speak — plus
  a `lines` count on reads for line-targeted follow-ups.
- **Dedicated subagent toggle.** Settings → Agent gains an explicit "Delegated Subagents"
  switch (same plumbing as the Tool Access grid) for turning delegation off when token
  spend matters most.
- **Always-fresh model lists.** Every view that renders a model catalog (Settings → Model,
  the chat model switcher, subagent/vision/inline pickers) refreshes it from the provider
  API on open — stale-while-revalidate with a 30s guard, so the cached list stays rendered
  under a slim animated glint while the refresh runs, and rapid open/close can't hammer
  the API. Manual Refresh always hits the API.
- **Extended thinking on OpenRouter.** The same thinking toggle + budget that drives
  Anthropic/Bedrock extended thinking now flows through OpenRouter's unified `reasoning`
  parameter (mapped per routed model — Anthropic budgets, Gemini thinking, OpenAI effort),
  with reasoning deltas streamed into the thinking view. Available in Generation settings
  and chat quick-settings for reasoning-capable models.
- **Map intelligence guidance.** The system prompt now teaches map_relationships as the
  first reach for structural questions (imports, imported-by/blast radius, cross-service
  edges, prior-session notes) instead of re-deriving structure with file searches, and
  frames map notes as compounding context that map_relationships returns to future runs.
- **Stars sized by file weight.** A star's radius now blends the file's size on disk
  (log-scaled, capped) with its connectivity, so a large file reads bigger at a glance
  while heavily-imported files keep visual priority. Aggregates stay degree-sized.
- **Functional role marks.** Every file is classified by what it's *for* — tests, config,
  docs, styles, type declarations, entry points, data, assets — and denoted with a small
  per-role silhouette in the star's lower-left corner (flask triangle, square, text bars,
  swatch diamond, chevron, four-point star, dataset bars, circle), each with its own quiet
  hue. Plain source files carry no mark, so the marks stay signal. The node card names the
  selected file's role, and the Map key documents every mark.
- **Typed territory borders.** A territory zone whose files are mostly one role now says
  so with its outline: dashed = tests, long-dash = config, dotted = docs, short-dash =
  styles, with the border hue leaning toward the role color while keeping the folder's
  identity hue as its base. Source territories keep the solid border.
- **Filter by role.** The Filter rail gains role chips (with the same glyphs the star
  marks use) alongside the language chips — click "test", "config", "data", … to ghost
  everything else, composable with language, territory solo, and min-links. Role
  classification is memoized, so the filter pass stays cheap on large maps.

### Fixed (providers)

- **Anthropic-family temperature clamp.** The settings slider spans the OpenAI-style 0–2
  range, but Anthropic (direct, Bedrock Converse, Mantle) accepts 0–1 — a dialed-up
  temperature previously produced a 400 on every call after switching provider. Values
  above 1 are now clamped at request time, with a hint in Generation settings.

### Fixed

- **Screenshots reach the model now.** browser_screenshot's image was JSON-stringified as
  base64 into the tool-result text and truncated by the result cap — the model never saw
  it. Screenshots (and reference_zoom_image) now arrive as real vision blocks, or as a
  description via the configured vision-fallback model.
- **code_diagnostics returning empty.** The op now opens the target document (triggering
  language-server analysis for files the agent only ever read via fs) and waits briefly
  for the server to publish before trusting an empty result.
- **Map symbol-sweep edges render.** The background LSP symbol sweep
  (blacksite.graph.backgroundSymbols) fed only the agent's map_relationships tool — its
  call/reference/supertype edges never reached the visual Map. They now flow into the
  file-lens edge set with their own colors, cluster-collapse handling, and live refresh.

### Changed

- **Subagent lanes look like agents.** Delegated lanes render as their own persona card
  (bot avatar, colored kicker, explicit disclosure chevron) instead of a tool-row
  lookalike, and no longer appear twice in the transcript.

## 0.5.0

### Added

- **Territory solo.** Each row in the Map's territory index gains a Solo toggle that ghosts
  every file outside that folder (stackable across territories, cleared from the Filter
  section's chips). Soloed territories persist with display prefs and saved views.
- **Hubs quick-list.** A new rail section lists the most-connected files — the same set the
  gold hub rings mark on the canvas — as a click-to-fly index.
- **Altitude meter.** The legend now names the semantic zoom band the camera is at
  (Overview / Modules / Files, mirroring the label crossfade bands) and flies to a band on
  click.

### Changed

- **Territory rows preview on the canvas.** Hovering a territory row lifts that territory's
  stars and recedes the rest, and its blob highlights on the minimap — the rail and the map
  are now the same surface.
- **Hover lifts neighbors.** Pointing at a star now softly brightens its direct neighbors
  along with the spotlight arcs, so local structure reads before you commit to a selection.
- **Minimap territory blobs.** The minimap sketches the biggest territories as faint colored
  regions beneath the dots, matching the rail's swatches.

## 0.4.0

### Added

- **Territory index.** A new Territories section in the Map's control rail lists the biggest
  folder territories with their true canvas colors — click a row to frame that territory,
  or Fold/Open it into a single star, without hunting the canvas for it.
- **Connections navigator.** The node card now lists a selected file's top dependencies and
  dependents (ranked by connectivity) as click-to-navigate rows, so you can walk the import
  graph instead of reading bare degree counts. Neighbors folded into a collapsed cluster
  surface as that cluster.
- **Smarter Map search.** Search now ANDs whitespace-separated terms, falls back to fuzzy
  basename matching ("grapp" finds `GraphApp.tsx`), ranks basename hits above path hits, and
  highlights the matched characters in each result. Hovering a result previews that star on
  the canvas before you commit.
- **Minimap drag-to-pan.** Hold and drag the minimap to sweep the camera continuously
  (click-to-jump still works), and a "you are here" marker shows the focused star in its
  territory color.

### Changed

- **Aggregates look like aggregates.** A collapsed folder's super-node now wears an orbital
  ring and Services-lens nodes a diamond outline, so semantic aggregates are distinguishable
  from big files even at overview zoom. The Map key documents both marks.
- **Color continuity between canvas and chrome.** Search results, the focus tooltip, and the
  selection cards now carry the territory's color swatch, tying the HTML overlays to the
  exact hues the renderer draws.

## 0.3.0

### Added

- **LSP tool cancellation.** `code_*` tools now cancel in-flight language-server calls promptly
  when a turn is cancelled, instead of riding out the full timeout.
- **Actionable "no provider" errors.** Code-intelligence tools that come back empty now explain
  why when a language's recommended extension isn't installed, instead of a generic "no results"
  message.
- **Signature help on hover.** `code_hover` now shows the active parameter of an in-scope call
  signature, bolded, alongside the usual hover text.
- **Safer renames.** `code_rename` validates the position via the language server's own
  `prepareRename` first, surfacing the specific reason a rename can't proceed instead of a
  generic failure.
- **`code_inlay_hints` tool.** Inferred type and parameter-name hints for a file or range — most
  useful for untyped or dynamically-typed code.
- **Background-indexing prompt.** The Codebase Map's onboarding panel now also offers to turn on
  `blacksite.graph.backgroundSymbols` once a working language server is detected, instead of that
  setting being discoverable only via `settings.json`.
- **Saved Map views.** Name and save the current camera position, filters, and collapsed
  clusters, then jump back to it later from the Map toolbar.
- **Semantic zoom.** On a multi-codebase workspace, zooming out past the whole-map fit now
  collapses individual files toward their neighborhood's silhouette instead of rendering every
  star at every zoom level.
- **Cross-project cycle flagging.** A new opt-in "Cycles" layer highlights cross-codebase
  reference cycles detected in project manifests.
- **Cul-de-sac detection.** A new opt-in "Cul-de-sacs" layer dims probably-unused orphan files
  and highlights the single bridge edge into an isolated "pocket" subgraph within a neighborhood.
- **Adaptive architecture routes.** Dense file maps now replace raw overview hairballs with a
  connectivity-preserving, weighted folder backbone and restore file links automatically at
  detail zoom. The control rail discloses both raw corpus size and visible route count.
- **Collision-aware semantic labels.** Territory, module, and subgroup labels use distinct zoom
  bands plus a screen-space collision/occlusion pass, keeping architecture names readable around
  the command panel, inspector, and focused node.
- **Service relationship bundles.** Parallel API, event, data, and config detections render as one
  directed weighted route per service pair and kind while retaining confidence ranges and raw
  evidence in the inspector.
- **Adaptive service topology.** Dense many-to-many service maps now use a weighted,
  connectivity-preserving backbone at overview zoom, then restore every typed route at detail
  zoom or around a focused service. Focused routes carry direction chevrons for fast
  one-to-many / many-to-one reading.
- **Service-aware map navigation.** Search and Follow Agent now project a file path onto its
  visible owning service, rather than leaving an invisible file selection in the Services lens.

### Changed

- The Map's empty-state message now matches the rest of the panel's visual language (heading +
  subtext) instead of a single terse line.
- The Map layout now gives high-degree hubs weaker, longer spokes and collision-separates dense
  service meshes. Existing position caches rebuild once under schema v8.
- Dense Map overviews use restrained node compositing, fewer decorative stars, hidden per-file
  badges, a scrollable progressive-disclosure control rail, semantic focus states, and responsive
  high-contrast/reduced-transparency styling.
- Services now assign nested paths to their most-specific root (with `.` representing the
  workspace root), avoiding double-counted service size and incorrect centroids in monorepos.

## 0.2.0

### Added

- **Docked approval/question bar.** Pending questions and tool approvals now surface in a
  persistent bar pinned above the chat input, visible regardless of where the transcript is
  scrolled — including approvals raised inside subagent lanes, which were previously the most
  buried case (hidden behind both a collapsed lane tile and a collapsed tool-log summary). A
  "show in thread" link jumps to the full context when it's available.
- **Approval prompts for unrecognized shell commands.** A command that is neither explicitly
  allowed nor explicitly denied now prompts for approval instead of failing instantly.
  Explicitly denied commands (`blacksite.permissions.deniedCommands`) still hard-block with no
  prompt. Applies to both one-shot commands (`shell_run`) and long-running processes
  (`process_start`).
- **Project vs. all-projects "always allow."** Choosing "always allow" for a command binary now
  offers an explicit choice between persisting the rule for the current project only or for all
  projects, instead of always auto-detecting the scope.
- **Richer, more editable plans.** Phases and steps can now carry an optional risk note,
  dependency references, acceptance-criteria bullets, and a coarse complexity hint
  (small/medium/large). `plan_update` gained `reorderPhaseIds`, `reorderStepIds`,
  `moveStepId`/`moveStepToPhaseId`, and `insertPhaseBeforeId` for restructuring an existing plan
  without recreating it.

### Changed

- Tool guidance now nudges the agent to build larger plans phase-by-phase via `plan_create` +
  `plan_update`'s `addPhases`, rather than authoring every phase in one call.

### Fixed

- A shell command that isn't on the built-in or configured allowlist no longer fails outright
  with "not in the allowed list" — it now gets a chance to ask.
