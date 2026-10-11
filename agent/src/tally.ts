/**
 * Law 2, Law 3 and Law 11: counting a vote.
 */
import { createHash } from "node:crypto";
import type { Laws, Procedure } from "./laws.js";
import { cappedWeight } from "./weight.js";
import type { Layer } from "./constitution.js";

export interface Review {
  reviewId: number;
  account: number;
  login: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  /** Platform timestamp, UTC seconds. */
  submittedAt: number;
}

export interface TallyInput {
  layer: Layer;
  openedAt: number;
  closesAt: number;
  /** Qualified voter set recorded at open. */
  qualified: ReadonlySet<number>;
  authors: ReadonlySet<number>;
  reviews: Review[];
  /** Mature weight per account at close, uncapped. */
  matureAtClose: Map<number, bigint>;
  /** Count of accounts holding mature weight at open (Law 3 percent quorum). */
  weightedAccountsAtOpen: number;
  /** Lowercase hex, no prefix. */
  headSha: string;
  /** Lowercase hex, no prefix. Required only on a tie. */
  tieBlockHash?: string;
}

export interface CountedVote { account: number; login: string; reviewId: number; yes: boolean; weightMicro: bigint }

export interface TallyResult {
  result: "merge" | "reject" | "expire";
  votes: CountedVote[];
  yesVoters: number;
  quorum: number;
  yesMicro: bigint;
  noMicro: bigint;
  tie: boolean;
  tieBit?: 0 | 1;
  procedure: Procedure;
}

/** Law 2 step 2: the one review per eligible account that counts. */
export function countedReviews(input: TallyInput): Map<number, Review> {
  const latest = new Map<number, Review>();
  for (const r of input.reviews) {
    if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") continue;
    if (r.submittedAt <= input.openedAt || r.submittedAt > input.closesAt) continue;
    if (!input.qualified.has(r.account) || input.authors.has(r.account)) continue;
    const prev = latest.get(r.account);
    if (!prev || r.submittedAt > prev.submittedAt || (r.submittedAt === prev.submittedAt && r.reviewId > prev.reviewId)) latest.set(r.account, r);
  }
  return latest;
}

export function quorumFor(layer: Layer, weightedAccounts: number, laws: Laws): { quorum: number; procedure: Procedure } {
  const procedure = layer === "laws" ? laws.vote.laws : laws.vote.world;
  const pct = Math.ceil((procedure.quorum_percent_of_weighted_accounts / 100) * weightedAccounts);
  return { quorum: Math.max(procedure.quorum_yes_voters, pct), procedure };
}

/** Law 11 tie-break: LSB of last byte of SHA-256(headSha || blockHash), ASCII hex without prefixes. 0 merges. */
export function tieBit(headSha: string, blockHash: string): 0 | 1 {
  const h = createHash("sha256").update(headSha.toLowerCase().replace(/^0x/, "") + blockHash.toLowerCase().replace(/^0x/, ""), "ascii").digest();
  return (h[h.length - 1]! & 1) as 0 | 1;
}

export function tally(input: TallyInput, laws: Laws): TallyResult {
  const { quorum, procedure } = quorumFor(input.layer, input.weightedAccountsAtOpen, laws);
  const counted = countedReviews(input);
  let totalMature = 0n;
  for (const w of input.matureAtClose.values()) totalMature += w;
  const votes: CountedVote[] = [];
  let yesMicro = 0n, noMicro = 0n, yesVoters = 0;
  for (const r of counted.values()) {
    const raw = input.matureAtClose.get(r.account) ?? 0n;
    const w = cappedWeight(raw, totalMature, laws);
    const yes = r.state === "APPROVED";
    votes.push({ account: r.account, login: r.login, reviewId: r.reviewId, yes, weightMicro: w });
    if (yes) { yesMicro += w; yesVoters++; } else noMicro += w;
  }
  votes.sort((a, b) => a.account - b.account);
  const base = { votes, yesVoters, quorum, yesMicro, noMicro, procedure };
  if (yesVoters < quorum) return { ...base, result: "expire", tie: false };
  let passes: boolean;
  if (procedure.majority === "two_thirds_weight") passes = yesMicro * 3n >= (yesMicro + noMicro) * 2n && yesMicro > noMicro;
  else passes = yesMicro > noMicro;
  if (yesMicro === noMicro || (procedure.majority === "two_thirds_weight" && yesMicro * 3n === (yesMicro + noMicro) * 2n)) {
    if (!input.tieBlockHash) throw new Error("tie requires tieBlockHash");
    const bit = tieBit(input.headSha, input.tieBlockHash);
    return { ...base, result: bit === 0 ? "merge" : "reject", tie: true, tieBit: bit };
  }
  return { ...base, result: passes ? "merge" : "reject", tie: false };
}
