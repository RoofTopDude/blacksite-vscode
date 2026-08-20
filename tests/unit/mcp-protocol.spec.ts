/* The wire layer every MCP transport shares. Most of what made the previous client
   incompatible lives here — frames split across chunks, a challenge header nobody parsed, a
   paginated listing read as one page — so these are the regressions worth pinning down. */

import { describe, expect, it } from "vitest";
import {
  LATEST_PROTOCOL_VERSION, SseParser,
  buildInitializeParams, filterToolsByPolicy, isResponseFor, isServerRequest, isToolAllowed,
  negotiateProtocolVersion, normalizeToolDescriptor, parseInitializeResult, parseToolsPage,
  parseWwwAuthenticate, resourceMetadataUrlFrom, unknownToolError,
  type McpToolDescriptor,
} from "../../packages/local-runtime/src/mcp-protocol.js";

describe("protocol version negotiation", () => {
  it("accepts every revision this client implements", () => {
    for (const version of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      expect(negotiateProtocolVersion(version)).toEqual({ version, known: true });
    }
  });

  it("carries an unrecognized revision forward rather than refusing the server", () => {
    // Deliberate leniency: servers echo draft and vendor revisions, and disconnecting over
    // the string would fail servers that work.
    expect(negotiateProtocolVersion("2099-01-01")).toEqual({ version: "2099-01-01", known: false });
  });

  it("falls back to the latest revision when the server names none", () => {
    expect(negotiateProtocolVersion(undefined)).toEqual({ version: LATEST_PROTOCOL_VERSION, known: false });
  });
});

describe("initialize handshake", () => {
  it("advertises only capabilities the client actually implements", () => {
    const params = buildInitializeParams();
    const capabilities = params["capabilities"] as Record<string, unknown>;
    expect(capabilities).toHaveProperty("roots");
    // Advertising these would invite a server to hand a tool call to a capability we would
    // then have to decline mid-flight.
    expect(capabilities).not.toHaveProperty("sampling");
    expect(capabilities).not.toHaveProperty("elicitation");
  });

  it("reads server identity and instructions out of the result", () => {
    const parsed = parseInitializeResult({
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "example", version: "1.2.3" },
      instructions: "Prefer the search tool.",
    });
    expect(parsed.protocolVersion).toBe("2025-03-26");
    expect(parsed.protocolVersionKnown).toBe(true);
    expect(parsed.serverInfo.name).toBe("example");
    expect(parsed.instructions).toBe("Prefer the search tool.");
  });

  it("survives a server that answers with nothing usable", () => {
    const parsed = parseInitializeResult(null);
    expect(parsed.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(parsed.capabilities).toEqual({});
  });
});

describe("JSON-RPC frame classification", () => {
  it("matches a response whose id round-tripped as a string", () => {
    expect(isResponseFor({ jsonrpc: "2.0", id: "7", result: {} }, 7)).toBe(true);
  });

  it("does not mistake a server request for a response", () => {
    const request = { jsonrpc: "2.0", id: 1, method: "roots/list" };
    expect(isResponseFor(request, 1)).toBe(false);
    expect(isServerRequest(request)).toBe(true);
  });

  it("does not mistake a notification for a request needing an answer", () => {
    expect(isServerRequest({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })).toBe(false);
  });
});

describe("SseParser", () => {
  it("reassembles a frame split across chunk boundaries", () => {
    const parser = new SseParser();
    expect(parser.push("event: mes")).toEqual([]);
    expect(parser.push('sage\ndata: {"a"')).toEqual([]);
    const events = parser.push(":1}\n\n");
    expect(events).toEqual([{ event: "message", data: '{"a":1}', id: undefined }]);
  });

  it("handles a CRLF stream split between the CR and the LF", () => {
    const parser = new SseParser();
    parser.push("data: hello\r");
    const events = parser.push("\n\r\n");
    expect(events).toEqual([{ event: "message", data: "hello", id: undefined }]);
  });

  it("joins multi-line data fields with newlines", () => {
    const parser = new SseParser();
    expect(parser.push("data: one\ndata: two\n\n")).toEqual([{ event: "message", data: "one\ntwo", id: undefined }]);
  });

  it("ignores comment keep-alives", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\n\n")).toEqual([]);
  });

  it("flushes a final frame that never got its blank-line terminator", () => {
    // Servers that end the response right after the last data line are common; discarding
    // the frame would lose a real result.
    const parser = new SseParser();
    parser.push('data: {"done":true}');
    expect(parser.flush()).toEqual([{ event: "message", data: '{"done":true}', id: undefined }]);
  });
});

