import * as vscode from "vscode";
import { shouldNotify, type AttentionCenter, type AttentionItem, type NotificationLevel } from "./chat/attention.js";

/** Items the dedicated resume prompt already covers; announcing them twice would only nag. */
const NOT_ANNOUNCED: ReadonlySet<string> = new Set(["run_interrupted"]);

export interface AttentionSurfaceOptions {
  /** How much to interrupt, read on every item so a settings change applies at once. */
  level(): NotificationLevel;
  /** Whether the chat view is on screen right now. */
  chatVisible(): boolean;
  /** Bring the chat forward. */
  showChat(): void;
  /** Tell the user's Notification hooks, so alerts can reach a phone or the desktop. */
  runHook(item: AttentionItem): void;
}

/**
 * The part of the attention center that reaches outside the chat: a toast when the user is away,
 * and the Notification hook. The badge and the status bar are fed by the chat provider, which owns
 * the view and the status bar item.
 *
 * Only an item that is new is announced, and only when the user cannot already see the chat —
 * the point is the person who walked away, not a second copy of what is in front of them.
 */
export class AttentionSurfaces implements vscode.Disposable {
  private readonly _subscription: () => void;

  constructor(private readonly _center: AttentionCenter, private readonly _options: AttentionSurfaceOptions) {
    this._subscription = _center.onChange((items) => this._onChange(items));
  }

  dispose(): void {
    this._subscription();
  }

  private _onChange(items: readonly AttentionItem[]): void {
    for (const item of items) {
      if (NOT_ANNOUNCED.has(item.kind)) continue;
      if (!this._center.markAnnounced(item.id)) continue;
      if (item.source === "run" || item.source === "loop") this._options.runHook(item);
      const ctx = { windowFocused: vscode.window.state.focused, chatVisible: this._options.chatVisible() };
      if (!shouldNotify(item, this._options.level(), ctx)) continue;
      this._toast(item);
    }
  }

  private _toast(item: AttentionItem): void {
    const text = item.detail ? `Blacksite: ${item.title}. ${item.detail}` : `Blacksite: ${item.title}.`;
    const show = (choice: string | undefined): void => {
      if (choice === "Show") this._options.showChat();
    };
    const result = item.severity === "error"
      ? vscode.window.showErrorMessage(text, "Show")
      : item.severity === "needs_you"
        ? vscode.window.showWarningMessage(text, "Show")
        : vscode.window.showInformationMessage(text, "Show");
    void Promise.resolve(result).then(show, () => undefined);
  }
}
