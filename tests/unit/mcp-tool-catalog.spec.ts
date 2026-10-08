/* MCP tools as typed agent tools: stable, valid, collision-free names, and schemas a provider
   accepts, with the server's own contract otherwise untouched. */

import { describe, expect, it } from "vitest";
import { buildMcpToolCatalog, wireSchema } from "../../src/mcp-tool-catalog.js";
import { buildToolRoster } from "../../src/agent/tool-loading.js";

const VALID_NAME = /^[A-Za-z0-9_-]{1,54}$/;

describe("buildMcpToolCatalog", () => {
  it("names each tool mcp__<server>__<tool> and routes it through mcp.call_tool", () => {
    const [typed] = buildMcpToolCatalog([{ serverId: "mcp_1", serverName: "GitHub", tool: { name: "create_issue", description: "Open an issue." } }]);
    expect(typed).toMatchObject({ name: "mcp__github__create_issue", serverId: "mcp_1", toolName: "create_issue" });
    expect(typed!.definition.runtimeType).toBe("mcp.call_tool");
    expect(typed!.definition.description).toBe("[MCP server \"GitHub\"] Open an issue.");
  });

  it("keeps two servers whose names reduce to the same slug apart", () => {
    const catalog = buildMcpToolCatalog([
      { serverId: "a", serverName: "Files!", tool: { name: "read" } },
      { serverId: "b", serverName: "files", tool: { name: "read" } },
    ]);
    expect(new Set(catalog.map((tool) => tool.name)).size).toBe(2);
    expect(catalog[0]!.name).toBe("mcp__files__read");
    expect(catalog[1]!.name).toMatch(/^mcp__files_[a-z0-9]+__read$/);
  });

  it("stays within the name limit every route enforces, and stays deterministic", () => {
    const long = { serverId: "s", serverName: "A very long server name indeed", tool: { name: "x".repeat(80) } };
    const first = buildMcpToolCatalog([long])[0]!;
    expect(first.name).toMatch(VALID_NAME);
    expect(buildMcpToolCatalog([long])[0]!.name).toBe(first.name);
  });

  it("makes a tool name with characters a provider rejects into a valid one", () => {
    const [typed] = buildMcpToolCatalog([{ serverId: "s", serverName: "Docs", tool: { name: "search.pages v2" } }]);
    expect(typed!.name).toMatch(VALID_NAME);
    expect(typed!.toolName).toBe("search.pages v2");
  });

  it("marks read-only and destructive tools from their annotations", () => {
    const catalog = buildMcpToolCatalog([
      { serverId: "s", serverName: "S", tool: { name: "get", annotations: { readOnlyHint: true, destructiveHint: true } } },
      { serverId: "s", serverName: "S", tool: { name: "drop", annotations: { destructiveHint: true } } },
      { serverId: "s", serverName: "S", tool: { name: "plain" } },
    ]);
    expect(catalog.map((tool) => [tool.toolName, tool.readOnly, tool.destructive])).toEqual([
      ["get", true, false],
      ["drop", false, true],
      ["plain", false, false],
    ]);
    expect(catalog[1]!.definition.description).toContain("(destructive)");
  });
});

describe("wireSchema", () => {
  it("guarantees an object root and drops only the $schema keyword", () => {
    expect(wireSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(wireSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { q: { type: "string" } }, required: ["q"], $defs: { x: {} } }))
      .toEqual({ type: "object", properties: { q: { type: "string" } }, required: ["q"], $defs: { x: {} } });
    expect(wireSchema({ oneOf: [{ type: "object" }] })).toEqual({ oneOf: [{ type: "object" }], type: "object", properties: {} });
  });
});

describe("tool roster", () => {
  it("lists typed MCP tools under their server instead of under Other", () => {
    const catalog = buildMcpToolCatalog([
      { serverId: "a", serverName: "GitHub", tool: { name: "create_issue" } },
      { serverId: "a", serverName: "GitHub", tool: { name: "list_prs" } },
    ]);
    const roster = buildToolRoster(catalog.map((tool) => tool.definition));
    expect(roster).toBe("- MCP server \"github\": mcp__github__create_issue, mcp__github__list_prs");
  });
});
