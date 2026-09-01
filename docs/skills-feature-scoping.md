# Skills as a first-class feature — scoping

Status: **v1 implemented.** This document defines what a "skill" is in Blacksite,
why the existing harness surfaces do not already cover it, how it interacts with
every one of those surfaces, and the phased path. §13 records what v1 actually
shipped and where each piece lives.

## 1. The gap

The harness already has several ways to shape agent behaviour, but they cluster
in three corners and leave one empty:

| Surface | Loaded | Cardinality | Authored by | Mutually exclusive? | Carries |
| --- | --- | --- | --- | --- | --- |
| Static system contract | always | 1 | us | — | universal behaviour |
| Base Context / project memory / repo instruction files | always | few | user / agent | no | **facts** about this project |
| Request modes (`auto`/`plan`/`review`/`debug`) | per request | 4, fixed | us | **yes** | an operating *method* |
| Subagent profiles | per delegated lane | few | us (+ custom) | one per lane | a lane's focus |
| MCP servers | when configured | few | user | no | external *tools* |
| Plans / plan docs | when work is active | 1 active | agent | — | *this* work, now |

Nothing in that table is: **numerous, authored by the user or the agent,
loaded only when a task matches, composable (several at once), and able to carry
runnable resources as well as prose.** That is the skills quadrant.

A skill is a named bundle of procedural knowledge — a `SKILL.md` with
frontmatter, optionally plus reference files and scripts — that the agent loads
on demand when the task matches its description, and that then specialises the
core contract for the duration of that work the way a request mode does, but
authored rather than built in, and dozens rather than four.

### What a skill is not

- **Not Base Context.** Base Context is *what is true about this repo* and is
  always in the prompt. A skill is *how to do a class of task* and is loaded only
  when that task is at hand. A skill that needs a project fact should point at
  Base Context, not copy it.
- **Not a plan.** A plan tracks one piece of work through phases with execution
  gating. A skill is reusable across every instance of that kind of work and
  holds no per-run state. A skill can *ship a plan template*; it is not itself a
  plan.
- **Not an MCP server.** MCP adds tools. A skill adds knowledge — including,
  usefully, *how to drive a particular MCP server well*.
- **Not a request mode.** Modes stay a small fixed set of mutually exclusive
  operating postures. Skills compose underneath whichever mode is active.

## 2. Anatomy

```text
.blacksite/skills/<slug>/
  SKILL.md            # required: frontmatter + progressive-disclosure body
  reference/*.md      # optional: loaded only when SKILL.md tells the agent to
  assets/*            # optional: templates, schemas, checklists, fixtures
  scripts/*           # optional: runnable helpers (treated as workspace code)
```

`SKILL.md` frontmatter:

```yaml
---
name: release-cut                     # unique slug, kebab-case
description: >                        # THE discovery surface — see below
  Cut a Blacksite extension release: version bump, changelog section in the
  house voice, vsix package + verify, release notes. Use when the user asks to
  release, cut a version, or publish a build.
version: 1
scope: ["package.json", "CHANGELOG.md"]   # optional: globs / map areas that hint relevance
requires: []                              # optional: ["mcp:linear", "service:github", "db"]
allowed-tools: []                         # optional: may only NARROW a lane's tools, never widen
mode: auto                                # optional affinity: review | debug | plan
origin: bundled | workspace | user       # set by the loader, not the author
---
```

The **`description` is the entire discovery mechanism** and the only part of a
skill that is in context every turn before it is loaded. It must say *what the
skill does* and *what situations trigger it*, in the third person, concretely. A
weak description means the skill never fires. The authoring UI lints this
specifically (section 6).

The **body** obeys progressive disclosure:

1. `description` — always in context (one line in the roster).
2. `SKILL.md` body — pulled in only when the agent calls `skill_read`. Target
   ≤ ~500 lines. This is the overview and the decision procedure.
3. `reference/*.md` and `assets/*` — read individually, on demand, when the body
   directs the agent to them. Unbounded depth lives here.

### Locations & precedence

| Origin | Path | Trust | Shared with team | Overridable |
| --- | --- | --- | --- | --- |
| bundled | shipped in the extension | first-party | n/a | yes, by name |
| workspace | `.blacksite/skills/` | repo-level (could arrive via a PR) | yes (committed) | yes, by name |
| user | `~/.blacksite/skills/` | user wrote it | no | — |

