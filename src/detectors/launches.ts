import type { Finding, HealthSnapshot, LaunchDetail, SwarmSnapshot } from '../types.js';

const MIN = 60_000;

/** Failure text that points at IMD's own infrastructure rather than at the launch itself. */
export const INFRA_FAILURE =
  /rpc|capacity|rate.?limit|too many requests|\b429\b|\b5\d\d\b|timeout|timed out|econn|enotfound|fetch failed|network|insufficient funds|nonce|gateway/i;

export const TERMINAL_LAUNCH_STATES = new Set(['live', 'parked']);

export interface LaunchThresholds {
  launchAdmittedMinutes: number;
}

/**
 * Launch detector.
 *  - deployFailure on a launch that is not live: critical when the text looks like an
 *    infrastructure error (RPC quota, timeouts, gas), warning otherwise. A parked launch with a
 *    preflight failure (gas cap, bytecode rule) is a normal refusal and is not flagged.
 *  - a launch sitting in "admitted" longer than `launchAdmittedMinutes`.
 *  - the contradiction from 2026-10-19: an infra deploy failure while /swarm says deployerUp.
 */
export function detectLaunches(
  launches: LaunchDetail[],
  swarm: SwarmSnapshot | null,
  health: HealthSnapshot | null,
  now: number,
  t: LaunchThresholds,
): Finding[] {
  const out: Finding[] = [];
  const infraFailures: LaunchDetail[] = [];

  for (const l of launches) {
    const failure = l.deployFailure?.trim();
    const infra = !!failure && INFRA_FAILURE.test(failure);
    if (failure && l.status !== 'live' && (l.status !== 'parked' || infra)) {
      if (infra) infraFailures.push(l);
      out.push({
        key: `launch.deploy_failure:${l.id}`, scope: 'launches', severity: infra ? 'critical' : 'warning',
        title: `Launch #${l.launchNumber} deploy failed${infra ? ' (infrastructure)' : ''}`,
        detail: `Launch ${l.id} (chain ${l.chainId ?? '?'}) is "${l.status}" with deployFailure: ${failure.slice(0, 300)}`,
        data: { id: l.id, launchNumber: l.launchNumber, status: l.status, chainId: l.chainId, deployFailure: failure },
      });
    }
    if (l.status === 'admitted') {
      const since = Date.parse(l.updatedAt ?? l.createdAt ?? '');
      const mins = Number.isFinite(since) ? Math.round((now - since) / MIN) : null;
      if (mins !== null && mins >= t.launchAdmittedMinutes) {
        out.push({
          key: `launch.stuck_admitted:${l.id}`, scope: 'launches', severity: 'warning',
          title: `Launch #${l.launchNumber} stuck in "admitted" for ${mins} min`,
          detail: `Launch ${l.id} has not moved past "admitted" since ${l.updatedAt ?? l.createdAt}.` +
            (failure ? ` deployFailure: ${failure.slice(0, 200)}` : ''),
          data: { id: l.id, launchNumber: l.launchNumber, minutes: mins, deployFailure: failure ?? null },
        });
      }
    }
  }

  if (infraFailures.length && swarm?.health?.deployerUp === true) {
    out.push({
      key: 'swarm.deployer_health_mismatch', scope: 'launches', severity: 'critical',
      title: '/swarm reports deployerUp while deploys are failing',
      detail: `${infraFailures.length} launch(es) failed to deploy with an infrastructure error ` +
        `(e.g. #${infraFailures[0]!.launchNumber}: ${infraFailures[0]!.deployFailure!.slice(0, 160)}) ` +
        'but GET /swarm health.deployerUp is true. The health flag cannot be trusted right now.',
      data: { launches: infraFailures.map((l) => l.launchNumber) },
    });
  }

  if (health && health.deployBreaker !== null && health.deployBreaker !== undefined) {
    out.push({
      key: 'launch.deploy_breaker', scope: 'health', severity: 'warning',
      title: 'Deploy breaker is open',
      detail: `/health deployBreaker: ${JSON.stringify(health.deployBreaker).slice(0, 300)}`,
      data: { deployBreaker: health.deployBreaker },
    });
  }
  return out;
}
