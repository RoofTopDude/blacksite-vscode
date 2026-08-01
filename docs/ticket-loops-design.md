# Ticket Loops — Design & Implementation Plan

Status: phases 1–4 shipped · Owner: Blacksite VS Code extension · View id: `blacksite.loops`

Companion designs: [`tickets-implementation-plan.md`](./tickets-implementation-plan.md), [`execution-runs.md`](./execution-runs.md)

A **loop** is a supervised, long-running drain of the ticket queue: the user names a
queue and a worker budget, and the extension works tickets until the queue is empty
or a stop condition trips. Loops are intended to run for hours, unattended.

---

## 1. Objective

Today the extension can do one ticket at a time, driven by a user prompt per ticket.
The queue exists ([`ticket-store.ts`](../src/ticket-store.ts)), the delegation
machinery exists ([`chat-provider.ts`](../src/chat-provider.ts) subagent lanes), the
evidence trail exists ([`run-store.ts`](../src/runs/run-store.ts)) — nothing joins
them into "work this backlog down".

A loop supplies the three missing pieces:

1. **A scheduler.** Which ticket is next, given dependencies, priority, and what
   other workers are already touching.
2. **A supervisor that outlives a chat turn.** Loops survive window reloads and
   keep going across sessions.
3. **A closure contract.** Something has to decide a ticket is actually done, and
   it must not be the same lane that wants to be finished.

### Non-goals

- **Not a cron.** A loop is driven by queue contents, not the clock. Recurrence is
  a separate feature and should stay separate.
- **Not a new execution engine.** A loop dispatches into the existing subagent lane
  path. It adds scheduling, not a second way to run an agent.
- **Not a ticket editor.** Loops consume the queue; they do not restructure it
  beyond the status transitions their work earns.

---

## 2. The contract (load-bearing)

Five rules. Everything below follows from them.

1. **A loop never invents work.** It drains a ticket query. If the query is empty,
   the loop is done. Tickets a lane discovers are *filed*, and only enter the loop
   if they match the query — which makes an unbounded loop a visible consequence of
   a broad query rather than a hidden behaviour.
2. **A worker lane cannot close its own ticket.** It moves a ticket to `review`.
   Closure is a separate judgment against `acceptanceCriteria` (§6). A lane that
   both does the work and grades it will pass itself.
3. **Two lanes never hold overlapping territory.** `Ticket.territory` is the lock
   (§5). This is the only thing standing between parallel workers and interleaved
   writes to the same file.
4. **A loop has a hard ceiling on every axis it can run away on** — tickets, wall
   clock, tokens, dollars, consecutive failures. Ceilings are declared at creation
   and are not raisable by the model.
5. **An unattended loop never blocks on a human indefinitely.** Approval posture is
   declared up front (§7). A lane that needs an approval it cannot get parks its
   ticket and the loop moves on, rather than holding a worker slot forever.

---

## 3. Data model

New store, `src/loops/loop-store.ts`, persisted to `.blacksite/loops.json`, following
the additive-schema discipline `ticket-store.ts` and `planning-store.ts` already use.

