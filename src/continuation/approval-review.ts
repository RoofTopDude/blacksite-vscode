/**
 * A no-tools continuation reviewer for unattended Ticket Loop gates.
 *
 * The executing lane wants to act; this reviewer only decides whether that action is a safe,
 * reversible part of the ticket the user already approved. Keeping the roles separate prevents
 * a lane from approving its own escalation and lets a loop move one unsafe ticket aside without
 * stopping unrelated work.
 */

import type { ContinuationModel, HaltCategory } from "./continuation-model.js";

export interface LoopApprovalReviewBrief {
  loopId: string;
  ticketId: string;
  ticketTitle: string;
  ticketDescription?: string;
  acceptanceCriteria: string[];
  territory: string[];
  userPrompts: string[];
  tier: string;
  toolName: string;
  description: string;
}

export type LoopApprovalVerdict =
  | { action: "allow"; risk: "low" | "medium"; reason: string }
  | {
    action: "block";
    category: HaltCategory;
    reason: string;
    whatWouldUnblock: string;
  };

const MAX_ITEM_CHARS = 2_000;

function clip(value: string | undefined, max = MAX_ITEM_CHARS): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

export function buildLoopApprovalReviewSystemPrompt(): string {
  return [
    "You are the independent continuation reviewer for an unattended Ticket Loop in Blacksite.",
    "A separate execution agent requested an approval. You have no tools and cannot perform the action yourself.",
    "Decide only whether this one action is a safe, scoped, reversible part of the ticket the user already chose to run.",
    "",
    "Return exactly one JSON object and nothing else:",
    '{"action":"allow","risk":"low|medium","reason":"one concise sentence"}',
    '{"action":"block","category":"safety|security|irrecoverable|intent_drift|incoherent","reason":"why","whatWouldUnblock":"human action or clarification"}',
    "",
    "Normally allow routine workspace file creation and edits when they are required by the ticket, remain inside its territory or a clearly adjacent test/config file, and are reversible in version control.",
    "Normally allow local test, build, formatting, and package-manager operations that do not publish, deploy, rotate credentials, or delete valuable data.",
    "Block destructive deletion outside disposable build/cache artifacts, force pushes, releases, deployments, production mutations, credential/secret/permission changes, unexplained network writes, actions outside the ticket's intent, and any action whose target is ambiguous.",
    "Do not block merely because an operation writes a file. The purpose of this reviewer is to resolve ordinary implementation approvals while the user is away.",
    "When evidence is insufficient, block this ticket. The supervisor will continue with other tickets, so uncertainty never requires halting the whole loop.",
  ].join("\n");
}

