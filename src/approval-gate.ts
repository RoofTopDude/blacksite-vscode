import * as vscode from "vscode";

const TIER_LABELS: Record<string, string> = {
  write: "file-write",
  network: "network",
  destructive: "destructive",
};

// "allow_always" persists the command's binary to blacksite.permissions.autoApprove
// (handled by the chat provider) so it never prompts again in this project.
export type ApprovalDecision = "allow" | "allow_all" | "allow_always" | "deny";

export async function requestApprovalWithDetails(
  toolName: string,
  description: string,
  tier: string,
): Promise<ApprovalDecision> {
  const label = TIER_LABELS[tier] ?? tier;
  const detail = `Tool: ${toolName}\n\n${description}`;
  const action = await vscode.window.showWarningMessage(
    `Blacksite wants to run a ${label} operation`,
    { modal: true, detail },
    "Allow",
    "Allow All",
    "Deny",
  );
  if (action === "Allow All") return "allow_all";
  if (action === "Allow") return "allow";
  return "deny";
}
