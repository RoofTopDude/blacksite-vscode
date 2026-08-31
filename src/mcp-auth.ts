/* OAuth 2.1 for MCP servers — discovery, dynamic client registration, and the authorization
 * code flow with PKCE.
 *
 * MCP does not define an authorization scheme of its own. It composes existing RFCs, and the
 * chain only works end to end if every link is present:
 *
 *   401 + WWW-Authenticate   the server points at its metadata           (RFC 9728 §5.1)
 *   protected resource meta  names its authorization server and audience (RFC 9728)
 *   AS metadata              names authorize/token/register endpoints    (RFC 8414)
 *   dynamic registration     obtains a client_id without a support ticket(RFC 7591)
 *   authorization code+PKCE  the user consents in a real browser         (OAuth 2.1)
 *   resource indicator       binds the token to this server specifically (RFC 8707)
 *
 * Skipping the last one is the subtle failure: without `resource`, an authorization server
 * that serves several MCP deployments issues a token whose audience is ambiguous, and
 * spec-compliant servers reject it. Skipping dynamic registration is the common one — it is
 * what lets a user connect to a server nobody pre-provisioned this extension with.
 *
 * The interactive half needs a browser and a place for the redirect to land, so the flow runs
 * against a loopback HTTP listener bound for the duration of the consent. Everything above
 * that (URL derivation, PKCE, expiry) is exported as plain functions so it can be tested
 * without a network or a browser. */

import * as http from "http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "net";
import * as vscode from "vscode";

/** Bound so a hung or malicious metadata host cannot stall a tool call indefinitely. */
const METADATA_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 20_000;
/** How long the loopback listener waits for the user to finish consenting. */
const CONSENT_TIMEOUT_MS = 5 * 60_000;
/** Refresh this far ahead of expiry so a token cannot lapse mid-request. */
const EXPIRY_SKEW_MS = 60_000;
const MAX_METADATA_BYTES = 512 * 1024;
/** Default loopback port. Fixed rather than random because a *pre-registered* client has one
 *  redirect URI baked into it, and a random port would never match; the listener falls back
 *  to an ephemeral port only when this one is busy and the client was registered dynamically. */
const DEFAULT_REDIRECT_PORT = 33418;
const REDIRECT_PATH = "/callback";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds, absent when the server issued a token without an expiry. */
  expiresAt?: number;
  scope?: string;
  tokenType: string;
  /** The resource indicator the token was issued for; kept so a changed server URL
   *  invalidates the stored token instead of sending it somewhere it does not belong. */
  resource?: string;
}

export interface OAuthClientRegistration {
  clientId: string;
  clientSecret?: string;
  issuer: string;
  redirectUri: string;
  registeredAt: number;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  grantTypesSupported?: string[];
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorizationServers: string[];
  scopesSupported?: string[];
}

export interface McpOAuthConfig {
  /** Scopes to request. Empty means "whatever the server advertises". */
  scopes?: string[];
  /** Pre-registered client id, for servers without dynamic registration. */
  clientId?: string;
  /** Full redirect URI of a pre-registered client. Its port and path drive the listener. */
  redirectUri?: string;
}

/** Where tokens and registrations are kept. Implemented by McpRegistry against VS Code
 *  SecretStorage; kept as an interface so this module never touches persistence directly. */
export interface OAuthStorage {
  readTokens(serverId: string): Promise<OAuthTokenSet | undefined>;
  writeTokens(serverId: string, tokens: OAuthTokenSet): Promise<void>;
  clearTokens(serverId: string): Promise<void>;
  readClient(serverId: string): Promise<OAuthClientRegistration | undefined>;
  writeClient(serverId: string, client: OAuthClientRegistration): Promise<void>;
}

