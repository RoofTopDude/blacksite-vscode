/* Cross-tool skills and Agent Plugins 1.0.

   Skills: the folders the Agent Skills adopters share are read after Blacksite's own, and a skill
   written for another tool loads without complaint — but only Blacksite's own folder is ever
   written to or deleted from.

   Plugins: the specification's validation rules, and Blacksite's trust model on top of them —
   an enabled plugin's skills load, its MCP servers run only once the user trusts that exact
   mcp.json, and a change to the file withdraws the trust. */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { SkillStore } from "../../src/skills/skill-store.js";
import { parseSkillFile } from "../../src/skills/skill-format.js";
import { expandPluginPlaceholders, loadPlugin, MCP_SCHEMA_ID, PLUGIN_SCHEMA_ID } from "../../src/plugins/plugin-manifest.js";
import { PluginRegistry } from "../../src/plugins/plugin-registry.js";
import { McpRegistry } from "../../src/mcp-registry.js";

let root: string;
let home: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bs-plugins-"));
  home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
const DESC = "Does the thing. Use when the thing needs doing.";
function skill(dir: string, name: string, extra = ""): void {
  write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${DESC}\n${extra}---\n\n# Steps\n`);
}

function memento() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => { values.set(key, value); },
  };
}

function plugin(dir: string, name: string, mcp?: Record<string, unknown>, manifestExtra: Record<string, unknown> = {}): void {
  write(path.join(dir, "plugin.json"), JSON.stringify({ $schema: PLUGIN_SCHEMA_ID, name, version: "1.0.0", ...manifestExtra }));
  if (mcp) write(path.join(dir, "mcp.json"), JSON.stringify({ $schema: MCP_SCHEMA_ID, mcpServers: mcp }));
}

describe("skills from the cross-tool folders", () => {
  it("reads every conventional folder, Blacksite's first, and records what it shadows", () => {
    skill(path.join(root, ".claude", "skills"), "claude-only");
    skill(path.join(root, ".agents", "skills"), "shared");
    skill(path.join(root, ".blacksite", "skills"), "shared");
    skill(path.join(root, ".github", "skills"), "github-only");
    skill(path.join(home, ".agents", "skills"), "personal");
    const store = new SkillStore(root, undefined, home);
    const byName = new Map(store.list().map((record) => [record.name, record]));
    expect([...byName.keys()].sort()).toEqual(["claude-only", "github-only", "personal", "shared"]);
    expect(byName.get("shared")).toMatchObject({ location: ".blacksite/skills", managed: true, shadowedLocations: [".agents/skills"] });
    expect(byName.get("claude-only")).toMatchObject({ origin: "workspace", location: ".claude/skills", managed: false });
    expect(byName.get("personal")).toMatchObject({ origin: "user", location: "~/.agents/skills", managed: false });
  });

  it("never deletes a skill that lives in another tool's folder", () => {
    skill(path.join(root, ".claude", "skills"), "theirs");
    const store = new SkillStore(root, undefined, home);
    expect(store.remove("theirs")).toBe(false);
    expect(fs.existsSync(path.join(root, ".claude", "skills", "theirs", "SKILL.md"))).toBe(true);
  });

  it("loads a skill written to the standard without a warning per field", () => {
    const parsed = parseSkillFile(`---\nname: pdf-tools\ndescription: ${DESC}\nlicense: Apache-2.0\ncompatibility: Requires python3\nmetadata:\n  author: someone\n  version: "1.2"\nallowed-tools: Read Grep Bash(git:*)\n---\n\nBody`);
    expect(parsed.issues).toEqual([]);
    expect(parsed.frontmatter.allowedTools).toEqual(["Read", "Grep", "Bash(git:*)"]);
  });

  it("lists enabled plugins' skills under the plugin origin, below user and workspace", () => {
    skill(path.join(root, "p", "skills"), "from-plugin");
    const store = new SkillStore(root, undefined, home, () => [{ plugin: "tidy", dir: path.join(root, "p", "skills") }]);
    expect(store.find("from-plugin")).toMatchObject({ origin: "plugin", location: "plugin: tidy", managed: false });
  });
});

