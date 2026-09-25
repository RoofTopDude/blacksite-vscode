import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServer, type CodexMessage } from "../../src/codex-app-server.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.unstubAllEnvs());

function fixture(executable = "codex") {
  const sent: CodexMessage[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    stdin: new Writable({ write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk)) as CodexMessage;
      sent.push(message);
      if (message.method === "initialize") queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n"));
      callback();
    } }),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return { child, sent, rpc: new CodexAppServer(executable, "/blacksite-profile") };
}

describe("Codex JSONL transport", () => {
  it("coalesces initialization and isolates subscription credentials without invoking a shell", async () => {
    vi.stubEnv("OPENAI_API_KEY", "must-not-be-inherited");
    vi.stubEnv("CODEX_ACCESS_TOKEN", "must-not-be-inherited");
    const f = fixture();
    try {
      await Promise.all([f.rpc.start(), f.rpc.start()]);
      expect(f.sent.map((message) => message.method)).toEqual(["initialize", "initialized"]);
      const options = vi.mocked(spawn).mock.calls.at(-1)?.[2];
      expect(options).toMatchObject({ cwd: "/blacksite-profile", shell: false, windowsHide: true, env: { CODEX_HOME: "/blacksite-profile" } });
      expect(options?.env?.OPENAI_API_KEY).toBeUndefined();
      expect(options?.env?.CODEX_ACCESS_TOKEN).toBeUndefined();
    } finally { f.rpc.dispose(); }
  });

  it("launches npm's JS entrypoint using Node mode in an Electron host", async () => {
    const f = fixture("C:/npm/codex.js");
    try {
      await f.rpc.start();
      expect(spawn).toHaveBeenLastCalledWith(process.execPath, expect.arrayContaining(["C:/npm/codex.js", "app-server"]), expect.objectContaining({ env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }) }));
    } finally { f.rpc.dispose(); }
  });

  it("matches out-of-order responses by ID and rejects server permission requests", async () => {
    const f = fixture();
    try {
      await f.rpc.start();
      const first = f.rpc.request("first");
      const firstId = f.sent.at(-1)?.id;
      const second = f.rpc.request("second");
      const secondId = f.sent.at(-1)?.id;
      f.child.stdout.write(JSON.stringify({ id: secondId, result: { value: 2 } }) + "\n");
      f.child.stdout.write(JSON.stringify({ id: firstId, result: { value: 1 } }) + "\n");
      expect(await first).toEqual({ value: 1 });
      expect(await second).toEqual({ value: 2 });
      f.child.stdout.write(JSON.stringify({ id: 999, method: "item/commandExecution/requestApproval", params: {} }) + "\n");
      expect(f.sent.at(-1)).toMatchObject({ id: 999, error: { code: -32601 } });
    } finally { f.rpc.dispose(); }
  });

  it("rejects pending requests and notifies streams on process exit", async () => {
    const f = fixture();
    await f.rpc.start();
    const failed = vi.fn();
    f.rpc.subscribe(() => {}, failed);
    const pending = f.rpc.request("account/read");
    f.child.emit("exit", 1);
    await expect(pending).rejects.toThrow("connection closed");
    expect(failed).toHaveBeenCalledOnce();
    expect(f.child.kill).toHaveBeenCalledOnce();
  });
});
