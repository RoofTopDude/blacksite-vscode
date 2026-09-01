---
name: planning-discipline
description: >
  Choosing correctly between a ticket, a plan, and a todo run, then using plans as real
  execution contracts — modular blocks, acceptance criteria, execution gating, phase
  rationale, and maxIterations loops. Use before creating a plan, when work spans multiple
  phases or sessions, or when unsure which surface a piece of work belongs on.
version: 1
mode: plan
---

# Planning discipline

## Three surfaces, one question each

| Surface | Question it answers | Lifetime |
| --- | --- | --- |
| **Ticket** | An outcome that *should be true* | Survives sessions and plans; no steps |
| **Plan** | How one piece of work gets done *now* | Sequenced phases; execution-gated |
| **Todo run** | The step *in flight* | Scratch for 3+ sub-actions you are about to take |

A ticket linked to a plan takes its status from that plan automatically — **never track the
same progress in both**. To start work on a ticket: `ticket_promote` for a plan seed, then
`plan_create`, then `ticket_update` with the new `planId`.

Todo items are not a second progress tracker. Ongoing multi-phase progress belongs in
`plan_update`, not one todo run per phase.

## When a plan is warranted

Use plans deliberately, not ceremonially.

- A bounded one- or two-step request: **just do it**. No plan.
- A 3+ action tactical checklist you are about to execute: `todo_*`.
- Work with meaningful milestones, needing user-visible approval or progress, spanning
  sessions, or needing a durable decision record: `plan_create`.

Do not create a plan merely to restate a simple request as a checklist.

**Before multi-phase work, `plan_list` first** and continue an existing plan with
`plan_update` rather than duplicating it.

## Creating a plan is not permission to build it

Unless the user has explicitly told you to proceed, a new plan starts **unapproved for
execution**. Keep authoring and refining it, research, write plan docs, ask clarifying
questions — but do **not** start implementing. `plan_update` will refuse to advance steps or
phases to `in_progress`/`completed` until the user approves execution (the "Approve
execution" button in the Plans panel) or tells you to go ahead.

Never advance, modify, or act on a plan whose status is `on_hold` or `cancelled` unless the
user explicitly resumes it.

## Author the first phases only

For plans with more than 2–3 phases, create the plan with just the first phase or two, then
extend with `plan_update`'s `addPhases` once you have made progress. Early phases are usually
wrong before you have seen the codebase, and authoring every phase up front commits you to
guesses made before you had the evidence to make them well.

## plan_update is a field-level edit

It takes `planId` plus **only the fields you are changing**: `activePhaseId` to move focus, or
`phaseId` + `phaseStatus`/`phaseNote`, or `phaseId` + `stepId` + `stepStatus`/`stepNote`.
Everything else is left untouched.

The active-plan summary carries a complete phase/step status index, so target any visible id
directly. **Do not call `plan_create` again to "update" a plan that already exists**, and do
not restate phases or steps you are not changing. If an unusually large index is truncated,
call `plan_list` rather than guessing.

## Make plans real execution contracts

- Define concrete **acceptance criteria** for consequential or uncertain phases.
- Record material discoveries, risks, and rejected alternatives in phase notes/rationale.
  **Non-obvious design rationale belongs in `phaseRationale`, not only in chat text** — it is
  durable and cross-session, so a later session (or you, after compaction) does not have to
  re-litigate a decision it can no longer see.
- Revise the next phase when evidence changes the approach.
- Mark work completed only after checking its acceptance criteria. If the current approach
  cannot meet them, record the evidence and mark it **blocked** rather than letting the plan
  imply progress.

## Phase order is structure, not a lock

Phase order communicates the intended shape but does not lock execution. Choose any phase
whose real dependencies permit work, set `activePhaseId` to that focus, and update that
phase/step's status and notes without waiting for unrelated earlier phases.

## Shape the plan to the work

`plan_create`/`plan_update` accept optional modular `blocks` — `findings`, `open_questions`,
`options_considered`, `deliverables`, `rollout_plan`, `rollback_plan`, or `custom` — scoped to
the whole plan or to one phase. Assemble the sections this specific plan calls for. A research
spike looks different from a migration, which looks different from a straightforward feature.
Do not default every plan to the same bare phases-and-steps shape.

## maxIterations is permission to loop

For a step unlikely to be right on the first pass (ambiguous UX, tricky logic), set
`maxIterations` on it. That is explicit permission to implement, check the result against its
`acceptanceCriteria`, refine, and repeat up to the cap before marking it completed — instead
of stopping at the first attempt.
