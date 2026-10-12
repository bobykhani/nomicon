#!/usr/bin/env node
/**
 * nomicon <command>
 *
 *   keygen                         print a new ed25519 key pair for ledger signing
 *   genesis                        write the first ledger event (bootstrap begins)
 *   run                            start the agent loop and the payment endpoint
 *   replay                         recompute the ledger and report differences
 *   confirm <pr> <reason>          bootstrap: confirm a contribution
 *   reject <pr> <reason> [--bar]   bootstrap: reject a contribution (--bar applies the Article 4 bar)
 *   release <pr> <reason>          resolve a screening hold by releasing it to a vote
 *   hold-reject <pr> <reason>      resolve a screening hold by rejecting it (applies the bar)
 *   takedown <pr,...> <reason> [notice_hash]
 *   rotate-destination <address> <reason>
 *   maintenance <from_iso> <to_iso> <reason>
 *   end-bootstrap <reason>
 *   deploy <commit> <reason>
 *   patch <commit> <reason>
 *   amend-laws <reason>            bootstrap only: bring the repository's current laws.json into force now (Article 3)
 *
 * Environment: NOMICON_REPO_ROOT, NOMICON_LEDGER_KEY (pkcs8 pem or path),
 * GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (pem or path) [+ GITHUB_APP_INSTALLATION_ID] for the agent's own
 * GitHub App identity, or GITHUB_TOKEN for local testing; GITHUB_OWNER, GITHUB_REPO, NOMICON_NETWORK (eip155:8453 | eip155:84532), BASE_RPC_URL,
 * ANCHOR_PRIVATE_KEY, X402_FACILITATOR_URL, NOMICON_PUBLIC_URL, NOMICON_PORT, ANTHROPIC_API_KEY,
 * NOMICON_OWNER_ACCOUNTS (comma-separated numeric ids), NOMICON_AGENT_ACCOUNT, NOMICON_FEE_DESTINATION,
 * NOMICON_DOORBELL_ISSUE (issue number accounts comment on to register a doorbell; unset disables),
 * NOMICON_DATA_DIR (private directory for doorbell URLs; default <repo root>/../nomicon-private),
 * CDP_API_KEY_ID + CDP_API_KEY_SECRET (Coinbase facilitator, required on Base mainnet) or X402_FACILITATOR_URL (testnets),
 * ANCHOR_PRIVATE_KEY (gas wallet for ledger anchors, required on mainnet), NOMICON_USDC_CAD (fixed rate; unset = Bank of Canada daily),
 * NOMICON_TRUST_PROXY=1 behind a reverse proxy that sets X-Forwarded-For,
 * NOMICON_DOORBELL_ALLOW_PRIVATE=1 accepts http and private doorbell addresses (local testing only).
 */
import { generateKeyPairSync } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ledger, Signer } from "./ledger.js";
import { replayFromFiles } from "./replay.js";
import { Runtime } from "./runtime.js";
import { FileDoorbellStore, GitHubAdapter, HttpDoorbell } from "./adapters/github.js";
import { octokitFor, parseGitHubAuthEnv, type GitHubIdentity } from "./adapters/auth.js";
import { Notifier } from "./notifier.js";
import { BaseChainAdapter, USDC } from "./adapters/chain.js";
import { ClaudeScreen } from "./screen.js";
import { createPayServer, describeFacilitator, type FacilitatorChoice } from "./pay.js";
import { BankOfCanadaOracle } from "./adapters/oracle.js";
import { preflight } from "./check.js";
import { loadLaws } from "./laws.js";
import type { PriceOracle } from "./ports.js";

const env = (k: string, def?: string): string => {
  const v = process.env[k] ?? def;
  if (v === undefined) throw new Error(`missing environment variable ${k}`);
  return v;
};
const root = () => resolve(env("NOMICON_REPO_ROOT", process.cwd()));
const now = () => Math.floor(Date.now() / 1000);

function signer(): Signer {
  const k = env("NOMICON_LEDGER_KEY");
  const pem = existsSync(k) ? readFileSync(k, "utf8") : k;
  return new Signer(pem);
}
function ledger(): Ledger { return new Ledger(resolve(root(), "ledger/events.jsonl"), signer()); }

async function githubFromEnv(): Promise<{ github: GitHubAdapter; identity: GitHubIdentity }> {
  const owner = env("GITHUB_OWNER"), repo = env("GITHUB_REPO");
  const { octokit, identity } = await octokitFor(parseGitHubAuthEnv(process.env), owner, repo);
  return { github: new GitHubAdapter(owner, repo, octokit), identity };
}

