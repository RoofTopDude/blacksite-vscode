import { describe, expect, it } from "vitest";
import { buildProjectTopology, owningProjectForPath } from "../../src/graph/project-topology.js";

function file(path: string, content: string): { path: string; content: string } {
  return { path, content };
}

describe("buildProjectTopology", () => {
  it("parses .sln membership and csproj ProjectReference edges", () => {
    const topology = buildProjectTopology([
      file("Relay.sln", `
Project("{GUID}") = "OrdersApi", "services/OrdersApi/OrdersApi.csproj", "{A}"
Project("{GUID}") = "Shared", "services/Shared/Shared.csproj", "{B}"
`),
      file("services/OrdersApi/OrdersApi.csproj", `
<Project>
  <PropertyGroup><AssemblyName>OrdersApi</AssemblyName></PropertyGroup>
  <ItemGroup><ProjectReference Include="../Shared/Shared.csproj" /></ItemGroup>
</Project>
`),
      file("services/Shared/Shared.csproj", `<Project><PropertyGroup><AssemblyName>Shared</AssemblyName></PropertyGroup></Project>`),
    ]);

    expect(topology.projects.map((project) => project.root)).toEqual(["services/OrdersApi", "services/Shared"]);
    expect(topology.projects.find((project) => project.root === "services/OrdersApi")?.containerRoot).toBe(".");
    expect(topology.references).toContainEqual(expect.objectContaining({
      from: "services/OrdersApi",
      to: "services/Shared",
      kind: "project",
    }));
    expect(owningProjectForPath(topology, "services/OrdersApi/Controllers/OrdersController.cs")?.root).toBe("services/OrdersApi");
  });

  it("parses npm workspaces and local package dependency edges", () => {
    const topology = buildProjectTopology([
      file("package.json", JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] })),
      file("apps/web/package.json", JSON.stringify({ name: "@acme/web", dependencies: { "@acme/orders": "workspace:*" } })),
      file("packages/orders/package.json", JSON.stringify({ name: "@acme/orders" })),
    ]);

    expect(topology.projects.find((project) => project.root === "apps/web")?.containerRoot).toBe(".");
    expect(topology.projects.find((project) => project.root === "packages/orders")?.containerRoot).toBe(".");
    expect(topology.references).toContainEqual(expect.objectContaining({
      from: "apps/web",
      to: "packages/orders",
      kind: "package",
    }));
  });

  it("parses Maven multi-module roots and local inter-module dependencies", () => {
    const topology = buildProjectTopology([
      file("pom.xml", `
<project>
  <groupId>com.acme</groupId>
  <artifactId>root</artifactId>
  <modules>
    <module>services/orders</module>
    <module>services/web</module>
  </modules>
</project>
`),
      file("services/orders/pom.xml", `
<project>
  <parent><groupId>com.acme</groupId><artifactId>root</artifactId></parent>
  <artifactId>orders</artifactId>
</project>
`),
      file("services/web/pom.xml", `
<project>
  <parent><groupId>com.acme</groupId><artifactId>root</artifactId></parent>
  <artifactId>web</artifactId>
  <dependencies>
    <dependency><groupId>com.acme</groupId><artifactId>orders</artifactId></dependency>
  </dependencies>
</project>
`),
    ]);

    expect(topology.projects.find((project) => project.root === "services/orders")?.containerRoot).toBe(".");
    expect(topology.projects.find((project) => project.root === "services/web")?.containerRoot).toBe(".");
    expect(topology.references).toContainEqual(expect.objectContaining({
      from: "services/web",
      to: "services/orders",
      kind: "module",
    }));
  });

  it("parses Gradle multi-project includes and project() dependencies", () => {
    const topology = buildProjectTopology([
      file("settings.gradle.kts", `include(":app", ":shared")`),
      file("app/build.gradle.kts", `dependencies { implementation(project(":shared")) }`),
      file("shared/build.gradle.kts", `plugins { java }`),
    ]);

    expect(topology.projects.find((project) => project.root === "app")?.containerRoot).toBe(".");
    expect(topology.projects.find((project) => project.root === "shared")?.containerRoot).toBe(".");
    expect(topology.references).toContainEqual(expect.objectContaining({
      from: "app",
      to: "shared",
      kind: "build",
    }));
  });

  it("parses go.work membership and local go.mod relationships", () => {
    const topology = buildProjectTopology([
      file("go.work", `
go 1.22
use (
  ./services/orders
  ./libs/shared
)
`),
      file("services/orders/go.mod", `
module github.com/acme/orders

require github.com/acme/shared v0.0.0
`),
      file("libs/shared/go.mod", `module github.com/acme/shared`),
    ]);

    expect(topology.projects.find((project) => project.root === "services/orders")?.containerRoot).toBe(".");
    expect(topology.projects.find((project) => project.root === "libs/shared")?.containerRoot).toBe(".");
    expect(topology.references).toContainEqual(expect.objectContaining({
      from: "services/orders",
      to: "libs/shared",
      kind: "module",
    }));
  });
});
