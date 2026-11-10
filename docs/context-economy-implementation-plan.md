# Context Economy — Implementation Plan

Status: **Phases 0–4 built and released in 1.33.0-pre.8, every setting off by default; 0.2 baselines and the live arms still open** · Prepared
2026-11-10 from a reading of `main` at 1.33.0-pre.7 (`c030f88`), for whoever implements it. Line
references are to that commit. Re-read each file before editing.

## Progress (2026-11-10)

| Step | State | Where |
| --- | --- | --- |
| 0.1 Session report | Built, behind `blacksite.context.report` (off). Fed from the ledger directly rather than from PAU receipts, so it works on every route, Converse included. Written to the execution log once per turn; `analyze:execution` has a Context section. | `src/context/report.ts`, `AgentSession._recordContextUsage` / `_takeContextReport` |
| 0.2 Baselines | **Not done.** Needs real long sessions, at least two on Bedrock Converse, with the report on. | `tests/eval/baselines/` |
| 0.3 Replay scorecard | Built. Three synthetic scenarios, arms `baseline` and `stable-caching`. | `tests/eval/replay/context-scorecard.spec.ts` |
| 1.1 Model | Built. | `src/context/model.ts` |
| 1.2 Archive | Built, **on by default** (it is what the paging tools read now). Every result is archived, memory first, then disk under workspace storage. Up to 5,000 results or 64 MB per conversation, 20 conversations, 7 days. `browser_*` / `web_*` results stay in memory only, matching the redaction everything else that persists applies to them. | `src/context/archive.ts`, `src/agent/tool-output-store.ts` |
| 1.3 Ledger | Built. Supersession from the freshness ledger's read/write classification; calibration against provider usage. Not yet checked against real usage: the "done when" needs 0.2. | `src/context/ledger.ts` |
| 1.4 PAU onto the ledger | **Partly.** The report does not depend on PAU. PAU still segments with pau-profiler; it now measures the stable block where the wire puts it. | `AgentSession._buildPauReceiptEvent` |
| 2.1–2.3 Stable context cached | Built, behind `blacksite.context.stableCaching` (off). Section stability is assigned in `layout.ts`. | `src/context/layout.ts`, `ModelRequest.contextStable`, each route in `packages/llm` |
| 2.4 Envelope text | Built. The stable block has its own envelope (`<blacksite-session-context>`); the static prompt gains one sentence when the flag is on. | `src/agent/transcript-hygiene.ts`, `buildStaticSystemPrompt` |
| 3.1 History budget | Built, `blacksite.context.historyBudgetTokens` (0). Counts the whole request as the provider reports it, not history alone: that is the figure the session has. The compaction checks read a fill scaled so the budget reads as the trigger percentage; it can only bring compaction forward. | `AgentSession._compactionThresholdTokens` / `_compactionFillPct` |
| 3.2 Aging policy | Built, `blacksite.context.aging` (`off`). Superseded first, then tokens × distance from the recent window. Never pinned, recent (the compaction keep-recent window), unrecoverable or already set aside. | `src/context/policy.ts`, `AgentSession._ageContext` |
| 3.3 Honest stubs | Built. Aging, the context tool and the emergency path all write the same record. The emergency path now says how to read a result back whenever the archive has it; that is one of two changes that apply with every setting off. | `src/context/stubs.ts` |
| 3.4 Cache-aware timing | Built. Runs at a turn's first call from 80% of the threshold, or at any call over it, and aims for 60%. Below the threshold it acts only when reads saved over min(20, iterations) requests beat re-caching the history after the earliest change. On ChatGPT sign-in it acts only over the threshold, since a changed history means a new Codex thread. | `planAging`, `AGING_*_FRACTION` |
| 3.5 Provider-native back ends | **Not done.** Anthropic context editing is still its own opt-in. Worth doing once `aging: on` has run live. | |
| 3.6 Smaller inline results | Built, `blacksite.context.inlineResultChars` (20000). At 20000 the cut is the old head-only one; at any other value it keeps the head (60%), the tail (25%) and the failure lines between. | `capToolResultKeepingEnds` |
| 4.1 Status line | Built, `blacksite.context.awareness: status`. Facts only, in the live block before the checklist, from the previous request's usage. | `AgentSession._contextStatusLine` |
| 4.2 `context` tool | Built, `awareness: status+tool`. Deferred. `review`, `set_aside` (ids or `through`, with a note), `carry_forward`. Reports tokens freed per request and tokens re-cached once. | `CONTEXT_TOOLS`, `AgentSession._handleContextTool` |
| 4.3 Carry-forward note | Built. Kept verbatim ahead of the next summary, used once, persisted with the checkpoint. A later recondense of a long summary can still paraphrase it. | `AgentSession._compressHistory` |
| 4.4 Prompt | Built. One paragraph of fact when awareness is on, no directive. | `buildStaticSystemPrompt` |
| 4 Judging the arms | **Not done.** The scripted scorecard prices sight (about 70 tokens a request) and control (about 500, the tool definition), but a scripted model cannot react to either. The three-arm comparison needs the live suite. | `tests/eval/replay/context-scorecard.spec.ts` |
| 5–6 | Not started. | |

