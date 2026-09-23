# Changelog

All notable changes to the Blacksite VS Code extension are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## 1.24.0-pre.20

Prerelease. The stable update channel remains on 1.23.0.

### Fixed

- **Bedrock models picked through a global, Japan or Australia inference profile now work
  fully.** Blacksite recognised Claude only behind the `us.`, `eu.`, `apac.` and `us-gov.`
  prefixes. A `global.`, `jp.` or `au.` model, including the `global.anthropic.claude-sonnet-5`
  id AWS's own examples use, ran without thinking, without the effort setting, with unknown
  context and output limits, and without the newer cache marker. The model picker lists these
  profiles, so this could happen with no warning. Global routing is also the cheaper option on
  Bedrock.
- **The 1-hour prompt cache now works on the Bedrock Converse API.** The cache duration setting
  (1 hour by default) was ignored on Converse, which always cached for 5 minutes, so any pause
  longer than that paid to rebuild the cache. Converse now sends the 1-hour duration to the
  Claude models AWS supports it on (Haiku 4.5, the 4.5 and newer Sonnet and Opus models, and the
  current generation). Other models keep the 5-minute cache. If Bedrock rejects the 1-hour
  duration anyway, Blacksite falls back to the 5-minute cache instead of turning caching off.
  Cost estimates also stopped charging the 1-hour rate for models that only get 5 minutes.

### Changed

- **A Bedrock conversation that outgrows the model's context window is now compacted.**
  Converse reports this as `model_context_window_exceeded`. Blacksite treated it as a garbled
  response and retried with a larger output budget, which made the request bigger still. It now
  compacts the conversation, as it already did on the Anthropic API. To restore the old
  behaviour, turn off `blacksite.bedrock.extendedStopReasons`; the change applies from the next
  turn.
- **The default Bedrock Converse model is now Claude Sonnet 5** (`us.anthropic.claude-sonnet-5`),
  replacing Claude Sonnet 4 from May 2025. It keeps the same US routing, and a model you have
  already picked is never changed. To keep Sonnet 4 as the default, for example if your AWS
  account does not have Sonnet 5 access yet, turn off `blacksite.bedrock.latestDefaultModel`.

## 1.24.0-pre.19

Prerelease. The stable update channel remains on 1.23.0.

### Changed

- **Long agent turns through OpenRouter cost much less on Claude models.** Blacksite marked the
  start of each turn for caching, but not the tool results that pile up inside it. So on every
  step of a long task, all of that turn's earlier tool output was sent again at the full input
  price, and the extra cost grew with the square of the number of steps. The newest tool
  result is now marked as well, so earlier steps are read back from the cache at about a tenth
  of the price. If OpenRouter ever rejects the marker, Blacksite retries once without it and
  stops using it for the rest of the conversation.
- **Wide parallel tool rounds no longer throw away the conversation cache** (Anthropic,
  Bedrock). A cache marker only finds the previous cached point if that point is within about
  20 content blocks. One step with around ten parallel tool calls goes past that, and the whole
  conversation was then written to the cache again at the higher write price (double the input
  price on the 1-hour setting). Each request now also marks the point where the previous one
  ended, so that lookup always succeeds.
- **The agent's instructions now cover engineering judgement, not only tool use.** A new
  section asks for specific habits:
  - Decide what "done" means before the first edit.
  - Confirm a bug's root cause before fixing it.
  - Check who depends on code before changing it.
  - Think through how a change fails: concurrency, cancellation, partial failure, platform
    differences.
  - Match the style of the surrounding code.
  - Keep changes small but complete.
  - Never make a check pass by weakening it.
  - Only claim a test proves a fix after seeing it fail without the fix.
  - Report briefly what was verified and what was not.

  Delegated lanes now say which of their findings they verified and which they inferred.

### Fixed

- **"Update Now" no longer fails on slower connections.** The download used the 15-second
  limit meant for the update check itself. The update package is about 15 MB, so below about
  8 Mbit/s every update ended in "operation was aborted". Downloads now get five minutes.
- **Conversation compaction works again on OpenRouter models that always reason** (such as
  Gemini 2.5 Pro and OpenAI's o-series). Compaction asks the model not to reason. OpenRouter
  refuses that request for these models, so compaction failed every time and the conversation
  never shrank. When the model refuses, Blacksite now retries with the model's default reasoning
  setting. The same fallback covers OpenAI models that reject a reasoning setting.
- **Ticket prefixes with symbols work.** A `blacksite.tickets.idPrefix` such as `C++` made
  ticket creation fail outright. A prefix such as `A.B` also counted ids like `AxB-1` when
  numbering new tickets.
- **Edit diffs are no longer dropped too early in long sessions.** When several lanes edited
  at once, the memory count behind the reviewable diffs could keep rising after the diffs
  themselves were cleared. Once that happened, every later edit cleared the whole set.
- **Failed browser recordings clean up after themselves.** If starting a recording failed (the
  page timed out while reloading, or the action was cancelled), the browser kept recording
  every later action into a temporary folder that was never deleted.
- **Parallel preview renders no longer leave a stray headless browser running.** Two previews
  that both needed a new render browser at the same moment each started one. The first was
  never closed, even after the previews went idle.

## 1.24.0-pre.18

Prerelease. The stable update channel remains on 1.23.0.

### Fixed

- **Question-card previews written in JSX now work in projects that don't use React.**
  Previews are compiled with React's automatic JSX runtime, so any JSX at all, even a single
  `<div>`, needs React. In a game, CLI, Canvas or plain-DOM project the build failed with
  "Could not resolve react/jsx-runtime". Because every preview in a question card is built
  before the card is shown, one such preview rejected the whole question.
  Blacksite now ships React (the development build) for previews and uses it only when the
  workspace has no React of its own. A project that has React always uses its own copy, so
  two versions are never mixed. The agent is told when the bundled copy was used.
- **Preview build errors now point at the problem.** Every build failure used to end with
  "the imported package must already be installed", so a typo in the preview's own code sent
  the agent looking for a missing package. A syntax error now reports the line and column in
  the preview code, with the text around it (trimmed on long one-line previews) and a tip for
  the common mistake of an unquoted `--custom-property` key. The package advice now appears
  only when a module could not be found.
- **Mounting a named export no longer returns a spurious warning.** Every correct `mount` of a
  named export came back with `Import "default" will always be undefined`. A mount that asks
  for an export that doesn't exist now fails with the list of exports the file has, instead of
  silently rendering the default export.

The preview tool descriptions also tell the agent that the sandbox has no network access and
blocks `eval` and `new Function`, the same way the live question card does.

## 1.24.0-pre.17

Prerelease. The stable update channel remains on 1.23.0.

### Fixed

- **The agent can open files you attached, from this conversation or an earlier one.**
  Attachments are saved under `.blacksite/reference/<conversation>/`, but the agent was only
  ever told an attachment's name. When it tried `file_read` on that name, the path resolved
  against the project root and came back as a file that does not exist. Files attached in
  another conversation had no discoverable path at all.
  Each message with attachments now tells the agent where they were saved. `reference_list`
  returns a `workspacePath` for every attachment, and `allConversations: true` also lists the
  files from your other conversations in the workspace. If `file_read` is given a path that
  does not exist, it also checks the saved attachments. A single match is read, with a note
  giving the real path. Several matches return the list of saved paths rather than a guess.

## 1.24.0-pre.16

Prerelease. The stable update channel remains on 1.23.0.

### Fixed

- **UI preview renders now come back at the size you asked for, with no approval prompts.**
  `ui_preview_render` used to drive the agent's own browser page, and that failed three ways.
  The resize ran while the page was still blank, which the origin check treated as an escape,
  so the page was closed. Every render came back at 1280×800 whatever size was requested, and
  the agent was judging crop and wrapping on a frame the user never sees. The viewport and
  error-collection steps are approval-gated for pages the agent navigates, so every render
  also raised two approval cards for Blacksite's own document. In a delegated lane, which has
  nobody to approve, the first preview render aborted the whole lane.
  Previews now render in a fresh, exactly-sized context in a dedicated headless browser. It
  is confined to the one loopback address serving the preview, needs no approval, leaves the
  agent's browser session alone, and never opens a window or takes focus.
- **Preview builds no longer depend on Node.js being on your PATH.** When the workspace has no
  esbuild of its own, previews are bundled with the portable WebAssembly build Blacksite ships.
  That build started itself by running `node` from PATH, so on a machine without Node.js every
  mount preview and every workspace code preview failed with "No usable esbuild was found".
  This also hit macOS setups where Node comes from nvm or Homebrew and VS Code was launched from
  the Dock. It now runs on the Node runtime built into VS Code. Plain JavaScript previews also
  still run, with a warning, if no bundler can start at all.
- **A mount-preview patch that never reaches the component is now an error.** A patch to a
  file the entry does not import used to build "successfully" and render the unmodified
  component, so the preview did not contain the change it proposed. Patch paths are also
  matched through symlinks and drive-letter case, so a linked project folder cannot cause the
  same silent miss.
- **Browser detection finds more installs on both platforms.** On Windows: per-user Chrome and
  Edge under `%LOCALAPPDATA%` and Program Files on any drive. On macOS: `~/Applications` (the
  default when you install without admin rights). Beta, Dev and Canary channels, Chromium and
  Brave are also accepted. If no browser is found, the error says so and names the new
  `blacksite.browserExecutablePath` setting, where it used to tell the agent to run
  `npx playwright install`. Browser tools then stop being offered for the session instead of
  failing call after call.
- **Execution Runs open on a screenshot.** A run opened on its first key observation, which for
  a browser run was the "before" capture of step one, taken before anything had loaded. So
  the Runs view showed "No visual observation" even when every later step had a screenshot.
  Runs now open on the failed step's capture, or otherwise the most recent capture that has an
  image. That empty first capture is no longer taken, and only image-bearing captures take a
  place in the run's filmstrip, which now holds 40.
- **A step's own screenshots appear in the run.** Images from a `screenshot` step and the frames
  of a `capture_matrix` perspective sweep were stored but attached to nothing, so the Runs view
  could never display them. They are now that step's visual evidence, and no duplicate
  screenshot is taken on top. Video and desktop captures also join the filmstrip, so the
  sidebar loads their images too.
- **The Run Theater holds the last frame between captures.** The stage showed whichever
  observation was nearest the playhead, often one with nothing to display, so it went blank
  between most frames. It now shows the latest image at or before the playhead, as its own
  empty-state text always said it did.
- After a failed navigation, the failure capture now gets a screenshot. The blank page left
  behind is no longer treated as an escape from the run's allowed origins.

- **Attached images now reach the model on Windows the same way they do on macOS.** Jimp has no
  WebP decoder, so oversized WebP attachments could not be downscaled and `reference_zoom_image`
  could not open a WebP at all, except on macOS, where the system `sips` converter covered for
  it. A bundled WebAssembly libwebp now decodes WebP on every platform.
- **`reference_zoom_image` keeps the image's shape.** Width and height were capped at 1600
  separately, so zooming a wide screenshot squashed it: a 1920×1080 capture came back
  1600×1600. The crop is now scaled as one unit, and a single target dimension derives the
  other.
- **Attachment names are matched the way people type them.** macOS screenshot names put a
  narrow no-break space before "AM"/"PM", and Finder can pass accented names in decomposed
  form. The agent retypes both as plain characters, and the exact lookup reported the file as
  missing. Lookups now tolerate whitespace, Unicode-form and case differences, and accept the
  path or hash from `reference_list`. An ambiguous match is refused rather than guessed.
- **An image can no longer make the provider reject the whole turn.** Every image sent to the
  model now passes one check: attachments, zooms, `file_read` on an image, browser and preview
  screenshots, and run artifacts. The media type is read from the file's bytes, not its
  extension (a renamed JPEG labelled PNG was rejected outright). BMP, TIFF, HEIC and AVIF are
  converted. Anything over the byte limit or the 8,000-pixel side limit, such as a full-page
  screenshot, is downscaled, as JPEG when PNG will not fit. An SVG attachment now points the
  agent at `reference_read` instead of the zoom tool, which cannot open it.

### Added

- `blacksite.browserExecutablePath` (machine setting): the full path to a Chromium-based
  browser, for installs outside the detected locations.

## 1.24.0-pre.15

Prerelease. The stable update channel remains on 1.23.0.

### Changed

- **Every Blacksite view has its own activity-bar icon again.** Chat, Codebase Map, Plans,
  Tickets, Ticket Loops, Execution Runs, Base Context, Skills, Data and PAU are ten separate
  containers, in that order, rather than three groups with collapsed sections inside them.
  Reaching the map or the ticket queue is one click from anywhere again, instead of opening a
  group and expanding the right section. View ids are unchanged, so every `blacksite.*.focus`
  command and every **Blacksite: Open …** entry still opens the same panel, and any icon you
  do not want can be hidden from the activity bar's own right-click menu.

### Fixed

- **Conversation compaction no longer lets the summariser think.** Reasoning is now switched
  off explicitly on every provider: `thinking: {type: "disabled"}` with low effort for Claude
  on Anthropic and both Bedrock APIs, the shallowest rung the model accepts on direct OpenAI
  (`none` from GPT-5.1 on, `minimal` on GPT-5.0, `low` for the o-series), and the unified
  off switch on OpenRouter.
  This was the cause of the repeated compaction failures. Thinking tokens are billed against
  the same 8,192-token budget as the summary, so a model that reasoned first ran out of room
  mid-JSON and had the result thrown away — and on a long transcript that reasoning also spent
  the five-minute deadline. Both failures looked the same from the session's side: compaction
  never landed, the conversation kept running at full context, and the next attempt started
  from an even longer transcript. Off has to be sent rather than assumed, because several
  models — Sonnet 5 among them — run adaptive thinking when the field is simply absent.
- The compaction prompt now states its output budget and forbids commentary outside the JSON
  object, and the "ran out of output tokens" error points at the settings that actually shorten
  a transcript instead of suggesting a different model.

### Site

- The homepage now says which parts of it are interactive. The extension demo and the codebase
  map carry a live badge that pulses until it has been used and then settles, because both read
  as screenshots until touched, and a reader who never touches them never sees the product work.
- A section rail under the hero tracks where you are on the page and keeps Install one click
  away from anywhere in it.
- The closing call to action is now a three-step install block with the real VSIX filename and
  a copy button on the `code --install-extension` line, filled in from the published release.
- The release manifest is read on every page rather than only the homepage, so the header's
  Download button resolves to the actual file wherever you are, and every page carries the
  reading-progress hairline that previously only documents had.

## 1.24.0-pre.14

Prerelease. The stable update channel remains on 1.23.0.

### Added

- **Every file the agent edits can be reopened as a real diff, from the row that reported it.**
  A change row in the execution log — and in the conversation's Changes ledger, which outlives
  scrolling past the turn — now opens a side-by-side VS Code diff of the file as it was
  immediately before that tool call against the file now, scrolled to the first changed line.
  The right-hand side is the live file whenever it still matches what the call left behind, so
  a correction can be made without leaving the diff; it falls back to the recorded result once
  something else has touched the file, because showing later unrelated edits under this call's
  name would be a lie. A multi-file edit opens as a set from one action.
  Reviewing what the agent changed previously meant opening the file and reconstructing the
  edit from the tool's input JSON — the review step most likely to be skipped, and the one
  where a wrong edit gets caught.
- The before/after snapshots are taken per tool call, so a diff is always attributed to the row
  that caused it even with several delegated lanes editing at once, and cover every mutating
  file tool (edits, batch edits, JSON edits, whole-file writes, moves, symbol-targeted
  replacements) plus the lanes' own edits. They are held in the host's memory with explicit
  caps and oldest-first eviction, never persisted; a file too large or too binary to snapshot,
  or a change from a restored conversation, simply has no diff to open, and its row opens the
  file instead of promising one.
- A change that only differs in line endings reports no diff at all rather than a review
  surface VS Code would render as identical.

### Changed

- **Web research access is now granted per site, not per URL.** Approving one wikipedia.org
  link covers every page and subdomain of wikipedia.org for the session, and a batch of
  requested sources is one approval card answering one decision instead of a card per URL.
  Grants are scoped to the registrable domain with private suffixes honored, so approving one
  tenant of github.io, vercel.app, pages.dev or s3.amazonaws.com never approves another's.
  URLs already covered by policy are dropped from the card.
- A publisher's own same-site redirect no longer costs a second approval — wikipedia.org to
  en.wikipedia.org is one retrieval. Cross-site hops still re-enter policy on their own, and
  an explicit deny on the target still wins.
- Web approvals now appear as the blocked tool call's own gate in the chat's docked action bar,
  alongside every other pending decision, rather than in a panel floating outside the
  transcript. An approval that opens while another view is in front escalates back to the chat.
  Exact field values still travel only on the ephemeral research channel and never enter the
  persisted transcript. The modal fallback uses the same words as the in-chat card, so the same
  four decisions are not two vocabularies.
- The `web_request_access` and `web_read` tool descriptions and the system prompt now state the
  per-site, one-card-per-batch model, so the agent asks for every source it expects to need in
  a single call instead of one host at a time.

## 1.24.0-pre.13

Prerelease. The stable update channel remains on 1.23.0.

### Fixed

- Context compression now allows up to five minutes for a complete summary, with one shared
  deadline across retries. The previous 60-second limit repeatedly aborted long summaries.
  The session no longer repeats the compressor's entire retry sequence, and repeated transient
  failures retry after a cooldown instead of disabling automatic compression for the session.
- Compression failures identify the provider, model and timeout or API error. Empty summaries,
  truncated summaries and errors returned inside HTTP 200 responses preserve the active history.
- Choosing a separate compression provider without specifying a model now uses that provider's
  configured model. Compression also reloads credentials for each pass so key rotation takes
  effect during an existing session.
- Generated coverage reports are excluded from the extension package, with a packaging check
  to prevent them being shipped in future releases.

## 1.24.0-pre.12

Prerelease. The stable update channel remains on 1.23.0.

### Changed

- **The activity bar now uses three icons instead of ten.** Blacksite holds Chat, Base Context,
  Skills, Data and PAU; Codebase Map stands alone; Work holds Plans, Tickets, Ticket Loops and
  Execution Runs. Every view keeps its identity and its `…focus` command, so existing shortcuts
  and links still open the same panel — but ten icons from one extension crowded out everything
  else in a shared, finite strip. Secondary views start collapsed and mount on first expand, so
  opening a container no longer builds five webviews at once.
- Coverage is now measured and enforced. `npm run test:coverage` runs the unit suite with V8
  coverage against thresholds set just under current levels; CI and the release workflow both run
  it in place of the plain test step. The thresholds are a ratchet — raise them as real coverage
  climbs, never lower them to turn a build green.
- `eslint-plugin-jsx-a11y` now guards the webview. The rules that catch real breakage are errors;
  the judgement calls about interactive non-button elements are warnings.
- New `ARCHITECTURE.md`, `CONTRIBUTING.md` and `SECURITY.md`, linked from the README.
  `SECURITY.md` gives vulnerability reports a private route instead of the public issue tracker.

### Fixed

- pdf.js was being evaluated on every activation, in every window, whether or not the session ever
  opened a PDF — it sat on the static import chain from the extension entry point. It now loads on
  first use, cutting `out/extension.js` from 8.10MB to 6.75MB with no change in VSIX size.
- A combobox in the ticket editor put `aria-expanded` on a plain text input, whose implicit
  `textbox` role does not support it, so the popup's open state was announced to nothing. It now
  uses `role="combobox"` with `aria-activedescendant`, matching the Codebase Map's search field.
- Opening a file from the chat or data panels resolved the path lexically, so a symlink inside the
  workspace pointing outside it passed the containment check. Both paths now canonicalize before
  opening, matching what the agent runtime already did.
- Corrected a comment repeated across six webview providers that claimed the opposite of what the
  code does about `retainContextWhenHidden`.
- A stray encoding artifact in the README's Browser & Research entry.

## 1.24.0-pre.11

Prerelease. The stable update channel remains on 1.23.0.

### Changed

- The agent session and chat provider were split into focused modules. Provider wire
  formats (Anthropic, OpenAI/Responses, Bedrock, and the shared strict-tool schema),
  transcript hygiene, and the tool-output overflow store moved out of `agent-session.ts`;
  delegated-lane policy and attachment handling moved out of `chat-provider.ts`. Both
  files re-export everything they moved, so no behaviour and no import path changed.
- The chat webview message handler, a single 821-line method covering 60 message types,
  now delegates settings and credential messages to handlers of their own.

### Fixed

- The workspace context sent to the model no longer re-reads `.blacksite/context.md`,
  `memory.md`, and `workspace-rules.md` from disk on every tool call within a turn. They
  are cached against file mtime and size, so a note the agent writes mid-turn is still
  visible on its next step while a long turn stops paying for repeated reads of an
  append-only memory file. This completes the per-turn context caching begun for project
  shape, instruction files, plans, and base-context topics.
- A test covering image zoom could fail spuriously under full-suite parallelism: it
  imported `jimp` inside the test body, where a cold import could outlast the per-test
  timeout on a loaded machine. The import now happens once in a hook sized for it.

## 1.24.0-pre.10

Prerelease. The stable update channel remains on 1.23.0.

### Fixed

- The request mode selector (Plan/Debug/Review) in the composer now opens upward. It
  sits near the bottom of the panel, and the list previously opened downward and could
  run off-screen.

## 1.24.0-pre.9

Prerelease. The stable update channel remains on 1.23.0.

### Added

- A view switcher at the top of every Blacksite panel listing all workspace views and
  recent destinations, with a Back button to the previous view.
- Interface density (`blacksite.interface.density`). Comfortable enlarges text and
  controls across every panel; Compact keeps the previous density. The choice is
  user-level and synchronizes across open panels.
- Settings search over control names and explanations. Results name their workflow and
  section; choosing one opens that section, highlights the control and focuses it, and
  says when a control is conditional on a feature or provider. Credentials and live
  input values are never indexed.
- Cross-surface navigation for linked work: tickets open their plan, plan phases open
  their execution evidence, and runs open their ticket or plan.

### Changed

- Starter prompts (Plan a change, Fix an issue, Review code, Trace a workflow) moved
  into the empty conversation. Each fills the composer and selects its mode, and the
  prompt stays editable before sending.
- The composer keeps model and mode selection beside a Generation settings popover
  instead of inline controls.
- Settings remembers its last workflow and section. Longer explanations moved under
  Details, and status chips under Current configuration.
- Ticket selection and plan phase expansion survive a view rebuild.

## 1.24.0-pre.8

Prerelease. Corrects the synthetic credential fixture that prevented pre.7 from passing the release secret scan. Includes the Browser & Research changes below.

## 1.24.0-pre.7

Prerelease. The stable update channel remains on 1.23.0.

### Added

- Browser & Research settings with trusted domain grants, deny precedence, SecretStorage-backed Brave configuration, and revocable session permissions.
- Provider-independent web search, bounded DNS-pinned HTTPS reads, reviewed query values, and attributable source metadata.
- Exact browser input review with human edits, field snapshots/references, multi-field entry, frame/tab targeting, and separate submission approval.
- Optional Browser approval reviewer with explicit human task/domain scope, strict proposal digests, timeout fallback, and visible revocation.
- Real Chromium and built-webview regression suites, run in CI and prerelease packaging.

### Changed

- Browser authorization now lives at the shared runner boundary, including batches and sequences. Generic Allow All, unattended policies, and legacy runners cannot bypass it.
- Browser entry values are transient in approval UI and redacted from tool-log/transcript copies. Stale targets, cancellation and partial entry fail closed.
- Public Chromium rendering is unavailable until private-network confinement is proven. Public research uses the direct HTTPS transport. Local testing blocks service workers, WebSockets and cross-origin redirects; same-origin redirects retain the original browser URL. PDF, authenticated takeover, uploads and managed companion execution remain unavailable. See [Browser & Research](docs/guide/browser-research.md) for migration details.

## 1.24.0-pre.6

Prerelease. The stable update channel remains on 1.23.0.

### Changed

- Map folders now retain their own file groups instead of stretching toward
  cross-folder imports. Final spacing accounts for the occupied folder bounds
  and their outlines; existing cached maps regenerate with the new layout.
- More folder regions have visible outlines, borders remain readable when
  zoomed out, and small-folder labels retain their contrast.
- Moderately sized dense maps now bundle links between folders at overview
  scale, revealing individual file links when zoomed in.
- Zooming in reveals file names with collision-aware placement. Connected files
  receive label priority when a file is focused, and selected connection labels
  no longer stack over one another.

## 1.24.0-pre.5

Prerelease. The stable update channel remains on 1.23.0.

### Changed

- Chat diagnostics now use compact, expandable panels with error and warning counts,
  grouped duplicate messages, readable wrapping, and scrollable details.
- History compression now offers Background and Pause conversation modes in Context
  settings. Paused mode waits for compaction before the next model call while keeping
  Stop responsive. Background remains the default.

### Fixed

- Cancelling during pre-send compaction now ends the turn before another model call.
- Blocking compaction now reports its active runtime state while waiting.

### Documentation

- Added a Bedrock stability review covering AWS streaming and timeout guidance,
  existing recovery behavior, and Blacksite's map-note continuation limits. The
  reported session interruptions remain unconfirmed without failing-session logs.

## 1.24.0-pre.4

Prerelease. The stable update channel remains on 1.23.0.

### Fixed

- HEIC/HEIF photo attachments (the default format for iPhone photos) now decode on
  Windows and Linux, not only macOS. The attach-file picker always advertised HEIC/HEIF
  support, but only macOS actually had a decoder (via `sips`); other platforms failed
  silently. A cross-platform libheif-based decoder closes that gap on every OS, with
  macOS's ImageIO bridge kept as a last-resort fallback for whatever it still declines.
- `test.run` against a Jest or Vitest project could fail on Windows before the runner
  ever started: `npx` resolves to a `.cmd` shim there, and spawning it without a shell
  is refused outright, a failure this tool silently misreported as "Could not parse
  structured test output" instead of a diagnosable error. Test-runner spawns (Jest,
  Vitest, pytest, Go) now route through the same Windows-safe spawn path shell/process
  tools already use, and pytest falls back from `python` to `python3` when the former
  isn't on PATH (current macOS ships no bare `python` at all).
