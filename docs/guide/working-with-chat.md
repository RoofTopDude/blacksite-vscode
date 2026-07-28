# Working with Chat

The Chat panel is where you direct work. It looks like a chat box, but what is behind it is an
**agent loop** — a machine that alternates between asking the model what to do next and actually
doing it.

Understanding that loop is the difference between using Blacksite well and being surprised by it.
You can use the panel without learning its internals; the short version is that the model asks,
Blacksite checks and executes, and you can watch or stop the process. The rest of this guide explains
the controls in that order.

---

## What happens when you press Enter

1. Blacksite assembles a request: your message, the conversation so far, your workspace context,
   and the catalog of tools the agent may call.
2. The model replies with either prose (it is done) or a request to call a tool.
3. Blacksite executes the tool — reading a file, running a command, querying the map — and appends
   the result to the conversation.
4. Go back to step 1.

The model never touches your machine. It emits a structured request; Blacksite decides whether and
how to honour it. Every safety property in the product lives in step 3, not in the model's
judgement.

You can watch the whole thing. Each tool call appears in the transcript as it happens, with its
target and its result. Expand any of them to see the exact input the model sent and the exact output
it got back.

**Reasoning** appears above the answer as a single collapsed row — how long the agent thought, and
in how many steps. While it is still working, the row shows the line it is on. Expanding it breaks
the thinking into the steps it actually happened in, each followed by the tool calls that step
produced, so you can read the turn as the sequence of decisions it was rather than one block of
text. Code the agent works through mid-thought is syntax-highlighted, whether or not the block
carries a language tag.

**Cancel at any time** with the stop button, or **Blacksite: Cancel Current Run**. Cancellation is
honoured between tool calls, so an in-flight command finishes rather than being killed mid-write.

---

## Request profiles

The same request can mean different things. "Look at the checkout flow" might mean *plan a change*,
*review it for bugs*, or *find out why it's broken* — and those want genuinely different behaviour.

Blacksite exposes four **request profiles** in a row above the input:

### Auto

The default. Blacksite reads your message and resolves it conservatively to one of the specialized
profiles, or leaves it general. Resolution is deliberately cautious — an ambiguous request stays
general rather than being forced into the wrong mode. An explicit choice always wins over Auto.

### Plan

Read-only by default. The agent researches before prescribing, separates confirmed facts from
assumptions, asks focused questions at genuine forks, and produces a durable multi-phase plan with
outcomes, dependencies, validation, and acceptance criteria per phase.

It will not implement while in Plan. It will create plans, todos, notes, and plan documents — those
are the output. Switch profiles when you want the work done.

### Review

Read-only analysis. Defines the review contract from your request, reads repository instructions
before judging code against generic preferences, traces data and error paths end to end rather than
reading files in isolation, and verifies each finding against the actual code before reporting it.

Findings come back ordered by severity with file/line references, observable impact, evidence, and a
fix direction. If nothing is wrong it says so plainly — and still states what it did *not* prove.

### Debug

Hypothesis-driven. Translates the report into observed vs. expected behaviour, traces the failing
control and data flow, maintains a small ranked hypothesis set, and tests the highest-information
one first. It will not edit merely plausible code before locating the causal path.

When root cause is supported, it makes the smallest complete correction, adds a regression test at
the lowest reliable layer, and validates from narrow to broad.

> The profile shifts the whole panel as one state — the accent colour, the active controls, the
> focus ring, and the live indicators all move together. That is deliberate: the mode is visible
> without you having to check a label.

---

## Slash commands

Type `/` in the input to open the command menu.

| Command | Aliases | What it does |
| --- | --- | --- |
| `/clear` | `/new` | Start a fresh conversation |
| `/compact` | | Compact history to reclaim context |
| `/model <name>` | | Switch the active model |
| `/retry` | | Resend your last message |
| `/settings` | | Open the settings panel |
| `/history` | | Browse past conversations |
| `/help` | | List every slash command |

---

## Giving the agent context

Blacksite already sees your workspace, open editors, selection, and diagnostics. These add more,
deliberately:

**`@` mentions.** Type `@` in the input to search workspace files by name and attach one. Fastest
way to say "this file" without typing a path.

**Attachments.** The paperclip button, or drag files onto the input. Attachments are stored under
`.blacksite/reference/<sessionId>/` rather than being pasted into context — the agent gets tools to
list, read, zoom into images, query spreadsheets, and run vector search over them. That matters
because it means attaching a 200-page PDF does not blow up your context window; the agent retrieves
from it on demand.

**Editor commands.** Select code and run **Explain Selection** (`Ctrl+Shift+E` / `Cmd+Shift+E`), or
right-click a file for **Ask About This File** and **Attach File To Chat**.

**Base Context.** For knowledge that should ride along in *every* request — architecture decisions,
conventions, the reason a weird thing is weird — use Base Context instead of repeating yourself. See
[Plans & Context](plans-and-context.html).

---

## Question cards

When the agent hits a genuine fork — a product decision, an architecture choice, a scope question it
cannot resolve from the code — it does not guess and it does not bury the question in prose. It
renders a **question card**: the question, the options, what each one implies, and a recommendation.

