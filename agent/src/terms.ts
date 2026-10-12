// Article 13: which commit of TERMS.md a quote cites.
//
// After bootstrap the owner may record a legally required change to TERMS.md as a
// `declare` event with `what: "terms_amendment"`, carrying the commit of the new text,
// the commit it replaces, the provision that requires it, and `effective_at`, thirty
// days after the record. A quote issued before that moment cites the earlier text.

import type { LedgerEvent } from "./ledger.js";

export const TERMS_AMENDMENT_NOTICE_DAYS = 30;

export function termsAmendments(events: readonly LedgerEvent[]): LedgerEvent[] {
  return events.filter((e) => e.type === "declare" && e["what"] === "terms_amendment");
}

/** The commit of TERMS.md in force at `at`, or `fallback` when no amendment was ever recorded. */
export function termsCommitAt(events: readonly LedgerEvent[], at: number, fallback: string): string {
  const all = termsAmendments(events);
  if (all.length === 0) return fallback;
  const inForce = all.filter((e) => Number(e["effective_at"]) <= at);
  if (inForce.length > 0) return String(inForce[inForce.length - 1]!["commit"]);
  return String(all[0]!["previous_commit"]);
}
