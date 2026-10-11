/**
 * The orchestrator. One `tick()` applies the rules to every open pull request
 * and to the fee clock. All state is derived from the ledger; the runtime
 * keeps nothing in memory that a restart would lose.
 */
import { ARTICLE_9A, BOOTSTRAP_MAX_DAYS } from "./constitution.js";
import { fee as feeFns } from "./index-fee.js";
import { intake } from "./intake.js";
import { Ledger, type LedgerEvent } from "./ledger.js";
import { parseLaws, LawsError, type Laws, type LoadedLaws } from "./laws.js";
import { phaseOf } from "./phases.js";
import type { ChainPort, Clock, GitHubPort, PaymentNotice, PriceOracle, PullInfo, ScreenPort } from "./ports.js";
import { fold, serializeState, type State } from "./state.js";
import { tally, type Review } from "./tally.js";
import type { OpenQuote } from "./pay.js";

export interface RuntimeDeps {
  github: GitHubPort;
  chain: ChainPort;
  screen: ScreenPort;
  oracle: PriceOracle;
  clock: Clock;
  ledger: Ledger;
  /** Reads laws.json and laws.schema.json from the repository at main. */
  loadLaws(): Promise<{ rawLaws: string; rawSchema: string }>;
  termsCommit(): Promise<string>;
  publicBaseUrl: string;
  log?: (msg: string) => void;
}

export class Runtime {
  private laws: LoadedLaws | null = null;
  private log: (msg: string) => void;
  constructor(private d: RuntimeDeps) { this.log = d.log ?? (() => {}); }

  get events(): LedgerEvent[] { return this.d.ledger.events; }

  /** Article 8: refuse a non-compliant laws.json and keep the last compliant one. */
  async refreshLaws(): Promise<Laws> {
    const { rawLaws, rawSchema } = await this.d.loadLaws();
    try {
      const loaded = parseLaws(rawLaws, rawSchema);
      if (!this.laws || this.laws.hash !== loaded.hash) this.log(`laws ${loaded.hash.slice(0, 12)} loaded`);
      this.laws = loaded;
    } catch (e) {
      if (!(e instanceof LawsError)) throw e;
      const hash = sha(rawLaws);
      const already = this.events.some((ev) => ev.type === "refusal" && ev["laws_hash"] === hash);
      if (!already) this.d.ledger.append(this.d.clock.now(), "refusal", { laws_hash: hash, reason: e.problems.join("; ") });
      if (!this.laws) throw new Error("no compliant laws.json has ever been loaded: " + e.problems.join("; "));
    }
    return this.laws.laws;
  }

  state(now = this.d.clock.now()): State {
    if (!this.laws) throw new Error("laws not loaded");
    return fold(this.events, now, this.laws.laws);
  }

  /** Current open quote for the payment endpoint. */
  quoteFor(pr: number): OpenQuote | null {
    const p = phaseOf(pr, this.events);
    if (p.kind !== "quoted") return null;
    const q = p.quote;
    return { pr, feeMicro: BigInt(String(q["fee_micro"])), destination: String(q["destination"]), expires: Number(q["expires"]) };
  }

  /** Called by the payment endpoint after settlement. */
  async onPaid(n: PaymentNotice): Promise<void> {
    const p = phaseOf(n.pr, this.events);
    if (p.kind !== "quoted") { this.log(`payment for pr ${n.pr} arrived in phase ${p.kind}; recorded as unmatched`); this.d.ledger.append(this.d.clock.now(), "payment", { pr: n.pr, tx: n.tx, from: n.payer, amount_micro: n.amountMicro, matched: false }); return; }
    const info = await this.d.chain.transactionInfo(n.tx);
    const cad = await this.d.oracle.usdcToCad();
    const amountCad = (Number(n.amountMicro) / 1_000_000 * Number(cad)).toFixed(2);
    this.d.ledger.append(this.d.clock.now(), "payment", {
      pr: n.pr, tx: n.tx, block: info?.blockNumber?.toString() ?? null, block_time: info?.blockTime ?? null,
      amount_micro: n.amountMicro, from: n.payer, cad_value: amountCad, matched: true,
    });
  }

