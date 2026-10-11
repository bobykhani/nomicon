/**
 * In-memory adapters for tests and for the Phase 3 simulation. They model
 * just enough of GitHub and the chain for the rules to be exercised.
 */
import type { ChainPort, Clock, FinalizedBlock, GitHubPort, PriceOracle, PullCommit, PullInfo, ScreenDecision, ScreenInput, ScreenPort } from "../ports.js";
import type { ChangedFile } from "../paths.js";
import type { Review } from "../tally.js";
import { createHash } from "node:crypto";

export class FakeClock implements Clock {
  constructor(public t: number) {}
  now(): number { return this.t; }
  advance(seconds: number): void { this.t += seconds; }
}

export interface FakePull extends PullInfo {
  mergeCommit?: string;
  files: ChangedFile[];
  contents: Record<string, string>;
  commits: PullCommit[];
  reviews: Review[];
  comments: string[];
}

export class FakeGitHub implements GitHubPort {
  pulls = new Map<number, FakePull>();
  /** Files at the base branch; merges add to it. */
  repoFiles: Record<string, string> = { "README.md": "# Nomicon", "LAWS.md": "# Laws", "world/README.md": "# World" };
  get basePaths(): string[] { return Object.keys(this.repoFiles); }
  published: Array<{ path: string; content: string }> = [];
  merges: Array<{ pr: number; head: string }> = [];
  private seq = 0;
  constructor(private clock: Clock) {}

  open(author: { id: number; login: string }, files: Record<string, string>, over: Partial<FakePull> = {}): FakePull {
    const n = ++this.seq;
    const head = createHash("sha1").update(`pr${n}:${JSON.stringify(files)}:${this.clock.now()}`).digest("hex");
    const changed: ChangedFile[] = Object.entries(files).map(([path, content]) => ({ path, status: "added", mode: "100644", bytesChanged: Buffer.byteLength(content), sizeAfter: Buffer.byteLength(content) }));
    const pull: FakePull = {
      number: n, title: `pr ${n}`, body: "", headSha: head, baseSha: "base", author, state: "open", draft: false, merged: false, createdAt: this.clock.now(),
      files: changed, contents: files, commits: [{ sha: head, signedOff: true, authorId: author.id }], reviews: [], comments: [], ...over,
    };
    this.pulls.set(n, pull);
    return pull;
  }
  review(pr: number, account: number, state: Review["state"], at = this.clock.now()): void {
    const p = this.pulls.get(pr)!;
    p.reviews.push({ reviewId: pr * 1000 + p.reviews.length + 1, account, login: `u${account}`, state, submittedAt: at });
  }
  push(pr: number): void { const p = this.pulls.get(pr)!; p.headSha = createHash("sha1").update(p.headSha + "push").digest("hex"); }

  async listOpenPulls(): Promise<PullInfo[]> { return [...this.pulls.values()].filter((p) => p.state === "open"); }
  async getPull(n: number): Promise<PullInfo> { return this.pulls.get(n)!; }
  async listFiles(n: number): Promise<ChangedFile[]> { return this.pulls.get(n)!.files; }
  async listCommits(n: number): Promise<PullCommit[]> { return this.pulls.get(n)!.commits; }
  async listReviews(n: number): Promise<Review[]> { return this.pulls.get(n)!.reviews; }
  async listPaths(): Promise<string[]> { return this.basePaths; }
  async readFile(ref: string, path: string): Promise<string> {
    for (const p of this.pulls.values()) if ((p.headSha === ref || p.mergeCommit === ref) && p.contents[path] !== undefined) return p.contents[path]!;
    if (this.repoFiles[path] !== undefined) return this.repoFiles[path]!;
    for (const p of this.pulls.values()) if (p.contents[path] !== undefined) return p.contents[path]!;
    return "";
  }
  async comment(n: number, body: string): Promise<void> { this.pulls.get(n)!.comments.push(body); }
  async merge(n: number, headSha: string): Promise<string | null> {
    const p = this.pulls.get(n)!;
    if (p.headSha !== headSha || p.state !== "open") return null;
    p.state = "closed"; p.merged = true; this.merges.push({ pr: n, head: headSha });
    for (const [path, content] of Object.entries(p.contents)) this.repoFiles[path] = content;
    p.mergeCommit = createHash("sha1").update("merge" + headSha).digest("hex");
    return p.mergeCommit;
  }
  async close(n: number): Promise<void> { this.pulls.get(n)!.state = "closed"; }
  async publishLedger(files: Array<{ path: string; content: string }>): Promise<void> { this.published = files; }
}

export class FakeChain implements ChainPort {
  anchors: string[] = [];
  constructor(private clock: Clock, private finalityLag = 60) {}
  async firstFinalizedBlockAfter(ts: number): Promise<FinalizedBlock | null> {
    if (this.clock.now() - ts < this.finalityLag) return null;
    const number = BigInt(Math.floor((ts + 2) / 2));
    return { number, hash: createHash("sha256").update("block" + number.toString()).digest("hex"), timestamp: ts + 2 };
  }
  async transactionInfo(txHash: string): Promise<{ blockNumber: bigint; blockTime: number } | null> {
    return { blockNumber: BigInt(parseInt(txHash.slice(2, 10), 16) || 1), blockTime: this.clock.now() };
  }
  async anchor(hashHex: string): Promise<string> { this.anchors.push(hashHex); return "0x" + createHash("sha256").update("anchor" + hashHex).digest("hex"); }
}

export class FakeScreen implements ScreenPort {
  constructor(private holdIf: (input: ScreenInput) => ScreenDecision | null = () => null) {}
  async screen(input: ScreenInput): Promise<ScreenDecision> { return this.holdIf(input) ?? { decision: "pass" }; }
}

export class FixedOracle implements PriceOracle { async usdcToCad(): Promise<string> { return "1.37"; } }
