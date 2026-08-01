/**
 * Contract for driving a desktop application inside an execution run.
 *
 * **Design only — nothing implements this yet, and nothing calls it.** It exists so the browser
 * work already shipped (`mouse_path`, `drag`, `key`, `capture_matrix` in chromium-runner.ts) is
 * the *first* implementation of a general input/capture surface rather than a browser special
 * case, and so the security model is decided in one place rather than improvised alongside a
 * native dependency.
 *
 * ## Why this is not just "the browser adapter with a different target"
 *
 * A browser adapter is safe by construction in ways a desktop adapter is not:
 *
 *  - **Scope.** Playwright input goes to a page this extension launched. OS-level input goes to
 *    whatever currently has focus — which may be the user's editor, terminal, or password
 *    manager. A misaimed click in a browser is a wasted step; a misaimed click on the desktop is
 *    an action taken against something nobody authorized.
 *  - **Reversibility.** A page reloads. An application that saved a file, or a 3D tool that
 *    applied a destructive modifier, does not. Every desktop effect is therefore
 *    `external_mutation` at minimum and never `reversible` — see BROWSER_MUTATING_ACTIONS in
 *    sequence-service.ts for the browser equivalent, which can afford to be finer-grained.
 *  - **Observability.** A browser hands back console, network and DOM. A desktop application
 *    hands back pixels. The trace is therefore visual-only for these steps, which changes what
 *    the inspection report can honestly say about them.
 *
 * ## The shape of the eventual implementation
 *
 * Three pieces, in dependency order:
 *
 *  1. **Window resolution** — find and focus the target window by a stable identity, and fail
 *     rather than guess. Every input action must assert the intended window is focused
 *     *immediately before* dispatching, because focus can change between two steps for reasons
 *     that have nothing to do with the run.
 *  2. **Input synthesis** — the same vocabulary the browser adapter already speaks, so a sequence
 *     reads the same whichever adapter runs it. This is the entire reason the browser verbs were
 *     designed around a *path* rather than a selector: a selector is a browser concept, a path is
 *     not, and a 3D viewport has no DOM to select from.
 *  3. **Window capture** — frames into the existing content-addressed artifact store, so the
 *     filmstrip, perspective sets and comparison all work unchanged.
 *
 * ## Authorization
 *
 * Modelled on the command allow-list the shell tier already uses (`readCommandPolicy` in
 * extension.ts, `classifyOperation` in the runtime), not invented fresh:
 *
 *  - A per-application allow-list under `blacksite.permissions.*`, keyed on an identity the user
 *    can actually recognise and that an arbitrary process cannot claim (executable path, not
 *    window title — a title is attacker-controlled text).
 *  - Nothing implicit. An application absent from the list is denied, and the denial is recorded
 *    in the preflight manifest's `deniedOperations` so the report can explain why a run did less
 *    than it intended.
 *  - Approval flows through the *existing* preflight/approval gate, so the user sees desktop
 *    effects in the same manifest as filesystem and command effects rather than in a parallel
 *    prompt with different rules.
 *
 * ## What is deliberately excluded
 *
 * Reading pixels *outside* the target window, global keyboard capture, and any form of
 * screen-wide recording. Each would turn an automation tool into a surveillance one, and none is
 * required by the use cases this exists for (driving a modelling tool, a game client, an editor).
 */

import type { EntityRef, SideEffectRecord } from "../runs/run-model.js";

/** How a target application is identified. Deliberately not the window title: a title is
 *  attacker-controlled text, and matching on it would let any process impersonate an allowed
 *  application simply by renaming its window. */
export interface DesktopTargetIdentity {
  /** Absolute path to the executable. The allow-list key. */
  executablePath: string;
  /** Optional narrowing when one executable owns several windows. Advisory only — never the sole
   *  basis for authorization. */
  windowTitlePattern?: string;
  /** Optional OS process id, when the run itself launched the application and therefore knows it. */
  processId?: number;
}

export interface DesktopWindowState {
  identity: DesktopTargetIdentity;
  focused: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  /** Display scale factor. Every coordinate below is in logical pixels; the adapter is
   *  responsible for converting, because getting this wrong silently offsets an entire gesture. */
  scaleFactor: number;
}

