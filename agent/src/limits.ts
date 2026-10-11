/**
 * Guards for the agent's public surface: which doorbell addresses are
 * acceptable (Law 12), and how many requests one client may make.
 */
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

function v4Private(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** True for loopback, private, link-local, carrier-grade NAT, multicast, reserved and unspecified addresses, and for anything that is not an address. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return v4Private(ip);
  if (v !== 6) return true;
  const lower = ip.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return v4Private(dotted[1]!);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) { const a = parseInt(hex[1]!, 16), b = parseInt(hex[2]!, 16); return v4Private(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
  if (lower === "::1" || lower === "::") return true;
  const first = parseInt(lower.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  return false;
}

/** Why a doorbell address is not acceptable, or null if it is. Syntactic only; resolution is checked at delivery. */
export function doorbellUrlProblem(raw: string, opts: { allowPrivate?: boolean } = {}): string | null {
  if (raw.length > 2048) return "address longer than 2048 characters";
  let u: URL;
  try { u = new URL(raw); } catch { return "not a valid URL"; }
  if (u.username || u.password) return "credentials in the address are not accepted";
  if (u.protocol !== "https:" && !(opts.allowPrivate && u.protocol === "http:")) return "only https addresses are accepted";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return "no host";
  if (opts.allowPrivate) return null;
  if (isIP(host)) return isPrivateAddress(host) ? "private or reserved addresses are not accepted" : null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa") || !host.includes(".")) return "host must be a public name";
  return null;
}

/** Token bucket per key. `perMinute` sustained, `burst` at once. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private calls = 0;
  constructor(private perMinute: number, private burst = perMinute) {}
  allow(key: string, nowMs: number): boolean {
    if (++this.calls % 1000 === 0) for (const [k, b] of this.buckets) if (nowMs - b.at > 600_000) this.buckets.delete(k);
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: nowMs };
    b.tokens = Math.min(this.burst, b.tokens + ((nowMs - b.at) / 60_000) * this.perMinute);
    b.at = nowMs;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

/** The client's address; the first X-Forwarded-For entry only when a trusted proxy sits in front. */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xf = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xf) ? xf[0] : xf)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}
