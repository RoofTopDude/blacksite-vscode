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
  HTTP allowed for development), every connection/call is approval-gated, responses are bounded,
  and delegated lanes must ask the supervising parent to perform MCP operations.
- Extension updates must come from a `github.com` release URL and publish a SHA-256 digest. The
  downloaded bytes are bounded and verified before installation, and release-derived paths never
  pass through a command shell.
- Model-authored remote images are rendered as blocked placeholders. This prevents chat content
  from creating tracking-beacon requests under the user's IP.

## Triage

For a possible committed secret, do not merely delete the line. Revoke or rotate the credential,
remove it from current source, determine whether repository history or a release artifact contains
it, and rewrite/publicly invalidate history only after coordinating with repository owners.

For a dependency advisory, follow the linked public reference, determine whether the vulnerable
code is shipped or development-only, update the lockfile through npm, and keep a narrow documented
exception only when no fix exists and exploitability has been reviewed. The default policy does
not support silent high/critical exceptions.
