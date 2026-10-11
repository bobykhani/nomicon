/**
 * Law 4 and Law 11: weight arithmetic in micro-USDC integers.
 * Decay w × 2^(−s / H) is computed with integer-only operations so that every
 * replayer gets the same answer on every platform.
 */
import type { Laws } from "./laws.js";

const SCALE = 1n << 64n;

/** 2^(−x) for x in [0,1), as a fixed-point fraction of 2^64, by binary exponentiation of 2^(−1/2^k). */
function pow2NegFrac(num: bigint, den: bigint): bigint {
  // Compute 2^(-num/den) with 64 fractional bits using the identity
  // 2^(-f) = exp(-f ln 2); we avoid floats by repeated square roots:
  // 2^(-f) = prod over bits b_k of f (f = sum b_k 2^-k) of 2^(-2^-k).
  // Precompute r_k = 2^(-2^-k) via integer sqrt: r_0 = 1/2, r_{k+1} = sqrt(r_k).
  let result = SCALE;
  // The first fractional bit has value 2^-1, whose factor is 2^(-1/2) = sqrt(1/2).
  let r = isqrt((SCALE / 2n) * SCALE);
  const f = (num * SCALE) / den; // fraction in 64-bit fixed point
  for (let k = 0; k < 64; k++) {
    const bit = (f >> BigInt(63 - k)) & 1n;
    if (bit === 1n) result = (result * r) / SCALE;
    r = isqrt(r * SCALE);
  }
  return result;
}

function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  // Newton refinement to exactness.
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) {
      while (x * x > n) x -= 1n;
      while ((x + 1n) * (x + 1n) <= n) x += 1n;
      return x;
    }
    x = y;
  }
}

/** Round-half-to-even division of a by b (b > 0). */
export function divRoundHalfEven(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a - q * b;
  const twice = r * 2n;
  if (twice < b) return q;
  if (twice > b) return q + 1n;
  return q % 2n === 0n ? q : q + 1n;
}

/** weight × 2^(−elapsedSeconds / halfLifeSeconds), micro-USDC, round half even. */
export function decayed(weightMicro: bigint, elapsedSeconds: bigint, halfLifeSeconds: bigint): bigint {
  if (elapsedSeconds <= 0n) return weightMicro;
  const whole = elapsedSeconds / halfLifeSeconds;
  const rem = elapsedSeconds % halfLifeSeconds;
  if (whole >= 200n) return 0n;
  const frac = pow2NegFrac(rem, halfLifeSeconds);
  const scaled = (weightMicro * frac) >> BigInt(Number(whole)); // divide by 2^whole
  return divRoundHalfEven(scaled, SCALE);
}

export interface Merge { account: number; mergedAt: number; weightMicro: bigint }

export interface AccountWeight { account: number; matureMicro: bigint; immatureMicro: bigint }

/**
 * Compute every account's mature and immature weight at time `now`.
 * `lastVoteAt` gives each account's last vote timestamp (Law 4 inactivity).
 */
export function weightsAt(merges: Merge[], lastVoteAt: Map<number, number>, now: number, laws: Laws): Map<number, AccountWeight> {
  const H = BigInt(Math.round(laws.weight.decay_half_life_days * 86400));
  const Hi = BigInt(Math.round(laws.weight.inactive_half_life_days * 86400));
  const inactiveAfter = Math.round(laws.weight.inactive_after_days_without_vote * 86400);
  const maturity = Math.round(laws.weight.maturity_days * 86400);
  const out = new Map<number, AccountWeight>();
  for (const m of merges) {
    const elapsed = now - m.mergedAt;
    if (elapsed < 0) continue;
    const last = lastVoteAt.get(m.account);
    const inactiveSince = (last ?? m.mergedAt) + inactiveAfter;
    let w: bigint;
    if (now <= inactiveSince) {
      w = decayed(m.weightMicro, BigInt(elapsed), H);
    } else {
      // Normal decay until inactiveSince, faster decay after.
      const first = Math.max(0, inactiveSince - m.mergedAt);
      const second = now - Math.max(m.mergedAt, inactiveSince);
      w = decayed(decayed(m.weightMicro, BigInt(first), H), BigInt(second), Hi);
    }
    const cur = out.get(m.account) ?? { account: m.account, matureMicro: 0n, immatureMicro: 0n };
    if (elapsed >= maturity) cur.matureMicro += w; else cur.immatureMicro += w;
    out.set(m.account, cur);
  }
  return out;
}

/** Law 4 cap: no account counts for more than cap% of the total mature weight. */
export function cappedWeight(w: bigint, totalMature: bigint, laws: Laws): bigint {
  const capNum = BigInt(Math.round(laws.weight.per_account_cap_percent * 1000));
  const cap = (totalMature * capNum) / 100_000n;
  return w > cap ? cap : w;
}
