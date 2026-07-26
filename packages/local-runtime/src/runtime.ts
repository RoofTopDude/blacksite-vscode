import os from "os";
import { handleShell, ProcessManager, buildEnv } from "./shell.js";
import {
  listDirectory, readFile, writeFile, deletePath, createDirectory, glob, searchFiles, copyPath,
  type SearchOutputMode,
} from "./file-ops.js";
import { handleGitOp } from "./git.js";
import { listMcpTools, callMcpTool } from "./mcp-client.js";
import { resolveShellConfirmation, type CommandPolicy } from "./security.js";
import { runTests, detectFramework } from "./test-harness.js";
import { handleWorktreeOp } from "./subagent-runner.js";
import { handleGithub, handleGitlab, handleJira, handleConfluence, handleSalesforce } from "./service-tools.js";
import type { McpServer } from "./types.js";
import { normalizeWorkspaceRoot } from "./path-policy.js";

type JsonRpcResponse = { jsonrpc: "2.0"; id: 1; result?: unknown; error?: { code: number; message: string } };

export class LocalRuntime {
  readonly processes: ProcessManager;
  readonly workspaceRoot: string;

  private policy: CommandPolicy;

  constructor(workspaceRoot?: string, policy: CommandPolicy = {}) {
    this.workspaceRoot = normalizeWorkspaceRoot(workspaceRoot ?? os.homedir());
    this.policy = policy;
    this.processes = new ProcessManager(this.workspaceRoot, policy);
  }

  /** Update the user command-permission policy in place (e.g. after a settings change). */
  setPolicy(policy: CommandPolicy): void {
    this.policy = policy;
    this.processes.setPolicy(policy);
  }

