# The Ticket Entity — Design & Implementation Plan

Status: proposed, for review · Owner: Blacksite VS Code extension

Companion: [`tickets-implementation-plan.md`](./tickets-implementation-plan.md) (the system: stores,
providers, phasing, Map/Plans wiring). **This document is only about the ticket itself** — every
field it carries, why that field exists, what writes it, how it is normalized, how it renders at
three densities, and how a person and an agent each interact with it.

---

## 1. Design principles

Five rules that decide every field question below.

1. **Every field must change a decision.** A field nobody filters, sorts, groups, or acts on is
   ceremony. `estimate` and `assignee` fail this test in a single-player local tracker; `priority`
   and `territory` pass.
2. **Intent is stored; membership is derived.** A ticket stores *"this is about `src/graph/`"*, not
   the 41 files that currently satisfies. Derived-at-read means the answer stays true as the
   codebase moves — the same discipline `deriveDisplayGraph` uses on the Map.
3. **Current state and history are different shapes.** The description is *replaced* (it states what
   should be true now). The activity timeline is *appended* (it states what happened). Conflating
   them is what turns a tracker into a scroll of stale prose.
4. **A ticket has no steps.** Restated from the companion doc because it is the constraint most
   likely to erode under pressure: procedure lives in a Plan. This document adds no field that could
   be used to track incremental progress.
5. **Degrade honestly.** A stale file reference, an unindexed workspace, a deleted plan — each is
   shown as what it is, never silently dropped or quietly repaired.

---

## 2. Anatomy at a glance

| Group | Fields | Written by |
| --- | --- | --- |
| Identity | `id`, `title`, `description` | User + agent |
| Classification | `status`, `statusSource`, `priority`, `complexity`, `labels` | User + agent (gated) |
| Territory | `territory.files`, `territory.areas` | User + agent |
| Links | `planId`, `phaseId`, `blockedBy`, `relatedTo`, `origin`, `originRef` | User + agent |
| Activity | `events[]` (comments + system entries) | Append-only |
| Attachments | `docs[]` | User + agent |
| Lifecycle | `createdAt`, `updatedAt`, `closedAt`, `sessionId` | Store only |

---

## 3. Identity

### 3.1 `id`

