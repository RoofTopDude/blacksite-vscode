import * as vscode from "vscode";
import type { BedrockCredentials } from "./bedrock-types.js";

const PREFIX = "blacksite.apiKey.";

const PLACEHOLDERS: Record<string, string> = {
  anthropic:  "sk-ant-api03-…",
  openrouter: "sk-or-…",
  openai:     "sk-…",
  bedrock:    "AWS access key / secret (collected step by step)",
  github:     "ghp_… or github_pat_…",
  gitlab:     "glpat-…",
  jira:       "user@example.com:ATATT3x… (email:token)",
  confluence: "user@example.com:ATATT3x… (email:token)",
  salesforce: "your-access-token",
};

export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getApiKey(provider: string): Promise<string | undefined> {
    return this.secrets.get(PREFIX + provider);
  }

  async setApiKey(provider: string, key: string): Promise<void> {
    await this.secrets.store(PREFIX + provider, key);
  }

  async deleteApiKey(provider: string): Promise<void> {
    await this.secrets.delete(PREFIX + provider);
  }

  async hasApiKey(provider: string): Promise<boolean> {
    if (provider === "bedrock") return !!(await this.getBedrockConfig());
    const v = await this.getApiKey(provider);
    return !!v;
  }

  /** Prompt for and store a key; returns the key or undefined if cancelled. */
  async getOrPromptApiKey(provider: string): Promise<string | undefined> {
    if (provider === "bedrock") {
      const existing = await this.getBedrockConfig();
      if (existing) return this.getApiKey("bedrock");
      return this.promptForApiKey(provider);
    }
    const existing = await this.getApiKey(provider);
    if (existing) return existing;
    return this.promptForApiKey(provider);
  }

  async promptForApiKey(provider: string): Promise<string | undefined> {
    if (provider === "bedrock") {
      const config = await this.promptForBedrockCredentials();
      return config ? this.getApiKey("bedrock") : undefined;
    }
    const key = await vscode.window.showInputBox({
      title: `Blacksite — ${provider} API key`,
      prompt: `Enter your ${provider} key. Stored in VS Code SecretStorage, never leaves your machine.`,
      password: true,
      placeHolder: PLACEHOLDERS[provider] ?? "your-api-key",
      ignoreFocusOut: true,
    });
    if (key?.trim()) {
      await this.setApiKey(provider, key.trim());
      return key.trim();
    }
    return undefined;
  }

  // ── Bedrock credentials (region + AWS keys, stored as one JSON blob) ──────────

  /** Parse the stored Bedrock credentials blob, or undefined if unset/invalid. */
  async getBedrockConfig(): Promise<BedrockCredentials | undefined> {
    const raw = await this.getApiKey("bedrock");
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<BedrockCredentials>;
      if (!parsed.region || !parsed.accessKeyId || !parsed.secretAccessKey) return undefined;
      return {
        region: parsed.region,
        accessKeyId: parsed.accessKeyId,
        secretAccessKey: parsed.secretAccessKey,
        sessionToken: parsed.sessionToken || undefined,
      };
    } catch {
      return undefined;
    }
  }

  async setBedrockConfig(config: BedrockCredentials): Promise<void> {
    await this.setApiKey("bedrock", JSON.stringify(config));
  }

  /** Collect AWS region + credentials through a sequence of input boxes. */
  async promptForBedrockCredentials(): Promise<BedrockCredentials | undefined> {
    const existing = await this.getBedrockConfig();

    const region = await vscode.window.showInputBox({
      title: "Blacksite — AWS Bedrock (1/4): Region",
      prompt: "AWS region for Bedrock (e.g. us-east-1).",
      value: existing?.region ?? "us-east-1",
      ignoreFocusOut: true,
    });
    if (!region?.trim()) return undefined;

    const accessKeyId = await vscode.window.showInputBox({
      title: "Blacksite — AWS Bedrock (2/4): Access Key ID",
      prompt: "AWS access key id (AKIA…). Stored in VS Code SecretStorage.",
      value: existing?.accessKeyId ?? "",
      placeHolder: "AKIA…",
      ignoreFocusOut: true,
    });
    if (!accessKeyId?.trim()) return undefined;

    const secretAccessKey = await vscode.window.showInputBox({
      title: "Blacksite — AWS Bedrock (3/4): Secret Access Key",
      prompt: "AWS secret access key. Stored in VS Code SecretStorage, never leaves your machine.",
      password: true,
      ignoreFocusOut: true,
    });
    if (!secretAccessKey?.trim()) return undefined;

    const sessionToken = await vscode.window.showInputBox({
      title: "Blacksite — AWS Bedrock (4/4): Session Token (optional)",
      prompt: "AWS session token for temporary credentials. Leave blank for long-lived keys.",
      password: true,
      value: existing?.sessionToken ?? "",
      ignoreFocusOut: true,
    });
    // sessionToken may be cancelled (undefined) or intentionally blank — treat blank as none.

    const config: BedrockCredentials = {
      region: region.trim(),
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secretAccessKey.trim(),
      sessionToken: sessionToken?.trim() || undefined,
    };
    await this.setBedrockConfig(config);
    return config;
  }

  /** Return masked status for all known providers — used by the settings panel. */
  async getProviderStatus(): Promise<Record<string, boolean>> {
    const providers = ["anthropic", "openrouter", "openai", "bedrock", "github", "gitlab", "jira", "confluence", "salesforce"];
    const result: Record<string, boolean> = {};
    for (const p of providers) {
      result[p] = await this.hasApiKey(p);
    }
    return result;
  }
}
