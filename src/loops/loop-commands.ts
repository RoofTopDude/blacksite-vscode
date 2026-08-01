/**
 * Commands for the Loops view.
 *
 * The load-bearing rule here is that **starting a loop is always a user action**, and it is
 * confirmed with the ceilings and the matched ticket count visible. A feature whose premise is
 * "spend money unattended for hours" must never begin as a side effect of anything else.
 */

import * as vscode from "vscode";
import { computeReadySet } from "./loop-scheduler.js";
import { MAX_LOOP_CONCURRENCY, type LoopStore } from "./loop-store.js";
import { defaultQueueSpec, type LoopRecord } from "./loop-model.js";
import { loopIdOf, parkedTicketOf, type LoopTreeProvider } from "./loop-view.js";
import type { LoopSupervisor } from "./loop-supervisor.js";
import type { TicketStore } from "../ticket-store.js";

/** How many tickets a loop may match before the confirmation stops being reassuring. */
const LARGE_QUEUE = 25;

export function registerLoopCommands(
  context: vscode.ExtensionContext,
  store: LoopStore,
  supervisor: LoopSupervisor,
  tree: LoopTreeProvider,
  tickets: TicketStore,
): void {
  const matchedCount = (record: LoopRecord): number => {
    try {
      return computeReadySet({
        tickets: tickets.read().tickets,
        spec: record.definition.queue,
        state: new Map(record.ticketState.map((entry) => [entry.ticketId, entry] as const)),
        inFlight: [],
        indexedFiles: [],
      }).queueSize;
    } catch {
      return 0;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.loops.create", async () => {
      const title = await vscode.window.showInputBox({
        title: "New ticket loop",
        prompt: "What is this loop working through?",
        placeHolder: "Drain the auth backlog",
        validateInput: (value) => (value.trim() ? null : "Give the loop a name."),
      });
      if (!title?.trim()) return;

      const concurrency = await vscode.window.showQuickPick(
        Array.from({ length: MAX_LOOP_CONCURRENCY }, (_, index) => ({
          label: `${index + 1}`,
          description: index === 0
            ? "Sequential — one ticket at a time"
            : `${index + 1} lanes in parallel, on non-overlapping territory`,
        })),
        { title: "How many workers?", placeHolder: "Concurrency" },
      );
      if (!concurrency) return;

      const posture = await vscode.window.showQuickPick([
        { label: "Park on every approval", description: "Nothing runs unattended that would prompt you. Safest.", tiers: [] as string[] },
        { label: "Auto-approve file writes", description: "Writes proceed; network and destructive actions park.", tiers: ["write"] },
        { label: "Auto-approve writes and network", description: "Only destructive actions park.", tiers: ["write", "network"] },
      ], { title: "What may a lane do while nobody is watching?", placeHolder: "Approval posture" });
      if (!posture) return;

      const record = store.create({
        title: title.trim(),
        queue: defaultQueueSpec(),
        workers: { concurrency: Number(concurrency.label) },
        approvals: { autoApproveTiers: posture.tiers, onGate: "park", notify: true },
      });
      tree.refresh();
      void vscode.window.showInformationMessage(
        `Created "${record.definition.title}" as a draft. Start it from the Loops view when you are ready.`,
      );
    }),

    vscode.commands.registerCommand("blacksite.loops.start", async (node?: unknown) => {
      const loopId = loopIdOf(node);
      if (!loopId) return;
      const record = store.get(loopId);
      if (!record) return;

      const matched = matchedCount(record);
      if (!matched) {
        void vscode.window.showInformationMessage("That loop's query does not match any open tickets.");
        return;
      }

      const { ceilings, workers, approvals } = record.definition;
      const detail = [
        `${matched} ticket(s) match this loop's queue.`,
        `${workers.concurrency} worker(s) will run at a time.`,
        approvals.autoApproveTiers.length
          ? `Lanes may proceed through: ${approvals.autoApproveTiers.join(", ")}. Anything else parks.`
          : "Every approval will park its ticket and wait for you.",
        ceilings.maxTickets ? `Stops after ${ceilings.maxTickets} tickets.` : "",
        ceilings.maxUsd ? `Stops at $${ceilings.maxUsd}.` : "",
        `Stops after ${ceilings.maxConsecutiveFailures} consecutive failures.`,
        "",
        // The single most important sentence in this dialog.
        "No ticket will be closed. Completed work is moved to review for you to check.",
        matched > LARGE_QUEUE ? "\nThis is a large queue and may run for a long time." : "",
      ].filter(Boolean).join("\n");

      const choice = await vscode.window.showWarningMessage(
        `Start "${record.definition.title}"?`,
        { modal: true, detail },
        "Start loop",
      );
      if (choice !== "Start loop") return;

      supervisor.start(loopId);
      tree.refresh();
    }),

    vscode.commands.registerCommand("blacksite.loops.pause", (node?: unknown) => {
      const loopId = loopIdOf(node);
      if (loopId) {
        supervisor.pause(loopId);
        tree.refresh();
      }
    }),

    vscode.commands.registerCommand("blacksite.loops.stop", async (node?: unknown) => {
      const loopId = loopIdOf(node);
      if (!loopId) return;
      const choice = await vscode.window.showWarningMessage(
        "Stop this loop? Lanes already running will finish.",
        { modal: true },
        "Stop",
      );
      if (choice !== "Stop") return;
      supervisor.stop(loopId, "Stopped by the user.");
      tree.refresh();
    }),

    vscode.commands.registerCommand("blacksite.loops.releasePark", (node?: unknown) => {
      const parked = parkedTicketOf(node);
      if (!parked) return;
      supervisor.releasePark(parked.loopId, parked.ticketId);
      tree.refresh();
      void vscode.window.showInformationMessage(
        `${parked.ticketId} is dispatchable again. It will be picked up when the loop next runs.`,
      );
    }),

    vscode.commands.registerCommand("blacksite.loops.delete", async (node?: unknown) => {
      const loopId = loopIdOf(node);
      if (!loopId) return;
      const record = store.get(loopId);
      if (!record) return;
      if (supervisor.isRunning(loopId)) {
        void vscode.window.showWarningMessage("Stop the loop before deleting it.");
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete "${record.definition.title}"? Its run history goes with it. Tickets are not affected.`,
        { modal: true },
        "Delete",
      );
      if (choice !== "Delete") return;
      store.delete(loopId);
      tree.refresh();
    }),

    vscode.commands.registerCommand("blacksite.openLoops", () => {
      void vscode.commands.executeCommand("blacksite.loops.focus");
    }),
  );
}
