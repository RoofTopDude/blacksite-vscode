# Orchestration 2.0 — P0 Foundations: Work Contracts, Evaluation Baseline, Work Graph

Status: **shipped in 1.33.0-pre.4** (live evaluation not yet run) · Issues: [#11](https://github.com/RoofTopDude/blacksite-vscode/issues/11), [#13](https://github.com/RoofTopDude/blacksite-vscode/issues/13), then [#12](https://github.com/RoofTopDude/blacksite-vscode/issues/12) · Epic: [#10](https://github.com/RoofTopDude/blacksite-vscode/issues/10)

Companion docs: [`ticket-loops-design.md`](./ticket-loops-design.md), [`execution-runs.md`](./execution-runs.md), [`agent-environment.md`](./agent-environment.md), [`codebase-map.md`](./codebase-map.md), [`../tests/eval/README.md`](../tests/eval/README.md)

Prepared 2026-10-15 from a reading of the current code, for whoever implements it. Line
references are to `main` at 1.33.0-pre.3 (`ac38fe5`). Re-read each file before editing.

## Progress log

Implemented 2026-10-16 and released as prerelease 1.33.0-pre.4. Commits: `b704ee6` (Phase 0
and #11), `6dc8fa7` (#13), `d21f0cb` (#12). Deviations from the plan text below are called out.

| Part | State | Notes |
| --- | --- | --- |
| Phase 0 | Done | `src/orchestration/flags.ts` registers both flags (`workContracts`, `workGraph`) with a baseline, an optional shadow value, and a rollback note. `LoopStore` and `LoopSupervisor` take an injected `now` and `newId`. **Deviation:** landed in the same commit as #11, not ahead of it on its own. |
| #11 contracts and receipts | Done | See the breakdown below this table. |
| #13 evaluation | Done | `tests/eval/`: 14 synthetic traces (7 loop, 7 plan run) cover crash, retry, park, halt, budget, conflict, false completion, provider outage, deferred decisions and tripwires. They replay through the real services on a virtual clock under the baseline, observe and enforce arms. Each replay runs three times and must be byte-identical and match its golden file. `observe` must equal `baseline` once contract records are removed. `replay/outcomes.spec.ts` asserts what each scenario means. CI step "Orchestration replay baseline" uploads the scorecard. The flag-registry check and the sanitization check are in place. **Live suite:** `npm run eval:live` (launcher, env-gated `blacksite.eval.runScenario`, `delegation-fanout` and `cross-module-refactor` fixtures, verifiers checked to fail when untouched and pass when solved by hand). **Not run against a real model.** No live baseline exists yet. |
| Convergence (§6) | Done for replays | Every scenario replays under observe and enforce. The scorecard counts receipt-versus-verifier agreement. `loop-territory-overlap` has a deliberate disagreement, and `loop-false-completion` shows enforce cutting false completions from 1 to 0 without losing a verified success. The live comparison awaits the first live run. |
| #12 work graph | Done | See the breakdown below this table. |

**#11 contracts and receipts, in detail:**

- **Contracts and receipts:** `work-contract.ts` validates strictly and handles `narrowContract` and migration. `work-receipt.ts` derives status only from host facts. `contract-mapping.ts`, `contract-scope.ts` and `receipt-store.ts` follow §3.1.
- **Lane lifecycle:** `active-contract.ts` holds the shared grant state and wraps the edit and LSP providers. `lane-contracts.ts` covers issue, spend meter, receipt, plan-step receipts and abandoned receipts.
- **Where the scope check runs:** in `AgentSession` before dispatch, and again in the edit/LSP wrapper on the paths an edit actually touches.
- **Loops:** loop lanes get ticket contracts. Under `enforce`, the receipt decides the outcome. A restart writes an `abandoned` receipt.
- **Deviation (D2, owner's decision):** a scope gate can be granted. See D2 below.
- **Deviation (check history):** check history is kept on the session (`_contractChecks`), not added to the persisted `VerificationGateState`.
- **Deviation (observe-mode scope):** out-of-territory writes are advisory under an observing contract (`scopeAdvisory`). They are listed on the receipt but do not fail it, because nothing gated them. Main-thread plan steps are always observe.
- **Not done:** the `git status` delta for lanes. Receipts report `coverage: "tool_edits"`, so writes a shell command makes outside the territory are only caught when a snapshot exists.

**#12 work graph, in detail:**

- **Modules:** `src/orchestration/work-graph/` contains `model.ts`, `build.ts` (one partition per ticket, plan or receipt), `graph.ts` and `service.ts`.
- **Incremental updates:** both partitions and read indexes update incrementally. A seeded test of 150 random edits checks that incremental always equals a full rebuild.
- **Read-time resolution:** missing and stale are resolved when the graph is read. Findings cover cycles, missing references, stale evidence, incompatible or superseded inputs, healed ticket links (new `TicketLinkFinding` from `normalizeTicketDocument`) and observed conflicts.
- **Queries and tool:** host queries, plus the `work_graph` tool, offered only while the flag is on.
- **Scale:** 38k nodes and 78k edges: cold ~0.3 s, one-ticket update ~20 ms (median), critical path ~0.1 s. **Deviation:** the timed test lives in the eval suite, because coverage instrumentation slows it about 5×.
- **Not done:** inferred `informed_by` from inputs that were actually read (needs #17), and any UI (#24).

### Verification (2026-10-16)

The full gate passed locally on Windows; it is recorded in the release commit. Not verified:

- a live run against a real provider;
- the enforce mode in a real VS Code window.

Unit and integration tests drive `AgentSession`, the loop engine and plan runs, but no real lane has run under a contract yet.

Order: **Phase 0** (a small shared seam on `main`), then **#11 and #13 in parallel**, then a
short **convergence** step, then **#12**.

```
Phase 0 ──┬── #11 Work Contracts + Receipts ──┐
(flags,   │                                   ├── Convergence ── #12 Work Graph
 seams)   └── #13 Replay + Scorecard + Live ──┘   (receipt arms,
                                                   flag parity)
```

---

## 0. Intent and decisions already made

The epic asks for better delegation, scheduling and verification. It must not replace the
runtime or weaken approvals. P0 lays three foundations:

- **#11** gives delegated work a bounded, versioned contract and returns a receipt built from
  what the host observed, not from what the model says.
- **#13** measures today's behaviour before anything changes, so each later addition can be
  compared against it.
- **#12** derives one read-only graph across tickets, plans, code, runs and receipts. It does
  not become another source of truth.

These are recommended defaults. The ones marked **(confirm)** are product calls for the owner.

| # | Decision | Why |
| --- | --- | --- |
| D1 **(confirm)** | `blacksite.orchestration.workContracts` takes `off \| observe \| enforce`, default `off`. `observe` writes contracts and receipts but changes no behaviour. `enforce` adds scope gates and lets receipts decide outcomes. | `observe` is a shadow mode: it can be compared with `off` for exact parity (#13) before anything is enforced. It is also the rollback path. |
| D2 **(decided 2026-10-16: grantable)** | Writing outside a contract's territory is an ordinary gate with tier `scope`. Whoever decides the lane's approvals can grant it: the user, the Auto-mode reviewer, or a loop's continuation reviewer. "Allow all" covers it for the rest of the turn. An unattended refusal parks the ticket. Every grant is listed on the receipt. | The owner chose this over the human-only version first proposed. The agent is already over-constrained, and a visible, recorded grant keeps scope widening auditable without stopping unattended work. |
| D3 | Contracts are validated **strictly**: unknown keys, wrong types, out-of-range budgets and paths outside the workspace are rejected. | The stores normalize tolerantly on purpose (a rejected ticket is a ticket not filed). A contract is an authorization boundary, so it must fail closed instead. |
| D4 | No new `LoopIterationOutcome` values. Receipt status goes in a separate optional field. | `loop-store.ts:230` normalizes unknown outcomes to `"failed"`. An older build reading a newer `loops.json` would turn every new value into a failure and trip the consecutive-failure ceiling. |
| D5 | Receipts point at their subjects (ticket, step, lane, run). Stores gain at most an id reference. The Work Graph is derived and never written back. | #12 forbids duplicating sources of truth, and tickets already keep only `runIds` for Execution Runs. |
| D6 | In evaluations, the ground truth is an **independent verifier** that the harness runs after the agent finishes. It is never the receipt and never the agent's own report. | Otherwise #13 would measure #11 with #11's own instrument. |
| D7 | Live evaluations run the real extension in a VS Code Extension Development Host. There is no headless copy of the lane runner. | A headless re-implementation of `_runDelegatedLane` would be the "parallel agent loop" the guardrails forbid. It would also measure the copy, not the product. |

**Non-goals for P0:** scheduling changes (#15), new conductor behaviour (#16), artifact
exchange between agents (#17), UI beyond notes and tool results (#24), and enforcing
territory for shell commands before they run (see §3.5).

---

## 1. What exists today

| Area | Where | What P0 builds on |
| --- | --- | --- |
| Lane input | `agent-session.ts:568` `SubagentSpawnInput` | task, context, complexity, label, profileId, optional plan step link. No scope, no outputs. |
| Lane results | `agent-session.ts:595` / `:627` | Success = answer + budget. Failure = rich forensics (`failureKind`, `filesTouched`, trace, `nextStep`). No verification facts. |
| Lane runner | `chat-provider.ts:2569` `_runDelegatedLane` | Builds the child `AgentSession`, watchdog, headless approval policy, loop edit/LSP providers. |
| Lane budgets | `chat/subagent-lanes.ts:84` `resolveSubagentBudget` | Budgets come from complexity tiers. There is no USD ceiling per lane. |
| Host-side refusal seam | `agent-session.ts:3225` `_toolValidationError` (plan mode at `:3238`) | The place to refuse a call before it runs. `plan-mode-policy.ts` is the precedent. |
| Approval gate | `agent-session.ts:3341` `_approvalGate`; `approval-scope.ts` | Grant keys per category and tier. Reviewer first, then human. |
| Step ↔ lane sync | `agent-session.ts:2265` / `:2293` | Marks a linked step in_progress or blocked. A successful lane only adds a note. |
| Lane folding | `loops/loop-dispatcher.ts` `foldLaneStream`, `loopApprovalPolicy:77`, `buildTicketTask:141` | Ticket → lane prompt. Lane events → `LoopDispatchResult`. `filesTouched` comes from edit diffs. |
| Loop engine | `loops/loop-supervisor.ts` (`restore:153`, `_launch:303`, `_record:383`) | Injected dispatcher, gateway and clock. Ids still use `Math.random` (`:343`, `loop-store.ts:456`, `:522`). |
| Plan runs | `plans/plan-run-service.ts` (`PlanRunHost` at `:69`), `plan-run-model.ts:248` `PlanRunEvent` | An event-sourced ledger with `now`/`newId` already injectable. `StepEvidence` lives in `plan-run-view.ts`. |
| Territory helpers | `plans/run-tripwires.ts:61` `territoryAreas`, `:50` `ALWAYS_IN_BOUNDS`; `loops/loop-scheduler.ts` `territoryOf` | Reuse these. Do not write new path rules. |
| Verification | `agent/verification-ledger.ts`, `agent/verification-commands.ts` | Per-file pending/passed/failed/unchecked. Keeps only the last `method`; there is no check history. |
| Tickets | `ticket-store.ts` (v3) | `blockedBy` is informational. Two-cycles are dropped at write time (`:1177`). `reconcileLinks:534` heals on read. |
| Plans | `planning-store.ts` (v3) | `phase.dependsOn` and `phase.files` are informational. Steps have no dependencies. |
| Map | `graph-agent-gateway.ts` (repo root, **not** `src/graph/` as #12 says), `graph/map-queries.ts`, `graph/run-footprints.ts` | Node index, impact traversal, and which runs touched which files. |
| Feature-flag precedent | `package.json:1132` `blacksite.planContinuation.enabled` | A boolean setting read through `getConfiguration`. |
| Test harnesses | `tests/unit/helpers/scripted-provider-session.ts`, `plan-run-service.spec.ts` (in-memory host), `loop-supervisor.spec.ts`, `tests/unit/soak/`, `tests/integration/lsp/run.mjs` | A scripted model, fake hosts and real-VS-Code launching already exist. |
| CI | `.github/workflows/ci.yml` | lint → compile → webview typecheck → `test:coverage` → security → build → llm package → browser. |

---

## 2. Phase 0 — shared seam (land on `main` before branching)

This is small: about one commit. Doing it first means the two parallel branches never edit the
same lines.

1. **`src/orchestration/flags.ts`** is pure, with no `vscode` import.
   - `ORCHESTRATION_FLAGS`: a registry of `{ id, setting, values, baseline, issue, rollback }`.
     Every later orchestrator addition (#12, #14 to #25) registers here. The #13 checks in §4.6
     iterate this registry.
   - `readOrchestrationFlags(get: (key: string) => unknown): OrchestrationFlags`. Unknown or
     invalid values resolve to the baseline. A bad setting falls back to today's behaviour.
   - The first entry is `workContracts` (`off | observe | enforce`, baseline `off`, issue 11).
2. **`package.json`**: declare `blacksite.orchestration.workContracts` (enum, default `off`,
   marked experimental in the description). It does nothing until #11 lands.
3. **Determinism seams.** No behaviour changes; defaults stay as they are.
   - `LoopStore` and `LoopSupervisor` accept optional `newId(prefix)` and `now()`. They are
     used at `loop-store.ts:456`, `:522` and `loop-supervisor.ts:343`, and wherever `LoopStore`
     calls `nowIso()`.
4. **Tests**:
   - `orchestration-flags.spec.ts` covers parsing, the fallback to baseline, and the registry
     shape.
   - Extend `loop-store.spec.ts` / `loop-supervisor.spec.ts` to assert that the injected
     ids and clock are used.
5. Add this document.

Gate: the CONTRIBUTING checks (§9). Then cut two branches or worktrees from this commit:
`orch/11-work-contracts` and `orch/13-eval-baseline`.

---

## 3. #11 — Typed Work Contracts and Outcome Receipts

### 3.1 Module layout (new, pure unless noted)

```
src/orchestration/
  flags.ts                  (Phase 0)
  work-contract.ts          WorkContract v1 types, validateWorkContract, migrateWorkContract, narrowContract
  work-receipt.ts           WorkReceipt v1 types, deriveReceiptStatus, validate/migrate
  contract-mapping.ts       contractFromTicket / contractFromPlanStep / contractFromSpawn
  contract-scope.ts         mutationTargets(tool, runtimeType, payload), scopeCheck(contract, …)
  contract-edit-provider.ts createContractEditProvider(inner, scope, onGate)   (wraps EditProvider/LspProvider)
  receipt-store.ts          .blacksite/orchestration/{contracts,receipts}/ + index.json (fs, no vscode)
```

### 3.2 `WorkContract` v1

```ts
interface WorkContractV1 {
  schema: 1;
  id: string;                                // "wc_…", issued by the host only
  issuedBy: "host";                          // models propose; the host issues
  enforcement: "observe" | "enforce";
  origin: {
    kind: "ticket" | "plan_step" | "subagent";
    ticketId?: string; loopId?: string;
    planId?: string; phaseId?: string; stepId?: string;
    parentContractId?: string;
  };
  objective: string;                         // ≤ 2,000 chars
  dependencies: WorkRef[];                   // { kind: "ticket"|"plan_step"|"contract"|"receipt", id }
  inputs: ArtifactRef[];                     // { kind: "file"|"plan_doc"|"run"|"artifact"|"receipt", id, sha256? }
  outputs: ExpectedOutput[];                 // { kind: "file_change"|"artifact"|"answer"|"test", ref?, description }
  territory: {
    writable: PathScope;                     // { files: string[]; areas: string[] }, workspace-relative
    readable: PathScope | "workspace";       // default "workspace"; recorded, enforced only if narrowed
    source: "declared" | "undeclared";       // undeclared = the origin named no territory
  };
  acceptance: string[];                      // verbatim criteria, ≤ 20 × 300 chars (ticket caps)
  verification: {
    required: boolean;                       // true when the contract expects file changes
    expectations: Array<{ kind: "covering_check" } | { kind: "command"; match: string }>;
  };
  budget: { maxToolRounds: number; maxRuntimeSeconds: number; idleTimeoutSeconds: number; maxUsd?: number };
  escalation: { onOutOfScope: "gate"; onGate: "park" | "wait" | "defer"; onBudget: "stop" };
  createdAt: string;
}
```

Rules:

- **Validation is strict** (D3). `validateWorkContract(raw)` returns `{ ok: true, contract }` or
  `{ ok: false, errors: string[] }`. It rejects:
  - unknown keys at any level;
  - a missing or empty `objective`;
  - non-finite, negative or zero budgets;
  - paths that are absolute, contain `..`, use a drive letter, or are empty;
  - an area of `""`, `"."` or `"/"` in `writable`;
  - anything over the caps;
  - `schema` above the supported version ("written by a newer Blacksite").
- **Contracts are immutable once issued.** A ticket or plan edit made mid-lane does not change
  the lane's contract. Widening it means issuing a new contract from user-authored sources.
- **`narrowContract(base, proposal)`** is the only way a model-proposed contract becomes real
  (from the `contract` argument of `subagent_spawn`, §3.5). Each field must be a subset of the
  base:
  - writable territory ⊆ base writable;
  - budget ≤ base budget and ≤ the complexity tier's ceiling;
  - outputs and acceptance may be **added**;
  - `enforcement` can never go from `enforce` to `observe`.
  Anything wider is **rejected with the excess listed**. It is never silently clamped. The
  model can retry with a narrower contract, and an expansion it asked for cannot pass through.

### 3.3 `WorkReceipt` v1

```ts
interface WorkReceiptV1 {
  schema: 1;
  id: string; contractId: string; contractSchema: number;
  subject: { laneId?; subRequestId?; loopId?; iterationSeq?; planRunId?; ticketId?; planId?; phaseId?; stepId? };
  status: "verified" | "succeeded_unverified" | "partial" | "blocked" | "failed" | "cancelled" | "abandoned";
  basis: string[];                           // machine-readable reasons, e.g. "checks_cover_all_changes"
  observed: {
    filesChanged: Array<{ path: string; change: "A" | "M" | "D" | "R"; sha256?: string; sizeBytes?: number }>;
    coverage: "tool_edits" | "tool_edits+snapshot" | "none";   // honest about what could be missed
    outOfScope: string[];                    // observed writes outside writable territory
    refused: Array<{ toolName: string; reason: string }>;      // calls stopped before they ran
  };
  evidence: Array<
    | { kind: "check"; method: string; passed: string[]; failed: string[]; at: string }
    | { kind: "diagnostics"; errors: number; warnings: number }
    | { kind: "run"; runId: string }
    | { kind: "artifact"; sha256: string; label?: string }>;
  verification: { required: boolean; result: "passed" | "failed" | "not_run" | "not_applicable"; uncovered: string[] };
  usage: { usd?: number; spendPartial: boolean; toolRounds: number; elapsedMs: number; budgetHit?: "rounds" | "runtime" | "idle" | "usd" };
  blocked?: { gate: string; detail: string; whatWouldUnblock?: string };
  failure?: { kind: "timeout" | "no_answer" | "error" | "verification_failed" | "scope_violation" | "contract_invalid"; detail: string };
  selfReport: { answerExcerpt: string };     // kept apart from everything above; never read by deriveReceiptStatus
  next: { guidance: string; retryable: boolean };
  createdAt: string;
}
```

`deriveReceiptStatus(facts)` is pure and takes **only host-observed facts**. The first matching
row wins:

| # | Condition | Status | Notes |
| --- | --- | --- | --- |
| 1 | The user stopped it, or the parent cancelled | `cancelled` | Not charged as an attempt (matches `_record` today). |
| 2 | The host died mid-lane (written by `restore()`) | `abandoned` | `coverage: "none"`. |
| 3 | A gate was refused, parked or deferred | `blocked` | `blocked.gate` carries the tier, including `scope`. |
| 4 | Observed `outOfScope` is non-empty | `failed` | `scope_violation`, not retryable. A person must look at the changes. |
| 5 | A covering check failed on a changed file | `failed` | `verification_failed`. |
| 6 | Lane error/no_answer, or timeout, **with** changes or a partial answer | `partial` | |
| 7 | Lane error/no_answer **without** changes | `failed` | |
| 8 | Lane ok, a declared output is missing (e.g. a named file is unchanged or absent) | `partial` | |
| 9 | Lane ok, verification required, every changed file covered by a passing check | `verified` | Only here. |
| 10 | Lane ok, anything else (no check, uncovered files, research-only answer) | `succeeded_unverified` | **No evidence never means verified.** |

`sha256` per changed file is recorded at receipt time: up to 200 files, and only files under
2 MB. #12 uses it to tell when a `verified_by` relation has gone stale. Add it now so the
receipt schema does not have to change later.

### 3.4 Mapping existing work into contracts (`contract-mapping.ts`)

| Source | Objective | Writable territory | Acceptance / verification | Budget |
| --- | --- | --- | --- | --- |
| Ticket in a loop | `buildTicketTask` text (title + description) | `ticket.territory` files + areas. Empty means `source: "undeclared"`, writable = whole workspace. | `ticket.acceptanceCriteria`; `required` = true | Complexity tier from `laneComplexityFor`; `maxUsd` = the loop's remaining `maxUsd` |
| Plan step (linked lane, or a plan-run step) | step title + detail | `territoryAreas(phase.files)` (the tripwire rule, so a declared file stands for its folder). No files means undeclared. | `step.acceptanceCriteria` + `phase.acceptanceCriteria` | Tier; the run's remaining `charter.maxUsd` |
| `subagent_spawn` with no link | task text | The parent's active contract if it has one, otherwise undeclared | none; `required` = true only once changes are observed | Tier |

An **undeclared** territory is enforced as "anywhere in the workspace". That is today's
behaviour, so contracts never make an untenanted ticket harder to work. The receipt still lists
what changed, and #12 can show it as an undeclared `modifies` relation.

### 3.5 Enforcement at host boundaries

Every check is made by the host. None asks the model to stay in scope.

1. **Before dispatch.** A new `AgentSession` option is `workContract?: { contract; mode }`. In
   `_toolValidationError` (`agent-session.ts:3225`), right after the plan-mode refusal,
   `scopeCheck(contract, tc.name, runtimeType, payload)`:
   - finds target paths with `mutationTargets`. That covers the file group of
     `PLAN_MODE_WITHHELD`: `file_edit`, `file_edit_batch`, `json_edit`, `file_write`,
     `file_delete`, `file_move` (source **and** destination), `file_copy` (destination),
     `file_mkdir`, `code_insert`, `code_replace`, `code_replace_batch`, `skill_write`,
     `worktree_op`;
   - lets paths inside `writable`, scratch paths (`isScratchPath`) and `ALWAYS_IN_BOUNDS`
     lockfiles through;
   - for anything else, in `enforce` mode, raises a **scope gate**: a new `ApprovalCategory
     "scope"` with tier `"scope"` through `_approvalGate`. In `observe` mode it only records
     the event.
2. **At the edit applier.** `code_rename`, `code_actions` and `code_format` produce a
   `WorkspaceEdit` whose files the input does not name. `createContractEditProvider` wraps the
   lane's `EditProvider`/`LspProvider` in the same way `createLoopEditProvider` does now, so the
   real file set is checked. It is installed in `_runDelegatedLane` (`chat-provider.ts:2569`).
3. **What answers a scope gate (D2).**
   - **Grants:** `approvalGrantKey` never stores a grant for `scope`. "Allow all" acts as allow
     once.
   - **Loops:** `loopApprovalPolicy` short-circuits tier `scope` to deny/park **without
     calling the reviewer**. The ticket is blocked with the paths it wanted, and the user
     releases it after widening the ticket's territory.
   - **Plan runs:** `run-gate.ts` treats `scope` like the untrusted floor: there is no charter
     match and no reviewer. Under `whenBlocked: "defer"` it becomes a queued decision.
   - **Interactive chat lanes:** the user is asked "*<lane>* wants to write outside its
     contract: *paths*".
4. **Budgets.** The contract budget is an upper bound on `resolveSubagentBudget`. `maxUsd` adds
   a third watchdog reason, `LANE_BUDGET_REASON`, fed by the per-lane usage cost that
   `estimateUsageCostUsd` already computes for loops.
5. **Requests that fail closed.** Each is a tool error, and no lane starts:
   - a `contract` argument on `subagent_spawn` (a new optional object parameter in
     `tools/definitions.ts`) that fails `validateWorkContract` or `narrowContract`;
   - `complexity` or budget above the tier ceiling or the parent's remaining budget;
   - `subagent_followup` on a contract lane that asks for more than the contract's budget;
   - unknown keys such as `permissions`, `allow`, `approve` or `autoApprove`.
6. **Known gap, stated plainly.** A shell command can write anywhere, and its targets cannot be
   known before it runs. Contract lanes keep today's command gate. Writes a command makes outside
   the territory are found **afterwards**: by step snapshots in plan runs, and by a `git status`
   delta for lanes when nothing else is writing at the same time. They become a `scope_violation`
   receipt. When neither source is available, the receipt says `coverage: "tool_edits"` instead
   of claiming completeness.

### 3.6 Producing receipts

| Producer | Where | What happens |
| --- | --- | --- |
| Delegated lane | `_runDelegatedLane` end | Collects the lane's edit diffs, a `verificationSnapshot()` from the child session, usage, refusals and gates. Then `deriveReceiptStatus`, `ReceiptStore.put`. The `subagent_tool_result` carries a short `receipt` summary (`id`, `status`, `uncovered`, `next`) in both result types, so the parent model sees it too. |
| Loop lane | `SubagentLoopDispatcher.dispatch` / `foldLaneStream` | Issues the ticket's contract on `SubagentSpawnRequest.contract`. This is a **host** field, separate from the model's `input.contract`. `LoopDispatchResult` gains `receipt?`. |
| Loop record | `LoopSupervisor._record` (`:383`) | `LoopIteration` gains `contractId?`, `receiptId?`, `receiptStatus?`. **In `observe` mode the outcome logic is unchanged.** In `enforce` mode: `verified` / `succeeded_unverified` → `succeeded` (the review note opens with "Verified by …" or "Not verified: …"); `partial` / `failed` → `failed`; `blocked` → `parked`; `cancelled` / `abandoned` → `abandoned` (D4). |
| Crash | `LoopSupervisor.restore` (`:153`) | Writes an `abandoned` receipt for every open iteration that has a `contractId`. |
| Plan step, main thread | `PlanRunService` on `step_completed` | `enforcement: "observe"` only: the main agent is not a bounded delegate. Built from `StepEvidence` and the snapshot comparison the tripwires already make. Adds `PlanRunEvent { type: "receipt", phaseId, stepId, receiptId, status }`, and an optional `StepEvidence.receiptIds`. |
| Linked lane → step | `_syncSubagentStepEnd` (`:2293`) | The step note includes the receipt status. Behaviour is otherwise unchanged: a successful lane still does not mark the step done. |

Supporting change: `VerificationGateState` (`session-state.ts`) gains an optional bounded
`checks: Array<{ method; passed; failed; at }>` history. This is additive; `recordCheck` appends
to it.

### 3.7 Persistence, versioning, migration

- Files:
  - `.blacksite/orchestration/contracts/<id>.json`, written at issue time, so a crash still
    leaves a record of what was authorized;
  - `.blacksite/orchestration/receipts/<id>.json`;
  - `receipts/index.json` (id, contractId, subject, status, createdAt), rebuilt from the files
    if it is missing.
  - All are written with `atomicWriteJson`. `.blacksite/` is already gitignored.
- Retention follows `blacksite.planRuns.retentionDays` with a hard cap (2,000 receipts). Receipts
  still referenced by an open loop or plan run are kept.
- Migration: `migrateWorkContract` / `migrateWorkReceipt` walk a `{ [fromVersion]: fn }` chain.
  - A contract with a schema newer than supported is **rejected**, because it is an
    authorization.
  - A newer receipt loads as an opaque record that can never count as `verified`.
- All schemas stay as they are: loops v1, plan runs 1, planning v3, tickets v3. Every new field
  is optional, following the stores' additive discipline.

### 3.8 Flag behaviour

| `workContracts` | Contracts / receipts written | Scope gates | Outcomes driven by receipts |
| --- | --- | --- | --- |
| `off` | no | no | no. The code path is the same as today. |
| `observe` | yes | recorded only | no |
| `enforce` | yes | yes | yes (loops); plan-run steps stay `observe` |

Rollback is setting `off`. Data written under `observe` or `enforce` stays on disk, and nothing
reads it.

### 3.9 Tests, mapped to the acceptance criteria

| AC | Specs |
| --- | --- |
| Validated with schema versions; compatibility and migration | `work-contract.spec.ts`: v1 round-trip; a newer schema rejected; a migration chain with a synthetic test-only v0→v1 step. `work-receipt.spec.ts`: a newer receipt is opaque and never verified. Loading **pre-#11 fixtures** of `loops.json`, `plan-runs/*/run.json`, `planning.json` and `tickets.json` under each flag value. |
| Bounded, durable receipts without parsing transcripts | `receipt-store.spec.ts`: put, index rebuild, retention, crash, abandoned. `loop-dispatcher.spec.ts`: a receipt from lane events only. `agent-session.subagent-contract.spec.ts` (ScriptedProviderSession): the receipt is built from tool events and the verification ledger. |
| Distinct outcomes; no evidence never means success | `work-receipt.spec.ts`: one table test per row of §3.3. Includes "lane says 'all tests pass', no check ran → `succeeded_unverified`" and "lane ok, covering check failed → `failed`". |
| Malformed contracts and expansions fail closed | `contract-scope.spec.ts` and `agent-session.subagent-contract.spec.ts`: each case in §3.5.5 refuses and no lane is spawned. A write outside the territory is refused before dispatch (`enforce`) and only recorded (`observe`). The loop policy never calls the reviewer for `scope`. "Allow all" does not persist a scope grant. A mid-lane ticket edit does not widen the contract. Out-of-territory writes from a command become a `scope_violation`. Path tests pin `platform` (Linux CI vs Windows paths). |

### 3.10 Build order (one commit per step)

1. `work-contract.ts`, `work-receipt.ts` + specs (pure).
2. `contract-mapping.ts`, `contract-scope.ts` + specs (pure).
3. `receipt-store.ts` + spec.
4. `VerificationGateState.checks` history + `AgentSession.verificationSnapshot()`.
5. Wire in `_runDelegatedLane`: contract option, `_toolValidationError` scope check, edit-provider
   wrapper, budget, receipt on completion. Wire `normalizeSubagentSpawnInput` for `contract`.
6. Scope category through `_approvalGate`, `approval-scope.ts`, `loopApprovalPolicy`, `run-gate.ts`.
7. Loop wiring: dispatcher, supervisor `_record`/`restore`, loop-store normalizer for the new
   optional fields, `extension.ts:603`.
8. Plan-run step receipts (observe).
9. Docs: `docs/guide/` (settings, approvals and safety, tool reference for the `contract`
   argument), CHANGELOG entry under the next prerelease.

---

## 4. #13 — Orchestration Baseline and Regression Evaluation

### 4.1 Layout

```
tests/eval/
  harness/            virtual-clock.ts, loop-driver.ts, plan-run-driver.ts, canonical.ts, scorecard.ts, compare.ts
  traces/             <scenario>.trace.jsonl           synthetic, hand-written or generated
  golden/             <scenario>.<arm>.json            canonical final state + scorecard
  replay/             *.spec.ts                        run by vitest.eval.config.ts (CI)
  fixtures/<scenario>/ scenario.json, verify/          live-suite inputs; the verifier lives OUTSIDE the agent's workspace copy
  baselines/          README.md, <date>-<sha>.summary.json   committed summaries only
tests/integration/eval/run.mjs                         live suite launcher (Extension Development Host)
src/eval/eval-commands.ts                              registered only when BLACKSITE_EVAL=1
scripts/gen-eval-fixture.mjs                           seeded, synthetic fixture workspaces
vitest.eval.config.ts
```

npm scripts: `test:eval:replay`, `eval:baseline` (refreshes golden files and the scorecard with
flags at baseline, when `UPDATE_EVAL_GOLDEN=1`), and `eval:live`.

### 4.2 Deterministic replay

Replays drive the **real** `LoopSupervisor`, `computeReadySet`, `LoopStore`, `PlanRunService`,
`PlanRunStore`, `settleRunGate`, `loopApprovalPolicy` and tripwire checks. Only the dispatcher,
the plan-run host and model verdicts are scripted. What gets tested is the orchestration state
machine as it ships.

- **Trace format** (JSONL):
  - Line 1 is a header: `{ trace: 1, scenario, subject: "loop" | "plan_run", flags, setup: { tickets, plan, loop, charter } }`.
  - Every other line is an event with a virtual `at` (ms):
    - loop events: `start`, `lane { ticket, attempt, durationMs, spend: [[atMs, usd]…], result }`,
      `review { verdict }`, `crash`, `user { resume | pause | stop | release, ticket? }`,
      `ticket_edit`;
    - plan-run events: `turn { origin, stepMoves, spend, stopReason, facts }`,
      `gate { kind, answer | "timeout" }`, `provider_outage { ms }`,
      `conductor { decision, rationale }`, `snapshot_changes { changes }`, `crash`.
  - `verifier { subject: pass | fail }` records the independent verdict (D6).
- **`crash`** throws away the supervisor or service and builds a new one over the **same**
  on-disk store, then calls `restore()` or runs plan recovery. That is the real recovery path.
- **Virtual clock:** a discrete-event queue. Lanes resolve in `(endAt, ticketId)` order, and
  microtasks are flushed between events. This uses the injected `now` and `newId` (Phase 0 and
  `PlanRunService` options).
- **Canonical output:** the final loop record and ticket statuses and event kinds, the plan-run
  ledger, receipts (once #11 has landed), and the scorecard. Ids and times are rewritten to
  virtual values. Each spec checks it against `golden/<scenario>.<arm>.json` and replays every
  trace **three times in-process**, asserting byte-identical output.

### 4.3 Scenario catalogue

Every outcome the issue names is covered for both subjects where it applies. Fixtures are
**synthetic**: generated or hand-written, never copied from a user's project. They are nested
multi-project workspaces, because that is the normal case.

| Scenario | Subject | Exercises |
| --- | --- | --- |
| `retry-then-succeed` | loop | Fail with `nextStep`, an informed retry, success, review. |
| `crash-mid-lane` | loop | `crash` → `restore` → paused → `abandoned` iteration → resume → re-dispatch. |
| `park-release` | loop | Reviewer blocks → ticket blocked → user `release` → success. |
| `consecutive-failure-halt` | loop | `maxConsecutiveFailures` stop. |
| `spend-ceiling` | loop | `maxUsd` counted with live in-flight spend. In-flight lanes finish. |
| `territory-overlap` | loop | Concurrency 2: one withheld for territory, plus an **undeclared** collision (conflict metric). |
| `false-completion` | loop + plan_run | The agent reports done, the verifier fails. Self-reported ≠ verified. |
| `long-plan-outage` | plan_run | 3 phases × 4 steps, provider outage, compaction, step retries. |
| `defer-and-answer` | plan_run | `whenBlocked: defer` → queued decision → answered → preapproval used. |
| `conductor-halt` / `tripwire-pause` | plan_run | Halt verdict; `out_of_territory` and `repeated_failure` pauses. |
| `run-budget-exhausted` | plan_run | `maxUsd` → `budget_exhausted`. |
| `crash-mid-step` | plan_run | Interrupted step → recovery brief → resume. |
| `cross-module-refactor`, `delegation-fanout` | live | Live-suite scenarios (§4.5), with replay traces taken from their recorded ledgers. |

### 4.4 Scorecard (`harness/scorecard.ts`, pure)

`scoreLoop(record, tickets, verifier)` and `scorePlanRun(run, events, verifier)` return:

| Field | Definition |
| --- | --- |
| `verifiedSuccess` | Subjects the **independent verifier** passed. |
| `selfReportedSuccess` | Lanes reporting ok, steps marked complete, tickets moved to review. |
| `falseCompletions` | Self-reported and not verified. Reported on its own line, never folded into success. |
| `elapsedMs`, `activeMs` | Virtual in replay, wall-clock live. Plan runs use the existing clock buckets. |
| `costUsd`, `costPerVerifiedSuccess` | `null` when nothing was verified (never ∞ or 0). |
| `interventions` | User actions (resume, release, answer, stop) + gates answered by a person + decisions answered. |
| `repeatedFailures` | Distinct `failureSignature` (`run-tripwires.ts`) values seen ≥ 2 times. |
| `conflicts` | Withheld for territory (prevented) vs overlapping writes in overlapping time (occurred) vs merge conflicts (live, isolated copies). Kept separate. |
| `retries`, `parks`, `abandoned`, `halts`, `budgetStops` | Counts. |

`compare(baseline, candidate)` produces a table of deltas with regression flags:

- verified success must not fall;
- false completions must not rise;
- cost per verified success may rise by at most a configurable tolerance;
- interventions must not rise.

### 4.5 Live suite (opt-in, never in CI)

- `npm run eval:live -- --scenario <name> --arms baseline,candidate --repeats 3` builds the
  extension and launches the Extension Development Host the way `tests/integration/lsp/run.mjs`
  does. That includes the junction trick, because the repo path contains a space.
- `BLACKSITE_EVAL=1` registers the `blacksite.eval.runScenario` command:
  1. Copy the fixture into a temp workspace and `git init` it.
  2. Seed `.blacksite/` tickets and the plan.
  3. Set the orchestration flags for the arm at workspace scope.
  4. Inject provider credentials from environment variables into the profile's secret storage.
  5. Start the loop or plan run with a fixed charter (`whenBlocked: "defer"`, fixed `maxUsd`).
  6. Wait for it to settle under a wall-clock cap.
  7. Export the ledgers and receipts.
- The launcher then runs `fixtures/<scenario>/verify/` against the workspace copy (D6), scores
  each arm, and writes `eval-results/<date>/…` (gitignored).
- Both arms use the same model, provider, task, charter and budgets. Repeats report the mean and
  the spread, because live models vary between runs.
- Guards:
  - it refuses to start without `BLACKSITE_EVAL_MAX_USD`;
  - each arm stops at that ceiling;
  - it runs in temp copies only.

### 4.6 Flag registry and rollback checks (AC 4)

`tests/eval/replay/flags.spec.ts` iterates `ORCHESTRATION_FLAGS` and checks four things:

1. The setting is declared in `package.json`, and its default equals `baseline`.
2. It is documented in `docs/guide/settings-and-commands.md`.
3. **Parity:** every replay with all flags at baseline matches the baseline golden file.
4. **Shadow parity:** for any flag with an `observe` value, a replay in `observe` produces the
   same outcomes and statuses as baseline. Only the added records may differ.

Any future addition that skips its flag or changes behaviour in shadow mode fails CI.

### 4.7 CI

Add a step after "Unit tests and coverage thresholds":

```yaml
- name: Orchestration replay baseline
  run: npm run test:eval:replay
- name: Upload replay scorecard
  if: always()
  uses: actions/upload-artifact@<pinned sha> # match the pinning style of the other actions
  with: { name: orchestration-scorecard, path: eval-results/replay-scorecard.json }
```

Replay specs live outside `tests/unit/`, so they run once and do not move the coverage ratchet.

### 4.8 Capturing the baseline (AC 1)

1. On the Phase 0 commit (before any #11 code exists), run `npm run eval:baseline`. Commit the
   golden files and `baselines/<date>-<sha>.summary.json`.
2. Run `npm run eval:live -- --arms baseline --repeats 3` for each live scenario. Commit only the
   summary JSON, recording provider, model, date and SHA. The cost goes to the owner's key
   **(confirm the budget and the model)**.
3. Every later candidate is compared with those numbers. Because of the flag-off parity in §4.6,
   the baseline can be rerun on any later commit with flags off.

### 4.9 Tests, mapped to the acceptance criteria

| AC | Covered by |
| --- | --- |
| Baseline captured before enabling components | §4.8 procedure; golden files committed from the Phase 0 commit. |
| Deterministic replay across crash, retry, park, halt, budget | §4.3 scenarios; triple replay with byte-identical output. |
| Verification evidence vs self-reported completion | Separate scorecard fields; the `false-completion` scenario in both subjects. |
| Flag and rollback per major addition | §4.6 registry checks, run in CI. |

### 4.10 Build order

1. Virtual clock, loop driver, canonicalizer, golden files. Scenarios `retry-then-succeed`
   and `crash-mid-lane`.
2. The remaining loop scenarios.
3. Plan-run driver and its scenarios.
4. Scorecard, compare, and `false-completion`.
5. Flag registry checks, `vitest.eval.config.ts`, npm scripts, CI step.
6. `gen-eval-fixture.mjs`, plus a sanitization spec that scans fixtures and traces for emails,
   home paths and key-shaped strings.
7. Live launcher, `eval-commands.ts`, and the baseline capture procedure and README.

---

## 5. Running #11 and #13 in parallel

The tracks overlap only at Phase 0, so they can run as two worktrees.

| Owned by #11 | Owned by #13 | Touched by both (expect a trivial rebase) |
| --- | --- | --- |
| `src/orchestration/*` except `flags.ts` | `tests/eval/**`, `tests/integration/eval/**` | `package.json`: #11 adds docs/settings, #13 adds scripts |
| `agent-session.ts`, `chat-provider.ts` (lane runner), `chat/subagent-lanes.ts` | `src/eval/eval-commands.ts` | `src/extension.ts`: #11 changes the loop wiring block (`:603`), #13 adds one env-gated `register` line |
| `loops/loop-dispatcher.ts`, `loop-supervisor.ts` (`_record`, `restore`), `loop-model.ts`, `loop-store.ts` normalizer | `scripts/gen-eval-fixture.mjs`, `vitest.eval.config.ts` | `CHANGELOG.md` |
| `plans/plan-run-model.ts`, `plan-run-service.ts`, `plan-run-view.ts`, `run-gate.ts` | `.github/workflows/ci.yml` | |
| `approval-scope.ts`, `session-state.ts`, `agent/verification-ledger.ts`, `tools/definitions.ts`, `docs/guide/*` | | |

Rules:

- #13 replays drive `LoopSupervisor` and `PlanRunService` only through their public
  constructors and methods, so #11's internal changes do not break them.
- Whichever branch merges second runs the other's tests before merging.
- If #11 merges first, the golden files must still match with flags `off`. That is the parity
  check doing its job.

---

## 6. Convergence (after both merge, before #12)

1. Add `observe` and `enforce` arms to the replay scenarios. Commit the golden files for
   each arm.
2. Shadow parity (§4.6) must pass for `workContracts=observe`.
3. Make the scorecard receipt-aware: report `receipt.status` alongside the independent verifier
   and count disagreements (for example, a receipt says `verified` and the verifier fails). Every
   disagreement is a bug in #11's evidence and gets a test.
4. Run the live suite for `baseline` vs `enforce`. The results decide when to change the
   default, which is the owner's call.

---

## 7. #12 — Unified Work Graph (after #11 and #13)

### 7.1 Model (`src/orchestration/work-graph/work-graph-model.ts`, pure)

- **Node ids** reuse the stable ids each store already has, with a namespace prefix:
  - `ticket:BLK-12`, `plan:<id>`, `phase:<plan>/<phase>`, `step:<plan>/<phase>/<step>`;
  - `contract:<id>`, `receipt:<id>`, `run:<execRunId>`, `planrun:<id>`;
  - `artifact:sha256:<hex>`, `file:<map node id>`, `area:<prefix>`.
- **Edges:**

```ts
interface WorkEdge {
  id: string;                                // `${kind}:${from}->${to}:${source}`
  kind: "depends_on" | "modifies" | "consumes" | "produces" | "conflicts_with" | "verified_by" | "informed_by";
  from: string; to: string;
  status: "verified" | "declared" | "inferred" | "missing";
  provenance: { source: EdgeSource; ref: string; rev?: string };   // e.g. source "ticket.blockedBy", ref "BLK-12"
  confidence: number;                        // 1 for verified/declared; heuristic for inferred; 0 for missing
  observedAt: string;
  freshness: "fresh" | "stale";
  staleReason?: string;
}
```

- **Status meanings:**
  - `verified`: observed by the host (receipts, snapshots, run footprints).
  - `declared`: authored intent (territory, `blockedBy`, `dependsOn`, contract fields).
  - `inferred`: computed by the graph, such as step order or impact overlap.
  - `missing`: the reference's target does not exist. The edge is **kept and shown**, never
    dropped.

### 7.2 Sources → relations

| Relation | Declared | Verified | Inferred |
| --- | --- | --- | --- |
| `depends_on` | `ticket.blockedBy`, `phase.dependsOn`, `contract.dependencies` | — | Step order within a phase (low confidence); parent ticket → children |
| `modifies` | `ticket.territory`, `phase.files` via `territoryAreas`, `contract.territory.writable` | `receipt.observed.filesChanged`, plan-run step snapshot changes, run footprints | — |
| `consumes` | `contract.inputs`, plan docs attached to a phase or step | — | — |
| `produces` | `contract.outputs` | Receipt evidence artifacts, run artifacts | — |
| `conflicts_with` | — | Two receipts with overlapping time windows that changed the same file | Open items whose `modifies` sets intersect (reuse `territoryConflicts`), or that meet through Map impact at depth 1 |
| `verified_by` | — | Step, ticket or contract → `receipt` with status `verified`, or a check evidence entry | — |
| `informed_by` | `ticket.references`, Map notes, `ticket.runIds`, `PlanPhaseRunEvidence.runIds` | Receipt `inputs` that were actually read (once #17 exists) | — |

### 7.3 Builder and incremental invalidation

- `buildWorkGraph(sources)` is pure. `sources` are read-only snapshots of:
  - `TicketStore.read()`, `PlanningStore.read()`;
  - the receipt index (#11), `PlanRunStore` summaries, `RunStore` summaries plus
    `RunFootprintIndex`;
  - the Map node index and adjacency through a narrow read port on `GraphAgentGateway`
    (`nodeExists`, `impactOf(files, depth)`).
- Edges are grouped into **partitions by source entity** (`ticket:BLK-12`, `plan:<id>`,
  `receipt:<id>`). A reverse index `path → edge ids` supports invalidation.
- `WorkGraphIndex` (host side, owns the subscriptions) reacts to changes:
  - each store's `onDidChange`: rebuild only the partitions whose `updatedAt` changed;
  - Map index changes: re-check node existence and freshness for edges on the changed paths.
- The index is built lazily on first query and never on activation. When
  `blacksite.orchestration.workGraph` is off, nothing is built.

### 7.4 Findings: shown, never repaired

`findings()` returns:

- **Cycles:** Tarjan SCC over `depends_on`, run separately for declared and inferred edges.
  Each cycle lists its edges and where they came from.
- **Missing references:** dangling `blockedBy`/`dependsOn` ids, territory files absent from the
  Map index, contract inputs whose artifact or receipt does not exist.
- **Stale relations:** a `verified_by` edge is stale when any file it covered has a different
  `sha256` now (from #11 §3.3), or when a later receipt modified that file.
- **Incompatible artifact versions:** a contract input pinned to a sha that differs from the
  producer's latest receipt output.
- **Healed by the store:** `ticket-store` drops two-cycles at write time (`:1177`) and heals links
  on read (`reconcileLinks:534`). Add a non-mutating `TicketStore.linkFindings()` that reports
  what the last read healed or dropped, so the graph can show it instead of hiding it. This is
  the only change #12 makes to ticket-store.

### 7.5 Queries (read-only)

- **Host API `WorkGraphQueries`**, for #15 and #16 to consume later:
  - `trace(ref)` → affected code, dependent tasks, required deliverables, evidence (AC 1);
  - `dependencies(ref, depth)` and `dependents(ref, depth)`;
  - `blockers(ref)`: unsatisfied `depends_on`;
  - `impact(ref)`: work items reached through `modifies` combined with Map impact;
  - `criticalPath(scope)`: the longest weighted path over the open-work DAG. Weights come from
    complexity (small 1, medium 3, large 8), or from median step durations when plan-run history
    exists. Cycles are excluded and reported.
  - `findings(scope)`.
- **Agent tool `work_graph`** (`op: trace | blockers | impact | critical_path | findings`):
  - results are bounded like the `map_*` tools (limits, caps);
  - it is read-only, so plan mode allows it;
  - it is withheld from the catalog when the flag is off.
- **No scheduling or approval changes in #12.** The loop scheduler keeps using
  `ticket.blockedBy` until #15.

### 7.6 Tests

- **Headless fixtures:** JSON snapshots of tickets, planning, receipts and a Map node list,
  reusing #13's scenario fixtures. Covers:
  - trace completeness (AC 1);
  - the four statuses are distinct (AC 2);
  - a 3-cycle, a dangling id, a stale receipt and an incompatible artifact each appear as
    findings, and nothing is mutated (AC 3).
- **Incremental equals full:** apply a random sequence of store edits, then assert that the
  incremental graph is deep-equal to a full rebuild after every edit. Seeded and deterministic.
- **Scale** (`work-graph.scale.spec.ts`, AC 4): a generated graph with 10k tickets, 500 plans ×
  40 steps, 5k receipts and 50k Map nodes.
  - Targets: cold build ≤ 2 s, incremental single-ticket update ≤ 25 ms, `criticalPath` over 20k
    steps ≤ 200 ms.
  - CI asserts 3× those targets to avoid flakes and prints the actual numbers.
  - An opt-in `test:perf` script asserts the real targets.

### 7.7 Build order

1. Model, builder for tickets and plans (declared and inferred), findings for cycles and
   missing references.
2. Receipt, run and Map sources (verified edges), freshness and staleness, incompatible
   artifacts.
3. `WorkGraphIndex` with partitions and invalidation, plus the incremental-equals-full test.
4. `WorkGraphQueries`, then the `work_graph` tool, then `TicketStore.linkFindings()`.
5. Scale tests, then the flag registry entry (`workGraph`, baseline `false`), docs and
   CHANGELOG.

---

## 8. Risks and open questions

| Risk | Mitigation |
| --- | --- |
| Enforcement makes agents fight their constraints (standing harness direction). | Tri-state flag, `observe` first. Scope is a visible approval, never a silent block. Undeclared territory means today's behaviour. |
| Shell writes get past the pre-dispatch checks. | Stated as a gap. Detected afterwards (snapshots, `git status` delta). Receipts report their own `coverage`. |
| Receipts and `StepEvidence` duplicate each other. | Plan-step receipts are built **from** `StepEvidence`, and `StepEvidence` stores only `receiptIds`. |
| Older builds reading newer files. | D4 (no new outcome values); optional fields only; newer contract schemas are rejected, newer receipts are opaque. |
| Replays drift from reality. | They drive the real services. Live runs export ledgers that become new traces. Receipt and verifier disagreements are counted (§6.3). |
| Live evaluation cost and noise. | Opt-in only, a hard USD guard, repeats with the spread reported, never a CI gate. |
| Linux-only failures from path tests written on Windows. | Pin `platform` in every path test (release-process lesson). Push `main` and watch CI before tagging. |

Open questions for the owner:

1. D1 and D2: the tri-state flag and human-only scope widening. Are these right?
2. The live evaluation budget per scenario, the provider and model for the baseline, and
   whether a manual (`workflow_dispatch`) GitHub workflow with secrets is wanted later.
3. Should `enforce` ever become the default, and what evidence from §6.4 would justify it?

---

## 9. Verification gate (every phase)

From CONTRIBUTING:

- `npm run lint`, `compile`, `typecheck:webview`, `test:coverage`, `security`, `build`;
- plus `npm run test:eval:replay` once #13 lands;
- `npm run test:browser` where a webview changed.

Rerun a single git-heavy spec alone before treating a timeout under coverage as real. The
prerelease follows the established process: an annotated tag, and `main` pushed and green on
ubuntu CI before the tag is pushed.
