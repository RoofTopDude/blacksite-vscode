/* Reference material ↔ code. Files the user attaches to a conversation (and
   the per-conversation `Extracted context.md` scratchpad) live under
   .blacksite/reference/, which the map never indexes — so until now a spec
   that describes a module had no presence anywhere near that module.

   Links are derived from what the document says:
   - workspace paths and unambiguous file names (the doc-links.ts rules docs in
     the repository already use);
   - API routes ("POST /api/orders") matched against the providers the
     relationship indexer found, so a spec links to the handler that serves
     the endpoint it describes.
   PDFs are not scanned here (their text lives in the reference index, which
   is not loaded on the map's path). Pure extraction below; the host index
   reads the store and caches by attachment mtime. */

import * as fs from "fs";
import * as path from "path";
import { extractDocLinks, resolveDocByName } from "./doc-links.js";
import { normalizeGraphPath, type GraphEdge } from "./graph-model.js";

export interface ReferenceTarget {
  path: string;
  via: "path" | "name" | "route";
  evidence: string;
  confidence: number;
}

export interface ReferenceLink {
  /** `${session}/${name}`. */
  id: string;
  name: string;
  session: string;
  /** Workspace-relative path of the attachment (what file_read / open_file accept). */
  workspacePath: string;
  kind: "attachment" | "context";
  targets: ReferenceTarget[];
}

export interface RouteProvider {
  method?: string;
  path: string;
  file: string;
}

const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "rst", "adoc", "json", "yaml", "yml", "toml", "csv", "tsv", "log", "html", "htm", "xml",
  "ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "kt", "cs", "rb", "php", "sql", "graphql", "proto", "sh",
]);
const MAX_TEXT_BYTES = 1_000_000;
const MAX_TARGETS = 40;
const ROUTE_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[\w\-./{}:]*)/g;
const BARE_ROUTE_RE = /(?:^|[\s`'"(])(\/(?:api|v\d+)\/[\w\-./{}:]*)/g;
const METHOD_BEFORE_RE = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+$/;

/** Normalize a route for comparison: lower-case, no trailing slash, every
    parameter spelling ({id}, :id, <id>, [id]) collapsed to one placeholder. */
export function normalizeRoute(route: string): string {
  return route
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, "")
    .replace(/\{[^}]+\}|:[a-z_]\w*|<[^>]+>|\[[^\]]+\]/g, "*")
    .replace(/\/+$/, "") || "/";
}

/** Route providers from relationship `api` edges: the provider file is the
    edge's target, the route is in its label ("GET /api/orders"). */
export function routeProvidersFromEdges(edges: readonly GraphEdge[]): RouteProvider[] {
  const out: RouteProvider[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== "api" || !edge.targetPath || !edge.label) continue;
    const match = /^(?:([A-Z]+)\s+)?(\/\S*)/.exec(edge.label.trim());
    if (!match) continue;
    const key = `${match[1] ?? ""} ${normalizeRoute(match[2]!)} ${edge.targetPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...(match[1] ? { method: match[1] } : {}), path: match[2]!, file: edge.targetPath });
  }
  return out;
}

