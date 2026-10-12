/**
 * Adversarial scenarios. Each one is an attack or a failure mode from the
 * hostile reviews, run against the real runtime, with explicit claims checked.
 */
import { Sim, acct, DAY, H, OWNER, rawLaws, rawSchema, type Account } from "./harness.js";
import { Signer, samePem, verifyEvent, type LedgerEvent } from "../ledger.js";
import { generateKeyPairSync } from "node:crypto";
import type { FakePull } from "../adapters/mock.js";
import { replay } from "../replay.js";
import { lawsHash } from "./harness.js";

export interface Scenario { name: string; description: string; run(): Promise<Sim> }

const H1 = acct(1, "h1"), H2 = acct(2, "h2"), H3 = acct(3, "h3"), H4 = acct(4, "h4"), H5 = acct(5, "h5");
const X1 = acct(11, "x1"), X2 = acct(12, "x2"), X3 = acct(13, "x3"), X4 = acct(14, "x4");
const W = acct(20, "whale"), N = acct(30, "newcomer"), M = acct(31, "newcomer2");
const yes = (a: Account): [Account, "APPROVED"] => [a, "APPROVED"];
const no = (a: Account): [Account, "CHANGES_REQUESTED"] => [a, "CHANGES_REQUESTED"];

function sc(name: string, description: string, body: (s: Sim) => Promise<void>, opts: ConstructorParameters<typeof Sim>[0] = {}): Scenario {
  return { name, description, async run() { const s = new Sim(opts); await body(s); s.replayCheck(); return s; } };
}

const merged = (s: Sim, pr: FakePull) => s.github.merges.some((m) => m.pr === pr.number);
const closeOf = (s: Sim, pr: FakePull) => s.eventsFor(pr.number).find((e) => e.type === "vote_close");
const openOf = (s: Sim, pr: FakePull) => s.eventsFor(pr.number).find((e) => e.type === "vote_open");
const windowOf = (s: Sim, pr: FakePull) => { const o = openOf(s, pr); return o ? (Number(o["closes"]) - Number(o["opened"])) / H : -1; };

