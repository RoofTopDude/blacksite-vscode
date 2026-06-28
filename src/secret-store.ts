import * as vscode from "vscode";

const PREFIX = "blacksite.apiKey.";

const PLACEHOLDERS: Record<string, string> = {
  anthropic:  "sk-ant-api03-…",
  openrouter: "sk-or-…",
  openai:     "sk-…",
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
    const v = await this.getApiKey(provider);
    return !!v;
  }

  /** Prompt for and store a key; returns the key or undefined if cancelled. */
  async getOrPromptApiKey(provider: string): Promise<string | undefined> {
    const existing = await this.getApiKey(provider);
    if (existing) return existing;
    return this.promptForApiKey(provider);
  }

  async promptForApiKey(provider: string): Promise<string | undefined> {
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

  /** Return masked status for all known providers — used by the settings panel. */
  async getProviderStatus(): Promise<Record<string, boolean>> {
    const providers = ["anthropic", "openrouter", "openai", "github", "gitlab", "jira", "confluence", "salesforce"];
    const result: Record<string, boolean> = {};
    for (const p of providers) {
      result[p] = await this.hasApiKey(p);
    }
    return result;
  }
}