export class McpOAuthError extends Error {
  constructor(message: string, readonly recoverable = true) {
    super(message);
    this.name = "McpOAuthError";
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** RFC 7636 S256. 32 random bytes is the recommended entropy; base64url keeps it inside the
 *  43–128 character range the spec allows without any padding to strip. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The canonical resource indicator for an MCP endpoint (RFC 8707 / MCP authorization spec).
 *
 * Lowercased scheme and host, no fragment, and no trailing slash on an otherwise empty path —
 * the same normalization the server performs before comparing audiences. Getting this wrong
 * produces a token the server rejects with a second 401, which reads as "authorization is
 * broken" rather than "the audience did not match".
 */
export function canonicalResourceIndicator(endpoint: string): string {
  const url = new URL(endpoint);
  url.hash = "";
  url.username = "";
  url.password = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  const href = url.href;
  return url.pathname === "/" && !url.search ? href.replace(/\/$/, "") : href;
}

/**
 * Candidate protected-resource metadata URLs for an endpoint, in priority order.
 *
 * RFC 9728 inserts the resource's path *after* the well-known segment
 * (`/.well-known/oauth-protected-resource/mcp`), which is the spelling a server hosting
 * several resources on one origin uses. Plenty of single-resource deployments only publish
 * the root form, so both are tried.
 */
export function protectedResourceMetadataUrls(endpoint: string): string[] {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, "");
  const urls = new Set<string>();
  if (path && path !== "/") urls.add(`${url.origin}/.well-known/oauth-protected-resource${path}`);
  urls.add(`${url.origin}/.well-known/oauth-protected-resource`);
  return [...urls];
}

/**
 * Candidate authorization-server metadata URLs for an issuer, in priority order.
 *
 * RFC 8414 puts the issuer's path after the well-known segment; OpenID Connect Discovery puts
 * it before. Issuers in the wild implement one, the other, or both, so all four spellings are
 * tried before giving up.
 */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  const urls = new Set<string>();
  if (path && path !== "/") {
    urls.add(`${url.origin}/.well-known/oauth-authorization-server${path}`);
    urls.add(`${url.origin}/.well-known/openid-configuration${path}`);
    urls.add(`${url.origin}${path}/.well-known/openid-configuration`);
  }
  urls.add(`${url.origin}/.well-known/oauth-authorization-server`);
  urls.add(`${url.origin}/.well-known/openid-configuration`);
  return [...urls];
}

/** Endpoints every OAuth 2.1 server is required to expose at fixed paths. Used when metadata
 *  discovery finds nothing — a server can be perfectly usable and simply not publish it. */
export function defaultAuthorizationServerMetadata(issuer: string): AuthorizationServerMetadata {
  const base = issuer.replace(/\/+$/, "");
  return {
    issuer: base,
    authorizationEndpoint: `${base}/authorize`,
    tokenEndpoint: `${base}/token`,
    registrationEndpoint: `${base}/register`,
  };
}

export function parseAuthorizationServerMetadata(raw: unknown, fallbackIssuer: string): AuthorizationServerMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const authorizationEndpoint = typeof m["authorization_endpoint"] === "string" ? m["authorization_endpoint"] : "";
  const tokenEndpoint = typeof m["token_endpoint"] === "string" ? m["token_endpoint"] : "";
  if (!authorizationEndpoint || !tokenEndpoint) return null;
  const strings = (key: string): string[] | undefined =>
    Array.isArray(m[key]) ? (m[key] as unknown[]).filter((v): v is string => typeof v === "string") : undefined;
  return {
    issuer: typeof m["issuer"] === "string" ? m["issuer"] : fallbackIssuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: typeof m["registration_endpoint"] === "string" ? m["registration_endpoint"] : undefined,
    revocationEndpoint: typeof m["revocation_endpoint"] === "string" ? m["revocation_endpoint"] : undefined,
    scopesSupported: strings("scopes_supported"),
    codeChallengeMethodsSupported: strings("code_challenge_methods_supported"),
    grantTypesSupported: strings("grant_types_supported"),
  };
}

export function parseProtectedResourceMetadata(raw: unknown): ProtectedResourceMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const resource = typeof m["resource"] === "string" ? m["resource"] : "";
  if (!resource) return null;
  const servers = Array.isArray(m["authorization_servers"])
    ? (m["authorization_servers"] as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  return {
    resource,
    authorizationServers: servers,
    scopesSupported: Array.isArray(m["scopes_supported"])
      ? (m["scopes_supported"] as unknown[]).filter((v): v is string => typeof v === "string")
      : undefined,
  };
}

