/* Command-palette flows for MCP that are not the server panel itself: importing servers another
 * client already has, and bringing a server's prompts and resources into the chat.
 *
 * Prompts and resources are things a *person* picks (MCP calls them user-controlled and
 * application-controlled), so they arrive as attached context on the next message rather than as
 * something the agent fetches on its own. The agent has mcp_read_resource for the other case. */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { getMcpPrompt, listMcpPrompts, listMcpResources, readMcpResource, type McpServer } from "@blacksite/local-runtime";
import { importSources, readImportSource, type ImportCandidate } from "./mcp-import.js";
import type { McpRegistry } from "./mcp-registry.js";

/** VS Code's user folder (where settings.json and mcp.json live), from the extension's global
 *  storage path: <User>/globalStorage/<publisher.name>. */
function vscodeUserDir(context: vscode.ExtensionContext): string | undefined {
  const storage = context.globalStorageUri?.fsPath;
  return storage ? path.resolve(storage, "..", "..") : undefined;
}

function readIfPresent(file: string): string | undefined {
  try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
}

function describeTarget(candidate: ImportCandidate): string {
  const entry = candidate.entry;
  if (entry.transport === "http") return entry.url ?? "";
  return [entry.command, ...(entry.args ?? [])].filter(Boolean).join(" ");
}

/**
 * Find servers in other clients' config files and add the ones the user picks.
 *
 * Every candidate is shown with its full command line or URL, because a repository's
 * .vscode/mcp.json or .mcp.json can name any program; picking it is the trust decision. Servers
 * already configured here (same transport and target) are listed as such and not offered again.
 */