Things learned while building it:

- The archive changes one thing even with every flag off: `tool_output_page` can now read results
  that were never truncated. The tool descriptions still say "only works for results truncated
  earlier". That is left alone until Phase 3's stubs point the agent at the archive, so the prompt
  is unchanged in this step.
- The execution log's sanitiser blanks any key that looks like a token or a session. The report's
  keys are fixed and hold no secrets, so it is logged with that filter off and string redaction
  still on. A spec pins this.
- Stable caching reads its flag live, but the system prompt's sentence about the stable block is
  fixed when the chat starts. Turning the flag on mid-chat works: the block explains itself. The
  sentence reads "may", so turning it off mid-chat leaves nothing false.
- The architecture summary is classed as stable. That is a judgement call. If the Phase 0 report
  shows cache writes on most turns with stable caching on, move it to live first.
- The paging tools' descriptions now say they read back any earlier result, including set-aside
  ones. This changes the tool-schema bytes with every setting off: the snapshot hashes moved, and
  no other request byte did. It had to change once stubs began pointing the agent at those tools.
- A partial `contextFlags` object read missing settings as "not off". The session now merges what
  the host gives over the baselines. The scorecard found this: its baseline arm had been carrying
  the status line.
- The `observe` count is summed over passes: a result that qualifies at three turn boundaries
  counts three times. It measures pressure, not distinct results.
- Calibration (reported ÷ estimated) has only run against scripted usage figures, so no ratio seen
  so far means anything. The first real number comes from 0.2. Set budgets from calibrated
  figures, never raw estimates.

Companion docs: [`agent-system-prompt-review.md`](./agent-system-prompt-review.md),
[`responsiveness-and-file-size-review.md`](./responsiveness-and-file-size-review.md),
[`../tests/eval/README.md`](../tests/eval/README.md).

Token figures are estimates (characters ÷ 3.6) measured from the real prompt builder and tool
definitions with a throwaway probe. Nothing here was measured on a live session; Phase 0 exists to
replace these estimates with real ones.

## 1. Goal

Two things, in this order:

1. **Cut what every request carries**, both before the user types anything and as a conversation
   grows, on every route (Anthropic, Bedrock Converse and Mantle, OpenAI, OpenRouter, ChatGPT
   sign-in) and in every delegated lane.
2. **Do it in a way that leaves the agent more room to think, not less.** The context is the
   agent's working memory. The aim is an agent that can see the state of that memory, has the
   means to manage it, and decides for itself — not one that follows a longer list of rules about
   it.

The second point decides how most of this plan is built, so it gets its own section.

## 2. Design stance

**Inform, equip, then get out of the way.** Behaviour that is instructed is a performance of the
instruction. Behaviour that comes from the agent seeing its situation clearly and having good tools
is a decision. Each change below is checked against four rules:

1. **Facts over directives.** Tell the agent what is true (how full its context is, what was set
   aside and how to get it back, what a tool costs). Do not tell it what to conclude.
2. **Mechanism over instruction.** If the harness can do the bookkeeping, it does it silently. A
   rule in the prompt is the last resort, kept only where the model cannot infer the right thing
   from facts and tools.
3. **Everything set aside can be brought back.** The agent can only reason freely about memory it
   trusts. Aging, stubbing and compaction never destroy information; they move it to a place the
   agent can read from, and say where.
4. **Reasons, not commands.** Where guidance stays, it explains the constraint and the failure it
   prevents, and leaves the choice to the agent.

