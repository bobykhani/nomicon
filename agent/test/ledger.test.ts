import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, Signer, canonical, parseEvents, verifyEvent } from "../src/ledger.js";

const { privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

describe("ledger", () => {
  it("canonical JSON sorts keys, drops sig and undefined, and stringifies bigints", () => {
    expect(canonical({ b: 1n, a: "x", sig: "zzz", u: undefined, n: { z: [1, 2n] } })).toBe('{"a":"x","b":"1","n":{"z":[1,"2"]}}');
  });
  it("appends sequential signed events that verify and parse back", () => {
    const dir = mkdtempSync(join(tmpdir(), "nomicon-"));
    const signer = new Signer(pem);
    const led = new Ledger(join(dir, "events.jsonl"), signer);
    led.append(100, "genesis", { head: "abc", fee_destination: "0x1", laws_hash: "h", owner_accounts: [1], agent_account: 2 });
    led.append(101, "fee_adjust", { base_micro: 1_000_000n, target: 3, submissions_24h: 0 });
    const text = readFileSync(join(dir, "events.jsonl"), "utf8");
    const events = parseEvents(text);
    expect(events.map((e) => e.id)).toEqual([1, 2]);
    expect(events[1]!["base_micro"]).toBe("1000000");
    for (const e of events) expect(verifyEvent(e, signer.publicKeyPem())).toBe(true);
    const tampered = { ...events[0]!, head: "xyz" };
    expect(verifyEvent(tampered, signer.publicKeyPem())).toBe(false);
    const reopened = new Ledger(join(dir, "events.jsonl"), signer);
    expect(reopened.head).toBe(2);
    expect(reopened.headHash()).toBe(led.headHash());
  });
  it("rejects a ledger with a gap in ids", () => {
    expect(() => parseEvents('{"id":1,"at":1,"type":"genesis"}\n{"id":3,"at":2,"type":"fee_adjust"}\n')).toThrow();
  });
});
