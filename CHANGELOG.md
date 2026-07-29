# Changelog

All notable changes to the Blacksite VS Code extension are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## 1.2.3

### Fixed

- **Configured workspace roots now take effect.** `blacksite.workspaceRoot` was ignored whenever
  VS Code had an open folder, while its default empty string also prevented the documented
  extension-host fallback when no folder was open. Root selection now has explicit, tested
  precedence: configured override, first open folder, then the host working directory.
- **Release packages no longer inherit local editor state.** An untracked `.vscode/settings.json`
  was being copied into the VSIX, making the published extension depend on the packaging
  machine. `.vscode/**` is excluded and every package is now inspected for required runtime
  files and forbidden development artifacts before it can be uploaded.
- **Tag releases enforce the complete verification gate.** Release builds now run lint in
  addition to tests, both typechecks, and the production build, matching the checks on `main`.

## 1.2.1

A follow-up review of the ticket work in 1.2.0, looking for the same class of defect: a
surface that exists on one side of a seam and was never wired to the other.

### Fixed

- **Renames and copies now appear on the Codebase Map.** The map lights up the files the
  agent touches, but the table driving it never covered `file_move` or `file_copy` — the
  single most structurally significant file operation left the graph silent, and the live
  activity chip couldn't say where a file was going. Both ends of a move are now traced,
  along with `file_mkdir`, `code_hierarchy` and `code_inlay_hints`.
- **Ticket calls read as work in the transcript.** With the tools finally reachable, every
  ticket call rendered as a bare label with no detail — no id, no title, no filter. They now
  show what they are doing ("Filing ticket · retry backoff drifts", "Reading ticket · BLK-12")
  in both the result rows and the live activity line.
- **Icons for the tools that were quietly missing them.** The Codebase Map's note tools and
  the whole reference family showed the generic wrench, which reads as deliberate rather than
  as an oversight. Database tools also stop rendering as "Db Run Read Query".
- **`ticket_promote` no longer over-promises.** It described its output as being in
  `plan_create`'s shape when the two differ: the file list belongs to the first phase, and a
  ticket's labels and references have no plan equivalent at all. It now states the mapping,
  so promoting a ticket doesn't cost a turn spent guessing or quietly drop the references.
- **Six source files were opaque to search.** They carried a raw NUL byte where a `\u0000`
  escape was meant — a deliberate separator written in a form that makes ripgrep report
  "binary file matches" and refuse to print them, and that made `src/graph/layout.ts` binary
  to git, silently exempting it from the repository's own line-ending normalization. The
  behavior is unchanged; the files are text again, and layout.ts is normalized to LF.

### Changed

- Three seams that previously drifted are now asserted by tests: every tool in the catalog
  reaches the model, every tool has an icon, every ticket tool routes to a real store
  operation, and no source file carries a raw control byte.

## 1.2.0

### Added

- **The ticket queue, rebuilt as something you can live in.** Tickets and the Board now share one
  surface language: compact rows instead of cards, a status ring that fills as work progresses and
  a priority glyph that grows as it matters, both readable in greyscale. Collapsible group headers,
  a persistent search box, a filter menu whose every active choice shows as a removable chip, and
  grouping and sorting that survive tabbing away. Built for a queue that reaches several hundred —
  rows render in windows as you scroll, closed work stays collapsed, and the result count is always
  on screen so a filtered list can never quietly pretend to be the whole queue.
- **Keyboard-first, on both surfaces.** `j`/`k` move, `↵` opens, `[`/`]` advance status, `1`–`4` set
  priority, `c` files, `/` searches, `e` edits, `Esc` backs out. Scoped to the panel, so nothing is
  stolen from the editor beside it.
- **A real ticket, not just a title.** Tickets now carry **acceptance criteria** (what done means —
  statements, not steps, so the no-progress rule still holds), **references** to specs, PRs and
  upstream issues, an **assignee** (you or the agent), a **duplicate-of** marker, and both
  directions of the blocking relationship — a ticket now shows what it blocks, not only what blocks
  it. Everything is reachable from a detail pane that opens beside the board and in place in the
  sidebar.
