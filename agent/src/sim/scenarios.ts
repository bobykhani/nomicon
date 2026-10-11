/**
 * Adversarial scenarios. Each one is an attack or a failure mode from the
 * hostile reviews, run against the real runtime, with explicit claims checked.
 */
import { Sim, acct, DAY, H, rawLaws, rawSchema, type Account } from "./harness.js";
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

  sc("fee-pump", "Ten attacker accounts open three paid submissions a day for twelve days with nobody voting. The base fee rises to its cap of ten times the floor, concurrency pricing makes the flood expensive, and the fee falls back within a week of the flood stopping.", async (s) => {
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
    s.check("base fee reaches the cap of ten times the floor", maxBase === 10_000_000n, String(maxBase));
    s.check("base fee never exceeds the cap", maxBase <= 10_000_000n);
    s.check("the flood cost the attackers more than 10,000 USDC", spent > 10_000_000_000n, String(spent / 1_000_000n));
    await s.advance(7 * DAY);
    s.check("base fee returns to the floor within a week of the flood stopping", s.state().fee.base_micro === 1_000_000n, String(s.state().fee.base_micro));
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

  sc("apathy-and-held-fee", "Nobody votes on a newcomer's submission. It expires with the fee held, the held fee covers a resubmission, and after 90 days an unused held fee is forfeit.", async (s) => {
    await s.seedFounders([H1, H2, H3]);
    const pr = await s.submitAndVote(N, { "world/n1.md": "x" });
    s.check("no votes: expired with the fee held", s.phase(pr.number).kind === "done" && s.state().held_fees.some((f) => f.account === N.id));
    const pr2 = await s.submit(N, { "world/n2.md": "y" });
    s.check("resubmission is covered by the held fee with nothing to pay", s.phase(pr2.number).kind === "paid", s.phase(pr2.number).kind);
    await s.tick(); await s.advance(78 * H);
    s.check("the second expiry keeps a held fee on the account", s.state().held_fees.some((f) => f.account === N.id));
    await s.advance(91 * DAY, DAY);
    s.check("held fees are forfeit after 90 days", !s.state().held_fees.some((f) => f.account === N.id));
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
];
