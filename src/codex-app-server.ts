import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface CodexMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Local JSONL transport. Never logs protocol payloads (including login URLs). */
export class CodexAppServer {
  private process?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(message: CodexMessage) => void>();
  private failures = new Set<(error: Error) => void>();

  constructor(private readonly executable: string, private readonly home: string) {}

  subscribe(listener: (message: CodexMessage) => void, failure?: (error: Error) => void): () => void {
    this.listeners.add(listener);
    if (failure) this.failures.add(failure);
    return () => { this.listeners.delete(listener); if (failure) this.failures.delete(failure); };
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.launch().catch((error) => { this.dispose(); throw error; });
    return this.starting;
  }

  private async launch(): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.home };
    // Subscription mode must not inherit API billing or externally managed auth.
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_LOGIN_TOKEN", "CODEX_WIF_PROVIDER_ID", "CODEX_WIF_TOKEN_FILE"]) delete env[key];
    const args = ["app-server", "-c", 'forced_login_method="chatgpt"'];
    const nodeLauncher = /\.[cm]?js$/i.test(this.executable);
    if (nodeLauncher) env.ELECTRON_RUN_AS_NODE = "1";
    const child = spawn(nodeLauncher ? process.execPath : this.executable, nodeLauncher ? [this.executable, ...args] : args, {
      cwd: this.home, env, windowsHide: true, shell: false, stdio: "pipe",
    });
    this.process = child;
    const lines = createInterface({ input: child.stdout });
    const fail = (error: Error) => {
      if (this.process !== child) return;
      this.process = undefined;
      this.starting = undefined;
      lines.close();
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      this.pending.clear();
      for (const listener of this.failures) listener(error);
      child.kill();
    };
    child.on("error", () => fail(new Error("Cannot start Codex. Install the Codex CLI or set blacksite.chatgpt.codexPath to its executable, then retry.")));
    child.on("exit", () => fail(new Error("The Codex connection closed. Retry to reconnect.")));
    child.stdin.on("error", () => fail(new Error("The Codex connection closed.")));
    child.stderr.resume();
    lines.on("line", (line) => {
      let message: CodexMessage;
      try { message = JSON.parse(line) as CodexMessage; } catch { fail(new Error("Codex returned an invalid protocol message.")); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { fail(new Error("Codex returned an invalid protocol message.")); return; }
      if (message.method) {
        for (const listener of this.listeners) listener(message);
        // No server-side tools or permissions are authorized by this transport.
        if (message.id !== undefined && message.method !== "item/tool/call") {
          this.write({ id: message.id, error: { code: -32601, message: "Use Blacksite tools and approvals." } });
        }
        return;
      }
      const entry = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!entry) return;
      this.pending.delete(message.id as number);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    await this.request("initialize", { clientInfo: { name: "blacksite", title: "Blacksite", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    this.write({ method: "initialized", params: {} });
  }

  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.process) return Promise.reject(new Error("Codex is not connected."));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, 30_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try { this.write({ id, method, params }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }

  private write(message: CodexMessage): void {
    if (!this.process) throw new Error("Codex is not connected.");
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }

  dispose(): void {
    const child = this.process;
    this.process = undefined;
    this.starting = undefined;
    const error = new Error("Codex connection disposed.");
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    for (const listener of this.failures) listener(error);
    child?.kill();
  }
}
