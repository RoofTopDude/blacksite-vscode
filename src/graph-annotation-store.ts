/* Durable Codebase Map annotations — the relations + notes drawn by the agent
   (and later the user) between workspace files. Stored at .blacksite/graph.json,
   physically separate from the regenerable graph cache so a re-index can never
   destroy a note. Template: base-context-store.ts. Also implements the
   dispatch() surface backing the map_link* agent tools ("graph.*" runtime). */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const GRAPH_FILE = "graph.json";
const BLACKSITE_DIR = ".blacksite";
const GRAPH_SCHEMA_VERSION = 1;
const MAX_NOTE_CHARS = 500;
const MAX_ANNOTATIONS = 500;

export interface GraphAnnotation {
  id: string;
  from: string;
  to: string;
  kind: "ai" | "user";
  author: "agent" | "user";
  note: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
}

export interface GraphAnnotationDocument {
  schemaVersion: number;
  updatedAt: string | null;
  annotations: GraphAnnotation[];
}

export interface GraphAnnotationContext {
  sessionId: string;
}

/** Backs the map_link* agent tools ("graph.*" runtime types). */
export interface GraphAnnotationProvider {
  dispatch(op: string, payload: Record<string, unknown>, ctx: GraphAnnotationContext): Promise<Record<string, unknown>>;
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

function normalizeStoredPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function normalizeAnnotation(value: unknown): GraphAnnotation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const from = typeof record.from === "string" ? normalizeStoredPath(record.from) : "";
  const to = typeof record.to === "string" ? normalizeStoredPath(record.to) : "";
  const note = typeof record.note === "string" ? record.note.trim().slice(0, MAX_NOTE_CHARS) : "";
  if (!from || !to || !note) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("gl"),
    from,
    to,
    kind: record.kind === "user" ? "user" : "ai",
    author: record.author === "user" ? "user" : "agent",
    note,
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : nowIso(),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso(),
    ...(typeof record.sessionId === "string" && record.sessionId ? { sessionId: record.sessionId } : {}),
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

  constructor(private readonly _workspaceRoot: string) {}

  dispose(): void {
    this._emitter.dispose();
  }

  setNodeLookup(lookup: () => ReadonlySet<string> | null): void {
    this._knownNodes = lookup;
  }

  ensureInitialized(): void {
    ensureDir(path.join(this._workspaceRoot, BLACKSITE_DIR));
    if (!fs.existsSync(this.filePath())) {
      fs.writeFileSync(this.filePath(), `${JSON.stringify(defaultDocument(), null, 2)}\n`, "utf8");
    }
  }

  filePath(): string {
    return path.join(this._workspaceRoot, BLACKSITE_DIR, GRAPH_FILE);
  }

  read(): GraphAnnotationDocument {
    return normalizeDocument(readJsonFile(this.filePath()));
  }

  add(input: { from: string; to: string; note: string; kind: "ai" | "user"; author: "agent" | "user"; sessionId?: string }): GraphAnnotation {
    const from = this._validatePath(input.from);
    const to = this._validatePath(input.to);
    if (from === to) throw new Error("A relation must connect two different files.");
    const note = input.note.trim().slice(0, MAX_NOTE_CHARS);
    if (!note) throw new Error("A relation needs a non-empty note.");

    const document = this.read();
    const duplicate = document.annotations.find((a) => a.from === from && a.to === to && a.note === note);
    if (duplicate) return duplicate;
    if (document.annotations.length >= MAX_ANNOTATIONS) {
      throw new Error(`The map supports up to ${MAX_ANNOTATIONS} annotated relations.`);
    }

    const timestamp = nowIso();
    const annotation: GraphAnnotation = {
      id: newId("gl"),
      from,
      to,
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

  /* ── Agent tool surface (map_link / map_link_list / map_link_remove) ── */

  async dispatch(op: string, payload: Record<string, unknown>, ctx: GraphAnnotationContext): Promise<Record<string, unknown>> {
    try {
      switch (op) {
        case "link": {
          const annotation = this.add({
            from: String(payload.from ?? ""),
            to: String(payload.to ?? ""),
            note: String(payload.note ?? ""),
            kind: "ai",
            author: "agent",
            sessionId: ctx.sessionId,
          });
          return { ok: true, link: annotation };
        }
        case "list": {
          const filter = typeof payload.path === "string" && payload.path.trim() ? payload.path : undefined;
          return { ok: true, links: this.list(filter) };
        }
        case "remove": {
          const id = String(payload.linkId ?? "").trim();
          if (!id) return { ok: false, error: "linkId is required." };
          const removed = this.remove(id);
          return removed ? { ok: true, removed: id } : { ok: false, error: `No map relation with id ${id}.` };
        }
        default:
          return { ok: false, error: `Unknown map operation: ${op}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private _validatePath(value: string): string {
    const normalized = normalizeStoredPath(value);
    if (!normalized) throw new Error("A relation endpoint path is required.");
    const absolute = path.resolve(this._workspaceRoot, normalized);
    const relative = path.relative(this._workspaceRoot, absolute).replace(/\\/g, "/");
    if (!relative || relative.startsWith("..")) {
      throw new Error(`Only workspace files can be linked on the map: ${value}`);
    }
    const known = this._knownNodes?.();
    if (known && !known.has(relative)) {
      /* Fall back to disk existence so links still work before first index. */
      if (!fs.existsSync(absolute)) {
        throw new Error(`Not a file on the Codebase Map: ${relative}`);
      }
    }
    return relative;
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
