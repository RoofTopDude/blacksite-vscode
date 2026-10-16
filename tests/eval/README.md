# Orchestration evaluation

Measures Blacksite's orchestration before and after each Orchestration 2.0 addition (epic #10, issue #13). Plan: [`docs/orchestration-p0-implementation-plan.md`](../../docs/orchestration-p0-implementation-plan.md) §4.

## Replay suite (CI)

`npm run test:eval:replay`

Synthetic traces in `traces/` are replayed through the real `LoopSupervisor`, `LoopStore`, scheduler, `SignalService`, `PlanRunService` and `PlanRunStore`. Only the lanes, the model turns and the user are scripted. Every trace runs under three arms, and can ask for more by name in its header (`"arms": [...]`):

| Arm | Flags | Runs for |
| --- | --- | --- |
| `baseline` | every flag at its baseline: the behaviour before Orchestration 2.0 | every trace |
| `observe` | every flag at its shadow value at once: contracts and receipts, signals, the shadow scheduler. Records everything, changes nothing | every trace |
| `enforce` | `workContracts: enforce`: receipts decide loop outcomes | every trace |
| `signals-act` | `workContracts: observe`, `signals: act` | traces that ask |
| `scheduler-graph` | `workGraph: true`, `scheduler: graph` | traces that ask |

A new flag with a shadow value is covered by the `observe` arm automatically (`replay/flags.spec.ts` checks that). Concurrency claims (#19) have no replay arm: scripted lanes write no files. They are covered by `tests/unit/orchestration-claims.spec.ts`, which drives real sessions and includes a seeded stress test.

Besides `lane`, `user`, `crash` and `verifier`, a loop trace can script:

- `ticket`: a person (or an agent) changes a ticket: closes a blocker, adds a dependency. With `crashBeforeReconcile`, the host dies after the change is journaled and before any consumer saw it.
- `redeliver`: every source hands over everything again; repeats must change nothing.

Every replay:

- runs three times and must be byte-identical;
- must match its file in `golden/`;
- in `observe`, must equal `baseline` once the records shadow modes add are removed (shadow parity).

`replay/outcomes.spec.ts` asserts what each scenario is for, so a golden file regenerated over a regression still fails.

Each run writes `eval-results/replay-scorecard.json` and `.md`, which compare baseline and enforce. CI uploads them as the `orchestration-scorecard` artifact.

## Scorecard

- Verified success comes only from the trace's `verifier` lines, or from the live verifier. It never comes from the agent or the receipt.
- What the system marked done counts as self-reported success.
- The gap between the two is reported as false completions.
- Cost per verified success is `null` when nothing was verified.
- With contracts on, the scorecard also counts how often a receipt's claim (verified or failed) agreed with the verifier.

## Updating golden files

`npm run eval:baseline` rewrites every golden file from the current code. It also saves a dated summary in `baselines/`. Review the golden diff like code: a golden file that changed means behaviour changed.

## Live suite (opt-in, costs money)

```
BLACKSITE_EVAL_API_KEY=… BLACKSITE_EVAL_MAX_USD=5 \
  npm run eval:live -- --scenario delegation-fanout --arms baseline,enforce --repeats 3
```

Each arm × repeat gets three fresh things:

- a synthetic workspace from `scripts/gen-eval-fixture.mjs`: nested packages with `node --test` suites and nothing to install;
- a fresh VS Code profile;
- the real extension in an Extension Development Host.

The extension's own loop or plan run does the work. The scenario's `fixtures/<name>/verify.mjs` then judges the result. The agent never sees that verifier. Results go to `eval-results/live-<time>/`, which is gitignored. Copy a summary worth keeping into `baselines/` by hand, and record the provider, model and commit.

Scenarios:

- `delegation-fanout`: a loop with three tickets in three packages, two lanes at a time.
- `cross-module-refactor`: a plan run that renames a shared helper across two services and fixes its rounding.

The live suite has not been run yet; see `baselines/README.md`.

## Rules for inputs

Everything here is synthetic: written by hand or generated. Never copy a user's project, log or path. `replay/sanitized.spec.ts` rejects emails, home directories and key-shaped strings in traces, golden files and fixtures.
