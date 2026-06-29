// Built-in container profile: PostgreSQL + pgvector.
//
// This is the recommended advanced backend (BLA-80): SQLite stays the local control
// plane while a local Postgres sidecar carries vector-heavy retrieval. The profile
// describes how to launch and health-check the container; the health parsing is pure
// so it can be unit-tested without a running daemon.

export interface ContainerProfile {
  /** Stable id used as the container name. */
  id: string;
  label: string;
  image: string;
  /** host:container port mappings. */
  ports: Array<{ host: number; container: number }>;
  env: Record<string, string>;
  /** Command the container should run as its in-container health probe. */
  healthCheck: string[];
  /** SQL run once after the container is healthy (e.g. enable the extension). */
  initSql: string[];
}

export const POSTGRES_PGVECTOR_PROFILE: ContainerProfile = {
  id: "blacksite-pgvector",
  label: "PostgreSQL + pgvector",
  image: "pgvector/pgvector:pg16",
  ports: [{ host: 54329, container: 5432 }],
  env: {
    POSTGRES_USER: "blacksite",
    POSTGRES_PASSWORD: "blacksite",
    POSTGRES_DB: "blacksite",
  },
  healthCheck: ["pg_isready", "-U", "blacksite", "-d", "blacksite"],
  initSql: [
    "CREATE EXTENSION IF NOT EXISTS vector;",
    "CREATE TABLE IF NOT EXISTS embeddings (id TEXT PRIMARY KEY, collection TEXT NOT NULL DEFAULT 'default', payload JSONB, vector vector);",
    "CREATE INDEX IF NOT EXISTS idx_embeddings_collection ON embeddings(collection);",
  ],
};

export function connectionStringFor(profile: ContainerProfile): string {
  const port = profile.ports[0]?.host ?? 5432;
  const user = profile.env.POSTGRES_USER ?? "postgres";
  const password = profile.env.POSTGRES_PASSWORD ?? "";
  const db = profile.env.POSTGRES_DB ?? "postgres";
  return `postgresql://${user}:${password}@127.0.0.1:${port}/${db}`;
}

export type SidecarHealth = "running" | "starting" | "unhealthy" | "stopped" | "missing";

export interface SidecarStatus {
  health: SidecarHealth;
  running: boolean;
  detail: string;
}

/**
 * Parse a `docker inspect`-style status into a normalized health value. Accepts the
 * common shapes the lifecycle commands emit so the UI can show one consistent state:
 *   - `docker inspect --format '{{.State.Status}}|{{.State.Health.Status}}'`
 *   - a JSON array from `docker inspect <name>`
 *   - empty / "no such object" when the container does not exist
 */
export function parseSidecarHealth(raw: string): SidecarStatus {
  const text = raw.trim();
  if (!text || /no such object|not found|error: no/i.test(text)) {
    return { health: "missing", running: false, detail: "Container does not exist." };
  }

  // Pipe-delimited format: "<state>|<health>"
  if (text.includes("|") && !text.startsWith("[") && !text.startsWith("{")) {
    const [state = "", healthRaw = ""] = text.split("|").map((s) => s.trim().toLowerCase());
    return interpret(state, healthRaw);
  }

  // JSON form from `docker inspect`.
  try {
    const parsed = JSON.parse(text) as unknown;
    const node = Array.isArray(parsed) ? parsed[0] : parsed;
    const state = (node as { State?: { Status?: string; Health?: { Status?: string } } })?.State;
    const status = (state?.Status ?? "").toLowerCase();
    const health = (state?.Health?.Status ?? "").toLowerCase();
    return interpret(status, health);
  } catch {
    // Fall back to a plain `docker ps` status string, e.g. "Up 3 seconds (healthy)".
    const lower = text.toLowerCase();
    if (/\(healthy\)/.test(lower)) return { health: "running", running: true, detail: text };
    if (/\(health: starting\)|starting/.test(lower)) return { health: "starting", running: true, detail: text };
    if (/\(unhealthy\)/.test(lower)) return { health: "unhealthy", running: true, detail: text };
    if (/^up\b/.test(lower)) return { health: "running", running: true, detail: text };
    if (/^exited|^created/.test(lower)) return { health: "stopped", running: false, detail: text };
    return { health: "unhealthy", running: false, detail: text };
  }
}

function interpret(state: string, health: string): SidecarStatus {
  if (state === "running") {
    if (health === "healthy" || health === "") return { health: "running", running: true, detail: `running${health ? " (healthy)" : ""}` };
    if (health === "starting") return { health: "starting", running: true, detail: "running (starting)" };
    return { health: "unhealthy", running: true, detail: `running (${health})` };
  }
  if (state === "created") return { health: "starting", running: false, detail: "created" };
  if (state === "exited" || state === "dead") return { health: "stopped", running: false, detail: state };
  return { health: "missing", running: false, detail: state || "unknown" };
}
