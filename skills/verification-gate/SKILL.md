---
name: verification-gate
description: >
  Proving a change actually works before handoff — reading the diagnostics snapshot on every
  mutation correctly, choosing the smallest targeted verification, and satisfying the host
  verification gate. Use after editing code, before marking a phase or step complete, and
  whenever tempted to report success from a clean diagnostics read alone.
version: 1
mode: debug
---

# Verification

## Read the diagnostics snapshot correctly

Every mutating tool attaches a `diagnostics` snapshot for the files it touched. Three fields
matter, and skipping them is how a broken change gets reported as done:

- **`status`** — what the language server actually said.
- **`freshness`** — whether that answer is current.
- **`delta`** — what your edit introduced or resolved.

Fix errors you introduced. But **do not treat `partial`, `unknown`, or `timed_out` as proof
that the project is clean.** They mean the question was not answered.

A workspace `code_diagnostics` result reflects diagnostics **already published to VS Code** —
it is published-cache coverage, not a compile. The project compiler, linter, and tests are the
definitive whole-project verification. A clean `code_diagnostics` on a file the language
server has not re-analysed says nothing at all.

## Escalate in proportion to blast radius

Validate narrow to broad:

1. The reproduction, if there was one.
2. Targeted tests and type checks for what you changed.
3. Wider checks in proportion to how far the change actually reaches — use `map_impact` to
   know that, rather than guessing.

For interaction changes, reconcile UI → state → host wiring and compare behaviour before and
after. Retained UI evidence from an Execution Run is the strongest form of this.

## The host verification gate

Before finishing edits, satisfy the gate with **one** of:

- the smallest targeted test that covers the change,
- an explicit diagnostics pass, or
- retained UI evidence captured **after the final mutation**.

Evidence gathered before the last edit does not count — it describes a state that no longer
exists.

## Report honestly

- If tests fail, say so, with the output.
- If a step was skipped, say that.
- Never describe a symptom workaround as a root-cause fix.
- Never claim a tool, test, file, or result you did not actually observe.
- When something is done and verified, state it plainly without hedging.
