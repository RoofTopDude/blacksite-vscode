# Blacksite Execution Runs

Execution Runs are Blacksite's durable execution-evidence layer. A run records the ordered
steps, synchronized events, observations, artifacts, side effects, failures, lineage, and
work-management references produced by one bounded sequence. Screenshots are evidence within
a run; they are not the canonical record.

This document records the architecture decisions and the delivered browser-first MVP boundary.

## Architecture decisions

### ADR 1: The canonical trace is event-sourced

Status: accepted.

The host assigns every event a strictly increasing sequence number and monotonic timestamp.
Adapters provide observations; they do not control ordering. Run metadata, steps, observation
bundles, artifact references, and compressed event-segment indexes live under
`.blacksite/runs/`. This makes event windows seekable without loading a whole trace and lets
Run Explorer and Codebase Map playback project the same retained record.

Wall-clock timestamps are descriptive only. Sequence numbers are the ordering authority.
Interrupted `validating`, `awaiting_approval`, or `running` records recover as terminal partial
evidence instead of disappearing.

### ADR 2: Artifact bytes are content-addressed

Status: accepted.

Artifact blobs are keyed by SHA-256 and deduplicated across runs. Each attachment retains its
own semantic metadata—role, kind, filename, media type, step, observation, and adapter
metadata—so identical before/after bytes do not collapse into the first attachment's meaning.
Large tool results are stored as artifacts and referenced from compact events.

### ADR 3: Inspection is not replay

Status: accepted.

`sequence_inspect`, Run Explorer scrubbing, and Codebase Map playback are read-only projections
over retained evidence. Seeking never reruns an action. `sequence_resume` is a separate,
conservative operation that can replay only repeatable setup and unfinished read-only actions
after environment and side-effect revalidation. MVP checkpoints are inspection markers, not
restorable snapshots; requesting one is rejected unless a future adapter can actually restore it.

### ADR 4: The MVP is linear and graph-ready

Status: accepted.

Sequences execute as bounded ordered steps. Stable step IDs and `depends_on` edges are stored
so comparison and a future DAG executor have durable identities, but the current compiler
accepts only dependencies on earlier steps. `continue_safe` proceeds only through read-only
steps independent of failed prerequisites. `collect_all` is restricted to independent,
read-only diagnostic scans.

## Safety boundary

The coordinator orchestrates existing authority; it does not create a second authorization
system. Process steps use the existing command policy and approval classifier. Approval
denials are retained as typed failed runs. Browser sequences are restricted to loopback
development origins, page content is treated as untrusted data, and captured URLs and DOM
state are sanitized. External and destructive mutations are outside the sequence MVP.

Every execution records a preflight manifest containing resolved actions, declared effect
classes, browser origins, command and filesystem effects, limits, required approvals, and
denied operations. Cancellation and timeout propagate into active process, test, and browser
actions and preserve completed work plus the failure envelope.

## Storage and migration

Run metadata uses workspace-local SQLite when available, with a JSON metadata fallback.
SQLite migrations are versioned with `PRAGMA user_version`; step identity is composite
`(run_id, id)` because semantic step IDs repeat across runs. Events use independently
compressed gzip segments with sequence and monotonic-time bounds. Artifact writes are atomic
and content-addressed.

Retention classes are:

- `temporary`: short-lived exploratory evidence.
- `standard`: normal retained history.
- `pinned`: explicit baseline or durable evidence, never automatically pruned.

Automatic pruning also protects active runs and runs referenced by active plans or open
tickets. Configuration controls temporary age, standard age, and the maximum unpinned count.

## Product surfaces and tools

The agent tool family is:

- `sequence_discover`
- `sequence_execute`
- `sequence_inspect`
- `sequence_compare`
- `sequence_resume`
- `sequence_search`

Run Explorer provides windowed timelines, synchronized observation/artifact inspection,
comparison, entity navigation, active cancellation, baseline pinning, and explicit anomaly
ticket filing. Codebase Map playback reads bounded event windows and reuses stable workspace
file identity and lane colors. Plans and tickets store stable run/observation IDs only; full
trace payloads remain in the run store.

## Delivered MVP boundary

The browser-first MVP includes the run/event store, bounded linear execution, browser,
workspace-read, process, and test adapters, route/Storybook/test/runtime discovery, screenshot,
console, exception, network, DOM and accessibility capture, partial failure retention,
semantic inspection, Run Explorer, basic channel-aware comparison, Codebase Map playback,
search, and plan/ticket evidence links.

Deliberately deferred are full video, generic DAG execution, automated external/destructive
effects, complete component-to-source provenance, universal stateful resume, 3D adapters, and
cross-workspace cloud synchronization.
