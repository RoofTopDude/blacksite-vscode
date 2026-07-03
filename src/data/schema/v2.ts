// Blacksite Data Workbench — schema v2 (embedded for runtime bundling).
//
// This is the runtime source of truth: the migration runner applies `V2_SCHEMA` as
// migration version 2. The sibling `v2.sql` carries the identical DDL as the on-disk
// artifact; `tests/unit/vscode-db-migrations.spec.ts` asserts the two stay in sync
// (normalised comparison) so neither silently drifts from the other.

export const V2_SCHEMA = `-- Blacksite Data Workbench — schema v2
-- Adds real conversation-log persistence: message rows linked to the existing
-- (previously dormant) core_agent_sessions table, plus a join table associating a
-- message with the reference-file attachments (core_documents) uploaded in that turn.
-- Applied by the migration runner as migration version 2. The identical DDL is
-- embedded in \`schema/v2.ts\` for runtime bundling; \`tests/unit/vscode-db-migrations.spec.ts\`
-- guards the two against drift.

-- ── Messages ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core_messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES core_agent_sessions(id) ON DELETE CASCADE,
  turn_index   INTEGER NOT NULL DEFAULT 0,
  role         TEXT NOT NULL,              -- user | assistant
  content      TEXT NOT NULL,              -- JSON or plain text
  provider     TEXT,
  model        TEXT,
  stop_reason  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON core_messages(session_id);

-- ── Message ↔ attachment linkage ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core_message_attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES core_messages(id) ON DELETE CASCADE,
  document_id  TEXT NOT NULL REFERENCES core_documents(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON core_message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_message_attachments_document ON core_message_attachments(document_id);

-- ── Views ────────────────────────────────────────────────────────────────────
CREATE VIEW IF NOT EXISTS v_session_messages AS
  SELECT m.id           AS id,
         m.session_id   AS session_id,
         s.title        AS session_title,
         m.turn_index   AS turn_index,
         m.role         AS role,
         m.provider     AS provider,
         m.model        AS model,
         m.stop_reason  AS stop_reason,
         m.created_at   AS created_at,
         COUNT(ma.id)   AS attachment_count
  FROM core_messages m
  LEFT JOIN core_agent_sessions s ON s.id = m.session_id
  LEFT JOIN core_message_attachments ma ON ma.message_id = m.id
  GROUP BY m.id
  ORDER BY m.created_at DESC;
`;
