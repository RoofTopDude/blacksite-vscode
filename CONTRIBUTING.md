# Contributing

Blacksite is source-available, not open source, and is maintained by one person. Read
[Before you start](#before-you-start) before writing code — the licensing and scope constraints are
real, and finding out after the fact wastes your time more than mine.

Security problems do not go here. See [SECURITY.md](SECURITY.md).

## Before you start

**Contributions are licensed under the [CLA](CONTRIBUTOR-LICENSE-AGREEMENT.md).** Opening a pull
request means agreeing to it. It grants rights broad enough to relicense your contribution
commercially, because the project is dual-licensed — noncommercial use under
[PolyForm](LICENSE.md), commercial use under a separate paid agreement. If that is not acceptable
to you, please don't open a PR.

**Open an issue before building anything substantial.** This is a product with an opinionated
direction and a single maintainer; a large PR that does not fit it is a bad outcome for both of us.
Bug fixes, tests, and documentation are always welcome without asking first.

**The bus factor is one.** Review latency is measured in days. Small, reviewable PRs get merged;
sprawling ones may sit.

## Setup

Requires Node 22 and VS Code 1.85+.

```sh
npm install
npm run build      # webview bundles + extension host
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.
`npm run watch` and `npm run watch:webview` rebuild on change — run both if you are touching each
half.

You need an API key for at least one provider (Anthropic, OpenAI, OpenRouter, or Bedrock) to
exercise the agent. **Blacksite: Set API Key** in the command palette. Keys go to `SecretStorage`;
they must never reach settings, logs, or a test fixture.

## Before you push

CI runs exactly this, so running it locally is the fastest way to not be surprised:

```sh
npm run lint
npm run compile            # tsc --noEmit, extension host
npm run typecheck:webview
npm run test:coverage      # the unit suite, with coverage thresholds
npm run security           # secret/PII/policy scan + dependency advisories
npm run build
```

A few things that trip people up:

- **Coverage has a floor.** `vitest.config.ts` sets thresholds just under the current numbers.
  Raise them when real coverage climbs; never lower them to turn a build green.
- **The security scan is not advisory.** It fails on unapproved contact emails, shell-enabled
  process launches, movable GitHub Action refs, and weakened webview CSP directives, among others.
  If it flags a new contact email, add it to `security/policy.json` with an honest `purpose` — and
  never allowlist a secret value. Rotate it instead.
- **`npm run test:browser`** needs Chromium (`npx playwright-core install chromium`). CI runs it;
  locally it is optional unless you are touching browser policy.

## House style

The code has conventions worth matching. Read a neighbouring file before adding to it.

**Comments explain why, not what.** This is the most consistent property of the codebase and the
most useful. A comment that restates the code is noise; one that records the failure mode a line
prevents, or the alternative that was rejected, is why the next person does not undo it. Look at
`packages/local-runtime/src/security.ts` or the cache-invalidation notes in `workspace-context.ts`
for the register.

**Types are strict.** `strict` plus `noUncheckedIndexedAccess` on both halves. Do not add
`@ts-ignore` — there are currently zero in ~116k lines, and that is worth keeping. `any` is
tolerated at boundaries where a type genuinely is not known, not as a way past an error.

**Catches are explained.** An empty `catch {}` needs a comment saying why swallowing is correct.
The lint config permits empty catch blocks precisely so the comment carries the meaning.

**Prefer a directory.** `src/` root is already ~41k lines flat; new subsystems go in a directory
(`src/agent/`, `src/chat/`, `src/graph/`, …). See [ARCHITECTURE.md](ARCHITECTURE.md).

**Keep the host/webview boundary honest.** Webviews render and collect input. They do not read the
filesystem, hold credentials, or make network calls. If a webview needs data, the host sends it.

## Tests

The suite is ~3,500 tests and is expected to stay meaningful rather than merely large. Test the
behaviour that would actually break — the existing `agent-session.*.spec.ts` files are a good model:
mid-stream retry, compaction outcomes, token truncation, service-tier fallback.

- Unit tests live in `tests/unit/`, run in a node environment, and get the `vscode` module aliased
  to `tests/unit/helpers/vscode-mock.ts` — which is what lets host code be tested at all.
- A test that needs a heavy dependency should import it once in a hook with a timeout sized for a
  cold import, not inside the test body where it competes with the 5-second per-test budget.
- If a test needs a capability the platform may not grant (symlinks on Windows, for instance), have
  it detect and skip rather than fail. `tests/unit/workspace-paths-realpath.spec.ts` shows the
  pattern.

## Commits and pull requests

Write a commit message that explains the change and why it was made — recent history is the
standard to match. Keep a PR to one coherent change; a refactor and a behaviour change in the same
diff are hard to review and harder to revert.

If your change is user-visible, add a `CHANGELOG.md` entry under an `## Unreleased` heading. Do not
bump the version or tag — releases are cut by the maintainer with `npm version` and a `v*` tag,
which triggers the release workflow.

## What tends not to get merged

- Reformatting, import reordering, or style churn unrelated to a fix
- Swapping a dependency for a preferred alternative without a concrete problem being solved
- New dependencies where a small amount of code would do — the production tree is 29 packages and
  the bundle is already large
- Lowering a coverage threshold, widening the security allowlist, or disabling a lint rule to make
  a build pass
- Large features that were not discussed in an issue first
