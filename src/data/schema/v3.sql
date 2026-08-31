-- Blacksite Data Workbench — schema v3
-- Page-addressable PDF extraction state and text.

CREATE TABLE IF NOT EXISTS core_pdf_indexes (
  document_id      TEXT PRIMARY KEY REFERENCES core_documents(id) ON DELETE CASCADE,
  extractor_version INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed | cancelled
  total_pages      INTEGER NOT NULL DEFAULT 0,
  indexed_pages    INTEGER NOT NULL DEFAULT 0,
  text_pages       INTEGER NOT NULL DEFAULT 0,
  outline          TEXT,
  metadata         TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_pdf_indexes_status ON core_pdf_indexes(status);

CREATE TABLE IF NOT EXISTS core_document_pages (
  document_id  TEXT NOT NULL REFERENCES core_documents(id) ON DELETE CASCADE,
  page_number  INTEGER NOT NULL,
  page_label   TEXT,
  text         TEXT NOT NULL DEFAULT '',
  char_count   INTEGER NOT NULL DEFAULT 0,
  has_text     INTEGER NOT NULL DEFAULT 0,
  width        REAL NOT NULL DEFAULT 0,
  height       REAL NOT NULL DEFAULT 0,
  metadata     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (document_id, page_number)
);
CREATE INDEX IF NOT EXISTS idx_document_pages_document ON core_document_pages(document_id, page_number);
