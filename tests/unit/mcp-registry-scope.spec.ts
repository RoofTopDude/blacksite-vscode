/* Where MCP servers live, and what that means for the next project the user opens.

   Servers used to be added to workspace state only, so one set up in project A did not exist in
   project B. Now a server can be in every project (user settings) or this project only
   (workspace state), and moves between the two keeping its credentials and tool choices. */

import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { McpRegistry } from "../../src/mcp-registry.js";

type MockWorkspace = {
  __setGlobalConfig(key: string, value: unknown): void;
  __clearConfig(): void;
};
const mock = vscode.workspace as unknown as MockWorkspace;

/** One extension context per "window": global state and secrets are shared across projects,
 *  workspace state is per project — the same split VS Code makes. */
function machine() {
  const global = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const store = (map: Map<string, unknown>) => ({
    get: <T>(key: string, fallback?: T): T | undefined => (map.has(key) ? map.get(key) as T : fallback),
    update: async (key: string, value: unknown): Promise<void> => { map.set(key, value); },
  });
  return (root: string) => {
    const workspace = new Map<string, unknown>();
    const context = {
      workspaceState: store(workspace),
      globalState: store(global),
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => { secrets.set(key, value); },
        delete: async (key: string) => { secrets.delete(key); },
      },
    } as unknown as vscode.ExtensionContext;
    return { registry: new McpRegistry(context, () => [root]), workspace, secrets };
  };
}

beforeEach(() => mock.__clearConfig());

describe("scope", () => {
  it("makes a server added for all projects appear in another project", async () => {
    const open = machine();
    const projectA = open("/a");
    const added = await projectA.registry.addEntry({ name: "GitHub", transport: "stdio", command: "npx", args: ["-y", "srv"], enabled: true }, "user");
    expect(added.scope).toBe("user");

    const projectB = open("/b");
    expect(projectB.registry.getEntry(added.id)).toMatchObject({ name: "GitHub", scope: "user", command: "npx", args: ["-y", "srv"] });
  });

  it("keeps a project-only server out of other projects", async () => {
    const open = machine();
    const added = await open("/a").registry.addEntry({ name: "Local", transport: "stdio", command: "srv", enabled: true }, "workspace");
    expect(open("/b").registry.getEntry(added.id)).toBeUndefined();
  });

  it("shares a project server with every project, credentials and tool choices included", async () => {
    const open = machine();
    const projectA = open("/a");
    const added = await projectA.registry.addEntry({ name: "Remote", transport: "http", url: "https://mcp.example/mcp", enabled: true, auth: { mode: "bearer" } }, "workspace");
    await projectA.registry.setStaticSecret(added.id, "tok");
    await projectA.registry.setToolEnabled(added.id, "dangerous", false);

    await projectA.registry.setScope(added.id, "user");
    expect(projectA.registry.getEntry(added.id)?.scope).toBe("user");
    expect(projectA.workspace.get("blacksite.mcpServers")).toEqual([]);

    const projectB = open("/b");
    expect(projectB.registry.getEntry(added.id)?.scope).toBe("user");
    expect(await projectB.registry.getStaticSecret(added.id)).toBe("tok");
    expect(projectB.registry.policyFor(added.id).deny).toEqual(["dangerous"]);
    const resolved = await projectB.registry.resolveForAgent(added.id);
    expect(resolved.ok && resolved.server.apiKey).toBe("tok");
  });

  it("moves an all-projects server back to this project only", async () => {
    const open = machine();
    const projectA = open("/a");
    const added = await projectA.registry.addEntry({ name: "S", transport: "stdio", command: "srv", enabled: true }, "user");
    await projectA.registry.setScope(added.id, "workspace");
    expect(projectA.registry.getEntry(added.id)?.scope).toBe("workspace");
    expect(open("/b").registry.getEntry(added.id)).toBeUndefined();
  });

  it("edits an all-projects server in place, for every project", async () => {
    const open = machine();
    const projectA = open("/a");
    mock.__setGlobalConfig("blacksite.mcpServers", [{ id: "s1", name: "Server", transport: "http", url: "https://a.example/mcp", enabled: true }]);
    await projectA.registry.updateEntry("s1", { enabled: false });
    expect(open("/b").registry.getEntry("s1")).toMatchObject({ enabled: false, scope: "user", url: "https://a.example/mcp" });
  });

  it("keeps hand-written entries it cannot parse when it rewrites user settings", async () => {
    const open = machine();
    mock.__setGlobalConfig("blacksite.mcpServers", [{ name: "no id, hand-written" }, { id: "s1", name: "Server", transport: "http", url: "https://a.example/mcp" }]);
    await open("/a").registry.updateEntry("s1", { name: "Renamed" });
    const written = vscode.workspace.getConfiguration("blacksite").inspect<unknown[]>("mcpServers")?.globalValue;
    expect(written?.[0]).toEqual({ name: "no id, hand-written" });
    expect(written?.[1]).toMatchObject({ id: "s1", name: "Renamed" });
  });

  it("hides an all-projects server in one project without removing it elsewhere", async () => {
    const open = machine();
    const projectA = open("/a");
    const added = await projectA.registry.addEntry({ name: "S", transport: "stdio", command: "srv", enabled: true, env: [{ name: "TOKEN", secret: true }] }, "user");
    await projectA.registry.setEnvSecret(added.id, "TOKEN", "secret");
    await projectA.registry.removeEntry(added.id, { hereOnly: true });
    expect(projectA.registry.getEntry(added.id)).toBeUndefined();
    const projectB = open("/b");
    expect(projectB.registry.getEntry(added.id)).toBeDefined();
    expect(await projectB.registry.getEnvSecret(added.id, "TOKEN")).toBe("secret");
  });

  it("removes an all-projects server everywhere, credentials too", async () => {
    const open = machine();
    const projectA = open("/a");
    const added = await projectA.registry.addEntry({ name: "S", transport: "http", url: "https://a.example/mcp", enabled: true, auth: { mode: "bearer" } }, "user");
    await projectA.registry.setStaticSecret(added.id, "tok");
    await projectA.registry.removeEntry(added.id);
    const projectB = open("/b");
    expect(projectB.registry.getEntry(added.id)).toBeUndefined();
    expect(await projectB.registry.getStaticSecret(added.id)).toBeUndefined();
  });
});

