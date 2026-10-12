/* Turns command-line flags into a ModelTransport: an API-key client, Bedrock on the AWS chain, or
   the ChatGPT subscription through Codex. */
import * as os from "node:os";
import * as path from "node:path";
import { createModelClient, type ModelTransport, type ProviderName } from "@blacksite-agent/llm";
import { ChatGptService, CodexAppServer, createChatGptTransport, resolveBedrockCredentialsFromEnvironment } from "@blacksite-agent/llm/node";

export const PROVIDERS = ["anthropic", "openai", "openrouter", "bedrock", "bedrock-mantle", "chatgpt"] as const;
export type CliProvider = (typeof PROVIDERS)[number];

export interface TransportFlags {
  provider: CliProvider;
  model: string;
  baseUrl?: string;
  reasoningEffort?: string;
  /** OpenAI reasoning models: use the Responses API (replays reasoning across tool calls). */
  responses?: boolean;
  codexPath?: string;
  codexHome?: string;
}

export interface CliTransport {
  transport: ModelTransport;
  /** The provider name the SDK's thinking and token rules key on. */
  provider: ProviderName;
  /** Releases what the transport holds open (the Codex process). */
  close(): void;
}

const KEY_VARIABLES: Partial<Record<CliProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export class UsageError extends Error {}

function apiKeyFor(provider: CliProvider): string {
  const variable = KEY_VARIABLES[provider]!;
  const key = process.env[variable]?.trim();
  if (!key) throw new UsageError(`Set ${variable} to use ${provider}.`);
  return key;
}

export async function openTransport(flags: TransportFlags): Promise<CliTransport> {
  switch (flags.provider) {
    case "anthropic":
    case "openai":
    case "openrouter":
      return {
        provider: flags.provider,
        transport: createModelClient({
          provider: flags.provider,
          apiKey: apiKeyFor(flags.provider),
          baseUrl: flags.baseUrl,
          useResponsesApi: flags.responses,
          reasoningEffort: flags.reasoningEffort as never,
        }),
        close: () => {},
      };
    case "bedrock":
    case "bedrock-mantle": {
      // Resolved per request, so refreshed AWS credentials apply without restarting.
      const credentials = (): ReturnType<typeof resolveBedrockCredentialsFromEnvironment> & object => {
        const resolved = resolveBedrockCredentialsFromEnvironment();
        if (!resolved) throw new UsageError("No AWS credentials found. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION, or configure a profile with `aws configure` (AWS_PROFILE picks one).");
        return resolved;
      };
      credentials();
      return {
        provider: "bedrock",
        transport: createModelClient({ provider: "bedrock", bedrockApi: flags.provider === "bedrock-mantle" ? "mantle" : "converse", bedrock: credentials }),
        close: () => {},
      };
    }
    case "chatgpt": {
      // The Codex CLI's own home by default, so an existing `codex login` is reused.
      const home = flags.codexHome ?? process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");
      const service = new ChatGptService(new CodexAppServer(flags.codexPath ?? "codex", home), home, () => {}, async () => false);
      try {
        await service.requireAccount();
      } catch (error) {
        service.dispose();
        const message = error instanceof Error ? error.message : String(error);
        throw new UsageError(/sign in/i.test(message)
          ? "Codex is not signed in to ChatGPT. Run `codex login`, then try again."
          : `Could not start Codex (${message}). Install it (npm i -g @openai/codex) or pass --codex-path.`);
      }
      return {
        provider: "openai",
        transport: createChatGptTransport(service, { reasoningEffort: flags.reasoningEffort }),
        close: () => service.dispose(),
      };
    }
  }
}