export const scenarios: Scenario[] = [
  sc("honest-flow", "Five founders are seeded during bootstrap. After bootstrap ends and their weight matures, a newcomer passes with three yes votes and is merged.", async (s) => {
    await s.seedFounders([H1, H2, H3, H4, H5]);
    const first = s.events.find((e) => e.type === "vote_open")!;
    s.check("with nobody qualified to vote, the first founder's vote closed the moment it opened (Law 9)", Number(first["closes"]) === Number(first["opened"]));
    s.check("five founders hold mature weight after 31 days", s.state().weighted_accounts === 5, String(s.state().weighted_accounts));
    const pr = await s.submitAndVote(N, { "world/n.md": "hello" }, [yes(H1), yes(H2), yes(H3)]);
    s.check("newcomer merged", merged(s, pr));
    const c = closeOf(s, pr)!;
    s.check("tally recorded merge with three yes voters", c["tally_result"] === "merge" && c["yes_voters"] === 3, JSON.stringify({ tally: c["tally_result"], yes: c["yes_voters"] }));
    const w = s.state().weights["30"];
    s.check("newcomer's weight is immature right after merge", w !== undefined && w.mature_micro === 0n && w.immature_micro > 0n);
  }),

  sc("sybil-bloc", "Three attacker accounts get merged by honest votes, then approve each other. Immature weight does not qualify; after maturity two yes votes still miss the quorum of three. A fourth attacker reaches quorum but honest voters outweigh it.", async (s) => {
    await s.seedFounders([H1, H2, H3, H4]);
    for (const x of [X1, X2, X3, X4]) { const pr = await s.submitAndVote(x, { [`world/${x.login}.md`]: "x" }, [yes(H1), yes(H2), yes(H3)]); s.check(`${x.login} merged by honest votes`, merged(s, pr)); }
    const a1 = await s.submitAndVote(X1, { "world/x1-a.md": "attack" }, [yes(X2), yes(X3), yes(X4)]);
    const o1 = openOf(s, a1)!;
    s.check("bloc accounts are not qualified voters while their weight is immature", !(o1["qualified"] as number[]).some((id) => id >= 11 && id <= 14), JSON.stringify(o1["qualified"]));
    s.check("bloc self-approval expires for lack of quorum", s.eventsFor(a1.number).some((e) => e.type === "expiry"));
    await s.advance(31 * DAY, DAY);
    const a2 = await s.submitAndVote(X1, { "world/x1-b.md": "attack" }, [yes(X2), yes(X3)]);
    s.check("after maturity, two bloc yes votes still fail the quorum of three", closeOf(s, a2)!["tally_result"] === "expire");
    const a3 = await s.submitAndVote(X1, { "world/x1-c.md": "attack" }, [yes(X2), yes(X3), yes(X4), no(H1), no(H2), no(H3), no(H4)]);
    const c3 = closeOf(s, a3)!;
    s.note(`three bloc yes (${c3["yes_micro"]}) against four honest no (${c3["no_micro"]}): ${c3["tally_result"]}`);
    s.check("three bloc yes votes meet quorum but four honest no votes outweigh them", c3["tally_result"] === "reject");
  }),

  sc("whale-cap", "One account with ten merges against four accounts with one each. Its weight is capped to 20 percent of the total mature weight, so it cannot veto.", async (s) => {
    await s.seedFounders([H1, H2, H3, H4], { endBootstrap: false, mature: false });
    await s.seedFounders([W], { mergesEach: 10 });
    const st = s.state();
    const whale = st.weights["20"]!.mature_micro, total = Object.values(st.weights).reduce((a, w) => a + w.mature_micro, 0n);
    s.note(`whale holds ${whale} of ${total} micro-USDC mature weight (${Number((whale * 1000n) / total) / 10} percent)`);
    const pr = await s.submitAndVote(N, { "world/n.md": "x" }, [yes(H1), yes(H2), yes(H3), yes(H4), no(W)]);
    const c = closeOf(s, pr)!;
    const noMicro = BigInt(String(c["no_micro"])), yesMicro = BigInt(String(c["yes_micro"]));
    s.check("whale's no vote counts for at most a fifth of all mature weight", noMicro <= total / 5n, `no=${noMicro} yes=${yesMicro} total=${total}`);
    s.check("four honest yes votes beat the capped whale", c["tally_result"] === "merge");
  }),

  sc("size-and-overpayment-mint-no-weight", "A 200 kB file is quoted base plus size charge, and the submitter pays ten times the quote. The merge mints only the base fee as weight.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const pr = await s.submit(N, { "world/big.md": "x".repeat(200 * 1024) });
    const q = s.rt.quoteFor(pr.number)!;
    s.check("200 kB file is quoted base plus 192 kB of size charge", q.feeMicro === 1_000_000n + 192n * 50_000n, String(q.feeMicro));
    await s.pay(pr.number, 10n); await s.tick();
    s.clock.advance(H); for (const a of [H1, H2, H3]) s.review(pr.number, a, "APPROVED"); await s.tick();
    await s.advance(78 * H);
    const m = s.eventsFor(pr.number).find((e) => e.type === "merge");
    s.check("weight minted equals the base fee only, despite the size charge and the overpayment", m !== undefined && BigInt(String(m["weight_micro"])) === 1_000_000n, String(m?.["weight_micro"]));
    const p = s.eventsFor(pr.number).find((e) => e.type === "payment")!;
    s.check("overpayment recorded as matched and not refunded", BigInt(String(p["amount_micro"])) === q.feeMicro * 10n && p["matched"] === true);
  }),

  sc("bait-and-switch", "A submitter collects a yes vote, then pushes a new commit. The vote is void, the submission is withdrawn, and the fee is forfeit because a vote had been cast.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const pr = await s.submit(N, { "world/n.md": "nice" }); await s.pay(pr.number); await s.tick();
    s.clock.advance(H); s.review(pr.number, H1, "APPROVED"); await s.tick();
    s.github.push(pr.number); await s.tick();
    const w = s.eventsFor(pr.number).find((e) => e.type === "withdrawal");
    s.check("push after a vote was cast is a withdrawal with the fee forfeit", w?.["fee_disposition"] === "forfeit", String(w?.["fee_disposition"]));
    s.check("no held fee was created", !s.eventsFor(pr.number).some((e) => e.type === "expiry"));
    s.check("pull request closed", pr.state === "closed");
  }),

  sc("withdrawal-before-any-vote", "A submitter closes the pull request after paying but before anyone votes. The fee is held for resubmission.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const pr = await s.submit(N, { "world/n.md": "x" }); await s.pay(pr.number); await s.tick();
    await s.github.close(pr.number); await s.tick();
    const w = s.eventsFor(pr.number).find((e) => e.type === "withdrawal");
    s.check("closing before any vote holds the fee", w?.["fee_disposition"] === "held" && s.state().held_fees.some((f) => f.account === N.id), String(w?.["fee_disposition"]));
  }),

  sc("fee-pump", "Ten attacker accounts open three paid submissions a day for twelve days with nobody voting. Concurrency pricing makes every further queued submission cost double, the vote queue fills and the agent stops quoting, the base fee rises to its cap for as long as more paid contributions wait than can be open, and it falls back to the floor once the junk has drained through the queue.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const attackers = Array.from({ length: 10 }, (_, i) => acct(40 + i, `spam${i}`));
    let spent = 0n, maxBase = 0n;
    for (let d = 0; d < 12; d++) {
      for (const a of attackers) for (let i = 0; i < 3; i++) {
        const pr = await s.submit(a, { [`world/spam/${a.login}-${d}-${i}.md`]: "spam" });
        const q = s.rt.quoteFor(pr.number); if (q) { spent += q.feeMicro; await s.pay(pr.number); }
      }
      await s.advance(DAY);
      if (s.state().fee.base_micro > maxBase) maxBase = s.state().fee.base_micro;
    }
    s.note(`attackers spent ${spent / 1_000_000n} USDC over 12 days; peak base fee ${Number(maxBase) / 1e6} USDC`);
    s.check("quoting paused while the paid queue was full, and the base rose to its cap because a full queue is demand (Law 5)", maxBase === 10_000_000n && s.events.some((e) => e.type === "screen_deferred" && e["reason"] === "capacity"), String(maxBase));
    s.check("base fee never exceeds the cap", maxBase <= 10_000_000n);
    s.check("the flood cost the attackers more than 10,000 USDC", spent > 10_000_000_000n, String(spent / 1_000_000n));
    const waiting = () => [...new Set(s.events.filter((e) => e.type === "quote").map((e) => Number(e["pr"])))].filter((pr) => s.phase(pr).kind === "paid").length;
    let weeks = 0;
    while ((waiting() > 0 || s.state().open_votes.length > 0) && weeks < 40) { await s.advance(7 * DAY); weeks++; }
    s.note(`the junk drained through the queue in ${weeks} weeks; a held fee is applied once, so each junk submission got at most two windows`);
    await s.advance(7 * DAY);
    s.check("base fee returns to the floor within a week of the queue draining", s.state().fee.base_micro === 1_000_000n, String(s.state().fee.base_micro));
  }),

  sc("protected-paths", "Changes that touch the Constitution, the ledger, owner files, a workflow, a case-colliding filename, a symbolic link or a non-ASCII path are rejected at intake with no fee. A README change is quoted at the Laws multiplier.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const cases: Array<[string, Record<string, string>]> = [
      ["editing CONSTITUTION.md", { "CONSTITUTION.md": "hacked" }],
      ["adding Laws.json beside laws.json", { "Laws.json": "{}" }],
      ["adding a workflow under .github", { ".github/workflows/x.yml": "on: push" }],
      ["writing to the ledger", { "ledger/events.jsonl": "" }],
      ["editing NOTICES.md", { "NOTICES.md": "x" }],
      ["a non-ASCII path", { "world/wоrld.md": "x" }],
      ["an HTML file in the World", { "world/page.html": "<b>" }],
    ];
    for (const [name, files] of cases) {
      const pr = await s.submit(X1, files);
      s.check(`${name} is rejected at intake with no quote`, s.phase(pr.number).kind === "intake_rejected" && !s.eventsFor(pr.number).some((e) => e.type === "quote"), s.phase(pr.number).kind);
    }
    const sym = s.github.open(X1, { "world/link.md": "x" }); sym.files[0]!.mode = "120000"; await s.tick();
    s.check("a symbolic link is rejected", s.phase(sym.number).kind === "intake_rejected");
    const readme = await s.submit(X1, { "README.md": "changed" });
    s.check("a README change is Laws-layer and quoted at ten times the base", s.rt.quoteFor(readme.number)?.feeMicro === 10_000_000n, String(s.rt.quoteFor(readme.number)?.feeMicro));
  }),

  sc("laws-capture-attempt", "Three mature attacker accounts submit a laws.json that sets the World quorum to one and the window to one hour. The Laws quorum of five defeats it. Even if such a file reached the ledger as a snapshot, the agent refuses it under Article 9A and keeps the rules in force.", async (s) => {
    await s.seedFounders([H1, H2, H3, H4, H5, X1, X2, X3]);
    const malicious = JSON.parse(rawLaws); malicious.vote.world.quorum_yes_voters = 1; malicious.vote.world.window_hours = 1;
    const pr = await s.submit(X1, { "laws.json": JSON.stringify(malicious) });
    s.check("a Laws change is quoted at ten times the base", s.rt.quoteFor(pr.number)?.feeMicro === 10_000_000n);
    await s.pay(pr.number); await s.tick();
    s.check("Laws vote window is 168 hours", windowOf(s, pr) === 168, String(windowOf(s, pr)));
    s.clock.advance(H); s.review(pr.number, X2, "APPROVED"); s.review(pr.number, X3, "APPROVED"); await s.tick();
    await s.advance(174 * H);
    const c = closeOf(s, pr)!;
    s.check("two bloc yes votes fail the Laws quorum of five", c["tally_result"] === "expire" && c["quorum"] === 5, JSON.stringify({ quorum: c["quorum"], yes: c["yes_voters"] }));
    s.ledger.append(s.clock.now(), "laws_snapshot", { pr: pr.number, laws_hash: "deadbeef", laws_raw: JSON.stringify(malicious), schema_raw: rawSchema, effective_at: s.clock.now(), merge_commit: "x" });
    await s.tick();
    s.check("agent records a refusal for the non-compliant snapshot", s.events.some((e) => e.type === "refusal"));
    const probe = await s.submit(N, { "world/probe.md": "x" }); await s.pay(probe.number); await s.tick();
    s.check("rules in force are unchanged: the next World vote still has a 72-hour window", windowOf(s, probe) === 72, String(windowOf(s, probe)));
  }),

  sc("laws-change-takes-effect-after-delay", "Five founders pass a Laws change that makes the World window 96 hours. It takes effect 14 days after merging; a vote opened before then keeps 72 hours, one opened after gets 96.", async (s) => {
    await s.seedFounders([H1, H2, H3, H4, H5]);
    const changed = JSON.parse(rawLaws); changed.vote.world.window_hours = 96; changed.version = 3;
    const pr = await s.submitAndVote(N, { "laws.json": JSON.stringify(changed) }, [yes(H1), yes(H2), yes(H3), yes(H4), yes(H5)], 168);
    s.check("Laws change with five yes votes merges", merged(s, pr));
    const snap = s.events.find((e) => e.type === "laws_snapshot" && e["pr"] === pr.number);
    s.check("snapshot takes effect 14 days after the merge", snap !== undefined && Number(snap["effective_at"]) - snap.at === 14 * DAY);
    const before = await s.submit(M, { "world/before.md": "x" }); await s.pay(before.number); await s.tick();
    s.check("a vote opened before the effective time keeps the 72-hour window", windowOf(s, before) === 72, String(windowOf(s, before)));
    await s.advance(15 * DAY, DAY);
    const after = await s.submit(M, { "world/after.md": "x" }); await s.pay(after.number); await s.tick();
    s.check("a vote opened after the effective time gets the 96-hour window", windowOf(s, after) === 96, String(windowOf(s, after)));
  }),

  sc("illegal-content-holds", "Content the screen flags is held with no fee. The owner rejects one hold and bars the author; a second hold times out after 14 days; a third is released by the owner and proceeds to a quote without a second screen.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const a = await s.submit(X1, { "world/a.md": "ILLEGAL" });
    s.check("flagged content is held with no quote", s.phase(a.number).kind === "held" && s.rt.quoteFor(a.number) === null);
    s.holdReject(a.number); await s.tick();
    s.check("hold rejected by the owner closes the pull request", a.state === "closed");
    const b = await s.submit(X1, { "world/b.md": "fine" });
    s.check("the barred author's next submission is rejected at intake", s.phase(b.number).kind === "intake_rejected");
    const c = await s.submit(X2, { "world/c.md": "ILLEGAL" });
    await s.advance(15 * DAY, DAY);
    s.check("an unresolved hold times out and closes without charge", c.state === "closed" && !s.eventsFor(c.number).some((e) => e.type === "quote"));
    const d = await s.submit(X3, { "world/d.md": "ILLEGAL" });
    s.release(d.number); await s.tick();
    s.check("a released hold is quoted without being screened again", s.phase(d.number).kind === "quoted" && s.eventsFor(d.number).filter((e) => e.type === "screen_hold").length === 1, s.phase(d.number).kind);
  }, { holdIf: (i) => (i.files.some((f) => f.content.includes("ILLEGAL")) ? { decision: "hold", reasonClass: "unlawful", note: "sim" } : null) }),

  sc("apathy-and-held-fee", "Nobody votes on a newcomer. The contribution expires with the fee held; a resubmission is quoted at zero against it; when that too expires the fee is forfeit, since a held fee is applied once; a further submission pays again.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const pr = await s.submitAndVote(N, { "world/n1.md": "x" });
    s.check("no votes: expired with the fee held", s.phase(pr.number).kind === "done" && s.state().held_fees.some((f) => f.account === N.id));
    const pr2 = await s.submit(N, { "world/n2.md": "y" });
    s.check("resubmission is covered by the held fee with nothing to pay", s.phase(pr2.number).kind === "paid", s.phase(pr2.number).kind);
    await s.tick(); await s.advance(78 * H);
    s.check("the second expiry forfeits the held fee: it was applied once (Law 5)", !s.state().held_fees.some((f) => f.account === N.id) && s.state().held_in_use[pr2.number] === undefined);
    await s.advance(91 * DAY, DAY);
    const third = await s.submit(N, { "world/n/third.md": "z" });
    s.check("a further submission pays the full fee again", BigInt(String(s.eventsFor(third.number).find((e) => e.type === "quote")!["fee_micro"])) > 0n);
  }),

  sc("bootstrap-owner-decisions", "During bootstrap a passing tally waits for the owner. A rejection after a pass holds the fee, and thirty days of owner silence expires a submission with the fee held.", async (s) => {
    await s.seedFounders([H1, H2, H3], { endBootstrap: false });
    const pr = await s.submitAndVote(N, { "world/n.md": "x" }, [yes(H1), yes(H2), yes(H3)]);
    s.check("a passing tally waits for the owner during bootstrap", s.phase(pr.number).kind === "await_owner" && closeOf(s, pr)!["tally_result"] === "merge", s.phase(pr.number).kind);
    s.reject(pr.number); await s.tick();
    s.check("owner rejection after a passing vote holds the fee (Article 3)", s.eventsFor(pr.number).some((e) => e.type === "expiry" && e["reason"] === "owner rejection") && s.state().held_fees.some((f) => f.account === N.id));
    s.check("pull request closed and not merged", pr.state === "closed" && !merged(s, pr));
    const pr2 = await s.submitAndVote(M, { "world/m.md": "x" });
    await s.advance(31 * DAY, DAY);
    s.check("thirty days of owner silence after close expires the submission with the fee held", s.eventsFor(pr2.number).some((e) => e.type === "expiry") && s.state().held_fees.some((f) => f.account === M.id));
    s.confirm(pr2.number); await s.tick();
    s.check("a confirmation that arrives after the expiry is stale and changes nothing", !merged(s, pr2) && s.phase(pr2.number).kind === "done" && !s.eventsFor(pr2.number).some((e) => e.type === "merge"));
  }),

  sc("tamper-detection", "After an honest flow, a copy of the ledger with one merge's weight altered fails both the signature check and the arithmetic replay.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const pr = await s.submitAndVote(N, { "world/n.md": "x" }, [yes(H1), yes(H2), yes(H3)]);
    s.check("baseline merge", merged(s, pr));
    const copy = s.events.map((e) => ({ ...e }));
    const m = copy.find((e) => e.type === "merge" && e["pr"] === pr.number)!;
    m["weight_micro"] = "999000000";
    const r = replay(copy, new Map([[lawsHash, rawLaws]]), rawSchema, s.signer.publicKeyPem(), s.clock.now());
    s.check("tampered ledger is detected", !r.ok && r.findings.some((f) => f.event === m.id && f.problem.includes("signature")), r.findings.map((f) => f.problem).join("; "));
  }),

  sc("questions-and-mentions", "A merged file asks a question; a later merged file answers it and cites a third. The index records the question as open then answered, and the agent mentions the asker and the cited author, never the answerer.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const ask = await s.submitAndVote(N, { "world/q/facilitators.md": "---\nnomicon:\n  question: \"Which facilitators settle on Base within a minute?\"\n---\n\n# Facilitators\n" }, [yes(H1), yes(H2), yes(H3)]);
    s.check("the question is indexed as open after merge", merged(s, ask) && s.rt.questionsIndex().open.some((q) => q.id === "world/q/facilitators.md"));
    const cited = await s.submitAndVote(M, { "world/notes/base.md": "# Base notes\n" }, [yes(H1), yes(H2), yes(H3)]);
    s.check("cited entry merged", merged(s, cited));
    const ans = await s.submitAndVote(H4, { "world/a/facilitators-answer.md": "---\nnomicon:\n  answers: [world/q/facilitators.md]\n  cites: [world/notes/base.md]\n---\n\nx402.org settles in about ten seconds.\n" }, [yes(H1), yes(H2), yes(H3)]);
    s.check("answer merged", merged(s, ans));
    const idx = s.rt.questionsIndex();
    s.check("the question moved from open to answered", !idx.open.some((q) => q.id === "world/q/facilitators.md") && idx.answered.some((q) => q.id === "world/q/facilitators.md" && q.answers[0]?.by === H4.id));
    const mentions = s.events.filter((e) => e.type === "notice" && e["kind"] === "mention" && e["pr"] === ans.number).map((e) => Number(e["target"])).sort();
    s.check("asker and cited author were mentioned, the answerer was not", JSON.stringify(mentions) === JSON.stringify([N.id, M.id].sort()), JSON.stringify(mentions));
    const comment = s.github.pulls.get(ans.number)!.comments.find((c) => c.includes("@newcomer"));
    s.check("the mention comment names the asker", comment !== undefined);
  }),

  sc("mention-cap", "A merge citing thirty entries by thirty authors mentions at most ten of them.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const authors = Array.from({ length: 30 }, (_, i) => acct(200 + i, `w${i}`));
    for (const a of authors) { const pr = await s.submitAndVote(a, { [`world/w/${a.login}.md`]: "x" }, [yes(H1), yes(H2), yes(H3)]); if (!merged(s, pr)) s.check(`${a.login} merged`, false); }
    const cites = authors.map((a) => `world/w/${a.login}.md`);
    const big = await s.submitAndVote(N, { "world/w/survey.md": `---\nnomicon:\n  cites: [${cites.join(", ")}]\n---\n\nSurvey.\n` }, [yes(H1), yes(H2), yes(H3)]);
    const n = s.events.filter((e) => e.type === "notice" && e["kind"] === "mention" && e["pr"] === big.number).length;
    s.check("exactly ten mentions were sent", merged(s, big) && n === 10, String(n));
  }),

  sc("doorbell", "An account registers a doorbell by commenting on the doorbell issue. It receives signed deliveries for events that concern it and nothing for events that do not. A dead doorbell is retired after repeated failures and the account is told by mention.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    s.github.commentOnIssue(s.doorbellIssue, N, "doorbell: https://newcomer.example/hook/secret-123");
    await s.tick();
    s.check("registration recorded as a channel event with a hash, not the URL", s.events.some((e) => e.type === "channel" && e["account"] === N.id && e["status"] === "active" && typeof e["url_hash"] === "string" && !JSON.stringify(e).includes("secret-123")));
    const before = s.doorbell.deliveries.length;
    const pr = await s.submitAndVote(N, { "world/n.md": "x" }, [yes(H1), yes(H2), yes(H3)]);
    await s.tick();
    const mine = s.doorbell.deliveries.slice(before).map((d) => JSON.parse(d.body) as { type: string; sig?: string; pr?: number });
    s.check("the newcomer's doorbell received its quote, vote open, close and merge", ["quote", "vote_open", "vote_close", "merge"].every((t) => mine.some((d) => d.type === t && d.pr === pr.number)), mine.map((d) => d.type).join(","));
    s.check("every delivery carries the ledger signature", mine.every((d) => typeof d.sig === "string" && d.sig.length > 0));
    s.check("deliveries were recorded as notices", s.events.some((e) => e.type === "notice" && e["kind"] === "doorbell" && e["target"] === N.id && e["ok"] === true));
    const other = await s.submitAndVote(M, { "world/m.md": "y" }, [yes(H1), yes(H2), yes(H3)]);
    const leaked = s.doorbell.deliveries.map((d) => JSON.parse(d.body) as { pr?: number; type: string }).filter((d) => d.pr === other.number && d.type !== "vote_open");
    s.check("another account's submission was not delivered to the newcomer's doorbell", leaked.length === 0, leaked.map((d) => d.type).join(","));
    s.doorbell.failing.add("https://newcomer.example/hook/secret-123");
    for (let i = 0; i < 31; i++) { await s.submit(N, { [`world/n-${i}.md`]: "z" }); }
    s.check("a doorbell that keeps failing is retired", s.events.some((e) => e.type === "channel" && e["account"] === N.id && e["status"] === "retired"));
    s.check("the account was told by mention on the doorbell issue", (s.github.issueComments[s.doorbellIssue] ?? []).some((c) => c.account === 0 && c.body.includes("@newcomer")));
    s.github.commentOnIssue(s.doorbellIssue, N, "doorbell: https://newcomer.example/hook/secret-123");
    await s.tick();
    s.check("posting the address again re-registers it", s.events.filter((e) => e.type === "channel" && e["account"] === N.id && e["status"] === "active").length === 2);
    s.github.commentOnIssue(s.doorbellIssue, M, "doorbell: http://10.0.0.7/hook");
    await s.tick();
    s.check("a plain-http or private address is refused, recorded, and the account told", s.events.some((e) => e.type === "channel" && e["account"] === M.id && e["status"] === "refused") && (s.github.issueComments[s.doorbellIssue] ?? []).some((c) => c.account === 0 && c.body.includes("@newcomer2")));
    s.check("nothing is ever delivered to a refused address", !s.doorbell.deliveries.some((d) => d.url.includes("10.0.0.7")));
  }),

  sc("digest-and-watchers", "After seven days the agent posts a digest listing the week's merges and open questions, and records who watches the repository.", async (s) => {
    s.github.watchers.push({ id: H1.id, login: H1.login });
    await s.seedFounders([H1, H2, H3]);
    await s.submitAndVote(N, { "world/q/one.md": "---\nnomicon:\n  question: \"What is the cheapest RPC for Base Sepolia?\"\n---\n" }, [yes(H1), yes(H2), yes(H3)]);
    await s.advance(8 * DAY, DAY);
    const digests = s.github.discussions;
    s.check("at least one digest was posted after a week", digests.length >= 1, String(digests.length));
    const last = digests[digests.length - 1]!;
    s.check("the digest lists the open question", last.body.includes("cheapest RPC"));
    s.check("the digest is recorded in the ledger", s.events.some((e) => e.type === "digest"));
    s.check("the watcher was recorded as a channel", s.events.some((e) => e.type === "channel" && e["channel"] === "watch" && e["account"] === H1.id));
    const recorded = s.events.filter((e) => e.type === "digest").length;
    s.github.discussionsEnabled = false;
    await s.advance(8 * DAY, DAY);
    s.check("a failed digest post is not recorded and does not stop the agent", s.events.filter((e) => e.type === "digest").length === recorded && s.notes.some((n) => n.includes("digest not posted")) && s.github.merges.length > 0);
  }),

  sc("tie-expires", "Six founders merged in the same instant hold identical weight. Three vote yes and three vote no: equal weight is no decision, so the contribution expires with the fee held and nothing outside the ledger is consulted.", async (s) => {
    await s.seedFoundersTogether([H1, H2, H3, H4, H5, X1]);
    const w = [H1, H2, H3, H4, H5, X1].map((a) => s.state().weights[String(a.id)]?.mature_micro ?? -1n);
    s.check("the six founders hold identical mature weight", w.every((x) => x === w[0]) && w[0]! > 0n, w.map(String).join(","));
    const pr = await s.submitAndVote(N, { "world/n.md": "x" }, [yes(H1), yes(H2), yes(H3), no(H4), no(H5), no(X1)]);
    const c = closeOf(s, pr)!;
    s.check("the tally records an exact tie and expiry", c["tie"] === true && c["tally_result"] === "expire" && String(c["yes_micro"]) === String(c["no_micro"]), `yes ${String(c["yes_micro"])} no ${String(c["no_micro"])} ${String(c["tally_result"])} tie ${String(c["tie"])}`);
    s.check("the fee is held for resubmission, nothing merged", !merged(s, pr) && s.state().held_fees.some((f) => f.account === N.id));
  }),

  sc("intake-recheck-at-close", "Two approved submissions add world/Foo.md and world/foo.md. Both passed intake at quote time; at close the second is checked again against the main the first changed and expires for the case collision Law 6 forbids.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const a = s.github.open(N, { "world/Foo.md": "a" }), b = s.github.open(M, { "world/foo.md": "b" });
    await s.tick(); await s.pay(a.number); await s.pay(b.number); await s.tick();
    s.clock.advance(H); for (const v of [H1, H2, H3]) { s.review(a.number, v, "APPROVED"); s.review(b.number, v, "APPROVED"); } await s.tick();
    await s.advance(78 * H);
    s.check("the first merged", merged(s, a));
    s.check("the second expired at close for the collision, fee held", !merged(s, b) && s.eventsFor(b.number).some((e) => e.type === "expiry" && String(e["reason"]).includes("intake")) && s.state().held_fees.some((f) => f.account === M.id), s.eventsFor(b.number).map((e) => e.type).join(","));
  }),

  sc("close-order", "Two approved submissions add the same path and their windows close in the same tick. The platform lists the newer first; the agent settles the older first, so it merges and the newer expires as unmergeable.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const a = s.github.open(N, { "world/same.md": "from N" }), b = s.github.open(M, { "world/same.md": "from M" });
    await s.tick(); await s.pay(a.number); await s.pay(b.number); await s.tick();
    s.clock.advance(H); for (const v of [H1, H2, H3]) { s.review(a.number, v, "APPROVED"); s.review(b.number, v, "APPROVED"); } await s.tick();
    await s.advance(78 * H);
    s.check("the older submission merged", merged(s, a));
    s.check("the newer one expired with its fee held", !merged(s, b) && s.eventsFor(b.number).some((e) => e.type === "expiry") && s.state().held_fees.some((f) => f.account === M.id), s.eventsFor(b.number).map((e) => e.type).join(","));
  }),

  sc("crash-recovery", "GitHub performs a merge but the agent dies before recording it; later a merge call fails before GitHub performed it. After each, the next tick leaves the ledger explaining the repository: one merge event, weight minted once.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    s.github.failNextMerge = "after";
    const a = await s.submit(N, { "world/a.md": "a" }); await s.pay(a.number); await s.tick();
    s.clock.advance(H); for (const v of [H1, H2, H3]) s.review(a.number, v, "APPROVED"); await s.tick();
    await s.advance(78 * H);
    s.check("the tick that lost the merge response skipped that pull request, went on, and a later tick found the merge GitHub had made", s.logs.some((n) => n.includes("skipped this tick")) && s.github.pulls.get(a.number)!.merged);
    const m = s.eventsFor(a.number).filter((e) => e.type === "merge");
    s.check("the next tick recorded the merge GitHub had already made, exactly once, with its commit", m.length === 1 && String(m[0]!["merge_commit"]) === s.github.pulls.get(a.number)!.mergeCommit);
    s.github.failNextMerge = "before";
    const b = await s.submit(M, { "world/b.md": "b" }); await s.pay(b.number); await s.tick();
    s.clock.advance(H); for (const v of [H1, H2, H3]) s.review(b.number, v, "APPROVED"); await s.tick();
    const logsBefore = s.logs.length;
    await s.advance(78 * H);
    s.check("the tick whose merge call failed skipped only that pull request and a later tick retried it", s.logs.slice(logsBefore).some((n) => n.includes("skipped this tick")) && merged(s, b));
    s.check("the next tick retried and merged, once", merged(s, b) && s.eventsFor(b.number).filter((e) => e.type === "merge").length === 1);
    s.check("both authors hold weight", s.state().weights[String(N.id)] !== undefined && s.state().weights[String(M.id)] !== undefined);
  }),

  sc("screen-spam", "One account opens seven submissions and pays for none. Five are screened; two wait without being screened or touching the platform, commented on once. Paying one quote frees a place; a day later the rest are screened. Quotes that lapse and renew reuse the earlier pass instead of screening the same content again.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const before = s.screen.calls;
    const prs = [];
    for (let i = 0; i < 7; i++) prs.push(s.github.open(X1, { [`world/spam/${i}.md`]: `junk ${i}` }));
    await s.tick();
    s.check("five submissions were screened and quoted", s.screen.calls - before === 5 && prs.filter((p) => s.rt.quoteFor(p.number)).length === 5, String(s.screen.calls - before));
    const deferred = prs.filter((p) => s.eventsFor(p.number).some((e) => e.type === "screen_deferred"));
    s.check("the other two wait, each recorded and commented on once", deferred.length === 2 && deferred.every((p) => p.comments.filter((c) => c.startsWith("Waiting")).length === 1));
    await s.tick(); await s.tick();
    s.check("waiting submissions are not screened again or re-commented on later ticks", s.screen.calls - before === 5 && deferred.every((p) => p.comments.length === 1 && s.eventsFor(p.number).filter((e) => e.type === "screen_deferred").length === 1));
    await s.pay(prs[0]!.number); await s.tick();
    s.check("paying one quote frees a place and one waiting submission is screened", s.screen.calls - before === 6 && deferred.filter((p) => s.rt.quoteFor(p.number)).length === 1, String(s.screen.calls - before));
    const callsBeforeLapse = s.screen.calls;
    await s.advance(26 * H, H);
    s.check("a day later the last waiting submission is screened", deferred.every((p) => s.eventsFor(p.number).some((e) => e.type === "quote")));
    const renewed = s.events.filter((e) => e.type === "quote" && e["screening"] === "reused");
    s.check("lapsed quotes were renewed without screening the same content again", renewed.length >= 4 && s.screen.calls - callsBeforeLapse === 1, `renewed ${renewed.length}, new calls ${s.screen.calls - callsBeforeLapse}`);
    s.check("another account is unaffected by this account's limit", await (async () => { const n = s.screen.calls; const p = await s.submit(M, { "world/m.md": "fine" }); return s.screen.calls === n + 1 && s.rt.quoteFor(p.number) !== null; })());
  }),

  sc("screen-budget", "Thirty-six accounts that never paid each open a 1 MB submission in one tick, after one of them already used its 4 MB. Only the newcomers' half of the 32 MB daily budget is screened; the rest wait. A founder who has paid is still screened. A day later the freed budget screens sixteen more, and the remainder the day after.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const big = () => Object.fromEntries([0, 1, 2, 3].map((i) => [`world/big/${Math.random().toString(36).slice(2)}-${i}.md`, "x".repeat(256 * 1024)]));
    const before = s.screen.calls;
    for (let i = 0; i < 5; i++) s.github.open(X2, big());
    await s.tick();
    s.check("one account is screened up to 4 MB a day and its fifth submission waits", s.screen.calls - before === 4 && s.events.some((e) => e.type === "screen_deferred" && e["account"] === X2.id && e["reason"] === "account_bytes"), String(s.screen.calls - before));
    const flood = Array.from({ length: 36 }, (_, i) => acct(500 + i, `flood${i}`));
    const prs = flood.map((a) => s.github.open(a, big()));
    await s.tick();
    const screened = prs.filter((p) => s.rt.quoteFor(p.number)).length;
    s.check("newcomers get the remaining 12 MB of their 16 MB half; the other 24 wait on the global budget", screened === 12 && prs.filter((p) => s.eventsFor(p.number).some((e) => e.type === "screen_deferred" && e["reason"] === "newcomer_bytes")).length === 24, `screened ${screened}`);
    const founder = s.github.open(H1, big());
    await s.tick();
    s.check("an account that has paid before is still screened from the reserved half", s.rt.quoteFor(founder.number) !== null);
    const calls = s.screen.calls;
    await s.advance(25 * H, H);
    s.check("a day later the freed budget screens sixteen more", s.screen.calls - calls === 16, String(s.screen.calls - calls));
    const calls2 = s.screen.calls;
    await s.advance(24 * H, H);
    s.check("and the rest the day after, nothing screened twice", s.screen.calls - calls2 === 9 && prs.every((p) => s.eventsFor(p.number).filter((e) => e.type === "quote" && e["screening"] === "model").length === 1), String(s.screen.calls - calls2));
  }),

  sc("vote-queue", "Two hundred accounts each pay for a submission in one day. Only eighteen votes open at once; the rest wait in order of payment, told their position, and open as earlier votes close. A two-hundred-and-first submission is not even quoted while the queue is that long.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const accounts = Array.from({ length: 200 }, (_, i) => acct(1000 + i, `q${i}`));
    const prs = accounts.map((a) => s.github.open(a, { [`world/q/${a.login}.md`]: `entry by ${a.login}` }));
    await s.tick();
    s.check("all two hundred were quoted", prs.every((p) => s.rt.quoteFor(p.number) !== null));
    for (const p of prs) await s.pay(p.number);
    await s.tick();
    const queued = s.events.filter((e) => e.type === "vote_queued");
    s.check("eighteen votes opened and the other 182 were queued with positions 1 to 182 in payment order", s.state().open_votes.length === 18 && queued.length === 182 && queued.every((e, i) => Number(e["position"]) === i + 1 && Number(e["pr"]) === prs[18 + i]!.number), `open ${s.state().open_votes.length}, queued ${queued.length}`);
    s.check("each queued submission was told once", prs.slice(18).every((p) => p.comments.filter((c) => c.startsWith("Paid.")).length === 1));
    const late = s.github.open(N, { "world/q/late.md": "late" });
    await s.tick();
    s.check("with 182 paid and waiting, a new submission is not quoted but told why, and not screened", s.rt.quoteFor(late.number) === null && s.eventsFor(late.number).some((e) => e.type === "screen_deferred" && e["reason"] === "capacity"));
    await s.tick(); await s.tick();
    s.check("the queue does not re-comment on later ticks", prs.slice(18).every((p) => p.comments.filter((c) => c.startsWith("Paid.")).length === 1) && s.events.filter((e) => e.type === "vote_queued").length === 182);
    await s.advance(78 * H);
    const opened = s.events.filter((e) => e.type === "vote_open").map((e) => Number(e["pr"]));
    s.check("when the first eighteen closed, the next eighteen opened in payment order", s.state().open_votes.length === 18 && JSON.stringify(opened.slice(-18)) === JSON.stringify(prs.slice(18, 36).map((p) => p.number)), String(s.state().open_votes.length));
    s.check("the first eighteen expired unreviewed with their fees held, nothing merged", prs.slice(0, 18).every((p) => s.eventsFor(p.number).some((e) => e.type === "expiry")) && s.github.merges.length === 3);
  }),

  sc("reciprocity", "A member who can vote submits again while three votes are open: the quote waits until they have voted on all three, either way. An account whose weight has not matured owes nothing, and when nothing is open nothing is owed.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const first = await s.submitAndVote(N, { "world/n/first.md": "first" }, [yes(H1), yes(H2), yes(H3)]);
    s.check("the member's first entry merged", merged(s, first));
    await s.advance(31 * DAY, DAY);
    const others: FakePull[] = [];
    for (const x of [X1, X2, X3]) { const p = await s.submit(x, { [`world/x/${x.login}.md`]: "entry" }); await s.pay(p.number); others.push(p); }
    await s.tick();
    s.check("three votes are open that the member qualifies for", s.state().open_votes.length === 3 && s.state().open_votes.every((v) => v.qualified.includes(N.id)));
    const callsBefore = s.screen.calls;
    const again = await s.submit(N, { "world/n/second.md": "second" });
    s.check("the member's next submission waits for three votes, told once with examples, and is not screened meanwhile", s.rt.quoteFor(again.number) === null && s.eventsFor(again.number).some((e) => e.type === "screen_deferred" && e["reason"] === "votes_owed") && again.comments.filter((c) => c.includes("owes 3 votes")).length === 1 && s.screen.calls === callsBefore);
    s.clock.advance(H);
    s.review(others[0]!.number, N, "APPROVED"); await s.tick();
    s.check("one vote is recorded in the ledger as cast, before any window closes", s.events.some((e) => e.type === "review" && e["account"] === N.id && e["pr"] === others[0]!.number) && s.rt.quoteFor(again.number) === null);
    s.review(others[1]!.number, N, "CHANGES_REQUESTED"); s.review(others[2]!.number, N, "APPROVED"); await s.tick();
    s.check("after three votes of either kind the quote is issued", s.rt.quoteFor(again.number) !== null);
    const x1Again = await s.submit(X1, { "world/x/x1-again.md": "again" });
    s.check("an account whose weight has not matured owes nothing", s.rt.quoteFor(x1Again.number) !== null);
    for (const p of others) { for (const v of [H1, H2, H3]) s.review(p.number, v, "APPROVED"); }
    await s.advance(78 * H);
    s.check("the three entries merged with the member's votes counted at close", others.every((p) => merged(s, p)) && others.every((p) => s.eventsFor(p.number).filter((e) => e.type === "review" && e["account"] === N.id).length === 1));
    const idle = await s.submit(H1, { "world/h1/later.md": "later" });
    s.check("with no open vote the founder qualifies for, nothing is owed and the quote is immediate", s.rt.quoteFor(idle.number) !== null, s.eventsFor(idle.number).map((e) => `${e.type}:${String(e["reason"] ?? "")}`).join(",") + ` open=${s.state().open_votes.length}`);
  }),

  sc("growth-budget", "Under Laws that allow the World to grow 2 MB in thirty days, two 1 MB entries merge and a third waits at no charge, while a Laws-layer change is unaffected; thirty days later the third proceeds.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const big = () => Object.fromEntries([0, 1, 2, 3].map((i) => [`world/big/${Math.random().toString(36).slice(2)}-${i}.md`, "x".repeat(256 * 1024)]));
    const a = await s.submitAndVote(N, big(), [yes(H1), yes(H2), yes(H3)]);
    const b = await s.submitAndVote(M, big(), [yes(H1), yes(H2), yes(H3)]);
    s.check("two 1 MB entries merged and their bytes are recorded", merged(s, a) && merged(s, b) && s.eventsFor(b.number).some((e) => e.type === "merge" && Number(e["bytes"]) === 4 * 256 * 1024));
    const c = await s.submit(X1, big());
    s.check("a third waits on the growth budget, told why, with no quote", s.rt.quoteFor(c.number) === null && s.eventsFor(c.number).some((e) => e.type === "screen_deferred" && e["reason"] === "growth"), s.eventsFor(c.number).map((e) => `${e.type}:${String(e["reason"] ?? "")}`).join(","));
    const readme = await s.submit(X2, { "README.md": "# Nomicon, revised" });
    s.check("a Laws-layer change is not held by the World's growth budget", s.rt.quoteFor(readme.number) !== null && s.eventsFor(readme.number).some((e) => e.type === "quote" && e["layer"] === "laws"));
    await s.advance(31 * DAY, DAY);
    s.check("thirty days later the waiting entry is quoted", s.eventsFor(c.number).some((e) => e.type === "quote"));
  }, { laws: (l) => { l.content.max_world_growth_kb_per_month = 2048; } }),

  sc("key-rotation", "The owner rotates the ledger signing key: the rotation is signed by the key in force and names the next key, which signs everything after. Replay follows the chain from the Constitution's key. A rotation signed by the wrong key, and a lost-key rotation announced less than fourteen days earlier, are both findings.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const next = new Signer(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string);
    const rot = s.ledger.append(s.clock.now(), "key_rotation", { new_public_key: next.publicKeyPem(), commit: "cc".repeat(20), reason: "scheduled rotation", by: OWNER.id });
    s.ledger.setSigner(next);
    const pr = await s.submitAndVote(N, { "world/n/after-rotation.md": "x" }, [yes(H1), yes(H2), yes(H3)]);
    s.check("a contribution merged under the new key, every event after the rotation signed by it", merged(s, pr) && s.events.filter((e) => e.id > rot.id).every((e) => verifyEvent(e, next.publicKeyPem())));
    s.check("the state names the key in force", s.state().ledger_key !== null && samePem(String(s.state().ledger_key), next.publicKeyPem()));
    const original = s.signer.publicKeyPem();
    const copy = s.events.map((e) => ({ ...e }));
    const badRot = copy.find((e) => e.id === rot.id)!;
    badRot.sig = next.sign(badRot); // canonical JSON ignores sig
    const r1 = replay(copy, new Map([[lawsHash, rawLaws]]), rawSchema, original, s.clock.now());
    s.check("a rotation signed by the new key instead of the key in force is a finding", !r1.ok && r1.findings.some((f) => f.event === rot.id && f.problem.includes("not signed by the key in force")), r1.findings.map((f) => f.problem).join("; "));
    const third = new Signer(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string);
    // A lost key: announced by a transaction from the fee destination after the last planned rotation; the block time is the clock.
    const announced = s.clock.now() + 1;
    const early: LedgerEvent = { id: s.events.length + 1, at: announced + 13 * DAY, type: "key_rotation", new_public_key: third.publicKeyPem(), tx: "0x" + "dd".repeat(32), announced_at: announced, announced_from: "0xdest", lost: true, reason: "lost", by: OWNER.id };
    early.sig = third.sign(early);
    const r2 = replay([...s.events, early], new Map([[lawsHash, rawLaws]]), rawSchema, original, early.at);
    s.check("a lost-key rotation thirteen days after its announcement is a finding", !r2.ok && r2.findings.some((f) => f.event === early.id && f.problem.includes("sooner than")));
    const late: LedgerEvent = { ...early, at: announced + 15 * DAY };
    late.sig = third.sign(late);
    const r3 = replay([...s.events, late], new Map([[lawsHash, rawLaws]]), rawSchema, original, late.at);
    s.check("fifteen days after the announcement the new key may sign for itself", r3.ok, r3.findings.map((f) => f.problem).join("; "));
    const stale: LedgerEvent = { ...late, announced_at: rot.at - 1 };
    stale.sig = third.sign(stale);
    const r4 = replay([...s.events, stale], new Map([[lawsHash, rawLaws]]), rawSchema, original, stale.at);
    s.check("an announcement that a planned rotation by the key in force followed does not stand", !r4.ok && r4.findings.some((f) => f.problem.includes("does not stand")));
  }),

  sc("held-fee-once-in-flight", "A held fee pays for one resubmission at a time: while the submission it funds is undecided, another submission costs the full fee; a merge consumes it; an expiry holds it again.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const first = await s.submitAndVote(N, { "world/n/1.md": "one" });
    s.check("an unreviewed submission expires with its fee held", s.eventsFor(first.number).some((e) => e.type === "expiry") && s.state().held_fees.some((f) => f.account === N.id));
    const second = await s.submit(N, { "world/n/2.md": "two" });
    const q2 = s.eventsFor(second.number).find((e) => e.type === "quote")!;
    s.check("the next submission is quoted at zero against the held fee, which leaves the held set", BigInt(String(q2["fee_micro"])) === 0n && !s.state().held_fees.some((f) => f.account === N.id) && s.state().held_in_use[second.number] !== undefined);
    await s.tick();
    const third = await s.submit(N, { "world/n/3.md": "three" });
    const q3 = s.eventsFor(third.number).find((e) => e.type === "quote")!;
    s.check("while that one is undecided a further submission costs the full fee", BigInt(String(q3["fee_micro"])) > 0n, String(q3["fee_micro"]));
    s.clock.advance(H); for (const v of [H1, H2, H3]) s.review(second.number, v, "APPROVED"); await s.tick();
    await s.advance(78 * H);
    s.check("the merge of the funded submission consumes the held fee for good", merged(s, second) && s.state().held_in_use[second.number] === undefined && !s.state().held_fees.some((f) => f.account === N.id));
    const fourth = await s.submit(N, { "world/n/4.md": "four" });
    s.check("nothing is left to fund another free submission", BigInt(String(s.eventsFor(fourth.number).find((e) => e.type === "quote")!["fee_micro"])) > 0n);
  }),

  sc("release-covers-the-held-head", "The owner releases a held submission; the author then pushes different content. The release does not cover it: the new head is screened again and held again.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const pr = await s.submit(N, { "world/n/x.md": "HOLDME first" });
    s.check("held", s.eventsFor(pr.number).some((e) => e.type === "screen_hold"));
    s.release(pr.number); await s.tick();
    s.check("released head is quoted without a second screen", s.rt.quoteFor(pr.number) !== null && s.eventsFor(pr.number).some((e) => e.type === "quote" && e["screening"] === "released"));
    s.github.push(pr.number); pr.contents["world/n/x.md"] = "HOLDME second";
    await s.advance(25 * H, H); await s.tick();
    s.check("after a push, the new head was screened by the model and held again, not quoted on the old release", s.eventsFor(pr.number).filter((e) => e.type === "screen_hold").length === 2 && !s.eventsFor(pr.number).some((e) => e.type === "quote" && e["screening"] === "released" && String(e["head"]) === pr.headSha));
  }, { holdIf: (i) => (i.files.some((f) => f.content.includes("HOLDME")) ? { decision: "hold", reasonClass: "unlawful", note: "sim" } : null) }),

  sc("closed-before-open", "A paid submission is closed by its author while it waits for a place; a quoted one is closed unpaid. Both are settled: the paid one is a withdrawal with the fee held, neither holds a queue place or a concurrency slot.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const paid = await s.submit(N, { "world/n/p.md": "paid" }); await s.pay(paid.number);
    const quoted = await s.submit(M, { "world/m/q.md": "quoted" });
    await s.github.close(paid.number); await s.github.close(quoted.number);
    await s.tick();
    s.check("the paid one is a withdrawal with the fee held", s.eventsFor(paid.number).some((e) => e.type === "withdrawal" && e["fee_disposition"] === "held") && s.state().held_fees.some((f) => f.account === N.id));
    s.check("the quoted one lapsed", s.eventsFor(quoted.number).some((e) => e.type === "quote_lapsed"));
    const again = await s.submit(N, { "world/n/p2.md": "again" });
    const q = s.eventsFor(again.number).find((e) => e.type === "quote")!;
    s.check("the closed submission no longer counts as a concurrent paid one", Number(q["concurrency"]) === 1, String(q["concurrency"]));
  }),

  sc("dismissal-and-review-spam", "A collaborator dismisses an approval on the platform before close: the ledger's record still counts, as Law 2 says. A voter who changes its review fifty times in a window writes a bounded number of ledger events and counts as one vote toward the throughput target.", async (s) => {
    await s.seedFounders([H1, H2, H3, H4]);
    const pr = await s.submit(N, { "world/n/d.md": "x" }); await s.pay(pr.number); await s.tick();
    s.clock.advance(H); for (const v of [H1, H2, H3]) s.review(pr.number, v, "APPROVED"); await s.tick();
    for (let i = 0; i < 50; i++) { s.clock.advance(60); s.review(pr.number, H4, i % 2 ? "CHANGES_REQUESTED" : "APPROVED"); await s.tick(); }
    const h4 = s.events.filter((e) => e.type === "review" && e["pr"] === pr.number && e["account"] === H4.id);
    s.check("fifty review changes by one voter were recorded as at most ten events during the window", h4.length <= 10 && h4.length >= 2, String(h4.length));
    s.github.dismissReview(pr.number, H1.id);
    await s.advance(78 * H);
    const close = closeOf(s, pr)!;
    s.check("the dismissed approval still counted and the contribution merged", merged(s, pr) && Number(close["yes_voters"]) === 3);
    const h4final = s.events.filter((e) => e.type === "review" && e["pr"] === pr.number && e["account"] === H4.id);
    s.check("the voter's final state was recorded at close", Number(h4final[h4final.length - 1]!["review_id"]) === s.github.pulls.get(pr.number)!.reviews.filter((r) => r.account === H4.id).slice(-1)[0]!.reviewId);
    const adjust = [...s.events].reverse().find((e) => e.type === "fee_adjust")!;
    s.check("the throughput target saw one vote from that voter, not fifty", Number(adjust["target"]) === 3, String(adjust["target"]));
  }),
];
