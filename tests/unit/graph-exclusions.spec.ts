import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXCLUSION_POLICY,
  INVARIANTS_ONLY_POLICY,
  buildExcludeGlob,
  exclusionPolicy,
  exclusionPolicyKey,
  hasExcludedSegment,
  isExcludedSegment,
  normalizeAllowlistEntry,
} from "../../src/graph/exclusions.js";

const DEFAULT = DEFAULT_EXCLUSION_POLICY;

describe("normalizeAllowlistEntry", () => {
  it("accepts a bare name, a dotted name, and path decoration alike", () => {
    expect(normalizeAllowlistEntry("github")).toBe("github");
    expect(normalizeAllowlistEntry(".github")).toBe("github");
    expect(normalizeAllowlistEntry("./github/")).toBe("github");
    expect(normalizeAllowlistEntry("  .GitHub  ")).toBe("github");
    expect(normalizeAllowlistEntry(".vscode-test")).toBe("vscode-test");
  });

  it("rejects anything that is not a single directory name", () => {
    expect(normalizeAllowlistEntry("")).toBeNull();
    expect(normalizeAllowlistEntry("   ")).toBeNull();
    expect(normalizeAllowlistEntry(".")).toBeNull();
    expect(normalizeAllowlistEntry("..")).toBeNull();
    expect(normalizeAllowlistEntry("a/b")).toBeNull();
    expect(normalizeAllowlistEntry(".github/workflows")).toBeNull();
  });

  it("rejects non-string input rather than throwing", () => {
    expect(normalizeAllowlistEntry(null)).toBeNull();
    expect(normalizeAllowlistEntry(undefined)).toBeNull();
    expect(normalizeAllowlistEntry(42)).toBeNull();
    expect(normalizeAllowlistEntry({})).toBeNull();
  });
});

describe("hasExcludedSegment", () => {
  it("drops files under a dot-directory", () => {
    expect(hasExcludedSegment(".vscode-test/vscode-win32/resources/app/main.js", DEFAULT)).toBe(true);
    expect(hasExcludedSegment(".github/workflows/ci.yml", DEFAULT)).toBe(true);
    expect(hasExcludedSegment(".tmp-screenshot/shoot.mjs", DEFAULT)).toBe(true);
  });

  it("keeps ordinary source files", () => {
    expect(hasExcludedSegment("src/graph/exclusions.ts", DEFAULT)).toBe(false);
    expect(hasExcludedSegment("packages/local-runtime/src/types.ts", DEFAULT)).toBe(false);
    expect(hasExcludedSegment("README.md", DEFAULT)).toBe(false);
  });

  it("applies the rule to nested dot-directories, not just top-level ones", () => {
    expect(hasExcludedSegment("packages/web/.cache/bundle.js", DEFAULT)).toBe(true);
    expect(hasExcludedSegment("a/b/c/.pytest_cache/v/results.json", DEFAULT)).toBe(true);
  });

  it("keeps dot-FILES — the rule is about directories", () => {
    /* Client-config shapes are evidence the service lens reads; excluding them
       would silently delete verified config-driven edges. */
    expect(hasExcludedSegment("src/.eslintrc.json", DEFAULT)).toBe(false);
    expect(hasExcludedSegment(".env.production", DEFAULT)).toBe(false);
    expect(hasExcludedSegment("services/api/.env", DEFAULT)).toBe(false);
    expect(hasExcludedSegment(".gitignore", DEFAULT)).toBe(false);
  });

  it("honors the allowlist at any nesting depth", () => {
    const policy = exclusionPolicy({ excludeDotDirectories: true, dotDirectoryAllowlist: [".github"] });
    expect(hasExcludedSegment(".github/workflows/ci.yml", policy)).toBe(false);
    expect(hasExcludedSegment("packages/web/.github/workflows/ci.yml", policy)).toBe(false);
    /* Allowing one dot-directory must not allow the rest. */
    expect(hasExcludedSegment(".vscode-test/vscode-win32/resources/app/main.js", policy)).toBe(true);
  });

  it("accepts allowlist entries in any of the tolerated spellings", () => {
    for (const entry of ["github", ".github", "./github/", ".GitHub"]) {
      const policy = exclusionPolicy({ excludeDotDirectories: true, dotDirectoryAllowlist: [entry] });
      expect(hasExcludedSegment(".github/workflows/ci.yml", policy)).toBe(false);
    }
  });

  it("still excludes the invariants when the dot rule is off", () => {
    expect(hasExcludedSegment(".git/config", INVARIANTS_ONLY_POLICY)).toBe(true);
    expect(hasExcludedSegment(".blacksite/graph-cache.json", INVARIANTS_ONLY_POLICY)).toBe(true);
    expect(hasExcludedSegment(".next/server/page.js", INVARIANTS_ONLY_POLICY)).toBe(true);
    expect(hasExcludedSegment(".venv/lib/site.py", INVARIANTS_ONLY_POLICY)).toBe(true);
    expect(hasExcludedSegment("node_modules/react/index.js", INVARIANTS_ONLY_POLICY)).toBe(true);
    /* …but nothing else. */
    expect(hasExcludedSegment(".vscode-test/vscode-win32/resources/app/main.js", INVARIANTS_ONLY_POLICY)).toBe(false);
    expect(hasExcludedSegment(".github/workflows/ci.yml", INVARIANTS_ONLY_POLICY)).toBe(false);
  });

  it("cannot be talked out of the invariants by an allowlist", () => {
    const policy = exclusionPolicy({
      excludeDotDirectories: true,
      dotDirectoryAllowlist: [".git", "blacksite", "node_modules", ".venv"],
    });
    expect(hasExcludedSegment(".git/config", policy)).toBe(true);
    expect(hasExcludedSegment(".blacksite/corpus.json", policy)).toBe(true);
    expect(hasExcludedSegment("node_modules/react/index.js", policy)).toBe(true);
    expect(hasExcludedSegment(".venv/lib/site.py", policy)).toBe(true);
  });

  it("normalizes windows separators and leading ./ before splitting", () => {
    expect(hasExcludedSegment(".vscode-test\\out\\main.js", DEFAULT)).toBe(true);
    expect(hasExcludedSegment("./.vscode-test/vscode-win32/resources/app/main.js", DEFAULT)).toBe(true);
    expect(hasExcludedSegment("src\\graph\\exclusions.ts", DEFAULT)).toBe(false);
  });

  it("keeps the non-dot literals excluded under every policy", () => {
    for (const policy of [DEFAULT, INVARIANTS_ONLY_POLICY]) {
      expect(hasExcludedSegment("dist/extension.js", policy)).toBe(true);
      expect(hasExcludedSegment("out/webview/graph.js", policy)).toBe(true);
      expect(hasExcludedSegment("coverage/lcov-report/index.html", policy)).toBe(true);
      expect(hasExcludedSegment("app/__pycache__/mod.cpython-311.pyc", policy)).toBe(true);
    }
  });
});

