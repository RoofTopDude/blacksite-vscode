/* The smallest useful loop on top of @blacksite-agent/llm: send, run any tool calls, send their
   results back, until the model answers. Everything provider-specific is the SDK's job. */
import {
  assistantMessageFromTurn,
  planThinking,
  ProviderTurnRunner,
  resolveOutputCeiling,
  type AgentMessage,
  type ModelRequest,
  type ModelTransport,
  type ProviderName,
  type ProviderTurnResult,
  type ProviderTurnStreamEvent,
  type ToolResultBlock,
} from "@blacksite-agent/llm";
import type { CliTool } from "./tools.js";

export interface ConversationOptions {
  transport: ModelTransport;
  provider: ProviderName;
  /** Names the provider in retry and activity messages. */
  label: string;
  model: string;
  system: string;
  tools: CliTool[];
  thinking: boolean;
  maxTokens: number;
  /** Tool rounds allowed per message before the loop stops. */
  maxRounds?: number;
}

export interface SendResult {
  /** Every round's result, in order; the last one is the answer. */
  rounds: ProviderTurnResult[];
  toolCalls: Array<{ name: string; input: Record<string, unknown>; output: string; error?: boolean }>;
}

export class Conversation {
  readonly messages: AgentMessage[] = [];
  private readonly runner = new ProviderTurnRunner();
  private readonly conversationId = `cli_${Date.now().toString(36)}`;
  private turns = 0;

  constructor(private readonly options: ConversationOptions) {}

  async send(text: string, onEvent: (event: ProviderTurnStreamEvent) => void, signal?: AbortSignal): Promise<SendResult> {
    const { maxRounds = 8 } = this.options;
    const result: SendResult = { rounds: [], toolCalls: [] };
    this.messages.push({ role: "user", content: text });
    for (let round = 0; round < maxRounds; round++) {
      const request = this.request();
      const turn = await this.runner.run(() => this.options.transport.stream(request, signal), { emit: onEvent }, {
        signal,
        label: this.options.label,
        model: this.options.model,
      });
      result.rounds.push(turn);
      this.messages.push(assistantMessageFromTurn(turn));
      if (turn.toolCalls.length === 0) return result;
      const outputs: ToolResultBlock[] = [];
      for (const call of turn.toolCalls) {
        const tool = this.options.tools.find((candidate) => candidate.schema.name === call.name);
        let output: string;
        let error = false;
        try {
          if (!tool) throw new Error(`No tool named ${call.name}`);
          output = await tool.run(call.input);
        } catch (err) {
          output = `Error: ${err instanceof Error ? err.message : String(err)}`;
          error = true;
        }
        result.toolCalls.push({ name: call.name, input: call.input, output, ...(error ? { error } : {}) });
        outputs.push({ type: "tool_result", tool_use_id: call.id, content: output });
      }
      this.messages.push({ role: "user", content: outputs });
    }
    return result;
  }

  private request(): ModelRequest {
    const { model, provider } = this.options;
    return {
      model,
      system: this.options.system,
      systemSummary: "",
      contextTail: "",
      messages: this.messages,
      tools: { wire: this.options.tools.map((tool) => tool.schema), deferred: new Set() },
      thinking: planThinking({
        model,
        provider,
        configuredMaxTokens: this.options.maxTokens,
        ceiling: resolveOutputCeiling(model, provider) ?? null,
        thinkingEnabled: this.options.thinking,
        budgetTokens: Math.min(8_000, Math.floor(this.options.maxTokens / 2)),
        effort: undefined,
        temperature: undefined,
      }),
      conversationId: this.conversationId,
      turnIndex: this.turns++,
    };
  }
}