- Stopping a long-running background process (`process.kill`) could leave the real
  process running on Windows: a dev server started via an npm/npx-style `.cmd` shim is
  wrapped in a `cmd.exe` layer, and killing only that wrapper orphaned the process it
  launched. `process.kill` now closes the whole process tree on Windows, matching the
  one-shot `shell_run` cancellation path that already did this.

## 1.24.0-pre.3

Prerelease. The stable update channel remains on 1.23.0.

### Added

- The chat activity row now shows what a provider is doing during a live request —
  waiting, reasoning, responding, preparing a tool call, or retrying — with an
  elapsed timer, so a quiet pause no longer reads as indistinguishable from a hang.
- Attached RTF and EPUB files now extract real text (RTF's control words and cp1252
  escapes; EPUB's chapters in true spine/reading order) instead of producing no
  extractable text. Legacy binary Office files (.doc/.xls/.ppt) still aren't
  parsed, but the error now names the format and suggests the modern extension
  instead of a generic "unsupported binary format."

### Fixed

- A provider stream that ends without its real completion signal (stop reason,
  Bedrock's messageStop, OpenAI's finish_reason) is now retried instead of
  silently completing the turn with whatever partial text happened to stream.
- Bedrock's prompt-cache fallback, used when a model rejects cache markers, now
  strips them from every request field instead of only the system block; retry
  backoff honors a provider's Retry-After header instead of always guessing.
- A crafted or corrupt xlsx cell reference could drive spreadsheet text
  extraction into a runaway loop. Numeric XML entities in the UTF-16 surrogate
  range no longer decode to corrupt characters.

### Maintenance

- Added test coverage for the browser screenshot/capture_matrix tooling and the
  Windows desktop-capture path, neither of which had any before.

## 1.24.0-pre.2

Prerelease. The stable update channel remains on 1.23.0.

### Changed

- Refined the Codebase Map while preserving its star field and territory colors:
  clearer Blacksite branding, larger summary counts, a dedicated search field, and
  more readable display controls with distinct active states.
- Display & analysis can collapse to leave more room for the canvas and starts
  collapsed in sidebar widths. Selection cards use the available sidebar width;
  controls adapt to search and indexing notices, and the desktop legend has its
  own space below the control panel.

### Maintenance

- Updated compatible dependency versions in the lockfile to clear the release
  security audit.

## 1.24.0-pre.1

Prerelease. Reaches only installs with `blacksite.updates.includePrerelease` enabled; the
default update channel stays on 1.23.0.

### Added

- **Skills are a first-class surface** — a skill is a stored procedure for a recurring class of
  work: a `SKILL.md` with frontmatter, optionally alongside `reference/` files it points at.
  The agent sees a one-line roster of what is available in its workspace state every turn and
  loads one with `skill_read` when the work matches. Nothing else in the harness filled that
  quadrant: Base Context and memory are always-loaded *facts*, request modes are four fixed
  postures we ship, plans are *this* work rather than a reusable method. Skills are numerous,
  authored, loaded only on a match, and composable — several at once, under whichever request
  mode is active.

  A loaded skill lands in the message tail beside the request profile, **not** in the tool
  result. That is deliberate: a tool result is exactly what compaction drops, so a long run
  would lose the procedure it was following partway through, and returning it in both places
  would put two copies of it in context. Checkpoints carry the skill *body* rather than its
  name, so a resumed run follows the procedure it was actually following instead of whatever
  that file says now.

  Ten built-in skills ship, and they are strictly about **using this harness well** — the
  Codebase Map's five-beat workflow, map-note taxonomy, the ticket/plan/todo split, delegation
  trade-offs, Execution Run authoring, the verification gate, question-card altitude, context
  hygiene, the ticket queue, and how to author a skill. Domain and language knowledge is left
  to you and the agent. Precedence is workspace > personal > built-in, and the panel says which
  copy won rather than leaving an edit that appeared to do nothing.

- **A Skills panel to author them** — lists every skill with its origin, what shadows what, and
  why an unavailable one cannot load. The new-skill form lints as you type, and spends most of
  its rules on the `description`, because that is the only part of a skill in context before it
  loads and therefore the entire basis on which it is ever chosen. A weak description does not
  produce a weak skill; it produces an unused one, and the failure is invisible. It also warns
  when a body outgrows progressive disclosure. "Draft in chat" hands the job to the agent,
  composing the request in the composer so you send it and review the draft before it saves.

  The agent can propose one itself with `skill_write` — the way it files a ticket for a problem
  it noticed — writing only into `.blacksite/skills/`. It will not touch a personal skill in
  `~/.blacksite/skills`, and a name a built-in already uses produces a workspace copy that
  shadows it rather than an in-place edit that the next update would erase.

  `/skills` opens the panel; `/skill <name>` composes the request to load one.

## 1.23.0

### Added

- **The Codebase Map skips dot-directories** — `.vscode-test`, `.pytest_cache`, `.gradle`, `.idea`
  and their kin hold tooling state, not authored source, and are no longer indexed. On this
  extension's own repository that removes **566 of 1,256 files (45%)**, 560 of them a downloaded
  VS Code build kept as a test fixture. Those files were previously read, import-scanned, laid out
  by the force solver, and drawn — and they skewed cul-de-sac detection, cycle detection, and the
  capacity profile auto-selected from the true file count. Dot-*files* such as `.env` and
  `.eslintrc.json` are still indexed; the service lens reads them as evidence. When the rule hides
  anything the map now says so above the search box, with a one-click **Show**. Controlled by
  `blacksite.graph.excludeDotDirectories` and `blacksite.graph.dotDirectoryAllowlist` (add
  `".github"` to keep workflows on the map).
- **Depth is a real dimension on the map** — stars now sit at genuine distances: far ones fade
  toward the background, shrink slightly, draw behind their neighbours, recede in their edge
  connections, and drift more slowly than the foreground as you pan. What distance *means* is
  selectable under **Layers → Depth** — folder nesting (default), connectedness, entry→leaf
  position, commit recency, change frequency, or file size — with an intensity slider whose `Flat`
  setting restores the previous rendering exactly. Nesting is the default rather than
  connectedness because star size already encodes how connected a file is, and spending depth on
  the same signal would say one thing twice.

- **Workspace PDFs are readable in place** — `reference_read` and `reference_search` now accept a
  `path` to a PDF already in an open project folder, not just a conversation attachment, so a spec
  or datasheet committed to the repository no longer has to be re-attached to be cited. Paths are
  resolved against the open workspace roots and re-checked after symlink resolution, so this
  read-only surface cannot follow a link out of the workspace; the agent only ever sees
  workspace-relative paths, never machine-specific absolute ones. Deliberately PDF-only — other
  project files continue to go through `file_read`.

### Changed

- The map's exclusion policy is now data rather than two hand-maintained literals, and the render
  cache records the policy it was built under, so changing either setting rebuilds instead of
  leaving a stale map on screen.

### Fixed

- Corrected the tool reference: it listed `search`, `search_code`, and `add_comment`, which do not
  exist, and understated the GitHub, GitLab, Jira, Confluence, and Salesforce tool surfaces. Also
  documents `sequence_annotate`, the browser-recording retention settings, the ticket settings, and
  the integration host settings, which had shipped undocumented.

## 1.22.1

### Changed

- **Modern MCP compatibility** — supports the stateless 2026 MCP discovery flow over HTTP and
  stdio, including self-describing tool calls and safe, schema-declared parameter headers.

### Fixed

- MCP connections now keep tool caches, credentials, and allowlists scoped to their actual
  destination; retargeting or changing credentials invalidates stale state. Local stdio servers
  launch from the workspace, removed secret environment variables are deleted, and rapid panel
  changes cannot overwrite each other.
- Hardened MCP and OAuth redirect handling so credentials and POST bodies do not follow a redirect
  to another origin. Long-lived stdio connections now bound incomplete frames rather than lifetime
  traffic, and cancelled requests leave reusable local servers running.

## 1.22.0

### Added

- **Page-addressable PDF references** — attached PDFs are indexed page-by-page in the background,
  preserving page numbers, printed labels, metadata, outlines, and extraction progress. The agent
  can read an explicit page range with `reference_read` or use the new deterministic
  `reference_search` tool to jump directly to page-numbered matches without requiring embeddings.
- **Large PDF attachment support** — picker attachments now copy and hash in one bounded-memory
  stream and may be up to 256 MB. Pasted/base64 attachments retain their lower safety limit.

### Changed

- PDF semantic chunks stay within page boundaries and carry page citations through vector-search
  results. The bundled PDF.js worker now ships in the VSIX so installed builds use the same
  page-aware extractor exercised in development.

## 1.21.0

### Added

- **PAU cache economics (Beta)** — the PAU panel now reports what the prompt cache is actually
  doing and what it costs to disturb it. A new observed layer derives cache hit ratio, prefix
  stability, invalidated tokens, and reads-per-write from the provider's own usage counts, so it
  works even on a provider whose rates are unknown. Where rates are resolvable, a cache-economics
  layer adds the break-even read count for the configured TTL — answering empirically whether a
  1-hour cache breakpoint is paying for itself — and prices every hog segment by the warm prefix
  its removal would force a rewrite of. A large, stable segment in a warm prefix is not a hog; it
  is cache ballast, and it used to be ranked as the worst offender in the session.
- **Advisory optimization plans (Beta)** — each receipt now carries a suggested plan, re-ranked by
  net value after charging each action for its cache blast radius, with governance-locked segments
  reported separately. Purely advisory: the plan is rendered for a person, is never fed back into
  the model's context, and nothing is applied automatically.

### Fixed

- The PAU trace now matches the request that was actually sent. It previously omitted
  `stripUnsignedThinking` on the Anthropic path, and on the OpenAI path analysed a system prompt
  without the compressed-history summary the wire body carries — so on long, compacted sessions,
  the measurement diverged most from reality exactly where it mattered most. The OpenAI system
  string now has a single definition shared by the request path and the trace.
- PAU now counts the wire tool catalog. Tool schemas are part of every request body and lead the
  cache prefix, but no messages trace contains them, so the analysis under-counted by the size of
  the whole catalog and charged the difference to heuristic tokenization — depressing the token
  accounting grade that the rest of the feature gates on.
- PAU receipts no longer collapse fresh input, cache reads, and cache writes into a single total
  before analysis. The three differ by up to 20x in price, and the distinction is what the entire
  cache layer is computed from.

## 1.20.0

### Security

- Shell and long-running process commands now resolve bare executable names from trusted `PATH`
  entries before spawning. `cmd.exe` searches the working directory first, so a repository-local
  `git.cmd` could previously run under the identity of the allowlisted system binary. An explicit
  executable path is never treated as the allowlisted tool sharing its basename and always needs a
  one-shot approval.
- Commands able to load project scripts, plugins, hooks, repository configuration, or a nested
  shell now require approval even when the nominal subcommand looks read-only. Version probes and
  a small set of direct file utilities stay prompt-free, and a binary on the persisted
  `blacksite.permissions.autoApprove` list still runs without a prompt.
- Agent-launched processes — shell, long-running processes, git, and the test harness — now share
  one minimal environment, so provider tokens, cloud credentials, and CI secrets are no longer
  ambient authority for workspace code.
- `test_run` requires approval before executing workspace test code, and both test tools reject
  roots, working directories, and filters resolving outside the workspace — symlinks and junctions
  included. Jest and Vitest runs use `npx --no-install`.
- Browser tools that navigate, script, or interact with a page now require approval, and browser
  navigation is limited to `http(s)` URLs without embedded credentials, including navigations
  nested inside `browser_run_script`. Origin-scoped sessions block every off-origin request rather
  than only top-level navigations.
- Preview rendering no longer writes the model-authored document to a temp file and grants the
  browser `file:` access. It is served from a short-lived, unguessable loopback URL under a strict
  CSP and an exact-origin browser scope.
- `rg --pre` and `find -exec` / `-execdir` join the inline-execution argument blocklist.

## 1.19.0

### Added

- **Workspace Rules editor** — the Base Context panel now includes a dedicated editor for
  explicit, workspace-local operating instructions. Rules are atomically stored in
  `.blacksite/workspace-rules.md` and loaded into every agent run with clear precedence guidance.
- Git/PR-aware workflows can now collect branch, merge-base, commit, diff, remote-provider, and
  pull-request-template context in one operation. GitHub pull requests and GitLab merge requests
  also expose review, discussion, file, and pipeline context to the agent.
- Successful edits now create a visible verification gate. The agent must run a relevant test,
  diagnostic, command, or preview before finishing, with a bounded fail-open path that clearly
  reports any remaining unverified changes.
- Session and plan cost guardrails now support warning thresholds and hard USD ceilings. Session
  ceilings can stop the active response; plan ceilings automatically pause execution and revoke
  approval until the plan is reviewed and resumed.

## 1.18.5

### Fixed

- Mounted preview rendering now uses a portable WebAssembly esbuild fallback when the workspace
  has no working native installation. Releases are packaged once on Linux but installed across
  macOS, Windows, and Linux, so preview screenshots no longer fail on macOS because a Linux native
  binary was included in the VSIX.
- Image attachments from macOS (HEIC, HEIF, TIFF, and AVIF) now fall back to the built-in ImageIO
  service when the portable decoder cannot read them. The converted image is available both to
  inline model vision and `reference_zoom_image`.
- `reference_zoom_image` can now be called with just an attachment name to inspect the full image
  before choosing crop coordinates, instead of forcing the agent to guess a region blindly.

## 1.18.0

### Changed

- The prompt-cache TTL (Anthropic-direct, Bedrock Mantle, and OpenRouter's Claude/Gemini
  cache-control path) now defaults to 1 hour instead of 5 minutes. A real coding session
  routinely has gaps over 5 minutes — reading a diff, testing, thinking — which previously
  expired the cache and forced the whole conversation prefix to be rewritten at the write
  premium instead of read back cheaply. Anyone who already set an explicit preference in
  Settings keeps it; this only changes the default for sessions that never touched it.
- New-session creation now shares one model-catalog fetch between its two concurrent lookups
  (context length and max output tokens) instead of firing it twice on a cold cache.

## 1.17.0

### Added

- **PAU (Beta)** — a new sidebar panel that measures what's consuming the agent's context window
  each turn: token load, duplication, replay across turns, and hog segments, graded for accounting
  fidelity. Off by default (`blacksite.pau.enabled`) while it gets real-world testing. Purely
  read-only instrumentation — it never changes what is sent to the model or how compaction behaves.
  Bedrock Converse sessions aren't measured yet; use the Mantle API or Anthropic/OpenAI directly.
- Edit tools (`file_edit`, `file_edit_batch`, `json_edit`) can now carry an optional one-sentence
  rationale from the agent, shown on the approval card and the completed diff entry. A new
  "Explain this diff" button asks the agent to walk through a specific change.

### Changed

- General responsiveness improvements: smaller per-webview CSS payloads, deferred loading of
  image/jq tooling until first use, cached several per-turn workspace reads, a lighter Codebase
  Map redraw on search/selection, and fewer redundant model-catalog network calls. No visible
  behavior change.

## 1.16.2

### Fixed

- Transcript documents generated by the agent now open directly in VS Code's rendered Markdown
  preview instead of the raw text editor.

## 1.16.1

### Security

- Bumped transitive dependencies (brace-expansion, dompurify, fast-uri, js-yaml, nanoid,
  pdfjs-dist) to close five high-severity and one moderate advisory. No direct dependency range
  changed; all fixes landed within existing semver ranges.

## 1.16.0

### Added

- Tickets can now be organized into subtasks. Setting a ticket's parent forms a tree — a parent
  that would create a cycle is rejected at write time, and a stale or hand-edited link is healed
  at read time — with children shown in the ticket detail panel and a compact count on the board
  card.
- A ticket's linked Execution Runs are now clickable, opening the run directly in Run Theater.
  Run Explorer and Run Theater in turn show a run's linked tickets — and plan/phase, when set —
  as chips you can jump to, instead of the id-only text that led nowhere before.
- MCP servers can now be authenticated. OAuth signs you in through your browser using the MCP
  authorization profile — protected-resource and authorization-server metadata discovery, dynamic
  client registration, authorization code with PKCE, silent refresh, and an RFC 8707 resource
  indicator binding the token to the server it was issued for. Servers with static credentials are
  supported through a bearer token or a header of their own choosing, and stdio servers through
  secret environment variables. Every credential lives in VS Code SecretStorage, never in settings
  and never in a tool schema the model can read.
- The MCP panel now lists every tool a server offers, with descriptions, and lets each one be
  switched on or off individually. A tool switched off is filtered out of the catalog the agent
  receives and its invocation answers exactly as an unknown tool name does, so the capability
  leaves no trace in the conversation for the model to reason about or ask for. A per-server
  **New tools** setting decides whether tools discovered later are admitted automatically or held
  until reviewed.
- The MCP panel gained a connection test, per-server protocol and identity reporting, static
  headers, environment variables, and inline editing of every server field.
- Each server's admitted tool names now appear in the workspace-state block, so the agent can call
  a tool directly instead of spending a turn on discovery.

### Changed

- The Execution Runs panel is now named consistently everywhere — the sidebar view, its
  container, and the Run Theater editor tab previously disagreed with each other (one said
  "Execute Run", another just "Run Explorer"). The "Cancel Current Run" command, which stops the
  agent's current response and has nothing to do with an Execution Run, is now labeled "Stop
  Response" to remove the naming collision between the two.

### Fixed

- A question card with several questions, or with a long context/detail block, could push its own
  answer choices and Submit button out of view with no way to reach them. The docked question bar
  now scrolls internally, with its pager and Submit controls pinned to the bottom so they stay
  reachable regardless of how long the questions run.
- MCP clients now perform the `initialize` handshake and send `notifications/initialized` before
  any other request. Servers that refuse traffic before initialization — which includes most built
  on the official SDKs — could not be used at all before this.
- Streamable HTTP sessions now carry the `Mcp-Session-Id` issued at initialize and the
  `MCP-Protocol-Version` header on every subsequent request, and recover when a server forgets a
  session. Servers that assign a session previously failed after the handshake.
- The legacy HTTP+SSE transport (MCP 2024-11-05) is now implemented as a real transport and is
  fallen back to automatically when a server does not accept Streamable HTTP POSTs.
- `tools/list` now follows the pagination cursor to the end of the catalog. Servers with more
  tools than fit in one page previously advertised only the first page.
- stdio servers now run as one long-lived process per configured server instead of a fresh spawn
  per call, which removes a full server boot from the cost of every tool call. Server-to-client
  requests (`roots/list`, `ping`) are answered rather than ignored, and banner output on stdout no
  longer breaks the connection.
- Oversized inline base64 in a tool result (screenshots, audio, binary blobs) is replaced with a
  description of what was there instead of being pasted into the conversation verbatim.
- Approval prompts for MCP operations now name the destination — the remote origin or the local
  command line — rather than describing it generically.

## 1.15.1

### Added

- Authored selection previews and `ui_preview_render` can now import installed packages, local
  JavaScript/TypeScript modules, CSS, shaders and visual assets. A workspace-relative
  `resolveFrom` context makes dependency resolution work from the correct app or package in a
  monorepo.
- Successful UI preview render calls now retain an openable screenshot in the conversation, with
  viewport, sandbox-error and build-warning context, so users can inspect the same visual evidence
  the agent used before presenting a selection.

### Fixed

- Compiling a question-card preview no longer mutates the model's historical tool-call arguments.
  That reference leak could turn a small authored preview into a 39 MB Responses API argument,
  exceeding OpenAI's 1 MiB per-call limit and duplicating the bundle through active history, full
  history, checkpoints and webview state until VS Code's renderer terminated for OOM.
- Existing sessions containing oversized historical tool inputs are repaired during restore and
  bounded again before every provider send. Preview bundles are minified, capped at a 4 MB
  sandbox budget, and omitted from duplicated runtime/checkpoint state when large, preventing a
  single dependency graph or production-size 3D asset from destabilising the editor.

## 1.15.0

### Added

- Visual preference questions now operate at product/design-system altitude instead of collapsing
  into low-level styling choices. The agent is explicitly required to inspect the active
  project's screens, assets, tokens, stored preferences, product domain and target viewport; to
  offer materially different complete directions; and to render/review each consequential option
  before asking. SVG, Canvas 2D, WebGL/WebGPU, animation and production-style 3D scene concerns
  (geometry, camera, lighting, materials, depth and motion) are all first-class preview media.
- The comparison editor is now a visual stage rather than a set of small collapsed accordions.
  Candidate previews open by default, may use up to 900 px of height, and can be focused at full
  editor width. Mounted previews also bundle imported images, fonts, media, GPU shaders and common
  3D assets into the sandbox, while remaining offline and isolated.
- Project styling auto-discovery now recognizes fingerprinted CSS in common build asset folders
  and conventional source entries such as `src/globals.css` when no dedicated Blacksite preview
  stylesheet has been produced.

## 1.14.2

### Fixed

- **A failed parallel lane left its sibling lanes running unsupervised.** When one lane in a
  parallel subagent group threw, the merged event stream ended immediately but never closed the
  other lanes — abandoning an async generator does not stop it. Those lanes kept calling tools
  (edits, shell commands) and kept spending tokens against a turn that had already reported
  failure. Every lane is now closed on the way out, whether the merge ends by error, by the
  consumer walking away, or normally.
- **Each of six webview views leaked its message listener on every hide/show.** None of these
  views set `retainContextWhenHidden`, so VS Code disposes them when hidden and rebuilds them
  when shown — but Chat, Map, Plans, Tickets, Data and Base Context all registered their
  listeners into the extension-lifetime subscription list, stranding one dead listener, and the
  dead webview it held, per cycle. They now scope registrations to the view that owns them, as
  Runs and Loops already did. Three of the affected files also carried comments asserting the
  opposite, which is what let this persist.

### Changed

- Consolidated the last private copy of the JSON cache reader into the shared helper.

## 1.14.1

### Fixed

- **Security: a `shell_run` or `process_start` argument could run a second command on Windows.**
  Arguments are passed to cmd.exe as a command line, and one containing a metacharacter but no
  whitespace — `build&calc` — was written to that line unquoted, so cmd read the `&` as a
  command separator. Because the approval gate classifies risk from the named binary, the
  smuggled command was never classified and never prompted. Every argument is now quoted unless
  it consists solely of characters cmd treats as ordinary text.
- **Durable state could be lost outright if the extension host died mid-save.** Tickets, plans,
  loops, base context and map notes were each written with a single in-place overwrite. A write
  interrupted by a crash or force-quit left invalid JSON, which every reader treats as "absent"
  and replaces with an empty document — so the surface came back empty and the next edit made
  that permanent. These documents are now written to a temp file and moved into place atomically,
  keeping the previous copy as `.bak`, and a torn primary file falls back to it on read.
- Automatic updates no longer leave the downloaded VSIX behind. Each check created a temp
  directory that was never removed, stranding roughly 7 MB per offered update.

### Changed

- Ticket territory resolution no longer rebuilds its index once per ticket. Refreshing the
  tickets surface, scheduling a loop, and computing map ticket-heat all resolve a whole queue
  against one prepared index — on a 50,000-file repository with 300 tickets that is 2,510 ms of
  blocking work reduced to 17 ms, with identical results.
- Consolidated the atomic-write, JSON-read, `ensureDir`, `nowIso` and `newId` helpers that had
  been copied privately into as many as eight modules apiece.

## 1.14.0

### Added

- Question-card previews now render against the project's own design system. The compiled
  stylesheet — design tokens, component classes, utility layer and the product font — is loaded
  into every preview, so an option can be drawn with the real class names instead of a
  hand-written approximation of them. Resolution is workspace-first, with
  `blacksite.preview.projectStylesheet` to point at a specific stylesheet.
- New `ui_design_tokens` tool, listing the tokens and component classes a preview can actually
  use. Guessing class names renders unstyled, which is a large part of why previews fell back to
  hand-rolled CSS.
- Preview options can now `mount` a real component instead of reimplementing it. The named entry
  is bundled from the workspace with the proposed edits applied in memory — the working tree is
  never touched — so the preview is the actual component under the actual change, and the patch
  is the implementation.
- New `ui_preview_render` tool, which renders a candidate preview headlessly and returns a
  screenshot at the size the chat frame will give it, plus any errors thrown inside the sandbox.
  Previews were previously authored blind and only failed in front of the user.

### Changed

- The preview baseline defers to the project stylesheet for body typography and background when
  one is present, so a preview inherits the product's type rather than overriding it.
- The inline chat frame, the side-by-side comparison panel and the headless renderer now build
  their preview documents from one shared implementation.

## 1.13.3

### Fixed

- Fixed Windows automatic updates failing with `spawn EINVAL`. VSIX updates now use VS Code's
  native installer first, and a failed CLI launcher no longer prevents fallback candidates.

## 1.13.2

### Changed

- Made the Loops workbench denser and more consistent with the chat and plan surfaces. Active
  lane timelines remain inspectable in a compact bounded stream instead of expanding the sidebar.
- Start, stop, delete, draft creation, loop notices, and restart recovery now stay inside the
  styled Loops workbench rather than opening native VS Code dialogs.
- Interactive agent choices stay compact in Chat. Visual comparisons are now opened on demand,
  and their live previews are collapsed and height-bounded until the user asks to inspect one.

### Fixed

- Corrected continuation-review calls for OpenAI GPT-5 and o-series models by sending
  `max_completion_tokens`, preventing routine loop approvals from failing with a 400 response.
- Pinned the GitHub Pages release workflow to the documented artifact/deployment action contract
  after the newer artifact upload action stalled, so `latest.json` is refreshed with each release.

## 1.13.1

### Changed

- Refined the Loops workbench into a calmer operational dashboard with consolidated metrics,
  clearer live and blocked states, and a connected activity timeline.

### Fixed

- Restored reliable vertical scrolling in short and narrow activity-bar layouts.
- Routed editor-native file edits, batch/JSON edits, moves, language-server mutations, resource
  operations, and opaque code-action commands through the loop's Continuous Review agent. Loop
  lanes no longer surface VS Code approval modals; a reviewer refusal blocks only that ticket,
  frees the worker slot, and lets the supervisor advance the remaining queue.

## 1.13.0

### Added

- **A full Ticket Loops workbench.** Loops now use the same retained React surface treatment as
  the rest of Blacksite, with responsive controls, live status, queue visibility, lane-level
  subagent inspection, compact tool timelines, reviewer decisions, and direct handoff to Chat.
- **Independent continuation review for unattended approvals.** A no-tools reviewer evaluates
  each gated subagent operation against the ticket, declared territory, acceptance criteria, and
  the user's original request. Routine file creation and edits can proceed without waking the
  user; unsafe, irreversible, ambiguous, or out-of-scope operations block only their ticket while
  the supervisor continues dispatching other safe work.
- **Per-execution loop accounting.** Every start or resume creates a durable execution ledger with
  its own timestamps, outcome, attempted/succeeded/failed/blocked counts, and spend, alongside
  lifetime totals for the loop.
- **Distinct Execute Run and Ticket Loops icons** in the activity bar.

### Changed

- `loop_control inspect` now gives the chat agent recent lane activity, continuation-review
  decisions, active workers, and per-execution spend so it can explain and safely manage loops
  without making the user translate raw loop state.
- Unattended question cards are converted into ticket-level blocks instead of opening a prompt
  that can strand a worker while the user is away.
## 1.12.0

### Added

- **Parent-owned Execution Run strategy.** The agent now knows when retained runs earn their
  cost, how to reuse prior evidence, discover stable surfaces, build bounded falsifiable
  sequences, link plan/ticket lineage, inspect targeted evidence, compare baselines, and place
  verification checkpoints across a long plan. Delegated lanes report verification needs; only
  the parent agent creates, executes, resumes, annotates, compares, and reviews runs.
- **Agentic Ticket Loop setup and supervision.** `loop_propose` analyzes the durable queue into an
  inert draft with exact matches, blockers, territory collisions, first-wave scheduling,
  conservative cost, and recommended concurrency. `loop_control` can list, pause, stop, or tighten
  ceilings, but cannot start, resume, widen, or make unattended spend decisions for the user.
- **Opt-in continuous plan execution.** The continuation conductor is now called after settled
  turns, preserves the user's original prompts, can continue serially across multiple turns, and
  stops to ask or halt on ambiguity, drift, safety, security, irreversibility, or a configurable
  consecutive-turn ceiling.

### Changed

- **Execution Runs now follow a browse â†’ review flow.** The activity-bar view is a compact run
  picker, digest, step summary, and workbench launcher; detailed evidence is progressively
  disclosed instead of filling a narrow sidebar by default. Opening the editor workbench
  automatically closes the sidebar.
- **The Execution Workbench now matches Blacksite's visual system.** It uses the same committed
  dark ground, Lexend typography, violet/blue accent field, orbit marks, glass hairlines, quiet
  depth, and muted signal tones as chat, the site, and Project Relay. Transport and agent-review
  actions stay visible while retention, baseline, map, and cancellation actions move into a
  focused overflow menu.

### Fixed

- A continuation-authored turn that settled while its conductor call was still unwinding was
  discarded, causing automatic continuation to stop after exactly one extra turn. Settled turns
  now queue behind the in-flight decision and resume serially without overlapping model calls.

## 1.11.1

### Changed

- Corrected the ticket-loops build order, which still listed the Loops view and the
  `LoopDispatcher` adapter as outstanding after 1.11.0 shipped both. The remaining work is now
  stated accurately: agentic loop setup (`loop_propose` / `loop_control`) is unbuilt, and the
  continuation conductor — implemented and tested in 1.11.0 — has no caller yet, so plan
  recovery remains a one-shot reconciliation at activation rather than a continuous
  decide-or-halt cycle.

## 1.11.0

### Added

- **Ticket loops.** A supervised, unattended drain of the ticket queue: name a queue and a
  worker budget, and the extension works tickets until the queue is empty or a ceiling trips.
  Dependency-aware scheduling honours `blockedBy`, and `Ticket.territory` acts as a write lock
  so parallel lanes never hold overlapping files. New **Ticket Loops** view with start, pause,
  stop, and park-release actions.
- **A loop never closes a ticket.** Completed work moves to `review` for a person to check —
  `drained` means every ticket was attempted, not that any were verified. The UI says so.
- **Per-loop approval posture.** Each loop declares which approval tiers its lanes may proceed
  through unattended. Anything else parks the ticket, frees the worker slot immediately, and
  surfaces it for you rather than holding a lane until morning.
- **Plan-execution recovery.** At activation, plan steps left `in_progress` by an interrupted
  session are returned to `pending` with a note explaining the interruption. No agent session
  survives a host restart, so such a step was previously a standing lie the next session
  believed.
- **A continuation conductor** for long-horizon work: a fresh agent holding the user's original
  prompts verbatim decides whether stalled work should continue, and writes the message that
  continues it — answering questions the executor raised about phases it has not reached. It can
  halt outright on safety, security, irrecoverable, intent-drift, or incoherence grounds, and
  every unparseable verdict resolves to a halt rather than to "keep going".

### Fixed

- **Subagent lanes no longer time out while still working.** The fixed spawn timer fired whether
  or not the lane was active. Replaced with a progress watchdog: `idleTimeoutSeconds` is a
  silence window consumed only while the child emits nothing, and `maxRuntimeSeconds` is a much
  larger ceiling. Time spent blocked on a human approval is excluded from both clocks.
- **Subagent follow-ups now render.** A follow-up's answer was discarded outright — the check
  guarding it asked whether the lane had produced any text, and the lane was already full of its
  original answer. Lanes now track rounds; a follow-up reopens the lane in place, streams
  visibly, and shows the question that prompted it.

## 1.10.0

### Added

- Opt-in browser video evidence through explicit paired `video_start` and `video_stop` sequence
  actions, with bounded adjacent keyframe sampling and automatic finalization when a run fails.
- Native video playback in the Execution Workbench, one-click recording preservation, and a
  **Flag frame** action that retains the paused frame as searchable evidence for later agent review.
- Workspace settings for the recording disk budget, keyframe interval, quality-decay age, and
  deletion age. Preserved videos are exempt; extracted and flagged keyframes survive cleanup.
- Targeted `sequence_inspect` artifact selection so the agent can inspect individual neighboring
  or user-flagged frames without copying an entire recording into model context.

### Changed

- Long recordings progressively thin older sampled frames while keeping recent samples dense,
  preserving temporal coverage without unbounded memory growth.
- Unpreserved recordings are reduced with local `ffmpeg` when available, then deleted at expiry or
  when the configured quota is exceeded. Recording data remains local and video capture is off by
  default.

## 1.8.0

The rest of the Execution Runs work: the run theater gets a real transport and learns to explain
itself, and the agent gets the capture vocabulary that design work actually needs.

### Added

- **A proper timeline, on an elapsed-time axis.** The transport was a range input over sequence
  numbers — the wrong axis for a trace, because sequence numbers are uniform and a run is not, so
  a four-second step and a four-millisecond one occupied identical width. Now: a filmstrip of real
  captures at their real moments, step bands showing which step owned which stretch of time,
  per-channel event lanes tinted by severity, a playhead spanning every track, and zoom that keeps
  the point under the playhead fixed rather than sliding it away as you close in. Frames either
  side of the playhead are decoded ahead of use, so scrubbing lands on a ready image instead of a
  flash of nothing.
- **`capture_matrix` — the same subject from several perspectives, in one observation.** A single
  screenshot answers "does it render". Design work asks what it looks like *from the other side*,
  at the other breakpoint, with that parameter changed — and answering that as N separate steps
  scatters the evidence across N observations nothing relates to each other. Each perspective can
  run a script (orbit a 3D camera, change a material, toggle a state), set a viewport for a
  breakpoint sweep, or scroll; every frame lands in one observation, which needed no schema change
  because `visualArtifactIds` was always an array.
- **A post-run report that answers what the run actually did.** Not another event list — the
  stream and the timeline are already that. A verdict in one sentence, including whether
  irreversible effects landed, because nothing in the product previously answered *"is my
  workspace dirty right now?"*. Then blast radius grouped by consequence, a **promise-vs-reality**
  diff against the preflight manifest that surfaces undeclared file writes and unexpected origins,
  an evidence ledger that seeks the timeline, and any perspective sets captured. It replaces the
  stage in place when a run settles, with a toggle back to the replay.
- **A desktop adapter contract** (`src/sequences/desktop-adapter.ts`), design only and not yet
  implemented. The security model is decided here rather than improvised later next to a native
  input dependency: applications are identified by executable path — never window title, which is
  text a process can rename itself into — authorization is exact rather than prefix-based, every
  desktop input is classified `external_mutation` and irreversible, and reading anything outside
  the target window is excluded outright.

### Changed

- `EntityRefScheme` gains `external-app`, so a driven application is a first-class touched entity
  in blast radius and search rather than an untyped string.
- The preflight manifest is now readable back from a run's trace. It had no store of its own,
  existing only as an event payload; the accessor takes the *last* `preflight_*` event, since a
  revalidated manifest supersedes the original and comparing against the superseded promise would
  report differences that were approved away.

## 1.7.0

Execution Runs, which has been the most structurally complete feature in the extension and the
least usable: a rich event-sourced trace that could only be read through a 300px sidebar.

### Added

- **A run now opens in an editor tab and plays live.** *Blacksite: Open Run in Editor* follows a
  single run as it happens — step rail, the newest visual capture, a tailing event stream, and a
  transport to scrub back through it. Deliberately a separate surface from the sidebar rather than
  a wider version of it: the sidebar browses every run and replaces its state when you switch, the
  theater follows one run and appends. They share their domain layer and nothing else.
- **The agent can drive the pointer itself, not just its destinations.** `mouse_path` walks the
  cursor through waypoints with interpolation, so hover states, drag thresholds, `pointermove`
  handlers, canvas/WebGL orbit controls and game input all see the intermediate positions instead
  of a teleport to an element's centre. With it: `drag` (press-move-release along a path), `scroll`
  (wheel deltas), `hover` (selector or raw coordinate), and `key` (page-level presses, with
  `holdMs` for a held movement input, which a press cannot express). The engine was always
  Playwright — this was a vocabulary gap, not a capability one.

### Fixed

- **Screenshots now appear while scrubbing a run.** They were never failing to decode: a webview
  URL was minted only for the *selected* observation's artifacts, so every other frame was handed
  to the timeline with no source to load at all. The mintable set is now the run's key
  observations plus the current selection.
- **The Run Explorer stopped re-serializing itself on every store mutation.** It rebuilt the whole
  view — every run, every step, every observation, plus an event window read back off disk — per
  change, because the change event's `runId` was discarded and `queueMicrotask` merged nothing
  (each mutation in the sequence loop lands in its own macrotask). Now filtered by run, skipped
  while hidden, and debounced on a real timer.
- **A succeeded run no longer looks like a cancelled one.** The status pill had no tone for
  `succeeded`, `partial`, `timed_out`, `skipped`, `awaiting_approval`, `validating` or `created`,
  so seven of the nine run states rendered in the same muted grey.

### Changed

- **Store change events carry what changed.** They always fired with `{kind, runId, ids}` and both
  subscribers discarded the argument, so anything wanting to update incrementally had to re-query.
  Each now carries the records just written plus a trace watermark, taken straight off state — no
  scan, no disk — which is what lets the theater stay live without reading anything back.
- Side-effect data (`RunStep.sideEffects`) was already crossing the wire and being discarded by a
  missing type declaration in the webview protocol. It is now typed, along with a failure's
  `completedSideEffects` — the field that answers "is my workspace dirty right now?".

## 1.6.0

Driven by a real 635-iteration session log rather than by inspection. Two of these were costing
money and wall-clock on every turn, and one feature turned out never to have been connected.

### Fixed

- **The prompt cache on the OpenAI Responses path was inverted.** Across the measured session,
  68.7% of all input tokens were cache *writes* against 24% reads — a 2.87:1 ratio, on a model
  family where a write bills at 1.25x fresh input. The cause is the one the Chat Completions path
  already documented and fixed for itself: implicit caching auto-anchors the *newest* input item,
  the newest item here is the per-turn workspace context tail, and a breakpoint keyed on content
  that never recurs can only ever be written. The reads that did land were a single cold prefix
  cached before any tail existed, which is why the cache-read figure sat flat near 30k while
  writes climbed all session. The Responses path now places its own explicit breakpoints — the
  static prefix and a rolling anchor on the newest user turn — so the conversation comes back as a
  read instead of being rewritten every turn.
- **A rejected prompt-cache parameter could no longer be retried away on that path.** The
  one-shot recovery stripped breakpoints out of `messages` only, which was correct while
  Responses carried none; now that it does, retrying a rejected request would have re-sent the
  breakpoints that caused the rejection. It sweeps `input` too.
- **UI preferences were never being recorded.** `.blacksite/ui-preferences.json` stayed at
  `{"preferences": []}` through sessions that made a dozen explicit visual choices. The store,
  the schema, and `upsertUiPreference` had all been there from the start with no caller. Answers
  to preview-bearing `question_card` questions are now captured as they are given, keyed by an
  optional `preferenceKey` so a later decision about the same element supersedes the earlier one
  instead of accumulating beside it.

### Changed

- **Question-card previews start themed instead of blank.** A preview runs in a sandboxed iframe
  that inherits nothing, and the shell was a bare white page — so every preview had to invent an
  entire visual system before it could show the one thing it was actually proposing, and they
  came back looking like unstyled test pages rather than like the product. Previews now open on a
  surface carrying the viewer's live editor theme, a matching font stack, a box-sizing reset and
  styled scrollbars, plus short semantic variables (`--bs-bg`, `--bs-fg`, `--bs-accent`,
  `--bs-surface`, `--bs-border`, `--bs-mono`, …) layered over the bridged `--vscode-*` palette.
  Both surfaces that render previews share one substrate, so an option looks identical inline and
  in the side-by-side comparison panel.
- **The default preview height moved from 160px to 260px.** 160 could not hold a realistic
  component, let alone a layout with a header and a row of controls, so previews were being
  authored down to whatever survived the frame rather than up to what the decision deserved.
- **The system prompt now covers tool-call batching.** In the measured session 64% of iterations
  issued exactly one tool call, for a mean of 1.62 — while model latency alone accounted for 185
  minutes across 635 iterations, at 18.1s per round-trip. That latency, not the tools (most
  return in single-digit milliseconds), is what makes a long run feel slow. The prompt now asks
  for independent calls in one turn, with an explicit test for independence, and is equally
  explicit that genuinely dependent calls should stay sequential — batching those would just mean
  acting on assumptions that were about to be evidence.

## 1.5.2

### Changed

- **Update checks now run every three hours, and keep running.** The interval was twelve hours,
  but the more consequential half was that the check only ever fired at activation — which made
  the interval a ceiling on staleness rather than a period. A window left open for a week never
  re-checked, so an install picked up a release only when its user happened to restart, and a fix
  shipped for a bug they were actively hitting could sit unoffered indefinitely. A live window now
  re-checks on the same three-hour cadence. Every existing gate still applies: it stays off if
  `blacksite.updates.checkOnStartup` is `false` (now re-read per tick, so toggling it needs no
  reload), never runs outside a production desktop host, and a version you declined is not
  re-offered on the next tick.

## 1.5.1

### Fixed

- **A backend blip on the OpenAI Responses API no longer ends the run.** That endpoint reports a
  mid-stream failure with a *symbolic* code — `"server_error"`, not `429` — and the classifier ran
  it through `Number()` before checking it against the retryable HTTP statuses. Every real error
  event therefore scored `NaN` and was declared fatal, which made the mid-stream retry layer
  unreachable from this provider path even though it was working for Anthropic, Bedrock and Chat
  Completions. Flex-tier turns were the visible victim: flex queues server-side and gives up under
  load exactly this way, so a long agent session would die partway through on a failure that one
  retry would have cleared. Symbolic codes are now classified by name, and an unrecognised code is
  retried rather than treated as fatal — the request has already cleared validation by the time
  this event can arrive, so a post-200 failure is far likelier to be the backend than the request.
  The invalid-request family is still failed fast, since retrying it only repeats it.
- **Those failures said what went wrong.** The same handler read the provider's message from the
  flat event shape only, so the nested `{"error":{...}}` form that proxies and some failure paths
  send left it with nothing — the run ended on a bare `OpenAI Responses stream error` carrying no
  code, no message, and no way to tell a throttle from a broken request. Both shapes are now read,
  and the code and message are preserved into the reported error.
- **`response.failed` is classified the same way.** It carries the same error payload and fails for
  the same reasons, but threw a bare `Error` that the retry layer could only read as fatal — which
  would have left the run-ending path alive through a second door.

## 1.5.0

A sweep across all four providers, in the same spirit as 1.4.0's OpenAI pass: what each one
currently supports, what it has quietly stopped supporting, and where the cost accounting was
guessing. Two of these were failing every turn for anyone who had the relevant setting on.

### Fixed

- **Fast mode no longer fails every turn on Claude Opus 4.7.** Anthropic *removed* fast mode from
  4.7 — `speed: "fast"` there is now a hard error rather than a silent downgrade to standard
  speed. The eligibility floor moves up to Opus 4.8, the one rule in the capability table whose
  threshold had to move backwards instead of extending forwards.
- **Thinking-off no longer 400s on Claude Opus 5 at high effort settings.** Opus 5 accepts
  `thinking: {type: "disabled"}` only at `high` effort or below; paired with `xhigh` or `max` it
  rejects the request. Neither field is invalid alone, so no per-field capability check could
  catch it — the effort rung is now clamped to the cap when thinking is off, which keeps the
  setting the user actually reached for instead of quietly switching thinking back on.
- **Cache tokens were missing from every Anthropic-family cost estimate.** The pricing tables
  carried no cache read or write rates, and the estimator drops any category it cannot price.
  This is the worst place for that gap to be: the Anthropic path places cache breakpoints on
  purpose, so most of a long run's prompt is served from cache and the reported spend was a
  fraction of the invoice. Rates are now derived from each model's input rate (a read is 0.1x, a
  write 1.25x), so a model added later can't inherit prices with the cache columns blank.
