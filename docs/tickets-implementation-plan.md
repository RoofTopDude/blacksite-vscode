# Local Ticketing — Design & Implementation Plan

Status: proposed · Owner: Blacksite VS Code extension · Proposed view id: `blacksite.work`

Companion designs: [`codebase-map.md`](./codebase-map.md), [`guide/plans-and-context.md`](./guide/plans-and-context.md)

A project-local ticketing surface — a durable queue of independently-schedulable
work — wired into Plans (which execute a ticket) and the Codebase Map (which
locates one). This document specifies the data model, the contract that keeps it
from becoming a second progress tracker, every integration point, and a five-phase
build order.

It also carries a **standalone enhancement to Plans**: rendering markdown in plan
text and attached plan documents (§9). That work is a prerequisite for Tickets and
ships first, on its own, in Phase 0.

---

## 1. Objective

Give the workspace a durable, agent-addressable **backlog**: units of work that
exist before a plan, outlive the plan that satisfies them, and can be ranked,
filtered, located in the codebase, and picked up across sessions.

Three capabilities the extension does not have today:

1. **The agent can file work without doing it.** Today, an agent that notices a
   real bug mid-task chooses between scope creep, a chat message lost to
   compaction, or a `todo`-category map note with no lifecycle. None is correct.
2. **The agent has a queue, not just a spine.** When a plan completes, there is
   nothing to pick up. "What is the next unblocked ticket in this area" is
   currently unanswerable.
3. **Work has a location.** Plans already declare per-phase map territory
   (`TaskPlanPhase.files`). Tickets generalize that one level up, which makes
   "where is the work piling up", "which two open tickets touch the same code",
   and "what else lives in this blast radius" first-class questions.

---

## 2. The contract (load-bearing)