  async handleMessage(message: { type: string; payload?: Record<string, unknown> }): Promise<JsonRpcResponse> {
    const payload = message.payload ?? {};

    try {
      let result: unknown;
      switch (message.type) {
        // ── Shell ──────────────────────────────────────────────────────────────
        case "system.shell":
          result = await handleShell(payload as unknown as Parameters<typeof handleShell>[0], this.workspaceRoot, this.policy);
          break;

        // ── Long-running processes ─────────────────────────────────────────────
        case "system.process.start": {
          const command = String(payload["command"] ?? "").trim();
          const args = (Array.isArray(payload["args"]) ? payload["args"] : []).map((a) => String(a));
          const allowStdin = payload["allowStdin"] === true;
          const confirmed = payload["confirmed"] === true;
          if (!command) { result = { ok: false, error: "Missing command." }; break; }
          const outcome = resolveShellConfirmation(command, args, confirmed, payload["allowedBinaries"] as string[] | undefined, this.policy);
          if (outcome.kind === "denied") { result = { ok: false, error: outcome.error }; break; }
          const cwdResult = this.processes.resolveCwd(String(payload["cwd"] ?? ""));
          if (!cwdResult.ok) { result = cwdResult; break; }
          if (outcome.kind === "confirm") {
            result = { ok: true, requiresConfirmation: true, tier: outcome.tier, description: outcome.description, unrecognizedCommand: outcome.unrecognizedCommand }; break;
          }
          let record;
          try {
            record = this.processes.launch({ command, args, cwd: cwdResult.cwd, allowStdin });
          } catch (err) {
            result = { ok: false, error: err instanceof Error ? err.message : String(err) };
            break;
          }
          result = { ok: true, process: this.processes.serialize(record.handleId), tier: outcome.tier };
          break;
        }
        case "system.process.status": {
          const handleId = String(payload["handleId"] ?? "").trim();
          if (!handleId) { result = { ok: false, error: "Missing handleId." }; break; }
          const s = this.processes.serialize(handleId);
          result = s ? { ok: true, process: s } : { ok: false, error: `Unknown process: ${handleId}` };
          break;
        }
        case "system.process.read_output": {
          const handleId = String(payload["handleId"] ?? "").trim();
          if (!handleId) { result = { ok: false, error: "Missing handleId." }; break; }
          const s = this.processes.serialize(handleId);
          if (!s) { result = { ok: false, error: `Unknown process: ${handleId}` }; break; }
          result = {
            ok: true, process: s,
            output: this.processes.readOutput(handleId, payload["cursor"] as number | undefined, payload["limit"] as number | undefined),
          };
          break;
        }
        case "system.process.send_input": {
          const handleId = String(payload["handleId"] ?? "").trim();
          const input = typeof payload["input"] === "string" ? payload["input"] : "";
          const r = this.processes.sendInput(handleId, input);
          result = { ...r, process: this.processes.serialize(handleId) };
          break;
        }
        case "system.process.stop": {
          const handleId = String(payload["handleId"] ?? "").trim();
          const stopped = this.processes.kill(handleId);
          result = { ok: true, stopped, process: this.processes.serialize(handleId) };
          break;
        }

        // ── File ops ───────────────────────────────────────────────────────────
        case "system.list_directory":
          result = listDirectory(this.workspaceRoot, String(payload["path"] ?? ""), payload["limit"] as number | undefined);
          break;
        case "system.read_file":
          result = readFile(this.workspaceRoot, String(payload["path"] ?? ""), {
            offset: payload["offset"] as number | undefined,
            limit: payload["limit"] as number | undefined,
            lineNumbers: payload["lineNumbers"] as boolean | undefined,
            maxLineChars: payload["maxLineChars"] as number | undefined,
          });
          break;
        case "system.write_file":
          result = writeFile(
            this.workspaceRoot,
            String(payload["path"] ?? ""),
            String(payload["content"] ?? ""),
            payload["confirmed"] === true,
            { mode: payload["mode"] === "append" ? "append" : "overwrite" },
          );
          break;
        case "system.copy_path":
          result = copyPath(
            this.workspaceRoot,
            String(payload["source"] ?? ""),
            String(payload["destination"] ?? ""),
            payload["overwrite"] === true,
            payload["confirmed"] === true,
          );
          break;
        case "system.delete_path":
          result = deletePath(this.workspaceRoot, String(payload["path"] ?? ""), payload["confirmed"] === true);
          break;
        case "system.create_project":
          result = createDirectory(this.workspaceRoot, String(payload["path"] ?? payload["name"] ?? ""));
          break;
        case "system.mount_directory": {
          const dirPath = String(payload["path"] ?? "").trim();
          if (!dirPath) { result = { ok: false, error: "Missing path." }; break; }
          const check = listDirectory(this.workspaceRoot, dirPath, 1);
          result = check.ok ? { ok: true, path: check.path } : { ok: false, error: `Not a directory: ${dirPath}` };
          break;
        }
        case "system.glob":
          result = glob(
            this.workspaceRoot,
            String(payload["path"] ?? ""),
            String(payload["pattern"] ?? ""),
            payload["maxResults"] as number | undefined,
            {
              includeExcluded: payload["includeExcluded"] === true,
              extraExcludes: Array.isArray(payload["extraExcludes"]) ? (payload["extraExcludes"] as unknown[]).map(String) : undefined,
            },
          );
          break;
        case "system.search_files":
          result = searchFiles(this.workspaceRoot, String(payload["path"] ?? ""), String(payload["pattern"] ?? ""), {
            caseSensitive: payload["caseSensitive"] as boolean | undefined,
            include: payload["include"] as string | undefined,
            maxResults: payload["maxResults"] as number | undefined,
            contextLines: payload["contextLines"] as number | undefined,
            outputMode: payload["outputMode"] as SearchOutputMode | undefined,
            multiline: payload["multiline"] as boolean | undefined,
            maxFileBytes: payload["maxFileBytes"] as number | undefined,
            includeExcluded: payload["includeExcluded"] === true,
            extraExcludes: Array.isArray(payload["extraExcludes"]) ? (payload["extraExcludes"] as unknown[]).map(String) : undefined,
          });
          break;

        // ── Git ────────────────────────────────────────────────────────────────
        case "workspace.git":
          result = handleGitOp(this.workspaceRoot, payload, buildEnv());
          break;

        // ── MCP ────────────────────────────────────────────────────────────────
        case "mcp.list_tools": {
          const server = payload["server"] as McpServer;
          if (!server?.url) { result = { ok: false, error: "Missing server.url." }; break; }
          result = await listMcpTools(server);
          break;
        }
        case "mcp.call_tool": {
          const server = payload["server"] as McpServer;
          if (!server?.url) { result = { ok: false, error: "Missing server.url." }; break; }
          const toolName = String(payload["toolName"] ?? "");
          const toolArgs = (payload["args"] && typeof payload["args"] === "object"
            ? payload["args"]
            : {}) as Record<string, unknown>;
          result = await callMcpTool(server, toolName, toolArgs);
          break;
        }

        // ── Test runner ───────────────────────────────────────────────────────
        case "test.run":
          result = runTests(
            String(payload["root"] ?? this.workspaceRoot),
            {
              filter:    payload["filter"]    ? String(payload["filter"])    : undefined,
              timeoutMs: payload["timeoutMs"] ? Number(payload["timeoutMs"]) : undefined,
              cwd:       payload["cwd"]       ? String(payload["cwd"])       : undefined,
            },
          );
          break;
        case "test.detect":
          result = { ok: true, framework: detectFramework(String(payload["root"] ?? this.workspaceRoot)) };
          break;

        // ── Git worktrees ──────────────────────────────────────────────────────
        case "worktree.op":
          result = handleWorktreeOp(this.workspaceRoot, payload);
          break;

        // ── Service tools (token injected by agent-session before dispatch) ───
        case "service.github":
          result = await handleGithub(String(payload["_token"] ?? ""), payload);
          break;
        case "service.gitlab":
          result = await handleGitlab(String(payload["_token"] ?? ""), payload);
          break;
        case "service.jira":
          result = await handleJira(
            String(payload["_email"] ?? ""),
            String(payload["_token"] ?? ""),
            payload,
          );
          break;
        case "service.confluence":
          result = await handleConfluence(
            String(payload["_email"] ?? ""),
            String(payload["_token"] ?? ""),
            payload,
          );
          break;
        case "service.salesforce":
          result = await handleSalesforce(String(payload["_token"] ?? ""), payload);
          break;

        // ── Health ─────────────────────────────────────────────────────────────
        case "health.ping":
          result = { status: "ready", version: "0.1.0", runtime: "local-runtime" };
          break;

        default:
          return { jsonrpc: "2.0", id: 1, error: { code: -32601, message: `Unsupported message type: ${String(message.type ?? "")}` } };
      }
      return { jsonrpc: "2.0", id: 1, result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { jsonrpc: "2.0", id: 1, error: { code: -32000, message: msg } };
    }
  }
}
