---
name: tickets-and-queue
description: >
  Working the project's durable ticket queue — filing work you noticed without widening
  scope, checking for near-duplicates first, recording investigation in comments, ranking
  what to pick up with ticket_next, and who is allowed to close. Use when you spot a problem
  mid-task, when asked what to work on, or before starting unprompted work in an area.
version: 1
---

# The ticket queue

The project's durable local backlog. You see it as the "Ticket queue" section of the workspace
state each turn; the user sees it as the Tickets panel and the Board.

## File what you notice, then carry on

When you spot a real bug, a missing test, or a fragile assumption **while doing something
else**: call `ticket_file` and continue the task you were actually given.

- Do **not** widen your scope to fix it.
- Do **not** leave it only in chat text, where it dies at the next compaction.

Filing is cheap, and it is the correct third option between ignoring a problem and derailing
to fix it.

**Never file a ticket for something you are about to do in this same turn.** Just do it.

## Check before filing

Call `ticket_list` first. A near-duplicate should be a `ticket_update`, the same way
`map_note_add` defers to `map_note_update`. Check `matched` and `nextOffset` before treating a
page as the whole queue.

Also check before starting unprompted work in an area, so you see what is already known
about it.

## Investigation belongs in comments

`ticket_comment` is where root causes, ruled-out theories, and evidence go. **That is where a
later session will look for them** — and where you will look, after compaction.

Before starting any ticket you did not file this session, `ticket_get` it first. Its comments
hold the investigation that already happened; redoing that work is pure waste.

## Picking what to work on

When the user asks what to work on, or you finish a plan with no obvious next task, call
`ticket_next` rather than picking from the queue summary by eye. It returns ranked candidates
with the factors behind each position, and **reports blocked work separately** — "everything is
blocked on BLK-9" is a genuinely different answer from "there is nothing to do".

Use `ticket_sweep` only for a deliberate backlog pass, and treat its output as **proposals to
review with the user**, never as tickets to file wholesale.

## Starting work on a ticket

`ticket_promote` for a plan seed → `plan_create` → `ticket_update` with the new `planId`.

A ticket linked to a plan takes its status from that plan automatically. Never track the same
progress in both.

## Closing is the user's call

Move a ticket to `review` when the work is finished and awaiting their verification. **Leave
`done` to them.** Assign a ticket to yourself only when they hand it to you.
