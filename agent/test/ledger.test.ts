import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, Signer, canonical, parseEvents, readLedgerDir, segmentOf, verifyEvent } from "../src/ledger.js";

const { privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const DAY = 86400;
const t0 = 1_791_700_000; // 2026-10-11 UTC

describe("ledger", () => {
  it("canonical JSON sorts keys, drops sig and undefined, and stringifies bigints", () => {
    expect(canonical({ b: 1n, a: "x", sig: "zzz", u: undefined, n: { z: [1, 2n] } })).toBe('{"a":"x","b":"1","n":{"z":[1,"2"]}}');
  });
  it("appends signed events into one file per UTC day, with head.json, and reads them back in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "nomicon-"));
    const signer = new Signer(pem);
    const led = new Ledger(dir, signer);
    led.append(t0, "genesis", { head: "abc", fee_destination: "0x1", laws_hash: "h", owner_accounts: [1], agent_account: 2 });
    led.append(t0 + 10, "fee_adjust", { base_micro: 1_000_000n, target: 3, submissions_24h: 0 });
    led.append(t0 + DAY, "fee_adjust", { base_micro: 1_050_000n, target: 3, submissions_24h: 4 });
    const files = readdirSync(join(dir, "events")).sort();
    expect(files).toEqual([segmentOf(t0) + ".jsonl", segmentOf(t0 + DAY) + ".jsonl"]);
    const day1 = parseEvents(readFileSync(join(dir, "events", files[0]!), "utf8"));
    expect(day1.map((e) => e.id)).toEqual([1, 2]);
    expect(day1[1]!["base_micro"]).toBe("1000000");
    for (const e of readLedgerDir(dir)) expect(verifyEvent(e, signer.publicKeyPem())).toBe(true);
    const head = JSON.parse(readFileSync(join(dir, "head.json"), "utf8"));
    expect(head.head_event).toBe(3);
    expect(head.segment).toBe(segmentOf(t0 + DAY));
    expect(head.head_hash).toBe(led.headHash());
    const reopened = new Ledger(dir, signer);
    expect(reopened.head).toBe(3);
    expect(reopened.headHash()).toBe(led.headHash());
    expect(reopened.dirtySegments()).toEqual(files.map((f) => f.slice(0, 10)));
    reopened.markPublished(reopened.dirtySegments());
    expect(reopened.dirtySegments()).toEqual([]);
    expect(reopened.segmentContent(segmentOf(t0)).split("\n").filter(Boolean).length).toBe(2);
  });
  it("adopts what another process appended, and refuses a disk that disagrees", () => {
    const dir = mkdtempSync(join(tmpdir(), "nomicon-"));
    const a = new Ledger(dir), b = new Ledger(dir);
    a.append(t0, "genesis", { head: "x" });
    expect(b.reload()).toBe(1);
    b.append(t0 + DAY + 5, "fee_adjust", { base_micro: 1n });
    expect(a.reload()).toBe(1);
    expect(a.head).toBe(2);
    expect(a.dirtySegments()).toEqual([segmentOf(t0), segmentOf(t0 + DAY + 5)]);
    // Reload re-reads only the day holding the last event and anything newer; earlier days are replay's job.
    const tampered = JSON.stringify({ id: 2, at: t0 + DAY + 5, type: "fee_adjust", base_micro: "2" }) + "\n";
    writeFileSync(join(dir, "events", segmentOf(t0 + DAY + 5) + ".jsonl"), tampered);
    expect(() => a.reload()).toThrow(/differs on disk/);
  });
  it("rejects an event filed under the wrong day, and a gap in ids across files", () => {
    const dir = mkdtempSync(join(tmpdir(), "nomicon-"));
    mkdirSync(join(dir, "events"));
    writeFileSync(join(dir, "events", segmentOf(t0) + ".jsonl"), '{"id":1,"at":' + (t0 + DAY) + ',"type":"genesis"}\n');
    expect(() => readLedgerDir(dir)).toThrow(/belongs to/);
    writeFileSync(join(dir, "events", segmentOf(t0) + ".jsonl"), '{"id":1,"at":' + t0 + ',"type":"genesis"}\n');
    writeFileSync(join(dir, "events", segmentOf(t0 + DAY) + ".jsonl"), '{"id":3,"at":' + (t0 + DAY) + ',"type":"fee_adjust"}\n');
    expect(() => readLedgerDir(dir)).toThrow(/has id 3/);
  });
  it("migrates the old single file into segments and refuses to append until that is done", () => {
    const dir = mkdtempSync(join(tmpdir(), "nomicon-"));
    writeFileSync(join(dir, "events.jsonl"), [`{"id":1,"at":${t0},"type":"genesis"}`, `{"id":2,"at":${t0 + DAY},"type":"fee_adjust"}`, `{"id":3,"at":${t0 + DAY + 1},"type":"fee_adjust"}`].join("\n") + "\n");
    const legacy = new Ledger(dir);
    expect(legacy.head).toBe(3);
    expect(() => legacy.append(t0 + 2 * DAY, "fee_adjust", {})).toThrow(/migrate-ledger/);
    expect(Ledger.migrate(dir)).toBe(3);
    expect(existsSync(join(dir, "events.jsonl"))).toBe(false);
    expect(readdirSync(join(dir, "events")).sort()).toEqual([segmentOf(t0) + ".jsonl", segmentOf(t0 + DAY) + ".jsonl"]);
    const led = new Ledger(dir);
    expect(led.head).toBe(3);
    led.append(t0 + 2 * DAY, "fee_adjust", {});
    expect(JSON.parse(readFileSync(join(dir, "head.json"), "utf8")).head_event).toBe(4);
  });
});