```ts
export type LoopStatus =
  | "draft"        // being configured; never dispatches
  | "running"
  | "paused"       // user-paused; in-flight lanes finish, none start
  | "blocked"      // every remaining ticket is blocked or parked
  | "drained"      // queue empty — the success terminal
  | "stopped"      // a ceiling tripped or the user stopped it
  | "failed";      // the supervisor itself errored

export interface LoopDefinition {
  id: string;
  title: string;
  status: LoopStatus;

  /** What to drain. Evaluated fresh each dispatch, so tickets filed mid-loop are picked
   *  up and tickets closed by hand disappear from the queue without special-casing. */
  queue: LoopQueueSpec;

  /** How much of the machine the user is lending this loop. */
  workers: LoopWorkerSpec;

  /** Non-negotiable ceilings. Declared at creation; the model cannot raise them. */
  ceilings: LoopCeilings;

  /** What happens when a lane needs a human and there is none. See §7. */
  approvalPosture: LoopApprovalPosture;

  /** Who decides a ticket is done. See §6. */
  closure: LoopClosurePolicy;

  createdAt: string;
  updatedAt: string;
}

export interface LoopQueueSpec {
  /** Reuses the board's existing filter vocabulary rather than inventing a query language. */
  statuses: TicketStatus[];        // default: ["backlog", "triage"]
  labels?: string[];
  priorities?: TicketPriority[];
  /** Restrict to tickets whose territory falls under these areas. */
  areas?: string[];
  /** Explicit ticket ids — the "just these twelve" case, which is most of the real usage. */
  ids?: string[];
  /** Honour Ticket.blockedBy when ordering. Ticket links are informational everywhere else
   *  in the product; a loop is the one consumer that must respect them. */
  respectBlockedBy: boolean;
}

export interface LoopWorkerSpec {
  /** Concurrent lanes. 1 means a strictly sequential drain. */
  concurrency: number;
  /** Optional per-ticket subagent profile (see builtin-subagent-profiles.ts). */
  profileId?: string;
  /** Ticket.complexity drives the lane budget by default; this overrides it. */
  complexityOverride?: SubagentComplexity;
}

export interface LoopCeilings {
  maxTickets?: number;
  maxWallClockMs?: number;
  maxUsd?: number;
  /** Consecutive ticket failures before the loop stops. Guards the case where something
   *  environmental broke and every remaining lane will fail identically. */
  maxConsecutiveFailures: number;   // default 3
}
```

Iteration state is a separate record so a definition stays small and diffable:

```ts
export interface LoopIteration {
  loopId: string;
  ticketId: string;
  seq: number;
  laneId?: string;
  subRequestId?: string;      // resumable lane — see MAX_RESUMABLE_LANES
  runIds: string[];
  outcome: "succeeded" | "failed" | "parked" | "abandoned" | "cancelled";
  /** Why it ended, verbatim from the lane's failureKind/nextStep, so a post-mortem does
   *  not require re-reading the transcript. */
  detail: string;
  startedAt: string;
  endedAt?: string;
  usd?: number;
}
```

---

## 4. The dispatch cycle

The supervisor (`src/loops/loop-supervisor.ts`) is a plain async loop, not a timer:

```
while (status === "running") {
  reconcile()                       // re-read queue, drop closed, pick up newly filed
  const ready = readySet()          // §5
  if (!ready.length && !inFlight)   // nothing to do and nothing coming
    → status = queueEmpty ? "drained" : "blocked"
  while (inFlight < concurrency && ready.length)
    dispatch(ready.shift())
  await Promise.race(inFlight)      // wake on the first lane to finish
  checkCeilings()
}
```

`await Promise.race(inFlight)` is why this is not a polling job: the loop wakes
exactly when a worker frees a slot. An idle loop with nothing ready and nothing in
flight goes to `blocked` and stops consuming anything at all.

**Dispatch** is a `subagent_spawn` through the existing provider path, with:

- `task` — built from the ticket's title, description, and `acceptanceCriteria`.
  Acceptance criteria go in verbatim; they are the lane's definition of done and the
  verifier's rubric.
- `context` — territory files, linked plan/phase, prior iteration `detail` if this
  ticket is being retried, and the ticket's own comment timeline.
- `complexity` — mapped from `Ticket.complexity`: `small → standard`,
  `medium → complex`, `large → deep`. The two vocabularies already line up, and
  the mapping means a well-triaged backlog produces well-budgeted lanes for free.
- `label` — the ticket id, so the transcript reads as a work log.

**This design depends on the lane watchdog** landed alongside it. Under the previous
fixed spawn timer a `deep` lane died at 420s regardless of activity; a loop of
thirty such tickets would have been thirty timeouts. The idle/runtime split
(`idleTimeoutSeconds` vs `maxRuntimeSeconds` in `resolveSubagentBudget`) is what
makes an hours-long drain viable at all.