This matches the standing direction that the agent is over-constrained: accurate gates,
harness-done bookkeeping, and rare, specific reminders over more rules.

A consequence worth stating: **trimming the prompt is not only a cost saving.** The static prompt
holds 49 always/never/must directives in about 15k tokens. Removing the ones that script behaviour
is the largest single change this plan makes to how the agent thinks.

## 3. What was measured

### 3.1 Before the user types anything: about 27k tokens

| Piece | ~Tokens | Where |
| --- | --- | --- |
| Static system prompt | 15,200 | `buildStaticSystemPrompt`, `src/workspace-context.ts:453` |
| 19 core tools | 11,200 | `CORE_TOOL_NAMES`, `src/agent/tool-loading.ts:39` |
| `tool_search` roster | 1,050 | `toolSearchDescription`, same file |

System prompt by section:

| Section | ~Tokens |
| --- | --- |
| Guidelines | 4,650 |
| Your toolset | 2,400 |
| Output Formatting | 2,100 |
| Environment & tooling | 1,900 |
| Codebase Map: usage & note-taking | 1,450 |
| Engineering judgement | 1,075 |
| Architecture & repository shape | 770 |
| Preamble | 615 |
| Editing discipline | 195 |

Core tools: `question_card` (3,100) and `subagent_spawn` (1,700) are 43% of the core set. The
other 17 average about 375 each.

On-demand tool loading already avoids the worst case: all 163 tools would be about 55k tokens.

### 3.2 Re-sent on every model call, outside the cache

`_dynamicContext()` (`src/agent-session.ts:1697`) builds one `<blacksite-context>` block that is
appended to the newest turn on every request and never kept in history. That design is right. Its
cost is not: the block sits after the last cache breakpoint, so it is billed at the full input
price on every call, including every tool round. It contains:

- the active request profile;
- **the full body of every loaded skill** (`_skillContext`, line 1684);
- workspace instructions, up to 16,000 characters (`MAX_INSTRUCTION_CONTEXT_CHARS`,
  `src/workspace-context.ts:114`);
- project shape, installed toolchains, open editors, diagnostics, git status;
- `.blacksite/context.md`, Base Context, project memory, UI preferences;
- the plan summary, the ticket queue summary, the skill roster;
- any run notice and the closing checklist.

Only open editors, diagnostics, git status, the run notice and the checklist change between tool
rounds. The rest is stable for a whole turn and usually a whole session, and is re-billed in full
anyway. A session with two loaded skills and a full instruction budget can carry well over 10k
uncached tokens per call. A 40-round turn pays for that 40 times.

### 3.3 Growth from turn to turn

- **Every tool result stays in full until compaction.** One result can be 20,000 characters, about
  5.5k tokens (`DEFAULT_PAGE_CHAR_LIMIT`, `src/tool-result-paging.ts:25`).
- **Compaction starts at 60% of the context window** (`src/agent-session.ts:4190` and `5745`),
  with a critical line at 82% (`COMPACTION_CRITICAL_PCT`, line 178). On a 1M-window model that is
  about 600k tokens. A 200K-window session compacts at 120k. Nothing bounds the absolute size.
- **Only oversized results can be read back.** `ToolOutputStore` (`src/agent/tool-output-store.ts`)
  keeps the full text of a result only when it overflowed the 20k limit, and only the newest 30.
  A result that fit is in history or nowhere.
- **The one aging mechanism is an emergency.** `_emergencyTruncateOldestToolResults`
  (`src/agent-session.ts:3858`) stubs old results only after compaction has failed, and its stub
  tells the agent to re-run the tool.
- **Anthropic's context editing is opt-in and Anthropic-only** (`contextEditingEnabled`). Bedrock
  Converse, OpenAI, OpenRouter and ChatGPT sign-in have no equivalent.
- **Compaction appends.** Each pass adds a summary to an uncached system block
  (`buildAnthropicSystemBlocks`, `packages/llm/src/wire/anthropic.ts`), re-condensed only past
  30,000 characters (`MAX_SUMMARY_CHARS`).

### 3.4 Delegated lanes

A lane's prompt is seven lines of lane rules plus the entire static prompt
(`buildDelegatedSystemPrompt`, `src/chat/subagent-lanes.ts:393`), with the full core tool set. Each
lane starts cold, so it pays the 27k with no cache to spread it over. Much of what it carries
cannot apply to it: plan and ticket rules, `question_card` design guidance, output formatting for a
reader who is another agent.