describe("isExcludedSegment", () => {
  it("reports directory segments, not whole paths", () => {
    expect(isExcludedSegment(".vscode-test", DEFAULT)).toBe(true);
    expect(isExcludedSegment("node_modules", DEFAULT)).toBe(true);
    expect(isExcludedSegment("src", DEFAULT)).toBe(false);
    expect(isExcludedSegment("", DEFAULT)).toBe(false);
  });
});

describe("exclusionPolicy", () => {
  it("drops malformed allowlist entries instead of throwing", () => {
    const policy = exclusionPolicy({
      excludeDotDirectories: true,
      dotDirectoryAllowlist: ["", ".", "a/b", ".github"] as string[],
    });
    expect([...policy.allowlist]).toEqual(["github"]);
  });

  it("treats any non-true dot setting as off", () => {
    expect(exclusionPolicy({
      excludeDotDirectories: false,
      dotDirectoryAllowlist: [],
    }).excludeDotDirectories).toBe(false);
  });
});

describe("buildExcludeGlob", () => {
  it("keeps every invariant name", () => {
    const glob = buildExcludeGlob(DEFAULT);
    for (const name of ["node_modules", ".git", ".blacksite", "dist", "out", "build", ".next", "coverage", "__pycache__", ".venv", "venv"]) {
      expect(glob).toContain(name);
    }
  });

  it("prunes high-volume dot-directories at scan time when the rule is on", () => {
    expect(buildExcludeGlob(DEFAULT)).toContain(".vscode-test");
    expect(buildExcludeGlob(INVARIANTS_ONLY_POLICY)).not.toContain(".vscode-test");
  });

  it("stops pruning a dot-directory the user allowlisted", () => {
    const policy = exclusionPolicy({ excludeDotDirectories: true, dotDirectoryAllowlist: [".vscode-test"] });
    expect(buildExcludeGlob(policy)).not.toContain(".vscode-test");
    /* The invariants are unaffected by an allowlist. */
    expect(buildExcludeGlob(policy)).toContain(".blacksite");
  });

  it("emits a single well-formed brace group", () => {
    const glob = buildExcludeGlob(DEFAULT);
    expect(glob.startsWith("**/{")).toBe(true);
    expect(glob.endsWith("}/**")).toBe(true);
    expect(glob).not.toContain(",,");
  });
});

describe("exclusionPolicyKey", () => {
  it("is stable regardless of allowlist ordering", () => {
    const a = exclusionPolicy({ excludeDotDirectories: true, dotDirectoryAllowlist: [".github", ".vscode"] });
    const b = exclusionPolicy({ excludeDotDirectories: true, dotDirectoryAllowlist: [".vscode", "github"] });
    expect(exclusionPolicyKey(a)).toBe(exclusionPolicyKey(b));
  });

  it("changes when the policy changes, so a stale cache is detectable", () => {
    const on = exclusionPolicyKey(DEFAULT);
    const off = exclusionPolicyKey(INVARIANTS_ONLY_POLICY);
    const allowed = exclusionPolicyKey(exclusionPolicy({
      excludeDotDirectories: true,
      dotDirectoryAllowlist: [".github"],
    }));
    expect(new Set([on, off, allowed]).size).toBe(3);
  });
});