- **A creation flow worth using.** One dialog for filing and for editing, with autocomplete on every
  relation field: files and areas search the live Codebase Map index, labels offer the vocabulary
  already in use, and ticket and plan pickers search by title rather than demanding you know an id.
  The one-line filing bar still exists for when a title is all you have — `⌘↵` promotes it into the
  full form mid-thought.
- **Two layouts, one filter set.** The Board toggles between columns and a list without losing your
  search, filters, or selection — columns for moving work along, the list for finding one thing
  among three hundred.
- **`ticket_get`.** The agent can read one ticket in full, including every comment. Investigation
  recorded on a ticket now survives the session that produced it in a form a later session can
  actually retrieve.
- **A missing tool is now a dead end, not a loop.** When the agent runs a command this machine
  doesn't have (`npm`, `npx`, `brew`, `python`, `cargo`, …), the run used to look like a command
  that succeeded silently, so the agent kept re-issuing it until the turn ran out of iterations.
  It is now reported as an explicit failure that names the tool, and the session refuses further
  calls to it — including ones nested in a shell line (`bash -lc "npm ci"`) — so the turn spends
  its remaining budget on something that can actually work.
- **One-click install for a missing tool.** The editor offers the install command for the host
  platform (winget/choco, Homebrew, apt/dnf) and prefills it into a terminal for you to run, or
  opens the tool's install page. Nothing is executed without you pressing Enter.
- **Full sampling controls per model.** Settings → Generation now exposes every sampling
  parameter the selected model actually accepts — Top P, Top K, Min P, frequency, presence and
  repetition penalties, and seed — read from the provider catalog rather than a fixed list. This
  is most visible on OpenRouter, where models like Kimi, DeepSeek and GLM accept far more than
  the temperature slider previously offered. Each control is unset by default, leaving the
  model's own default in charge, and clears back to it.

### Changed

- **Searching and paging the queue from the agent side.** `ticket_list` takes free text matched
  across title, description, labels, acceptance criteria and territory, filters by assignee, and
  reports `matched` alongside a `nextOffset` that appears only while more remain — so "that was the
  first 25" can no longer be mistaken for "that was all of them".
- **Ranking knows who owns what.** `ticket_next` promotes work the user handed to the agent, sinks
  work they kept for themselves, and sinks known duplicates. Tickets assigned to the agent are named
  in the per-turn context block, so a standing instruction doesn't need a tool call to be remembered.
- **Deleting a ticket now asks first, and names it.** It was previously immediate and irreversible
  from a single click.
- **Mid-run commentary reads as a sequence, not a wall.** Text the agent writes between tool
  calls is now presented as numbered progress updates, with its final answer rendered separately
  beneath them. Previously every stretch of prose in a turn — status updates from minutes apart
  and the conclusion — was concatenated into one undifferentiated block.

### Fixed

- **The agent can actually use the ticket queue.** Every `ticket_*` tool was defined, dispatchable,
  toggleable in Settings, and the queue was summarized into the agent's context every turn — but the
  family was never advertised to the model, so the agent could read the backlog and had no way to
  file, comment on, rank, or promote anything in it. The tools are now offered whenever the project's
  ticket store is available, in the main session and in delegated lanes alike. A test now asserts
  that every tool in the catalog reaches the model, so a whole family cannot go missing again.
- **The system prompt documents the whole ticket family**, not just filing: which surface owns what
  (ticket = durable outcome, plan = how it gets done, todo = scratch for the step in flight), reading
  a ticket's history before starting it, asking the queue what to pick up next instead of eyeballing
  the summary, treating a sweep as proposals to review, and leaving `done` to the user.
- **Ticket relations can no longer disagree with themselves.** Relations are reconciled on every
  read: ids pointing at deleted tickets are dropped, `relatedTo` is made symmetric from either end,
  and the blocking edge has exactly one authority, so removing a blocker from either side removes it
  for good. A ticket size set by mistake can now also be cleared back to unsized.

