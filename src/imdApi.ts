import type { IntakeEntry } from './intake.js';
import type { HealthSnapshot, JobSummary, LaunchDetail, LaunchSummary, SwarmSnapshot } from './types.js';

/** Read-only client for the documented public routes of the IMD control plane. */
export class ImdApi {
  constructor(private readonly base: string, private readonly timeoutMs = 20_000) {}

  private async get<T>(path: string): Promise<{ status: number; body: T }> {
    const res = await fetch(this.base + path, {
      headers: { accept: 'application/json', 'user-agent': 'imd-watchtower/0.1 (+https://getnightshift.tech)' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: 'non_json', text: text.slice(0, 200) };
    }
    return { status: res.status, body: body as T };
  }

  /** GET /intake/:chainId/:tx. Returns null on 404 unknown_transaction. */
  async intake(chainId: number, tx: string): Promise<IntakeEntry[] | null> {
    const r = await this.get<{ entries?: IntakeEntry[]; error?: string }>(`/intake/${chainId}/${tx}`);
    if (r.status === 404 || r.body.error === 'unknown_transaction') return null;
    if (r.status >= 400) throw new Error(`/intake ${r.status} ${r.body.error ?? ''}`);
    return r.body.entries ?? [];
  }

  async swarm(): Promise<SwarmSnapshot> {
    const r = await this.get<SwarmSnapshot>('/swarm');
    if (r.status >= 400) throw new Error(`/swarm ${r.status}`);
    // seats/owners/events are large and unused; drop them early
    return { at: r.body.at, health: r.body.health, counts: r.body.counts };
  }

  async health(): Promise<HealthSnapshot> {
    const r = await this.get<HealthSnapshot>('/health');
    if (r.status >= 400) throw new Error(`/health ${r.status}`);
    return r.body;
  }

  async launches(limit: number): Promise<LaunchSummary[]> {
    const r = await this.get<{ launches?: LaunchSummary[] }>(`/launches?limit=${limit}`);
    if (r.status >= 400) throw new Error(`/launches ${r.status}`);
    return r.body.launches ?? [];
  }

  async launch(id: string): Promise<LaunchDetail> {
    const r = await this.get<LaunchDetail>(`/launches/${id}`);
    if (r.status >= 400) throw new Error(`/launches/${id} ${r.status}`);
    const b = r.body;
    return {
      id: b.id, launchNumber: b.launchNumber, status: b.status, kind: b.kind, chainId: b.chainId,
      parkedReason: b.parkedReason, deployFailure: b.deployFailure, attestationFailure: b.attestationFailure,
      createdAt: b.createdAt, updatedAt: b.updatedAt,
    };
  }

  async jobs(limit: number): Promise<JobSummary[]> {
    const r = await this.get<{ jobs?: JobSummary[] }>(`/jobs?limit=${limit}&exclude=oracle`);
    if (r.status >= 400) throw new Error(`/jobs ${r.status}`);
    return (r.body.jobs ?? []).map((j) => ({
      id: j.id, state: j.state, template: j.template, objective: j.objective?.slice(0, 140),
      blockedReason: j.blockedReason, createdAt: j.createdAt, updatedAt: j.updatedAt,
    }));
  }
}
