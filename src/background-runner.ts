import * as vscode from "vscode";
import type { AgentSession, AgentEvent, TurnOrigin } from "./agent-session.js";
import type { PlanRunView } from "./plans/plan-run-model.js";
import { presentRun } from "./plans/run-status-text.js";
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
  /** What the user actually typed, when this run answers a user message. See AgentSession.send. */
  userText?: string;
  /** Image attachments left out because the model is not vision-capable. See AgentSession.send. */
  withheldImages?: number;
  /** Who started the turn. See AgentSession.send. */
  origin?: TurnOrigin;
}

/** How often the status bar item is redrawn while a plan run is open, so its clock keeps moving. */
const RUN_REFRESH_MS = 30_000;

/**
 * Runs agent turns and owns the status bar item.
 *
 * The item tells the truth about the run, not just the turn: while a plan run is open it shows
 * where the plan is and what the run needs ("7/23 · 42m", "Needs you", "Plan done"), and it stays
 * after the run ends until someone has looked. Clicking it opens Blacksite — it never cancels a
 * run. Stopping is a deliberate act (the run bar, or the Stop command), because a click on an
 * item that says "approval needed" must not be the thing that throws the work away.
 */
export class BackgroundRunner {
  private statusBarItem: vscode.StatusBarItem;
  private abortController: AbortController | null = null;
  private isRunning = false;
  /** What the current turn is doing, shown when no plan run is open. */
  private _activity: { icon: string; text: string } | undefined;
  private _runView: PlanRunView | null = null;
  /** The run (and its end state) whose result the user has already seen. */
  private _acknowledged: string | undefined;
  private _refreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = "blacksite.showRun";
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
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this.statusBarItem.dispose();
  }

  /** The plan run changed. Called with null when there is none. */
  setRunView(view: PlanRunView | null): void {
    this._runView = view;
    const open = !!view && presentRun(view).ended === false;
    if (open && !this._refreshTimer) {
      this._refreshTimer = setInterval(() => this._render(), RUN_REFRESH_MS);
    } else if (!open && this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = undefined;
    }
    this._render();
  }

  /** The user has seen how the run ended; the item can go. */
  acknowledgeRun(): void {
    const view = this._runView;
    if (!view) return;
    const presentation = presentRun(view);
    if (!presentation.ended) return;
    this._acknowledged = `${view.id}:${view.status}`;
    this._render();
  }

  private _render(): void {
    const view = this._runView;
    if (view) {
      const presentation = presentRun(view);
      const seen = presentation.ended && this._acknowledged === `${view.id}:${view.status}`;
      if (!seen) {
        this.statusBarItem.text = `${presentation.icon} ${presentation.text}`;
        this.statusBarItem.tooltip = presentation.tooltip;
        this.statusBarItem.backgroundColor = presentation.pressing
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
        this.statusBarItem.show();
        return;
      }
    }
    this.statusBarItem.backgroundColor = undefined;
    if (this.isRunning && this._activity) {
      this.statusBarItem.text = `${this._activity.icon} ${this._activity.text}`;
      this.statusBarItem.tooltip = "Blacksite is working. Click to open it.";
      this.statusBarItem.show();
      return;
    }
    this.statusBarItem.hide();
  }

  private _setActivity(icon: string, text: string): void {
    this._activity = { icon, text };
    this._render();
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
    this._setActivity("$(loading~spin)", title);

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
            userText: options.userText,
            withheldImages: options.withheldImages,
            origin: options.origin,
          })) {
            onEvent(event);

            if (event.type === "iteration_start") {
              iteration = event.iteration;
              progress.report({ message: `turn ${iteration}` });
              this._setActivity("$(loading~spin)", `${title} — turn ${iteration}`);
            } else if (event.type === "tool_call_start") {
              progress.report({ message: `${event.toolName}…` });
              this._setActivity("$(loading~spin)", `${title} — ${event.toolName}`);
            } else if (event.type === "question_card_pending") {
              progress.report({ message: "waiting for your response" });
              this._setActivity("$(comment)", `${title} — question`);
            } else if (event.type === "approval_pending") {
              progress.report({ message: "waiting for approval" });
              this._setActivity("$(warning)", `${title} — approval needed`);
            } else if (event.type === "subagent_lane_start") {
              progress.report({ message: `delegated lane — ${event.label}` });
              this._setActivity("$(loading~spin)", `${title} — ${event.label}`);
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
      this._activity = undefined;
      this._render();
    }
  }
}
