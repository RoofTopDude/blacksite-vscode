/**
 * AWS credential resolution chain — the same precedence order every AWS SDK/CLI uses, reused
 * here so a developer who already ran `aws configure` (or exports AWS_* vars for other tools)
 * gets Bedrock working with zero extra setup, instead of the extension being static-keys-only.
 *
 * Split into pure parsing/resolution (this file, unit-testable) and the fs/env access that
 * feeds it (secret-store.ts, which already depends on Node/vscode and isn't unit-tested).
 */

export interface ParsedAwsProfile {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

/**
 * Minimal INI parser for `~/.aws/credentials` and `~/.aws/config` — just enough for the flat
 * `key = value` pairs under `[section]` / `[profile section]` headers those files use. Not a
 * general-purpose INI parser: no nested sections, no multi-line values, no `${}` interpolation.
 */
export function parseAwsIniFile(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      // `~/.aws/config` prefixes non-default profile sections with "profile " (e.g.
      // "[profile work]"); `~/.aws/credentials` never does ("[work]"). Normalize both to the
      // bare profile name so a lookup by name works against either file.
      const name = sectionMatch[1]!.trim().replace(/^profile\s+/, "");
      current = sections[name] = sections[name] ?? {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0 && current) {
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key) current[key] = value;
    }
  }
  return sections;
}

/** Resolve a named profile's region/keys from parsed credentials + config files. The
 *  credentials file is authoritative for keys; region can live in either, credentials wins. */
export function resolveAwsProfile(
  profile: string,
  credentialsIni: Record<string, Record<string, string>>,
  configIni: Record<string, Record<string, string>>,
): ParsedAwsProfile {
  const cred = credentialsIni[profile] ?? {};
  const cfg = configIni[profile] ?? {};
  return {
    region: cred["region"] || cfg["region"] || undefined,
    accessKeyId: cred["aws_access_key_id"] || undefined,
    secretAccessKey: cred["aws_secret_access_key"] || undefined,
    sessionToken: cred["aws_session_token"] || undefined,
  };
}

/**
 * Resolve AWS credentials from environment variables — the shape every AWS SDK/CLI honors and
 * the highest-precedence fallback after an explicitly stored credential. Returns undefined
 * unless both the access key id and secret are present (a lone `AWS_REGION` isn't "credentials"
 * on its own, but is still picked up by the profile-file path below via {@link resolveAwsProfile}).
 */
export function resolveAwsEnvCredentials(env: NodeJS.ProcessEnv): ParsedAwsProfile | undefined {
  const accessKeyId = env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = env["AWS_SECRET_ACCESS_KEY"];
  if (!accessKeyId || !secretAccessKey) return undefined;
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: env["AWS_SESSION_TOKEN"] || undefined,
    region: env["AWS_REGION"] || env["AWS_DEFAULT_REGION"] || undefined,
  };
}
