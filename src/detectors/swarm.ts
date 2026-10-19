import type { Finding, SwarmSnapshot } from '../types.js';

/** Health flags the plane publishes on GET /swarm. */
export function detectSwarm(s: SwarmSnapshot): Finding[] {
  const h = s.health ?? {};
  const out: Finding[] = [];
  if (h.reachable === false) {
    out.push({ key: 'swarm.unreachable', scope: 'swarm', severity: 'critical', title: '/swarm reports the plane unreachable', detail: 'health.reachable is false.' });
  }
  for (const svc of ['verifierUp', 'publisherUp', 'deployerUp'] as const) {
    if (h[svc] === false) {
      out.push({
        key: `swarm.${svc}`, scope: 'swarm', severity: 'critical',
        title: `${svc.replace('Up', '')} is down`, detail: `/swarm health.${svc} is false.`,
      });
    }
  }
  if (typeof h.agentsOnline === 'number' && typeof h.seatsEnrolled === 'number' && h.seatsEnrolled > 0) {
    const share = h.agentsOnline / h.seatsEnrolled;
    if (share < 0.25) {
      out.push({
        key: 'swarm.agents_low', scope: 'swarm', severity: 'warning',
        title: `Only ${h.agentsOnline} of ${h.seatsEnrolled} seats online`,
        detail: `${Math.round(share * 100)}% of enrolled seats are online.`,
        data: { agentsOnline: h.agentsOnline, seatsEnrolled: h.seatsEnrolled },
      });
    }
  }
  return out;
}
