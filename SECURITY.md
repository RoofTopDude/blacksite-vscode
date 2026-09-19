# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub's [Private Vulnerability
Reporting](https://github.com/RoofTopDude/blacksite-vscode/security/advisories/new), or by email to
**mgriffith@blacksite-agent.com** with `SECURITY` in the subject.

Please include:

- what an attacker can do, not just what looks wrong
- the version (`blacksite.version` in the extension, or the `.vsix` filename)
- steps to reproduce, and a proof of concept if you have one
- your platform and VS Code version

**What to expect.** Blacksite is maintained by one person, so an initial reply may take a few days
rather than hours. You will get an acknowledgement, an assessment of severity, and a fix timeline
or an explanation of why it is not being treated as a vulnerability. You are welcome to be credited
in the release notes, or to stay anonymous — say which.

Please give a reasonable window to ship a fix before disclosing publicly.

## Supported versions

Fixes land on the latest release. There are no long-term support branches: if you are behind,
update rather than expecting a backport. Prereleases (`-pre.N`) are exactly that — report issues in
them, but do not run them anywhere you would mind a bug.

## Scope

Blacksite reads your code, edits files, runs approved processes, drives a browser, and sends
portions of your workspace to a model provider you configure. That is the product, not a
vulnerability. What matters is whether the boundaries hold.

**In scope — please report:**

- Escaping workspace path containment (reading or writing outside the workspace root), including
  via symlinks, or bypassing the approval gate for a write/network/destructive operation
- Executing a command the command policy should have refused, or getting an inline-eval argument
  (`node -e`, `python -c`, `--script-shell`, …) past the blocklist
- Any path by which a **credential leaves the machine to somewhere it was not configured to go**,
  or by which model output can redirect a credential's destination
- Reading a secret out of `SecretStorage` from a context that should not have it, or finding a
  credential written to settings, logs, `.blacksite/`, or a persisted transcript
- Webview CSP bypass, or script execution from model- or tool-supplied content (the markdown
  sanitizer, preview rendering, MCP panel markup)
- Defeating the update integrity checks — installing a VSIX that is not the digest-verified asset
  from the pinned `github.com` release
- MCP: a withheld tool becoming invocable, credentials attached to the wrong server, or an OAuth
  flow accepting a token bound to a different resource
- SSRF or domain-policy bypass in the browser/research tools

**Out of scope:**

- Anything requiring the user to have already granted Workspace Trust *and* approved the specific
  operation. Approving a destructive command and having it run destructively is the feature.
- The model doing something unhelpful, wrong, or expensive. That is a quality issue — open a normal
  issue.
- What your configured model provider does with the data you send it. Read their policies; the
  README's Privacy section explains what leaves the machine.
- Vulnerabilities in a dependency with no path to exploitation here, especially dev-only ones. The
  advisory gate in `npm run security` already fails at `high`.
- Findings from an automated scanner with no demonstrated impact.

## How this is defended

[`docs/security.md`](docs/security.md) documents the controls in force — the credential and update
boundaries, the MCP authorization profile, the webview CSP — and the local/CI scanning pipeline.
[`ARCHITECTURE.md`](ARCHITECTURE.md) describes where the runtime boundary sits in the code.

Two gates run on every push and pull request, and again on release:

```sh
npm run security   # static secret/PII/policy scan + public dependency advisories
```

If you are fixing a security bug, see the triage guidance in `docs/security.md` — for a committed
secret, rotating it comes before deleting the line.
