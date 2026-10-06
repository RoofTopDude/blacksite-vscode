import { describe, expect, it } from "vitest";
import {
  ansiSegments, appendTerminalOutput, createTerminalOutput, settleTerminalOutput, stripAnsi,
  terminalFromResult, terminalTail, terminalText, MAX_TERMINAL_LINES,
} from "../../src/webview/react/lib/terminal-output.js";
import { applyToolOutput, applyToolResult, createAssistantTurn, createChatState, ensureToolCall } from "../../src/webview/react/lib/chat-model.js";

/* The chat's terminal view of a shell command: what a terminal would show for the bytes that
   arrived, bounded, and rebuilt from the result when nothing was streamed. */

describe("terminal output buffer", () => {
  it("splits lines across chunks and keeps the unfinished line as current", () => {
    const out = createTerminalOutput();
    appendTerminalOutput(out, "stdout", "one\ntw");
    appendTerminalOutput(out, "stdout", "o\nthr");
    expect(out.lines.map((l) => l.text)).toEqual(["one", "two"]);
    expect(out.current?.text).toBe("thr");
    expect(terminalText(out)).toBe("one\ntwo\nthr");
  });

  it("redraws a carriage-return progress line in place", () => {
    const out = createTerminalOutput();
    appendTerminalOutput(out, "stdout", "progress 10%\rprogress 50%\r");
    appendTerminalOutput(out, "stdout", "progress 100%\ndone\n");
    expect(out.lines.map((l) => l.text)).toEqual(["progress 100%", "done"]);
  });

  it("treats a CRLF split across two reads as one line ending, not a redraw", () => {
    const out = createTerminalOutput();
    appendTerminalOutput(out, "stdout", "built\r");
    appendTerminalOutput(out, "stdout", "\nnext\r\n");
    expect(out.lines.map((l) => l.text)).toEqual(["built", "next"]);
  });

  it("interleaves stderr as its own lines", () => {
    const out = createTerminalOutput();
    appendTerminalOutput(out, "stdout", "compiling ");
    appendTerminalOutput(out, "stderr", "warning: slow\n");
    appendTerminalOutput(out, "stdout", "ok\n");
    expect(out.lines).toEqual([
      { stream: "stdout", text: "compiling " },
      { stream: "stderr", text: "warning: slow" },
      { stream: "stdout", text: "ok" },
    ]);
  });

  it("keeps only the newest lines and counts what it dropped", () => {
    const out = createTerminalOutput();
    appendTerminalOutput(out, "stdout", Array.from({ length: MAX_TERMINAL_LINES + 25 }, (_, i) => `line ${i}`).join("\n") + "\n");
    expect(out.lines).toHaveLength(MAX_TERMINAL_LINES);
    expect(out.dropped).toBe(25);
    expect(out.lines[0]!.text).toBe("line 25");
    settleTerminalOutput(out, { ok: true, exitCode: 0 });
    expect(out.lines.length).toBeLessThan(MAX_TERMINAL_LINES);
    expect(out.dropped + out.lines.length).toBe(MAX_TERMINAL_LINES + 25);
    expect(out.exit).toEqual({ code: 0, timedOut: false, cancelled: false, error: "" });
  });

  it("parses ANSI colour and drops other escapes", () => {
    expect(ansiSegments("\x1b[32m✓\x1b[39m built \x1b[1min\x1b[22m 4s")).toEqual([
      { fg: 2, text: "✓" },
      { fg: undefined, text: " built " },
      { fg: undefined, bold: true, text: "in" },
      { fg: undefined, bold: false, dim: false, text: " 4s" },
    ]);
    expect(stripAnsi("\x1b[2K\x1b[1Gloading\x1b]0;title\x07")).toBe("loading");
  });

  it("surfaces the newest non-blank line as the running command's tail", () => {
    const out = createTerminalOutput();
    appendTerminalOutput(out, "stdout", "\x1b[36mtransforming\x1b[39m (12)\n\n   \n");
    expect(terminalTail(out)).toBe("transforming (12)");
    expect(terminalTail(null)).toBe("");
  });

  it("rebuilds a finished command from its result, including one that never ran", () => {
    expect(terminalFromResult({ ok: true, exitCode: 1, stdout: "a\nb", stderr: "boom" })!.lines.map((l) => [l.stream, l.text]))
      .toEqual([["stdout", "a"], ["stdout", "b"], ["stderr", "boom"]]);
    const missing = terminalFromResult({ ok: false, error: "'foo' is not installed" })!;
    expect(missing.lines).toEqual([]);
    expect(missing.exit?.error).toBe("'foo' is not installed");
    expect(terminalFromResult({ ok: true, path: "x" })).toBeNull();
  });
});

describe("tool calls carry their terminal", () => {
  it("streams onto a shell call, then settles on its result without re-reading stdout", () => {
    const state = createChatState();
    const turn = createAssistantTurn(state, "t1", false);
    const call = ensureToolCall(state, turn, { toolCallId: "sh", toolName: "shell_run", input: { command: "npm", args: ["test"] } });
    applyToolOutput(call, [{ stream: "stdout", text: "running\n" }, { stream: "stderr", text: "warn\n" }], false);
    expect(call.output?.live).toBe(true);
    applyToolResult(turn, call, { ok: true, exitCode: 0, stdout: "IGNORED", stderr: "" }, 40);
    expect(call.output?.live).toBe(false);
    expect(call.output?.lines.map((l) => l.text)).toEqual(["running", "warn"]);
    expect(call.output?.exit?.code).toBe(0);
  });

  it("keeps a long build's output even though the retained result is truncated", () => {
    const state = createChatState();
    const turn = createAssistantTurn(state, "t2", false);
    const call = ensureToolCall(state, turn, { toolCallId: "sh2", toolName: "shell_run", input: { command: "make" } });
    const stdout = Array.from({ length: 3000 }, (_, i) => `step ${i}`).join("\n");
    applyToolResult(turn, call, JSON.stringify({ ok: true, exitCode: 0, stdout, stderr: "" }), 10);
    expect(typeof call.result).toBe("string"); // bounded to a truncated preview
    expect(call.output!.lines.at(-1)!.text).toBe("step 2999");
  });

  it("gives other tools no terminal", () => {
    const state = createChatState();
    const turn = createAssistantTurn(state, "t3", false);
    const call = ensureToolCall(state, turn, { toolCallId: "r", toolName: "file_read", input: { path: "a" } });
    applyToolResult(turn, call, { ok: true, stdout: "not a command" }, 1);
    expect(call.output).toBeNull();
  });
});
