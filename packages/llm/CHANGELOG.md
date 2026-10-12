# Changelog

## 0.1.0

First release. The model layer of the Blacksite VS Code extension (1.33.0-pre.2), extracted unchanged
into its own package.

- `createModelClient`: Anthropic, OpenAI Chat Completions and Responses, OpenRouter, Bedrock
  Converse and Mantle, with one event stream for all of them.
- `ProviderTurnRunner` and `complete`: fold a stream into a result. Retries transient failures
  before the first byte and mid-stream, and can wait out an outage.
- `ModelTransport`: plug in your own transport. `subscriptionTransport` and (from `/node`)
  `createChatGptTransport` adapt the ChatGPT subscription through Codex.
- `completeText`: one-shot, non-streaming completions. `compressHistory`: compaction summaries.
- The model catalog, limits and pricing; the thinking plan and Anthropic beta features.
- Bedrock SigV4 signing on Web Crypto, so the core runs in browsers and workers.
- `/node`: the AWS credential chain, the Codex app-server client and `ChatGptService`.
- `/testing`: SSE and Bedrock event-stream fixture builders.
