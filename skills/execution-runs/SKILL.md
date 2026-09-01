---
name: execution-runs
description: >
  Using Execution Runs as an evidence loop — deciding when a run beats a cheaper check,
  searching retained evidence before rerunning, authoring bounded sequences with assertions,
  reading results with sequence_inspect and sequence_compare, and choosing video over
  screenshots. Use when correctness depends on ordered interaction, visual state, timing, or
  a regression comparison.
version: 1
requires: ["browser"]
---

# Execution Runs

**Runs are the parent agent's evidence loop.** The parent — never a delegated lane — decides
when to create a run, authors its bounded steps and assertions, executes it, inspects the
retained evidence, and decides what follows.

## When a run earns its cost

Use a run when correctness depends on:

- an ordered interaction,
- visual state,
- temporal causality,
- cross-channel evidence (UI + console + network + files), or
- a regression comparison against an earlier run.

**Do not** create one for a fact that a focused unit test, the compiler, a file read, or a
single screenshot answers more cheaply. That is the most common way to spend a run for
nothing.

## Start with the evidence you already have

1. **`sequence_search`** the retained evidence and inspect a relevant prior run instead of
   rerunning blindly.
2. **`sequence_discover`** when stable routes, stories, tests, or surfaces are unclear.
3. Then execute the **smallest sequence that can falsify the current hypothesis**: semantic
   step IDs, explicit assertions, the cheapest useful capture profile, hard duration and
   artifact limits.

## Read the result as an index, not a verdict

The compact `sequence_execute` result is an index.

- **`sequence_inspect`** seeks directly to failed assertions, anomalies, named steps, or
  selected visual artifacts. This is where the actual evidence is.
- **`sequence_compare`** surfaces candidate differences — which you must still judge. It does
  not decide for you.
- **`sequence_annotate`** records only durable findings and decisions.
- **`sequence_resume`** only when it says the adapter and side-effect ledger make it safe.
  Otherwise author a narrowed replacement run.

## Video versus screenshots

When motion or temporal causality matters — games, animation, simulations — prefer an explicit
paired browser `video_start`/`video_stop` window. Otherwise use screenshots; they are far
cheaper. **Recordings never start implicitly**, and stop once the evidence answers the
acceptance criteria cleanly.

The desktop adapter is **capture-only** and requires a user-approved opaque binding. External
input and destructive automation remain prohibited.

## Cadence over a long plan

Link meaningful runs to the active plan/phase and to tickets. Use `parent_run_id` for
follow-up lineage, and `baseline_run_id` **only** when the earlier run is a deliberate
comparison baseline.

Run at evidence checkpoints — after an integrated implementation or a delegated wave, before
marking acceptance criteria complete, and again after a focused correction. **Not after every
edit.**
