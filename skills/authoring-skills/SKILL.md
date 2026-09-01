---
name: authoring-skills
description: >
  Writing a good SKILL.md — what belongs in a skill versus Base Context, memory, or a plan;
  how to write the description that decides whether the skill is ever loaded; and how to use
  progressive disclosure so a large skill stays cheap. Use when the user asks to create or
  improve a skill, or when offering to capture a procedure you just worked out.
version: 1
---

# Authoring skills

A skill is **procedural knowledge**: how to do a recurring class of work. It is loaded only
when the task matches, and it specialises the core contract while it is loaded.

## What is not a skill

Getting this wrong is the most common failure, because the result still "works" — it just
wastes context or never fires.

| If it is… | It belongs in… |
| --- | --- |
| A fact about this repository | Base Context (always loaded) |
| Something learned to carry forward | `memory_append` |
| How one piece of work gets done now | A plan |
| A tool the agent needs | An MCP server |
| A durable outcome that should be true | A ticket |
| **How to do a kind of work, reusably** | **A skill** |

A skill that restates project facts is Base Context with extra steps, and it pays for itself
twice — once in the roster and again when loaded. If a skill needs a project fact, point at
Base Context rather than copying it.

## The description is the whole game

The `description` is the **only** part of a skill in context before it loads. It is the entire
basis on which the agent decides whether to load it. A skill with a weak description is not a
weak skill — it is an **unused** skill, and the failure is invisible.

Write it in the **third person**, and make it say two things:

1. **What the skill does** — concretely, in the vocabulary of the work.
2. **When to use it** — the situations, requests, or signals that should trigger it.

```yaml
# Weak — says nothing that distinguishes it from any other skill:
description: Helps with database migrations.

# Strong — a reader can tell whether it applies right now:
description: >
  Authoring and verifying a schema migration in this repo: the up/down pair, the backfill
  strategy for large tables, and the staging verification before merge. Use when the user asks
  for a schema change, a new column or table, or a data backfill.
```

Aim for one to three sentences. Cap is 600 characters.

## Progressive disclosure

Three levels, and using all three is what keeps a deep skill cheap:

1. **`description`** — always in context. One line.
2. **`SKILL.md` body** — loaded on `skill_read`. Target **under ~500 lines**. This is the
   overview and the decision procedure.
3. **`reference/` files** — read individually, on demand, when the body points at them.
   Unbounded depth lives here.

If the body is growing past ~500 lines, that is the signal to split. Move the detail into
`reference/<topic>.md` and have the body say *when* to go read it. A body that inlines
everything makes the whole skill expensive every time it loads, even for the 80% of uses that
never needed the detail.

## Body shape

Write the body as a **decision procedure**, not an essay:

- Lead with when this applies and when it does not.
- Give the steps in the order they are actually taken.
- Say what each step is for, so a step can be skipped intelligently.
- Call out the failure modes — the mistakes this skill exists to prevent.
- Keep examples concrete and from this project.

Do not restate the core contract. The agent already has it. A skill earns its place by saying
what the contract cannot know.

## Frontmatter

```yaml
---
name: release-cut          # lowercase kebab-case; also the directory name
description: >             # see above — this decides everything
  …
version: 1                 # optional
scope: ["package.json", "CHANGELOG.md"]   # optional: globs that hint relevance
requires: ["service:github"]              # optional: mcp:<id>, service:<name>, db, browser, lsp
mode: review                              # optional affinity: plan | review | debug
---
```

`scope` annotates the roster when an open file matches — it is a hint, never an auto-load.
`requires` hides the skill as unavailable-with-reason when the capability is absent, so a
procedure that depends on tools the session lacks cannot be loaded and then fail halfway.

## Offering to write one

Propose a skill when you have just executed a non-obvious repeatable procedure and recognise
it will recur — the same instinct as filing a ticket for a problem you noticed. Offer it, let
the user agree, then write it. Do not write skills unprompted mid-task, and never for a
one-off.
