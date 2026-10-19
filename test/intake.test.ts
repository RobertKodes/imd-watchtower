import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { replay } from '../src/backfill.js';
import { detectHealthIntake, detectIntake } from '../src/detectors/intake.js';
import { applyIntakeAnswer, decodeActionId, decodeRequests, type RawLog } from '../src/intake.js';
import type { TrackedRequest } from '../src/types.js';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const MIN = 60_000;
const cfg = { admitWarnMinutes: 10, admitCriticalMinutes: 30, confirmations: 3, healthLagBlocks: 50, chainId: 1 };

/** The six Requested events of the 2026-10-19 stall window, with today's /intake answers applied. */
function stallRequests(): TrackedRequest[] {
  const logs: RawLog[] = fx('intake-logs-26224624-26225706.json').logs;
  const reqs = decodeRequests(logs, new Map());
  const answers = fx('intake-answers.json');
  for (const tx of new Set(reqs.map((r) => r.txHash))) {
    applyIntakeAnswer(reqs.filter((r) => r.txHash === tx), answers[tx].entries, Date.parse('2026-10-19T20:00:00Z'));
  }
  return reqs;
}

describe('Intake event decoding', () => {
  it('decodes the recorded Requested logs and skips FailureHookSet/Completed', () => {
    const logs: RawLog[] = fx('intake-logs-26224624-26225706.json').logs;
    const reqs = decodeRequests(logs, new Map());
    expect(logs.length).toBeGreaterThan(reqs.length);
    expect(reqs).toHaveLength(6);
    expect(reqs.map((r) => r.action)).toEqual([
      'oracle.request', 'oracle.request', 'launch.open', 'launch.open', 'oracle.request', 'oracle.request',
    ]);
    const launch = reqs.find((r) => r.txHash.startsWith('0xb34adaeb'))!;
    expect(launch.blockNumber).toBe(26225162);
    expect(launch.payer).toBe('0x6c4c78f2c3bdf4c4318fe305fb1c8bc1694d19b5');
    expect(launch.requestId).toBe('0x294af0aefcc04e32bd8585fc18c21eb0aba75f19c89c10ef76938b05bd7cc67b');
    expect(new Date(launch.blockTime).toISOString()).toBe('2026-10-19T07:34:59.000Z');
  });

  it('reads the action id', () => {
    expect(decodeActionId('0x6c61756e63682e6f70656e406c61756e63682d31000000000000000000000000')).toEqual({ action: 'launch.open', version: 'launch-1' });
  });

  it('maps a 404 unknown_transaction to state "unknown" and an admitted entry to its admission time', () => {
    const unknown = fx('intake-unknown.json');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('unknown_transaction');
    const reqs = stallRequests();
    const r = reqs.find((x) => x.txHash.startsWith('0xb34adaeb'))!;
    expect(r.state).toBe('completed');
    expect(new Date(r.admittedAt!).toISOString()).toBe('2026-10-19T13:35:01.290Z');
    applyIntakeAnswer([r], null, 0);
    expect(r.state).toBe('unknown');
  });
});

describe('detectIntake', () => {
  const head = { number: 26226000, time: Date.parse('2026-10-19T10:30:00Z') };

  it('reports the 2026-10-19 stall as critical while /intake answered unknown_transaction', () => {
    // How the window looked at 10:30Z: the two oracle requests at 26224624 admitted, the rest unknown.
    const now = head.time;
    const reqs = stallRequests().map((r) => (r.admittedAt! <= now ? r : { ...r, state: 'unknown', admittedAt: null }));
    const [f] = detectIntake(reqs, head, now, cfg);
    expect(f).toBeDefined();
    expect(f!.severity).toBe('critical');
    expect(f!.key).toBe('intake.unadmitted:1');
    expect(f!.data!.lastAdmittedBlock).toBe(26224624);
    expect(f!.data!.blocksBehind).toBe(26226000 - 26224624);
    expect((f!.data!.requests as unknown[]).length).toBe(4);
    expect(f!.data!.oldestMinutes).toBe(175); // 07:34:59 -> 10:30
  });

  it('is quiet once everything is admitted', () => {
    expect(detectIntake(stallRequests(), head, head.time, cfg)).toEqual([]);
  });

  it('warns before it goes critical, and ignores requests still inside the confirmation depth', () => {
    const base = stallRequests()[2]!;
    const r = { ...base, state: 'unknown', admittedAt: null };
    const at = (mins: number) => base.blockTime + mins * MIN;
    expect(detectIntake([r], { number: r.blockNumber + 100, time: at(5) }, at(5), cfg)).toEqual([]);
    expect(detectIntake([r], { number: r.blockNumber + 100, time: at(12) }, at(12), cfg)[0]!.severity).toBe('warning');
    expect(detectIntake([r], { number: r.blockNumber + 200, time: at(31) }, at(31), cfg)[0]!.severity).toBe('critical');
    expect(detectIntake([r], { number: r.blockNumber + 2, time: at(31) }, at(31), cfg)).toEqual([]);
  });

  it('flags /health cursor lag and unreachable RPCs, and not the recorded healthy snapshot', () => {
    const h = fx('health-2026-10-19.json');
    expect(detectHealthIntake(h, cfg, [1])).toEqual([]);
    // the same recorded snapshot had Robinhood Chain's cursor 83 blocks behind
    expect(detectHealthIntake(h, cfg, [4663]).map((f) => f.key)).toEqual(['intake.cursor_lag:4663']);
    const eth = h.intake.chains.find((c: { chainId: number }) => c.chainId === 1);
    expect(detectHealthIntake({ intake: { chains: [{ ...eth, lag: 0 }] } }, cfg)).toEqual([]);
    const bad = { intake: { chains: [{ ...eth, cursor: eth.head - 400, lag: 400, rpc: { reachable: false } }] } };
    expect(detectHealthIntake(bad, cfg).map((f) => f.key)).toEqual(['intake.cursor_lag:1', 'intake.rpc_unreachable:1']);
  });
});

describe('backfill replay of blocks 26224624-26225706', () => {
  it('opens, escalates and resolves exactly one stall incident', () => {
    const reqs = stallRequests();
    const points = reqs.map((r) => [r.blockNumber, r.blockTime] as [number, number]);
    const { events, incidents } = replay(reqs, points, cfg);
    expect(events.map((e) => `${e.type}:${e.severity}`)).toEqual(['opened:warning', 'escalated:critical', 'resolved:critical']);
    expect(events[0]!.at).toBe('2026-10-19T07:44:59.000Z'); // 10 min after block 26225162
    expect(events[1]!.at).toBe('2026-10-19T08:04:59.000Z'); // 30 min after
    expect(Date.parse(events[2]!.at)).toBeGreaterThanOrEqual(Date.parse('2026-10-19T13:35:08Z'));
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.source).toBe('backfill');
  });
});
