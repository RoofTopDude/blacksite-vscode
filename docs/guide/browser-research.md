# Browser & Research

Open **Settings → Agent & delegation → Browser & Research**. Confirm the allowed and denied source hostnames and, optionally, Brave as the search provider. The Brave key lives in VS Code SecretStorage. Direct `web_read` needs no search key.

An allowed hostname includes its dot-delimited descendants. `docs.example.com` does not authorize `example.com`. Public suffixes, shared-hosting suffixes such as `github.io`, wildcards, paths and IP literals are rejected. Names are normalized to lowercase ASCII, including internationalized names. Denies override every grant. Workspace lists replace user lists; the panel shows the effective policy. A user-level grant can therefore be shadowed by a workspace list.

Editing settings files can restrict access but cannot create new grants, remove an effective deny, enable a search provider or delegate review. Confirm widening in this panel. Human-confirmed policy is attested in SecretStorage for the workspace. On a different workspace, confirm that workspace's effective policy again. Session grants, delegated review and pending approvals do not survive restart or a chat change.

## Research tools

| Tool | Behavior |
| --- | --- |
| `web_request_access` | Requests human approval for up to ten candidate URLs, with a purpose. Choices are page once, domain for this session, always in workspace, always for user, or deny. URLs are redacted in the card. |
| `web_read` | Retrieves HTML/plain text using HTTPS on port 443. Returns source ID, requested/final citation URLs, title, retrieval time, bounded text, candidate links and `nextOffset`. Links are not automatically fetched. |
| `web_search` | Sends an exact reviewed query to the configured Brave API, including source restrictions. Returns only snippets whose domains independently pass the local policy. An empty source list never becomes unrestricted search. |

Source content is untrusted evidence, never an instruction channel. Cite the returned URLs and distinguish search snippets from pages actually retrieved. URL query values also require exact input review, including query-bearing redirects; domain approval alone does not approve transmitting those values. GET requests can have side effects on poorly designed services.

Reads check domain policy before every hop, validate the entire DNS address set, and pin the connection to a validated address while preserving TLS hostname verification. Private, loopback, link-local, metadata, multicast and reserved destinations are rejected. There is no second unchecked DNS lookup or automatic redirect following. Each network hop has a 20-second deadline and 2 MB limit; there are at most five redirects. Compressed responses are rejected unless the server honors `Accept-Encoding: identity`. Extraction is capped at 500,000 characters and returned in 16,000-character chunks. Each offset request retrieves the live page again; it is not an immutable snapshot. Citation URLs redact query values, so they may require the user's original URL to reproduce a query-specific source.

## Exact browser input

Interactive browser tools operate on **explicit local testing origins only** in this prerelease. Use `browser_snapshot` to discover field labels, types, frame/document IDs and host-issued element references. `browser_type` accepts a reference or unique CSS selector and replace/append behavior. Append review shows the complete final value. `browser_fill_form` reviews text, textarea/contenteditable, select, checkbox and radio values together. It never submits.

The docked approval panel stays visible across chat and settings. It shows the destination/frame document, full editable values and an escaped view for whitespace and invisible characters. Approve the proposal, edit and approve it, or deny it. There is no Allow All for browser input. Native fallback dialogs offer the same domain scopes and JSON-array editing of exact input values.

Entry exposes values to the page immediately: autosave and suggestion requests may run before submission. Approval occurs before focusing or filling a field. A stable element handle and document ID are checked again immediately before entry. Navigation, replacement, changed field values, expiration, cancellation or policy/reviewer revocation invalidate approval. A new snapshot invalidates old element references.

`browser_submit` and `browser_click` request separate human approval. For a form, this includes its current values and known action/method; changed form values invalidate the approval. Clicks use normal actionability checks, without forcing through overlays. `browser_tabs`, `browser_select_tab` and `browser_close_tab` provide explicit tab control; frame IDs target a specific frame. No absent-target fallback selects a different tab.

