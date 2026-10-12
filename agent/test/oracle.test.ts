import { afterEach, describe, expect, it, vi } from "vitest";
import { BankOfCanadaOracle } from "../src/adapters/oracle.js";

const reply = (body: unknown) => ({ json: async () => body }) as unknown as Response;

describe("Bank of Canada oracle", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("reads the latest USD/CAD observation and caches it", async () => {
    const fetch = vi.fn(async () => reply({ observations: [{ d: "2026-10-08", FXUSDCAD: { v: "1.4100" } }, { d: "2026-10-09", FXUSDCAD: { v: "1.4271" } }] }));
    vi.stubGlobal("fetch", fetch);
    const o = new BankOfCanadaOracle("1.37");
    expect(await o.usdcToCad()).toBe("1.4271");
    expect(await o.usdcToCad()).toBe("1.4271");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("falls back to the fixed rate when the feed is down or malformed, and says so", async () => {
    const logs: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await new BankOfCanadaOracle("1.37", (m) => logs.push(m)).usdcToCad()).toBe("1.37");
    vi.stubGlobal("fetch", vi.fn(async () => reply({ observations: [{ d: "x", FXUSDCAD: { v: "not a number" } }] })));
    expect(await new BankOfCanadaOracle("1.37", (m) => logs.push(m)).usdcToCad()).toBe("1.37");
    expect(logs.length).toBe(2);
  });
});
