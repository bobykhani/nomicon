import { describe, expect, it } from "vitest";
import { adjustBase, quote, throughputTarget } from "../src/fee.js";
import { laws } from "./helpers.js";

describe("quote", () => {
  it("charges base × multiplier for a small World change and mints that as weight", () => {
    const q = quote({ layer: "world", bytesChanged: 4096, openPaidByAccount: 0, baseMicro: 1_000_000n }, laws);
    expect(q.feeMicro).toBe(1_000_000n);
    expect(q.weightMicro).toBe(1_000_000n);
    expect(q.sizeKbCharged).toBe(0);
  });
  it("adds the size component beyond 8 kB and does not mint weight for it", () => {
    const q = quote({ layer: "world", bytesChanged: 20 * 1024, openPaidByAccount: 0, baseMicro: 1_000_000n }, laws);
    expect(q.sizeKbCharged).toBe(12);
    expect(q.feeMicro).toBe(1_000_000n + 12n * 50_000n);
    expect(q.weightMicro).toBe(1_000_000n);
  });
  it("multiplies by 10 for the Laws and doubles for concurrent submissions", () => {
    const q = quote({ layer: "laws", bytesChanged: 0, openPaidByAccount: 2, baseMicro: 1_000_000n }, laws);
    expect(q.multiplier).toBe(10);
    expect(q.concurrency).toBe(4);
    expect(q.feeMicro).toBe(40_000_000n);
    expect(q.weightMicro).toBe(10_000_000n);
  });
});

describe("control loop", () => {
  it("has a target floor of 3 per day", () => {
    expect(throughputTarget(0, 0, laws)).toBe(3);
    expect(throughputTarget(21, 0, laws)).toBe(3);
    expect(throughputTarget(210, 100, laws)).toBe(8);
    expect(throughputTarget(210, 7, laws)).toBe(5); // never more than twice the week's merges above the minimum
  });
  it("rises 5 percent above target, falls 10 percent below, and respects floor and cap", () => {
    const up = adjustBase({ baseMicro: 1_000_000n, paidSubmissionsInLookback: 10, qualifiedVotesInLookback: 0, mergesInLookback: 0, queueAboveOpenLimit: false }, laws);
    expect(up.baseMicro).toBe(1_050_000n);
    const down = adjustBase({ baseMicro: 1_050_000n, paidSubmissionsInLookback: 0, qualifiedVotesInLookback: 0, mergesInLookback: 0, queueAboveOpenLimit: false }, laws);
    const jammed = adjustBase({ baseMicro: 1_000_000n, paidSubmissionsInLookback: 0, qualifiedVotesInLookback: 0, mergesInLookback: 0, queueAboveOpenLimit: true }, laws);
    expect(jammed.baseMicro).toBe(1_050_000n);
    expect(down.baseMicro).toBe(1_000_000n);
    expect(adjustBase({ baseMicro: 1_000_000n, paidSubmissionsInLookback: 0, qualifiedVotesInLookback: 0, mergesInLookback: 0, queueAboveOpenLimit: false }, laws).baseMicro).toBe(1_000_000n);
    expect(adjustBase({ baseMicro: 9_900_000n, paidSubmissionsInLookback: 100, qualifiedVotesInLookback: 0, mergesInLookback: 0, queueAboveOpenLimit: false }, laws).baseMicro).toBe(10_000_000n);
  });
  it("holds at target", () => {
    expect(adjustBase({ baseMicro: 2_000_000n, paidSubmissionsInLookback: 3, qualifiedVotesInLookback: 0, mergesInLookback: 0, queueAboveOpenLimit: false }, laws).baseMicro).toBe(2_000_000n);
  });
});
