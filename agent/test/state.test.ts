import { describe, expect, it } from "vitest";
import { fold } from "../src/state.js";
import type { LedgerEvent } from "../src/ledger.js";
import { laws } from "./helpers.js";

describe("agent account in force", () => {
  it("starts at genesis and follows recorded changes of custody", () => {
    const events: LedgerEvent[] = [
      { id: 1, at: 100, type: "genesis", head: "h", laws_hash: "x", owner_accounts: [7], owner_keys: [], agent_account: 7, fee_destination: "0xabc", network: "eip155:84532" },
      { id: 2, at: 200, type: "agent_account_change", agent_account: 4242, login: "nomicon-agent[bot]", reason: "moved to the App", by: "7" },
    ];
    expect(fold(events.slice(0, 1), 150, laws).agent_account).toBe(7);
    expect(fold(events, 250, laws).agent_account).toBe(4242);
  });
});
