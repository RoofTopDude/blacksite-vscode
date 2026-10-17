# Orchestration 2.0 — remaining P1 (#16–#21): progress log

Status: **working tree, not committed.** Branch `fix/orchestration-repeat-detection`. Epic [#10](https://github.com/RoofTopDude/blacksite-vscode/issues/10). The issues stay open until a person closes them.

Companion docs: [`orchestration-p1-implementation-plan.md`](./orchestration-p1-implementation-plan.md) (#14, #15, #19, shipped in 1.33.0-pre.5), [`artifact-exchange-design.md`](./artifact-exchange-design.md) (#17), [`../tests/eval/README.md`](../tests/eval/README.md).

## Verification (2026-10-16, this tree)

| Check | Result |
| --- | --- |
| `tsc -p tsconfig.json --noEmit` | passes |
| `npm run test:unit` | 369 files, 5,210 tests pass |
| `npm run test:eval:replay` | 6 files, 268 tests pass |
| `npm run security:static` | 0 findings in 1,257 files |
| ESLint on every file this work touched | passes |

## Per-ticket state

| Issue | State | What is in the tree | Not done |
| --- | --- | --- | --- |
| **#20** repeated failures and stalls | Detector fix done, behind `normalizeToolRounds` (off) | Fingerprint ignores volatile timing metadata in results (`src/orchestration/tool-round-fingerprint.ts`). Arguments and text content still count. Replay: timestamped identical failures intervene at round 3 of 40; a genuinely progressing sequence never does, with the flag on or off (`tests/eval/replay/repeated-failure-loop.spec.ts`, fixtures `repeated-failure-loop` and `incremental-progress`). | Only identical consecutive rounds are detected. Near-identical edits, repeated retrieval, unchanged requirements and verification stagnation are not. Threshold (3) and nudge cap (3) are not configurable. No progress facts in run reports or handoff receipts. Dismissal is only the flag. |
| **#17** artifact exchange | Read side added (slice 2); still storage-only in the product | `list`, `assessRecord` (freshness), `buildArtifactPacket` (ranked, bounded), `changeReceiptDraft`, `revisionOf` (`src/orchestration/artifact-exchange/`). Tests: `tests/unit/artifact-exchange-read.spec.ts`. | No session integration, tool, or injection. `interface_contract` and `verification_receipt` kinds. Redaction pass. Invalidation of dependent findings. Retention pins. |
| **#18** verification lane | Pure decision core; not wired into Ticket Loops | `decideVerification`, `buildVerificationRequest`, `freshnessOf` (`src/orchestration/verification-lane.ts`). Tests: `tests/unit/verification-lane.spec.ts` (19). | No deterministic check runner (it reads the receipt's checks, it does not run new ones). No reviewer adapter or model call. No Ticket Loop wiring and no flag. Scope and cost bounds are not enforced. |
| **#21** integration coordination | Pure gate; not wired into the scheduler or worktrees | `evaluateIntegration` (`src/orchestration/integration-gate.ts`). Tests: `tests/unit/integration-gate.spec.ts` (17). | No merge or worktree work (D9 deferred). Interface facts come from the host because `interface_contract` is not a store kind. No scheduler flag. "Authorized" rework is named, not dispatched. |
| **#16** strategic conductor | Wired behind `strategicConductor` (off) | `src/continuation/strategic-verdict.ts`: typed proposals (replan, delegate, reallocate, verify, block), a parser that halts on malformed or forbidden requests, a per-run call cap and replan cap, oscillation rejection, and `decideWithStrategy`. `PlanContinuationService` takes an optional policy; with the flag off it calls the legacy path. Proposals become a question to the person. Tests: `tests/unit/strategic-verdict.spec.ts` (33), `tests/unit/plan-continuation-strategic.spec.ts` (5). | Only stalled steps and steps that failed twice consult it. Delegation, reallocation and verification are shown, not performed. No per-call cost ledger; the cap counts calls. No live provider run, so proposal quality is unmeasured. |

## Decisions taken without the owner

- **#16 proposals stop the run.** Every proposal reaches the person as a question, including `block`. Nothing continues on a proposal's say-so. A replan is deferred until someone approves it. The conductor has no path to an action.
- **#16 forbidden keys halt the run.** A reply that names a grant, budget, limit, close, edit, command, tool or dispatch field halts with category `security`. A reply is not trimmed and applied.
- **#18 verdicts are fail-closed.** An unreadable receipt, a change with no pinned hash, or a required review that did not run gives `insufficient_evidence`. A reviewer that wrote to the workspace gives `blocked`.
- **#17 slice 2 goes past the design doc's gate.** The design said to review before adding consumers. The read side is pure and has no producer in the product, so it is a review candidate, not a change in behaviour. Say so if you want it reverted.
- **Flags.** Only #16 and the #20 detector add a flag. #17's `artifactExchange` flag already existed. #18 and #21 are libraries with no flag; a flag with no effect would be misleading.

## Known gaps in receipts that limit #18

Receipts hash changed files only up to a count and a size limit (`lane-contracts.ts`, `_fingerprint`). A larger file or one past the count has no hash, so the lane holds it as `unpinned_change` rather than verifying it. This is conservative on purpose. Fixing it means raising the limits or hashing lazily, which is a separate decision.

## Next steps, in order

1. Run the live evaluation (`npm run eval:live`, needs a provider key and a spend ceiling) for #16 and #20 with the flags on. Nothing should change a default until that has run.
2. Wire the verification lane into Ticket Loop `user_review`, behind a flag, so a verdict is recorded on the ticket. Keep closure human.
3. Add `interface_contract` to the exchange store, so #21 can read producers from records rather than host facts.
4. Thresholds for #20 as settings, and progress facts in the run report.
