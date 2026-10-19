import { createPublicClient, fallback, http, numberToHex, type Hex, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import type { RawLog } from './intake.js';
import type { Head } from './types.js';

/**
 * A read-only Ethereum client over several free RPCs. viem's `fallback` transport moves
 * to the next URL when one errors or times out (publicnode, for example, blocks some IPs).
 */
export class Rpc {
  readonly client: PublicClient;
  private blockTimes = new Map<number, number>();

  constructor(urls: string[], private readonly maxRange: number) {
    this.client = createPublicClient({
      chain: mainnet,
      transport: fallback(
        urls.map((u) => http(u, { timeout: 20_000, retryCount: 1 })),
        { retryCount: 2 },
      ),
    }) as PublicClient;
  }

  async head(): Promise<Head> {
    const b = await this.client.getBlock({ blockTag: 'latest' });
    return { number: Number(b.number), time: Number(b.timestamp) * 1000 };
  }

  async blockTime(n: number): Promise<number> {
    const hit = this.blockTimes.get(n);
    if (hit) return hit;
    const b = await this.client.getBlock({ blockNumber: BigInt(n) });
    const t = Number(b.timestamp) * 1000;
    this.blockTimes.set(n, t);
    return t;
  }

  get knownBlockTimes() {
    return this.blockTimes;
  }

  /** eth_getLogs in chunks of at most `maxRange` blocks, inclusive bounds. */
  async getLogs(addresses: string[], fromBlock: number, toBlock: number, topic0?: Hex): Promise<RawLog[]> {
    const out: RawLog[] = [];
    for (let start = fromBlock; start <= toBlock; start += this.maxRange) {
      const end = Math.min(toBlock, start + this.maxRange - 1);
      const logs = (await this.client.request({
        method: 'eth_getLogs',
        params: [
          {
            address: addresses as Hex[],
            fromBlock: numberToHex(start),
            toBlock: numberToHex(end),
            ...(topic0 ? { topics: [topic0] } : {}),
          },
        ],
      })) as unknown as RawLog[];
      out.push(...logs);
    }
    // Fill in block timestamps (some RPCs include blockTimestamp in logs, others do not).
    for (const l of out) {
      const n = Number(BigInt(l.blockNumber));
      if (l.blockTimestamp !== undefined) this.blockTimes.set(n, Number(BigInt(l.blockTimestamp)) * 1000);
      else await this.blockTime(n);
    }
    return out;
  }
}