- **The 1-hour cache TTL is now billed at its real premium.** A 1-hour breakpoint costs 2x input
  per cache write against the default 5-minute breakpoint's 1.25x — a setting the extension has
  offered all along while costing both at the same rate.
- **Claude Sonnet 5 is billed at its introductory rate until the rate expires.** It runs at
  $2/$10 per MTok through 2026-08-31 and $3/$15 after. A single hardcoded figure is wrong on one
  side of that date or the other, so the rate is resolved against the clock — and re-resolved per
  lookup, since a host process running across the cutover would otherwise quote the old number
  for the rest of its life.

### Added

- **Claude Opus 5 and Claude Mythos 5**, across the Anthropic, Bedrock Mantle, and OpenRouter
  catalogs with full pricing, 1M context, and a 128K output ceiling. Bedrock Mantle's default
  model moves to `anthropic.claude-opus-5`.
- **Refusal fallback now covers Claude Opus 5**, which shipped with the same elevated
  cybersecurity safeguards as Fable 5 — benign security and life-sciences work trips them often
  enough that a declined turn would otherwise end the run with empty content.
- **The refusal fallback routes by refusal category.** It now sends `fallbacks: "default"` rather
  than a pinned `claude-opus-4-8`, so a cyber decline and a bio decline can land on different
  substitutes and there is no hardcoded model name to migrate when that one is retired.

