// Blacksite Data Workbench — schema v1 (embedded for runtime bundling).
//
// This is the runtime source of truth: the migration runner applies `V1_SCHEMA`
// as migration version 1. The sibling `v1.sql` carries the identical DDL as the
// on-disk artifact; `tests/unit/vscode-db-migrations.spec.ts` asserts the two stay
// in sync (normalised comparison) so neither silently drifts from the other.

export const V1_SCHEMA = `-- Blacksite Data Workbench — schema v1
-- Canonical embedded relational store (SQLite). Applied by the migration runner as
-- migration version 1. The identical DDL is embedded in \`schema/v1.ts\` for runtime
-- bundling; \`tests/unit/vscode-db-migrations.spec.ts\` guards the two against drift.

-- ── Meta ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Source registry ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core_sources (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,           -- file | memory | base_context | session | plan | import
  uri        TEXT,                    -- workspace-relative path or logical locator
  title      TEXT,
  metadata   TEXT,                    -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sources_kind ON core_sources(kind);

-- ── Documents ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core_documents (
  id         TEXT PRIMARY KEY,
  source_id  TEXT REFERENCES core_sources(id) ON DELETE CASCADE,
  title      TEXT,
  body       TEXT,
  mime       TEXT,
  byte_size  INTEGER NOT NULL DEFAULT 0,
  hash       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_source ON core_documents(source_id);

-- ── Chunks ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core_chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT REFERENCES core_documents(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL DEFAULT 0,
  content     TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  metadata    TEXT,                   -- JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON core_chunks(document_id);

-- ── Embeddings ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core_embeddings (
  id         TEXT PRIMARY KEY,
  chunk_id   TEXT REFERENCES core_chunks(id) ON DELETE CASCADE,
  collection TEXT NOT NULL DEFAULT 'default',
  model      TEXT,
  dims       INTEGER NOT NULL DEFAULT 0,
  vector     TEXT NOT NULL,           -- JSON array of floats (L2-normalised)
  norm       REAL NOT NULL DEFAULT 1,
  payload    TEXT,                    -- JSON metadata used for filtering/preview
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_embeddings_collection ON core_embeddings(collection);
CREATE INDEX IF NOT EXISTS idx_embeddings_chunk ON core_embeddings(chunk_id);

-- ── Notes / memory ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core_notes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'note',  -- note | memory | base_context | ui_preference
  title      TEXT,
  body       TEXT NOT NULL,
  tags       TEXT,                    -- JSON array
  source_id  TEXT REFERENCES core_sources(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_kind ON core_notes(kind);

-- ── Agent sessions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core_agent_sessions (
  id            TEXT PRIMARY KEY,
  title         TEXT,
  provider      TEXT,
  model         TEXT,
  status        TEXT NOT NULL DEFAULT 'active',  -- active | completed | cancelled
  message_count INTEGER NOT NULL DEFAULT 0,
  metadata      TEXT,                 -- JSON
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT
);

-- ── Tool events ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core_tool_events (
  id           TEXT PRIMARY KEY,
  session_id   TEXT REFERENCES core_agent_sessions(id) ON DELETE CASCADE,
  tool_name    TEXT NOT NULL,
  runtime_type TEXT,
  status       TEXT NOT NULL DEFAULT 'ok',       -- ok | error | denied
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  input        TEXT,                  -- JSON (redacted)
  output       TEXT,                  -- JSON (redacted)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tool_events_session ON core_tool_events(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_events_created ON core_tool_events(created_at);

-- ── Ingestion / background jobs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core_jobs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,          -- import | embed | reindex | sync
  status      TEXT NOT NULL DEFAULT 'queued',    -- queued | running | done | failed | cancelled
  progress    REAL NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  completed   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  payload     TEXT,                   -- JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON core_jobs(status);

-- ── Saved queries ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core_saved_queries (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sql         TEXT NOT NULL,
  description TEXT,
  backend     TEXT NOT NULL DEFAULT 'embedded',
  run_count   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_run_at TEXT
);

-- ── Retrieval profiles & runs ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core_retrieval_profiles (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  embedding_model TEXT,
  dims            INTEGER NOT NULL DEFAULT 0,
  chunk_size      INTEGER NOT NULL DEFAULT 1024,
  chunk_overlap   INTEGER NOT NULL DEFAULT 128,
  vector_backend  TEXT NOT NULL DEFAULT 'exact_local',
  config          TEXT,               -- JSON
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS core_retrieval_runs (
  id           TEXT PRIMARY KEY,
  profile_id   TEXT REFERENCES core_retrieval_profiles(id) ON DELETE SET NULL,
  query        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ok',
  top_k        INTEGER NOT NULL DEFAULT 0,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  result_count INTEGER NOT NULL DEFAULT 0,
  trace        TEXT,                  -- JSON
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_retrieval_runs_profile ON core_retrieval_runs(profile_id);

-- ── Views (stable GUI/adapter surface) ───────────────────────────────────────
CREATE VIEW IF NOT EXISTS v_recent_agent_activity AS
  SELECT te.id           AS event_id,
         te.session_id   AS session_id,
         s.title         AS session_title,
         te.tool_name    AS tool_name,
         te.runtime_type AS runtime_type,
         te.status       AS status,
         te.duration_ms  AS duration_ms,
         te.created_at   AS created_at
  FROM core_tool_events te
  LEFT JOIN core_agent_sessions s ON s.id = te.session_id
  ORDER BY te.created_at DESC;

CREATE VIEW IF NOT EXISTS v_documents_with_chunk_counts AS
  SELECT d.id        AS id,
         d.source_id AS source_id,
         d.title     AS title,
         d.mime      AS mime,
         d.byte_size AS byte_size,
         d.updated_at AS updated_at,
         COUNT(DISTINCT c.id) AS chunk_count,
         COUNT(DISTINCT e.id) AS embedding_count
  FROM core_documents d
  LEFT JOIN core_chunks c ON c.document_id = d.id
  LEFT JOIN core_embeddings e ON e.chunk_id = c.id
  GROUP BY d.id;

CREATE VIEW IF NOT EXISTS v_memory_timeline AS
  SELECT id           AS id,
         kind         AS kind,
         title        AS title,
         substr(body, 1, 280) AS preview,
         source_id    AS source_id,
         created_at   AS created_at,
         updated_at   AS updated_at
  FROM core_notes
  ORDER BY COALESCE(updated_at, created_at) DESC;

CREATE VIEW IF NOT EXISTS v_active_jobs AS
  SELECT id         AS id,
         kind       AS kind,
         status     AS status,
         progress   AS progress,
         completed  AS completed,
         total      AS total,
         error      AS error,
         created_at AS created_at,
         updated_at AS updated_at,
         started_at AS started_at
  FROM core_jobs
  WHERE status IN ('queued', 'running')
  ORDER BY created_at DESC;
`;
