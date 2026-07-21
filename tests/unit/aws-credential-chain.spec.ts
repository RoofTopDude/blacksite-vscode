import { describe, expect, it } from "vitest";
import { parseAwsIniFile, resolveAwsEnvCredentials, resolveAwsProfile } from "../../src/aws-credential-chain.js";

// AWS credential chain: env vars, then a named profile in ~/.aws/{credentials,config} — the
// same precedence every AWS SDK/CLI uses, so Bedrock stops being static-keys-only for anyone
// who already `aws configure`'d or exports AWS_* vars for other tools.

describe("parseAwsIniFile", () => {
  it("parses [default] and named sections from a credentials file", () => {
    const text = [
      "[default]",
      "aws_access_key_id = AKIADEFAULT",
      "aws_secret_access_key = secretdefault",
      "",
      "[work]",
      "aws_access_key_id = AKIAWORK",
      "aws_secret_access_key = secretwork",
      "aws_session_token = tokenwork",
    ].join("\n");
    const parsed = parseAwsIniFile(text);
    expect(parsed["default"]).toEqual({ aws_access_key_id: "AKIADEFAULT", aws_secret_access_key: "secretdefault" });
    expect(parsed["work"]).toEqual({ aws_access_key_id: "AKIAWORK", aws_secret_access_key: "secretwork", aws_session_token: "tokenwork" });
  });

  it("normalizes '[profile name]' (as used in ~/.aws/config) to the bare profile name", () => {
    const text = ["[profile work]", "region = us-west-2"].join("\n");
    const parsed = parseAwsIniFile(text);
    expect(parsed["work"]).toEqual({ region: "us-west-2" });
    expect(parsed["profile work"]).toBeUndefined();
  });

  it("does not treat '[default]' in ~/.aws/config as 'profile default'", () => {
    // Only non-default profiles get the "profile " prefix in config; [default] never does.
    const text = ["[default]", "region = us-east-1"].join("\n");
    expect(parseAwsIniFile(text)["default"]).toEqual({ region: "us-east-1" });
  });

  it("ignores blank lines and comments", () => {
    const text = ["# a comment", "; another comment", "", "[default]", "region = us-east-1"].join("\n");
    expect(parseAwsIniFile(text)["default"]).toEqual({ region: "us-east-1" });
  });

  it("returns an empty object for empty input", () => {
    expect(parseAwsIniFile("")).toEqual({});
  });

  it("tolerates a value containing '=' (e.g. base64-ish tokens)", () => {
    const text = ["[default]", "aws_session_token = abc=def=ghi"].join("\n");
    expect(parseAwsIniFile(text)["default"]?.["aws_session_token"]).toBe("abc=def=ghi");
  });
});

describe("resolveAwsProfile", () => {
  it("prefers the credentials file for keys, falling back to config for region", () => {
    const credentialsIni = { work: { aws_access_key_id: "AKIA1", aws_secret_access_key: "secret1" } };
    const configIni = { work: { region: "eu-west-1" } };
    expect(resolveAwsProfile("work", credentialsIni, configIni)).toEqual({
      region: "eu-west-1",
      accessKeyId: "AKIA1",
      secretAccessKey: "secret1",
      sessionToken: undefined,
    });
  });

  it("credentials-file region wins over config-file region when both are present", () => {
    const credentialsIni = { work: { region: "us-east-1", aws_access_key_id: "AKIA1", aws_secret_access_key: "s1" } };
    const configIni = { work: { region: "eu-west-1" } };
    expect(resolveAwsProfile("work", credentialsIni, configIni).region).toBe("us-east-1");
  });

  it("returns an all-undefined result for a profile present in neither file", () => {
    expect(resolveAwsProfile("missing", {}, {})).toEqual({
      region: undefined, accessKeyId: undefined, secretAccessKey: undefined, sessionToken: undefined,
    });
  });
});

