/*
  The AWS credential chain's Node half: environment variables, then the active profile in
  ~/.aws/{credentials,config}. The parsing it relies on is in the runtime-neutral core.
*/
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAwsIniFile, resolveAwsEnvCredentials, resolveAwsProfile } from "../aws-credential-chain.js";
import type { BedrockCredentials } from "../bedrock-types.js";

/** Environment vars, then `~/.aws/{credentials,config}` for the active/default profile.
 *  Never throws — a missing/malformed AWS config file is a normal "not set up" state here,
 *  not an error. */
export function resolveBedrockCredentialsFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = os.homedir(),
): BedrockCredentials | undefined {
  const envCreds = resolveAwsEnvCredentials(env);

  const profileName = env["AWS_PROFILE"] || "default";
  const readIni = (p: string): Record<string, Record<string, string>> => {
    try { return parseAwsIniFile(fs.readFileSync(p, "utf8")); } catch { return {}; }
  };
  const credentialsIni = readIni(path.join(home, ".aws", "credentials"));
  const configIni = readIni(path.join(home, ".aws", "config"));
  const resolved = resolveAwsProfile(profileName, credentialsIni, configIni);

  // AWS precedence: env credentials win over profile-file credentials, and env region wins
  // over profile-file region — resolved independently, so e.g. env keys with a
  // profile-file-only region (or a region-only env var with profile-file keys) still combine
  // into a full config instead of one missing field silently discarding the other source.
  const accessKeyId = envCreds?.accessKeyId || resolved.accessKeyId;
  const secretAccessKey = envCreds?.secretAccessKey || resolved.secretAccessKey;
  const sessionToken = envCreds?.sessionToken || resolved.sessionToken;
  const region = envCreds?.region || resolved.region;
  if (accessKeyId && secretAccessKey && region) {
    return { region, accessKeyId, secretAccessKey, sessionToken };
  }
  return undefined;
}