  async tick(): Promise<void> {
    const laws = await this.refreshLaws();
    const now = this.d.clock.now();
    const genesis = this.events.find((e) => e.type === "genesis");
    if (!genesis) { this.log("no genesis event; run `nomicon genesis` first"); return; }
    await this.maybeAdjustFee(laws, now);
    await this.maybeEndBootstrap(now);
    const pulls = await this.d.github.listOpenPulls();
    const openNumbers = new Set(pulls.map((p) => p.number));
    for (const pr of pulls) await this.handlePull(pr, laws, now);
    // Votes on pull requests the author closed or converted are withdrawals (Law 8).
    const state = this.state(now);
    for (const v of state.open_votes) if (!openNumbers.has(v.pr)) await this.withdraw(v.pr, laws, now, "closed");
    await this.publish(now);
  }

  private async handlePull(pr: PullInfo, laws: Laws, now: number): Promise<void> {
    const p = phaseOf(pr.number, this.events);
    const state = this.state(now);
    switch (p.kind) {
      case "new": return this.intakeAndScreen(pr, laws, now, state);
      case "held":
        if (now - p.since >= laws.screening.hold_timeout_days * 86400) {
          this.d.ledger.append(now, "hold_resolved", { pr: pr.number, decision: "timeout", reason: "no owner action within the hold timeout" });
          await this.d.github.comment(pr.number, "The screening hold was not resolved within the time the Laws allow. This submission is closed without charge; it may be resubmitted.");
          await this.d.github.close(pr.number);
        }
        return;
      case "quoted":
        if (Number(p.quote["expires"]) < now) {
          this.d.ledger.append(now, "quote_lapsed", { pr: pr.number });
          await this.d.github.comment(pr.number, "The quote lapsed unpaid. Push nothing; the agent will issue a new quote on its next pass if the pull request is still open.");
        }
        return;
      case "paid": return this.openVote(pr, p.quote, laws, now, state);
      case "voting": return this.maybeClose(pr, p.open, p.quote, laws, now, state);
      case "await_owner":
        if (now - p.close.at >= laws.bootstrap.owner_action_deadline_days * 86400) await this.expire(pr.number, p.quote, laws, now, "owner did not act within the bootstrap deadline");
        return;
      case "confirmed": return this.doMerge(pr.number, String(p.open["head"]), p.quote, laws, now, pr.author);
      default: return;
    }
  }

  private async intakeAndScreen(pr: PullInfo, laws: Laws, now: number, state: State): Promise<void> {
    const barred = state.barred_until[pr.author.id];
    if (barred && barred > now) { this.d.ledger.append(now, "intake_reject", { pr: pr.number, reasons: ["author is barred from submitting until " + barred] }); await this.d.github.comment(pr.number, "Submissions from this account are not accepted until the bar in the ledger ends."); await this.d.github.close(pr.number); return; }
    const [files, commits, existing] = await Promise.all([this.d.github.listFiles(pr.number), this.d.github.listCommits(pr.number), this.d.github.listPaths(pr.baseSha)]);
    const result = intake({ files, existingPaths: existing, commits }, laws);
    if (!result.ok) {
      this.d.ledger.append(now, "intake_reject", { pr: pr.number, account: pr.author.id, reasons: result.reasons });
      await this.d.github.comment(pr.number, "Not accepted at intake:\n\n" + result.reasons.map((r) => "- " + r).join("\n") + "\n\nSee LAWS.md Law 6 and Law 8. No fee was charged.");
      await this.d.github.close(pr.number);
      return;
    }
    // Screen before any quote (Law 10).
    const contents = await Promise.all(files.filter((f) => f.status !== "removed").map(async (f) => ({ path: f.path, content: await this.d.github.readFile(pr.headSha, f.path) })));
    let decision;
    try { decision = await this.d.screen.screen({ pr: pr.number, title: pr.title, body: pr.body, files: contents }); }
    catch (e) { this.log(`screen error on pr ${pr.number}: ${(e as Error).message}; will retry`); return; }
    if (decision.decision === "hold") {
      this.d.ledger.append(now, "screen_hold", { pr: pr.number, head: pr.headSha, account: pr.author.id, reason_class: decision.reasonClass });
      await this.d.github.comment(pr.number, "Held for the owner's review under Constitution Article 4. No fee has been charged. A hold is not a finding; it means a person must look before a vote can open.");
      return;
    }
    // Quote (Law 5).
    const openPaid = this.events.filter((e) => e.type === "payment" && e["matched"] !== false).map((e) => Number(e["pr"]))
      .filter((n) => { const ph = phaseOf(n, this.events); return ph.kind === "paid" || ph.kind === "voting" || ph.kind === "await_owner"; })
      .filter((n) => this.events.some((e) => e.type === "quote" && Number(e["pr"]) === n && Number(e["account"]) === pr.author.id)).length;
    const q = feeFns.quote({ layer: result.layer as "world" | "laws", bytesChanged: result.bytesChanged, openPaidByAccount: openPaid, baseMicro: state.fee.base_micro }, laws);
    // A held fee from an earlier expiry at the same layer covers this submission (Law 5).
    const held = state.held_fees.find((h) => h.account === pr.author.id && h.layer === result.layer && h.micro >= q.feeMicro);
    const terms = await this.d.termsCommit();
    const expires = now + laws.fee.quote_valid_hours * 3600;
    const ev = this.d.ledger.append(now, "quote", {
      pr: pr.number, head: pr.headSha, account: pr.author.id, login: pr.author.login, layer: result.layer,
      fee_micro: held ? 0n : q.feeMicro, base_micro: q.baseMicro, multiplier: q.multiplier, concurrency: q.concurrency, size_kb: q.sizeKbCharged,
      weight_micro: q.weightMicro, terms_commit: terms, destination: state.fee.destination, expires, held_fee_pr: held?.pr ?? null,
    });
    if (held) {
      this.d.ledger.append(now, "payment", { pr: pr.number, tx: null, amount_micro: 0n, from: null, cad_value: "0.00", matched: true, from_held_fee_pr: held.pr });
      await this.d.github.comment(pr.number, `A held fee from pull request #${held.pr} covers this submission. The vote opens on the agent's next pass.`);
      return;
    }
    await this.d.github.comment(pr.number, quoteComment(ev, laws, this.d.publicBaseUrl));
  }