`BLK-12` — sequential, human-readable, greppable, mintable offline. Produced by the existing
`nextSeq(ids, prefix)` helper in [`planning-store.ts:298`](../src/planning-store.ts#L298).

The prefix is configurable per workspace (`blacksite.tickets.idPrefix`, default `BLK`) because ids
leak into commit messages and branch names, where a project-specific prefix earns its keep. Ids are
**never reused** — `nextSeq` reads the max over all tickets including closed ones.

### 3.2 `title`

Single line, ≤ 160 chars, normalized with `cleanText` (collapses whitespace). Required — it is the
only required field on `ticket_file`, because a ticket filed under friction is a ticket not filed.

Guidance carried in the tool description: *state the outcome, not the activity.* "Retry backoff
drifts from gateway TTL" over "look into retry stuff".

**Presentation:** the title is the click target everywhere. In the detail view it is inline-editable
— click to edit, `Enter` commits, `Escape` reverts. No modal, no save button.

### 3.3 `description`

Markdown, ≤ 8,000 chars, normalized with `cleanParagraph` (preserves newlines — this is the reason
[`planning-store.ts:520`](../src/planning-store.ts#L520) keeps two distinct cleaners).

It states the outcome and its context: what is wrong or missing, why it matters, what "done" looks
like. It is **replaced** on edit, not appended — history lives in §7.

Beyond 8,000 chars the content is a document, and belongs in `docs[]` (§9). The editor says so at
the cap rather than truncating silently.

**Rendering — and a prerequisite.** Descriptions render through `renderMd`
([`markdown.ts:204`](../src/webview/react/lib/markdown.ts#L204)), which gives fenced code, tables,
and — the reason this matters — **live file links**: `[provider-retry.ts:42](src/provider-retry.ts#L42)`
becomes a clickable jump into the editor. A ticket that can point directly at code is the whole
premise of tying this to the Map.

> **Blocking prerequisite.** [`Markdown.tsx`](../src/webview/react/components/chat/Markdown.tsx)
> imports `actions` from `@/lib/store` — the *chat* store — for its `openFile` and `openLightbox`
> delegation. It cannot be used from another webview app as written. **Extract it to
> `components/ui/markdown.tsx` taking `onOpenFile` / `onOpenImage` callbacks**, with the chat
> passing its existing actions. Small, mechanical, and it must land before any ticket UI work.
>
> This extraction is shared with the Plans markdown enhancement and is specified in full at
> [`tickets-implementation-plan.md`](./tickets-implementation-plan.md) §9, where it ships as
> Phase 0 — including the `variant` / `density` additions, lazy loading, and the sanitization and
> image constraints that apply equally to ticket descriptions and comments.

An editing affordance worth the small cost: a **Write / Preview** toggle on the description editor,
since agents write markdown and users should see what they are editing.

---

## 4. Classification

### 4.1 `status`

```ts
type TicketStatus =
  | "triage"       // filed, not yet accepted — the agent's landing zone
  | "backlog"      // accepted, not started
  | "in_progress"  // a plan is executing it, or manually started
  | "blocked"
  | "review"       // work done, awaiting verification
  | "done"
  | "cancelled";
```

Seven states, each earning its place: `triage` separates *filed* from *accepted* (essential once an
agent can file freely); `review` separates *finished* from *verified*, which is where the derivation
rule stops (§4.2). `cancelled` is distinct from `done` because "we decided not to" is a different
historical fact from "we did it".

Normalization is tolerant — `normalizeTicketStatus` accepts the synonym families
`normalizePlanStatus` already handles ("wip", "doing", "paused", "closed"), for the same reason
recorded at [`planning-store.ts:528`](../src/planning-store.ts#L528): rejecting a near-miss burns a
whole agent turn.

### 4.2 `statusSource`

`"manual" | "derived"`. While `derived` and a plan is linked, `reconcileTicket` drives status from
plan state. The first manual change flips it to `manual` and derivation stops overriding — but the
UI keeps showing what the plan says as a dimmed hint, so the divergence is visible rather than
silent. A "Follow plan again" action flips it back.

`done` is never derived. Full derivation table in the companion doc, §5.3.

### 4.3 `priority`

`"urgent" | "high" | "normal" | "low"`, default `normal`.

Four levels, not five: a middle-plus-two-on-each-side scale is where people stop being able to
distinguish neighbors. Ordering the queue is priority's only job.

**Presentation — weight, not hue alone.** `urgent` gets a left inset edge (the treatment
`.plan-card.is-awaiting-approval` already uses at [`theme.css:2355`](../src/webview/react/theme.css#L2355))
plus a filled mark; `high` gets the mark only; `normal` renders nothing at all — the default should
be silent — and `low` renders a hollow, dimmed mark. Color reinforces but never carries it alone.

### 4.4 `complexity`

Reuses `PlanComplexity` verbatim: `"small" | "medium" | "large"`, optional.

Deliberately not story points, t-shirt-plus-numbers, or hours. The reasoning is already recorded in
this codebase at [`planning-store.ts:117`](../src/planning-store.ts#L117) — *"deliberately not a
numeric estimate the model can't calibrate honestly."* A ticket surface does not get to relitigate
that; a coarse qualitative hint is what an agent can supply without fabricating precision.

Optional `complexityBasis?: string` (≤ 200 chars, `cleanText`): one clause on *why*. "Touches the
serialized cache format" is worth carrying in a tooltip and costs nothing.

> **Judgment call for review.** `complexityBasis` could equally be a comment. I favor the field
> because it belongs in the queue tooltip where a comment would not surface — but it is the field in
> this document I hold least firmly.

### 4.5 `labels`

Free-form strings, normalized to kebab-case lowercase, ≤ 24 chars each, ≤ 8 per ticket.

No fixed taxonomy and no reserved labels. Anything that deserves consistent behavior gets a real
field — that is exactly why status, priority and complexity are not labels.

**Drift control without a config file.** The workspace label set is *derived* from usage across all
tickets, ranked by frequency. The picker offers existing labels before allowing a new one, which is
what stops `auth` / `authentication` / `Auth` from coexisting. No registry to maintain, no schema to
migrate — the same "derive, don't store" instinct as §1.2.

**Color** comes from a deterministic hash of the label text, reusing the approach
`agentLaneColor(laneId)` already takes for subagent lanes. Same label, same color, every surface,
no assignment step.

---

## 5. Territory — files *and* directories

The join key to the Map and to Plans, and the most consequential design in this document.

```ts
interface TicketTerritory {
  /** Exact Codebase Map node ids. */
  files: string[];
  /** Directory prefixes — matched exactly as map-queries' `area` filter does. */
  areas: string[];
}
```

### 5.1 Why both

A ticket like "the graph indexer is too slow" is about `src/graph/`, not about fourteen enumerated
files that will be sixteen next month. Enumerating them is wrong twice: it goes stale, and it
misrepresents a directory-scoped concern as a file-scoped one.

`areas` uses the exact convention already implemented in
[`map-queries.ts:446`](../src/graph/map-queries.ts#L446):

```ts
node.id === area || node.id.startsWith(`${area}/`)
```

normalized by the same `normalizeArea` (fold backslashes, strip `./` and trailing `/`). `files` uses
the same dialect `normalizePlanFiles` applies to phase territory, so a ticket, a plan phase, a map
note, and git all speak one path language with no translation layer.

### 5.2 Derived membership

```ts
resolvedFiles(ticket, indexedNodes): string[]   // files ∪ every node under any area
```

Computed at read time against the live index. **Never stored.** This is what keeps a ticket honest
as the codebase moves, and it is what the Map lens, the blast-radius query, and the overlap
detection all consume.

Bounded: an area resolving to more than 200 files reports a count rather than a list. A ticket
scoped to the whole repo is a scoping error, and the UI should make that feel like one.

### 5.3 Staleness — flag, never delete

A stored file id absent from the current index is **kept and marked**, not removed. Rendered
struck-through with a "not in the current index" tooltip and a one-click *Remove* / *Update path*.

Silent deletion is wrong because the file may be renamed, gitignored, beyond the render cap, or in a
folder not currently open — all recoverable situations that a silent drop turns into lost intent.
This mirrors how `GraphAnnotationStore` validates note endpoints against the *indexed* set rather
than the *rendered* one ([`extension.ts:99-105`](../src/extension.ts#L99-L105)).

### 5.4 Suggested territory

A ticket filed mid-task usually should not need territory typed by hand. Candidates are **proposed**
as dismissible chips, never auto-applied:

- files the agent touched in the turn that filed the ticket (its trace already exists);
- the source file of the map note it was promoted from (`originRef`);
- `map_find` hits on distinctive terms in the title.

Accepting a suggestion is one click. Nothing enters `territory` without an explicit act, because
territory is an assertion about scope.

### 5.5 Presentation

Each entry is the two-part chip already established by `PhaseTerritory`
([`PlanningApp.tsx:243`](../src/webview/react/apps/planning/PlanningApp.tsx#L243)) — the name opens
the file, `◎` flies the Map camera to its star. **Extract that component and share it** rather than
copying it; Plans and Tickets diverging on this interaction would be a visible seam.

Areas render with a `▤` prefix (the same glyph the Map uses for cluster super-nodes) and carry a
live resolved count: `▤ src/graph/ · 41 files`. Clicking an area chip focuses that cluster on the
Map.

---

## 6. Links

```ts
planId?: string;        // the plan executing this ticket
phaseId?: string;       // when one phase, not the whole plan, satisfies it
blockedBy: string[];    // ticket ids that must close first
relatedTo: string[];    // symmetric, non-blocking association
origin: TicketOrigin;   // "user" | "agent" | "map_note" | "diagnostic" | "review"
originRef?: string;     // note id, diagnostic key, review reference
```

**`blockedBy` is informational, never enforced** — the same posture `TaskPlanPhase.dependsOn` takes.
The store rejects only self-reference and direct two-cycles; longer cycles are detected at read and
surfaced as a warning banner rather than being prevented. Enforcement in a single-player tracker
generates more friction than it prevents.

**`relatedTo` is symmetric.** Adding it on one ticket adds the reverse on the other; removing
removes both. Asymmetric "related" links are a classic source of confusing trackers.

**`origin` is provenance, and it is load-bearing for trust.** "Where did this come from" is the first
question about any agent-filed ticket. It drives the queue's *Filed by agent* filter, the triage
review flow, and a small attribution mark on every card.

**Presentation.** A Links panel in the detail view: the plan as a chip that opens the Plans tab
scrolled to that phase; blocking tickets as chips carrying their own status color, so a blocker that
has since closed is obvious at a glance; the origin as a sentence with a link — *"Promoted from map
note: 'Retry TTL drift'"*.

---

## 7. Activity — one timeline, two kinds of entry

The largest addition beyond the companion doc, and where a ticket earns the "alive" feel.

### 7.1 Model

```ts
type TicketEventKind =
  | "created" | "comment"
  | "status" | "priority" | "complexity" | "label"
  | "territory" | "link" | "doc" | "reopened";

interface TicketEvent {
  id: string;
  at: string;                              // ISO
  actor: "user" | "agent" | "system";
  sessionId?: string;                      // correlates to a chat session
  kind: TicketEventKind;
  /** Markdown, for kind "comment". */
  body?: string;
  /** Transition detail for non-comment kinds. */
  from?: string;
  to?: string;
}
```

**One array, not two.** Comments and system events interleave chronologically because that is how
the story actually reads: *filed → commented → status changed because a plan started → commented
with the root cause → closed*. Splitting them into a "comments" tab and a "history" tab forces the
reader to reconstruct that sequence by timestamp.

### 7.2 Rendering

- **Comments** get full markdown treatment — code blocks, live file links, the lot — with an actor
  chip. Agent comments carry the bot-avatar badge already defined at
  [`theme.css:2021`](../src/webview/react/theme.css#L2021), so an agent's note reads as an agent's
  note without a color-only cue.
- **System events** collapse to one dim line each on a shared left rail — the exact treatment the
  agent narration log already uses ([`theme.css:1903`](../src/webview/react/theme.css#L1903)) — so a
  ticket with 30 status changes and 3 comments still reads as three comments.

```
● filed by agent · 2d ago · from map note "Retry TTL drift"
● status → in_progress · plan "Retry hardening" started · 1d ago
💬 agent · 4h ago
   Root cause is the gateway TTL being read once at construction —
   see provider-retry.ts:118. Backoff ceiling has to derive from it,
   not from the static default.
● priority normal → high · by you · 3h ago
```

### 7.3 Coalescing and caps

Without pruning, system events drown comments. Two rules:

1. **Coalesce**: consecutive same-kind system events by the same actor within 5 minutes collapse to
   one entry carrying the first `from` and last `to`. Ten priority flips while triaging read as one
   line.
2. **Prune asymmetrically** at 200 events: system events are dropped oldest-first; **comments are
   never auto-pruned**. Comments are authored content; transitions are reconstructible from state.

`created` is pinned and never pruned.

### 7.4 Agent comments

`ticket_comment` is a distinct tool rather than a flag on `ticket_update`, because the two have
different failure modes and different descriptions. Its guidance: *record findings, root causes, and
dead ends on the ticket where the next session will look for them — not only in chat, where they are
lost to compaction.*

This is the mechanism that lets an agent investigate a ticket across sessions without a plan
existing yet, which is precisely the gap between "filed" and "started" that Plans cannot cover.

### 7.5 Composer

Textarea with `Cmd/Ctrl+Enter` to submit, a Write/Preview toggle, and no draft persistence in v1
(the webview keeps context when hidden via `retainContextWhenHidden`, which covers the realistic
loss case). Comments are **not editable** after posting — they are a log — but they are deletable by
their author, which is the honest combination.

---

## 8. Lifecycle fields

| Field | Written by | Notes |
| --- | --- | --- |
| `createdAt` | Store | Never mutated |
| `updatedAt` | Store | Any mutation, including comments |
| `closedAt` | Store | Set on `done`/`cancelled`, **cleared on reopen** |
| `sessionId` | Store | The chat session that filed it; correlates to transcripts |

Reopening a closed ticket clears `closedAt` and appends a `reopened` event. A ticket that has been
closed and reopened is a meaningful signal — the timeline preserves it.

---

## 9. Attachments (`docs[]`)

Reuses `PlanDocMeta` and `PlanDocStore` unchanged, with the store rooted at `.blacksite/tickets/`
via the optional subdirectory argument proposed in the companion doc. Metadata inline, bodies on
disk — `tickets.json` is rewritten in full on every status change, so inlining bodies would rewrite
every attachment on every unrelated edit.

Same two affordances the Plans panel already offers: **＋ New note** (creates and opens a markdown
file in a real editor tab) and **＋ Add reference** (native file picker, copies the file in). Both
paths are already built at [`PlanningApp.tsx:192`](../src/webview/react/apps/planning/PlanningApp.tsx#L192).

Screenshots deserve a mention: a copied image lands as a `reference` doc and renders inline in the
detail view through the existing lightbox path. Worth doing, not worth blocking on.

---

## 10. Full schema

```ts
export interface Ticket {
  id: string;
  title: string;
  description?: string;

  status: TicketStatus;
  statusSource: "manual" | "derived";
  priority: TicketPriority;
  complexity?: PlanComplexity;
  complexityBasis?: string;
  labels: string[];

  territory: TicketTerritory;

  planId?: string;
  phaseId?: string;
  blockedBy: string[];
  relatedTo: string[];
  origin: TicketOrigin;
  originRef?: string;

  events: TicketEvent[];
  docs: PlanDocMeta[];

  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  sessionId?: string;
}

export interface TicketDocument {
  schemaVersion: number;
  updatedAt: string | null;
  /** Array order is backlog rank; the board reorders in place. */
  tickets: Ticket[];
}
```

### 10.1 Caps and normalization

| Field | Cap | Cleaner | On violation |
| --- | --- | --- | --- |
| `title` | 160 | `cleanText` | Truncate |
| `description` | 8,000 | `cleanParagraph` | Truncate; editor warns at cap |
| `complexityBasis` | 200 | `cleanText` | Truncate |
| `labels` | 8 × 24 | kebab-normalize | Drop overflow |
| `territory.files` | 60 | `normalizePlanFiles` | Drop overflow, dedupe |
| `territory.areas` | 12 | `normalizeArea` | Drop overflow, dedupe |
| `blockedBy` / `relatedTo` | 20 each | id validation | Drop unknown ids |
| `events` | 200 | §7.3 | Prune system events first |
| `docs` | 20 | `MAX_DOCS` | Reject with error |
| Comment body | 4,000 | `cleanParagraph` | Truncate |

Caps are generous rather than tight, and every one truncates or drops rather than rejecting the
call — except `docs`, which returns an explicit error because a dropped attachment is invisible.

### 10.2 Versioning

`schemaVersion: 1`. Every field above except `title`/`status`/`priority` is optional or
array-defaulted, so `normalizeTicket` tolerates any subset — the additive-evolution posture recorded
at [`planning-store.ts:8-13`](../src/planning-store.ts#L8-L13). A version bump is needed only for a
semantic change to an existing field, not for new ones.

---

## 11. Presentation at three densities

### 11.1 Row — sidebar queue

One line, scannable, ~34px.

```
┃ BLK-12  Retry backoff drifts from gateway TTL      IN PROGRESS  ◎3  ⧉p-2
┃ BLK-19  file-freshness cache never evicts on rename    TRIAGE   ◎1  🤖
  BLK-07  Document the graph cache schema bump             BACKLOG  ▤1
```

`┃` = priority inset (urgent/high only) · `◎n` = territory count · `⧉` = linked plan · `🤖` = agent-filed
and not yet triaged.

### 11.2 Card — board column

```
┌──────────────────────────────────┐
│ ┃ BLK-12              ⧉ p-2  💬3 │
│ Retry backoff drifts from        │
│ gateway TTL                      │
│ ◎ provider-retry.ts +2           │
│ [auth] [retry]        medium · 4h│
└──────────────────────────────────┘
```

Title clamped to two lines. Territory shows the first file plus a count. Trailing row: labels,
complexity, last-activity relative time via the existing `formatRelativeTime`
([`format.ts:119`](../src/webview/react/lib/format.ts#L119)).

### 11.3 Detail — the full view

Opens in the sidebar as a push-over panel, or in the editor tab from the board. Same component, same
layout, container-query responsive — `.planning-root` already establishes the
`container-type: inline-size` pattern this needs.

```
┌─ BLK-12 ────────────────────── [ IN PROGRESS ▾ ]  [⋯] ─┐
│ Retry backoff drifts from gateway TTL                   │  ← inline editable
│ ┃ urgent   medium · touches serialized cache   [auth]   │
├─────────────────────────────────────────────────────────┤
│ The backoff ceiling is read once at construction from   │
│ the static default, so a gateway with a shorter TTL      │
│ silently retries past expiry. See provider-retry.ts:118 │  ← live file link
│                                          [Write|Preview]│
├──────────────────────────┬──────────────────────────────┤
│ TERRITORY            [+] │ LINKS                    [+] │
│ ◎ provider-retry.ts      │ ⧉ Retry hardening · phase 2  │
│ ◎ bedrock-client.ts      │ ⛔ Blocked by BLK-9 (backlog)│
│ ▤ src/graph/ · 41 files  │ ↔ Related: BLK-22            │
│ ◎ old-retry.ts  (stale)  │ ⌁ From note "Retry TTL drift"│
├──────────────────────────┴──────────────────────────────┤
│ ACTIVITY                                                │
│ ● filed by agent · 2d ago · from map note               │
│ ● status → in_progress · plan started · 1d ago          │
│ 💬 agent · 4h ago                                        │
│    Root cause is the gateway TTL read once at            │
│    construction — see provider-retry.ts:118.             │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Add a comment…                        ⌘↵ to post    │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

Under ~380px the two middle columns stack, matching the `@container relay-planning (max-width: 350px)`
treatment already in [`theme.css`](../src/webview/react/theme.css).

### 11.4 Motion

Reusing the established vocabulary rather than inventing:

- `turn-in` entrance keyed by ticket id, so switching tickets replays the entrance (the Map's node-card pattern).
- Status change: the badge cross-fades and the card settles ~2px — one moment, not a celebration.
- A ticket moving columns on the board eases along its path rather than teleporting, consistent with the Map's *"stars fly, never teleport"* rule.
- A ticket whose territory is under live agent work gets a slow breathing edge, driven by the same activity feed the Map's live layer consumes. **This is the single best "alive" moment available** — the queue visibly reacts to the agent working, for almost no cost.
- All of it behind `prefers-reduced-motion`, matching every other surface.

---

## 12. Who writes what

| Field | User | Agent | Derived |
| --- | --- | --- | --- |
| `id`, `createdAt`, `updatedAt`, `closedAt` | — | — | Store |
| `title`, `description` | ✓ | ✓ | — |
| `status` | ✓ | ✓ *(`done` gated, §12.1)* | ✓ when `statusSource: "derived"` |
| `statusSource` | ✓ implicitly | — | Store |
| `priority` | ✓ | ✓ | — |
| `complexity`, `complexityBasis` | ✓ | ✓ | — |
| `labels` | ✓ | ✓ | — |
| `territory.*` | ✓ | ✓ | `resolvedFiles` derived |
| `planId` / `phaseId` | ✓ | ✓ | Cleared when the plan is deleted |
| `blockedBy` | ✓ | ✓ | — |
| `relatedTo` | ✓ | ✓ | Reverse side written by store |
| `origin`, `originRef` | — | Set at creation | Immutable after |
| `events[]` | ✓ comments | ✓ comments | System entries by store |
| `docs[]` | ✓ | ✓ | — |

### 12.1 The close gate

`blacksite.tickets.agentMayClose`, default `false`. The agent may file, update, comment, and move to
`review`; moving to `done` returns an explanatory error unless permitted — the same posture and the
same error shape as the `agentCanArchive` gate on Plans.

### 12.2 Tool → field mapping

| Tool | Writes |
| --- | --- |
| `ticket_file` | `title` (req), `description`, `priority`, `complexity`, `labels`, `territory`, `origin`, `originRef`, `blockedBy` |
| `ticket_update` | Any classification/territory/link field; `note` appends a system event |
| `ticket_comment` | One `comment` event |
| `ticket_list` | — (reads; filters by status/priority/label/area/glob/file/plan/origin) |
| `ticket_promote` | Reads the ticket, returns a plan seed, records the intended back-link |
| `ticket_doc_write` / `_read` / `_list` | `docs[]` |

Every write tool is field-level, never a full-document replace — the discipline
`plan_update`'s description spends a paragraph establishing, for the same reason.

---

## 13. Interaction details

- **Themed `Select` everywhere**, never a native `<select>`. The reasoning is documented in
  [`select.tsx`](../src/webview/react/components/ui/select.tsx): the OS draws a native popup and
  ignores every token in the stylesheet.
- **Optimistic UI with host reconciliation.** The webview applies the change immediately and posts;
  the store is the source of truth and its `tickets_state` push reconciles. A rejected write (close
  gate, unknown id) reverts with an inline message.
- **Concurrency is last-write-wins per field**, stated explicitly because it is a real choice: the
  store is single-writer and single-player. Field-level rather than document-level, so a status
  change from the board and a comment from the sidebar cannot clobber each other.
- **Keyboard on the board:** `↑↓←→` to move focus, `Enter` to open, `1-4` priority, `c` to comment,
  `[` `]` to move column. Board-scoped only — no global keybindings in v1.
- **Adding territory** offers a quick-pick over indexed Map node ids (not a raw file dialog), so a
  typed path cannot become a broken reference. A native picker remains available for files outside
  the index.
- **Destructive actions arm before firing**, reusing the `ConfirmButton` pattern at
  [`PlanningApp.tsx:106`](../src/webview/react/apps/planning/PlanningApp.tsx#L106) — deletion, and
  clearing a plan link that has history behind it.

---

## 14. Validation and failure modes

| Condition | Behavior |
| --- | --- |
| Territory file absent from index | Kept, flagged stale, remove/update offered (§5.3) |
| Area resolves to > 200 files | Count shown instead of a list; scoping hint |
| `blockedBy` names an unknown ticket | Dropped on write, note appended |
| `blockedBy` cycle (length > 2) | Allowed; warning banner at read |
| Linked plan deleted | `planId` cleared, system event appended, status frozen at last derived value |
| Workspace unwritable | Store runs read-only; UI shows it; agent tools return a clean unavailability error |
| `tickets.json` corrupt | `normalizeTicket` salvages every parseable ticket; unparseable entries dropped with a count reported |
| Agent attempts `done` while gated | Explanatory error naming the setting |

---

## 15. Test plan

Extending `tests/unit/ticket-store.spec.ts` (tmpdir per test, real filesystem, everything through
`dispatch`), matching [`planning-store.spec.ts`](../tests/unit/planning-store.spec.ts):

- **Normalizers** — status/priority synonyms; label kebab-normalization and dedupe; area folding
  (backslashes, `./`, trailing `/`); every cap in §10.1 truncating rather than rejecting.
- **Territory** — `resolvedFiles` unions files and area membership; area prefix matching does not
  match `src/graphics/` for area `src/graph`; stale entries are retained and flagged; the 200-file
  bound reports a count.
- **Events** — coalescing window; asymmetric pruning keeps comments and drops system entries;
  `created` survives pruning; comment authorship and deletion rules.
- **Links** — `relatedTo` symmetry on add *and* remove; self-reference rejected; two-cycle rejected;
  longer cycle allowed and reported; plan deletion clears the link and appends an event.
- **The contract** — `ticket_update` rejects any step-like field, so §1.4 cannot erode silently.
- **Close gate** — `agentMayClose: false` rejects `done` with an explanatory error; `review` succeeds.
- **Reopen** — clears `closedAt`, appends `reopened`.
- **Corruption** — a document with two valid and one malformed ticket loads two and reports one dropped.

---

## 16. Build order for the entity

Sequenced so each step is independently reviewable.

1. **Phase 0 of the companion plan** — the `Markdown` extraction, `variant`/`density`, lazy loading,
   and `TerritoryChips` extraction ([`tickets-implementation-plan.md`](./tickets-implementation-plan.md)
   §9, §13). *Prerequisite for everything below, and it ships Plans markdown on its own.*
2. **Schema + normalizers + caps** (§10) with unit coverage — no UI.
3. **Events model** (§7) including coalescing and pruning, with unit coverage.
4. **Territory resolution** (§5.2, §5.3) against the live index.
5. **Row + card renderers** (§11.1, §11.2) — read-only.
6. **Detail view** (§11.3) — read-only, then editable field by field.
7. **Comment composer** (§7.5).
8. **`ticket_comment`** + the tool→field mapping (§12.2).
9. **Motion pass** (§11.4), reduced-motion audit last.

---

## 17. Open questions for review

1. **`complexityBasis` — field or comment?** (§4.4) The only field here I hold loosely.
2. **Are comments editable?** I propose no (log, not document) but deletable by their author.
   Editable comments are friendlier; append-only is more honest. Reasonable people differ.
3. **Should `triage` exist as a status, or be a derived view of `origin: "agent"` + never-touched?**
   A status is more explicit; a derived view is one less state to move through when the user is the
   one filing.
4. **Draft persistence for the comment composer.** Skipped in v1 on the reasoning that
   `retainContextWhenHidden` covers the realistic loss case — worth confirming against how you
   actually move between panels.
5. **Event cap of 200.** Generous for a personal tracker, but a long-lived ticket on a hot file
   could brush it. The alternative is spilling events to disk like doc bodies, which is real
   complexity for a case that may never arrive.