### Changed

- **First-run default models move to the current generation** — Claude Sonnet 5 for Anthropic and
  OpenRouter, GPT-5.6 Terra for OpenAI. This applies only where a provider has no saved model; any
  install that has ever used the model picker keeps its choice. Each default stays in the same
  tier rather than jumping to the provider's flagship, so nobody who never opened the picker lands
  on a materially pricier model. Sonnet 5 is in fact cheaper than the Sonnet 4.6 it replaces while
  its introductory pricing lasts.

## 1.4.0

OpenAI's GPT-5.6 generation changed prompt caching from something that happened to you into
something you configure, and changed cache writes from free into a billed category. This
release teaches the OpenAI provider both halves of that, and fixes the cost accounting that
had been quietly under-reporting OpenAI spend for far longer than the 5.6 line has existed.

### Added

- **GPT-5.6 Sol, Terra and Luna.** All three are in the model catalog with their real context
  window (1.05M, not the 400K the earlier 5.x line uses — inheriting that figure tripped
  auto-compaction at ~38% of capacity), 128K output ceiling, and full four-category pricing.
  The bare `gpt-5.6` alias routes to Sol, as it does upstream.
- **Explicit prompt caching for GPT-5.6+.** Requests now carry
  `prompt_cache_options: {mode: "explicit"}` and mark the reusable prefix with
  `prompt_cache_breakpoint` on two stable anchors — the static system prompt and the rolling
  end of the conversation — mirroring what the Anthropic and OpenRouter paths have always done.
