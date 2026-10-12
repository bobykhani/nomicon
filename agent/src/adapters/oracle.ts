/**
 * USDC to Canadian dollars for the tax record Law 5 requires. The Bank of
 * Canada publishes the daily USD/CAD average; USDC is taken at par with the
 * US dollar. The rate is cached for twelve hours, and a fixed fallback
 * covers outages so a payment is never left unrecorded for want of a rate.
 */
import type { PriceOracle } from "../ports.js";

export class BankOfCanadaOracle implements PriceOracle {
  private cached: { rate: string; at: number } | null = null;
  constructor(
    private fallback: string,
    private log: (m: string) => void = () => {},
    private url = "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1",
    private ttlSeconds = 12 * 3600,
  ) {}

  async usdcToCad(): Promise<string> {
    const now = Date.now() / 1000;
    if (this.cached && now - this.cached.at < this.ttlSeconds) return this.cached.rate;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 10_000);
      let data: { observations?: Array<{ d: string; FXUSDCAD?: { v: string } }> };
      try { const res = await fetch(this.url, { signal: ctl.signal }); data = (await res.json()) as typeof data; } finally { clearTimeout(t); }
      const last = data.observations?.[data.observations.length - 1];
      const v = last?.FXUSDCAD?.v;
      if (!v || !/^\d+(\.\d+)?$/.test(v)) throw new Error("no rate in the response");
      this.cached = { rate: v, at: now };
      return v;
    } catch (e) {
      const used = this.cached?.rate ?? this.fallback;
      this.log(`USD/CAD rate unavailable (${(e as Error).message}); using ${used}`);
      return used;
    }
  }
}
