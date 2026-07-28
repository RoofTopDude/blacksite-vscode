# Using the Codebase Map

The Codebase Map is a rendered star-field of your repository. Files are stars, relationships are
arcs, and folders form coloured territories. A separate Services lens rolls files up into
deployable units and the typed routes between them.

You do not need a graph-theory background to use it. Start by searching for a file you know,
selecting it, and choosing **Focus this neighborhood**.

It is genuinely useful to look at. But the reason it exists is that **the agent queries the same
graph you are looking at.** When it needs to know what a change reaches, it does not grep for import
statements and guess — it asks the index.

For the architecture behind it, read [Codebase Map](../codebase-map.html). This page is about using
it.

---

## Opening it

- **Blacksite: Open Codebase Map** — in the sidebar container.
- **Blacksite: Open Codebase Map in Editor** — as a full editor tab, which is where you want it for
  real exploration.
- **Blacksite: Rebuild Codebase Map Index** — force a full reindex if something looks stale.

The index builds in the background on first open and updates as you work.

---

## Reading the map

**Stars are files.** Size reflects significance—a file everything imports is bigger than a leaf.
Colour identifies the file's folder territory, so nearby areas stay recognizable across sessions.
A small role mark distinguishes tests, configuration, docs, styles, data, types, assets, and entry
points without turning star colour into a second legend.

**Arcs are relationships**, and they come from several layers:

- **Imports** — resolved per language, not pattern-matched. TypeScript path aliases from
  `tsconfig.json`, Go module paths, Java and C# namespaces, Python packages and re-exports, PHP
  autoload rules.
- **Service relationships** — one service calling another's HTTP API, publishing an event another
  consumes, or writing a table another reads. Detected across roughly ten frameworks.