  private async openVote(pr: PullInfo, quote: LedgerEvent, laws: Laws, now: number, state: State): Promise<void> {
    if (pr.headSha !== String(quote["head"])) { await this.withdraw(pr.number, laws, now, "head changed before the vote opened", quote); return; }
    const commits = await this.d.github.listCommits(pr.number);
    const authors = new Set<number>([pr.author.id]);
    for (const c of commits) { if (c.authorId) authors.add(c.authorId); if (c.committerId) authors.add(c.committerId); }
    const qualified = Object.entries(state.weights).filter(([id, w]) => w.mature_micro > 0n && !authors.has(Number(id))).map(([id]) => Number(id)).sort((a, b) => a - b);
    const layer = quote["layer"] as "world" | "laws";
    const proc = layer === "laws" ? laws.vote.laws : laws.vote.world;
    const closes = now + proc.window_hours * 3600;
    this.d.ledger.append(now, "vote_open", {
      pr: pr.number, head: pr.headSha, layer, opened: now, closes, laws_hash: this.laws!.hash,
      qualified, authors: [...authors].sort((a, b) => a - b), weighted_accounts: state.weighted_accounts,
    });
    await this.d.github.comment(pr.number, "```nomicon-vote\n" + [`pr: ${pr.number}`, `head: ${pr.headSha}`, `layer: ${layer}`, `opened: ${iso(now)}`, `closes: ${iso(closes)}`, `laws: ${this.laws!.hash}`, `qualified_voters: ${qualified.length}`].join("\n") + "\n```\nQualified voters vote by reviewing this pull request: Approve is yes, Request changes is no. Do not push to it.");
  }

