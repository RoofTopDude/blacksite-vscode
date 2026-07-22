import * as vscode from "vscode";
import type { AgentSession, AgentEvent } from "./agent-session.js";
import type { ImageBlock } from "./agent-loop-contract.js";
import type { RequestMode } from "./request-modes.js";

export interface RunOptions {
  title?: string;
  cancellable?: boolean;
  /** User-attached images to include in the user turn as vision blocks. */
  images?: ImageBlock[];
  requestMode?: RequestMode;
  /** Checkpoint continuation keeps the profile that was active when the run paused. */
  preserveRequestMode?: boolean;
}

export class BackgroundRunner {
  private statusBarItem: vscode.StatusBarItem;
  private abortController: AbortController | null = null;
  private isRunning = false;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = "blacksite.cancelRun";
    this.statusBarItem.name = "Blacksite";
  }

  get signal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  get busy(): boolean {
    return this.isRunning;
  }

  cancel(): void {
    this.abortController?.abort();
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }

  async runWithProgress(
    session: AgentSession,
    userContent: string,
    onEvent: (event: AgentEvent) => void,
    options: RunOptions = {},
  ): Promise<void> {
    if (this.isRunning) {
      vscode.window.showWarningMessage("Blacksite is already running a task. Cancel it first.");
      // Throw so the caller's catch block can post stream_error to the webview.
      // Without this, stream_start was already posted but the webview never receives
      // stream_end or stream_error, leaving the send button permanently disabled.
      throw new Error("Another task is already running. Cancel it first.");
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    // The session was constructed before this controller existed — hand it the
    // live signal now so cancellation aborts in-flight fetches and tool calls.
    session.attachSignal(this.abortController.signal);

    const title = options.title ?? "Blacksite";
    this.statusBarItem.text = `$(loading~spin) ${title}`;
    this.statusBarItem.tooltip = "Click to cancel";
    this.statusBarItem.show();

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title,
          cancellable: options.cancellable !== false,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => this.cancel());

          let iteration = 0;
          for await (const event of session.send(userContent, {
            images: options.images,
            requestMode: options.requestMode,
            preserveRequestMode: options.preserveRequestMode,
          })) {
            onEvent(event);

            if (event.type === "iteration_start") {
              iteration = event.iteration;
              progress.report({ message: `turn ${iteration}` });
              this.statusBarItem.text = `$(loading~spin) ${title} — turn ${iteration}`;
            } else if (event.type === "tool_call_start") {
              progress.report({ message: `${event.toolName}…` });
              this.statusBarItem.text = `$(loading~spin) ${title} — ${event.toolName}`;
            } else if (event.type === "question_card_pending") {
              progress.report({ message: "waiting for your response" });
              this.statusBarItem.text = `$(comment) ${title} — question`;
            } else if (event.type === "approval_pending") {
              progress.report({ message: "waiting for approval" });
              this.statusBarItem.text = `$(warning) ${title} — approval needed`;
            } else if (event.type === "subagent_lane_start") {
              progress.report({ message: `delegated lane — ${event.label}` });
              this.statusBarItem.text = `$(loading~spin) ${title} — ${event.label}`;
            } else if (event.type === "subagent_lane_complete") {
              progress.report({ message: event.ok ? "delegated lane complete" : "delegated lane failed" });
            } else if (event.type === "turn_complete") {
              progress.report({ message: "done" });
            }
          }
        },
      );
    } finally {
      this.isRunning = false;
      this.abortController = null;
      this.statusBarItem.hide();
    }
  }
}
