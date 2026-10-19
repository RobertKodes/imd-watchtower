import type { Finding, JobSummary } from '../types.js';

const MIN = 60_000;

export interface JobThresholds {
  jobStaleMinutes: number;
  jobMaxMinutes: number;
}

/** Jobs in "executing" that have not moved for `jobStaleMinutes`, or ran longer than `jobMaxMinutes`. */
export function detectJobs(jobs: JobSummary[], now: number, t: JobThresholds): Finding[] {
  const stuck = jobs
    .filter((j) => j.state === 'executing')
    .map((j) => ({
      j,
      idle: Math.round((now - Date.parse(j.updatedAt)) / MIN),
      total: Math.round((now - Date.parse(j.createdAt)) / MIN),
    }))
    .filter((x) => x.idle >= t.jobStaleMinutes || x.total >= t.jobMaxMinutes)
    .sort((a, b) => b.idle - a.idle);
  if (!stuck.length) return [];
  return [
    {
      key: 'jobs.stuck_executing', scope: 'jobs', severity: 'warning',
      title: `${stuck.length} job(s) stuck executing`,
      detail: stuck
        .slice(0, 5)
        .map((x) => `${x.j.id.slice(0, 8)} idle ${x.idle} min, running ${x.total} min (${x.j.template ?? '?'})`)
        .join('; '),
      data: {
        jobs: stuck.slice(0, 25).map((x) => ({ id: x.j.id, template: x.j.template, idleMinutes: x.idle, totalMinutes: x.total, objective: x.j.objective })),
      },
    },
  ];
}
