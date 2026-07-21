import { describe, expect, it } from "vitest";
import { toStrictToolSchema, withAnthropicStrictTools } from "../../src/agent-session.js";

// Strict tool use (Anthropic Messages / Bedrock Mantle): schemas inside the documented strict
// subset are marked `strict: true` so the API guarantees schema-valid tool_use.input — the
// malformed-argument class the coercion layer repairs becomes impossible at the source. The
// conversion is whitelist-gated: anything outside the subset must be sent unchanged (no strict),
// because a wrongly-marked tool would 400 every turn of the session.

describe("toStrictToolSchema", () => {
  it("converts a plain object schema, forcing additionalProperties:false and keeping required", () => {
    const out = toStrictToolSchema({
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        limit: { type: "integer" },
      },
      required: ["path"],
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        limit: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: false,
    });
  });

  it("defaults a missing required array and recurses into nested objects and items", () => {
    const out = toStrictToolSchema({
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { old: { type: "string" }, new: { type: "string" } },
          },
        },
      },
    });
    expect(out?.["required"]).toEqual([]);
    const edits = (out?.["properties"] as Record<string, Record<string, unknown>>)["edits"];
    const items = edits?.["items"] as Record<string, unknown>;
    expect(items["additionalProperties"]).toBe(false);
    expect(items["required"]).toEqual([]);
  });

  it("rejects free-form payload objects (no declared properties) — strict would forbid every key", () => {
    expect(toStrictToolSchema({ type: "object", properties: {} })).toBeNull();
    expect(
      toStrictToolSchema({
        type: "object",
        properties: { payload: { type: "object", properties: {} } },
        required: ["payload"],
      }),
    ).toBeNull();
  });

  it("rejects schemas using keywords outside the strict subset", () => {
    // Numeric constraint
    expect(toStrictToolSchema({
      type: "object",
      properties: { n: { type: "integer", minimum: 1 } },
    })).toBeNull();
    // String length constraint
    expect(toStrictToolSchema({
      type: "object",
      properties: { s: { type: "string", maxLength: 10 } },
    })).toBeNull();
    // $ref (recursion risk)
    expect(toStrictToolSchema({
      type: "object",
      properties: { r: { $ref: "#/defs/x" } },
    })).toBeNull();
  });

  it("rejects explicit free-form additionalProperties, type arrays, and unsupported formats", () => {
    expect(toStrictToolSchema({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: true,
    })).toBeNull();
    expect(toStrictToolSchema({
      type: "object",
      properties: { a: { type: ["string", "null"] } },
    })).toBeNull();
    expect(toStrictToolSchema({
      type: "object",
      properties: { a: { type: "string", format: "regex" } },
    })).toBeNull();
    // Supported format passes.
    expect(toStrictToolSchema({
      type: "object",
      properties: { a: { type: "string", format: "uuid" } },
    })).not.toBeNull();
  });

  it("accepts enum/const/anyOf within the subset", () => {
    const out = toStrictToolSchema({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["a", "b"] },
        target: { anyOf: [{ type: "string" }, { type: "integer" }] },
      },
      required: ["mode"],
    });
    expect(out).not.toBeNull();
  });

  it("does not mutate the input schema (tool definitions are shared across providers)", () => {
    const schema = {
      type: "object",
      properties: { path: { type: "string" } },
    } as Record<string, unknown>;
    const snapshot = JSON.stringify(schema);
    toStrictToolSchema(schema);
    expect(JSON.stringify(schema)).toBe(snapshot);
  });
});

describe("withAnthropicStrictTools", () => {
  it("marks qualifying tools strict and passes non-qualifying tools through unchanged", () => {
    const qualifying = {
      name: "file_read",
      description: "Read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    };
    const freeForm = {
      name: "db_dispatch",
      description: "Dispatch",
      input_schema: { type: "object", properties: { payload: { type: "object", properties: {} } } },
    };
    const [a, b] = withAnthropicStrictTools([qualifying, freeForm]);
    expect(a!["strict"]).toBe(true);
    expect((a!["input_schema"] as Record<string, unknown>)["additionalProperties"]).toBe(false);
    expect(b!["strict"]).toBeUndefined();
    expect(b!["input_schema"]).toBe(freeForm.input_schema); // byte-identical pass-through
  });
});
