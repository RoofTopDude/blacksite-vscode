import { describe, expect, it } from "vitest";
import { approvalGrantKey, commandApprovalScope } from "../../src/approval-scope.js";

describe("command approval scope", () => {
  it("keys inline code apart from ordinary commands of the same tier", () => {
    const script = approvalGrantKey(commandApprovalScope("shell_run", "system.shell", "write", { command: "python", args: ["tool.py"] }, false));
    const snippet = approvalGrantKey(commandApprovalScope("shell_run", "system.shell", "write", { command: "python", args: ["-c", "print(1)"] }, false));
    expect(snippet).not.toBe(script);
    expect(snippet).toContain("inline:python");
  });

  it("pins an inline-code grant to its interpreter", () => {
    const python = approvalGrantKey(commandApprovalScope("shell_run", "system.shell", "write", { command: "python", args: ["-c", "1"] }, false));
    const node = approvalGrantKey(commandApprovalScope("shell_run", "system.shell", "write", { command: "node", args: ["-e", "1"] }, false));
    expect(python).not.toBe(node);
  });
});
