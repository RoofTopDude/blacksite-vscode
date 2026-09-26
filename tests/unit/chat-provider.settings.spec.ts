import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ChatProvider, type ExtendedSettings } from "../../src/chat-provider.js";

/* Settings round-trips through the sidebar handlers. Every handler writes back what
   _readSettings returns, so these pin that a stored preference survives unrelated writes and
   that a no-op or reversible switch never silently changes the user's model. */

const SETTINGS_KEY = "blacksite.settings.v2";

interface Host {
  _readSettings(): ExtendedSettings;
  _onSettingsMessage(type: string, msg: Record<string, unknown>): Promise<boolean>;
  _onCredentialMessage(type: string, msg: Record<string, unknown>): Promise<boolean>;
  _session: unknown;
}

function makeHost(stored?: Partial<ExtendedSettings>): { host: Host; state: Map<string, unknown> } {
  const state = new Map<string, unknown>();
  if (stored) {
    state.set(SETTINGS_KEY, { provider: "anthropic", providerSettings: {}, maxIterations: 40, disabledTools: [], ...stored });
  }
  const host = Object.assign(Object.create(ChatProvider.prototype), {
    _context: {
      globalState: {
        get: (key: string) => state.get(key),
        update: async (key: string, value: unknown) => { state.set(key, structuredClone(value)); },
      },
    },
    _session: { live: true },
    _runner: { busy: false },
    _modelCache: new Map(),
    _modelFetchInFlight: new Map(),
    _post: vi.fn(),
    _persistSession: vi.fn(),
    _sendSettingsToWebview: vi.fn(async () => undefined),
    _fetchAndSendModels: vi.fn(async () => undefined),
    _chatGptService: () => ({ refresh: async () => undefined }),
  }) as Host;
  return { host, state };
}

afterEach(() => {
  (vscode.workspace as unknown as { __clearConfig(): void }).__clearConfig();
  vi.restoreAllMocks();
});

describe("ChatProvider settings — stored preferences survive other writes", () => {
  it("keeps audio transcription switched off across an unrelated settings write", async () => {
    const { host, state } = makeHost({});
    await host._onSettingsMessage("set_audio_transcription", { enabled: false, language: "en" });
    expect(host._readSettings().audioTranscription).toEqual({ enabled: false, language: "en" });

    await host._onSettingsMessage("set_temperature", { provider: "anthropic", temperature: 0.5 });
    expect((state.get(SETTINGS_KEY) as ExtendedSettings).audioTranscription).toEqual({ enabled: false, language: "en" });
    expect(host._readSettings().audioTranscription?.enabled).toBe(false);
  });
});

describe("ChatProvider settings — switches that must not reset the model", () => {
  it("ignores a click on the Bedrock API that is already active", async () => {
    const picked = "us.anthropic.claude-opus-4-8-v1:0";
    const { host } = makeHost({
      provider: "bedrock",
      bedrockApi: "converse",
      providerSettings: { bedrock: { model: picked, temperature: 1, maxTokens: 8192 } },
    });
    await host._onCredentialMessage("set_bedrock_api", { api: "converse" });
    expect(host._readSettings().providerSettings.bedrock?.model).toBe(picked);
    expect(host._session).not.toBeNull();
  });

  it("restores the API-key model after trying ChatGPT sign-in", async () => {
    const { host } = makeHost({
      provider: "openai",
      providerSettings: { openai: { model: "gpt-5.6-luna", temperature: 1, maxTokens: 8192 } },
    });
    await host._onCredentialMessage("set_openai_auth_mode", { mode: "chatgpt" });
    expect(host._readSettings().providerSettings.openai).toMatchObject({ authMode: "chatgpt", model: "" });

    await host._onCredentialMessage("set_openai_auth_mode", { mode: "apiKey" });
    expect(host._readSettings().providerSettings.openai).toMatchObject({ authMode: "apiKey", model: "gpt-5.6-luna" });
  });
});

describe("ChatProvider settings — the visible-settings mirror", () => {
  it("finishes a provider switch even when the settings file cannot be written", async () => {
    const { host } = makeHost({});
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
      update: async () => { throw new Error("Unable to write into user settings because the file has unsaved changes."); },
    } as unknown as ReturnType<typeof vscode.workspace.getConfiguration>);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(host._onSettingsMessage("set_active_provider", { provider: "openai" })).resolves.toBe(true);
    expect(host._readSettings().provider).toBe("openai");
    expect(host._session).toBeNull();
  });

  it("writes the mirror to user settings, never the open folder", async () => {
    const { host } = makeHost({});
    const targets: unknown[] = [];
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
      update: async (_key: string, _value: unknown, target: unknown) => { targets.push(target); },
    } as unknown as ReturnType<typeof vscode.workspace.getConfiguration>);
    const workspace = vscode.workspace as unknown as { workspaceFolders: unknown };
    const previousFolders = workspace.workspaceFolders;
    workspace.workspaceFolders = [{ name: "repo", index: 0, uri: vscode.Uri.file(process.cwd()) }];
    try {
      await host._onSettingsMessage("set_active_provider", { provider: "openai" });
    } finally {
      workspace.workspaceFolders = previousFolders;
    }
    expect(targets).toHaveLength(3);
    expect(new Set(targets)).toEqual(new Set([vscode.ConfigurationTarget.Global]));
  });

  it("seeds a new install from the user-level provider, not a repository's workspace setting", () => {
    const config = vscode.workspace as unknown as { __setConfig(k: string, v: unknown): void; __setGlobalConfig(k: string, v: unknown): void };
    config.__setConfig("blacksite.provider", "openrouter");
    expect(makeHost().host._readSettings().provider).toBe("anthropic");

    config.__setGlobalConfig("blacksite.provider", "openai");
    expect(makeHost().host._readSettings().provider).toBe("openai");
  });
});
