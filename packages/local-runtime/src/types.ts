import type { McpToolPolicy } from "./mcp-protocol.js";

export type OperationTier = "read" | "write" | "network" | "destructive";

export interface OperationClassification {
  tier: OperationTier;
}

export interface ConfirmationRequired {
  ok: true;
  requiresConfirmation: true;
  tier: OperationTier;
  description: string;
  /**
   * True when the command binary itself is unrecognized (not on the built-in or
   * configured allowlist, and not explicitly denied) — confirmation is forced for
   * this reason regardless of what the tier guess would otherwise imply.
   */
  unrecognizedCommand?: boolean;
}

export type LocalRuntimeResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string }
  | ConfirmationRequired;

// ── Shell ─────────────────────────────────────────────────────────────────────

export interface ShellPayload {
  command: string;
  args?: string[];
  cwd?: string;
  confirmed?: boolean;
  timeout?: number;
  allowedBinaries?: string[];
}

export interface ShellResult {
  ok: true;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  tier: OperationTier;
  cwd: string;
}

// ── Long-running processes ────────────────────────────────────────────────────

export interface ProcessOutputEntry {
  cursor: number;
  stream: "stdout" | "stderr";
  text: string;
  timestamp: string;
}

export interface ProcessSummary {
  handleId: string;
  command: string;
  args: string[];
  cwd: string;
  displayCommand: string;
  status: "running" | "completed" | "failed" | "cancelled";
  exitCode: number | null;
  startedAt: string;
  finishedAt?: string;
  allowStdin: boolean;
  cancelled: boolean;
}

export interface ProcessOutputPage {
  availableFrom: number;
  entries: ProcessOutputEntry[];
  nextCursor: number;
  truncated: boolean;
}

// ── File ops ──────────────────────────────────────────────────────────────────

export interface DirectoryEntry {
  name: string;
  type: "file" | "directory" | "symlink";
  sizeBytes: number | null;
  modifiedAt: string | null;
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
  /** Lines immediately before the match, when contextLines > 0. */
  before?: string[];
  /** Lines immediately after the match, when contextLines > 0. */
  after?: string[];
}

// ── Git ───────────────────────────────────────────────────────────────────────

export interface GitFileChange {
  path: string;
  status: string;
}

export interface GitStatusData {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
  success: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  refs: string;
  message: string;
}

export interface GitDiffFile {
  path: string;
  additions: number;
  deletions: number;
  hunks: string[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string;
  remote: boolean;
}

// ── MCP ───────────────────────────────────────────────────────────────────────

/**
 * A fully resolved MCP destination.
 *
 * Assembled on the host from the user's configuration plus whatever credential the auth
 * layer just produced, and handed to the runtime per call. The model never constructs one and
 * never sees one: the `mcp_*` tool schemas carry only a `serverId`, which is the whole reason
 * a token or a tool policy can safely live on this object.
 */
export interface McpServer {
  /** HTTPS endpoint for a remote server, or the command line for a local stdio server. */
  url: string;
  /** Stable identity for connection pooling. Without it connections are pooled by target,
   *  so two entries pointing at one URL with different credentials would collide. */
  id?: string;
  /** "auto" probes Streamable HTTP and falls back to the legacy HTTP+SSE pair. The explicit
   *  values are an escape hatch for servers that misreport which one they speak. */
  transport?: "auto" | "http" | "sse" | "stdio";
  /** Bearer token — an OAuth access token or a user-supplied static token. */
  apiKey?: string;
  /** Static headers, including any non-Bearer credential header the user configured. */
  headers?: Record<string, string>;
  /** Extra environment for stdio servers, layered over the inherited environment. This is
   *  how most local servers take their credentials. */
  env?: Record<string, string>;
  /** Working directory for stdio servers. */
  cwd?: string;
  /** Workspace directories reported to the server when it asks for `roots/list`. */
  roots?: string[];
  /** Per-request timeout override in milliseconds. */
  timeoutMs?: number;
  /** Which of this server's tools the agent may see and call. Absent means all of them. */
  toolPolicy?: McpToolPolicy;
}

export type { McpToolPolicy };
