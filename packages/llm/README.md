# @blacksite-agent/llm

One streaming interface to Anthropic, OpenAI (Chat Completions and Responses), OpenRouter, AWS
Bedrock (Converse and Mantle) and the ChatGPT subscription. You send a provider-neutral request,
and you get back one event stream with the same shape for every provider. This is the model layer
of the Blacksite VS Code extension, packaged so other projects can use it.

It handles what each provider does differently:

- the wire format for each route
- prompt-cache breakpoints
- extended thinking, reasoning effort, and replaying signed or encrypted reasoning
- hosted web search
- retries: before the first byte, mid-stream, and long outage waits
- stop-reason normalization
- capability probes (strict tool schemas, Bedrock cache points)

## Install

The package is published privately to GitHub Packages under the `blacksite-agent` org.

```ini
# .npmrc
@blacksite-agent:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```sh
npm install @blacksite-agent/llm
```

The token needs `read:packages`. The package is ESM-only and needs Node 20 or later. The core entry
point also runs in browsers and workers.

## Entry points

| Import | Runs in | Contents |
| --- | --- | --- |
| `@blacksite-agent/llm` | Node 20+, browsers, workers | Types, the model client, every provider route, retries, history hygiene, compaction, one-shot completions, model catalog, Bedrock signing (Web Crypto) |
| `@blacksite-agent/llm/node` | Node | The AWS credential chain (environment + `~/.aws`), the Codex app-server client and `ChatGptService` |
| `@blacksite-agent/llm/testing` | anywhere | Builders for Anthropic and Responses SSE streams and Bedrock event-stream frames, for tests |

## Streaming a turn

```ts
import { assistantMessageFromTurn, complete, createModelClient, planThinking, type AgentMessage } from "@blacksite-agent/llm";

const client = createModelClient({ provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY });
const messages: AgentMessage[] = [{ role: "user", content: "Name three prime numbers." }];

const result = await complete(client, {
  model: "claude-sonnet-4-6",
  system: "You are terse.",
  systemSummary: "",
  contextTail: "",
  messages,
  tools: { wire: [], deferred: new Set() },
  thinking: planThinking({
    model: "claude-sonnet-4-6", provider: "anthropic", configuredMaxTokens: 4096, ceiling: null,
    thinkingEnabled: false, budgetTokens: 0, effort: undefined, temperature: undefined,
  }),
  conversationId: "demo",
  turnIndex: 0,
}, { onEvent: (event) => event.type === "text_delta" && process.stdout.write(event.text) });

messages.push(assistantMessageFromTurn(result));
```

- **The client:** `createModelClient(config)` returns a client for one conversation. It remembers
  facts it learns about the endpoint, such as a rejected cache marker or unsupported strict
  schemas. Create one per conversation and don't share it.
- **Streaming:** `client.stream(request, signal)` yields `ProviderTurnStreamEvent`s: text and
  reasoning deltas, finished reasoning blocks, tool calls, hosted searches, usage, the stop reason,
  notices, and `turn_reset` when a retry discards a partial answer.
- **Retries:** `ProviderTurnRunner.run(open, sink, options)` folds the stream into a
  `ProviderTurnResult` and retries transient failures, including mid-stream ones. It can also wait
  out a provider outage. `complete()` is that same runner applied to a single turn.
- **History:** `assistantMessageFromTurn(result)` builds the history entry in the order every
  provider will accept on replay.
- **A tool loop:** call the tools a result asks for, append
  `{ role: "user", content: toolResults }`, and send again. `packages/llm-cli/src/conversation.ts`
  is a complete loop in about 100 lines.

## Requests

`ModelRequest` is plain data. Build a new one for every turn:

| Field | Meaning |
| --- | --- |
| `system`, `systemSummary` | The stable system prompt, and a summary of compacted history (empty for none) |
| `contextTail` | Per-request context sent after the cache breakpoints, so the cached prefix survives it changing |
| `messages` | The conversation. Each route normalizes it for its wire format (orphaned tool results, empty turns, unsigned thinking) |
| `tools.wire` / `tools.deferred` / `tools.references` | Tool schemas, names to defer (Anthropic tool search), and tool_search results to expand |
| `thinking` | The output of `planThinking()`: max_tokens, thinking dialect and temperature, already reconciled with the model |
| `hostedSearch` | The provider's own web search, when it's allowed |
| `conversationId`, `turnIndex` | OpenAI's `prompt_cache_key`, and part of synthesized ids |
| `anthropicBeta` | Fast mode, task budgets, context editing, server-side compaction, refusal fallback |

## Providers

| `provider` | Route | Credentials |
| --- | --- | --- |
| `anthropic` | Messages API | `apiKey` |
| `openai` | Chat Completions; Responses for reasoning models when `useResponsesApi` is set | `apiKey` |
| `openrouter` | Chat Completions | `apiKey` |
| `bedrock` | Converse (default) or Mantle (`bedrockApi: "mantle"`) | `bedrock: { region, accessKeyId, secretAccessKey, sessionToken? }` |
| ChatGPT subscription | Codex app-server, through `createChatGptTransport(service)` from `/node` | The user's Codex sign-in |

`apiKey` and `bedrock` accept a value or a function that returns one (sync or async). A function
is called once per request attempt, so short-lived credentials can refresh. On Node,
`resolveBedrockCredentialsFromEnvironment()` from `/node` gives you the standard AWS chain.

## Your own transport

`ModelTransport` is just `{ stream(request, signal), hostedSearchRoute? }`. Anything that
implements it can stand in for the built-in client: a gateway that holds the credentials, or a
recorded transport in tests. `subscriptionTransport(stream)` adapts an app that takes the simpler
`SubscriptionRequest` shape.

## Also included

- **`completeText(request)`:** one plain-text answer from a system prompt and one user message,
  optionally with an image. It's non-streaming, with no tools, cache markers or thinking fields.
- **`compressHistory(options, messages)`:** summarizes older history for compaction.
- **`fetchModels`, `getFallbackModels`, `listAvailableBedrockModels`, `getModelPricing`,
  `estimateUsageCostUsd`, `resolveOutputCeiling`:** the model catalog, limits and pricing.

## Stability

This is 0.x. The API reports in `etc/*.api.md` record the full public surface, and CI fails on any
change that hasn't been reviewed. The high-level API above is what we intend to keep. The rest of
the surface is lower-level: the wire converters (`toOpenAIMessages`, `toBedrockMessages`, cache
breakpoint helpers, …), the stream parsers and the stop-reason normalizers. The extension uses
them directly, and they may change between 0.x minor versions.

## Developing

The package lives in the `blacksite-vscode` repository as an npm workspace, and the extension uses
its TypeScript source directly through the `source` export condition.

| Command (from the repository root) | Does |
| --- | --- |
| `npm run test:unit` | Runs every test, including `packages/llm/test` |
| `npm run compile` | Typechecks the extension, the core (without Node types), the Node entry and the CLI |
| `npm run build:llm` | Builds `dist/` and the `blacksite-llm` CLI |
| `npm run check:api` | Builds, then fails if the public API differs from `etc/*.api.md` |
| `npm run update:api -w @blacksite-agent/llm` | Rewrites the API reports after an intended change |
| `node packages/llm-cli/dist/cli.js probe --provider <p> --model <m>` | Live checks against a real provider |

`tests/unit/provider-request-snapshots.spec.ts` pins the exact request every route sends. Prompt
caching depends on byte-identical prefixes, so treat a snapshot diff as a behavior change and
review it before you accept it.
