/**
 * Claims as one agent session sees them: checked right before each write, released when the
 * session's work ends.
 *
 * A delegated lane ({@link LaneClaims}) takes a claim on every path it is about to write. If
 * another lane holds one, or another lane changed a file this lane is about to overwrite since it
 * read it, that is a collision: recorded and signalled in `observe`, refused with the other lane
 * named in `enforce`. Reads never take claims and are never refused.
 *
 * The user's own chat agent ({@link MainSessionClaims}) holds nothing and is never refused (plan
 * D8): a background lane must not stand in the way of the person at the keyboard. It is warned
 * when it writes into a file a lane is working on, and its writes still count, so a lane that read
 * a file before the user's agent changed it is told its copy is stale.
 *
 * With claims on, a lane's shell commands are diffed afterwards (`git status` before and after),
 * because what a command writes cannot be known before it runs. What it changed is attributed to
 * the lane — unless another lane's command ran at the same time, in which case it is recorded as
 * unattributed rather than guessed at.
 *
 * No vscode import.
 */

import type { ClaimsMode } from "../flags.js";
import type { SignalSink } from "../signals/model.js";
import type { ClaimHolder, ClaimRegistry } from "./registry.js";

export type BeforeWriteResult = { ok: true; warning?: string } | { ok: false; error: string };

/** What an AgentSession asks of claims. Every method is cheap and never throws. */
export interface SessionClaims {
  beforeWrite(toolName: string, targets: readonly string[], options?: { prefix?: boolean }): BeforeWriteResult;
  afterWrite(paths: readonly string[]): void;
  noteRead(paths: readonly string[]): void;
  /** Any tool call: the session is alive, so its claims stay. */
  touch(): void;
  beforeShell?(): Promise<void>;
  afterShell?(): Promise<void>;
}

/** Whole-file overwrite and position-addressed edits: a stale copy is silently destructive. */
const STALE_SENSITIVE = new Set(["file_write", "code_insert"]);

/** The tools whose writes cannot be known before they run. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["shell_run", "test_run", "process_start", "sequence_execute"]);

/** path → a signature that changes when the file does (status, size, mtime). */
export type WorkingTreeState = Map<string, string>;

export interface LaneClaimsOptions {
  registry: ClaimRegistry;
  holder: ClaimHolder;
  mode: () => ClaimsMode;
  sink: SignalSink;
  /** Workspace-relative, forward slashes; null for a path outside the workspace. */
  toRelative: (path: string) => string | null;
  /** The working tree's changed files right now, or undefined when that cannot be had cheaply. */
  workingTree?: () => Promise<WorkingTreeState | undefined>;
}

function describe(holder: ClaimHolder): string {
  return holder.ticketId ? `${holder.ticketId}'s lane` : holder.label;
}

export class LaneClaims implements SessionClaims {
  /** Paths where this lane collided with another, refused or not. */
  readonly conflicts = new Set<string>();
  /** Files this lane's own shell commands changed. */
  readonly shellChanged = new Set<string>();
  /** Files that changed while this lane's command and another lane's ran together. */
  readonly unattributed = new Set<string>();
  private _shellRuns = 0;
  private _shellDeltas = 0;
  private readonly _readVersions = new Map<string, number>();
  private _before: WorkingTreeState | undefined;

  constructor(private readonly _options: LaneClaimsOptions) {}

  get holder(): ClaimHolder {
    return this._options.holder;
  }

  private _mode(): ClaimsMode {
    try {
      return this._options.mode();
    } catch {
      return "off";
    }
  }

  private _relative(paths: readonly string[]): string[] {
    const out: string[] = [];
    for (const path of paths) {
      const relative = this._options.toRelative(path);
      if (relative && !out.includes(relative)) out.push(relative);
    }
    return out;
  }

  /** Whether every shell command this lane ran was diffed: the receipt's coverage depends on it. */
  get shellCovered(): boolean {
    return this._shellRuns > 0 && this._shellDeltas === this._shellRuns;
  }

