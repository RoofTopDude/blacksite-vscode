# Changelog

All notable changes to the Blacksite VS Code extension are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

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