export function parseTokenResponse(raw: unknown, resource: string, previous?: OAuthTokenSet): OAuthTokenSet {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const accessToken = typeof m["access_token"] === "string" ? m["access_token"] : "";
  if (!accessToken) throw new McpOAuthError("The authorization server returned no access token.");
  const expiresIn = typeof m["expires_in"] === "number" ? m["expires_in"] : Number(m["expires_in"] ?? NaN);
  return {
    accessToken,
    // Refresh tokens are frequently omitted on refresh responses, meaning "keep using the one
    // you have". Dropping it there would turn a renewable session into a single-use one.
    refreshToken: typeof m["refresh_token"] === "string" ? m["refresh_token"] : previous?.refreshToken,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
    scope: typeof m["scope"] === "string" ? m["scope"] : previous?.scope,
    tokenType: typeof m["token_type"] === "string" ? m["token_type"] : "Bearer",
    resource,
  };
}

export function isTokenExpired(tokens: OAuthTokenSet, skewMs = EXPIRY_SKEW_MS): boolean {
  if (!tokens.expiresAt) return false;
  return Date.now() + skewMs >= tokens.expiresAt;
}

/** A stored token is usable only for the resource it was issued for; a re-pointed server
 *  entry must re-authorize rather than replay the old audience's token. */
export function tokenMatchesResource(tokens: OAuthTokenSet, resource: string): boolean {
  return !tokens.resource || tokens.resource === resource;
}

export function buildAuthorizationUrl(input: {
  metadata: AuthorizationServerMetadata;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  resource: string;
  scopes?: string[];
}): string {
  const url = new URL(input.metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resource);
  if (input.scopes?.length) url.searchParams.set("scope", input.scopes.join(" "));
  return url.href;
}

// ── Network helpers ───────────────────────────────────────────────────────────

async function fetchJson(url: string, timeoutMs: number, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Token, refresh, and dynamic-registration bodies contain authorization codes or client
    // credentials. Never let fetch replay those POST bodies to a redirect target.
    const response = await fetch(url, {
      ...init,
      redirect: (init?.method ?? "GET").toUpperCase() === "GET" ? "follow" : "error",
      signal: controller.signal,
    });
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpOAuthError("Authorization metadata response was implausibly large.");
    }
    const text = (await response.text()).slice(0, MAX_METADATA_BYTES);
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function describeOAuthFailure(status: number, body: unknown, context: string): string {
  const m = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const code = typeof m["error"] === "string" ? m["error"] : "";
  const description = typeof m["error_description"] === "string" ? m["error_description"] : "";
  if (code || description) return `${context} failed: ${[code, description].filter(Boolean).join(" — ")}`;
  return `${context} failed with HTTP ${status}.`;
}

// ── Loopback redirect listener ────────────────────────────────────────────────

interface LoopbackListener {
  redirectUri: string;
  waitForCode(expectedState: string, timeoutMs: number): Promise<string>;
  dispose(): void;
}

