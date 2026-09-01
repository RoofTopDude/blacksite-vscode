---
name: map-notes
description: >
  Writing durable Codebase Map notes that compound instead of becoming clutter — file notes
  versus relation notes, classifying and titling them, refining rather than duplicating, and
  pruning notes an edit has invalidated. Use when recording why a boundary or constraint
  exists, and before finishing any turn that edited files.
version: 1
---

# Map notes

Notes render directly on the Codebase Map the user is watching, and in their Notes timeline.
They are the map's living documentation: `map_relationships` returns them, the workspace-state
block surfaces recent ones, and a future session inherits them without re-deriving anything.

## The rules that matter

**After an edit, a note is required.** What changed and *why*, on each edited file, before you
finish. If you skip it the harness will prompt you. Purely reading a file needs no note.

**Record the durable, non-obvious thing — not narration.** A file's role, a constraint or
gotcha ("X must stay in sync with Y"), the rationale behind a decision. If the fact is obvious
from the code or from the import graph, it is not worth a note. "Added a helper function" is
narration; "this helper exists because the provider returns two shapes and the caller cannot
tell them apart" is a note.

**Refine, don't duplicate.** Call `map_note_list` on the file(s) first. If a related note
exists, `map_note_update` it — the map keeps a bounded revision trail, so updates read as
accumulating knowledge and the user can audit the trail in the Notes timeline. Near-duplicate
notes are clutter, and clutter is what makes people stop reading notes.

**Prune what you invalidate.** If your edit makes an existing note wrong, update it or
`map_note_remove` it. A stale note is worse than no note.

## File note vs relation note

- **File note** (`from` only) describes that file: its role, a constraint on it, why it is
  shaped the way it is.
- **Relation note** (`from` + `to`) captures a meaningful **non-import** link worth showing
  spatially — event flows, IPC/message routes, config-to-consumer links, "this handler
  triggers that service". These are the edges the import graph cannot see, which is exactly
  what makes them worth recording.
- Set `relationKind` when the pair could carry more than one kind of edge (e.g. both an
  import and an event flow) so it is clear which one you mean.

## Classify and title

Set `category`: `architecture`, `gotcha`, `todo`, `risk`, or `question`. This drives the
coloured badge on the map and the filter chips in the Notes timeline — it is what makes the
notes read as classified knowledge rather than a flat log.

Add a short `title` (≤ 80 chars). It is what makes the note skimmable in the timeline and on
the map's floating edge labels.

## Length

**Tight, not terse — ≤ 1000 characters.** You have room for the full non-obvious reasoning: a
title plus a few sentences. Write for a human skimming the map, not for yourself, and stop
once the "why" is captured.
