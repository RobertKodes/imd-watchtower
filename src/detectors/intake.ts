import { isProcessed, type Finding, type HealthSnapshot, type Head, type TrackedRequest } from '../types.js';

export interface IntakeThresholds {
  admitWarnMinutes: number;
  admitCriticalMinutes: number;
  confirmations: number;
  healthLagBlocks: number;
}

export interface IntakeView {
  head: Head | null;
  tracked: number;
  pending: number;
  oldestPendingMinutes: number | null;
  lastAdmittedBlock: number | null;
  lastAdmittedAt: number | null;
  blocksBehind: number | null;
}

const MIN = 60_000;

/** Summary numbers for the status page; no judgement. */
export function intakeView(reqs: TrackedRequest[], head: Head | null, now: number): IntakeView {
  const processed = reqs.filter(isProcessed);
  const pending = reqs.filter((r) => !isProcessed(r));
  const lastAdmitted = processed.reduce<TrackedRequest | null>(
    (best, r) => (!best || r.blockNumber > best.blockNumber ? r : best),
    null,
  );
  const oldest = pending.reduce<number | null>((m, r) => (m === null || r.blockTime < m ? r.blockTime : m), null);
  return {
    head,
    tracked: reqs.length,
    pending: pending.length,
    oldestPendingMinutes: oldest === null ? null : Math.round((now - oldest) / MIN),
    lastAdmittedBlock: lastAdmitted?.blockNumber ?? null,
    lastAdmittedAt: processed.reduce<number | null>((m, r) => (r.admittedAt && (!m || r.admittedAt > m) ? r.admittedAt : m), null),
    blocksBehind: head && lastAdmitted && pending.length ? head.number - lastAdmitted.blockNumber : null,
  };
}

/**
 * Intake admission detector.
 *
 * A request is "late" when it has been onchain (and past the plane's confirmation depth)
 * for longer than `admitWarnMinutes` while /intake still has not admitted it, which is
 * what 404 unknown_transaction means. The incident is one aggregate per chain so that an
 * 8-hour stall is one page, not forty. It goes critical once the oldest late request passes
 * `admitCriticalMinutes`: at that point the indexer is stalled, not slow. The finding
 * carries the last admitted block and how far the chain head has moved past it.
 */
export function detectIntake(
  reqs: TrackedRequest[],
  head: Head | null,
  now: number,
  t: IntakeThresholds,
  chainId = 1,
): Finding[] {
  const findings: Finding[] = [];
  const confirmedBefore = head ? head.number - t.confirmations : Infinity;
  const late = reqs
    .filter((r) => !isProcessed(r) && r.blockNumber <= confirmedBefore && r.blockTime > 0)
    .filter((r) => now - r.blockTime >= t.admitWarnMinutes * MIN)
    .sort((a, b) => a.blockNumber - b.blockNumber);

  if (late.length) {
    const view = intakeView(reqs, head, now);
    const oldestMin = Math.round((now - late[0]!.blockTime) / MIN);
    const critical = oldestMin >= t.admitCriticalMinutes;
    const states = [...new Set(late.map((r) => r.state))].join(', ');
    findings.push({
      key: `intake.unadmitted:${chainId}`,
      scope: 'intake',
      severity: critical ? 'critical' : 'warning',
      title: critical ? `Intake stalled: ${late.length} onchain request(s) not admitted` : `Intake slow: ${late.length} request(s) waiting for admission`,
      detail:
        `${late.length} Requested event(s) on chain ${chainId} have not been admitted by the control plane ` +
        `(API state: ${states}). Oldest is ${oldestMin} min old at block ${late[0]!.blockNumber}. ` +
        (view.lastAdmittedBlock !== null && head
          ? `Last admitted request is at block ${view.lastAdmittedBlock}, ${head.number - view.lastAdmittedBlock} blocks behind head ${head.number}.`
          : 'No admitted request seen in the tracked window.'),
      data: {
        chainId,
        oldestMinutes: oldestMin,
        lastAdmittedBlock: view.lastAdmittedBlock,
        head: head?.number ?? null,
        blocksBehind: view.lastAdmittedBlock !== null && head ? head.number - view.lastAdmittedBlock : null,
        requests: late.slice(0, 25).map((r) => ({
          tx: r.txHash, logIndex: r.logIndex, block: r.blockNumber, action: r.action, state: r.state,
          ageMinutes: Math.round((now - r.blockTime) / MIN),
        })),
      },
    });
  }
  return findings;
}

/** Signals the plane reports about itself on GET /health (cursor lag, RPC reachability, low writer gas). */
export function detectHealthIntake(health: HealthSnapshot, t: IntakeThresholds, chains: number[] = [1]): Finding[] {
  const out: Finding[] = [];
  for (const c of health.intake?.chains ?? []) {
    if (!chains.includes(c.chainId)) continue;
    if (typeof c.lag === 'number' && c.lag > t.healthLagBlocks) {
      out.push({
        key: `intake.cursor_lag:${c.chainId}`, scope: 'health', severity: 'warning',
        title: `Intake cursor ${c.lag} blocks behind on chain ${c.chainId}`,
        detail: `/health reports cursor ${c.cursor} vs head ${c.head} (lag ${c.lag} > ${t.healthLagBlocks}).`,
        data: { ...c },
      });
    }
    if (c.rpc && c.rpc.reachable === false) {
      out.push({
        key: `intake.rpc_unreachable:${c.chainId}`, scope: 'health', severity: 'critical',
        title: `Plane's RPC for chain ${c.chainId} unreachable`,
        detail: `/health intake.chains[${c.chainId}].rpc.reachable is false.`,
        data: { chainId: c.chainId },
      });
    }
    if (c.writer?.low) {
      out.push({
        key: `intake.writer_low:${c.chainId}`, scope: 'health', severity: 'warning',
        title: `Intake writer gas low on chain ${c.chainId}`,
        detail: `/health reports the completion writer balance as low (${c.writer.balance ?? '?'} ETH).`,
        data: { chainId: c.chainId, balance: c.writer.balance },
      });
    }
  }
  return out;
}