Name collision resolves **workspace > user > bundled**. The Skills panel shows
the origin badge and which copy won.

## 3. Discovery & activation

### Roster in the live workspace block

`buildWorkspaceContextBlock` gains a **"Skills available"** section, alongside
the existing MCP-servers section and built the same way — volatile state at the
message tail, never the cached prefix, fail-soft on a read error:

```text
Skills available (call skill_read with the name to load the full procedure):
  release-cut — Cut a Blacksite extension release: version bump, changelog … [scope match: package.json]
  pr-house-style — Review a PR against this repo's conventions …
  db-migration — Author and verify a schema migration … [requires db — not connected]
Loaded this session: pr-house-style
```

One line per skill. Scope-glob matches against the open/active files are
annotated as a hint. Unmet `requires` are shown with the reason, exactly as
service tools are hidden-with-reason today.

### Load protocol

The static contract gains ~4 stable lines: skills exist, the roster is in the
workspace block, load one with `skill_read` before starting work it covers,
treat a loaded skill as specialising this contract but never overriding user
scope / repo instructions / approval gates / the live tool catalog.

`skill_read(name)` injects the `SKILL.md` body as a distinct block that
**persists for the rest of the session**, mirroring `_requestModePrompt`. Join
point is `AgentSession._dynamicContext()`:

```ts
// today:  [this._requestModePrompt, this._workspaceContext]
// becomes:[this._requestModePrompt, ...this._loadedSkillPrompts, this._workspaceContext]
```

Loaded skill slugs go into `exportState()` / `importState()` (next to
`requestMode`) so **checkpoint resume re-hydrates them**, and the compaction
summary records "skills active: X, Y" so compaction re-summarises rather than
silently dropping them. The plan-continuation agent inherits the loaded set.

### Activation paths, in order of directness

- **Agent judgment** (v1 default): reads the roster, calls `skill_read`.
- **`/skill <name>`** slash command and a Skills-panel toggle (user forces a
  load). Extend `SlashArgKind` with `"skill"` so the chat input autocompletes
  from the roster; add `/skills` to list.
- **Scope-glob suggestion** (v2): a skill whose `scope` matches an open/edited
  file is marked in the roster; still the agent's call to load.
- **Plan/phase binding** (v2): a plan phase names a `skill` to load when it
  becomes active; recorded in phase rationale so a resumed session reloads it.

## 4. Bundled skills — harness fluency only

We ship a starter set, and they are **strictly about using this harness well** —
not domain or language knowledge, which is left to the user and the agent.

Candidate bundled skills (each corresponds to a surface the base prompt
currently over-explains to every request):

| Skill | Covers |
| --- | --- |
| `codebase-map` | the five-beat orient→locate→scope→trace→record workflow; when each `map_*` tool earns its call; reading the map as architectural feedback |
| `map-notes` | file-note vs relation-note, classify/title/refine-don't-duplicate, prune-what-you-invalidate |
| `planning-discipline` | ticket vs plan vs todo split, plan `blocks`, acceptance criteria, execution gating, `maxIterations` loops |
| `delegation` | sequential vs parallel fan-out, `complexity` rating, `subagent_followup` vs respawn, reading a failed lane |
| `execution-runs` | when a run beats a unit test; `sequence_discover` → `execute` → `inspect`; linking runs to plan/phase/ticket; video vs screenshots |
| `verification-gate` | the host verification gate; smallest targeted test; diagnostics `freshness`/`delta` semantics |
| `pr-workflow` | `git_op context` as the entry point, base-branch resolution, PR templates, the integration tools |
| `mcp-fluency` | the discovery flow, `mcp_list_tools` then `mcp_call_tool`, the credential/allowlist model |
| `question-cards` | when to ask, the altitude of the decision, authoring real previews not wireframes |
| `context-hygiene` | what belongs in Base Context vs memory vs a skill vs a plan doc |

**Architectural payoff.** Much of `buildStaticSystemPrompt` is deep guidance for
surfaces that are irrelevant to most requests (the map five-beat, run authoring,
delegation trade-offs, note taxonomy). Moving that into bundled skills lets the
**always-cached prefix shrink to the universal contract**, with a one-liner per
surface pointing at its skill. Per-turn token cost drops for the common case;
the deep guidance arrives at full fidelity exactly when that surface is in play.
This is the single strongest reason to build the feature.