/** The same input vocabulary the browser adapter speaks. Coordinates are relative to the target
 *  window's client area, never the screen — an absolute coordinate would be meaningless the
 *  moment the window moves, and dangerous if it landed outside. */
export interface DesktopInputRequest {
  kind: "mouse_path" | "drag" | "hover" | "scroll" | "key";
  waypoints?: Array<{ x: number; y: number }>;
  stepsPerLeg?: number;
  button?: "left" | "right" | "middle";
  deltaX?: number;
  deltaY?: number;
  keys?: string[];
  holdMs?: number;
}

export interface DesktopCaptureRequest {
  /** Perspectives are applied by the *sequence*, not the adapter — a desktop application has no
   *  scriptable camera, so a sweep is expressed as input steps between captures. The adapter only
   *  ever grabs the current frame. */
  label: string;
}

export interface DesktopCaptureResult {
  label: string;
  /** PNG bytes. Persisted through the existing RunArtifactStore CAS, exactly like a screenshot. */
  data: Buffer;
  capturedAt: string;
}

/**
 * The adapter itself.
 *
 * Every method is expected to reject rather than degrade: a desktop action that "mostly worked"
 * is worse than one that failed loudly, because the run continues on an assumption the trace
 * cannot verify.
 */
export interface DesktopAdapter {
  /** Whether OS-level input synthesis is available in this environment at all. Gates tool
   *  advertisement the same way `isBrowserRuntimeAvailable` does, so the agent never spends a
   *  turn on a capability that cannot work here. */
  available(): boolean;

  /** Resolve and focus the target. Rejects when the application is not running, not on the
   *  allow-list, or ambiguous between several windows. */
  focus(identity: DesktopTargetIdentity, signal?: AbortSignal): Promise<DesktopWindowState>;

  /**
   * Dispatch input to the focused window.
   *
   * Must re-assert focus immediately before dispatching and abort if it has changed. This is the
   * single most important rule in the contract: without it, input intended for a modelling tool
   * can land in whatever the user alt-tabbed to.
   */
  send(
    identity: DesktopTargetIdentity,
    request: DesktopInputRequest,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; dispatched: number }>;

  /** Capture the target window only — never the screen, never another window. */
  capture(
    identity: DesktopTargetIdentity,
    request: DesktopCaptureRequest,
    signal?: AbortSignal,
  ): Promise<DesktopCaptureResult>;
}

/**
 * Side-effect classification for a desktop step.
 *
 * Flat and pessimistic on purpose. The browser classifier can distinguish a read from a write
 * because it knows what each action does to a page; nothing here knows what an arbitrary
 * application does with a click, so every input is an external mutation and nothing is
 * reversible. A capture is the one genuine read.
 */
export function desktopSideEffectClass(kind: DesktopInputRequest["kind"] | "capture"): SideEffectRecord["class"] {
  return kind === "capture" ? "workspace_read" : "external_mutation";
}

/** Entity reference for a desktop target, so blast radius and search treat it like any other
 *  touched entity. Uses the executable path — the same value the allow-list is keyed on. */
export function desktopEntityRef(identity: DesktopTargetIdentity): EntityRef {
  return { scheme: "external-app", id: identity.executablePath };
}

/**
 * Whether a target is authorized.
 *
 * Exact executable-path match against the user's allow-list, case-insensitively on Windows only.
 * No globs, no prefix matching: a prefix rule like `C:\Program Files\` would authorize every
 * application under it, which is not a decision a user makes knowingly when they add one entry.
 */
export function isDesktopTargetAllowed(
  identity: DesktopTargetIdentity,
  allowedExecutables: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalize = (value: string): string => {
    const trimmed = value.trim().replace(/[\\/]+$/, "");
    return platform === "win32" ? trimmed.toLowerCase().replace(/\//g, "\\") : trimmed;
  };
  if (!identity.executablePath.trim()) return false;
  const target = normalize(identity.executablePath);
  return allowedExecutables.some((allowed) => allowed.trim() !== "" && normalize(allowed) === target);
}
