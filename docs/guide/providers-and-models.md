# Providers, Keys & Models

Blacksite talks to four model providers. You supply the account and the credentials; requests go
straight from your machine to that provider's API. There is no Blacksite server in the path, so
your provider's own dashboard is the authoritative record of what you spent and what you sent.

---

## Choosing a provider

| Provider | Setting value | Credentials | Notes |
| --- | --- | --- | --- |
| **Anthropic** | `anthropic` | API key | The default. Direct access to the Claude family. |
| **OpenRouter** | `openrouter` | API key | One key, many vendors' models. Easiest way to try several. |
| **OpenAI** | `openai` | API key | Includes the newer Responses API path. |
| **AWS Bedrock** | `bedrock` | AWS credential chain | SigV4-signed. For teams already inside AWS. |

Set it either in VS Code settings (`blacksite.provider`) or in the **Settings** panel inside the
Blacksite sidebar — they are the same value, and the sidebar is usually faster.

### Why the choice matters less than you'd think

Blacksite normalizes every provider onto one internal event stream before the agent loop sees it.
Five separate streaming implementations converge on a single event type, so switching providers
mid-project changes which API is called and nothing else about how the agent behaves. Tool schemas
are converted per provider at request time rather than authored several times.

The practical consequence: pick whichever provider you already have billing set up with, and change
your mind later without rework.

---

## Storing your key

Run **Blacksite: Set API Key** from the command palette. Choose the provider, paste the key.

Keys go into VS Code's `SecretStorage`, which is backed by your OS keychain — Keychain on macOS,
DPAPI on Windows, libsecret on Linux. They are never written to `settings.json`, never written into
your workspace, and never written to a log.

You can store a key for more than one provider. Switching `blacksite.provider` picks up whichever
key matches without re-prompting.

### AWS Bedrock

Bedrock does not use a pasted key. Blacksite resolves credentials through the standard AWS chain:

1. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`)
2. Shared config and credentials files (`~/.aws/config`, `~/.aws/credentials`), including named
   profiles and SSO
3. Container and instance metadata roles

If `aws sts get-caller-identity` works in your terminal, Blacksite will authenticate.

Bedrock also has a second choice — `blacksite.bedrockApi`:

- **`converse`** (default) — the Converse API. Live model listing, dated inference-profile IDs.
- **`mantle`** — the Anthropic-native Messages endpoint on Bedrock. Required for the newest Claude
  models that have not reached Converse yet.

If a model you expect is missing from the list, switching to `mantle` is the usual fix.

---

## Choosing a model

Leave `blacksite.model` empty and Blacksite uses the provider's default. Set it to override.

You can also switch mid-conversation with a slash command:

```
/model claude-sonnet-4-6
```

The model picker in the Settings panel lists what your provider currently advertises, fetched live
rather than from a hardcoded table — so a model released this morning shows up today.

### What to actually pick

Agentic coding is unusually demanding on a model. It is not one clever completion; it is dozens of
sequential decisions where an early mistake compounds. The heuristics that hold up:

- **Frontier models earn their price on hard work.** For a multi-file refactor or a subtle bug, a
  stronger model finishes in fewer turns, and fewer turns is often *cheaper* overall than a weaker
  model flailing.
- **Cheaper models are fine for mechanical work.** Renaming, formatting, writing tests against an
  already-understood contract.
- **Subagents can run on a different model than the main loop.** Because the core is
  provider-neutral, a broad file-triage subagent can use something cheap while the orchestrating
  loop stays on something strong. You do not have to pick one model for everything.

---

## Thinking and reasoning effort

Claude models expose a thinking budget, and the shape of that control changed across model
generations. Blacksite handles the difference for you, but it helps to know what is happening:

- **Adaptive thinking** (Opus 4.6+, Sonnet 4.6+, Fable 5): the model decides when and how deeply to
  think. Depth is steered by an *effort* level rather than a token count. The ladder runs
  `low → medium → high → xhigh → max`, and `high` is the default.
- **Budgeted thinking** (Claude 3.7 through 4.5): a fixed `budget_tokens` allowance.
- **No thinking**: everything else.

Which dialect a request uses is a function of the model, not a global setting, and the newer models
reject the older shape outright. Blacksite picks the right one per model — including for models
released after this build, which it assumes speak the newest dialect rather than failing closed.

Raise effort for genuinely hard reasoning: root-causing a race condition, planning a migration.
Leave it at the default for ordinary work. Thinking tokens are billed like any other output tokens.

---

## What a request actually costs

An agent loop resends the whole conversation on every iteration. That sounds ruinous, and it would
be without **prompt caching**.

Providers will cache a prefix of your request and charge far less to re-read it. The rule that makes
it work is that caches key on an *exact prefix* — anything that changes invalidates everything after
it. So Blacksite orders each request stable-content-first (system prompt, tool schemas, early
conversation) and volatile-content-last, and places a cache breakpoint just before the volatile tail
on every provider path that supports it.

The visible consequences for you:

- **Long conversations are much cheaper than their token count suggests.** Most of the prefix is a
  cache hit.
- **Starting a fresh conversation is not free.** The first turn re-pays for the whole prefix.
  Continuing an existing thread is usually the cheaper move.
- **Compaction costs one model call.** It buys back context room; see
  [Working with Chat](working-with-chat.html#compaction).

The **Inspector** (the ⓘ button in the chat header) shows live token accounting for the current
conversation — what is in context, what was cached, and what the last turn consumed.

---

## MCP servers

Beyond the built-in tool surface, Blacksite can connect to [Model Context Protocol](https://modelcontextprotocol.io)
servers, which expose additional tools to the agent.

Run **Blacksite: Manage MCP Servers** to add one. Both transports are supported:

- **stdio** — a local command Blacksite launches and talks to over pipes.
- **http** — a remote server reached over HTTP.

Configured servers live in `blacksite.mcpServers`. Each entry can be enabled or disabled without
being deleted, and the agent sees only the tools from enabled servers.

MCP tools are subject to the same approval gates as built-in ones. A remote MCP server is a third
party in your loop — extend it the same trust you would extend to any dependency you install.

---

## Related

- [Getting Started](getting-started.html) — installation and first request
- [Settings & Commands](settings-and-commands.html) — the full settings reference
- [Approvals & Safety](approvals-and-safety.html) — what leaves your machine, and when
