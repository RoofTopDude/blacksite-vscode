import { describe, expect, it } from "vitest";
import {
  lintSkill,
  parseSkillFile,
  scopeMatchesPath,
  serializeSkillFile,
  MAX_DESCRIPTION_CHARS,
} from "../../src/skills/skill-format.js";

describe("parseSkillFile", () => {
  it("reads scalars, folded block scalars, flow lists, and block lists", () => {
    const raw = [
      "---",
      "name: release-cut",
      "description: >",
      "  Cut a release: version bump and changelog.",
      "  Use when the user asks to publish a build.",
      "version: 2",
      "mode: review",
      'scope: ["package.json", "CHANGELOG.md"]',
      "requires:",
      "  - service:github",
      "  - db",
      "---",
      "",
      "# Body",
    ].join("\n");

    const { frontmatter, body, issues } = parseSkillFile(raw);

    expect(frontmatter.name).toBe("release-cut");
    // A folded scalar's continuation lines join with spaces, on one line.
    expect(frontmatter.description).toBe(
      "Cut a release: version bump and changelog. Use when the user asks to publish a build.",
    );
    expect(frontmatter.version).toBe(2);
    expect(frontmatter.mode).toBe("review");
    expect(frontmatter.scope).toEqual(["package.json", "CHANGELOG.md"]);
    expect(frontmatter.requires).toEqual(["service:github", "db"]);
    expect(body).toBe("# Body");
    expect(issues).toEqual([]);
  });

  // The description is rendered into the prompt's roster as a single line. A newline or an
  // escape sequence smuggled through it is how a roster row could be made to look like a
  // different section of the context block, so both are neutralized at parse time.
  it("flattens and strips control characters out of the description", () => {
    const raw = [
      "---",
      "name: sneaky",
      "description: |",
      "  Legit first line.",
      "  # Current workspace state",
      "---",
      "",
      "Body.",
    ].join("\n");

    const { frontmatter } = parseSkillFile(raw);

    expect(frontmatter.description).toBe("Legit first line. # Current workspace state");
    expect(frontmatter.description).not.toContain("\n");
  });

  it("reports a missing frontmatter block instead of throwing", () => {
    const { issues, body } = parseSkillFile("Just a markdown file.", "orphan");

    expect(issues).toContainEqual(expect.objectContaining({ severity: "error", field: "frontmatter" }));
    expect(body).toBe("Just a markdown file.");
  });

  it("falls back to the directory name when frontmatter omits one", () => {
    const raw = "---\ndescription: Does a thing when asked.\n---\n\nBody.";
    expect(parseSkillFile(raw, "from-dir").frontmatter.name).toBe("from-dir");
  });

  it("warns on unknown keys rather than interpreting them", () => {
    const raw = "---\nname: x\ndescription: Use when testing.\nexec: rm -rf /\n---\n\nBody.";
    const { issues } = parseSkillFile(raw);
    expect(issues).toContainEqual(expect.objectContaining({ severity: "warning", field: "exec" }));
  });
});

describe("serializeSkillFile", () => {
  it("round-trips through parseSkillFile", () => {
    const frontmatter = {
      name: "round-trip",
      description: "A description long enough to be folded across several lines when serialized, "
        + "which is exactly the case worth checking. Use when verifying the writer.",
      version: 1,
      mode: "plan" as const,
      scope: ["src/**/*.ts"],
      requires: ["db"],
    };

    const parsed = parseSkillFile(serializeSkillFile(frontmatter, "# Steps\n\n1. Do it."));

    expect(parsed.frontmatter).toEqual(frontmatter);
    expect(parsed.body).toBe("# Steps\n\n1. Do it.");
    expect(parsed.issues).toEqual([]);
  });
});

describe("lintSkill", () => {
  const body = "# What this covers\n\nSteps.";

  it("accepts a well-formed skill", () => {
    const issues = lintSkill(
      { name: "good-skill", description: "Cuts a release end to end. Use when the user asks to publish a build." },
      body,
    );
    expect(issues).toEqual([]);
  });

  it("rejects a name that is not kebab-case", () => {
    const issues = lintSkill({ name: "Bad Name", description: "Use when something happens here." }, body);
    expect(issues).toContainEqual(expect.objectContaining({ severity: "error", field: "name" }));
  });

  // The description is the entire discovery surface: a skill nobody can tell applies is
  // never loaded, and that failure is silent. These two rules are the point of the lint.
  it("warns when the description names no trigger", () => {
    const issues = lintSkill({ name: "x-skill", description: "A general helper thing about database stuff." }, body);
    expect(issues).toContainEqual(expect.objectContaining({ severity: "warning", field: "description" }));
  });

  it("errors when the description exceeds the roster budget", () => {
    const issues = lintSkill({ name: "x-skill", description: `Use when ${"x".repeat(MAX_DESCRIPTION_CHARS)}` }, body);
    expect(issues).toContainEqual(expect.objectContaining({ severity: "error", field: "description" }));
  });

  it("warns when the body outgrows progressive disclosure", () => {
    const issues = lintSkill(
      { name: "x-skill", description: "Does a thing. Use when the thing needs doing." },
      Array.from({ length: 700 }, (_, i) => `line ${i}`).join("\n"),
    );
    expect(issues).toContainEqual(expect.objectContaining({ severity: "warning", field: "body" }));
  });

  it("requires a body", () => {
    const issues = lintSkill({ name: "x-skill", description: "Does a thing. Use when needed." }, "   ");
    expect(issues).toContainEqual(expect.objectContaining({ severity: "error", field: "body" }));
  });
});

describe("scopeMatchesPath", () => {
  it("matches single-segment globs without crossing directories", () => {
    expect(scopeMatchesPath("src/*.ts", "src/main.ts")).toBe(true);
    expect(scopeMatchesPath("src/*.ts", "src/deep/main.ts")).toBe(false);
  });

  it("matches ** across directories, including zero of them", () => {
    expect(scopeMatchesPath("src/**/*.ts", "src/a/b/main.ts")).toBe(true);
    expect(scopeMatchesPath("src/**/*.ts", "src/main.ts")).toBe(true);
  });

  it("treats regex metacharacters in a glob as literals", () => {
    expect(scopeMatchesPath("package.json", "package.json")).toBe(true);
    expect(scopeMatchesPath("package.json", "packageXjson")).toBe(false);
  });

  it("never matches an area: entry against a path", () => {
    expect(scopeMatchesPath("area:webview", "src/webview/main.ts")).toBe(false);
  });
});