Bundled skills are read-only, first-party trusted, and eligible for
scope/trigger auto-suggestion earlier than third-party skills. A workspace skill
of the same name shadows one.

## 5. Authoring — agent

`skill_write` tool (v1): create or update a skill under `.blacksite/skills/`.
Goes through the normal file-write approval and diff — a skill is workspace
content. The agent proposes one the way `ticket_file` proposes work it noticed:
when it executes a non-obvious repeatable procedure and recognises it will recur,
it offers to capture it as a skill rather than letting the method die at the next
compaction. It never writes a skill silently or mid-task; it offers, the user
accepts, the file is written and shown.

Guardrails: `skill_write` cannot target `~/.blacksite/skills/` (user-only space)
or overwrite a bundled skill in place (it writes a shadowing workspace copy and
says so). Frontmatter is validated before the file lands.

## 6. Authoring — user UI

A **Skills panel** (`blacksiteSkills` view container + `blacksite.skills.open`),
following the existing panel pattern (Plans, Tickets, Map, Runs, Data…):

- **List** every skill with origin badge, enabled/disabled toggle, scope, load
  state, and "which copy won" on a collision.
- **View / edit source** — open `SKILL.md` in the editor.
- **New skill — guided form**:
  - name, description, "when to use" triggers, body (markdown editor),
    optional scope globs, `requires`, `allowed-tools`, `mode` affinity;
  - **live frontmatter lint** and a **description-quality check** (is it third
    person, does it name trigger situations, is it specific) — the description
    is the discovery surface and the most common failure;
  - **progressive-disclosure warnings**: SKILL.md over ~500 lines, or content
    that should be a `reference/` file;
  - **"test activation"**: given a sample prompt, show whether the roster line
    would plausibly trigger a load.
- **Agent-assisted mode**: the user describes the workflow in prose; the agent
  drafts `SKILL.md`; the user edits and saves. This is the expected common path
  and reuses `skill_write` under the hood.
- **Scaffold from selection**: an editor-context action that seeds a skill from
  highlighted code/notes.

Disabling a skill in the panel removes it from the roster without deleting the
file. Trust: a `.blacksite/skills/` folder in an untrusted workspace is listed
but not loadable until the workspace is trusted (workspace trust is already
false-by-default here).

## 7. Interaction with every harness surface

