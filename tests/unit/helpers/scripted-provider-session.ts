import type {
  ProviderTurnResult,
  ProviderTurnSession,
  ProviderTurnSink,
  ProviderTurnUsage,
  ToolResultBlock,
  ToolUseBlock,
} from "../../../src/agent-loop-contract.js";
import type { AgentStopReason } from "../../../src/session-state.js";

export interface ScriptedTurn {
  text?: string;
  textDeltas?: string[];
  thinking?: string[];
  toolCalls?: ToolUseBlock[];
  stopReason?: AgentStopReason;
  usage?: ProviderTurnUsage;
  throwError?: string;
}

export interface ScriptedProviderState {
  turnIndex: number;
  userTexts: string[];
  toolResults: ToolResultBlock[][];
}

export type ScriptedTurnFactory = (state: ScriptedProviderState) => ScriptedTurn;

export class ScriptedProviderSession implements ProviderTurnSession {
  private turnIndex = 0;
  readonly userTexts: string[] = [];
  readonly toolResults: ToolResultBlock[][] = [];

  constructor(private readonly turnFactory: ScriptedTurnFactory) {}

  appendUserText(text: string): void {
    this.userTexts.push(text);
  }

  appendToolResults(results: ToolResultBlock[]): void {
    this.toolResults.push(results);
  }

  async runTurn(sink: ProviderTurnSink): Promise<ProviderTurnResult> {
    const turn = this.turnFactory({
      turnIndex: this.turnIndex,
      userTexts: [...this.userTexts],
      toolResults: this.toolResults.map((batch) => [...batch]),
    });
    this.turnIndex += 1;

    if (turn.throwError) throw new Error(turn.throwError);

    const textDeltas = turn.textDeltas ?? (turn.text ? [turn.text] : []);
    for (const delta of textDeltas) sink.emit({ type: "text_delta", text: delta });

    const thinking = turn.thinking ?? [];
    for (const chunk of thinking) {
      sink.emit({ type: "thinking_delta", text: chunk });
      sink.emit({ type: "thinking_block", text: chunk });
    }

    const toolCalls = turn.toolCalls ?? [];
    for (const toolCall of toolCalls) sink.emit({ type: "tool_use_block", block: toolCall });

    const stopReason = turn.stopReason ?? "end_turn";
    sink.emit({ type: "stop_reason", reason: stopReason });
    if (turn.usage) sink.emit({ type: "usage_update", ...turn.usage });

    const text = textDeltas.join("");
    return {
      text,
      thinkingBlocks: thinking.map((chunk) => ({ type: "thinking", thinking: chunk })),
      toolCalls,
      stopReason,
      usage: turn.usage,
      empty: text.trim().length === 0 && thinking.length === 0 && toolCalls.length === 0,
    };
  }

  exportState(): Record<string, unknown> {
    return { turnIndex: this.turnIndex };
  }

  importState(state?: Record<string, unknown>): void {
    this.turnIndex = Number(state?.["turnIndex"] ?? 0);
  }
}

export function createSeededScenario(seed: number, totalTurns: number): ScriptedTurnFactory {
  let value = seed >>> 0;
  const next = (): number => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };

  return ({ turnIndex }) => {
    if (turnIndex >= totalTurns - 1) {
      return {
        text: `seed:${seed}:done:${turnIndex}`,
        stopReason: "end_turn",
        usage: { inputTokens: 88, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    }

    const mode = next();
    if (mode < 0.08) {
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 91, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    }

    const toolName = mode < 0.5 ? "memory_read" : "file_list";
    const input = toolName === "memory_read" ? {} : { path: "." };
    return {
      toolCalls: [{ type: "tool_use", id: `tool-${turnIndex}`, name: toolName, input }],
      stopReason: "tool_use",
      usage: { inputTokens: 92, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  };
}