  private async maybeClose(pr: PullInfo, open: LedgerEvent, quote: LedgerEvent, laws: Laws, now: number, state: State): Promise<void> {
    if (pr.headSha !== String(open["head"]) || pr.draft) { await this.withdraw(pr.number, laws, now, pr.draft ? "converted to draft" : "pushed after the vote opened", quote); return; }
    const closesAt = Number(open["closes"]);
    if (now < closesAt) return;
    const block = await this.d.chain.firstFinalizedBlockAfter(closesAt);
    if (!block) return; // wait for finality
    const reviews = await this.d.github.listReviews(pr.number);
    const qualified = new Set((open["qualified"] as number[]) ?? []);
    const authors = new Set((open["authors"] as number[]) ?? []);
    for (const r of reviews) {
      if ((r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") && qualified.has(r.account) && r.submittedAt > Number(open["opened"]) && r.submittedAt <= closesAt && !this.events.some((e) => e.type === "review" && Number(e["review_id"]) === r.reviewId)) {
        this.d.ledger.append(now, "review", { pr: pr.number, account: r.account, login: r.login, review_id: r.reviewId, state: r.state, submitted: r.submittedAt });
      }
    }
    const lawsAtOpen = await this.lawsByHash(String(open["laws_hash"]), laws);
    const atClose = fold(this.events, closesAt, lawsAtOpen);
    const matureAtClose = new Map<number, bigint>();
    for (const [id, w] of Object.entries(atClose.weights)) matureAtClose.set(Number(id), w.mature_micro);
    const counted: Review[] = reviews;
    const result = tally({
      layer: open["layer"] as "world" | "laws", openedAt: Number(open["opened"]), closesAt, qualified, authors, reviews: counted,
      matureAtClose, weightedAccountsAtOpen: Number(open["weighted_accounts"]), headSha: String(open["head"]), tieBlockHash: block.hash,
    }, lawsAtOpen);
    // Article 3: during bootstrap every closed vote waits for the owner, whatever the tally says.
    const bootstrap = state.bootstrap.active;
    const recorded = bootstrap ? "await_owner" : result.result;
    this.d.ledger.append(now, "vote_close", {
      pr: pr.number, yes_voters: result.yesVoters, quorum: result.quorum, yes_micro: result.yesMicro, no_micro: result.noMicro,
      tie_block: result.tie ? block.hash : null, tie_bit: result.tie ? result.tieBit : null, result: recorded, bootstrap,
      votes: result.votes.map((v) => ({ account: v.account, yes: v.yes, weight_micro: v.weightMicro })),
    });
    const summary = `Result: ${recorded}. Yes voters ${result.yesVoters} of quorum ${result.quorum}. Yes weight ${micro(result.yesMicro)}, no weight ${micro(result.noMicro)}${result.tie ? `, tie broken by block ${block.hash} bit ${result.tieBit}` : ""}.`;
    if (recorded === "await_owner") { await this.d.github.comment(pr.number, summary + " Bootstrap is active: this merges when the owner confirms."); return; }
    if (recorded === "merge") { await this.doMerge(pr.number, String(open["head"]), quote, laws, now, pr.author, summary); return; }
    if (recorded === "reject") {
      await this.d.github.comment(pr.number, summary + " The fee is forfeit (Law 5).");
      await this.d.github.close(pr.number);
      return;
    }
    await this.expire(pr.number, quote, laws, now, summary + " Quorum was not reached.");
  }

  private async doMerge(pr: number, head: string, quote: LedgerEvent, laws: Laws, now: number, author: { id: number; login: string }, note = ""): Promise<void> {
    const mergeCommit = await this.d.github.merge(pr, head);
    if (!mergeCommit) { await this.expire(pr, quote, laws, now, "could not be merged cleanly at close"); return; }
    this.d.ledger.append(now, "merge", { pr, head, merge_commit: mergeCommit, weight_micro: BigInt(String(quote["weight_micro"])), account: author.id, login: author.login });
    await this.d.github.comment(pr, (note ? note + " " : "") + `Merged as ${mergeCommit}. Weight ${micro(BigInt(String(quote["weight_micro"])))} USDC accrues to the author and matures in ${laws.weight.maturity_days} days.`);
  }

  private async expire(pr: number, quote: LedgerEvent, laws: Laws, now: number, why: string): Promise<void> {
    const heldUntil = now + laws.fee.expiry_hold_days * 86400;
    this.d.ledger.append(now, "expiry", { pr, account: Number(quote["account"]), layer: quote["layer"], fee_micro: BigInt(String(quote["fee_micro"])), held_until: heldUntil, reason: why });
    await this.d.github.comment(pr, `Expired: ${why} The fee is held until ${iso(heldUntil)} for resubmission at the same layer (Law 5).`);
    await this.d.github.close(pr);
  }

  private async withdraw(pr: number, laws: Laws, now: number, why: string, quote?: LedgerEvent): Promise<void> {
    const anyVote = this.events.some((e) => e.type === "review" && Number(e["pr"]) === pr);
    const held = !anyVote;
    const q = quote ?? this.events.filter((e) => e.type === "quote" && Number(e["pr"]) === pr).pop();
    const feeMicro = q ? BigInt(String(q["fee_micro"])) : 0n;
    const fields: Record<string, unknown> = { pr, reason: why, fee_disposition: held ? "held" : "forfeit" };
    if (held && q) {
      fields["held_until"] = now + laws.fee.expiry_hold_days * 86400;
      this.d.ledger.append(now, "withdrawal", fields);
      this.d.ledger.append(now, "expiry", { pr, account: Number(q["account"]), layer: q["layer"], fee_micro: feeMicro, held_until: fields["held_until"], reason: "withdrawal before any vote" });
    } else {
      this.d.ledger.append(now, "withdrawal", fields);
    }
    try { await this.d.github.comment(pr, `Withdrawn: ${why}. Fee ${held ? "held for resubmission" : "forfeit"} (Law 8).`); await this.d.github.close(pr); } catch { /* already closed */ }
  }

  private async maybeAdjustFee(laws: Laws, now: number): Promise<void> {
    const last = [...this.events].reverse().find((e) => e.type === "fee_adjust" || e.type === "genesis");
    if (last && now - last.at < laws.fee.adjust_every_hours * 3600) return;
    const state = this.state(now);
    const lookback = now - laws.fee.lookback_hours * 3600;
    const paid = this.events.filter((e) => e.type === "payment" && e["matched"] !== false && e.at >= lookback).length;
    const since = now - laws.fee.target_lookback_days * 86400;
    const qualifiedVotes = this.events.filter((e) => e.type === "review" && e.at >= since).length;
    const r = feeFns.adjustBase({ baseMicro: state.fee.base_micro, paidSubmissionsInLookback: paid, qualifiedVotesInLookback: qualifiedVotes }, laws);
    let anchorTx: string | null = null;
    try { anchorTx = await this.d.chain.anchor(this.d.ledger.headHash()); } catch (e) { this.log(`anchor failed: ${(e as Error).message}`); }
    this.d.ledger.append(now, "fee_adjust", { base_micro: r.baseMicro, submissions_24h: paid, target: r.target, per_day: r.perDay, anchor_tx: anchorTx, ledger_head: this.d.ledger.headHash() });
  }

  private async maybeEndBootstrap(now: number): Promise<void> {
    const state = this.state(now);
    if (!state.bootstrap.active || !state.bootstrap.began) return;
    if (now - state.bootstrap.began < BOOTSTRAP_MAX_DAYS * 86400) return;
    this.d.ledger.append(now, "declare", { what: "bootstrap_end", reason: `${BOOTSTRAP_MAX_DAYS} days elapsed (Article 3)` });
  }

  private async lawsByHash(hash: string, current: Laws): Promise<Laws> {
    if (this.laws && this.laws.hash === hash) return this.laws.laws;
    // Older laws.json versions are reconstructed from the ledger's "laws_snapshot" events when present.
    const snap = this.events.find((e) => e.type === "declare" && e["what"] === "laws_snapshot" && e["laws_hash"] === hash);
    if (snap) return parseLaws(String(snap["raw"]), (await this.d.loadLaws()).rawSchema).laws;
    this.log(`laws ${hash.slice(0, 12)} not available; using current`);
    return current;
  }

  private async publish(now: number): Promise<void> {
    const state = this.state(now);
    const serialized = this.events.map((e) => JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).join("\n") + (this.events.length ? "\n" : "");
    await this.d.github.publishLedger([
      { path: "ledger/events.jsonl", content: serialized },
      { path: "ledger/state.json", content: serializeState(state) },
    ], `ledger: event ${this.d.ledger.head}`);
  }
}

export function quoteComment(q: LedgerEvent, laws: Laws, base: string): string {
  const lines = [
    `pr: ${q["pr"]}`, `head: ${q["head"]}`, `layer: ${q["layer"]}`,
    `fee_usdc: ${micro(BigInt(String(q["fee_micro"])))}`, `base_usdc: ${micro(BigInt(String(q["base_micro"])))}`,
    `multiplier: ${q["multiplier"]}`, `concurrency: ${q["concurrency"]}`, `size_kb_charged: ${q["size_kb"]}`,
    `terms_commit: ${q["terms_commit"]}`, `destination: ${q["destination"]}`, `network: ${laws.fee.network_caip2}`,
    `pay: ${base.replace(/\/$/, "")}/pay/${q["pr"]}`, `expires: ${iso(Number(q["expires"]))}`,
  ];
  return "```nomicon-quote\n" + lines.join("\n") + "\n```\nPay within the validity window with USDC on Base via x402 (see agent/PROTOCOL.md). Paying is acceptance of TERMS.md at the commit shown. Verify the destination against CONSTITUTION.md Article 7 before paying.";
}

export function micro(m: bigint): string {
  const s = m.toString().padStart(7, "0");
  return s.slice(0, -6) + "." + s.slice(-6);
}
export function iso(t: number): string { return new Date(t * 1000).toISOString(); }
function sha(s: string): string { return createHashHex(s); }
import { createHash } from "node:crypto";
function createHashHex(s: string): string { return createHash("sha256").update(s).digest("hex"); }