- **Extended cache retention for pre-5.6 models.** `prompt_cache_retention: "24h"` is sent
  where it applies. Without it a zero-data-retention organization silently gets the `in_memory`
  policy, whose 5–10 minutes of idle tolerance a single code review outlasts.
- **Fast mode.** OpenAI renamed Priority Processing to Fast on 2026-07-30; the tier picker now
  offers `Fast`. Settings saved as `priority` keep working — OpenAI still accepts the old
  spelling and routes it to the same place.

### Fixed

- **The cache hit rate on the GPT-5.6 family.** Implicit caching — the previous behaviour, and
  still OpenAI's default — places its breakpoint on the *newest* message. The newest message on
  every request here is the volatile workspace-context block, so each turn wrote that block into
  the cache at the 1.25x premium 5.6 introduced and none of those tokens could ever come back as
  a read. The explicit breakpoints above move them out of `cache_write_tokens` and into
  `cached_tokens` on the following turn, which is the number the cache-rate readout reports.
- **Cache tokens were missing from every OpenAI cost estimate.** The OpenAI pricing table had no
  cache-read or cache-write rates at all, and the estimator deliberately drops any category it
  cannot price rather than guessing. On a long agent run — where the cache carries most of the
  prompt — the reported spend was a fraction of the invoice, flagged only by a `partial` marker.
  All OpenAI models now carry both rates.
- **Cache writes were reported as zero on Chat Completions.** `cacheWriteTokens` was hardcoded,
  so on 5.6 (the first family to report and bill them) those tokens were invisible in the usage
  readout and costed as ordinary input. Both OpenAI endpoints now read `cache_write_tokens` and
  subtract it from the input total, keeping input + cacheRead + cacheWrite equal to the reported
  prompt size. The Responses path was reading the field but not subtracting it, which
  double-counted those tokens.
- **Flex and Fast turns are costed at the tier that actually served them.** Cost was computed at
  standard rates regardless of tier, so an honoured flex turn was over-reported 2x. The tier is
  now read back from the `service_tier` OpenAI echoes on the response — not the one that was
  requested, which OpenAI may decline — so a flex turn downgraded to standard on a capacity miss
  is billed at standard, and one that was honoured at half.
- **A rejected prompt-cache parameter no longer ends the run.** Which caching dialect a model
  speaks is inferred from its id, which is a threshold guess for anything newer than this build.
  A wrong guess now costs one round trip: the turn retries once with the cache parameters
  stripped, the same way an unsupported service tier already retried at the account default.

## 1.3.1

### Fixed

- **The copy button on transcript code blocks copies.** Every fenced block renders a `Copy`
  control in its header rail, but the Markdown sanitizer's allow-list had no entry for
  `button` — so DOMPurify removed the element and hoisted its label into the header as bare
  text. What was left looked close enough to a button to invite a click and had nothing
  behind it to receive one. The renderer's own output is now checked against the allow-list
  by test, since this class of bug fails silently: the element disappears at the last step of
  rendering, long after the code that emits it was verified.
- **A refused clipboard now says so.** The copy handler swallowed clipboard errors, which
  reproduced that same dead-button symptom whenever the async Clipboard API declined — as it
  does when the webview is not the focused document. It now falls back to a selection copy,
  and reports `Copy failed` if that fails too.

## 1.3.0

### Added

- **Execution Runs retain how a result was produced.** Bounded browser, workspace-read,
  process, and test sequences now record ordered events, synchronized screenshots and state,
  partial failures, side effects, artifacts, and lineage in a local searchable run store.
- **Run Explorer and Codebase Map playback.** Retained traces can be scrubbed without
  rerunning them, inspected around semantic anchors, compared by stable step or surface, pinned
  as baselines, cancelled while active, and promoted into evidence-linked tickets.
- **Six provider-neutral sequence tools.** The agent can discover surfaces, execute a sequence,
  inspect retained evidence, compare runs, perform conservatively validated logical resumes,
  and search visual and operational history while existing approval policy remains authoritative.

## 1.2.4

Answers you give the agent are the one thing in a session that cannot be recovered by trying
again — re-running a tool costs a tool call, "re-running" a question costs you another
interruption. This release closes every path where one could be lost without saying so.

### Fixed

- **An answer that cannot reach the agent now says so instead of vanishing.** Submitting a
  question card whose run had already ended — cancelled, errored, or replaced by a new chat —
  marked the question answered on screen and discarded the answer host-side without a word.
  The card was still sitting in the action bar looking answerable, so the failure was easy to
  hit and impossible to see: the agent simply proceeded as if it had never asked. Unroutable
  answers and approvals are now reported, logged, and the card is closed with the reason.
- **Cancelling a run closes the questions it was waiting on.** A cancelled or cleared run left
  its question cards and approval prompts live in the docked action bar, wired to a gate that
  no longer existed. They now close as *unanswered* — deliberately distinct from *declined*
  and *denied*, because nobody decided anything.
- **A reloaded panel no longer strands an in-flight question.** Moving the chat between side
  bars or reloading the window rebuilt the webview with the persisted transcript only, which
  never contains the live turn's pending card. The agent kept waiting on an answer the user
  could no longer see or give. Open questions and approvals are now replayed on reconnect.
- **Starting a new chat stops the run it abandons.** `New chat` archived the conversation but
  left the previous run streaming into a session that no longer existed.
- **Your answers survive context management.** With context editing enabled, Anthropic and
  Bedrock Mantle were told to clear stale tool results with no exclusions — so a long enough
  session dropped the user's own answers server-side and the agent carried on without them.
  `question_card` results are now excluded from clearing, protected from local emergency
  shedding, and called out to the summariser so compaction preserves them verbatim.

## 1.2.3

### Fixed

- **Configured workspace roots now take effect.** `blacksite.workspaceRoot` was ignored whenever
  VS Code had an open folder, while its default empty string also prevented the documented
  extension-host fallback when no folder was open. Root selection now has explicit, tested
  precedence: configured override, first open folder, then the host working directory.
- **Release packages no longer inherit local editor state.** An untracked `.vscode/settings.json`
  was being copied into the VSIX, making the published extension depend on the packaging
  machine. `.vscode/**` is excluded and every package is now inspected for required runtime
  files and forbidden development artifacts before it can be uploaded.
- **Tag releases enforce the complete verification gate.** Release builds now run lint in
  addition to tests, both typechecks, and the production build, matching the checks on `main`.

## 1.2.1

A follow-up review of the ticket work in 1.2.0, looking for the same class of defect: a
surface that exists on one side of a seam and was never wired to the other.

### Fixed

- **Renames and copies now appear on the Codebase Map.** The map lights up the files the
  agent touches, but the table driving it never covered `file_move` or `file_copy` — the
  single most structurally significant file operation left the graph silent, and the live
  activity chip couldn't say where a file was going. Both ends of a move are now traced,
  along with `file_mkdir`, `code_hierarchy` and `code_inlay_hints`.
- **Ticket calls read as work in the transcript.** With the tools finally reachable, every
  ticket call rendered as a bare label with no detail — no id, no title, no filter. They now
  show what they are doing ("Filing ticket · retry backoff drifts", "Reading ticket · BLK-12")
  in both the result rows and the live activity line.
- **Icons for the tools that were quietly missing them.** The Codebase Map's note tools and
  the whole reference family showed the generic wrench, which reads as deliberate rather than
  as an oversight. Database tools also stop rendering as "Db Run Read Query".
- **`ticket_promote` no longer over-promises.** It described its output as being in
  `plan_create`'s shape when the two differ: the file list belongs to the first phase, and a
  ticket's labels and references have no plan equivalent at all. It now states the mapping,
  so promoting a ticket doesn't cost a turn spent guessing or quietly drop the references.
- **Six source files were opaque to search.** They carried a raw NUL byte where a `\u0000`
  escape was meant — a deliberate separator written in a form that makes ripgrep report
  "binary file matches" and refuse to print them, and that made `src/graph/layout.ts` binary
  to git, silently exempting it from the repository's own line-ending normalization. The
  behavior is unchanged; the files are text again, and layout.ts is normalized to LF.

### Changed

- Three seams that previously drifted are now asserted by tests: every tool in the catalog
  reaches the model, every tool has an icon, every ticket tool routes to a real store
  operation, and no source file carries a raw control byte.

## 1.2.0

### Added

- **The ticket queue, rebuilt as something you can live in.** Tickets and the Board now share one
  surface language: compact rows instead of cards, a status ring that fills as work progresses and
  a priority glyph that grows as it matters, both readable in greyscale. Collapsible group headers,
  a persistent search box, a filter menu whose every active choice shows as a removable chip, and
  grouping and sorting that survive tabbing away. Built for a queue that reaches several hundred —
  rows render in windows as you scroll, closed work stays collapsed, and the result count is always
  on screen so a filtered list can never quietly pretend to be the whole queue.
- **Keyboard-first, on both surfaces.** `j`/`k` move, `↵` opens, `[`/`]` advance status, `1`–`4` set
  priority, `c` files, `/` searches, `e` edits, `Esc` backs out. Scoped to the panel, so nothing is
  stolen from the editor beside it.
- **A real ticket, not just a title.** Tickets now carry **acceptance criteria** (what done means —
  statements, not steps, so the no-progress rule still holds), **references** to specs, PRs and
  upstream issues, an **assignee** (you or the agent), a **duplicate-of** marker, and both
  directions of the blocking relationship — a ticket now shows what it blocks, not only what blocks
  it. Everything is reachable from a detail pane that opens beside the board and in place in the
  sidebar.
- **A creation flow worth using.** One dialog for filing and for editing, with autocomplete on every
  relation field: files and areas search the live Codebase Map index, labels offer the vocabulary
  already in use, and ticket and plan pickers search by title rather than demanding you know an id.
  The one-line filing bar still exists for when a title is all you have — `⌘↵` promotes it into the
  full form mid-thought.
- **Two layouts, one filter set.** The Board toggles between columns and a list without losing your
  search, filters, or selection — columns for moving work along, the list for finding one thing
  among three hundred.
- **`ticket_get`.** The agent can read one ticket in full, including every comment. Investigation
  recorded on a ticket now survives the session that produced it in a form a later session can
  actually retrieve.
- **A missing tool is now a dead end, not a loop.** When the agent runs a command this machine
  doesn't have (`npm`, `npx`, `brew`, `python`, `cargo`, …), the run used to look like a command
  that succeeded silently, so the agent kept re-issuing it until the turn ran out of iterations.
  It is now reported as an explicit failure that names the tool, and the session refuses further
  calls to it — including ones nested in a shell line (`bash -lc "npm ci"`) — so the turn spends
  its remaining budget on something that can actually work.
- **One-click install for a missing tool.** The editor offers the install command for the host
  platform (winget/choco, Homebrew, apt/dnf) and prefills it into a terminal for you to run, or
  opens the tool's install page. Nothing is executed without you pressing Enter.
