import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  handleWorktreeOp,
  LocalRuntime,
  normalizeServiceOrigin,
  resolveManagedWorktreePath,
} from "@blacksite/local-runtime";
import { createWebviewNonce } from "../../src/webview-html.js";
import { SERVICE_TOOLS, WORKSPACE_TOOLS } from "../../src/tools/definitions.js";
import { isMutatingServiceTool } from "../../src/agent-session.js";
import { isBridgeRequestAuthorized } from "../../src/browser-bridge-auth.js";

describe("webview security", () => {
  it("uses unpredictable, URL-safe CSP nonces", () => {
    const nonces = new Set(Array.from({ length: 64 }, () => createWebviewNonce()));
    expect(nonces.size).toBe(64);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe("browser companion bridge", () => {
  it("requires an exact bearer secret for localhost control-plane requests", () => {
    const token = "bridge-secret-value";
    expect(isBridgeRequestAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(isBridgeRequestAuthorized(undefined, token)).toBe(false);
    expect(isBridgeRequestAuthorized("Bearer bridge-secret-valuE", token)).toBe(false);
    expect(isBridgeRequestAuthorized(token, token)).toBe(false);
  });
});

describe("credential destination policy", () => {
  it("accepts only credential-free HTTPS origins", () => {
    expect(normalizeServiceOrigin("https://gitlab.example/path?q=1", "GitLab"))
      .toBe("https://gitlab.example");
    expect(() => normalizeServiceOrigin("http://gitlab.example", "GitLab")).toThrow(/HTTPS/);
    expect(() => normalizeServiceOrigin("https://user:secret@gitlab.example", "GitLab")).toThrow(/credentials/);
    expect(() => normalizeServiceOrigin("not a URL", "GitLab")).toThrow(/Invalid/);
  });

  it("does not expose credential destinations in model tool schemas", () => {
    for (const tool of SERVICE_TOOLS.filter((entry) => /^(gitlab|jira|confluence|salesforce)_/.test(entry.name))) {
      expect(tool.input_schema.properties).not.toHaveProperty("host");
      expect(tool.input_schema.properties).not.toHaveProperty("instanceUrl");
    }
  });

  it("classifies every credential-bearing write as an approval-gated mutation", () => {
    for (const name of [
      "github_create_issue", "github_create_pr", "github_add_comment",
      "gitlab_create_issue", "gitlab_create_mr",
      "jira_create_issue", "jira_update_issue", "jira_add_comment",
      "confluence_create_page", "confluence_update_page",
      "salesforce_create_object", "salesforce_update_object",
    ]) expect(isMutatingServiceTool(name), name).toBe(true);
    for (const name of ["github_get_issue", "gitlab_list_issues", "jira_list_projects", "confluence_search", "salesforce_query"]) {
      expect(isMutatingServiceTool(name), name).toBe(false);
    }
  });
});

describe("MCP control plane", () => {
  it("exposes only configured server IDs to the model", () => {
    const mcpTools = WORKSPACE_TOOLS.filter((tool) => tool.name.startsWith("mcp_"));
    expect(mcpTools).toHaveLength(2);
    for (const tool of mcpTools) {
      expect(tool.input_schema.properties).toHaveProperty("serverId");
      expect(tool.input_schema.properties).not.toHaveProperty("server");
      // The descriptor the host builds carries credentials, launch environment, and the tool
      // policy. None of it may be nameable from a tool call — a model that could set
      // `toolPolicy` could lift its own restrictions.
      expect(JSON.stringify(tool.input_schema)).not.toMatch(/apiKey|headers|toolPolicy|env|cwd/);
    }
  });

  it("requires approval before launching or contacting a configured server", async () => {
    const runtime = new LocalRuntime(process.cwd());
    await expect(runtime.handleMessage({
      type: "mcp.list_tools",
      payload: { server: { url: "definitely-not-a-real-mcp-command" } },
    })).resolves.toMatchObject({
      result: { ok: true, requiresConfirmation: true, tier: "network" },
    });
    await expect(runtime.handleMessage({
      type: "mcp.call_tool",
      payload: { server: { url: "https://mcp.example" }, toolName: "mutate" },
    })).resolves.toMatchObject({
      result: { ok: true, requiresConfirmation: true, tier: "network" },
    });
  });

  it("refuses a withheld tool before the approval prompt, not after it", async () => {
    // An approval dialog naming the tool would disclose that it exists, which is exactly what
    // withholding it is meant to prevent — so the refusal has to come first.
    const runtime = new LocalRuntime(process.cwd());
    await expect(runtime.handleMessage({
      type: "mcp.call_tool",
      payload: {
        server: { url: "https://mcp.example", toolPolicy: { deny: ["secret_tool"] } },
        toolName: "secret_tool",
      },
    })).resolves.toMatchObject({
      result: { ok: false, error: "MCP error -32602: Unknown tool: secret_tool" },
    });
  });

  it("names the destination in the approval prompt", async () => {
    // "An MCP server" is not enough for a user to judge the request: a remote origin and a
    // local command line are very different decisions.
    const runtime = new LocalRuntime(process.cwd());
    const remote = await runtime.handleMessage({
      type: "mcp.call_tool",
      payload: { server: { url: "https://mcp.example/endpoint" }, toolName: "mutate" },
    });
    expect((remote.result as { description: string }).description).toContain("https://mcp.example");
    const local = await runtime.handleMessage({
      type: "mcp.list_tools",
      payload: { server: { url: "npx -y some-server" } },
    });
    expect((local.result as { description: string }).description).toContain("npx -y some-server");
  });
});

describe("managed worktree removal", () => {
  const root = path.join(os.tmpdir(), "blacksite-security-root");
  const managed = path.join(root, ".blacksite", "worktrees", "lane-a");

  it("confines removal to Blacksite's managed worktree directory", () => {
    expect(resolveManagedWorktreePath(root, managed)).toBe(path.resolve(managed));
    expect(() => resolveManagedWorktreePath(root, root)).toThrow(/outside/);
    expect(() => resolveManagedWorktreePath(root, path.join(root, "..", "other"))).toThrow(/outside/);
  });

  it("requires destructive approval before invoking git", () => {
    expect(handleWorktreeOp(root, { op: "remove", path: managed })).toMatchObject({
      ok: true,
      requiresConfirmation: true,
      tier: "destructive",
    });
  });
});
