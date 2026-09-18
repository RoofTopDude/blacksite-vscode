/** Shared identifiers keep webviews from sending arbitrary VS Code commands. */
export const WORKSPACE_DESTINATIONS = [
  { id: "chat", label: "Chat", command: "blacksite.chat.focus" },
  { id: "plans", label: "Plans", command: "blacksite.plans.focus" },
  { id: "tickets", label: "Tickets", command: "blacksite.tickets.focus" },
  { id: "runs", label: "Execution runs", command: "blacksite.runs.focus" },
  { id: "loops", label: "Ticket loops", command: "blacksite.loops.focus" },
  { id: "map", label: "Codebase map", command: "blacksite.map.focus" },
  { id: "data", label: "Data", command: "blacksite.data.focus" },
  { id: "context", label: "Base context", command: "blacksite.baseContext.focus" },
  { id: "skills", label: "Skills", command: "blacksite.skills.focus" },
  { id: "pau", label: "PAU (Beta)", command: "blacksite.pau.focus" },
] as const;
export type WorkspaceDestination = typeof WORKSPACE_DESTINATIONS[number]["id"];
export type InterfaceDensity = "comfortable" | "compact";

export function isWorkspaceDestination(value: unknown): value is WorkspaceDestination {
  return WORKSPACE_DESTINATIONS.some((entry) => entry.id === value);
}
