---
name: context-hygiene
description: >
  Choosing where a piece of knowledge belongs — Base Context, project memory, a map note, a
  ticket, a plan doc, or a skill — and keeping the context window spent on things that change
  a decision. Use when recording something for later, when unsure which durable surface owns
  a fact, or when a long run is losing the thread.
version: 1
---

# Context hygiene

## Where knowledge goes

Every durable surface answers exactly one question. Putting a fact on the wrong one means it
is either never found or paid for on every turn forever.

| Surface | Owns | Loaded |
| --- | --- | --- |
| **Base Context** | Static, reusable project facts | Always |
| **Project memory** (`memory_append`) | Notes from prior sessions worth carrying forward | Always |
| **Map notes** | Why a file, boundary, or non-import relationship is the way it is | With the file |
| **Tickets** | An outcome that should be true | Queue summary each turn |
| **Plan / plan docs** | How this work gets done, and the decisions behind it | While the plan is active |
| **Skills** | How to do a recurring *class* of work | Only when loaded |
| **Chat text** | Nothing durable | Dies at the next compaction |

The last row is the one that costs people work. **A finding left only in chat text is gone
after compaction.** If it matters, it goes on a surface.

## The always-loaded surfaces are expensive

Base Context and project memory ride in every turn. Something added there is paid for on every
request for the rest of the project's life. That is correct for a handful of load-bearing
facts and wrong for a transcript of what happened.

Before adding to either, ask: **would an agent starting cold on an unrelated task in this repo
be better off knowing this?** If not, it belongs somewhere scoped.

## Spend tool calls on evidence, not reassurance

A tool call is useful only when its result **can change your next decision**. Re-reading a file
you have already read, re-running a search you already have the answer to, or re-confirming
state the workspace block reports every turn are all ways to spend context on nothing.

Two specific traps:

- **The workspace-state block already answers a lot.** Architecture map, open-file map
  neighbourhood, git status, diagnostics, ticket queue, plans, skills roster. Read it before
  spending a call re-deriving any of them.
- **Never re-read a file from the top hoping for different content.** If `hasMore` was true,
  continue from `endLine + 1` or locate the region first with `file_search`/`code_symbols` and
  jump straight to it with `offset`.

## Recognise a loop

Repeated results, unchanged failures, and calls producing no new evidence are a **strategy
signal**, not a reason to try once more. Narrow the question, switch to a more appropriate tool
family, or surface the concrete blocker. Spending the remaining iteration budget on variations
of the same attempt is the single most expensive failure mode there is.

## Long-run discipline

- Reconcile the environment before consequential writes and again before handoff — other
  edits, diagnostics, plan updates, or branch changes may have appeared while you worked.
- Preserve changes you did not make. Re-read overlapping regions.
- Never describe stale state as current.
- Batch independent calls into one turn; take dependent ones one at a time. Bookkeeping
  (`plan_update`, `todo_update`, `map_note_add`, ticket updates) almost never depends on
  another call's result, so let it ride along with the substantive call rather than taking a
  round-trip of its own.
