import * as vscode from "vscode";
import type { CommandPolicy } from "@blacksite/local-runtime";

/**
 * The runtime command-permission policy, built from `blacksite.permissions.*`.
 *
 * Those settings are resource-scoped so "Always allow → This project" can live with the
 * project, but that also means a repository can ship them in its `.vscode/settings.json` — and
 * a checked-in `autoApprove: ["bash", "node"]` would let prompt-injected instructions run
 * without the user ever being asked. So, as with the research domain policy, a settings file can
 * restrict immediately but cannot widen on its own:
 *
 * - `deniedCommands` and `allowedCommands` are read from every scope. A deny only restricts,
 *   and an allowed binary still meets the code-execution prompt unless it is also auto-approved.
 * - `autoApprove` entries from user settings apply as written. Workspace entries apply only once
 *   the user has confirmed that binary for this project on this machine — recorded in
 *   workspaceState, which never travels with the repository.
 * - `allowEvalFlags` is read from user settings only.
 * - Installed toolchains outside the workspace are readable by default (`readToolchains`, see
 *   packages/local-runtime/src/toolchain-roots.ts). Any scope may turn that off; extra
 *   `readableRoots` come from user settings only.
 */
export const PROJECT_AUTO_APPROVE_KEY = "blacksite.permissions.projectAutoApprove";

/** Same identity rule the runtime applies: basename, lowercased, without a Windows extension. */
export function normalizeCommandBinary(command: string): string {
  return String(command ?? "").trim().split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase() ?? "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : [];
}

export function readCommandPolicy(workspaceState: vscode.Memento): CommandPolicy {
  const cfg = vscode.workspace.getConfiguration("blacksite.permissions");
  const merged = (key: string): string[] => stringList(cfg.get<unknown>(key, []));
  const autoApprove = cfg.inspect<string[]>("autoApprove");
  const confirmed = new Set(stringList(workspaceState.get(PROJECT_AUTO_APPROVE_KEY)).map(normalizeCommandBinary));
  const projectEntries = [...stringList(autoApprove?.workspaceValue), ...stringList(autoApprove?.workspaceFolderValue)];
  const toolchains = cfg.inspect<boolean>("readToolchains");
  return {
    allowedCommands: merged("allowedCommands"),
    deniedCommands: merged("deniedCommands"),
    autoApprove: [
      ...stringList(autoApprove?.globalValue),
      ...projectEntries.filter((entry) => confirmed.has(normalizeCommandBinary(entry))),
    ],
    allowEvalFlags: cfg.inspect<boolean>("allowEvalFlags")?.globalValue === true,
    readToolchains: [toolchains?.globalValue, toolchains?.workspaceValue, toolchains?.workspaceFolderValue]
      .every((value) => value !== false),
    readableRoots: stringList(cfg.inspect<string[]>("readableRoots")?.globalValue),
  };
}

/** Record that the user chose "Always allow → This project" for `binary` on this machine. */
export async function confirmProjectAutoApprove(workspaceState: vscode.Memento, binary: string): Promise<void> {
  const normalized = normalizeCommandBinary(binary);
  if (!normalized) return;
  const current = stringList(workspaceState.get(PROJECT_AUTO_APPROVE_KEY));
  if (current.map(normalizeCommandBinary).includes(normalized)) return;
  await workspaceState.update(PROJECT_AUTO_APPROVE_KEY, [...current, normalized]);
}
