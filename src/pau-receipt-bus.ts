/* In-process fan-out of PAU context-receipt events. ChatProvider taps its single event choke
   point (_handleAgentEvent) into emitFromAgentEvent(); PauMetricsProvider subscribes to
   onReceipt. Mirrors agent-activity-bus.ts's shape exactly — same choke point, same pattern,
   a different narrow event type. */

import * as vscode from "vscode";
import type { AgentEvent } from "./agent-session.js";
import type { PauReceipt } from "./pau-metrics.js";

export interface PauReceiptEvent {
  at: number;
  receipt: PauReceipt;
  /** Present when the receipt came from a delegated subagent lane rather than the parent turn. */
  laneId?: string;
}

export class PauReceiptBus implements vscode.Disposable {
  private readonly _emitter = new vscode.EventEmitter<PauReceiptEvent>();
  readonly onReceipt = this._emitter.event;

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
    if (inner.type === "pau_receipt") {
      this._emitter.fire({ at: Date.now(), receipt: inner.receipt, laneId });
    }
  }
}