## 1.1.0

### Added

- **Subagent follow-up.** `subagent_followup` re-opens a finished lane with a new message, keeping
  everything it already had in context. Following up costs one message where a fresh lane would
  have to rediscover the files, commands and reasoning behind the original answer. Follow-ups run
  one at a time, get their own budget, and the most recent lanes stay resumable for the
  conversation.
- **Lanes report back even when they run out of budget.** A lane that times out or ends without a
  final answer returns `partialAnswer`, `executionTrace`, `filesTouched`, `toolRounds` and a
  `failureKind` (`timeout` / `cancelled` / `no_answer` / `error`), so the agent can continue from
  what was gathered, narrow the task, or resume the lane — rather than starting over.
- **Segmented reasoning in the transcript.** Thinking is recorded as one segment per burst, each
  carrying the tool calls it produced. Collapsed to a single row by default — duration, step count,
  and a live readout of the current line — and expandable into the sequence of decisions the turn
  actually followed.
- **Syntax highlighting for untagged code blocks**, detected by language. Most visible in reasoning
  output, where snippets are often written without a language tag.
- **Themed select controls** across Settings and the Data panel, replacing the platform dropdown so
  the whole surface renders in one visual language.

### Changed

- **Extension updates need no credentials.** The updater reads a public release manifest published
  with the site (`blacksite.updates.manifestUrl`) and falls back to the GitHub releases API.
  Nothing prompts for or sends a token, and a `403`/`429` is reported as the shared API rate limit
  it is.
- **Delegation runs sequentially or in parallel, by choice.** `subagent_spawn` documents the
  trade-offs of fanning lanes out versus running them one at a time, and `complexity` states what
  each tier means in tool calls. Neither mode is the default-correct one — the agent picks per
  situation, and concurrency is bounded by **Max concurrent** in Settings → Subagents.
- **Answered question cards collapse to one line** — the question and the chosen answer — keeping a
  conversation with several decisions in it readable, and expandable for the full record.
- **Transcript documents surface in the thread** as they are produced, so a long deliverable is
  readable while the rest of the run continues.

### Fixed

- Markdown tables stay readable in a narrow side panel: they keep a minimum column width and
  scroll horizontally as a unit.
- A live reasoning block can be collapsed while the agent is still streaming into it, and its
  collapsed readout updates smoothly rather than restarting its animation on each token.
- Long streamed responses stay within their retention limit exactly.

## 1.0.2

### Added

- **Provider-aware output ceilings.** Anthropic and OpenRouter consume live catalog limits;
  direct OpenAI and Bedrock use documented model-family/platform metadata. Unknown models keep
  a conservative 65,536-token fallback, while explicit provider corrections are learned and
  checkpointed per provider/model.
- **Architecture-aware coding guidance.** The core agent prompt now treats repository shape as
  part of the product, balancing cohesive modules against fragmentation and using Codebase Map
  relationships to validate ownership, dependency direction, cycles, hubs, and service edges.

### Changed

- Unlimited output now starts at the selected model's resolved ceiling instead of a fixed 64K
  allowance. The model picker and Generation settings surface the detected cap.
- Model changes preserve conversation identity and history while isolating context windows,
  output corrections, and provider-native continuation state. Switching models repeatedly no
  longer carries one model's limits into another.

### Fixed

- **Plan updates now expose phase/step ids for targeted edits.** The active-plan block injected
  into the prompt each turn only ever showed the current/next step per phase, with no phase id at
  all — an agent wanting to update a different step or phase had no id to target and would either
  skip the edit or recreate the whole plan. It now lists every phase's id and every step's
  id/status/title, and the prompt guidance is explicit that plan_update is a field-level edit, not
  a rewrite.
- **Plans panel could go stale until manually refreshed.** The panel resyncs on every reveal now,
  not just on first load, so a plan the agent updated while the panel was hidden (or a missed
  live-update push for any other reason) is never more than one tab-switch away from correct.