- **Full sampling controls per model.** Settings → Generation now exposes every sampling
  parameter the selected model actually accepts — Top P, Top K, Min P, frequency, presence and
  repetition penalties, and seed — read from the provider catalog rather than a fixed list. This
  is most visible on OpenRouter, where models like Kimi, DeepSeek and GLM accept far more than
  the temperature slider previously offered. Each control is unset by default, leaving the
  model's own default in charge, and clears back to it.

### Changed

- **Searching and paging the queue from the agent side.** `ticket_list` takes free text matched
  across title, description, labels, acceptance criteria and territory, filters by assignee, and
  reports `matched` alongside a `nextOffset` that appears only while more remain — so "that was the
  first 25" can no longer be mistaken for "that was all of them".
- **Ranking knows who owns what.** `ticket_next` promotes work the user handed to the agent, sinks
  work they kept for themselves, and sinks known duplicates. Tickets assigned to the agent are named
  in the per-turn context block, so a standing instruction doesn't need a tool call to be remembered.
- **Deleting a ticket now asks first, and names it.** It was previously immediate and irreversible
  from a single click.
- **Mid-run commentary reads as a sequence, not a wall.** Text the agent writes between tool
  calls is now presented as numbered progress updates, with its final answer rendered separately
  beneath them. Previously every stretch of prose in a turn — status updates from minutes apart
  and the conclusion — was concatenated into one undifferentiated block.

### Fixed

- **The agent can actually use the ticket queue.** Every `ticket_*` tool was defined, dispatchable,
  toggleable in Settings, and the queue was summarized into the agent's context every turn — but the
  family was never advertised to the model, so the agent could read the backlog and had no way to
  file, comment on, rank, or promote anything in it. The tools are now offered whenever the project's
  ticket store is available, in the main session and in delegated lanes alike. A test now asserts
  that every tool in the catalog reaches the model, so a whole family cannot go missing again.
- **The system prompt documents the whole ticket family**, not just filing: which surface owns what
  (ticket = durable outcome, plan = how it gets done, todo = scratch for the step in flight), reading
  a ticket's history before starting it, asking the queue what to pick up next instead of eyeballing
  the summary, treating a sweep as proposals to review, and leaving `done` to the user.
- **Ticket relations can no longer disagree with themselves.** Relations are reconciled on every
  read: ids pointing at deleted tickets are dropped, `relatedTo` is made symmetric from either end,
  and the blocking edge has exactly one authority, so removing a blocker from either side removes it
  for good. A ticket size set by mistake can now also be cleared back to unsized.

## 1.1.0

### Added

- **Subagent follow-up.** `subagent_followup` re-opens a finished lane with a new message, keeping
  everything it already had in context. Following up costs one message where a fresh lane would
  have to rediscover the files, commands and reasoning behind the original answer. Follow-ups run
  one at a time, get their own budget, and the most recent lanes stay resumable for the
  conversation.
- **Lanes report back even when they run out of budget.** A lane that times out or ends without a
  final answer returns `partialAnswer`, `executionTrace`, `filesTouched`, `toolRounds` and a
  `failureKind` (`timeout` / `cancelled` / `no_answer` / `error`), so the agent can continue from
  what was gathered, narrow the task, or resume the lane — rather than starting over.
- **Segmented reasoning in the transcript.** Thinking is recorded as one segment per burst, each
  carrying the tool calls it produced. Collapsed to a single row by default — duration, step count,
  and a live readout of the current line — and expandable into the sequence of decisions the turn
  actually followed.
- **Syntax highlighting for untagged code blocks**, detected by language. Most visible in reasoning
  output, where snippets are often written without a language tag.
- **Themed select controls** across Settings and the Data panel, replacing the platform dropdown so
  the whole surface renders in one visual language.

### Changed

- **Extension updates need no credentials.** The updater reads a public release manifest published
  with the site (`blacksite.updates.manifestUrl`) and falls back to the GitHub releases API.
  Nothing prompts for or sends a token, and a `403`/`429` is reported as the shared API rate limit
  it is.
- **Delegation runs sequentially or in parallel, by choice.** `subagent_spawn` documents the
  trade-offs of fanning lanes out versus running them one at a time, and `complexity` states what
  each tier means in tool calls. Neither mode is the default-correct one — the agent picks per
  situation, and concurrency is bounded by **Max concurrent** in Settings → Subagents.
- **Answered question cards collapse to one line** — the question and the chosen answer — keeping a
  conversation with several decisions in it readable, and expandable for the full record.
- **Transcript documents surface in the thread** as they are produced, so a long deliverable is
  readable while the rest of the run continues.

### Fixed

- Markdown tables stay readable in a narrow side panel: they keep a minimum column width and
  scroll horizontally as a unit.
- A live reasoning block can be collapsed while the agent is still streaming into it, and its
  collapsed readout updates smoothly rather than restarting its animation on each token.
- Long streamed responses stay within their retention limit exactly.

## 1.0.2

### Added

- **Provider-aware output ceilings.** Anthropic and OpenRouter consume live catalog limits;
  direct OpenAI and Bedrock use documented model-family/platform metadata. Unknown models keep
  a conservative 65,536-token fallback, while explicit provider corrections are learned and
  checkpointed per provider/model.
- **Architecture-aware coding guidance.** The core agent prompt now treats repository shape as
  part of the product, balancing cohesive modules against fragmentation and using Codebase Map
  relationships to validate ownership, dependency direction, cycles, hubs, and service edges.

### Changed

- Unlimited output now starts at the selected model's resolved ceiling instead of a fixed 64K
  allowance. The model picker and Generation settings surface the detected cap.
- Model changes preserve conversation identity and history while isolating context windows,
  output corrections, and provider-native continuation state. Switching models repeatedly no
  longer carries one model's limits into another.

### Fixed

- **Plan updates now expose phase/step ids for targeted edits.** The active-plan block injected
  into the prompt each turn only ever showed the current/next step per phase, with no phase id at
  all — an agent wanting to update a different step or phase had no id to target and would either
  skip the edit or recreate the whole plan. It now lists every phase's id and every step's
  id/status/title, and the prompt guidance is explicit that plan_update is a field-level edit, not
  a rewrite.
- **Plans panel could go stale until manually refreshed.** The panel resyncs on every reveal now,
  not just on first load, so a plan the agent updated while the panel was hidden (or a missed
  live-update push for any other reason) is never more than one tab-switch away from correct.
- **A file edit could report success without actually reaching disk.** file_edit/file_edit_batch/
  json_edit/file_move save through the VS Code buffer; if that save silently failed (e.g. a
  transient external file lock), the tool still reported `ok: true` with no indication anything
  was wrong — and a subsequent file_read, which always reads raw bytes off disk, would show the
  old content. Saving now retries once, and a save that still fails is surfaced as an explicit
  notice instead of silent success.
- **The same stale-until-reveal gap existed in every other panel backed by an external store.**
  Base Context, Data, the Codebase Map (both its sidebar view and its full-page editor panel),
  and the Map Notes timeline all pushed state once on first load and then only on a live
  onDidChange event — never on a later reveal. They now resync on every reveal too, matching the
  Plans panel fix above.

## 1.0.1

### Added

- **Durable request profiles.** Auto, Plan, Review, and Debug now travel from the chat
  composer through queued messages, the host protocol, the agent loop, runtime state, and
  checkpoints. The selected profile is refreshed alongside live workspace context on every
  provider turn without invalidating the stable system-prompt cache.
- **Specialized agent methods.** Plan mode drives evidence-led research, focused question
  cards, implementation-ready phases, acceptance criteria, and linked plan documents. Review
  mode defaults to severity-ordered read-only findings; Debug mode uses ranked hypotheses,
  root-cause evidence, regression coverage, and narrow-to-broad validation.
- **Mode-aware chat surface.** A compact composer control and header status chip make the
  current profile explicit, while restrained Plan, Review, and Debug palettes shift ambient
  chat accents, controls, focus states, user turns, and live cues as one coherent surface.
- **Prompt architecture report.** Added a full review of the core prompt, tool environment,
  request-routing design, implemented profiles, and remaining evaluation opportunities.

### Changed

- Plan, Fix, Review, and Trace blueprints now select an actual behavioral profile instead of
  only inserting prompt text. The Plan scaffold is planning-only and respects execution
  approval rather than asking the agent to implement immediately.

## 0.9.100

### Added

- **Server-side compaction (beta `compact-2026-01-12`).** New per-provider trigger (in input
  tokens; minimum 50,000) on Anthropic-direct and Bedrock Mantle. When the conversation's input
  reaches that size, the API summarizes earlier history into a `compaction` content block and
  automatically drops everything before it on future requests — a new `CompactionBlock` type
  round-trips through the same message-history pipeline as every other content block (recorded
  first in the assistant turn, replayed verbatim on the next request). `usage.iterations` is now
  summed for accurate cost/context-window accounting on turns where compaction fires, instead of
  undercounting by whatever the compaction pass itself billed. Coexists correctly with context
  editing in one shared `context_management.edits` array (fixed a bug along the way where the
  two features would have silently overwritten each other if both were enabled). Enabling
  compaction for a provider disables this session's own client-side auto-compaction for that
  provider — running both would double-summarize and burn a full extra model call for nothing.
- **OpenAI Responses API (reasoning continuity across tool calls).** New opt-in toggle, scoped to
  OpenAI reasoning models (o-series, gpt-5+): routes those turns through `/v1/responses` instead
  of Chat Completions and replays the model's encrypted reasoning state (`encrypted_content`)
  into the next request after a tool-call round trip, instead of the model re-reasoning from
  scratch every turn. `ThinkingBlock` gained `encryptedContent`/`reasoningItemId` fields
  alongside Anthropic's existing `signature`, so reasoning blocks from either provider share the
  same history representation and each is correctly dropped (not sent, not misinterpreted) when
  replayed to the other provider. No effect on non-reasoning OpenAI models or on OpenRouter.
- **Fixed a pre-existing bug found while wiring the above:** the Context Editing toggle showed
  for the Bedrock provider tab regardless of Converse vs. Mantle mode, but the feature was (and
  remains) wired for Mantle only — on Converse it silently did nothing. The toggle (and the new
  compaction toggle) now only appear when Bedrock is actually in Mantle mode.

## 0.9.99

### Added

- **Anthropic Models API capability consumption.** The live `/v1/models` catalog now reads
  `max_tokens` (output cap, display-only) and the `capabilities` tree (vision, thinking) where
  present, OR'd against the existing id-based heuristics rather than replacing them — a live
  capability can add support the id table doesn't know about yet, but an absent/stale API
  response can never remove support the heuristic already established.
- **Claude Fable 5 / Mythos 5 refusal fallback (beta).** On by default for Fable/Mythos models:
  a policy-declined turn (`stop_reason: "refusal"`) now retries on Claude Opus 4.8 within the
  same request via the server-side `fallbacks` parameter, instead of ending the run. A new
  "Refusal Fallback" toggle lets it be turned off. First-party Anthropic API only. `stop_details`
  (category/explanation) is now parsed off refusals generally and surfaced as a specific
  diagnostic instead of the previous generic "declined to complete this response" message.
- **Fast mode (beta, Opus 4.8/4.7).** New per-provider toggle runs the model at up to 2.5x
  higher output tokens/sec at premium pricing. First-party Anthropic API only.
- **Task budgets (beta, Fable5/Sonnet5/Opus4.8/4.7).** New per-provider token-budget field
  gives the model a self-paced ceiling for an agentic loop instead of an enforced per-response
  cut-off. Anthropic-direct only (unavailable on Bedrock/Vertex/Foundry per Anthropic's own
  platform-availability table).
- **Context editing (beta).** New toggle clears stale tool_use/tool_result content server-side
  before the model sees it, keeping the effective prompt lean without summarizing. Available on
  both Anthropic-direct and Bedrock Mantle — it's a plain request field with no new response
  shape to round-trip, unlike server-side compaction (deliberately not implemented this pass —
  it introduces a new content-block type that must round-trip through the entire message-history
  pipeline, and getting that wrong risks corrupting every conversation, not just this feature).
- **OpenRouter provider-routing preferences.** New model-fallback list and provider-routing
  controls (order, allow-fallbacks, zero-data-retention, sort) forwarded as OpenRouter's
  `models`/`provider` request fields.
- **AWS credential chain for Bedrock.** Bedrock credentials are no longer static-keys-only:
  when no explicit key is stored, the extension now falls back to `AWS_*` environment variables
  and then a named profile in `~/.aws/{credentials,config}` — the same precedence every AWS
  SDK/CLI uses, so a machine already set up for other AWS tools works here with zero extra
  configuration.
- **Bedrock pricing.** Bedrock models (both Converse cross-region inference profiles and Mantle
  ids) now show estimated cost, mirroring Anthropic's own published per-model rates (Bedrock
  applies no separate Claude markup) — previously always "cost unknown" since Bedrock publishes
  no pricing API.
- **1-hour prompt-cache TTL option.** New per-provider Cache TTL control (Anthropic, Bedrock
  Mantle, OpenRouter) — the default 5-minute breakpoint survives typical multi-turn latency;
  1-hour trades a larger cache-write premium (2x vs 1.25x) for surviving longer gaps in bursty
  traffic.
- **Voyage AI embeddings.** New embeddings-only provider option (Anthropic's recommended
  embeddings partner, since Anthropic itself has no embeddings endpoint) alongside
  OpenAI/OpenRouter/Bedrock, with its own model catalog and API key slot.
- **Dated-snapshot-tolerant pricing lookup.** `getModelPricing` now falls back to a normalized-id
  match (stripping provider prefixes and dated-snapshot/version suffixes) when the exact id
  isn't in the fallback table, so a differently-decorated id for an already-known model (a new
  Bedrock inference-profile date stamp, an OpenRouter `provider/model:tag` id) still resolves
  pricing instead of showing "unknown."

## 0.9.9

### Added

- **Strict tool use on Anthropic and Bedrock Mantle.** Tool definitions whose
  schemas fit the documented strict subset are now sent with `strict: true`, so
  the API guarantees schema-valid `tool_use.input` — the malformed-argument
  class the coercion layer repairs after the fact becomes impossible at the
  source. Conversion is whitelist-gated per schema (free-form payload objects,
  numeric/string constraints, `$ref`, unknown keywords are sent unchanged
  without `strict`), and an endpoint that rejects strict marking gets one
  retry with plain schemas, remembered for the rest of the session — the same
  live-probe pattern as the Bedrock cachePoint check.
- **Reasoning control for non-Claude OpenRouter models.** Gemini thinking,
  DeepSeek R1, GPT-5-via-OR and friends can now actually reason: a new
  Reasoning Effort control (settings panel + quick chips) drives OpenRouter's
  unified `reasoning: {effort}` parameter for models that don't speak the
  Claude thinking dialect. The old top-level `reasoning_effort` send path was
  dead code — no UI could set it for this provider — while these models
  silently ran at the routed model's default.
- **Per-provider endpoint override.** A new Endpoint field (Models panel)
  wires the previously-unwired `baseUrl` session option through settings for
  Anthropic/OpenAI/OpenRouter — one field unlocks Azure OpenAI deployments,
  corporate proxies, and local OpenAI-compatible servers (Ollama, LM Studio,
  vLLM). Applies to chat turns, delegated subagent lanes, compression calls,
  and the vision-fallback/data-assistant path; validated host-side (http/https
  URL or blank to clear).
- **Effort on Bedrock Converse.** `output_config.effort` now rides
  `additionalModelRequestFields` next to `thinking`, exactly like the
  Messages-API shape. It was previously dropped on this path entirely — the
  same effort setting behaved differently across Converse and Mantle, with
  Converse-path Claude always running at the server default.

### Fixed

- **OpenRouter capability flags are real now.** The model catalog reads
  `architecture.input_modalities` and `supported_parameters` instead of
  hardcoding `supportsVision/supportsTools: true` for every model. Text-only
  models no longer get image blocks (and the vision-fallback path can finally
  engage for them), tool-less models are flagged, and reasoning support is
  detected for the families the id heuristics missed (Gemini, DeepSeek R1,
  Grok). The thinking toggle no longer appears as a no-op knob for non-Claude
  OR reasoning models — they get the effort control instead.
- **OpenAI metadata refresh.** Pricing/context rows for the gpt-5.x and
  gpt-4.1 families (cost tracking no longer shows "unknown" there), o3's
  June-2025 reprice ($2/$8, was still $10/$40), a modernized fallback model
  list (o1-mini/o1-preview out; gpt-5.1/gpt-5/o4-mini in), and a context
  heuristic fix: `gpt-4.1` resolved through the bare `gpt-4` rule to an 8K
  window — 0.5% of its real 1M capacity — which made compaction fire
  absurdly early.

## 0.9.8

### Added

