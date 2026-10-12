import { describe, expect, it } from "vitest";
import { ceilSqrt, tally, type Review } from "../src/tally.js";
import { laws } from "./helpers.js";

const t0 = 1_800_000_000;
const rv = (account: number, state: Review["state"], at = t0 + 100, reviewId = account * 10 + 1): Review => ({ reviewId, account, login: `u${account}`, state, submittedAt: at });

function base(over: Partial<TallyInput> = {}): TallyInput {
  return {
    layer: "world", openedAt: t0, closesAt: t0 + 72 * 3600,
    qualified: new Set([1, 2, 3, 4, 5]), authors: new Set([9]),
    reviews: [], matureAtClose: new Map([[1, 10n], [2, 10n], [3, 10n], [4, 10n], [5, 10n]]),
    weightedAccountsAtOpen: 5, headSha: "ab".repeat(20), ...over,
  };
}

describe("tally", () => {
  it("expires below three yes voters even with many no votes", () => {
    const r = tally(base({ reviews: [rv(1, "APPROVED"), rv(2, "APPROVED"), rv(3, "CHANGES_REQUESTED"), rv(4, "CHANGES_REQUESTED")] }), laws);
    expect(r.result).toBe("expire");
    expect(r.yesVoters).toBe(2);
  });
  it("merges on yes-weight majority with quorum met", () => {
    const r = tally(base({ reviews: [rv(1, "APPROVED"), rv(2, "APPROVED"), rv(3, "APPROVED"), rv(4, "CHANGES_REQUESTED")] }), laws);
    expect(r.result).toBe("merge");
    expect(r.yesMicro).toBe(30n);
    expect(r.noMicro).toBe(10n);
  });
  it("rejects when no-weight exceeds yes-weight and three accounts said no; with fewer, expires", () => {
    const m = new Map([[1, 1n], [2, 1n], [3, 1n], [4, 100n], [5, 100n], [6, 100n]]);
    const one = tally(base({ qualified: new Set([1, 2, 3, 4, 5, 6]), matureAtClose: m, weightedAccountsAtOpen: 6, reviews: [rv(1, "APPROVED"), rv(2, "APPROVED"), rv(3, "APPROVED"), rv(4, "CHANGES_REQUESTED")] }), laws);
    expect(one.result).toBe("expire");
    const three = tally(base({ qualified: new Set([1, 2, 3, 4, 5, 6]), matureAtClose: m, weightedAccountsAtOpen: 6, reviews: [rv(1, "APPROVED"), rv(2, "APPROVED"), rv(3, "APPROVED"), rv(4, "CHANGES_REQUESTED"), rv(5, "CHANGES_REQUESTED"), rv(6, "CHANGES_REQUESTED")] }), laws);
    expect(three.result).toBe("reject");
  });
  it("caps a whale at 20 percent of total mature weight", () => {
    const r = tally(base({ matureAtClose: new Map([[1, 1n], [2, 1n], [3, 1n], [4, 1n], [5, 1000n]]), reviews: [rv(1, "APPROVED"), rv(2, "APPROVED"), rv(3, "APPROVED"), rv(4, "APPROVED"), rv(5, "CHANGES_REQUESTED")] }), laws);
    expect(r.noMicro).toBe(200n);
    expect(r.result).toBe("expire"); // one capped whale outweighs four, yet alone it forfeits nobody's fee
  });
  it("ignores comment-only reviews, late reviews, early reviews, authors and unqualified accounts", () => {
    const r = tally(base({
      qualified: new Set([1, 2, 3, 9]),
      reviews: [
        rv(1, "APPROVED"), rv(2, "APPROVED"),
        rv(3, "COMMENTED"),
        rv(4, "APPROVED"),
        rv(9, "APPROVED"),
        rv(5, "APPROVED", t0 + 72 * 3600 + 1),
        rv(2, "CHANGES_REQUESTED", t0 - 1, 99),
      ],
    }), laws);
    expect(r.result).toBe("expire");
    expect(r.votes.map((v) => v.account)).toEqual([1, 2]);
  });
  it("counts only the latest approve or request-changes review per account", () => {
    const r = tally(base({ reviews: [rv(1, "APPROVED"), rv(2, "APPROVED"), rv(3, "APPROVED", t0 + 100, 31), rv(3, "CHANGES_REQUESTED", t0 + 200, 32), rv(3, "COMMENTED", t0 + 300, 33)] }), laws);
    expect(r.yesVoters).toBe(2);
    expect(r.result).toBe("expire");
  });
  it("treats equal weight as no decision: the contribution expires", () => {
    const r = tally(base({
      qualified: new Set([1, 2, 3, 4, 5, 6]),
      reviews: [rv(1, "APPROVED"), rv(2, "APPROVED"), rv(3, "APPROVED"), rv(4, "CHANGES_REQUESTED"), rv(5, "CHANGES_REQUESTED"), rv(6, "CHANGES_REQUESTED")],
      matureAtClose: new Map([[1, 10n], [2, 10n], [3, 10n], [4, 10n], [5, 10n], [6, 10n]]),
    }), laws);
    expect(r.tie).toBe(true);
    expect(r.result).toBe("expire");
  });
  it("passes a Laws vote at exactly two thirds and rejects an equal split without calling it a tie", () => {
    const q7 = new Set([1, 2, 3, 4, 5, 6, 7]);
    const m7 = new Map([[1, 10n], [2, 10n], [3, 10n], [4, 10n], [5, 10n], [6, 15n], [7, 10n]]);
    const fiveYes = [1, 2, 3, 4, 5].map((a) => rv(a, "APPROVED")).concat([rv(6, "CHANGES_REQUESTED"), rv(7, "CHANGES_REQUESTED")]);
    const exact = tally(base({ layer: "laws", qualified: q7, matureAtClose: m7, weightedAccountsAtOpen: 7, reviews: fiveYes }), laws);
    expect(exact.yesMicro * 3n).toBe((exact.yesMicro + exact.noMicro) * 2n);
    expect(exact.result).toBe("merge");
    const q10 = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const m10 = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, 10n] as [number, bigint]));
    const split = [1, 2, 3, 4, 5].map((a) => rv(a, "APPROVED")).concat([6, 7, 8, 9, 10].map((a) => rv(a, "CHANGES_REQUESTED")));
    const r = tally(base({ layer: "laws", qualified: q10, matureAtClose: m10, weightedAccountsAtOpen: 10, reviews: split }), laws);
    expect(r.result).toBe("reject");
    expect(r.tie).toBe(false);
  });
  it("needs two thirds and a larger quorum for the Laws", () => {
    const yes3no2 = [rv(1, "APPROVED"), rv(2, "APPROVED"), rv(3, "APPROVED"), rv(4, "CHANGES_REQUESTED"), rv(5, "CHANGES_REQUESTED")];
    const r = tally(base({ layer: "laws", reviews: yes3no2 }), laws);
    expect(r.quorum).toBe(5);
    expect(r.result).toBe("expire");
    const q = new Set([1, 2, 3, 4, 5, 6, 7]);
    const m = new Map([[1, 10n], [2, 10n], [3, 10n], [4, 10n], [5, 10n], [6, 10n], [7, 10n]]);
    const sixYes = [1, 2, 3, 4, 5, 6].map((a) => rv(a, "APPROVED")).concat([rv(7, "CHANGES_REQUESTED")]);
    expect(tally(base({ layer: "laws", qualified: q, matureAtClose: m, weightedAccountsAtOpen: 7, reviews: sixYes }), laws).result).toBe("merge");
    const fiveYes = [1, 2, 3, 4, 5].map((a) => rv(a, "APPROVED")).concat([rv(6, "CHANGES_REQUESTED"), rv(7, "CHANGES_REQUESTED")]);
    const heavyNo = new Map([[1, 10n], [2, 10n], [3, 10n], [4, 10n], [5, 10n], [6, 20n], [7, 20n]]);
    expect(tally(base({ layer: "laws", qualified: q, matureAtClose: heavyNo, weightedAccountsAtOpen: 7, reviews: fiveYes }), laws).result).toBe("expire"); // two no voters cannot reject
    const q8 = new Set([1, 2, 3, 4, 5, 6, 7, 8]), heavyNo8 = new Map([...heavyNo, [8, 20n]]);
    expect(tally(base({ layer: "laws", qualified: q8, matureAtClose: heavyNo8, weightedAccountsAtOpen: 8, reviews: fiveYes.concat([rv(8, "CHANGES_REQUESTED")]) }), laws).result).toBe("reject");
    for (const [members, quorum] of [[4, 5], [40, 7], [100, 10], [101, 11], [10_000, 100], [1_000_000, 1000]] as const) expect(tally(base({ layer: "laws", weightedAccountsAtOpen: members, reviews: [] }), laws).quorum).toBe(quorum);
    expect(tally(base({ layer: "world", weightedAccountsAtOpen: 1_000_000, reviews: [] }), laws).quorum).toBe(3);
  });
});

