// Body storage for plan/phase documentation — the markdown text and file attachments behind
// the `docs[]` metadata PlanningStore keeps inline in planning.json (see PlanDocMeta there).
//
// Kept as a separate file-backed store, mirroring ReferenceStore, for the same reason: doc
// bodies can run tens of thousands of characters and planning.json is rewritten in full on
// every plan mutation (PlanningStore.write) — inlining bodies there would mean rewriting every
// doc's full text on every unrelated status/step change. Metadata (title/kind/size/timestamps)
// stays cheap and inline; content lives on disk, read on demand.
//
// `vscode`-free so it can be unit-tested directly, matching PlanningStore/ReferenceStore.

import * as fs from "fs";
import * as path from "path";

const BLACKSITE_DIR = ".blacksite";
const PLANS_DIR = "plans";
const DOCS_SUBDIR = "docs";
const FILES_SUBDIR = "files";
const RESERVED_PATH_CHARS = ["\\", "/", ":", "*", "?", "\"", "<", ">", "|"];

/** Markdown doc bodies aren't injected into every prompt the way plan `blocks` are (they're
 *  read on demand via plan_doc_read) so this cap is far more generous than MAX_BLOCK_BODY —
 *  still bounded so a runaway write can't produce an unbounded file. */
export const MAX_DOC_BODY = 50_000;

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/** Strip path separators and control characters so an id/filename can never escape its directory. Mirrors ReferenceStore's sanitizeFileName. */
function sanitizeFileName(name: string): string {
  let out = "";
  for (const ch of path.basename(name)) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || RESERVED_PATH_CHARS.includes(ch) ? "_" : ch;
  }
  out = out.trim();
  return out || "file";
}

export class PlanDocStore {
  private readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceRoot, BLACKSITE_DIR, PLANS_DIR);
  }

  private planDir(planId: string): string {
    return path.join(this.root, sanitizeFileName(planId));
  }

  private docsDir(planId: string): string {
    return path.join(this.planDir(planId), DOCS_SUBDIR);
  }

  private filesDir(planId: string): string {
    return path.join(this.planDir(planId), FILES_SUBDIR);
  }

  /** Absolute path of a doc's markdown file — public so a provider can open the real file in
   *  a VSCode editor tab (the "Open in Editor" affordance) instead of only reading its text. */
  markdownAbsPath(planId: string, docId: string): string {
    return path.join(this.docsDir(planId), `${sanitizeFileName(docId)}.md`);
  }

  /** Writes (creating or overwriting) a doc's markdown body, capped at MAX_DOC_BODY. Returns the stored byte size. */
  writeMarkdown(planId: string, docId: string, body: string): number {
    ensureDir(this.docsDir(planId));
    const capped = body.slice(0, MAX_DOC_BODY);
    fs.writeFileSync(this.markdownAbsPath(planId, docId), capped, "utf8");
    return Buffer.byteLength(capped, "utf8");
  }

  readMarkdown(planId: string, docId: string): string {
    try { return fs.readFileSync(this.markdownAbsPath(planId, docId), "utf8"); } catch { return ""; }
  }

  deleteMarkdown(planId: string, docId: string): void {
    try { fs.unlinkSync(this.markdownAbsPath(planId, docId)); } catch { /* already gone */ }
  }

  /** Resolve a desired filename to a collision-free path inside this plan's files directory,
   *  prefixed with the doc id so two attachments with the same original filename never collide
   *  across docs. Mirrors ReferenceStore.resolveAttachmentPath's containment check. */
  private resolveFilePath(planId: string, docId: string, desiredName: string): string {
    const dir = this.filesDir(planId);
    ensureDir(dir);
    const safe = sanitizeFileName(desiredName);
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length) || "file";
    const idPrefix = sanitizeFileName(docId);

    let candidate = path.join(dir, `${idPrefix}-${stem}${ext}`);
    for (let n = 1; fs.existsSync(candidate); n += 1) {
      candidate = path.join(dir, `${idPrefix}-${stem} (${n})${ext}`);
    }

    const resolvedDir = path.resolve(dir);
    const resolved = path.resolve(candidate);
    const relative = path.relative(resolvedDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to write plan attachment outside its files directory: ${desiredName}`);
    }
    return resolved;
  }

  /** Copies an existing on-disk file (e.g. from a native file picker) into permanent plan storage. */
  attachFile(planId: string, docId: string, sourceAbsPath: string, desiredName?: string): { attachmentFilename: string; byteSize: number } {
    const target = this.resolveFilePath(planId, docId, desiredName ?? path.basename(sourceAbsPath));
    fs.copyFileSync(sourceAbsPath, target);
    return { attachmentFilename: path.basename(target), byteSize: fs.statSync(target).size };
  }

  /** Resolve a stored attachment's absolute path, refusing anything that isn't an exact,
   *  contained filename (same guard shape as ReferenceStore.attachmentPath). */
  attachmentAbsPath(planId: string, attachmentFilename: string): string | undefined {
    const safe = sanitizeFileName(attachmentFilename);
    if (safe !== attachmentFilename) return undefined;
    const dir = path.resolve(this.filesDir(planId));
    const target = path.resolve(dir, safe);
    const relative = path.relative(dir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return fs.existsSync(target) ? target : undefined;
  }

  deleteAttachment(planId: string, attachmentFilename: string): void {
    const abs = this.attachmentAbsPath(planId, attachmentFilename);
    if (abs) { try { fs.unlinkSync(abs); } catch { /* already gone */ } }
  }

  /** Removes every doc/attachment belonging to a plan. Only called from the explicit,
   *  user-driven permanent-delete path — never from archiving, which must keep everything on disk. */
  deletePlanDir(planId: string): void {
    try { fs.rmSync(this.planDir(planId), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
