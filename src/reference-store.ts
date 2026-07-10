// Permanent, per-conversation attachment storage under `<workspaceRoot>/.blacksite/reference/<sessionId>/`.
//
// This is deliberately workspace-visible (not VS Code's private storageUri) — attached
// files are user data the user explicitly chose to keep, and the per-conversation
// `Extracted context.md` scratchpad is meant to be human- and agent-editable on disk.
// `vscode`-free, mirroring MemoryStore/PlanningStore, so it can be unit-tested directly.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const DIR = ".blacksite";
const REFERENCE_DIR = "reference";
const CONTEXT_FILE = "Extracted context.md";
const RESERVED_PATH_CHARS = ["\\", "/", ":", "*", "?", "\"", "<", ">", "|"];

export interface ReferenceAttachment {
  name: string;
  path: string;
  byteSize: number;
  hash: string;
  addedAt: string;
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/** Strip path separators and control characters so a filename can never escape the session directory. */
function sanitizeFileName(name: string): string {
  let out = "";
  for (const ch of path.basename(name)) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || RESERVED_PATH_CHARS.includes(ch) ? "_" : ch;
  }
  out = out.trim();
  return out || "file";
}

export class ReferenceStore {
  private readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceRoot, DIR, REFERENCE_DIR);
  }

  ensureInitialized(): void {
    ensureDir(this.root);
  }

  sessionDir(sessionId: string): string {
    return path.join(this.root, sanitizeFileName(sessionId));
  }

  private ensureSessionDir(sessionId: string): string {
    const dir = this.sessionDir(sessionId);
    ensureDir(dir);
    return dir;
  }

  /** Resolve a desired filename to a collision-free path guaranteed to stay inside the session directory. */
  private resolveAttachmentPath(sessionId: string, desiredName: string): string {
    const dir = this.ensureSessionDir(sessionId);
    const safe = sanitizeFileName(desiredName);
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length) || "file";

    let candidate = path.join(dir, safe);
    for (let n = 1; fs.existsSync(candidate); n += 1) {
      candidate = path.join(dir, `${stem} (${n})${ext}`);
    }

    const resolvedDir = path.resolve(dir);
    const resolved = path.resolve(candidate);
    const relative = path.relative(resolvedDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to write attachment outside its session directory: ${desiredName}`);
    }
    return resolved;
  }

  /** Copy an existing on-disk file (e.g. from a native file picker) into permanent per-conversation storage. */
  copyAttachment(sessionId: string, sourcePath: string, desiredName?: string): ReferenceAttachment {
    const target = this.resolveAttachmentPath(sessionId, desiredName ?? path.basename(sourcePath));
    fs.copyFileSync(sourcePath, target);
    return this._describe(target);
  }

  /** Write raw bytes (e.g. a pasted/dropped image) into permanent per-conversation storage. */
  writeAttachmentBytes(sessionId: string, desiredName: string, bytes: Buffer): ReferenceAttachment {
    const target = this.resolveAttachmentPath(sessionId, desiredName);
    fs.writeFileSync(target, bytes);
    return this._describe(target);
  }

  /** Read one named attachment from this conversation only. The exact sanitized
      filename check prevents a caller from escaping the session directory. */
  readAttachmentText(sessionId: string, name: string): string | undefined {
    const safe = sanitizeFileName(name);
    if (safe !== name || safe === CONTEXT_FILE) return undefined;
    const dir = path.resolve(this.sessionDir(sessionId));
    const target = path.resolve(dir, safe);
    const relative = path.relative(dir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    try { return fs.readFileSync(target, "utf8"); } catch { return undefined; }
  }

  attachmentPath(sessionId: string, name: string): string | undefined {
    const safe = sanitizeFileName(name);
    if (safe !== name || safe === CONTEXT_FILE) return undefined;
    const dir = path.resolve(this.sessionDir(sessionId));
    const target = path.resolve(dir, safe);
    const relative = path.relative(dir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return fs.existsSync(target) ? target : undefined;
  }

  listAttachments(sessionId: string): ReferenceAttachment[] {
    const dir = this.sessionDir(sessionId);
    try {
      return fs.readdirSync(dir)
        .filter((f) => f !== CONTEXT_FILE)
        .map((f) => this._describe(path.join(dir, f)));
    } catch {
      return [];
    }
  }

  private _describe(absPath: string): ReferenceAttachment {
    const bytes = fs.readFileSync(absPath);
    return {
      name: path.basename(absPath),
      path: absPath,
      byteSize: bytes.byteLength,
      hash: crypto.createHash("sha256").update(bytes).digest("hex"),
      addedAt: new Date().toISOString(),
    };
  }

  contextMdPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), CONTEXT_FILE);
  }

  readContextMd(sessionId: string): string {
    try { return fs.readFileSync(this.contextMdPath(sessionId), "utf8"); } catch { return ""; }
  }

  writeContextMd(sessionId: string, content: string): void {
    this.ensureSessionDir(sessionId);
    fs.writeFileSync(this.contextMdPath(sessionId), content, "utf8");
  }

  appendContextMd(sessionId: string, entry: string): void {
    this.ensureSessionDir(sessionId);
    const timestamp = new Date().toISOString().slice(0, 16);
    const text = `\n## ${timestamp}\n\n${entry.trim()}\n`;
    fs.appendFileSync(this.contextMdPath(sessionId), text, "utf8");
  }
}
