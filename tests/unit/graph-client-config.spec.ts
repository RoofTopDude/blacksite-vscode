import { describe, expect, it } from "vitest";
import {
  buildClientConfigIndex,
  isClientConfigPath,
  lookupHostRoot,
  resolveProxyHost,
  urlHost,
} from "../../src/graph/client-config.js";

function file(path: string, content: string): { path: string; content: string } {
  return { path, content };
}

const rootOf = (path: string): string => path.split("/").slice(0, 2).join("/");

describe("isClientConfigPath", () => {
  it("admits .env variants and nginx-style conf files, not arbitrary files", () => {
    expect(isClientConfigPath(".env")).toBe(true);
    expect(isClientConfigPath("services/web/.env.production")).toBe(true);
    expect(isClientConfigPath("services/web/nginx.conf")).toBe(true);
    expect(isClientConfigPath("deploy/conf.d/default.conf")).toBe(true);
    expect(isClientConfigPath("services/web/src/index.ts")).toBe(false);
    expect(isClientConfigPath("services/web/environment.md")).toBe(false);
  });
});

describe("buildClientConfigIndex", () => {
  it("reads URL values from .env files and ignores non-URL values (secrets)", () => {
    const index = buildClientConfigIndex([
      file(".env", "ORDERS_URL=http://orders:3000\nexport BILLING_URL='https://billing:8443'\nDB_PASSWORD=hunter2\n# comment"),
    ], rootOf);
    expect(index.envUrl.get("ORDERS_URL")).toBe("http://orders:3000");
    expect(index.envUrl.get("BILLING_URL")).toBe("https://billing:8443");
    expect(index.envUrl.has("DB_PASSWORD")).toBe(false);
  });

  it("maps docker-compose service names to workspace roots and reads environment entries", () => {
    const index = buildClientConfigIndex([
      file("docker-compose.yml", `
services:
  users:
    build: ./services/users
    environment:
      - ORDERS_URL=http://orders:3000
  orders:
    build:
      context: ./services/orders
    environment:
      USERS_URL: http://users:3000
  redis:
    image: redis:7
`),
    ], rootOf);
    expect(index.hostRoot.get("users")).toBe("services/users");
    expect(index.hostRoot.get("orders")).toBe("services/orders");
    expect(index.hostRoot.has("redis")).toBe(false);
    expect(index.envUrl.get("ORDERS_URL")).toBe("http://orders:3000");
    expect(index.envUrl.get("USERS_URL")).toBe("http://users:3000");
  });

  it("resolves compose build contexts relative to the compose file directory", () => {
    const index = buildClientConfigIndex([
      file("deploy/docker-compose.yaml", "services:\n  api:\n    build: ../services/api\n"),
    ], rootOf);
    expect(index.hostRoot.get("api")).toBe("services/api");
  });

  it("reads Kubernetes env name/value pairs", () => {
    const index = buildClientConfigIndex([
      file("k8s/web.yaml", `
spec:
  containers:
    - name: web
      env:
        - name: TICKETS_URL
          value: "http://tickets:8080"
        - name: LOG_LEVEL
          value: debug
`),
    ], rootOf);
    expect(index.envUrl.get("TICKETS_URL")).toBe("http://tickets:8080");
    expect(index.envUrl.has("LOG_LEVEL")).toBe(false);
  });

  it("flattens appsettings.json URL values under config-key and env-override spellings", () => {
    const index = buildClientConfigIndex([
      file("services/billing/appsettings.json", JSON.stringify({
        Services: { Orders: { BaseUrl: "http://orders-api" } },
        Logging: { Level: "Warning" },
      })),
    ], rootOf);
    expect(index.envUrl.get("Services:Orders:BaseUrl")).toBe("http://orders-api");
    expect(index.envUrl.get("SERVICES__ORDERS__BASEURL")).toBe("http://orders-api");
    expect(index.envUrl.has("Logging:Level")).toBe(false);
  });

  it("extracts nginx location/proxy_pass routes scoped to the serving service", () => {
    const index = buildClientConfigIndex([
      file("services/web/nginx.conf", `
server {
  listen 80;
  location /api/ {
    proxy_pass http://orders:8080;
  }
  location / {
    root /usr/share/nginx/html;
  }
}
`),
    ], rootOf);
    expect(resolveProxyHost(index, "services/web", "/api/orders/1")).toBe("orders");
    expect(resolveProxyHost(index, "services/web", "/assets/logo.png")).toBeUndefined();
  });

  it("extracts Vite devserver proxy targets and CRA package.json proxy", () => {
    const index = buildClientConfigIndex([
      file("services/spa/vite.config.ts", `
export default defineConfig({
  server: { proxy: { "/api": { target: "http://backend:4000", changeOrigin: true } } },
});
`),
      file("services/cra/package.json", JSON.stringify({ name: "cra", proxy: "http://legacy:5000" })),
    ], rootOf);
    expect(resolveProxyHost(index, "services/spa", "/api/things")).toBe("backend");
    expect(resolveProxyHost(index, "services/spa", "/other")).toBeUndefined();
    expect(resolveProxyHost(index, "services/cra", "/anything/at/all")).toBe("legacy");
  });

  it("prefers the longest matching proxy prefix", () => {
    const index = buildClientConfigIndex([
      file("services/web/nginx.conf", `
location / { proxy_pass http://frontend:3000; }
location /api { proxy_pass http://backend:4000; }
`),
    ], rootOf);
    expect(resolveProxyHost(index, "services/web", "/api/x")).toBe("backend");
    expect(resolveProxyHost(index, "services/web", "/page")).toBe("frontend");
  });
});

describe("host helpers", () => {
  it("extracts and normalizes URL hosts", () => {
    expect(urlHost("http://orders:3000/api")).toBe("orders");
    expect(urlHost("https://user:pw@billing.internal/x")).toBe("billing.internal");
    expect(urlHost("not a url")).toBeUndefined();
  });

  it("falls back to the first dot-label when looking up compose hosts", () => {
    const index = buildClientConfigIndex([
      file("docker-compose.yml", "services:\n  users:\n    build: ./services/users\n"),
    ], rootOf);
    expect(lookupHostRoot(index, "users:3000")).toBe("services/users");
    expect(lookupHostRoot(index, "users.internal")).toBe("services/users");
    expect(lookupHostRoot(index, "payments")).toBeUndefined();
  });
});