| Surface | Interaction |
| --- | --- |
| **Static system contract** (cached prefix) | + ~4 stable lines: skills exist, roster is in the workspace block, load protocol, precedence. Roster itself never goes here. Deep per-surface guidance migrates *out* to bundled skills (section 4). |
| **Live workspace block** (per-turn tail) | + "Skills available" section: `name — description`, scope-match hints, unmet-`requires` reasons, "Loaded this session" line. Fail-soft like the rest of the block. |
| **Loaded-skill injection** | New `_loadedSkillPrompts: string[]`, joined in `_dynamicContext()` between the request-mode prompt and the workspace block. Session state: exported for checkpoint resume, re-summarised at compaction, inherited by plan-continuation. |
| **Request modes** | Skills compose *under* the active mode. Precedence: user explicit scope > repo instruction files > approval gates > request mode > skill > core contract. A skill cannot relax a mode's read-only posture. `mode:` frontmatter is an affinity hint, not a switch. |
| **Subagents & profiles** | v1: `subagent_spawn({ skills: [...] })` injects those `SKILL.md` bodies into the lane's frozen prompt; the lane cannot discover or load skills itself (keeps its context tight). v3: collapse `builtin-subagent-profiles.ts` into skills with an `agent:` block — a profile *is* a skill. |
| **Plans & plan docs** | A skill can ship a plan template (`blocks` + phase skeleton) the agent instantiates via `plan_create`. A phase can name a `skill:` to load on activation. "Activated skill X" is recorded in plan/phase rationale so a resumed session reloads it. |
| **Tickets & loops** | A ticket may carry a `skill` hint label; loop lanes pass it to each spawned lane. Skill activation is noted in ticket comments for the audit trail. |
| **Base Context & memory** | Hard separation: Base Context = always-loaded facts, skills = on-demand procedures. Memory may record "for tasks like X, load skill Y" — a learned routing hint. Lint rejects a skill that just restates Base Context. |
| **References** | Skill-bundled files are read via `skill_read({ name, file })`, path-checked to stay inside the skill dir — *not* the `reference_*` tools, which are conversation attachments. A skill *may* instruct `reference_read({ path })` on a workspace PDF. |
| **MCP** | `requires: ["mcp:<id>"]`; roster shows the skill as unavailable-with-reason when unmet. Skills are the natural home for "how to drive this MCP server well." |
| **Approvals & permissions** | A skill can never grant permission or auto-approve. `allowed-tools` may only *narrow* a lane. A skill wanting a normally-prompted command still prompts. Loading a skill is itself non-destructive, no approval needed. |
| **Codebase Map** | Skills don't touch the graph substrate. `scope` may name a map area (`area:webview`), resolved through `map_find`. A skill can encode repo-specific `map_*` usage patterns. |
| **Execution Runs / sequences** | A skill can bundle a named sequence / assertion template for a recurring verification ("to verify checkout, run this sequence"). Parent-only, consistent with runs being parent-owned. |
| **Tool catalog & gating** | New `SKILL_TOOLS`: `skill_list`, `skill_read`, `skill_write`. Gated on the feature flag + at least one skill present. Entries added to `validateToolInput` / `coerceToolInput`; `resolveToolDispatch` → `skill.*` runtime types. |
| **question_card / UI** | Not a primary surface. The agent may *propose* a skill in a normal chat line ("this looks like a migration — load `db-migration`?"); the user confirms. No preview cards needed. |
| **Slash commands / commands / menus** | `/skill <name>`, `/skills` added to `SLASH_COMMANDS`; `SlashArgKind` gains `"skill"`. `blacksite.skills.open` command + `blacksiteSkills` panel. Editor-context "Scaffold skill from selection." |
| **Data workbench** | A skill can encode house SQL conventions, known-safe query shapes, and the DB's semantic layer; loaded when `db_*` tools are in play. |
| **Checkpoints / compaction / continuation** | Loaded slugs in `exportState()`; compaction summary lists active skills; continuation agent inherits them. |
| **PAU** | Loaded skill blocks are measured like any context; the PAU panel attributes token load to "skills" so the cost of a fat `SKILL.md` is visible — pressure toward tight authoring. |
| **Execution log / transcript** | `skill_read` / `skill_write` logged like any tool. Transcript renders a compact "Loaded skill: X" card. |

## 8. New tools

- **`skill_list`** → roster with descriptions, origin, availability, scope
  matches, load state. Largely redundant with the workspace block for the
  parent, but needed for delegated lanes and for an unfiltered view.
- **`skill_read`** `{ name, file? }` — no `file`: the `SKILL.md` body, and the
  skill is marked loaded for the session. `file`: a bundled reference/asset
  file, resolved and symlink-checked to stay inside the skill directory.
- **`skill_write`** `{ name, markdown, files? }` — create/update a workspace
  skill; normal file-write approval + diff; frontmatter validated first;
  cannot target user space or overwrite a bundled skill in place.
- *(later)* **`skill_unload`** if session context pressure warrants it.

## 9. Security & trust

- **Bundled scripts are workspace code.** A `SKILL.md` may instruct running
  `scripts/*`; that goes through the same allowlist and approval as any
  `shell_run`. Loading a skill never pre-approves its scripts.
- **Skill bodies are prompt-injection surface.** A workspace skill is trusted
  roughly at repo-instruction level *but ranked below* `AGENTS.md` / `CLAUDE.md`
  and below the user's live message, and can never override approval gates or
  scope. Untrusted workspace → listed, not loadable.
- **`description` is attacker-controllable and in every turn's context.** Cap
  its length, strip control characters, and treat it as data — never as tool
  directives — exactly as MCP tool descriptions are treated today.
- **User skills outrank workspace skills on trust** (the user wrote them) but not
  on precedence for the *same name*. The panel always shows origin.

## 10. Phased rollout

**v1 — core.** File format + loader; roster in the workspace block
(name/description/scope/requires); `skill_read` / `skill_list` / `skill_write`;
loaded-skill injection at the tail with state export and compaction handling;
`/skill` + `/skills`; Skills panel (list, enable/disable, view/edit source,
agent-assisted "new skill"). Ship the bundled harness skills from section 4 and
begin trimming `buildStaticSystemPrompt` in step. No auto-activation.

