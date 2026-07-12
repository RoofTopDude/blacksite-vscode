import { describe, expect, it } from "vitest";
import {
  applyJsonOperation, decodePointer, detectIndent, serializeJson, type JsonValue,
} from "../../src/json-pointer.js";

describe("decodePointer", () => {
  it("decodes the empty pointer to the document root", () => {
    expect(decodePointer("")).toEqual([]);
  });

  it("splits and unescapes segments", () => {
    expect(decodePointer("/a/b")).toEqual(["a", "b"]);
    expect(decodePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
  });

  it("rejects a pointer that doesn't start with /", () => {
    expect(() => decodePointer("a/b")).toThrow(/must start with/);
  });
});

describe("applyJsonOperation: set", () => {
  it("overwrites an existing key", () => {
    const root: JsonValue = { scripts: { build: "tsc" } };
    const res = applyJsonOperation(root, { op: "set", pointer: "/scripts/build", value: "vite build" });
    expect(res.ok).toBe(true);
    expect(root).toEqual({ scripts: { build: "vite build" } });
  });

  it("adds a brand new key without disturbing siblings", () => {
    const root: JsonValue = { scripts: { build: "tsc" } };
    applyJsonOperation(root, { op: "set", pointer: "/scripts/test", value: "vitest" });
    expect(root).toEqual({ scripts: { build: "tsc", test: "vitest" } });
  });

  it("auto-creates missing intermediate objects", () => {
    const root: JsonValue = {};
    const res = applyJsonOperation(root, { op: "set", pointer: "/a/b/c", value: 1 });
    expect(res.ok).toBe(true);
    expect(root).toEqual({ a: { b: { c: 1 } } });
  });

  it("sets an array element by index and appends with '-'", () => {
    const root: JsonValue = { items: ["a", "b"] };
    applyJsonOperation(root, { op: "set", pointer: "/items/0", value: "z" });
    expect(root).toEqual({ items: ["z", "b"] });
    applyJsonOperation(root, { op: "set", pointer: "/items/-", value: "c" });
    expect(root).toEqual({ items: ["z", "b", "c"] });
  });

  it("rejects an out-of-range array index", () => {
    const root: JsonValue = { items: ["a"] };
    const res = applyJsonOperation(root, { op: "set", pointer: "/items/5", value: "x" });
    expect(res.ok).toBe(false);
    expect(root).toEqual({ items: ["a"] });
  });

  it("rejects setting the document root", () => {
    const res = applyJsonOperation({}, { op: "set", pointer: "", value: { a: 1 } });
    expect(res.ok).toBe(false);
  });

  it("rejects descending through a scalar", () => {
    const root: JsonValue = { a: 1 };
    const res = applyJsonOperation(root, { op: "set", pointer: "/a/b", value: 2 });
    expect(res.ok).toBe(false);
    expect(root).toEqual({ a: 1 });
  });

  it("requires a value", () => {
    const res = applyJsonOperation({}, { op: "set", pointer: "/a" });
    expect(res.ok).toBe(false);
  });
});

describe("applyJsonOperation: remove", () => {
  it("removes an object key", () => {
    const root: JsonValue = { a: 1, b: 2 };
    const res = applyJsonOperation(root, { op: "remove", pointer: "/a" });
    expect(res.ok).toBe(true);
    expect(root).toEqual({ b: 2 });
  });

  it("removes an array element, shifting later elements down", () => {
    const root: JsonValue = { items: ["a", "b", "c"] };
    applyJsonOperation(root, { op: "remove", pointer: "/items/1" });
    expect(root).toEqual({ items: ["a", "c"] });
  });

  it("errors removing a key that doesn't exist rather than silently no-oping", () => {
    const root: JsonValue = { a: 1 };
    const res = applyJsonOperation(root, { op: "remove", pointer: "/missing" });
    expect(res.ok).toBe(false);
    expect(root).toEqual({ a: 1 });
  });

  it("errors removing an out-of-range array index", () => {
    const root: JsonValue = { items: ["a"] };
    const res = applyJsonOperation(root, { op: "remove", pointer: "/items/9" });
    expect(res.ok).toBe(false);
  });
});

describe("applyJsonOperation: merge", () => {
  it("shallow-merges into an existing object without dropping other keys", () => {
    const root: JsonValue = { compilerOptions: { strict: true, target: "es2020" } };
    const res = applyJsonOperation(root, { op: "merge", pointer: "/compilerOptions", value: { target: "es2022", lib: ["ES2022"] } });
    expect(res.ok).toBe(true);
    expect(root).toEqual({ compilerOptions: { strict: true, target: "es2022", lib: ["ES2022"] } });
  });

  it("creates the target object if it's missing", () => {
    const root: JsonValue = {};
    applyJsonOperation(root, { op: "merge", pointer: "/compilerOptions", value: { strict: true } });
    expect(root).toEqual({ compilerOptions: { strict: true } });
  });

  it("merges at the document root when pointer is empty", () => {
    const root: JsonValue = { a: 1 };
    applyJsonOperation(root, { op: "merge", pointer: "", value: { b: 2 } });
    expect(root).toEqual({ a: 1, b: 2 });
  });

  it("rejects merging into an array element", () => {
    const root: JsonValue = { items: [{ a: 1 }] };
    const res = applyJsonOperation(root, { op: "merge", pointer: "/items/0", value: { b: 2 } });
    expect(res.ok).toBe(false);
  });

  it("rejects a non-object merge value", () => {
    const root: JsonValue = { a: {} };
    const res = applyJsonOperation(root, { op: "merge", pointer: "/a", value: "not an object" });
    expect(res.ok).toBe(false);
  });
});

describe("detectIndent", () => {
  it("detects 2-space indent", () => {
    expect(detectIndent('{\n  "a": 1\n}')).toBe("  ");
  });

  it("detects 4-space indent", () => {
    expect(detectIndent('{\n    "a": 1\n}')).toBe("    ");
  });

  it("detects tab indent", () => {
    expect(detectIndent('{\n\t"a": 1\n}')).toBe("\t");
  });

  it("falls back to 2 spaces for unindented/minified JSON", () => {
    expect(detectIndent('{"a":1}')).toBe("  ");
  });
});

describe("serializeJson", () => {
  it("preserves indent and adds a trailing newline when requested", () => {
    expect(serializeJson({ a: 1 }, "  ", true)).toBe('{\n  "a": 1\n}\n');
  });

  it("omits the trailing newline when the original had none", () => {
    expect(serializeJson({ a: 1 }, "  ", false)).toBe('{\n  "a": 1\n}');
  });
});
