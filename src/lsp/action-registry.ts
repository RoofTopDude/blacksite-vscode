import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

export type RegisteredAction = vscode.CodeAction | vscode.Command;

interface Entry {
  action: RegisteredAction;
  uri: vscode.Uri;
  documentVersion: number;
  createdAt: number;
}

export interface ActionSummary {
  actionId: string;
  title: string;
  kind?: string;
  isPreferred?: boolean;
  disabledReason?: string;
  hasEdit: boolean;
  hasCommand: boolean;
  documentVersion: number;
}

export type ActionResolution =
  | { ok: true; action: RegisteredAction }
  | { ok: false; error: string };

export class ActionRegistry {
  private readonly _entries = new Map<string, Entry>();

  constructor(private readonly _ttlMs = 30_000) {}

  register(actions: readonly RegisteredAction[], uri: vscode.Uri, documentVersion: number): ActionSummary[] {
    this.prune();
    return actions.map((action) => {
      const actionId = randomUUID();
      this._entries.set(actionId, { action, uri, documentVersion, createdAt: Date.now() });
      const codeAction = isCodeAction(action) ? action : undefined;
      return {
        actionId,
        title: action.title,
        kind: codeAction?.kind?.value,
        isPreferred: codeAction?.isPreferred || undefined,
        disabledReason: codeAction?.disabled?.reason,
        hasEdit: !!codeAction?.edit && codeAction.edit.size > 0,
        hasCommand: codeAction ? !!codeAction.command : true,
        documentVersion,
      };
    });
  }

  resolve(actionId: string, uri: vscode.Uri, documentVersion: number): ActionResolution {
    this.prune();
    const entry = this._entries.get(actionId);
    if (!entry) return { ok: false, error: `Code action '${actionId}' expired or was not found. List actions again.` };
    if (entry.uri.toString() !== uri.toString()) return { ok: false, error: "The code action belongs to a different document." };
    if (entry.documentVersion !== documentVersion) {
      this._entries.delete(actionId);
      return { ok: false, error: "The document changed after the code action was listed. List actions again." };
    }
    if (isCodeAction(entry.action) && entry.action.disabled) {
      return { ok: false, error: `Code action is disabled: ${entry.action.disabled.reason}` };
    }
    this._entries.delete(actionId);
    return { ok: true, action: entry.action };
  }

  prune(now = Date.now()): void {
    for (const [id, entry] of this._entries) {
      if (now - entry.createdAt > this._ttlMs) this._entries.delete(id);
    }
  }
}

function isCodeAction(action: RegisteredAction): action is vscode.CodeAction {
  return typeof (action as vscode.Command).command !== "string";
}
