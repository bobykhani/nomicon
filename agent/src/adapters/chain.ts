import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { ChainPort, FinalizedBlock } from "../ports.js";

export const USDC = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
} as const;

export class BaseChainAdapter implements ChainPort {
  private pub;
  private wallet;
  constructor(network: "eip155:8453" | "eip155:84532", rpcUrl: string, anchorPrivateKey?: Hex) {
    const chain = network === "eip155:8453" ? base : baseSepolia;
    this.pub = createPublicClient({ chain, transport: http(rpcUrl) });
    this.wallet = anchorPrivateKey ? createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(anchorPrivateKey) }) : null;
  }

  async firstFinalizedBlockAfter(ts: number): Promise<FinalizedBlock | null> {
    const latest = await this.pub.getBlock({ blockTag: "finalized" });
    if (Number(latest.timestamp) <= ts) return null;
    // Binary search for the lowest block number with timestamp > ts.
    let lo = 0n, hi = latest.number;
    // Tighten the lower bound: Base blocks are ~2s, so start a safe distance back.
    const guess = latest.number - BigInt(Math.ceil((Number(latest.timestamp) - ts) / 2) + 500);
    if (guess > 0n) {
      const g = await this.pub.getBlock({ blockNumber: guess });
      if (Number(g.timestamp) <= ts) lo = guess;
    }
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const b = await this.pub.getBlock({ blockNumber: mid });
      if (Number(b.timestamp) > ts) hi = mid; else lo = mid + 1n;
    }
    const b = await this.pub.getBlock({ blockNumber: hi });
    return { number: b.number, hash: b.hash, timestamp: Number(b.timestamp) };
  }

  async transactionInfo(txHash: string): Promise<{ blockNumber: bigint; blockTime: number } | null> {
    try {
      const r = await this.pub.getTransactionReceipt({ hash: txHash as Hex });
      if (r.status !== "success") return null;
      const b = await this.pub.getBlock({ blockNumber: r.blockNumber });
      return { blockNumber: r.blockNumber, blockTime: Number(b.timestamp) };
    } catch {
      return null;
    }
  }

  async anchor(hashHex: string): Promise<string> {
    if (!this.wallet) throw new Error("no anchor key configured");
    const data = ("0x" + hashHex.replace(/^0x/, "")) as Hex;
    return this.wallet.sendTransaction({ to: this.wallet.account.address, value: 0n, data });
  }
}
