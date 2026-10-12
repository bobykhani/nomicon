/**
 * Derive where each pull request stands from the ledger alone, so that the
 * runtime has no state of its own and a restart changes nothing.
 */
import type { LedgerEvent } from "./ledger.js";

export type Phase =
  | { kind: "new" }
  | { kind: "intake_rejected" }
  | { kind: "held"; since: number; event: LedgerEvent }
  | { kind: "quoted"; quote: LedgerEvent }
  | { kind: "paid"; quote: LedgerEvent; payment: LedgerEvent }
  | { kind: "voting"; open: LedgerEvent; quote: LedgerEvent }
  | { kind: "await_owner"; open: LedgerEvent; close: LedgerEvent; quote: LedgerEvent }
  | { kind: "confirmed"; open: LedgerEvent; quote: LedgerEvent; confirm: LedgerEvent }
  /** The tally said merge but no merge event exists yet: the merge failed or the agent died before recording it. */
  | { kind: "merging"; open: LedgerEvent; close: LedgerEvent; quote: LedgerEvent }
  | { kind: "done"; last: LedgerEvent };

/** Events after which nothing more happens to the pull request. */
const TERMINAL = new Set(["merge", "expiry", "withdrawal", "owner_reject", "intake_reject"]);

export function phaseOf(pr: number, events: LedgerEvent[]): Phase {
  const mine = events.filter((e) => Number(e["pr"]) === pr && e.type !== "owner_action_applied" && e.type !== "review" && e.type !== "laws_snapshot");
  if (mine.length === 0) return { kind: "new" };
  const last = mine[mine.length - 1]!;
  if (last.type === "intake_reject") return { kind: "intake_rejected" };
  if (TERMINAL.has(last.type)) return { kind: "done", last };
  if (last.type === "vote_close" && last["result"] === "reject") return { kind: "done", last };
  if (last.type === "hold_resolved" && last["decision"] !== "release") return { kind: "done", last };

  let quote: LedgerEvent | undefined, payment: LedgerEvent | undefined, open: LedgerEvent | undefined, close: LedgerEvent | undefined, confirm: LedgerEvent | undefined, hold: LedgerEvent | undefined, terminal: LedgerEvent | undefined, released = false;
  for (const e of mine) {
    if (TERMINAL.has(e.type)) { terminal = e; quote = payment = open = close = confirm = hold = undefined; released = false; continue; }
    switch (e.type) {
      case "screen_hold": hold = e; released = false; break;
      case "hold_resolved": if (e["decision"] === "release") released = true; break;
      case "quote": quote = e; payment = open = close = confirm = undefined; break;
      case "quote_lapsed": quote = payment = undefined; break;
      case "payment": if (e["matched"] !== false) payment = e; break;
      case "vote_open": open = e; close = confirm = undefined; break;
      case "vote_close": close = e; break;
      case "owner_confirm": if (close) confirm = e; break; // a confirmation after expiry or withdrawal is stale
      default: break;
    }
  }
  if (hold && !released && !quote) return { kind: "held", since: hold.at, event: hold };
  if (!quote) return terminal ? { kind: "done", last: terminal } : { kind: "new" };
  if (!payment) return { kind: "quoted", quote };
  if (!open) return { kind: "paid", quote, payment };
  if (!close) return { kind: "voting", open, quote };
  if (confirm) return { kind: "confirmed", open, quote, confirm };
  if (close["result"] === "await_owner") return { kind: "await_owner", open, close, quote };
  if (close["result"] === "merge") return { kind: "merging", open, close, quote };
  return { kind: "done", last: close };
}
