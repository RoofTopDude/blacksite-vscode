# Agent system prompt and request-profile review

## Executive assessment

The core prompt already has unusually strong workspace awareness: it teaches the agent to prefer language intelligence over text search, use the Codebase Map as an architectural index, keep plans and map notes durable, respect approvals, inspect mutation diagnostics, and work in evidence loops. The agent harness also refreshes workspace state before every provider turn and dynamically removes unavailable tools. Those are the right foundations.

The principal gap was not missing tool documentation. It was the absence of a request-level operating contract. The composer offered Plan, Fix, Review, and Trace templates, but each button only inserted text. The host, session, checkpoints, provider loop, and restored UI had no concept of mode. Consequently, the same general prompt governed planning, code review, debugging, and implementation even though those tasks need different mutation defaults, research sequences, question strategies, artifacts, and definitions of done.

Version 1.0.1 introduces composable request profiles for Plan, Review, and Debug, plus conservative Auto routing. A profile is appended to the same live context tail as refreshed workspace state. This keeps the stable core prompt cacheable while ensuring the active method remains present after every tool round.

## Reviewed surfaces

- Static and live prompt assembly in `workspace-context.ts`.
- Session lifecycle, provider adapters, tool iteration, checkpoints, and runtime state in `agent-session.ts`.
- Tool inventory and dispatch descriptions, with particular attention to planning, plan documents, question cards, transcript documents, code intelligence, diagnostics, references, and the Codebase Map.
- Chat webview blueprints, outgoing protocol, queued messages, restored runtime state, and composer controls.
- Planning persistence and the execution-approval boundary.
- Existing question-card preview and full-panel comparison behavior.
- Multi-provider context-tail assembly for Anthropic, Bedrock, OpenAI Chat Completions, OpenAI Responses, and compatible providers.

## What the core prompt does well

1. **It treats the harness as a system.** The agent is told to use purpose-built tools and the extension's plans, memory, approvals, diagnostics, and map instead of bypassing them with shell work.
2. **It distinguishes stable and volatile context.** Static policy remains cacheable while roots, diagnostics, git state, plans, memory, and architecture are refreshed every model turn.
3. **It gives tools operational meaning.** Tool families are not merely listed; the prompt explains when code intelligence, map relationships, diagnostics, process tools, result paging, integrations, and precise edit tools are preferable.
4. **It has durable-work discipline.** Plans, phase rationale, plan documents, memory, map notes, and transcript documents each have a distinct role.
5. **It has evidence and recovery discipline.** Repeated failures are treated as a strategy signal, environment state is reconciled, and mutation diagnostics are not overstated as proof of whole-project health.
6. **It respects uncertainty without becoming passive.** Discoverable facts should be inspected autonomously, while material preference or architecture forks can be presented through rich question cards.

## Gaps found

### 1. Composer blueprints were presentation-only

Plan, Fix, Review, and Trace changed the text box but did not change agent behavior. A Plan blueprint even asked the agent to implement after inspection, conflicting with the planning system's execution-approval model.

**Impact:** users could believe they entered a mode while the agent continued under the general implementation-oriented contract.

### 2. No request type survived the agent loop

There was no mode field in the webview protocol, queued follow-ups, `AgentSession.send`, checkpoint state, runtime state, or restored session model.

**Impact:** even a prompt-text convention could be lost or diluted after tool calls, compaction, approval waits, checkpoint resume, or context refresh.

### 3. Planning capability exceeded planning behavior

The extension already supports phased plans, modular blocks, acceptance criteria, rationale, execution approval, and full Markdown documents attached to a plan or phase. The general prompt mentioned these features, but it did not establish a complete planning method that reliably separates facts from assumptions, asks targeted questions, or produces phase-linked research/specification artifacts.

**Impact:** plan quality depended heavily on the selected model spontaneously discovering and coordinating the available features.

### 4. Review and debugging shared generic execution defaults

The static prompt had good editing and verification guidance but no review contract, severity/confidence format, end-to-end path tracing requirement, ranked hypothesis loop, reproduction standard, or explicit distinction between read-only review and root-cause repair.

**Impact:** reviews could drift toward style commentary or premature edits, while debugging could jump from symptom to patch without proving causality.

### 5. Auto inference needed a fail-safe boundary

Aggressive request classification would be worse than no classification: words such as “plan” or “review” often appear inside implementation requests.

**Impact:** a false Plan classification could suppress explicitly requested implementation; a false Review classification could incorrectly force read-only behavior.

### 6. Mode was invisible after selection

There was no persistent visual signal showing whether the next request or active run was using Auto, Plan, Review, or Debug.

**Impact:** users could not verify the behavioral contract they were invoking, especially after a blueprint, queue, restore, or Auto classification.

## Architecture decision: composable profiles, not full prompt swaps

