import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { waitForDiagnosticQuiescence } from "../../src/post-edit-diagnostics.js";

describe("waitForDiagnosticQuiescence", () => {
  it("waits for a quiet window after the most recent matching event", async () => {
    vi.useFakeTimers();
    try {
      const uri = vscode.Uri.file("C:/workspace/file.ts");
      const result = waitForDiagnosticQuiescence([uri], { timeoutMs: 1000, quietMs: 50 });
      vscode.languages.__fireDiagnostics([uri]);
      await vi.advanceTimersByTimeAsync(30);
      vscode.languages.__fireDiagnostics([uri]);
      await vi.advanceTimersByTimeAsync(60);
      await expect(result).resolves.toMatchObject({ observed: true, timedOut: false, cancelled: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports timeout instead of treating no event as fresh", async () => {
    vi.useFakeTimers();
    try {
      const result = waitForDiagnosticQuiescence([vscode.Uri.file("C:/workspace/file.ts")], { timeoutMs: 25, quietMs: 5 });
      await vi.advanceTimersByTimeAsync(30);
      await expect(result).resolves.toMatchObject({ observed: false, timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is cancellation-aware", async () => {
    const controller = new AbortController();
    const result = waitForDiagnosticQuiescence([vscode.Uri.file("C:/workspace/file.ts")], {
      timeoutMs: 1000,
      quietMs: 50,
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).resolves.toMatchObject({ cancelled: true });
  });
});
