import { describe, expect, it } from "vitest";
import { replay } from "../src/replay.js";
import type { LedgerEvent } from "../src/ledger.js";
import { fold } from "../src/state.js";
import { DAY, laws, loaded, rawLaws, rawSchema } from "./helpers.js";

const t0 = 1_800_000_000;
let id = 0;
const ev = (at: number, type: LedgerEvent["type"], f: Record<string, unknown>): LedgerEvent => ({ id: ++id, at, type, ...f });

function scenario(): LedgerEvent[] {
  id = 0;
  const h = loaded.hash;
  const events: LedgerEvent[] = [
    ev(t0, "genesis", { head: "aa".repeat(20), fee_destination: "0xdead", laws_hash: h, owner_accounts: [100], agent_account: 101 }),
  ];
  // Bootstrap: owner confirms three founders, 40 days ago, so their weight is mature now.
  for (const [pr, acct] of [[1, 1], [2, 2], [3, 3]] as const) {
    const t = t0 + 10 + pr;
    events.push(ev(t, "quote", { pr, head: "bb".repeat(20), layer: "world", fee_micro: 1_000_000n, base_micro: 1_000_000n, multiplier: 1, concurrency: 1, size_kb: 0, terms_commit: "cc".repeat(20), destination: "0xdead", expires: t + DAY }));
    events.push(ev(t + 1, "payment", { pr, tx: "0x" + "11".repeat(32), block: 1, block_time: t + 1, amount_micro: 1_000_000n, from: "0xabc", cad_value: "1.37" }));
    events.push(ev(t + 2, "vote_open", { pr, head: "bb".repeat(20), layer: "world", opened: t + 2, closes: t + 2 + 72 * 3600, laws_hash: h, qualified: [], authors: [acct], weighted_accounts: 0 }));
    events.push(ev(t + 2 + 72 * 3600, "vote_close", { pr, yes_voters: 0, yes_micro: 0n, no_micro: 0n, result: "await_owner", bootstrap: true }));
    events.push(ev(t + 3 + 72 * 3600, "owner_confirm", { pr, reason: "founding contribution" }));
    events.push(ev(t + 4 + 72 * 3600, "merge", { pr, head: "bb".repeat(20), merge_commit: "dd".repeat(20), weight_micro: 1_000_000n, account: acct, login: `u${acct}` }));
  }
  // 40 days later: a fourth account submits, the three founders vote.
  const t1 = t0 + 40 * DAY;
  events.push(ev(t1, "vote_open", { pr: 4, head: "ee".repeat(20), layer: "world", opened: t1, closes: t1 + 72 * 3600, laws_hash: h, qualified: [1, 2, 3], authors: [4], weighted_accounts: 3 }));
  events.push(ev(t1 + 100, "review", { pr: 4, account: 1, login: "u1", review_id: 11, state: "APPROVED", submitted: t1 + 100 }));
  events.push(ev(t1 + 200, "review", { pr: 4, account: 2, login: "u2", review_id: 21, state: "APPROVED", submitted: t1 + 200 }));
  events.push(ev(t1 + 300, "review", { pr: 4, account: 3, login: "u3", review_id: 31, state: "APPROVED", submitted: t1 + 300 }));
  return events;
}

describe("replay", () => {
  it("reproduces a recorded tally and the resulting weights", () => {
    const events = scenario();
    const t1 = t0 + 40 * DAY;
    // Compute what the agent would record at close, then record it.
    const partial = replay(events, new Map([[loaded.hash, rawLaws]]), rawSchema, null, t1 + 72 * 3600);
    expect(partial.ok).toBe(true);
    const w1 = partial.state.weights["1"]!;
    expect(w1.mature_micro).toBeGreaterThan(0n);
    // Recorded yes weight is the sum of capped weights (Law 4: 20 percent of total each).
    const ws = [1, 2, 3].map((a) => partial.state.weights[String(a)]!.mature_micro);
    const total = ws.reduce((x, y) => x + y, 0n);
    const cap = (total * 20_000n) / 100_000n;
    const yes = ws.map((w) => (w > cap ? cap : w)).reduce((x, y) => x + y, 0n);
    events.push(ev(t1 + 72 * 3600, "vote_close", { pr: 4, yes_voters: 3, yes_micro: yes, no_micro: 0n, result: "await_owner", bootstrap: true }));
    const full = replay(events, new Map([[loaded.hash, rawLaws]]), rawSchema, null, t1 + 72 * 3600 + 10);
    expect(full.ok).toBe(true);
    expect(full.state.weighted_accounts).toBe(3);
    expect(full.state.open_votes).toHaveLength(0);
  });
  it("flags a tally whose recorded result differs from the rules", () => {
    const events = scenario();
    const t1 = t0 + 40 * DAY;
    events.push(ev(t1 + 72 * 3600, "vote_close", { pr: 4, yes_voters: 3, yes_micro: 0n, no_micro: 0n, result: "reject", bootstrap: true }));
    const r = replay(events, new Map([[loaded.hash, rawLaws]]), rawSchema, null, t1 + 72 * 3600 + 10);
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.problem.includes("replay says await_owner"))).toBe(true);
  });
  it("folds state deterministically", () => {
    const events = scenario();
    const a = fold(events, t0 + 50 * DAY, laws);
    const b = fold(events, t0 + 50 * DAY, laws);
    expect(JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    expect(a.bootstrap.active).toBe(true);
    expect(a.fee.destination).toBe("0xdead");
  });
});
