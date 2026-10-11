/**
 * Law 12 runtime duties: doorbell registration and delivery, watcher
 * detection, and the weekly digest. Doorbell URLs never enter the ledger;
 * only their hashes and every delivery attempt do.
 */
import type { Ledger, LedgerEvent } from "./ledger.js";
import type { Laws } from "./laws.js";
import type { Clock, DoorbellPort, DoorbellStore, GitHubPort, IssueComment } from "./ports.js";
import type { State } from "./state.js";
import { DOORBELL_RE, buildDigest, targetsOf, urlHash } from "./notify.js";

export interface NotifierDeps {
  github: GitHubPort;
  doorbell: DoorbellPort;
  store: DoorbellStore;
  ledger: Ledger;
  clock: Clock;
  log: (m: string) => void;
  /** Issue number accounts comment on to register a doorbell; null disables registration. */
  doorbellIssue: number | null;
}

const serialize = (e: LedgerEvent) => JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

export class Notifier {
  private lastWatchPoll = 0;
  private lastDigestAttempt = 0;
  constructor(private d: NotifierDeps) {}

  /** Read the doorbell issue; the latest valid comment per account wins. */
  async pollRegistrations(now: number): Promise<void> {
    if (this.d.doorbellIssue === null) return;
    let comments: IssueComment[];
    try { comments = await this.d.github.listIssueComments(this.d.doorbellIssue); } catch (e) { this.d.log(`doorbell issue unreadable: ${(e as Error).message}`); return; }
    const data = this.d.store.load();
    let changed = false;
    const latest = new Map<number, { login: string; value: string; comment: number }>();
    for (const c of comments) { const m = DOORBELL_RE.exec(c.body); if (m && c.account) latest.set(c.account, { login: c.login, value: m[1]!, comment: c.id }); }
    for (const [account, { login, value, comment }] of latest) {
      const cur = data.doorbells[account];
      if (cur && cur.comment === comment) continue;
      if (value.toLowerCase() === "off") {
        if (cur && cur.url !== "") { data.doorbells[account] = { ...cur, url: "", retired: true, comment }; changed = true; this.d.ledger.append(now, "channel", { account, login, channel: "doorbell", status: "off" }); }
        continue;
      }
      {
        data.doorbells[account] = { account, login, url: value, failures: 0, retired: false, registeredAt: now, comment };
        changed = true;
        this.d.ledger.append(now, "channel", { account, login, channel: "doorbell", status: "active", url_hash: urlHash(value) });
      }
    }
    if (changed) this.d.store.save(data);
  }

  /** Record accounts that watch the repository, at most once per account. */
  async pollWatchers(now: number, laws: Laws, state: State): Promise<void> {
    if (now - this.lastWatchPoll < laws.notices.watch_poll_every_hours * 3600) return;
    this.lastWatchPoll = now;
    let watchers: Array<{ id: number; login: string }>;
    try { watchers = await this.d.github.listWatchers(); } catch (e) { this.d.log(`watchers unreadable: ${(e as Error).message}`); return; }
    for (const w of watchers) if (!state.channels[w.id]?.watch) this.d.ledger.append(now, "channel", { account: w.id, login: w.login, channel: "watch", status: "active" });
  }

  /** Post the digest when due. A failed post is retried an hour later, not recorded. */
  async maybeDigest(now: number, laws: Laws, state: State, events: LedgerEvent[]): Promise<void> {
    const last = [...events].reverse().find((e) => e.type === "digest" || e.type === "genesis");
    if (last && now - last.at < laws.notices.digest_every_days * 86400) return;
    if (now - this.lastDigestAttempt < 3600) return;
    this.lastDigestAttempt = now;
    const d = buildDigest({ events, state, now, laws, days: laws.notices.digest_every_days });
    try {
      const url = await this.d.github.postDiscussion(d.title, d.body);
      this.d.ledger.append(now, "digest", { url, ...d.counts });
    } catch (e) { this.d.log(`digest not posted: ${(e as Error).message}`); }
  }

  /** Deliver every new event to the doorbells of the accounts it concerns. */
  async deliver(now: number, laws: Laws, state: State, events: LedgerEvent[]): Promise<void> {
    const data = this.d.store.load();
    const pending = events.filter((e) => e.id > data.lastDelivered);
    if (pending.length === 0) return;
    for (const e of pending) {
      if (e.type === "notice" && e["kind"] === "doorbell") continue;
      for (const account of targetsOf(e, state)) {
        const bell = data.doorbells[account];
        if (!bell || bell.retired || !bell.url || e.at < bell.registeredAt) continue;
        let ok = false, status = 0;
        for (let attempt = 0; attempt <= laws.notices.doorbell_retries && !ok; attempt++) {
          const r = await this.d.doorbell.deliver(bell.url, serialize({ ...e }));
          ok = r.ok; status = r.status;
        }
        bell.failures = ok ? 0 : bell.failures + 1;
        this.d.ledger.append(now, "notice", { kind: "doorbell", target: account, pr: e["pr"] ?? null, about: e.id, ok, status });
        if (!ok && bell.failures >= laws.notices.doorbell_retire_after_failures) {
          bell.retired = true;
          this.d.ledger.append(now, "channel", { account, login: bell.login, channel: "doorbell", status: "retired", url_hash: urlHash(bell.url) });
          if (this.d.doorbellIssue !== null) {
            try { await this.d.github.comment(this.d.doorbellIssue, `@${bell.login} your doorbell stopped answering and was retired after ${bell.failures} failed deliveries. Post a new address to register again.`); } catch { /* best effort */ }
          }
        }
      }
    }
    data.lastDelivered = pending[pending.length - 1]!.id;
    this.d.store.save(data);
  }
}
