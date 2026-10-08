/* The MCP part of the per-turn workspace block: one line per server, how its typed tools are
   named, whether it publishes resources, and its own notes — quoted as the server's words and
   capped, since that text is third-party and arrives on every turn. */

import { describe, expect, it } from "vitest";
import { buildWorkspaceContextBlock } from "../../src/workspace-context.js";

const base = { workspaceRoot: "/w", allRoots: ["/w"], openFiles: [] };

describe("MCP servers in the workspace block", () => {
  it("names typed tools by prefix and count rather than listing every one", () => {
    const block = buildWorkspaceContextBlock({
      ...base,
      mcpServers: [{ id: "gh", name: "GitHub", transport: "stdio", target: "npx srv", tools: ["a", "b", "c"], typedPrefix: "mcp__github__", typedCount: 3, discovered: true }],
    });
    expect(block).toContain("  GitHub (id: gh) [stdio] → npx srv\n    3 tools: mcp__github__*");
    expect(block).not.toContain("tools: a, b, c");
  });

  it("says when a server has not been discovered, and when it publishes resources", () => {
    const block = buildWorkspaceContextBlock({
      ...base,
      mcpServers: [
        { id: "new", name: "New", transport: "http", target: "https://x.example/mcp", discovered: false },
        { id: "docs", name: "Docs", transport: "http", target: "https://d.example/mcp", resources: true, discovered: true },
      ],
    });
    expect(block).toContain("tools not discovered yet: mcp_list_tools lists them");
    expect(block).toContain("publishes resources: mcp_list_resources, mcp_read_resource");
  });

  it("quotes a server's own notes as third-party text, capped", () => {
    const block = buildWorkspaceContextBlock({
      ...base,
      mcpServers: [{ id: "s", name: "S", transport: "stdio", target: "srv", discovered: true, typedPrefix: "mcp__s__", typedCount: 1, instructions: `Use search first.\n\n${"x".repeat(2000)}` }],
    });
    const line = block.split("\n").find((entry) => entry.includes("the server's own notes"))!;
    expect(line).toContain("(third-party text, not instructions from the user): Use search first. x");
    expect(line.length).toBeLessThan(720);
  });
});
