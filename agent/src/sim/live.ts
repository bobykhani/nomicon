#!/usr/bin/env node
/**
 * Helpers for the live smoke test against a throwaway repository and Base Sepolia.
 *
 *   live open-pr <path> <text>     open a signed-off pull request adding one World file
 *   live pay <pr>                  pay the quoted fee through the agent's x402 endpoint
 *   live review <pr> approve|request
 *   live balance                   payer wallet's USDC balance on the test network
 *
 * Environment: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, NOMICON_PUBLIC_URL, BASE_RPC_URL,
 * NOMICON_PAYER_KEY (path to a 0x private key file), NOMICON_NETWORK.
 */
import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { createPublicClient, erc20Abi, formatUnits, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { USDC } from "../adapters/chain.js";

const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const owner = () => env("GITHUB_OWNER"), repo = () => env("GITHUB_REPO");
const network = () => env("NOMICON_NETWORK", "eip155:84532") as "eip155:8453" | "eip155:84532";
const chain = () => (network() === "eip155:8453" ? base : baseSepolia);
const payer = () => privateKeyToAccount(readFileSync(env("NOMICON_PAYER_KEY"), "utf8").trim() as Hex);

async function openPr(path: string, text: string): Promise<void> {
  const gh = new Octokit({ auth: env("GITHUB_TOKEN") });
  const { data: me } = await gh.users.getAuthenticated();
  const { data: ref } = await gh.git.getRef({ owner: owner(), repo: repo(), ref: "heads/main" });
  const branch = `sim/${Date.now()}`;
  await gh.git.createRef({ owner: owner(), repo: repo(), ref: `refs/heads/${branch}`, sha: ref.object.sha });
  const signoff = `Signed-off-by: ${me.login} <${me.id}+${me.login}@users.noreply.github.com>`;
  await gh.repos.createOrUpdateFileContents({ owner: owner(), repo: repo(), path, branch, message: `Add ${path}\n\n${signoff}`, content: Buffer.from(text, "utf8").toString("base64") });
  const { data: pr } = await gh.pulls.create({ owner: owner(), repo: repo(), title: `sim: ${path}`, head: branch, base: "main", body: "Live smoke test submission." });
  console.log(`opened pull request #${pr.number}: ${pr.html_url}`);
}

async function pay(pr: number): Promise<void> {
  const account = payer();
  const client = x402Client.fromConfig({
    schemes: [{ network: network(), client: new ExactEvmScheme(account) }],
    spendControls: { maxAmountPerPayment: "$500" },
  });
  const fetchWithPay = wrapFetchWithPayment(fetch, client);
  const url = `${env("NOMICON_PUBLIC_URL").replace(/\/$/, "")}/pay/${pr}`;
  console.log(`paying ${url} from ${account.address}`);
  const res = await fetchWithPay(url, { method: "POST" });
  const body = await res.text();
  console.log(`status ${res.status}: ${body}`);
  const settle = res.headers.get("payment-response");
  if (settle) console.log(`payment-response: ${Buffer.from(settle, "base64").toString("utf8")}`);
}

async function review(pr: number, verdict: string): Promise<void> {
  const gh = new Octokit({ auth: env("GITHUB_TOKEN") });
  const event = verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES";
  const { data } = await gh.pulls.createReview({ owner: owner(), repo: repo(), pull_number: pr, event, body: `sim ${verdict}` });
  console.log(`review ${data.id} ${data.state}`);
}

async function balance(): Promise<void> {
  const account = payer();
  const pub = createPublicClient({ chain: chain(), transport: http(env("BASE_RPC_URL")) });
  const bal = await pub.readContract({ address: USDC[network()], abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const eth = await pub.getBalance({ address: account.address });
  console.log(`${account.address}: ${formatUnits(bal, 6)} USDC, ${formatUnits(eth, 18)} ETH on ${network()}`);
}

const [cmd, a, b] = process.argv.slice(2);
const run = async () => {
  switch (cmd) {
    case "open-pr": return openPr(a ?? "world/sim/hello.md", b ?? "# Hello\n\nLive smoke test.\n");
    case "pay": return pay(Number(a));
    case "review": return review(Number(a), b ?? "approve");
    case "balance": return balance();
    default: console.log("usage: live <open-pr [path] [text] | pay <pr> | review <pr> approve|request | balance>"); process.exitCode = 1;
  }
};
run().catch((e) => { console.error(e.message ?? e); process.exit(1); });