describe("resolution of a README-style server", () => {
  it("launches the command with its arguments, working directory and environment", async () => {
    const { registry } = machine()("/work");
    process.env["BLACKSITE_TEST_HOME"] = "/home/tester";
    mock.__setGlobalConfig("blacksite.mcpServers", [{
      id: "gh", name: "GitHub", command: "npx", args: ["-y", "@modelcontextprotocol/server-github", "${workspaceFolder}"],
      cwd: "${env:BLACKSITE_TEST_HOME}/tools", env: { GITHUB_TOKEN: "abc", HOME_COPY: "${BLACKSITE_TEST_HOME}" },
    }]);
    const resolved = await registry.resolveForAgent("gh");
    if (!resolved.ok) throw new Error(resolved.message);
    expect(resolved.server).toMatchObject({
      url: "npx",
      transport: "stdio",
      args: ["-y", "@modelcontextprotocol/server-github", "/work"],
      cwd: "/home/tester/tools",
      env: { GITHUB_TOKEN: "abc", HOME_COPY: "/home/tester" },
      label: "GitHub",
    });
    delete process.env["BLACKSITE_TEST_HOME"];
  });
});

describe("always allow", () => {
  async function withTools() {
    const { registry } = machine()("/w");
    const entry = await registry.addEntry({ name: "S", transport: "http", url: "https://a.example/mcp", enabled: true });
    await registry.setCache(entry.id, {
      fetchedAt: new Date().toISOString(),
      tools: [
        { name: "search", annotations: { readOnlyHint: true } },
        { name: "delete_repo", annotations: { destructiveHint: true } },
        { name: "comment" },
      ],
    });
    return { registry, id: entry.id };
  }

  it("asks for everything until the user chooses otherwise", async () => {
    const { registry, id } = await withTools();
    expect(["search", "delete_repo", "comment"].map((tool) => registry.autoApproval(id, tool))).toEqual([undefined, undefined, undefined]);
  });

  it("runs a tool the user always-allowed, and only that tool", async () => {
    const { registry, id } = await withTools();
    await registry.setToolAutoApprove(id, "comment", true);
    expect(registry.autoApproval(id, "comment")).toBe("always");
    expect(registry.autoApproval(id, "search")).toBeUndefined();
    await registry.setToolAutoApprove(id, "comment", false);
    expect(registry.autoApproval(id, "comment")).toBeUndefined();
  });

  it("runs read-only tools unasked only on a server set to, never a destructive one", async () => {
    const { registry, id } = await withTools();
    await registry.updateEntry(id, { autoApproveReadOnly: true });
    expect(registry.autoApproval(id, "search")).toBe("read_only");
    expect(registry.autoApproval(id, "delete_repo")).toBeUndefined();
    expect(registry.autoApproval(id, "comment")).toBeUndefined();
    expect(registry.toolViews(id).map((tool) => [tool.name, tool.autoApproved])).toEqual([["search", true], ["delete_repo", false], ["comment", false]]);
  });

  it("offers the agent only enabled servers' admitted tools", async () => {
    const { registry, id } = await withTools();
    await registry.setToolEnabled(id, "delete_repo", false);
    expect(registry.agentTools().map((tool) => tool.tool.name)).toEqual(["search", "comment"]);
    await registry.updateEntry(id, { enabled: false });
    expect(registry.agentTools()).toEqual([]);
  });
});
