/* What the MCP client does beyond listing and calling tools, against a real stdio server:
   it hears a server announce a changed tool list, keeps images for the host, reads resources
   and prompts, and reports what happened to the MCP log. Each of these was missing before 1.32:
   list_changed was dropped, images became "[payload omitted]", and nothing was logged. */

import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  callMcpTool, closeMcpConnections, discoverMcpTools, getMcpPrompt, listMcpPrompts,
  listMcpResources, readMcpResource, setMcpLogger, type McpLogEntry,
} from "../../packages/local-runtime/src/mcp-client.js";

const serverPath = fileURLToPath(new URL("./helpers/fake-stdio-mcp-server.mjs", import.meta.url));
const command = `node "${serverPath}"`;

let counter = 0;
const server = (extra: Record<string, unknown> = {}) => ({
  id: `features-${++counter}`, url: command, label: "Fake", env: { FAKE_MCP_EXTRAS: "1" }, ...extra,
});

afterEach(() => {
  closeMcpConnections();
  setMcpLogger(undefined);
});

describe("server notifications", () => {
  it("tells the host when a server announces a changed tool list", async () => {
    let changed = 0;
    const descriptor = server({ onToolsChanged: () => { changed += 1; } });
    const before = await discoverMcpTools(descriptor);
    if (!before.ok) throw new Error(before.error);
    expect(before.tools.map((tool) => tool.name)).not.toContain("grown_4");

    const grew = await callMcpTool(descriptor, "grow", {});
    expect(grew.ok).toBe(true);
    await expect.poll(() => changed).toBe(1);

    const after = await discoverMcpTools(descriptor);
    if (!after.ok) throw new Error(after.error);
    expect(after.tools.map((tool) => tool.name)).toContain("grown_4");
  });

  it("carries the server's own instructions in its summary", async () => {
    const result = await discoverMcpTools(server());
    if (!result.ok) throw new Error(result.error);
    expect(result.server.instructions).toBe("Use whoami before anything else.");
    expect(result.server.capabilities).toEqual(expect.arrayContaining(["tools", "resources", "prompts"]));
  });
});

describe("images in results", () => {
  it("returns an image beside the redacted content instead of dropping it", async () => {
    const result = await callMcpTool(server(), "screenshot", {});
    if (!result.ok) throw new Error(result.error);
    expect(result.images).toHaveLength(1);
    expect(result.images![0]!.mimeType).toBe("image/png");
    expect(result.images![0]!.data.startsWith("iVBOR")).toBe(true);
  });
});

describe("resources and prompts", () => {
  it("lists resources and templates, and reads text and image contents", async () => {
    const descriptor = server();
    const listed = await listMcpResources(descriptor);
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.supported).toBe(true);
    expect(listed.resources.map((resource) => resource.uri)).toEqual(["fake://readme", "fake://logo"]);
    expect(listed.templates[0]?.uriTemplate).toBe("fake://issues/{number}");

    const text = await readMcpResource(descriptor, "fake://readme");
    if (!text.ok) throw new Error(text.error);
    expect(text.contents[0]?.text).toBe("contents of fake://readme");

    const image = await readMcpResource(descriptor, "fake://logo");
    if (!image.ok) throw new Error(image.error);
    expect(image.contents[0]?.binary).toMatch(/image\/png content/);
    expect(image.images).toHaveLength(1);
  });

  it("reports a server without resources as unsupported rather than failing", async () => {
    const listed = await listMcpResources({ id: `plain-${++counter}`, url: command });
    if (!listed.ok) throw new Error(listed.error);
    expect(listed).toMatchObject({ supported: false, resources: [] });
  });

  it("lists prompts and expands one with its arguments, embedded resources included", async () => {
    const descriptor = server();
    const prompts = await listMcpPrompts(descriptor);
    if (!prompts.ok) throw new Error(prompts.error);
    expect(prompts.prompts[0]).toMatchObject({ name: "review", arguments: [{ name: "path", required: true }] });

    const expanded = await getMcpPrompt(descriptor, "review", { path: "src/a.ts" });
    if (!expanded.ok) throw new Error(expanded.error);
    expect(expanded.messages.map((message) => message.text)).toEqual(["Review src/a.ts", "embedded readme"]);
  });
});

describe("MCP log", () => {
  it("reports the launch, the connection, server stderr and each call — never a credential", async () => {
    const entries: McpLogEntry[] = [];
    setMcpLogger((entry) => entries.push(entry));
    const result = await callMcpTool(server({ env: { FAKE_MCP_EXTRAS: "1", FAKE_MCP_TOKEN: "credential-must-not-appear" } }), "whoami", {});
    expect(result.ok).toBe(true);
    await expect.poll(() => entries.some((entry) => entry.message.includes("[stderr] [fake] started"))).toBe(true);
    const text = entries.map((entry) => entry.message).join("\n");
    expect(entries.every((entry) => entry.server === "Fake")).toBe(true);
    expect(text).toMatch(/Starting /);
    expect(text).toMatch(/Connected over stdio, protocol 2025-06-18, server fake-stdio 1\.0\.0\./);
    expect(text).toMatch(/tools\/call whoami → ok in \d+ ms/);
    expect(text).not.toContain("credential-must-not-appear");
  });

  it("reports a server that cannot start", async () => {
    const entries: McpLogEntry[] = [];
    setMcpLogger((entry) => entries.push(entry));
    const result = await callMcpTool({ id: `missing-${++counter}`, url: "definitely-not-a-real-mcp-binary-xyz", label: "Missing" }, "x", {});
    expect(result.ok).toBe(false);
    expect(entries.some((entry) => entry.level === "error" && /Could not connect/.test(entry.message))).toBe(true);
  });
});
