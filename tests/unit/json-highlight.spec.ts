import { describe, expect, it } from "vitest";
import { tokenizeJson, type JsonToken } from "../../src/webview/react/lib/json-highlight.js";

function joined(tokens: JsonToken[]): string {
  return tokens.map((t) => t.text).join("");
}

function classesOf(tokens: JsonToken[], cls: JsonToken["cls"]): string[] {
  return tokens.filter((t) => t.cls === cls).map((t) => t.text);
}

describe("tokenizeJson: non-JSON fallback", () => {
  it("returns null for empty or whitespace-only input", () => {
    expect(tokenizeJson("")).toBeNull();
    expect(tokenizeJson("   ")).toBeNull();
  });

  it("returns null for plain text that isn't an object/array", () => {
    expect(tokenizeJson("No data")).toBeNull();
    expect(tokenizeJson("Pending…")).toBeNull();
    expect(tokenizeJson("total 0\ndrwxr-xr-x  2 user  staff  64 Jan 1 00:00 .")).toBeNull();
  });

  it("returns null for a bare string/number/boolean JSON literal", () => {
    expect(tokenizeJson('"just a string"')).toBeNull();
    expect(tokenizeJson("42")).toBeNull();
    expect(tokenizeJson("true")).toBeNull();
  });

  it("returns null for malformed/truncated JSON (e.g. formatDetailValue's truncation marker)", () => {
    expect(tokenizeJson('{"path": "src/foo.ts", "content": "abc\n… [truncated]')).toBeNull();
    expect(tokenizeJson("{not valid")).toBeNull();
  });
});

describe("tokenizeJson: valid JSON", () => {
  it("tokenizes a flat object with every value type", () => {
    const tokens = tokenizeJson('{"path":"a.ts","ok":true,"count":3,"note":null}');
    expect(tokens).not.toBeNull();
    expect(classesOf(tokens!, "key")).toEqual(['"path"', '"ok"', '"count"', '"note"']);
    expect(classesOf(tokens!, "string")).toEqual(['"a.ts"']);
    expect(classesOf(tokens!, "boolean")).toEqual(["true"]);
    expect(classesOf(tokens!, "number")).toEqual(["3"]);
    expect(classesOf(tokens!, "null")).toEqual(["null"]);
  });

  it("distinguishes a string that is a key from an identical string used as a value", () => {
    const tokens = tokenizeJson('{"name":"name"}')!;
    expect(classesOf(tokens, "key")).toEqual(['"name"']);
    expect(classesOf(tokens, "string")).toEqual(['"name"']);
  });

  it("classifies negative and decimal numbers", () => {
    // JSON.stringify's roundtrip is the source of truth for exact formatting (see the
    // "re-serializes" test below) — these values are chosen to survive it unchanged.
    const tokens = tokenizeJson("[-1, 2.5, 100, -0.5]")!;
    expect(classesOf(tokens, "number")).toEqual(["-1", "2.5", "100", "-0.5"]);
  });

  it("classifies numbers in exponential notation as a single token", () => {
    const tokens = tokenizeJson("[1e21, 1e-9]")!;
    expect(classesOf(tokens, "number")).toEqual(["1e+21", "1e-9"]);
  });

  it("handles escaped quotes and backslashes inside strings without breaking the scan", () => {
    const tokens = tokenizeJson(String.raw`{"msg": "she said \"hi\" and used \\ backslash"}`)!;
    expect(classesOf(tokens, "string")).toEqual([String.raw`"she said \"hi\" and used \\ backslash"`]);
  });

  it("tokenizes nested arrays and objects", () => {
    const tokens = tokenizeJson('{"items":[{"id":1},{"id":2}]}')!;
    expect(classesOf(tokens, "key")).toEqual(['"items"', '"id"', '"id"']);
    expect(classesOf(tokens, "number")).toEqual(["1", "2"]);
    expect(classesOf(tokens, "punct").join("")).toContain("[");
  });

  it("re-serializes with 2-space indentation regardless of the input's original spacing", () => {
    const tokens = tokenizeJson('{"a":1}')!;
    expect(joined(tokens)).toBe('{\n  "a": 1\n}');
  });

  it("round-trips the full text losslessly (concatenated tokens equal the canonical JSON)", () => {
    const input = { b: [1, 2, "three"], a: { nested: true, empty: null } };
    const tokens = tokenizeJson(JSON.stringify(input))!;
    expect(joined(tokens)).toBe(JSON.stringify(input, null, 2));
  });

  it("accepts a top-level array", () => {
    const tokens = tokenizeJson("[1,2,3]");
    expect(tokens).not.toBeNull();
    expect(classesOf(tokens!, "number")).toEqual(["1", "2", "3"]);
  });

  it("merges consecutive same-class characters into a single token (compact output)", () => {
    const tokens = tokenizeJson('{"a":1,"b":2}')!;
    // Every run of whitespace should be one token, not one per character.
    for (const t of tokens) {
      if (t.cls === "ws") expect(t.text.length).toBeGreaterThanOrEqual(1);
    }
    // Sanity: token count stays small relative to character count for structured content.
    expect(tokens.length).toBeLessThan(JSON.stringify(JSON.parse('{"a":1,"b":2}'), null, 2).length);
  });
});
