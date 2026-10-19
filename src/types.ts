export type Severity = 'info' | 'warning' | 'critical';

/** What a detector reports for one tick. A finding with the same key across ticks is one incident. */
export interface Finding {
  key: string;
  scope: Scope;
  severity: Severity;
  title: string;
  detail: string;
  data?: Record<string, unknown>;
}

export type Scope = 'intake' | 'health' | 'swarm' | 'launches' | 'jobs' | 'api';

export interface Incident {
  id: string;
  key: string;
  scope: Scope;
  severity: Severity;
  title: string;
  detail: string;
  data?: Record<string, unknown>;
  openedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  source: 'live' | 'backfill';
}

export type IncidentEvent = { type: 'opened' | 'escalated' | 'resolved'; incident: Incident };

/** One Intake `Requested` event and what the IMD API says about it. */
export interface TrackedRequest {
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: number;
  /** block timestamp, ms */
  blockTime: number;
  requestId: `0x${string}`;
  action: string;
  payer: `0x${string}`;
  /** API state: 'unknown' while /intake answers unknown_transaction */
  state: string;
  /** admission.createdAt from /intake, ms */
  admittedAt: number | null;
  lastCheckedAt: number | null;
}

/** States after which the control plane has picked the request up. */
export const PROCESSED_STATES = new Set(['admitted', 'completing', 'completed', 'refused', 'failed']);

export function isProcessed(r: TrackedRequest): boolean {
  return PROCESSED_STATES.has(r.state) || r.admittedAt !== null;
}

export interface Head {
  number: number;
  /** ms */
  time: number;
}

/** Subset of GET /swarm we rely on. */
export interface SwarmHealth {
  reachable?: boolean;
  agentsOnline?: number;
  seatsEnrolled?: number;
  workingNow?: number;
  pendingVerification?: number;
  pendingDeployment?: number;
  pendingSites?: number;
  verifierUp?: boolean;
  publisherUp?: boolean;
  deployerUp?: boolean;
}

export interface SwarmSnapshot {
  at?: number;
  health?: SwarmHealth;
  counts?: { jobs?: number; jobStates?: Record<string, number>; launchesLive?: number };
}

/** Subset of GET /health intake section. */
export interface HealthIntakeChain {
  chainId: number;
  head?: number;
  cursor?: number;
  lag?: number;
  rpc?: { reachable?: boolean };
  writer?: { low?: boolean; balance?: string };
}

export interface HealthSnapshot {
  status?: string;
  deployBreaker?: unknown;
  intake?: { enabled?: boolean; chains?: HealthIntakeChain[] };
  payments?: { gasWallet?: { low?: boolean } };
}

export interface LaunchSummary {
  id: string;
  launchNumber: number;
  status: string;
  kind?: string;
  chainId?: number;
  parkedReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface LaunchDetail extends LaunchSummary {
  deployFailure?: string | null;
  attestationFailure?: string | null;
}

export interface JobSummary {
  id: string;
  state: string;
  template?: string;
  objective?: string;
  blockedReason?: string | null;
  createdAt: string;
  updatedAt: string;
}
