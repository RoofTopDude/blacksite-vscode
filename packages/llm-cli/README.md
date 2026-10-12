# blacksite-llm

A terminal client for `@blacksite-agent/llm`. It's also the package's first outside consumer: it
loads the package's built output exactly as any other project would.

```sh
npm run build:llm            # from the repository root: builds the package and the CLI
node packages/llm-cli/dist/cli.js --help
```

| Command | Does |
| --- | --- |
| `chat --provider <p> --model <m>` | A REPL that streams text and reasoning. Two read-only tools (`read_file`, `list_dir`) can read the working directory (`--cwd`) |
| `probe --provider <p> --model <m> [--thinking]` | Live checks for one route: a plain answer, a tool call, the tool result being used, reasoning replayed, usage reported |
| `probe --fixture` | The same checks against a scripted Anthropic endpoint. Needs no key and no network |
| `models --provider <p>` | The provider's model catalog |

Providers are `anthropic`, `openai`, `openrouter`, `bedrock`, `bedrock-mantle` and `chatgpt`.
Credentials come from:

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `OPENROUTER_API_KEY`.
- The AWS chain for Bedrock: `AWS_*` variables, then `~/.aws`. `AWS_PROFILE` picks a profile.
- Your existing `codex login` for `chatgpt`. Override the binary with `--codex-path` and the home
  directory with `--codex-home`.
