# Codebase Map — Corpus Hygiene & Dimensional Depth

Status: **shipped in 1.23.0** · Owner: Blacksite VS Code extension · Surface: `blacksite.graph`

Both tracks landed. Measured outcome on this repository: the corpus went from
1,256 files to 690 — 566 dropped (45.1%), 560 of them `.vscode-test`.
Allowlisting `.github` brings it back to 694, as designed.

Two deviations from the plan as written, both documented at their call sites:

- **§7.4 edge depth** is bucketed into three depth bands rather than modulated
  per edge. Import edges are drawn as one batched `Graphics.stroke()`, and a
  stroke commits everything accumulated since the previous one — so per-edge
  alpha would have meant one stroke call per edge instead of one per layer.
  Three bands keep the batch at three calls and still read as recession.
- **§7.5 parallax** is budget-gated (`PARALLAX_MAX_NODES` / `PARALLAX_MAX_EDGES`)
  because it makes drawn position camera-dependent, which forces an edge-layer
  redraw on every pan. Above the budget the other four cues still run. Hulls,
  zones, and the HTML label overlay deliberately stay on layout coordinates:
  at 4% of pan-from-centroid the offset is smaller than `ZONE_PADDING_BASE`, so
  nothing visibly separates from its territory.

Companion docs: [`guide/map-guide.md`](./guide/map-guide.md), [`codebase-map.md`](./codebase-map.md), [`guide/settings-and-commands.md`](./guide/settings-and-commands.md)

Two enhancements to the Codebase Map that are independent in code but related in
purpose — both are about **what the map spends its resolution on**.

**Track A (§2–§5): corpus hygiene.** Dot-directories are indexed today. On this
very workspace that is 45% of the map, and none of it is the user's code.

**Track B (§6–§11): dimensional depth.** Nodes already carry a `z` depth cue, and
the renderer uses it for exactly one thing — alpha. The parallax math written to
consume it has never been called. This track makes `z` a real spatial dimension
*and* makes what `z` encodes selectable.

Track A ships first. It is smaller, it is a strict improvement with a measurable
win, and it shrinks the node count that Track B's per-frame work is proportional to.

---

## 1. Evidence

Measured from this workspace's own `.blacksite/corpus.json` on 2026-08-31:

| Dot-directory | Files indexed | Share of corpus |
| --- | ---: | ---: |
| `.vscode-test` | 560 | 44.7% |
| `.github` | 4 | 0.3% |
| `.tmp-screenshot` | 1 | 0.1% |
| `.vscode` | 1 | 0.1% |
| **Total dot-dir** | **566** | **45.2%** |
| Real workspace source | 687 | 54.8% |
| **Corpus total** | **1253** | |

`.vscode-test` is a *downloaded VS Code build* — an integration-test fixture, not
authored code. It is nearly half the map. Every one of those 560 files is
enumerated, read, import-scanned, laid out by the force solver, and drawn.

This is not a display nuisance. It is a cost multiplier on the entire host
pipeline and it distorts every derived signal the map computes:

- **Layout.** The force solver packs 560 foreign files into territories that
  compete with real ones for space and pull real clusters off their natural
  positions.
