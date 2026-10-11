/**
 * Phase 3 harness: the real runtime driven by in-memory adapters on a fake clock.
 * Every scenario gets a fresh signed ledger and ends with a replay check.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime } from "../runtime.js";
import { Ledger, Signer, type LedgerEvent } from "../ledger.js";
import { FakeChain, FakeClock, FakeDoorbell, FakeGitHub, FakeScreen, FixedOracle, MemoryDoorbellStore, type FakePull } from "../adapters/mock.js";
import { Notifier } from "../notifier.js";
import { phaseOf, type Phase } from "../phases.js";
import { replay } from "../replay.js";
import { parseLaws } from "../laws.js";
import type { ScreenDecision, ScreenInput } from "../ports.js";
import type { State } from "../state.js";
import type { Review } from "../tally.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const rawLaws = readFileSync(resolve(repoRoot, "laws.json"), "utf8");
export const rawSchema = readFileSync(resolve(repoRoot, "laws.schema.json"), "utf8");
export const lawsHash = parseLaws(rawLaws, rawSchema).hash;

export const T0 = 1_800_000_000;
export const H = 3600;
export const DAY = 86400;
export const OWNER = { id: 100, login: "owner" };
export type Account = { id: number; login: string };
export const acct = (id: number, login = `u${id}`): Account => ({ id, login });

export interface Check { claim: string; ok: boolean; detail?: string }

export class Sim {
  clock = new FakeClock(T0);
  github: FakeGitHub;
  chain: FakeChain;
  doorbell = new FakeDoorbell();
  store = new MemoryDoorbellStore();
  readonly doorbellIssue = 9999;
  ledger: Ledger;
  signer: Signer;
  rt: Runtime;
  checks: Check[] = [];
  notes: string[] = [];
  private lawsSource = { rawLaws, rawSchema };

  constructor(opts: { holdIf?: (i: ScreenInput) => ScreenDecision | null } = {}) {
    this.github = new FakeGitHub(this.clock);
    this.github.repoFiles["laws.json"] = rawLaws;
    this.github.repoFiles["laws.schema.json"] = rawSchema;
    this.chain = new FakeChain(this.clock);
    const { privateKey } = generateKeyPairSync("ed25519");
    this.signer = new Signer(privateKey.export({ type: "pkcs8", format: "pem" }) as string);
    this.ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "nomicon-sim-")), "events.jsonl"), this.signer);
    const notifier = new Notifier({ github: this.github, doorbell: this.doorbell, store: this.store, ledger: this.ledger, clock: this.clock, log: (m) => this.notes.push("log: " + m), doorbellIssue: this.doorbellIssue });
    this.rt = new Runtime({
      github: this.github, chain: this.chain, screen: new FakeScreen(opts.holdIf), oracle: new FixedOracle(), clock: this.clock, ledger: this.ledger,
      publicBaseUrl: "https://pay.sim", loadLaws: async () => this.lawsSource, termsCommit: async () => "tt".repeat(20), notifier,
    });
    this.ledger.append(T0, "genesis", { head: "aa".repeat(20), laws_hash: lawsHash, owner_accounts: [OWNER.id], owner_keys: [this.signer.publicKeyPem()], agent_account: 101, fee_destination: "0xdest", network: "eip155:84532" });
    this.ledger.append(T0, "laws_snapshot", { pr: null, laws_hash: lawsHash, laws_raw: rawLaws, schema_raw: rawSchema, effective_at: T0, merge_commit: "aa".repeat(20) });
  }

  check(claim: string, ok: boolean, detail?: string): void { this.checks.push(detail === undefined ? { claim, ok } : { claim, ok, detail }); }
  note(s: string): void { this.notes.push(s); }
  get events(): LedgerEvent[] { return this.ledger.events; }
  eventsFor(pr: number): LedgerEvent[] { return this.events.filter((e) => Number(e["pr"]) === pr); }
  phase(pr: number): Phase { return phaseOf(pr, this.events); }
  state(): State { return this.rt.state(); }
  async tick(): Promise<void> { await this.rt.tick(); }

  /** Advance the clock in steps, ticking the agent at each step as a real deployment would. */
  async advance(seconds: number, step = 6 * H): Promise<void> {
    let left = seconds;
    while (left > 0) { const s = Math.min(step, left); this.clock.advance(s); left -= s; await this.rt.tick(); }
  }

  async submit(author: Account, files: Record<string, string>, over: Partial<FakePull> = {}): Promise<FakePull> {
    const pr = this.github.open(author, files, over);
    await this.tick();
    return pr;
  }

  async pay(pr: number, times = 1n): Promise<boolean> {
    const q = this.rt.quoteFor(pr);
    if (!q) return false;
    await this.rt.onPaid({ pr, tx: "0x" + pr.toString(16).padStart(64, "0"), payer: "0xpayer", amountMicro: q.feeMicro * times, network: "eip155:84532" });
    return true;
  }

  review(pr: number, account: Account, state: Review["state"]): void { this.github.review(pr, account.id, state); }
  confirm(pr: number): void { this.ledger.append(this.clock.now(), "owner_confirm", { pr, reason: "sim", by: OWNER.id }); }
  reject(pr: number, bar = false): void {
    const f: Record<string, unknown> = { pr, reason: "sim", by: OWNER.id };
    if (bar) f["barred_until"] = this.clock.now() + 90 * DAY;
    this.ledger.append(this.clock.now(), "owner_reject", f);
  }
  release(pr: number): void { this.ledger.append(this.clock.now(), "hold_resolved", { pr, decision: "release", reason: "sim", by: OWNER.id }); }
  holdReject(pr: number): void { this.ledger.append(this.clock.now(), "hold_resolved", { pr, decision: "reject", reason: "sim", by: OWNER.id, barred_until: this.clock.now() + 90 * DAY }); }
  endBootstrap(): void { this.ledger.append(this.clock.now(), "declare", { what: "bootstrap_end", reason: "sim", by: OWNER.id }); }

  /** Submit, pay, cast the given votes an hour later, and wait for the window to close. */
  async submitAndVote(author: Account, files: Record<string, string>, votes: Array<[Account, Review["state"]]> = [], windowHours = 72): Promise<FakePull> {
    const pr = await this.submit(author, files);
    await this.pay(pr.number);
    await this.tick();
    if (votes.length) { this.clock.advance(H); for (const [a, s] of votes) this.review(pr.number, a, s); await this.tick(); }
    await this.advance(windowHours * H + 6 * H);
    return pr;
  }

  /** Bootstrap: owner-confirmed founders, each with `mergesEach` merges. */
  async seedFounders(accounts: Account[], opts: { endBootstrap?: boolean; mature?: boolean; mergesEach?: number } = {}): Promise<void> {
    const each = opts.mergesEach ?? 1;
    for (let i = 0; i < each; i++) {
      for (const a of accounts) {
        const pr = await this.submitAndVote(a, { [`world/seed/${a.login}-${i}.md`]: `seed ${a.login} ${i}` });
        this.confirm(pr.number);
        await this.tick();
      }
    }
    if (opts.endBootstrap ?? true) this.endBootstrap();
    if (opts.mature ?? true) await this.advance(31 * DAY, DAY);
  }

  replayCheck(): void {
    const r = replay(this.events, new Map([[lawsHash, rawLaws]]), rawSchema, this.signer.publicKeyPem(), this.clock.now());
    this.check("replay of the full ledger reproduces every recorded outcome and every signature verifies", r.ok, r.findings.map((f) => `event ${f.event}: ${f.problem}`).join("; "));
  }
}
