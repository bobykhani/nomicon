import { Octokit } from "@octokit/rest";
import type { GitHubPort, PullCommit, PullInfo } from "../ports.js";
import type { ChangedFile } from "../paths.js";
import type { Review } from "../tally.js";

const SIGNOFF = /^Signed-off-by: .+ <.+@.+>$/m;

/** Bytes of added lines per file, from a unified diff. */
export function bytesChangedByFile(diff: string): Map<string, number> {
  const out = new Map<string, number>();
  let current: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = m ? m[2]! : null;
      if (current && !out.has(current)) out.set(current, 0);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) out.set(current, (out.get(current) ?? 0) + Buffer.byteLength(line.slice(1), "utf8") + 1);
  }
  return out;
}

export class GitHubAdapter implements GitHubPort {
  private octokit: Octokit;
  constructor(private owner: string, private repo: string, auth: string, private ledgerBranch = "main") {
    this.octokit = new Octokit({ auth });
  }

  private toInfo(p: { number: number; title: string; body: string | null; head: { sha: string }; base: { sha: string }; user: { id: number; login: string } | null; state: string; draft?: boolean; merged?: boolean | null; created_at: string }): PullInfo {
    return {
      number: p.number, title: p.title, body: p.body ?? "", headSha: p.head.sha, baseSha: p.base.sha,
      author: { id: p.user?.id ?? 0, login: p.user?.login ?? "" },
      state: p.state === "open" ? "open" : "closed", draft: !!p.draft, merged: !!p.merged,
      createdAt: Math.floor(Date.parse(p.created_at) / 1000),
    };
  }

  async listOpenPulls(): Promise<PullInfo[]> {
    const pulls = await this.octokit.paginate(this.octokit.pulls.list, { owner: this.owner, repo: this.repo, state: "open", per_page: 100 });
    return pulls.map((p) => this.toInfo(p));
  }

  async getPull(n: number): Promise<PullInfo> {
    const { data } = await this.octokit.pulls.get({ owner: this.owner, repo: this.repo, pull_number: n });
    return this.toInfo(data);
  }

  async listFiles(n: number): Promise<ChangedFile[]> {
    const files = await this.octokit.paginate(this.octokit.pulls.listFiles, { owner: this.owner, repo: this.repo, pull_number: n, per_page: 100 });
    const pr = await this.octokit.pulls.get({ owner: this.owner, repo: this.repo, pull_number: n });
    const tree = await this.octokit.git.getTree({ owner: this.owner, repo: this.repo, tree_sha: pr.data.head.sha, recursive: "1" });
    const modes = new Map<string, { mode: string; size: number }>();
    for (const t of tree.data.tree) if (t.path) modes.set(t.path, { mode: t.mode ?? "100644", size: t.size ?? 0 });
    const diffResp = await this.octokit.pulls.get({ owner: this.owner, repo: this.repo, pull_number: n, mediaType: { format: "diff" } });
    const bytes = bytesChangedByFile(diffResp.data as unknown as string);
    return files.map((f) => {
      const m = modes.get(f.filename);
      const entry: ChangedFile = {
        path: f.filename,
        status: f.status as ChangedFile["status"],
        bytesChanged: bytes.get(f.filename) ?? 0,
        sizeAfter: f.status === "removed" ? 0 : (m?.size ?? 0),
      };
      if (m?.mode) entry.mode = m.mode;
      if (f.previous_filename) entry.previousPath = f.previous_filename;
      return entry;
    });
  }

  async listCommits(n: number): Promise<PullCommit[]> {
    const commits = await this.octokit.paginate(this.octokit.pulls.listCommits, { owner: this.owner, repo: this.repo, pull_number: n, per_page: 100 });
    return commits.map((c) => {
      const out: PullCommit = { sha: c.sha, signedOff: SIGNOFF.test(c.commit.message) };
      if (c.author?.id) out.authorId = c.author.id;
      if (c.committer?.id) out.committerId = c.committer.id;
      return out;
    });
  }

  async listReviews(n: number): Promise<Review[]> {
    const reviews = await this.octokit.paginate(this.octokit.pulls.listReviews, { owner: this.owner, repo: this.repo, pull_number: n, per_page: 100 });
    return reviews.map((r) => ({
      reviewId: r.id, account: r.user?.id ?? 0, login: r.user?.login ?? "",
      state: r.state as Review["state"],
      submittedAt: r.submitted_at ? Math.floor(Date.parse(r.submitted_at) / 1000) : 0,
    }));
  }

  async listPaths(ref: string): Promise<string[]> {
    const tree = await this.octokit.git.getTree({ owner: this.owner, repo: this.repo, tree_sha: ref, recursive: "1" });
    return tree.data.tree.filter((t) => t.type === "blob" && t.path).map((t) => t.path!);
  }

  async readFile(ref: string, path: string): Promise<string> {
    const { data } = await this.octokit.repos.getContent({ owner: this.owner, repo: this.repo, path, ref });
    if (Array.isArray(data) || data.type !== "file") throw new Error(`${path} is not a file`);
    return Buffer.from(data.content, "base64").toString("utf8");
  }

  async comment(n: number, body: string): Promise<void> {
    await this.octokit.issues.createComment({ owner: this.owner, repo: this.repo, issue_number: n, body });
  }

  async merge(n: number, headSha: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.pulls.merge({ owner: this.owner, repo: this.repo, pull_number: n, sha: headSha, merge_method: "merge" });
      return data.merged ? data.sha : null;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 405 || status === 409) return null;
      throw e;
    }
  }

  async close(n: number): Promise<void> {
    await this.octokit.pulls.update({ owner: this.owner, repo: this.repo, pull_number: n, state: "closed" });
  }

  async publishLedger(files: Array<{ path: string; content: string }>, message: string): Promise<void> {
    for (const f of files) {
      let sha: string | undefined;
      try {
        const { data } = await this.octokit.repos.getContent({ owner: this.owner, repo: this.repo, path: f.path, ref: this.ledgerBranch });
        if (!Array.isArray(data) && data.type === "file") sha = data.sha;
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e;
      }
      const params: Parameters<Octokit["repos"]["createOrUpdateFileContents"]>[0] = {
        owner: this.owner, repo: this.repo, path: f.path, message, branch: this.ledgerBranch,
        content: Buffer.from(f.content, "utf8").toString("base64"),
      };
      if (sha) params.sha = sha;
      await this.octokit.repos.createOrUpdateFileContents(params);
    }
  }
}
