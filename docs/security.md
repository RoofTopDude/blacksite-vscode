# Blacksite security model and local scanning

Blacksite is a high-trust extension: it reads workspace files, can edit them, launches approved
processes, controls a browser, and can call external services with user-provided credentials. VS
Code therefore keeps the extension disabled in untrusted and virtual workspaces. Treat granting
Workspace Trust as granting Blacksite access to the repository and its configured tools.

## Zero-cost security pipeline

Run the complete pipeline locally:

```sh
npm run security
```

The pipeline has no paid service or scanner dependency:

- `security:static` enumerates tracked and untracked repository files without printing matched
  values. It detects common provider tokens and private keys, unapproved contact email addresses,
  labelled public phone numbers, shell-enabled process launches, movable GitHub Action refs,
  missing Workspace Trust restrictions, and weakened webview CSP directives.
- `security:dependencies` asks the configured npm registry for its public advisory report and
  fails at the severity threshold in `security/policy.json` (currently `high`). Advisory URLs are
  included in CI annotations so a failure is directly reviewable.
- `.github/workflows/security.yml` runs both scanners on every pull request and main push, weekly
  for newly disclosed dependency issues, and on demand. Normal CI and release packaging run the
  same gate, so a release cannot bypass it.

Scanner policy is intentionally small and reviewable. `security/policy.json` is the only PII
allowlist. Never allowlist a secret value: rotate and remove it. The public commercial licensing
email is approved only in the legal/public files that need it; a copy introduced elsewhere fails.
Example-only domains such as `example.com` and `.internal` are ignored.

## Credential and update boundaries

- API keys are stored in VS Code SecretStorage. Jira and Confluence keep their existing
  `email:token` storage format.
- GitLab, Jira, Confluence, and Salesforce credentials are sent only to an application-scoped
  HTTPS origin configured under `blacksite.integrations.*`. Those destination fields are absent
  from agent tool schemas, so model output cannot redirect a credential. Delegated lanes receive
  neither service tools nor service credentials.
- MCP tools accept only IDs for enabled servers configured in application state; a repository
  setting cannot register a process to launch. Remote MCP endpoints require HTTPS (with loopback
  HTTP allowed for development) and may not embed credentials in the URL, every connection/call is
  approval-gated, responses are bounded, and delegated lanes must ask the supervising parent to
  perform MCP operations.
- MCP credentials — OAuth tokens and client registrations, static bearer/header tokens, and secret
  environment values for stdio servers — are held in VS Code SecretStorage, never in settings or
  workspace state. They are attached to a request in one place, on the host, and are absent from
  every tool schema the model can see. OAuth follows the MCP authorization profile: authorization
  code with PKCE (S256 required), dynamic client registration, a loopback redirect with a
  constant-time `state` check, and an RFC 8707 resource indicator so a token is bound to the
  server it was issued for and is not replayed at another.
- Per-tool MCP permissions are enforced on the host, on both listing and invocation. A tool the
  user has withheld is filtered out of the catalog the model receives and its invocation is
  refused before any connection is opened, with the same error an unknown tool name produces — so
  a withheld capability is not disclosed to the model by an error message, an approval prompt, or
  a timing difference. The policy travels on the server descriptor, which the model can neither
  read nor set.
- Extension updates must come from a `github.com` release URL and publish a SHA-256 digest. The
  downloaded bytes are bounded and verified before installation, and release-derived paths never
  pass through a command shell.
- Model-authored remote images are rendered as blocked placeholders. This prevents chat content
  from creating tracking-beacon requests under the user's IP.

## Unattended plan runs

A plan run can work for hours without the user. Its boundaries are enforced by the host, not by
instructions to the model:

- **Nothing is approved by default for being unanswered.** A gate nobody answers is queued as a
  decision (`src/gate-deferral.ts`) and reported to the agent as not run; no caller can mistake a
  deferral for permission, because it travels as an error rather than an approval answer.
- **Run permissions are exact matches** (`src/plans/run-envelope.ts`): manifest-only dependency
  installs, named test/build/lint scripts, local commits without amend or hook skipping, and a push
  of the run's own branch to `origin` without force. Destructive tiers, service mutations, sequences,
  MCP calls, edits, unrecognized executables, inline code, shell wrappers, operator characters and
  outside-workspace paths are never covered. Permissions come from the user's preflight, live in
  the run's charter, and end with the run. The repository cannot set them.
- **Untrusted content raises the bar** (`src/plans/run-gate.ts`). After web, browser, MCP or
  service content enters the conversation, an unattended run stops letting the model reviewer approve
  network operations or MCP calls. The flag persists with the session through compaction and restore.
- **Tripwires are measured, not reported** (`src/plans/run-tripwires.ts`): deletions and
  out-of-territory changes come from comparing the run's private snapshots, so shell commands are
  included. A tripwire pauses; it never undoes or continues anything.
- **Isolated copies are containment, not a sandbox** (`src/plans/run-isolation.ts`). The copy is a
  git worktree outside the workspace, opened in its own window. A user-level `blacksite.workspaceRoot`
  would root that window elsewhere, so isolation is refused when one is set, and the copy window
  refuses to start a handed-over run whose tools are not rooted inside the copy. The handoff file is
  read once, deleted, and ignored after 30 minutes.

## Triage

For a possible committed secret, do not merely delete the line. Revoke or rotate the credential,
remove it from current source, determine whether repository history or a release artifact contains
it, and rewrite/publicly invalidate history only after coordinating with repository owners.

For a dependency advisory, follow the linked public reference, determine whether the vulnerable
code is shipped or development-only, update the lockfile through npm, and keep a narrow documented
exception only when no fix exists and exploitability has been reviewed. The default policy does
not support silent high/critical exceptions.
