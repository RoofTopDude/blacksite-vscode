import { describe, expect, it } from "vitest";
import { buildServiceRelationships, detectServices, type IndexedFileContent } from "../../src/graph/relationship-indexer.js";
import { buildProjectTopology } from "../../src/graph/project-topology.js";

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

  it("recognizes .NET (.csproj/.sln), Gradle, Ruby, and PHP project markers", () => {
    const services = detectServices([
      "services/orders-api/OrdersApi.csproj",
      "services/billing/build.gradle.kts",
      "services/legacy/Gemfile",
      "services/reports/composer.json",
      "Solution.sln",
    ]);

    expect(services.map((service) => service.root).sort()).toEqual([
      ".", "services/billing", "services/legacy", "services/orders-api", "services/reports",
    ]);
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

  it("raises confidence when a path match is corroborated by an independent name match", () => {
    const result = buildServiceRelationships([
      file("services/backend-one/package.json", "{}"),
      file("services/backend-one/src/routes.ts", `app.get("/status", handler);`),
      file("services/caller-a/package.json", "{}"),
      file("services/caller-a/src/client.ts", `fetch("http://localhost:9999/status");`),
      file("services/caller-b/package.json", "{}"),
      file("services/caller-b/src/client.ts", `fetch("http://backend-one:9999/status");`),
    ]);

    const edges = result.edges.filter((edge) => edge.kind === "api");
    const pathOnly = edges.find((edge) => edge.sourcePath === "services/caller-a/src/client.ts");
    const corroborated = edges.find((edge) => edge.sourcePath === "services/caller-b/src/client.ts");
    // Same path match in both cases; caller-b's host also names the target
    // service ("backend-one"), an independent signal path-matching alone
    // doesn't have — that corroboration earns a higher confidence tier.
    expect(pathOnly?.confidence).toBeCloseTo(0.9);
    expect(corroborated?.confidence).toBeCloseTo(0.95);
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

  it("matches a Spring Java controller to a JS/TS fetch consumer (polyglot)", () => {
    const result = buildServiceRelationships([
      file("services/inventory/pom.xml", "<project></project>"),
      file("services/inventory/src/main/java/com/acme/inventory/StockController.java", `
@RestController
public class StockController {
  @GetMapping("/inventory/{sku}")
  public Stock getStock(@PathVariable String sku) { return null; }
}
`),
      file("services/storefront/package.json", "{}"),
      file("services/storefront/src/api.ts", `fetch("http://inventory:8080/inventory/ABC123");`),
    ]);

    expect(result.edges.find((edge) => edge.kind === "api")).toMatchObject({
      kind: "api",
      serviceFrom: "services/storefront",
      serviceTo: "services/inventory",
      label: "GET /inventory/{sku}",
    });
  });

  it("matches a Spring @RequestMapping(method=...) to a RestTemplate consumer", () => {
    const result = buildServiceRelationships([
      file("services/accounts/pom.xml", "<project></project>"),
      file("services/accounts/src/main/java/AccountController.java", `
@RequestMapping(value = "/accounts/{id}", method = RequestMethod.GET)
public Account getAccount(String id) { return null; }
`),
      file("services/ledger/pom.xml", "<project></project>"),
      file("services/ledger/src/main/java/AccountClient.java", `
Account a = restTemplate.getForObject("http://accounts/accounts/42", Account.class);
`),
    ]);

    expect(result.edges.find((edge) => edge.kind === "api")).toMatchObject({
      kind: "api",
      serviceFrom: "services/ledger",
      serviceTo: "services/accounts",
      label: "GET /accounts/{id}",
    });
  });

  it("matches Go router idioms (Gin/chi/Echo-style) to a stdlib http client", () => {
    const result = buildServiceRelationships([
      file("services/pricing/go.mod", "module github.com/acme/pricing"),
      file("services/pricing/main.go", `
func main() {
	r := gin.Default()
	r.GET("/prices/:sku", getPriceHandler)
	r.Run()
}
`),
      file("services/checkout/go.mod", "module github.com/acme/checkout"),
      file("services/checkout/client.go", `
func fetchPrice(sku string) {
	http.Get("http://pricing:8080/prices/ABC123")
}
`),
    ]);

    expect(result.edges.find((edge) => edge.kind === "api")).toMatchObject({
      kind: "api",
      serviceFrom: "services/checkout",
      serviceTo: "services/pricing",
      label: "GET /prices/:sku",
    });
  });

  it("matches a method-agnostic net/http HandleFunc registration by path", () => {
    const result = buildServiceRelationships([
      file("services/notify/go.mod", "module github.com/acme/notify"),
      file("services/notify/main.go", `http.HandleFunc("/notify/send", sendHandler)`),
      file("services/worker/go.mod", "module github.com/acme/worker"),
      file("services/worker/send.go", `http.NewRequest("POST", "http://notify/notify/send", body)`),
    ]);

    expect(result.edges.find((edge) => edge.kind === "api")).toMatchObject({
      kind: "api",
      serviceFrom: "services/worker",
      serviceTo: "services/notify",
    });
  });

  it("matches ASP.NET Core [HttpGet] attributes to an HttpClient consumer", () => {
    const result = buildServiceRelationships([
      file("services/orders-api/OrdersApi.csproj", "<Project></Project>"),
      file("services/orders-api/Controllers/OrdersController.cs", `
[ApiController]
public class OrdersController : ControllerBase {
  [HttpGet("orders/{id}")]
  public IActionResult GetOrder(int id) => Ok();
}
`),
      file("services/billing/Billing.csproj", "<Project></Project>"),
      file("services/billing/OrdersClient.cs", `
public async Task<Order> GetOrder(int id) => await httpClient.GetAsync("http://orders-api/orders/" + id);
`),
    ]);

    expect(result.edges.find((edge) => edge.kind === "api")).toMatchObject({
      kind: "api",
      serviceFrom: "services/billing",
      serviceTo: "services/orders-api",
    });
  });

  it("expands ASP.NET [controller] tokens while composing controller-level routes", () => {
    const result = buildServiceRelationships([
      file("services/orders-api/OrdersApi.csproj", "<Project></Project>"),
      file("services/orders-api/Controllers/OrdersController.cs", `
[Route("api/[controller]")]
public class OrdersController : ControllerBase {
  [HttpGet]
  public IActionResult List() => Ok();
}
`),
      file("services/billing/Billing.csproj", "<Project></Project>"),
      file("services/billing/OrdersClient.cs", `
public async Task<Orders> List() => await httpClient.GetAsync("http://orders-api/api/orders");
`),
    ]);

    const apiEdge = result.edges.find((edge) => edge.kind === "api");
    expect(apiEdge).toMatchObject({ kind: "api", serviceFrom: "services/billing", serviceTo: "services/orders-api" });
    /* The route's label carries the literal "[controller]" text (the label is
       always the provider's own declared path) — only the *matching* is
       template-aware, so a real request path like "api/orders" still lines up. */
    expect(apiEdge?.label).toContain("api/Orders");
    expect(apiEdge?.label).not.toContain("[controller]");
  });

  it("composes ASP.NET controller + action routes and expands [action] tokens", () => {
    const result = buildServiceRelationships([
      file("services/orders-api/OrdersApi.csproj", "<Project></Project>"),
      file("services/orders-api/Controllers/OrdersController.cs", `
[Route("api/[controller]")]
public class OrdersController : ControllerBase {
  [HttpGet("[action]/{id}")]
  public IActionResult GetOrder(int id) => Ok();
}
`),
      file("services/billing/Billing.csproj", "<Project></Project>"),
      file("services/billing/OrdersClient.cs", `
public async Task<Order> GetOrder(int id) => await httpClient.GetAsync("http://orders-api/api/orders/getorder/42");
`),
    ]);

    const apiEdge = result.edges.find((edge) => edge.kind === "api");
    expect(apiEdge).toMatchObject({ kind: "api", serviceFrom: "services/billing", serviceTo: "services/orders-api" });
    expect(apiEdge?.label).toContain("GetOrder");
    expect(apiEdge?.label).not.toContain("[action]");
  });

  it("matches HttpClientFactory named-client BaseAddress patterns", () => {
    const result = buildServiceRelationships([
      file("services/orders-api/OrdersApi.csproj", "<Project></Project>"),
      file("services/orders-api/Controllers/OrdersController.cs", `
[Route("api/[controller]")]
public class OrdersController : ControllerBase {
  [HttpGet("{id}")]
  public IActionResult GetOrder(int id) => Ok();
}
`),
      file("services/billing/Billing.csproj", "<Project></Project>"),
      file("services/billing/Program.cs", `
services.AddHttpClient("orders", client => client.BaseAddress = new Uri("http://orders-api/api/"));
var client = httpClientFactory.CreateClient("orders");
await client.GetAsync("orders/42");
`),
    ]);

    expect(result.edges.find((edge) => edge.kind === "api")).toMatchObject({
      kind: "api",
      serviceFrom: "services/billing",
      serviceTo: "services/orders-api",
    });
  });

  it("matches typed HttpClient registrations with relative calls", () => {
    const result = buildServiceRelationships([
      file("services/orders-api/OrdersApi.csproj", "<Project></Project>"),
      file("services/orders-api/Controllers/OrdersController.cs", `
[Route("api/[controller]")]
public class OrdersController : ControllerBase {
  [HttpGet("{id}")]
  public IActionResult GetOrder(int id) => Ok();
}
`),
      file("services/billing/Billing.csproj", "<Project></Project>"),
      file("services/billing/Program.cs", `
services.AddHttpClient<OrdersClient>(client => client.BaseAddress = new Uri("http://orders-api/api/"));
`),
      file("services/billing/OrdersClient.cs", `
public class OrdersClient {
  private readonly HttpClient _httpClient;
  public OrdersClient(HttpClient httpClient) { _httpClient = httpClient; }
  public Task<HttpResponseMessage> Get(int id) => _httpClient.GetAsync("orders/42");
}
`),
    ]);

    expect(result.edges.find((edge) => edge.kind === "api")).toMatchObject({
      kind: "api",
      serviceFrom: "services/billing",
      serviceTo: "services/orders-api",
    });
  });

  it("defaults a RestSharp request with no explicit Method to GET, not any-method", () => {
    const result = buildServiceRelationships([
      file("services/orders-api/OrdersApi.csproj", "<Project></Project>"),
      file("services/orders-api/Controllers/OrdersController.cs", `
[HttpGet("orders/{id}")]
public IActionResult Get(int id) => Ok();

[HttpDelete("orders/{id}")]
public IActionResult Delete(int id) => Ok();
`),
      file("services/billing/Billing.csproj", "<Project></Project>"),
      file("services/billing/OrdersClient.cs", `
var request = new RestRequest("orders/42");
client.Execute(request);
`),
    ]);

    /* An implicit-GET RestRequest must path-match the GET route only —
       treating the missing Method as "matches any method" (the bug) would
       also wrongly connect it to the DELETE route at the same path. */
    const apiEdges = result.edges.filter((edge) => edge.kind === "api" && edge.serviceFrom === "services/billing");
    expect(apiEdges).toHaveLength(1);
    expect(apiEdges[0]?.label).toContain("GET");
  });

  it("gates language-specific route detection by file extension", () => {
    /* A .ts file containing Go-shaped and Java-shaped route text must not be
       scanned by the Go/Java-only detectors — only the always-on JS/decorator
       patterns apply outside their own language. */
    const result = buildServiceRelationships([
      file("services/weird/package.json", "{}"),
      file("services/weird/notes.ts", `
        // r.GET("/should/not/match", h) -- Go-shaped text in a .ts file
        // @GetMapping("/should/not/match") -- Java-shaped text in a .ts file
      `),
    ]);
    expect(result.edges.filter((edge) => edge.kind === "api")).toEqual([]);
  });

  it("matches a gRPC Stub-suffixed call site to a proto service declaration", () => {
    const result = buildServiceRelationships([
      file("services/identity/package.json", "{}"),
      file("services/identity/protos/auth.proto", "service AuthService { rpc Login (LoginRequest) returns (LoginReply); }"),
      file("services/admin/pom.xml", "<project></project>"),
      file("services/admin/src/main/java/AdminService.java", "authStub.Login(request);"),
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

  it("links two .NET services that persist the same EF entity as a shared-data relationship", () => {
    const result = buildServiceRelationships([
      file("services/orders-api/OrdersApi.csproj", "<Project></Project>"),
      file("services/orders-api/Data/OrdersContext.cs", `namespace Orders.Data; public class OrdersContext : DbContext { public DbSet<Ticket> Tickets { get; set; } }`),
      file("services/tickets-api/TicketsApi.csproj", "<Project></Project>"),
      file("services/tickets-api/Data/TicketsContext.cs", `namespace Tickets.Data; public class TicketsContext : DbContext { public DbSet<Ticket> Tickets { get; set; } }`),
    ]);

    const ticketEdges = result.edges.filter((edge) => edge.kind === "data" && edge.label === "Ticket");
    expect(ticketEdges.length).toBeGreaterThan(0);
    const roots = new Set(ticketEdges.flatMap((edge) => [edge.serviceFrom, edge.serviceTo]));
    expect(roots).toEqual(new Set(["services/orders-api", "services/tickets-api"]));
  });

  it("maps EF [Table] attributes to a shared-data relationship by table name", () => {
    const result = buildServiceRelationships([
      file("services/a/A.csproj", "<Project></Project>"),
      file("services/a/Entities/Invoice.cs", `namespace A; [Table("Invoices")] public class Invoice {}`),
      file("services/b/B.csproj", "<Project></Project>"),
      file("services/b/Entities/Invoice.cs", `namespace B; [Table("Invoices")] public class Invoice {}`),
    ]);
    expect(result.edges.some((edge) => edge.kind === "data" && edge.label === "Invoices")).toBe(true);
  });

  it("uses project topology to break ambiguous cross-service path matches", () => {
    const files = [
      file("package.json", JSON.stringify({ private: true, workspaces: ["apps/*", "services/*"] })),
      file("apps/web/package.json", JSON.stringify({ name: "@acme/web", dependencies: { "@acme/orders": "workspace:*" } })),
      file("services/orders/package.json", JSON.stringify({ name: "@acme/orders" })),
      file("services/orders/src/routes.ts", `app.get("/status", handler);`),
      file("services/users/package.json", JSON.stringify({ name: "@acme/users" })),
      file("services/users/src/routes.ts", `app.get("/status", handler);`),
      file("apps/web/src/api.ts", `fetch("http://localhost:8080/status");`),
    ];
    const topology = buildProjectTopology(files);
    const result = buildServiceRelationships(files, 5000, topology);

    const apiEdges = result.edges.filter((edge) => edge.kind === "api");
    expect(apiEdges).toHaveLength(1);
    expect(apiEdges[0]).toMatchObject({
      kind: "api",
      serviceFrom: "apps/web",
      serviceTo: "services/orders",
    });
  });

  it("matches the whole corpus without a signal-count truncation cap", () => {
    /* Well past the old MAX_SIGNALS_PER_KIND=3000 ceiling: every consumer must
       still be matched (truth is preserved) and, since matching is now a keyed
       join rather than an O(providers×consumers) scan, it must not truncate. */
    const files: IndexedFileContent[] = [
      file("services/api/package.json", "{}"),
      file("services/api/routes.ts", `app.get("/data", handler);`),
      file("services/web/package.json", "{}"),
    ];
    for (let i = 0; i < 3001; i += 1) {
      files.push(file(`services/web/c${i}.ts`, `fetch("http://api/data");`));
    }
    const result = buildServiceRelationships(files, 100_000);
    const apiEdges = result.edges.filter((edge) => edge.kind === "api");
    expect(apiEdges).toHaveLength(3001);
    expect(result.truncated).toBe(false);
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
