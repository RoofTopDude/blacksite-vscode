/* blacksite-llm: a terminal client for @blacksite-agent/llm. */
import * as readline from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  bedrockModelsToModelInfo,
  fetchModels,
  getFallbackModels,
  listAvailableBedrockModels,
  type ModelInfo,
  type ProviderTurnStreamEvent,
} from "@blacksite-agent/llm";
import { resolveBedrockCredentialsFromEnvironment } from "@blacksite-agent/llm/node";
import { Conversation } from "./conversation.js";
import { installFixtureEndpoint, runProbe, type ProbeCheck } from "./probe.js";
import { demoTools } from "./tools.js";
import { openTransport, PROVIDERS, UsageError, type CliProvider } from "./transport.js";

const HELP = `blacksite-llm — talk to a model through @blacksite-agent/llm

Usage
  blacksite-llm chat   --provider <p> --model <m> [--thinking] [--effort <e>] [--base-url <url>]
  blacksite-llm probe  --provider <p> --model <m> [--thinking]
  blacksite-llm probe  --fixture
  blacksite-llm models --provider <p>

Providers   ${PROVIDERS.join(", ")}
Credentials ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY. Bedrock uses the AWS chain
            (AWS_* variables, then ~/.aws; AWS_PROFILE picks a profile). chatgpt runs Codex with
            your existing \`codex login\` (--codex-path, --codex-home to override).

Options
  --thinking         Ask for reasoning (Claude extended thinking, OpenRouter reasoning)
  --effort <e>       OpenAI / ChatGPT reasoning effort (low, medium, high, ...)
  --responses        OpenAI reasoning models: use the Responses API
  --max-tokens <n>   Output budget per turn (default 4096)
  --cwd <dir>        Directory the chat tools (read_file, list_dir) may read (default: current)
  --no-tools         Chat without tools`;

const DIM = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      thinking: { type: "boolean", default: false },
      effort: { type: "string" },
      responses: { type: "boolean", default: false },
      "base-url": { type: "string" },
      "max-tokens": { type: "string", default: "4096" },
      "codex-path": { type: "string" },
      "codex-home": { type: "string" },
      cwd: { type: "string" },
      "no-tools": { type: "boolean", default: false },
      fixture: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

function requireProvider(value: string | undefined): CliProvider {
  if (!value) throw new UsageError(`--provider is required (${PROVIDERS.join(", ")}).`);
  if (!(PROVIDERS as readonly string[]).includes(value)) throw new UsageError(`Unknown provider "${value}" (${PROVIDERS.join(", ")}).`);
  return value as CliProvider;
}

function requireModel(value: string | undefined): string {
  if (!value) throw new UsageError("--model is required.");
  return value;
}

/** Live output for one streamed turn: text as it arrives, reasoning dimmed, notices on their own line. */
function printer(): (event: ProviderTurnStreamEvent) => void {
  let thinking = false;
  return (event) => {
    if (event.type === "thinking_delta") {
      if (!thinking) { process.stdout.write(DIM("\n[thinking] ")); thinking = true; }
      process.stdout.write(DIM(event.text));
    } else if (event.type === "text_delta") {
      if (thinking) { process.stdout.write("\n\n"); thinking = false; }
      process.stdout.write(event.text);
    } else if (event.type === "notice") {
      process.stdout.write(DIM(`\n[${event.level}] ${event.message}\n`));
    } else if (event.type === "turn_reset") {
      process.stdout.write(DIM(`\n[retrying: ${event.reason}]\n`));
    } else if (event.type === "hosted_search") {
      process.stdout.write(DIM(`\n[searched: ${event.query}]\n`));
    }
  };
}