---

## 5. Ready-set and territory locking

A ticket is **ready** when all hold:

1. Its status is still in the queue spec.
2. If `respectBlockedBy`, every id in `blockedBy` has a closed status.
3. It is not parked (§7) and has not exhausted its retry budget.
4. **Its territory does not intersect any in-flight lane's territory.**

Rule 4 is the load-bearing one for `concurrency > 1`. `Ticket.territory` is already
`{ files, areas }` resolvable against the Map index, and
`ticketsIntersectingPaths` in [`ticket-store.ts`](../src/ticket-store.ts) already
computes the intersection — the scheduler reuses it directly rather than inventing
a lock manager.

Two honest caveats to surface in the UI:

- **Territory is declared, not enforced.** A lane can edit a file outside its
  ticket's territory. Territory prevents *scheduled* collisions, not all collisions.
  The mitigation is to widen the lock as a lane runs: `filesTouched` already comes
  back on every lane result, and a lane's effective territory should be
  `declared ∪ touched` for the remainder of the loop.
- **Untenanted tickets serialize.** A ticket with empty territory intersects
  nothing and therefore conflicts with nothing, which is backwards. Treat empty
  territory as conflicting with *everything* — it is the safe reading, and it gives
  triage a visible incentive to declare territory.

Ordering within the ready set is delegated to `rankTickets`
([`ticket-store.ts`](../src/ticket-store.ts)) rather than reimplemented. It is already
the product's explainable "what should I pick up next" ranking, and a loop that
ordered work differently from the board would be a second opinion nobody asked for.

### A loop finishes what it started

One rule discovered while building, and it is load-bearing enough to state here: a
ticket the loop has already attempted **stays in its queue even once its status moves
out of the query**.

A lane that fails partway leaves its ticket `in_progress`; one that hits a dependency
leaves it `blocked`. Under a plain `backlog + triage` status filter both silently
leave the queue, the queue reads as empty, and the loop reports `drained` — "all work
complete" — over a half-finished ticket. Reaching a closed status or `review` does
release it; those are the two ways a ticket legitimately stops being the loop's
problem. Retention is keyed on the loop having touched the ticket, so an unrelated
ticket the user is working on is never adopted.

---

## 6. Closure — who decides a ticket is done

The rule from §2: a worker lane moves its ticket to `review`, never to `done`.

**Decided: `user_review` is the only closure policy.** A lane that succeeds moves its
ticket to `review` with its answer as the note, and stops. Nothing in a loop closes a
ticket — closure is the user's, always.

This is stricter than the alternatives originally sketched here, and the consequence
is worth stating plainly: **`drained` means every ticket was attempted, not that any
of them are done.** An overnight loop hands back a review pile. The UI must say so in
those words; "12/12 complete" over a pile of unreviewed work would be the exact lie
§12 warns about.

`LoopClosurePolicy` is a union of one rather than a bare literal, so widening it later
is additive and the persisted schema already carries the discriminator. A future
`verifier_lane` — a fresh lane with no write tools grading the work against
`acceptanceCriteria` — remains the natural next step if the review pile gets tiring,
and rule 2 is what makes it safe when it arrives.

Retry, meanwhile, is independent of closure and is implemented: a failed ticket
returns to the ready set with its attempt count incremented and **the previous
attempt's failure detail fed into the retry prompt**, so the second attempt is
informed rather than identical. Budget is 2 attempts, then the ticket is withheld as
`exhausted` and surfaced.

---

## 7. Unattended approvals

The failure mode this exists to prevent: a loop starts at 18:00, the third lane hits
a destructive-tier approval at 18:20, and the loop holds that worker slot until
morning.

