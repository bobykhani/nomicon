/**
 * Article 11: the append-only, signed ledger. Canonical JSON (sorted keys,
 * no whitespace, bigints as decimal strings) is what gets signed.
 */
import { createHash, sign as edSign, verify as edVerify, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type EventType =
  | "genesis" | "intake_reject" | "screen_hold" | "hold_resolved" | "quote" | "quote_lapsed" | "payment" | "vote_open" | "review"
  | "vote_close" | "merge" | "withdrawal" | "expiry" | "owner_confirm" | "owner_reject" | "fee_adjust"
  | "takedown" | "redaction" | "patch" | "deploy" | "destination_change" | "declare" | "correction" | "refusal";

export interface LedgerEvent {
  id: number;
  at: number;
  type: EventType;
  sig?: string;
  [k: string]: unknown;
}

export function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value as object).filter((k) => k !== "sig" && (value as Record<string, unknown>)[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",") + "}";
}

export function eventHash(e: LedgerEvent): string {
  return createHash("sha256").update(canonical(e)).digest("hex");
}

export class Signer {
  private key: KeyObject;
  constructor(privateKeyPem: string) { this.key = createPrivateKey(privateKeyPem); }
  publicKeyPem(): string { return createPublicKey(this.key).export({ type: "spki", format: "pem" }) as string; }
  sign(e: LedgerEvent): string { return edSign(null, Buffer.from(canonical(e)), this.key).toString("base64"); }
}

export function verifyEvent(e: LedgerEvent, publicKeyPem: string): boolean {
  if (!e.sig) return false;
  return edVerify(null, Buffer.from(canonical(e)), createPublicKey(publicKeyPem), Buffer.from(e.sig, "base64"));
}

/** Serialise one event for events.jsonl: bigints as strings. */
export function serialize(e: LedgerEvent): string {
  return JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function parseEvents(text: string): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as LedgerEvent);
  }
  for (let i = 0; i < out.length; i++) if (out[i]!.id !== i + 1) throw new Error(`ledger event ${i + 1} has id ${out[i]!.id}`);
  return out;
}

export class Ledger {
  readonly events: LedgerEvent[];
  constructor(readonly path: string, private signer?: Signer) {
    this.events = existsSync(path) ? parseEvents(readFileSync(path, "utf8")) : [];
  }
  get head(): number { return this.events.length; }
  /** Append, sign, write. Returns the stored event. */
  append(at: number, type: EventType, fields: Record<string, unknown>): LedgerEvent {
    const e: LedgerEvent = { id: this.head + 1, at, type, ...fields };
    if (this.signer) e.sig = this.signer.sign(e);
    appendFileSync(this.path, serialize(e) + "\n", "utf8");
    this.events.push(e);
    return e;
  }
  headHash(): string {
    const h = createHash("sha256");
    for (const e of this.events) h.update(eventHash(e));
    return h.digest("hex");
  }
}
