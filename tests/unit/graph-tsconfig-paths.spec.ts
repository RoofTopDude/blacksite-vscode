import { describe, expect, it } from "vitest";
import { aliasCandidates, buildAliasTable, mergeExtendsChain, parseTsconfig, resolveExtends, stripJsonc } from "../../src/graph/tsconfig-paths.js";

describe("stripJsonc", () => {
  it("removes line and block comments and trailing commas", () => {
    const jsonc = `{
      // a line comment
      "compilerOptions": {
        "baseUrl": ".", /* inline */
        "paths": { "@a/*": ["src/*"], },
      },
    }`;
    expect(() => JSON.parse(stripJsonc(jsonc))).not.toThrow();
  });

  it("does not treat // inside a string as a comment", () => {
    const jsonc = `{ "url": "https://example.com" }`;
    expect(JSON.parse(stripJsonc(jsonc))).toEqual({ url: "https://example.com" });
  });
});

describe("parseTsconfig", () => {
  it("resolves baseUrl relative to the config dir", () => {
    const cfg = parseTsconfig("apps/web", `{ "compilerOptions": { "baseUrl": "./src", "paths": { "@/*": ["*"] } } }`);
    expect(cfg).toEqual({ dir: "apps/web", baseUrl: "apps/web/src", paths: { "@/*": ["*"] }, extends: null });
  });

  it("keeps paths without a baseUrl (modern TS)", () => {
    const cfg = parseTsconfig("", `{ "compilerOptions": { "paths": { "~/*": ["lib/*"] } } }`);
    expect(cfg).toEqual({ dir: "", baseUrl: null, paths: { "~/*": ["lib/*"] }, extends: null });
  });

  it("returns null when there is nothing to rewrite a specifier", () => {
    expect(parseTsconfig("", `{ "compilerOptions": { "strict": true } }`)).toBeNull();
    expect(parseTsconfig("", `{ "compilerOptions": {} }`)).toBeNull();
    expect(parseTsconfig("", `not json`)).toBeNull();
  });

  it("captures a top-level extends value even with no own paths/baseUrl", () => {
    const cfg = parseTsconfig("apps/web", `{ "extends": "../../tsconfig.base.json" }`);
    expect(cfg).toEqual({ dir: "apps/web", baseUrl: null, paths: {}, extends: "../../tsconfig.base.json" });
  });
});

describe("resolveExtends", () => {
  const files = new Set(["tsconfig.base.json", "apps/web/tsconfig.json", "apps/web/tsconfig.local.json"]);

  it("resolves a relative extends path, appending .json when omitted", () => {
    expect(resolveExtends("apps/web", "../../tsconfig.base", files)).toBe("tsconfig.base.json");
    expect(resolveExtends("apps/web", "../../tsconfig.base.json", files)).toBe("tsconfig.base.json");
  });

  it("returns null for a bare package specifier (not locally resolvable)", () => {
    expect(resolveExtends("apps/web", "@tsconfig/node18", files)).toBeNull();
  });

  it("returns null when the target doesn't exist", () => {
    expect(resolveExtends("apps/web", "./missing", files)).toBeNull();
  });
});

describe("mergeExtendsChain", () => {
  it("inherits baseUrl/paths from the base when the leaf defines none", () => {
    const base = parseTsconfig("", `{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["apps/*/src"] } } }`)!;
    const leaf = parseTsconfig("apps/web", `{ "extends": "../../tsconfig.base.json" }`)!;
    const merged = mergeExtendsChain([base, leaf]);
    /* Root-level baseUrl "." resolves to "" (the codebase's root-dir convention),
       carried through as-is from the base — it isn't re-resolved against the
       leaf's own directory. */
    expect(merged).toEqual({ dir: "apps/web", baseUrl: "", paths: { "@app/*": ["apps/*/src"] }, extends: null });
  });

  it("lets the leaf's own paths override the base's instead of merging", () => {
    const base = parseTsconfig("", `{ "compilerOptions": { "paths": { "@base/*": ["src/*"] } } }`)!;
    const leaf = parseTsconfig("apps/web", `{ "compilerOptions": { "paths": { "@web/*": ["app/*"] } } }`)!;
    const merged = mergeExtendsChain([base, leaf]);
    expect(merged.paths).toEqual({ "@web/*": ["app/*"] });
  });

  it("Nx/Turborepo-style: a shared base with no per-package paths still produces working aliases end to end", () => {
    /* The exact real-world case that motivated this: every package's own
       tsconfig.json just extends a root base that declares all the aliases. */
    const base = parseTsconfig("", `{ "compilerOptions": {
      "baseUrl": ".",
      "paths": { "@app/*": ["packages/*"] }
    } }`)!;
    const leaf = parseTsconfig("packages/web", `{ "extends": "../../tsconfig.base.json" }`)!;
    const table = buildAliasTable([mergeExtendsChain([base, leaf])]);
    expect(aliasCandidates("packages/web/src/index.ts", "@app/web", table)).toContain("packages/web");
  });
});

describe("aliasCandidates", () => {
  const table = buildAliasTable([
    parseTsconfig("", `{ "compilerOptions": {
      "baseUrl": "src",
      "paths": { "@app/*": ["*"], "@ui": ["../packages/ui/src/index.ts"] }
    } }`)!,
    parseTsconfig("apps/web", `{ "compilerOptions": {
      "paths": { "@web/*": ["app/*"] }
    } }`)!,
  ]);

  it("expands a wildcard against baseUrl", () => {
    expect(aliasCandidates("src/a.ts", "@app/components/Button", table)).toContain("src/components/Button");
  });

  it("expands an exact alias", () => {
    expect(aliasCandidates("src/a.ts", "@ui", table)).toContain("packages/ui/src/index.ts");
  });

  it("offers a baseUrl root-relative candidate for a bare specifier", () => {
    expect(aliasCandidates("src/a.ts", "components/Button", table)).toContain("src/components/Button");
  });

  it("only applies a config whose directory contains the importer", () => {
    /* @web/* belongs to apps/web; a file in src/ must not pick it up. */
    expect(aliasCandidates("src/a.ts", "@web/home", table)).not.toContain("apps/web/app/home");
    expect(aliasCandidates("apps/web/a.ts", "@web/home", table)).toContain("apps/web/app/home");
  });

  it("returns nothing for a relative specifier", () => {
    expect(aliasCandidates("src/a.ts", "./sibling", table)).toEqual([]);
    expect(aliasCandidates("src/a.ts", "../up", table)).toEqual([]);
  });

  it("falls back to a baseUrl probe for an unmatched bare specifier", () => {
    /* baseUrl 'src' makes any bare specifier a root-relative candidate; it
       simply won't probe to a real file, so no false edge results. */
    expect(aliasCandidates("src/a.ts", "nope/x", table)).toEqual(["src/nope/x"]);
  });
});
