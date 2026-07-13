/* Durable Codebase Map "working memory" — notes the agent (and later the user)
   attaches to a single file or to a relation between two files. Stored at
   .blacksite/graph.json, physically separate from the regenerable graph cache
   so a re-index can never destroy a note. Template: base-context-store.ts.
   Also implements the dispatch() surface backing the map_note_* agent tools
   ("graph.*" runtime). */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { fromNodeId, toNodeId, type WorkspaceRoot } from "./graph/workspace-roots.js";

const GRAPH_FILE = "graph.json";
const BLACKSITE_DIR = ".blacksite";
const GRAPH_SCHEMA_VERSION = 2;
const MAX_NOTE_CHARS = 500;
const MAX_ANNOTATIONS = 500;
const MAX_HISTORY = 5;

/** A prior note's text, displaced by an update() merge — bounded trail kept
    so the map can show "revised N×" without unbounded growth. */
export interface GraphAnnotationRevision {
  note: string;
  sessionId?: string;
  updatedAt: string;
}

export interface GraphAnnotation {
  id: string;
  /** "edge" links two files (`to` present); "node" is a single-file note.
      Absent = "edge" (schema v1 back-compat — every v1 row has both from/to). */
  scope?: "edge" | "node";
  from: string;
  /** Required when scope is "edge"; absent for node-scoped notes. */
  to?: string;
  kind: "ai" | "user";
  author: "agent" | "user";
  note: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  /** Prior note text, most recent first, capped at MAX_HISTORY. */
  history?: GraphAnnotationRevision[];
}

export interface GraphAnnotationDocument {
  schemaVersion: number;
  updatedAt: string | null;
  annotations: GraphAnnotation[];
}

export interface GraphAnnotationContext {
  sessionId: string;
}

/** Backs the map_note_* agent tools ("graph.*" runtime types). */
export interface GraphAnnotationProvider {
  dispatch(op: string, payload: Record<string, unknown>, ctx: GraphAnnotationContext): Promise<Record<string, unknown>>;
  /**
   * Compact, provider-neutral orientation derived from the live Codebase Map.
   * The chat harness injects this into the refreshable workspace block so an
   * agent begins each model turn with project boundaries and dependency hubs,
   * without first spending tool calls rediscovering the repository shape.
   */
  workspaceOverview?(): Promise<string>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function defaultDocument(): GraphAnnotationDocument {
  return { schemaVersion: GRAPH_SCHEMA_VERSION, updatedAt: null, annotations: [] };
}

/** Also used by agent-session.ts's note-enforcement dirty-file tracker, so a
    path recorded there and a path recorded here always normalize identically
    — the two must agree for "a note was left for this file" to match. */
export function normalizeStoredPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function normalizeRevision(value: unknown): GraphAnnotationRevision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const note = typeof record.note === "string" ? record.note.trim().slice(0, MAX_NOTE_CHARS) : "";
  if (!note) return null;
  return {
    note,
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso(),
    ...(typeof record.sessionId === "string" && record.sessionId ? { sessionId: record.sessionId } : {}),
  };
}

function normalizeAnnotation(value: unknown): GraphAnnotation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const from = typeof record.from === "string" ? normalizeStoredPath(record.from) : "";
  const note = typeof record.note === "string" ? record.note.trim().slice(0, MAX_NOTE_CHARS) : "";
  /* Schema v1 rows carry no `scope` but always have both from/to populated
     (enforced at write time) — absent scope means "edge", losslessly. */
  const scope: "edge" | "node" = record.scope === "node" ? "node" : "edge";
  const to = scope === "edge" && typeof record.to === "string" ? normalizeStoredPath(record.to) : "";
  if (!from || !note) return null;
  if (scope === "edge" && !to) return null;

  const history = Array.isArray(record.history)
    ? record.history.map(normalizeRevision).filter((r): r is GraphAnnotationRevision => r !== null).slice(0, MAX_HISTORY)
    : [];

  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("gl"),
    scope,
    from,
    ...(scope === "edge" ? { to } : {}),
    kind: record.kind === "user" ? "user" : "ai",
    author: record.author === "user" ? "user" : "agent",
    note,
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : nowIso(),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso(),
    ...(typeof record.sessionId === "string" && record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(history.length ? { history } : {}),
  };
}

