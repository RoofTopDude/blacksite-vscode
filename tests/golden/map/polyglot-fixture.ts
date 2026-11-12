/* A small polyglot workspace that exercises every layer of the Codebase Map index at once, for the
   golden tests in map-harness.ts:

   - a TypeScript workspace monorepo (workspace packages with dist→src twins, a declared-but-unused
     dependency, tsconfig `paths`);
   - a Python package with __init__ re-exports and a src layout from pyproject;
   - a Go module with an internal package;
   - a C# project (namespaces, `using`, an ASP.NET controller);
   - docker-compose services that call each other's HTTP routes, an env file resolving one host;
   - Markdown linking to code, a test file (kept out of the service lens), an orphan, a dot
     directory (hidden by policy) and a git-ignored tree;
   - git history with two co-changing pairs, one of them across codebases with no import behind it.

   Contents live here as strings rather than as checked-in files on purpose: with core.autocrlf a
   checkout can rewrite line endings, which changes file sizes, and sizes are part of the golden. */

export const POLYGLOT_FILES: Readonly<Record<string, string>> = {
  ".gitignore": ".blacksite/\nnode_modules/\n",
  ".github/workflows/ci.yml": "name: ci\non: push\njobs: {}\n",
  "node_modules/left-pad/index.js": "module.exports = (s) => s;\n",
  "README.md": "# Poly\n\nSee [the architecture notes](docs/architecture.md).\n",
  "docs/architecture.md": [
    "# Architecture",
    "",
    "The web app starts in `apps/web/src/main.ts` and talks to the orders service",
    "([app.py](../services/orders/src/orders/app.py)), which looks up owners in",
    "`services/users/main.go`. Invoices come from `services/billing/Controllers/InvoicesController.cs`.",
    "",
  ].join("\n"),
  "docker-compose.yml": [
    "services:",
    "  web:",
    "    build: ./apps/web",
    "    ports:",
    "      - \"3001:3001\"",
    "  orders:",
    "    build: ./services/orders",
    "    ports:",
    "      - \"8080:8080\"",
    "    environment:",
    "      USERS_URL: http://users:3000",
    "  users:",
    "    build: ./services/users",
    "    ports:",
    "      - \"3000:3000\"",
    "  billing:",
    "    build: ./services/billing",
    "    ports:",
    "      - \"5000:5000\"",
    "",
  ].join("\n"),
  "package.json": JSON.stringify({ name: "poly", private: true, workspaces: ["apps/*", "packages/*"] }, null, 2),
  "scripts/orphan.ts": "export const orphan = 1;\n",
  "tools/version.ts": "export const version = \"1.0.0\";\n",

  /* ---- TypeScript workspace ------------------------------------------------------------- */
  "apps/web/package.json": JSON.stringify({
    name: "@poly/web",
    dependencies: { "@poly/shared": "workspace:*", "@poly/unused": "workspace:*", axios: "^1.7.0" },
  }, null, 2),
  "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@web/*": ["src/*"] } } }, null, 2),
  "apps/web/src/main.ts": [
    "import { formatTotal } from \"@poly/shared\";",
    "import { createOrder } from \"@web/api/client\";",
    "import { render } from \"./ui/render\";",
    "",
    "export function start(): void {",
    "  render(formatTotal(createOrder));",
    "}",
    "",
  ].join("\n"),
  "apps/web/src/ui/render.ts": [
    "import { slugify } from \"@poly/shared/format\";",
    "",
    "export function render(value: unknown): string {",
    "  return slugify(String(value));",
    "}",
    "",
  ].join("\n"),
  "apps/web/src/api/client.ts": [
    "import axios from \"axios\";",
    "import { formatDate } from \"@poly/shared/format\";",
    "",
    "const ORDERS = \"http://localhost:8080\";",
    "",
    "export async function createOrder(total: number) {",
    "  const response = await fetch(`${ORDERS}/api/orders`, { method: \"POST\", body: JSON.stringify({ total, at: formatDate(new Date()) }) });",
    "  return response.json();",
    "}",
    "",
    "export async function invoice(id: string) {",
    "  return axios.get(`http://localhost:5000/api/invoices/${id}`);",
    "}",
    "",
  ].join("\n"),
  "apps/web/src/main.test.ts": "import { start } from \"./main\";\n\nstart();\n",
  "packages/shared/package.json": JSON.stringify({
    name: "@poly/shared",
    main: "dist/index.js",
    types: "dist/index.d.ts",
    exports: { ".": "./dist/index.js", "./format": "./dist/format.js" },
  }, null, 2),
  "packages/shared/src/index.ts": [
    "export { formatDate, slugify } from \"./format\";",
    "",
    "export function formatTotal(value: unknown): string {",
    "  return String(value);",
    "}",
    "",
  ].join("\n"),
  "packages/shared/src/format.ts": [
    "export const formatDate = (d: Date): string => d.toISOString();",
    "export const slugify = (s: string): string => s.toLowerCase().replace(/\\s+/g, \"-\");",
    "",
  ].join("\n"),
  "packages/unused/package.json": JSON.stringify({ name: "@poly/unused", main: "src/index.ts" }, null, 2),
  "packages/unused/src/index.ts": "export const unused = true;\n",

  /* ---- Python service ------------------------------------------------------------------- */
  "services/orders/pyproject.toml": "[project]\nname = \"orders\"\n\n[tool.setuptools.packages.find]\nwhere = [\"src\"]\n",
  "services/orders/.env": "USERS_URL=http://users:3000\n",
  "services/orders/src/orders/__init__.py": "from .models import Order\nfrom .app import app\n",
  "services/orders/src/orders/models.py": "class Order:\n    def __init__(self, total):\n        self.total = total\n",
  "services/orders/src/orders/app.py": [
    "import os",
    "import requests",
    "from flask import Flask, request",
    "from orders.models import Order",
    "",
    "app = Flask(__name__)",
    "USERS_URL = os.environ.get(\"USERS_URL\", \"http://users:3000\")",
    "",
    "",
    "@app.route(\"/api/orders\", methods=[\"POST\"])",
    "def create_order():",
    "    order = Order(request.json[\"total\"])",
    "    owner = requests.get(f\"{USERS_URL}/api/users/42\")",
    "    return {\"total\": order.total, \"owner\": owner.json()}",
    "",
    "",
    "@app.route(\"/api/orders/<order_id>\", methods=[\"GET\"])",
    "def get_order(order_id):",
    "    return {\"id\": order_id}",
    "",
  ].join("\n"),

  /* ---- Go service ----------------------------------------------------------------------- */
  "services/users/go.mod": "module example.com/users\n\ngo 1.22\n",
  "services/users/main.go": [
    "package main",
    "",
    "import (",
    "\t\"net/http\"",
    "",
    "\t\"example.com/users/internal/store\"",
    "\t\"github.com/go-chi/chi/v5\"",
    ")",
    "",
    "func main() {",
    "\tr := chi.NewRouter()",
    "\tr.Get(\"/api/users/{id}\", func(w http.ResponseWriter, req *http.Request) {",
    "\t\tstore.Find(chi.URLParam(req, \"id\"))",
    "\t\thttp.Get(\"http://orders:8080/api/orders/\" + chi.URLParam(req, \"id\"))",
    "\t})",
    "\thttp.ListenAndServe(\":3000\", r)",
    "}",
    "",
  ].join("\n"),
  "services/users/internal/store/store.go": "package store\n\nfunc Find(id string) string { return id }\n",

  /* ---- C# service ----------------------------------------------------------------------- */
  "services/billing/Billing.csproj": "<Project Sdk=\"Microsoft.NET.Sdk.Web\">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n",
  "services/billing/Program.cs": [
    "using Billing.Models;",
    "",
    "var builder = WebApplication.CreateBuilder(args);",
    "var app = builder.Build();",
    "app.MapControllers();",
    "app.Run();",
    "",
  ].join("\n"),
  "services/billing/Controllers/InvoicesController.cs": [
    "using Microsoft.AspNetCore.Mvc;",
    "using Billing.Models;",
    "",
    "namespace Billing.Controllers",
    "{",
    "    [ApiController]",
    "    [Route(\"api/invoices\")]",
    "    public class InvoicesController : ControllerBase",
    "    {",
    "        [HttpGet(\"{id}\")]",
    "        public Invoice Get(string id) => new Invoice(id);",
    "    }",
    "}",
    "",
  ].join("\n"),
  "services/billing/Models/Invoice.cs": [
    "namespace Billing.Models",
    "{",
    "    public class Invoice",
    "    {",
    "        public Invoice(string id) { Id = id; }",
    "        public string Id { get; }",
    "    }",
    "}",
    "",
  ].join("\n"),
};