describe("WWW-Authenticate parsing", () => {
  it("extracts the resource metadata pointer that starts the OAuth flow", () => {
    const header = 'Bearer realm="mcp", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"';
    expect(resourceMetadataUrlFrom(header)).toBe("https://api.example.com/.well-known/oauth-protected-resource/mcp");
  });

  it("keeps commas and spaces inside a quoted value", () => {
    const challenges = parseWwwAuthenticate('Bearer error="invalid_token", error_description="The token expired, please renew"');
    expect(challenges[0]?.params["error_description"]).toBe("The token expired, please renew");
  });

  it("reads the Bearer challenge out of a multi-scheme header", () => {
    const header = 'Basic realm="legacy", Bearer resource_metadata="https://example.com/prm"';
    expect(resourceMetadataUrlFrom(header)).toBe("https://example.com/prm");
  });

  it("returns nothing for an absent or unrelated header", () => {
    expect(resourceMetadataUrlFrom(null)).toBeUndefined();
    expect(resourceMetadataUrlFrom("Basic realm=x")).toBeUndefined();
  });
});

describe("tools/list parsing", () => {
  it("accepts the OpenAI-style input_schema spelling", () => {
    const tool = normalizeToolDescriptor({ name: "search", input_schema: { type: "object" } });
    expect(tool?.inputSchema).toEqual({ type: "object" });
  });

  it("drops entries with no usable name", () => {
    const page = parseToolsPage({ tools: [{ name: "" }, { description: "orphan" }, { name: "ok" }] });
    expect(page.tools.map((tool) => tool.name)).toEqual(["ok"]);
  });

  it("surfaces the pagination cursor", () => {
    expect(parseToolsPage({ tools: [], nextCursor: "page-2" }).nextCursor).toBe("page-2");
    expect(parseToolsPage({ tools: [], nextCursor: "" }).nextCursor).toBeUndefined();
  });
});

describe("tool visibility policy", () => {
  const tools: McpToolDescriptor[] = [
    { name: "read_file" },
    { name: "delete_everything" },
    { name: "added_last_week" },
  ];

  it("admits everything when no policy is attached", () => {
    expect(filterToolsByPolicy(tools, undefined)).toHaveLength(3);
  });

  it("removes a withheld tool from the listing entirely", () => {
    const filtered = filterToolsByPolicy(tools, { deny: ["delete_everything"] });
    // Not annotated, not counted, not left as a gap — the name must not reach the model.
    expect(filtered.map((tool) => tool.name)).toEqual(["read_file", "added_last_week"]);
    expect(JSON.stringify(filtered)).not.toContain("delete_everything");
  });

  it("lets deny win over allow, so an explicit withholding cannot be undone by an allowlist", () => {
    expect(isToolAllowed("x", { allow: ["x"], deny: ["x"] })).toBe(false);
  });

  it("admits an unreviewed tool by default, and withholds it under a deny fallback", () => {
    expect(isToolAllowed("added_last_week", { allow: ["read_file"] })).toBe(true);
    expect(isToolAllowed("added_last_week", { allow: ["read_file"], fallback: "deny" })).toBe(false);
  });

  it("answers a withheld tool exactly as a server answers a name it never had", () => {
    // The error is the obfuscation: "disabled here" and "does not exist" must be
    // indistinguishable from inside the conversation.
    const error = unknownToolError("delete_everything");
    expect(error).toEqual({ ok: false, error: "MCP error -32602: Unknown tool: delete_everything" });
    expect(error.error).not.toMatch(/disabl|withheld|denied|permission|blocked/i);
  });
});
