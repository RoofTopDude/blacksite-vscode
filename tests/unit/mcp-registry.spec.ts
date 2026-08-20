/* The registry is the gate between user configuration and the runtime. Two properties matter
   most and are asserted here rather than left to review:

     1. A credential-bearing descriptor is only ever produced for a server the user enabled,
        pointed somewhere safe, and supplied credentials for.
     2. Every descriptor carries the tool policy, because that is what makes a withheld tool
        unreachable rather than merely unadvertised. */

import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { McpRegistry, validateHttpTarget, type McpServerEntry } from "../../src/mcp-registry.js";

function createContext() {
  const workspace = new Map<string, unknown>();
  const global = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  return {
    context: {
      workspaceState: {
        get: <T>(key: string, fallback?: T): T | undefined => (workspace.has(key) ? workspace.get(key) as T : fallback),
        update: async (key: string, value: unknown): Promise<void> => { workspace.set(key, value); },
      },
      globalState: {
        get: <T>(key: string, fallback?: T): T | undefined => (global.has(key) ? global.get(key) as T : fallback),
        update: async (key: string, value: unknown): Promise<void> => { global.set(key, value); },
      },
      secrets: {
        get: async (key: string): Promise<string | undefined> => secrets.get(key),
        store: async (key: string, value: string): Promise<void> => { secrets.set(key, value); },
        delete: async (key: string): Promise<void> => { secrets.delete(key); },
      },
    } as unknown as vscode.ExtensionContext,
    stores: { workspace, global, secrets },
  };
}

function makeRegistry() {
  const { context, stores } = createContext();
  return { registry: new McpRegistry(context, () => ["C:/workspace"]), stores };
}

beforeEach(() => {
  (vscode.workspace as unknown as { __clearConfig(): void }).__clearConfig();
});

describe("target validation", () => {
  it("allows HTTPS, and plain HTTP only on loopback", () => {
    expect(validateHttpTarget("https://api.example.com/mcp").ok).toBe(true);
    expect(validateHttpTarget("http://localhost:3000/mcp").ok).toBe(true);
    expect(validateHttpTarget("http://127.0.0.1:3000/mcp").ok).toBe(true);
  });

  it("refuses cleartext to a remote host, which would hand the bearer token to the network", () => {
    const result = validateHttpTarget("http://api.example.com/mcp");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/HTTPS/);
  });

  it("refuses a URL with embedded credentials", () => {
    expect(validateHttpTarget("https://user:pass@api.example.com/mcp").ok).toBe(false);
  });

  it("refuses a target that is not a URL at all", () => {
    expect(validateHttpTarget("not a url").ok).toBe(false);
  });
});

describe("entry sources", () => {
  it("reads application-level settings but never repository-level ones", async () => {
    // A repo-controlled .vscode/settings.json must not be able to register a process for the
    // extension to launch, so only globalValue is honoured.
    const { registry } = makeRegistry();
    (vscode.workspace as unknown as { __setGlobalConfig(k: string, v: unknown): void })
      .__setGlobalConfig("blacksite.mcpServers", [{ id: "global-1", name: "Global", transport: "http", url: "https://a.example/mcp", enabled: true }]);
    (vscode.workspace as unknown as { __setConfig(k: string, v: unknown): void })
      .__setConfig("blacksite.mcpServers", [{ id: "repo-1", name: "Repo", transport: "stdio", command: "rm -rf /", enabled: true }]);

    const ids = registry.listEntries().map((entry) => entry.id);
    expect(ids).toContain("global-1");
    expect(ids).not.toContain("repo-1");
  });

  it("lets a workspace-state entry win over a settings entry with the same id", async () => {
    const { registry } = makeRegistry();
    (vscode.workspace as unknown as { __setGlobalConfig(k: string, v: unknown): void })
      .__setGlobalConfig("blacksite.mcpServers", [{ id: "dup", name: "From settings", transport: "http", url: "https://a.example/mcp", enabled: true }]);
    await registry.addEntry({ id: "dup", name: "From panel", transport: "http", url: "https://b.example/mcp", enabled: true });
    expect(registry.getEntry("dup")?.name).toBe("From panel");
  });

  it("edits a settings-declared server by copying it into workspace state", async () => {
    const { registry } = makeRegistry();
    (vscode.workspace as unknown as { __setGlobalConfig(k: string, v: unknown): void })
      .__setGlobalConfig("blacksite.mcpServers", [{ id: "s1", name: "Server", transport: "http", url: "https://a.example/mcp", enabled: true }]);
    await registry.updateEntry("s1", { enabled: false });
    expect(registry.getEntry("s1")?.enabled).toBe(false);
    expect(registry.getEntry("s1")?.url).toBe("https://a.example/mcp");
  });
});