For visual choices, options can carry a **sandbox preview** so you compare rendered results rather
than descriptions.

Answering a question card feeds the choice straight back into the loop. This is most common in the
Plan profile, where resolving forks early is the entire point.

Once answered, the card collapses to a single line — the question, and what you chose — so a
conversation with several decisions in it stays readable. Expand it to see the full question, your
answer with its rationale, and what it was chosen over.

---

## Approvals

Two gates stand between the agent and your machine:

**File edits.** Every edit is shown as a diff before it touches disk. Approve, reject, or open the
full preview.

**Sensitive commands.** Anything classified as file-write, network, or destructive raises a modal
prompt with the tool name and the exact operation. You can **Allow** once, **Allow All** for the
rest of this run, or **Deny**. Choosing "always allow" for a command persists its binary to
`blacksite.permissions.autoApprove` so it stops asking in this project.

[Approvals & Safety](approvals-and-safety.html) covers the classification rules and the allow/deny
lists in full.

---

## Compaction

Models have a fixed context window, and a long agent session will exhaust any of them — tool results
accumulate far faster than conversation does.

**Compaction** is the answer: when the conversation approaches the limit, the older portion is
summarized and replaced with that summary. The agent keeps working; it just remembers the distant
past in less detail.

Blacksite runs compaction in the background where it can and blocks only when it must. There is a
circuit breaker, because the naive version of this spirals — compact, immediately overflow, compact
again — and a pathological session should degrade rather than burn tokens in a loop.

You can force it early with `/compact` or **Blacksite: Compact Conversation History**. Worth doing
before starting a big new task in an old thread: you keep the accumulated understanding, and get
room to work.

The **Inspector** (ⓘ in the header) shows how full the window currently is.

---

## Subagents

Some work is better done in a separate context: reading twenty files to find three relevant ones,
verifying a claim independently, gathering evidence across an area you do not want summarized into
the main thread.

The agent can **spawn a subagent** for that. The subagent has its own context window and its own
tool access, does the work, and returns a result — so the parent's context is spent on orchestration
and synthesis rather than on raw material.

Four built-in profiles ship with it — **Frontend UI**, **Backend API**, **QA Regression**, and
**Repo Ops** — each with a tool surface and posture suited to that kind of work.

Subagents can run on a cheaper model than the main loop, which is often the right call for broad
triage.

### One at a time, or several at once

Both are available and the agent chooses. Running one lane and reading its answer before starting
the next is the default, and it is frequently the right one — the first result often changes what
the second task should even be.

When lanes are genuinely independent, the agent can **fan them out in parallel** instead: several
lanes in flight at once, bounded by **Max concurrent** in Settings → Subagents. That trades context
for wall-clock time, since every lane is paid for even if the first answer makes the rest moot.
Lanes that would edit the same files are kept sequential.

You will see this in the transcript directly — parallel lanes appear as sibling cards progressing
together rather than one after another.

### Budgets

Each lane is rated for complexity when it is created, and that rating sets how long it may run and
how many tool rounds it gets — a quick lookup and a broad investigation get budgets to match.

A lane that reaches the end of its budget still hands back what it gathered: its findings so far,
which files it touched, and what it ran. The agent reads that before deciding whether to continue
with what came back, narrow the task, or pick the lane up again.

### Picking a lane back up

A finished lane can be **re-opened** rather than replaced. It still holds everything it read and
worked out, so a follow-up question costs one message instead of a fresh lane rediscovering all of
it from nothing. The most recent lanes stay resumable for the rest of the conversation.

---

## Long outputs

Two things stop a large result from swamping the conversation:

**Result paging.** Big tool outputs are paginated. The agent pages through with `tool_output_page`
or searches within them with `tool_output_search` rather than pulling everything into context.

**Transcript documents.** For genuinely long deliverables — a full code review, a migration
write-up — the agent writes a navigable document and keeps the chat response concise. You get both:
a short answer in the thread and the full artifact to read properly.

Documents surface in the thread itself, the moment they are written — so a report produced early
in a long run is yours to read while the rest of the run is still going.

---

## History and durability

Conversations persist. The **history** button in the header (or `/history`) lists past sessions;
open one and continue it.

Sessions checkpoint as they go, so a crashed or reloaded window resumes rather than restarting. The
execution log — every tool call, its input, its result, its timing — is written to `.blacksite/` and
readable with **Blacksite: Show Execution Logs**. When something went wrong three steps back and you
want to know exactly what the agent saw, that is where to look.

Work the agent notices outside your request can be filed into **Tickets** instead of being buried in
the transcript or silently added to the current scope. Agent-filed items start in Triage, where you
decide what belongs in the backlog. See [Tickets & the Board](tickets-and-board.html).

---

## Related

- [Plans & Context](plans-and-context.html) — durable plans, curated context, memory, and notes
- [Tickets & the Board](tickets-and-board.html) — follow-up work that should survive the chat
- [Tool Reference](tool-reference.html) — every tool the agent can call
- [Approvals & Safety](approvals-and-safety.html) — the gates, in detail
- [Learn](../../learn.html) — why agent loops are built this way
