/* Diagrams saved with the project: `.blacksite/context/diagrams/<name>.mmd`.
 *
 * A diagram that lives only in a chat reply is gone from the agent's reach the moment the
 * conversation compacts, and a large one is expensive to regenerate on every change. A file the
 * agent can read and patch survives both, and the viewer can follow it as it changes. Plain
 * Mermaid source, one diagram per file, so it also opens in anything else that reads .mmd.
 *
 * Each save keeps the previous contents as `<name>.mmd.bak` (see durable-file.ts), which is the
 * one-step undo for an edit that turns out wrong. The folder is under `.blacksite/`, which projects
 * usually keep out of version control; copy a diagram out to keep it in the repository.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../shared/durable-file.js";
import { MAX_DIAGRAM_SOURCE_CHARS, describeMermaid } from "../shared/mermaid-source.js";
import { diagramFileName, normalizeSource } from "./diagram-edit.js";

export const DIAGRAMS_DIR = path.join(".blacksite", "context", "diagrams");
export const MAX_SAVED_DIAGRAMS = 200;

export interface SavedDiagram {
  /** The file name, e.g. "request-flow.mmd". It is how the other operations name a diagram. */
  name: string;
  /** Workspace-relative path, with forward slashes. */
  file: string;
  kind: string;
  title?: string;
  lines: number;
  chars: number;
  updatedAt: string;
}

export type StoreResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export class DiagramStore {
  constructor(private readonly _workspaceRoot: string) {}

  directory(): string {
    return path.join(this._workspaceRoot, DIAGRAMS_DIR);
  }

  /** Absolute path for a diagram name, or undefined when the name is unusable. */
  resolve(name: string): string | undefined {
    const file = diagramFileName(name);
    return file ? path.join(this.directory(), file) : undefined;
  }

  /** The workspace-relative path used in messages to the agent and the user. */
  relativePath(name: string): string {
    return `${DIAGRAMS_DIR.split(path.sep).join("/")}/${diagramFileName(name) ?? name}`;
  }

  /** The name a diagram path is stored under, if `absolute` is inside the diagrams folder. */
  nameOf(absolute: string): string | undefined {
    const relative = path.relative(this.directory(), absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) return undefined;
    return /\.mmd$/i.test(relative) ? relative : undefined;
  }

  list(): SavedDiagram[] {
    let names: string[];
    try { names = fs.readdirSync(this.directory()).filter((entry) => /\.mmd$/i.test(entry)); } catch { return []; }
    const entries: SavedDiagram[] = [];
    for (const name of names.slice(0, MAX_SAVED_DIAGRAMS)) {
      try {
        const absolute = path.join(this.directory(), name);
        const stat = fs.statSync(absolute);
        if (!stat.isFile()) continue;
        const source = fs.readFileSync(absolute, "utf8");
        const { kind, title } = describeMermaid(source);
        entries.push({
          name,
          file: this.relativePath(name),
          kind,
          ...(title ? { title } : {}),
          lines: normalizeSource(source).split("\n").length,
          chars: source.length,
          updatedAt: stat.mtime.toISOString(),
        });
      } catch { /* a file that vanished between the listing and the read is simply not listed */ }
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  read(name: string): StoreResult<{ name: string; file: string; source: string }> {
    const absolute = this.resolve(name);
    if (!absolute) return { ok: false, error: `"${name}" is not a usable diagram name.` };
    try {
      const source = normalizeSource(fs.readFileSync(absolute, "utf8"));
      return { ok: true, name: path.basename(absolute), file: this.relativePath(name), source };
    } catch {
      const known = this.list().slice(0, 12).map((entry) => entry.name);
      return {
        ok: false,
        error: `No saved diagram named "${path.basename(absolute)}".${known.length ? ` Saved diagrams: ${known.join(", ")}.` : " None are saved yet."}`,
      };
    }
  }

  /** Create a diagram, or replace one when `overwrite` is set. */
  write(name: string, source: string, options: { overwrite?: boolean } = {}): StoreResult<{ name: string; file: string; created: boolean }> {
    const absolute = this.resolve(name);
    if (!absolute) return { ok: false, error: `"${name}" is not a usable diagram name. Use letters, digits, dashes, and dots.` };
    const body = normalizeSource(source);
    if (!body.trim()) return { ok: false, error: "The diagram is empty." };
    if (body.length > MAX_DIAGRAM_SOURCE_CHARS) {
      return { ok: false, error: `The diagram is ${body.length.toLocaleString()} characters; Mermaid draws at most ${MAX_DIAGRAM_SOURCE_CHARS.toLocaleString()}. Split it into more than one diagram.` };
    }
    const exists = fs.existsSync(absolute);
    if (exists && !options.overwrite) {
      return { ok: false, error: `${path.basename(absolute)} already exists. Change it with diagram_edit, or pass overwrite: true to replace it whole.` };
    }
    if (!exists && this.list().length >= MAX_SAVED_DIAGRAMS) {
      return { ok: false, error: `There are already ${MAX_SAVED_DIAGRAMS} saved diagrams; remove some from ${this.relativePath("x")} first.` };
    }
    try {
      atomicWriteFile(absolute, `${body}\n`);
    } catch (error) {
      return { ok: false, error: `Could not write ${path.basename(absolute)}: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { ok: true, name: path.basename(absolute), file: this.relativePath(name), created: !exists };
  }

  /** A name for a new diagram that does not collide with a saved one: `stem`, `stem-2`, … */
  freeName(stem: string): string {
    const base = (diagramFileName(stem) ?? "diagram.mmd").replace(/\.mmd$/, "");
    for (let attempt = 1; attempt < 1000; attempt += 1) {
      const candidate = attempt === 1 ? `${base}.mmd` : `${base}-${attempt}.mmd`;
      if (!fs.existsSync(path.join(this.directory(), candidate))) return candidate;
    }
    return `${base}-${Date.now()}.mmd`;
  }
}