**v2 — routing & reach.** `scope`-glob suggestion in the roster; `subagent_spawn`
`skills:` param; plan/phase `skill:` binding; MCP `requires:`; bundled sequence
templates; the full guided authoring form (lint, description-quality check,
disclosure warnings, test-activation); PAU attribution.

**v3 — unification.** Subagent profiles become skills with an `agent:` block;
learned routing hints from memory; team skill sharing / registry.

## 11. Invariants

- Skills specialise the contract; they never override user scope, repo
  instruction files, approval gates, or the live tool catalog.
- The skill roster is volatile state at the message tail, never the cached
  prefix.
- A loaded skill is session state: it survives turns and checkpoint resume, and
  is re-summarised, not silently dropped, at compaction.
- Bundled scripts are workspace code: normal allowlist and approval apply;
  loading never pre-approves.
- Progressive disclosure is mandatory: `description` (always) → `SKILL.md` (on
  load) → `reference/` files (on demand).
- Bundled skills are harness fluency only. Domain, language, and product skills
  are the user's and the agent's to author.

## 12. Open decisions

1. **Auto-load bundled skills on surface use?** e.g. first heavy `map_*` call
   pulls in `codebase-map`. Cheaper prompt vs a surprise context jump. Leaning:
   suggest in the roster, do not force, until v2.
2. **One loaded-skill budget or unbounded?** A cap (e.g. 3) with an LRU drop vs
   trusting the agent. Leaning: soft cap surfaced in the roster, `skill_unload`
   in v2.
3. **`SKILL.md` vs `skill.md` vs a `skill.json` manifest.** Leaning: `SKILL.md`
   with YAML frontmatter, to stay portable with the wider ecosystem convention.
4. **Do workspace skills need per-skill trust prompts** on first load (like MCP
   servers), or is workspace-trust sufficient? Leaning: workspace-trust is
   enough for prose; first script execution prompts anyway.
5. **Should `skill_write` be allowed to author user-space skills** with an
   explicit path arg and a stronger confirmation, or stay workspace-only?
   *Resolved for v1: workspace-only. `skill_write` refuses a name owned by a
   personal skill rather than editing someone's private space.*

## 13. What v1 shipped

| Piece | Where |
| --- | --- |
| Format, lint, glob matching | `src/skills/skill-format.ts` |
| Discovery, precedence, enable state, asset containment | `src/skills/skill-store.ts` |
| `skill_*` tool contract | `src/skills/skill-tools.ts` |
| Tool schemas | `SKILL_TOOLS` in `src/tools/definitions.ts` |
| Loaded-skill context + state | `_loadedSkills`, `_skillContext()` in `src/agent-session.ts` |
| Roster in the live block | `skillRoster` in `src/workspace-context.ts`, built in `chat-provider.ts` |
| Static contract lines | `buildStaticSystemPrompt()` in `src/workspace-context.ts` |
| Skills panel (host) | `src/skills-provider.ts` |
| Skills panel (UI) | `src/webview/react/apps/skills/` |
| Bundled skills | `skills/`, staged to `out/skills` by `esbuild.mjs` |
| Tests | `tests/unit/skill-{format,store,tools}.spec.ts`, `tests/unit/agent-session.skills.spec.ts` |

Ten bundled skills ship: `codebase-map`, `map-notes`, `planning-discipline`,
`delegation`, `execution-runs`, `verification-gate`, `question-cards`,
`context-hygiene`, `tickets-and-queue`, `authoring-skills`.

**Two decisions worth recording**, because both went against the obvious choice:

1. **`skill_read` does not return the body as its tool result.** The body is
   handed to `AgentSession` out-of-band via `loadedBody` and injected at the
   message tail instead. A tool result is exactly what compaction drops — a long
   run would lose the procedure it was following partway through — and returning
   it in both places would put two full copies in context. One copy, in the
   durable place.
2. **Checkpoints carry skill bodies, not names.** Re-reading by name on resume
   would silently substitute whatever the file says now, including nothing at all
   if the skill was renamed or deleted meanwhile.

Deliberately **not** in v1: auto-activation (the roster hints, the agent decides),
`subagent_spawn({ skills })`, plan/phase binding, and the base-prompt trim that
bundled skills make possible. The trim is the one with the real payoff (§4) and
should follow once the bundled skills have seen use.
