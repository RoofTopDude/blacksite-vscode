import { describe, expect, it, vi } from "vitest";
import type { EditProvider, EditProviderOptions } from "../../src/diff-edit-service.js";
import type { LspContext, LspProvider } from "../../src/lsp-service.js";
import {
  createLoopEditProvider,
  createLoopLspProvider,
  loopEditApprovalProvider,
  stopLaneOnApprovalDenial,
} from "../../src/loops/loop-approval-routing.js";

function editDelegate(calls: Array<{ tool: string; opts: EditProviderOptions }>): EditProvider {
  return {
    applyEdit: async (_input, opts) => {
      calls.push({ tool: "edit", opts });
      return { ok: true, path: "src/a.ts", replacements: 1 };
    },
    applyBatchEdits: async (_input, opts) => {
      calls.push({ tool: "batch", opts });
      return { ok: true, files: 1, edits: 1, replacements: 1, results: [] };
    },
    applyJsonEdit: async (_input, opts) => {
      calls.push({ tool: "json", opts });
      return { ok: true, path: "package.json", operations: 1, lineChanges: { additions: 1, deletions: 1 } };
    },
    movePath: async (_input, opts) => {
      calls.push({ tool: "move", opts });
      return { ok: true, source: "a.ts", destination: "b.ts" };
    },
  };
}

describe("loop editor approval routing", () => {
  it("stops the lane on a refusal so the supervisor can advance the queue", async () => {
    const stop = vi.fn();
    const policy = stopLaneOnApprovalDenial(async () => "deny", stop);

    await expect(policy("network", "shell_run", "publish")).resolves.toBe("deny");
    expect(stop).toHaveBeenCalledWith("Blocked by automated continuation review.");
  });

  it("keeps the lane running after an allowed review", async () => {
    const stop = vi.fn();
    const policy = stopLaneOnApprovalDenial(async () => "allow", stop);

    await expect(policy("write", "file_edit", "change src/a.ts")).resolves.toBe("allow");
    expect(stop).not.toHaveBeenCalled();
  });

  it("binds every editor mutation to a request-local reviewer and disables editor previews", async () => {
    const calls: Array<{ tool: string; opts: EditProviderOptions }> = [];
    const reviewed: string[] = [];
    const provider = createLoopEditProvider(editDelegate(calls), async (_tier, toolName) => {
      reviewed.push(toolName);
      return "allow";
    });

    await provider.applyEdit({ path: "src/a.ts", oldString: "a", newString: "b" }, { autoApprove: true });
    await provider.applyBatchEdits({ edits: [] }, { autoApprove: true });
    await provider.applyJsonEdit({ path: "package.json", operations: [] }, { autoApprove: true });
    await provider.movePath!({ source: "a.ts", destination: "b.ts" }, { autoApprove: true });

    for (const call of calls) {
      expect(call.opts).toMatchObject({ autoApprove: false, showPreview: false });
      expect(call.opts.approvalProvider).toBeTypeOf("function");
      await call.opts.approvalProvider!({ summary: `${call.tool} mutation`, fileCount: 1 });
    }
    expect(reviewed).toEqual(["file_edit", "file_edit_batch", "json_edit", "file_move"]);
  });

  it("fails closed instead of falling through to a native modal when no policy decides", async () => {
    const provider = loopEditApprovalProvider(async () => null, "file_edit");
    await expect(provider({ summary: "change src/a.ts", fileCount: 1 })).resolves.toBe("reject");
  });

  it("routes LSP workspace edits and opaque commands through the matching code tool reviewer", async () => {
    const policy = vi.fn(async () => "allow" as const);
    const delegate: LspProvider = {
      dispatch: async (_op: string, _payload: Record<string, unknown>, ctx: LspContext) => {
        expect(ctx).toMatchObject({ autoApprove: false, showPreview: false });
        const outcome = await ctx.approvalProvider!({
          summary: "Run code action command: organize imports",
          fileCount: 0,
          unpreviewableCommand: "source.organizeImports",
        });
        return { ok: outcome === "apply" };
      },
    };

    const result = await createLoopLspProvider(delegate, policy).dispatch("actions", { apply: "organize" }, { autoApprove: true });

    expect(result.ok).toBe(true);
    expect(policy).toHaveBeenCalledWith(
      "write",
      "code_actions",
      expect.stringContaining("source.organizeImports"),
    );
  });

  it("classifies overwrite-capable resource operations as destructive", async () => {
    const policy = vi.fn(async () => "deny" as const);
    const provider = loopEditApprovalProvider(policy, "file_move");

    await expect(provider({ summary: "Move a.ts to b.ts", fileCount: 2, destructive: true })).resolves.toBe("reject");
    expect(policy).toHaveBeenCalledWith("destructive", "file_move", expect.stringContaining("overwrite"));
  });
});