The system prompt already spends four separate guidelines warning the agent not
to let `todo_*` runs become a second progress tracker
([`workspace-context.ts:407-410`](../src/workspace-context.ts#L407-L410)). A
ticket surface repeats that mistake at a larger scale unless the boundary is
structural rather than advisory.

| Surface | Holds | Lifetime | Owner |
| --- | --- | --- | --- |
| **Ticket** | One outcome that should be true. Status, priority, territory, links. | Outlives sessions *and* plans | Project |
| **Plan** | How one piece of work gets done now: sequenced phases, execution-gated | One work effort | Agent, user-approved |
| **Todo run** | Tactical decomposition of the step in flight | Minutes | Agent |
| **Map note** | Durable knowledge *about code* | Until the code changes | Agent + user |

**The enforcing rule: a ticket has no steps.**

There is no `steps[]`, no per-item status, no progress meter the agent can
maintain. A ticket carries a status and a `planId`. Where a plan is linked,
ticket status is *derived* from that plan's phase state; where none is linked, it
is manual. Progress therefore has exactly one home — `plan_update` — and the
ticket surface is additive rather than competing.

This is enforced in the store (`reconcileTicket`, §5.3), advertised in the tool
descriptions, and asserted in tests.

**Corollary for prompt guidance:** the agent is told to file tickets *instead of*
widening scope, and to convert a ticket into a plan when it starts work — never
to maintain both.

---

## 3. Non-goals

- **Not a Jira/Linear replacement or client.** No sprints, epics, story points,
  estimates, or workflows. `jira_op` / `github_create_issue` already exist for
  reaching real trackers; §12 covers optional one-way export.
- **Not multiplayer.** `.blacksite/` is gitignored today, so v1 is a personal,
  project-local queue. §15 records the fork.
- **No assignee field in v1.** Single-player makes it noise. The schema is
  additive, so it can arrive with sharing.
- **Not a replacement for map notes.** A note says what is true about code; a
  ticket says what should change. Promotion between them is one-directional and
  explicit (§10.3).
- **Not automatic ticket creation.** Every agent-filed ticket is a deliberate
  tool call, visible in the transcript. Bulk triage sweeps (Phase 4) always land
  in `triage` status for user review, never straight into the backlog.

---

## 4. Success criteria

1. An agent that notices out-of-scope work files a ticket and continues its task,
   without touching the plan it is executing.
2. The agent's per-turn context names open tickets touching the files currently
   in play, costing zero tool calls.
3. A ticket promoted to a plan carries its title, body, and territory into
   `plan_create`, and the resulting plan back-links to the ticket.
4. Ticket status never has to be maintained in two places: with a linked plan,
   advancing a phase advances the ticket.
5. The Map can answer "where is open work" and "which open tickets collide on the
   same files" without a new resolution layer — both read existing node ids.
6. Ticket state survives session boundaries, compaction, and plan deletion.
7. The store, its normalizers, status derivation, and prompt summarization have
   direct unit coverage matching [`planning-store.spec.ts`](../tests/unit/planning-store.spec.ts).
8. Every new surface reads as native: same tokens, same motion vocabulary, same
   reduced-motion discipline as the Map and Plans.
9. Markdown the agent already writes into plans and plan documents renders as
   markdown — tables, code blocks, and file links that open in the editor — without
   a schema change, and without the Plans panel paying the parser's cost until
   something is actually expanded.

---

## 5. Data model

### 5.1 Storage

`.blacksite/tickets.json`, written by `TicketStore`
(`src/ticket-store.ts`), modeled directly on
[`planning-store.ts`](../src/planning-store.ts): schema version, tolerant
normalization on read, full-document rewrite on mutation, a
`vscode.EventEmitter` `onDidChange`, and a `dispatch(op, payload, ctx)` surface
backing the agent tools.

Long-form ticket bodies live on disk, not inline — the same reasoning
[`plan-doc-store.ts`](../src/plan-doc-store.ts) documents for plan docs
(`tickets.json` is rewritten in full on every status change). `PlanDocStore`
gains an optional second constructor argument for its subdirectory (`"plans"`
default, `"tickets"` for this store), so the doc machinery is reused rather than
duplicated.

### 5.2 Shape

```ts
export type TicketStatus =
  | "triage"      // filed, not yet accepted — the agent's landing zone
  | "backlog"     // accepted, not started
  | "in_progress" // a plan is executing it (or manually started)
  | "blocked"
  | "review"      // work done, awaiting the user's verification
  | "done"
  | "cancelled";

export type TicketPriority = "urgent" | "high" | "normal" | "low";

export type TicketOrigin = "user" | "agent" | "map_note" | "diagnostic" | "review";

export interface Ticket {
  id: string;                 // "BLK-12" — sequential, human-readable, via nextSeq
  title: string;
  /** Short body. Anything longer belongs in docs[]. */
  body?: string;
  status: TicketStatus;
  /** "derived" while a linked plan drives status; flips to "manual" the moment a
   *  user sets status by hand, and derivation stops overriding (see reconcileTicket). */
  statusSource: "manual" | "derived";
  priority: TicketPriority;
  labels: string[];
  /** Map territory — workspace-relative node ids, normalized by the same
   *  normalizePlanFiles dialect phases use. THE join key to Plans, Map, and git. */
  files: string[];
  /** The plan executing this ticket, when one exists. */
  planId?: string;
  /** Set when a single phase (not the whole plan) satisfies this ticket. */
  phaseId?: string;
  /** Ticket ids that must close first. Informational, never enforced — mirrors
   *  TaskPlanPhase.dependsOn. */
  blockedBy: string[];
  origin: TicketOrigin;
  /** Map note id, diagnostic key, or review reference this ticket came from. */
  originRef?: string;
  notes: string[];
  docs: PlanDocMeta[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  sessionId?: string;
}

export interface TicketDocument {
  schemaVersion: number;
  updatedAt: string | null;
  /** Array order is backlog rank — the board reorders in place. */
  tickets: Ticket[];
}
```

Deliberately absent, with reasons: **`steps`** (§2), **`assignee`** (§3),
**`estimate`** (a number the model cannot calibrate honestly — the same reason
`PlanComplexity` is qualitative), **`sprint`** (no cadence to hang it on).

**Ranking** is array order, reordered by drag on the board. Fractional-index
ranking is deferred until concurrent editing exists to justify it.

### 5.3 Status derivation

`reconcileTicket(ticket, plans)` runs inside `TicketStore.read()`, mirroring how
`reconcilePlan` already runs inside `PlanningStore.read()`. For a ticket with
`statusSource === "derived"` and a live linked plan:

| Linked plan state | Derived ticket status |
| --- | --- |
| Plan missing or terminal-cancelled | `backlog`, link cleared, note appended |
| `executionApproved === false` | `backlog` (hint: "plan awaiting approval") |
| Any phase `in_progress` | `in_progress` |
| Any phase `blocked` | `blocked` |
| All phases `completed` | `review` — **not** `done` |
| Plan `on_hold` | `blocked` |

`done` is never derived. Closing a ticket is an explicit act, by the user or by
an agent the user has permitted (§7.4) — the same posture Plans take toward
archiving via `agentCanArchive`.

A manual status change sets `statusSource: "manual"`; the UI keeps showing what
the plan says as a dimmed hint, so the divergence is visible rather than silent.

---

## 6. Host architecture

### 6.1 New files

| File | Role |
| --- | --- |
| `src/ticket-store.ts` | Document, normalizers, `dispatch`, `reconcileTicket`, `summarizeTicketsForPrompt` |
| `src/ticket-provider.ts` | `WebviewViewProvider` for the sidebar queue; message handling; cross-wires to Map + Plans |
| `src/ticket-board-panel.ts` | Editor-tab board (`createWebviewPanel`), modeled on [`notes-timeline-provider.ts`](../src/notes-timeline-provider.ts) |
| `src/webview/react/apps/work/` | `main.tsx`, `WorkApp.tsx`, `QueueTab.tsx`, `TicketCard.tsx`, `store.ts` |
| `src/webview/react/apps/board/` | `main.tsx`, `BoardApp.tsx`, column/drag components |
| `src/webview/react/lib/tickets/protocol.ts` | Hand-mirrored message contract (repo convention) |
| `tests/unit/ticket-store.spec.ts` | Normalizers, derivation, prompt summary |
| `tests/unit/ticket-provider.spec.ts` | Message handling, path containment |

### 6.2 Changed files

| File | Change |
| --- | --- |
| [`extension.ts`](../src/extension.ts) | Construct `TicketStore`, `TicketProvider`, board panel; `ensureInitialized` in the existing try/catch block; register the view; cross-wire `setMapRevealer` (as [`extension.ts:142`](../src/extension.ts#L142) does for Plans) and a `setPlanOpener`; new commands |
| [`chat-provider.ts`](../src/chat-provider.ts) | Thread `TicketStore` into both `AgentSession` construction sites (~1029, ~1829) as `ticketProvider` |
| [`agent-session.ts`](../src/agent-session.ts) | `runtimeType.startsWith("tickets.")` branch in the dispatch chain (~3288), beside `planning.` and `graph.` |
| [`tools/definitions.ts`](../src/tools/definitions.ts) | `TICKET_TOOLS`, added to `ALL_TOOLS` |
| [`workspace-context.ts`](../src/workspace-context.ts) | `ticketSummary` beside `planningSummary` (~309); new guidelines (§7.3) |
| [`graph-provider.ts`](../src/graph-provider.ts) | Accept `TicketStore`; post `tickets_state`; re-post on change |
| [`graph/protocol.ts`](../src/webview/react/lib/graph/protocol.ts) | `MapTicket`, `tickets_state` message, `"work"` lens, `showTicketHeat` |
| [`graph/view-model.ts`](../src/webview/react/lib/graph/view-model.ts) | `deriveWorkGraph`, ticket heat stats, `"work"` in `GraphDisplayOptions["lens"]` |
| [`graph/scene/renderer.ts`](../src/webview/react/apps/graph/scene/renderer.ts) | Ticket beacon marks, ticket heat tint, blocking/overlap edge draw |
| [`graph/flow-signature.ts`](../src/webview/react/lib/graph/flow-signature.ts) | `gate` signature for blocking edges |
| [`planning-store.ts`](../src/planning-store.ts) | Optional `TaskPlan.ticketId` back-link; emit on transitions the ticket store observes |
| [`plan-doc-store.ts`](../src/plan-doc-store.ts) | Optional subdirectory constructor argument |
| [`format.ts`](../src/webview/react/lib/format.ts) | `TOOL_GROUPS` "Tickets" entry, `TOOL_LABELS` |
| [`tool-icons.ts`](../src/webview/react/lib/tool-icons.ts) | `ticket` icon case |
| [`tool-presentation.ts`](../src/webview/react/lib/tool-presentation.ts) | Result/input/intent cases for `ticket_*` |
| [`vite.webview.config.mjs`](../vite.webview.config.mjs) | `work` + `board` entries in **both** `input` and the CSS-injection filter list |
| [`package.json`](../package.json) | View registration, commands, `blacksite.tickets.*` config |
| [`theme.css`](../src/webview/react/theme.css) | Ticket/board section (§11); `.md-compact` density modifier (§9.3) |
| [`components/chat/Markdown.tsx`](../src/webview/react/components/chat/Markdown.tsx) | Extract to `components/ui/markdown.tsx`, store-agnostic, `variant` + `density` (§9.3) |
| [`lib/markdown.ts`](../src/webview/react/lib/markdown.ts) | `renderMdInline` via markdown-it `renderInline` (§9.2) |
| [`apps/planning/PlanningApp.tsx`](../src/webview/react/apps/planning/PlanningApp.tsx) | Markdown rendering across every surface in §9.7; extract `TerritoryChips` |

---

## 7. Agent tooling

### 7.1 Tools

Runtime prefix `tickets.`, dispatched exactly like `planning.` and `graph.`.

| Tool | Runtime | Purpose |
| --- | --- | --- |
| `ticket_file` | `tickets.file` | File a unit of work. Named *file*, not *create*, to signal it is cheap and correct to call mid-task. |
| `ticket_update` | `tickets.update` | Field-level edit: status, priority, labels, files, body, note, `blockedBy`, plan link. |
| `ticket_list` | `tickets.list` | Filter by status/priority/label/area/glob/file/planId; rank by priority, recency, or blast radius. |
| `ticket_promote` | `tickets.promote` | Returns a plan-shaped seed (title, summary, phase-`files` territory) and records the intended back-link, so the agent's follow-up `plan_create` is one call with no re-derivation. |
| `ticket_doc_write` / `_read` / `_list` | `tickets.doc*` | Phase 2. Mirrors `plan_doc_*`. |

`ticket_file` requires only `title`. Everything else is optional, because a
ticket filed under friction is a ticket not filed.

### 7.2 Description discipline

Tool descriptions carry the §2 contract explicitly, matching the density of the
existing `plan_*` descriptions:

- `ticket_file`: *"Use this when you notice real work that is outside the scope
  of what you were asked to do — a bug, a missing test, a fragile assumption —
  instead of widening your current task or mentioning it only in chat, where it
  is lost. Set `files` to the workspace-relative paths it concerns (Codebase Map
  ids) so it is locatable on the Map and joinable to plan territory. A ticket has
  no steps: it records the outcome, not the procedure. Do not file a ticket for
  work you are about to do in this turn."*
- `ticket_update`: *"...A ticket linked to a plan takes its status from that
  plan — do not maintain progress here and in `plan_update` both. Setting status
  by hand detaches this ticket from its plan's status until you re-link it."*
- `ticket_promote`: *"Call this when starting work on a ticket, then pass the
  returned seed to `plan_create`. The plan becomes the ticket's execution record;
  the ticket stays the durable outcome."*

Tolerant normalization throughout — `normalizeTicketStatus` accepts the same
family of synonyms `normalizePlanStatus` does, for the same logged reason.

### 7.3 Prompt guidance

Three guidelines appended to the block at
[`workspace-context.ts:380-430`](../src/workspace-context.ts#L380-L430):

- Filing over widening: notice → `ticket_file` → continue the current task.
- Ticket / plan / todo boundary, restating §2 in one sentence.
- Check `ticket_list` before starting unprompted work in an area, and before
  filing (a near-duplicate should be a `ticket_update`, exactly as
  `map_note_add` defers to `map_note_update`).

### 7.4 Permissions

Mirrors the Plans posture. `blacksite.tickets.agentMayClose` (default `false`):
the agent may file, update, and move tickets to `review`, but moving to `done`
is the user's act unless permitted. Rejection returns an explanatory error, as
the `agentCanArchive` gate does.

### 7.5 Per-turn context injection

`summarizeTicketsForPrompt(workspaceRoot, { openFiles, maxChars })` runs beside
`summarizePlanningStateForPrompt` at
[`workspace-context.ts:309`](../src/workspace-context.ts#L309). Deliberately
narrow, because it runs every turn:

```text
Open tickets touching your current files:
- BLK-12 [in_progress, high] Retry backoff drifts from gateway TTL
    src/provider-retry.ts · plan_a1b2 phase p-2
- BLK-19 [triage, normal] file-freshness cache never evicts on rename
    src/file-freshness.ts

Queue: 7 open (2 urgent/high) · 3 in triage awaiting your review
```

Budget ~800 characters: the tickets intersecting open files, then a one-line
queue posture. Everything else is one `ticket_list` away. This mirrors the
reasoning behind `localOverview` in
[`graph-annotation-store.ts`](../src/graph-annotation-store.ts) — orientation
that would otherwise cost the first tool call of every turn.

---

## 8. Plans integration

**Ticket → Plan.** `ticket_promote` returns a seed; the agent calls
`plan_create`; the store records `plan.ticketId` and `ticket.planId`. In the UI,
a ticket card shows "Start plan", which pre-fills a chat prompt rather than
silently creating a plan — plan authorship stays a conversation.

**Plan → Ticket.** A plan phase gains a "File as ticket" action for work it
discovers but should not absorb — the UI counterpart to `ticket_file`.

**Territory inheritance.** `ticket_promote` maps `ticket.files` into the seed's
first-phase `files`, so the phase begins with real territory instead of a guess.
Conversely, when a linked plan's `phaseFiles` grow beyond the ticket's `files`,
the ticket card offers to widen its own territory — one click, never automatic,
since a ticket's scope is an assertion.

**Status flow.** §5.3. `PlanningStore.onDidChange` is the trigger;
`TicketStore` recomputes derived statuses and emits its own change so both
webviews update from one plan mutation.

**Lifecycle safety.** `PlanningStore.clearCompleted` and `deletePlan` currently
salvage phase rationale into project memory
([`planning-store.ts:1162`](../src/planning-store.ts#L1162)). They must also
clear `ticket.planId` and append a note recording the plan's outcome — otherwise
a deleted plan leaves tickets pointing at nothing.

---

## 9. Shared: Markdown rendering across Plans and Tickets

An enhancement to Plans in its own right, and a prerequisite for Tickets. It ships first (Phase 0,
§13) because it delivers user-visible value before any ticket code exists.

### 9.1 The gap

`plan_doc_write` is documented as writing *"full-length markdown documentation"* up to
`MAX_DOC_BODY` = 50,000 characters, and every multi-line plan field is normalized with
`cleanParagraph` rather than `cleanText` — a distinction
[`planning-store.ts:520`](../src/planning-store.ts#L520) maintains specifically so newlines survive.
**The agent is already writing markdown into plans today.**

The Plans panel discards it. Doc bodies render as `whitespace-pre-wrap` plain text
([`PlanningApp.tsx:167`](../src/webview/react/apps/planning/PlanningApp.tsx#L167)), and so do block
bodies, notes, objectives, rationale, risks, and step details. A table renders as raw pipes, a
fenced code block as flat indented text, and a `src/foo.ts:42` reference as dead prose instead of a
link into the editor.

This is a rendering gap, not a data gap: **no schema change, no migration, no store change.**

### 9.2 Block markdown vs inline markdown

The right treatment for each field falls straight out of which cleaner already normalizes it:

| Field | Cap | Cleaner | Treatment |
| --- | --- | --- | --- |
| Plan doc body | 50,000 | (`PlanDocStore`) | **Block** — the headline change |
| `PlanBlock.body` | 1,200 | `cleanParagraph` | **Block** |
| `TaskPlan.summary` | 1,000 | `cleanParagraph` | Block, compact |
| `TaskPlanPhase.objective` / `rationale` / `risks` | 500 | `cleanParagraph` | Block, compact |
| `TaskPlanStep.detail` / `acceptanceCriteria` | 500 | `cleanParagraph` | Block, compact |
| `notes[]` entries | 400 | `cleanParagraph` | Block, compact |
| `TodoStep.result` | 500 | `cleanParagraph` | Block, compact |
| Phase `acceptanceCriteria[]` bullets | — | `cleanText` | **Inline only** |
| Titles, labels, `activePhaseId` | — | `cleanText` | **Plain text** |

`cleanText` collapses all whitespace, so those fields *cannot* contain block structure — rendering
them through a block renderer would be dishonest about what they can hold. They get an inline-only
pass (code spans, emphasis, links) or nothing at all.

### 9.3 The component

The extraction already required by the ticket work
([`ticket-entity-design.md`](./ticket-entity-design.md) §3.3) covers this too. Moving
[`Markdown.tsx`](../src/webview/react/components/chat/Markdown.tsx) to
`components/ui/markdown.tsx`, decoupled from the chat store via `onOpenFile` / `onOpenImage`
callbacks, plus two additions:

- **`variant: "block" | "inline"`** — inline uses markdown-it's `renderInline()` rather than
  post-stripping tags, so no block-level element is ever produced.
- **`density: "comfortable" | "compact"`** — a `.md-compact` modifier tightening heading margins,
  list padding, and code-block chrome. A 300px sidebar panel is not a chat bubble, and the existing
  `.md` metrics are tuned for the latter.

No CSS port is needed otherwise: `.md` is defined globally and unscoped at
[`theme.css:1366`](../src/webview/react/theme.css#L1366), and
[`apps/planning/main.tsx`](../src/webview/react/apps/planning/main.tsx) already imports
`@/theme.css`. The styles are present in the planning bundle today, unused.

### 9.4 Bundle cost — lazy, not static

[`markdown.ts`](../src/webview/react/lib/markdown.ts) pulls DOMPurify, markdown-it, seven
markdown-it plugins, and eleven highlight.js languages. Static-importing that into `planning.js`
makes the Plans panel pay for it on every mount, including for plans with no prose worth rendering.

Load it through a dynamic `import()` behind a small `useMarkdown()` hook, so the cost lands the
first time a user actually expands a doc or block. Vite already emits shared chunks
(`chunkFileNames: "chunks/[name]-[hash].js"` in
[`vite.webview.config.mjs`](../vite.webview.config.mjs)), so chat and Plans share one copy on disk.

The fallback while the chunk loads is the current `whitespace-pre-wrap` plain-text render — which is
also the parse-failure fallback, mirroring the `try`/`catch` already in `Markdown.tsx`. The panel
never shows an empty box.

### 9.5 Long documents

A 50,000-character doc body inside a 320px-tall expander needs the guards chat already has:
`useDeferredValue` + `useMemo` (present), and the existing `max-h-[320px] overflow-y-auto` cap on
`DocRow`.

Past a threshold (~8,000 characters) the inline expansion renders a **bounded preview** with an
explicit notice — *"Preview of the first 8,000 characters — open in the editor for the full
document"* — rather than silently truncating. The division of labor is deliberate and worth stating
in the UI: **inline is for reading, the editor is for writing.** The existing "Edit" button already
opens the real `.md` file in a VS Code tab, where the user gets full editing plus VS Code's own
preview, so the panel never needs an editor of its own.

### 9.6 Security and images

Plan text and doc bodies are model-authored, which is to say untrusted — exactly like chat output.
They go through the same `renderMd` → DOMPurify path with the same `SANITIZE_CONFIG`. No new
sanitizer surface, no new allowed tags.

**One real constraint, worth deciding before implementation.**
[`planning-provider.ts:45`](../src/planning-provider.ts#L45) sets
`localResourceRoots: [.../out]`. A plan doc referencing a workspace image
(`![diagram](docs/arch.png)`) therefore **will not load** under the webview CSP. Three options:

1. Render a placeholder chip linking "open in editor" — safest, zero new surface, v1 default.
2. Extend `localResourceRoots` to include the workspace root — broad, and grants the panel read
   access to every file in the project.
3. Resolve referenced images to `webview.asWebviewUri` on demand, allowlisting only paths that
   appear in the doc being rendered — correct, but real work.

I propose (1) for v1 with (3) as the follow-up, and I would not choose (2).

### 9.7 Where it renders

| Surface | Treatment |
| --- | --- |
| `DocRow` expanded body | Block, compact, bounded preview — the headline change |
| `BlockList` block bodies | Block, compact |
| `PhaseExtras` rationale | Block, compact |
| `PhaseExtras` risks | Inline (sits after a `⚠` on one row) |
| `StepRow` detail + acceptance criteria | Block, compact |
| `NoteList` entries | Block, compact |
| `TodoStep.result` | Block, compact (shares `StepRow`'s detail slot) |
| Plan summary | **Inline** — see the note below |
| Phase objective | **Plain** — see the note below |
| Phase acceptance-criteria bullets | Inline |
| `ExecutionFocus` title, all plan/phase/step titles | Plain |
| Ticket description + comments | Block (entity doc §3.3, §7.2) |

**Two deviations found during implementation**, both driven by the markup these fields already
sit in rather than by what the store can hold:

- **Plan summary** is a `line-clamp-2` teaser. Block elements cannot be measured by
  `line-clamp`, so it renders inline — emphasis and code spans survive, block structure would
  have broken the clamp.
- **Phase objective** is a `line-clamp-1` teaser *inside the `<button>` that expands the
  phase*. A `<button>`'s content model is phrasing content, so a block wrapper would be invalid
  markup, and a rendered `<a>` inside it would be nested interactive content that swallows the
  expand click. It stays plain text. Rendering the objective richly would mean moving it out of
  the button — a layout change beyond this phase's scope, and worth doing deliberately if the
  field turns out to carry structure in practice.

---

## 10. Map integration

### 10.1 Ticket heat (cheap, high value — Phase 3a)

A `showTicketHeat` display option beside `showGitHeat`, following the exact
pattern §5 of [`codebase-map.md`](./codebase-map.md) documents: per-node open
ticket weight (priority-weighted count over `files`) tints toward a distinct
signal color and scales the sprite. It composes with git heat through the
existing `baseTintById` seam rather than overwriting it — so
*recently-changed-and-ticketed* reads differently from either alone.

Requires no new node kinds, no layout change, and no renderer restructuring.

### 10.2 The Work lens (Phase 3b)

`display.lens: "files" | "services" | "work"`. `deriveWorkGraph(nodes, edges,
tickets, display)` sits beside `deriveServiceGraph` in `view-model.ts` and
synthesizes:

- **Ticket nodes** (`kind: "ticket"`) at the centroid of their `files`, sized by
  priority, tinted by status. Tickets with no `files` collect in a "no
  territory" gutter — visible, not hidden, since an unlocated ticket is a real
  signal.
- **Scope edges** (ticket → each of its files), drawn faintly.
- **Blocking edges** (ticket → ticket from `blockedBy`), carrying a new `gate`
  motion signature in [`flow-signature.ts`](../src/webview/react/lib/graph/flow-signature.ts):
  a particle that travels partway and stalls, then dissipates. Reads as
  *impeded* before any label is read, consistent with the "motion as meaning"
  vocabulary already established.
- **Overlap edges** — derived, not stored: two open tickets sharing ≥1 file get
  an `exchange`-signature edge. This surfaces collisions that are otherwise
  nearly impossible to see, and it is the single most defensible reason for the
  lens to exist.

Lens-guard parity with Services: entering Work with no tickets must offer an
explicit recovery action rather than rendering an empty canvas, and switching
lenses clears incompatible selection/isolate state.

**Live activity is free.** Traces already key off file paths, so a ticket whose
files are under active agent work gets ringed by the existing live layer with no
new renderer work — the "alive" moment costs nothing.

### 10.3 Note → ticket promotion

A map note with category `todo` or `risk` gets a "Make a ticket" action in the
node card and the Notes timeline. It creates a ticket with
`origin: "map_note"`, `originRef: <note id>`, and `files: [note.from]`. The note
is **kept**, not consumed — it remains true knowledge about the code — and gains
a back-reference chip. One direction only; tickets never become notes.

### 10.4 Agent map/ticket queries

`ticket_list` accepts `area` and `glob` filters resolved through the same
machinery `map_find` uses, and a `nearFile` filter that runs `map_impact` to
return tickets within N hops of a file. That is the query that makes "what else
should I know before touching this" answerable in one call.

---

## 11. Surfaces and visual design

### 11.1 Placement

The activity bar already holds five webviews; a sixth narrow view is a poor home
for a board. Instead:

- **Rename the Plans view to "Work"**, holding two tabs — **Queue** and
  **Plans** — using the `.tab-strip-item` language the Data app already
  establishes ([`theme.css:2283`](../src/webview/react/theme.css#L2283)). Sidebar
  count stays constant, and tickets sit physically adjacent to plans, which is
  exactly the relationship the design wants users to feel.
- **A full board in an editor tab**, opened by `blacksite.openBoard`, following
  `graphProvider.openFullPage()` / `NotesTimelineProvider`. Columns by status,
  drag to move, keyboard navigation, filter rail.

Sidebar = the focused queue (what is next, what is blocked, what is in triage).
Editor tab = the board.

### 11.2 The alive language

Reusing what exists rather than inventing:

- `.living-panel-header` + `.panel-presence` for the header and its live dot.
- `.plan-focus` has a direct analogue: a **"Next up"** rail showing the
  highest-priority unblocked ticket, with the same inset brand edge.
- `turn-in` card entrance keyed by ticket id, so moving between tickets replays
  the entrance — the pattern node cards use.
- `StatusBadge` gains ticket statuses in `STATUS_TONE`
  ([`status-badge.tsx:3`](../src/webview/react/components/ui/status-badge.tsx#L3)):
  `triage` → muted, `backlog` → muted, `review` → `--s-info`, reusing existing
  tones for the rest.
- **Priority as weight, not color alone.** `urgent` gets a left inset edge like
  `.plan-card.is-awaiting-approval`; priority never relies on hue alone.
- **Column transitions on the board** ease rather than snap, and a ticket landing
  in `done` gets one settle-in pulse — a single moment, not a celebration.
- Everything gated behind `prefers-reduced-motion`, matching the rest of the
  codebase.

### 11.3 Board specifics

Columns `triage | backlog | in_progress | blocked | review | done`, with `done`
collapsed by default and windowed. Each card: id, title, priority mark, territory
count, linked-plan chip, blocked-by chips. Territory chips reuse
`PhaseTerritory`'s two-part interaction from
[`PlanningApp.tsx:243`](../src/webview/react/apps/planning/PlanningApp.tsx#L243)
— name opens the file, `◎` flies the Map camera — extracted into a shared
component rather than copied.

---

## 12. Optional export (deferred)

Not in v1, but the schema anticipates it: `ticket.externalRef?: { provider:
"github" | "gitlab" | "jira"; id: string; url: string }`, populated by a one-way
"Push to GitHub" action over the existing `github_create_issue` tool. One-way
only — bidirectional sync is a different product with a different failure mode,
and pretending otherwise is how local trackers rot.

---

## 13. Phasing

### Phase 0 — Shared UI groundwork (ships value on its own)

Independently useful, independently reviewable, and a hard prerequisite for everything after it.

- Extract `Markdown` to `components/ui/markdown.tsx` with `onOpenFile` / `onOpenImage` callbacks,
  `variant`, and `density`; repoint chat at it (§9.3)
- `useMarkdown()` lazy-loading hook + plain-text fallback (§9.4)
- `.md-compact` density modifier in `theme.css`
- **Plans render markdown** across every surface in §9.7, with the bounded-preview notice (§9.5) and
  the image placeholder (§9.6 option 1)
- Extract `TerritoryChips` from `PhaseTerritory`; repoint the Plans panel at it

**Done when:** a plan doc containing a table, a fenced code block, and a `src/foo.ts:42` reference
renders as formatted markdown with a working file link — and the Plans panel's mount cost is
unchanged for plans nobody expands.

### Phase 1 — Foundation and the agent unlock

The cheapest phase and the one carrying most of the value.

- `src/ticket-store.ts`: document, normalizers, `dispatch`, `reconcileTicket`,
  `summarizeTicketsForPrompt`
- `TICKET_TOOLS` + `tickets.` dispatch branch + prompt guidance
- Per-turn context injection
- Minimal Queue tab in the renamed Work view (list, status/priority controls,
  territory chips, file-a-ticket)
- `tests/unit/ticket-store.spec.ts`

**Done when:** an agent files a ticket mid-task without disturbing its plan, and
the next turn's context names tickets touching the open files.

### Phase 2 — The surface

- Editor-tab board with columns, drag, keyboard navigation, filter rail
- `ticket_promote` + plan back-links + territory inheritance
- Note → ticket promotion (§10.3)
- Plan phase → "File as ticket"
- `ticket_doc_*` over the generalized `PlanDocStore`
- Lifecycle safety in `clearCompleted` / `deletePlan`

**Done when:** a ticket can be filed from a map note, promoted to a plan, worked,
and closed — without the user ever hand-syncing status.

### Phase 3 — Map

- **3a:** ticket heat layer (§10.1)
- **3b:** Work lens — ticket beacons, scope/blocking/overlap edges, `gate`
  signature, lens guards, legend, `TicketCard` inspector

**Done when:** the Map answers "where is open work" and "which tickets collide",
and the Work lens degrades honestly when there is nothing to draw.

### Phase 4 — Intelligence

- Triage sweeps: diagnostics, `TODO`/`FIXME` scans, and failing tests proposed as
  `triage` tickets for user acceptance — never auto-accepted
- "What next" ranking: priority × blocked-state × map centrality × git churn
- Overlap warnings surfaced to the agent when its current files intersect another
  open ticket's territory

**Done when:** the agent can propose a next ticket with a defensible reason, and
warn before working inside another ticket's territory.

---

## 14. Test plan

Mirroring [`planning-store.spec.ts`](../tests/unit/planning-store.spec.ts)
(tmpdir per test, real filesystem, `dispatch` through the public surface):

- **Normalizers** — status/priority synonym coercion; `files` dialect folding
  (backslashes, `./`, dedupe) shared with `normalizePlanFiles`; caps enforced
- **Derivation** — every row of the §5.3 table; `done` is never derived; a manual
  set detaches and stays detached; a deleted plan clears the link and notes it
- **The contract** — asserts no step-like field is accepted by `ticket_update`,
  so §2 cannot erode by accident
- **Prompt summary** — respects the character budget; prefers tickets
  intersecting open files; empty string when the queue is empty
- **Permission gate** — `agentMayClose: false` rejects a `done` transition with an
  explanatory error
- **Provider** — path containment for territory chips (the `_resolvePhaseFile`
  traversal guard at
  [`planning-provider.ts:175`](../src/planning-provider.ts#L175) applies verbatim;
  ticket `files` are model-authored too)
- **View model** — `deriveWorkGraph` centroids, overlap-edge derivation,
  no-territory gutter, lens-switch state clearing
- **Integration** — `agent-session` dispatch reaches the store and reports
  unavailability cleanly when no workspace is writable

Markdown rendering (§9), in `tests/unit/markdown-render.spec.ts`:

- **Inline variant** emits no block-level element for input containing headings,
  lists, and fenced blocks — the guarantee that makes `cleanText` fields safe to render
- **Sanitization** — script tags, event-handler attributes, and `javascript:` hrefs do
  not survive `renderMd`, asserted against doc-body input rather than assumed from chat
- **File links** — `src/foo.ts:42` produces a `.file-link` carrying the path and line, and
  the extracted component invokes `onOpenFile` rather than reaching for a store
- **Lazy fallback** — the plain-text render appears before the chunk resolves, and a parse
  failure falls back to plain text rather than an empty box
- **Bounded preview** — a body over the threshold renders the notice and does not render
  the full document inline

---

## 15. Open decisions

1. **Shared or personal?** `.blacksite/` is gitignored, so v1 is single-player.
   Committing `tickets.json` makes it team-visible at the cost of merge conflicts
   on a hot file. A third option — local by default, one-way export (§12) — is
   probably right, but it changes whether `assignee` and `rank` matter.
2. **Who closes?** §7.4 proposes user-only by default, matching `agentCanArchive`.
   The looser alternative: the agent may close what it demonstrably finished, and
   `review` becomes the exception rather than the rule.
3. **Sidebar shape.** Renaming Plans → Work with tabs (§11.1) keeps the activity
   bar at five, at the cost of one more click to reach Plans. The alternative is a
   sixth view.
4. **Id scheme.** `BLK-12` is readable and greppable but bakes in a prefix; a
   per-workspace configurable prefix is a small addition if tickets are ever
   quoted in commit messages.
5. **Phase 3b scope.** The Work lens is the most speculative piece here. Ticket
   heat (3a) may deliver most of the value at a fraction of the cost — worth
   re-evaluating after 3a ships rather than committing now.
6. **Images in plan docs.** §9.6 proposes a placeholder chip for v1 rather than
   widening the Plans panel's `localResourceRoots` to the whole workspace. If plan
   docs are expected to carry diagrams routinely, the on-demand `asWebviewUri`
   resolution (option 3) should move into Phase 0 instead of being a follow-up.
