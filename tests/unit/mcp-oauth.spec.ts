/* MCP's OAuth profile is a chain of RFCs, and a break anywhere in it reads to the user as
   "authorization is broken". These cover the links that are easy to get subtly wrong: the
   audience binding, the two incompatible well-known layouts, and the refresh response that
   omits the refresh token. */

import { describe, expect, it } from "vitest";
import {
  authorizationServerMetadataUrls, buildAuthorizationUrl, canonicalResourceIndicator,
  createOAuthState, createPkcePair, defaultAuthorizationServerMetadata, isTokenExpired,
  parseAuthorizationServerMetadata, parseProtectedResourceMetadata, parseTokenResponse,
  protectedResourceMetadataUrls, tokenMatchesResource,
  type AuthorizationServerMetadata,
} from "../../src/mcp-auth.js";
import { createHash } from "node:crypto";

describe("PKCE", () => {
  it("derives the challenge as base64url(sha256(verifier))", () => {
    const pair = createPkcePair();
    expect(pair.method).toBe("S256");
    expect(createHash("sha256").update(pair.verifier).digest("base64url")).toBe(pair.challenge);
  });

  it("produces a verifier inside the length range the spec allows, with no padding to strip", () => {
    const pair = createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.verifier.length).toBeLessThanOrEqual(128);
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never repeats a verifier or a state between flows", () => {
    const verifiers = new Set(Array.from({ length: 32 }, () => createPkcePair().verifier));
    const states = new Set(Array.from({ length: 32 }, () => createOAuthState()));
    expect(verifiers.size).toBe(32);
    expect(states.size).toBe(32);
  });
});

describe("canonical resource indicator", () => {
  it("keeps the path, because that is what distinguishes two MCP servers on one origin", () => {
    expect(canonicalResourceIndicator("https://api.example.com/mcp")).toBe("https://api.example.com/mcp");
  });

  it("drops the fragment and normalizes case", () => {
    expect(canonicalResourceIndicator("https://API.Example.com/mcp#frag")).toBe("https://api.example.com/mcp");
  });

  it("drops a bare trailing slash so the audience matches what the server compares against", () => {
    expect(canonicalResourceIndicator("https://api.example.com/")).toBe("https://api.example.com");
  });

  it("strips embedded credentials rather than carrying them into a token request", () => {
    expect(canonicalResourceIndicator("https://user:pass@api.example.com/mcp")).toBe("https://api.example.com/mcp");
  });
});