  beforeWrite(toolName: string, targets: readonly string[], options: { prefix?: boolean } = {}): BeforeWriteResult {
    const mode = this._mode();
    if (mode === "off") return { ok: true };
    const paths = this._relative(targets);
    if (!paths.length) return { ok: true };
    const { registry, holder } = this._options;

    // A copy read before someone else changed the file, about to be written over wholesale.
    const stale: Array<{ path: string; by: string }> = [];
    if (STALE_SENSITIVE.has(toolName)) {
      for (const path of paths) {
        const read = this._readVersions.get(registry.key(path));
        const writer = registry.lastWriter(path);
        if (read !== undefined && registry.version(path) > read && writer && writer !== holder.id) {
          stale.push({ path, by: writer === "main" ? "your chat agent" : (registry.holderOf(path, holder.id)?.label ?? "another lane") });
        }
      }
    }
    const acquired = registry.acquire(holder, paths, options);
    const conflicts = acquired.ok ? [] : acquired.conflicts;

    for (const conflict of conflicts) {
      this.conflicts.add(conflict.path);
      this._options.sink.emit({
        kind: "contract_conflict",
        taskId: holder.ticketId ? `ticket:${holder.ticketId}` : `lane:${holder.laneId}`,
        causeId: `claim:${holder.id}:${conflict.path}:${conflict.holder.id}`,
        provenance: { source: "host", observer: "claims" },
        scope: { laneId: holder.laneId, ...(holder.contractId ? { contractId: holder.contractId } : {}), ...(holder.loopId ? { loopId: holder.loopId } : {}) },
        evidence: [{ kind: "file", ref: conflict.path }],
        detail: `${describe(holder)} tried to write ${conflict.path} while ${describe(conflict.holder)} was working on it.`,
        data: { path: conflict.path, with: conflict.holder.laneId, refused: mode === "enforce" },
      });
    }
    for (const entry of stale) {
      this.conflicts.add(entry.path);
      this._options.sink.emit({
        kind: "contract_conflict",
        taskId: holder.ticketId ? `ticket:${holder.ticketId}` : `lane:${holder.laneId}`,
        causeId: `stale:${holder.id}:${entry.path}:${registry.version(entry.path)}`,
        provenance: { source: "host", observer: "claims.stale_read" },
        scope: { laneId: holder.laneId, ...(holder.loopId ? { loopId: holder.loopId } : {}) },
        evidence: [{ kind: "file", ref: entry.path }],
        detail: `${describe(holder)} was about to overwrite ${entry.path}, which ${entry.by} changed after it was read.`,
        data: { path: entry.path, staleRead: true, refused: mode === "enforce" },
      });
    }

    if (mode !== "enforce" || (!conflicts.length && !stale.length)) return { ok: true };
    const parts: string[] = [];
    if (conflicts.length) {
      const named = [...new Map(conflicts.map((entry) => [entry.path, entry])).values()].slice(0, 6)
        .map((entry) => `${entry.path} (${describe(entry.holder)})`);
      parts.push(`Not written: another lane is working on ${named.join(", ")}. `
        + "Work on other files first, wait and try again later, or report that this change needs those files.");
    }
    if (stale.length) {
      parts.push(`Not written: ${stale.slice(0, 6).map((entry) => `${entry.path} was changed by ${entry.by}`).join("; ")} after you read it. `
        + "Read it again and build your change on what is there now.");
    }
    return { ok: false, error: parts.join(" ") };
  }

  afterWrite(paths: readonly string[]): void {
    if (this._mode() === "off") return;
    const { registry, holder } = this._options;
    for (const path of this._relative(paths)) {
      registry.noteWrite(path, holder.id);
      // Its own write is the lane's current picture of the file.
      this._readVersions.set(registry.key(path), registry.version(path));
    }
  }

  noteRead(paths: readonly string[]): void {
    if (this._mode() === "off") return;
    const { registry } = this._options;
    for (const path of this._relative(paths)) this._readVersions.set(registry.key(path), registry.version(path));
  }

  touch(): void {
    if (this._mode() === "off") return;
    this._options.registry.renew(this._options.holder.id);
  }

  async beforeShell(): Promise<void> {
    if (this._mode() === "off") return;
    this._shellRuns += 1;
    this._options.registry.beginShell(this._options.holder.id);
    this._before = await this._snapshot();
  }

  async afterShell(): Promise<void> {
    if (this._mode() === "off") return;
    const { registry, holder } = this._options;
    const before = this._before;
    this._before = undefined;
    const after = await this._snapshot();
    const overlapped = registry.endShell(holder.id);
    if (!before || !after) return;
    this._shellDeltas += 1;
    const changed: string[] = [];
    for (const [path, signature] of after) if (before.get(path) !== signature) changed.push(path);
    for (const path of before.keys()) if (!after.has(path)) changed.push(path);
    for (const path of changed.sort()) {
      if (overlapped) {
        this.unattributed.add(path);
        continue;
      }
      this.shellChanged.add(path);
      const other = registry.holderOf(path, holder.id);
      if (other) {
        this.conflicts.add(path);
        this._options.sink.emit({
          kind: "contract_conflict",
          taskId: holder.ticketId ? `ticket:${holder.ticketId}` : `lane:${holder.laneId}`,
          causeId: `shell:${holder.id}:${path}:${other.id}`,
          provenance: { source: "host", observer: "shell_delta" },
          scope: { laneId: holder.laneId, ...(holder.loopId ? { loopId: holder.loopId } : {}) },
          evidence: [{ kind: "file", ref: path }],
          detail: `A command run by ${describe(holder)} changed ${path}, which ${describe(other)} was working on.`,
          data: { path, with: other.laneId, fromCommand: true },
        });
      }
      registry.noteWrite(path, holder.id);
    }
  }

  private async _snapshot(): Promise<WorkingTreeState | undefined> {
    try {
      return await this._options.workingTree?.();
    } catch {
      return undefined;
    }
  }

  release(): void {
    this._options.registry.release(this._options.holder.id);
  }
}

export class MainSessionClaims implements SessionClaims {
  constructor(
    private readonly _registry: ClaimRegistry,
    private readonly _mode: () => ClaimsMode,
    private readonly _toRelative: (path: string) => string | null,
  ) {}

  beforeWrite(_toolName: string, targets: readonly string[]): BeforeWriteResult {
    if (this._safeMode() === "off") return { ok: true };
    const busy: string[] = [];
    for (const target of targets) {
      const relative = this._toRelative(target);
      const holder = relative ? this._registry.holderOf(relative) : undefined;
      if (relative && holder) busy.push(`${relative} (${describe(holder)})`);
    }
    if (!busy.length) return { ok: true };
    return { ok: true, warning: `A delegated lane is working on ${busy.slice(0, 4).join(", ")} right now; this change and its may collide. Check the file after the lane finishes.` };
  }

  afterWrite(paths: readonly string[]): void {
    if (this._safeMode() === "off") return;
    for (const path of paths) {
      const relative = this._toRelative(path);
      if (relative) this._registry.noteWrite(relative, "main");
    }
  }

  noteRead(): void { /* the user's agent is never refused, so it needs no picture of versions */ }

  touch(): void { /* holds nothing */ }

  private _safeMode(): ClaimsMode {
    try {
      return this._mode();
    } catch {
      return "off";
    }
  }
}
