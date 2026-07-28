// SQL safety classifier.
//
// The trust model (BLA-80 / BLA-81): read-only SQL runs directly; potential writes
// must be previewed and confirmed; destructive statements always require explicit
// confirmation. This module is the single source of that classification, kept pure
// so it can be exhaustively unit-tested and reused by both the Query tab and the
// agent's `db.preview_write_query` tool.

export type StatementKind = "read" | "write" | "ddl" | "destructive" | "unknown";

export interface ClassifiedStatement {
  sql: string;
  kind: StatementKind;
  /** Leading keyword that drove the classification (upper-cased). */
  command: string;
}

export interface QueryClassification {
  statements: ClassifiedStatement[];
  /** True only when every statement is read-only. */
  readOnly: boolean;
  /** True when any statement is destructive (drop/truncate, unfiltered delete/update). */
  destructive: boolean;
  /** Highest-severity kind across all statements. */
  overall: StatementKind;
  /** True when more than one statement is present. */
  multiple: boolean;
}

const READ_COMMANDS = new Set(["SELECT", "WITH", "EXPLAIN", "VALUES"]);
const WRITE_COMMANDS = new Set(["INSERT", "UPDATE", "DELETE", "UPSERT", "REPLACE"]);
const DDL_COMMANDS = new Set(["CREATE", "ALTER", "REINDEX", "ANALYZE", "VACUUM"]);
const DESTRUCTIVE_COMMANDS = new Set(["DROP", "TRUNCATE", "DETACH"]);

// Pragmas that only read state are safe; everything else (a pragma that sets a value)
// is treated as a write.
const READ_ONLY_PRAGMAS = new Set([
  "table_info", "table_list", "index_list", "index_info", "foreign_key_list",
  "database_list", "schema_version", "user_version", "integrity_check",
  "quick_check", "page_count", "page_size", "freelist_count", "wal_checkpoint",
  "collation_list", "compile_options", "function_list", "module_list",
]);

const severityRank: Record<StatementKind, number> = {
  read: 0,
  unknown: 1,
  ddl: 2,
  write: 3,
  destructive: 4,
};

/** Strip line (`--`) and block (`/* *\/`) comments without touching string literals. */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  let inSingle = false;
  let inDouble = false;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inSingle) {
      out += ch;
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (ch === "'") { inSingle = true; out += ch; i++; continue; }
    if (ch === '"') { inDouble = true; out += ch; i++; continue; }
    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Split a SQL string on top-level `;` (ignoring semicolons inside string literals). */
export function splitStatements(sql: string): string[] {
  const cleaned = stripSqlComments(sql);
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; current += ch; continue; }
    if (ch === '"') { inDouble = true; current += ch; continue; }
    if (ch === ";") {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Blank out string-literal contents (keeping the quotes) so keyword checks can't be fooled by literal text. */
function maskStringLiterals(sql: string): string {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingle) {
      out += ch === "'" ? ch : " ";
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      out += ch === '"' ? ch : " ";
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; out += ch; continue; }
    if (ch === '"') { inDouble = true; out += ch; continue; }
    out += ch;
  }
  return out;
}

/** Blank out the contents of parenthesized groups so a top-level WHERE check can't be
 *  fooled by a WHERE that only restricts a nested subquery — e.g.
 *  `UPDATE t SET x = (SELECT y FROM u WHERE u.id = t.id)` has no clause restricting
 *  which rows of `t` get updated, even though the text contains "WHERE". */
function maskParenGroups(sql: string): string {
  let out = "";
  let depth = 0;
  for (const ch of sql) {
    if (ch === "(") { depth += 1; out += " "; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); out += " "; continue; }
    out += depth > 0 ? " " : ch;
  }
  return out;
}

function hasWhereClause(sql: string): boolean {
  return /\bWHERE\b/i.test(maskParenGroups(maskStringLiterals(sql)));
}

function classifyOne(statement: string): ClassifiedStatement {
  const trimmed = statement.trim();
  const match = /^([a-zA-Z]+)/.exec(trimmed);
  const command = (match?.[1] ?? "").toUpperCase();

  if (command === "PRAGMA") {
    // A pragma reads when it is a known introspection pragma and is not an
    // assignment. `PRAGMA table_info(t)` reads; `PRAGMA journal_mode = WAL` writes.
    // The parenthesised argument form (table_info(t), index_info(x)) is still a read.
    const pragmaMatch = /^PRAGMA\s+([a-zA-Z_]+)/i.exec(trimmed);
    const name = (pragmaMatch?.[1] ?? "").toLowerCase();
    const isAssignment = /=/.test(trimmed);
    const kind: StatementKind = READ_ONLY_PRAGMAS.has(name) && !isAssignment ? "read" : "write";
    return { sql: trimmed, kind, command };
  }

  if (READ_COMMANDS.has(command)) return { sql: trimmed, kind: "read", command };
  if (DESTRUCTIVE_COMMANDS.has(command)) return { sql: trimmed, kind: "destructive", command };

  if (WRITE_COMMANDS.has(command)) {
    // DELETE / UPDATE without a WHERE clause hits every row — treat as destructive.
    if ((command === "DELETE" || command === "UPDATE") && !hasWhereClause(trimmed)) {
      return { sql: trimmed, kind: "destructive", command };
    }
    return { sql: trimmed, kind: "write", command };
  }

  if (DDL_COMMANDS.has(command)) {
    // `ALTER TABLE ... DROP COLUMN` discards data — treat as destructive.
    if (command === "ALTER" && /\bDROP\b/i.test(trimmed)) {
      return { sql: trimmed, kind: "destructive", command };
    }
    return { sql: trimmed, kind: "ddl", command };
  }

  return { sql: trimmed, kind: "unknown", command: command || "(empty)" };
}

export function classifyQuery(sql: string): QueryClassification {
  const statements = splitStatements(sql).map(classifyOne);
  if (statements.length === 0) {
    return { statements: [], readOnly: true, destructive: false, overall: "read", multiple: false };
  }
  let overall: StatementKind = "read";
  for (const s of statements) {
    if (severityRank[s.kind] > severityRank[overall]) overall = s.kind;
  }
  return {
    statements,
    readOnly: statements.every((s) => s.kind === "read"),
    destructive: statements.some((s) => s.kind === "destructive"),
    overall,
    multiple: statements.length > 1,
  };
}

/** Convenience: is this SQL safe to run without confirmation? */
export function isReadOnly(sql: string): boolean {
  return classifyQuery(sql).readOnly;
}

/** Human-readable confirmation summary for a non-read statement set. */
export function describeForConfirmation(classification: QueryClassification): string {
  if (classification.readOnly) return "Read-only query — runs directly.";
  const commands = classification.statements
    .filter((s) => s.kind !== "read")
    .map((s) => s.command)
    .join(", ");
  if (classification.destructive) {
    return `Destructive operation (${commands}). This can delete or drop data and requires explicit confirmation.`;
  }
  return `Write operation (${commands}). Review the target before running.`;
}
