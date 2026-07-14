import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { AgentEvent } from "./agent-session.js";
import {
  buildPromptPreview,
  createSessionStartEntry,
  createStructuredEventEntry,
  createTurnEndEntry,
  createTurnStartEntry,
  type TurnLogMetadata,
} from "./execution-log-format.js";

// ExecutionLogger
//
// Writes execution telemetry to three sinks simultaneously:
//   1. A VS Code OutputChannel ("Blacksite Agent") for live inspection.
//   2. .blacksite/execution.log for a compact human-readable audit trail.
//   3. .blacksite/execution.jsonl for machine-readable postmortem analysis.
//
// logEvent() handles every AgentEvent type. High-volume deltas (text_delta,
// thinking_delta) are intentionally skipped to keep logs readable.

export interface LogStats {
  turnCount: number;
  logPath: string;
  structuredLogPath: string;
}

export class ExecutionLogger {
  private readonly _channel: vscode.OutputChannel;
  private readonly _workspaceRoot: string;
  private readonly _logPath: string;
  private readonly _structuredLogPath: string;
  private _logStream: fs.WriteStream | null = null;
  private _structuredLogStream: fs.WriteStream | null = null;
  private _turnCount = 0;
  private _sessionId: string | undefined;
  private _provider: string | undefined;
  private _model: string | undefined;
  private _activeTurnId: string | undefined;
  private _turnStartedAt = new Map<string, number>();

  constructor(workspaceRoot: string, context: vscode.ExtensionContext) {
    this._workspaceRoot = workspaceRoot;
    this._channel = vscode.window.createOutputChannel("Blacksite Agent");
    context.subscriptions.push({ dispose: () => this.dispose() });
    this._logPath = path.join(workspaceRoot, ".blacksite", "execution.log");
    this._structuredLogPath = path.join(workspaceRoot, ".blacksite", "execution.jsonl");
    this._openStream();
  }