describe("Agent Plugins 1.0 manifest rules", () => {
  it("loads a valid plugin with its skills and MCP servers", () => {
    const dir = path.join(root, "good");
    plugin(dir, "good-plugin", {
      local: { type: "stdio", command: "./bin/server", args: ["--config", "${PLUGIN_ROOT}/config.json"], env: { LOG: "${PLUGIN_DATA}/log" } },
      remote: { type: "streamable-http", url: "https://mcp.example.com/mcp", headers: { "X-Team": "a" } },
    }, { description: "Tidy things" });
    write(path.join(dir, "bin", "server"), "");
    skill(path.join(dir, "skills"), "tidy");
    const result = loadPlugin(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.manifest).toMatchObject({ name: "good-plugin", description: "Tidy things" });
    expect(result.plugin.skillsDir).toBeTruthy();
    expect(result.plugin.mcpServers.map((server) => server.name)).toEqual(["local", "remote"]);
    expect(result.plugin.mcpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.plugin.warnings).toEqual([]);
  });

  it("rejects a missing or unknown schema id and an invalid name", () => {
    write(path.join(root, "a", "plugin.json"), JSON.stringify({ name: "ok" }));
    expect(loadPlugin(path.join(root, "a")).ok).toBe(false);
    for (const name of ["Upper", "-lead", "trail-", "double--hyphen", "a..b", "x".repeat(65)]) {
      plugin(path.join(root, name), name);
      expect(loadPlugin(path.join(root, name)).ok, name).toBe(false);
    }
  });

  it("warns about unknown top-level fields without rejecting", () => {
    plugin(path.join(root, "w"), "warns", undefined, { surprise: true });
    const result = loadPlugin(path.join(root, "w"));
    expect(result.ok && result.plugin.warnings[0]).toMatch(/surprise/);
  });

  it("disables MCP when mcp.json's schema does not match, and skips invalid servers one by one", () => {
    const dir = path.join(root, "m");
    plugin(dir, "mcp-plugin");
    write(path.join(dir, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json", mcpServers: { a: { type: "stdio", command: "x" } } }));
    const mismatch = loadPlugin(dir);
    expect(mismatch.ok && mismatch.plugin.mcpServers).toEqual([]);

    plugin(dir, "mcp-plugin", {
      spaced: { type: "stdio", command: "npx some-server" },
      escaping: { type: "stdio", command: "./../outside" },
      pathy: { type: "stdio", command: "bin/server" },
      claimsRoot: { type: "stdio", command: "node", env: { PLUGIN_ROOT: "/elsewhere" } },
      cleartext: { type: "streamable-http", url: "http://mcp.example.com" },
      placeholder: { type: "sse", url: "https://x.example.com/${PLUGIN_ROOT}" },
      loopback: { type: "streamable-http", url: "http://127.0.0.1:8080/mcp" },
      fine: { type: "stdio", command: "node", args: ["server.js"] },
    });
    const result = loadPlugin(dir);
    expect(result.ok && result.plugin.mcpServers.map((server) => server.name)).toEqual(["loopback", "fine"]);
    expect(result.ok && result.plugin.warnings.length).toBe(6);
  });

  it("expands the two placeholders once, and nothing else", () => {
    expect(expandPluginPlaceholders("${PLUGIN_ROOT}/a ${PLUGIN_DATA} ${HOME}", "/r", "/d")).toBe("/r/a /d ${HOME}");
    expect(expandPluginPlaceholders("${PLUGIN_ROOT}", "${PLUGIN_DATA}", "/d")).toBe("${PLUGIN_DATA}");
  });
});

describe("plugin registry trust model", () => {
  function registry() {
    return new PluginRegistry(root, memento(), memento(), path.join(root, "data"), home);
  }

  it("discovers workspace and user plugins, enabled by default, with MCP not yet allowed", () => {
    plugin(path.join(root, ".blacksite", "plugins", "repo-tools"), "repo-tools", { srv: { type: "stdio", command: "node" } });
    plugin(path.join(home, ".agents", "plugins", "mine"), "mine");
    const reg = registry();
    const records = reg.list();
    expect(records.map((r) => [r.key, r.location, r.enabled, r.mcpTrusted])).toEqual([
      ["workspace:repo-tools", ".blacksite/plugins/repo-tools", true, false],
      ["user:mine", "~/.agents/plugins/mine", true, false],
    ]);
    expect(reg.mcpEntries()).toEqual([]);
  });

  it("runs MCP servers only after trust, with PLUGIN_ROOT and PLUGIN_DATA supplied", async () => {
    const dir = path.join(root, ".blacksite", "plugins", "tools");
    plugin(dir, "tools", { srv: { type: "stdio", command: "./run", args: ["${PLUGIN_DATA}/state"], cwd: "./work" } });
    write(path.join(dir, "run"), "");
    const reg = registry();
    await reg.trustMcp("workspace:tools");
    const [entry] = reg.mcpEntries();
    const real = fs.realpathSync(dir);
    const data = path.join(root, "data", "workspace-tools");
    expect(entry).toMatchObject({
      id: "plugin.workspace.tools.srv",
      transport: "stdio",
      command: path.resolve(real, "./run"),
      args: [`${data}/state`],
      cwd: path.resolve(real, "./work"),
      pluginKey: "workspace:tools",
    });
    expect(entry!.env).toEqual(expect.arrayContaining([{ name: "PLUGIN_ROOT", value: real }, { name: "PLUGIN_DATA", value: data }]));
    expect(fs.existsSync(data)).toBe(true);
  });

  it("withdraws trust when mcp.json changes, and hides a disabled plugin entirely", async () => {
    const dir = path.join(root, ".blacksite", "plugins", "tools");
    plugin(dir, "tools", { srv: { type: "stdio", command: "node" } });
    const reg = registry();
    await reg.trustMcp("workspace:tools");
    expect(reg.mcpEntries()).toHaveLength(1);
    plugin(dir, "tools", { srv: { type: "stdio", command: "node", args: ["--evil"] } });
    reg.invalidate();
    expect(reg.find("workspace:tools")!.mcpTrusted).toBe(false);
    expect(reg.mcpEntries()).toEqual([]);

    skill(path.join(dir, "skills"), "tidy");
    reg.invalidate(); // the workspace file watcher does this when the folder appears
    expect(reg.skillSources()).toHaveLength(1);
    await reg.setEnabled("workspace:tools", false);
    expect(reg.skillSources()).toEqual([]);
  });

  it("reports a second plugin of the same name instead of silently shadowing it", () => {
    plugin(path.join(root, ".blacksite", "plugins", "a"), "dup");
    plugin(path.join(root, ".agents", "plugins", "b"), "dup");
    const records = registry().list();
    expect(records[1]!.error).toMatch(/already loaded/);
  });

  it("installs into the user folder and uninstalls from it", async () => {
    const source = path.join(root, "download");
    plugin(source, "installable");
    const reg = registry();
    const result = reg.install(source);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(home, ".blacksite", "plugins", "installable", "plugin.json"))).toBe(true);
    expect(reg.install(source).ok).toBe(false); // already installed
    expect(await reg.uninstall("user:installable")).toBe(true);
    expect(fs.existsSync(path.join(home, ".blacksite", "plugins", "installable"))).toBe(false);
  });
});

