import { describe, expect, it } from "vitest";
import {
  SLASH_COMMANDS, isSlashInput, matchSlashCommands, parseSlashInput,
  resolveSlashCommand, slashQuery, slashUsage,
} from "../../src/webview/react/lib/slash-commands.js";

describe("isSlashInput", () => {
  it("recognizes a leading slash", () => {
    expect(isSlashInput("/")).toBe(true);
    expect(isSlashInput("/model")).toBe(true);
    expect(isSlashInput("/model gpt-5")).toBe(true);
  });
  it("rejects non-slash text", () => {
    expect(isSlashInput("hello")).toBe(false);
    expect(isSlashInput(" /model")).toBe(false); // leading space isn't a command
    expect(isSlashInput("")).toBe(false);
  });
});

describe("slashQuery", () => {
  it("returns the partial name while typing the command", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/mod")).toBe("mod");
    expect(slashQuery("/clear")).toBe("clear");
  });
  it("returns null once an argument is being typed", () => {
    expect(slashQuery("/model ")).toBeNull();
    expect(slashQuery("/model gpt")).toBeNull();
  });
  it("returns null for non-slash text", () => {
    expect(slashQuery("hello")).toBeNull();
  });
});

describe("parseSlashInput", () => {
  it("splits name and argument", () => {
    expect(parseSlashInput("/model gpt-5-mini")).toEqual({ name: "model", arg: "gpt-5-mini" });
    expect(parseSlashInput("/clear")).toEqual({ name: "clear", arg: "" });
  });
  it("lowercases the name and trims the arg", () => {
    expect(parseSlashInput("/MODEL   Sonnet ")).toEqual({ name: "model", arg: "Sonnet" });
  });
  it("returns null for non-commands", () => {
    expect(parseSlashInput("hello")).toBeNull();
    expect(parseSlashInput("/123")).toBeNull(); // must start with a letter
    expect(parseSlashInput("/")).toBeNull();
  });
});

describe("resolveSlashCommand", () => {
  it("resolves canonical names", () => {
    expect(resolveSlashCommand("compact")?.name).toBe("compact");
  });
  it("resolves aliases to their canonical command", () => {
    expect(resolveSlashCommand("new")?.name).toBe("clear");
  });
  it("is case-insensitive and returns null for unknowns", () => {
    expect(resolveSlashCommand("HELP")?.name).toBe("help");
    expect(resolveSlashCommand("nope")).toBeNull();
    expect(resolveSlashCommand("")).toBeNull();
  });
});

describe("matchSlashCommands", () => {
  it("returns everything for an empty query", () => {
    expect(matchSlashCommands("")).toHaveLength(SLASH_COMMANDS.length);
  });
  it("prefix matches rank ahead of substring matches", () => {
    const results = matchSlashCommands("c");
    expect(results.map((c) => c.name)).toContain("clear");
    expect(results.map((c) => c.name)).toContain("compact");
  });
  it("matches aliases", () => {
    expect(matchSlashCommands("new").map((c) => c.name)).toContain("clear");
  });
  it("returns nothing for an unmatched query", () => {
    expect(matchSlashCommands("zzz")).toHaveLength(0);
  });
});

describe("slashUsage", () => {
  it("uses the explicit usage string when present", () => {
    const model = SLASH_COMMANDS.find((c) => c.name === "model")!;
    expect(slashUsage(model)).toBe("/model <name>");
  });
  it("falls back to /name", () => {
    const clear = SLASH_COMMANDS.find((c) => c.name === "clear")!;
    expect(slashUsage(clear)).toBe("/clear");
  });
});