**Decided: this is configured per loop, not fixed globally.** `LoopApprovalPosture`
is part of the definition and every loop declares its own:

```ts
export interface LoopApprovalPosture {
  /** Tiers that auto-approve without a human. Anything else hits onGate. */
  autoApproveTiers: string[];
  /** Park and move on (default) vs. hold the slot and wait. */
  onGate: "park" | "wait";
  /** Notify on the first park, so a loop that parks everything is noticed early. */
  notify: boolean;
}
```

Tiers are an **allow-list, not a ladder**. The tiers actually in use are `write`,
`network` and `destructive` ([`approval-gate.ts`](../src/approval-gate.ts)) and they
are not totally ordered — asking a user to rank network against file-write would be
inventing a hierarchy the rest of the product does not have.

The default posture is the safe one: `autoApproveTiers: []`, `onGate: "park"`,
`notify: true`. A loop configured that way cannot do anything unattended that it
could not do watched.

**Parking** returns the ticket to the queue in a `parked` sub-state with the gate
recorded, frees the worker slot immediately, and surfaces the ticket in a "needs
you" list. When the user answers, the ticket becomes ready again and the lane
resumes via `subagent_followup` — which is exactly the resumable-lane path, and
another reason the follow-up rendering fix matters: a resumed park must be visible
inside the lane that parked.

Note `autoApproveUpTo: "destructive"` is deliberately expressible and deliberately
not the default. It is the correct setting for a sandboxed worktree and the wrong
one everywhere else, and the creation UI should say so.

---

## 8. Agentic setup

The user's ask: the model should help configure the loop and assign the work out.

Two tools, both configuration-only — neither dispatches:

