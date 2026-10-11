/**
 * Article 8: recompute every outcome from the ledger and compare.
 * This checks the arithmetic the ledger records against the rules; the
 * inputs themselves (reviews, payments) are taken from the ledger, which is
 * why Article 11 requires every input to be recorded.
 */
import { readFileSync } from "node:fs";
import { parseEvents, verifyEvent, type LedgerEvent } from "./ledger.js";
import { parseLaws, type Laws } from "./laws.js";
import { tally, type Review } from "./tally.js";
import { fold, type State } from "./state.js";
import { weightsAt } from "./weight.js";

export interface ReplayFinding { event: number; problem: string }

export interface ReplayResult { ok: boolean; findings: ReplayFinding[]; state: State }

/**
 * Replay with the laws.json hashes recorded at each vote_open. `lawsByHash`
 * must provide the raw laws.json text for every hash the ledger references.
 */
export function replay(events: LedgerEvent[], lawsByHash: Map<string, string>, rawSchema: string, publicKeyPem: string | null, now: number): ReplayResult {
  const findings: ReplayFinding[] = [];
  const lawsCache = new Map<string, Laws>();
  const lawsFor = (hash: string): Laws => {
    let l = lawsCache.get(hash);
    if (!l) {
      const raw = lawsByHash.get(hash);
      if (!raw) throw new Error(`laws.json with hash ${hash} not available for replay`);
      l = parseLaws(raw, rawSchema).laws;
      lawsCache.set(hash, l);
    }
    return l;
  };
  // Signatures.
  if (publicKeyPem) for (const e of events) if (!verifyEvent(e, publicKeyPem)) findings.push({ event: e.id, problem: "bad or missing signature" });

  // Walk vote_open → vote_close pairs and recompute tallies.
  const opens = new Map<number, LedgerEvent>();
  const reviews = new Map<number, Review[]>();
  const merges: Array<{ account: number; mergedAt: number; weightMicro: bigint; pr: number; revoked?: boolean }> = [];
  const lastVote = new Map<number, number>();
  const firstHash = events.find((e) => e.type === "genesis")?.["laws_hash"];
  let currentLaws: Laws | null = typeof firstHash === "string" ? lawsFor(firstHash) : null;

  for (const e of events) {
    if (e.type === "vote_open") { opens.set(Number(e["pr"]), e); reviews.set(Number(e["pr"]), []); }
    if (e.type === "review") {
      reviews.get(Number(e["pr"]))?.push({ reviewId: Number(e["review_id"]), account: Number(e["account"]), login: String(e["login"]), state: e["state"] as Review["state"], submittedAt: Number(e["submitted"]) });
      const t = Number(e["submitted"]); const a = Number(e["account"]);
      if ((lastVote.get(a) ?? 0) < t) lastVote.set(a, t);
    }
    if (e.type === "merge") merges.push({ account: Number(e["account"]), mergedAt: e.at, weightMicro: BigInt(String(e["weight_micro"])), pr: Number(e["pr"]) });
    if (e.type === "takedown") for (const pr of (e["prs"] as number[]) ?? []) for (const m of merges) if (m.pr === pr) m.revoked = true;
    if (e.type === "vote_close") {
      const pr = Number(e["pr"]);
      const open = opens.get(pr);
      if (!open) { findings.push({ event: e.id, problem: `vote_close for pr ${pr} without vote_open` }); continue; }
      const laws = lawsFor(String(open["laws_hash"]));
      currentLaws = laws;
      const closesAt = Number(open["closes"]);
      const live = merges.filter((m) => !m.revoked && m.mergedAt < Number(open["opened"]));
      const w = weightsAt(live, lastVote, closesAt, laws);
      const matureAtClose = new Map<number, bigint>();
      for (const [a, aw] of w) matureAtClose.set(a, aw.matureMicro);
      const t = tally({
        layer: open["layer"] as "world" | "laws",
        openedAt: Number(open["opened"]), closesAt,
        qualified: new Set((open["qualified"] as number[]) ?? []),
        authors: new Set((open["authors"] as number[]) ?? []),
        reviews: reviews.get(pr) ?? [],
        matureAtClose,
        weightedAccountsAtOpen: Number(open["weighted_accounts"]),
        headSha: String(open["head"]),
        ...(typeof e["tie_block"] === "string" ? { tieBlockHash: e["tie_block"] as string } : {}),
      }, laws);
      const recorded = String(e["result"]);
      const expected = e["bootstrap"] === true ? "await_owner" : t.result;
      if (recorded !== expected) findings.push({ event: e.id, problem: `pr ${pr}: recorded ${recorded}, replay says ${expected}` });
      if (String(e["yes_micro"]) !== t.yesMicro.toString() || String(e["no_micro"]) !== t.noMicro.toString()) findings.push({ event: e.id, problem: `pr ${pr}: weights differ (recorded ${e["yes_micro"]}/${e["no_micro"]}, replay ${t.yesMicro}/${t.noMicro})` });
    }
  }
  if (!currentLaws) throw new Error("ledger has no genesis event");
  const state = fold(events, now, currentLaws);
  return { ok: findings.length === 0, findings, state };
}

export function replayFromFiles(repoRoot: string, now: number, extraLaws: Map<string, string> = new Map()): ReplayResult {
  const events = parseEvents(readFileSync(`${repoRoot}/ledger/events.jsonl`, "utf8"));
  const rawLaws = readFileSync(`${repoRoot}/laws.json`, "utf8");
  const rawSchema = readFileSync(`${repoRoot}/laws.schema.json`, "utf8");
  const lawsByHash = new Map(extraLaws);
  const { hash } = parseLaws(rawLaws, rawSchema);
  lawsByHash.set(hash, rawLaws);
  let pub: string | null = null;
  try { pub = readFileSync(`${repoRoot}/ledger/public-key.pem`, "utf8"); } catch { pub = null; }
  return replay(events, lawsByHash, rawSchema, pub, now);
}
