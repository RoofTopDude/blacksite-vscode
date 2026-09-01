---
name: delegation
description: >
  Delegating to subagent lanes well — what is worth delegating, rating complexity so a lane
  is not killed mid-work, choosing sequential versus parallel fan-out honestly, resuming a
  finished lane with subagent_followup, and reading a failed lane as evidence. Use before
  spawning a subagent, or when a lane has timed out or come back empty.
version: 1
---

# Delegation

`subagent_spawn` runs an independent lane in an isolated context and returns only a concise
synthesis. **The lane cannot see this conversation** — everything it needs goes in the task.

Delegate self-contained investigation, verification, or broad file triage early, so your own
context stays focused on orchestration and the final answer. Do **not** delegate trivial or
tightly-coupled work: the coordination cost outweighs it.

## Rate complexity deliberately

`complexity` sets the lane's timeout and tool-round budget. Under-rating kills a lane
mid-work; over-rating holds a budget it never needs. **Rate by the work required, not by the
length of the prompt.**

- `standard` — a bounded lookup or single-file change, roughly under 6 tool calls.
- `complex` — multi-file investigation, or a change needing verification, roughly 6–10.
- `deep` — broad triage across an unfamiliar area, or iterative build/test cycles, 10+.
- `auto` infers from prompt length only, which is a poor proxy. Prefer rating explicitly.

## Sequential and parallel are both first-class

Issuing one lane and reading its answer before the next **is the default and is often right**:
the first result frequently changes what the second task should even be, and it keeps
synthesis to one thing at a time.

To fan out, emit several `subagent_spawn` calls in the **same turn**, each with
`parallel: true`. They run concurrently up to the configured limit. A single lane marked
parallel still just runs alone.

**Fan out when** the lanes are genuinely independent — each self-contained, none needing
another's findings — and you want wall-clock time back: surveying several areas at once,
verifying independent hypotheses, gathering evidence from unrelated parts of the tree.

**Sequence when** a later task depends on an earlier finding, when one result may make the
rest unnecessary, or when lanes would write to overlapping files (concurrent edits to one file
interleave unpredictably).

**The real trade.** Fanning out costs you every lane's context even if the first answer made
the others moot, and lands several results at once to synthesise. Sequencing costs you the sum
of the latencies instead of the slowest one. Weigh those honestly rather than defaulting to
either.

## Re-open a lane instead of replacing it

`subagent_followup` resumes a finished lane using the `subRequestId` from its result, with
everything it already had in context — the files it read, the commands it ran, the reasoning
behind its answer.

Reach for it when the next question **builds on what that lane did**: clarifying its
synthesis, extending one finding, or continuing after a timeout you have diagnosed from its
`executionTrace`. A fresh lane starts blank and has to rediscover all of it.

Spawn new only when the work is genuinely unrelated — carrying an old lane's context into
unrelated work only pollutes it. A follow-up gets its own fresh budget; rate `complexity` for
the follow-up work itself, not the original task. Follow-ups run one at a time. Only the most
recent lanes stay resumable; if the id is gone, spawn a lane carrying what you learned.

## A failed lane is evidence, not a dead end

The failure result carries `partialAnswer`, `executionTrace`, `filesTouched`, `toolRounds`,
and `failureKind`. Read them before deciding:

- If `partialAnswer` already answers what you delegated — **continue. Do not respawn.**
- If a `timeout` lane was still progressing, respawn **narrowed to only what is missing**, or
  at a higher complexity. Never re-delegate work the trace shows is already done.
- A `no_answer` lane that ran to completion will usually fail the same way again. Restate the
  task or do the work yourself.

## Linking a lane to a plan step

Pass `planId`/`phaseId`/`stepId` **together** to link a lane to one step of a tracked plan.
The step is marked `in_progress` when the lane starts, and `blocked` automatically (with the
error as a step note) if it fails.

On success the lane records its answer as a step note but **does not mark the step done**.
Review the lane's answer yourself against that step's acceptance criteria, then call
`plan_update` to complete it — the same way a `maxIterations` step is not done after one pass
without checking.

## Execution Runs stay with the parent

A delegated lane never authors or executes an Execution Run. Subagents may implement or
investigate and recommend verification targets; **the parent tests their combined result**.
