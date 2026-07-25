# Provider-neutral agent environment

Blacksite gives every supported model provider the same agent environment. Provider adapters translate wire formats only; they do not decide what the agent can understand or do.

## Environment contract

Every provider turn receives three coordinated inputs:

1. A stable system contract describing behavior, navigation, editing discipline, planning, memory, verification, and tool-selection expectations.
2. The tools that are actually available in that session. Optional families are advertised only when their backing provider is configured.
3. A live workspace block appended at the message tail. It is rebuilt before every model turn, including internal turns after tool execution and delegated-subagent turns.

The stable system contract remains cacheable. Volatile state stays at the message tail, so accuracy does not require invalidating the provider's prompt cache.

## Live workspace block

The block is a compact operating picture rather than a source dump. It includes:

- workspace roots, active/open files, project stack, package manager, and test framework;
- current diagnostics and git state;
- repository instruction files (`.blacksite/instructions.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `.github/copilot-instructions.md`);
- Base Context, project memory, UI preferences, and persisted plans;
- configured MCP targets;
- a compact architecture overview from the Codebase Map, plus the map neighbourhood (area, immediate blast radius, attached notes) of the files currently open.

Root instructions always apply. Instructions on the active file's ancestor chain are loaded as scoped guidance. Once the agent chooses another target directory, the system contract requires it to check for nearer scoped instruction files before editing there.

Refresh failures are fail-soft: a transient filesystem, git, or indexing error retains the last known-good block instead of stopping the agent or replacing its context with an empty snapshot.

## Architectural understanding

The Codebase Map is the relationship substrate shared by the UI and agent runtime. It precomputes project topology, imports, project references, service relations, optional symbol relations, and durable notes.

Five tools expose that substrate, one per question the agent actually has:

- `map_overview` — whole-workspace orientation: index coverage, project boundaries, major areas, dependency hubs, cross-service flows, structural findings (cross-project cycles, orphan files, single-access pockets), and recent map knowledge. Every section is a ranked top-N.
- `map_find` — drill-down enumeration: filter the indexed nodes by area, glob, language, connectivity, or git churn, and rank by any of those. This is what turns an area named by the overview into the actual file list, without falling back to filesystem globs.
- `map_relationships` — one-hop, file-level evidence: imports, imported-by, service edges, symbol edges when enabled, the file's own area/language/churn, and attached notes.
- `map_impact` — the transitive version: the full N-hop dependent (or dependency) closure of a change set, bucketed by depth, grouped by area, each reached file carrying the edge chain back to its seed. This is the pre-change question `map_relationships` cannot answer alone.
- `map_path` — the concrete chains connecting two files, across import, service, and symbol layers.

Direction is uniform across all five: outbound / `dependencies` means this file depends on the peer; inbound / `dependents` means the peer depends on it. The layers do not agree about this natively — symbol `reference` edges are stored definition→referencer — so the traversal layer normalizes them before walking.

The compact `map_overview` orientation is injected automatically into the live workspace block, as is the map neighbourhood of the user's open files. An agent therefore begins with both global bearings and local ones, and requests structured evidence only when the task needs more.

Plans anchor to the map: a plan phase can declare the `files` it expects to touch, and those ids ride in the plan summary on every later turn so a resumed session navigates to the work instead of re-deriving it from prose.

## Parent and delegated agents

Parent sessions and delegated sessions use the same static contract, live workspace provider, tool gating, path dialect, approval system, diagnostics, and architecture graph. A delegated lane may use a different model or provider, but it does not receive a weaker or frozen environment.

Subagents still receive their own focused task, context budget, timeout, and tool budget. That isolation keeps the parent focused on orchestration while preserving the same project understanding inside each lane.

## Code-intelligence contract

All providers use the same `CODE_INTEL_TOOLS` schemas and the same `LspService`; provider adapters contain no LSP policy. The service exposes root-aware symbols, navigation, hierarchy graphs, hover/signatures, diagnostics, actions, formatting, inlay metadata, semantic rename, and exact target-range insertion/replacement.

Language-provider calls report typed outcome metadata instead of collapsing empty, failed, timed-out, unavailable, and cancelled requests. Diagnostics identify freshness and measured coverage; a workspace published-cache read is never presented as proof that the whole project is clean. Compiler, linter, and test commands remain the stronger verification layer.

Mutating code-intelligence calls share a per-workspace transaction queue across parent and delegated sessions. They bind target/document versions, validate every provider-produced URI, preview and approve text/resource/command plans, report touched files and save state, and attach post-edit diagnostic deltas. Command-side mutations that VS Code cannot fully preview require explicit approval and remain uncertain on timeout because the underlying command may still finish internally.

## Invariants

- Model vendors are transport choices, not capability tiers.
- Workspace-relative, forward-slash paths are the shared identity across file tools, code intelligence, git, and the map.
- Actual advertised tools are the capability source of truth.
- Repository policy is loaded before work and scoped policy is checked before edits.
- Architectural orientation is available without repeated repository-wide searches.
- Post-edit decisions see post-edit workspace state.
- Mutations remain approval-aware and report diagnostics in the same result.
- Large outputs, long histories, and long-running processes have bounded continuation mechanisms rather than silent truncation.

## Extension points

New model providers should implement the normalized provider-turn contract and reuse `AgentSession`; they should not fork tool assembly or workspace-context behavior. New workspace intelligence belongs in the live context provider or a conditionally advertised tool family. New architectural facts should enter the shared graph so the map UI, automatic orientation, and explicit relationship tools stay consistent.