export async function importMcpServers(registry: McpRegistry, context: vscode.ExtensionContext, roots: string[]): Promise<number> {
  const sources = importSources({
    platform: process.platform,
    home: os.homedir(),
    appData: process.env["APPDATA"],
    vscodeUserDir: vscodeUserDir(context),
    workspaceRoots: roots,
  });
  const candidates: ImportCandidate[] = [];
  const problems: string[] = [];
  for (const source of sources) {
    const { candidates: found, error } = readImportSource(source, readIfPresent);
    candidates.push(...found);
    if (error) problems.push(error);
  }
  // VS Code before mcp.json kept servers under the `mcp` setting.
  const legacy = vscode.workspace.getConfiguration("mcp").inspect<Record<string, unknown>>("servers")?.globalValue;
  if (legacy && typeof legacy === "object") {
    const { candidates: found } = readImportSource(
      { label: "VS Code (user settings)", file: "settings.json", format: "vscode" },
      () => JSON.stringify({ servers: legacy }),
    );
    candidates.push(...found);
  }

  if (!candidates.length) {
    const searched = sources.map((source) => source.label).filter((label, index, all) => all.indexOf(label) === index).join(", ");
    void vscode.window.showInformationMessage(
      `No MCP servers found to import. Looked in: ${searched}.${problems.length ? ` ${problems.join(" ")}` : ""}`,
    );
    return 0;
  }

  type Item = vscode.QuickPickItem & { candidate?: ImportCandidate };
  const items: Item[] = [];
  let lastSource = "";
  for (const candidate of candidates) {
    if (candidate.source !== lastSource) {
      items.push({ label: candidate.source, kind: vscode.QuickPickItemKind.Separator });
      lastSource = candidate.source;
    }
    const duplicate = registry.findDuplicate(candidate.entry);
    const secretNote = candidate.secrets.length
      ? ` · ${candidate.secrets.length} credential${candidate.secrets.length === 1 ? "" : "s"} moved to secure storage`
      : "";
    const missingNote = candidate.missingSecrets.length ? ` · asks for ${candidate.missingSecrets.join(", ")}` : "";
    items.push({
      label: candidate.name,
      description: duplicate ? `already added as "${duplicate.name}"` : candidate.entry.transport === "http" ? "remote" : "local process",
      detail: `${describeTarget(candidate)}${secretNote}${missingNote}`,
      candidate: duplicate ? undefined : candidate,
    });
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: "Import MCP servers",
    placeHolder: "Pick servers to add. Each one is started exactly as shown, with your user rights.",
    canPickMany: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  const chosen = (picked ?? []).map((item) => item.candidate).filter((candidate): candidate is ImportCandidate => !!candidate);
  if (!chosen.length) return 0;

  const scope = await vscode.window.showQuickPick(
    [
      { label: "All projects", description: "Recommended", detail: "Saved in your user settings. Available in every folder you open.", value: "user" as const },
      { label: "This project only", detail: "Saved with this workspace. Other projects will not see it.", value: "workspace" as const },
    ],
    { title: "Where should the imported servers be available?", ignoreFocusOut: true },
  );
  if (!scope) return 0;

  const needsSecrets: string[] = [];
  for (const candidate of chosen) {
    const entry = await registry.addEntry(candidate.entry, scope.value);
    for (const secret of candidate.secrets) {
      if (secret.kind === "env") await registry.setEnvSecret(entry.id, secret.name, secret.value);
      else await registry.setStaticSecret(entry.id, secret.value);
    }
    if (candidate.missingSecrets.length) needsSecrets.push(`${candidate.name} (${candidate.missingSecrets.join(", ")})`);
  }
  const summary = `Imported ${chosen.length} MCP server${chosen.length === 1 ? "" : "s"}. Their tools are being discovered in the background.`;
  const action = await vscode.window.showInformationMessage(
    needsSecrets.length ? `${summary} Still needs a value: ${needsSecrets.join("; ")}.` : summary,
    "Manage MCP Servers",
  );
  if (action) void vscode.commands.executeCommand("blacksite.manageMcp");
  return chosen.length;
}

/** Enabled servers resolved for a person-initiated request (prompts, resources). */
async function resolvedServers(registry: McpRegistry): Promise<Array<{ id: string; name: string; server: McpServer }>> {
  const out: Array<{ id: string; name: string; server: McpServer }> = [];
  for (const entry of registry.enabledEntries()) {
    const resolved = await registry.resolveForAgent(entry.id);
    if (resolved.ok) out.push({ id: entry.id, name: entry.name, server: resolved.server });
  }
  return out;
}

/** Pick a prompt from any enabled server, fill in its arguments, and attach the expanded text to
 *  the next chat message. */
export async function useMcpPrompt(registry: McpRegistry, attach: (text: string, label: string) => void): Promise<void> {
  const servers = await resolvedServers(registry);
  if (!servers.length) {
    void vscode.window.showInformationMessage("No enabled MCP server is ready. Add or sign in to one with Blacksite: Manage MCP Servers.");
    return;
  }
  const listed = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Asking MCP servers for their prompts…" },
    () => Promise.all(servers.map(async (server) => ({ server, result: await listMcpPrompts(server.server) }))),
  );
  type Item = vscode.QuickPickItem & { serverIndex?: number; promptName?: string };
  const items: Item[] = [];
  listed.forEach(({ server, result }, serverIndex) => {
    if (!result.ok || !result.prompts.length) return;
    items.push({ label: server.name, kind: vscode.QuickPickItemKind.Separator });
    for (const prompt of result.prompts) {
      items.push({ label: prompt.title || prompt.name, description: prompt.title ? prompt.name : undefined, detail: prompt.description, serverIndex, promptName: prompt.name });
    }
  });
  if (!items.length) {
    void vscode.window.showInformationMessage("None of your enabled MCP servers offers prompts.");
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { title: "Use an MCP prompt", matchOnDescription: true, matchOnDetail: true });
  if (!picked || picked.serverIndex === undefined || !picked.promptName) return;
  const { server, result } = listed[picked.serverIndex]!;
  const prompt = result.ok ? result.prompts.find((entry) => entry.name === picked.promptName) : undefined;
  const args: Record<string, string> = {};
  for (const argument of prompt?.arguments ?? []) {
    const value = await vscode.window.showInputBox({
      title: `${prompt?.title ?? prompt?.name}: ${argument.name}`,
      prompt: argument.description,
      placeHolder: argument.required ? "Required" : "Optional, leave empty to skip",
      ignoreFocusOut: true,
      validateInput: (text) => (argument.required && !text.trim() ? `${argument.name} is required.` : undefined),
    });
    if (value === undefined) return;
    if (value.trim()) args[argument.name] = value;
  }
  const expanded = await getMcpPrompt(server.server, picked.promptName, args);
  if (!expanded.ok) {
    void vscode.window.showErrorMessage(`Blacksite: ${server.name} could not expand that prompt. ${expanded.error}`);
    return;
  }
  const text = expanded.messages.map((message) => (expanded.messages.length > 1 ? `[${message.role}]\n${message.text}` : message.text)).join("\n\n");
  attach(text, `MCP prompt: ${prompt?.title ?? picked.promptName}`);
  void vscode.commands.executeCommand("blacksite.chat.focus");
}

