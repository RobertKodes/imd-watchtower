import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectJobs } from '../src/detectors/jobs.js';
import { detectLaunches } from '../src/detectors/launches.js';
import { detectSwarm } from '../src/detectors/swarm.js';
import { reconcile } from '../src/incidents.js';
import type { Incident } from '../src/types.js';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const t = { launchAdmittedMinutes: 45 };

describe('detectLaunches', () => {
  const swarm = fx('swarm-2026-10-19.json'); // recorded: deployerUp true
  const incident = fx('launch-rpc-capacity-incident.json');

  it('catches the RPC capacity deploy failure and the deployerUp contradiction', () => {
    expect(swarm.health.deployerUp).toBe(true);
    const now = Date.parse('2026-10-19T12:10:00Z');
    const f = detectLaunches([incident], swarm, null, now, t);
    expect(f.map((x) => `${x.key}:${x.severity}`)).toEqual([
      `launch.deploy_failure:${incident.id}:critical`,
      'swarm.deployer_health_mismatch:critical',
    ]);
    expect(f[0]!.detail).toContain('Monthly capacity limit exceeded');
  });

  it('adds stuck-in-admitted once the launch has not moved for the threshold', () => {
    const now = Date.parse('2026-10-19T13:00:00Z'); // 55 min after updatedAt
    const keys = detectLaunches([incident], swarm, null, now, t).map((x) => x.key);
    expect(keys).toContain(`launch.stuck_admitted:${incident.id}`);
  });

  it('does not flag a normal preflight refusal or a live launch (recorded)', () => {
    const parked = fx('launch-2179-parked-preflight.json');
    const live = fx('launch-2235-live.json');
    expect(parked.deployFailure).toMatch(/preflight failed/);
    expect(detectLaunches([parked, live], swarm, null, Date.parse('2026-10-19T20:00:00Z'), t)).toEqual([]);
  });

  it('reports an open deploy breaker from /health', () => {
    const f = detectLaunches([], swarm, { deployBreaker: { reason: 'x' } }, Date.now(), t);
    expect(f.map((x) => x.key)).toEqual(['launch.deploy_breaker']);
    expect(detectLaunches([], swarm, fx('health-2026-10-19.json'), Date.now(), t)).toEqual([]);
  });
});

describe('detectJobs', () => {
  const rec = fx('jobs-2026-10-19.json');
  const recordedAt = Date.parse(rec.recordedAt);
  const cfg = { jobStaleMinutes: 120, jobMaxMinutes: 720 };

  it('is quiet on the recorded job list', () => {
    expect(rec.jobs.some((j: { state: string }) => j.state === 'executing')).toBe(true);
    expect(detectJobs(rec.jobs, recordedAt, cfg)).toEqual([]);
  });

  it('flags the same executing jobs once they sit idle past the threshold', () => {
    const later = recordedAt + 3 * 3600_000;
    const [f] = detectJobs(rec.jobs, later, cfg);
    const executing = rec.jobs.filter((j: { state: string }) => j.state === 'executing').length;
    expect(f!.key).toBe('jobs.stuck_executing');
    expect((f!.data!.jobs as unknown[]).length).toBe(executing);
  });
});

describe('detectSwarm', () => {
  it('is quiet on the recorded snapshot and critical when a service flag drops', () => {
    const s = fx('swarm-2026-10-19.json');
    expect(detectSwarm(s)).toEqual([]);
    const down = detectSwarm({ ...s, health: { ...s.health, verifierUp: false, reachable: false } });
    expect(down.map((f) => f.key)).toEqual(['swarm.unreachable', 'swarm.verifierUp']);
  });
});

describe('reconcile', () => {
  const f = { key: 'k', scope: 'swarm' as const, severity: 'warning' as const, title: 'a', detail: 'b' };

  it('opens, escalates, keeps, then resolves', () => {
    const inc: Incident[] = [];
    expect(reconcile(inc, [f], new Set(['swarm']), 0).map((e) => e.type)).toEqual(['opened']);
    expect(reconcile(inc, [f], new Set(['swarm']), 1)).toEqual([]);
    expect(reconcile(inc, [{ ...f, severity: 'critical' }], new Set(['swarm']), 2).map((e) => e.type)).toEqual(['escalated']);
    expect(reconcile(inc, [], new Set(['swarm']), 3).map((e) => e.type)).toEqual(['resolved']);
    expect(inc[0]!.resolvedAt).toBe(new Date(3).toISOString());
  });

  it('never resolves an incident whose detector did not run (failed fetch)', () => {
    const inc: Incident[] = [];
    reconcile(inc, [f], new Set(['swarm']), 0);
    expect(reconcile(inc, [], new Set(['intake']), 1)).toEqual([]);
    expect(inc[0]!.resolvedAt).toBeNull();
  });
});
