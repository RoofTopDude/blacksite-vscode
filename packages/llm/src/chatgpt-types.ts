/** Public account state only. OAuth credentials stay in Codex's credential store. */
export interface ChatGptLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}
export interface ChatGptLimit {
  limitId?: string | null;
  limitName?: string | null;
  primary?: ChatGptLimitWindow | null;
  secondary?: ChatGptLimitWindow | null;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | null } | null;
}
export interface ChatGptState {
  status: "disconnected" | "connecting" | "connected";
  email?: string | null;
  planType?: string | null;
  limits: ChatGptLimit[];
  updatedAt?: number;
  refreshing?: boolean;
  error?: string;
}
