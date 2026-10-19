import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Incident, TrackedRequest } from './types.js';

export interface Sample {
  at: number;
  head: number | null;
  pending: number;
  oldestPendingMinutes: number | null;
  blocksBehind: number | null;
  agentsOnline: number | null;
  executing: number | null;
  openIncidents: number;
}

export interface State {
  version: 1;
  /** next block to scan for Intake logs */
  cursorBlock: number | null;
  requests: Record<string, TrackedRequest>;
  incidents: Incident[];
  samples: Sample[];
  /** last snapshot shown on the status page */
  last: Record<string, unknown> | null;
}

const MAX_SAMPLES = 1440; // 24 h at one per minute
const MAX_INCIDENTS = 500;
const KEEP_PROCESSED_MS = 24 * 3600_000;

export const emptyState = (): State => ({ version: 1, cursorBlock: null, requests: {}, incidents: [], samples: [], last: null });

/** A single JSON file, written atomically (tmp + rename). Small enough for a minute-by-minute monitor. */
export class Store {
  state: State;
  constructor(private readonly file: string) {
    try {
      this.state = { ...emptyState(), ...JSON.parse(readFileSync(file, 'utf8')) };
    } catch {
      this.state = emptyState();
    }
  }

  prune(now: number) {
    const s = this.state;
    for (const [k, r] of Object.entries(s.requests)) {
      const processed = r.admittedAt !== null || ['admitted', 'completing', 'completed', 'refused', 'failed'].includes(r.state);
      if (processed && now - r.blockTime > KEEP_PROCESSED_MS) delete s.requests[k];
    }
    if (s.samples.length > MAX_SAMPLES) s.samples = s.samples.slice(-MAX_SAMPLES);
    if (s.incidents.length > MAX_INCIDENTS) {
      const open = s.incidents.filter((i) => !i.resolvedAt);
      const closed = s.incidents.filter((i) => i.resolvedAt).slice(-(MAX_INCIDENTS - open.length));
      s.incidents = [...closed, ...open];
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    renameSync(tmp, this.file);
  }
}
