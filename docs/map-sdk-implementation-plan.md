# Map SDK — the Codebase Map as an open-source, headless SDK

Status: **Phases 0–2 done** · Written 2026-11-12 · The packages live in this repository as `@blacksite-agent/map-*` until there are outside users (§0.1)

The goal is to extract the indexing, analysis and query engine behind Blacksite's Codebase Map
into an open-source SDK. Agents will reach it through MCP, other products will embed it
directly, and Blacksite will use it like any other consumer. The plan is headless first: engine,
queries, wire protocol, MCP server and CLI. The visual map follows once the protocol has
settled (§5, Phase 7).

---

## Progress log

| Phase | State | Notes |
| --- | --- | --- |
| 0 — Decide | done 2026-11-13 | License, registry and home decided. The public name is chosen; claiming it is part of Phase 6 |
| 1 — Characterize | done 2026-11-12 | Goldens and baselines below; branch `map-sdk/phase-1-2` |
| 2 — Cut seams in place | done 2026-11-13, except the Extension Development Host pass | Eight commits on `map-sdk/phase-1-2`; record below |
| 3 — Incubate packages | not started | |
| 4 — Node defaults | not started | |
| 5 — Protocol, MCP, CLI | not started | First release candidate |
| 6 — Publish | deferred until there are outside users | Claim the name, rename, separate repository, npm 0.1.0 |

### Phase 1 record (2026-11-12)

**Goldens** — recorded through today's code paths, so they describe current behavior, quirks and all:

| Fixture | Where | Runs in | Covers |
| --- | --- | --- | --- |
| Polyglot (31 files, generated from `tests/golden/map/polyglot-fixture.ts`, 11 dated commits) | `polyglot-not-ready/-index/-queries/-incremental.json` | unit suite | Full index; all five queries, including error cases; the notes round trip; both context blocks; the gateway helpers; an incremental pass (edit, create, delete) and its delta |
| Generated two-root (2,000 target files, `gen-map-fixture.mjs`, commit dates now fixed) | `generated.json` | unit suite | Multi-root ids; index digests; queries; context blocks |
| This repository at `a60475f` (1,237 files, real history) | `repo-a60475f.json` | `npm run test:map-golden` | Index digests; queries; context blocks |

The harness is `tests/golden/map/map-harness.ts`. Only its `buildPipeline()` and `touch()` may change as
the plumbing moves.

**Baselines** — `node scripts/map-baseline.mjs` (Node 24.15, win32-x64). Indexing runs inline on the
measuring thread, so these are relative numbers:

| Measure | Value |
| --- | --- |
| Scale fixture | 20,000 target → 17,660 indexed (auto-escalated to *large*), 15,000 rendered, 38,402 import edges |
| Cold index (no caches) | 4,478 ms + relationships 2,743 ms; peak RSS 255 MB |
| Warm index (facts and relationship caches present) | 2,319 ms + relationships 213 ms; peak RSS 229 MB |
| One-file edit → index updated (`syncIndex`) | 91 ms |
| This repository at `a60475f` | Index 1,931 ms, relationships 837 ms, peak RSS 225 MB |

**Resolution on this repository** (specifiers that resolved to an indexed file; "relative misses" are `./`
or `/` specifiers that did not resolve, the true misses; the rest are external packages):

| Lang | Files | Specifiers | Resolved | % | Relative misses |
| --- | --- | --- | --- | --- | --- |
| ts | 774 | 3,591 | 2,275 | 63.4 | 16 |
| md | 49 | 957 | 602 | 62.9 | 53 |
| tsx | 120 | 857 | 665 | 77.6 | 0 |
| json | 97 | 398 | 22 | 5.5 | 15 |
| mjs | 20 | 82 | 4 | 4.9 | 0 |
| html | 5 | 26 | 5 | 19.2 | 0 |

### Phase 2 record (2026-11-13)

One commit per step on `map-sdk/phase-1-2`. After each one: host typecheck, the full unit suite, and
both sets of goldens, all passing, with the goldens unchanged byte for byte.

