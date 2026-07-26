// WebSocket/HTTP message contracts for VS Code extension ↔ Chrome companion bridge.

export const DEFAULT_BRIDGE_PORT = 5892;
export const BRIDGE_HOST = "127.0.0.1";
export const BROWSER_COMPANION_TRUST_MODE = "browser_companion";

// ── Message envelope ───────────────────────────────────────────────────────────

export type BridgeMessageType =
  | "ping" | "pong"
  | "tool_call" | "tool_result"
  | "navigate" | "click" | "type_text" | "screenshot"
  | "get_text" | "evaluate" | "browser_result"
  | "status_request" | "status_response"
  | "session_start" | "session_end";

export interface BridgeEnvelope {
  id: string;          // UUID or timestamp-based unique ID
  type: BridgeMessageType;
  sessionId?: string;  // ties to an active agent session
  payload?: unknown;
}

// ── Ping / Pong ────────────────────────────────────────────────────────────────

export interface PingMessage extends BridgeEnvelope { type: "ping" }
export interface PongMessage extends BridgeEnvelope { type: "pong"; payload: { version: string } }

// ── Agent → Chrome: tool calls forwarded to browser ───────────────────────────

export interface ToolCallMessage extends BridgeEnvelope {
  type: "tool_call";
  payload: {
    toolName: string;
    toolInput: Record<string, unknown>;
  };
}

export interface ToolResultMessage extends BridgeEnvelope {
  type: "tool_result";
  payload: { ok: boolean; data?: unknown; error?: string };
}

// ── Browser action messages (agent → Chrome extension to act on a tab) ─────────

export interface NavigateMessage extends BridgeEnvelope {
  type: "navigate";
  payload: { url: string; tabId?: number; waitFor?: "load" | "networkidle" };
}

export interface ClickMessage extends BridgeEnvelope {
  type: "click";
  payload: { selector: string; tabId?: number };
}

export interface TypeTextMessage extends BridgeEnvelope {
  type: "type_text";
  payload: { selector: string; text: string; tabId?: number };
}

export interface ScreenshotMessage extends BridgeEnvelope {
  type: "screenshot";
  payload: { tabId?: number; fullPage?: boolean };
}

export interface GetTextMessage extends BridgeEnvelope {
  type: "get_text";
  payload: { selector?: string; tabId?: number };
}

export interface EvaluateMessage extends BridgeEnvelope {
  type: "evaluate";
  payload: { script: string; tabId?: number };
}

export interface BrowserResultMessage extends BridgeEnvelope {
  type: "browser_result";
  payload: { ok: boolean; data?: unknown; error?: string };
}

// ── Status ─────────────────────────────────────────────────────────────────────

export interface StatusRequestMessage extends BridgeEnvelope { type: "status_request" }
export interface StatusResponseMessage extends BridgeEnvelope {
  type: "status_response";
  payload: {
    version: string;
    activeSessions: number;
    extensionVersion?: string;
  };
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

export interface SessionStartMessage extends BridgeEnvelope {
  type: "session_start";
  payload: { agentModel: string; workspaceRoot: string };
}

export interface SessionEndMessage extends BridgeEnvelope {
  type: "session_end";
  payload: { reason: "completed" | "cancelled" | "error" };
}

// ── Union ─────────────────────────────────────────────────────────────────────

export type AnyBridgeMessage =
  | PingMessage | PongMessage
  | ToolCallMessage | ToolResultMessage
  | NavigateMessage | ClickMessage | TypeTextMessage | ScreenshotMessage
  | GetTextMessage | EvaluateMessage | BrowserResultMessage
  | StatusRequestMessage | StatusResponseMessage
  | SessionStartMessage | SessionEndMessage;

// ── Browser tool names (used as runtimeType prefix) ───────────────────────────

export const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_get_text",
  "browser_evaluate",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOLS)[number];

export function isBrowserTool(name: string): name is BrowserToolName {
  return (BROWSER_TOOLS as readonly string[]).includes(name);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function makeBridgeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
