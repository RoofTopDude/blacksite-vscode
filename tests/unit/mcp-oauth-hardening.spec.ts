import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  McpOAuthClient, parseAuthorizationServerMetadata,
  type OAuthClientRegistration, type OAuthStorage, type OAuthTokenSet,
} from "../../src/mcp-auth.js";

/* The authorization code, the PKCE verifier, and refresh tokens travel to the endpoints a
   metadata document names, and the loopback redirect listener is reachable by any page in the
   user's browser. These pin both boundaries. */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authorization server metadata", () => {
  const base = { issuer: "https://auth.example.com", authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "https://auth.example.com/token" };

  it("refuses endpoints that would carry codes or tokens over plain HTTP", () => {
    expect(parseAuthorizationServerMetadata({ ...base, token_endpoint: "http://auth.example.com/token" }, base.issuer)).toBeNull();
    expect(parseAuthorizationServerMetadata({ ...base, authorization_endpoint: "http://auth.example.com/authorize" }, base.issuer)).toBeNull();
    expect(parseAuthorizationServerMetadata({ ...base, registration_endpoint: "http://auth.example.com/register" }, base.issuer)?.registrationEndpoint)
      .toBeUndefined();
  });

  it("allows loopback HTTP for local development servers", () => {
    const local = parseAuthorizationServerMetadata({
      issuer: "http://127.0.0.1:9000",
      authorization_endpoint: "http://127.0.0.1:9000/authorize",
      token_endpoint: "http://localhost:9000/token",
    }, "http://127.0.0.1:9000");
    expect(local?.tokenEndpoint).toBe("http://localhost:9000/token");
  });
});

describe("loopback redirect listener", () => {
  function memoryStorage(): OAuthStorage {
    const tokens = new Map<string, OAuthTokenSet>();
    const clients = new Map<string, OAuthClientRegistration>();
    return {
      readTokens: async (id) => tokens.get(id),
      writeTokens: async (id, value) => { tokens.set(id, value); },
      clearTokens: async (id) => { tokens.delete(id); },
      readClient: async (id) => clients.get(id),
      writeClient: async (id, value) => { clients.set(id, value); },
    };
  }

  function respond(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function get(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      http.get(url, (response) => { response.resume(); resolve(response.statusCode ?? 0); }).on("error", reject);
    });
  }

  it("ignores stray callbacks that lack this request's state instead of ending the sign-in", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("oauth-authorization-server")) {
        return respond(200, {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.endsWith("/register")) return respond(201, { client_id: "client-1" });
      if (url.endsWith("/token")) return respond(200, { access_token: "token-1", token_type: "Bearer", expires_in: 3600 });
      return respond(404, {});
    }));
    let authorizationUrl = "";
    vi.spyOn(vscode.env, "openExternal").mockImplementation(async (uri: vscode.Uri) => {
      authorizationUrl = `${uri.scheme}:${uri.fsPath}`;
      return true;
    });

    const pending = new McpOAuthClient(memoryStorage()).authorize({
      serverId: "srv", serverName: "Server", endpoint: "https://api.example.com/mcp", config: {},
    });
    await vi.waitFor(() => expect(authorizationUrl).not.toBe(""));
    const params = new URL(authorizationUrl).searchParams;
    const redirect = params.get("redirect_uri")!;
    const state = params.get("state")!;

    // Any page can fire these at the port; neither may end or complete the flow.
    expect(await get(`${redirect}?error=access_denied`)).toBe(400);
    expect(await get(`${redirect}?code=forged&state=not-the-state`)).toBe(400);
    // The genuine response still completes it.
    expect(await get(`${redirect}?code=real&state=${encodeURIComponent(state)}`)).toBe(200);
    await expect(pending).resolves.toMatchObject({ accessToken: "token-1" });
  });
});