| Step | Commit | What changed |
| --- | --- | --- |
| 1 | `c8fed85` | `src/graph/events.ts` (`Event`, `Emitter`, `Disposable`, shaped like VS Code's). The indexer and the notes store use it. |
| 2 | `195a5da` | `src/graph/index-reader.ts` (`MapIndexReader`, `ServiceRelationshipReader`). The gateway and the three snapshots take the interfaces. The gateway's `typeof` checks are gone. |
| 3 | `6909706` | The incremental pass reads through the same IO as the full rebuild. `src/graph/fingerprint.ts` replaces `node:crypto`. |
| 4 | `fe37628` | `src/graph/indexer-ports.ts` and `jobs.ts`; `node-ports.ts` and `vscode-ports.ts` implement them. `GraphIndexer` has no `vscode`, `fs` or `path`. |
| 5 | `aaee254` | `config.ts` is pure; `vscode-config.ts` reads the settings. `.blacksite` reaches the exclusion policy as the host's `neverIndex`. |
| 6 | `01a6b72` | `src/graph/notes.ts` (`NoteBook` over `NoteStorage`). `GraphAnnotationStore` is the file adapter with the same exports. |
| 7 | `6536617` | `src/graph/map-query-service.ts`: typed results and error codes. The gateway maps codes back to the map_* tools' wording. |
| 8 | `a69d2de` | `src/graph/git-parse.ts`: pure parsers. `git-log.ts` and `git-discovery.ts` keep the runners. |

**Exit criteria:**

- Only `vscode-ports.ts`, `vscode-config.ts`, `symbol-indexer.ts` and `language-support.ts` import
  `vscode` under `src/graph`.
- Unit suite: 387 files, 5,419 tests. The repo golden passes.
- `npm run build` (webview included) passes, and lint has 0 errors. The 18 warnings are all in webview
  files this branch does not touch.
- **Not done: an Extension Development Host session.** It needs someone at the editor.
- Performance: no regression. Comparing single runs taken hours apart first suggested Phase 2 was
  6–9% slower, but that turned out to be machine conditions. Run back to back, alternating
  Phase 1 / Phase 2 / Phase 1 / Phase 2 (`4d13c8b` from a temporary clone, then the head), on the
  20k fixture and this repository:

  | ms | Phase 1 runs | Phase 2 runs |
  | --- | --- | --- |
  | Cold index | 4,938 · 4,824 | 4,946 · 4,501 |
  | Warm index | 2,581 · 2,555 | 2,372 · 2,335 |
  | One-file edit | 95 · 133 | 94 · 84 |
  | Repository index | 2,795 · 2,495 | 2,579 · 1,959 |

  Peak RSS varies by up to 70 MB between identical runs, so it is not compared.

**Where the work went beyond the steps above:**

- Step 2 also removed RelationshipSnapshot's direct-from-disk fallback, which was planned for step 3.
  The class now receives its job runner as a function. That fallback was reachable only from test
  doubles.
- Step 4 made more things ports than §3.2 sketches: git, storage, the job runner and the yield
  function, as well as files, watcher and roots. The indexer now imports only pure modules and port
  types, which does part of Phase 3 early. The actual port shapes differ from the sketch, so update
  §3.2 from `indexer-ports.ts` when Phase 3 starts:
  - `FileReader` takes absolute paths.
  - `GitPort` has `toplevel`, `listFiles`, `ignored`, `history` and `normalize`.
  - `MapStorage` has `read`, `write` and `path`.
  - `JobRunner` is in `jobs.ts`.

**Found for Phase 3:**

- Some result strings that will live in core still name the product or a tool:
  - `scopeNote` (names `map_relationships`)
  - the not-on-the-map warnings in `FileRelationships` ("Codebase Map")
  - the notes error "Not a file on the Codebase Map"
  - the `events.ts` log prefix

  Make them neutral and map them back in the Blacksite gateway, the same way step 7 handles the
  not-indexed messages.
- `MapStorage.path` and `RunJobOptions.cachePath` are still filesystem paths, because the worker
  writes its own caches. A host without a filesystem returns `null` and runs its jobs without a cache.
  Revisit this together with the browser `JobRunner`.
- `notes.ts` keeps the `GraphAnnotation*` names. Rename them when the package's public API is
  settled.
- The relationship cache key changed from sha256 to the fingerprint, so the first run after this
  lands recomputes relationships once.

**Noticed while recording** — not changed, because Phase 1 records behavior:

- The generated fixture gets no service edges at any size. Its only cross-root call is a relative
  `fetch('/api/orders')`, which the matcher treats as the weakest evidence.
- In the polyglot fixture, root-level files (`docker-compose.yml`, `docs/`) make the root project
  report "used but undeclared" dependencies on every service.
- Project manifests count as structural orphans.

---

## 0. Intent and decisions

### 0.1 Decided

- **Open source.**
- **A new name** for the published SDK, independent of Blacksite. Chosen 2026-11-12, but not
  written in this public file until it is claimed (§0.3).
- **Headless first.** The viewer comes later.
- **An SDK, not just an MCP server.** It must embed natively in other interfaces.
- **Home: this repository, for now.** Decided 2026-11-13. The packages live in `packages/map-*` as
  `@blacksite-agent/map-core`, `map-node`, `map-mcp` and `map-cli`, and are bundled into the
  extension the way `@blacksite-agent/llm` is. A separate repository, the public name and npm
  publishing wait for Phase 6, which starts when there are outside users. Renaming then is a
  find-and-replace inside this repository, because nothing outside depends on the packages.
- **License: Apache-2.0.** Decided 2026-11-12. It is permissive, so anyone can embed it,
  commercial products included, and it grants patents explicitly. Blacksite keeps its own
  license and depends on it. You are the only human author of the Map code (checked in git), so
  relicensing it is your decision alone.
- **Registry: npmjs.com**, public, with provenance. Decided 2026-11-12. Installing from GitHub
  Packages needs a token even for public packages, which is fatal for `npx`-style MCP installs.

### 0.2 Still proposed

Packages, runtimes and versioning are needed by Phase 3; DCO only by Phase 6.

| Decision | Proposal | Why | Alternative |
| --- | --- | --- | --- |
| Contributions | **DCO** (`Signed-off-by`), not a CLA | Apache-2.0 already lets Blacksite incorporate contributions, so a CLA buys nothing and puts off contributors. | Reuse the Blacksite CLA |
| Packages | `@blacksite-agent/map-core`, `map-node`, `map-mcp`, `map-cli` (the CLI's command is `blacksite-map`) | See §3.1. MCP is separate so library users don't pull in the MCP SDK. Renamed to the public scope in Phase 6. | One package with subpath exports |
| Runtimes | Core: ES2022 with no Node built-ins and no DOM (browser, worker, Deno, Bun, Node). Node package: Node ≥ 20. ESM only. | A runtime-neutral core is what makes "embed it anywhere" true. The core is already nearly pure (§2). | — |
| Versioning | 0.x semver, api-extractor reports, changesets | The same discipline as `packages/llm`. | — |
| MCP in the extension | Unchanged. The extension does **not** register the SDK's MCP server with VS Code's agents. | The September map-scale decision stays in force for the extension. The standalone server is a separate product. | — |

### 0.3 Name

The public name was chosen on 2026-11-12 from a shortlist checked that day against npm, GitHub and
domain availability. It is kept out of this file because the repository is public and the names
are not claimed yet. Phase 6 starts by claiming the npm org, the GitHub org and a domain, and by
running a basic trademark search.

---

## 1. What the SDK is for

| Host | Package | How it connects |
| --- | --- | --- |
| Any MCP client (Claude Code, Codex, Cursor, …) | `@blacksite-agent/map-cli` | `npx @blacksite-agent/map-cli mcp` in the client's MCP config (after Phase 6; until then, the build in this repository) |
| A Node app, in process (Blacksite, an Electron desktop app, a server-side worker) | `@blacksite-agent/map-node` | `openMapEngine(dir)`, or `createMapEngine(ports)` with the host's own ports |
| Editors and non-JS tools (JetBrains, Neovim, Zed, Emacs, Python scripts) | `@blacksite-agent/map-cli` | Spawn `blacksite-map serve --stdio` and speak JSON-RPC (LSP-style framing) |
| A browser or edge runtime (web app, Chrome extension) | `@blacksite-agent/map-core` | `createMapEngine` with a `FileSource` over an API (for example a repo host's contents API), jobs inline or in a Web Worker |
| Agent frameworks that register their own tools | `@blacksite-agent/map-core` | Exported tool schemas + `dispatchTool(engine, name, args)` |
| CI and scripts | `@blacksite-agent/map-cli` | `blacksite-map query … --json`, `blacksite-map export` (`blacksite-map check` comes after 0.1) |

**What 0.1 includes:**
- indexing, with the Node defaults
- the five queries: overview, find, relationships, impact, routes
- durable notes
- per-turn context summaries
- JSON export
- the stdio protocol
- MCP
- the CLI

**Not in 0.1:** the visual map, agent-activity streaming, a language-server symbol layer outside
VS Code, a plugin API for languages or service detectors, and CI rules. All of these are in §5,
Phase 7.

---

## 2. Evidence (from the 2026-11-12 review)

**Already pure.** Of the 49 files under `src/graph/`, four import `vscode`: `config.ts`,
`graph-indexer.ts`, `symbol-indexer.ts` and `language-support.ts`. Another eight or so use Node
built-ins: git, fs, `worker_threads`, `node:crypto`. The rest have neither: about 13.6k lines of
host code in total, with 57 spec files and around 11k lines of tests behind them. The full rebuild
(`index-job.ts`) already reads files only through an injected `JobIO`. `graph-agent-gateway.ts`
has no `vscode` import.

**The seams to cut:**

1. `GraphIndexer` uses `vscode.EventEmitter`, `findFiles`/`RelativePattern`,
   `createFileSystemWatcher` and `onDidChangeWorkspaceFolders`, and hardcodes `.blacksite/`
   ([graph-indexer.ts](../src/graph/graph-indexer.ts)).
2. The gateway and the three snapshots depend on the concrete `GraphIndexer` class through
   `import type`, duck-typed with `typeof this._indexer.nodeIndex === "function"`. The interface
   is missing.
3. `_applyDirty` calls `fs.statSync`/`readFileSync` directly, and so do
   `relationship-snapshot.ts`'s `readIndexedContents*`. The worker path and the incremental path
   read files differently.
4. `relationship-job.ts` uses `node:crypto`. Yields use `setImmediate`.
5. `readGraphConfig` reads VS Code settings. The `resolve*` functions next to it are pure.
6. `GraphAnnotationStore` needs `vscode` only for its emitter and `Disposable`. It writes
   `.blacksite/graph.json` through `shared/durable-file`.
7. Query results are `Record<string, unknown>`, and errors are English sentences that name
   Blacksite tools ("call map_overview again…").
8. `git-log.ts` and `git-discovery.ts` mix pure parsers (`parseGitLog`, `parseGitCommits`,
   `parseNulList`, `groupRootsByRepo`) with `execFile` runners.
9. `exclusions.ts` lists `.blacksite` among the never-indexed literals.
10. The webview's `protocol.ts` hand-mirrors `graph-model.ts`.

**What can be reused from `packages/llm`:**
- the lint guards in `eslint.config.mjs` (no `vscode`, no Node built-ins in the core entry, no
  escapes out of the package)
- the `source` export condition, already wired through tsconfig, esbuild, Vitest and Vite
- api-extractor reports, with CI running `check:api`
- a Chromium smoke test (`tests/browser/llm-core-browser.spec.ts`)

`@blacksite-agent/llm` is still `private` and `UNLICENSED`, so npm publishing (org, trusted
publishing, provenance) is new work regardless.

---

## 3. Target architecture

### 3.1 Packages

```text
All under @blacksite-agent/ until Phase 6:

map-cli ──▶ map-mcp ──▶ map-node ──▶ map-core
   │                        ▲           ▲
   └────────────────────────┘           │
Blacksite extension ──▶ map-node + map-core   (never map-mcp or map-cli)
Blacksite webview   ──▶ map-core model types only
```

- **`@blacksite-agent/map-core`** runs anywhere. It holds:
  - the model and node ids
  - all language facts and resolution
  - topology, hierarchy, structure, co-change, service relationships and layout
  - the index and relationship jobs
  - the snapshots
  - **the engine itself**, written against ports
  - queries, notes logic, context formatters, tool schemas, protocol types

  Its only dependencies are `d3-force` and `d3-hierarchy` (both ISC).
- **`@blacksite-agent/map-node`**: Node implementations of every port (git, fs, watcher, worker, caches,
  notes file), `openMapEngine()`, and the stdio JSON-RPC server.
- **`@blacksite-agent/map-mcp`**: `createMcpServer(engine)` on `@modelcontextprotocol/sdk` (MIT).
- **`@blacksite-agent/map-cli`**: the `blacksite-map` command.

Subpaths:
- `@blacksite-agent/map-core/analysis` exposes the primitives (`buildProjectTopology`,
  `buildServiceRelationships`, `traverseImpact`, `findRoutes`, …) marked `@beta`. Builders get
  them without every one becoming a stable promise in 0.x.
- `@blacksite-agent/map-core/testing` holds an in-memory `FileSource` and the fixture generator (today's
  `scripts/gen-map-fixture.mjs`).

### 3.2 Ports

The engine moves into core. Everything it touches outside itself becomes a port. VS Code,
Node, a browser and a remote API each supply their own.

```ts
interface Disposable { dispose(): void }
type Event<T> = (listener: (value: T) => void) => Disposable; // same shape as vscode.Event

interface MapPorts {
  roots: { current(): WorkspaceRoot[]; onDidChange?: Event<void> };
  files: FileSource;       // today: git-discovery + findFiles + JobIO
  watcher?: FileWatcher;   // today: vscode.workspace.createFileSystemWatcher
  history?: HistorySource; // today: git-log.ts (churn, recency, per-commit file sets)
  cache?: CacheStore;      // today: fs writes under <root>/.blacksite
  jobs?: JobRunner;        // today: graph-worker-client.ts; inline when absent
  symbols?: SymbolSource;  // today: symbol-indexer.ts (VS Code language servers)
  notes?: NoteStorage;     // today: graph-annotation-store.ts persistence
  log?: Logger;
}

interface FileSource {
  discover(roots: readonly WorkspaceRoot[], policy: ExclusionPolicy): Promise<Discovery>;
  /** Watcher admission for new paths (git check-ignore today). */
  ignored?(ids: readonly string[]): Promise<Set<string>>;
  stat(id: string): Promise<FileStat | null>;
  read(id: string): Promise<string | null>;
}
interface FileWatcher { watch(roots: readonly WorkspaceRoot[], onTouch: (absPath: string) => void): Disposable }
interface HistorySource { collect(roots: readonly WorkspaceRoot[], maxCommits: number): Promise<GitHistory | null> }
interface CacheStore { read(name: string): Promise<string | null>; write(name: string, text: string): Promise<void> }
interface JobRunner { run<K extends JobKind>(kind: K, input: JobInput<K>, io: JobIO): RunningJob<JobResult<K>> }
interface SymbolSource { edges(): readonly GraphEdge[]; onDidChange: Event<void> }
interface NoteStorage { read(): Promise<unknown>; write(document: NoteDocument): Promise<void> }
```

`FileSource.stat`/`read` replace today's `JobIO.stat`/`read`. `JobIO` keeps progress, yield and
cancellation, and is built from the `FileSource` plus the `CacheStore`, so the incremental
pass, the relationship snapshot and the worker all read files one way (seam 3).

### 3.3 Engine API

```ts
// @blacksite-agent/map-core
const engine = createMapEngine(ports, {
  profile: "balanced",          // capacity tiers, auto-escalation as today
  neighborhoods: "auto",
  exclusions: { excludeDotDirectories: true, respectGitignore: true, allow: [] },
  neverIndex: [".blacksite-map"],     // hosts add their own (Blacksite adds ".blacksite")
});
engine.start();                 // watch + first reconcile (cached snapshot paints first)
await engine.ready();

engine.query.overview({ limit: 10 });
engine.query.find({ area: "src/graph", sortBy: "dependents" });
engine.query.relationships({ paths: ["src/a.ts"] });
engine.query.impact({ paths: ["src/a.ts"], depth: 3, layers: ["import", "service"] });
engine.query.routes({ from: "src/a.ts", to: "src/b.ts" });
engine.notes.add({ from: "src/a.ts", note: "…", category: "gotcha", author: "agent" });
engine.context.workspaceOverview();      // prose block for an agent's system context
engine.context.localOverview(["src/a.ts"]);
engine.index;                            // MapIndexReader: snapshot(), nodeIndex(), importEdges(), …
engine.onDidChange((snapshot) => {});    // snapshot.delta when incremental
engine.onProgress(({ phase, fraction }) => {});
engine.dispose();

// @blacksite-agent/map-node
const engine = await openMapEngine(process.cwd(), { cacheDir: ".blacksite-map" });
```

**Query results.**
- They keep **exactly today's JSON shapes**, which have been proven with agents, now as typed
  interfaces (`OverviewResult`, `FindResult`, `RelationshipsResult`, `ImpactResult`,
  `RoutesResult`).
- Failures become `{ ok: false, code, message, indexing? }` with
  `code ∈ "not_indexed" | "bad_request" | "unresolved"`. Hosts map codes to their own wording,
  which is how Blacksite keeps its current messages byte for byte.
- Explicit queries flush pending watcher changes first. The context summaries never do, as
  today, because they run on every turn.

### 3.4 On disk

- **The cache is private.** The SDK default is `.blacksite-map/` (`graph-cache.json`, `facts.json`,
  `relationships.json`, `corpus.json`, `notes.json`). Schema versions stay internal and may bump
  in any release.
- **Blacksite keeps its layout.** It passes `cacheDir: ".blacksite"` and its current file names,
  including `graph.json` for notes, so upgrading never forces a cold rebuild or loses notes.
- **The export format is public.** `blacksite-map export` writes **`map-graph/v1`**: nodes, edges
  with `provenance`, hierarchy, topology and coverage, with optional positions. It is
  documented with a JSON Schema in the repo, and it is the supported way for a non-JS tool to
  read the graph without running the server.

### 3.5 Wire protocol (`blacksite-map serve --stdio`)

JSON-RPC 2.0 with LSP-style `Content-Length` framing. Every editor ecosystem already has a
client for it, and the framing is about 100 lines with no dependency. Methods:

| Method | Params → result |
| --- | --- |
| `initialize` | `{ protocolVersion, roots, options }` → `{ capabilities, serverInfo }` |
| `shutdown` | — |
| `index/status` | → `{ indexing, phase, progress, seq, coverage }` |
| `index/rebuild`, `index/flush` | → `{ appliedChanges? }` |
| `query/overview` · `query/find` · `query/relationships` · `query/impact` · `query/routes` | the query options → the typed results |
| `notes/list` · `notes/add` · `notes/update` · `notes/remove` | the notes operations |
| `context/workspace` · `context/local` | → `{ text }` |
| `graph/export` | `{ format: "map-graph/v1", layout? }` → the document |

The server sends three notifications:
- `index/didChange` with `{ seq, changedNodes, changedEdges }` (a summary, not the patch)
- `index/progress`
- `notes/didChange`

Protocol types live in core so a TypeScript client and the server cannot drift apart.

### 3.6 MCP server

- **Tools:** `overview`, `find`, `relationships`, `impact`, `path`, `note_add`, `note_list`,
  `note_update`, `note_remove`. Clients namespace them (for example `mcp__blacksite-map__impact`).
- **Descriptions** start from Blacksite's tested wording in `src/tools/definitions.ts`, with the
  Blacksite references removed (Notes timeline, `plan_create`). The canonical copy lives in
  `@blacksite-agent/map-core/tools`.
- **Roots** come from the client's MCP `roots/list` when it supports that, else the working
  directory.
- **Cold start:** indexing begins at launch. A query arriving during a cold index waits up to a
  bounded time, then returns `not_indexed` with progress, so the agent can carry on and ask again.
- **Server `instructions`** carry the short "when to use which tool" guidance, and a resource
  `map://overview` exposes the overview to clients that read resources.

---

## 4. Where each file goes

| Destination | Files (today's names) |
| --- | --- |
| **core — model** | `graph-model`, `workspace-roots`, `corpus`, new `events` (`Event`, `Emitter`, `Disposable`), the notes model and rules from `graph-annotation-store` (normalization, caps, revisions), and the pure functions now in `graph-indexer` (`autoEscalatedProfile`, `renderedImportProjection`, `diffSnapshots`, `normalizeCache`) |
| **core — analysis** | `import-scan`, `resolve-imports`, `tsconfig-paths`, `go-modules`, `csharp-index`, `php-index`, `python-index`, `python-reexports`, `doc-links`, `workspace-packages`, `file-facts`, `scan-pipeline`, `project-topology`, `neighborhoods`, `hierarchy`, `structural-analysis`, `connectivity-stats`, `cochange`, `relationship-indexer`, `client-config`, `layout`, `directory-pack`, `symbol-pass`, `symbol-relations`, the git parsers split out of `git-log` / `git-discovery` |
| **core — policy** | `exclusions` (with `neverIndex` as an option), `file-discovery`, the pure half of `config` (`resolveGraphCapacity`, `resolveGraphExclusions`, `PROFILE_CAPS`) |
| **core — engine** | `index-job`, `relationship-job`, `GraphIndexer` rewritten against ports as `MapEngine`, `relationship-snapshot` / `structural-snapshot` / `hierarchy-snapshot` behind `MapIndexReader` |
| **core — query, tools, protocol** | `map-queries`, `MapQueryService` and the context formatters from `graph-agent-gateway`, tool schemas, JSON-RPC types |
| **node** | the git runners from `git-log` / `git-discovery`, `graph-worker-client` → `JobRunner`, `worker/graph-worker`, `worker/job-io` → `FileSource`, a recursive `fs.watch` watcher, a zero-dependency fallback walker, the cache and notes file stores (atomic writes, replacing `shared/durable-file`), `openMapEngine`, `serveStdio` |
| **stays in Blacksite** | `graph-provider`, `readGraphConfig` (from `config`), `language-support`, `symbol-indexer` (as a `SymbolSource`), `trace-extract`, `live-activity`, `run-footprints`, `reference-links`, `change-log`, a thin `graph-agent-gateway` (notes dispatch, mapping error codes to messages), a thin `GraphAnnotationStore` adapter, new `vscode-ports.ts` (`findFiles` fallback, watcher, roots), the `map_*` tool definitions, the whole webview |

`reference-links` (linking documents to code by path and API route) is generic logic that
only reads Blacksite's reference folder. It is a candidate for `core/analysis` after 0.1.

---

## 5. Phases

Each phase ends with Blacksite behaving exactly as before (§6). Sizes are relative:
S < M < L.

### Phase 0 — Decide · S · done

- Done 2026-11-12: name (chosen; claiming it is part of Phase 6), license (Apache-2.0), registry
  (npmjs.com).
- Done 2026-11-13: home (this repository, as `@blacksite-agent/map-*`; §0.1).
- Still to confirm, before Phase 6: DCO.

**Exit:** met.

### Phase 1 — Characterize before moving anything · M

**Fixtures:**
- `tests/fixtures/map/polyglot/`: a TS workspace monorepo with `tsconfig` paths, a Python
  package with `__init__` re-exports, a Go module, a C# project, two services in
  `docker-compose` calling each other's HTTP routes, and Markdown linking to code.
- The 20k-file generated fixture.
- This repository at a pinned commit.

**Golden outputs**, through today's code paths:
- index job result (node ids, `dir`, `codebase`, degrees, import edges)
- relationship edges, hierarchy and structure
- gateway output for a fixed query set per fixture (all five queries, notes round trip, both
  context blocks)
- positions for the polyglot fixture only, within a tolerance

**Baselines:**
- cold and warm index time, and peak memory, on the 20k fixture
- time for one file edit to reach the snapshot
- import resolution rate per language on this repository

**Exit:** goldens committed and passing; baselines recorded in this plan's progress log.

### Phase 2 — Cut the seams in place, inside `src/graph` · L

One commit per step. Goldens must pass after each.

1. **`events.ts`.** `Event`, `Emitter`, `Disposable` in the VS Code shape. `GraphIndexer` and
   `GraphAnnotationStore` use them.
2. **`MapIndexReader`.** `GraphIndexer` implements it; the gateway and the three snapshots take
   it. Remove the `typeof … === "function"` checks and their test doubles' gaps.
3. **One file-reading path.** `_applyDirty` and `relationship-snapshot` read through the
   `FileSource` shape. Replace `node:crypto` with a pure hash. Yield through `JobIO`.
4. **Ports on `GraphIndexer`:** roots plus a change event, `FileSource` (git listing + an injected
   fallback enumerator), watcher, cache. The VS Code implementations go in
   `src/graph/vscode-ports.ts`. `GraphIndexer` stops importing `vscode`.
5. **Config split.** `readGraphConfig` moves to the extension side. `neverIndex` becomes an
   option.
6. **Notes split.** Pure note logic + a `NoteStorage` port. `GraphAnnotationStore` becomes an
   adapter.
7. **Query split.** `MapQueryService` with typed results and error codes; the context
   formatters move with it. `GraphAgentGateway` keeps notes dispatch and maps codes to today's
   exact messages.
8. **Git split.** Parsers apart from `execFile` runners.

**Exit:**
- Only `vscode-ports.ts`, the config reader, `symbol-indexer.ts` and `language-support.ts` import
  `vscode` under `src/graph`.
- Goldens, all Map specs, `npm run build` and `npm run build:webview` pass.
- An Extension Development Host session on this repository behaves as before.

### Phase 3 — Incubate the packages in this repo · M

- Create `packages/map-core` (`@blacksite-agent/map-core`) and `packages/map-node` (`@blacksite-agent/map-node`),
  modeled on `packages/llm`'s `package.json` (`exports` with the `source` condition,
  `sideEffects: false`, `files: ["dist"]`).
  - Set `"license": "Apache-2.0"`, and keep `"private": true` until Phase 6 so nothing publishes
    early.
  - Add `LICENSE`, `NOTICE` and a README to each.
  - State in the root README and `LICENSE.md` that `packages/map-*` are Apache-2.0 while the
    rest of the repository is not.
- Move the files per §4, updating imports directly; there are about 20 importing files.
  - No re-export stubs: the llm split needed a whole extra phase to remove them.
  - Run `npm run build:webview` as well as esbuild (the Vite `source`-condition trap from the
    llm split).
- **Lint guards**, copied from llm's block:
  - core forbids `vscode`, Node built-ins, `@blacksite/*` and escapes out of the package
  - node forbids `vscode`
  - a CI grep fails on `/blacksite/i` in the packages' `src/` (their package names aside), so
    nothing Blacksite-specific moves into them
- Move the specs for moved modules into `packages/*/test`, and add them to the Vitest config.
- Add `tests/browser/map-core-browser.spec.ts`: run the engine with the in-memory
  `FileSource` and inline jobs in Chromium, then query it.
- The webview's `protocol.ts` imports the model types from `@blacksite-agent/map-core`, which ends the hand
  mirror. This is also the first real proof that core runs in a browser bundle.
- Add api-extractor reports for `core`, `core/analysis`, `core/testing` and `node`, plus a
  `check:api` CI step.

**Exit:**
- Both packages build standalone.
- `check:api`, goldens, the specs, the browser smoke test and both builds pass.
- An Extension Development Host session behaves as before.

### Phase 4 — Node defaults and `openMapEngine` · M

- `nodePorts()`:
  - git-aware `FileSource`, plus a zero-dependency walker for non-git folders (exclusion policy,
    a file cap, no symlink loops)
  - recursive `fs.watch` with a debounce (document Linux inotify limits; a `@parcel/watcher`
    adapter can follow)
  - atomic cache and notes stores under `.blacksite-map/`
  - a `worker_threads` `JobRunner` that finds `dist/worker.js` through `import.meta.url`, with an
    explicit `workerScript` option for bundled hosts (Blacksite's CJS bundle passes
    `out/graph-worker.js`, as now)
- Add `openMapEngine(dirOrDirs, options)` and `examples/embed-node.ts`.

**Exit:**
- Outside VS Code, the engine indexes this repository and one large public repository, on Windows
  and on Linux.
- Warm start is within 10% of the Phase 1 baseline.
- A one-file edit appears in the snapshot within 3 s.

### Phase 5 — Protocol, MCP server and CLI · L → 0.1.0-rc

- Protocol types in core (§3.5) with a `protocolVersion`, and `serveStdio(engine)` in node.
- `@blacksite-agent/map-mcp` per §3.6.
- `@blacksite-agent/map-cli`:
  - `blacksite-map index [dir…]`, `status`, `query <overview|find|relationships|impact|routes> …`
  - `export --format map-graph/v1 [--layout]`, `serve --stdio`, `mcp`
  - human-readable output by default, `--json` for scripts, meaningful exit codes
- Docs:
  - a README with one quickstart per §1 row
  - `docs/protocol.md`, `docs/export-format.md` + JSON Schema
  - `docs/languages.md`: what resolves per language, with the resolution rates measured in
    Phase 1
  - an architecture overview adapted from `docs/codebase-map.md`, without the Blacksite parts
    and without its encoding damage

**Exit:**
- `npx` from a packed tarball works in a clean temporary directory on Windows and Linux.
- JSON-RPC conformance tests pass.
- The MCP server is verified live in Claude Code and at least one other MCP client: index this
  repository, run all five queries, round-trip a note.

### Phase 6 — Publish, when there are outside users · M → 0.1.0

- Claim the public name: the npm org, the GitHub org and a domain, after a basic trademark search.
  Set up npm trusted publishing for the GitHub org (OIDC from Actions, no long-lived token).
- Rename `@blacksite-agent/map-*` to the public scope, along with the `blacksite-map` command, the
  `.blacksite-map/` default cache directory and the `map-graph/v1` and `map://` identifiers.
- Create the public repository. Its first commit holds the packages with a provenance line (source
  repository + commit).
- Add CI: lint, typecheck, test and `check:api` on Node 20/22/24 × Ubuntu/Windows/macOS. Windows
  matters here: the id rules lowercase and slash-normalize Windows paths.
- Add changesets, and npm publish with provenance from Actions.
- Add `CONTRIBUTING.md` (DCO), `CODE_OF_CONDUCT.md`, `SECURITY.md` and issue templates.
- Audit before the first publish:
  - review `npm pack --dry-run` file lists
  - check dependency licenses
  - grep for private references
- Publish 0.1.0.
- **Switch Blacksite over:**
  - depend on exact versions and delete `packages/map-*`
  - local co-development through `npm link` or `overrides`
  - ship a Blacksite prerelease built on the published packages, then run an Extension
    Development Host session

**Exit:**
- 0.1.0 is on npm with provenance.
- A Blacksite prerelease built on it ships.
- The goldens, now run in Blacksite's suite against the published packages, still pass.

### Phase 7 — After 0.1 (unscheduled)

- **Plugin API** for languages and service detectors, the main path for community contributions.
  `FileFacts` currently has one field per language, so this needs per-plugin facts
  (`facts.ext[pluginId]`) and plugin versions in the cache key.
- **`blacksite-map check`**: CI rules (no new cross-project cycles, no imports a manifest doesn't
  declare, no unexplained co-change above a threshold), with SARIF output for code scanning.
- **A headless symbol layer**: a `SymbolSource` that drives a language server directly.
- **A quality benchmark**: resolution rate per language on pinned public repositories, run in CI.
- **The viewer**: `@blacksite-agent/map-view` (view model + the pixi renderer, which is already
  framework-independent) and `@blacksite-agent/map-react` (panels with injected transport and storage,
  Blacksite features as slots). Blacksite's webview becomes a consumer, and an activity-stream
  API lets hosts show agent work on the map.
- **A browser example** indexing a public repository through a contents API.

---

## 6. Keeping Blacksite unchanged

These rules hold in every phase.

- **Tool definitions stay as they are.** `map_*` definitions and descriptions stay in
  `src/tools/definitions.ts`. Never regenerate a request snapshot
  (`tests/unit/__snapshots__/provider-requests`) to make a run pass.
- **Tool results stay byte for byte**, error messages included. Error codes are mapped back to
  today's wording.
- **The cache layout doesn't move.** It stays in `.blacksite/` under the same file names and
  schema versions; notes stay in `.blacksite/graph.json`.
- **The extension depends on core and node only**, never on mcp or cli. It does not register an
  MCP server.
- **Settings are untouched.** `blacksite.graph.*` keep their names; the extension translates them
  into engine options.

---

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Behavior drifts while code moves | Phase 1 goldens on three fixtures; one seam per commit; request snapshots never regenerated |
| A slower engine after the port indirection | Phase 1 baselines; Phase 4 exit within 10% |
| Windows path handling | Windows in the CI matrix; the existing `workspace-roots` specs move with the code |
| Recursive `fs.watch` on Linux (inotify limits, network drives) | Document it; watcher is a port; `@parcel/watcher` adapter later; queries flush, so a missed event costs freshness, not correctness |
| The worker can't be found in bundled hosts | Explicit `workerScript`; inline fallback (already exists) |
| Public API churn | 0.x; small stable root API; primitives under `/analysis` as `@beta`; api-extractor reports reviewed in CI |
| Heuristic changes (service detectors change often: cache v11→v12 was one) | Cache schemas stay private; changelog entries for detector changes; plugin versions in cache keys after 0.1 |
| Blacksite concepts leaking into the SDK | Lint guard + `/blacksite/i` CI grep; Blacksite-only features stay behind ports or in the extension |
| Name or trademark conflict | Phase 0 search; claim namespaces before any public mention |
| Open-source maintenance load | Narrow 0.1 scope (§1); issue templates; plugin API before accepting one-off language PRs |

## 8. Out of scope for this plan

The visual map and the React panels, agent-activity streaming, running the engine as a service
for Blacksite Cloud, and anything about how Blacksite charges for features built on the SDK.