describe("tool policy", () => {
  async function withInventory() {
    const { registry } = makeRegistry();
    const entry = await registry.addEntry({ name: "Files", transport: "http", url: "https://a.example/mcp", enabled: true });
    await registry.setCache(entry.id, {
      fetchedAt: new Date().toISOString(),
      tools: [{ name: "read_file" }, { name: "write_file" }, { name: "delete_file" }],
    });
    return { registry, id: entry.id };
  }

  it("admits every tool until the user says otherwise", async () => {
    const { registry, id } = await withInventory();
    expect(registry.enabledToolNames(id)).toEqual(["read_file", "write_file", "delete_file"]);
  });

  it("withholds a single tool without touching the rest", async () => {
    const { registry, id } = await withInventory();
    await registry.setToolEnabled(id, "delete_file", false);
    expect(registry.enabledToolNames(id)).toEqual(["read_file", "write_file"]);
    expect(registry.policyFor(id).deny).toEqual(["delete_file"]);
  });

  it("marks a fallback verdict as implicit so the panel can distinguish it from a choice", async () => {
    const { registry, id } = await withInventory();
    await registry.setToolEnabled(id, "read_file", true);
    const views = registry.toolViews(id);
    expect(views.find((tool) => tool.name === "read_file")?.implicit).toBe(false);
    expect(views.find((tool) => tool.name === "write_file")?.implicit).toBe(true);
  });

  it("makes 'disable all' keep holding when the server later grows a tool", async () => {
    const { registry, id } = await withInventory();
    await registry.setAllTools(id, false);
    expect(registry.policyFor(id).fallback).toBe("deny");
    // A tool nobody has reviewed arrives on the next discovery.
    await registry.setCache(id, {
      fetchedAt: new Date().toISOString(),
      tools: [{ name: "read_file" }, { name: "write_file" }, { name: "delete_file" }, { name: "brand_new" }],
    });
    expect(registry.enabledToolNames(id)).toEqual([]);
  });

  it("admits a newly discovered tool under the default fallback", async () => {
    const { registry, id } = await withInventory();
    await registry.setToolEnabled(id, "delete_file", false);
    await registry.setCache(id, {
      fetchedAt: new Date().toISOString(),
      tools: [{ name: "read_file" }, { name: "delete_file" }, { name: "brand_new" }],
    });
    expect(registry.enabledToolNames(id)).toContain("brand_new");
    expect(registry.enabledToolNames(id)).not.toContain("delete_file");
  });

  it("stamps the policy onto every descriptor handed to the runtime", async () => {
    // This is what makes a withheld tool unreachable rather than merely unlisted: the same
    // policy is enforced on tools/call, so a remembered name still fails.
    const { registry, id } = await withInventory();
    await registry.setToolEnabled(id, "delete_file", false);
    const resolved = await registry.resolveForAgent(id);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.server.toolPolicy?.deny).toContain("delete_file");
  });

  it("leaves the panel's own resolution unfiltered so the user can see everything", async () => {
    const { registry, id } = await withInventory();
    await registry.setToolEnabled(id, "delete_file", false);
    const resolved = await registry.resolveForPanel(id);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.server.toolPolicy).toBeUndefined();
  });
});

