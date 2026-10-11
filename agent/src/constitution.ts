/**
 * Values the Constitution fixes. Hardcoded on purpose: Article 2 says the agent
 * applies the layer rule directly from the Constitution, and Article 8 says it
 * refuses any laws.json that breaches Article 9A. Nothing here is read from a
 * Laws-layer file.
 */

export type Layer = "constitution" | "laws" | "world" | "ledger" | "owner";

/** Article 2. Exact paths (relative to repository root, forward slashes). */
export const CONSTITUTION_FILES: ReadonlySet<string> = new Set([
  "CONSTITUTION.md",
  "TERMS.md",
  "DCO.md",
  "LICENSE",
  "LICENSE-CONTENT",
]);

/** Article 2 and Article 6. Owner-maintained, no vote changes them. */
export const OWNER_FILES: ReadonlySet<string> = new Set(["NOTICES.md", "PRIVACY.md"]);

/** Article 2. Directory prefixes. */
export const CONSTITUTION_DIRS = [".github/"] as const;
export const WORLD_DIR = "world/";
export const LEDGER_DIR = "ledger/";

/** Article 9A minimums. A laws.json that crosses any of these is refused. */
export const ARTICLE_9A = {
  minWindowHours: 24,
  minQuorumYesVoters: 3,
  lawsMajority: "two_thirds_weight" as const,
  minDecayHalfLifeDays: 30,
  minMaturityDays: 14,
  maxMaturityDays: 90,
  maxPerAccountCapPercent: 100 / 3,
  minFeeCapMultiple: 2,
  maxFeeCapMultiple: 100,
  minContributionKb: 64,
  maxContributionKb: 8192,
  voteYes: "APPROVED" as const,
  voteNo: "CHANGES_REQUESTED" as const,
  maxExpiryHoldDays: 365,
  minLawsEffectDelayDays: 7,
} as const;

/** Article 7. */
export const MIN_BASE_FEE_MICRO = 1_000_000n;

/** Article 3 and Law 9 refer to these; the Constitution fixes the year. */
export const BOOTSTRAP_MAX_DAYS = 365;

/** Article 14. */
export const CONTINUITY = { lapseDays: 90, noticeDays: 30 } as const;

/** Article 8. */
export const AGENT_DEPLOY_DELAY_DAYS = 14;

/**
 * Article 2: the layer of one path. "owner" is NOTICES.md / PRIVACY.md.
 * Every path has exactly one layer; nothing is unclassified.
 */
export function layerOfPath(path: string): Layer {
  if (CONSTITUTION_FILES.has(path)) return "constitution";
  if (OWNER_FILES.has(path)) return "owner";
  for (const d of CONSTITUTION_DIRS) if (path.startsWith(d)) return "constitution";
  if (path.startsWith(LEDGER_DIR)) return "ledger";
  if (path.startsWith(WORLD_DIR)) return "world";
  return "laws";
}

/** Strictness order for "the strictest rule wins". */
const STRICTNESS: Record<Layer, number> = { world: 0, laws: 1, owner: 2, ledger: 3, constitution: 4 };

export function strictest(layers: Iterable<Layer>): Layer {
  let best: Layer = "world";
  for (const l of layers) if (STRICTNESS[l] > STRICTNESS[best]) best = l;
  return best;
}
