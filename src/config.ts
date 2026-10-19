import type { Severity } from './types.js';

export interface Config {
  apiBase: string;
  chainId: number;
  intakeAddresses: `0x${string}`[];
  rpcUrls: string[];
  /** max blocks per eth_getLogs call (capped at 9000) */
  logRange: number;
  /** Ethereum confirmations the plane waits for before it reads a log */
  confirmations: number;
  /** on first start, how many blocks back to scan */
  startLookback: number;
  intervalMs: number;
  /** a request not admitted after this many minutes is late (warning) */
  admitWarnMinutes: number;
  /** ... and after this many minutes the Intake is considered stalled (critical) */
  admitCriticalMinutes: number;
  /** /health intake lag (blocks) that raises a warning */
  healthLagBlocks: number;
  /** a launch sitting in "admitted" longer than this is stuck */
  launchAdmittedMinutes: number;
  /** a job executing with no update for this long is stuck */
  jobStaleMinutes: number;
  /** a job executing longer than this in total is stuck */
  jobMaxMinutes: number;
  launchesLimit: number;
  jobsLimit: number;
  port: number;
  host: string;
  dataFile: string;
  webhookUrl: string | null;
  telegramToken: string | null;
  telegramChatId: string | null;
  alertMinSeverity: Severity;
}

const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));
const list = (v: string | undefined, d: string[]) =>
  v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sev = (env.ALERT_MIN_SEVERITY ?? 'warning') as Severity;
  return {
    apiBase: (env.IMD_API ?? 'https://api.imd.fun').replace(/\/$/, ''),
    chainId: num(env.CHAIN_ID, 1),
    intakeAddresses: list(env.INTAKE_ADDRESSES, ['0xa43e6f75ee006411f79ac1c84120606c2330de82']).map(
      (a) => a.toLowerCase() as `0x${string}`,
    ),
    rpcUrls: list(env.RPC_URLS, ['https://rpc.mevblocker.io', 'https://eth.drpc.org']),
    logRange: Math.min(9000, num(env.LOG_RANGE, 5000)),
    confirmations: num(env.CONFIRMATIONS, 3),
    startLookback: num(env.START_LOOKBACK_BLOCKS, 1800),
    intervalMs: num(env.INTERVAL_SECONDS, 60) * 1000,
    admitWarnMinutes: num(env.ADMIT_WARN_MINUTES, 10),
    admitCriticalMinutes: num(env.ADMIT_CRITICAL_MINUTES, 30),
    healthLagBlocks: num(env.HEALTH_LAG_BLOCKS, 50),
    launchAdmittedMinutes: num(env.LAUNCH_ADMITTED_MINUTES, 45),
    jobStaleMinutes: num(env.JOB_STALE_MINUTES, 120),
    jobMaxMinutes: num(env.JOB_MAX_MINUTES, 720),
    launchesLimit: num(env.LAUNCHES_LIMIT, 50),
    jobsLimit: num(env.JOBS_LIMIT, 100),
    port: num(env.PORT, 8787),
    host: env.HOST ?? '0.0.0.0',
    dataFile: env.DATA_FILE ?? 'data/state.json',
    webhookUrl: env.WEBHOOK_URL || null,
    telegramToken: env.TELEGRAM_BOT_TOKEN || null,
    telegramChatId: env.TELEGRAM_CHAT_ID || null,
    alertMinSeverity: ['info', 'warning', 'critical'].includes(sev) ? sev : 'warning',
  };
}
