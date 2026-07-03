/* In-process fan-out of agent tool activity. ChatProvider taps its single
   event choke point (_handleAgentEvent) into emitFromAgentEvent(); consumers
   (the Codebase Map) subscribe to onActivity. Agent events carry no wall
   clock, so receipt time is stamped here. */

import * as vscode from "vscode";
import type { AgentEvent } from "./agent-session.js";

export interface ToolActivity {
  at: number;
  phase: "start" | "result";
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  ok?: boolean;
  /** Present when the call ran inside a delegated subagent lane. */
  laneId?: string;
}

export class AgentActivityBus implements vscode.Disposable {
  private readonly _emitter = new vscode.EventEmitter<ToolActivity>();
  readonly onActivity = this._emitter.event;

  dispose(): void {
    this._emitter.dispose();
  }

  emitFromAgentEvent(event: AgentEvent): void {
    let inner: AgentEvent = event;
    let laneId: string | undefined;
    if (event.type === "subagent_lane_event") {
      inner = event.event as AgentEvent;
      laneId = event.laneId;
    }
    if (inner.type === "tool_call_start") {
      this._emitter.fire({
        at: Date.now(),
        phase: "start",
        toolCallId: inner.toolCallId,
        toolName: inner.toolName,
        input: inner.input,
        laneId,
      });
    } else if (inner.type === "tool_call_result") {
      this._emitter.fire({
        at: Date.now(),
        phase: "result",
        toolCallId: inner.toolCallId,
        toolName: inner.toolName,
        ok: inner.ok,
        laneId,
      });
    }
  }
}
