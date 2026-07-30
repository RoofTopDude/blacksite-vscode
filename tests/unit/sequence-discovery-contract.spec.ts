import { describe, expect, it } from "vitest";
import { SEQUENCE_TOOLS } from "../../src/tools/definitions";

interface ArrayEnumSchema {
  items?: {
    enum?: string[];
  };
}

describe("sequence_discover public contract", () => {
  it("advertises only discovery sources and surface kinds that the browser discovery adapter implements", () => {
    const definition = SEQUENCE_TOOLS.find((tool) => tool.name === "sequence_discover");
    expect(definition).toBeDefined();

    const sources = definition?.input_schema.properties["sources"] as ArrayEnumSchema;
    const include = definition?.input_schema.properties["include"] as ArrayEnumSchema;

    expect(sources.items?.enum).toEqual([
      "filesystem",
      "router",
      "storybook",
      "tests",
      "runtime",
    ]);
    expect(include.items?.enum).toEqual([
      "routes",
      "stories",
      "tests",
      "files",
    ]);
  });
});