describe("resolveAwsEnvCredentials", () => {
  it("resolves full credentials including session token and region", () => {
    const env = {
      AWS_ACCESS_KEY_ID: "AKIAENV",
      AWS_SECRET_ACCESS_KEY: "secretenv",
      AWS_SESSION_TOKEN: "tokenenv",
      AWS_REGION: "ap-southeast-2",
    };
    expect(resolveAwsEnvCredentials(env)).toEqual({
      accessKeyId: "AKIAENV", secretAccessKey: "secretenv", sessionToken: "tokenenv", region: "ap-southeast-2",
    });
  });

  it("falls back to AWS_DEFAULT_REGION when AWS_REGION is unset", () => {
    const env = { AWS_ACCESS_KEY_ID: "AKIAENV", AWS_SECRET_ACCESS_KEY: "secretenv", AWS_DEFAULT_REGION: "us-west-1" };
    expect(resolveAwsEnvCredentials(env)?.region).toBe("us-west-1");
  });

  it("returns undefined when only one of the key pair is set", () => {
    expect(resolveAwsEnvCredentials({ AWS_ACCESS_KEY_ID: "AKIAENV" })).toBeUndefined();
    expect(resolveAwsEnvCredentials({ AWS_SECRET_ACCESS_KEY: "secretenv" })).toBeUndefined();
  });

  it("returns undefined for a completely empty environment", () => {
    expect(resolveAwsEnvCredentials({})).toBeUndefined();
  });

  it("resolves the key pair without requiring a region — region is optional here by design", () => {
    // secret-store.ts's _resolveBedrockCredentialsFromEnvironment combines this result's
    // region independently from its keys (falling back to the profile file's region when
    // env has none); a prior version required envCreds.region truthy before trusting the env
    // key pair at all, silently dropping valid env credentials whenever the user's region
    // lived only in ~/.aws/config.
    const env = { AWS_ACCESS_KEY_ID: "AKIAENV", AWS_SECRET_ACCESS_KEY: "secretenv" };
    expect(resolveAwsEnvCredentials(env)).toEqual({
      accessKeyId: "AKIAENV", secretAccessKey: "secretenv", sessionToken: undefined, region: undefined,
    });
  });
});

describe("credential-chain composition (mirrors secret-store.ts's _resolveBedrockCredentialsFromEnvironment)", () => {
  // secret-store.ts isn't unit-tested directly (it depends on vscode/fs — see the file's doc
  // comment), so this pins the composition contract at the pure-function boundary it's built on:
  // env keys and profile-file keys never mix, but region resolves independently of which side
  // supplied the keys, matching AWS's own precedence (env wins, per field).
  function resolveBedrockCredentials(
    env: NodeJS.ProcessEnv,
    profile: string,
    credentialsIni: Record<string, Record<string, string>>,
    configIni: Record<string, Record<string, string>>,
  ) {
    const envCreds = resolveAwsEnvCredentials(env);
    const resolved = resolveAwsProfile(profile, credentialsIni, configIni);
    const accessKeyId = envCreds?.accessKeyId || resolved.accessKeyId;
    const secretAccessKey = envCreds?.secretAccessKey || resolved.secretAccessKey;
    const sessionToken = envCreds?.sessionToken || resolved.sessionToken;
    const region = envCreds?.region || resolved.region;
    return accessKeyId && secretAccessKey && region ? { region, accessKeyId, secretAccessKey, sessionToken } : undefined;
  }

  it("combines env keys with a profile-file-only region instead of dropping the env keys", () => {
    const env = { AWS_ACCESS_KEY_ID: "AKIAENV", AWS_SECRET_ACCESS_KEY: "secretenv" };
    const configIni = { default: { region: "us-east-1" } };
    expect(resolveBedrockCredentials(env, "default", {}, configIni)).toEqual({
      region: "us-east-1", accessKeyId: "AKIAENV", secretAccessKey: "secretenv", sessionToken: undefined,
    });
  });

  it("falls back to the profile-file region when env supplies no credentials at all", () => {
    const credentialsIni = { default: { aws_access_key_id: "AKIAFILE", aws_secret_access_key: "secretfile" } };
    const configIni = { default: { region: "eu-west-1" } };
    expect(resolveBedrockCredentials({}, "default", credentialsIni, configIni)?.region).toBe("eu-west-1");
  });

  it("prefers env keys over profile-file keys when both are present", () => {
    const env = { AWS_ACCESS_KEY_ID: "AKIAENV", AWS_SECRET_ACCESS_KEY: "secretenv", AWS_REGION: "ap-southeast-2" };
    const credentialsIni = { default: { aws_access_key_id: "AKIAFILE", aws_secret_access_key: "secretfile" } };
    expect(resolveBedrockCredentials(env, "default", credentialsIni, {})).toEqual({
      region: "ap-southeast-2", accessKeyId: "AKIAENV", secretAccessKey: "secretenv", sessionToken: undefined,
    });
  });

  it("returns undefined when no source supplies a region at all", () => {
    const env = { AWS_ACCESS_KEY_ID: "AKIAENV", AWS_SECRET_ACCESS_KEY: "secretenv" };
    expect(resolveBedrockCredentials(env, "default", {}, {})).toBeUndefined();
  });
});
