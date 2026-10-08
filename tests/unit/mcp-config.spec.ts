/* Reading an MCP server entry the way people actually write one. The first parser accepted only
   a single command line and [{ name, value }] env entries, and dropped args, cwd and an env object
   without a word, so a server copied from its README launched as a bare `npx`. */

import { describe, expect, it } from "vitest";
import { entryTarget, expandVariables, normalizeEntry, parseJsonc, serializeEntry } from "../../src/mcp-config.js";

describe("normalizeEntry", () => {
  it("keeps command, args, cwd and an env object, the shape every MCP README uses", () => {
    const entry = normalizeEntry({
      id: "gh", name: "GitHub", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"],
      cwd: "C:/tools", env: { GITHUB_TOKEN: "abc", DEBUG: 1 },
    });
    expect(entry).toMatchObject({
      transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], cwd: "C:/tools",
      env: [{ name: "GITHUB_TOKEN", value: "abc" }, { name: "DEBUG", value: "1" }],
    });
  });

  it("still reads Blacksite's own [{ name, value, secret }] env form", () => {
    const entry = normalizeEntry({ id: "x", transport: "stdio", command: "srv", env: [{ name: "KEY", secret: true }, { name: "MODE", value: "fast" }] });
    expect(entry?.env).toEqual([{ name: "KEY", secret: true }, { name: "MODE", value: "fast" }]);
  });

  it("infers the transport from another client's `type`, or from command vs url", () => {
    expect(normalizeEntry({ id: "a", type: "stdio", command: "srv" })?.transport).toBe("stdio");
    expect(normalizeEntry({ id: "b", type: "http", url: "https://x.example/mcp" })?.transport).toBe("http");
    expect(normalizeEntry({ id: "c", type: "sse", url: "https://x.example/sse" })).toMatchObject({ transport: "http", transportHint: "sse" });
    expect(normalizeEntry({ id: "d", type: "streamable-http", url: "https://x.example/mcp" })?.transport).toBe("http");
    // No transport and no type: a command alone is a local process (it used to become "http").
    expect(normalizeEntry({ id: "e", command: "srv" })?.transport).toBe("stdio");
    expect(normalizeEntry({ id: "f", url: "https://x.example/mcp" })?.transport).toBe("http");
  });

  it("honours `disabled: true` as other clients write it", () => {
    expect(normalizeEntry({ id: "a", command: "srv", disabled: true })?.enabled).toBe(false);
    expect(normalizeEntry({ id: "b", command: "srv" })?.enabled).toBe(true);
  });

  it("uses the fallback id for a config keyed by name", () => {
    expect(normalizeEntry({ command: "srv" }, "files")?.id).toBe("files");
    expect(normalizeEntry({ command: "srv" })).toBeNull();
  });
});

describe("serializeEntry", () => {
  it("round-trips, writing env compactly unless a variable is secret", () => {
    const plain = normalizeEntry({ id: "a", name: "A", command: "npx", args: ["srv"], env: { MODE: "x" } })!;
    expect(serializeEntry(plain)).toMatchObject({ command: "npx", args: ["srv"], env: { MODE: "x" } });
    expect(normalizeEntry(serializeEntry(plain))).toMatchObject({ command: "npx", args: ["srv"], env: [{ name: "MODE", value: "x" }] });

    const secret = normalizeEntry({ id: "b", name: "B", command: "srv", env: [{ name: "TOKEN", secret: true }] })!;
    expect(serializeEntry(secret)["env"]).toEqual([{ name: "TOKEN", secret: true }]);
  });

  it("never writes the derived scope or a plugin key", () => {
    const out = serializeEntry({ id: "a", name: "A", transport: "stdio", command: "srv", enabled: true, scope: "user", pluginKey: "p" });
    expect(out).not.toHaveProperty("scope");
    expect(out).not.toHaveProperty("pluginKey");
  });
});

describe("entryTarget", () => {
  it("shows the command with its arguments, quoting ones with spaces", () => {
    expect(entryTarget({ transport: "stdio", command: "node", args: ["C:/My Tools/srv.js", "--flag"] })).toBe("node \"C:/My Tools/srv.js\" --flag");
    expect(entryTarget({ transport: "http", url: " https://x.example/mcp " })).toBe("https://x.example/mcp");
  });
});

describe("expandVariables", () => {
  const context = { env: { HOME_DIR: "/home/me", EMPTY: "" }, workspaceFolder: "/work", userHome: "/home/me" };

  it("expands the variable spellings other clients use", () => {
    expect(expandVariables("${env:HOME_DIR}/x", context)).toBe("/home/me/x");
    expect(expandVariables("${HOME_DIR}/x", context)).toBe("/home/me/x");
    expect(expandVariables("${MISSING:-fallback}", context)).toBe("fallback");
    expect(expandVariables("${EMPTY:-fallback}", context)).toBe("fallback");
    expect(expandVariables("${workspaceFolder}/src", context)).toBe("/work/src");
    expect(expandVariables("${userHome}/.config", context)).toBe("/home/me/.config");
    expect(expandVariables("${MISSING}", context)).toBe("");
  });

  it("leaves a VS Code input prompt and anything unrecognised as written", () => {
    expect(expandVariables("${input:token}", context)).toBe("${input:token}");
    expect(expandVariables("${not a name}", context)).toBe("${not a name}");
    expect(expandVariables("plain", context)).toBe("plain");
  });
});

describe("parseJsonc", () => {
  it("accepts comments and trailing commas, and leaves strings alone", () => {
    const parsed = parseJsonc(`{
      // a comment
      "servers": { "a": { "url": "https://x.example/mcp//not-a-comment", "note": "a, ]", }, },
      /* block */
      "list": [1, 2,],
    }`);
    expect(parsed).toEqual({ servers: { a: { url: "https://x.example/mcp//not-a-comment", note: "a, ]" } }, list: [1, 2] });
  });

  it("still rejects text that is not JSON", () => {
    expect(() => parseJsonc("{ nope }")).toThrow();
  });
});