async function chat(values: ReturnType<typeof parse>["values"]): Promise<void> {
  const provider = requireProvider(values.provider);
  const model = requireModel(values.model);
  const cli = await openTransport({ provider, model, baseUrl: values["base-url"], reasoningEffort: values.effort, responses: values.responses, codexPath: values["codex-path"], codexHome: values["codex-home"] });
  const root = values.cwd ?? process.cwd();
  const tools = values["no-tools"] ? [] : demoTools(root);
  const conversation = new Conversation({
    transport: cli.transport,
    provider: cli.provider,
    label: provider,
    model,
    system: tools.length ? `You are a helpful assistant in a terminal. You can read files under ${root} with read_file and list_dir.` : "You are a helpful assistant in a terminal.",
    tools,
    thinking: values.thinking ?? false,
    maxTokens: Number(values["max-tokens"]),
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(DIM(`${provider} · ${model}${tools.length ? ` · tools read ${root}` : ""} — empty line or Ctrl+C to quit`));
  try {
    for (;;) {
      const line = (await rl.question("\n> ")).trim();
      if (!line) break;
      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.once("SIGINT", onSigint);
      try {
        const { rounds, toolCalls } = await conversation.send(line, printer(), controller.signal);
        for (const call of toolCalls) console.log(DIM(`\n[${call.name} ${JSON.stringify(call.input)}${call.error ? " failed" : ""}]`));
        const usage = rounds.map((r) => r.usage).filter((u) => u !== undefined);
        if (usage.length) {
          const input = usage.reduce((n, u) => n + u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens, 0);
          const output = usage.reduce((n, u) => n + u.outputTokens, 0);
          console.log(DIM(`\n${input} in · ${output} out`));
        } else {
          process.stdout.write("\n");
        }
      } catch (error) {
        console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        process.off("SIGINT", onSigint);
      }
    }
  } finally {
    rl.close();
    cli.close();
  }
}

function printChecks(checks: ProbeCheck[]): boolean {
  const mark = { pass: "✓", fail: "✗", skip: "–" } as const;
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const check of checks) console.log(`${mark[check.status]} ${check.name.padEnd(width)}  ${DIM(check.detail)}`);
  return checks.every((check) => check.status !== "fail");
}

async function probe(values: ReturnType<typeof parse>["values"]): Promise<boolean> {
  if (values.fixture) {
    const restore = installFixtureEndpoint();
    try {
      console.log(DIM("anthropic (scripted fixture endpoint) · claude-sonnet-4-6"));
      process.env["ANTHROPIC_API_KEY"] ??= "fixture";
      const checks = await runProbe(() => openTransport({ provider: "anthropic", model: "claude-sonnet-4-6" }), { label: "anthropic", model: "claude-sonnet-4-6", thinking: true, maxTokens: 4096 });
      return printChecks(checks);
    } finally {
      restore();
    }
  }
  const provider = requireProvider(values.provider);
  const model = requireModel(values.model);
  console.log(DIM(`${provider} · ${model}`));
  const checks = await runProbe(
    () => openTransport({ provider, model, baseUrl: values["base-url"], reasoningEffort: values.effort, responses: values.responses, codexPath: values["codex-path"], codexHome: values["codex-home"] }),
    { label: provider, model, thinking: values.thinking ?? false, maxTokens: Number(values["max-tokens"]), reasoningInThread: provider === "chatgpt" },
  );
  return printChecks(checks);
}

async function models(values: ReturnType<typeof parse>["values"]): Promise<void> {
  const provider = requireProvider(values.provider);
  let list: ModelInfo[];
  if (provider === "bedrock" || provider === "bedrock-mantle") {
    const creds = resolveBedrockCredentialsFromEnvironment();
    if (!creds) throw new UsageError("No AWS credentials found (see --help).");
    const result = await listAvailableBedrockModels(creds);
    if (!result.ok) console.log(DIM(`(Bedrock listing failed: ${result.error}; showing the built-in list)`));
    list = result.ok ? bedrockModelsToModelInfo(result.data.models) : getFallbackModels("bedrock");
  } else if (provider === "chatgpt") {
    const { ChatGptService, CodexAppServer } = await import("@blacksite-agent/llm/node");
    const os = await import("node:os");
    const path = await import("node:path");
    const home = values["codex-home"] ?? process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");
    const service = new ChatGptService(new CodexAppServer(values["codex-path"] ?? "codex", home), home, () => {}, async () => false);
    try { list = await service.models(); } finally { service.dispose(); }
  } else {
    const key = process.env[{ anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" }[provider]];
    list = key ? await fetchModels(provider, key) : getFallbackModels(provider);
    if (!key) console.log(DIM("(no API key set: showing the built-in list)"));
  }
  for (const model of list) {
    const window = model.contextLength ? ` ${DIM(`${Math.round(model.contextLength / 1000)}K`)}` : "";
    console.log(`${model.id}${window}`);
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parse();
  const command = positionals[0];
  if (values.help || !command) { console.log(HELP); return command || values.help ? 0 : 1; }
  try {
    switch (command) {
      case "chat": await chat(values); return 0;
      case "probe": return (await probe(values)) ? 0 : 1;
      case "models": await models(values); return 0;
      default: throw new UsageError(`Unknown command "${command}". Run blacksite-llm --help.`);
    }
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : `Error: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof UsageError ? 2 : 1;
  }
}

process.exitCode = await main();
