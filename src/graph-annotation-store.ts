/* Durable Codebase Map "working memory" for the extension. The note rules — shape, caps,
   duplicates, revisions, path validation, and the dispatch() surface behind the map_note_* agent
   tools ("graph.*" runtime) — live in src/graph/notes.ts (NoteBook). This is the file-backed
   store: .blacksite/graph.json, physically separate from the regenerable graph cache so a
   re-index can never destroy a note, written atomically and recovered from its .bak after a torn
   write. Template: base-context-store.ts. */

import * as fs from "fs";
import * as path from "path";
import { NoteBook, defaultNoteDocument, type GraphAnnotationContext } from "./graph/notes.js";
import type { WorkspaceRoot } from "./graph/workspace-roots.js";
import { atomicWriteJson, ensureDir, readJsonDocument } from "./shared/durable-file.js";

export {
  NOTE_CATEGORIES,
  RELATION_KINDS,
  normalizeStoredPath,
  type GraphAnnotation,
  type GraphAnnotationContext,
  type GraphAnnotationDocument,
  type GraphAnnotationRevision,
  type NoteCategory,
  type RelationKind,
} from "./graph/notes.js";

const GRAPH_FILE = "graph.json";
const BLACKSITE_DIR = ".blacksite";

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
  /**
   * Compact map neighbourhood for the files currently in play (the user's active
   * editor and open tabs). Injected alongside workspaceOverview so a turn that
   * starts "fix this" already knows the file's area, blast radius, and attached
   * notes — the orientation an agent would otherwise spend its first tool call
   * on, for the file it is most likely to be asked about.
   */
  localOverview?(paths: readonly string[]): Promise<string>;
  /** Bring the map index up to date with the disk now instead of after the watcher's debounce.
   *  Resolves with how many changed paths were waiting. */
  syncIndex?(): Promise<{ appliedChanges: number }>;
  /**
   * Root of the project that owns a workspace-relative path: the deepest project the Map found
   * (a package.json, pyproject.toml, go.mod, … folder) containing it, as a map id. "" when the
   * path belongs to no project; undefined when the Map has no topology yet. Lets per-project
   * work (a check run inside one project) be told apart in a workspace holding many.
   */
  projectRootOf?(path: string): string | undefined;
  /** Whether the Map would index this path, so it can carry a note. A scratch folder, a dot
   *  directory or a virtualenv never can. */
  isMapIndexable?(path: string): boolean;
}

/** Durable annotations live under the first workspace folder. */
function annotationFile(roots: () => readonly WorkspaceRoot[]): string {
  const root = roots()[0]?.path ?? process.cwd();
  return path.join(root, BLACKSITE_DIR, GRAPH_FILE);
}

export class GraphAnnotationStore extends NoteBook implements GraphAnnotationProvider {
  private readonly _fileRoots: () => WorkspaceRoot[];

  constructor(roots: () => WorkspaceRoot[]) {
    super({
      roots,
      storage: {
        read: () => readJsonDocument(annotationFile(roots)),
        write: (document) => atomicWriteJson(annotationFile(roots), document),
      },
      exists: (absolutePath) => fs.existsSync(absolutePath),
    });
    this._fileRoots = roots;
  }

  ensureInitialized(): void {
    ensureDir(path.dirname(this.filePath()));
    if (!fs.existsSync(this.filePath())) {
      atomicWriteJson(this.filePath(), defaultNoteDocument());
    }
  }

  filePath(): string {
    return annotationFile(this._fileRoots);
  }
}
