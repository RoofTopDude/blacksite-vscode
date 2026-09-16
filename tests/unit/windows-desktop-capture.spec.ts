import { mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real capture path shells out to powershell.exe running an embedded C# helper (PrintWindow
// via DllImport) — not something a unit test can drive for real. Mocking execFile at the
// node:child_process boundary exercises everything this module controls (argument/env
// construction, timeout/signal wiring, output-file handling, error propagation) without needing
// a real Windows desktop or PowerShell.
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

import { WindowsDesktopCaptureService } from "../../src/sequences/windows-desktop-capture.js";

function callback(args: unknown[]): (err: unknown, result: { stdout: string; stderr: string }) => void {
  return args[args.length - 1] as (err: unknown, result: { stdout: string; stderr: string }) => void;
}

function fakeMemento() {
  let store: unknown = [];
  return {
    get: (_key: string, fallback: unknown) => store ?? fallback,
    update: async (_key: string, value: unknown) => { store = value; },
  };
}

describe("WindowsDesktopCaptureService", () => {
  let workspaceRoot: string;
  let realPlatform: PropertyDescriptor;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "bs-desktop-capture-"));
    realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    execFileMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("rejects every operation on a non-Windows platform without shelling out", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const service = new WindowsDesktopCaptureService(fakeMemento() as never, workspaceRoot);

    expect(service.available()).toBe(false);
    await expect(service.enumerateForUser()).rejects.toThrow(/Windows only/);
    await expect(service.capture({ bindingId: "x" })).rejects.toThrow(/Windows only/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("enumerates windows from the helper's JSON list output", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      callback(args)(null, {
        stdout: JSON.stringify([
          { Title: "Blender", ExecutablePath: "C:\\Blender\\blender.exe", ProcessId: 42 },
          { Title: "", ExecutablePath: "C:\\bad.exe", ProcessId: 1 }, // no title — filtered out
        ]),
        stderr: "",
      });
    });
    const service = new WindowsDesktopCaptureService(fakeMemento() as never, workspaceRoot);

    const candidates = await service.enumerateForUser();

    expect(candidates).toEqual([{ title: "Blender", executablePath: "C:\\Blender\\blender.exe", processId: 42 }]);
    const [, , options] = execFileMock.mock.calls[0]!;
    expect((options as { env: Record<string, string> }).env["BS_MODE"]).toBe("list");
  });

  it("captures PNG bytes the helper writes to BS_OUT, then deletes the temp file", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const options = args[2] as { env: Record<string, string> };
      writeFileSync(options.env["BS_OUT"]!, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      callback(args)(null, { stdout: "", stderr: "" });
    });
    const service = new WindowsDesktopCaptureService(fakeMemento() as never, workspaceRoot);
    const binding = await service.authorize({ title: "Blender", executablePath: "C:\\Blender\\blender.exe", processId: 42 }, "My Blender");

    const result = await service.capture({ bindingId: binding.id });

    expect(result.data.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(result.label).toBe("My Blender");
    const [, , options] = execFileMock.mock.calls[0]!;
    const outputPath = (options as { env: Record<string, string> }).env["BS_OUT"]!;
    expect(existsSync(outputPath)).toBe(false); // cleaned up after read, not left behind
  });

  it("bounds the helper with a 30s timeout, windowsHide, and a capped output buffer", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const options = args[2] as { env: Record<string, string> };
      writeFileSync(options.env["BS_OUT"]!, Buffer.from("x"));
      callback(args)(null, { stdout: "", stderr: "" });
    });
    const service = new WindowsDesktopCaptureService(fakeMemento() as never, workspaceRoot);
    const binding = await service.authorize({ title: "App", executablePath: "C:\\app.exe", processId: 1 }, "App");

    await service.capture({ bindingId: binding.id });

    const [, , options] = execFileMock.mock.calls[0]!;
    expect(options).toMatchObject({ windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  });

  it("forwards an AbortSignal through to the underlying process call", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const options = args[2] as { env: Record<string, string> };
      writeFileSync(options.env["BS_OUT"]!, Buffer.from("x"));
      callback(args)(null, { stdout: "", stderr: "" });
    });
    const service = new WindowsDesktopCaptureService(fakeMemento() as never, workspaceRoot);
    const binding = await service.authorize({ title: "App", executablePath: "C:\\app.exe", processId: 1 }, "App");
    const controller = new AbortController();

    await service.capture({ bindingId: binding.id }, controller.signal);

    const [, , options] = execFileMock.mock.calls[0]!;
    expect((options as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });

  it("rejects capture for a binding that was never authorized", async () => {
    const service = new WindowsDesktopCaptureService(fakeMemento() as never, workspaceRoot);
    await expect(service.capture({ bindingId: "external-app-unknown" })).rejects.toThrow(/unavailable or not approved/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("propagates the helper's ambiguous/unauthorized-window error instead of swallowing it", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      callback(args)(Object.assign(new Error("Target window is ambiguous."), { code: 1 }), { stdout: "", stderr: "" });
    });
    const service = new WindowsDesktopCaptureService(fakeMemento() as never, workspaceRoot);
    const binding = await service.authorize({ title: "App", executablePath: "C:\\app.exe", processId: 1 }, "App");

    await expect(service.capture({ bindingId: binding.id })).rejects.toThrow(/ambiguous/);
  });

  it("rejects when the helper reports success but writes an empty capture file", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const options = args[2] as { env: Record<string, string> };
      writeFileSync(options.env["BS_OUT"]!, Buffer.alloc(0));
      callback(args)(null, { stdout: "", stderr: "" });
    });
    const service = new WindowsDesktopCaptureService(fakeMemento() as never, workspaceRoot);
    const binding = await service.authorize({ title: "App", executablePath: "C:\\app.exe", processId: 1 }, "App");

    await expect(service.capture({ bindingId: binding.id })).rejects.toThrow(/empty/);
  });
});
