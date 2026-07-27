# Data Workbench

The Data view is an embedded database workbench with an unusual property: **the agent can use it
too.** It explores the catalog, grounds its SQL in the real schema, runs read queries, and searches
vectors — through the same layer you do, under the same rules.

Open it with **Blacksite: Open Data Workbench**, or from the activity bar.

---

## Five tabs

| Tab | What it does |
| --- | --- |
| **Explorer** | Browse the catalog — tables, views, columns, types, indexes, row counts, DDL |
| **Query** | Write and run SQL, with results in a paged grid |
| **Assistant** | Ask questions in natural language and get SQL back |
| **Vectors** | Manage collections and run semantic nearest-neighbour search |
| **RAG** | Retrieval over embedded content |

The engine is SQLite, persisted in `.blacksite/`. Nothing is sent anywhere; the workbench is local.

---

## Explorer

Pick a table or view and see its structure: columns and types, indexes, row count, and the DDL that
created it. Preview rows with pagination and a case-insensitive text filter across text columns.

Preview page size is `blacksite.data.previewPageSize` (default 50).

Click any row to open a detail drawer, which is where you want to be when a row has thirty columns
and the grid has become unreadable.

---

## Query

A SQL editor with a results grid. Read queries return up to `blacksite.data.maxQueryRows` rows
(default 500).

Queries can be **saved**, and saved queries are visible to the agent — it can list them and continue
prior analysis rather than reinventing a join you already worked out.

### Reads and writes are not the same thing

This is the central design decision of the workbench:

- **Read statements** — `SELECT`, `WITH`, `EXPLAIN`, read `PRAGMA` — execute directly.
- **Write and DDL statements** are *classified, not executed*, when they come from the agent. The
  agent gets back whether a statement is a write or destructive and what confirmation it needs, and
  surfaces that to you.

**The agent never executes a write against your database.** It can propose one, explain what it
would do, and hand it to you. Running it is your action.

You, working in the Query tab yourself, are not restricted this way. The gate is on the agent.

---

## Assistant

Natural-language questions against your schema. It reads the real catalog first, so the SQL it
produces references columns that exist.

Toggle with `blacksite.data.enableAssistant` (on by default).

Treat generated SQL the way you would treat any generated code: read it before you trust its output.
A query that runs is not a query that answers your question, and a subtly wrong join produces a
plausible number.

---

## Vectors and RAG

Blacksite embeds content locally and stores vectors alongside your data, so semantic search is
available without an external service.

**Vectors** manages collections and runs nearest-neighbour search — by query text (embedded on the
spot) or by a raw vector, scoped to a collection or across all of them.

**RAG** is retrieval over that embedded content: the pattern where instead of stuffing documents into
a prompt, you retrieve the relevant fragments at question time. This is the same machinery that lets
an attached 200-page PDF be searchable rather than context-consuming.

### Two backends

`blacksite.data.backendMode`:

- **`exact_local`** (default) — exact vector search persisted in SQLite. Zero dependencies, exact
  results, fine up to a large number of vectors.
- **`pgvector_container`** — an optional local PostgreSQL + pgvector sidecar, for higher-scale
  retrieval.

Start with `exact_local`. Move to pgvector when exact search becomes the bottleneck, which for most
projects is never.

---

## What the agent can do here

Its data tools, and what each is for:

| Tool | Purpose |
| --- | --- |
| `db_list_objects` | List the catalog — tables, views, vector collections, saved queries, jobs |
| `db_describe_object` | Columns, types, indexes, row count, DDL for one object |
| `db_preview_rows` | Paginated, filterable row preview. Read-only |
| `db_run_read_query` | Execute one read-only statement |
| `db_preview_write_query` | **Classify** a write without executing it |
| `db_vector_search` | Semantic nearest-neighbour search |
| `db_list_saved_queries` | List saved queries and their SQL |

The instruction the agent operates under is to inspect the catalog before proposing SQL, so that it
uses real object names rather than plausible ones. When it gets that wrong, it is usually because the
catalog is stale — **Blacksite: Refresh Data Catalog** fixes it.

---

## Using it well

**Ask questions about data the way you ask questions about code.** "How many subscriptions churned
last month, and is that unusual?" is a reasonable request. The agent will look at the schema, write
the query, run it, and interpret the result — and you can read every step.

**Save the queries that turn out to matter.** They become a shared vocabulary between you and the
agent for the next session.

**Keep the destructive work manual.** The agent proposing a migration and you running it is the right
division of labour, and the workbench is built to enforce it rather than rely on good intentions.

---

## When the engine is unavailable

If a SQLite binding is not present, the Data view says so and the rest of Blacksite continues to work
normally. Chat, the map, plans, and context do not depend on the database.

---

## Related

- [Settings & Commands](settings-and-commands.html) — every `blacksite.data.*` setting
- [Tool Reference](tool-reference.html) — the full tool surface
- [Approvals & Safety](approvals-and-safety.html) — where the other gates sit
