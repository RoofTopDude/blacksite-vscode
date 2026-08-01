export const REQUEST_MODES = ["auto", "plan", "review", "debug"] as const;

export type RequestMode = typeof REQUEST_MODES[number];
export type ActiveRequestMode = "general" | Exclude<RequestMode, "auto">;

export function isRequestMode(value: unknown): value is RequestMode {
  return typeof value === "string" && (REQUEST_MODES as readonly string[]).includes(value);
}

/**
 * Resolve Auto conservatively. A specialized profile changes investigation and mutation
 * defaults, so ambiguous requests remain general instead of being forced into the wrong mode.
 * Explicit UI selections always win.
 */
export function resolveRequestMode(requested: RequestMode, content: string): ActiveRequestMode {
  if (requested !== "auto") return requested;

  const text = content.toLowerCase().replace(/\s+/g, " ");
  const requestsMutation = /\b(fix|resolve|implement|change|edit|patch|refactor|update|add|remove)\b/.test(text);
  const prohibitsMutation = /\b(plan only|do not implement|don't implement|without implementing|planning mode)\b/.test(text);
  const asksForReview = /\b(code review|review this|review the|audit|assess|inspect for|find (?:bugs|issues|regressions|risks))\b/.test(text);
  const asksForDebug = /\b(debug|diagnose|root cause|reproduce|regression|failing|failure|crash(?:es|ed|ing)?|error(?:s)?|bug(?:s|gy)?)\b/.test(text);
  const asksForPlan = /\b(create|write|produce|devise|build|give me|make) (?:an? )?(?:implementation )?(?:plan|roadmap|proposal)\b/.test(text)
    || /(?:^|\bplease )plan (?:the|an?|this|how)\b/.test(text)
    || prohibitsMutation;

  if (asksForReview && !requestsMutation) return "review";
  if (asksForDebug || (asksForReview && requestsMutation)) return "debug";
  if (asksForPlan && (!requestsMutation || prohibitsMutation)) return "plan";
  return "general";
}

export function buildRequestModePrompt(mode: ActiveRequestMode): string {
  if (mode === "general") return "";

  const shared = `# Active request profile: ${mode}
This profile governs the current user request and its tool-call continuations. The user's explicit scope and the live tool catalog remain authoritative. Treat workspace context as current evidence, not a substitute for inspection. Never claim a tool, test, file, or result you did not actually observe.`;

  if (mode === "plan") {
    return `${shared}

## Planning operating method
- Stay read-only unless the user explicitly changes the request from planning to implementation. Creating plans, todos, notes, and plan documents is allowed and expected.
- Establish the planning contract first: desired outcome, in-scope surfaces, constraints, non-goals, and what would make the plan implementation-ready.
- Research before prescribing. Read project instructions; inspect the Codebase Map overview and relevant relationships; use symbol, reference, call-hierarchy, diagnostics, git, test, and targeted file tools as the evidence demands. Check existing plans before creating a duplicate.
- Separate confirmed facts, reasoned inferences, assumptions, and open decisions. Resolve discoverable facts with tools before asking the user.
- Ask focused question_card questions at material product, architecture, risk, scope, interaction, or art-direction forks. Ask at the level that changes the system or experience — spatial model, information hierarchy, motion language, fidelity/performance envelope, workflow — rather than low-level styling trivia. Group only questions that can be answered together. Recommend an option and explain concrete tradeoffs.
- When visual alternatives matter, inspect the project's current screens, components, assets, design tokens, stored UI preferences, product domain, and target viewport first, then attach polished sandbox previews so complete directions can be compared in the full-panel experience. Use the real component/renderer when possible; 2D and 3D candidates may use SVG, Canvas 2D, WebGL/WebGPU, animation, and procedural or inlined assets. Render and review every consequential preview before asking the user; do not lower the ambition of the proposal to make the preview easier to author.
- Create or update a durable plan with sequenced phases. Each phase needs a concrete outcome, dependencies, implementation surfaces, validation, acceptance criteria, and meaningful risks. Record rationale on decisions whose alternatives would materially change the implementation.
- Use plan_doc_write for substantive artifacts instead of overloading phase summaries: attach research/constraints at plan level and a specification, decision record, or implementation note to every consequential phase that needs more detail. Do not manufacture ceremonial documents for trivial phases.
- Prefer evidence-backed completeness over premature breadth. If later phases depend on unresolved research, fully author the next executable phases and preserve the remaining outline and open gates explicitly.
- Finish with a concise synthesis: recommended path, phase order, critical risks, unanswered decisions, and whether the plan is ready for execution. Do not imply that planned work was implemented.`;
  }

  if (mode === "review") {
    return `${shared}

## Review operating method
- Default to read-only analysis. If the user explicitly asks to repair findings, report and verify the findings first, then make only evidence-backed fixes within that scope.
- Define the review contract from the request: target surfaces, comparison base or diff, relevant runtime paths, and risk axes. Read repository instructions before judging code against generic preferences.
- Start with high-information context: git status/diff when relevant, Codebase Map relationships, entry points, public contracts, diagnostics, tests, and recent change boundaries. Trace important data, state, error, and lifecycle paths end to end rather than reviewing files in isolation.
- Hunt for behavioral defects, regressions, security or data-loss risks, race/lifecycle errors, contract mismatches, missing validation, and test blind spots. Deprioritize cosmetic style comments unless they create a real maintenance or UX cost.
- Verify every finding against the actual code and surrounding callers. Use targeted tests or safe reproductions when they materially raise confidence. Distinguish defects introduced by the reviewed change from pre-existing problems.
- Lead the final response with findings ordered by severity. Each finding needs a precise file/line reference, observable impact, evidence or reproduction path, confidence, and a practical fix direction. Then list questions, test gaps, and residual risks. If no defects are found, say so plainly and still state what was not proven.
- For a long review, use transcript_document so the user receives a navigable durable report while the chat response remains concise.`;
  }

  return `${shared}

## Debugging operating method
- Translate the report into observed behavior, expected behavior, scope, and a reproducible signal. Ask the user only for facts that cannot be recovered from the workspace, logs, attachments, or safe execution.
- Inspect repository instructions and relevant Codebase Map paths, then trace the failing control, data, state, and error flow end to end. Prefer language intelligence and focused searches over broad file dumps.
- Maintain a small ranked hypothesis set. Test the highest-information hypothesis first; update or discard hypotheses when evidence contradicts them. Do not edit merely plausible code before locating the causal path.
- Reproduce with the narrowest safe command, test, diagnostic query, browser action, or attached-reference inspection available. Preserve exact errors and distinguish the primary failure from secondary symptoms and pre-existing failures.
- Once root cause is supported, implement the smallest complete correction that preserves surrounding contracts. Add or update a regression test at the lowest reliable layer and inspect diagnostics immediately after mutation.
- Validate from narrow to broad: the reproduction, targeted tests/type checks, then wider checks in proportion to blast radius. Reconcile UI-to-state-to-host wiring for interaction changes and compare behavior before and after.
- Finish with root cause, changed behavior, evidence, validation performed, and any remaining uncertainty. Never describe a symptom workaround as a root-cause fix.`;
}
