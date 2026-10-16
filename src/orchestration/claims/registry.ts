/**
 * Mutation-time claims: which delegated lane is writing which file right now.
 *
 * The scheduler already keeps lanes with overlapping declared territory apart. What it cannot see
 * is a lane writing outside what it declared, or two lanes discovering mid-run that they both need
 * the same file. A claim is taken at the moment of the write, on the exact paths written, and held
 * until the lane ends (or its lease lapses). A second lane's write into a held path is a collision.
 *
 * Claims are taken all-or-nothing per call and never waited on: a lane that cannot have every path
 * it is about to write is told who holds them, and decides what to do. Nothing ever blocks, so
 * nothing can deadlock. The registry also counts versions: every completed write to a path, by
 * anyone (the user's own chat agent included), bumps it, so a lane can tell that a file changed
 * under it since it read it.
 *
 * In memory only, per window. A restart therefore leaves nothing behind to clean up.
 *
 * Pure (injected clock). See docs/orchestration-p1-implementation-plan.md §4.
 */

export interface ClaimHolder {
  id: string;
  laneId: string;
  /** For a person: "BLK-7's lane", "Delegated lane: refactor auth". */
  label: string;
  contractId?: string;
  loopId?: string;
  ticketId?: string;
}

export interface Claim {
  key: string;
  /** A directory move or delete: everything beneath the path is claimed too. */
  prefix: boolean;
  holder: ClaimHolder;
  acquiredAt: number;
  renewedAt: number;
}

export interface ClaimConflict {
  path: string;
  holder: ClaimHolder;
}

export type AcquireResult = { ok: true } | { ok: false; conflicts: ClaimConflict[] };

export interface ClaimRegistryOptions {
  now?: () => number;
  /** A claim not renewed for this long lapses. Any tool call by the holder renews. */
  leaseMs?: number;
  /** No claim outlives this, renewed or not; a lane that still needs the path takes it again. */
  maxLeaseMs?: number;
  /** Windows and macOS: "src/App.ts" and "src/app.ts" are one file. */
  caseInsensitive?: boolean;
}

export const DEFAULT_LEASE_MS = 15 * 60_000;
export const DEFAULT_MAX_LEASE_MS = 2 * 60 * 60_000;

export function defaultCaseInsensitive(platform: string = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

export class ClaimRegistry {
  private readonly _now: () => number;
  private readonly _leaseMs: number;
  private readonly _maxLeaseMs: number;
  private readonly _caseInsensitive: boolean;
  /** Claims by key. One holder per key; prefix claims are checked against everything below them. */
  private readonly _claims = new Map<string, Claim>();
  private readonly _versions = new Map<string, { version: number; by: string }>();
  /** Holders with a shell command running, and whether another holder's ran alongside it. */
  private readonly _shells = new Map<string, { overlapped: boolean }>();

  constructor(options: ClaimRegistryOptions = {}) {
    this._now = options.now ?? (() => Date.now());
    this._leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this._maxLeaseMs = options.maxLeaseMs ?? DEFAULT_MAX_LEASE_MS;
    this._caseInsensitive = options.caseInsensitive ?? defaultCaseInsensitive();
  }

  /** The registry's spelling of a path: forward slashes, no ./ or trailing slash, case-folded where the OS folds. */
  key(path: string): string {
    const normalized = path.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    return this._caseInsensitive ? normalized.toLowerCase() : normalized;
  }

  private _expired(claim: Claim, now: number): boolean {
    return now - claim.renewedAt > this._leaseMs || now - claim.acquiredAt > this._maxLeaseMs;
  }

  private _reap(): void {
    const now = this._now();
    for (const [key, claim] of this._claims) if (this._expired(claim, now)) this._claims.delete(key);
  }

  private _overlapping(key: string, prefix: boolean, exceptHolder: string): Claim[] {
    const out: Claim[] = [];
    for (const claim of this._claims.values()) {
      if (claim.holder.id === exceptHolder) continue;
      if (claim.key === key
        || (claim.prefix && key.startsWith(`${claim.key}/`))
        || (prefix && claim.key.startsWith(`${key}/`))) {
        out.push(claim);
      }
    }
    return out;
  }

  /** Every path or none. Never waits. Lapsed claims are dropped first. */
  acquire(holder: ClaimHolder, paths: readonly string[], options: { prefix?: boolean } = {}): AcquireResult {
    this._reap();
    const prefix = options.prefix === true;
    const keys = [...new Set(paths.map((path) => this.key(path)).filter(Boolean))].sort();
    const conflicts: ClaimConflict[] = [];
    for (const key of keys) {
      for (const claim of this._overlapping(key, prefix, holder.id)) conflicts.push({ path: key, holder: claim.holder });
    }
    if (conflicts.length) return { ok: false, conflicts };
    const now = this._now();
    for (const key of keys) {
      const existing = this._claims.get(key);
      if (existing && existing.holder.id === holder.id) {
        existing.renewedAt = now;
        existing.prefix = existing.prefix || prefix;
      } else {
        this._claims.set(key, { key, prefix, holder, acquiredAt: now, renewedAt: now });
      }
    }
    return { ok: true };
  }

  /** Who other than `exceptHolder` holds this path (or a directory above it), if anyone. */
  holderOf(path: string, exceptHolder = ""): ClaimHolder | undefined {
    this._reap();
    return this._overlapping(this.key(path), false, exceptHolder)[0]?.holder;
  }

  renew(holderId: string): void {
    const now = this._now();
    for (const claim of this._claims.values()) if (claim.holder.id === holderId) claim.renewedAt = now;
  }

  release(holderId: string): void {
    for (const [key, claim] of this._claims) if (claim.holder.id === holderId) this._claims.delete(key);
    this._shells.delete(holderId);
  }

  /** A write to `path` completed. `by` is a holder id, or "main" for the user's own chat agent. */
  noteWrite(path: string, by: string): void {
    const key = this.key(path);
    if (!key) return;
    this._versions.set(key, { version: (this._versions.get(key)?.version ?? 0) + 1, by });
  }

  version(path: string): number {
    return this._versions.get(this.key(path))?.version ?? 0;
  }

  lastWriter(path: string): string | undefined {
    return this._versions.get(this.key(path))?.by;
  }

  /** Live claims, for scheduling admission (#15): path → holder. */
  held(exceptHolder = ""): ReadonlyMap<string, ClaimHolder> {
    this._reap();
    const out = new Map<string, ClaimHolder>();
    for (const claim of this._claims.values()) if (claim.holder.id !== exceptHolder) out.set(claim.key, claim.holder);
    return out;
  }

  claimsOf(holderId: string): Claim[] {
    return [...this._claims.values()].filter((claim) => claim.holder.id === holderId);
  }

  /** A holder's shell command started. Another holder's shell already running makes both ambiguous. */
  beginShell(holderId: string): void {
    const overlapping = this._shells.size > 0;
    for (const entry of this._shells.values()) entry.overlapped = true;
    this._shells.set(holderId, { overlapped: overlapping });
  }

  /**
   * The command ended. True when another holder's shell command ran at any point alongside it: the
   * files that changed meanwhile cannot be pinned on either one.
   */
  endShell(holderId: string): boolean {
    const entry = this._shells.get(holderId);
    this._shells.delete(holderId);
    return entry?.overlapped ?? false;
  }
}