function normalizeDocument(value: unknown): GraphAnnotationDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultDocument();
  const record = value as Record<string, unknown>;
  return {
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : GRAPH_SCHEMA_VERSION,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    annotations: Array.isArray(record.annotations)
      ? record.annotations.map(normalizeAnnotation).filter((a): a is GraphAnnotation => a !== null).slice(0, MAX_ANNOTATIONS)
      : [],
  };
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export class GraphAnnotationStore implements vscode.Disposable, GraphAnnotationProvider {
  private readonly _emitter = new vscode.EventEmitter<GraphAnnotationDocument>();
  readonly onDidChange = this._emitter.event;

  /** Set by the extension to reject links to files that aren't map nodes. */
  private _knownNodes: (() => ReadonlySet<string> | null) | null = null;

  constructor(private readonly _roots: () => WorkspaceRoot[]) {}

  dispose(): void {
    this._emitter.dispose();
  }

  setNodeLookup(lookup: () => ReadonlySet<string> | null): void {
    this._knownNodes = lookup;
  }

  ensureInitialized(): void {
    ensureDir(path.dirname(this.filePath()));
    if (!fs.existsSync(this.filePath())) {
      fs.writeFileSync(this.filePath(), `${JSON.stringify(defaultDocument(), null, 2)}\n`, "utf8");
    }
  }

  /** Durable annotations live under the first workspace folder. */
  filePath(): string {
    const root = this._roots()[0]?.path ?? process.cwd();
    return path.join(root, BLACKSITE_DIR, GRAPH_FILE);
  }

  read(): GraphAnnotationDocument {
    return normalizeDocument(readJsonFile(this.filePath()));
  }

  /** `to` omitted (or equal to `from`) creates a node-scoped note on a single
      file; otherwise an edge-scoped note linking two files. */
  add(input: { from: string; to?: string; note: string; kind: "ai" | "user"; author: "agent" | "user"; sessionId?: string }): GraphAnnotation {
    const from = this._validatePath(input.from);
    const to = input.to && input.to.trim() ? this._validatePath(input.to) : undefined;
    if (to && from === to) throw new Error("A relation must connect two different files.");
    const scope: "edge" | "node" = to ? "edge" : "node";
    const note = input.note.trim().slice(0, MAX_NOTE_CHARS);
    if (!note) throw new Error("A note needs non-empty text.");

    const document = this.read();
    const duplicate = document.annotations.find((a) => a.scope === scope && a.from === from && (a.to ?? undefined) === to && a.note === note);
    if (duplicate) return duplicate;
    if (document.annotations.length >= MAX_ANNOTATIONS) {
      throw new Error(`The map supports up to ${MAX_ANNOTATIONS} notes.`);
    }

    const timestamp = nowIso();
    const annotation: GraphAnnotation = {
      id: newId("gl"),
      scope,
      from,
      ...(to ? { to } : {}),
      kind: input.kind,
      author: input.author,
      note,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    };
    document.annotations.push(annotation);
    this.write(document);
    return annotation;
  }

  /** Merge new text into an existing note, keeping the displaced text as a
      bounded revision so repeated agent runs read as refinement, not churn. */
  update(input: { id: string; note: string; sessionId?: string }): GraphAnnotation {
    const id = input.id.trim();
    if (!id) throw new Error("A note id is required.");
    const note = input.note.trim().slice(0, MAX_NOTE_CHARS);
    if (!note) throw new Error("A note needs non-empty text.");

    const document = this.read();
    const existing = document.annotations.find((a) => a.id === id);
    if (!existing) throw new Error(`No map note with id ${id}.`);

    const revision: GraphAnnotationRevision = {
      note: existing.note,
      updatedAt: existing.updatedAt,
      ...(existing.sessionId ? { sessionId: existing.sessionId } : {}),
    };
    existing.history = [revision, ...(existing.history ?? [])].slice(0, MAX_HISTORY);
    existing.note = note;
    existing.updatedAt = nowIso();
    if (input.sessionId) existing.sessionId = input.sessionId;

    this.write(document);
    return existing;
  }

  remove(id: string): boolean {
    const document = this.read();
    const before = document.annotations.length;
    document.annotations = document.annotations.filter((a) => a.id !== id.trim());
    if (document.annotations.length === before) return false;
    this.write(document);
    return true;
  }

  list(pathFilter?: string): GraphAnnotation[] {
    const annotations = this.read().annotations;
    if (!pathFilter) return annotations;
    const filter = normalizeStoredPath(pathFilter);
    return annotations.filter((a) => a.from === filter || a.to === filter);
  }

  /* ── Agent tool surface (map_note_add / map_note_list / map_note_update / map_note_remove) ── */

  async dispatch(op: string, payload: Record<string, unknown>, ctx: GraphAnnotationContext): Promise<Record<string, unknown>> {
    try {
      switch (op) {
        case "add":
        case "link": { // "link" kept as an alias so any in-flight sessions using the old tool name still resolve.
          const rawTo = typeof payload.to === "string" ? payload.to.trim() : "";
          const annotation = this.add({
            from: String(payload.from ?? ""),
            to: rawTo || undefined,
            note: String(payload.note ?? ""),
            kind: "ai",
            author: "agent",
            sessionId: ctx.sessionId,
          });
          return { ok: true, note: annotation };
        }
        case "update": {
          const id = String(payload.id ?? payload.linkId ?? "").trim();
          if (!id) return { ok: false, error: "id is required." };
          const annotation = this.update({ id, note: String(payload.note ?? ""), sessionId: ctx.sessionId });
          return { ok: true, note: annotation };
        }
        case "list": {
          const filter = typeof payload.path === "string" && payload.path.trim() ? payload.path : undefined;
          return { ok: true, notes: this.list(filter) };
        }
        case "remove": {
          const id = String(payload.id ?? payload.linkId ?? "").trim();
          if (!id) return { ok: false, error: "id is required." };
          const removed = this.remove(id);
          return removed ? { ok: true, removed: id } : { ok: false, error: `No map note with id ${id}.` };
        }
        default:
          return { ok: false, error: `Unknown map operation: ${op}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Resolve an agent- or user-supplied path to a canonical node id. Accepts
      an absolute path under any open folder, a plain relative path (assumed
      to be under the first folder — the common single-root shape), or an
      already folder-qualified id ("my-app/src/foo.ts") for multi-root. */
  private _validatePath(value: string): string {
    const normalized = normalizeStoredPath(value);
    if (!normalized) throw new Error("A relation endpoint path is required.");
    const roots = this._roots();
    const root0 = roots[0];
    if (!root0) throw new Error("No workspace folder is open.");

    const isAbsolute = normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
    let id: string | null;
    if (isAbsolute) {
      id = toNodeId(roots, normalized);
    } else {
      const asAbsolute = (roots.length > 1 ? fromNodeId(roots, normalized) : null) ?? fromNodeId([root0], normalized);
      id = asAbsolute ? toNodeId(roots, asAbsolute) : null;
    }
    if (!id) throw new Error(`Only workspace files can be linked on the map: ${value}`);

    const known = this._knownNodes?.();
    if (known && !known.has(id)) {
      /* Fall back to disk existence so links still work before first index. */
      const absolute = fromNodeId(roots, id);
      if (!absolute || !fs.existsSync(absolute)) {
        throw new Error(`Not a file on the Codebase Map: ${id}`);
      }
    }
    return id;
  }

  private write(document: GraphAnnotationDocument): void {
    const normalized = normalizeDocument({
      ...document,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      updatedAt: nowIso(),
      annotations: document.annotations,
    });
    fs.writeFileSync(this.filePath(), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    this._emitter.fire(normalized);
  }
}
