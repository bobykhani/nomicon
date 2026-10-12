import { describe, expect, it } from "vitest";
import { termsCommitAt } from "../src/terms.js";
import type { LedgerEvent } from "../src/ledger.js";

const DAY = 86400;
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
function amendment(id: number, at: number, previous: string, commit: string): LedgerEvent {
  return { id, at, type: "declare", what: "terms_amendment", previous_commit: previous, commit, provision: "s. 1 of a statute", effective_at: at + 30 * DAY };
}

describe("Article 13 Terms amendments", () => {
  it("cites the fallback when nothing was ever amended", () => {
    expect(termsCommitAt([], 1000, "main")).toBe("main");
  });
  it("keeps citing the earlier text for thirty days after the record", () => {
    const ev = [amendment(1, 1000, A, B)];
    expect(termsCommitAt(ev, 1000, "main")).toBe(A);
    expect(termsCommitAt(ev, 1000 + 30 * DAY - 1, "main")).toBe(A);
    expect(termsCommitAt(ev, 1000 + 30 * DAY, "main")).toBe(B);
  });
  it("takes the latest amendment in force, not a pending one", () => {
    const ev = [amendment(1, 1000, A, B), amendment(2, 1000 + 40 * DAY, B, C)];
    expect(termsCommitAt(ev, 1000 + 45 * DAY, "main")).toBe(B);
    expect(termsCommitAt(ev, 1000 + 70 * DAY, "main")).toBe(C);
  });
});
