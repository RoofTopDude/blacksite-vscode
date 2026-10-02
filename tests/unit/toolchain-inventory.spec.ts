import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ToolchainInventoryCache, environmentsInPlay, formatToolchainSummary, whichAll, type MachineInventory,
} from "../../src/toolchains/inventory.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function venv(root: string, relative: string, tools: string[], version: string): void {
  const dir = path.join(root, relative);
  const bin = path.join(dir, process.platform === "win32" ? "Scripts" : "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dir, "pyvenv.cfg"), `version = ${version}\n`);
  for (const tool of tools) fs.writeFileSync(path.join(bin, process.platform === "win32" ? `${tool}.exe` : tool), "");
}

const inventory: MachineInventory = {
  probedAt: Date.now(),
  pathKey: "k",
  installs: [
    { toolchain: "Python", command: "python3", path: "/usr/bin/python3", version: "3.9.6", source: "PATH" },
    { toolchain: "Python", command: "/opt/homebrew/opt/python@3.12/bin/python3", path: "/opt/homebrew/opt/python@3.12/bin/python3", version: "3.12.4", source: "Homebrew" },
    { toolchain: "Node", command: "node", path: "/usr/local/bin/node", version: "20.11.1", source: "PATH" },
  ],
  managers: ["brew", "uv"],
  missing: ["Go", ".NET"],
};

describe("toolchain summary for the agent's context", () => {
  it("lists every install with its version, and what is missing", () => {
    const text = formatToolchainSummary(inventory, []);
    expect(text).toContain("python3 3.9.6 (/usr/bin/python3)");
    expect(text).toContain("Homebrew 3.12.4");
    expect(text).toContain("Node: node 20.11.1");
    expect(text).toContain("Not installed: Go, .NET");
    expect(text).toContain("Package managers: brew, uv");
  });

  it("says when there is no bare python, so the agent reaches for python3 first", () => {
    if (process.platform === "win32") return;
    expect(formatToolchainSummary(inventory, [])).toContain("no bare `python`; use `python3`");
  });

  it("names the environment of each project in play, one per environment", () => {
    const root = tempDir("blacksite-envs-");
    venv(root, "services/billing/.venv", ["pytest", "mypy"], "3.12.4");
    fs.mkdirSync(path.join(root, "services", "billing", "app"), { recursive: true });
    fs.mkdirSync(path.join(root, "apps", "web"), { recursive: true });

    const environments = environmentsInPlay(root, ["services/billing/app/main.py", "services/billing/app/db.py", "apps/web/index.ts"]);

    expect(environments).toEqual([{ project: "services/billing", venv: "services/billing/.venv", pythonVersion: "3.12.4", tools: ["pytest", "mypy"] }]);
    expect(formatToolchainSummary(undefined, environments)).toContain("Project services/billing uses services/billing/.venv (Python 3.12.4; has pytest, mypy)");
  });
});

describe("whichAll", () => {
  it("finds every copy on PATH, not just the first", () => {
    const first = tempDir("blacksite-path-a-");
    const second = tempDir("blacksite-path-b-");
    const name = process.platform === "win32" ? "tool.exe" : "tool";
    fs.writeFileSync(path.join(first, name), "");
    fs.writeFileSync(path.join(second, name), "");
    const separator = process.platform === "win32" ? ";" : ":";
    expect(whichAll("tool", { PATH: [first, second].join(separator), PATHEXT: ".EXE" })).toHaveLength(2);
  });
});

describe("ToolchainInventoryCache", () => {
  it("answers from the stored probe without waiting, and refreshes a stale one in the background", async () => {
    const stored = { ...inventory, probedAt: 0 };
    const store = { get: vi.fn(() => stored), update: vi.fn(async () => undefined) };
    const fresh = { ...inventory, probedAt: Date.now(), missing: [] };
    const probe = vi.fn(async () => fresh);
    const cache = new ToolchainInventoryCache(store as never, probe);

    expect(cache.current()).toBe(stored);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(cache.current()).toBe(fresh));
    expect(store.update).toHaveBeenCalledWith("blacksite.toolchainInventory", fresh);
  });
});
