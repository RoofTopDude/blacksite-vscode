# Architecture

How Blacksite is put together, for someone reading the source for the first time. For what the
extension *does*, read the [README](README.md) and [`docs/guide/`](docs/guide/); for the security
model, [`docs/security.md`](docs/security.md).

Line counts below are approximate and will drift. They are here to convey proportion — which parts
are large enough to need a map — not as figures to keep updated.

## The shape of it

Blacksite is a single VS Code extension, bundled by esbuild into one `out/extension.js`. There is
no server. Everything runs either in the **extension host** (Node) or in a **webview** (browser
context), and those two halves talk only by `postMessage`.

```
 VS Code extension host (Node)                    Webviews (browser)
┌────────────────────────────────┐               ┌──────────────────────────┐
│ extension.ts    activation     │               │ src/webview/react/       │
│   ├─ ChatProvider ─────────────┼─ postMessage ─┼→  apps/chat              │
│   ├─ GraphProvider ────────────┼───────────────┼→  apps/graph             │
│   ├─ PlanningProvider, …       │               │   apps/{plans,tickets,   │
│   │                            │               │    runs,loops,data,…}    │
│   ├─ AgentSession  ← the loop  │               └──────────────────────────┘
│   │    └─ tools ──┐            │
│   └─ stores (disk)│            │               packages/  (vendored, bundled in)
└───────────────────┼────────────┘                 local-runtime   fs/shell/git/MCP
                    │                              file-content    PDF/CSV/XLSX extract
                    ▼                              browser-bridge-protocol
        provider APIs (Anthropic, OpenAI,
        OpenRouter, Bedrock) — direct from
        the user's machine, no proxy
```

## The two halves

**Extension host.** Owns all state, all disk access, all credentials, and every network call.
Nothing in a webview is trusted with any of those.

**Webviews.** React apps under `src/webview/react/` (~34k lines), one bundle per surface, built by
Vite separately from the host bundle. They render and collect input; they never read the filesystem
or hold a key. Each is served by `webview-html.ts` under a strict CSP (`default-src 'none'`, a
per-render nonce, locally bundled fonts).

`src/webview/react/lib/protocol.ts` is the message contract between the halves. Host-side, each
provider's `onDidReceiveMessage` is the entry point — `ChatProvider._onMessage` and its two
siblings, `_onSettingsMessage` and `_onCredentialMessage`.

## The agent loop

`src/agent-session.ts` is the core. `AgentSession.send()` is the agentic loop: build a request,
stream a provider turn, run whatever tools the model called, feed the results back, repeat until
the model stops or a limit trips.

Around that loop sit the concerns that make long-horizon work survivable, each of which is why the
file is as large as it is: context compaction, tool-result overflow paging, verification and
map-note enforcement, duplicate-round detection, subagent lanes, checkpointing.

Extracted from it, and the right place to look first:

| Module | What it owns |
| --- | --- |
| `src/agent/wire/{anthropic,openai,bedrock}.ts` | Per-provider wire format: messages, tools, cache breakpoints, stop reasons |
| `src/agent/wire/strict-schema.ts` | The JSON-Schema subset both OpenAI and Anthropic accept for strict tool use |
| `src/agent/transcript-hygiene.ts` | Provider-neutral passes that make a history safe to send (orphan repair, image stripping, empty-content filling) |
| `src/agent/tool-output-store.ts` | Retains oversized tool results for `tool_output_page` / `tool_output_search` |
| `src/tools/definitions.ts` | Every tool's schema and description — the agent's entire advertised surface |
| `src/provider-retry.ts` | Retry classification and backoff shared by all four providers |

`agent-session.ts` re-exports everything it moved, so an import from `"./agent-session.js"` still
resolves. Prefer importing from the specific module in new code.

**Four providers, one loop.** Anthropic, OpenAI (both Chat Completions and Responses), OpenRouter,
and Bedrock each get a `_streamTurn*` method that normalizes its stream into the same event shape.
Everything downstream is provider-agnostic. Adding a provider means a wire module, a stream method,
and a stop-reason normalizer — not touching the loop.

## Tools and the runtime boundary

Tool *schemas* live in `src/tools/definitions.ts`. Tool *execution* is split deliberately:

- `packages/local-runtime/` — filesystem, shell, git, tests, MCP clients. This is the security
  boundary: path containment (canonicalized with `realpath`, not just lexically), the command
  classifier that sorts operations into read/write/network/destructive tiers, and the argument
  blocklist that refuses inline-eval vectors. Nothing here launches a shell; every process is
  `spawn`/`execFile` with an argv array.
- `src/` services — anything needing VS Code APIs or extension state: LSP, diagnostics, the
  Codebase Map, browser automation, the data workbench.

