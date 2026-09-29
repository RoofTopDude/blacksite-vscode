import * as vscode from "vscode";
import { parseHooks, runHooks, type HookProvider } from "./hooks.js";

/** Only user settings can authorize scripts; repository settings cannot install hooks. */
export const configuredHooks: HookProvider = async (input, signal) => {
  if (!vscode.workspace.isTrusted) return {};
  const value = vscode.workspace.getConfiguration("blacksite.hooks").inspect<unknown>("commands")?.globalValue ?? [];
  return runHooks(parseHooks(value), input, signal);
};
