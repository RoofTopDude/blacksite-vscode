import { describe, expect, it } from "vitest";
import { recommendationForLanguage } from "../../src/graph/language-support.js";

describe("recommendationForLanguage", () => {
  it("recommends an LSP extension for every previously-gapped language", () => {
    /* These langs are tracked (SOURCE_LANGS includes them, so a workspace with
       Dart/Kotlin/Scala/Lua/Elixir files reports their file counts) but used to
       have no RECOMMENDATIONS entry — meaning the "Light up more relationships"
       onboarding panel could never offer an install button for them. */
    expect(recommendationForLanguage("dart")).toBe("Dart-Code.dart-code");
    expect(recommendationForLanguage("kt")).toBe("fwcd.kotlin");
    expect(recommendationForLanguage("kts")).toBe("fwcd.kotlin");
    expect(recommendationForLanguage("scala")).toBe("scalameta.metals");
    expect(recommendationForLanguage("sc")).toBe("scalameta.metals");
    expect(recommendationForLanguage("lua")).toBe("sumneko.lua");
    expect(recommendationForLanguage("ex")).toBe("JakeBecker.elixir-ls");
    expect(recommendationForLanguage("exs")).toBe("JakeBecker.elixir-ls");
  });

  it("still recommends extensions for the previously-covered languages", () => {
    expect(recommendationForLanguage("py")).toBe("ms-python.python");
    expect(recommendationForLanguage("cs")).toBe("ms-dotnettools.csharp");
    expect(recommendationForLanguage("php")).toBe("bmewburn.vscode-intelephense-client");
  });

  it("returns undefined for a language with no known extension", () => {
    expect(recommendationForLanguage("zig")).toBeUndefined();
  });
});
