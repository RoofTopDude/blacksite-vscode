import * as vscode from "vscode";
import { isWorkspaceDestination, WORKSPACE_DESTINATIONS, type WorkspaceDestination } from "./shared/workspace-navigation.js";

const peers = new Set<() => void>();

/** Owned by the same view/panel lifecycle as its existing message subscription. */
export function bindWorkspaceUi(webview: vscode.Webview, context: vscode.ExtensionContext): vscode.Disposable {
  const publish = (): void => {
    void webview.postMessage({
      type: "workspace_ui_state",
      density: vscode.workspace.getConfiguration("blacksite").get("interface.density", "comfortable"),
      recent: context.workspaceState.get<WorkspaceDestination[]>("workspace.recent", []).filter(isWorkspaceDestination),
    });
  };
  peers.add(publish);
  const receive = webview.onDidReceiveMessage(async (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const msg = message as Record<string, unknown>;
    try {
      if (msg.type === "workspace_ui_ready") publish();
      if (msg.type === "workspace_density" && (msg.density === "compact" || msg.density === "comfortable")) {
        await vscode.workspace.getConfiguration("blacksite").update("interface.density", msg.density, vscode.ConfigurationTarget.Global);
      }
      if (msg.type === "workspace_navigate" && isWorkspaceDestination(msg.destination)) {
        const current = context.workspaceState.get<WorkspaceDestination[]>("workspace.recent", []).filter(isWorkspaceDestination);
        const source = isWorkspaceDestination(msg.source) ? [msg.source] : [];
        const recent = [...new Set([msg.destination, ...source, ...current])].slice(0, 5);
        await context.workspaceState.update("workspace.recent", recent);
        for (const send of peers) send();
        const destination = WORKSPACE_DESTINATIONS.find((entry) => entry.id === msg.destination)!;
        if (typeof msg.entityId === "string" && msg.entityId.length <= 200 && msg.entityId) {
          if (msg.destination === "plans") await vscode.commands.executeCommand("blacksite.revealPlan", msg.entityId);
          else if (msg.destination === "tickets") await vscode.commands.executeCommand("blacksite.revealTicket", msg.entityId);
          else if (msg.destination === "runs") await vscode.commands.executeCommand("blacksite.openRunTheater", msg.entityId);
          else await vscode.commands.executeCommand(destination.command);
        } else await vscode.commands.executeCommand(destination.command);
      }
    } catch (error) {
      void webview.postMessage({ type: "workspace_ui_error", message: error instanceof Error ? error.message : "Navigation failed. Please try again." });
    }
  });
  const config = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("blacksite.interface.density")) publish();
  });
  return new vscode.Disposable(() => { peers.delete(publish); receive.dispose(); config.dispose(); });
}