describe("resolution", () => {
  it("refuses an unknown, disabled, or cleartext server, each with its own reason", async () => {
    const { registry } = makeRegistry();
    expect(await registry.resolveForAgent("nope")).toMatchObject({ ok: false, reason: "unknown" });

    const disabled = await registry.addEntry({ name: "Off", transport: "http", url: "https://a.example/mcp", enabled: false });
    expect(await registry.resolveForAgent(disabled.id)).toMatchObject({ ok: false, reason: "disabled" });

    const cleartext = await registry.addEntry({ name: "Plain", transport: "http", url: "http://api.example.com/mcp", enabled: true });
    expect(await registry.resolveForAgent(cleartext.id)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("reports auth_required rather than silently contacting a server unauthenticated", async () => {
    const { registry } = makeRegistry();
    const entry = await registry.addEntry({
      name: "Guarded", transport: "http", url: "https://a.example/mcp", enabled: true,
      auth: { mode: "bearer" },
    });
    const resolved = await registry.resolveForAgent(entry.id);
    expect(resolved).toMatchObject({ ok: false, reason: "auth_required" });
  });

  it("attaches a stored bearer token as an Authorization header", async () => {
    const { registry } = makeRegistry();
    const entry = await registry.addEntry({
      name: "Guarded", transport: "http", url: "https://a.example/mcp", enabled: true,
      auth: { mode: "bearer" },
    });
    await registry.setStaticSecret(entry.id, "tok-abc");
    const resolved = await registry.resolveForAgent(entry.id);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.server.apiKey).toBe("tok-abc");
  });

  it("places a custom-header credential in the header the user named", async () => {
    const { registry } = makeRegistry();
    const entry = await registry.addEntry({
      name: "Keyed", transport: "http", url: "https://a.example/mcp", enabled: true,
      auth: { mode: "header", headerName: "X-API-Key" },
    });
    await registry.setStaticSecret(entry.id, "key-1");
    const resolved = await registry.resolveForAgent(entry.id);
    if (!resolved.ok) throw new Error("expected resolution");
    expect(resolved.server.headers?.["X-API-Key"]).toBe("key-1");
    expect(resolved.server.apiKey).toBeUndefined();
  });

  it("keeps credentials out of settings and workspace state entirely", async () => {
    const { registry, stores } = makeRegistry();
    const entry = await registry.addEntry({
      name: "Guarded", transport: "http", url: "https://a.example/mcp", enabled: true,
      auth: { mode: "bearer" },
    });
    await registry.setStaticSecret(entry.id, "super-secret-value");
    expect(JSON.stringify([...stores.workspace.values()])).not.toContain("super-secret-value");
    expect(JSON.stringify([...stores.global.values()])).not.toContain("super-secret-value");
    expect([...stores.secrets.values()]).toContain("super-secret-value");
  });

  it("resolves secret env vars for a stdio server, and omits ones not yet filled in", async () => {
    // An empty string reads to most servers as a *present* but invalid credential, which
    // fails far more confusingly than an unset variable.
    const { registry } = makeRegistry();
    const entry = await registry.addEntry({
      name: "Local", transport: "stdio", command: "npx -y server", enabled: true,
      env: [{ name: "API_KEY", secret: true }, { name: "REGION", value: "us-east-1" }, { name: "EMPTY", value: "" }],
    });
    await registry.setEnvSecret(entry.id, "API_KEY", "sk-live");
    const resolved = await registry.resolveForAgent(entry.id);
    if (!resolved.ok) throw new Error("expected resolution");
    expect(resolved.server.env).toEqual({ API_KEY: "sk-live", REGION: "us-east-1" });
    expect(resolved.server.transport).toBe("stdio");
  });

  it("passes the workspace roots a server may ask for", async () => {
    const { registry } = makeRegistry();
    const entry = await registry.addEntry({ name: "Local", transport: "stdio", command: "npx -y server", enabled: true });
    const resolved = await registry.resolveForAgent(entry.id);
    if (!resolved.ok) throw new Error("expected resolution");
    expect(resolved.server.roots).toEqual(["C:/workspace"]);
  });
});

describe("credential lifecycle", () => {
  it("reports whether the credential a server's mode calls for is present", async () => {
    const { registry } = makeRegistry();
    const open = await registry.addEntry({ name: "Open", transport: "http", url: "https://a.example/mcp", enabled: true });
    expect(await registry.credentialStatus(open.id)).toBe("none");

    const guarded = await registry.addEntry({
      name: "Guarded", transport: "http", url: "https://b.example/mcp", enabled: true, auth: { mode: "bearer" },
    });
    expect(await registry.credentialStatus(guarded.id)).toBe("missing");
    await registry.setStaticSecret(guarded.id, "tok");
    expect(await registry.credentialStatus(guarded.id)).toBe("configured");
  });

  it("clears every credential a server owns on sign-out", async () => {
    const { registry, stores } = makeRegistry();
    const entry = await registry.addEntry({
      name: "Guarded", transport: "stdio", command: "npx server", enabled: true,
      auth: { mode: "oauth" }, env: [{ name: "TOKEN", secret: true }],
    });
    await registry.setStaticSecret(entry.id, "static");
    await registry.setEnvSecret(entry.id, "TOKEN", "env-secret");
    await registry.writeTokens(entry.id, { accessToken: "at", tokenType: "Bearer" });
    await registry.writeClient(entry.id, { clientId: "cid", issuer: "https://i.example", redirectUri: "http://127.0.0.1:1/callback", registeredAt: 0 });

    await registry.clearCredentials(entry.id);
    expect(stores.secrets.size).toBe(0);
  });

  it("removes policy, cache, and credentials along with the entry", async () => {
    const { registry, stores } = makeRegistry();
    const entry = await registry.addEntry({
      name: "Guarded", transport: "http", url: "https://a.example/mcp", enabled: true, auth: { mode: "bearer" },
    });
    await registry.setStaticSecret(entry.id, "tok");
    await registry.setCache(entry.id, { fetchedAt: new Date().toISOString(), tools: [{ name: "t" }] });
    await registry.setToolEnabled(entry.id, "t", false);

    await registry.removeEntry(entry.id);
    expect(registry.getEntry(entry.id)).toBeUndefined();
    expect(registry.cacheEntry(entry.id)).toBeUndefined();
    expect(registry.policyRecord(entry.id).tools).toEqual({});
    expect(stores.secrets.size).toBe(0);
  });

  it("round-trips an OAuth token set through SecretStorage", async () => {
    const { registry } = makeRegistry();
    const tokens = { accessToken: "at", refreshToken: "rt", tokenType: "Bearer", expiresAt: Date.now() + 60_000 };
    await registry.writeTokens("s1", tokens);
    expect(await registry.readTokens("s1")).toEqual(tokens);
    await registry.clearTokens("s1");
    expect(await registry.readTokens("s1")).toBeUndefined();
  });

  it("keeps one server's secrets out of another's, even for ids that differ only in punctuation", async () => {
    const { registry } = makeRegistry();
    await registry.setStaticSecret("a.b", "first");
    await registry.setStaticSecret("a%2Eb", "second");
    expect(await registry.getStaticSecret("a.b")).toBe("first");
    expect(await registry.getStaticSecret("a%2Eb")).toBe("second");
  });
});

describe("entry normalization", () => {
  it("ignores malformed settings entries instead of failing the whole list", () => {
    const { registry } = makeRegistry();
    (vscode.workspace as unknown as { __setGlobalConfig(k: string, v: unknown): void })
      .__setGlobalConfig("blacksite.mcpServers", [
        null,
        "a string",
        { name: "no id" },
        { id: "good", name: "Good", transport: "http", url: "https://a.example/mcp", enabled: true },
      ]);
    const entries: McpServerEntry[] = registry.listEntries();
    expect(entries.map((entry) => entry.id)).toEqual(["good"]);
  });

  it("treats a missing enabled flag as enabled, matching how the panel writes entries", () => {
    const { registry } = makeRegistry();
    (vscode.workspace as unknown as { __setGlobalConfig(k: string, v: unknown): void })
      .__setGlobalConfig("blacksite.mcpServers", [{ id: "x", name: "X", transport: "http", url: "https://a.example/mcp" }]);
    expect(registry.getEntry("x")?.enabled).toBe(true);
  });
});

describe("failure messages", () => {
  it("tells the agent what a person must do, and the panel what to press", async () => {
    // The panel's reader is already standing in the place the agent's message sends them.
    const { registry } = makeRegistry();
    const entry = await registry.addEntry({
      name: "Guarded", transport: "http", url: "https://a.example/mcp", enabled: true,
      auth: { mode: "oauth" },
    });

    const forAgent = await registry.resolveForAgent(entry.id);
    const forPanel = await registry.resolveForPanel(entry.id);
    expect(forAgent.ok).toBe(false);
    expect(forPanel.ok).toBe(false);
    if (forAgent.ok || forPanel.ok) return;
    expect(forAgent.message).toContain("Manage MCP Servers");
    expect(forPanel.message).toContain("Sign in");
    expect(forPanel.message).not.toContain("Manage MCP Servers");
  });

  it("lets the panel resolve a disabled server so its tools can be reviewed before switching it on", async () => {
    const { registry } = makeRegistry();
    const entry = await registry.addEntry({ name: "Off", transport: "http", url: "https://a.example/mcp", enabled: false });
    expect((await registry.resolveForPanel(entry.id)).ok).toBe(true);
    expect((await registry.resolveForAgent(entry.id)).ok).toBe(false);
  });
});
