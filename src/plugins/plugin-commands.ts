/**
 * The user's side of Agent Plugins: installing one, and reviewing, enabling, trusting or removing
 * the ones found. Every decision that lets a plugin run something — its MCP servers — shows the
 * exact command lines and URLs first, and is asked separately from installing or enabling it.
 */

import * as path from "path";
import * as vscode from "vscode";
import type { McpServerEntry, PluginEntryAction } from "../mcp-registry.js";
import type { PluginMcpServer } from "./plugin-manifest.js";
import type { PluginRecord, PluginRegistry } from "./plugin-registry.js";

function describeServer(server: PluginMcpServer): string {
  return server.type === "stdio"
    ? `${server.name}: runs \`${[server.command, ...server.args].join(" ")}\``
    : `${server.name}: connects to ${server.url}`;
}

function summarize(record: PluginRecord): string {
  const plugin = record.plugin;
  if (!plugin) return record.error ?? "Could not be loaded.";
  const parts = [
    plugin.manifest.description ?? "",
    plugin.skillsDir ? "provides skills" : "",
    plugin.mcpServers.length ? `${plugin.mcpServers.length} MCP server${plugin.mcpServers.length === 1 ? "" : "s"}${record.mcpTrusted ? " (allowed)" : " (not allowed to run)"}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * Ask to let a plugin's MCP servers run. Shown with every command and URL, and pinned by the
 * registry to the exact mcp.json on disk, so a later change asks again.
 */
export async function confirmPluginServers(registry: PluginRegistry, record: PluginRecord): Promise<boolean> {
  const servers = record.plugin?.mcpServers ?? [];
  if (!servers.length || !record.plugin?.mcpHash) return false;
  const origin = record.scope === "workspace"
    ? "It comes from this repository, so anyone who can change the repository can change what runs."
    : "It is installed for your user.";
  const choice = await vscode.window.showWarningMessage(
    `Allow the MCP servers of plugin "${record.name}" to run?`,
    {
      modal: true,
      detail: [
        ...servers.map(describeServer),
        "",
        origin,
        "Each tool call still asks for approval. If mcp.json changes, you will be asked again.",
      ].join("\n"),
    },
    "Allow",
  );
  if (choice !== "Allow") return false;
  await registry.trustMcp(record.key);
  return true;
}

export async function installPluginFromFolder(registry: PluginRegistry): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Install plugin",
    title: "Choose an Agent Plugin folder (it contains plugin.json)",
  });
  const source = picked?.[0]?.fsPath;
  if (!source) return;
  let result = registry.install(source);
  if (!result.ok && /already installed/.test(result.error)) {
    const replace = await vscode.window.showWarningMessage(`${result.error} Replace it?`, { modal: true }, "Replace");
    if (replace !== "Replace") return;
    result = registry.install(source, true);
  }
  if (!result.ok) {
    void vscode.window.showErrorMessage(`Blacksite: could not install the plugin. ${result.error}`);
    return;
  }
  const record = registry.find(result.key);
  const warnings = result.plugin.warnings.length ? ` Warnings: ${result.plugin.warnings.join(" ")}` : "";
  void vscode.window.showInformationMessage(`Blacksite: installed plugin "${result.plugin.manifest.name}".${warnings}`);
  if (record && record.plugin?.mcpServers.length) await confirmPluginServers(registry, record);
}

export async function managePlugins(registry: PluginRegistry): Promise<void> {
  const records = registry.list();
  if (!records.length) {
    const action = await vscode.window.showInformationMessage(
      "No Agent Plugins found. Plugins are read from .blacksite/plugins and .agents/plugins in the workspace, and from the same folders in your home directory.",
      "Install From Folder…",
    );
    if (action) await installPluginFromFolder(registry);
    return;
  }
  type Item = vscode.QuickPickItem & { record?: PluginRecord; install?: boolean };
  const items: Item[] = [
    ...records.map((record): Item => ({
      label: `${record.enabled ? "$(check)" : record.error ? "$(error)" : "$(circle-slash)"} ${record.name}`,
      description: record.location,
      detail: summarize(record),
      record,
    })),
    { label: "$(add) Install From Folder…", install: true },
  ];
  const chosen = await vscode.window.showQuickPick(items, { title: "Agent Plugins", matchOnDescription: true, matchOnDetail: true });
  if (!chosen) return;
  if (chosen.install) { await installPluginFromFolder(registry); return; }
  const record = chosen.record!;

  type Action = vscode.QuickPickItem & { run: () => Promise<void> };
  const actions: Action[] = [];
  if (record.plugin) {
    actions.push(record.enabled
      ? { label: "Disable", description: "Its skills and MCP servers stop being offered", run: () => registry.setEnabled(record.key, false) }
      : { label: "Enable", run: () => registry.setEnabled(record.key, true) });
    if (record.plugin.mcpServers.length) {
      actions.push(record.mcpTrusted
        ? { label: "Stop its MCP servers from running", run: () => registry.revokeMcp(record.key) }
        : { label: "Allow its MCP servers to run…", run: async () => { await confirmPluginServers(registry, record); } });
    }
  }
  actions.push({
    label: "Open plugin.json",
    run: async () => { await vscode.window.showTextDocument(vscode.Uri.file(path.join(record.dir, "plugin.json"))); },
  });
  if (record.scope === "user") {
    actions.push({
      label: "Uninstall",
      run: async () => {
        const confirm = await vscode.window.showWarningMessage(`Uninstall plugin "${record.name}"? This deletes ${record.dir}.`, { modal: true }, "Uninstall");
        if (confirm === "Uninstall") await registry.uninstall(record.key);
      },
    });
  }
  const action = await vscode.window.showQuickPick(actions, {
    title: `${record.name} — ${record.location}`,
    placeHolder: record.plugin?.warnings.length ? `Warnings: ${record.plugin.warnings.join(" ")}` : summarize(record),
  });
  await action?.run();
}

/** How the MCP panel's actions on a plugin-provided server are answered (see McpRegistry.setPluginSource). */
export function pluginEntryActionHandler(registry: PluginRegistry): (entry: McpServerEntry, action: PluginEntryAction) => Promise<void> {
  return async (entry, action) => {
    const key = entry.pluginKey;
    if (!key) return;
    if (action.kind === "update" && action.patch.enabled === false) {
      await registry.revokeMcp(key);
      return;
    }
    void vscode.window.showInformationMessage(
      `"${entry.name}" is provided by an Agent Plugin, so it is managed there. Use Blacksite: Manage Plugins to change or remove it.`,
    );
  };
}
