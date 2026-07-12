import { describe, expect, it } from "vitest";
import { isGraphIndexablePath, isGraphManifestPath } from "../../src/graph/file-discovery.js";

describe("graph file discovery", () => {
  it("includes standalone API contracts that feed relationship analysis", () => {
    for (const path of ["api/auth.proto", "schema/catalog.graphql", "schema/catalog.graphqls", "schema/catalog.gql"]) {
      expect(isGraphIndexablePath(path), path).toBe(true);
    }
  });

  it("includes extensionless and variable-name project/service manifests", () => {
    for (const path of [
      "services/web/Dockerfile",
      "services/web/Dockerfile.dev",
      "services/legacy/Gemfile",
      "services/orders/Orders.csproj",
      "services/lua/acme.rockspec",
      "services/scala/build.sbt",
      "services/elixir/mix.exs",
      "services/dart/pubspec.yaml",
    ]) {
      expect(isGraphManifestPath(path), path).toBe(true);
      expect(isGraphIndexablePath(path), path).toBe(true);
    }
  });

  it("includes build orchestration and Python dependency manifests", () => {
    for (const path of [
      "Makefile",
      "services/api/Makefile",
      "config/build.mk",
      "requirements.txt",
      "requirements-dev.txt",
      "services/api/requirements.in",
    ]) {
      expect(isGraphIndexablePath(path), path).toBe(true);
    }
  });

  it("recognizes the built-in language files without admitting arbitrary assets", () => {
    for (const path of ["Main.kt", "App.scala", "main.dart", "init.lua", "router.ex", "setup.sh"]) {
      expect(isGraphIndexablePath(path), path).toBe(true);
    }
    expect(isGraphIndexablePath("assets/archive.zip")).toBe(false);
    expect(isGraphIndexablePath("tmp/runtime.bin")).toBe(false);
  });
});
