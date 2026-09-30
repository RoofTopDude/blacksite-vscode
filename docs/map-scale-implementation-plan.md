# Codebase Map — Scale, Structure & Cross-Project Relationships

Status: **shipped in 1.30.0-pre.1** (P9 deferred) · Owner: Blacksite VS Code extension · Surface: `blacksite.map` / `blacksite.graph`

Companion docs: [`codebase-map.md`](./codebase-map.md), [`map-depth-implementation-plan.md`](./map-depth-implementation-plan.md), [`guide/map-guide.md`](./guide/map-guide.md), [`guide/settings-and-commands.md`](./guide/settings-and-commands.md)

Prepared 2026-09-29 from an investigation of the current code, for whoever implements it. Line
references are to `main` at 1.29.0 (`6d1db33`). Re-read each file before editing.

## Progress log

Implemented 2026-09-29 and released as prerelease 1.30.0-pre.1. Each entry names what landed
and where; deviations from the plan text below are called out.

| Phase | State | Notes |
| --- | --- | --- |
| P0 updater gate | Done | `engineSatisfied`, `readVsixEngineRange`, `promptEngineTooOld` in `update-service.ts`; the downloaded VSIX's own `engines.vscode` is checked too, which covers prereleases. 7 new tests in `update-service.spec.ts`. **Deviation:** the gate and the bump ship in the same prerelease; see "Release note" below. |
| P1 git discovery | Done | `graph/git-discovery.ts` (`git ls-files -co --exclude-standard`, grouped per repo toplevel, `git check-ignore --stdin` for new watcher paths). Setting `blacksite.graph.respectGitignore`. `collectGitHistory` runs one `git log` per repository. Tests: `graph-git-discovery.spec.ts` (real repository). |
| P1 delta protocol | Done | `graph_delta` (with `seq`/`baseSeq`), `relationships_state`, `structure_state`, `symbol_edges`, `lsp_support`. **Found and fixed while doing this:** after every full post, the provider started a language-server probe whose completion posted the full graph again, a loop that re-sent everything for as long as a Map was open. Inspection now runs once per index shape. |
| P2 floor 1.139 | Done | `engines ^1.139.0`, `@types/vscode ~1.138.0` (newest published), esbuild `node24`, TS/Vite `ES2024`, docs updated. `findFiles2` is still not in the 1.138 typings, so git discovery stays. |
| P3 worker + facts | Done | `scan-pipeline.ts` (pure, facts-based), `file-facts.ts` (cached per mtime+size at `.blacksite/graph-facts.json`; C#/PHP refs re-read only when a newly declared type name appears), `index-job.ts`, `relationship-job.ts` (fingerprint cache at `.blacksite/graph-relationships.json`), `worker/graph-worker.ts` → `out/graph-worker.js`, `graph-worker-client.ts` (inline fallback, and a worker that fails to start falls back for the session). Layout now covers every indexed file; `GraphIndexer.nodeIndex()` exposes it and the gateway reads it. Tests: `graph-index-job.spec.ts`, `graph-worker-thread.spec.ts` (bundles the real worker). |
| P4 resolution | Done | `workspace-packages.ts`: package.json `exports`/`imports`/`main`/`types`/`source` with dist→src twins; Cargo crate names; pyproject/setup.cfg source roots; multi-root absolute Python and web-root JSON. Tests: `graph-workspace-packages.spec.ts`. |
| P5 project edges, co-change | Done | `hierarchy.ts` (+ `hierarchy-snapshot.ts`) aggregates imports, routes, co-change and `project_ref` per level, with declared-but-unused / used-but-undeclared findings and "hidden coupling". `cochange.ts`. Map queries gained a `history` layer; `map_find` a `codebase` filter; `map_overview` lists codebases and dependency findings. **Deviation:** `map_path` does not traverse `project_ref`, because those edges join project directories, not files; the overview reports them instead. Tests: `graph-cochange.spec.ts`, `graph-hierarchy.spec.ts`. |
| P6 split, hierarchy, scope | Done | B8 first, move-only: `GraphApp.tsx` went from 2,979 lines to ~390, with panels in `apps/graph/panels/` (`shared`, `LabelsOverlay`, `SearchBar`, `Minimap`, `cards`, `Legend`, `MapControls`, `StatusChips`). Then `lib/graph/scope.ts` (`computeFolds`, `landingMode`, breadcrumb helpers), `deriveScopedGraph`/`applyLanding`/`setScope` in `view-model.ts`, the `ScopeBar` in `SearchBar.tsx`, `request_scope_detail`/`scope_detail` fill-in, host corpus search, Backspace to go up. **Addition:** the hierarchy has a `systems` edge level joining exactly what the Systems view draws (codebases, else workspace folders). Without it, the scale fixture showed hidden coupling between a codebase and a folder-level sibling was never drawn, because the per-level aggregates only join groups of the same level. Tests: `graph-scope.spec.ts`. |
| P7 outline, inspector, controls, color | Done | `panels/Outline.tsx` (true counts, ticket/note/live badges, change-heat bar, dependency findings, hubs in view), `panels/Inspector.tsx` (tabs Overview · Relations · Work · Activity · Notes · Refs; `GroupCard`), controls reorganised: Structure/Services/Work lenses, Declared deps and Co-change layers, and an **Advanced** disclosure holding depth, territory layout, and the focus budget. Hierarchical color lives in `folderColor` itself (`setColorCodebases`), so every call site follows. Group edges carry counts (stroke width), hidden coupling is dashed, and the new `echo` motion animates co-change. Activity and traces on a folded file light up its group (`displayFoldOf`). |
| P8 context | Done | `run-footprints.ts`, `reference-links.ts` (text attachments and Extracted context; **PDFs are not scanned** — their text lives in the reference index, which is not on the map's path), notes timeline `focus`, `file_ticket_for_area`, `open_run`, inspector tabs. Tests: `graph-run-footprints.spec.ts`, `graph-reference-links.spec.ts`. **Not done:** a scope-aware Work lens and a scope filter on the playback scrubber. In a scoped or Systems view, playback already lights up folded groups through `displayFoldOf`. |
| P9 timeline strip | Deferred | Stretch, as planned. The inspector's Activity and Notes tabs cover the per-selection half of it. |

### Verification (2026-09-29)

- Gate: `npm run lint` (0 errors), `compile`, `typecheck:webview`, `test:coverage` (290 files,
  4,187 tests, thresholds met), `security`, `build`, `package:vsix`.
- Browser gate: `npm run test:browser` (including a new Systems, scope and inspector interaction
  test). The browser pass found and fixed a renderer initialization race, selection lost during
  scope navigation, and a Systems fit that placed codebases under the side panels.
- **Security gate fix:** `npm run security` failed on a pre-existing high advisory in `undici`
  (a transitive of `@vscode/vsce`), unrelated to this work. `npm update undici` moved it
  7.29.0 → 7.30.0, which clears it.
- Scale fixture (`node scripts/gen-map-fixture.mjs <dir> --files 25000`: two workspace folders,
  26,587 files, 4,500 of them git-ignored), driven through the built worker bundle:

  | Measure | Result |
  | --- | --- |
  | Discovery (git ls-files, two repositories) | 22,060 files in 283 ms; ignored `generated/` trees absent |
  | Full index job in the worker, cold | 3.9 s (scan 2.9 s, resolve 0.5 s, layout 0.3 s) |
  | Same, warm (facts cache) | 1.4 s, 0 files re-read |
  | Longest stall of the calling thread during either | 20 ms cold, 72 ms warm |
  | Relationship job in the worker | 3.2 s, caller stall ≤ 51 ms |
  | Hierarchy build | 180 ms for 645 groups |

  Resolution checks on the fixture:
  - `@acme/ui` and `@acme/shared/format/date` from `apps/web` resolved to package sources;
  - `use acme_core::m0` resolved to the sibling crate;
  - absolute Python imports under a `src/` layout resolved;
  - both scripted co-change pairs were found;
  - `@acme/admin → @acme/unused` was reported as declared but unused.

  Relationship-job parity with the old in-process pass is a unit test
  (`graph-index-job.spec.ts`).
- **Still to verify with users:** the redesigned UI has not been exercised in a running Extension
  Development Host on the full fixture workspace (`fixture.code-workspace`). The built webview's
  Systems landing, scope navigation and inspector were exercised in Chromium.

### Release note

The plan asked for the updater gate to ship one release before the VS Code floor bump. Both are
in 1.30.0-pre.1. For prerelease users that is fine, because the gate also reads the engine range
from the downloaded VSIX. **Stable users on 1.29.0 and a VS Code older than 1.139 have no gate**,
though. When 1.30.0 goes stable, 1.29's updater will offer it, and VS Code will refuse the install.
To avoid that, cut a stable 1.29.1 that carries only the gate first, or accept the one failed
prompt.

## 0. Intent and decisions already made

The goal is a Map that stays smooth and readable when the workspace holds one or more dense
codebases, past 20,000 files and across several roots. It should present the workspace as an
organized hierarchy rather than one star field. It should bring the newer features (timeline notes,
tickets, execution runs, reference material) into the same place. And it should derive better
relationships, especially between projects and between roots.

Constraints from the user:

- Build on the existing foundations. No rewrite. Refactor a specific target only where the plan says
  why it is needed.
- **Raise the VS Code floor to 1.139** (current stable, 2026-09-23).
- **Large or multi-codebase workspaces open on a Systems overview** (one node per codebase or
  project), and the user drills in from there.
- **Not in scope:** exposing map queries to VS Code's own agents (LM tools or MCP). Revisit later.

Five tracks, in dependency order:

| Track | What | Why first/last |
| --- | --- | --- |
| 0 | VS Code 1.139 floor, with an updater gate shipped one release earlier | Independent; the gate must precede the bump |
| A | Host pipeline at 20k+: git-aware discovery, worker, facts cache, delta updates | Everything else gets slower without it |
| C | Relationship depth: workspace packages across roots, project edges, co-change | The Systems overview needs its edges |
| B | Hierarchy and scoped presentation: Systems landing, scope bar, outline, inspector | The user-visible redesign |
| D | Tickets, runs, notes, and references in context | Lands in B's inspector |

---

## 1. Evidence

### 1.1 Host pipeline

| Finding | Where | Consequence at 20k+ files |
| --- | --- | --- |
| Discovery is `findFiles("**/*")` per root with a 200k raw cap and a hand-built exclude glob. `.gitignore` is not honored. | [`graph-indexer.ts:480-501`](../src/graph/graph-indexer.ts#L480-L501) | Generated, vendored, and build-output trees that the repo ignores are enumerated, read, and laid out |
| The same file is read up to four times per rebuild: the import scan, the C#/PHP/Python name indexes, and the relationship snapshot | [`graph-indexer.ts:529-550`](../src/graph/graph-indexer.ts#L529-L550), [`:738-818`](../src/graph/graph-indexer.ts#L738-L818), [`relationship-snapshot.ts:50-70`](../src/graph/relationship-snapshot.ts#L50-L70) | Several passes of `readFileSync` in 50-file slices on the **extension host thread, which also runs chat and the agent** |
| No per-file facts survive a reload. `start()` always reconciles with a full rebuild. | [`graph-indexer.ts:382-397`](../src/graph/graph-indexer.ts#L382-L397) | Every window reload re-reads and re-resolves the whole corpus |
| Every debounced edit and every relationship update re-posts the **entire** graph (nodes, imports, relationship, symbol, annotations) to every Map surface | [`graph-provider.ts:203-204`](../src/graph-provider.ts#L203-L204), [`:865-907`](../src/graph-provider.ts#L865-L907) | Multi-MB messages and a full webview re-derive every ~2 s while the agent edits, which is exactly when the user is watching |
| The render cap is a global sample (`sampleAcrossClusters`). The `balanced` profile auto-escalates to `large` above 12k files (15k stars). | [`graph-indexer.ts:506-526`](../src/graph/graph-indexer.ts#L506-L526), [`config.ts:34-39`](../src/graph/config.ts#L34-L39) | Past the cap, which files exist on the canvas is decided once, globally; focusing an area cannot bring its missing files back |
| Agent `overview` areas and hubs read `snapshot.nodes`, the **rendered** projection | [`graph-agent-gateway.ts:204-208`](../src/graph-agent-gateway.ts#L204-L208) | Agent orientation is sampled whenever the render cap truncates |
| `git log` runs once per root, even when roots share a repository, and the log is not path-limited | [`graph-indexer.ts:858-868`](../src/graph/graph-indexer.ts#L858-L868), [`git-log.ts:73-96`](../src/graph/git-log.ts#L73-L96) | N roots in one monorepo parse the same 4,000 commits N times |

### 1.2 Presentation

- **The hierarchy is only implicit.** Neighborhood territories exist only when `auto` territorializes
  ([`graph-indexer.ts:953-961`](../src/graph/graph-indexer.ts#L953-L961)). Collapse works on single
  cluster dirs only (`collapsedClusters` matches `node.dir` exactly,
  [`view-model.ts:478-582`](../src/webview/react/lib/graph/view-model.ts#L478-L582)). Nothing
  represents "root → codebase → project → area".
- **The controls are one flat rail.** "Display & analysis" is a 204 px rail with about nine sections
  where lens, layers, filters, depth, and neighborhood mode all sit at the same level
  ([`GraphApp.tsx:1722-2057`](../src/webview/react/apps/graph/GraphApp.tsx#L1722-L2057)).
- **There are four separate selection cards:** `NodeCard`, `TicketCard`, `ClusterCard`, and
  `ServiceCard` ([`GraphApp.tsx:845-1276`](../src/webview/react/apps/graph/GraphApp.tsx#L845-L1276)).
- **The newer features live on separate surfaces:**
  - The Notes timeline is an editor tab.
  - Runs have a floating scrubber plus the separate Runs view.
  - Tickets are the Work lens plus a heat layer.
  - Plan phases are chips in the Plans panel.
  - Reference material never reaches the map. `.blacksite` is always excluded, and attachments live
    under `.blacksite/reference/<session>/` ([`reference-store.ts:1-6`](../src/reference-store.ts#L1-L6)).
- **The webview files are large.** `GraphApp.tsx` is 2,979 lines, `renderer.ts` 2,753, and
  `view-model.ts` 2,042. Adding more panels to `GraphApp.tsx` as it stands is not sustainable.

### 1.3 Relationships

| Gap | Where |
| --- | --- |
| Bare JS/TS specifiers resolve **only** through tsconfig aliases. `import "@acme/shared"` between workspace packages, or between roots, yields no edge. | [`resolve-imports.ts:1-4`](../src/graph/resolve-imports.ts#L1-L4), [`:752-763`](../src/graph/resolve-imports.ts#L752-L763) |
| A Rust sibling crate named by crate name returns null | [`resolve-imports.ts:236-242`](../src/graph/resolve-imports.ts#L236-L242) |
| Project topology (package, project, module, and build references) is host-only. It biases layout and is never drawn or checked against actual imports. | [`graph-indexer.ts:820-822`](../src/graph/graph-indexer.ts#L820-L822) |
| `parseGitLog` sees each commit's file list and throws it away | [`git-log.ts:25-45`](../src/graph/git-log.ts#L25-L45) |
| Multi-root: Python absolute modules and web-root-absolute JSON refs resolve against a single root. The Python suffix fallback only partly covers this. | `resolvePython` (base `""`), `resolveJson` (`/…`) in `resolve-imports.ts` |

### 1.4 VS Code

| Finding | Evidence |
| --- | --- |
| Engine is `^1.85.0` (Chromium 114 / Node 18), but the lockfile resolves `@types/vscode` **1.125.0**, so typings do not enforce the floor | `package.json:20`, `package-lock.json:5181-5183` |
| 1.139.x runs Electron 43.6, **Node 24.20**, **Chromium 150** | [vscode-versions](https://github.com/ewanharris/vscode-versions) |
| The 1.136 multi-root support is for VS Code's **own** Copilot/Claude agent sessions, not an extension API. Extensions could always read every workspace folder, and the map already indexes all of them. | [1.136 notes](https://code.visualstudio.com/updates/v1_136) |
| `findFiles2` (the `.gitignore`-aware search) is not in the stable typings we resolve (1.125), and the 1.136 and 1.139 notes do not finalize it | [#204657](https://github.com/microsoft/vscode/issues/204657) |
| The updater ignores the `minimumVscodeVersion` that `pages.yml` already publishes, so users on an older VS Code would be offered a VSIX that fails to install | `pages.yml:138`, `site/release-download.js:43`, no reference in `src/update-service.ts` |
| Forks: Cursor's base was still 1.105 on 2026-06-27. A 1.139 floor stops forks from installing Blacksite. Accepted. | [Cursor forum](https://forum.cursor.com/t/urgent-the-1-105-vs-code-base-is-now-5-months-old-we-need-a-modern-upstream-sync/164204) |

---

## 2. Track 0 — VS Code 1.139 floor

### 0.1 Updater engine gate (ship at least one release **before** the bump)

In [`update-service.ts`](../src/update-service.ts):

1. `parseReleaseManifest` (line 156) reads `minimumVscodeVersion` (for example `"^1.139.0"`) into
   `UpdateInfo.minimumVscodeVersion`.
2. Add a pure `engineSatisfied(range: string, running: string): boolean` next to
   `compareVersions` (line 278). Accept only `^x.y.z` and `>=x.y.z`. Treat an unparseable range as
   satisfied so a malformed manifest can never block updates.
3. `checkForUpdates` (line 455): when the release requires a newer VS Code, show *"Blacksite X needs
   VS Code 1.139 or newer (you have Y). Update VS Code, then Blacksite."* Do not download.
4. `installUpdate` (line 592): after `downloadVsix`, read `extension/package.json` `engines.vscode`
   out of the VSIX with `fflate` (already a dependency) and apply the same check. This also covers
   the GitHub-API fallback and prereleases, which have no manifest.
5. Tests in the existing update-service spec: range parsing, the gate message, and VSIX engine
   extraction.

### 0.2 The bump

| File | Change |
| --- | --- |
| `package.json` | `engines.vscode: "^1.139.0"`. Pin `@types/vscode` exactly (`~`) to the newest published version that is at most 1.139 (1.138.0 as of 2026-09-29), so typings enforce the floor from now on. Refresh the lockfile. |
| `esbuild.mjs:38` | `target: "node18"` → `node24` (fall back to `node22` if esbuild 0.25 rejects it) |
| `tsconfig.json`, `packages/*/tsconfig.json` | `target`/`lib` ES2022 → ES2024 |
| `vite.webview.config.mjs:75` | `es2022` → `es2024` |
| `README.md:45`, `docs/guide/getting-started.md:21`, `docs/guide/troubleshooting.md:15`, `CONTRIBUTING.md:26` | 1.85 → 1.139 |
| `CHANGELOG.md` | State plainly that forks on older bases (Cursor is on 1.105) can no longer install |

Gate: `npm run compile`, `npm run typecheck:webview`, `npm run lint`, `npm run test:unit`,
`npm run build`, and `npm run test:lsp:integration` (it already runs on `stable`). At bump time,
check the 1.138 typings for `findFiles2`. If it has been finalized, A1 uses it for non-git roots.

### 0.3 Unblocked, but separate work (not this effort)

- Mermaid 12. It is pinned to 11 because 12 needs ES2024 (see the mermaid memory note).
- The pdf.js modern build instead of `legacy/build` (`esbuild.mjs:33`, `:123`).

The floor bump is not required by any step below. It removes old-runtime constraints and makes the
typings honest. The worker (A2) uses `worker_threads`, which 1.85 already had.

---

## 3. Track A — Host pipeline at 20k+

### A1. Git-aware discovery

New pure module `src/graph/git-discovery.ts`. The runner and the NUL-separated output parser follow
the `git-log.ts` pattern.

- Group roots by repo toplevel (`git rev-parse --show-toplevel`), one process per unique toplevel.
- `git -c core.quotePath=false ls-files -z --cached --others --exclude-standard -- <root pathspec>`.
  The pathspec keeps a root nested inside a larger repo to its own subtree. Tracked files are always
  listed even if a pattern matches them; ignored untracked files are not.
- Map each path with `toNodeId`, then apply `isGraphIndexablePath` and `hasExcludedSegment` exactly
  as `_enumerate` does now. The dot-directory policy is unchanged.
- Fall back to today's `findFiles` path for non-git roots and on any git failure or timeout.
- New setting `blacksite.graph.respectGitignore` (default `true`), folded into
  `exclusionPolicyKey()` so toggling it invalidates the cache (the v13 `policyKey` mechanism).
- **Watcher:** `_markDirty` cannot shell out per event. In `_applyDirty`, run dirty paths that are
  not already in the corpus through one `git check-ignore -z --stdin` per batch before admitting
  them. Without this, a build writing thousands of files into an ignored directory forces a full
  rebuild.
- `collectGitStats` also runs once per toplevel, reusing the same grouping, with its results fanned
  out to every root in that repo.
- Bump `CACHE_SCHEMA_VERSION` 14 → 15 and `CORPUS_SCHEMA_VERSION` 2 → 3, with running-changelog
  comments as in the existing ones.
- The hidden-files note reports "ignored by .gitignore" alongside the dot-directory count, with the
  same inline toggle (`set_exclude_dot_directories` pattern → new `set_respect_gitignore`).

### A2. Graph worker

The pure compute moves off the extension host thread. `GraphIndexer` stays the orchestrator (VS Code
API calls, the watcher, config, events). A worker does file reads and compute.

- **New esbuild entry** `src/graph/worker/graph-worker.ts` → `out/graph-worker.js`. This is the
  first `worker_threads` use in the repo; keep the entry small and bundle only pure graph modules.
- **Refactor target (needed):** the private `_load*Index`, `_readTsconfigChain`, `_scanImports`,
  and `_resolveFileTargets` methods of `GraphIndexer` move into a pure `src/graph/scan-pipeline.ts`
  that takes `(files, readFile)`. The worker and the main-thread incremental path (`_applyDirty`,
  which stays on the main thread because dirty sets are small) both call it. Behavior is unchanged,
  so this move is its own commit.
- **One read per file.** The worker reads each file once, feeds every extractor (imports, C#/PHP/
  Python declarations, tsconfig chains, manifests for topology), then drops the content. The
  relationship indexer needs contents across files, so the worker passes it only the candidate
  source files (non-doc, non-test, which it already filters) instead of the whole corpus.
- `RelationshipSnapshot` gets its edges from the worker's job result instead of reading files
  itself. Its public `get()`, `full()`, and `fullAsync()` are unchanged.
- The layout (`createLayout`) also runs in the worker.
- **Progress:** `graph_indexing` gains optional `phase` (`discover | scan | relationships | layout`)
  and `progress` (0–1), shown in the existing "Indexing…" chip.
- **Cancellation:** a newer `rebuild()` terminates the in-flight worker (replacing today's
  `_rebuildQueued` flag).

### A3. Per-file facts cache

- `.blacksite/graph-facts.json` stores, per node id: `{ mtimeMs, size, specs[] }` plus declared
  names for `.cs`, `.php`, and `.py`, for every indexed file. A warm start only stats files and
  re-reads the ones that changed. Resolution reruns over cached specs, which is cheap and in-memory.
- The relationship result is cached against a corpus fingerprint (a hash of every `(id, mtimeMs,
  size)`). An unchanged workspace skips the relationship pass entirely on reload.
- Both caches are best-effort and derived, like `graph-cache.json`. Unreadable means recompute.

### A4. Delta updates instead of full re-posts

Protocol additions in [`lib/graph/protocol.ts`](../src/webview/react/lib/graph/protocol.ts),
mirrored in `graph-provider.ts`:

- `graph_delta { seq, baseSeq, upsertNodes, removeNodeIds, addEdges, removeEdgeIds, counts }`.
  `_applyDirty` already knows exactly which files changed. `graph_state` keeps its role for full
  rebuilds and gains `seq`.
- `relationships_state` and `structure_state` carry their own slices. `_relationships.onDidChange`
  stops calling `_postState()`.
- View-model: `applyMessage` patches `nodes` and `edges` for `graph_delta`, then re-runs
  `withDisplayGraph`. On a `baseSeq` mismatch it posts `refresh` and ignores the delta, so drift can
  never persist.
- Renderer: node add and remove already go through the birth and fade path. Check that a delta does
  not trigger `structureChanged` for untouched sprites.

### A5. Lay out every indexed file, and index nodes beyond the render cap

- Lay out `indexedFiles`, not just the rendered `files`. Above 6,000 nodes the packer is linear
  ([`layout.ts:530`](../src/graph/layout.ts#L530)). Persist positions for all of them (compactly in
  the cache), so the scope fill-in in B2 has stable coordinates.
- Keep a host-side **node index** for every indexed file: area, codebase, lang, degree, churn, and
  position. The render snapshot stays the projection it is today.
- Agent gateway: `overview` (areas, hubs), `find`, and `impact`'s area lookup read the node index,
  not `snapshot.nodes`. This fixes §1.1's sampled-orientation row.

---

## 4. Track C — Relationship depth

### C1. Workspace-package resolution (JS/TS), across every root

New pure `src/graph/workspace-packages.ts`, added to `ResolveContext` as `workspacePackages`:

- Read every `package.json` in the corpus (all roots). Map `name` → `{ dir, exports, main, module,
  types, source, imports }`.
- In `resolveSpecifier`, after the tsconfig alias attempt fails, resolve `@scope/name[/subpath]`:
  1. Conditional `exports` (`.` and subpaths, including `*` patterns). Prefer `source`, then
     `types`, `import`, and `default`.
  2. `main`, `module`, `types`, and `source`.
  3. `src/index.*`.
- When a target points into an excluded `dist/` or `out/` tree, probe the source twin (`dist/x.js`
  → `src/x.ts`), because build output is never in the corpus.
- `#internal/*` resolves through the package's `imports` field.
- Only names declared by a `package.json` in the corpus can match, so real npm packages never
  produce edges.

### C2. Other ecosystems by name

- **Rust:** Cargo `[package] name`, with `-` → `_`, maps to the crate root. `use other_crate::a::b`
  reuses the `resolveRustUse` walk from that root.
- **Python:** `pyproject.toml` `[project] name`, `tool.setuptools.packages.find.where`, and poetry
  `packages` seed per-root source roots for absolute modules.
- **Dart:** already resolves `package:` by directory name (`resolveDart`). Leave it.
- C#, Java, and Go already resolve across roots through namespace, FQCN, and `go.mod` indexes.

### C3. Multi-root correctness

- Absolute Python modules and web-root-absolute (`/icons/x.png`) refs try the importing file's own
  root prefix first.
- Add two-root fixtures to `graph-resolve.spec.ts` and `graph-workspace-roots.spec.ts`.

### C4. Project-level relationships, checked against usage

- Promote `ProjectTopology.references` to drawn `project_ref` edges (provenance `topology`) between
  project groups (§5 B1).
- For each project pair, compare the manifest-declared reference with actual file-level imports and
  service routes, and derive two findings:
  - **declared but unused:** a manifest dependency with zero imports;
  - **used but undeclared:** cross-project imports with no manifest reference, which usually means
    a path alias or a relative import reaching into a sibling.
- Show both in the codebase inspector and in the agent `overview` structure section, next to the
  existing cycles, orphans, and pockets.

### C5. Git co-change (logical coupling)

- `git-log.ts` returns per-commit file sets alongside the existing stats. It is the same single
  `git log`, now once per toplevel (A1).
- New pure `src/graph/cochange.ts`:
  - skip commits touching more than 40 files (formatting sweeps, renames);
  - require pair support of at least 3 and `support / min(churnA, churnB)` of at least 0.3;
  - keep the top 8 partners per file and a global cap.
- Edge kind `cochange`, provenance `history`. It is undirected (registered both ways, like notes, in
  `map-queries.ts`).
- On the map:
  - off by default at file level;
  - drawn at the Systems and codebase levels as a dashed link **only where no structural link
    explains it**, labeled "hidden coupling". That is the high-signal case.
- It covers roots that share a repository. Coupling across separate repositories is out of scope,
  because there is no shared commit identity.

### C6. Vocabulary and queries

- `EdgeKind` gains `project_ref` and `cochange`. `EdgeProvenance` gains `history`.
  `flow-signature.ts` gets a signature for each: `project_ref` reuses `settle` (declared once, then
  static), and `cochange` is a new slow two-way `echo`. The Map key updates automatically because it
  calls the same function.
- In `map-queries.ts` normalization, `project_ref` uses dependency direction and `cochange` is
  undirected.
- Gateway changes:
  - `overview` adds `codebases` with cross-codebase relationship counts per kind, from the hierarchy
    (B1);
  - `find` accepts `codebase`;
  - `relationships` includes co-change support and confidence;
  - `routes` may traverse `project_ref`.
- Update the matching tool descriptions in `src/tools/definitions.ts` (map tools around line 2217)
  and `skills/codebase-map/SKILL.md`.

---

## 5. Track B — Hierarchy and scoped presentation

### B1. Host hierarchy

New pure `src/graph/hierarchy.ts`, built each full rebuild over the **indexed** set (A5).

**Levels:** workspace → root (only with more than one root) → codebase (neighborhood root: a
topology container or project) → project (a topology project, when a codebase holds more than one)
→ area (cluster dir) → file.

- `assignNeighborhoods` already runs every rebuild. Only applying it to *layout* is gated by
  `shouldTerritorialize`. The hierarchy always uses it, now over indexed files.
- **Per group:** id, label (`neighborhoodLabel`), parent, true file count, rendered count, top
  languages, churn sum and latest commit, and centroid plus radius from the full layout.
- **Group edges:** per (group, group, kind) at each level, from full indexed imports, `project_ref`,
  service routes (`serviceFrom`/`serviceTo` → group), and `cochange`. Each carries count and
  maximum confidence.
- **Ids:** a distinct non-path prefix per level. Areas keep today's `▤` + dir, so persisted
  `collapsedClusters` and saved views stay valid. Codebase, project, and root ids get new prefixes.
- Sent as one `graph_hierarchy` message per rebuild. It holds hundreds to a few thousand groups, far
  smaller than `graph_state`.

### B2. Scope and budgeted folding (webview, pure)

New `src/webview/react/lib/graph/scope.ts`.

- **State:** `scope: string[]`, a breadcrumb of group ids where `[]` is the workspace. It is
  persisted with display prefs, and `SavedView` gains `scope`.
- **Landing rule (`blacksite.graph.landingView`: `auto | systems | files`, default `auto`):**
  - with two or more codebases and a corpus over the focus budget, open on the **Systems** level
    (codebases folded, with root hulls in multi-root);
  - with one codebase over budget, open on its areas;
  - otherwise, open on files, exactly as today.
- **`foldForBudget(hierarchy, scope, interest, budget)`** returns the groups to render folded, with
  everything in scope under budget kept as files:
  - `interest` is degree-of-interest: selection, live agent activity, open tickets, recent notes,
    and search hits keep their groups expanded;
  - `budget` is the display option `focusBudget` (default 2,500, adjustable under Advanced).
    `maxRenderedStars` stays the hard host ceiling.
- **Refactor target (needed):** `deriveDisplayGraph`'s collapse matching goes from exact `node.dir`
  to the longest folded ancestor group. Explicit user collapse and expand still win over the budget.
  The no-fold case must still return the inputs by reference, which keeps the renderer's fast path.
- **Out-of-scope signals roll up.** A trace, live activity, or ticket on a file inside a folded
  group pulses or badges that group node, so the Systems view still shows where the agent is
  working. Resolve paths to groups with a prefix lookup built from the hierarchy.
- **Scope fill-in (additive, not a new model):** the webview keeps the global render projection it
  has today. When the active scope contains indexed files that the global sample dropped
  (`indexedTruncated`/`renderedTruncated`), it posts `request_scope_detail { groupId }`. The host
  answers with `scope_detail { nodes, edges }` from the node index (A5), up to `maxRenderedStars`,
  and the webview merges them into `nodes`. Everything that reads `view.nodes` today keeps working.
- **Search:** keep local search. When the projection is truncated and local results come up short,
  add a debounced `search_corpus` request to the host.

### B3. Scope bar (top)

- A breadcrumb (`Workspace › frontend › apps/web › src/features/auth`) fused with the existing
  `SearchBar`. Results show their breadcrumb, and picking one scopes into its codebase before the
  existing `flyToNode`.
- Double-click or Enter on a group scopes in, extending `actions.activateNode`. Backspace or Alt+↑
  goes up one level.
- Transitions reuse `flyTo` plus the motion pass's `spawnOrigin` bloom. No new animation system.

### B4. Outline rail (left)

- A collapsible hierarchy tree with true counts and badges: open tickets, notes, a live-agent dot,
  and a git-heat bar.
- Hover previews through the existing `hoveredTerritory` seam, and click scopes.
- It absorbs `TerritoriesSection` and `HubsSection`; hubs are listed for the current scope.
- It becomes a drawer below 720 px, matching the controls rail's breakpoint, so the sidebar view
  stays usable. "Open in editor" remains the full experience.

### B5. Unified inspector (right)

- One shell for file, group, service, ticket, and edge selections, with tabs **Overview ·
  Relations · Work · Activity · Notes · References**.
- The four existing card bodies become tab content. Move them into `apps/graph/inspector/`.
- **Relations** groups relationships by kind and by counterpart codebase, and shows provenance and
  confidence. For example: "import · via workspace package `@acme/ui`", "co-changed in 14 of 20
  commits", "declared in `package.json`, no imports".

### B6. Slimmer controls

"Display & analysis" becomes a compact popover:

- **Lens:** Structure · Services · Work.
- **Overlays:** Git heat, Ticket heat, Agent activity, Notes, References, Co-change, Cycles,
  Cul-de-sacs.
- **Edges:** Adaptive and the rest, as today.
- Depth, neighborhood mode, focus budget, and capacity move under **Advanced**.

### B7. Hierarchical color

- Today each folder hashes to its own hue. Instead, each codebase gets a stable hue family, and its
  areas vary lightness and saturation within it. At file level, a star's hue then tells you its
  codebase.
- The change is confined to `colors.ts` (`folderColor`), and the git-heat and ticket-heat mixes
  already compose from `baseTintById`.
- Root hulls reuse the territory hull path.

### B8. Split `GraphApp.tsx` first (move-only commit)

Move panels into `src/webview/react/apps/graph/panels/`: `ScopeBar`, `OutlineRail`, `inspector/*`,
`MapControls`, `Legend`/`MapKeyPanel`, `RunPlaybackControls`, and `LspDiagnostics`, with no behavior
change. This is the only structural webview refactor besides B2's fold matching. It lands before any
redesign commit so the diffs stay reviewable.

### Renderer

- A new `group` node kind reuses the cluster super-node path (`clusterRingTexture`, `renderer.ts`
  near line 1001), with a count label and level-specific ring.
- Group edges draw as bundled routes through the existing backbone and bundle code
  (`clusterBackboneEdges`, service bundles).
- Label bands map onto the levels: territory = codebase, hub = area.
- No new scene layers. No WebGPU.

---

## 6. Track D — Work, activity, and knowledge in context

| Surface | Change |
| --- | --- |
| **Tickets** | The inspector **Work** tab lists tickets whose territory covers the selection (the host already resolves territories, `ticket-store.ts:687-749`). Ticket counts roll up into outline badges. The Work lens becomes scope-aware. A "File ticket for this area" action pre-fills `areas`, following the `make_ticket_from_note` pattern. |
| **Runs** | New host `src/graph/run-footprints.ts`: per finalized run, `{ runId, title, status, endedAt, files: {path, kinds, count}[] }` (capped), built lazily through `RunPlaybackProvider.getMapEventWindow` and cached in `.blacksite/map/run-footprints.json`. Finalized runs are immutable, so this is append-only. The **Activity** tab lists the runs that touched the selection, newest first, with "Replay on map" (existing `select_run`/`seek_run` to the first touch) and "Open run". The playback scrubber gains a scope filter that dims events outside the scope. |
| **Notes** | The **Notes** tab shows notes on the selection, or rolled up across a group, with category chips. "Open in timeline" deep-links to the Notes timeline filtered to that file or group (a new filter message in `notes-timeline-provider.ts` and its protocol). |
| **References** | New host `src/graph/reference-links.ts` links attachments to code. Sources: every session's attachments (`ReferenceStore.listSessions`), `Extracted context.md`, text attachments, and PDF page text already in the DB (`pdf-index.ts`). Signals: workspace path mentions (reuse `doc-links.ts` plus the basename index), distinctive basenames, and **API route strings matched against relationship-indexer providers** (`POST /api/orders` → the provider file). The **References** tab lists linked attachments, and "Open" uses their `workspacePath`. A References overlay places reference satellites near their targets. `map_relationships` returns the links so the agent knows which attached docs describe a file. |
| **Timeline strip** (stretch, behind a toggle) | A scoped strip combining commits, run footprints, note creations and revisions, and ticket opens and closes for the current scope. Scrubbing drives the existing run playback, and clicking focuses the note or ticket. |

---

## 7. Build order

Each phase is shippable on its own. Suggested release grouping is on the right.

| Phase | Work | Test gate | Release |
| --- | --- | --- | --- |
| P0 | 0.1 updater engine gate | update-service spec | 1.30 |
| P1 | A1 git-aware discovery + git once per toplevel; A4 delta and message split | new `graph-git-discovery.spec.ts`; `graph-view-model.spec.ts` (delta and seq mismatch); `graph-indexer-capacity.spec.ts` | 1.30 |
| P2 | 0.2 floor → 1.139 | full build, lint, unit, LSP integration | 1.31 (bump alone, one line in the notes) |
| P3 | A2 `scan-pipeline.ts` move (own commit), then the worker; A3 facts cache; A5 full-index layout and node index, gateway on the node index | existing indexer/relationship specs unchanged; new pipeline spec; gateway spec on a truncated fixture | 1.32 |
| P4 | C1–C3 resolution (workspace packages, Rust/Python names, multi-root) | `graph-resolve.spec.ts` two-root and monorepo fixtures | 1.32 or 1.33 |
| P5 | C4 project edges with declared/used checks; C5 co-change; C6 vocabulary and queries | `graph-project-topology.spec.ts`, new `graph-cochange.spec.ts`, `graph-map-queries.spec.ts`, `graph-flow-signature.spec.ts` | 1.33 |
| P6 | B8 move-only split; B1 hierarchy; B2 scope, fold, landing; B3 scope bar | new `graph-hierarchy.spec.ts`, `graph-scope.spec.ts` (fold budget, landing rule, no-fold returns by reference); `graph-canvas-navigation.spec.ts` | 1.34 |
| P7 | B4 outline, B5 inspector, B6 controls, B7 color | view-model and label specs; manual visual pass | 1.34 |
| P8 | D tickets, runs, notes, references | new `graph-run-footprints.spec.ts`, `graph-reference-links.spec.ts`; work-lens spec | 1.35 |
| P9 | D timeline strip (stretch) | — | later |

P4 and P5 do not depend on P3 and can come first if relationships matter sooner. P6 needs A5's
full-index layout and C4's group edges to be meaningful.

---

## 8. Verification

- **Every phase:** `npm run compile`, `npm run typecheck:webview`, `npm run lint`,
  `npm run test:unit`, and `npm run build`.
- **Scale fixture:** add `scripts/gen-map-fixture.mjs`, which writes a synthetic two-root git
  workspace (about 25k files; a TS monorepo with three `@acme/*` packages, a Python service, a Rust
  workspace, an ignored `generated/` tree, and scripted commits for co-change) into the scratch or
  temp directory. Launch the Extension Development Host on it, then check:
  1. time to first paint from cache, and a full rebuild's wall time before and after P1/P3 (log
     phase timings from the worker);
  2. chat streaming stays smooth during a full rebuild (the P3 goal);
  3. `generated/` never appears, and toggling `respectGitignore` rebuilds;
  4. editing one file sends a `graph_delta`, not `graph_state` (message log in webview devtools);
  5. `import "@acme/shared"` in root A draws an edge into root B's package source;
  6. the map opens on Systems with three codebases and cross-codebase links; drilling in shows every
     file of a codebase even though the global projection was truncated;
  7. live agent activity in a folded codebase pulses its Systems node.
- **This repository:** a regression pass. It is small and single-codebase, so it must still open on
  files exactly as today.
- **`depthIntensity: 0` rendering and `collapsedClusters` saved views** from before the change
  still restore.

---

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| `.gitignore` hides generated clients a user wants on the map | Setting plus the "ignored by .gitignore" note with an inline toggle; tracked files are always listed |
| Worker memory at 150k files | One read per file with contents dropped after extraction; the relationship pass only gets candidate source files; capped by `maxIndexedFiles` |
| Delta protocol drift | `seq`/`baseSeq`; any mismatch forces a full `graph_state` |
| Systems landing surprises existing users | `landingView` setting; the Systems level has a "Show all files" action; small workspaces are unchanged |
| Co-change noise | Skip commits over 40 files; support and confidence floors; off by default at file level; shown at Systems level only when nothing structural explains it |
| Workspace-package false edges | Only names declared by a `package.json` in the corpus resolve |
| Larger caches (positions for every indexed file, facts) | Compact encodings; best-effort and derived; schema bumps discard old ones |
| A 1.139 floor excludes forks | Accepted. Called out in the CHANGELOG; the updater gate prevents failed installs |
| `GraphApp.tsx` churn | The move-only split (B8) lands before any redesign commit |

## 10. Not in this effort

- Exposing map queries to VS Code's own agents (LM tools or MCP). Deferred by the user.
- A renderer rewrite, WebGPU, or blur/depth-of-field.
- Mermaid 12 and the pdf.js modern build, which the floor unblocks but which are separate work.
- Co-change across separate repositories.

## 11. Docs to update as phases land

- `codebase-map.md`: §3 pipeline (git discovery, worker, facts cache), §9 persistence (scope,
  `focusBudget`), §10 (full-index node index; retire the "next hardening step" paragraph), and a new
  hierarchy/scope section plus rows in the file map.
- `guide/map-guide.md`: Systems overview, scope navigation, outline and inspector, new overlays.
- `guide/settings-and-commands.md`: `respectGitignore`, `landingView`.
- `skills/codebase-map/SKILL.md` and the map tool descriptions in `src/tools/definitions.ts`.
- `CHANGELOG.md` for each release, and the floor change in `README.md` and the guides (0.2).