/** Commits after the initial one. Each appends a line to the files it names, so three pairs keep
    changing together: orders' app.py with users' main.go (across codebases, explained by the API
    calls between them), the web client with the shared formatter (explained by an import), and
    the release version with billing's invoice model (nothing links them — hidden coupling). */
export const POLYGLOT_HISTORY: ReadonlyArray<{ message: string; touch: readonly string[] }> = [
  { message: "release: invoice schema 2", touch: ["tools/version.ts", "services/billing/Models/Invoice.cs"] },
  { message: "release: invoice schema 3", touch: ["tools/version.ts", "services/billing/Models/Invoice.cs"] },
  { message: "release: invoice schema 4", touch: ["tools/version.ts", "services/billing/Models/Invoice.cs"] },
  { message: "orders and users: owner lookup", touch: ["services/orders/src/orders/app.py", "services/users/main.go"] },
  { message: "orders and users: ids", touch: ["services/orders/src/orders/app.py", "services/users/main.go"] },
  { message: "web: dates", touch: ["apps/web/src/api/client.ts", "packages/shared/src/format.ts"] },
  { message: "orders and users: errors", touch: ["services/orders/src/orders/app.py", "services/users/main.go"] },
  { message: "web: totals", touch: ["apps/web/src/api/client.ts", "packages/shared/src/format.ts"] },
  { message: "orders and users: retries", touch: ["services/orders/src/orders/app.py", "services/users/main.go"] },
  { message: "web: currency", touch: ["apps/web/src/api/client.ts", "packages/shared/src/format.ts"] },
];