  private _openStream(): void {
    try {
      const dir = path.dirname(this._logPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this._logStream = fs.createWriteStream(this._logPath, { flags: "a", encoding: "utf8" });
      this._structuredLogStream = fs.createWriteStream(this._structuredLogPath, { flags: "a", encoding: "utf8" });
    } catch { /* non-fatal - channel still works without file sinks */ }
  }

  private _ts(): string {
    return new Date().toISOString().replace("T", " ").slice(0, 23);
  }

  private _write(line: string): void {
    const full = `[${this._ts()}] ${line}`;
    this._channel.appendLine(full);
    if (this._logStream?.writable) this._logStream.write(`${full}\n`);
  }

  private _writeStructured(entry: unknown): void {
    if (!this._structuredLogStream?.writable) return;
    this._structuredLogStream.write(`${JSON.stringify(entry)}\n`);
  }

  private _context(ts = this._ts(), turnId = this._activeTurnId): {
    ts: string;
    sessionId?: string;
    provider?: string;
    model?: string;
    workspaceRoot: string;
    turnId?: string;
    turnCount: number;
  } {
    return {
      ts,
      sessionId: this._sessionId,
      provider: this._provider,
      model: this._model,
      workspaceRoot: this._workspaceRoot,
      turnId,
      turnCount: this._turnCount,
    };
  }

  sessionStart(sessionId: string, model: string, provider: string): void {
    this._sessionId = sessionId;
    this._provider = provider;
    this._model = model;

    const bar = "═".repeat(64);
    this._write(bar);
    this._write(`SESSION  ${sessionId.slice(-8)}  |  ${provider} / ${model}`);
    this._write(`ROOT     ${this._workspaceRoot}`);
    this._write(bar);
    this._writeStructured(createSessionStartEntry(this._context()));
  }

  turnStart(turnId: string, meta?: TurnLogMetadata): void {
    this._turnCount++;
    this._activeTurnId = turnId;
    this._turnStartedAt.set(turnId, Date.now());
    this._write(`─── TURN ${this._turnCount}  (${turnId}) ─────────────────────────────`);

    if (!meta) return;

    const promptParts = [
      `chars=${meta.inputChars}`,
      `mentions=${meta.mentionCount ?? 0}`,
    ];
    if (meta.contextLabel) promptParts.push(`context=${meta.contextLabel}`);
    this._write(`PROMPT   ${promptParts.join("  ")}  ${buildPromptPreview(meta.promptPreview)}`);
    this._writeStructured(createTurnStartEntry(this._context(this._ts(), turnId), meta));
  }

  turnEnd(turnId: string, ok: boolean, error?: string): void {
    const startedAt = this._turnStartedAt.get(turnId);
    const elapsedMs = startedAt ? Math.max(Date.now() - startedAt, 0) : 0;
    this._turnStartedAt.delete(turnId);

    if (!ok && error) {
      this._write(`─── END   ${turnId}  |  ✗ ${buildPromptPreview(error, 120)}  (${elapsedMs}ms)`);
    } else {
      this._write(`─── END   ${turnId}  |  ✓ OK  (${elapsedMs}ms)`);
    }

    this._writeStructured(createTurnEndEntry(this._context(this._ts(), turnId), ok, elapsedMs, error));
    if (this._activeTurnId === turnId) this._activeTurnId = undefined;
  }

  logEvent(event: AgentEvent, lanePrefix?: string): void {
    const p = lanePrefix ? `[${lanePrefix}] ` : "";
    // Text/thinking deltas can arrive dozens of times per second. They are not
    // useful in the audit log (the final assistant message is persisted at turn
    // end), and serializing/writing every token can starve the extension host
    // precisely when the final response starts streaming.
    if (event.type !== "text_delta" && event.type !== "thinking_delta") {
      this._writeStructured(createStructuredEventEntry(this._context(), event, lanePrefix));
    }

    switch (event.type) {
      case "iteration_start":
        this._write(`${p}▶ Iteration #${event.iteration}`);
        break;

      case "text_delta":
      case "thinking_delta":
        break;

      case "usage_update":
        this._write(
          `${p}◆ Tokens  in=${event.inputTokens}  out=${event.outputTokens}` +
          `  cacheR=${event.cacheReadTokens}  cacheW=${event.cacheWriteTokens}`,
        );
        break;

      case "runtime_state":
        this._write(
          `${p}◌ Runtime  ctx=${event.state.usagePct == null ? "n/a" : `${Math.round(event.state.usagePct)}%`}` +
          `  compact=${event.state.compressionCount}` +
          `${event.state.isCompacting ? "  [compacting]" : ""}`,
        );
        break;

      case "tool_call_start":
        this._write(
          `${p}⚙  ${event.toolName.padEnd(22)} [${event.toolCallId.slice(-6)}]` +
          `  ${buildPromptPreview(event.inputPreview, 150)}`,
        );
        break;

      case "tool_call_result": {
        const icon = event.ok ? "✓" : "✗";
        this._write(
          `${p}${icon}  ${event.toolName.padEnd(22)} [${event.toolCallId.slice(-6)}]` +
          `  (${event.elapsedMs}ms)  ${buildPromptPreview(event.summary, 100)}`,
        );
        if (!event.ok && event.result) {
          const errMsg = typeof event.result === "object" && event.result !== null &&
            "error" in event.result
            ? String((event.result as Record<string, unknown>)["error"])
            : JSON.stringify(event.result).slice(0, 200);
          this._write(`${p}    ⚠  ${buildPromptPreview(errMsg, 200)}`);
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
        this._write(`${p}   → ${event.granted ? "Granted" : "Denied"}  [${event.toolCallId.slice(-6)}]`);
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
        this._write(`${p}✗  ERROR: ${buildPromptPreview(event.message, 200)}`);
        break;

      case "subagent_lane_start":
        this._write(
          `[LANE:${event.laneId.slice(-6)}] ▶ Started  "${event.label}"  ` +
          `task: ${event.task.replace(/\s+/g, " ").slice(0, 80)}`,
        );
        break;

      case "subagent_lane_event":
        this.logEvent(event.event, `LANE:${event.laneId.slice(-6)}`);
        break;

      case "subagent_lane_complete":
        this._write(
          `[LANE:${event.laneId.slice(-6)}] ${event.ok ? "✓" : "✗"}  "${event.label}"` +
          `  ${event.ok ? "OK" : (event.error ?? "failed")}` +
          `  (${event.elapsedMs}ms, ${event.toolRounds} rounds)`,
        );
        break;

      default: {
        // A new AgentEvent variant reaches the structured sink above but would vanish from the
        // readable log with no error at all — the gap only surfaces when someone is reading a log
        // to explain an outage. Fail the build instead: this assignment stops compiling the moment
        // a variant is added or renamed without a case here.
        const unhandled: never = event;
        void unhandled;
        break;
      }
    }
  }

  get stats(): LogStats {
    return {
      turnCount: this._turnCount,
      logPath: this._logPath,
      structuredLogPath: this._structuredLogPath,
    };
  }

  show(): void {
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
    try { this._structuredLogStream?.end(); } catch { /* ignore */ }
    this._logStream = null;
    this._structuredLogStream = null;
    this._channel.dispose();
  }
}