describe("integer square root", () => {
  it("returns the smallest integer whose square is at least n", () => {
    for (const [n, r] of [[0, 0], [1, 1], [2, 2], [4, 2], [5, 3], [99, 10], [100, 10], [101, 11], [999_999, 1000], [1_000_000, 1000], [1_000_001, 1001]]) expect(ceilSqrt(n)).toBe(r);
  });
});

describe("rejection quorum", () => {
  it("rejects only with three distinct no voters; one heavy no vote alone expires the contribution", () => {
    const heavy = new Map([[1, 10n], [2, 10n], [3, 10n], [4, 200n], [5, 10n], [6, 10n]]); // account 4 is capped to a fifth of 250, still more than the three yes
    const q = new Set([1, 2, 3, 4, 5, 6]);
    const oneNo = [rv(1, "APPROVED"), rv(2, "APPROVED"), rv(3, "APPROVED"), rv(4, "CHANGES_REQUESTED")];
    const r = tally(base({ qualified: q, matureAtClose: heavy, weightedAccountsAtOpen: 6, reviews: oneNo }), laws);
    expect(r.noMicro > r.yesMicro).toBe(true);
    expect(r.result).toBe("expire");
    const threeNo = oneNo.concat([rv(5, "CHANGES_REQUESTED"), rv(6, "CHANGES_REQUESTED")]);
    expect(tally(base({ qualified: q, matureAtClose: heavy, weightedAccountsAtOpen: 6, reviews: threeNo }), laws).result).toBe("reject");
  });
});