### 3.5 What the agent cannot see

The agent is never told how full its context is. `usagePct` is computed for the UI
(`src/agent-session.ts:2879`) and stops there. It cannot tell that a compaction is close, what one
would keep, or that a result it is about to re-request is already in its history. It has no way to
set anything aside itself. Every decision about its own working memory is made for it, out of
sight.

### 3.6 Measurement already exists, switched off

The PAU receipts (`src/pau-metrics.ts`, `_buildPauReceiptEvent`) already break a request into
segments with token counts, duplication, replay counts and cache economics. The setting
`blacksite.pau.enabled` defaults to `false`, and nothing aggregates a session.

## 4. The foundation: a context ledger

Every later phase needs the same three things: to know what each part of a request is, what it
costs, and what may be done with it. Today that knowledge is spread across `_dynamicContext`, the
wire builders, the compactor and the PAU adapter, each with its own view. This plan introduces one
model that they all read.

**`src/context/`** — new, pure modules, no VS Code imports, shared with the webview where useful.

```
src/context/
  model.ts      ContextItem, ContextClass, ContextBudget — types only, frozen first
  ledger.ts     per-session record of what is in the request and what has been set aside
  archive.ts    durable store of every tool result, addressable by id
  policy.ts     pure decisions: what may be set aside, in what order, to reach a budget
  layout.ts     where each class of item sits in a request, and which cache boundary it is behind
  report.ts     per-request and per-session breakdowns, from the ledger
```

A **`ContextItem`** is one unit of a request: a system section, a tool definition, a message, a
tool result, an attached block. Each has:

- `id` and `class` (`system`, `tool-definition`, `attached-stable`, `attached-live`,
  `user-message`, `assistant-message`, `tool-result`, `summary`);
- `tokens`, estimated at creation and corrected from provider usage where possible;
- `stability`: `session`, `turn` or `call` — how often its bytes change, which decides which
  cache boundary it belongs behind;
- `recall`: how to get it back if set aside (`archive:<id>`, `re-read:<path>`, `none`);
- `pinned`: never set aside (a user's own words, an unanswered question, anything in
  `UNSHEDDABLE_TOOL_NAMES`);
- `supersededBy`: a later item that makes this one redundant (a newer read of the same unchanged
  file).

The ledger is the single place that answers "what is in this request, and why". The reporter, the
aging policy, the compactor, the agent-facing view and the PAU adapter all read it. New context
features after this plan add a class or a policy, not another parallel bookkeeping path.

**Why this is the foundation for later work.** With a ledger, these become small additions
rather than new subsystems:

- per-lane and per-plan-run context budgets;
- handing a lane a chosen slice of the parent's context by reference;
- provider-native features (context editing, server compaction, message threads) as alternative
  back ends of the same policy;
- a context view in the UI that shows the user what the agent is carrying;
- replay tests that assert on context shape, not only on behaviour.

## 5. Phases

Each phase ships behind a setting whose default is today's behaviour, in the style of the
orchestration flags (`src/orchestration/flags.ts`): a baseline value, a shadow value that records
without acting where that makes sense, and a one-line rollback. No default changes until Phase 0's
numbers and a replay run support it.

### Phase 0 — Measure

Nothing below should be tuned on estimates.

- **0.1 Session report.** Add `report.ts` and a per-session aggregate: tokens by class, cached vs
  uncached, the largest items, results that were never referred to again, repeated reads. Feed it
  from the existing PAU receipts first; move it onto the ledger in Phase 1. Write it to the
  execution log and add an `analyze:execution` section for it.
- **0.2 A baseline.** Record the report for a handful of real long sessions, at least two of them
  on Bedrock Converse, and commit the summaries under `tests/eval/baselines/` as the reference
  every later phase is compared with.
- **0.3 A context scorecard for replays.** Extend the replay harness (`tests/eval/harness/`) to
  emit tokens-per-request and peak context per scenario, so a phase that saves tokens but costs
  extra rounds shows up as such. Judge by cost per completed task, never per request.

Done when: a session's breakdown can be read from its log, and baselines exist.

### Phase 1 — Ledger and archive

No behaviour change. This is the groundwork.

