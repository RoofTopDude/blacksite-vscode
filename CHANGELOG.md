# Changelog

All notable changes to the Blacksite VS Code extension are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## 0.3.0

### Added

- **LSP tool cancellation.** `code_*` tools now cancel in-flight language-server calls promptly
  when a turn is cancelled, instead of riding out the full timeout.
- **Actionable "no provider" errors.** Code-intelligence tools that come back empty now explain
  why when a language's recommended extension isn't installed, instead of a generic "no results"
  message.
- **Signature help on hover.** `code_hover` now shows the active parameter of an in-scope call
  signature, bolded, alongside the usual hover text.
- **Safer renames.** `code_rename` validates the position via the language server's own
  `prepareRename` first, surfacing the specific reason a rename can't proceed instead of a
  generic failure.
- **`code_inlay_hints` tool.** Inferred type and parameter-name hints for a file or range — most
  useful for untyped or dynamically-typed code.
- **Background-indexing prompt.** The Codebase Map's onboarding panel now also offers to turn on
  `blacksite.graph.backgroundSymbols` once a working language server is detected, instead of that
  setting being discoverable only via `settings.json`.
- **Saved Map views.** Name and save the current camera position, filters, and collapsed
  clusters, then jump back to it later from the Map toolbar.
- **Semantic zoom.** On a multi-codebase workspace, zooming out past the whole-map fit now
  collapses individual files toward their neighborhood's silhouette instead of rendering every
  star at every zoom level.
- **Cross-project cycle flagging.** A new opt-in "Cycles" layer highlights cross-codebase
  reference cycles detected in project manifests.
- **Cul-de-sac detection.** A new opt-in "Cul-de-sacs" layer dims probably-unused orphan files
  and highlights the single bridge edge into an isolated "pocket" subgraph within a neighborhood.

### Changed

- The Map's empty-state message now matches the rest of the panel's visual language (heading +
  subtext) instead of a single terse line.

## 0.2.0

### Added

- **Docked approval/question bar.** Pending questions and tool approvals now surface in a
  persistent bar pinned above the chat input, visible regardless of where the transcript is
  scrolled — including approvals raised inside subagent lanes, which were previously the most
  buried case (hidden behind both a collapsed lane tile and a collapsed tool-log summary). A
  "show in thread" link jumps to the full context when it's available.
- **Approval prompts for unrecognized shell commands.** A command that is neither explicitly
  allowed nor explicitly denied now prompts for approval instead of failing instantly.
  Explicitly denied commands (`blacksite.permissions.deniedCommands`) still hard-block with no
  prompt. Applies to both one-shot commands (`shell_run`) and long-running processes
  (`process_start`).
- **Project vs. all-projects "always allow."** Choosing "always allow" for a command binary now
  offers an explicit choice between persisting the rule for the current project only or for all
  projects, instead of always auto-detecting the scope.
- **Richer, more editable plans.** Phases and steps can now carry an optional risk note,
  dependency references, acceptance-criteria bullets, and a coarse complexity hint
  (small/medium/large). `plan_update` gained `reorderPhaseIds`, `reorderStepIds`,
  `moveStepId`/`moveStepToPhaseId`, and `insertPhaseBeforeId` for restructuring an existing plan
  without recreating it.

### Changed

- Tool guidance now nudges the agent to build larger plans phase-by-phase via `plan_create` +
  `plan_update`'s `addPhases`, rather than authoring every phase in one call.

### Fixed

- A shell command that isn't on the built-in or configured allowlist no longer fails outright
  with "not in the allowed list" — it now gets a chance to ask.
