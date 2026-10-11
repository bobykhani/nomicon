/**
 * Interfaces the runtime depends on. Real adapters talk to GitHub, Base and a
 * model; the mock adapters in adapters/mock.ts drive the simulation and tests.
 */
import type { ChangedFile } from "./paths.js";
import type { Review } from "./tally.js";

export interface PullInfo {
  number: number;
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
  author: { id: number; login: string };
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  createdAt: number;
}

export interface PullCommit { sha: string; signedOff: boolean; authorId?: number; committerId?: number }

export interface GitHubPort {
  listOpenPulls(): Promise<PullInfo[]>;
  getPull(n: number): Promise<PullInfo>;
  /** Changed files with modes, sizes and bytes changed. */
  listFiles(n: number): Promise<ChangedFile[]>;
  listCommits(n: number): Promise<PullCommit[]>;
  listReviews(n: number): Promise<Review[]>;
  /** All paths at a commit. */
  listPaths(ref: string): Promise<string[]>;
  /** UTF-8 content of a file at a commit. */
  readFile(ref: string, path: string): Promise<string>;
  comment(n: number, body: string): Promise<void>;
  /** Merge the recorded head commit. Returns the merge commit sha, or null if it cannot merge cleanly. */
  merge(n: number, headSha: string): Promise<string | null>;
  close(n: number): Promise<void>;
  /** Publish ledger files to the repository. */
  publishLedger(files: Array<{ path: string; content: string }>, message: string): Promise<void>;
}

export interface FinalizedBlock { number: bigint; hash: string; timestamp: number }

export interface ChainPort {
  /** First finalized block whose timestamp is strictly greater than `ts`. Null if not yet available. */
  firstFinalizedBlockAfter(ts: number): Promise<FinalizedBlock | null>;
  /** Timestamp and block of a settled transaction. Null if not found. */
  transactionInfo(txHash: string): Promise<{ blockNumber: bigint; blockTime: number } | null>;
  /** Anchor a hash on the chain. Returns the transaction hash. */
  anchor(hashHex: string): Promise<string>;
}

export interface ScreenInput {
  pr: number;
  title: string;
  body: string;
  files: Array<{ path: string; content: string }>;
}

export type ScreenDecision = { decision: "pass" } | { decision: "hold"; reasonClass: string; note: string };

export interface ScreenPort {
  screen(input: ScreenInput): Promise<ScreenDecision>;
}

export interface PriceOracle {
  /** Canadian-dollar value of one USDC at the moment, as a decimal string. */
  usdcToCad(): Promise<string>;
}

export interface Clock { now(): number }

export interface PaymentNotice {
  pr: number;
  tx: string;
  payer: string;
  amountMicro: bigint;
  network: string;
}