export function buildLoopApprovalReviewUserPrompt(brief: LoopApprovalReviewBrief): string {
  const prompts = brief.userPrompts.length
    ? brief.userPrompts.slice(-8).map((prompt, index) => `  [${index + 1}] ${clip(prompt, 3_000)}`).join("\n")
    : "  (none recorded; use the ticket as the approved intent)";
  const criteria = brief.acceptanceCriteria.length
    ? brief.acceptanceCriteria.map((criterion) => `  - ${clip(criterion, 500)}`).join("\n")
    : "  (none declared)";
  const territory = brief.territory.length
    ? brief.territory.map((entry) => `  - ${clip(entry, 500)}`).join("\n")
    : "  (none declared; require the action to be clearly local to this ticket)";

  return [
    `LOOP: ${clip(brief.loopId, 120)}`,
    `TICKET: ${clip(brief.ticketId, 120)} — ${clip(brief.ticketTitle, 300)}`,
    brief.ticketDescription ? `DESCRIPTION: ${clip(brief.ticketDescription, 2_000)}` : "",
    "",
    "ACCEPTANCE CRITERIA:",
    criteria,
    "",
    "EXPECTED TERRITORY:",
    territory,
    "",
    "ORIGINAL USER REQUESTS (verbatim):",
    prompts,
    "",
    `APPROVAL TIER: ${clip(brief.tier, 80)}`,
    `TOOL: ${clip(brief.toolName, 160)}`,
    `REQUESTED ACTION: ${clip(brief.description, 4_000)}`,
    "",
    "Return the JSON decision now.",
  ].filter(Boolean).join("\n");
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && inString) { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char !== "}") continue;
    depth -= 1;
    if (depth !== 0) continue;
    try {
      const parsed = JSON.parse(text.slice(start, index + 1)) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseLoopApprovalVerdict(raw: string): LoopApprovalVerdict {
  const fallback = (reason: string): LoopApprovalVerdict => ({
    action: "block",
    category: "incoherent",
    reason,
    whatWouldUnblock: "Inspect this ticket's requested operation and resume it manually if it is safe.",
  });
  const value = extractJsonObject(raw);
  if (!value) return fallback("The continuation reviewer returned no readable decision.");
  if (value.action === "allow") {
    const reason = safeText(value.reason);
    if (!reason) return fallback("The continuation reviewer allowed the operation without explaining why.");
    return { action: "allow", risk: value.risk === "medium" ? "medium" : "low", reason };
  }
  if (value.action === "block") {
    const known = new Set<HaltCategory>(["safety", "security", "irrecoverable", "intent_drift", "incoherent"]);
    const category = known.has(value.category as HaltCategory) ? value.category as HaltCategory : "incoherent";
    return {
      action: "block",
      category,
      reason: safeText(value.reason) || "The continuation reviewer did not consider this operation safe to run unattended.",
      whatWouldUnblock: safeText(value.whatWouldUnblock),
    };
  }
  return fallback(`The continuation reviewer returned an unrecognized action (${safeText(value.action) || "none"}).`);
}

/* ── Chat auto mode ─────────────────────────────────────────────────────────────────────────────
   The same no-tools reviewer, pointed at an interactive chat instead of an unattended ticket. The
   difference that shapes everything below: the user is present. A loop reviewer that refuses
   blocks a ticket; a chat reviewer that is unsure hands the decision back to a person who can
   answer in seconds. So "allow" must be clearly right, and everything else escalates — there is no
   "deny" verdict, because refusing on the user's behalf is not the reviewer's call. */

export interface ChatApprovalReviewBrief {
  userPrompts: string[];
  toolName: string;
  tier: string;
  description: string;
  unrecognizedCommand?: boolean;
}

export type ChatApprovalVerdict =
  | { action: "allow"; reason: string }
  | { action: "escalate"; reason: string };

export function buildChatApprovalReviewSystemPrompt(): string {
  return [
    "You are the approval reviewer for Blacksite chat running in auto mode. The user is present and watching.",
    "An execution agent asked to run one operation that normally needs the user's approval. You have no tools and cannot run anything yourself.",
    "Decide whether this one operation is clearly part of what the user asked for and safe to run without asking them.",
    "",
    "Return exactly one JSON object and nothing else:",
    '{"action":"allow","reason":"one concise sentence"}',
    '{"action":"escalate","reason":"what the user should weigh before deciding"}',
    "",
    "Allow: builds, tests, type checks, linters and formatters; installing or fetching dependencies the requested work needs; project scripts the request calls for; read-only inspection.",
    "Escalate: anything the user did not ask for or that goes beyond the request; pushing to a remote unless the user explicitly asked to; publishing, deploying or releasing; credential, secret or permission changes; operations reaching outside the workspace; deleting data; network writes you cannot explain from the request; an unrecognized executable whose effect you cannot tell from the description; anything a careful user would want to see first.",
    "When in doubt, escalate. The user is right there, so escalating costs seconds and a wrong allow can cost much more.",
  ].join("\n");
}

export function buildChatApprovalReviewUserPrompt(brief: ChatApprovalReviewBrief): string {
  const prompts = brief.userPrompts.length
    ? brief.userPrompts.slice(-8).map((prompt, index) => `  [${index + 1}] ${clip(prompt, 3_000)}`).join("\n")
    : "  (none recorded)";
  return [
    "WHAT THE USER ASKED FOR (their own words, oldest first):",
    prompts,
    "",
    `APPROVAL TIER: ${clip(brief.tier, 80)}${brief.unrecognizedCommand ? " (unrecognized executable)" : ""}`,
    `TOOL: ${clip(brief.toolName, 160)}`,
    `REQUESTED OPERATION: ${clip(brief.description, 4_000)}`,
    "",
    "Return the JSON decision now.",
  ].join("\n");
}

export function parseChatApprovalVerdict(raw: string): ChatApprovalVerdict {
  const value = extractJsonObject(raw);
  const reason = safeText(value?.["reason"]);
  if (value?.["action"] === "allow" && reason) return { action: "allow", reason };
  if (value?.["action"] === "escalate") {
    return { action: "escalate", reason: reason || "The reviewer did not consider this safe to run without you." };
  }
  // Unreadable, unexplained, or anything else: the person decides.
  return { action: "escalate", reason: "The reviewer returned no usable decision." };
}

export async function reviewChatApproval(
  model: ContinuationModel,
  brief: ChatApprovalReviewBrief,
): Promise<ChatApprovalVerdict> {
  try {
    return parseChatApprovalVerdict(await model.decide(
      buildChatApprovalReviewSystemPrompt(),
      buildChatApprovalReviewUserPrompt(brief),
    ));
  } catch (error) {
    return {
      action: "escalate",
      reason: `The reviewer could not be reached (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

export async function reviewLoopApproval(
  model: ContinuationModel,
  brief: LoopApprovalReviewBrief,
): Promise<LoopApprovalVerdict> {
  try {
    const raw = await model.decide(
      buildLoopApprovalReviewSystemPrompt(),
      buildLoopApprovalReviewUserPrompt(brief),
    );
    return parseLoopApprovalVerdict(raw);
  } catch (error) {
    return {
      action: "block",
      category: "incoherent",
      reason: `The continuation reviewer could not be reached (${error instanceof Error ? error.message : String(error)}).`,
      whatWouldUnblock: "Retry when the configured model provider is reachable.",
    };
  }
}
