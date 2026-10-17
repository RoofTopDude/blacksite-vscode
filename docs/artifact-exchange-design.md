# Artifact exchange (#17)

Status: storage and read-side slices; orchestration epic #10. Nothing is enabled by
default. The store supports only change receipts and decision records. There is no
AgentSession integration, tool exposure, scheduling change, or automatic context injection.
The read side (slice 2, below) is pure functions over records a caller has already read. It
has no producer wired into a session, so nothing in the product calls it yet.

Still open against #17: `interface_contract` and `verification_receipt` kinds (the integration
gate in #21 takes interface facts from the host until these exist); a redaction pass over
summaries; invalidation of dependent findings; and retention pins for referenced blobs.

## Read side (slice 2)

- `ArtifactExchangeStore.list(actor, { kind?, limit? })` returns up to 50 readable records in
  ID order, scanning at most 200 files. It is discovery, not recency: records carry no
  timestamp. Records the actor may not read are counted in `skippedDenied`, never described. A
  corrupt record is an error, as in `get`.
- `assessRecord(record, resolve)` judges each pinned source against the revision the host
  resolves now: `fresh`, `stale` (with the current revision), `unavailable` (missing or a
  throwing resolver) or `denied`. The least fresh source decides. Only an all-fresh record is
  `usable`. Judgment happens at read time and is never stored.
- `buildArtifactPacket({ records, resolve, relevantTo, maxItems, maxBytes })` ranks records by
  overlap with what the consumer is working on, then by usability, then by ID. Items carry a
  clipped summary, freshness and the IDs of sources that are not fresh. No transcripts, tool
  output or payloads. Bounded by item count (12 max) and serialized bytes (16 KiB max).
- `changeReceiptDraft(receipt, access)` pins a `WorkReceipt` by `revisionOf(receipt)` and writes
  a one-line summary from its status, file count and verification result. It does not copy
  `selfReport`, the file list or check output.
- `revisionOf(snapshot)` is the canonical SHA-256 that producers use to pin a snapshot.

## Purpose and existing owners

An exchange artifact is a small, typed statement about work and the exact evidence it used.
It is a reference document, not a second copy of the project's state.

- [RunStore](../src/runs/run-store.ts) owns run metadata and artifact attachments.
  [RunArtifactStore](../src/runs/run-artifact-store.ts) owns large, content-addressed bytes.
  Logs, screenshots, diffs and long reports stay there. Reference a blob by its SHA-256 and
  owning run; do not copy it into an exchange record. Existing Run Store retention may remove
  it: a reference is not yet a retention pin.
- [WorkReceipt](../src/orchestration/work-receipt.ts) and
  [ReceiptStore](../src/orchestration/receipt-store.ts) own host-observed changes and checks.
  A change receipt in this exchange is a small handoff referring to a WorkReceipt, not a new
  success classifier and not a duplicate of its file or verification arrays.
- [Tickets](../src/ticket-store.ts), [plans](../src/planning-store.ts), plan documents and
  [map annotations](../src/graph-annotation-store.ts) retain their existing IDs and ownership.
  Plan-step references carry plan/phase/step identity; map-node references use the existing
  map node ID. The [work graph](../src/orchestration/work-graph/model.ts) remains derived.
  This slice writes none of these stores and does not close tickets.

## Typed vocabulary

| Kind | Meaning and evidence | First slice |
| --- | --- | --- |
| `investigation_finding` | Claim, confidence, scope, and references to supporting observations | Design only |
| `interface_contract` | Named interface, producer/consumer obligations, compatibility and source references | Design only |
| `change_receipt` | Concise handoff summary and a pinned existing WorkReceipt | Read/write |
| `verification_receipt` | Check result and coverage tied to the exact source revision and Run Store evidence | Design only; existing WorkReceipt remains authoritative |
| `blocker_report` | Blocked objective, reason, missing inputs, and owner/action references | Design only |
| `decision_record` | Decision, rationale, alternatives considered, and pinned source references | Read/write |

The kind union documents the vocabulary, but the v1 reader and writer reject the four
unimplemented kinds. No loosely typed catch-all payload is accepted.

## Identity, hashes and versions

The v1 envelope contains `schemaVersion`, `kind`, `access`, `sources` and a kind-specific
`payload`. Stored records add `id` and `contentHash`. Canonical JSON sorts object keys,
preserves array order, and hashes UTF-8 bytes with SHA-256. The hash covers the entire draft,
including access scope and pinned sources. The ID is `exchange_<contentHash>`.

