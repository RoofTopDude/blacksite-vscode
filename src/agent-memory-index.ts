import type { VectorStore } from "./vector-store.js";
import type { EmbeddingService } from "./embedding-service.js";

// ── Collection namespaces ──────────────────────────────────────────────────────

const COL_TOOL   = "tc";  // indexed tool calls
const COL_CHUNK  = "ch";  // compressed transcript chunks
const COL_MEMORY = "mm";  // agent-written memory notes

// ── Similarity config ──────────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.70;
const SIMILARITY_TIMEOUT_MS = 1_800;

// Tools that benefit from past-call similarity lookup.
// Excludes read-only lookup tools (file_read, file_list) to avoid noise.
const SIMILARITY_TOOLS = new Set([
  "file_edit", "file_edit_batch", "file_write", "file_delete", "file_move",
  "shell_run", "process_start",
  "git_op", "worktree_op",
  "code_rename", "code_actions", "code_format",
  "plan_create", "plan_update", "todo_create", "todo_update",
]);

// ── Public types ───────────────────────────────────────────────────────────────

export interface SimilarCall {
  toolName: string;
  inputSummary: string;
  resultSummary: string;
  sessionId: string;
  turnIndex: number;
  score: number;
}

export interface TranscriptChunk {
  sessionId: string;
  chunkIndex: number;
  summary: string;
  ref: string;
  score: number;
}

export interface MemoryResult {
  text: string;
  score: number;
}

export interface MemoryStats {
  toolCalls: number;
  chunks: number;
  memories: number;
  total: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMsg = { role: string; content: string | any[] };

// ── AgentMemoryIndex ───────────────────────────────────────────────────────────

/**
 * Semantic memory index backed by a VectorStore.
 *
 * Tracks three collections:
 * - Tool calls (tc): indexed call+result pairs; queried during execution to inject
 *   "related past actions" into tool results, inducing cross-session stability.
 * - Transcript chunks (ch): compressed conversation fragments with refs; enables
 *   the agent to semantically query old history instead of relying on a flat summary.
 * - Memory notes (mm): agent-written facts indexed for semantic recall.
 */
export class AgentMemoryIndex {
  private ready = false;

  constructor(
    private readonly store: VectorStore,
    private readonly embedding: EmbeddingService,
  ) {}

  init(): void {
    this.store.load();
    this.ready = true;
  }

  // ── Tool call indexing ───────────────────────────────────────────────────────

  /** Index a completed tool call. Fire-and-forget; errors are non-fatal. */
  async indexToolCall(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    result: unknown,
    turnIndex: number,
  ): Promise<void> {
    if (!this.ready || !SIMILARITY_TOOLS.has(toolName)) return;
    const text = `${toolName} ${shortInput(toolName, input)} → ${shortResult(result)}`;
    try {
      const vec = await this.embedding.embed(text);
      const id = `${COL_TOOL}:${sessionId}:t${turnIndex}`;
      this.store.upsert(id, vec, {
        _col: COL_TOOL,
        sessionId,
        toolName,
        inputSummary: shortInput(toolName, input),
        resultSummary: shortResult(result),
        turnIndex,
      });
    } catch { /* non-fatal */ }
  }

  /** Query similar past tool calls from OTHER sessions (cross-session memory). */
  async similarToolCalls(
    toolName: string,
    input: Record<string, unknown>,
    currentSessionId: string,
    topK = 3,
  ): Promise<SimilarCall[]> {
    if (!this.ready || !SIMILARITY_TOOLS.has(toolName)) return [];
    const text = `${toolName} ${shortInput(toolName, input)}`;
    try {
      const vec = await withTimeout(this.embedding.embed(text), SIMILARITY_TIMEOUT_MS, null);
      if (!vec) return [];
      return this.store
        .search(vec, topK + 2, (p) => p["_col"] === COL_TOOL && p["sessionId"] !== currentSessionId)
        .filter((r) => r.score >= SIMILARITY_THRESHOLD)
        .slice(0, topK)
        .map((r) => ({
          toolName:     String(r.payload["toolName"] ?? ""),
          inputSummary: String(r.payload["inputSummary"] ?? ""),
          resultSummary: String(r.payload["resultSummary"] ?? ""),
          sessionId:    String(r.payload["sessionId"] ?? ""),
          turnIndex:    Number(r.payload["turnIndex"] ?? 0),
          score:        r.score,
        }));
    } catch { return []; }
  }

  // ── Transcript chunk indexing ────────────────────────────────────────────────

  /**
   * Index a batch of compressed messages as a searchable transcript chunk.
   * Returns a short ref string the agent can use with memory_search.
   */
  async indexTranscriptChunk(
    sessionId: string,
    messages: AnyMsg[],
    chunkIndex: number,
    summary: string,
  ): Promise<string> {
    const ref = `${sessionId.slice(-8)}:c${chunkIndex}`;
    if (!this.ready) return ref;
    const searchText = `${summary} ${messagesToText(messages)}`.slice(0, 4_000);
    try {
      const vec = await withTimeout(this.embedding.embed(searchText), SIMILARITY_TIMEOUT_MS, null);
      if (vec) {
        this.store.upsert(`${COL_CHUNK}:${ref}`, vec, {
          _col: COL_CHUNK,
          sessionId,
          chunkIndex,
          summary: summary.slice(0, 500),
          ref,
        });
      }
    } catch { /* non-fatal */ }
    return ref;
  }