- **Symbol relationships** — calls, references, and inheritance, from your installed language
  servers. Off by default; see [performance](#performance) below.
- **Notes** — durable annotations, including relationships the indexers cannot see.

**Territories are neighborhoods.** Distinct codebases within a workspace get their own region,
subdivided by folder. Controlled by `blacksite.graph.neighborhoods`
(`auto` / `on` / `off`).

**The Services lens is a different view of the same index.** It shows one diamond per deployable
service and bundles verified API, event, shared-data, and configuration relationships between them.
Switch back to Files when you need individual source files.

### On the precision of service edges

A naive service matcher pairs any route string with any similar-looking URL and produces a hairball.
Blacksite requires the client side of a call to be *verified* before drawing the edge. The
consequence is that a line on the map means a call that plausibly exists, rather than two strings
that rhyme — and that some real relationships are missing rather than invented. That trade is
deliberate. If a relationship matters and the indexer cannot see it, attach a note; notes become
first-class edges.

---

## Navigating

| Action | How |
| --- | --- |
| Pan | Drag the field |
| Zoom | Scroll, or the zoom controls |
| Reset view | The ⌖ button |
| Select | Click a star |
| Search | The search box in the command panel |
| Filter | The layer and link-type toggles |

Selecting a star opens the inspector: its path, role, connection count, change heat, and any notes
attached to it. From there you can focus its neighborhood — isolating that file and everything it
touches, which is usually the view you actually wanted.

---

## Live agent traces

When the agent works, the map shows it. Files it reads pulse; files it edits flare; the working
directory of a shell command lights up.

Traces fade over `blacksite.graph.traceFadeSeconds` (default 45). Shell activity can be turned off
with `blacksite.graph.traceShellEvents`.

This is the single most useful thing about having the map open while the agent runs. You can see at
a glance whether it is working where you expected — and when it wanders into an area you did not
anticipate, that is usually worth interrupting to ask about.

---

## Ticket heat

Turn on the **Ticket heat** layer to see where open work is concentrated. Tickets attach to files or
folder areas; the map resolves that territory against the current index and weights it by priority.
The busiest files glow cool cyan, deliberately distinct from the warm git-change heat layer.

Select a glowing file to inspect it, then open the Tickets view or Board for the full work item.
See [Tickets & the Board](tickets-and-board.html) for how territory is recorded.

---

## The queries the agent can run

The map is the agent's structural sense. These are the tools it has against it, and knowing them
tells you what to ask for:

**`map_overview`** — orient in the whole workspace. Detected projects and project-to-project
references, major code areas, dependency hubs, cross-service flows, structural findings (cross-project
cycles, orphan files, single-access pockets), index coverage, and recent notes. Every section is
ranked and capped, so it is the top of a list rather than the whole list.

**`map_find`** — enumerate files with filters and ranking. "Which files are in `src/graph`", "the
most-connected files under this area", "Python files with no dependents", "what has churned most
recently here". Each result carries its area, language, dependent/dependency counts, size, and
recent-commit count.

**`map_relationships`** — one hop out from a file: what it imports, what imports it, cross-service
relationships with evidence, and attached notes.

**`map_impact`** — the transitive blast radius, N hops out, with the concrete edge chain connecting
each file back to the seed. Grouped by depth and by area, so you can see immediately whether a change
is contained or reaches across the system. This is the one to ask for before touching a shared
contract.

**`map_path`** — how two files are actually connected: the shortest chains between them, one entry
per hop with the edge kind. For "how does this webview message reach the store" — you know both ends
and need the middle.

**`map_note_*`** — add, list, update, and remove durable notes.

### Asking for these directly

You do not have to name the tools, but naming the *question* helps:

- *"What's the blast radius if I change the session store?"* → `map_impact`
- *"How is the chat input connected to the provider client?"* → `map_path`
- *"What are the dependency hubs in this repo?"* → `map_overview`
- *"Which files under src/lsp have no dependents?"* → `map_find`

---

## Notes: the map's memory

Notes are how knowledge survives the end of a session.

The agent attaches them as it learns things — the durable, non-obvious *why*. Not "this file exports
a component" (visible from the code) but "this retry backoff must stay under the gateway TTL or
requests double-fire". Each note has a category: **architecture**, **gotcha**, **todo**, **risk**, or
**question**.

Notes can attach to a **file** or to a **relation between two files**. Relation notes are how you
record an edge the indexers cannot see — an event flow, an IPC route, a config-to-consumer link. They
render on the map as labelled connections and are traversable as a layer in `map_impact` and
`map_path`.

Before adding, the agent lists existing notes and updates a related one rather than creating a
near-duplicate, keeping a bounded revision history.

Browse them all with **Blacksite: Open Map Notes Timeline**, which shows them chronologically
alongside git history and diffs.

You can and should write notes yourself. A note you leave is context every future session inherits.

---

## Performance

Force-directed layout — treating edges as springs and nodes as mutually repelling particles —
produces genuinely good results, because related things cluster naturally. It is also roughly O(n²)
per tick: beautiful at 2,000 nodes, unusable at 60,000. Above a threshold of 6,000 nodes Blacksite
switches to a linear-time phyllotaxis-style packing instead.

You control the caps with `blacksite.graph.performanceProfile`:

| Profile | For |
| --- | --- |
| `safe` | Conservative caps, average machines |
| `balanced` | Default. Normal monorepos |
| `large` | Capable workstations |
| `extreme` | Large machines and very large workspaces |
| `custom` | Use the explicit advanced caps |

The advanced caps — `maxIndexedFiles`, `maxRenderedStars`, `maxRelationshipEdges` — each default to
`0`, meaning "use the profile". Set them only when you need something the profiles do not give you.

### Background symbol indexing

`blacksite.graph.backgroundSymbols` (off by default) indexes call, reference, and inheritance
relationships across the whole codebase using your installed language servers. It runs on an idle
budget and pauses while you edit, but it is genuinely more expensive than import scanning.

Turn it on when symbol-level precision is worth it. Leave it off otherwise — and note that while it
is off, `map_relationships` reports `symbolRelationsUnavailable: true` rather than silently returning
an empty set, so neither you nor the agent mistakes "not analyzed" for "none".

---

## Related

- [Codebase Map architecture](../codebase-map.html) — the indexing, layout, and rendering design
- [Tool Reference](tool-reference.html) — the full map tool surface
- [Settings & Commands](settings-and-commands.html) — every `blacksite.graph.*` setting
