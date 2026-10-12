import { createPublicClient, createWalletClient, decodeEventLog, erc20Abi, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { ChainPort } from "../ports.js";

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

  /** Sender, data and block time of a settled transaction, for a key announcement from the fee destination (Article 11). */
  async transactionDetails(txHash: string): Promise<{ from: string; input: string; blockTime: number } | null> {
    try {
      const [tx, r] = await Promise.all([this.pub.getTransaction({ hash: txHash as Hex }), this.pub.getTransactionReceipt({ hash: txHash as Hex })]);
      if (r.status !== "success") return null;
      const b = await this.pub.getBlock({ blockNumber: r.blockNumber });
      return { from: tx.from, input: tx.input, blockTime: Number(b.timestamp) };
    } catch { return null; }
  }

  /** The USDC transfer a settled transaction made, for recording a payment by hand (`nomicon record-payment`). */
  async usdcTransfer(txHash: string, token: string): Promise<{ from: string; to: string; amountMicro: bigint; blockNumber: bigint; blockTime: number } | null> {
    try {
      const r = await this.pub.getTransactionReceipt({ hash: txHash as Hex });
      if (r.status !== "success") return null;
      for (const log of r.logs) {
        if (log.address.toLowerCase() !== token.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
          if (ev.eventName !== "Transfer") continue;
          const a = ev.args as { from: Hex; to: Hex; value: bigint };
          const b = await this.pub.getBlock({ blockNumber: r.blockNumber });
          return { from: a.from, to: a.to, amountMicro: a.value, blockNumber: r.blockNumber, blockTime: Number(b.timestamp) };
        } catch { continue; }
      }
      return null;
    } catch { return null; }
  }

  async anchor(hashHex: string): Promise<string> {
    if (!this.wallet) throw new Error("no anchor key configured");
    const data = ("0x" + hashHex.replace(/^0x/, "")) as Hex;
    return this.wallet.sendTransaction({ to: this.wallet.account.address, value: 0n, data });
  }
}