- **Shape-based API matching.** Service-lens API edges now match a client call
  to a route declaration by aligning their *path shapes* segment by segment —
  literal segments must agree, while route parameters (`{id}`, `:id`,
  `<int:id>`, `[controller]`) and call-site interpolation holes (`${id}`,
  f-string `{id}`, `{$id}`, `%s`) act as single-segment wildcards. This replaces
  the old substring heuristics, which let a route match any path merely
  *containing* its text (provider `/users` ↔ consumer `/a/users-extra`) and let
  a bare host-only URL match every route in the workspace. Full-length
  alignments with more literal agreement outrank loose suffix overlaps, so the
  tighter route wins ambiguous matches. Name evidence alone (a host token naming
  the target service) no longer fabricates a route-level API edge — it surfaces
  as a config edge, as it always did for unmatched clients.
- **More entry-point detection per language.** New route providers: Laravel
  `Route::get/post/...`, Slim `$app->get(...)`, and Symfony `#[Route]`/`@Route`
  (with `methods:` lists) for PHP; actix/Rocket `#[get("...")]` attributes and
  axum `.route("/x", get(...))` for Rust; Django `urlpatterns`
  `path()/re_path()` entries; Flask/FastAPI `methods=["POST", ...]` kwargs
  (previously read as GET); gorilla/mux `.Methods("POST")` chains and
  receiver-based `HandleFunc` registration for Go; JAX-RS `@Path` + verb
  annotations for Java.
- **More API-call detection per language.** New consumers: Guzzle/Laravel-Http
  verb and `->request('VERB', ...)` calls (PHP), `reqwest::get` and gated
  `client.get/post/...` (Rust), `httpx`/session/client instance verbs and
  `requests.request("VERB", ...)` (Python), `HttpRequest.newBuilder()` with
  `URI.create` (Java 11+ HttpClient), and the axios config-object form
  (`axios({ method, url })`). `fetch(url, { method: "POST" })` now reads its
  real verb from the options object instead of always registering as GET —
  bare fetches no longer bind to wrong-method routes.

- **Route-prefix composition.** Declared routes now carry the prefix a real
  request path actually has: NestJS `@Controller("users")` (including bare
  `@Get()` index endpoints), Spring class-level `@RequestMapping`, FastAPI
  `APIRouter(prefix=...)` plus same-file `include_router(..., prefix=...)`,
  Flask `Blueprint(url_prefix=...)`, gin `r.Group("/api")` chains (nested),
  Laravel `Route::prefix(...)->group(...)` / `Route::group(['prefix' => ...])`
  blocks, Express `app.use("/mount", router)` mounts resolved through relative
  imports to the router file, and OpenAPI `basePath`/`servers[0].url` path
  prefixes. Full-path shape matches replace the loose suffix overlaps these
  cases used to fall back on.
- **Compose port mapping resolution.** `ports: ["3001:3000"]` entries now
  resolve `http://localhost:3001/...` dev-loop clients to the service actually
  publishing that port — authoritative, so identically shaped routes in other
  services are vetoed, same as compose hostname resolution.
- **gRPC stub binding.** `c := pb.NewOrdersClient(conn)` /
  `stub = pb2_grpc.OrdersStub(channel)` / `new OrdersClient(...)` bind the
  variable to its proto service, so calls through an opaque variable name
  resolve operation-name collisions that a bare `client.Create(...)` cannot.
- **`new URL(path, base)` and `axios.defaults.baseURL`** clients resolve
  through the same env/config machinery as other base-URL forms.

### Changed

- **Test files no longer feed the service lens.** Route registrations and HTTP
  calls in test/mock/fixture files (`__tests__/`, `*.spec.ts`, `test_*.py`,
  `*Tests.cs`, `_test.go`, `cypress/`, …) are test doubles, not production
  topology, and are now excluded the same way documentation files already were.

### Fixed

- **GraphQL consumers match on schema fields, not operation names.** The
  client-chosen document name (`query ProductPage`) never appears in the
  schema; the first selected root field (`product`) is what `type Query`
  declares, and is now what the matcher uses.

## 0.9.7

### Added

- **Structured map notes.** A note can now carry a short `title`, a `category`
  (architecture / gotcha / todo / risk / question), and — for a relation note —
  a `relationKind` (import / API call / event flow / shared data / config link /
  call / reference / inheritance) naming which relationship it's about when a
  file pair carries more than one kind of edge. Notes render as colored,
  icon-labeled category badges instead of a flat line of text, both in the
  Notes timeline and on the Map's node card. The Notes timeline gained a
  category filter row alongside the existing scope filter, and search now
  matches titles too.
- **More room to write.** The note body cap grew from 500 to 1000 characters,
  so an agent can record the full non-obvious "why" — a title plus a few
  tight sentences — instead of a single clause.
- **Richer canvas labels.** A selected relation note's floating edge label on
  the Map now shows its title (or relationship kind) instead of the generic
  "note" every annotation edge used to carry.
- **Agent guidance updated** to classify notes by category, set `relationKind`
  on ambiguous relation notes, and use the added room for a fuller "why"
  while staying skimmable.

### Changed

- `map_note_add` / `map_note_update` accept the new `title`/`category`/
  `relationKind` fields; `map_note_list` gained an optional `category` filter.
  Existing notes and callers are unaffected — all three fields are optional.

## 0.9.6

### Added

- **Python and PHP import-resolution parity.** The Map's per-language layout quality
  traced back entirely to import-edge recall (the force layout is driven only by
  `kind: "import"` edges): Python previously dropped single-segment absolute imports
  (`import utils`) and skipped star re-exports (`from .sub import *`) outright, and PHP
  had no PSR-4 `namespace`/`use` scanning at all — only literal `require`/`include`.
  Python now resolves single-segment imports when the name is workspace-unique and
  follows star re-exports via a new module-name index (`graph/python-index.ts`); PHP
  gets a whole-codebase namespace/type index (`graph/php-index.ts`) with the same
  small-namespace-fans-out / large-namespace-needs-a-referenced-type precision gate C#
  already used, closing what was the single largest per-language gap in the indexer.
- **LSP onboarding parity.** Dart, Kotlin, Scala, Lua, and Elixir now get an install
  recommendation in the "Light up more relationships" panel — previously tracked but
  silently unable to ever prompt an install.
- **Services lens never links to documentation.** A `.md`/`.mdx`/`.txt`/`.rst`/`.adoc`
  file can no longer become an API/event/data/config edge's source or target — a
  README's example curl commands or route tables could previously read as a real
  cross-service relationship.
- **Connectivity measurement helper** (`graph/connectivity-stats.ts`) for objective
  per-neighborhood average-degree/orphan-rate comparisons, so future per-language import
  work can be measured rather than eyeballed.

## 0.9.5

### Added