A complete system-prompt swap was considered and rejected for the primary conversation loop. Full swaps would duplicate the identity, safety, repository-instruction, approval, tool-availability, editing, and environment contracts. Over time those copies would drift. They would also invalidate the provider's stable prompt cache whenever mode changed.

The implemented architecture has three layers:

1. **Stable core:** identity, safety, environment, tool semantics, durable state, formatting, and universal evidence discipline.
2. **Active request profile:** a small, focused Plan, Review, or Debug operating method selected explicitly or conservatively inferred by Auto.
3. **Live workspace state:** current roots, files, diagnostics, git, plans, memory, instructions, map orientation, and configured MCP context.

The latter two are joined at the dynamic message tail before every provider turn. The profile therefore persists through internal continuations without making the static prompt volatile.

Complete swaps remain appropriate for truly isolated agents with different authority or context boundaries, such as delegated subagents. They are not necessary for ordinary request specialization.

## Implemented profiles

### Plan

- Read-only by default; plan and documentation writes remain allowed.
- Establishes outcome, scope, constraints, non-goals, and readiness criteria.
- Researches instructions, existing plans, map topology, symbols, callers, diagnostics, git, and tests before prescribing changes.
- Separates confirmed facts, inferences, assumptions, and open decisions.
- Uses focused question cards only at material forks and encourages sandbox previews for visual or structural choices.
- Requires sequenced phases with dependencies, implementation surfaces, validation, acceptance criteria, risks, and decision rationale.
- Uses `plan_doc_write` for plan-level research and consequential phase specifications/decision records instead of stuffing long prose into summaries.

### Review

- Read-only by default, while respecting an explicit request to repair verified findings.
- Defines the review scope, change boundary, runtime paths, and risk axes.
- Traces contracts, data, state, errors, and lifecycle paths end to end.
- Prioritizes behavioral defects, regressions, security/data-loss risks, races, validation holes, and test blind spots over cosmetic nits.
- Requires severity-ordered findings with file/line evidence, impact, confidence, fix direction, questions, test gaps, and residual risk.
- Uses transcript documents for long, durable review reports.

### Debug

- Converts the report into observed behavior, expected behavior, scope, and a reproducible signal.
- Maintains and tests a small ranked hypothesis set.
- Requires causal-path evidence before editing.
- Implements the smallest complete fix, adds a regression test at the lowest reliable layer, and validates from narrow reproduction to proportionate wider checks.
- Separates primary failures, secondary symptoms, and pre-existing failures in the handoff.

### Auto

- Explicit mode selection always wins.
- Auto only specializes unambiguous planning, review, or debugging requests.
- Ambiguous requests remain General, preserving the user's direct instruction and the stable core behavior.
- Review requests that also explicitly ask for fixes route to Debug so mutation is not accidentally suppressed.

## UI and state contract

- A compact four-option mode control is always available in the composer.
- Blueprints now set both the prompt scaffold and the corresponding request profile.
- Queued messages retain the mode active when they were queued.
- The webview protocol sends the mode with the user request.
- Session runtime and checkpoint state preserve both the selected and resolved mode.
- Checkpoint continuation preserves the interrupted profile rather than reclassifying the synthetic resume text.
- The entire chat surface adopts a restrained semantic accent for Plan, Review, and Debug, while a header chip names the current profile. Auto-inferred mode becomes visible during the active run.

## Remaining opportunities

1. **Evaluation corpus:** add representative planning, review, debugging, ambiguous, and mixed-intent prompts with scored expectations for tool choice, mutation behavior, questions, artifacts, and final-answer structure.
2. **Outcome telemetry:** record selected/resolved profile, tool-family sequence, question count, plan-document creation, rework loops, and validation outcomes without storing sensitive prompt content.
3. **Additional profiles:** introduce Research, Migration, Test/QA, and Incident modes only after evaluation demonstrates a distinct method and completion contract.
4. **Custom profiles:** allow teams to add repository-scoped profile additions, bounded beneath the stable core and validated for conflicts.
5. **Capability-aware refinements:** vary optional profile advice when vision, browser, integrations, databases, or specific language intelligence are actually available; never advertise absent tools.
6. **Prompt conflict tests:** statically assert that profile defaults cannot override approvals, repository instructions, explicit user scope, or dynamic tool availability.
7. **Plan artifact quality checks:** validate that consequential phases have either a useful linked document or sufficient inline detail, without incentivizing empty ceremonial documents.

## Success criteria

The architecture is successful when users can predict what a mode will do, the agent chooses higher-information tools earlier, questions occur at real decision points, plans remain executable and documented, reviews lead with verified defects, debug work proves root cause before mutation, and the behavior survives tool continuations and restored sessions without bloating or fragmenting the core prompt.