- **`loop_propose`** — given a natural-language goal ("close out the auth backlog
  this week"), returns a *draft* `LoopDefinition`: the queue spec it inferred, the
  tickets that match, the dependency order it would use, the concurrency it
  recommends and why, and the estimated cost. It writes nothing.
- **`loop_control`** — `start` / `pause` / `stop` / `adjust` on an existing loop.
  `adjust` may lower ceilings and never raise them (rule 4).

The division that keeps this safe: **the model proposes, the user commits.** A
draft loop is inert. Starting one is a user action with the ceilings and the matched
ticket list visible on screen. This matters more than usual here — the whole feature
is "spend money unattended for several hours", and that should never begin as a
side effect of a chat turn.

Where the model earns its place is triage, not dispatch: reading thirty vague
tickets, spotting that six are duplicates, that four are blocked by one unfiled
piece of work, and that the territory declarations are wrong in a way that would
serialize the entire loop. That is a real analysis and it is the thing a user cannot
do quickly by hand.

---

## 9. Persistence and resume

Loops outlive the window. On extension activation the supervisor reads
`.blacksite/loops.json` and, for any loop in `running`:

- In-flight iterations are marked `abandoned` (the lane died with the host; its
  partial work is on disk and in the ticket timeline, but the lane is not resumable
  across a restart — retained lanes are in-memory only).
- Their tickets return to the ready set with the abandonment recorded.
- The loop resumes dispatching, subject to a **resume confirmation** if it has spent
  anything: silently resuming a paid loop after a crash is not acceptable.

Wall-clock ceilings count elapsed time, not running time, so a loop cannot evade its
ceiling by being restarted.

---

## 10. Surface

- **`blacksite.loops` view** — one row per loop: status, drained/total, workers busy,
  spend against ceiling, and a "needs you" count. Start/pause/stop inline.
- **Loop detail** — the iteration timeline: ticket, lane link, outcome, duration,
  cost. This is the post-mortem surface, and it is where an hours-long run becomes
  legible after the fact.
- **Board integration** — a loop-owned ticket shows a loop badge, so the board never
  looks like tickets are moving by themselves.
- **Transcript** — dispatches render as ordinary subagent lanes. A loop is not a
  separate kind of activity and should not look like one.

---

## 11. Build order

| Phase | Scope | State |
|---|---|---|
| 0 | Lane watchdog (idle vs runtime budgets); follow-up lane rendering | **done** |
| 1 | `loop-model.ts`, `loop-store.ts`, schema + normalization, sequential drain | **engine done** — view outstanding |
| 2 | Ready-set, `blockedBy` ordering, territory locking, `concurrency > 1` | **done** |
| 3 | Retry with informed context, park/release, restart reconciliation | **done** (arrived with 1–2) |
| 4 | `LoopDispatcher` adapter onto the real subagent path; `blacksite.loops` view; commands | **done** |
| 5 | `loop_propose` / `loop_control`; cost estimation | not started |
| 6 | Loop detail timeline, resume confirmation UI | not started |

### Three defects the Phase 4 review caught

Worth recording, because two of them made a safety mechanism decorative rather than real.

1. **The approval posture did nothing.** `_runDelegatedLane` always installed the interactive
   approval provider, so an unattended lane raised a modal nobody was there to answer and held
   its worker indefinitely — while the setup dialog claimed writes were being auto-approved. Now
   a `HeadlessApprovalPolicy` is threaded through the lane path and bound per dispatch, since
   two loops running at once can have different postures. It never returns `allow_always`: that
   writes a permanent project-wide auto-approval, and a loop at 3am does not get to widen the
   workspace's standing permissions.
2. **`restore()` could never find anything.** Iterations were written only on completion, so a
   host crash left no record of the in-flight lane — and `restore` looks for exactly an
   iteration with no `endedAt`. The crashed lane vanished silently. Iterations are now opened at
   dispatch and settled on finish.
3. **…which then made every busy lane look like a failure.** The open record folded as a
   failure, so a loop at concurrency 3 with a 3-failure ceiling stopped itself the moment it
   filled its worker slots. Fixed with an explicit `running` outcome that folds neutrally.

Separately, `iterations` grew without bound while the whole document was re-read and re-written
on every lane — quadratic I/O over exactly the long runs this feature exists for. History is now
windowed to the most recent 300, with the older arithmetic folded into `retired` so no total is
lost. `consecutiveFailures` is carried across the trim only when the retained window has settled
nothing since, because a streak is not a sum.

Phases 1–3 landed together because the recovery paths turned out to be inseparable
from the dispatch cycle: retry, park and abandonment reconciliation are all just
outcomes of one lane finishing, and building them separately would have meant
building the same state machine twice.

**What exists now** is the whole engine, injected-dependency and headless:
`LoopSupervisor` takes a `LoopDispatcher` and a `LoopTicketGateway` and never imports
vscode, the chat provider, or the ticket store. Every path — including the ones that
only fire at 3am — is covered by unit tests against fakes.

**What does not exist yet** is the wiring: the adapter that implements
`LoopDispatcher` against the real subagent lane path, and the view. Until those land
a loop cannot be started from the UI.

---

## 12. Open risks

- **Cost is the headline risk.** Thirty `deep` lanes is a materially larger spend
  than anything else in the product initiates. Ceilings, a pre-flight estimate, and
  a live spend readout are all mandatory, not polish.
- **Verification is only as good as `acceptanceCriteria`.** A backlog of one-line
  tickets with no criteria will drain to `done` having achieved nothing checkable.
  `loop_propose` should refuse to recommend `verifier_lane` closure for a queue
  whose tickets mostly lack criteria, and say why.
- **Territory is advisory.** Mitigated in §5, not eliminated. A worktree per lane
  would eliminate it — [`subagent-runner.ts`](../packages/local-runtime/src/subagent-runner.ts)
  already creates worktrees — at the cost of a merge step per ticket. Worth
  revisiting if interleaved-write bugs actually show up.
- **A drained loop is not a finished backlog.** `drained` means the query matched
  nothing further. Saying "all tickets closed" when the query was narrow would be a
  lie the UI must not tell.
