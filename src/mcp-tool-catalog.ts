/* MCP tools as first-class agent tools.
 *
 * Every MCP tool used to be reached through two untyped proxies, mcp_list_tools and
 * mcp_call_tool: the model saw a server's tool *names* in the workspace block, never their
 * descriptions or argument schemas, so it guessed arguments, was corrected, and guessed again in
 * the next session. Each admitted tool is now its own definition, `mcp__<server>__<tool>`, with
 * the server's own description and input schema. They are deferred like every non-core tool
 * (see agent/tool-loading.ts), so a server with sixty tools costs a roster line until one is
 * needed, and dispatch rewrites a call into the existing mcp.call_tool path — the same resolution,
 * policy, argument check and approval gate as before.
 *
 * Pure: the registry supplies the admitted tools, the session asks for definitions. */

import type { McpToolDescriptor } from "@blacksite/local-runtime";
import type { ToolDefinition } from "./tools/definitions.js";

export const MCP_TOOL_PREFIX = "mcp__";
/** Tool-name limits are 64 characters on every route; the ChatGPT route prefixes `blacksite_`. */
const MAX_NAME = 54;
const MAX_DESCRIPTION = 1200;

export interface McpCatalogInput {
  serverId: string;
  serverName: string;
  tool: McpToolDescriptor;
}

export interface McpTypedTool {
  /** The name the model calls. */
  name: string;
  serverId: string;
  serverName: string;
  /** The tool's own name on its server. */
  toolName: string;
  readOnly: boolean;
  destructive: boolean;
  definition: ToolDefinition;
}

/** Deterministic short hash (FNV-1a), for names that would otherwise collide or overflow. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).slice(0, 4);
}

function slug(text: string, max: number): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max).replace(/_+$/g, "");
}

/** A tool name kept as the server spells it when it is already a valid identifier, so the
 *  model sees `create_issue`, not a mangled form. */
function toolPart(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : slug(name, 48) || shortHash(name);
}

/**
 * The input schema as a provider will accept it: an object at the root, no `$schema` keyword.
 * Everything else is the server's contract and passes through untouched.
 */
export function wireSchema(schema: Record<string, unknown> | undefined): ToolDefinition["input_schema"] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {} };
  const { $schema: _dialect, ...rest } = schema;
  const properties = rest["properties"] && typeof rest["properties"] === "object" && !Array.isArray(rest["properties"])
    ? rest["properties"] as Record<string, unknown>
    : {};
  return { ...rest, type: "object", properties } as ToolDefinition["input_schema"];
}

function describe(serverName: string, tool: McpToolDescriptor, readOnly: boolean, destructive: boolean): string {
  const body = [tool.title && tool.title !== tool.name ? `${tool.title}.` : "", tool.description ?? ""].filter(Boolean).join(" ").trim();
  const hint = readOnly ? " (read-only)" : destructive ? " (destructive)" : "";
  const text = `[MCP server "${serverName}"${hint}] ${body || `The ${tool.name} tool.`}`;
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

export function buildMcpToolCatalog(inputs: readonly McpCatalogInput[]): McpTypedTool[] {
  // Server slugs first, so two servers whose names reduce to the same slug get distinct ones.
  const serverSlugs = new Map<string, string>();
  const taken = new Map<string, string>();
  for (const { serverId, serverName } of inputs) {
    if (serverSlugs.has(serverId)) continue;
    let base = slug(serverName, 20) || slug(serverId, 20) || "server";
    if (taken.has(base) && taken.get(base) !== serverId) base = `${base.slice(0, 15)}_${shortHash(serverId)}`;
    taken.set(base, serverId);
    serverSlugs.set(serverId, base);
  }

  const names = new Set<string>();
  const out: McpTypedTool[] = [];
  for (const { serverId, serverName, tool } of inputs) {
    const prefix = `${MCP_TOOL_PREFIX}${serverSlugs.get(serverId)}__`;
    let name = `${prefix}${toolPart(tool.name)}`;
    if (name.length > MAX_NAME || names.has(name)) {
      const suffix = `_${shortHash(`${serverId}\u0000${tool.name}`)}`;
      name = `${name.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    }
    if (names.has(name)) continue;
    names.add(name);
    const readOnly = tool.annotations?.["readOnlyHint"] === true;
    const destructive = !readOnly && tool.annotations?.["destructiveHint"] === true;
    out.push({
      name,
      serverId,
      serverName,
      toolName: tool.name,
      readOnly,
      destructive,
      definition: {
        name,
        description: describe(serverName, tool, readOnly, destructive),
        input_schema: wireSchema(tool.inputSchema),
        runtimeType: "mcp.call_tool",
      },
    });
  }
  return out;
}

export function isMcpTypedToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}