describe("metadata discovery URLs", () => {
  it("tries the path-scoped protected-resource document before the root one", () => {
    // RFC 9728 inserts the resource path after the well-known segment; a single-resource
    // deployment often only publishes the root form, so both have to be tried.
    expect(protectedResourceMetadataUrls("https://api.example.com/mcp")).toEqual([
      "https://api.example.com/.well-known/oauth-protected-resource/mcp",
      "https://api.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("offers a single candidate when the endpoint is at the origin root", () => {
    expect(protectedResourceMetadataUrls("https://api.example.com/")).toEqual([
      "https://api.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("covers both the RFC 8414 and OpenID Connect well-known layouts", () => {
    // RFC 8414 puts the issuer path after the well-known segment; OIDC puts it before.
    // Issuers implement one, the other, or both.
    const urls = authorizationServerMetadataUrls("https://auth.example.com/tenant1");
    expect(urls).toContain("https://auth.example.com/.well-known/oauth-authorization-server/tenant1");
    expect(urls).toContain("https://auth.example.com/tenant1/.well-known/openid-configuration");
    expect(urls).toContain("https://auth.example.com/.well-known/oauth-authorization-server");
  });

  it("falls back to the fixed OAuth 2.1 endpoint paths for an issuer that publishes nothing", () => {
    const metadata = defaultAuthorizationServerMetadata("https://auth.example.com/");
    expect(metadata.authorizationEndpoint).toBe("https://auth.example.com/authorize");
    expect(metadata.tokenEndpoint).toBe("https://auth.example.com/token");
  });
});

describe("metadata parsing", () => {
  it("rejects a document missing the endpoints the flow cannot run without", () => {
    expect(parseAuthorizationServerMetadata({ issuer: "https://a.example" }, "https://a.example")).toBeNull();
    expect(parseAuthorizationServerMetadata(null, "https://a.example")).toBeNull();
  });

  it("keeps the advertised PKCE methods so an S256-less server can be refused", () => {
    const metadata = parseAuthorizationServerMetadata({
      issuer: "https://a.example",
      authorization_endpoint: "https://a.example/authorize",
      token_endpoint: "https://a.example/token",
      registration_endpoint: "https://a.example/register",
      code_challenge_methods_supported: ["S256"],
    }, "https://a.example");
    expect(metadata?.codeChallengeMethodsSupported).toEqual(["S256"]);
    expect(metadata?.registrationEndpoint).toBe("https://a.example/register");
  });

  it("reads the authorization servers a protected resource names", () => {
    const parsed = parseProtectedResourceMetadata({
      resource: "https://api.example.com/mcp",
      authorization_servers: ["https://auth.example.com"],
      scopes_supported: ["read", "write"],
    });
    expect(parsed?.authorizationServers).toEqual(["https://auth.example.com"]);
    expect(parsed?.scopesSupported).toEqual(["read", "write"]);
  });
});

describe("authorization request", () => {
  const metadata: AuthorizationServerMetadata = {
    issuer: "https://auth.example.com",
    authorizationEndpoint: "https://auth.example.com/authorize?tenant=acme",
    tokenEndpoint: "https://auth.example.com/token",
  };

  it("binds the request to the resource and to the PKCE challenge", () => {
    const url = new URL(buildAuthorizationUrl({
      metadata,
      clientId: "client-123",
      redirectUri: "http://127.0.0.1:33418/callback",
      state: "state-abc",
      challenge: "challenge-xyz",
      resource: "https://api.example.com/mcp",
      scopes: ["read", "write"],
    }));
    // Without `resource`, an authorization server fronting several MCP deployments issues a
    // token with an ambiguous audience that compliant servers reject.
    expect(url.searchParams.get("resource")).toBe("https://api.example.com/mcp");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read write");
    // A query already on the authorize endpoint has to survive.
    expect(url.searchParams.get("tenant")).toBe("acme");
  });

  it("omits scope entirely when none were requested", () => {
    const url = new URL(buildAuthorizationUrl({
      metadata, clientId: "c", redirectUri: "http://127.0.0.1:1/callback",
      state: "s", challenge: "c", resource: "https://api.example.com/mcp",
    }));
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

describe("token handling", () => {
  it("converts expires_in into an absolute expiry", () => {
    const tokens = parseTokenResponse({ access_token: "at", expires_in: 3600 }, "https://api.example.com/mcp");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(tokens.resource).toBe("https://api.example.com/mcp");
  });

  it("keeps the previous refresh token when a refresh response omits one", () => {
    // Omission means "keep using the one you have"; dropping it would turn a renewable
    // session into a single-use one.
    const previous = { accessToken: "old", refreshToken: "rt-1", tokenType: "Bearer" };
    const refreshed = parseTokenResponse({ access_token: "new", expires_in: 60 }, "https://api.example.com/mcp", previous);
    expect(refreshed.refreshToken).toBe("rt-1");
  });

  it("throws when the server returns no access token", () => {
    expect(() => parseTokenResponse({ token_type: "Bearer" }, "https://api.example.com/mcp")).toThrow(/no access token/i);
  });

  it("treats a token inside the refresh skew as already expired", () => {
    expect(isTokenExpired({ accessToken: "a", tokenType: "Bearer", expiresAt: Date.now() + 5_000 })).toBe(true);
    expect(isTokenExpired({ accessToken: "a", tokenType: "Bearer", expiresAt: Date.now() + 600_000 })).toBe(false);
  });

  it("treats a token with no expiry as usable", () => {
    expect(isTokenExpired({ accessToken: "a", tokenType: "Bearer" })).toBe(false);
  });

  it("refuses to reuse a token issued for a different server", () => {
    // Re-pointing a server entry must force re-authorization rather than replay the old
    // audience's token at the new host.
    const tokens = { accessToken: "a", tokenType: "Bearer", resource: "https://old.example.com/mcp" };
    expect(tokenMatchesResource(tokens, "https://new.example.com/mcp")).toBe(false);
    expect(tokenMatchesResource(tokens, "https://old.example.com/mcp")).toBe(true);
  });
});
