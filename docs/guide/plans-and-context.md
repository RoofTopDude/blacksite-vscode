# Plans, Context & Memory

A chat thread is a bad place to keep anything you need next week. Blacksite has four durable
surfaces for the things that outlive a conversation — and knowing which one to reach for is most of
the skill.

This page covers structured work and project knowledge. For a durable list of outcomes you have not
started yet, use [Tickets](tickets-and-board.html); a ticket can become a plan when the work is ready
to begin.

| Surface | Holds | Lives in |
| --- | --- | --- |
| **Plans** | Sequenced work with per-phase state | `.blacksite/planning.json` |
| **Base Context** | Project knowledge injected into every request | `.blacksite/base-context.json` |
| **Agent memory** | Facts the agent records for itself as it works | `.blacksite/` |
| **Map notes** | Annotations on files and relationships | `.blacksite/` |

---

## Plans

A plan is a sequence of phases, each with a concrete outcome, dependencies, implementation surfaces,
validation, acceptance criteria, and risks. Phases carry state — pending, in progress, complete — so
work survives a session boundary and the agent can pick up where it left off.

### Making one

Ask for one, or switch to the **Plan** request profile and describe the work. In Plan the agent stays
read-only, researches before prescribing, and asks focused questions at genuine forks rather than
guessing. What comes back is a plan you can read and argue with before any code moves.

Open the **Plans** view in the sidebar to see it: phases, current state, and what each one touches.

### Plan documents

Phase summaries are one line. Real work needs more, so phases can carry attached **plan
documents** — a specification, a decision record with the alternatives that were considered, an
implementation note.

The distinction matters: research and constraints attach at the plan level, specifics attach to the
phase they belong to. A trivial phase does not need a ceremonial document, and the agent is told not
to manufacture one.

### Executing

When you move from planning to implementation, the plan becomes the agent's spine. It reads the
current phase, does that phase's work, and updates state as it goes. If a session ends mid-phase, the
next one resumes from the plan rather than from your memory of what was happening.

Plans are also how you keep a long piece of work honest. A phase with acceptance criteria is a phase
you can check.

### Todos

Lighter than a plan: a flat checklist for work inside a single session. The agent creates and updates
todos as it decomposes a task, which is mostly useful as a live view of what it thinks it is doing.

---

## Base Context

Some knowledge belongs in *every* request. That your API returns snake_case despite the frontend
being camelCase. That the `legacy/` directory is frozen. That "the queue" always means the Redis one,
not SQS.

Repeating that in each conversation is a waste. **Base Context** is where it goes instead.

### Topics

Base Context is organized into **topics**. Each has a title, notes, and up to six attached file
references, and each can be individually enabled, disabled, or pinned.

- **Enabled** topics ride along in every request.
- **Disabled** topics stay stored but stop being injected — useful when a topic is only relevant to
  work you are not doing right now.
- **Pinned** topics sort to the top.

Add a file with **Blacksite: Add File To Base Context**, or from the file's right-click menu in the
explorer.

### Writing good topics

The limits are generous but not infinite (notes up to ~16,000 characters, six files per topic), and
the real constraint is different anyway: **everything here is paid for on every single request.**

What earns its place:

- Conventions the code does not state.
- Decisions and their reasons — especially ones that look wrong without the reason.
- Domain vocabulary and what your team's terms actually mean.
- Pointers to canonical examples: "auth follows the pattern in `src/auth/session.ts`".

What does not:

- Anything derivable from the code. The agent can read files.
- Anything the map already knows. Structure is a map query.
- Long pasted file contents. Attach the file reference instead.

### Base Context vs. a repository instructions file

If your project has a `CLAUDE.md`, `AGENTS.md`, or similar, the agent reads it. Base Context is
complementary: instructions files are committed and shared, Base Context is a workspace-local layer
you can toggle per topic. Team conventions belong in the committed file; your own working notes
belong in Base Context.

---

## Agent memory

Distinct from Base Context, which you curate: **agent memory** is what the agent records for itself
while working. It can append findings, read them back, and search them.

This is what makes the second session on a problem faster than the first. The agent finds its own
notes about the thing it is looking at rather than rediscovering it.

You do not manage it directly. Its value is that it accumulates.

---

## Map notes

Notes attach knowledge to a **place in the codebase** — a file, or a relationship between two files —
rather than to a conversation.

They carry a category (**architecture**, **gotcha**, **todo**, **risk**, **question**), a short title
so they are skimmable, and a body with the durable non-obvious reasoning. They render on the Codebase
Map, appear in the Notes timeline, and are traversable as a graph layer, so a note can bridge a
relationship the indexers cannot detect.

Full treatment in [Using the Codebase Map](map-guide.html#notes-the-maps-memory).

---

## Attached references

Files you attach to a conversation are stored under `.blacksite/reference/<sessionId>/` rather than
being pasted into context.

That indirection is the point. The agent gets tools to list attachments, read them, zoom into regions
of an image, query a spreadsheet, and run vector search across them — so a 200-page PDF becomes
something it retrieves from rather than something that consumes your whole context window.

---

## Choosing between them

| You want to… | Use |
| --- | --- |
| Sequence work across sessions | A **plan** |
| Track steps within one session | **Todos** |
| State a convention that applies always | **Base Context** |
| Record why one specific file is strange | A **map note** |
| Record why two files are connected | A **relation note** |
| Give the agent a document to consult | An **attachment** |

---

## Committing them

Everything is plain JSON under `.blacksite/`. Whether to commit it is a real choice:

- **`planning.json`** — often worth committing. A shared plan is a shared understanding of the work.
- **`base-context.json`** — worth committing if the topics are team conventions rather than personal
  notes.
- **Everything else** — the index, logs, database, and attached references — is local working state.
  Ignore it.

A reasonable default:

```gitignore
.blacksite/*
!.blacksite/planning.json
!.blacksite/base-context.json
```

---

## Related

- [Working with Chat](working-with-chat.html) — request profiles, especially Plan
- [Using the Codebase Map](map-guide.html) — notes and the graph layers
- [Tool Reference](tool-reference.html) — the planning, memory, and reference tools