  /** Semantic search over compressed transcript chunks. */
  async searchTranscript(query: string, topK = 5): Promise<TranscriptChunk[]> {
    if (!this.ready) return [];
    try {
      const vec = await withTimeout(this.embedding.embed(query), SIMILARITY_TIMEOUT_MS, null);
      if (!vec) return [];
      return this.store
        .search(vec, topK, (p) => p["_col"] === COL_CHUNK)
        .map((r) => ({
          sessionId:  String(r.payload["sessionId"] ?? ""),
          chunkIndex: Number(r.payload["chunkIndex"] ?? 0),
          summary:    String(r.payload["summary"] ?? ""),
          ref:        String(r.payload["ref"] ?? ""),
          score:      r.score,
        }));
    } catch { return []; }
  }

  // ── Memory note indexing ─────────────────────────────────────────────────────

  /** Index an agent-written memory note for semantic retrieval. */
  async indexMemory(note: string, id?: string): Promise<void> {
    if (!this.ready) return;
    try {
      const vec = await this.embedding.embed(note);
      this.store.upsert(id ?? `${COL_MEMORY}:${Date.now()}`, vec, {
        _col: COL_MEMORY,
        text: note.slice(0, 1_000),
      });
    } catch { /* non-fatal */ }
  }

  /** Semantic search over indexed memory notes. */
  async searchMemories(query: string, topK = 5): Promise<MemoryResult[]> {
    if (!this.ready) return [];
    try {
      const vec = await withTimeout(this.embedding.embed(query), SIMILARITY_TIMEOUT_MS, null);
      if (!vec) return [];
      return this.store
        .search(vec, topK, (p) => p["_col"] === COL_MEMORY)
        .map((r) => ({ text: String(r.payload["text"] ?? ""), score: r.score }));
    } catch { return []; }
  }

  // ── Unified semantic search ──────────────────────────────────────────────────

  /** Search across one or more collections at once. */
  async semanticSearch(
    query: string,
    collections: ("tool_calls" | "transcript" | "memories")[] = ["tool_calls", "transcript", "memories"],
    topK = 5,
  ): Promise<Array<{ collection: string; content: string; ref: string; score: number }>> {
    if (!this.ready) return [];
    try {
      const vec = await withTimeout(this.embedding.embed(query), SIMILARITY_TIMEOUT_MS, null);
      if (!vec) return [];

      const colMap: Record<string, string> = {
        tool_calls: COL_TOOL,
        transcript: COL_CHUNK,
        memories:   COL_MEMORY,
      };
      const active = new Set(collections.map((c) => colMap[c]).filter(Boolean));
      if (!active.size) return [];

      return this.store
        .search(vec, topK * collections.length, (p) => active.has(String(p["_col"] ?? "")))
        .slice(0, topK)
        .map((r) => {
          const col = String(r.payload["_col"] ?? "");
          const colName = col === COL_TOOL ? "tool_calls" : col === COL_CHUNK ? "transcript" : "memories";
          let content = "";
          let ref = "";
          if (col === COL_TOOL) {
            content = `${r.payload["toolName"]} ${r.payload["inputSummary"]} → ${r.payload["resultSummary"]}`;
            ref = `${String(r.payload["sessionId"] ?? "").slice(-8)}:t${r.payload["turnIndex"]}`;
          } else if (col === COL_CHUNK) {
            content = String(r.payload["summary"] ?? "");
            ref = String(r.payload["ref"] ?? "");
          } else {
            content = String(r.payload["text"] ?? "");
            ref = r.id;
          }
          return { collection: colName, content, ref, score: r.score };
        });
    } catch { return []; }
  }

  // ── Stats ────────────────────────────────────────────────────────────────────

  get stats(): MemoryStats {
    const toolCalls = this.store.collectionSize(COL_TOOL);
    const chunks    = this.store.collectionSize(COL_CHUNK);
    const memories  = this.store.collectionSize(COL_MEMORY);
    return { toolCalls, chunks, memories, total: toolCalls + chunks + memories };
  }

  dispose(): void {
    this.store.dispose();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function shortInput(_toolName: string, input: Record<string, unknown>): string {
  const parts: string[] = [];
  if (input.path)      parts.push(String(input.path).slice(-50));
  if (input.command)   parts.push(String(input.command).slice(0, 60));
  if (input.pattern)   parts.push(String(input.pattern).slice(0, 40));
  if (input.op)        parts.push(String(input.op));
  if (input.branch)    parts.push(String(input.branch));
  if (input.oldString) parts.push(String(input.oldString).slice(0, 60));
  return (parts.join(" ").trim() || JSON.stringify({ ...input, newString: undefined }).slice(0, 80))
    .replace(/\s+/g, " ");
}

function shortResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "").slice(0, 80);
  const r = result as Record<string, unknown>;
  if (typeof r.error === "string")   return `ERR: ${r.error.slice(0, 80)}`;
  if (typeof r.content === "string") return r.content.slice(0, 100);
  if (typeof r.path === "string")    return r.path;
  if (typeof r.exitCode === "number") return `exit ${r.exitCode}`;
  return JSON.stringify(result).slice(0, 100);
}

function messagesToText(messages: AnyMsg[]): string {
  return messages.map((m) => {
    if (typeof m.content === "string") return m.content.slice(0, 200);
    if (!Array.isArray(m.content)) return "";
    return (m.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => (b.text ?? "").slice(0, 100))
      .join(" ");
  }).join(" ").slice(0, 2_000);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}
