import { describe, expect, it } from "vitest";
import type { Octokit } from "@octokit/rest";
import { GitHubAdapter } from "../src/adapters/github.js";

/** A stand-in Octokit that answers 304 when the ETag it last gave comes back and the data is unchanged. */
function stub() {
  let pulls = [{ number: 1, title: "a", body: "", head: { sha: "h1" }, base: { sha: "b" }, user: { id: 5, login: "u5" }, state: "open", draft: false, merged: false, created_at: "2026-10-12T00:00:00Z" }];
  let version = 1, calls = 0, served304 = 0;
  const list = async (params: { headers?: Record<string, string> }) => {
    calls++;
    const etag = `"v${version}"`;
    if (params.headers?.["if-none-match"] === etag) { served304++; const e = new Error("Not Modified") as Error & { status: number }; e.status = 304; throw e; }
    return { data: pulls, headers: { etag, "x-ratelimit-remaining": "4999" } };
  };
  const octokit = { pulls: { list, listReviews: async () => ({ data: [], headers: {} }) }, issues: {}, paginate: async () => [] } as unknown as Octokit;
  return { octokit, stats: () => ({ calls, served304 }), change: () => { version++; pulls = [...pulls, { ...pulls[0]!, number: 2, head: { sha: "h2" } }]; } };
}

describe("github adapter conditional requests", () => {
  it("reuses an unchanged answer on 304, refetches when the ETag moves, and tracks the rate limit", async () => {
    const s = stub();
    const gh = new GitHubAdapter("o", "r", s.octokit);
    expect((await gh.listOpenPulls()).map((p) => p.number)).toEqual([1]);
    expect(gh.rateLimitRemaining).toBe(4999);
    expect((await gh.listOpenPulls()).map((p) => p.number)).toEqual([1]);
    expect((await gh.listOpenPulls()).map((p) => p.number)).toEqual([1]);
    expect(s.stats()).toEqual({ calls: 3, served304: 2 });
    s.change();
    expect((await gh.listOpenPulls()).map((p) => p.number)).toEqual([1, 2]);
    expect(s.stats().served304).toBe(2);
    expect((await gh.listOpenPulls()).length).toBe(2);
    expect(s.stats().served304).toBe(3);
  });
});