`src/approval-gate.ts` is the user-consent chokepoint for anything write/network/destructive.

## Durable state

Everything persistent lives in `.blacksite/` in the workspace, written through
`src/shared/durable-file.ts` (atomic write, JSON document with a schema version). The stores:

| Store | File | Holds |
| --- | --- | --- |
| `planning-store.ts` | `planning.json` | Multi-phase plans, per-step state, todo runs |
| `ticket-store.ts` | `tickets.json` | The local work queue |
| `base-context-store.ts` | `base-context.json`, `workspace-rules.md` | Curated topics; user-authored rules |
| `graph-annotation-store.ts` | `map-notes.json` | Notes on files and relationships |
| `runs/run-store.ts` | `runs/` | Execution Run evidence |
| `memory-store.ts` | `context.md`, `memory.md` | Project narrative and agent memory |
| `data/` | `data.db` | The embedded SQLite workbench |

**Credentials are never here.** API keys, MCP tokens, and OAuth registrations live in VS Code
`SecretStorage` only.

## The per-turn context path

Worth understanding before touching anything near it, because it is hot: it runs once per
*tool-call round-trip*, not once per user message.

`AgentSession._refreshWorkspaceContext()` → `ChatProvider._buildWorkspaceContextBlock()` →
`workspace-context.ts`'s `gatherWorkspaceSnapshot()`, which assembles open files, diagnostics, git
status, project shape, instruction files, plans, tickets, base context, and map overview into the
block appended after the provider's cache breakpoint.

Most of it is cached, with the invalidation strategy chosen per source:

- **File-watcher invalidated** — project shape, instruction files (`AGENTS.md`, `CLAUDE.md`, …).
  They essentially never change mid-session.
- **Write-invalidated** — the planning document and base-context topics, which only this extension
  writes.
- **mtime+size validated** — `context.md`, `memory.md`, `workspace-rules.md`. These are *not* on
  the watcher, deliberately: `memory_append` writes mid-turn and the agent must see its own note on
  the very next round-trip, which a debounced watcher would delay.
- **Deliberately live** — diagnostics and git status. Stale values here would have the agent plan
  its next edit against pre-edit state.

If you add a disk read to this path, pick one of those four and say which in a comment.

## The Codebase Map

`src/graph/` (~11k lines) indexes the workspace into files, relationships, and folder territories,
rendered with PixiJS in `apps/graph`. The point is that it is *one* index: the same graph the user
navigates is what the agent queries through `map_*` tools via `graph-agent-gateway.ts`. Impact
analysis, path finding, and neighborhood lookup all read that shared snapshot, recomputed once per
index generation rather than per consumer.

## Larger subsystems

| Directory | Lines | What it is |
| --- | --- | --- |
| `src/webview/react/` | ~34k | All webview UI |
| `src/graph/` | ~11k | Codebase Map indexing |
| `src/sequences/` | ~4.7k | Bounded browser/local tool sequences |
| `src/runs/` | ~3.8k | Execution Run capture and retention |
| `src/loops/` | ~3.2k | Ticket Loops — supervised unattended queue execution |
| `src/data/` | ~2.8k | SQLite workbench, migrations, pgvector sidecar |
| `src/tools/` | ~2.6k | Tool definitions |
| `packages/` | ~7k | Vendored runtime libraries |

## Known rough edges

Honest notes, so nobody assumes the current shape is the intended one:

- **`src/` root is flat** — ~41k lines across ~110 files with no subfoldering, while the
  subsystems above are organized. New code should prefer a directory.
- **`agent-session.ts` (~6.3k) and `chat-provider.ts` (~4.7k) are still large.** The streaming
  methods and the compaction cluster are the next extraction candidates.
- **`mcp-panel.ts` is hand-rolled vanilla-JS webview markup**, inconsistent with every other
  surface being React. It escapes its interpolations (`esc()`), but it is the odd one out.
- **`docs/responsiveness-and-file-size-review.md`** catalogs congestion and performance findings
  in more depth, with a status header marking what has since been fixed. Its inventory numbers
  predate substantial growth — re-measure before relying on them.

## Build and test

```
npm run build          # vite (webviews) then esbuild (host) → out/
npm run compile        # tsc --noEmit, extension host
npm run typecheck:webview
npm run lint
npm run test:unit      # ~3.5k tests, node environment
npm run test:coverage  # same suite with V8 coverage thresholds
npm run test:browser   # Playwright browser-policy integration
npm run security       # static scan + dependency advisories
```

`tests/unit/helpers/vscode-mock.ts` is aliased over the `vscode` module, which is what lets host
code be unit-tested outside a real extension host.
