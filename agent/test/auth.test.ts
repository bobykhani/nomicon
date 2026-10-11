import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitHubAuthEnv } from "../src/adapters/auth.js";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";

describe("github auth configuration", () => {
  it("prefers the App when GITHUB_APP_ID is set, reading the key inline or from a path", () => {
    expect(parseGitHubAuthEnv({ GITHUB_APP_ID: "12", GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_TOKEN: "ghp_x" })).toEqual({ kind: "app", appId: 12, privateKey: PEM });
    const dir = mkdtempSync(join(tmpdir(), "nomicon-auth-"));
    const path = join(dir, "key.pem");
    writeFileSync(path, PEM);
    expect(parseGitHubAuthEnv({ GITHUB_APP_ID: "12", GITHUB_APP_PRIVATE_KEY: path, GITHUB_APP_INSTALLATION_ID: "77" })).toEqual({ kind: "app", appId: 12, privateKey: PEM, installationId: 77 });
  });
  it("falls back to a token and explains what is missing", () => {
    expect(parseGitHubAuthEnv({ GITHUB_TOKEN: "ghp_x" })).toEqual({ kind: "token", token: "ghp_x" });
    expect(() => parseGitHubAuthEnv({})).toThrow(/GITHUB_APP_ID/);
    expect(() => parseGitHubAuthEnv({ GITHUB_APP_ID: "12" })).toThrow(/PRIVATE_KEY/);
    expect(() => parseGitHubAuthEnv({ GITHUB_APP_ID: "12", GITHUB_APP_PRIVATE_KEY: "/no/such/file.pem" })).toThrow(/neither/);
    expect(() => parseGitHubAuthEnv({ GITHUB_APP_ID: "abc", GITHUB_APP_PRIVATE_KEY: PEM })).toThrow(/numeric/);
  });
});
