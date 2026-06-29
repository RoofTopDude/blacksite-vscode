import type * as vscode from "vscode";
import type { PersistedSessionState, SessionMessage } from "./session-state.js";

export interface Checkpoint {
  sessionId: string;
  iteration: number;
  model: string;
  workspaceRoot: string;
  messages: SessionMessage[];
  state?: PersistedSessionState;
  createdAt: number;
  updatedAt: number;
}

const KEY = "blacksite.checkpoint.active";

export function saveCheckpoint(ctx: vscode.ExtensionContext, cp: Checkpoint): void {
  void ctx.workspaceState.update(KEY, cp);
}

export function loadCheckpoint(ctx: vscode.ExtensionContext): Checkpoint | undefined {
  return ctx.workspaceState.get<Checkpoint>(KEY);
}

export function clearCheckpoint(ctx: vscode.ExtensionContext): void {
  void ctx.workspaceState.update(KEY, undefined);
}

export function hasCheckpoint(ctx: vscode.ExtensionContext): boolean {
  return ctx.workspaceState.get(KEY) !== undefined;
}
