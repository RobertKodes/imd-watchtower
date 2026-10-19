import { sendAlerts } from './alerts.js';
import type { Config } from './config.js';
import { detectHealthIntake, detectIntake, intakeView } from './detectors/intake.js';
import { detectJobs } from './detectors/jobs.js';
import { detectLaunches, TERMINAL_LAUNCH_STATES } from './detectors/launches.js';
import { detectSwarm } from './detectors/swarm.js';
import { ImdApi } from './imdApi.js';
import { applyIntakeAnswer, decodeRequests, REQUESTED_TOPIC, requestKey } from './intake.js';
import { reconcile } from './incidents.js';
import { Rpc } from './rpc.js';
import type { Store } from './store.js';
import { isProcessed, type Finding, type Head, type HealthSnapshot, type LaunchDetail, type Scope, type SwarmSnapshot, type TrackedRequest } from './types.js';

/** At most this many /intake lookups per tick, to stay well inside the 120 req/min public limit. */
const MAX_INTAKE_LOOKUPS = 40;
const MAX_LAUNCH_DETAILS = 15;

export interface Deps {
  cfg: Config;
  store: Store;
  rpc?: Rpc;
  api?: ImdApi;
  log?: Pick<Console, 'log' | 'warn'>;
  alerts?: boolean;
}

export async function tick(d: Deps): Promise<void> {
  const { cfg, store } = d;
  const log = d.log ?? console;
  const rpc = d.rpc ?? new Rpc(cfg.rpcUrls, cfg.logRange);
  const api = d.api ?? new ImdApi(cfg.apiBase);
  const s = store.state;
  const now = Date.now();
  const findings: Finding[] = [];
  const ran = new Set<Scope>(['api']);
  const errors: string[] = [];
  const apiErrors: string[] = [];

  // (a) Intake: new Requested logs, then ask /intake about everything not yet admitted
  let head: Head | null = null;
  try {
    head = await rpc.head();
    const safe = head.number - cfg.confirmations;
    const from = s.cursorBlock ?? safe - cfg.startLookback;
    if (from <= safe) {
      const logs = await rpc.getLogs(cfg.intakeAddresses, from, safe, REQUESTED_TOPIC);
      for (const r of decodeRequests(logs, rpc.knownBlockTimes)) s.requests[requestKey(r)] ??= r;
      s.cursorBlock = safe + 1;
    }
    const byTx = new Map<string, TrackedRequest[]>();
    for (const r of Object.values(s.requests)) if (!isProcessed(r)) byTx.set(r.txHash, [...(byTx.get(r.txHash) ?? []), r]);
    let lookups = 0;
    let intakeOk = true;
    for (const [tx, reqs] of byTx) {
      if (lookups++ >= MAX_INTAKE_LOOKUPS) break;
      try {
        applyIntakeAnswer(reqs, await api.intake(cfg.chainId, tx), now);
      } catch (e) {
        intakeOk = false;
        apiErrors.push(`/intake: ${(e as Error).message}`);
      }
    }
    findings.push(...detectIntake(Object.values(s.requests), head, now, cfg, cfg.chainId));
    if (intakeOk) ran.add('intake');
  } catch (e) {
    errors.push(`rpc: ${(e as Error).message.split('\n')[0]}`);
  }

  // /health: the plane's own view of its intake cursor
  let health: HealthSnapshot | null = null;
  try {
    health = await api.health();
    findings.push(...detectHealthIntake(health, cfg, [cfg.chainId]));
    ran.add('health');
  } catch (e) {
    apiErrors.push(`/health: ${(e as Error).message}`);
  }

  // (b) swarm health, launches, jobs
  let swarm: SwarmSnapshot | null = null;
  try {
    swarm = await api.swarm();
    findings.push(...detectSwarm(swarm));
    ran.add('swarm');
  } catch (e) {
    apiErrors.push(`/swarm: ${(e as Error).message}`);
  }

  let launchDetails: LaunchDetail[] = [];
  const launchCounts: Record<string, number> = {};
  try {
    const list = await api.launches(cfg.launchesLimit);
    for (const l of list) launchCounts[l.status] = (launchCounts[l.status] ?? 0) + 1;
    const open = list.filter((l) => !TERMINAL_LAUNCH_STATES.has(l.status)).slice(0, MAX_LAUNCH_DETAILS);
    launchDetails = await Promise.all(open.map((l) => api.launch(l.id)));
    findings.push(...detectLaunches(launchDetails, swarm, health, now, cfg));
    ran.add('launches');
  } catch (e) {
    apiErrors.push(`/launches: ${(e as Error).message}`);
  }

  let executing: number | null = null;
  try {
    const jobs = await api.jobs(cfg.jobsLimit);
    executing = jobs.filter((j) => j.state === 'executing').length;
    findings.push(...detectJobs(jobs, now, cfg));
    ran.add('jobs');
  } catch (e) {
    apiErrors.push(`/jobs: ${(e as Error).message}`);
  }

  if (apiErrors.length >= 3) {
    findings.push({
      key: 'api.unreachable', scope: 'api', severity: 'critical', title: 'IMD API unreachable',
      detail: apiErrors.join('; '),
    });
  }

  const events = reconcile(s.incidents, findings, ran, now);
  for (const e of events) log.log(`${new Date(now).toISOString()} ${e.type.toUpperCase()} [${e.incident.severity}] ${e.incident.title}`);
  if (d.alerts !== false) await sendAlerts(cfg, events, log as Console);

  const view = intakeView(Object.values(s.requests), head, now);
  const open = s.incidents.filter((i) => !i.resolvedAt);
  s.samples.push({
    at: now, head: head?.number ?? null, pending: view.pending, oldestPendingMinutes: view.oldestPendingMinutes,
    blocksBehind: view.blocksBehind, agentsOnline: swarm?.health?.agentsOnline ?? null, executing, openIncidents: open.length,
  });
  const ethHealth = health?.intake?.chains?.find((c) => c.chainId === cfg.chainId);
  s.last = {
    checkedAt: new Date(now).toISOString(),
    intake: { ...view, chainId: cfg.chainId, address: cfg.intakeAddresses[0], cursorBlock: s.cursorBlock, planeCursor: ethHealth?.cursor ?? null, planeLag: ethHealth?.lag ?? null },
    swarm: swarm ? { health: swarm.health, jobStates: swarm.counts?.jobStates ?? null, launchesLive: swarm.counts?.launchesLive ?? null } : null,
    launches: { counts: launchCounts, open: launchDetails.map((l) => ({ launchNumber: l.launchNumber, id: l.id, status: l.status, chainId: l.chainId, deployFailure: l.deployFailure ?? null, updatedAt: l.updatedAt })) },
    jobs: { executing },
    errors: [...errors, ...apiErrors],
  };
  store.prune(now);
  store.save();
}

export function overall(store: Store): 'ok' | 'degraded' | 'down' {
  const open = store.state.incidents.filter((i) => !i.resolvedAt && i.source === 'live');
  if (open.some((i) => i.severity === 'critical')) return 'down';
  if (open.some((i) => i.severity === 'warning')) return 'degraded';
  return 'ok';
}