Form entry is sequential. A failure reports completed fields and skipped steps; do not replay already entered values or retry an uncertain submission automatically. `browser_run_script` uses the same managed boundary for every step, and authorization failures stop it even with `continueOnError`. Keys are limited to reviewed navigation keys; use structured entry for printable/editing keys and paste, and `browser_submit` instead of Enter. Arbitrary evaluate/capture scripts require a separate **human privileged local test script** approval. This approval permits the displayed local code and is not a claim of exact-string confinement inside arbitrary JavaScript.

Passwords, OTPs, payment/secret fields and uploads require manual handling. Captures and scripted actions are refused while recognized protected fields contain data. These checks are conservative field-metadata heuristics; do not put credentials in ordinary text fields or page scripts.

## Browser approval reviewer

Human review is the default. To delegate, enter **your original task**, explicit domains, search/fill operation classes, and a model ID in Browser & Research. The reviewer uses the currently configured provider and its existing credentials in a separate no-tools call. For Brave query review include `api.search.brave.com`; explicit local testing hosts may be delegated for form filling. The active indicator includes a revoke button.

The reviewer receives complete values, target metadata and the human task. Only a strict allow with the matching proposal ID/digest can execute. It cannot add domains, edit values, approve scripts, handle credentials or approve general submissions. Oversized proposals, invalid responses, provider errors and a 30-second decision timeout fall back to human review. A timed-out provider call may still finish in the background; its result cannot authorize entry. No automatic reviewer retries occur.

Child/unattended lanes do not inherit a parent's session grants or delegation. A lane requiring browser approval blocks and releases its worker rather than opening a modal or using a loop review as consent. Resume the task in the interactive parent when browser authorization is needed. Independent lane delegation and inherited grants are not exposed in this prerelease.

## Privacy, boundaries and current limitations

Exact pending proposals stay in memory. Audit entries retain IDs, digests, approver, verdict, model and timing, not raw field values. Browser/research tool-input copies are redacted for logs and transcript display; persisted tool results are omitted so a resumed task must inspect state and request fresh approval. This cannot remove data already present in user messages, executor/model context, page content or existing external records.

Public Chromium rendering remains unavailable because browser URL interception alone is not a proven private-network sandbox. The direct HTTPS research transport is the supported public-web path. Local contexts install persistent routing before any page, block service workers and WebSockets, and block cross-origin redirects. Same-origin GET redirects are fetched hop by hop and fulfilled at the original browser URL; relative-URL behavior can differ from ordinary navigation. WebSocket-based hot reload and apps requiring normal redirect semantics need manual testing. Recordings/replacement contexts receive the same policy. Local testing is not an OS sandbox, and privileged local code must be trusted.

PDF ingestion, authenticated personal-browser takeover, public HTTP/nonstandard-port exceptions, public rendered browsing and managed companion-bridge execution are unavailable. Terminal, desktop and arbitrary MCP networking are outside this feature's containment boundary and must never be used to bypass a denied research operation.

## Validation

Run `npm run test:unit` for matching, proposal/reviewer, trusted-settings, privacy and DNS-pinning tests. Run `npm run build:webview` and then `npm run test:browser` for real Chromium and built-webview fixture tests. It uses installed Chrome/Edge or Playwright Chromium; install the latter with `npx --no-install playwright-core install --with-deps chromium`. CI and release workflows run this suite. Tests use local fixture servers and no live websites, paid search APIs or model calls. The webview tests check full long-value display, invisible-character escaping, edit-and-approve messages, transient storage, and explicit delegation controls.

The browser suite checks actual server request counts for redirects, delayed fetches, popups and frames; zero input events before review; edited values; denied batches; stale nodes; partial execution; and protected captures. Transport tests verify full-address-set rejection and connection pinning against a changed resolver answer. These are evidence for the implemented boundaries, not a claim of system-wide Chromium confinement.
