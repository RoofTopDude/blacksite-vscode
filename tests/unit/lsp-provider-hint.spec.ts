import { describe, expect, it } from "vitest";
import { noProviderNotice } from "../../src/lsp-provider-hint.js";

describe("noProviderNotice", () => {
  it("formats the actionable no-provider message", () => {
    expect(noProviderNotice("hover", "py", "ms-python.python")).toBe(
      "No hover provider for .py files. Is the ms-python.python extension installed?",
    );
  });

  it("interpolates the feature and language for different ops", () => {
    expect(noProviderNotice("rename", "rs", "rust-lang.rust-analyzer")).toBe(
      "No rename provider for .rs files. Is the rust-lang.rust-analyzer extension installed?",
    );
  });
});