- **A file edit could report success without actually reaching disk.** file_edit/file_edit_batch/
  json_edit/file_move save through the VS Code buffer; if that save silently failed (e.g. a
  transient external file lock), the tool still reported `ok: true` with no indication anything
  was wrong — and a subsequent file_read, which always reads raw bytes off disk, would show the
  old content. Saving now retries once, and a save that still fails is surfaced as an explicit
  notice instead of silent success.
- **The same stale-until-reveal gap existed in every other panel backed by an external store.**
  Base Context, Data, the Codebase Map (both its sidebar view and its full-page editor panel),
  and the Map Notes timeline all pushed state once on first load and then only on a live
  onDidChange event — never on a later reveal. They now resync on every reveal too, matching the
  Plans panel fix above.

## 1.0.1

### Added

- **Durable request profiles.** Auto, Plan, Review, and Debug now travel from the chat
  composer through queued messages, the host protocol, the agent loop, runtime state, and
  checkpoints. The selected profile is refreshed alongside live workspace context on every
  provider turn without invalidating the stable system-prompt cache.
- **Specialized agent methods.** Plan mode drives evidence-led research, focused question
  cards, implementation-ready phases, acceptance criteria, and linked plan documents. Review
  mode defaults to severity-ordered read-only findings; Debug mode uses ranked hypotheses,
  root-cause evidence, regression coverage, and narrow-to-broad validation.
- **Mode-aware chat surface.** A compact composer control and header status chip make the
  current profile explicit, while restrained Plan, Review, and Debug palettes shift ambient
  chat accents, controls, focus states, user turns, and live cues as one coherent surface.
- **Prompt architecture report.** Added a full review of the core prompt, tool environment,
  request-routing design, implemented profiles, and remaining evaluation opportunities.

### Changed

- Plan, Fix, Review, and Trace blueprints now select an actual behavioral profile instead of
  only inserting prompt text. The Plan scaffold is planning-only and respects execution
  approval rather than asking the agent to implement immediately.

## 0.9.100

### Added

- **Server-side compaction (beta `compact-2026-01-12`).** New per-provider trigger (in input
  tokens; minimum 50,000) on Anthropic-direct and Bedrock Mantle. When the conversation's input
  reaches that size, the API summarizes earlier history into a `compaction` content block and
  automatically drops everything before it on future requests — a new `CompactionBlock` type
  round-trips through the same message-history pipeline as every other content block (recorded
  first in the assistant turn, replayed verbatim on the next request). `usage.iterations` is now
  summed for accurate cost/context-window accounting on turns where compaction fires, instead of
  undercounting by whatever the compaction pass itself billed. Coexists correctly with context
  editing in one shared `context_management.edits` array (fixed a bug along the way where the
  two features would have silently overwritten each other if both were enabled). Enabling
  compaction for a provider disables this session's own client-side auto-compaction for that
  provider — running both would double-summarize and burn a full extra model call for nothing.
- **OpenAI Responses API (reasoning continuity across tool calls).** New opt-in toggle, scoped to
  OpenAI reasoning models (o-series, gpt-5+): routes those turns through `/v1/responses` instead
  of Chat Completions and replays the model's encrypted reasoning state (`encrypted_content`)
  into the next request after a tool-call round trip, instead of the model re-reasoning from
  scratch every turn. `ThinkingBlock` gained `encryptedContent`/`reasoningItemId` fields
  alongside Anthropic's existing `signature`, so reasoning blocks from either provider share the
  same history representation and each is correctly dropped (not sent, not misinterpreted) when
  replayed to the other provider. No effect on non-reasoning OpenAI models or on OpenRouter.
- **Fixed a pre-existing bug found while wiring the above:** the Context Editing toggle showed
  for the Bedrock provider tab regardless of Converse vs. Mantle mode, but the feature was (and
  remains) wired for Mantle only — on Converse it silently did nothing. The toggle (and the new
  compaction toggle) now only appear when Bedrock is actually in Mantle mode.

## 0.9.99

### Added

