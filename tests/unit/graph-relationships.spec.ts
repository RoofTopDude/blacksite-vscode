import { describe, expect, it } from "vitest";
import { buildServiceRelationships, detectServices, type IndexedFileContent } from "../../src/graph/relationship-indexer.js";

function file(path: string, content: string): IndexedFileContent {
  return { path, content };
}

describe("detectServices", () => {
  it("discovers monorepo service roots from common project markers", () => {
    const services = detectServices([
      "services/users/package.json",
      "services/billing/pyproject.toml",
      "libs/common/src/index.ts",
    ]);

    expect(services.map((service) => service.root).sort()).toEqual(["services/billing", "services/users"]);
    expect(services.find((service) => service.root === "services/users")?.markers).toContain("package.json");
  });
});

describe("buildServiceRelationships", () => {
  it("matches an OpenAPI provider to a fetch consumer by method and path", () => {
    const result = buildServiceRelationships([
      file("services/users/openapi.yaml", `
openapi: 3.0.0
paths:
  /users/{id}:
    get:
      operationId: getUser
`),
      file("services/users/package.json", "{}"),
      file("services/web/package.json", "{}"),
      file("services/web/src/client.ts", `export async function load(id: string) { return fetch("http://users:3000/users/" + id); }`),
    ]);

    expect(result.truncated).toBe(false);
    expect(result.edges.filter((edge) => edge.kind === "api")).toEqual([
      expect.objectContaining({
        kind: "api",
        serviceFrom: "services/web",
        serviceTo: "services/users",
        label: "GET /users/{id}",
        sourcePath: "services/web/src/client.ts",
        targetPath: "services/users/openapi.yaml",
      }),
    ]);
  });

  it("matches pragmatic route declarations and HTTP clients across services", () => {
    const result = buildServiceRelationships([
      file("apps/orders/package.json", "{}"),
      file("apps/orders/src/routes.ts", `router.post("/orders/:id/cancel", handler);`),
      file("apps/gateway/package.json", "{}"),
      file("apps/gateway/src/api.ts", `axios.post(process.env.ORDERS_SERVICE_URL + "/orders/123/cancel");`),
    ]);
    const apiEdge = result.edges.find((edge) => edge.kind === "api");

    expect(apiEdge).toMatchObject({
      kind: "api",
      serviceFrom: "apps/gateway",
      serviceTo: "apps/orders",
      label: "POST /orders/:id/cancel",
    });
    expect(apiEdge?.evidence?.join(" ")).toContain("ORDERS_SERVICE_URL");
  });

  it("matches GraphQL operations to schema fields", () => {
    const result = buildServiceRelationships([
      file("services/catalog/package.json", "{}"),
      file("services/catalog/schema.graphql", "type Query { product(id: ID!): Product }"),
      file("services/storefront/package.json", "{}"),
      file("services/storefront/src/query.ts", "const q = `query ProductPage { product(id: \"1\") { id } }`;"),
    ]);

    expect(result.edges.find((edge) => edge.kind === "api")).toMatchObject({
      kind: "api",
      serviceFrom: "services/storefront",
      serviceTo: "services/catalog",
      label: "Query.product",
    });
  });

  it("matches proto RPC client references to service declarations", () => {
    const result = buildServiceRelationships([
      file("services/identity/package.json", "{}"),
      file("services/identity/protos/auth.proto", "service AuthService { rpc Login (LoginRequest) returns (LoginReply); }"),
      file("services/admin/package.json", "{}"),
      file("services/admin/src/auth.ts", "client.Login({ username });"),
    ]);

    expect(result.edges.find((edge) => edge.kind === "api")).toMatchObject({
      kind: "api",
      serviceFrom: "services/admin",
      serviceTo: "services/identity",
      label: "AuthService.Login",
    });
  });

  it("tracks config, event, and data relationships as separate layers", () => {
    const result = buildServiceRelationships([
      file("services/users/package.json", "{}"),
      file("services/users/src/events.ts", `bus.publish("user.created", payload); db.query("insert into users values (?)");`),
      file("services/search/package.json", "{}"),
      file("services/search/src/index.ts", `process.env.USERS_SERVICE_URL; bus.subscribe("user.created", handler); db.query("select * from users");`),
    ]);

    expect(result.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "config", serviceFrom: "services/search", serviceTo: "services/users", label: "USERS_SERVICE_URL" }),
      expect.objectContaining({ kind: "event", serviceFrom: "services/users", serviceTo: "services/search", label: "user.created" }),
      expect.objectContaining({ kind: "data", serviceFrom: "services/users", serviceTo: "services/search", label: "users" }),
    ]));
  });

  it("applies the relationship edge cap without failing indexing", () => {
    const files: IndexedFileContent[] = [
      file("services/users/package.json", "{}"),
      file("services/users/src/routes.ts", `app.get("/users", handler);`),
    ];
    for (let i = 0; i < 4; i += 1) {
      files.push(file(`services/client${i}/package.json`, "{}"));
      files.push(file(`services/client${i}/src/api.ts`, `fetch("http://users/users");`));
    }

    const result = buildServiceRelationships(files, 2);
    expect(result.edges).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
