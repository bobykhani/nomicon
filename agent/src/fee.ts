/**
 * Law 5: quotes and the base-fee control loop. Micro-USDC integers throughout.
 */
import type { Laws } from "./laws.js";
import { usdcToMicro } from "./laws.js";
import type { Layer } from "./constitution.js";

export interface QuoteInput {
  layer: Layer;
  bytesChanged: number;
  /** Number of this account's paid submissions already open (k−1 for the k-th). */
  openPaidByAccount: number;
  baseMicro: bigint;
}

export interface Quote {
  feeMicro: bigint;
  baseMicro: bigint;
  multiplier: number;
  concurrency: number;
  sizeKbCharged: number;
  sizeMicro: bigint;
  /** Weight this submission mints if merged: base × multiplier. */
  weightMicro: bigint;
}

export function quote(input: QuoteInput, laws: Laws): Quote {
  const multiplier = input.layer === "laws" ? laws.fee.layer_multiplier.laws : laws.fee.layer_multiplier.world;
  const concurrency = Math.pow(laws.fee.concurrency_base, Math.max(0, input.openPaidByAccount));
  const kb = Math.ceil(input.bytesChanged / 1024);
  const sizeKbCharged = Math.max(0, kb - laws.fee.size_free_kb);
  const sizeMicro = BigInt(sizeKbCharged) * usdcToMicro(laws.fee.size_per_kb_usdc);
  const weightMicro = input.baseMicro * BigInt(multiplier);
  const feeMicro = weightMicro * BigInt(concurrency) + sizeMicro;
  return { feeMicro, baseMicro: input.baseMicro, multiplier, concurrency, sizeKbCharged, sizeMicro, weightMicro };
}

export interface AdjustInput {
  baseMicro: bigint;
  paidSubmissionsInLookback: number;
  /** Votes cast by qualified voters in the target lookback. */
  qualifiedVotesInLookback: number;
}

/** Law 5 throughput target, contributions per day. */
export function throughputTarget(qualifiedVotes: number, laws: Laws): number {
  const f = laws.fee;
  const perDay = (f.target_capacity_fraction * qualifiedVotes) / f.target_lookback_days / f.target_votes_per_contribution;
  return Math.max(f.target_min_per_day, Math.floor(perDay));
}

/** One step of the control loop. Returns the new base. */
export function adjustBase(input: AdjustInput, laws: Laws): { baseMicro: bigint; target: number; perDay: number } {
  const f = laws.fee;
  const floor = usdcToMicro(f.floor_usdc);
  const cap = floor * BigInt(f.cap_multiple_of_floor);
  const target = throughputTarget(input.qualifiedVotesInLookback, laws);
  const perDay = (input.paidSubmissionsInLookback * 24) / f.lookback_hours;
  let next = input.baseMicro;
  if (perDay > target) next = (next * BigInt(100 + f.rise_step_percent)) / 100n;
  else if (perDay < target) next = (next * BigInt(100 - f.fall_step_percent)) / 100n;
  if (next < floor) next = floor;
  if (next > cap) next = cap;
  return { baseMicro: next, target, perDay };
}