- **Anthropic Models API capability consumption.** The live `/v1/models` catalog now reads
  `max_tokens` (output cap, display-only) and the `capabilities` tree (vision, thinking) where
  present, OR'd against the existing id-based heuristics rather than replacing them — a live
  capability can add support the id table doesn't know about yet, but an absent/stale API
  response can never remove support the heuristic already established.
- **Claude Fable 5 / Mythos 5 refusal fallback (beta).** On by default for Fable/Mythos models:
  a policy-declined turn (`stop_reason: "refusal"`) now retries on Claude Opus 4.8 within the
  same request via the server-side `fallbacks` parameter, instead of ending the run. A new
  "Refusal Fallback" toggle lets it be turned off. First-party Anthropic API only. `stop_details`
  (category/explanation) is now parsed off refusals generally and surfaced as a specific
  diagnostic instead of the previous generic "declined to complete this response" message.
- **Fast mode (beta, Opus 4.8/4.7).** New per-provider toggle runs the model at up to 2.5x
  higher output tokens/sec at premium pricing. First-party Anthropic API only.
- **Task budgets (beta, Fable5/Sonnet5/Opus4.8/4.7).** New per-provider token-budget field
  gives the model a self-paced ceiling for an agentic loop instead of an enforced per-response
  cut-off. Anthropic-direct only (unavailable on Bedrock/Vertex/Foundry per Anthropic's own
  platform-availability table).
- **Context editing (beta).** New toggle clears stale tool_use/tool_result content server-side
  before the model sees it, keeping the effective prompt lean without summarizing. Available on
  both Anthropic-direct and Bedrock Mantle — it's a plain request field with no new response
  shape to round-trip, unlike server-side compaction (deliberately not implemented this pass —
  it introduces a new content-block type that must round-trip through the entire message-history
  pipeline, and getting that wrong risks corrupting every conversation, not just this feature).
- **OpenRouter provider-routing preferences.** New model-fallback list and provider-routing
  controls (order, allow-fallbacks, zero-data-retention, sort) forwarded as OpenRouter's
  `models`/`provider` request fields.
- **AWS credential chain for Bedrock.** Bedrock credentials are no longer static-keys-only:
  when no explicit key is stored, the extension now falls back to `AWS_*` environment variables
  and then a named profile in `~/.aws/{credentials,config}` — the same precedence every AWS
  SDK/CLI uses, so a machine already set up for other AWS tools works here with zero extra
  configuration.
- **Bedrock pricing.** Bedrock models (both Converse cross-region inference profiles and Mantle
  ids) now show estimated cost, mirroring Anthropic's own published per-model rates (Bedrock
  applies no separate Claude markup) — previously always "cost unknown" since Bedrock publishes
  no pricing API.
- **1-hour prompt-cache TTL option.** New per-provider Cache TTL control (Anthropic, Bedrock
  Mantle, OpenRouter) — the default 5-minute breakpoint survives typical multi-turn latency;
  1-hour trades a larger cache-write premium (2x vs 1.25x) for surviving longer gaps in bursty
  traffic.
- **Voyage AI embeddings.** New embeddings-only provider option (Anthropic's recommended
  embeddings partner, since Anthropic itself has no embeddings endpoint) alongside
  OpenAI/OpenRouter/Bedrock, with its own model catalog and API key slot.
- **Dated-snapshot-tolerant pricing lookup.** `getModelPricing` now falls back to a normalized-id
  match (stripping provider prefixes and dated-snapshot/version suffixes) when the exact id
  isn't in the fallback table, so a differently-decorated id for an already-known model (a new
  Bedrock inference-profile date stamp, an OpenRouter `provider/model:tag` id) still resolves
  pricing instead of showing "unknown."

## 0.9.9

### Added

- **Strict tool use on Anthropic and Bedrock Mantle.** Tool definitions whose
  schemas fit the documented strict subset are now sent with `strict: true`, so
  the API guarantees schema-valid `tool_use.input` — the malformed-argument
  class the coercion layer repairs after the fact becomes impossible at the
  source. Conversion is whitelist-gated per schema (free-form payload objects,
  numeric/string constraints, `$ref`, unknown keywords are sent unchanged
  without `strict`), and an endpoint that rejects strict marking gets one
  retry with plain schemas, remembered for the rest of the session — the same
  live-probe pattern as the Bedrock cachePoint check.