- **Map Notes timeline.** A new editor tab (Map toolbar → "Notes timeline", the node
  card's Notes → "Timeline" button, or the `Blacksite: Open Map Notes Timeline` command)
  presents every working-memory note as a scrollable, day-grouped timeline: full revision
  trails for notes refined across sessions, clickable file/relation endpoint chips,
  live search plus file-note/relation filters, and per-file git history with one-click
  commit-vs-parent diffs in VS Code's native diff editor. "Show on map" flies the Map's
  camera straight to the noted file's star.
- **Color-coded link-type filters.** The Map's file lens grew a "Link types" section:
  imports, calls, references, inheritance, and notes each render as a chip carrying the
  exact hue its edges are drawn with, plus a live edge count — toggling a chip shows or
  hides precisely that relationship family on the canvas. Call/reference/supertype edges
  from the background symbol sweep now filter independently instead of riding the
  imports toggle.
- **Host→Map navigation.** A new `focus_node` message lets other surfaces (the Notes
  timeline today) bring the Map forward and fly to a file's star, queued safely when the
  Map webview hasn't resolved yet.

### Changed

- **Agent Map guidance consolidated.** The system prompt now teaches an explicit
  orient → inspect → work → record Codebase Map workflow, with a concrete note-taking
  strategy: record the durable non-obvious "why", choose file vs relation notes
  deliberately, refine existing notes instead of duplicating, and prune notes an edit
  invalidates. The `map_note_add` tool description encodes the same quality bar.

## 0.9.0

### Added

- **Provider-neutral live agent environment.** Every parent and delegated model turn now
  receives a freshly rebuilt workspace block rather than a snapshot captured only at the
  start of the user message or delegated lane. Post-tool decisions therefore see current
  diagnostics, git state, plans, memory, repository guidance, and architectural context;
  transient refresh failures retain the last known-good block instead of stopping work.
- **Repository instruction discovery.** Root `.blacksite/instructions.md`, `AGENTS.md`,
  `CLAUDE.md`, `GEMINI.md`, and `.github/copilot-instructions.md` files are loaded for every
  provider, with scoped instructions from the active file's ancestor chain layered in.
- **`map_overview` architecture tool and automatic orientation.** Surfaces Codebase Map
  coverage, detected projects and project references, major areas, dependency hubs,
  cross-service flows, and recent map knowledge. A compact form is injected into the live
  workspace block, while the structured tool supports deeper architectural work on demand.
- **Provider-neutral LSP reliability layer.** Typed provider outcomes now separate valid
  empty results from errors, timeouts, cancellation, and unavailability under one total
  deadline. Multi-root identity and exact target resolution fail closed; diagnostics report
  freshness, coverage, and introduced/resolved/persisting deltas; mutations are serialized
  per workspace and return transaction receipts. Stable code-action IDs replace unsafe
  prefix selection, command-backed actions disclose/observe unpreviewable changes, and
  create/delete/rename operations require explicit review. `code_hierarchy` also supports
  bounded, cycle-safe depth graphs with call-site ranges.
- **LSP Extension Host verification.** `npm run test:lsp` combines focused unit coverage
  with a clean VS Code/TypeScript fixture for symbols, navigation, hover/signature help,
  diagnostic publication/resolution, organize imports, formatting, and cross-file rename.
- **`code_replace` tool.** Rewrites a symbol's exact language-server range — or an explicit line range —
  by targeting it the same way code_insert does (preferably by symbol), instead of
  reproducing the existing text as a file_edit `oldString`. The language server supplies
  the exact current range, so a whole-function/method/class rewrite no longer risks a
  failed or wrong exact-string match on a large block. Shows a diff for approval and
  returns diagnostics like every other mutating code_* tool; fully wired into the chat
  transcript's icon/label/activity presentation alongside code_insert.
- **Plan phase `rationale` field.** `plan_create`/`plan_update` accept a `rationale` /
  `phaseRationale` field alongside the existing objective/risks/acceptanceCriteria —
  a durable, cross-session place to record *why* a design was chosen over the
  alternatives considered, surfaced in the prompt summary and the Planning webview
  (not just left in chat text, which compaction or a later session can't see).
- **Architecture guidance in the static system prompt.** Two new guidelines: survey
  2-3 existing analogous implementations before designing a new module/boundary/
  abstraction, and capture non-obvious design rationale via `phaseRationale` rather
  than only in chat.
- **`code_replace_batch` tool.** The batch sibling `code_replace` was missing: rewrite
  several symbols' bodies (or explicit line ranges) across one or more files in a
  single reviewed diff, each resolved independently exactly like `code_replace`. Edits
  within the same file must not target overlapping ranges. Removes the need for one
  `code_replace` call and approval per symbol in a coordinated multi-file refactor.
- **`json_edit` tool.** Structural JSON edits by RFC 6901 JSON Pointer (`set` / `merge` /
  `remove`) instead of exact-text matching — immune to the reformatting, key reordering,
  or stray whitespace differences that make `file_edit` brittle on config files
  (`package.json`, `tsconfig.json`, `.vscode/settings.json`, etc.). Preserves the file's
  existing indent style and trailing newline; only supports plain JSON (falls back to
  `file_edit` for JSON-with-comments). Backed by a new pure, independently unit-tested
  `json-pointer.ts` engine.
- **"Unlimited" Max Tokens.** Settings → Generation has an Unlimited switch next to Max
  Tokens: when on, the configured number is ignored and the harness requests a generous
  output budget instead (escalating up to 200,000 tokens on truncation, versus 65,536
  normally) — still clamped to any real, documented provider ceiling (e.g. Bedrock Claude's
  64,000), since no provider actually accepts a literally unlimited request. Applies to
  delegated subagent lanes on the same provider too.
- **Windowed `file_read` (`offset` / `limit` / `lineNumbers`).** Reads now return a window
  of a file rather than all-or-nothing, with the file's true total `lines`, the
  `startLine`/`endLine` being held, and `hasMore`. Page on with `offset: endLine + 1`, or
  jump straight to a known line. `lineNumbers` is opt-in (a numbered line copied into
  `file_edit`'s `oldString` would never match, so it must never be the default).
- **`file_read` sees images.** Reading a `.png`/`.jpg`/`.gif`/`.webp`/`.bmp` returns the
  actual picture as a vision block (with the same describe-via-fallback-model path
  `browser_screenshot` uses when the model has no vision), instead of decoding the binary
  as UTF-8 and handing the model mojibake. Binary non-images are refused with a clear
  reason rather than garbage.
- **`file_search` gains context lines, output modes, glob includes, and multiline.**
  `outputMode: 'files_with_matches'` (cheap "where does this live") and `'count'` (cheap
  blast-radius sizing) join the default `'content'`, which can now attach `contextLines`
  around each hit. Multi-line patterns are supported via `multiline`.
- **`file_glob` sorts most-recently-modified first**, so the files a task is actually about
  surface at the head of a truncated result set.

### Fixed

- **LSP diagnostics no longer imply project-wide cleanliness.** File snapshots distinguish
  ready, unknown, timed-out, and cancelled freshness; workspace cache reads are explicitly
  partial and show measured coverage. Empty partial/unknown results render as warnings or
  neutral evidence rather than a green “No problems” conclusion.
- **LSP mutation races and opaque side effects now fail closed.** Target/document versions
  are revalidated around approval, parent and delegated mutations share one workspace queue,
  outside-root provider edits are blocked, resource-only edits cannot bypass approval, and
  command failures/timeouts are never reported as successful application.
- **`code_insert` never lit up the Codebase Map's live-activity trace.** The trace
  extractor read a top-level `path` field that tool never sends (it addresses its file
  via `target.path`), so `code_insert` calls silently never appeared in the map's edit
  trail. Fixed alongside `code_replace`/`code_replace_batch`, which use the same
  targeting shape.
- **Plan phase rationale could be lost forever.** It only lived on a plan, and clearing
  completed plans or archiving one deleted it with no trace. `clearCompleted` and
  `archivePlan` now fold any recorded phase rationale into `.blacksite/memory.md` (read
  back into every prompt) before the plan is removed, so a captured design decision
  survives the plan the way it would if the agent had called `memory_append` itself.
- **Agent could get stuck in long read/probe loops without ever editing.** Execution logs
  showed turns burning 10+ minutes and dozens of iterations re-reading the same large file,
  paging through truncated results, or shelling out to PowerShell for text substitution —
  sometimes never calling an edit tool for the whole turn, until the user cancelled or the
  provider errored out. The harness now tracks consecutive non-edit iterations and, after 6
  in a row, injects a reminder to commit to an edit (file_edit/code_insert/code_replace/
  code_replace_batch/json_edit) or say what's blocking it, instead of continuing to probe —
  capped at 3 per turn so a model that ignores it doesn't get spammed. A failed edit attempt
  (e.g. file_edit's ambiguous-match error) still counts as engaging with the task and resets
  the counter, so only genuine read-only stalls trigger it.
- **The Codebase Map note-enforcement nudge only recognized `file_edit`/`file_edit_batch`.**
  Editing exclusively through `file_write`, `code_insert`, `code_replace`,
  `code_replace_batch`, or `json_edit` never marked the file dirty, so the "you edited
  without leaving a note" reminder silently never fired for those tools — a gap that grew
  with every edit tool this release added. All of them are now tracked the same way.
- **`file_edit` now recovers from line-number prefixes in `oldString`.** A model that rebuilds
  a snippet from a numbered source — a `lineNumbers` read, a `file_search` hit, a paged output
  dump, a pasted editor gutter — sends back an `oldString` the file cannot possibly contain,
  and the edit dies with "oldString was not found". The harness now detects a uniform
  line-number gutter (`42<tab>text`, `42: text`, `42 | text`; consecutive numbering required)
  and retries without it, joining the existing whitespace-tolerant fallback. Two safety rules
  make this non-destructive: a stripped candidate is only adopted if it is **actually found in
  the file** (so text that merely looks numbered — an object literal with keys `1:`, `2:` — can
  never redirect an edit), and when `oldString` needed stripping, `newString` is stripped too,
  since otherwise the edit would "succeed" while writing line numbers into the source. The
  result carries a `notice` so the repair is visible rather than silent.
- **A response cut off mid-text by the output token limit just became the final answer.**
  The existing truncation recovery only handled a tool call cut off mid-JSON; a plain-text
  response with no tool call in flight had no recovery path at all and silently ended the
  turn with the truncated text as "done." It now escalates the output budget and asks the
  model to continue from exactly where it left off, bounded by the same retry cap as the
  tool-call case.

## 0.8.1

### Fixed

- **Reasoning-effort table corrected for GPT-5.6.** 0.8.0 shipped gpt-5.2+ with a ladder
  that included `minimal` and lacked `max`; the real GPT-5.6 family (gpt-5.6, plus the
  -terra/-luna/-sol variants) drops `minimal` (gone for good since 5.1) and adds `max` as
  a new top rung above `xhigh`. The picker and clamping logic now reflect this, in both
  the host and webview capability tables. For the record: "ultra mode" is a separate
  multi-agent orchestration feature (parallel subagents via a different API surface), not
  a `reasoning_effort` value — it is intentionally not part of this ladder.

## 0.8.0

### Added

- **OpenAI Flex service tier.** Settings → Generation (and a one-tap ⚡ Flex chip in chat
  quick-settings) can pin OpenAI runs to the `flex` processing tier — flagship models at
  reduced rates with queued, capacity-dependent latency. The harness compensates for the
  tier's semantics: a 5-minute stream-idle allowance (vs. 60s standard) so server-side
  queueing isn't misread as a stalled socket, and an automatic one-turn fallback to the
  standard tier when flex capacity is unavailable after the normal retry cycle. `priority`
  and explicit `default` tiers are selectable too; Auto sends no tier and leaves the
  account default in charge.
- **Full reasoning-depth ladder for newer GPT models.** Reasoning effort now spans
  none / minimal / low / medium / high / x-high. The pickers show exactly the rungs the
  selected model family accepts (o-series: low–high; gpt-5: +minimal; gpt-5.1: +none,
  codex-max +x-high; gpt-5.2+ including 5.6: the full ladder), and unknown newer families
  default to the full ladder so new depth levels are usable the day a model ships.
  Requests clamp a persisted rung to the nearest one the active model supports — switching
  from gpt-5.6 (x-high) to o3 can never turn the saved setting into a 400-per-turn
  failure.
- **gpt-6+ readiness.** Reasoning-model detection matches any `gpt-N` with N ≥ 5 instead
  of pinning to ids known today, so future majors get `max_completion_tokens`/effort
  handling automatically.

## 0.7.0

### Added

- **Tool-input auto-repair.** Near-miss tool arguments are now coerced before validation
  and dispatch instead of bouncing back as errors: numeric strings for number fields,
  "true"/"false" for booleans, numbers for string fields (GitHub issue numbers), whole
  JSON-stringified arrays/objects, and wrong-case enum values ("Status" → "status") —
  recursively, including array items like `browser_run_script` steps. Each repaired call
  executes immediately instead of costing a full model turn to correct.
- **Nested argument validation.** `validateToolInput` now walks nested objects and array
  items, so a malformed entry deep inside `file_edit_batch.edits` or
  `browser_run_script.steps` is answered with a precise, path-qualified error
  ("edits[1].newString is required.") instead of failing opaquely at runtime.
- **Enum-constrained dispatch keys.** Exact-match fields (`git_op` op/action,
  `code_navigate`/`code_hierarchy` kind, `code_insert` position, `code_diagnostics`
  severity, `worktree_op` op, browser waitFor/action) now advertise real JSON-schema
  enums, guiding the model to valid values and turning garbage into a clean, correctable
  validation error.
- **"Did you mean" for unknown tools.** A call to a near-miss tool name ("file_reed",
  "fileRead") now gets the closest advertised tool suggested in the error.
- **OpenRouter prompt caching.** Claude/Gemini models driven through OpenRouter now get
  Anthropic-style `cache_control` breakpoints: one on the static system+tools prefix, one
  rolling on the latest user message, with the volatile per-turn workspace block kept past
  the breakpoints so it can never invalidate them. Previously these runs re-billed the
  entire prompt every turn.
- **OpenAI cache routing.** Direct-OpenAI requests carry a stable per-session
  `prompt_cache_key`, steering every request of a conversation to the same cache shard
  for materially higher automatic-cache hit rates on long runs.
- **Cache hit-rate in session stats.** The Session tokens row now shows what share of all
  prompt tokens were served from cache (⚡ count · percent).
- **Live tool toggles.** Disabling a tool in settings now takes effect on the
  already-running session immediately — advertised tool list and dispatch both — not just
  on the next conversation.

### Fixed

- **Compaction outcome reporting.** A compaction pass that legitimately had nothing to do
  (not enough history, or tool calls too interleaved to cut cleanly) is no longer
  misreported as a failure with a stale error message; skipped/failed/timed-out outcomes
  now produce accurate diagnostics, and manual compaction explains a skip.
- **Stop responsiveness during compaction.** Cancelling a run no longer waits out an
  in-flight blocking compaction pass — the wait aborts immediately while the pass
  finishes in the background.

### Changed

- **Welcome surface.** The empty-transcript state is now a proper landing hero — brand
  glow, breathing gradient orb, and chip-styled shortcut hints — matching the panel's
  design language.

## 0.6.0

### Added

- **browser_run_script.** One tool call runs a whole browser sequence — navigate, click,
  type, wait, screenshot, get_text, evaluate (max 25 steps) — against the same page, and
  returns every step's result together with each screenshot attached as a real image in
  step order. A multi-step visual walkthrough now costs one round trip instead of one per
  step. New `wait` step (selector-based or fixed timeout) for settling animations.
- **Project shape in the workspace state.** The per-turn "Current workspace state" block now
  opens with a deterministic Project shape section — stack manifests, package manager,
  detected test framework, and monorepo layout — so the agent knows what it's working with
  from turn one instead of spending opening turns on test_detect / manifest reads.
- **Post-write diagnostics.** file_write results now carry the same `diagnostics` field
  file_edit and the mutating code_* tools already attach, closing the write → diagnose loop
  in a single turn. System-prompt guidance updated to read the inline field instead of
  spending a code_diagnostics call after every edit.
- **Consistent file ids.** file_read/file_write results echo `relativePath` — the same
  workspace-relative forward-slash id the Codebase Map, code_* tools, and git speak — plus
  a `lines` count on reads for line-targeted follow-ups.
- **Dedicated subagent toggle.** Settings → Agent gains an explicit "Delegated Subagents"
  switch (same plumbing as the Tool Access grid) for turning delegation off when token
  spend matters most.
- **Always-fresh model lists.** Every view that renders a model catalog (Settings → Model,
  the chat model switcher, subagent/vision/inline pickers) refreshes it from the provider
  API on open — stale-while-revalidate with a 30s guard, so the cached list stays rendered
  under a slim animated glint while the refresh runs, and rapid open/close can't hammer
  the API. Manual Refresh always hits the API.
- **Extended thinking on OpenRouter.** The same thinking toggle + budget that drives
  Anthropic/Bedrock extended thinking now flows through OpenRouter's unified `reasoning`
  parameter (mapped per routed model — Anthropic budgets, Gemini thinking, OpenAI effort),
  with reasoning deltas streamed into the thinking view. Available in Generation settings
  and chat quick-settings for reasoning-capable models.
- **Map intelligence guidance.** The system prompt now teaches map_relationships as the
  first reach for structural questions (imports, imported-by/blast radius, cross-service
  edges, prior-session notes) instead of re-deriving structure with file searches, and
  frames map notes as compounding context that map_relationships returns to future runs.
- **Stars sized by file weight.** A star's radius now blends the file's size on disk
  (log-scaled, capped) with its connectivity, so a large file reads bigger at a glance
  while heavily-imported files keep visual priority. Aggregates stay degree-sized.
- **Functional role marks.** Every file is classified by what it's *for* — tests, config,
  docs, styles, type declarations, entry points, data, assets — and denoted with a small
  per-role silhouette in the star's lower-left corner (flask triangle, square, text bars,
  swatch diamond, chevron, four-point star, dataset bars, circle), each with its own quiet
  hue. Plain source files carry no mark, so the marks stay signal. The node card names the
  selected file's role, and the Map key documents every mark.
- **Typed territory borders.** A territory zone whose files are mostly one role now says
  so with its outline: dashed = tests, long-dash = config, dotted = docs, short-dash =
  styles, with the border hue leaning toward the role color while keeping the folder's
  identity hue as its base. Source territories keep the solid border.
- **Filter by role.** The Filter rail gains role chips (with the same glyphs the star
  marks use) alongside the language chips — click "test", "config", "data", … to ghost
  everything else, composable with language, territory solo, and min-links. Role
  classification is memoized, so the filter pass stays cheap on large maps.

### Fixed (providers)

- **Anthropic-family temperature clamp.** The settings slider spans the OpenAI-style 0–2
  range, but Anthropic (direct, Bedrock Converse, Mantle) accepts 0–1 — a dialed-up
  temperature previously produced a 400 on every call after switching provider. Values
  above 1 are now clamped at request time, with a hint in Generation settings.

### Fixed

- **Screenshots reach the model now.** browser_screenshot's image was JSON-stringified as
  base64 into the tool-result text and truncated by the result cap — the model never saw
  it. Screenshots (and reference_zoom_image) now arrive as real vision blocks, or as a
  description via the configured vision-fallback model.
- **code_diagnostics returning empty.** The op now opens the target document (triggering
  language-server analysis for files the agent only ever read via fs) and waits briefly
  for the server to publish before trusting an empty result.
- **Map symbol-sweep edges render.** The background LSP symbol sweep
  (blacksite.graph.backgroundSymbols) fed only the agent's map_relationships tool — its
  call/reference/supertype edges never reached the visual Map. They now flow into the
  file-lens edge set with their own colors, cluster-collapse handling, and live refresh.

### Changed

- **Subagent lanes look like agents.** Delegated lanes render as their own persona card
  (bot avatar, colored kicker, explicit disclosure chevron) instead of a tool-row
  lookalike, and no longer appear twice in the transcript.

## 0.5.0

### Added

- **Territory solo.** Each row in the Map's territory index gains a Solo toggle that ghosts
  every file outside that folder (stackable across territories, cleared from the Filter
  section's chips). Soloed territories persist with display prefs and saved views.
- **Hubs quick-list.** A new rail section lists the most-connected files — the same set the
  gold hub rings mark on the canvas — as a click-to-fly index.
- **Altitude meter.** The legend now names the semantic zoom band the camera is at
  (Overview / Modules / Files, mirroring the label crossfade bands) and flies to a band on
  click.

### Changed

- **Territory rows preview on the canvas.** Hovering a territory row lifts that territory's
  stars and recedes the rest, and its blob highlights on the minimap — the rail and the map
  are now the same surface.
- **Hover lifts neighbors.** Pointing at a star now softly brightens its direct neighbors
  along with the spotlight arcs, so local structure reads before you commit to a selection.
- **Minimap territory blobs.** The minimap sketches the biggest territories as faint colored
  regions beneath the dots, matching the rail's swatches.

## 0.4.0

### Added

- **Territory index.** A new Territories section in the Map's control rail lists the biggest
  folder territories with their true canvas colors — click a row to frame that territory,
  or Fold/Open it into a single star, without hunting the canvas for it.
- **Connections navigator.** The node card now lists a selected file's top dependencies and
  dependents (ranked by connectivity) as click-to-navigate rows, so you can walk the import
  graph instead of reading bare degree counts. Neighbors folded into a collapsed cluster
  surface as that cluster.
- **Smarter Map search.** Search now ANDs whitespace-separated terms, falls back to fuzzy
  basename matching ("grapp" finds `GraphApp.tsx`), ranks basename hits above path hits, and
  highlights the matched characters in each result. Hovering a result previews that star on
  the canvas before you commit.
- **Minimap drag-to-pan.** Hold and drag the minimap to sweep the camera continuously
  (click-to-jump still works), and a "you are here" marker shows the focused star in its
  territory color.

### Changed

- **Aggregates look like aggregates.** A collapsed folder's super-node now wears an orbital
  ring and Services-lens nodes a diamond outline, so semantic aggregates are distinguishable
  from big files even at overview zoom. The Map key documents both marks.
- **Color continuity between canvas and chrome.** Search results, the focus tooltip, and the
  selection cards now carry the territory's color swatch, tying the HTML overlays to the
  exact hues the renderer draws.

## 0.3.0

### Added

- **LSP tool cancellation.** `code_*` tools now cancel in-flight language-server calls promptly
  when a turn is cancelled, instead of riding out the full timeout.
- **Actionable "no provider" errors.** Code-intelligence tools that come back empty now explain
  why when a language's recommended extension isn't installed, instead of a generic "no results"
  message.
- **Signature help on hover.** `code_hover` now shows the active parameter of an in-scope call
  signature, bolded, alongside the usual hover text.
- **Safer renames.** `code_rename` validates the position via the language server's own
  `prepareRename` first, surfacing the specific reason a rename can't proceed instead of a
  generic failure.
- **`code_inlay_hints` tool.** Inferred type and parameter-name hints for a file or range — most
  useful for untyped or dynamically-typed code.
- **Background-indexing prompt.** The Codebase Map's onboarding panel now also offers to turn on
  `blacksite.graph.backgroundSymbols` once a working language server is detected, instead of that
  setting being discoverable only via `settings.json`.
- **Saved Map views.** Name and save the current camera position, filters, and collapsed
  clusters, then jump back to it later from the Map toolbar.
- **Semantic zoom.** On a multi-codebase workspace, zooming out past the whole-map fit now
  collapses individual files toward their neighborhood's silhouette instead of rendering every
  star at every zoom level.
- **Cross-project cycle flagging.** A new opt-in "Cycles" layer highlights cross-codebase
  reference cycles detected in project manifests.
- **Cul-de-sac detection.** A new opt-in "Cul-de-sacs" layer dims probably-unused orphan files
  and highlights the single bridge edge into an isolated "pocket" subgraph within a neighborhood.
- **Adaptive architecture routes.** Dense file maps now replace raw overview hairballs with a
  connectivity-preserving, weighted folder backbone and restore file links automatically at
  detail zoom. The control rail discloses both raw corpus size and visible route count.
- **Collision-aware semantic labels.** Territory, module, and subgroup labels use distinct zoom
  bands plus a screen-space collision/occlusion pass, keeping architecture names readable around
  the command panel, inspector, and focused node.
- **Service relationship bundles.** Parallel API, event, data, and config detections render as one
  directed weighted route per service pair and kind while retaining confidence ranges and raw
  evidence in the inspector.
- **Adaptive service topology.** Dense many-to-many service maps now use a weighted,
  connectivity-preserving backbone at overview zoom, then restore every typed route at detail
  zoom or around a focused service. Focused routes carry direction chevrons for fast
  one-to-many / many-to-one reading.
- **Service-aware map navigation.** Search and Follow Agent now project a file path onto its
  visible owning service, rather than leaving an invisible file selection in the Services lens.

### Changed

- The Map's empty-state message now matches the rest of the panel's visual language (heading +
  subtext) instead of a single terse line.
- The Map layout now gives high-degree hubs weaker, longer spokes and collision-separates dense
  service meshes. Existing position caches rebuild once under schema v8.
- Dense Map overviews use restrained node compositing, fewer decorative stars, hidden per-file
  badges, a scrollable progressive-disclosure control rail, semantic focus states, and responsive
  high-contrast/reduced-transparency styling.
- Services now assign nested paths to their most-specific root (with `.` representing the
  workspace root), avoiding double-counted service size and incorrect centroids in monorepos.

## 0.2.0

### Added

- **Docked approval/question bar.** Pending questions and tool approvals now surface in a
  persistent bar pinned above the chat input, visible regardless of where the transcript is
  scrolled — including approvals raised inside subagent lanes, which were previously the most
  buried case (hidden behind both a collapsed lane tile and a collapsed tool-log summary). A
  "show in thread" link jumps to the full context when it's available.
- **Approval prompts for unrecognized shell commands.** A command that is neither explicitly
  allowed nor explicitly denied now prompts for approval instead of failing instantly.
  Explicitly denied commands (`blacksite.permissions.deniedCommands`) still hard-block with no
  prompt. Applies to both one-shot commands (`shell_run`) and long-running processes
  (`process_start`).
- **Project vs. all-projects "always allow."** Choosing "always allow" for a command binary now
  offers an explicit choice between persisting the rule for the current project only or for all
  projects, instead of always auto-detecting the scope.
- **Richer, more editable plans.** Phases and steps can now carry an optional risk note,
  dependency references, acceptance-criteria bullets, and a coarse complexity hint
  (small/medium/large). `plan_update` gained `reorderPhaseIds`, `reorderStepIds`,
  `moveStepId`/`moveStepToPhaseId`, and `insertPhaseBeforeId` for restructuring an existing plan
  without recreating it.

### Changed

- Tool guidance now nudges the agent to build larger plans phase-by-phase via `plan_create` +
  `plan_update`'s `addPhases`, rather than authoring every phase in one call.

### Fixed

- A shell command that isn't on the built-in or configured allowlist no longer fails outright
  with "not in the allowed list" — it now gets a chance to ask.
