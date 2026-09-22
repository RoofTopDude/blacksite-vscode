// Permanent, per-conversation attachment storage under `<workspaceRoot>/.blacksite/reference/<sessionId>/`.
//
// This is deliberately workspace-visible (not VS Code's private storageUri) — attached
// files are user data the user explicitly chose to keep, and the per-conversation
// `Extracted context.md` scratchpad is meant to be human- and agent-editable on disk.
// `vscode`-free, mirroring MemoryStore/PlanningStore, so it can be unit-tested directly.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const DIR = ".blacksite";
const REFERENCE_DIR = "reference";
const CONTEXT_FILE = "Extracted context.md";
const ATTACHMENT_MANIFEST_FILE = ".attachments.json";
const RESERVED_PATH_CHARS = ["\\", "/", ":", "*", "?", "\"", "<", ">", "|"];

export interface ReferenceAttachment {
  name: string;
  path: string;
  byteSize: number;
  hash: string;
  addedAt: string;
  /** Internal cache validation; callers should use hash/byteSize as the stable public identity. */
  modifiedAtMs?: number;
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

  constructor(private readonly workspaceRoot: string) {
    this.root = path.join(workspaceRoot, DIR, REFERENCE_DIR);
  }

  /** Workspace-relative, forward-slash form of a stored file — the path file_read accepts. */
  workspacePath(absPath: string): string {
    return path.relative(this.workspaceRoot, absPath).split(path.sep).join("/");
  }

  /** Every conversation that has a reference directory, newest activity first. */
  listSessions(): string[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(this.root, { withFileTypes: true }); } catch { return []; }
    const mtime = (name: string): number => {
      try { return fs.statSync(path.join(this.root, name)).mtimeMs; } catch { return 0; }
    };
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, at: mtime(entry.name) }))
      .sort((a, b) => b.at - a.at)
      .map((entry) => entry.name);
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
    const sanitized = sanitizeFileName(desiredName);
    const safe = sanitized === ATTACHMENT_MANIFEST_FILE || sanitized === CONTEXT_FILE ? `_${sanitized}` : sanitized;
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
    const attachment = this._describe(target);
    this._rememberAttachment(sessionId, attachment);
    return attachment;
  }

  /** Copy and hash a picker attachment in one bounded-memory pass. */
  async copyAttachmentStreamed(sessionId: string, sourcePath: string, desiredName?: string): Promise<ReferenceAttachment> {
    const target = this.resolveAttachmentPath(sessionId, desiredName ?? path.basename(sourcePath));
    const hash = crypto.createHash("sha256");
    let byteSize = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        byteSize += chunk.byteLength;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(fs.createReadStream(sourcePath), meter, fs.createWriteStream(target, { flags: "wx" }));
    } catch (error) {
      try { fs.unlinkSync(target); } catch { /* no partial target was created */ }
      throw error;
    }
    const stat = fs.statSync(target);
    const attachment: ReferenceAttachment = {
      name: path.basename(target),
      path: target,
      byteSize,
      hash: hash.digest("hex"),
      addedAt: new Date().toISOString(),
      modifiedAtMs: stat.mtimeMs,
    };
    this._rememberAttachment(sessionId, attachment);
    return attachment;
  }

  /** Write raw bytes (e.g. a pasted/dropped image) into permanent per-conversation storage. */
  writeAttachmentBytes(sessionId: string, desiredName: string, bytes: Buffer): ReferenceAttachment {
    const target = this.resolveAttachmentPath(sessionId, desiredName);
    fs.writeFileSync(target, bytes);
    const attachment = this._describe(target);
    this._rememberAttachment(sessionId, attachment);
    return attachment;
  }

  /** Read one named attachment from this conversation only. The exact sanitized
      filename check prevents a caller from escaping the session directory. */
  readAttachmentText(sessionId: string, name: string): string | undefined {
    const safe = sanitizeFileName(name);
    if (safe !== name || safe === CONTEXT_FILE || safe === ATTACHMENT_MANIFEST_FILE) return undefined;
    const dir = path.resolve(this.sessionDir(sessionId));
    const target = path.resolve(dir, safe);
    const relative = path.relative(dir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    try { return fs.readFileSync(target, "utf8"); } catch { return undefined; }
  }

  attachmentPath(sessionId: string, name: string): string | undefined {
    const safe = sanitizeFileName(name);
    if (safe !== name || safe === CONTEXT_FILE || safe === ATTACHMENT_MANIFEST_FILE) return undefined;
    const dir = path.resolve(this.sessionDir(sessionId));
    const target = path.resolve(dir, safe);
    const relative = path.relative(dir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return fs.existsSync(target) ? target : undefined;
  }

  listAttachments(sessionId: string): ReferenceAttachment[] {
    const dir = this.sessionDir(sessionId);
    try {
      const known = new Map(this._readAttachmentManifest(sessionId).map((attachment) => [attachment.name, attachment]));
      let changed = false;
      return fs.readdirSync(dir)
        .filter((f) => f !== CONTEXT_FILE && f !== ATTACHMENT_MANIFEST_FILE)
        .map((f) => {
          const absPath = path.join(dir, f);
          const cached = known.get(f);
          const stat = fs.statSync(absPath);
          if (cached && cached.byteSize === stat.size && cached.modifiedAtMs === stat.mtimeMs) return { ...cached, path: absPath };
          changed = true;
          return this._describe(absPath);
        })
        .map((attachment, _index, all) => {
          if (changed && _index === all.length - 1) this._writeAttachmentManifest(sessionId, all);
          return attachment;
        });
    } catch {
      return [];
    }
  }

  private _describe(absPath: string): ReferenceAttachment {
    const hash = crypto.createHash("sha256");
    const handle = fs.openSync(absPath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let byteSize = 0;
    try {
      for (;;) {
        const read = fs.readSync(handle, buffer, 0, buffer.length, null);
        if (read <= 0) break;
        hash.update(buffer.subarray(0, read));
        byteSize += read;
      }
    } finally {
      fs.closeSync(handle);
    }
    const stat = fs.statSync(absPath);
    return {
      name: path.basename(absPath),
      path: absPath,
      byteSize,
      hash: hash.digest("hex"),
      addedAt: new Date().toISOString(),
      modifiedAtMs: stat.mtimeMs,
    };
  }

  private _attachmentManifestPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), ATTACHMENT_MANIFEST_FILE);
  }

  private _readAttachmentManifest(sessionId: string): ReferenceAttachment[] {
    try {
      const value = JSON.parse(fs.readFileSync(this._attachmentManifestPath(sessionId), "utf8")) as unknown;
      return Array.isArray(value)
        ? value.filter((item): item is ReferenceAttachment => !!item && typeof item === "object" && typeof item.name === "string")
        : [];
    } catch {
      return [];
    }
  }

  private _writeAttachmentManifest(sessionId: string, attachments: ReferenceAttachment[]): void {
    this.ensureSessionDir(sessionId);
    const portable = attachments.map(({ name, byteSize, hash, addedAt, modifiedAtMs }) => ({ name, byteSize, hash, addedAt, modifiedAtMs }));
    fs.writeFileSync(this._attachmentManifestPath(sessionId), JSON.stringify(portable, null, 2), "utf8");
  }

  private _rememberAttachment(sessionId: string, attachment: ReferenceAttachment): void {
    const attachments = this._readAttachmentManifest(sessionId).filter((item) => item.name !== attachment.name);
    attachments.push(attachment);
    this._writeAttachmentManifest(sessionId, attachments);
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