describe("MCP registry with plugin servers", () => {
  function context() {
    const state = () => { const m = new Map<string, unknown>(); return { get: <T>(k: string, f?: T) => (m.has(k) ? m.get(k) as T : f), update: async (k: string, v: unknown) => { m.set(k, v); } }; };
    return { workspaceState: state(), globalState: state(), secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined } } as unknown as vscode.ExtensionContext;
  }
  beforeEach(() => (vscode.workspace as unknown as { __clearConfig(): void }).__clearConfig());

  it("lists plugin servers, resolves their argv and cwd, and routes panel edits to the plugin", async () => {
    const registry = new McpRegistry(context(), () => ["C:/workspace"]);
    const onAction = vi.fn(async () => undefined);
    registry.setPluginSource(() => [{
      id: "plugin.user.tools.srv", name: "srv (plugin tools)", transport: "stdio", command: "node",
      args: ["server with spaces.js"], cwd: "C:/plugins/tools", enabled: true, pluginKey: "user:tools",
      env: [{ name: "PLUGIN_ROOT", value: "C:/plugins/tools" }],
    }], onAction);
    expect(registry.listEntries().map((entry) => entry.id)).toEqual(["plugin.user.tools.srv"]);
    const resolved = await registry.resolveForAgent("plugin.user.tools.srv");
    expect(resolved.ok && resolved.server).toMatchObject({ url: "node", args: ["server with spaces.js"], cwd: "C:/plugins/tools", env: { PLUGIN_ROOT: "C:/plugins/tools" } });

    await registry.updateEntry("plugin.user.tools.srv", { enabled: false });
    await registry.removeEntry("plugin.user.tools.srv");
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ pluginKey: "user:tools" }), { kind: "update", patch: { enabled: false } });
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ pluginKey: "user:tools" }), { kind: "remove" });
    // Never forked into ordinary configured servers.
    expect((context().workspaceState.get("blacksite.mcp.servers") ?? [])).toEqual([]);
  });
});
