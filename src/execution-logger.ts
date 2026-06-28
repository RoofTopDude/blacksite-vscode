import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { AgentEvent } from "./agent-session.js";

// ── ExecutionLogger ────────────────────────────────────────────────────────────
//
// Writes a structured execution log to two sinks simultaneously:
//   1. A VS Code OutputChannel ("Blacksite Agent") — live in the Output panel,
//      can be opened, searched, and saved via the built-in VS Code UI.
//   2. .blacksite/execution.log — append-only flat file; survives restarts and
//      can be opened / exported from the Settings → Execution Logs panel.
//
// logEvent() handles every AgentEvent type. High-volume deltas (text_delta,
// thinking_delta) are intentionally skipped to keep logs readable.

export interface LogStats {
  turnCount: number;
  logPath:   string;
}

export class ExecutionLogger {
  private readonly _channel:   vscode.OutputChannel;
  private readonly _logPath:   string;
  private _logStream: fs.WriteStream | null = null;
  private _turnCount = 0;

  constructor(workspaceRoot: string, context: vscode.ExtensionContext) {
    this._channel = vscode.window.createOutputChannel("Blacksite Agent");
    context.subscriptions.push({ dispose: () => this.dispose() });
    this._logPath = path.join(workspaceRoot, ".blacksite", "execution.log");
    this._openStream();
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _openStream(): void {
    try {
      const dir = path.dirname(this._logPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this._logStream = fs.createWriteStream(this._logPath, { flags: "a" });
    } catch { /* non-fatal — channel still works without file sink */ }
  }

  private _ts(): string {
    // ISO 8601 with space separator and ms precision: "2026-06-28 14:23:01.456"
    return new Date().toISOString().replace("T", " ").slice(0, 23);
  }

  private _write(line: string): void {
    const full = `[${this._ts()}] ${line}`;
    this._channel.appendLine(full);
    if (this._logStream?.writable) {
      this._logStream.write(`${full}\n`);
    }
  }

  // ── Structural markers ───────────────────────────────────────────────────────

  sessionStart(sessionId: string, model: string, provider: string): void {
    const bar = "═".repeat(64);
    this._write(bar);
    this._write(`SESSION  ${sessionId.slice(-8)}  |  ${provider} / ${model}`);
    this._write(bar);
  }

  turnStart(turnId: string): void {
    this._turnCount++;
    this._write(`─── TURN ${this._turnCount}  (${turnId}) ─────────────────────────────`);
  }

  turnEnd(turnId: string, ok: boolean, error?: string): void {
    if (!ok && error) {
      this._write(`─── END   ${turnId}  |  ✗ ${error.slice(0, 120)}`);
    } else {
      this._write(`─── END   ${turnId}  |  ✓ OK`);
    }
  }

  // ── Event logging ────────────────────────────────────────────────────────────

  logEvent(event: AgentEvent, lanePrefix?: string): void {
    const p = lanePrefix ? `[${lanePrefix}] ` : "";
    switch (event.type) {
      case "iteration_start":
        this._write(`${p}▶ Iteration #${event.iteration}`);
        break;

      case "text_delta":
      case "thinking_delta":
        // Too verbose for a structured log — skipped.
        break;

      case "usage_update":
        this._write(
          `${p}◆ Tokens  in=${event.inputTokens}  out=${event.outputTokens}` +
          `  cacheR=${event.cacheReadTokens}  cacheW=${event.cacheWriteTokens}`,
        );
        break;

      case "tool_call_start":
        this._write(
          `${p}⚙  ${event.toolName.padEnd(22)} [${event.toolCallId.slice(-6)}]` +
          `  ${event.inputPreview.replace(/\s+/g, " ").slice(0, 150)}`,
        );
        break;

      case "tool_call_result": {
        const icon = event.ok ? "✓" : "✗";
        this._write(
          `${p}${icon}  ${event.toolName.padEnd(22)} [${event.toolCallId.slice(-6)}]` +
          `  (${event.elapsedMs}ms)  ${event.summary.slice(0, 100)}`,
        );
        if (!event.ok && event.result) {
          const errMsg = typeof event.result === "object" && event.result !== null &&
            "error" in event.result
            ? String((event.result as Record<string, unknown>)["error"])
            : JSON.stringify(event.result).slice(0, 200);
          this._write(`${p}    ⚠  ${errMsg}`);
        }
        break;
      }

      case "execution_diagnostic":
        this._write(`${p}[${event.level.toUpperCase().padEnd(5)}] ${event.message}`);
        break;

      case "approval_pending":
        this._write(
          `${p}⚠  Approval pending  [tier:${event.tier}]` +
          `  ${event.description.slice(0, 100)}`,
        );
        break;

      case "approval_result":
        this._write(`${p}   → ${event.granted ? "Granted" : "Denied"}`);
        break;

      case "question_card_pending":
        this._write(`${p}?  Question: ${event.question.slice(0, 100)}`);
        break;

      case "question_card_result":
        this._write(`${p}   → Selected: "${event.selectedKey}"`);
        break;

      case "turn_complete":
        this._write(`${p}■  Complete  stopReason=${event.stopReason}  iter=${event.iterations}`);
        break;

      case "error":
        this._write(`${p}✗  ERROR: ${event.message}`);
        break;

      // ── Subagent / delegated lane events ──────────────────────────────────────

      case "subagent_lane_start":
        this._write(
          `[LANE:${event.laneId.slice(-6)}] ▶ Started  "${event.label}"  ` +
          `task: ${event.task.replace(/\s+/g, " ").slice(0, 80)}`,
        );
        break;

      case "subagent_lane_event":
        // Recurse with lane prefix so every child event is labelled.
        this.logEvent(event.event, `LANE:${event.laneId.slice(-6)}`);
        break;

      case "subagent_lane_complete":
        this._write(
          `[LANE:${event.laneId.slice(-6)}] ${event.ok ? "✓" : "✗"}  "${event.label}"` +
          `  ${event.ok ? "OK" : (event.error ?? "failed")}` +
          `  (${event.elapsedMs}ms, ${event.toolRounds} rounds)`,
        );
        break;
    }
  }

  // ── Public accessors ─────────────────────────────────────────────────────────

  get stats(): LogStats {
    return { turnCount: this._turnCount, logPath: this._logPath };
  }

  /** Open the Output panel to show the Blacksite Agent channel. */
  show(): void {
    // preserveFocus = true so the editor doesn't lose focus.
    this._channel.show(true);
  }

  getLogPath(): string {
    return this._logPath;
  }

  clear(): void {
    this._channel.clear();
  }

  dispose(): void {
    try { this._logStream?.end(); } catch { /* ignore */ }
    this._logStream = null;
    this._channel.dispose();
  }
}
