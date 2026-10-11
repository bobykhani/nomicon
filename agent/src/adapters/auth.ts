/**
 * How the agent authenticates to GitHub: as a GitHub App installation in
 * production (its own bot identity, short-lived tokens, no personal token
 * on the server) or with a personal token for local testing.
 */
import { existsSync, readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

export type GitHubAuthConfig =
  | { kind: "token"; token: string }
  | { kind: "app"; appId: number; privateKey: string; installationId?: number };

export interface GitHubIdentity { id: number; login: string }

/** GITHUB_APP_ID selects App auth; GITHUB_APP_PRIVATE_KEY is a PEM or a path to one; GITHUB_TOKEN is the fallback. */
export function parseGitHubAuthEnv(e: Record<string, string | undefined>): GitHubAuthConfig {
  const appId = e["GITHUB_APP_ID"];
  if (appId) {
    const key = e["GITHUB_APP_PRIVATE_KEY"];
    if (!key) throw new Error("GITHUB_APP_ID is set but GITHUB_APP_PRIVATE_KEY is not");
    let privateKey: string;
    if (key.includes("-----BEGIN")) privateKey = key;
    else if (existsSync(key)) privateKey = readFileSync(key, "utf8");
    else throw new Error("GITHUB_APP_PRIVATE_KEY is neither a PEM nor a readable path");
    if (!/^\d+$/.test(appId)) throw new Error("GITHUB_APP_ID must be numeric");
    const inst = e["GITHUB_APP_INSTALLATION_ID"];
    return { kind: "app", appId: Number(appId), privateKey, ...(inst ? { installationId: Number(inst) } : {}) };
  }
  const token = e["GITHUB_TOKEN"];
  if (!token) throw new Error("set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN");
  return { kind: "token", token };
}

/** An Octokit for the configuration and the identity it acts as. For an App, the installation on the repository is resolved when not given. */
export async function octokitFor(cfg: GitHubAuthConfig, owner: string, repo: string): Promise<{ octokit: Octokit; identity: GitHubIdentity }> {
  if (cfg.kind === "token") {
    const octokit = new Octokit({ auth: cfg.token });
    const { data } = await octokit.users.getAuthenticated();
    return { octokit, identity: { id: data.id, login: data.login } };
  }
  const appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId: cfg.appId, privateKey: cfg.privateKey } });
  const { data: app } = await appOctokit.apps.getAuthenticated();
  if (!app?.slug) throw new Error("GitHub App could not be read with the given id and key");
  let installationId = cfg.installationId;
  if (!installationId) {
    const { data } = await appOctokit.apps.getRepoInstallation({ owner, repo });
    installationId = data.id;
  }
  const octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId: cfg.appId, privateKey: cfg.privateKey, installationId } });
  const { data: bot } = await octokit.users.getByUsername({ username: `${app.slug}[bot]` });
  return { octokit, identity: { id: bot.id, login: bot.login } };
}