/** Pick a resource from any enabled server and attach its contents to the next chat message. */
export async function attachMcpResource(registry: McpRegistry, attach: (text: string, label: string) => void): Promise<void> {
  const servers = await resolvedServers(registry);
  if (!servers.length) {
    void vscode.window.showInformationMessage("No enabled MCP server is ready. Add or sign in to one with Blacksite: Manage MCP Servers.");
    return;
  }
  const listed = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Asking MCP servers for their resources…" },
    () => Promise.all(servers.map(async (server) => ({ server, result: await listMcpResources(server.server) }))),
  );
  type Item = vscode.QuickPickItem & { serverIndex?: number; uri?: string; template?: boolean };
  const items: Item[] = [];
  listed.forEach(({ server, result }, serverIndex) => {
    if (!result.ok || (!result.resources.length && !result.templates.length)) return;
    items.push({ label: server.name, kind: vscode.QuickPickItemKind.Separator });
    for (const resource of result.resources.slice(0, 500)) {
      items.push({ label: resource.title || resource.name || resource.uri, description: resource.mimeType, detail: resource.description ?? resource.uri, serverIndex, uri: resource.uri });
    }
    for (const template of result.templates) {
      items.push({ label: `$(symbol-variable) ${template.title || template.name || template.uriTemplate}`, description: "template", detail: template.uriTemplate, serverIndex, uri: template.uriTemplate, template: true });
    }
  });
  if (!items.length) {
    void vscode.window.showInformationMessage("None of your enabled MCP servers publishes resources.");
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { title: "Attach an MCP resource", matchOnDescription: true, matchOnDetail: true });
  if (!picked || picked.serverIndex === undefined || !picked.uri) return;
  let uri = picked.uri;
  if (picked.template) {
    const filled = await vscode.window.showInputBox({
      title: "Fill in the resource address",
      prompt: "Replace each {placeholder} with a value.",
      value: picked.uri,
      ignoreFocusOut: true,
      validateInput: (text) => (/\{[^}]+\}/.test(text) ? "Replace every {placeholder}." : undefined),
    });
    if (!filled) return;
    uri = filled.trim();
  }
  const { server } = listed[picked.serverIndex]!;
  const read = await readMcpResource(server.server, uri);
  if (!read.ok) {
    void vscode.window.showErrorMessage(`Blacksite: ${server.name} could not read ${uri}. ${read.error}`);
    return;
  }
  const parts = read.contents.map((content) => content.text ?? content.binary ?? "");
  if (read.images?.length) parts.push(`[${read.images.length} image${read.images.length === 1 ? "" : "s"} — ask the agent to read this resource with mcp_read_resource to see them]`);
  const text = `Resource ${uri} from MCP server "${server.name}":\n\n${parts.join("\n\n").slice(0, 200_000)}`;
  attach(text, `MCP resource: ${picked.label.replace(/^\$\([^)]+\)\s*/, "")}`);
  void vscode.commands.executeCommand("blacksite.chat.focus");
}
