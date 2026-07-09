import { describe, expect, it } from "vitest";
import { formatActiveSignature, type SignatureHelpLike } from "../../src/lsp-signature-format.js";

function help(overrides: Partial<SignatureHelpLike>): SignatureHelpLike {
  return {
    signatures: [],
    activeSignature: 0,
    activeParameter: 0,
    ...overrides,
  };
}

// Computed via indexOf rather than hand-counted, so the offsets can't drift from the label.
function tupleParam(label: string, text: string): { label: [number, number] } {
  const start = label.indexOf(text);
  if (start < 0) throw new Error(`"${text}" not found in "${label}"`);
  return { label: [start, start + text.length] };
}

describe("formatActiveSignature", () => {
  it("returns undefined for undefined or empty signature help", () => {
    expect(formatActiveSignature(undefined)).toBeUndefined();
    expect(formatActiveSignature(help({ signatures: [] }))).toBeUndefined();
  });

  it("bolds the active parameter using the tuple-offset label form", () => {
    const label = "fetchModels(provider: string, force?: boolean): Model[]";
    const h = help({
      signatures: [{ label, parameters: [tupleParam(label, "provider: string"), tupleParam(label, "force?: boolean")] }],
      activeParameter: 0,
    });
    expect(formatActiveSignature(h)).toBe("fetchModels(**provider: string**, force?: boolean): Model[]");
  });

  it("bolds the active parameter using the string-match label form", () => {
    const h = help({
      signatures: [{ label: "send(message: string): void", parameters: [{ label: "message: string" }] }],
      activeParameter: 0,
    });
    expect(formatActiveSignature(h)).toBe("send(**message: string**): void");
  });

  it("falls back to the plain label when the string label isn't found in the signature", () => {
    const h = help({
      signatures: [{ label: "send(message: string): void", parameters: [{ label: "not-present" }] }],
      activeParameter: 0,
    });
    expect(formatActiveSignature(h)).toBe("send(message: string): void");
  });

  it("falls back to the plain label on an out-of-range tuple offset", () => {
    const h = help({
      signatures: [{ label: "short()", parameters: [{ label: [100, 200] }] }],
      activeParameter: 0,
    });
    expect(formatActiveSignature(h)).toBe("short()");
  });

  it("prefers a per-signature activeParameter over the top-level one", () => {
    const label = "f(a: number, b: number)";
    const h = help({
      signatures: [{ label, parameters: [tupleParam(label, "a: number"), tupleParam(label, "b: number")], activeParameter: 1 }],
      activeSignature: 0,
      activeParameter: 0,
    });
    expect(formatActiveSignature(h)).toBe("f(a: number, **b: number**)");
  });

  it("falls back to the plain label when there is no parameter at the active index", () => {
    const h = help({
      signatures: [{ label: "noop()", parameters: [] }],
      activeParameter: 0,
    });
    expect(formatActiveSignature(h)).toBe("noop()");
  });

  it("uses the first signature when activeSignature is out of range", () => {
    const h = help({
      signatures: [{ label: "only()", parameters: [] }],
      activeSignature: 5,
    });
    expect(formatActiveSignature(h)).toBe("only()");
  });
});