- **1.1 `model.ts`**, frozen before anything else is written against it.
- **1.2 `archive.ts`.** Store every tool result's full text when it is produced, keyed by tool call
  id, on disk under the session's storage with a size cap and oldest-first eviction. It replaces
  the in-memory, overflow-only `ToolOutputStore`; `tool_output_page` and `tool_output_search` read
  from it unchanged. This removes the "only the newest 30 truncated results" limit and is what
  makes rule 3 of §2 true.
- **1.3 `ledger.ts`.** Build the item list where the request is built (`_dynamicContext`, the wire
  builders' inputs). Mark supersession from `file-freshness.ts`, which already tracks reads and
  changes per file.
- **1.4 Move the PAU adapter and the Phase 0 report onto the ledger.**

Done when: the ledger's totals agree with provider-reported usage within the estimator's error on
the replay suite, and the paging tools pass their existing tests against the archive.

### Phase 2 — Stop paying for stable context on every call

The cheapest large win, with no effect on what the agent sees.

- **2.1 Split the attached block by stability.** `layout.ts` assigns each part of today's block to
  `attached-stable` (instructions, project shape, toolchains, Base Context, project memory, UI
  preferences, skill roster, loaded skill bodies, request profile) or `attached-live` (open
  editors, diagnostics, git status, plan and ticket summaries, run notice, checklist).
- **2.2 Put the stable part behind a cache boundary.** Anthropic allows four breakpoints and all
  four are in use: tools, system, and two rolling message anchors. The stable part therefore goes
  into the system array as a second block after the static prompt, with the breakpoint moved to
  it, so the order is: static prompt, stable context (breakpoint), compaction summary. It changes
  only when a skill is loaded or a watched file changes, which costs one cache write each time.
  Apply the equivalent on Converse (`cachePoint` after the stable system block) and on the
  OpenAI-compatible routes, where prefix caching is automatic and only ordering matters.
- **2.3 Keep the live part where it is**, at the tail, uncached, and small.
- **2.4 Update the envelope text** (`wrapAttachedContext`, `src/agent/transcript-hygiene.ts`) and
  the prompt's description of it, since "a fresh copy on every request" will describe only the
  live part.

Risk: a stable block that is not byte-stable silently defeats the cache. Guard it with a test that
builds two consecutive requests and asserts the cached prefix is identical, and watch
`cache_read_input_tokens` in the Phase 0 report.

Done when: uncached input tokens per tool round drop to roughly the live part's size on the
replay scorecard, with no change in behaviour.

### Phase 3 — Bounded history, with everything recoverable

- **3.1 An absolute compaction budget.** Trigger at the lower of the existing percentage and a
  token budget (proposed default 150k, setting `blacksite.context.historyBudgetTokens`). Today a
  1M-window session carries five times the history of a 200K one before anything happens.
- **3.2 Aging in `policy.ts`.** A pure function from the ledger and a budget to a list of items to
  set aside, in this order: superseded results first, then results by age and size, never pinned
  items, never the recent window. It runs before compaction and usually makes compaction
  unnecessary.
- **3.3 Honest stubs.** A stubbed result is replaced by a short record: the tool, its arguments, a
  one-line outcome, its size, and how to get it back (`tool_output_page` with its id, or a re-read
  where the file has not changed). Replace the emergency stub's "re-run the tool" wording with the
  same record. Structure is preserved exactly as `_emergencyTruncateOldestToolResults` does today:
  every `tool_use` keeps its `tool_result`.
- **3.4 Cache-aware timing.** Stubbing an old message invalidates the cached prefix from that
  point. Apply aging in batches at turn boundaries or when the budget is crossed, not on every
  round, so one cache write buys a long stretch of smaller reads. `policy.ts` takes the cache
  economics already computed in `pau-cache-economics.ts` and only acts when the saving exceeds the
  rewrite.
- **3.5 Provider-native back ends.** On Anthropic, the same policy can be expressed as context
  editing (`clear_tool_uses_20250919`) where it is enabled. The policy decides; the back end is a
  route detail.
- **3.6 Smaller inline results.** With the archive holding everything, lower the inline limit from
  20,000 characters toward 8,000 and make truncation keep the head, the tail and any error lines,
  as the paging module's signal keywords already allow.

Modes for `blacksite.context.aging`: `off` (baseline), `observe` (records what it would have set
aside and the tokens saved, changes nothing), `on`.

Done when: on the replay suite in `on`, peak context is bounded by the budget, task outcomes match
the baseline arm, and the count of extra rounds spent recovering stubbed results is reported and
small.

### Phase 4 — Give the agent sight and control of its own context

This is the phase that the design stance is about. Everything before it is the harness managing
context well. This lets the agent take part.

- **4.1 A context line in the live block.** One or two lines of fact, from the ledger: how full
  the context is against its budget, how much is older tool output, and that set-aside results can
  be read back. No instruction attached. An agent that knows it is at 70% plans a long refactor
  differently from one that does not, without being told to.
- **4.2 A `context` tool, deferred, two actions.**
  - `review`: what the ledger holds, grouped and sized, with what is superseded or already set
    aside.
  - `set_aside`: the agent names results or ranges it no longer needs, with an optional note to
    its future self about what they established. The note stays in history; the bulk goes to the
    archive. This is the agent choosing what to remember, in its own words, at the moment it
    understands the material best — which is strictly better than a summariser guessing later.
- **4.3 Compaction the agent can prepare for.** When the budget is near, the live block says so as
  a fact. The agent may write its own carry-forward note, which the compactor keeps verbatim ahead
  of its own summary. If the agent writes nothing, compaction behaves as it does today.
- **4.4 No new rules.** The prompt gains a short description of what these are and what they
  cost, in the "what your working memory is" register, and no directive to use them. Whether the
  agent uses them, and when, is the thing being observed.

How to judge it: compare three replay arms — harness-only aging (Phase 3), sight only (4.1), and
sight plus control (4.2, 4.3) — on outcome, rounds and tokens. If sight alone changes behaviour
for the better, that is the emergent result this plan is after, and it argues for giving the agent
more facts elsewhere. If the tool goes unused, that is a finding too: keep the line, drop the tool.

Done when: the three arms have been run and the default is chosen from the result.

### Phase 5 — A smaller prompt that explains instead of instructs

Run after Phases 2–4, so the prompt can lean on what they provide.

- **5.1 Sort every line of the static prompt into four bins.**
  - **Facts about the environment** the agent cannot discover (the attached block, approval
    tiers, how compaction works). Keep, tighten.
  - **What a tool is for.** Move into that tool's description, where it arrives with the tool and
    costs nothing until then. Most of "Your toolset" (2,400) and the plan, ticket and
    `question_card` guidance in Guidelines belongs here.
  - **Procedure for one kind of work** (diagram and chart formatting, visual questions, Codebase
    Map note-taking). Move into skills or into the deferred tool family's description, loaded when
    that work starts.
  - **Directives that script judgement** ("after each tool result, decide the next step
    immediately", "narrate briefly between steps"). For each: delete it, or rewrite it as the fact
    behind it. "Each turn you end is a full round trip" is a fact the agent can act on; "issue
    independent calls in the same turn" is the conclusion it should be left to draw.
- **5.2 Keep "Engineering judgement".** It is the one section written as reasons, and it is the
  model for the rest.
- **5.3 Make the prompt sectional in code.** Replace the single `parts` array with named sections
  that each declare a class and stability, registered with `layout.ts`. This is what lets a lane,
  a request profile or a provider take a subset without string surgery.
- **5.4 Shrink the two large core tools.** `question_card` (3,100) and `subagent_spawn` (1,700):
  move worked examples and design guidance to a skill, keep the schema and one paragraph.
- **5.5 Reconsider the core set with Phase 0's data.** Which core tools are called in under, say,
  one session in five? Those can be deferred. Which deferred tools are loaded in most sessions?
  Those should be core.

Target: static prompt from about 15k to 6–8k, core tools from about 11k to 7–8k. Treat the target
as a consequence of the sorting, not a quota.

Method: one section per change, each with a replay run and a short live comparison, because a
prompt edit that looks neutral can move behaviour. Keep the previous prompt selectable by setting
(`blacksite.context.promptProfile`: `classic` or `lean`) until the lean one has run in real use.

Done when: the lean profile matches or beats classic on the replay scorecard and in live use, and
becomes the default.

### Phase 6 — Lanes

- **6.1 A lane prompt assembled from sections**, not the full prompt with a preface: environment
  facts, engineering judgement, editing, and the lane rules. No plan, ticket, question-design or
  user-facing formatting sections.
- **6.2 A lane tool set chosen by profile.** A read-only research lane does not need the edit
  tools; a verification lane does not need `subagent_spawn`.
- **6.3 Shared cache prefix across lanes.** Lanes of one parent that share a prompt and tool set
  should produce byte-identical prefixes, so the second lane onward reads the first one's cache.
  The existing tools-breakpoint comment in `packages/llm/src/providers/anthropic.ts` already aims
  at this; verify it holds once prompts are sectional.
- **6.4 Lane budgets from the ledger.** A lane gets a context budget alongside its round and time
  budgets, and its receipt reports peak context.

Done when: a fan-out replay (`tests/eval/fixtures/delegation-fanout`) shows lower total tokens for
the same outcome.

## 6. Order, size and dependencies

| Phase | Depends on | Rough size | Changes behaviour |
| --- | --- | --- | --- |
| 0 Measure | — | small | no |
| 1 Ledger and archive | 0 | medium | no |
| 2 Stable context cached | 1 | medium | no (cost only) |
| 3 Bounded history | 1 | medium–large | yes, behind a setting |
| 4 Sight and control | 1, 3 | medium | yes, behind a setting |
| 5 Lean prompt | 0; better after 2–4 | large, incremental | yes, behind a setting |
| 6 Lanes | 5.3 | medium | yes |

Phases 2 and 3 are independent of each other after Phase 1 and can run in parallel. Phase 5 can
start its sorting pass (5.1) at any time, since that is analysis.

Suggested releases: 0+1 together as a prerelease with no visible change; 2 alone, since it is
pure saving and easy to verify; 3 in `observe` first; 4 and 5 as experiments with their settings
off.

## 7. Settings introduced

All default to today's behaviour.

| Setting | Values | Baseline |
| --- | --- | --- |
| `blacksite.context.report` | boolean | `false` |
| `blacksite.context.stableCaching` | boolean | `false` |
| `blacksite.context.historyBudgetTokens` | number, 0 = none | `0` |
| `blacksite.context.aging` | `off`, `observe`, `on` | `off` |
| `blacksite.context.inlineResultChars` | number | `20000` |
| `blacksite.context.awareness` | `off`, `status`, `status+tool` | `off` |
| `blacksite.context.promptProfile` | `classic`, `lean` | `classic` |

## 8. Risks

- **Cache churn that costs more than it saves.** Aging and stable-block changes both rewrite the
  cache. Mitigated by batching (3.4), the byte-stability test (Phase 2) and reading cached vs
  uncached tokens from the Phase 0 report after every phase.
- **Losing something the agent needed.** Mitigated by rule 3: nothing is set aside without a way
  back, pinned items are never touched, and `observe` mode shows what would have gone before
  anything does.
- **Recovery loops.** An agent that keeps paging back what was just stubbed costs more than it
  saves. The replay scorecard counts recovery rounds; the policy's recent window and supersession
  rule should keep it low. If not, widen the window before anything else.
- **A lean prompt that regresses quietly.** Mitigated by one section per change, the selectable
  classic profile, and live comparison before any default changes.
- **Estimator error.** The 3.6 characters-per-token figure is rough and differs by tokenizer.
  Budgets should be set from provider-reported usage, which the ledger corrects against.
- **Provider differences.** Converse cache points, OpenAI prefix caching and ChatGPT sign-in's
  persistent thread each behave differently. `layout.ts` owns those differences; no phase should
  special-case a route anywhere else.

## 9. Open questions for the owner

1. **History budget default.** 150k is a starting guess. The Phase 0 baselines should set it.
2. **How far Phase 4 goes.** The status line is low risk. The `set_aside` tool gives the agent
   real control of its memory; it is the most interesting part and the least proven.
3. **Classic prompt lifetime.** Whether `classic` stays as a permanent option or is removed once
   `lean` is the default.
4. **Live evaluation.** The orchestration work shipped without a live eval run. This plan's Phase
   0 needs a provider key and a spend ceiling to produce baselines; without them every default
   stays where it is.

## 10. Out of scope

- Anthropic message threads (`message-threads-2026-08-12`). They shrink requests without shrinking
  context, and cannot be combined with compaction or most context editing. Worth a separate look
  once the ledger exists, as another back end.
- Changing the compaction summariser's prompt or model.
- The checkpoint path rewriting the full message list on every tool round. It is a disk and CPU
  cost, not a context cost, and is tracked in the harness review notes.
