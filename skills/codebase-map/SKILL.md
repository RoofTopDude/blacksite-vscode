---
name: codebase-map
description: >
  Working the Codebase Map deliberately — orienting with map_overview, enumerating an area
  with map_find, sizing a change with map_relationships and map_impact, and tracing wiring
  with map_path. Use before structural or architectural work, before editing anything
  shared, or whenever the answer is "which files does this actually touch".
version: 1
mode: plan
---

# Working the Codebase Map

The workspace is continuously indexed into a relationship graph: projects, per-language
alias-aware imports, cross-service edges (API calls, events, shared data/tables, config),
symbol-level call/reference/supertype edges when the background sweep is on, git churn, and
durable notes from prior sessions.

Two parts of it are **already in your context every turn** — the whole-workspace
"Architecture map" and the "Map neighbourhood of the open files". Read those before spending
a call re-asking what they already answer. That is the single most common wasted map call.

## The five beats

**1. Orient — `map_overview`.** Start broad or architectural work here: project boundaries,
major areas, dependency hubs, cross-service flows, structural findings (cycles, orphans,
single-access pockets), recent notes. One call. Every section is a ranked top-N, not an
exhaustive list — treat a short list as "the top few", not "all there is".

**2. Locate — `map_find`.** Turn an area the overview named into actual files. Filter by
area, glob, language, connectivity, or churn; rank by what matters — `dependents` to find
the risky files, `churn` to find the active ones. Prefer this over globbing the filesystem:
it answers with the index's knowledge of each file, not just a path list.

**3. Scope — `map_relationships`, then `map_impact`.** Before editing, `map_relationships`
on the files you expect to touch gives one hop: imports, imported-by, service links with
evidence, attached notes.

When the change touches anything shared — a widely-imported module, a public contract, a
config file, anything the overview called a hub — follow with `map_impact`. It walks the same
graph transitively and tells you how far the change actually reaches and into which areas.
**Sizing a blast radius from one hop is how a "small" change turns into a broken build.**

**4. Trace — `map_path`.** When you know the two ends of a behaviour but not the middle,
this returns the concrete chains between two files across import, service, and symbol layers.
Use it instead of guessing at the wiring or grepping your way along it.

**5. Record — `map_note_*`.** See the `map-notes` skill; after an edit a note is required.

## Reading results honestly

Direction is uniform across every map tool: **outbound / `dependencies` means this file
depends on the peer; inbound / `dependents` means the peer depends on it.** The underlying
layers do not agree about this natively — symbol `reference` edges are stored
definition→referencer — so the traversal layer normalizes them before walking. You can trust
the direction the tool reports.

When a result says `truncated`, reports `matched` higher than what came back, or shows
`symbolLayer: "inactive"`, that is a **real limit on what you were told**. Widen the query or
say what you could not see. Reading a capped list as the complete answer is how a
confident-sounding wrong conclusion gets made.

## The map as architectural feedback

Read the graph as evidence about the design, not as a cosmetic target:

- Dense hubs should be deliberate composition points. An accidental hub is a finding.
- Clusters should correspond to real domains.
- Cross-service, event, config, and data edges should have visible evidence behind them.

Do not contort code to make the graph look symmetrical.

## Anchoring plans to the map

Once `map_relationships` / `map_impact` have told you a phase's real surface area, record it
as that phase's `files` (`plan_create` phase `files`, or `plan_update`'s `phaseFiles`). Those
ids ride in the plan summary on every later turn, so a resumed session navigates straight to
the work instead of re-deriving it from prose — and the user can jump from a phase to the
file or its place on the Map. Update the list when investigation changes the phase's shape; a
territory that no longer matches the work is worse than none.
