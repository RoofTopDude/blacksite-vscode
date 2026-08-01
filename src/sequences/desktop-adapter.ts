/** Security contracts for read-only external-application evidence. */
import type { EntityRef, SideEffectRecord } from "../runs/run-model.js";

export interface DesktopTargetIdentity {
  executablePath: string;
  processId?: number;
}

export interface DesktopWindowCandidate {
  title: string;
  executablePath: string;
  processId: number;
}

export interface DesktopCaptureRequest {
  bindingId: string;
  label?: string;
}

export interface DesktopCaptureResult {
  bindingId: string;
  label: string;
  data: Buffer;
  capturedAt: string;
}

/** Resolution is intentionally separate from capture. Enumeration is user-only UI data. */
export interface DesktopWindowResolver {
  available(): boolean;
  enumerateForUser(signal?: AbortSignal): Promise<DesktopWindowCandidate[]>;
}

export interface DesktopCaptureAdapter {
  available(): boolean;
  bindings(): Array<{ id: string; label: string }>;
  capture(request: DesktopCaptureRequest, signal?: AbortSignal): Promise<DesktopCaptureResult>;
}

/** Reserved interface only. No implementation is shipped in this increment. */
export interface FutureDesktopInputAdapter {
  readonly supported: false;
}

export function desktopSideEffectClass(kind: "capture"): SideEffectRecord["class"] {
  return kind === "capture" ? "external_read" : "external_mutation";
}

export function desktopEntityRef(binding: { id: string; label?: string }): EntityRef {
  return { scheme: "external-app", id: binding.id, ...(binding.label ? { label: binding.label } : {}) };
}

/** Exact-path authorization; case-insensitive only on Windows. */
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
