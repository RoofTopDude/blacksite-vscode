# Tickets & the Board

Tickets are Blacksite's durable list of work worth coming back to. They are useful when you or the
agent notices something real—a missing test, a fragile assumption, a bug outside the current task—
but stopping to solve it now would pull the work off course.

You do not need a project-management system to use them. The queue is local to the open workspace,
stored in `.blacksite/tickets.json`, and visible in two forms:

- **Tickets** is the compact sidebar view for filing, reading, and discussing work.
- **Board** is the wide editor view for sorting that work across stages.

---

## Ticket, plan, or todo?

These three objects answer different questions:

| Use | The question it answers | Example |
| --- | --- | --- |
| **Ticket** | What outcome should we come back to? | “Retry backoff stays below the gateway timeout.” |
| **Plan** | How will we deliver a larger outcome? | A three-phase migration with validation per phase. |
| **Todo** | What is left in this one working session? | Read the handler, patch the test, run the suite. |

A ticket should describe the result you want, not a checklist of how to get there. When work becomes
large enough to need phases and acceptance criteria, promote the ticket into a plan.

---

## Opening the queue

- Choose **Tickets** inside the Blacksite activity-bar group, or run **Blacksite: Open Tickets**.
- Run **Blacksite: Open Ticket Board** for the full-width board.
- Right-click a file in the editor and choose **Blacksite: File a Ticket** to start with that file
  already attached as the ticket's territory.

The sidebar opens on **Open** work. Use **Triage** for items the agent noticed and left for your
decision, **Active** for work in progress or review, and **All** when you also need closed items.

---

## Filing a useful ticket

A good title states what should be true when the work is finished:

- Good: *“Map search keeps the selected result visible.”*
- Weak: *“Look into map search.”*

Add a short description when the reason is not obvious. Markdown is supported, including file
references such as `src/graph-provider.ts:120`.

Four fields help the queue stay useful:

- **Priority** is urgency: urgent, high, normal, or low.
- **Complexity** is a coarse effort hint: small, medium, or large. It is not a time estimate.
- **Labels** group related work. Reuse an existing label when one already means the same thing.
- **Territory** is the file or folder area the work concerns.

Territory connects the queue to the Codebase Map. A ticket can name individual files or a folder
area such as `src/graph`; the map resolves that area against its current index, so a renamed file
does not quietly become permanent stale metadata.

---

## What “Next up” means

The queue recommends a next unblocked item from the current view. It considers priority, blocked
work, complexity, how long an item has been untouched, and recent activity.

That recommendation is an explanation, not an assignment. It exists to make the choice visible:
you can see why an urgent, unblocked, small item rose above an older low-priority one and choose
differently.

---

## Moving work through the board

The Board has one column for each status:

| Status | Meaning |
| --- | --- |
| **Triage** | Newly noticed work waiting for your decision |
| **Backlog** | Accepted, but not started |
| **In progress** | Being worked now |
| **Blocked** | Cannot move until another condition changes |
| **Review** | Work is ready for a person to verify |
| **Done** | Verified and complete |
| **Cancelled** | Intentionally not being pursued |

Drag a card between columns, or select it and use `[` and `]` to move left or right. With a card
selected, keys `1` through `4` set urgent, high, normal, or low priority. The board keeps Done and
Cancelled collapsed by default so an old project history does not bury current work.

Closing work is normally your decision. The agent may move an item to **Review**, but it does not
silently mark the outcome verified.

---

## Connecting a ticket to a plan

When you decide to start a larger ticket, ask Blacksite to plan it. The ticket supplies the title,
description, and resolved map territory, giving the new plan a grounded starting point.

Once linked, the ticket can follow the plan's state:

- a plan waiting for execution approval reads as backlog;
- an active phase reads as in progress;
- a held or failed plan reads as blocked;
- completed work moves to review.

Changing the ticket status by hand detaches that automatic link. The sidebar tells you when this
happens and offers to let the ticket follow the plan again.

---

## Comments and history

Every ticket has one activity timeline. Comments, status changes, priority changes, plan links, and
territory changes appear in chronological order.

Use comments for facts another session will need: a root cause, a dead end already ruled out, a
decision, or a link to evidence. Unlike a chat transcript, these comments stay attached to the
outcome they explain and are not removed by conversation compaction.

---

## What the agent may do

The agent can file, search, update, comment on, rank, and promote tickets. It is instructed to file
out-of-scope work instead of quietly widening the task you gave it.

Agent-filed work begins in **Triage**. That boundary is deliberate: noticing is cheap, but deciding
that something belongs in the team's backlog is a human choice.

---

## Related

- [Plans, Context & Memory](plans-and-context.html) — when a ticket becomes structured work
- [Using the Codebase Map](map-guide.html) — ticket territory and the ticket-heat layer
- [Working with Chat](working-with-chat.html) — how the agent records follow-up work mid-run
- [Settings & Commands](settings-and-commands.html) — every queue command
