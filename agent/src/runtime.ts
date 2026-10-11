/**
 * The orchestrator. One `tick()` applies the rules to every open pull request
 * and to the fee clock. All state is derived from the ledger; the runtime
 * keeps nothing in memory that a restart would lose.
 */
import { createHash } from "node:crypto";
import { BOOTSTRAP_MAX_DAYS } from "./constitution.js";
import { adjustBase, quote as computeQuote } from "./fee.js";
import { intake } from "./intake.js";
import { Ledger, type LedgerEvent } from "./ledger.js";
import { parseLaws, LawsError, type Laws, type LoadedLaws } from "./laws.js";
import { phaseOf } from "./phases.js";
import type { ChainPort, Clock, GitHubPort, PaymentNotice, PriceOracle, PullInfo, ScreenPort } from "./ports.js";
import { fold, serializeState, type State } from "./state.js";
import { tally } from "./tally.js";
import type { OpenQuote } from "./pay.js";

export interface RuntimeDeps {
  github: GitHubPort;
  chain: ChainPort;
  screen: ScreenPort;
  oracle: PriceOracle;
  clock: Clock;
  ledger: Ledger;
  /** Fallback source for laws.json and laws.schema.json when the ledger holds no snapshot yet. */
  loadLaws(): Promise<{ rawLaws: string; rawSchema: string }>;
  termsCommit(): Promise<string>;
  publicBaseUrl: string;
  log?: (msg: string) => void;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class Runtime {
  private laws: LoadedLaws | null = null;
  private schemaHash = "";
  private lastPublishedHead = "";
  private log: (msg: string) => void;
  constructor(private d: RuntimeDeps) { this.log = d.log ?? (() => {}); }

  get events(): LedgerEvent[] { return this.d.ledger.events; }

  /**
   * Article 8 and Law 3: the rules in force are the latest laws_snapshot whose
   * effective time has passed. A non-compliant snapshot is refused and the
   * previous compliant one stays in force.
   */
  async refreshLaws(): Promise<Laws> {
    const now = this.d.clock.now();
    const snapshots = this.events.filter((e) => e.type === "laws_snapshot" && Number(e["effective_at"]) <= now);
    const candidates: Array<{ rawLaws: string; rawSchema: string; label: string }> = [];
    for (let i = snapshots.length - 1; i >= 0; i--) {
      const s = snapshots[i]!;
      candidates.push({ rawLaws: String(s["laws_raw"]), rawSchema: String(s["schema_raw"]), label: `snapshot ${s.id}` });
    }
    if (candidates.length === 0) {
      const f = await this.d.loadLaws();
      candidates.push({ rawLaws: f.rawLaws, rawSchema: f.rawSchema, label: "repository" });
    }
    for (const c of candidates) {
      try {
        const loaded = parseLaws(c.rawLaws, c.rawSchema);
        if (!this.laws || this.laws.hash !== loaded.hash) this.log(`laws ${loaded.hash.slice(0, 12)} in force (${c.label})`);
        this.laws = loaded;
        this.schemaHash = sha256(c.rawSchema);
        return loaded.laws;
      } catch (e) {
        if (!(e instanceof LawsError)) throw e;
        const hash = sha256(c.rawLaws);
        if (!this.events.some((ev) => ev.type === "refusal" && ev["laws_hash"] === hash)) {
          this.d.ledger.append(now, "refusal", { laws_hash: hash, reason: e.problems.join("; ") });
          this.log(`refused laws ${hash.slice(0, 12)}: ${e.problems.join("; ")}`);
        }
      }
    }
    if (this.laws) return this.laws.laws;
    throw new Error("no compliant laws.json has ever been loaded");
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
    const now = this.d.clock.now();
    const p = phaseOf(n.pr, this.events);
    if (p.kind !== "quoted") {
      this.log(`payment for pr ${n.pr} arrived in phase ${p.kind}; recorded as unmatched`);
      this.d.ledger.append(now, "payment", { pr: n.pr, tx: n.tx, from: n.payer, amount_micro: n.amountMicro, matched: false });
      return;
    }
    const quoted = BigInt(String(p.quote["fee_micro"]));
    const info = await this.d.chain.transactionInfo(n.tx);
    const arrival = info?.blockTime ?? now;
    const matched = n.amountMicro >= quoted && arrival <= Number(p.quote["expires"]);
    const cad = await this.d.oracle.usdcToCad();
    const amountCad = ((Number(n.amountMicro) / 1_000_000) * Number(cad)).toFixed(2);
    this.d.ledger.append(now, "payment", {
      pr: n.pr, tx: n.tx, block: info?.blockNumber?.toString() ?? null, block_time: info?.blockTime ?? null,
      amount_micro: n.amountMicro, quoted_micro: quoted, from: n.payer, cad_value: amountCad, matched,
    });
    if (!matched) this.log(`payment for pr ${n.pr} did not match its quote (amount ${n.amountMicro} vs ${quoted}, arrival ${arrival})`);
  }

  async tick(): Promise<void> {
    const added = this.d.ledger.reload();
    if (added) this.log(`${added} ledger event(s) appended by another process`);
    const laws = await this.refreshLaws();
    const now = this.d.clock.now();
    if (!this.events.some((e) => e.type === "genesis")) { this.log("no genesis event; run `nomicon genesis` first"); return; }
    await this.maybeAdjustFee(laws, now);
    await this.maybeEndBootstrap(now);
    const pulls = await this.d.github.listOpenPulls();
    const openNumbers = new Set(pulls.map((p) => p.number));
    for (const pr of pulls) await this.handlePull(pr, laws, now);
    await this.applyOwnerDecisions(laws, now, openNumbers);
    // A pull request closed or drafted while its vote was open is a withdrawal (Law 8).
    for (const v of this.state(now).open_votes) if (!openNumbers.has(v.pr)) await this.withdraw(v.pr, laws, now, "closed after the vote opened");
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
          await this.d.github.comment(pr.number, "The quote lapsed unpaid. A new quote will be issued on the agent's next pass while this pull request stays open.");
        }
        return;
      case "paid": return this.openVote(pr, p.quote, laws, now, state);
      case "voting": return this.maybeClose(pr, p.open, p.quote, laws, now, state);
      case "await_owner":
        if (now - p.close.at >= laws.bootstrap.owner_action_deadline_days * 86400) await this.expire(pr.number, p.quote, laws, now, "the owner did not act within the bootstrap deadline");
        return;
      case "confirmed": return this.doMerge(pr.number, String(p.open["head"]), p.quote, laws, now, pr.author);
      default: return;
    }
  }

  private async intakeAndScreen(pr: PullInfo, laws: Laws, now: number, state: State): Promise<void> {
    const barred = state.barred_until[pr.author.id];
    if (barred && barred > now) {
      this.d.ledger.append(now, "intake_reject", { pr: pr.number, account: pr.author.id, reasons: [`author is barred from submitting until ${iso(barred)}`] });
      await this.d.github.comment(pr.number, `Submissions from this account are not accepted until ${iso(barred)} (Law 10).`);
      await this.d.github.close(pr.number);
      return;
    }
    const [files, commits, existing] = await Promise.all([this.d.github.listFiles(pr.number), this.d.github.listCommits(pr.number), this.d.github.listPaths(pr.baseSha)]);
    const result = intake({ files, existingPaths: existing, commits }, laws);
    if (!result.ok) {
      this.d.ledger.append(now, "intake_reject", { pr: pr.number, account: pr.author.id, reasons: result.reasons });
      await this.d.github.comment(pr.number, "Not accepted at intake:\n\n" + result.reasons.map((r) => "- " + r).join("\n") + "\n\nSee LAWS.md Law 6 and Law 8. No fee was charged.");
      await this.d.github.close(pr.number);
      return;
    }
    // Law 10: screen before any quote, unless the owner already released a hold on this pull request.
    const released = this.events.some((e) => e.type === "hold_resolved" && e["decision"] === "release" && Number(e["pr"]) === pr.number);
    if (!released) {
      const contents = await Promise.all(files.filter((f) => f.status !== "removed").map(async (f) => ({ path: f.path, content: await this.d.github.readFile(pr.headSha, f.path) })));
      let decision;
      try { decision = await this.d.screen.screen({ pr: pr.number, title: pr.title, body: pr.body, files: contents }); }
      catch (e) { this.log(`screen error on pr ${pr.number}: ${(e as Error).message}; will retry`); return; }
      if (decision.decision === "hold") {
        this.d.ledger.append(now, "screen_hold", { pr: pr.number, head: pr.headSha, account: pr.author.id, reason_class: decision.reasonClass });
        await this.d.github.comment(pr.number, "Held for the owner's review under Constitution Article 4. No fee has been charged. A hold is not a finding; it means a person must look before a vote can open.");
        return;
      }
    }
    // Law 5: quote. Concurrency counts this account's other submissions that are paid and not yet decided.
    const openPaid = new Set<number>();
    for (const e of this.events) {
      if (e.type !== "quote" || Number(e["account"]) !== pr.author.id || Number(e["pr"]) === pr.number) continue;
      const k = phaseOf(Number(e["pr"]), this.events).kind;
      if (k === "paid" || k === "voting" || k === "await_owner" || k === "confirmed") openPaid.add(Number(e["pr"]));
    }
    const q = computeQuote({ layer: result.layer, bytesChanged: result.bytesChanged, openPaidByAccount: openPaid.size, baseMicro: state.fee.base_micro }, laws);
    const held = state.held_fees.find((h) => h.account === pr.author.id && h.layer === result.layer && h.micro >= q.feeMicro);
    const terms = await this.d.termsCommit();
    const expires = now + laws.fee.quote_valid_hours * 3600;
    const genesis = this.events.find((e) => e.type === "genesis");
    const network = genesis && typeof genesis["network"] === "string" ? (genesis["network"] as string) : laws.fee.network_caip2;
    const ev = this.d.ledger.append(now, "quote", {
      pr: pr.number, head: pr.headSha, account: pr.author.id, login: pr.author.login, layer: result.layer, network,
      fee_micro: held ? 0n : q.feeMicro, base_micro: q.baseMicro, multiplier: q.multiplier, concurrency: q.concurrency, size_kb: q.sizeKbCharged,
      weight_micro: q.weightMicro, terms_commit: terms, destination: state.fee.destination, expires, held_fee_pr: held?.pr ?? null,
    });
    if (held) {
      this.d.ledger.append(now, "payment", { pr: pr.number, tx: null, amount_micro: 0n, quoted_micro: 0n, from: null, cad_value: "0.00", matched: true, from_held_fee_pr: held.pr });
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
    const immediate = state.bootstrap.active && qualified.length === 0 && laws.bootstrap.close_immediately_without_voters;
    const closes = immediate ? now : now + proc.window_hours * 3600;
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
    const reviews = await this.d.github.listReviews(pr.number);
    const qualified = new Set((open["qualified"] as number[]) ?? []);
    const authors = new Set((open["authors"] as number[]) ?? []);
    this.recordReviews(pr.number, reviews, qualified, Number(open["opened"]), closesAt, now);
    const lawsAtOpen = this.lawsByHash(String(open["laws_hash"]), laws);
    const atClose = fold(this.events, closesAt, lawsAtOpen);
    const matureAtClose = new Map<number, bigint>();
    for (const [id, w] of Object.entries(atClose.weights)) matureAtClose.set(Number(id), w.mature_micro);
    const base = {
      layer: open["layer"] as "world" | "laws", openedAt: Number(open["opened"]), closesAt, qualified, authors, reviews,
      matureAtClose, weightedAccountsAtOpen: Number(open["weighted_accounts"]), headSha: String(open["head"]),
    };
    // Law 11: the tie-break block is needed only on an exact tie; fetch it lazily so ordinary closes do not wait for finality.
    let block: { hash: string } | null = null;
    let result;
    try { result = tally(base, lawsAtOpen); }
    catch (e) {
      if (!(e instanceof Error) || !e.message.includes("tie")) throw e;
      block = await this.d.chain.firstFinalizedBlockAfter(closesAt);
      if (!block) return; // wait for finality
      result = tally({ ...base, tieBlockHash: block.hash }, lawsAtOpen);
    }
    // Article 3: during bootstrap every closed vote waits for the owner, whatever the tally says.
    const bootstrap = state.bootstrap.active;
    const recorded = bootstrap ? "await_owner" : result.result;
    this.d.ledger.append(now, "vote_close", {
      pr: pr.number, yes_voters: result.yesVoters, quorum: result.quorum, yes_micro: result.yesMicro, no_micro: result.noMicro,
      tie_block: result.tie && block ? block.hash : null, tie_bit: result.tie ? result.tieBit : null, tally_result: result.result, result: recorded, bootstrap,
      votes: result.votes.map((v) => ({ account: v.account, yes: v.yes, weight_micro: v.weightMicro })),
    });
    const summary = `Tally: ${result.result}. Yes voters ${result.yesVoters} of quorum ${result.quorum}. Yes weight ${micro(result.yesMicro)}, no weight ${micro(result.noMicro)}${result.tie && block ? `, tie broken by block ${block.hash} bit ${result.tieBit}` : ""}.`;
    if (recorded === "await_owner") { await this.d.github.comment(pr.number, summary + " Bootstrap is active: this merges only when the owner confirms, and the owner may reject."); return; }
    if (recorded === "merge") { await this.doMerge(pr.number, String(open["head"]), quote, laws, now, pr.author, summary); return; }
    if (recorded === "reject") { await this.d.github.comment(pr.number, summary + " The fee is forfeit (Law 5)."); await this.d.github.close(pr.number); return; }
    await this.expire(pr.number, quote, laws, now, summary + " Quorum was not reached.");
  }

  /** Record every counting review in the ledger so replay needs nothing from the platform (Article 11). */
  private recordReviews(pr: number, reviews: Array<{ reviewId: number; account: number; login: string; state: string; submittedAt: number }>, qualified: Set<number>, opened: number, closesAt: number, now: number): number {
    let counted = 0;
    for (const r of reviews) {
      if ((r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") || !qualified.has(r.account) || r.submittedAt <= opened || r.submittedAt > closesAt) continue;
      counted++;
      if (this.events.some((e) => e.type === "review" && Number(e["review_id"]) === r.reviewId)) continue;
      this.d.ledger.append(now, "review", { pr, account: r.account, login: r.login, review_id: r.reviewId, state: r.state, submitted: r.submittedAt });
    }
    return counted;
  }

  private async doMerge(pr: number, head: string, quote: LedgerEvent, laws: Laws, now: number, author: { id: number; login: string }, note = ""): Promise<void> {
    const mergeCommit = await this.d.github.merge(pr, head);
    if (!mergeCommit) { await this.expire(pr, quote, laws, now, "could not be merged cleanly at close"); return; }
    const weight = BigInt(String(quote["weight_micro"]));
    this.d.ledger.append(now, "merge", { pr, head, merge_commit: mergeCommit, weight_micro: weight, account: author.id, login: author.login, layer: quote["layer"] });
    await this.d.github.comment(pr, (note ? note + " " : "") + `Merged as ${mergeCommit}. Weight ${micro(weight)} USDC accrues to the author and matures in ${laws.weight.maturity_days} days.`);
    // Law 3: a change to the Laws takes effect after the delay. Snapshot what was merged.
    if (quote["layer"] === "laws") {
      const [rawLaws, rawSchema] = await Promise.all([this.d.github.readFile(mergeCommit, "laws.json"), this.d.github.readFile(mergeCommit, "laws.schema.json")]);
      if (sha256(rawLaws) !== this.laws!.hash || sha256(rawSchema) !== this.schemaHash) {
        const effective = now + laws.vote.laws.effect_delay_days * 86400;
        this.d.ledger.append(now, "laws_snapshot", { pr, laws_hash: sha256(rawLaws), laws_raw: rawLaws, schema_raw: rawSchema, effective_at: effective, merge_commit: mergeCommit });
        await this.d.github.comment(pr, `This change to the Laws takes effect at ${iso(effective)} (Law 3). Votes opened before then run under the rules recorded at their open.`);
      }
    }
  }

  private async expire(pr: number, quote: LedgerEvent, laws: Laws, now: number, why: string): Promise<void> {
    const heldUntil = now + laws.fee.expiry_hold_days * 86400;
    this.d.ledger.append(now, "expiry", { pr, account: Number(quote["account"]), layer: quote["layer"], fee_micro: BigInt(String(quote["fee_micro"])), held_until: heldUntil, reason: why });
    await this.d.github.comment(pr, `Expired: ${why} The fee is held until ${iso(heldUntil)} for resubmission at the same layer (Law 5).`);
    await this.d.github.close(pr);
  }

  /** Law 8: a push, close or draft conversion after the vote opened. Forfeit once any qualified vote was cast. */
  private async withdraw(pr: number, laws: Laws, now: number, why: string, quote?: LedgerEvent): Promise<void> {
    const q = quote ?? [...this.events].reverse().find((e) => e.type === "quote" && Number(e["pr"]) === pr);
    const open = [...this.events].reverse().find((e) => e.type === "vote_open" && Number(e["pr"]) === pr);
    let anyVote = false;
    if (open) {
      let reviews: Awaited<ReturnType<GitHubPort["listReviews"]>> = [];
      try { reviews = await this.d.github.listReviews(pr); } catch { /* closed and gone: fall back to the ledger */ }
      anyVote = this.recordReviews(pr, reviews, new Set((open["qualified"] as number[]) ?? []), Number(open["opened"]), now, now) > 0
        || this.events.some((e) => e.type === "review" && Number(e["pr"]) === pr);
    }
    const held = !anyVote && !!q;
    this.d.ledger.append(now, "withdrawal", { pr, reason: why, fee_disposition: held ? "held" : "forfeit" });
    if (held) {
      const heldUntil = now + laws.fee.expiry_hold_days * 86400;
      this.d.ledger.append(now, "expiry", { pr, account: Number(q["account"]), layer: q["layer"], fee_micro: BigInt(String(q["fee_micro"])), held_until: heldUntil, reason: "withdrawal before any vote" });
    }
    try { await this.d.github.comment(pr, `Withdrawn: ${why}. Fee ${held ? "held for resubmission" : "forfeit"} (Law 8).`); await this.d.github.close(pr); } catch { /* already closed */ }
  }

  /** Article 3, Article 5 and Law 10: carry out owner decisions recorded by the CLI. */
  private async applyOwnerDecisions(laws: Laws, now: number, openNumbers: Set<number>): Promise<void> {
    for (const e of this.events) {
      const isReject = e.type === "owner_reject" || (e.type === "hold_resolved" && e["decision"] === "reject");
      if (!isReject) continue;
      if (this.events.some((a) => a.type === "owner_action_applied" && Number(a["event"]) === e.id)) continue;
      const pr = Number(e["pr"]);
      let disposition = "none";
      if (e.type === "owner_reject") {
        const close = [...this.events].reverse().find((x) => x.type === "vote_close" && Number(x["pr"]) === pr && x.id < e.id);
        const q = [...this.events].reverse().find((x) => x.type === "quote" && Number(x["pr"]) === pr && x.id < e.id);
        const tallyResult = close ? String(close["tally_result"] ?? close["result"]) : "none";
        // Article 3: a rejection after a passing vote is an expiry for the fee; so is one before any tally.
        if (q && tallyResult !== "reject") {
          const heldUntil = now + laws.fee.expiry_hold_days * 86400;
          this.d.ledger.append(now, "expiry", { pr, account: Number(q["account"]), layer: q["layer"], fee_micro: BigInt(String(q["fee_micro"])), held_until: heldUntil, reason: "owner rejection" });
          disposition = "held";
        } else disposition = q ? "forfeit" : "none";
      }
      if (openNumbers.has(pr)) {
        try {
          await this.d.github.comment(pr, e.type === "owner_reject" ? `Rejected by the owner: ${e["reason"]}. Fee ${disposition === "held" ? "held for resubmission" : disposition}.` : `The screening hold was resolved as a rejection: ${e["reason"]}.`);
          await this.d.github.close(pr);
        } catch (err) { this.log(`could not close pr ${pr}: ${(err as Error).message}`); }
      }
      this.d.ledger.append(now, "owner_action_applied", { pr, event: e.id, fee_disposition: disposition });
    }
  }

  private async maybeAdjustFee(laws: Laws, now: number): Promise<void> {
    const last = [...this.events].reverse().find((e) => e.type === "fee_adjust" || e.type === "genesis");
    if (last && now - last.at < laws.fee.adjust_every_hours * 3600) return;
    const state = this.state(now);
    const lookback = now - laws.fee.lookback_hours * 3600;
    const paid = this.events.filter((e) => e.type === "payment" && e["matched"] !== false && e.at >= lookback).length;
    const since = now - laws.fee.target_lookback_days * 86400;
    const qualifiedVotes = this.events.filter((e) => e.type === "review" && Number(e["submitted"]) >= since).length;
    const r = adjustBase({ baseMicro: state.fee.base_micro, paidSubmissionsInLookback: paid, qualifiedVotesInLookback: qualifiedVotes }, laws);
    let anchorTx: string | null = null;
    const head = this.d.ledger.headHash();
    try { anchorTx = await this.d.chain.anchor(head); } catch (e) { this.log(`anchor failed: ${(e as Error).message}`); }
    this.d.ledger.append(now, "fee_adjust", { base_micro: r.baseMicro, submissions_24h: paid, target: r.target, per_day: r.perDay, anchor_tx: anchorTx, ledger_head: head });
  }

  private async maybeEndBootstrap(now: number): Promise<void> {
    const state = this.state(now);
    if (!state.bootstrap.active || !state.bootstrap.began) return;
    if (now - state.bootstrap.began < BOOTSTRAP_MAX_DAYS * 86400) return;
    this.d.ledger.append(now, "declare", { what: "bootstrap_end", reason: `${BOOTSTRAP_MAX_DAYS} days elapsed (Article 3)` });
  }

  private lawsByHash(hash: string, current: Laws): Laws {
    if (this.laws && this.laws.hash === hash) return this.laws.laws;
    const snap = this.events.find((e) => e.type === "laws_snapshot" && e["laws_hash"] === hash);
    if (snap) {
      try { return parseLaws(String(snap["laws_raw"]), String(snap["schema_raw"])).laws; } catch { /* fall through */ }
    }
    this.log(`laws ${hash.slice(0, 12)} not available; using current`);
    return current;
  }

  private async publish(now: number): Promise<void> {
    const head = this.d.ledger.headHash();
    if (head === this.lastPublishedHead) return;
    const state = this.state(now);
    const serialized = this.events.map((e) => JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).join("\n") + (this.events.length ? "\n" : "");
    await this.d.github.publishLedger([
      { path: "ledger/events.jsonl", content: serialized },
      { path: "ledger/state.json", content: serializeState(state) },
    ], `ledger: event ${this.d.ledger.head}`);
    this.lastPublishedHead = head;
  }
}

export function quoteComment(q: LedgerEvent, laws: Laws, base: string): string {
  const lines = [
    `pr: ${q["pr"]}`, `head: ${q["head"]}`, `layer: ${q["layer"]}`,
    `fee_usdc: ${micro(BigInt(String(q["fee_micro"])))}`, `base_usdc: ${micro(BigInt(String(q["base_micro"])))}`,
    `multiplier: ${q["multiplier"]}`, `concurrency: ${q["concurrency"]}`, `size_kb_charged: ${q["size_kb"]}`,
    `terms_commit: ${q["terms_commit"]}`, `destination: ${q["destination"]}`, `network: ${q["network"] ?? laws.fee.network_caip2}`,
    `pay: ${base.replace(/\/$/, "")}/pay/${q["pr"]}`, `expires: ${iso(Number(q["expires"]))}`,
  ];
  return "```nomicon-quote\n" + lines.join("\n") + "\n```\nPay within the validity window with USDC on Base via x402 (see agent/PROTOCOL.md). Paying is acceptance of TERMS.md at the commit shown. Verify the destination against CONSTITUTION.md Article 7 before paying.";
}

export function micro(m: bigint): string {
  const s = m.toString().padStart(7, "0");
  return s.slice(0, -6) + "." + s.slice(-6);
}
export function iso(t: number): string { return new Date(t * 1000).toISOString(); }