Records are immutable. The same draft has the same ID across restarts and retries; changing
the payload, scope or source revision creates a new ID. There is no mutable "latest" alias,
publication timestamp, or overwrite API in this slice. A future logical lineage can reference
an earlier record; it must not change what an existing ID means. Hashes detect corruption and
identify bytes; they do not authenticate the author or prove the statement true.

`schemaVersion: 1` is required. Unknown versions and extra keys fail explicitly on reads and
writes. Future migrations must be explicit and create new records when hashed content changes;
old content hashes must never silently acquire new meanings.

## Source revisions and invalidation

Each source reference carries a kind, its existing ID, and a SHA-256 `revision` of the exact
source snapshot. A `run_artifact` additionally carries `runId`; its ID and revision are the
blob hash. A `plan_step` also carries plan and phase IDs. File and map-node IDs remain logical
references, never filesystem paths opened by the exchange store.

For file/blob evidence, hash the bytes. For ticket/plan/step/map/receipt/run snapshots, hash a
canonical JSON snapshot selected by the producer. `updatedAt` alone is not a revision: two
edits can share a timestamp. Producers and future resolvers must agree on snapshot selection.
The first slice validates reference shape but cannot establish that a supplied revision is
true, current, or even resolvable. It returns historical records without claiming freshness.

A future explicit consumer must resolve every source under the caller's access boundary and
compare revisions before using an artifact. A changed revision makes the record stale; a
missing/deleted/retained-away source makes it unavailable; an inaccessible source is denied,
not evidence of freshness. Invalidating a source transitively invalidates dependent findings
and contracts. Historical records stay readable; consumers must create a new record after
revalidation. No automatic invalidation walker, graph edges, or context injection is included
in this slice. A decision remains a historical decision even when its premises become stale.

## Access boundaries

The store is rooted in one host-selected workspace. `access` is either `workspace` or a
specific `sessionId`. Every read and write receives a trusted host-created actor: `host` or
`session` with its ID. The host can access both scopes; a session can access workspace records
and only its own session records. The actor must never come directly from model tool input.
IDs are validated before forming paths. Denied access is an explicit error.

These are in-process access boundaries, not encryption or protection from another local
process with filesystem access. Publication to workspace scope is an explicit host policy
decision; future adapters must check that referenced evidence can be shared at that scope.
This storage slice does not dereference sources, grant access to them, or expose a tool/API to
models. All referenced stores must perform their own authorization when a consumer opens them.

## Durable storage and recovery

Records live at `.blacksite/orchestration/artifact-exchange/<id>.json`. Each complete envelope
is validated and bounded to 64 KiB, then published as compact JSON with the existing
[atomicWriteFile](../src/shared/durable-file.ts) helper: unique sibling temporary file, atomic
rename, no backup needed for immutable records. A record is visible only at the rename.
Duplicate writes are idempotent; concurrent equal IDs have equal canonical content. Conflicting
or corrupt committed records raise errors instead of being silently replaced.

There is no separate index, mutable head, or multi-file transaction. After a host interruption:

1. Before rename, the target is absent and any partial/complete temporary file is ignored.
2. After rename, a fresh store reads and verifies the complete record even if the caller never
   received an acknowledgement. Retrying the draft returns the same ID.
3. Invalid JSON, mismatched filename/ID/hash, or an unsupported schema is a reported error, not
   an empty store. No corrupt evidence is promoted or overwritten by recovery.

Reads never promote or delete temporary files: another writer may still own them. No automatic
garbage collection is introduced. Tests inject failures at publication boundaries and reopen
the store, including partial temporary files and corruption. This guarantees host-process
crash consistency on filesystems with atomic sibling rename. The shared helper does not fsync
files/directories, so power-loss durability is not promised by this slice.

## API and rollout

`ArtifactExchangeStore(workspaceRoot, { enabled })` is filesystem-only and has no VS Code import.
The optional `enabled` callback defaults to false and is checked on every `put` and `get`;
disabled calls fail without reading, writing, or creating directories. A future host adapter
can supply `readOrchestrationFlags(...).artifactExchange`. The setting
`blacksite.orchestration.artifactExchange` defaults to false. Turning it off leaves existing
records untouched and inaccessible through this API.

`put(draft, actor)` validates, authorizes, computes identity, writes atomically and returns the
record. `get(id, actor)` returns a validated record or undefined for a missing ID. Both reject
malformed records and denied access. No session wiring or background work is added. Review
this slice before adding producers, consumers, retention pins, source resolvers or new kinds.
