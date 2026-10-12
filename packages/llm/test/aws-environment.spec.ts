import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBedrockCredentialsFromEnvironment } from "@blacksite-agent/llm/node";

describe("resolveBedrockCredentialsFromEnvironment", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "llm-aws-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  function writeAws(file: "credentials" | "config", text: string): void {
    fs.mkdirSync(path.join(home, ".aws"), { recursive: true });
    fs.writeFileSync(path.join(home, ".aws", file), text);
  }

  it("reads the default profile from ~/.aws when the environment has nothing", () => {
    writeAws("credentials", "[default]\naws_access_key_id = AKIA_FILE\naws_secret_access_key = file-secret\n");
    writeAws("config", "[default]\nregion = eu-west-1\n");
    expect(resolveBedrockCredentialsFromEnvironment({}, home)).toEqual({
      region: "eu-west-1", accessKeyId: "AKIA_FILE", secretAccessKey: "file-secret", sessionToken: undefined,
    });
  });

  it("uses AWS_PROFILE to pick a named profile", () => {
    writeAws("credentials", "[work]\naws_access_key_id = AKIA_WORK\naws_secret_access_key = work-secret\n");
    writeAws("config", "[profile work]\nregion = us-west-2\n");
    expect(resolveBedrockCredentialsFromEnvironment({ AWS_PROFILE: "work" }, home)).toMatchObject({ accessKeyId: "AKIA_WORK", region: "us-west-2" });
  });

  it("lets environment keys win while still taking the region from the profile", () => {
    writeAws("config", "[default]\nregion = ap-south-1\n");
    const env = { AWS_ACCESS_KEY_ID: "AKIA_ENV", AWS_SECRET_ACCESS_KEY: "env-secret", AWS_SESSION_TOKEN: "tok" };
    expect(resolveBedrockCredentialsFromEnvironment(env, home)).toEqual({
      region: "ap-south-1", accessKeyId: "AKIA_ENV", secretAccessKey: "env-secret", sessionToken: "tok",
    });
  });

  it("returns undefined instead of throwing when nothing is configured", () => {
    expect(resolveBedrockCredentialsFromEnvironment({}, home)).toBeUndefined();
  });
});
