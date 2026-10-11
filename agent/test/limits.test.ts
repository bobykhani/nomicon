import { describe, expect, it } from "vitest";
import { RateLimiter, doorbellUrlProblem, isPrivateAddress } from "../src/limits.js";

describe("doorbell addresses", () => {
  it("accepts a public https address", () => {
    expect(doorbellUrlProblem("https://agent.example.com/hook?x=1")).toBeNull();
    expect(doorbellUrlProblem("https://203.0.113.9:8443/hook")).toBeNull();
  });
  it("refuses plain http, localhost, private ranges, credentials and single labels", () => {
    expect(doorbellUrlProblem("http://agent.example.com/hook")).toMatch(/https/);
    expect(doorbellUrlProblem("https://localhost/hook")).toMatch(/public/);
    expect(doorbellUrlProblem("https://10.0.0.7/hook")).toMatch(/private/);
    expect(doorbellUrlProblem("https://127.1/hook")).toMatch(/private/);
    expect(doorbellUrlProblem("https://169.254.169.254/latest")).toMatch(/private/);
    expect(doorbellUrlProblem("https://[::1]/hook")).toMatch(/private/);
    expect(doorbellUrlProblem("https://[::ffff:127.0.0.1]/hook")).toMatch(/private/);
    expect(doorbellUrlProblem("https://user:pw@agent.example.com/")).toMatch(/credentials/);
    expect(doorbellUrlProblem("https://intranet/hook")).toMatch(/public/);
    expect(doorbellUrlProblem("https://box.internal/hook")).toMatch(/public/);
    expect(doorbellUrlProblem("not a url")).toMatch(/valid/);
    expect(doorbellUrlProblem("https://a.example/" + "x".repeat(2100))).toMatch(/longer/);
  });
  it("allows loopback and http only when told to", () => {
    expect(doorbellUrlProblem("http://localhost:8766/", { allowPrivate: true })).toBeNull();
  });
  it("classifies addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:a00:1", "garbage"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1111", "1.1.1.1", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("rate limiter", () => {
  it("allows a burst, refuses until tokens refill, and keeps keys apart", () => {
    const l = new RateLimiter(60, 5);
    let t = 0;
    for (let i = 0; i < 5; i++) expect(l.allow("a", t)).toBe(true);
    expect(l.allow("a", t)).toBe(false);
    expect(l.allow("b", t)).toBe(true);
    t += 1000;
    expect(l.allow("a", t)).toBe(true);
    expect(l.allow("a", t)).toBe(false);
    t += 60_000;
    for (let i = 0; i < 5; i++) expect(l.allow("a", t)).toBe(true);
    expect(l.allow("a", t)).toBe(false);
  });
});
