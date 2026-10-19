import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { overall } from './monitor.js';
import type { Store } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));
function file(name: string): string | null {
  for (const p of [join(here, '..', 'public', name), join(process.cwd(), 'public', name)]) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      /* next */
    }
  }
  return null;
}

const page = (): string => file('status.html') ?? '<!doctype html><title>IMD Watchtower</title><p>status.html missing</p>';

export function statusPayload(cfg: Config, store: Store) {
  const s = store.state;
  return {
    service: 'imd-watchtower',
    status: overall(store),
    intervalSeconds: cfg.intervalMs / 1000,
    thresholds: {
      admitWarnMinutes: cfg.admitWarnMinutes, admitCriticalMinutes: cfg.admitCriticalMinutes,
      launchAdmittedMinutes: cfg.launchAdmittedMinutes, jobStaleMinutes: cfg.jobStaleMinutes,
    },
    ...(s.last ?? {}),
    openIncidents: s.incidents.filter((i) => !i.resolvedAt),
    samples: s.samples.slice(-180),
  };
}

export function startServer(cfg: Config, store: Store): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body, null, 1));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    switch (url.pathname) {
      case '/':
      case '/index.html':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(page());
      case '/status.js':
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(file('status.js') ?? '');
      case '/status':
        return json(200, statusPayload(cfg, store));
      case '/incidents': {
        const all = url.searchParams.get('all') === '1';
        const source = url.searchParams.get('source');
        const list = store.state.incidents
          .filter((i) => all || !i.resolvedAt || Date.now() - Date.parse(i.resolvedAt) < 7 * 86400_000)
          .filter((i) => !source || i.source === source)
          .slice()
          .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
        return json(200, { count: list.length, incidents: list });
      }
      case '/healthz':
        return json(200, { ok: true });
      default:
        return json(404, { error: 'not_found' });
    }
  });
  server.listen(cfg.port, cfg.host);
  return server;
}