- **Reasoning control for non-Claude OpenRouter models.** Gemini thinking,
  DeepSeek R1, GPT-5-via-OR and friends can now actually reason: a new
  Reasoning Effort control (settings panel + quick chips) drives OpenRouter's
  unified `reasoning: {effort}` parameter for models that don't speak the
  Claude thinking dialect. The old top-level `reasoning_effort` send path was
  dead code — no UI could set it for this provider — while these models
  silently ran at the routed model's default.
- **Per-provider endpoint override.** A new Endpoint field (Models panel)
  wires the previously-unwired `baseUrl` session option through settings for
  Anthropic/OpenAI/OpenRouter — one field unlocks Azure OpenAI deployments,
  corporate proxies, and local OpenAI-compatible servers (Ollama, LM Studio,
  vLLM). Applies to chat turns, delegated subagent lanes, compression calls,
  and the vision-fallback/data-assistant path; validated host-side (http/https
  URL or blank to clear).
- **Effort on Bedrock Converse.** `output_config.effort` now rides
  `additionalModelRequestFields` next to `thinking`, exactly like the
  Messages-API shape. It was previously dropped on this path entirely — the
  same effort setting behaved differently across Converse and Mantle, with
  Converse-path Claude always running at the server default.

### Fixed

- **OpenRouter capability flags are real now.** The model catalog reads
  `architecture.input_modalities` and `supported_parameters` instead of
  hardcoding `supportsVision/supportsTools: true` for every model. Text-only
  models no longer get image blocks (and the vision-fallback path can finally
  engage for them), tool-less models are flagged, and reasoning support is
  detected for the families the id heuristics missed (Gemini, DeepSeek R1,
  Grok). The thinking toggle no longer appears as a no-op knob for non-Claude
  OR reasoning models — they get the effort control instead.
- **OpenAI metadata refresh.** Pricing/context rows for the gpt-5.x and
  gpt-4.1 families (cost tracking no longer shows "unknown" there), o3's
  June-2025 reprice ($2/$8, was still $10/$40), a modernized fallback model
  list (o1-mini/o1-preview out; gpt-5.1/gpt-5/o4-mini in), and a context
  heuristic fix: `gpt-4.1` resolved through the bare `gpt-4` rule to an 8K
  window — 0.5% of its real 1M capacity — which made compaction fire
  absurdly early.

## 0.9.8

### Added

- **Shape-based API matching.** Service-lens API edges now match a client call
  to a route declaration by aligning their *path shapes* segment by segment —
  literal segments must agree, while route parameters (`{id}`, `:id`,
  `<int:id>`, `[controller]`) and call-site interpolation holes (`${id}`,
  f-string `{id}`, `{$id}`, `%s`) act as single-segment wildcards. This replaces
  the old substring heuristics, which let a route match any path merely
  *containing* its text (provider `/users` ↔ consumer `/a/users-extra`) and let
  a bare host-only URL match every route in the workspace. Full-length
  alignments with more literal agreement outrank loose suffix overlaps, so the
  tighter route wins ambiguous matches. Name evidence alone (a host token naming
  the target service) no longer fabricates a route-level API edge — it surfaces
  as a config edge, as it always did for unmatched clients.
- **More entry-point detection per language.** New route providers: Laravel
  `Route::get/post/...`, Slim `$app->get(...)`, and Symfony `#[Route]`/`@Route`
  (with `methods:` lists) for PHP; actix/Rocket `#[get("...")]` attributes and
  axum `.route("/x", get(...))` for Rust; Django `urlpatterns`
  `path()/re_path()` entries; Flask/FastAPI `methods=["POST", ...]` kwargs
  (previously read as GET); gorilla/mux `.Methods("POST")` chains and
  receiver-based `HandleFunc` registration for Go; JAX-RS `@Path` + verb
  annotations for Java.