function ownerCommand(type: Parameters<Ledger["append"]>[1], fields: Record<string, unknown>): void {
  const l = ledger();
  const e = l.append(now(), type, { ...fields, by: env("NOMICON_OWNER_ACCOUNTS").split(",")[0]! });
  console.log(`recorded event ${e.id}: ${type}`);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "keygen": {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      console.log(privateKey.export({ type: "pkcs8", format: "pem" }));
      console.log(publicKey.export({ type: "spki", format: "pem" }));
      return;
    }
    case "genesis": {
      const l = ledger();
      if (l.head > 0) throw new Error("ledger already has events");
      const { hash, raw } = loadLaws(root());
      const rawSchema = readFileSync(resolve(root(), "laws.schema.json"), "utf8");
      const head = args[0] ?? env("NOMICON_HEAD_COMMIT");
      const e = l.append(now(), "genesis", {
        head, laws_hash: hash,
        owner_accounts: env("NOMICON_OWNER_ACCOUNTS").split(",").map(Number),
        owner_keys: [signer().publicKeyPem()],
        agent_account: process.env["NOMICON_AGENT_ACCOUNT"] ? Number(process.env["NOMICON_AGENT_ACCOUNT"]) : (await githubFromEnv()).identity.id,
        fee_destination: env("NOMICON_FEE_DESTINATION"),
        network: env("NOMICON_NETWORK"),
      });
      l.append(now(), "laws_snapshot", { pr: null, laws_hash: hash, laws_raw: raw, schema_raw: rawSchema, effective_at: e.at, merge_commit: head });
      console.log(`genesis recorded as event ${e.id}; bootstrap has begun`);
      return;
    }
    case "replay": {
      const r = replayFromFiles(root(), now());
      if (r.ok) console.log(`replay ok: ${r.state.head_event} events, ${r.state.weighted_accounts} weighted accounts, base fee ${r.state.fee.base_micro} micro`);
      else { for (const f of r.findings) console.log(`event ${f.event}: ${f.problem}`); process.exitCode = 1; }
      return;
    }
    case "confirm": ownerCommand("owner_confirm", { pr: Number(args[0]), reason: args.slice(1).join(" ") }); return;
    case "reject": {
      const bar = args.includes("--bar");
      const reason = args.slice(1).filter((a) => a !== "--bar").join(" ");
      const fields: Record<string, unknown> = { pr: Number(args[0]), reason };
      if (bar) { const l = loadLaws(root()).laws; fields["barred_until"] = now() + l.screening.floor_rejection_bar_days * 86400; }
      ownerCommand("owner_reject", fields); return;
    }
    case "release": ownerCommand("hold_resolved", { pr: Number(args[0]), decision: "release", reason: args.slice(1).join(" ") }); return;
    case "hold-reject": {
      const l = loadLaws(root()).laws;
      ownerCommand("hold_resolved", { pr: Number(args[0]), decision: "reject", reason: args.slice(1).join(" "), barred_until: now() + l.screening.floor_rejection_bar_days * 86400 }); return;
    }
    case "takedown": ownerCommand("takedown", { prs: args[0]!.split(",").map(Number), reason: args[1], notice_hash: args[2] ?? null }); return;
    case "rotate-destination": ownerCommand("destination_change", { destination: args[0], reason: args.slice(1).join(" ") }); return;
    case "maintenance": ownerCommand("declare", { what: "maintenance_window", from: Math.floor(Date.parse(args[0]!) / 1000), to: Math.floor(Date.parse(args[1]!) / 1000), reason: args.slice(2).join(" ") }); return;
    case "end-bootstrap": ownerCommand("declare", { what: "bootstrap_end", reason: args.join(" ") }); return;
    case "deploy": ownerCommand("deploy", { commit: args[0], reason: args.slice(1).join(" ") }); return;
    case "patch": ownerCommand("patch", { commit: args[0], reason: args.slice(1).join(" ") }); return;
    case "amend-laws": {
      const l = ledger();
      if (l.events.some((e) => e.type === "declare" && e["what"] === "bootstrap_end")) throw new Error("bootstrap has ended; the Laws change only by the Laws procedure");
      const { hash, raw } = loadLaws(root());
      const rawSchema = readFileSync(resolve(root(), "laws.schema.json"), "utf8");
      let head = process.env["NOMICON_HEAD_COMMIT"] || "";
      try { head = execSync("git rev-parse HEAD", { cwd: root(), encoding: "utf8" }).trim(); } catch { /* keep env value */ }
      const e = l.append(now(), "laws_snapshot", { pr: null, laws_hash: hash, laws_raw: raw, schema_raw: rawSchema, effective_at: now(), merge_commit: head, amended_by_owner: true, reason: args.join(" "), by: env("NOMICON_OWNER_ACCOUNTS").split(",")[0]! });
      console.log(`laws ${hash.slice(0, 12)} in force now as event ${e.id} (owner amendment during bootstrap)`);
      return;
    }
    case "run": return run();
    case "record-payment": return recordPayment(Number(args[0]), args[1] ?? "");
    case "check": return check();
    default:
      console.log("usage: nomicon <keygen|genesis|run|replay|confirm|reject|release|hold-reject|takedown|rotate-destination|maintenance|end-bootstrap|deploy|patch|amend-laws|record-payment|check>");
      process.exitCode = 1;
  }
}