/** Code targets one reference document names. Pure. */
export function linkReferenceText(
  text: string,
  fileSet: ReadonlySet<string>,
  byBasename: ReadonlyMap<string, string[]>,
  routes: readonly RouteProvider[],
): ReferenceTarget[] {
  const targets = new Map<string, ReferenceTarget>();
  const add = (target: ReferenceTarget): void => {
    const existing = targets.get(target.path);
    if (!existing || existing.confidence < target.confidence) targets.set(target.path, target);
  };
  for (const raw of extractDocLinks(text)) {
    const clean = normalizeGraphPath(raw.replace(/[?#].*$/, "").replace(/^\.\//, ""));
    if (fileSet.has(clean)) {
      add({ path: clean, via: "path", evidence: raw, confidence: 0.95 });
      continue;
    }
    const byName = resolveDocByName(raw, byBasename);
    if (byName) add({ path: byName, via: "name", evidence: raw, confidence: clean.includes("/") ? 0.85 : 0.6 });
  }
  if (routes.length > 0) {
    const byRoute = new Map<string, RouteProvider[]>();
    for (const route of routes) {
      const key = normalizeRoute(route.path);
      byRoute.set(key, [...(byRoute.get(key) ?? []), route]);
    }
    const mention = (method: string | undefined, routePath: string): void => {
      for (const provider of byRoute.get(normalizeRoute(routePath)) ?? []) {
        const methodMatches = !method || !provider.method || provider.method === method;
        if (!methodMatches) continue;
        add({
          path: provider.file,
          via: "route",
          evidence: `${method ? `${method} ` : ""}${routePath}`,
          confidence: method && provider.method ? 0.9 : 0.7,
        });
      }
    };
    for (const match of text.matchAll(ROUTE_RE)) mention(match[1], match[2]!);
    for (const match of text.matchAll(BARE_ROUTE_RE)) {
      /* A route written with a method was judged above; matching it again
         method-less would link "DELETE /x" to a handler that only serves GET. */
      const before = text.slice(Math.max(0, (match.index ?? 0) - 12), (match.index ?? 0) + match[0].indexOf("/"));
      if (METHOD_BEFORE_RE.test(before)) continue;
      mention(undefined, match[1]!);
    }
  }
  return [...targets.values()].sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path)).slice(0, MAX_TARGETS);
}

export interface ReferenceStoreLike {
  listSessions(): string[];
  listAttachments(sessionId: string): Array<{ name: string; path: string; byteSize: number; modifiedAtMs?: number }>;
  contextMdPath(sessionId: string): string;
  workspacePath(absPath: string): string;
}

interface CachedLink {
  mtime: number;
  link: ReferenceLink;
}

/** Host index over every conversation's reference material. Recomputed only
    for documents whose mtime changed, or when the code index generation does. */
export class ReferenceLinkIndex {
  private _cache = new Map<string, CachedLink>();
  private _generation = "";

  constructor(private readonly _store: ReferenceStoreLike) {}

  links(generation: string, fileSet: ReadonlySet<string>, byBasename: ReadonlyMap<string, string[]>, routes: readonly RouteProvider[]): ReferenceLink[] {
    if (generation !== this._generation) {
      this._cache.clear();
      this._generation = generation;
    }
    const out: ReferenceLink[] = [];
    const live = new Set<string>();
    let sessions: string[] = [];
    try { sessions = this._store.listSessions(); } catch { return []; }
    for (const session of sessions) {
      const docs: Array<{ name: string; abs: string; kind: ReferenceLink["kind"] }> = [];
      for (const attachment of safeList(() => this._store.listAttachments(session))) {
        const ext = attachment.name.slice(attachment.name.lastIndexOf(".") + 1).toLowerCase();
        if (!TEXT_EXTENSIONS.has(ext) || attachment.byteSize > MAX_TEXT_BYTES) continue;
        docs.push({ name: attachment.name, abs: attachment.path, kind: "attachment" });
      }
      const contextPath = this._store.contextMdPath(session);
      if (fs.existsSync(contextPath)) docs.push({ name: path.basename(contextPath), abs: contextPath, kind: "context" });
      for (const doc of docs) {
        const id = `${session}/${doc.name}`;
        live.add(id);
        let mtime = 0;
        try { mtime = fs.statSync(doc.abs).mtimeMs; } catch { continue; }
        const cached = this._cache.get(id);
        if (cached && cached.mtime === mtime) {
          if (cached.link.targets.length > 0) out.push(cached.link);
          continue;
        }
        let text = "";
        try { text = fs.readFileSync(doc.abs, "utf8"); } catch { continue; }
        const link: ReferenceLink = {
          id,
          name: doc.name,
          session,
          workspacePath: this._store.workspacePath(doc.abs),
          kind: doc.kind,
          targets: linkReferenceText(text, fileSet, byBasename, routes),
        };
        this._cache.set(id, { mtime, link });
        if (link.targets.length > 0) out.push(link);
      }
    }
    for (const id of [...this._cache.keys()]) if (!live.has(id)) this._cache.delete(id);
    return out;
  }
}

function safeList<T>(fn: () => T[]): T[] {
  try { return fn(); } catch { return []; }
}
