/**
 * `nomicon check`: everything that must be true before genesis or a restart,
 * verified against the live services with no money moved. Each check is one
 * line of output; a failure stops nothing here but should stop the operator.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, formatEther, http, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { describeFacilitator, facilitatorFor, type FacilitatorChoice } from "./pay.js";

export type Network = "eip155:8453" | "eip155:84532";

export interface CheckDeps {
  network: Network;
  rpcUrl: string;
  usdc: string;
  destination: string | null;
  publicBaseUrl: string;
  facilitator: FacilitatorChoice | Error;
  anchorKey: string | null;
  allowPrivate: boolean;
  dataDir: string;
  anthropicKey: boolean;
  github: () => Promise<string>;
  ledgerKey: () => string;
  ledger: () => { agentAccount: number; destination: string; network: string } | null;
}

export interface CheckResult { name: string; ok: boolean; severity: "fail" | "warn"; detail: string }

export async function preflight(d: CheckDeps): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const mainnet = d.network === "eip155:8453";
  const push = (name: string, ok: boolean, detail: string, severity: "fail" | "warn" = "fail") => out.push({ name, ok, severity, detail });
  const run = async (name: string, f: () => Promise<[boolean, string]>, severity: "fail" | "warn" = "fail") => {
    try { const [ok, detail] = await f(); push(name, ok, detail, severity); } catch (e) { push(name, false, (e as Error).message, severity); }
  };

  const chain = mainnet ? base : baseSepolia;
  const pub = createPublicClient({ chain, transport: http(d.rpcUrl) });
  await run("rpc", async () => { const id = await pub.getChainId(); return [id === chain.id, `${d.rpcUrl} answers chain ${id}; expected ${chain.id} for ${d.network}`]; });
  await run("clock", async () => { const b = await pub.getBlock(); const drift = Math.round(Date.now() / 1000 - Number(b.timestamp)); return [Math.abs(drift) < 120, `local clock is ${drift}s ahead of the latest block`]; }, "warn");
  await run("usdc", async () => { const code = await pub.getCode({ address: d.usdc as Hex }); return [!!code && code !== "0x", `${d.usdc} ${code && code !== "0x" ? "has contract code" : "has no code on this network"}`]; });
  await run("destination", async () => {
    if (!d.destination) return [false, "NOMICON_FEE_DESTINATION is not set"];
    if (!isAddress(d.destination) || /^0x0{40}$/i.test(d.destination)) return [false, `${d.destination} is not a usable address`];
    const code = await pub.getCode({ address: d.destination as Hex });
    const contract = !!code && code !== "0x";
    return [true, `${d.destination} (${contract ? "a contract: make sure it accepts plain USDC transfers" : "an ordinary account"})`];
  });
  await run("facilitator", async () => {
    if (d.facilitator instanceof Error) return [false, d.facilitator.message];
    const kinds = (await facilitatorFor(d.facilitator).getSupported()).kinds;
    const ok = kinds.some((k) => k.x402Version === 2 && k.scheme === "exact" && k.network === d.network);
    return [ok, `${describeFacilitator(d.facilitator)} ${ok ? "settles" : "does not settle"} exact payments on ${d.network}`];
  });
  await run("anchor", async () => {
    if (!d.anchorKey) return [!mainnet, mainnet ? "ANCHOR_PRIVATE_KEY is required on mainnet (Article 11 anchoring)" : "no anchor key; anchoring is skipped on the test network"];
    const a = privateKeyToAccount(d.anchorKey as Hex);
    const bal = await pub.getBalance({ address: a.address });
    return [bal > 0n, `${a.address} holds ${formatEther(bal)} ETH for gas`];
  }, mainnet ? "fail" : "warn");
  push("public url", /^https:\/\//.test(d.publicBaseUrl) || (!mainnet && /^http:\/\//.test(d.publicBaseUrl)), d.publicBaseUrl || "NOMICON_PUBLIC_URL is not set");
  push("doorbells", !(d.allowPrivate && mainnet), d.allowPrivate ? "private addresses allowed (NOMICON_DOORBELL_ALLOW_PRIVATE=1)" : "public https addresses only", mainnet ? "fail" : "warn");
  push("screen", d.anthropicKey, d.anthropicKey ? "ANTHROPIC_API_KEY is set" : "ANTHROPIC_API_KEY is not set; Law 10 screening cannot run");
  await run("github", async () => [true, await d.github()]);
  await run("ledger key", async () => [true, `signing key loads; public key begins ${d.ledgerKey()}`]);
  await run("data dir", async () => { mkdirSync(d.dataDir, { recursive: true }); const p = join(d.dataDir, ".write-test"); writeFileSync(p, "ok"); rmSync(p); return [true, `${d.dataDir} is writable`]; });
  await run("ledger", async () => {
    const g = d.ledger();
    if (!g) return [true, "no genesis yet; run `nomicon genesis` when the Constitution placeholders are filled"];
    const problems: string[] = [];
    if (g.network !== d.network) problems.push(`genesis network ${g.network} differs from NOMICON_NETWORK ${d.network}`);
    if (d.destination && g.destination.toLowerCase() !== d.destination.toLowerCase()) problems.push(`destination in force ${g.destination} differs from NOMICON_FEE_DESTINATION; use rotate-destination, not the environment`);
    return [problems.length === 0, problems.length ? problems.join("; ") : `agent account ${g.agentAccount}, destination ${g.destination}, network ${g.network} in force`];
  });
  return out;
}