- **More API-call detection per language.** New consumers: Guzzle/Laravel-Http
  verb and `->request('VERB', ...)` calls (PHP), `reqwest::get` and gated
  `client.get/post/...` (Rust), `httpx`/session/client instance verbs and
  `requests.request("VERB", ...)` (Python), `HttpRequest.newBuilder()` with
  `URI.create` (Java 11+ HttpClient), and the axios config-object form
  (`axios({ method, url })`). `fetch(url, { method: "POST" })` now reads its
  real verb from the options object instead of always registering as GET —
  bare fetches no longer bind to wrong-method routes.

- **Route-prefix composition.** Declared routes now carry the prefix a real
  request path actually has: NestJS `@Controller("users")` (including bare
  `@Get()` index endpoints), Spring class-level `@RequestMapping`, FastAPI
  `APIRouter(prefix=...)` plus same-file `include_router(..., prefix=...)`,
  Flask `Blueprint(url_prefix=...)`, gin `r.Group("/api")` chains (nested),
  Laravel `Route::prefix(...)->group(...)` / `Route::group(['prefix' => ...])`
  blocks, Express `app.use("/mount", router)` mounts resolved through relative
  imports to the router file, and OpenAPI `basePath`/`servers[0].url` path
  prefixes. Full-path shape matches replace the loose suffix overlaps these
  cases used to fall back on.
- **Compose port mapping resolution.** `ports: ["3001:3000"]` entries now
  resolve `http://localhost:3001/...` dev-loop clients to the service actually
  publishing that port — authoritative, so identically shaped routes in other
  services are vetoed, same as compose hostname resolution.
- **gRPC stub binding.** `c := pb.NewOrdersClient(conn)` /
  `stub = pb2_grpc.OrdersStub(channel)` / `new OrdersClient(...)` bind the
  variable to its proto service, so calls through an opaque variable name
  resolve operation-name collisions that a bare `client.Create(...)` cannot.
- **`new URL(path, base)` and `axios.defaults.baseURL`** clients resolve
  through the same env/config machinery as other base-URL forms.

### Changed

- **Test files no longer feed the service lens.** Route registrations and HTTP
  calls in test/mock/fixture files (`__tests__/`, `*.spec.ts`, `test_*.py`,
  `*Tests.cs`, `_test.go`, `cypress/`, …) are test doubles, not production
  topology, and are now excluded the same way documentation files already were.

### Fixed

- **GraphQL consumers match on schema fields, not operation names.** The
  client-chosen document name (`query ProductPage`) never appears in the
  schema; the first selected root field (`product`) is what `type Query`
  declares, and is now what the matcher uses.

## 0.9.7

### Added

- **Structured map notes.** A note can now carry a short `title`, a `category`
  (architecture / gotcha / todo / risk / question), and — for a relation note —
  a `relationKind` (import / API call / event flow / shared data / config link /
  call / reference / inheritance) naming which relationship it's about when a
  file pair carries more than one kind of edge. Notes render as colored,
  icon-labeled category badges instead of a flat line of text, both in the
  Notes timeline and on the Map's node card. The Notes timeline gained a
  category filter row alongside the existing scope filter, and search now
  matches titles too.
- **More room to write.** The note body cap grew from 500 to 1000 characters,
  so an agent can record the full non-obvious "why" — a title plus a few
  tight sentences — instead of a single clause.
- **Richer canvas labels.** A selected relation note's floating edge label on
  the Map now shows its title (or relationship kind) instead of the generic
  "note" every annotation edge used to carry.
- **Agent guidance updated** to classify notes by category, set `relationKind`
  on ambiguous relation notes, and use the added room for a fuller "why"
  while staying skimmable.

### Changed

- `map_note_add` / `map_note_update` accept the new `title`/`category`/
  `relationKind` fields; `map_note_list` gained an optional `category` filter.
  Existing notes and callers are unaffected — all three fields are optional.

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
