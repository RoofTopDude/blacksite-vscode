# Orchestration 2.0 — P1 Coordination: Signals, Concurrency Claims, Scheduling

Status: **shipped in 1.33.0-pre.5** (live evaluation not yet run) · Issues: [#14](https://github.com/RoofTopDude/blacksite-vscode/issues/14) and [#19](https://github.com/RoofTopDude/blacksite-vscode/issues/19) in parallel, then [#15](https://github.com/RoofTopDude/blacksite-vscode/issues/15) · Epic: [#10](https://github.com/RoofTopDude/blacksite-vscode/issues/10)

Companion docs: [`orchestration-p0-implementation-plan.md`](./orchestration-p0-implementation-plan.md), [`ticket-loops-design.md`](./ticket-loops-design.md), [`execution-runs.md`](./execution-runs.md), [`../tests/eval/README.md`](../tests/eval/README.md)

Prepared 2026-10-16 from a reading of the current code, for whoever implements it. Line
references are to `main` at 1.33.0-pre.4 (`9d6d595`). Re-read each file before editing.

## Progress log

Implemented 2026-10-16 in one working tree, in the order Phase 0, #14, #19, #15, and released
together as prerelease 1.33.0-pre.5. The parallel tracks of §6 were not needed with one
implementer. All three flags ship at their baselines.

| Part | State | Notes |
| --- | --- | --- |
| Step 0 live baseline | **Not run** | Needs a provider key and a spend ceiling. It still blocks changing any default. |
| Phase 0 | Done | Three flags with shadow values; `SHADOW_ORCHESTRATION_FLAGS`; frozen `signals/model.ts` with `NULL_SINK`; replay arms as a flag matrix. **Deviation:** extra arms are opt-in per trace (header `arms`), not run for every scenario. |
| #14 signals | Done | See the breakdown below this table. |
| #19 claims | Done | See the breakdown below this table. |
| #15 scheduling | Done | See the breakdown below this table. |

**#14 signals, in detail:**

- **Modules:** `src/orchestration/signals/{model,derive,journal,consumers,service,ports}.ts`.
- **Consumers:** they are pure, and return actions that the service applies only under `act`.
  The action vocabulary is the whole of what signals can do.
- **Supervisor:** `LoopSupervisor.wake` and `previewReady`, `blockedOn`, resume offers. Plan-run
  `onEvent`/`onStalled` hooks and the `reassessment` ledger event feed the conductor's digest.
- **Loops view:** "Ready to continue" banner (Resume goes through the existing confirmation) and
  "Flagged for you".
- **Replays:** six new traces covering a dependency closing while a loop runs or while it is
  blocked, a restart between journaling and reconciling, a storm with redelivery, missing evidence
  and a cancelled run.
- **Deviations:**
  - Plan-run cause ids use the event's type, step and time, not its ledger position. The position
    restarts with the host and would reuse ids.
  - The "can continue" attention item has no button of its own, because attention items carry no
    actions. The Loops view banner has the Resume button.
  - `integration_ready` is derived from the board directly (all blockers closed, or every child in
    review or closed), not through a graph walk.

**#19 claims, in detail:**

- **Modules:** `src/orchestration/claims/{registry,session-claims,edit-claims,working-tree}.ts`.
- **Session:** claims are checked right after the scope gate, and renewed on every tool call. Reads
  and writes are recorded after each call. Shell commands are diffed with `git status`.
- **Wrapping:** edit/LSP wrappers sit outside the contract wrappers.
- **Release:** claims are released in the lane runner's `finally`, and in the resumed-lane path.
- **Main session:** holds no claims. It gets a `claimWarning` on its result instead.
- **Receipts:** `coverage: "tool_edits+shell_delta"`, `observed.conflicts`, `observed.unattributed`.
  Under enforcement a collision makes the receipt `partial`.
- **Deviations:**
  - A shell write outside the contract makes an enforcing receipt `failed` (scope violation), not
    `partial`. Shell-changed files join `filesChanged`, so they get exactly the existing rule for
    out-of-territory changes.
  - No replay arm: scripted lanes write no files. Coverage is in
    `tests/unit/orchestration-claims.spec.ts`, which drives two real `AgentSession`s and includes a
    500-run seeded interleaving test.

**#15 scheduling, in detail:**

- **Code:** `computeGraphReadySet` and `SchedulingGraph` in `loop-scheduler.ts`; the adapter is
  `loops/scheduling-graph.ts`.
- **Supervisor:** reads a `LoopSchedulingContext` before every pass; the host builds it from the
  work graph, live claims and the receipt index. Decisions are recorded on change, without the
  running tickets, along with `scheduledBecause`, `passedOver` and `lastClaimConflict`.
- **D6:** `dependencySatisfiedBy` is honoured by both schedulers, with plumbing in the store, the
  loop tool, the proposal and the composer.
- **Replays:** three new traces: a critical blocker, a starvation guard, and cycles plus a missing
  dependency.
- **Deviations:**
  - `waitingInputs` is always empty until #17 produces `consumes` edges.
  - The starvation fixture needs work that keeps *arriving*. With a fixed set, every waiting ticket
    earns credit equally and the order never changes. That is not starvation: the low ticket still
    runs.

**Found while testing, not fixed (outside these issues):**

- A loop given an explicit id list (`queue.ids`) admits tickets in any status, review and done
  included. `matchesQueue` returns early for ids. Such a loop runs a finished ticket again until its
  two attempts are spent.

### Verification (2026-10-16)

See the release commit. Not verified: a live run, and any of the three modes in a real VS Code
window.

Order: **Step 0** (live baseline, not code), **Phase 0** (a small shared seam on `main`), then
**#14 and #19 in parallel**, then **#15**.

```
Step 0 ── Phase 0 ──┬── #14 Signals + reconciliation ──┐
(live     (flags,   │                                  ├── #15 Scheduling
 eval)     signal   └── #19 Concurrency claims ────────┘   (wake from #14,
           types,                                           held territory from #19)
           arm matrix)
```

This order differs slightly from the issue labels. #15 depends on #14, and it uses #19's live
claims for admission. #19 depends only on #11 and needs nothing from #14 except the signal
*types*. Freezing those types in Phase 0 lets #14 and #19 run side by side, and #15 then lands
on top of both instead of being reworked once claims exist.

---

## 0. Intent and decisions

P0 gave the host contracts, receipts, a replay suite and a read-only work graph. P1 makes the
host **react** to what it observes, **prevent** concurrent lanes from colliding, and **choose**
work using the graph. None of it may weaken approvals, raise a limit, or close a ticket.

The epic's rule applies throughout: no automatic model-driven strategy until the host can audit
the state changes underneath it. #14 provides that audit trail; #16 (strategic conductor) stays
out of scope.

The owner decided D5, D6, D8 and D9 on 2026-10-16. The rest are recommended defaults.

| # | Decision | Why |
| --- | --- | --- |
| D1 | Three new flags, all registered in `ORCHESTRATION_FLAGS`: `blacksite.orchestration.signals` (`off \| observe \| act`), `blacksite.orchestration.claims` (`off \| observe \| enforce`), `blacksite.orchestration.scheduler` (`legacy \| shadow \| graph`). Baselines `off`, `off`, `legacy`. Shadow values `observe`, `observe`, `shadow`. | Same shape as `workContracts`: a shadow value that records everything and changes nothing, so the replay suite can prove parity before anything acts. |
| D2 | **Consumers are level-triggered.** A signal is a hint that something changed. A consumer responds by re-reading current state and re-deriving what should be true. It never acts on the signal's payload alone, and a signal never dispatches work directly. | This one rule gives idempotence, out-of-order tolerance and safe restart replay. A duplicate or late signal only causes one more re-evaluation of the current state. Dispatch still happens only inside `computeReadySet`. |
| D3 | Every signal has a **provenance**: `host` (observed by the host), `user` (a person did it), `reviewer` (the auto reviewer ruled), or `model` (an agent claimed it). Only `host` and `user` signals may change ready/blocked state. `model` signals can only raise a reassessment flag. | This is the issue's "keep model interpretations separately attributed". It also keeps a lane's own account of its work from unblocking anything. |
| D4 | Consumers get a **narrow port**: wake a running loop, tell the user a stopped loop can continue, raise a reassessment flag, add a ticket note. They cannot start, resume or create loops, create tickets, change ceilings, approvals or contracts, or close anything. | This enforces "events cannot create unauthorized work or alter limits" through the type system, not through review. |
| D5 **(decided 2026-10-16: no auto-resume)** | A loop that is not running never starts again because of a signal. A **running** loop re-schedules immediately when a dependency clears. A loop that settled `blocked` only on dependencies gets a "can continue" attention item when they clear, and Resume stays a user action. | The owner chose to keep every start a person's decision. Signals inform, and the person resumes. |
| D6 **(decided 2026-10-16: yes, opt-in)** | A hard dependency is met when its ticket is **closed** (`done`/`cancelled`), as today. A loop may opt in to `queue.dependencySatisfiedBy: "verified_review"`. With it, a blocker in `review` whose latest receipt is `verified` counts as met. The default is `"closed"`. | Human-only closure means a chain BLK-1 → BLK-2 stalls at every link until someone reviews. The opt-in removes that wait without letting anything close a ticket. |
| D7 | Claims are **acquired at mutation time, not at dispatch**. They are short leases on concrete paths, all-or-nothing per call, and never waited on. A conflicting write is refused with the holder named, and the lane decides what to do next. | Dispatch-time territory is already the scheduler's job. #19 closes the gap between that advisory territory and real writes. Never waiting means no deadlocks. |
| D8 **(decided 2026-10-16: warning)** | The main chat agent is **not** a claim holder. Its writes still bump file versions, so lanes see stale reads it causes. When it writes into a file a lane holds, it gets a warning in the tool result, not a refusal. | The main session is the user's own. A refusal there would put a background lane ahead of the person at the keyboard. |
| D9 **(decided 2026-10-16: deferred to #21)** | Worktree isolation for large independent jobs is **specified here but built in #21**. P1 ships shared-tree claims and conflict reporting. Per-lane worktrees need the runtime, LSP and Map rooted per lane; today they are rooted per window (`plans/run-isolation.ts` opens a new window for that reason). | Doing it properly is #21's integration work. A half version would give lanes a tree their tools cannot see. |
| D10 | No new `LoopIterationOutcome` values and no new required fields, as with P0's D4. Every new persisted field is optional and preserved by the normalizers. | `loop-store.ts` normalizes unknown outcomes to `"failed"`, and older builds must read newer files. |

**Non-goals for P1:**
- strategic conductor behaviour (#16);
- artifact exchange (#17), beyond honouring `consumes` edges that already exist;
- an independent verifier lane (#18);
- false-progress detection (#20), which consumes #14's signals later;
- integration branches and per-lane worktrees (#21);
- graph UI (#24).

---

## Step 0 — live baseline (before Phase 0, not code)

P0 shipped without a live run. Every P1 flag needs that baseline before its default can change.

```
npm run eval:live -- --scenario delegation-fanout      --arms baseline,enforce --repeats 3
npm run eval:live -- --scenario cross-module-refactor  --arms baseline,enforce --repeats 3
```

- Commit the summary under `tests/eval/baselines/`.
- Record any receipt-versus-verifier disagreement as a #11 bug with a test.
- This is also the first time `workContracts=enforce` runs in a real VS Code window. Note
  anything it gets wrong in the P0 plan's progress log.

This step does not block implementation. It blocks **changing any default**.

---

## 1. What exists today

| Area | Where | What P1 builds on |
| --- | --- | --- |
| Loop cycle | `loops/loop-supervisor.ts:259` `_cycle` | Schedules, dispatches, then `await Promise.race` over in-flight lanes. A blocker closed mid-wait goes unnoticed until a lane finishes. On `blocked` it settles and returns; nothing ever restarts it. |
| Restart | `loop-supervisor.ts:165` `restore` | Marks open iterations abandoned, writes abandoned receipts, leaves loops paused. |
| Ready set | `loops/loop-scheduler.ts:143` `computeReadySet` | Queue match, then park/exhausted/`blockedBy`/blocked checks, then territory admission against in-flight and already-admitted territory. Pure. |
| Territory | `loop-scheduler.ts:85` `territoryOf`, `territoryConflicts`, `UNTENANTED` | Declared ∪ touched files. Untenanted conflicts with everything. |
| Withheld reasons | `loop-scheduler.ts:113` | `blocked \| parked \| exhausted \| territory`. Sent to the webview as a plain string (`webview/react/apps/loops/protocol.ts:74`). |
| Ranking | `ticket-store.ts:1601` `rankTickets`, `:1572` `byPriorityThenRecency` | Explainable score with reasons. **Ties on equal `updatedAt` fall back to input order**: not deterministic across inputs. |
| Open statuses | `ticket-store.ts:207` | `review` is open, so a blocker in review still blocks (D6). |
| Ticket events | `ticket-store.ts:78` `TicketEvent` | Each has an `id`, an `actor` (`user`/`agent`), and `from`/`to`. These supply the cause id and provenance for ticket signals. |
| Receipts | `orchestration/receipt-store.ts` | A listener API (`:66`). Status, `granted`, `refused`, `observedOutOfScope`, `failedFiles`. |
| Plan-run ledger | `plans/plan-run-service.ts:977` `_event`, `:968` `_apply`; events in `plan-run-model.ts:250` | Step transitions, tripwires, receipts, conductor decisions, quiet-attention stall (`:1237`). |
| Tripwires | `plans/run-tripwires.ts` | `repeated_failure`, `check_regressed`, `out_of_territory`, built from host-measured facts. |
| Lane watchdog | `chat-provider.ts:2501` `createLaneWatchdog` | Aborts a stalled lane with a reason. |
| Lane contracts | `orchestration/lane-contracts.ts`, `active-contract.ts` | Issue, meter, and edit/LSP wrappers that settle scope at the moment of the write (`contractRouting`). |
| Pre-dispatch scope gate | `agent-session.ts:2245` `_contractScopeGate`, called at `:4842` | Where a file-mutating call is checked before it runs. `mutationTargets` lives in `contract-scope.ts`. |
| Lane runner | `chat-provider.ts:2704` `_runDelegatedLane`; contract wrappers at `:2814` | Where a lane's providers are built and torn down (a `finally` exists). |
| Parallel lanes | `agent-session.ts:4696` | Up to `subagentMaxConcurrent` (default 4, max 8) lanes run at once in the same tree. Loops run up to 8 (`MAX_LOOP_CONCURRENCY`). |
| Freshness | `file-freshness.ts:65` `FileFreshnessLedger` | Per session read/write sequence. Anchored edits fail safely on stale content. `file_write` overwrite and `code_insert` do not. |
| Runtime writes | `packages/local-runtime/src/file-ops.ts:490` `writeFile`, `:594` `deletePath`, `copyPath` | Executed immediately after the pre-dispatch checks. |
| Work graph | `orchestration/work-graph/graph.ts` `blockers`, `walk`, `criticalPath`, `findings`; `service.ts` | Everything #15 needs to rank by downstream impact, with cycles and missing references already reported. |
| Isolation | `plans/run-isolation.ts` | Worktree on its own branch, opened in its own window. Plan runs only. |
| Replay arms | `tests/eval/harness/run-scenarios.ts:19` `ARMS` | Keyed on `workContracts` only. Must become a flag matrix (Phase 0). |

---

## 2. Phase 0 — shared seam (one commit on `main`)

1. **Flags.**
   - Register `signals`, `claims` and `scheduler` in `src/orchestration/flags.ts` with baseline,
     shadow and rollback notes. Declare all three in `package.json` as experimental.
   - The registry checks in `tests/eval/replay/flags.spec.ts` then cover them automatically.
2. **Signal types, frozen.** `src/orchestration/signals/model.ts` (pure):

   ```ts
   export type SignalKind =
     | "dependency_discovered" | "contract_conflict" | "verification_failed"
     | "scope_expanded" | "progress_stalled" | "integration_ready" | "work_completed";

   export type SignalProvenance = "host" | "user" | "reviewer" | "model";

   export interface OrchestrationSignal {
     v: 1;
     /** Deterministic: hash of kind, taskId and causeId. The same fact always has the same id. */
     id: string;
     kind: SignalKind;
     /** A work-graph node id: ticket:BLK-12, step:<plan>/<phase>/<step>, lane:<laneId>. Stable. */
     taskId: string;
     /** What caused it: a receipt id, ticket event id, `loop:<id>#<seq>`, `planrun:<id>@<n>`, a tool call id. */
     causeId: string;
     at: string;                      // injected clock
     seq: number;                     // assigned by the journal; total order on this host
     provenance: { source: SignalProvenance; observer: string };   // observer: "receipt", "ticket.event", "tripwire", "claims", "watchdog", …
     scope?: { loopId?: string; planRunId?: string; laneId?: string; contractId?: string };
     evidence?: Array<{ kind: "receipt" | "file" | "check" | "tool_call" | "snapshot" | "ticket_event"; ref: string; sha256?: string }>;
     detail: string;                  // one sentence for a person
     data?: SignalData;               // a discriminated payload per kind, e.g. conflict paths and holders
   }

   export interface SignalSink { emit(signal: Omit<OrchestrationSignal, "id" | "seq" | "v">): void }
   export const NULL_SINK: SignalSink;
   ```

   - #19 emits through `SignalSink` from day one.
   - #14 supplies the real sink. Until then the host passes `NULL_SINK`.
3. **Replay arm matrix.**
   - Change `ARMS` to `{ arm, flags: Partial<OrchestrationFlags> }`.
   - The `observe` arm turns on **every** flag's shadow value at once. Shadow parity then covers
     each new flag without adding arms.
   - New acting arms: `signals-act`, `claims-enforce`, `scheduler-graph`.
   - Existing golden file names stay unchanged; new arms get new files. The canonicalizer
     already strips receipt fields from the parity comparison. Extend that strip list with
     `signals`, `reconciliations`, `decisions` and `claims`.
4. **Loop seams.**
   - `LoopSupervisor` gains an injectable `wake` primitive: a waiter the cycle can race against.
   - `LoopStore` normalizer preserves the new optional fields (§3.6, §5.5) from day one, so a
     build with Phase 0 in it never drops what #14/#15 write.
5. Add this document.

Gate: §9. Then cut `orch/14-signals` and `orch/19-claims` from this commit.

---

## 3. #14 — Typed orchestration signals and event-driven reconciliation

### 3.1 Module layout (`src/orchestration/signals/`)

| File | Pure? | Role |
| --- | --- | --- |
| `model.ts` | yes | Types (Phase 0), `signalId()`, payload validators. |
| `derive.ts` | yes | Facts → signals. One function per source (§3.3). No I/O. |
| `journal.ts` | no (fs) | Append-only `.blacksite/orchestration/signals/journal.jsonl` plus `cursors.json`. Assigns `seq`, drops known ids, rotates. |
| `bus.ts` | yes | Debounce and coalescing, then dispatch batches to consumers on a tick. Injected clock. |
| `consumers.ts` | yes | The reconcilers (§3.4) over a narrow `ReconcilePorts`. |
| `service.ts` | no | `SignalService`: wires sources → derive → journal → bus → consumers. Owns the subscriptions. No `vscode` import (host passes in readers), like `WorkGraphService`. |

### 3.2 Signal semantics

| Kind | Host-derived from | Model-derived from | Meaning for consumers |
| --- | --- | --- | --- |
| `work_completed` | Receipt `verified`/`succeeded_unverified`; a ticket event moving to `done`/`cancelled` (actor `user` → provenance `user`); plan `step_completed` **with** evidence | Plan `step_completed` with no evidence (the agent ticked it off) | Dependents may now be ready. |
| `verification_failed` | Receipt `failed` with failed checks or `failedFiles`; tripwire `check_regressed`; a check failing on a file whose step is already completed | — | Work believed done may not be. Raises a reassessment. Never reopens anything. |
| `scope_expanded` | Receipt `granted` (D2 grants) or `observedOutOfScope`; claims finding writes outside the contract after a shell command (#19) | — | Territory grew. The scheduler widens that ticket's effective territory (#15). |
| `contract_conflict` | Two live contracts whose writable territories intersect at issue; a refused or observed claim collision (#19); a receipt-pair concurrent change (`graph.concurrent_change`) | — | Two pieces of work collide. Raises a reassessment and wakes the scheduler. |
| `progress_stalled` | Lane watchdog abort; plan-run quiet attention (`:1237`); tripwire `repeated_failure`; a loop iteration with no activity for `STALL_MS` (default 15 min) | — | Latched: emitted once per task until progress resumes. Raises a reassessment. |
| `integration_ready` | Derived after a `work_completed`: a dependent whose hard blockers are now all met (graph `blockers(ref)` is empty), or a parent ticket whose children are all in review or closed | — | The work can start, or its parts can be integrated. Wakes the scheduler. |
| `dependency_discovered` | A ticket event adding a `blockedBy` (actor gives provenance); a refused scope write whose path lies in another open ticket's declared territory | A lane's failure result naming a missing prerequisite (`failureKind`, `nextStep`) | Host/user: the scheduler re-reads. Model: reassessment only (D3). |

Rules:

- **Latching.** `progress_stalled` and `integration_ready` describe states, not events. They are
  persisted only on a transition and cleared by the opposite fact (activity resumed; a blocker
  reopened). This is the issue's "persist meaningful transitions".
- **Missing evidence.** A signal whose evidence reference cannot be resolved (a receipt id that is
  not in the store, for example) is still journaled. Its provenance is downgraded to `model`, and
  `data.evidenceMissing: true` is set. It can then flag, never unblock.
- **Cancelled runs.**
  - A lane or run cancelled by the user emits nothing beyond what its receipt says
    (`cancelled`), and that receipt status maps to no signal.
  - Signals already queued for a cancelled loop or run are journaled, but consumers skip
    targets that are no longer running.
- **No signals from reconciliation itself.** A change a consumer makes carries the cause
  `reconcile:<signalId>`. `derive.ts` ignores it. This prevents a signal → consumer → change →
  signal loop.

### 3.3 Sources (all in `service.ts`, each a thin adapter over a pure `derive*`)

| Source | Subscription | Derivation |
| --- | --- | --- |
| Receipts | `ReceiptStore` listener | `deriveFromReceipt(receipt)` |
| Tickets | `TicketStore.onDidChange` | `deriveFromTicketEvents(prevSeenEventIds, ticket)`. Diff by event id, so a re-read never re-emits. |
| Loops | `LoopStore.onDidChange` | `deriveFromIterations(prev, next)`: watchdog/stall reasons and lane failure results (model provenance) |
| Plan runs | New optional `PlanRunServiceOptions.onEvent(event, index)` hook, called from `_event` | `deriveFromPlanRunEvent` |
| Contracts | `LaneContracts.issue` (new `onIssued` hook) | `deriveContractOverlap(newContract, liveContracts)` |
| Claims (#19) | `SignalSink` passed into `ClaimRegistry` | Emitted directly; already typed. |
| Graph | After a `work_completed`, `WorkGraphService.graph().walk(task, "dependents", 1)` then `blockers()` | `integration_ready` |

### 3.4 Consumers

```ts
interface ReconcilePorts {
  /** Re-run scheduling for a running loop now, instead of when a lane next finishes. */
  wakeLoop(loopId: string): void;
  /** D5: tell the user a loop that settled `blocked` on dependencies alone could now continue. Never starts it. */
  offerResume(loopId: string, because: string, signalIds: readonly string[]): void;
  /** Bounded, deduped by signal id, on the loop record or plan run. Shown in the UI and given to the conductor. */
  flagReassessment(target: { loopId?: string; planRunId?: string }, entry: ReassessmentEntry): void;
  /** Open tickets only; deduped by signal id (marker in the note). */
  noteTicket(ticketId: string, signalId: string, text: string): void;
}

interface SignalConsumer {
  id: string;                                // stable; cursor key
  kinds: readonly SignalKind[];
  reconcile(batch: readonly OrchestrationSignal[], ports: ReconcilePorts, read: ReconcileReads): ReconcileRecord[];
}
```

- **C1 `loop-wake`.** On `work_completed`, `integration_ready`, `dependency_discovered`
  (host/user), `scope_expanded` or `contract_conflict` touching a running loop's queue, call
  `wakeLoop`.
  - The supervisor adds the wake waiter to its `Promise.race` (`_cycle`, the `"wait"` branch)
    and re-runs `computeReadySet`.
  - This is the fix for "a blocker closed mid-wait goes unnoticed".
- **C2 `loop-unblocked`** (D5: inform, never start). On host/user `work_completed` or
  `integration_ready`, for each loop with status `blocked`:
  - It needs a new optional `definition.blockedOn` field, recorded by `_settle` when every
    withheld reason was `blocked` (later also `incoherent`).
  - If `blockedOn === "dependencies"`, re-run `computeReadySet` against current state, which is
    pure and dispatches nothing.
  - If anything is now ready, call `offerResume`. That raises one attention item, deduped per
    loop: "BLK-1 was closed, so «Nightly cleanup» can continue with BLK-2 and BLK-5", with a
    Resume action, through the existing `notify` path.
  - When the user resumes, `start` runs as today. Ceilings, including elapsed wall-clock, apply
    as usual.
  - The item is withdrawn if the loop is resumed, deleted or stopped, or if a later re-check
    finds nothing ready again.
  - Never acts on `paused` or `stopped` loops.
- **C3 `reassess`.** Raises a flag on `verification_failed` after completion,
  `contract_conflict`, `progress_stalled`, any `model`-provenance signal, and `scope_expanded`
  beyond 10 granted files.
  - Plan runs: add the flags to `conductorContext()` (`plan-run-service.ts:876`) so the existing
    conductor sees them.
  - Loops: add an attention item (the existing `notify`/`onSettled` surfaces) and show the flags
    in the loop panel.
  - Flags never change state. Acting on them is #16.
- **C4 `ticket-notes`.** One timeline note per host `contract_conflict` or
  `verification_failed` on an open ticket. It is never written to a closed ticket.

Every consumer run writes a `ReconcileRecord` line to the journal:

```ts
interface ReconcileRecord { at: string; consumer: string; signalIds: string[]; action: string; target: string; applied: boolean; detail: string }
```

`applied` is `false` under `signals=observe`: the record says what *would* have happened. This
is the audit trail the epic asks for before #16.

### 3.5 Debounce, storms, ordering, restart

- **Dedup.** A signal's `id` is deterministic. The journal keeps a bounded set of recent ids,
  rebuilt from the tail on load, and drops repeats. Replaying a source therefore yields the same
  ids and nothing new.
- **Coalescing.** The bus collects signals for `COALESCE_MS` (250 ms, injected clock), then
  dispatches one batch per consumer. C1/C2 collapse a batch to one action per loop. A storm of
  10,000 signals costs one reconciliation per loop per tick.
- **Out-of-order delivery.** Consumers read current state (D2). A `work_completed` that arrives
  before its iteration is recorded simply finds the ticket not yet ready. The next signal or lane
  settle re-evaluates it.
- **Restart.**
  1. On activation, `LoopSupervisor.restore()` runs first, as today. Loops are paused.
  2. `SignalService` then replays journal entries after each consumer's cursor.
  3. Consumers are level-triggered, and no consumer can start a loop (D5). Replay therefore
     cannot dispatch anything. A crash between journal append and cursor save only causes one
     extra re-evaluation, and one deduped resume offer at most.
- **Finished tickets.** No consumer mutates a closed ticket; C4 checks before writing. C1 only
  wakes a running cycle, whose `computeReadySet` never selects a closed ticket.
- **Retention.**
  - Journal rotates at 4 MB and keeps the last two files.
  - Records older than 30 days are pruned with receipts (the 60 s post-activation prune in
    `extension.ts`).

### 3.6 Persistence on existing records (optional fields only)

- `LoopDefinition.blockedOn?: "dependencies" | "mixed"`.
- `LoopRecord.resumeOffer?: { at: string; ready: string[]; signalIds: string[] }`. Set by C2,
  cleared by `start`, `stop` or a re-check that finds nothing ready. When the user resumes from
  the offer, the execution entry records `offeredBy: signalIds`, so the audit trail shows which
  facts prompted it.
- `LoopRecord.reassessments?: ReassessmentEntry[]` (last 50).
- `PlanRun.reassessments?` (last 50). This is ledger state, so add a new `reassessment` event to
  `PlanRunEvent`. Older builds ignore unknown events in `events.jsonl` and `normalizePlanRun`
  tolerates extra fields. Verify both with a test.

### 3.7 Flag behaviour

| `signals` | Derive and journal | Consumers run | Effects applied |
| --- | --- | --- | --- |
| `off` | no | no | no. No file is created. |
| `observe` | yes | yes | no. Records `applied: false`. Must match `off` exactly in replays once `signals`/`reconciliations` are stripped. |
| `act` | yes | yes | yes |

### 3.8 Tests, mapped to the acceptance criteria

| AC | Test |
| --- | --- |
| Typed events carry id, cause, provenance, timestamp, evidence | `signals.model.spec.ts`: validator rejects a missing field; id is deterministic; every `derive*` output passes the validator (property test over generated facts). |
| Known-safe unblocking is deterministic, no model | `signals.consumers.spec.ts`: C1/C2 over a fake store; model-provenance input never wakes a loop or offers a resume; same input gives the same records. Replay `loop-dependency-chain-running`: a long BLK-3 lane is in flight, and the user closes BLK-1 at t+20 min. Under `baseline`, BLK-2 waits until BLK-3 finishes at t+60. Under `signals-act`, BLK-2 dispatches at t+20, exactly once. Replay `loop-dependency-chain-blocked`: the loop has settled `blocked` when the user closes BLK-1. Under `baseline` nothing happens. Under `signals-act` one resume offer is raised, nothing dispatches until a scripted user Resume, and then BLK-2 dispatches once. |
| No unauthorized work, limits untouched | Type-level: `ReconcilePorts` has no start, resume, create, adjust or close. Spec: no consumer path calls `LoopSupervisor.start` (spy over every consumer and every signal kind). Spec: C2 never offers for `paused` or `stopped` loops, or for loops with `blockedOn: "mixed"`. |
| Restart replay does not duplicate dispatch or mutate finished tickets | Replay `loop-restart-replay`: crash after journal append, before cursor save; dispatcher call count equals the baseline. Spec: C4 skips closed tickets. |
| Storms, out-of-order, cancelled runs, missing evidence | Replays `loop-signal-storm` (500 duplicate receipts plus 200 ticket edits within 1 s; one wake per tick), `loop-out-of-order` (closure delivered before the iteration settles), `plan-cancelled-signals`, `plan-missing-evidence` (step ticked with no evidence → `model` provenance → no host `work_completed`). |

The trace format gains `ticket_change` (a user edit at virtual time), `redeliver` (resend the
source's last N facts) and `crash_at` (stop before a named write).

### 3.9 Build order (one commit per step)

1. `derive.ts` plus source adapters for receipts and tickets. Journal with dedup, rotation and
   cursors. Spec coverage.
2. Bus and consumers C1/C3. `LoopSupervisor.wake`. Plan-run `onEvent` hook and the
   `reassessment` event.
3. C2 (D5), `blockedOn`, `resumeOffer` and its attention item with a Resume action. C4.
4. Remaining sources: loops, contracts, watchdog, latching.
5. Replay traces and golden files for `observe` and `signals-act`. Loop panel: reassessment list.
   Docs (`settings-and-commands.md`, `ticket-loops-design.md`), CHANGELOG.

---

## 4. #19 — Mutation-time concurrency claims

### 4.1 Model (`src/orchestration/claims/registry.ts`, pure, injected clock)

```ts
interface ClaimHolder { id: string; laneId: string; label: string; contractId?: string; loopId?: string; ticketId?: string }

interface Claim {
  key: string;                 // normalized path; case-folded on win32/darwin
  prefix: boolean;             // a directory delete or move claims everything under it
  holder: ClaimHolder;
  acquiredAt: number;
  renewedAt: number;           // any tool call by the holder renews; not only writes
}

class ClaimRegistry {
  constructor(opts: { now: () => number; leaseMs?: number /* 15 min */; maxLeaseMs?: number /* 2 h */; caseInsensitive: boolean; sink: SignalSink; mode: () => "off" | "observe" | "enforce" });
  /** All or nothing. Never waits. Expired leases are reaped first. */
  acquire(holder: ClaimHolder, paths: readonly string[], opts?: { prefix?: boolean }): { ok: true } | { ok: false; conflicts: Array<{ path: string; holder: ClaimHolder }> };
  renew(holderId: string): void;
  release(holderId: string): void;
  /** Version bumps on every completed write by anyone, including the main session. */
  noteWrite(path: string, by: string): void;
  version(path: string): number;
  held(exceptHolder?: string): ReadonlyMap<string, ClaimHolder>;  // for #15 admission
}
```

- In-memory and window-scoped. A host restart therefore leaves nothing to leak.
- Two windows on the same folder are out of scope and documented. An isolated run copy is a
  different folder, so it is unaffected.

### 4.2 Where claims are taken (the same two boundaries as contract scope)

1. **Before a runtime mutation.** `AgentSession` gains a `claims?: LaneClaims` option. Right
   after `_contractScopeGate` (`agent-session.ts:4842`), for `mutationTargets(tc.name, payload)`:
   - `file_move` claims both the source and the destination.
   - `file_delete` of a directory and `file_move` of a directory take prefix claims.
   - `file_edit_batch` and `code_replace_batch` claim every path in one all-or-nothing call.
2. **At the editor/LSP edit.** `createClaimEditProvider` and `createClaimLspProvider` sit in
   `claims/edit-claims.ts`, alongside `active-contract.ts`. They wrap *outside* the contract
   wrappers, so scope is settled first, and they claim `request.paths`, the files a rename or code
   action actually touches. A rename's destination is claimed even though the input never named
   it.

**Stale reads.** Each lane records `registry.version(path)` when its `FileFreshnessLedger`
records a read. Before an **overwrite** (`file_write`) or **positional** (`code_insert`) write:

- if the version advanced since that read, by a holder other than this lane, the write is
  refused: "BLK-7's lane changed this file after you read it; re-read it first".
- Anchored edits keep today's behaviour (they already fail safely). They get the holder's name
  in the failure explanation (`freshnessWarning`).

**Outcomes per mode:**

| Situation | `observe` | `enforce` |
| --- | --- | --- |
| Path held by another live lane | Write proceeds. `contract_conflict` signal (`data.would: "refuse"`), listed on the receipt. | Refused with the holder named and the advice "work elsewhere, wait, or report". `contract_conflict` signal. |
| Stale read before overwrite or positional write | Proceeds, recorded. | Refused, "re-read first". |
| Read-only tools, read-only lanes | Never claim; never refused. | Same. |
| Main session (D8) | Bumps versions. | Bumps versions. Gets a warning naming the lane, never a refusal. |

- After a successful write, call `noteWrite(path, holderId)`.
- `renew(holderId)` runs on every tool call the lane makes, so a lane spending ten minutes reading
  does not lose its claims.

### 4.3 Release

- `_runDelegatedLane` takes a holder at start and calls `release(holderId)` in its existing
  `finally`. That covers success, failure, abort and watchdog timeout.
- A lane that dies without its `finally` running (host crash) has nothing to release: the
  registry is in memory.
- A wedged lane that holds claims past `leaseMs` without a tool call has its claims reaped on
  the next acquire. That lane's next write must re-acquire, which may then conflict.

### 4.4 Shell writes and out-of-contract writes

This closes the P0 gap ("no `git status` delta").

- **When claims are on**, the lane runner records `git status --porcelain=v1 -z` (plus the
  mtimes of the files listed) before and after each `shell_exec`/`test_run` call in a lane.
  - The delta is that call's observed writes.
  - It is attributed to the lane only if no other lane ran a shell command in the same window.
    Otherwise the files are marked `unattributed` on both receipts.
- **Delta files that another lane holds** produce a `contract_conflict` signal with
  `observer: "shell_delta"`.
- **Delta files outside the lane's contract** produce a `scope_expanded` signal with
  `data.authorized: false`, and the files are listed on the receipt (`shellOutOfScope`).
- **Under `enforce`**, either finding stops the receipt from being `verified`; it becomes
  `partial`. A loop then sends the ticket back for another attempt instead of to review (P0's
  `_resultFromReceipt`). Nothing is reverted.
  - This is the host policy for "unknown or out-of-contract writes are surfaced and halted".
  - Contract authority is never widened silently: a shell write cannot be granted after the fact.
- Receipt `coverage` becomes `"tool_edits+shell_delta"` when the delta ran, and stays
  `"tool_edits"` when it could not run (not a git repository, git missing, or past a 2 s budget on
  a huge tree).
- `.gitignore`d files are invisible to the delta. Stated on the receipt.

### 4.5 Worktree isolation strategy (D9: specified now, built in #21)

| Tier | When | How | P1? |
| --- | --- | --- | --- |
| 1. Shared tree + claims | Default for all concurrent lanes | §4.1–§4.4 | **Yes** |
| 2. Serialize | Untenanted tickets, `large` tickets under concurrency > 1, any ticket whose last attempt hit a claim conflict | Scheduler admission (#15 §5.3), using `UNTENANTED` and claim history | **Yes (#15)** |
| 3. Isolated copy per loop | A long unattended loop over independent tickets | Reuse `run-isolation.ts`: the whole loop runs in one worktree window on its own branch, and the user merges the branch | #21 |
| 4. Isolated copy per lane | Large independent jobs needing their own build | Needs the runtime, LSP and Map rooted per lane; integration through `git merge-tree` preview plus conflict report | #21 |

**Conflict reporting in P1:** claim refusals, `contract_conflict` signals, and the work graph's
existing `conflicts_with` edges. The `work_graph conflicts` op already lists them. The loop panel
shows the latest per ticket.

### 4.6 Tests, mapped to the acceptance criteria

All in `tests/unit/claims/`, using a virtual clock and two scripted lanes over a temp workspace
(the `scripted-provider-session` helper).

| AC | Test |
| --- | --- |
| No silent incompatible concurrent writes | Two lanes `file_edit` the same file concurrently. Under `enforce` exactly one write lands and the other is refused, naming the holder. Under `observe` both land and a conflict signal is emitted. |
| Unknown or out-of-contract writes surfaced and halted | A shell script in lane A writes into lane B's claimed file, giving a conflict signal and a `partial` receipt under `enforce`. A shell write outside the contract gives `scope_expanded` with `authorized: false`. |
| Read-only agents not blocked | A read-only profile lane reads a claimed file mid-write: no refusal, no claim taken. |
| Cancellation, crash, timeout release | Abort mid-lane releases claims; a watchdog timeout releases them; a lease expires on the virtual clock and is reaped; a "restart" (new registry) is empty. |
| Overlap, renames, multi-file, stale reads | A rename onto a claimed destination is refused. A directory move over a claimed child conflicts (prefix). A batch with one conflicting path applies nothing. Stale read: A reads, B writes and releases, A's `file_write` is refused and A's `file_edit` with stale anchor text fails with B named. |
| Stress | Seeded property test, 500 random interleavings of 4 holders over 20 paths. Invariants: no path ever has two holders; every completed write was claimed by its writer; every holder's claims are gone after release. Windows case folding pinned with `platform` in path tests. |

Replay: a `loop-concurrent-same-file` trace under `baseline`, `observe` and `claims-enforce`.

### 4.7 Build order

1. `ClaimRegistry` and its property test.
2. Session pre-dispatch claims and the edit/LSP wrappers. Lane wiring and release in
   `_runDelegatedLane`. Main-session version bumps and warning.
3. Stale-read check through `FileFreshnessLedger`.
4. Shell delta, receipt `coverage` and `shellOutOfScope`, enforce → `partial`.
5. Replay trace, flag docs (`approvals-and-safety.md`), CHANGELOG.

---

## 5. #15 — Dependency-aware scheduling and critical-path prioritization

### 5.1 Shape

`computeReadySet` gains two optional inputs. When both are absent the function is
**byte-for-byte today's behaviour**, so `scheduler=legacy` needs no separate code path and every
existing `loop-scheduler.spec.ts` case passes untouched.

```ts
interface SchedulerInputs {
  // …existing…
  graph?: SchedulingGraph;               // present when scheduler != legacy
  held?: ReadonlyMap<string, string>;    // live claims from #19, path → holder label
  passedOver?: ReadonlyMap<string, number>;  // from LoopTicketState, starvation credit
}

/** Built by the host from WorkGraph; pure to consume. */
interface SchedulingGraph {
  hardBlockers(ticketId: string): Array<{ id: string; status: EdgeStatus; source: string }>;
  downstreamOpen(ticketId: string): string[];          // transitive open dependents
  onCriticalPath(ticketId: string): boolean;           // criticalPath("tickets")
  cycleOf(ticketId: string): string[] | undefined;
  waitingInputs(ticketId: string): string[];           // `consumes` edges whose producer is open (#17 hook)
  observedFiles(ticketId: string): string[];           // receipt filesChanged across attempts
}
```

### 5.2 Hard dependencies and incoherence

- **Hard:** open `ticket.blockedBy` (as today) plus `depends_on` edges with status `declared` or
  `verified` (`contract.dependencies`). "Met" follows D6.
- **D6 opt-in, `queue.dependencySatisfiedBy: "closed" | "verified_review"`, default `"closed"`.**
  - **Storage and input:**
    - a new optional field on `LoopQueueSpec` (`loop-model.ts:56`, next to `respectBlockedBy`);
    - normalized in `loop-store.ts:112` (anything but `"verified_review"` reads as `"closed"`);
    - accepted by `loop-tool-provider.ts:43` and `loop-proposal.ts:166`, whose blocked-ticket
      warning should say which rule applies;
    - shown in the loop editor (`apps/loops/protocol.ts:86`).
  - **Evaluation:** `computeReadySet` takes an optional `latestReceipt(ticketId)` port, built
    from the receipt index (subject ticket, newest first).
    - Under `"verified_review"`, a blocker counts as met when it is in `review` and its latest
      receipt is `verified`.
    - Anything else, including `succeeded_unverified`, still blocks.
    - With the port absent, or the field `"closed"`, the check is today's line for line. The
      opt-in works under every `scheduler` mode, `legacy` included, and changes nothing for
      loops that do not set it.
  - **Prerequisite:** receipts exist only with `workContracts` on. With contracts off, the opt-in
    can never be satisfied. The loop editor says so instead of offering a setting that does
    nothing.
  - **Reopening:** a blocker counted as met stays a ticket the user must still close. If they
    reopen it, or a later receipt for it is not `verified`, dependents are blocked again from the
    next scheduling pass. Lanes already running are not stopped. #14 emits `verification_failed`
    for this and raises a reassessment on the loop.
- **Soft:** `inferred` edges (parent → child, step order). These count toward ranking only,
  never toward readiness.
- **Missing dependency** (target does not exist) or **membership in a dependency cycle**: the
  ticket is withheld with a new reason, `incoherent`. The detail names the cycle or the missing
  id. It is never silently dispatched and never silently dropped. AC 3.
- **Waiting input:** a `consumes` edge whose producer is still open withholds the ticket with
  reason `waiting_input`. Today only contract inputs create these edges. #17 will populate them.
- `respectBlockedBy: false` keeps its meaning (the user opted out). It now switches off all
  declared dependencies, not just `blockedBy`. This is stated in the loop's settings text.

### 5.3 Ranking and admission

Score = `rankTickets` score (unchanged) plus bounded graph terms, each with a reason string:

| Term | Value | Reason text |
| --- | --- | --- |
| Unblocks others | `min(40, 8 × downstreamOpen.length)` | "unblocks 4 tickets (BLK-3, BLK-9, …)" |
| Critical path | `+25` | "on the critical path (weight 14)" |
| Starvation credit | `+10 × passedOver` (no cap; reset on dispatch) | "passed over 3 times" |
| Recent conflict | `−30` while the holder of the conflicting claim is still running | "collided with BLK-2's lane" |

- **No starvation.** Graph bonuses are bounded at 65 and the credit is not. A ready ticket passed
  over *k* times outranks any graph-favoured rival once `10k > 65 + priority gap`. The fixture
  asserts this bound.
- **Deterministic tie-break** (graph mode only, so legacy order is untouched): score desc,
  priority, `updatedAt` desc, then **ticket id asc**. Shuffled input gives identical output.
- **Admission** (territory):
  - effective territory = declared ∪ touched ∪ `observedFiles` ∪ paths granted on earlier
    receipts;
  - a ticket is withheld (reason `territory`, detail naming the holder) if it intersects
    in-flight territory, already-admitted territory, or `held` claims from other lanes;
  - unknown territory stays `UNTENANTED` (conservative).
  - Tier 2 serialization (§4.5): a `large` ticket, or one whose last attempt hit a claim conflict,
    is admitted only when nothing else is in flight.
- **Resource availability:** free slots (as today). A lane is not started when the loop's
  remaining USD is below the median spend of this loop's past iterations at the same complexity
  (reason `budget`, needs ≥ 3 samples; otherwise no check). Ceilings themselves are unchanged.

### 5.4 Recorded decisions (AC 2)

- `LoopRecord.decisions?: LoopSchedulingDecision[]`, the last 100. A new entry is written only
  when the decision's fingerprint (chosen ids plus withheld id:reason) changes, so a waiting
  loop does not churn the file.

  ```ts
  interface LoopSchedulingDecision {
    at: string; mode: "graph" | "shadow";
    chosen: Array<{ ticketId: string; score: number; reasons: string[] }>;
    withheld: Array<{ ticketId: string; reason: string; detail: string }>;
    /** shadow only: what graph mode would have dispatched instead. */
    wouldChoose?: string[];
    signalIds?: string[];   // the #14 wake that triggered this pass, when there was one
  }
  ```

- `LoopIteration.scheduledBecause?: string[]`: the reasons at dispatch.
- `LoopTicketState.passedOver?: number`.
- Older builds rewriting `loops.json` drop these fields. They are history, not state, and the
  only loss is the explanation.
- **UI:**
  - The loop panel shows "Picked because …" on each iteration.
  - Withheld tickets show their reason. `incoherent`, `waiting_input` and `budget` get labels and
    tooltips (`apps/loops`; `test:browser`).

### 5.5 Flag behaviour

| `scheduler` | Dispatches by | Records |
| --- | --- | --- |
| `legacy` | today's order | nothing new |
| `shadow` | today's order | decisions with `wouldChoose`; the scorecard counts divergences. Must equal `legacy` in replays once `decisions` are stripped. |
| `graph` | §5.2–§5.3 | decisions |

With `workGraph` off, `graph`/`shadow` fall back to `legacy` and say so once in the loop's
activity. The graph is the input, so the flag dependency is explicit in the registry note.

### 5.6 Tests, mapped to the acceptance criteria

| AC | Test |
| --- | --- |
| Never runs with unmet hard deps | Property test: 300 seeded random DAGs (with injected cycles and dangling ids), random closures between passes. No dispatched ticket ever has an open hard blocker, and every cycle member and dangling dependent is withheld `incoherent`. The same property runs under `dependencySatisfiedBy: "verified_review"`, where "met" means closed, or in review with a `verified` latest receipt. A blocker in review with `succeeded_unverified`, `partial` or no receipt never counts as met. |
| Durable reasons, deterministic ties | Spec: every `chosen` entry has ≥ 1 reason; the same inputs shuffled 20 times give an identical decision; the decision persists through a `LoopStore` round-trip. |
| Cyclic or missing deps visible | Spec plus replay `loop-dependency-cycle`: the loop settles `blocked` with `blockedOn: "mixed"`, and the panel shows the cycle. |
| Critical blocker first, without starvation | Workload fixtures in `tests/eval/workloads/`: (a) a 6-long chain plus 20 small independents, concurrency 2: the chain head is dispatched first and makespan drops versus legacy (reported, not asserted as a number); (b) a constant stream of high-bonus tickets plus one low ticket: the low ticket is dispatched within the computed bound. |
| Legacy tests pass | The existing `loop-scheduler.spec.ts` and `loop-supervisor.spec.ts` are unchanged. Every golden replay at `baseline` is unchanged. |

### 5.7 Build order

1. `SchedulingGraph` adapter over `WorkGraph` (host), plus `incoherent` and `waiting_input`.
   D6's `dependencySatisfiedBy` with the `latestReceipt` port, store and tool plumbing, and the
   loop editor control.
2. Graph ranking, tie-break and starvation credit, with property tests.
3. Admission with `held` claims (#19), observed files and Tier 2 serialization. Budget check.
4. Decisions, `scheduledBecause`, shadow mode. Loop panel explanations.
5. Workload fixtures, replay arms (`scheduler-graph`), docs (`ticket-loops-design.md`),
   CHANGELOG.

---

## 6. Running #14 and #19 in parallel

| Owned by #14 | Owned by #19 | Touched by both (expect a trivial rebase) |
| --- | --- | --- |
| `src/orchestration/signals/*` | `src/orchestration/claims/*` | `src/extension.ts`: #14 builds `SignalService`, #19 builds `ClaimRegistry` and passes `NULL_SINK` until #14 merges |
| `loops/loop-supervisor.ts` (wake, `blockedOn`), `loop-model.ts`, `loop-store.ts` normalizer | `agent-session.ts` (claims option, stale-read check), `file-freshness.ts` | `chat-provider.ts`: #14 adds the watchdog → signal hook (`:2501`); #19 adds holder plus release in `_runDelegatedLane` and the shell delta |
| `plans/plan-run-service.ts` (`onEvent`, reassessment), `plan-run-model.ts` | `orchestration/work-receipt.ts` (`coverage`, `shellOutOfScope`, enforce → `partial`) | `orchestration/lane-contracts.ts`: #14 adds `onIssued`; #19 reads the active contract |
| `webview/react/apps/loops/*` (reassessments) | `docs/guide/approvals-and-safety.md` | `CHANGELOG.md`, `package.json` (already done in Phase 0) |

Rules (as in P0):

- Replays drive services only through public constructors and methods.
- Whichever merges second runs the other's tests first.
- Once #14 merges, #19 swaps `NULL_SINK` for the real sink. That is one line in `extension.ts`
  plus a replay golden update for `claims-enforce`.

#15 starts after both merge. It touches `loop-scheduler.ts` (owned by neither track),
`loop-supervisor.ts` (pass `graph`, `held`, `passedOver`; record decisions), and the loop
panel.

---

## 7. Release plan

- **One prerelease per track** keeps each change bisectable and each flag's risk separate:
  - 1.33.0-pre.5: Phase 0 + #14
  - 1.33.0-pre.6: #19
  - 1.33.0-pre.7: #15
  - If the parallel tracks finish together, pre.5 can carry both.
- All flags ship at baseline.
- The live suite (Step 0) gets a `signals-act + claims-enforce + scheduler-graph` arm before any
  default changes. That arm decides the defaults, and the owner makes the call.

---

## 8. Risks and open questions

| Risk | Mitigation |
| --- | --- |
| Feedback loops (signal → consumer → change → signal). | Reconciliation-caused changes carry `reconcile:` causes and are not re-derived. Spec asserts a fixed point after one pass. |
| Signals add noise and the journal grows. | Deterministic ids, coalescing, latching, rotation, a 30-day prune. `off` writes nothing. |
| Claims refuse too often: two lanes editing different functions in one shared file (an `index.ts` barrel). | Ship `observe` first and count would-refusals in the scorecard. Refusals name the holder so the lane can work around it. Claims end with the lane. Line-range claims are a later refinement only if the numbers demand it. |
| Lease too short for a lane that thinks for a long time. | Any tool call renews. 15-minute idle lease, 2-hour cap. |
| Shell-delta cost on 20k-file trees (harness direction: design for large nested repos). | 2 s budget per delta, else `coverage: "tool_edits"`. Runs only for lanes and only with claims on. |
| Concurrent shell commands cannot be attributed. | Marked `unattributed` on both receipts. Never guessed. |
| Graph scoring makes ranking feel arbitrary. | Every term carries a reason string; decisions are recorded; `shadow` first, and divergences are reviewed before `graph` ships. |
| Resume offers pile up or go stale. | One offer per loop, withdrawn when the loop is resumed, stopped or deleted, or when a re-check finds nothing ready. Signals never start a loop (D5). |
| `verified_review` lets dependents build on work a human later rejects (D6). | Opt-in per loop. Only a `verified` receipt counts. Reopening the blocker or a non-verified receipt re-blocks dependents and raises a reassessment. Closure stays human-only. |
| Linux-only path failures. | Pin `platform` in every path and case-folding test. Push `main` and watch ubuntu CI before tagging. |

Owner decisions (2026-10-16):

1. **D5: no.** Signals never start or resume a loop. A running loop re-schedules immediately; a
   self-blocked loop gets a "can continue" offer, and the user resumes it.
2. **D6: yes.** `dependencySatisfiedBy: "verified_review"` is available per loop, opt-in, and
   defaults to `"closed"`.
3. **D8: warning.** A main-session write into a lane-held file proceeds with a warning that names
   the lane.
4. **D9: deferred.** Worktrees per loop and per lane are #21. P1 ships shared-tree claims,
   serialization and conflict reporting.

Still open: when to change any default. That waits for Step 0 and the combined live arm (§7).

---

## 9. Verification gate (every phase)

From CONTRIBUTING:

- `npm run lint`, `compile`, `typecheck:webview`, `test:coverage`, `security`, `build`;
- `npm run test:eval:replay`: every arm deterministic ×3, golden match, shadow parity;
- `npm run test:browser` where the loop panel changed.

Timed tests (signal storms, the claims stress test, scheduler property tests at scale) live in
the eval suite, not under coverage. Coverage is about 5× slower (P0 lesson). Rerun a single
git-heavy spec alone before treating a timeout under coverage as real.