function renderCallbackPage(title: string, message: string): string {
  const escape = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#09090b;color:#f4f4f5;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;max-width:26rem;padding:2rem}
h1{font-size:1.1rem;margin:0 0 .5rem}p{color:#a1a1aa;font-size:.85rem;line-height:1.6;margin:0}</style>
</head><body><div class="card"><h1>${escape(title)}</h1><p>${escape(message)}</p></div></body></html>`;
}

/**
 * Bind a loopback listener for the redirect.
 *
 * RFC 8252 makes loopback the recommended redirect for native apps, and it is the only option
 * that works with dynamic registration: a custom URI scheme would have to be pre-registered
 * with every authorization server we might ever meet. The listener lives exactly as long as
 * the consent does.
 */
async function startLoopbackListener(preferred?: { port?: number; path?: string }): Promise<LoopbackListener> {
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  let expected = "";
  const path = preferred?.path || REDIRECT_PATH;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== path) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    const description = url.searchParams.get("error_description") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";

    if (error) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderCallbackPage("Authorization declined", description || error));
      rejectCode?.(new McpOAuthError(`Authorization was declined: ${description || error}`));
      return;
    }
    // A mismatched state means this callback did not come from the request we started —
    // rejecting it is what stops an attacker-initiated code from being redeemed here.
    if (!statesMatch(state, expected)) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderCallbackPage("Authorization failed", "The response did not match this request."));
      rejectCode?.(new McpOAuthError("Authorization response failed its state check."));
      return;
    }
    if (!code) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderCallbackPage("Authorization failed", "No authorization code was returned."));
      rejectCode?.(new McpOAuthError("The authorization server returned no code."));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(renderCallbackPage("Connected", "Authorization is complete. You can close this tab and return to VS Code."));
    resolveCode?.(code);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      // A pre-registered client's redirect URI names one port; if it is taken we cannot
      // silently move, because the authorization server would reject the mismatch.
      if (error.code === "EADDRINUSE" && preferred?.port) {
        reject(new McpOAuthError(`Port ${preferred.port} is in use, and this server's redirect URI requires it. Close whatever is holding the port and try again.`));
        return;
      }
      if (error.code === "EADDRINUSE") {
        server.listen(0, "127.0.0.1");
        return;
      }
      reject(error);
    };
    server.on("error", onError);
    server.listen(preferred?.port ?? DEFAULT_REDIRECT_PORT, "127.0.0.1", () => {
      server.removeListener("error", onError);
      server.on("error", () => undefined);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${address.port}${path}`,
    waitForCode(expectedState: string, timeoutMs: number): Promise<string> {
      expected = expectedState;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new McpOAuthError("Timed out waiting for authorization. Nothing was changed.")),
          timeoutMs,
        );
        resolveCode = (code) => { clearTimeout(timer); resolve(code); };
        rejectCode = (error) => { clearTimeout(timer); reject(error); };
      });
    },
    dispose(): void {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

function statesMatch(received: string, expected: string): boolean {
  if (!expected || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received, "utf8"), Buffer.from(expected, "utf8"));
}

// ── The flow ──────────────────────────────────────────────────────────────────

export interface AuthorizeOptions {
  serverId: string;
  serverName: string;
  /** The MCP endpoint being authorized — the audience the token is bound to. */
  endpoint: string;
  config: McpOAuthConfig;
  /** `resource_metadata` from the 401 challenge, when the server sent one. Short-circuits
   *  the guessing in protectedResourceMetadataUrls. */
  resourceMetadataUrl?: string;
}

export class McpOAuthClient {
  constructor(private readonly _storage: OAuthStorage) {}

  /**
   * A usable access token, or undefined when the user has to consent first.
   *
   * Never interactive: this runs on the tool-call path, where blocking the agent behind a
   * browser window the user may not be looking at would hang the turn. The caller surfaces
   * the sign-in prompt out of band instead.
   */
  async getAccessToken(serverId: string, endpoint: string): Promise<string | undefined> {
    const stored = await this._storage.readTokens(serverId);
    if (!stored) return undefined;

    let resource: string;
    try { resource = canonicalResourceIndicator(endpoint); } catch { return undefined; }
    if (!tokenMatchesResource(stored, resource)) return undefined;
    if (!isTokenExpired(stored)) return stored.accessToken;

    if (!stored.refreshToken) return undefined;
    try {
      const refreshed = await this._refresh(serverId, endpoint, stored);
      return refreshed.accessToken;
    } catch {
      // A refresh token the server has revoked is not an error to report here — it just means
      // the user has to consent again, which is exactly what "no token" already communicates.
      await this._storage.clearTokens(serverId);
      return undefined;
    }
  }

  async hasTokens(serverId: string): Promise<boolean> {
    return !!(await this._storage.readTokens(serverId));
  }

  async signOut(serverId: string): Promise<void> {
    await this._storage.clearTokens(serverId);
  }

  /** Run the full interactive flow: discover, register if needed, consent, exchange. */
  async authorize(options: AuthorizeOptions): Promise<OAuthTokenSet> {
    const resource = canonicalResourceIndicator(options.endpoint);
    const discovery = await this.discover(options.endpoint, options.resourceMetadataUrl);
    const scopes = options.config.scopes?.length
      ? options.config.scopes
      : discovery.resourceMetadata?.scopesSupported ?? discovery.metadata.scopesSupported;

    // S256 is mandatory in OAuth 2.1 and the only method we implement; a server that
    // advertises support for `plain` alone is not one we should downgrade to meet.
    const methods = discovery.metadata.codeChallengeMethodsSupported;
    if (methods && methods.length > 0 && !methods.includes("S256")) {
      throw new McpOAuthError("This authorization server does not support PKCE with S256, which is required.", false);
    }

    const preferredRedirect = options.config.redirectUri ? new URL(options.config.redirectUri) : undefined;
    const listener = await startLoopbackListener(
      preferredRedirect
        ? { port: Number(preferredRedirect.port) || 80, path: preferredRedirect.pathname }
        : undefined,
    );

    try {
      const client = await this._resolveClient(options, discovery.metadata, listener.redirectUri, scopes);
      const pkce = createPkcePair();
      const state = createOAuthState();
      const authorizationUrl = buildAuthorizationUrl({
        metadata: discovery.metadata,
        clientId: client.clientId,
        redirectUri: client.redirectUri,
        state,
        challenge: pkce.challenge,
        resource,
        scopes,
      });

      const waiter = listener.waitForCode(state, CONSENT_TIMEOUT_MS);
      const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizationUrl));
      if (!opened) throw new McpOAuthError("VS Code could not open a browser for authorization.");
      const code = await waiter;

      const tokens = await this._exchangeCode({
        metadata: discovery.metadata,
        client,
        code,
        verifier: pkce.verifier,
        resource,
      });
      await this._storage.writeTokens(options.serverId, tokens);
      return tokens;
    } finally {
      listener.dispose();
    }
  }

  /**
   * Walk the discovery chain to the authorization server's metadata.
   *
   * Every step degrades rather than fails: a missing `resource_metadata` falls back to
   * well-known probing, a resource that names no authorization server falls back to treating
   * the MCP origin as the issuer, and an issuer that publishes no metadata falls back to the
   * fixed OAuth 2.1 endpoint paths. Servers exist in the wild at every one of those levels.
   */
  async discover(endpoint: string, resourceMetadataUrl?: string): Promise<{
    metadata: AuthorizationServerMetadata;
    resourceMetadata?: ProtectedResourceMetadata;
  }> {
    const resourceMetadata = await this._discoverResourceMetadata(endpoint, resourceMetadataUrl);
    const issuers = resourceMetadata?.authorizationServers.length
      ? resourceMetadata.authorizationServers
      : [new URL(endpoint).origin];

    const failures: string[] = [];
    for (const issuer of issuers) {
      for (const url of authorizationServerMetadataUrls(issuer)) {
        try {
          const { status, body } = await fetchJson(url, METADATA_TIMEOUT_MS, { headers: { Accept: "application/json" } });
          if (status !== 200) continue;
          const metadata = parseAuthorizationServerMetadata(body, issuer);
          if (metadata) return { metadata, resourceMetadata };
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    const fallbackIssuer = issuers[0];
    if (!fallbackIssuer) throw new McpOAuthError("Could not determine an authorization server for this MCP server.");
    return { metadata: defaultAuthorizationServerMetadata(fallbackIssuer), resourceMetadata };
  }

  private async _discoverResourceMetadata(
    endpoint: string,
    resourceMetadataUrl?: string,
  ): Promise<ProtectedResourceMetadata | undefined> {
    const candidates = resourceMetadataUrl
      ? [resourceMetadataUrl, ...protectedResourceMetadataUrls(endpoint)]
      : protectedResourceMetadataUrls(endpoint);
    for (const url of candidates) {
      try {
        const { status, body } = await fetchJson(url, METADATA_TIMEOUT_MS, { headers: { Accept: "application/json" } });
        if (status !== 200) continue;
        const parsed = parseProtectedResourceMetadata(body);
        if (parsed) return parsed;
      } catch { /* try the next candidate */ }
    }
    return undefined;
  }

  /** A stored registration, the user's pre-registered client, or a fresh dynamic one. */
  private async _resolveClient(
    options: AuthorizeOptions,
    metadata: AuthorizationServerMetadata,
    redirectUri: string,
    scopes?: string[],
  ): Promise<OAuthClientRegistration> {
    if (options.config.clientId) {
      return {
        clientId: options.config.clientId,
        issuer: metadata.issuer,
        redirectUri: options.config.redirectUri ?? redirectUri,
        registeredAt: Date.now(),
      };
    }

    const stored = await this._storage.readClient(options.serverId);
    // A registration is only good for the issuer that granted it, and only for the redirect
    // URI it was registered with — a moved port invalidates it.
    if (stored && stored.issuer === metadata.issuer && stored.redirectUri === redirectUri) return stored;

    if (!metadata.registrationEndpoint) {
      throw new McpOAuthError(
        "This server's authorization server does not support dynamic client registration. Add a client ID in the server's settings and try again.",
        false,
      );
    }

    const { status, body } = await fetchJson(metadata.registrationEndpoint, TOKEN_TIMEOUT_MS, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: `Blacksite — ${options.serverName}`,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // Public client: a desktop extension cannot keep a client secret, which is exactly
        // the case PKCE is designed for.
        token_endpoint_auth_method: "none",
        ...(scopes?.length ? { scope: scopes.join(" ") } : {}),
      }),
    });
    if (status !== 200 && status !== 201) {
      throw new McpOAuthError(describeOAuthFailure(status, body, "Dynamic client registration"));
    }
    const registered = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const clientId = typeof registered["client_id"] === "string" ? registered["client_id"] : "";
    if (!clientId) throw new McpOAuthError("Dynamic client registration returned no client ID.");

    const registration: OAuthClientRegistration = {
      clientId,
      clientSecret: typeof registered["client_secret"] === "string" ? registered["client_secret"] : undefined,
      issuer: metadata.issuer,
      redirectUri,
      registeredAt: Date.now(),
    };
    await this._storage.writeClient(options.serverId, registration);
    return registration;
  }

  private async _exchangeCode(input: {
    metadata: AuthorizationServerMetadata;
    client: OAuthClientRegistration;
    code: string;
    verifier: string;
    resource: string;
  }): Promise<OAuthTokenSet> {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.client.redirectUri,
      client_id: input.client.clientId,
      code_verifier: input.verifier,
      resource: input.resource,
    });
    if (input.client.clientSecret) form.set("client_secret", input.client.clientSecret);

    const { status, body } = await fetchJson(input.metadata.tokenEndpoint, TOKEN_TIMEOUT_MS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    });
    if (status !== 200) throw new McpOAuthError(describeOAuthFailure(status, body, "Token exchange"));
    return parseTokenResponse(body, input.resource);
  }

  private async _refresh(serverId: string, endpoint: string, stored: OAuthTokenSet): Promise<OAuthTokenSet> {
    const resource = canonicalResourceIndicator(endpoint);
    const { metadata } = await this.discover(endpoint);
    const client = await this._storage.readClient(serverId);
    if (!client) throw new McpOAuthError("No client registration is stored for this server.");

    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken ?? "",
      client_id: client.clientId,
      resource,
    });
    if (client.clientSecret) form.set("client_secret", client.clientSecret);

    const { status, body } = await fetchJson(metadata.tokenEndpoint, TOKEN_TIMEOUT_MS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    });
    if (status !== 200) throw new McpOAuthError(describeOAuthFailure(status, body, "Token refresh"));
    const tokens = parseTokenResponse(body, resource, stored);
    await this._storage.writeTokens(serverId, tokens);
    return tokens;
  }
}
