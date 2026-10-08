/* Importing servers another client already has. The parsers are pure, so each config format is
   exercised directly; the trust decision (the user picking from a list that shows every command)
   lives in the command and is not something a parser can make. */

import * as path from "path";
import { describe, expect, it } from "vitest";
import { candidateFrom, importSources, looksSecret, readImportSource, type ImportSource } from "../../src/mcp-import.js";

const read = (files: Record<string, string>) => (file: string): string | undefined => files[file];

describe("importSources", () => {
  it("lists project files for each root and the user-level files for the platform", () => {
    const sources = importSources({ platform: "win32", home: "C:/Users/me", appData: "C:/Users/me/AppData/Roaming", vscodeUserDir: "C:/Users/me/AppData/Roaming/Code/User", workspaceRoots: ["C:/work/a"] });
    const files = sources.map((source) => source.file.replace(/\\/g, "/"));
    expect(files).toEqual(expect.arrayContaining([
      "C:/work/a/.vscode/mcp.json",
      "C:/work/a/.mcp.json",
      "C:/work/a/.cursor/mcp.json",
      "C:/Users/me/AppData/Roaming/Code/User/mcp.json",
      "C:/Users/me/.claude.json",
      "C:/Users/me/AppData/Roaming/Claude/claude_desktop_config.json",
      "C:/Users/me/.cursor/mcp.json",
    ]));
    expect(sources.find((source) => source.file.endsWith(".mcp.json"))?.label).toBe("Claude Code (this project)");
  });

  it("finds Claude Desktop where macOS and Linux keep it", () => {
    const mac = importSources({ platform: "darwin", home: "/Users/me", workspaceRoots: [] });
    const linux = importSources({ platform: "linux", home: "/home/me", workspaceRoots: [] });
    expect(mac.find((source) => source.label === "Claude Desktop")?.file.replace(/\\/g, "/")).toBe("/Users/me/Library/Application Support/Claude/claude_desktop_config.json");
    expect(linux.find((source) => source.label === "Claude Desktop")?.file.replace(/\\/g, "/")).toBe("/home/me/.config/Claude/claude_desktop_config.json");
  });

  it("names each root when several are open", () => {
    const sources = importSources({ platform: "linux", home: "/h", workspaceRoots: ["/w/api", "/w/web"] });
    expect(sources.map((source) => source.label)).toEqual(expect.arrayContaining(["VS Code (api)", "Claude Code (web)"]));
  });
});

describe("readImportSource", () => {
  const vscodeSource: ImportSource = { label: "VS Code (this project)", file: "/w/.vscode/mcp.json", format: "vscode" };
  const desktopSource: ImportSource = { label: "Claude Desktop", file: "/desktop.json", format: "mcpServers" };
  const claudeUser: ImportSource = { label: "Claude Code (user)", file: "/h/.claude.json", format: "claude-code-user" };

  it("reads VS Code's mcp.json, comments and all", () => {
    const { candidates } = readImportSource(vscodeSource, read({
      "/w/.vscode/mcp.json": `{
        // servers for this repo
        "servers": {
          "files": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "\${workspaceFolder}"] },
          "remote": { "type": "http", "url": "https://mcp.example/mcp", "headers": { "Authorization": "Bearer \${input:token}" } },
        },
        "inputs": [{ "id": "token", "type": "promptString", "password": true }],
      }`,
    }));
    expect(candidates.map((candidate) => candidate.name)).toEqual(["files", "remote"]);
    expect(candidates[0]!.entry).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"] });
    // The prompted token becomes a credential to fill in, not a literal "${input:token}" header.
    expect(candidates[1]!.entry.auth).toEqual({ mode: "bearer" });
    expect(candidates[1]!.entry.headers).toBeUndefined();
    expect(candidates[1]!.missingSecrets).toEqual(["Authorization"]);
  });

  it("moves credentials out of the entry into secrets", () => {
    const { candidates } = readImportSource(desktopSource, read({
      "/desktop.json": JSON.stringify({ mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret", LOG_LEVEL: "info", API_KEY: "${env:MY_KEY}" } },
        hosted: { type: "http", url: "https://mcp.example", headers: { "Authorization": "Bearer tok_123", "X-Team": "core" } },
      } }),
    }));
    const github = candidates.find((candidate) => candidate.name === "github")!;
    expect(github.secrets).toEqual([{ kind: "env", name: "GITHUB_PERSONAL_ACCESS_TOKEN", value: "ghp_secret" }]);
    expect(github.entry.env).toEqual([
      { name: "GITHUB_PERSONAL_ACCESS_TOKEN", secret: true },
      { name: "LOG_LEVEL", value: "info" },
      // A reference to the user's own environment is not a secret value; it stays as written.
      { name: "API_KEY", value: "${env:MY_KEY}" },
    ]);
    expect(JSON.stringify(github.entry)).not.toContain("ghp_secret");

    const hosted = candidates.find((candidate) => candidate.name === "hosted")!;
    expect(hosted.entry.auth).toEqual({ mode: "bearer" });
    expect(hosted.secrets).toEqual([{ kind: "token", value: "tok_123" }]);
    expect(hosted.entry.headers).toEqual({ "X-Team": "core" });
  });

  it("turns a custom key header into header-mode auth", () => {
    const candidate = candidateFrom("svc", { url: "https://mcp.example", headers: { "X-API-Key": "k-1" } }, "test")!;
    expect(candidate.entry.auth).toEqual({ mode: "header", headerName: "X-API-Key" });
    expect(candidate.secrets).toEqual([{ kind: "token", value: "k-1" }]);
  });

  it("reads Claude Code's per-project servers from ~/.claude.json", () => {
    const { candidates } = readImportSource(claudeUser, read({
      "/h/.claude.json": JSON.stringify({
        mcpServers: { everywhere: { command: "srv-a" } },
        projects: { [path.join("/", "code", "api")]: { mcpServers: { local: { command: "srv-b" } } }, "/code/empty": { mcpServers: {} } },
      }),
    }));
    expect(candidates.map((candidate) => [candidate.name, candidate.source])).toEqual([
      ["everywhere", "Claude Code (user)"],
      ["local", "Claude Code (api)"],
    ]);
  });

  it("skips entries with nothing to launch, and reports a file that is not JSON", () => {
    expect(readImportSource(desktopSource, read({ "/desktop.json": JSON.stringify({ mcpServers: { broken: { args: ["x"] } } }) })).candidates).toEqual([]);
    const bad = readImportSource(desktopSource, read({ "/desktop.json": "{ not json" }));
    expect(bad.candidates).toEqual([]);
    expect(bad.error).toMatch(/Claude Desktop: desktop\.json is not valid JSON/);
    expect(readImportSource(desktopSource, read({}))).toEqual({ candidates: [] });
  });
});

describe("looksSecret", () => {
  it("recognises the usual credential names", () => {
    for (const name of ["GITHUB_TOKEN", "OPENAI_API_KEY", "apiKey", "DB_PASSWORD", "CLIENT_SECRET", "x-api-key", "GITLAB_PAT"]) expect(looksSecret(name)).toBe(true);
    for (const name of ["LOG_LEVEL", "PORT", "WORKSPACE", "X-Team"]) expect(looksSecret(name)).toBe(false);
  });
});
