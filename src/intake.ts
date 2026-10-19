import { decodeEventLog, hexToString, parseAbi, type Hex } from 'viem';
import type { TrackedRequest } from './types.js';

/**
 * The Intake v2 `Requested` event. The docs describe its fields but not the exact
 * signature; this one was recovered from mainnet logs and its keccak-256 matches
 * topic0 0x1c521a43c9b0f72a335bc80a6918abce08af7949ebbd1c41fe2a576074379063.
 */
export const INTAKE_ABI = parseAbi([
  'event Requested(bytes32 indexed requestId, address indexed payer, bytes32 indexed action, bytes body, address callbackTarget, bytes4 callbackSelector, address asset, uint256 amount)',
  'event FailureHookSet(bytes32 indexed requestId, bytes4 onFailure)',
  'event Completed(bytes32 indexed requestId, uint8 status, bytes32 resultHash, string uri, bool delivered)',
]);

export const REQUESTED_TOPIC = '0x1c521a43c9b0f72a335bc80a6918abce08af7949ebbd1c41fe2a576074379063' as const;

export interface RawLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: string | bigint | number;
  transactionHash: Hex;
  logIndex: string | number | bigint;
  blockTimestamp?: string | number | bigint;
}

const toNum = (v: string | number | bigint) => (typeof v === 'string' ? Number(BigInt(v)) : Number(v));

/** "launch.open@launch-1" padded to 32 bytes -> { action: "launch.open", version: "launch-1" } */
export function decodeActionId(action: Hex): { action: string; version: string } {
  const s = hexToString(action, { size: 32 }).replace(/\0+$/, '');
  const [a, v] = s.split('@');
  return { action: a ?? s, version: v ?? '' };
}

/** Decode the `Requested` logs from a getLogs result; other Intake events are skipped. */
export function decodeRequests(logs: RawLog[], blockTimes: Map<number, number>): TrackedRequest[] {
  const out: TrackedRequest[] = [];
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== REQUESTED_TOPIC) continue;
    const ev = decodeEventLog({ abi: INTAKE_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    if (ev.eventName !== 'Requested') continue;
    const blockNumber = toNum(log.blockNumber);
    const ts = log.blockTimestamp !== undefined ? toNum(log.blockTimestamp) * 1000 : blockTimes.get(blockNumber);
    out.push({
      txHash: log.transactionHash.toLowerCase() as Hex,
      logIndex: toNum(log.logIndex),
      blockNumber,
      blockTime: ts ?? 0,
      requestId: ev.args.requestId,
      action: decodeActionId(ev.args.action).action,
      payer: ev.args.payer.toLowerCase() as Hex,
      state: 'unknown',
      admittedAt: null,
      lastCheckedAt: null,
    });
  }
  return out;
}

export const requestKey = (r: Pick<TrackedRequest, 'txHash' | 'logIndex'>) => `${r.txHash}:${r.logIndex}`;

/** One entry of GET /intake/:chainId/:tx. */
export interface IntakeEntry {
  logIndex: number;
  blockNumber: number;
  state: string;
  admission?: { createdAt?: string } | null;
}

/**
 * Apply an /intake answer to the tracked requests of that transaction.
 * `entries === null` means the API answered 404 unknown_transaction.
 */
export function applyIntakeAnswer(reqs: TrackedRequest[], entries: IntakeEntry[] | null, now: number): void {
  for (const r of reqs) {
    r.lastCheckedAt = now;
    if (entries === null) {
      r.state = 'unknown';
      continue;
    }
    const e = entries.find((x) => x.logIndex === r.logIndex) ?? (entries.length === 1 ? entries[0] : undefined);
    if (!e) continue;
    r.state = e.state;
    const at = e.admission?.createdAt ? Date.parse(e.admission.createdAt) : NaN;
    r.admittedAt = Number.isFinite(at) ? at : r.admittedAt;
  }
}
