/**
 * Commands for the Loops workbench.
 *
 * These intentionally hand off to the retained webview. A loop can spend unattended budget or
 * discard its own history, so it still has explicit confirmation boundaries; they are rendered
 * in the Blacksite surface rather than as mismatched native VS Code dialogs.
 */

import * as vscode from "vscode";
import { loopIdOf, parkedTicketOf, type LoopProvider } from "./loop-view.js";

export function registerLoopCommands(
  context: vscode.ExtensionContext,
  view: LoopProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.loops.create", () => view.openComposer()),

    vscode.commands.registerCommand("blacksite.loops.start", async (node?: unknown) => {
      const loopId = loopIdOf(node);
      if (loopId) await view.requestStart(loopId);
    }),

    vscode.commands.registerCommand("blacksite.loops.pause", (node?: unknown) => {
      const loopId = loopIdOf(node);
      if (loopId) view.pause(loopId);
    }),

    vscode.commands.registerCommand("blacksite.loops.stop", async (node?: unknown) => {
      const loopId = loopIdOf(node);
      if (loopId) await view.requestStop(loopId);
    }),

    vscode.commands.registerCommand("blacksite.loops.releasePark", (node?: unknown) => {
      const parked = parkedTicketOf(node);
      if (parked) view.releasePark(parked.loopId, parked.ticketId);
    }),

    vscode.commands.registerCommand("blacksite.loops.delete", async (node?: unknown) => {
      const loopId = loopIdOf(node);
      if (loopId) await view.requestDelete(loopId);
    }),

    vscode.commands.registerCommand("blacksite.openLoops", () => {
      void vscode.commands.executeCommand("blacksite.loops.focus");
    }),
  );
}