- **Capacity.** `autoEscalatedProfile()`
  ([`graph-indexer.ts:129-133`](../src/graph/graph-indexer.ts#L129-L133))
  escalates the performance profile off the *true file count*. Fixture files can
  push a workspace into `large`, paying `large`-tier cost for a `balanced`-tier
  project.
- **Analysis.** Cul-de-sac detection, cycle detection, and neighborhood
  territorialization all reason over a corpus that is half fixtures. `.vscode-test`
  is a near-perfect orphan blob — exactly the shape those layers are built to
  flag.
- **Git heat.** Vendored files have no churn, so they render as a large cold
  region that is cold for an uninteresting reason.

### 1.1 Why the current exclusion list misses this

[`graph-indexer.ts:89-90`](../src/graph/graph-indexer.ts#L89-L90) holds two
hand-maintained literals that must be kept in sync by hand:

```ts
const EXCLUDE_GLOB = "**/{node_modules,.git,.blacksite,dist,out,build,.next,coverage,__pycache__,.venv,venv}/**";
const EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", ".blacksite", "dist", "out", "build", ".next", "coverage", "__pycache__", ".venv", "venv"]);
```

Four dot-directories are named (`.git`, `.blacksite`, `.next`, `.venv`) — which
is the tell: the *category* was always the intent, but it was expressed as an
enumeration. Every dot-directory not on the list gets indexed, and the list can
never be complete. `.vscode-test`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`,
`.gradle`, `.idea`, `.nuxt`, `.svelte-kit`, `.terraform`, `.tox`, `.nx`, `.turbo`,
`.parcel-cache`, `.yarn`, `.pnpm-store`, `.cargo`, `.stack-work`, `.dart_tool`,
`.angular`, `.astro` all fall through today.

The general rule already has ecosystem consensus: a leading dot means "tooling
state, not authored source." Encoding the rule is strictly better than extending
the enumeration.

---

## 2. Track A — the exclusion rule

### 2.1 Setting surface

Two new settings under `blacksite.graph`, registered in `package.json`
alongside the existing block at lines 533–668:

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `blacksite.graph.excludeDotDirectories` | boolean | `true` | Skip every directory whose name begins with `.` |
| `blacksite.graph.dotDirectoryAllowlist` | string[] | `[]` | Dot-directories to index anyway, e.g. `[".github"]` |

Default-on is the right call and worth stating plainly: the current behavior is
a bug that happens to be the status quo. A user who wants `.github` workflows on
their map adds one allowlist entry; a user who wants `.vscode-test` on their map
does not exist.

The allowlist matches on the **segment name**, not a path, so `.github` allows it
at any nesting depth. Entries are normalized (trimmed, leading `./` stripped,
case-folded on Windows) and a leading dot is optional — `github` and `.github`
both work, because requiring users to remember the dot is a papercut with no
upside.

### 2.2 Config plumbing

Extend `GraphConfig` in [`graph/config.ts`](../src/graph/config.ts):

```ts
export interface GraphExclusionConfig {
  excludeDotDirectories: boolean;
  dotDirectoryAllowlist: readonly string[];
}

export interface GraphConfig extends GraphCapacityConfig, GraphExclusionConfig { … }
```

Add a pure `resolveGraphExclusions(raw)` next to the existing
`resolveGraphCapacity()`, following that function's established shape — coerce
loosely, clamp, never throw on malformed user settings. It is pure, so it is
unit-testable with no VS Code host, matching how `graph-config.spec.ts` already
tests capacity resolution.

Read it in `readGraphConfig()`:

```ts
excludeDotDirectories: cfg.get<boolean>("excludeDotDirectories", true),
dotDirectoryAllowlist: readAllowlist(cfg.get("dotDirectoryAllowlist")),
```

### 2.3 The exclusion module

New file `src/graph/exclusions.ts` — pure, no `vscode` import, so it unit-tests
directly. This is the same separation-of-concerns move
[`file-discovery.ts`](../src/graph/file-discovery.ts) already makes for the
corpus boundary, and the header comment should say so.

```ts
/** Directory segments the map never indexes, regardless of settings. */
const ALWAYS_EXCLUDED = new Set([
  "node_modules", ".git", ".blacksite", "dist", "out", "build",
  ".next", "coverage", "__pycache__", ".venv", "venv",
]);

export interface ExclusionPolicy {
  excludeDotDirectories: boolean;
  allowlist: ReadonlySet<string>;
}

export function normalizeAllowlistEntry(raw: string): string | null;

export function isExcludedSegment(segment: string, policy: ExclusionPolicy): boolean;

/** True when any path segment is excluded under `policy`. Replaces
    graph-indexer's hasExcludedSegment(). */
export function hasExcludedSegment(relPath: string, policy: ExclusionPolicy): boolean;

/** The findFiles exclude glob for `policy`. Dot-directories cannot be
    expressed as a brace list, so the dot rule is enforced post-scan by
    hasExcludedSegment — see §2.5. */
export function buildExcludeGlob(policy: ExclusionPolicy): string;
```

Note `ALWAYS_EXCLUDED` keeps `.git`/`.blacksite`/`.next`/`.venv` explicitly even
though the dot rule subsumes them. That is deliberate: turning
`excludeDotDirectories` off must never start indexing `.git`. The dot rule is a
*default convenience*; these four are *invariants*.

### 2.4 Indexer integration

Four call sites in [`graph-indexer.ts`](../src/graph/graph-indexer.ts):

| Line | Current | Change |
| --- | --- | --- |
| [401](../src/graph/graph-indexer.ts#L401) | `hasExcludedSegment(rel)` (watcher) | pass the resolved policy |
| [428](../src/graph/graph-indexer.ts#L428) | `EXCLUDE_GLOB` (main enumerate) | `buildExcludeGlob(policy)` + post-filter |
| [646](../src/graph/graph-indexer.ts#L646) | `EXCLUDE_GLOB` (go.mod scan) | same |
| [764](../src/graph/graph-indexer.ts#L764) | `EXCLUDE_GLOB` (topology globs) | same |

The policy is resolved once per index run from `this._config()` and threaded
through, rather than read per-file. The watcher at line 401 matters as much as the
enumerate path: without it, creating a file under a dot-directory during a session
would re-add it to a corpus the full scan had excluded.

### 2.5 The glob limitation, and why the post-filter is required

VS Code's `findFiles` exclude pattern is a brace/star glob. It has **no way to
express "any segment starting with a dot"** — `**/.*/**` matches a literal
segment of `.` followed by anything, and does not reliably match arbitrary
dot-named directories across VS Code's glob implementation.

So the dot rule cannot live in the glob. The design is:

1. `buildExcludeGlob(policy)` emits the brace list for `ALWAYS_EXCLUDED` plus any
   *known* dot-directories worth naming for scan-time pruning (see below).
2. The dot rule is enforced in the loop at
   [graph-indexer.ts:434-439](../src/graph/graph-indexer.ts#L434-L439), right
   next to the existing `isGraphIndexablePath(rel)` check, via
   `hasExcludedSegment(rel, policy)`.

This is correct but not free: excluded files are still *enumerated* by
`findFiles` before being dropped, so they consume `RAW_SCAN_CAP` budget. They are
never read, never import-scanned, never laid out — which is where the real cost
is — but on a workspace with a genuinely enormous dot-directory the raw scan
still walks it.

**Mitigation:** seed the glob's brace list with a curated set of high-volume
dot-directories (`.vscode-test`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`,
`.gradle`, `.idea`, `.tox`, `.terraform`, `.nuxt`, `.svelte-kit`, `.turbo`,
`.parcel-cache`, `.yarn`, `.dart_tool`, `.angular`, `.astro`, `.stack-work`)
minus anything in the allowlist. This gets scan-time pruning for the cases that
actually matter while the general rule catches the tail. The curated list is an
*optimization*, not the mechanism — correctness lives entirely in the post-filter,
so a missing entry costs scan time and nothing else.

### 2.6 Cache invalidation

Bump `CACHE_SCHEMA_VERSION` 12 → 13
([`graph-indexer.ts:83`](../src/graph/graph-indexer.ts#L83)) with a comment in
the established running-changelog style:

> v13: dot-directories are excluded from discovery by default, so a v12 cache
> carries fixture/tooling nodes the new corpus does not — it would paint a
> materially denser map, and its layout was solved against a node set that no
> longer exists.

`CORPUS_SCHEMA_VERSION` ([`corpus.ts:13`](../src/graph/corpus.ts#L13)) bumps 1 → 2
for the same reason.

Changing either setting must also invalidate — the resolved policy is part of
what the cache is derived from. Add a `policyKey` (a stable hash of the resolved
policy) to the cache header and treat a mismatch as a rebuild trigger, the same
way a version mismatch is treated. Without this, toggling the setting leaves the
user staring at an unchanged map.

### 2.7 Discoverability

Silent removal of 45% of a map is its own failure mode: a user who *wanted*
`.github` on the map has no way to learn why it vanished.

Where the map already reports truncation, add a line to the same surface:
`"566 files in dot-directories hidden"` with an inline affordance to allowlist or
disable the rule. The counting is free — it is the difference between the raw
enumerate count and the post-filter count, both of which already exist in
`_enumerate()`'s return shape.

### 2.8 Track A tests

New `tests/unit/graph-exclusions.spec.ts`:

- `.vscode-test/foo.ts` excluded, `src/foo.ts` kept
- nested dot-dir (`packages/x/.cache/y.ts`) excluded — segment rule, not prefix rule
- dot-*file* (`src/.eslintrc.json`) **kept** — the rule is directories only, and a
  dot-file is authored config the map should keep
- allowlist round-trips: `.github`, `github`, `./github/` all allow `.github/w.yml`
- `excludeDotDirectories: false` still excludes `.git` and `.blacksite`
- malformed settings (`null`, `[1, 2]`, `""`) resolve to the default without throwing

Extend `tests/unit/graph-config.spec.ts` for `resolveGraphExclusions`, and
`tests/unit/graph-file-discovery.spec.ts` for the discovery interaction.

---

## 3. Track A — build order

| Step | Work | Test gate |
| --- | --- | --- |
| A1 | `src/graph/exclusions.ts` + `graph-exclusions.spec.ts` | new spec green |
| A2 | `GraphConfig` extension + `resolveGraphExclusions` | `graph-config.spec.ts` |
| A3 | `package.json` settings + `settings-and-commands.md` row | — |
| A4 | Indexer: thread policy through all 4 call sites | `graph-indexer-capacity.spec.ts` |
| A5 | Schema bumps + `policyKey` invalidation | rebuild-on-toggle verified in-app |
| A6 | Hidden-count reporting + allowlist affordance | — |

A1–A4 are the functional change; A5–A6 are what make it not feel like a bug.

---

## 4. Track B — where depth stands today

`z` exists end-to-end and is almost entirely unused.

**Host side.** `depthFromDegree(inDegree, outDegree, maxDegree)`
([`graph-model.ts:396-402`](../src/graph/graph-model.ts#L396-L402)) maps log-scaled
total degree into `[0.15, 1]`. It is called at
[`graph-indexer.ts:868`](../src/graph/graph-indexer.ts#L868) and
[`:1133`](../src/graph/graph-indexer.ts#L1133), and baked into the cache.

**Wire.** `GraphNode.z` ([`protocol.ts:20`](../src/webview/react/lib/graph/protocol.ts#L20)).

**Render.** One consumer, at
[`renderer.ts:982`](../src/webview/react/apps/graph/scene/renderer.ts#L982):

```ts
const base = 0.45 + 0.55 * node.z;
```

That is the whole of it. `z` moves alpha across a 0.45→1.0 band and nothing else.

**Dead code.** `parallaxFactor(z)` and `worldToScreenParallax(...)`
([`camera.ts:203-215`](../src/webview/react/lib/graph/camera.ts#L203-L215)) are
exported and called by **nothing** — not the renderer, not `GraphApp`, not a test.
The intent was clearly there; the wiring never happened.

**The only real depth today** is two background containers with fixed parallax
factors (0.8 far, 0.92 mid) at
[`renderer.ts:1594-1600`](../src/webview/react/apps/graph/scene/renderer.ts#L1594-L1600),
carrying decorative starfields and nebulae. The actual content — every file, every
edge — renders flat in a single `world` container.

So the map has a parallax *backdrop* and a flat *foreground*. The depth cue stops
exactly where the data begins.

---

## 5. Track B — the double-encoding problem

A load-bearing observation that shapes the whole design:

**`z` and node radius are currently the same signal.** `depthFromDegree` is a
function of degree; `graphNodeRadius`
([`view-model.ts:1898-1916`](../src/webview/react/lib/graph/view-model.ts#L1898-L1916))
is `2.5 + min(9, sqrt(degree) * 1.1)` plus a log size term. Both are degree.

So adding scale-falloff-by-`z` on top of today's `z` does not add a dimension —
it *amplifies the one already encoded twice*. Hub files would get bigger for being
hubs, then bigger again for being near. The map would look more three-dimensional
while carrying strictly less information per pixel.

Two consequences:

1. **The channel work is not optional polish — it is what makes the render work
   mean anything.** This is the argument for doing both tracks of §6 together.
2. **The default depth channel should not be `degree`.** Recommend `nesting`
   (directory depth) as the default: it is orthogonal to radius, it is stable
   under edits, it needs no git or LSP data, and it matches the intuition people
   already have about a codebase — entry points sit at the surface, deeply nested
   implementation sits further down.

---

## 6. Track B — design

Two halves that compose:

- **B-render (§7):** make `z` a genuine spatial dimension in the scene.
- **B-channel (§8):** make what `z` *means* selectable.

### 6.1 Where the channel is computed — webview, not host

`z` is host-computed and baked into the cache today. Making the channel
host-selectable would mean a message round-trip and a re-index on every channel
change. Unnecessary: **every input the channels need is already on `GraphNode`.**

| Channel | Inputs | Already on the wire? |
| --- | --- | --- |
| `degree` | `inDegree`, `outDegree` | yes |
| `nesting` | `id` (path segments) | yes |
| `layer` | `inDegree`, `outDegree` | yes |
| `recency` | `lastCommitAt` | yes |
| `churn` | `churn` | yes |
| `size` | `sizeBytes` | yes |

So the channel is a pure webview projection over data already in hand: instant,
no host round-trip, no cache bump, no new protocol fields. `node.z` from the host
stays as-is and becomes the `degree` channel's precomputed value.

---

## 7. B-render — making `z` spatial

Ordered by payoff-to-risk. **Ship in this order**; each step is independently
valuable and independently revertable.

### 7.1 Atmospheric perspective (do this first)

The single highest-value cue, and geometrically risk-free. Distant objects lose
contrast and shift toward the background — real, physical, and instantly readable.

`mixColors(a, b, t)` already exists in
[`colors.ts:169`](../src/webview/react/lib/graph/colors.ts#L169), and
`BACKGROUND_COLOR` is `0x080b14`. The whole cue is one tint change at the point
where sprite tint is assigned:

```ts
const haze = HAZE_STRENGTH * (1 - node.z);
sprite.tint = mixColors(baseTint, BACKGROUND_COLOR, haze);
```

Zero geometry impact, zero hit-test impact, zero per-frame cost beyond a tint
write that already happens. Cap `HAZE_STRENGTH` around 0.45 so far nodes recede
without becoming unreadable — they must stay clickable, and a ghosted node is
already a *different* meaning in this map's vocabulary
([`GHOST_ALPHA`](../src/webview/react/apps/graph/scene/renderer.ts)).

**Interaction to respect:** haze must compose with, not override, the git-heat and
ticket-heat tints. Those are analytical layers where hue *is* the answer. Apply
haze after the heat mix, at reduced strength when a heat lens is on.

### 7.2 Depth-sorted draw order

Set `nodeLayer.sortableChildren = true` and `sprite.zIndex = node.z`. Near stars
occlude far ones instead of z-fighting by insertion order.

Pixi 8 sorts only when the layer is marked dirty, so the cost is one sort per
node-set rebuild, not per frame. Neither `sortableChildren` nor `zIndex` is used
anywhere in the renderer today — clean slate.

Small and unglamorous, but it is what makes 7.1 and 7.3 read as depth rather than
as "some stars are dimmer."

### 7.3 Scale falloff

Multiply the existing `nodeSpriteScale(graphNodeRadius(node), …)` result at
[`renderer.ts:1054`](../src/webview/react/apps/graph/scene/renderer.ts#L1054) by a
depth term:

```ts
const depthScale = DEPTH_SCALE_MIN + (1 - DEPTH_SCALE_MIN) * node.z;   // ~0.72 → 1.0
```

**Gated on the channel not being `degree`** — see §5. Under the `degree` channel
this multiplier is pure double-encoding and should be held at 1.0.

`nodeSpriteScale` already enforces a minimum on-screen pixel radius, so falloff
cannot shrink a far node below visibility. Verify the depth multiplier is applied
*before* that floor, not after, or the floor stops protecting anything.

### 7.4 Edge depth

Edges currently draw at a uniform per-layer alpha via `edgeLayerAlpha(zoomRatio)`
([`camera.ts:96-103`](../src/webview/react/lib/graph/camera.ts#L96-L103)).
Modulate per-edge by the mean `z` of its endpoints, so a connection between two
deep files recedes with them and a hub-to-hub connection sits forward.

Keep the modulation gentle — the comment at `edgeLayerAlpha` documents a real
hard-won constraint (hundreds of overlapping strokes through the same pixels
saturate toward opaque regardless of per-edge alpha). Depth modulation must not
reintroduce the hub-glare bug that ceiling was lowered to fix. Multiply the
existing alpha by a bounded `[0.55, 1.0]` depth term rather than recomputing it.

### 7.5 Parallax (last, and gentler than the dead code)

The highest-risk item, and the one to ship behind a strength setting after 7.1–7.4
are stable.

**The math.** The `world` container applies `x_screen = (x - cx) * zoom + W/2`.
The dead `worldToScreenParallax` wants `x_screen = (x - cx * f) * zoom + W/2`.
Equating gives the world-space offset to bake into a node's draw position:

```text
offset = cx * (1 - parallaxFactor(z))
```

**The problem with the dead code as written.** `parallaxFactor` returns
`0.85 + 0.15 * z`, so `1 - f` reaches 0.15 — and the offset is proportional to
**absolute camera position**. At `cx = 5000` world units, a far node is displaced
750 world units from its true layout position. Hulls, cluster zones, territory
labels, and edge endpoints would all tear apart from the nodes they belong to.
This is very likely why it was never wired up.

**The fix:** anchor parallax to the **layout centroid**, not the world origin, and
cut the strength hard:

```ts
offset = (cx - layoutCentroidX) * (1 - parallaxFactor(z))
parallaxFactor(z) = 1 - PARALLAX_STRENGTH * (1 - z)   // PARALLAX_STRENGTH ≈ 0.04
```

Displacement is now bounded by how far the camera has panned *from the map's own
center*, times 4% — a few world units at normal viewing distance. It reads as
depth on motion and is geometrically negligible at rest. `parallaxFactor` should
be rewritten to this form and the old one deleted rather than left as a second
unused export.

**Consistency is the hard requirement, not the strength.** Every consumer of a
node's position must apply the same offset, or the scene delaminates:

| Consumer | Location | Note |
| --- | --- | --- |
| Sprites | `sprite.position.set` at [renderer.ts:2029-2039](../src/webview/react/apps/graph/scene/renderer.ts#L2029-L2039) | primary write |
| Edges, focus rings, traces, live rings | `posOf()` at [renderer.ts:1653](../src/webview/react/apps/graph/scene/renderer.ts#L1653) | single chokepoint — inherits for free |
| HTML labels | `worldToScreen` in [GraphApp.tsx](../src/webview/react/apps/graph/GraphApp.tsx) (11 call sites) | must switch to the parallax-aware projection |
| Hulls / cluster zones | `paddedHull` inputs | must use offset positions or they detach |
| Hit-testing | Pixi sprite `eventMode` | inherits automatically — sprites carry their own hit areas |

`posOf()` doing this work is the key structural win: edges, focus rings, traces,
and live rings all read through it, so one change covers five consumers.

`SpatialGrid` ([`spatial-index.ts`](../src/webview/react/lib/graph/spatial-index.ts))
indexes *layout targets* for viewport culling. Leave it on untransformed
coordinates and widen the overscan margin by the maximum possible parallax offset
— rebuilding the grid per camera move would defeat its purpose entirely.

**Reduced motion.** `usesSimplifiedNodeMotion()` already gates animation on
`reducedMotion` and node count. Parallax is motion: force `PARALLAX_STRENGTH` to 0
under that same gate. A user who asked the OS for reduced motion did not ask for
a shearing starfield.

### 7.6 What not to do: per-band blur

Real depth-of-field via `BlurFilter` on depth-banded containers is the obvious
next idea and should be explicitly rejected. Pixi filters force a render-texture
pass per filtered container — three bands is three full-scene passes per frame,
on a canvas that already targets 4000+ sprites at `MAX_FPS`. §7.1's haze buys most
of the perceptual effect for none of the cost. Revisit only if profiling ever
shows headroom, and never on the `analyticalOverview` path.

---

## 8. B-channel — making `z` mean something selectable

### 8.1 The channels

| Channel | Depth means | Formula sketch | Best for |
| --- | --- | --- | --- |
| `nesting` **(default)** | how deep in the tree | `1 - clamp(segments / maxSegments)` | "where is the surface of this codebase" |
| `degree` | how connected | existing host `node.z` | matches today's behavior |
| `layer` | entry → core → leaf | `outDeg / (inDeg + outDeg)` normalized | architectural flow |
| `recency` | how recently touched | `recencyFraction(lastCommitAt, …)` | what's alive right now |
| `churn` | how often changed | `churnFraction(churn, maxChurn)` | hotspots |
| `size` | how much code | `log10(1 + bytes/1024)` normalized | mass distribution |

`recencyFraction` and `churnFraction` already exist in
[`colors.ts:101-114`](../src/webview/react/lib/graph/colors.ts#L101-L114) — the
git channels are a reuse, not new math.

`layer` is the most interesting and the only one needing real design: a file that
only imports (high out, zero in) is an entry point and belongs at the surface; a
file that is only imported (zero out, high in) is a leaf utility and belongs deep;
a file with both is core. The ratio gives that ordering directly, but it needs a
degree floor — a 1-import file has a meaningless ratio and should sit mid-depth
rather than being flung to an extreme by a single edge.

### 8.2 Implementation

New pure module `src/webview/react/lib/graph/depth.ts`:

```ts
export type DepthChannel = "nesting" | "degree" | "layer" | "recency" | "churn" | "size";

export interface DepthStats { maxSegments: number; maxDegree: number; /* … */ }

/** Corpus-relative normalizers, computed once per display-graph rebuild. */
export function depthStats(nodes: readonly GraphNode[]): DepthStats;

/** z ∈ [0.15, 1] for `node` under `channel`. The 0.15 floor matches
    depthFromDegree's — no node ever fully vanishes into the background. */
export function depthFor(node: GraphNode, channel: DepthChannel, stats: DepthStats): number;
```

Pure, no pixi, no DOM — vitest-safe, exactly like `motion.ts` and `labels.ts`.

Applied in `withDisplayGraph` / `deriveDisplayGraph`
([`view-model.ts`](../src/webview/react/lib/graph/view-model.ts)), where display
nodes are already derived and where cluster super-nodes are already aggregated.
Super-nodes take the **mean** `z` of their members for continuous channels and the
**min segment count** for `nesting` (a folder sits at its shallowest member's
depth — that is where you would click into it).

### 8.3 State and persistence

Add to `GraphDisplayOptions`
([`view-model.ts:103-137`](../src/webview/react/lib/graph/view-model.ts#L103-L137)):

```ts
/** What the depth cue encodes. Depth is spatial in this map (haze, sort,
    scale, parallax); this picks which axis it spends that dimension on. */
depthChannel: DepthChannel;
/** 0 = flat (pre-depth behavior), 1 = full. User-tunable intensity. */
depthIntensity: number;
```

Defaults: `depthChannel: "nesting"`, `depthIntensity: 1`.

`GraphDisplayOptions` already persists to `localStorage` via
`persistDisplayPrefs()` ([`store.ts:76-88`](../src/webview/react/apps/graph/store.ts#L76-L88))
and merges over `DEFAULT_DISPLAY_OPTIONS` on read — so both fields round-trip with
zero new persistence code, and an old stored blob picks up the defaults
automatically.

`depthIntensity: 0` must reproduce today's rendering exactly. That is the
regression guarantee and it should be an explicit test, not an assumption.

### 8.4 UI

A `Depth` control in the left panel's Layers section
([`GraphApp.tsx:1812+`](../src/webview/react/apps/graph/GraphApp.tsx#L1812)),
following the established `map-layer-toggle` / `aria-pressed` / `data-map-control`
idiom the surrounding toggles already use:

- a 6-way channel selector (segmented control, matching the existing lens picker)
- an intensity slider, `0` snapping to "Flat"
- one line of live copy naming what depth currently encodes — "Depth: folder
  nesting". Without it, a user who changes the channel sees the map shift and has
  no idea what axis they are now looking at.

Add the depth channel to `MapKeyPanel`
([GraphApp.tsx:1356](../src/webview/react/apps/graph/GraphApp.tsx#L1356)) — it is
now a legend-worthy encoding, not decoration.

---

## 9. Track B — build order

| Step | Work | Gate |
| --- | --- | --- |
| B1 | `lib/graph/depth.ts` + `graph-depth.spec.ts` | new spec green |
| B2 | `depthChannel`/`depthIntensity` in display options; wire into display-graph derivation | `graph-view-model.spec.ts` |
| B3 | §7.1 atmospheric haze | visual + `depthIntensity: 0` regression test |
| B4 | §7.2 depth sorting | visual |
| B5 | §7.3 scale falloff (gated off for `degree`) | visual |
| B6 | §8.4 UI + map key | — |
| B7 | §7.4 edge depth | hub-glare check at overview zoom |
| B8 | §7.5 parallax, behind strength setting, reduced-motion gated | consistency check across all 5 consumers |

B1–B6 is a complete, shippable feature. B7–B8 are the ambitious half and can land
separately — which is the point of the ordering.

---

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Dot-rule hides something a user wanted | Allowlist + hidden-count reporting (§2.7); `.github` is the one to call out in docs |
| Cache invalidation missed on setting toggle | `policyKey` in the cache header (§2.6) — without it the feature silently appears broken |
| Depth double-encodes degree | Default channel is `nesting`; scale falloff gated off for `degree` (§5) |
| Parallax delaminates the scene | Centroid anchoring + 4% strength + `posOf()` chokepoint (§7.5); ship last |
| Haze fights the heat lenses | Compose after heat mix at reduced strength (§7.1) |
| Per-frame cost on large graphs | Depth is a per-rebuild projection, not per-frame; no filters (§7.6); parallax off under `usesSimplifiedNodeMotion()` |
| Accessibility | Depth is never the *only* encoding of anything; `depthIntensity: 0` fully restores flat rendering |

---

## 11. Docs to update

- [`guide/map-guide.md`](./guide/map-guide.md) — a "Depth" subsection under
  "Reading the map" (§ line 30), and a note under "Performance" (§ line 173) on
  what dot-exclusion does to the corpus
- [`guide/settings-and-commands.md`](./guide/settings-and-commands.md) — three new
  rows in the `blacksite.graph` table (lines 58–66)
- [`codebase-map.md`](./codebase-map.md) — corpus boundary now includes the
  exclusion policy
- `CHANGELOG.md` — both tracks, with the 45% number in the Track A entry; it is
  the most persuasive line in this whole document
