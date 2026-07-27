# Blacksite

An AI coding agent for VS Code with deep workspace integration — and a WebGL map of your codebase that the agent can actually navigate.

Blacksite is **bring-your-own-key**. You connect your own Anthropic, OpenAI, OpenRouter, or AWS Bedrock account, and your tokens are billed by that provider directly. Blacksite never proxies your requests through a server of ours, because there isn't one.

## What's in it

**Chat** — an agentic loop with a large tool surface: file reads and surgical edits, shell execution, search, LSP-backed code intelligence (symbols, navigation, hierarchies, diagnostics, rename, code actions), browser automation, and MCP server support. Edits are previewed and approved before they touch disk.

**Codebase Map** — a rendered star-field of your repository. Files are stars, imports are arcs, and services are territories. It's built from a real index: per-language import resolution across TypeScript (including path aliases), Go, Java, C#, Python, PHP, Rust, and more, plus a service lens that detects API providers and verified HTTP clients, event pub/sub, and data access across roughly ten frameworks. The agent queries the same graph you're looking at — impact analysis, path finding, and neighborhood lookup are tools it can call.

**Plans** — durable multi-phase plans with per-step state, so long-running work survives session boundaries and the agent can pick up where it left off.

**Base Context** — curated topics and file snippets that ride along in every request, for the project knowledge that doesn't live in any one file.

**Data** — an embedded SQLite workbench with a query editor, table preview, and vector search, with an optional pgvector sidecar.

**Notes** — a timeline of map annotations with git history and diffs.

## Requirements

- VS Code 1.85 or newer
- An API key for at least one supported provider: Anthropic, OpenAI, OpenRouter, or AWS Bedrock

## Install

Download the latest `.vsix` from [Releases](https://github.com/RoofTopDude/blacksite-vscode/releases) and install it:

```bash
code --install-extension blacksite-vscode-<version>.vsix
```

Or in VS Code: **Extensions → ⋯ → Install from VSIX…**

Then run **Blacksite: Set API Key** from the command palette and pick your provider.

Blacksite checks for updates on startup and can install them in place. Turn that off with `blacksite.updates.checkOnStartup` if you'd rather manage versions yourself.

## Getting started

1. Open the Blacksite icon in the activity bar.
2. **Blacksite: Set API Key** — choose a provider and paste your key. Keys are stored in VS Code's `SecretStorage`, never in settings files.
3. Ask for something in the Chat panel.
4. Open **Blacksite: Open Codebase Map** to watch the index build.

There are 26 settings under the `blacksite.*` namespace covering provider selection, model and generation controls, tool group toggles, map performance profiles, and update behavior.

## Privacy

Blacksite is a tool that reads your code and sends portions of it to a third-party language model provider of your choosing. That is the entire point of it, and you should understand the shape of it before you install:

- **What is sent:** the files, selections, diagnostics, terminal output, and workspace context relevant to your request, plus whatever a tool call retrieves, to the provider you configured.
- **Where it goes:** directly from your machine to that provider's API. There is no Blacksite server in the path, and no telemetry is collected.
- **What stays local:** the codebase index, plans, base context, map annotations, execution logs, and the embedded database all live in `.blacksite/` in your workspace.
- **Your keys:** stored in VS Code's `SecretStorage` (OS keychain), never written to settings or logs.

Your provider's own data-retention and training policies apply to everything Blacksite sends them. Read those too.

## Licensing

Blacksite is **source-available, not open source**. The source is public so you can read exactly what the agent does with your code before you trust it with your repository — public access to the source does not grant commercial-use rights.

**Free** for personal projects, research, study, hobby use, and qualifying noncommercial organizations, under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). That file is the canonical, unmodified license text and controls all noncommercial rights.

**Commercial use requires a separate written license.** That includes work for a for-profit company, client work, internal business operations, and CI or unattended agent workflows for a business — whether or not Blacksite ships in the resulting product.

| Document | What it covers |
| --- | --- |
| [LICENSE.md](LICENSE.md) | PolyForm Noncommercial 1.0.0 — the canonical noncommercial grant |
| [COMMERCIAL-LICENSING.md](COMMERCIAL-LICENSING.md) | When a commercial license is required, the Seat model, and how to request one |
| [EVALUATION-LICENSE.md](EVALUATION-LICENSE.md) | The 30-day commercial evaluation grant |
| [COMMERCIAL-LICENSE-AGREEMENT.md](COMMERCIAL-LICENSE-AGREEMENT.md) | The paid commercial agreement and Order Form template |
| [CONTRIBUTOR-LICENSE-AGREEMENT.md](CONTRIBUTOR-LICENSE-AGREEMENT.md) | Rights granted with contributions |

Commercial licensing enquiries: **[mgriffith@blacksite-agent.com](mailto:mgriffith@blacksite-agent.com)**

> The commercial, evaluation, and contributor agreements are drafts pending legal review; governing law, venue, and the licensing entity are not yet set. They describe the intended terms but should not be executed until counsel has reviewed them.

## Building from source

```bash
npm install
npm run build          # webview bundles + extension host
npm run test:unit      # 2000+ unit tests
npm run package:vsix   # produces a .vsix
```

`packages/` holds three vendored workspace libraries (`local-runtime`, `file-content`, `browser-bridge-protocol`) that are aliased and bundled into `out/extension.js` at build time.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