type Network = "eip155:8453" | "eip155:84532";
const MAINNET: Network = "eip155:8453";

/** Mainnet settles only through a facilitator that supports it; x402.org settles testnets. */
function facilitatorFromEnv(network: Network): FacilitatorChoice {
  const id = process.env["CDP_API_KEY_ID"], secret = process.env["CDP_API_KEY_SECRET"];
  if (id && secret) return { kind: "cdp", apiKeyId: id, apiKeySecret: secret };
  const url = env("X402_FACILITATOR_URL", "https://x402.org/facilitator");
  if (network === MAINNET && /x402\.org/.test(url)) throw new Error("x402.org settles test networks only; on Base mainnet set CDP_API_KEY_ID and CDP_API_KEY_SECRET (see RUNBOOK.md, Going to mainnet)");
  return { kind: "url", url };
}

function oracleFromEnv(log: (m: string) => void): PriceOracle {
  const fixed = process.env["NOMICON_USDC_CAD"];
  if (fixed) return { usdcToCad: async () => fixed };
  return new BankOfCanadaOracle("1.37", log);
}

/** Everything the runtime needs, built from the environment; shared by `run` and the owner commands that act through the runtime. */
async function buildRuntime(): Promise<{ rt: Runtime; led: Ledger; chain: BaseChainAdapter; network: Network; log: (m: string) => void; publicBaseUrl: string; trustProxy: boolean }> {
  const network = env("NOMICON_NETWORK", "eip155:84532") as Network;
  const { github, identity } = await githubFromEnv();
  const led = ledger();
  const genesis = led.events.find((e) => e.type === "genesis");
  const agentAccount = genesis ? Number(genesis["agent_account"]) : null;
  if (agentAccount !== null && agentAccount !== identity.id) throw new Error(`GitHub identity ${identity.login} (${identity.id}) is not the agent account ${agentAccount} named at genesis; quotes would come from the wrong account`);
  const log = (m: string) => console.log(new Date().toISOString(), m);
  log(`github identity: ${identity.login} (${identity.id})`);
  const anchorKey = process.env["ANCHOR_PRIVATE_KEY"] as `0x${string}` | undefined;
  const chain = new BaseChainAdapter(network, env("BASE_RPC_URL"), anchorKey);
  const oracle = oracleFromEnv(log);
  const publicBaseUrl = env("NOMICON_PUBLIC_URL");
  if (network === MAINNET && !publicBaseUrl.startsWith("https://")) throw new Error("NOMICON_PUBLIC_URL must be https on mainnet");
  const doorbellIssue = process.env["NOMICON_DOORBELL_ISSUE"] ? Number(process.env["NOMICON_DOORBELL_ISSUE"]) : null;
  const dataDir = env("NOMICON_DATA_DIR", resolve(root(), "..", "nomicon-private"));
  const allowPrivate = process.env["NOMICON_DOORBELL_ALLOW_PRIVATE"] === "1";
  const trustProxy = process.env["NOMICON_TRUST_PROXY"] === "1";
  if (allowPrivate && network === MAINNET) throw new Error("NOMICON_DOORBELL_ALLOW_PRIVATE must not be set on mainnet");
  if (allowPrivate) log("WARNING: NOMICON_DOORBELL_ALLOW_PRIVATE is set; private doorbell addresses are accepted. Never run like this in production.");
  const notifier = new Notifier({ github, doorbell: new HttpDoorbell({ allowPrivate }), store: new FileDoorbellStore(resolve(dataDir, "doorbells.json")), ledger: led, clock: { now }, log, doorbellIssue, allowPrivateDoorbells: allowPrivate });
  const rt = new Runtime({
    github, chain, screen: new ClaudeScreen(), oracle, clock: { now }, ledger: led, publicBaseUrl, notifier,
    loadLaws: async () => ({ rawLaws: await github.readFile("main", "laws.json"), rawSchema: await github.readFile("main", "laws.schema.json") }),
    termsCommit: async () => env("NOMICON_TERMS_COMMIT", "main"),
    log,
  });
  return { rt, led, chain, network, log, publicBaseUrl, trustProxy };
}

