import { describe, expect, it } from "vitest";
import { cappedWeight, decayed, divRoundHalfEven, weightsAt } from "../src/weight.js";
import { DAY, laws } from "./helpers.js";

const H = 180n * 86400n;

describe("decay arithmetic", () => {
  it("is identity at zero elapsed", () => expect(decayed(1_000_000n, 0n, H)).toBe(1_000_000n));
  it("halves at one half-life", () => expect(decayed(1_000_000n, H, H)).toBe(500_000n));
  it("quarters at two half-lives", () => expect(decayed(1_000_000n, 2n * H, H)).toBe(250_000n));
  it("is within one micro of 2^-0.5 at half a half-life", () => {
    const v = decayed(1_000_000n, H / 2n, H);
    expect(Number(v)).toBeGreaterThanOrEqual(707106);
    expect(Number(v)).toBeLessThanOrEqual(707107);
  });
  it("matches the continuous formula to the micro over a range", () => {
    for (const days of [1, 7, 33, 90, 179, 181, 400, 1000]) {
      const v = decayed(10_000_000n, BigInt(days * DAY), H);
      const expected = Math.round(10_000_000 * Math.pow(2, -days / 180));
      expect(Math.abs(Number(v) - expected)).toBeLessThanOrEqual(1);
    }
  });
  it("rounds half to even", () => {
    expect(divRoundHalfEven(5n, 2n)).toBe(2n);
    expect(divRoundHalfEven(7n, 2n)).toBe(4n);
    expect(divRoundHalfEven(6n, 4n)).toBe(2n);
  });
  it("goes to zero after enough half-lives", () => expect(decayed(1n, 300n * H, H)).toBe(0n));
});

describe("weightsAt", () => {
  const t0 = 1_800_000_000;
  it("separates mature from immature by the maturity delay", () => {
    const w = weightsAt([{ account: 1, mergedAt: t0, weightMicro: 1_000_000n }], new Map([[1, t0]]), t0 + 29 * DAY, laws);
    expect(w.get(1)!.matureMicro).toBe(0n);
    expect(w.get(1)!.immatureMicro).toBeGreaterThan(0n);
    const w2 = weightsAt([{ account: 1, mergedAt: t0, weightMicro: 1_000_000n }], new Map([[1, t0]]), t0 + 30 * DAY, laws);
    expect(w2.get(1)!.matureMicro).toBeGreaterThan(0n);
    expect(w2.get(1)!.immatureMicro).toBe(0n);
  });
  it("decays faster for an account that stopped voting", () => {
    const active = weightsAt([{ account: 1, mergedAt: t0, weightMicro: 1_000_000n }], new Map([[1, t0 + 170 * DAY]]), t0 + 180 * DAY, laws);
    const idle = weightsAt([{ account: 1, mergedAt: t0, weightMicro: 1_000_000n }], new Map([[1, t0]]), t0 + 180 * DAY, laws);
    expect(active.get(1)!.matureMicro).toBe(500_000n);
    expect(idle.get(1)!.matureMicro).toBeLessThan(500_000n);
  });
  it("ignores merges in the future", () => {
    expect(weightsAt([{ account: 1, mergedAt: t0 + 10, weightMicro: 5n }], new Map(), t0, laws).size).toBe(0);
  });
});

describe("per-account cap", () => {
  it("caps at 20 percent of the total", () => {
    expect(cappedWeight(90n, 100n, laws)).toBe(20n);
    expect(cappedWeight(10n, 100n, laws)).toBe(10n);
  });
});
