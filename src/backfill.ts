import type { Config } from './config.js';
import { detectIntake } from './detectors/intake.js';
import { ImdApi } from './imdApi.js';
import { applyIntakeAnswer, decodeRequests, REQUESTED_TOPIC } from './intake.js';
import { reconcile } from './incidents.js';
import { Rpc } from './rpc.js';
import { isProcessed, type Head, type Incident, type IncidentEvent, type TrackedRequest } from './types.js';

export interface BackfillResult {
  fromBlock: number;
  toBlock: number;
  requests: TrackedRequest[];
  events: { at: string; type: IncidentEvent['type']; severity: string; title: string; detail: string }[];
  incidents: Incident[];
}

/** Head block at time t, interpolated between known (block, time) points; 12 s/block outside them. */
export function headAt(points: [number, number][], t: number): Head {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  if (t <= p[0]![1]) return { number: p[0]![0], time: p[0]![1] };
  for (let i = 1; i < p.length; i++) {
    const [b0, t0] = p[i - 1]!;
    const [b1, t1] = p[i]!;
    if (t <= t1) return { number: b0 + Math.floor(((t - t0) / (t1 - t0 || 1)) * (b1 - b0)), time: t };
  }
  const [bl, tl] = p[p.length - 1]!;
  return { number: bl + Math.floor((t - tl) / 12_000), time: t };
}

/**
 * Replay a block range minute by minute with the same detector the live service runs.
 * Each request's admission time comes from /intake's `admission.createdAt`, so the replay
 * reconstructs what /intake would have answered at every minute (404 before admission).
 * Pure apart from the inputs: `requests` must already carry blockTime and admittedAt.
 */
export function replay(
  requests: TrackedRequest[],
  points: [number, number][],
  cfg: Pick<Config, 'admitWarnMinutes' | 'admitCriticalMinutes' | 'confirmations' | 'healthLagBlocks' | 'chainId'>,
  stepMs = 60_000,
): { events: BackfillResult['events']; incidents: Incident[] } {
  const incidents: Incident[] = [];
  const events: BackfillResult['events'] = [];
  if (!requests.length) return { events, incidents };
  const start = Math.min(...requests.map((r) => r.blockTime));
  const lastAdmit = Math.max(...requests.map((r) => r.admittedAt ?? r.blockTime));
  const end = Math.max(lastAdmit, ...requests.map((r) => r.blockTime)) + 2 * stepMs;
  for (let t = start; t <= end; t += stepMs) {
    const head = headAt(points, t);
    const visible = requests
      .filter((r) => r.blockTime <= t)
      .map((r) => {
        // refused/failed entries carry no admission time: count them as picked up immediately
        const processedByNow = r.admittedAt !== null ? r.admittedAt <= t : isProcessed(r);
        return { ...r, state: processedByNow ? r.state : 'unknown', admittedAt: processedByNow ? r.admittedAt : null };
      });
    const findings = detectIntake(visible, head, t, cfg, cfg.chainId);
    for (const e of reconcile(incidents, findings, new Set(['intake']), t, 'backfill')) {
      events.push({ at: new Date(t).toISOString(), type: e.type, severity: e.incident.severity, title: e.incident.title, detail: e.incident.detail });
    }
  }
  return { events, incidents };
}

export async function backfill(cfg: Config, fromBlock: number, toBlock: number, log = console): Promise<BackfillResult> {
  const rpc = new Rpc(cfg.rpcUrls, cfg.logRange);
  const api = new ImdApi(cfg.apiBase);
  log.log(`scanning Intake ${cfg.intakeAddresses.join(',')} blocks ${fromBlock}-${toBlock} ...`);
  const logs = await rpc.getLogs(cfg.intakeAddresses, fromBlock, toBlock, REQUESTED_TOPIC);
  const requests = decodeRequests(logs, rpc.knownBlockTimes);
  log.log(`${requests.length} Requested event(s) in ${new Set(requests.map((r) => r.txHash)).size} transaction(s)`);
  const byTx = new Map<string, TrackedRequest[]>();
  for (const r of requests) byTx.set(r.txHash, [...(byTx.get(r.txHash) ?? []), r]);
  const now = Date.now();
  for (const [tx, reqs] of byTx) applyIntakeAnswer(reqs, await api.intake(cfg.chainId, tx), now);
  const points: [number, number][] = [
    [fromBlock, await rpc.blockTime(fromBlock)],
    [toBlock, await rpc.blockTime(toBlock)],
    ...requests.map((r) => [r.blockNumber, r.blockTime] as [number, number]),
  ];
  const { events, incidents } = replay(requests, points, cfg);
  return { fromBlock, toBlock, requests, events, incidents };
}

const fmt = (ms: number | null) => (ms === null ? '-' : new Date(ms).toISOString().replace('.000Z', 'Z').replace(/\.\d+Z$/, 'Z'));
const dur = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};

export function formatReport(r: BackfillResult, now = Date.now()): string {
  const lines: string[] = [];
  lines.push(`Backfill blocks ${r.fromBlock}-${r.toBlock}: ${r.requests.length} Intake request(s)`);
  lines.push('');
  lines.push('block     tx          action           onchain (UTC)         admitted (UTC)        lag      state now');
  for (const q of r.requests) {
    const lag = q.admittedAt !== null ? dur(q.admittedAt - q.blockTime) : `${dur(now - q.blockTime)}+ (not admitted)`;
    lines.push(
      `${q.blockNumber}  ${q.txHash.slice(0, 10)}  ${q.action.padEnd(15)}  ${fmt(q.blockTime).padEnd(20)}  ${fmt(q.admittedAt).padEnd(20)}  ${lag.padEnd(7)}  ${q.state}`,
    );
  }
  lines.push('');
  lines.push(`Replayed minute by minute with the live detector: ${r.events.length} event(s)`);
  for (const e of r.events) lines.push(`${e.at.replace('.000Z', 'Z')}  ${e.type.toUpperCase().padEnd(9)} [${e.severity}] ${e.title}`);
  const longest = r.incidents.reduce<Incident | null>((b, i) => {
    const d = Date.parse(i.resolvedAt ?? new Date(now).toISOString()) - Date.parse(i.openedAt);
    return !b || d > Date.parse(b.resolvedAt ?? new Date(now).toISOString()) - Date.parse(b.openedAt) ? i : b;
  }, null);
  if (longest) {
    lines.push('');
    lines.push(`Longest incident: "${longest.title}" open ${dur(Date.parse(longest.resolvedAt ?? new Date(now).toISOString()) - Date.parse(longest.openedAt))} ` +
      `(${longest.openedAt} -> ${longest.resolvedAt ?? 'still open'})`);
    lines.push(`Last detail: ${longest.detail}`);
  }
  return lines.join('\n');
}