async function run(): Promise<void> {
  const { rt, network, publicBaseUrl, trustProxy, log } = await buildRuntime();
  const facilitator = facilitatorFromEnv(network);
  log(`network ${network}, facilitator ${describeFacilitator(facilitator)}`);
  const { server } = await createPayServer({
    network, facilitator,
    quoteFor: (pr) => rt.quoteFor(pr), onPaid: (n) => rt.onPaid(n), now, publicBaseUrl,
    feed: (since) => rt.feed(since), questions: () => rt.questionsIndex(),
    limits: { trustProxy },
  });
  server.listen(Number(env("NOMICON_PORT", "8402")), () => console.log(`payment endpoint on :${env("NOMICON_PORT", "8402")}`));
  const interval = Number(env("NOMICON_TICK_SECONDS", "60")) * 1000;
  for (;;) {
    try { await rt.tick(); } catch (e) { console.error(new Date().toISOString(), "tick failed:", (e as Error).message); }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Verify the configuration against the live services without moving money. Exit 1 on any failure. */
async function check(): Promise<void> {
  const network = env("NOMICON_NETWORK", "eip155:84532") as Network;
  let facilitator: FacilitatorChoice | Error;
  try { facilitator = facilitatorFromEnv(network); } catch (e) { facilitator = e as Error; }
  const results = await preflight({
    network, rpcUrl: env("BASE_RPC_URL"), usdc: USDC[network], destination: process.env["NOMICON_FEE_DESTINATION"] ?? null,
    publicBaseUrl: process.env["NOMICON_PUBLIC_URL"] ?? "", facilitator, anchorKey: process.env["ANCHOR_PRIVATE_KEY"] ?? null,
    allowPrivate: process.env["NOMICON_DOORBELL_ALLOW_PRIVATE"] === "1", dataDir: env("NOMICON_DATA_DIR", resolve(root(), "..", "nomicon-private")),
    anthropicKey: !!process.env["ANTHROPIC_API_KEY"],
    github: async () => { const { github, identity } = await githubFromEnv(); const pulls = await github.listOpenPulls(); return `${identity.login} (${identity.id}), ${pulls.length} open pull request(s) readable`; },
    ledgerKey: () => { const s = signer(); return s.publicKeyPem().split("\n")[1]?.slice(0, 16) ?? ""; },
    ledger: () => { const l = ledger(); const g = l.events.find((e) => e.type === "genesis"); return g ? { agentAccount: Number(g["agent_account"]), destination: String(g["fee_destination"]), network: String(g["network"]) } : null; },
  });
  let failed = 0;
  for (const r of results) { if (!r.ok && r.severity === "fail") failed++; console.log(`${r.ok ? "ok  " : r.severity === "fail" ? "FAIL" : "warn"}  ${r.name}: ${r.detail}`); }
  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  if (failed) process.exitCode = 1;
}

/** A payment the facilitator settled but the agent failed to record: verify the transfer on chain, then record it through the same path as a live payment. */
async function recordPayment(pr: number, tx: string): Promise<void> {
  if (!pr || !tx) throw new Error("usage: nomicon record-payment <pr> <transaction hash>");
  const { rt, led, chain, network } = await buildRuntime();
  if (led.events.some((e) => e.type === "payment" && String(e["tx"]).toLowerCase() === tx.toLowerCase())) throw new Error("that transaction is already recorded");
  const t = await chain.usdcTransfer(tx, USDC[network]);
  if (!t) throw new Error("no successful USDC transfer found in that transaction");
  const dest = replayFromFiles(root(), now()).state.fee.destination;
  if (!dest || t.to.toLowerCase() !== dest.toLowerCase()) throw new Error(`the transfer went to ${t.to}, not the destination in force ${dest}`);
  await rt.onPaid({ pr, tx, payer: t.from, amountMicro: t.amountMicro, network });
  console.log(`payment recorded for pr ${pr}: ${t.amountMicro} micro-USDC from ${t.from} in block ${t.blockNumber}`);
}

main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
