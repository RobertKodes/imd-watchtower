#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { backfill, formatReport } from './backfill.js';
import { loadConfig } from './config.js';
import { tick } from './monitor.js';
import { startServer } from './server.js';
import { Store } from './store.js';

const [cmd = 'watch', ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const cfg = loadConfig();

async function main() {
  if (cmd === 'backfill') {
    const from = Number(flag('from'));
    const to = Number(flag('to'));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      console.error('usage: imd-watchtower backfill --from <block> --to <block> [--json out.json] [--record]');
      process.exit(2);
    }
    const r = await backfill(cfg, from, to);
    console.log('');
    console.log(formatReport(r));
    const out = flag('json');
    if (out) writeFileSync(out, JSON.stringify(r, null, 1));
    if (args.includes('--record')) {
      // keep replayed incidents in the store so the status page shows them as history
      const store = new Store(cfg.dataFile);
      const keep = store.state.incidents.filter((i) => !(i.source === 'backfill' && r.incidents.some((n) => n.key === i.key && n.openedAt === i.openedAt)));
      store.state.incidents = [...keep, ...r.incidents];
      store.save();
      console.log(`recorded ${r.incidents.length} backfill incident(s) in ${cfg.dataFile}`);
    }
    return;
  }

  const store = new Store(cfg.dataFile);
  if (cmd === 'once') {
    await tick({ cfg, store, alerts: !args.includes('--no-alerts') });
    console.log(JSON.stringify(store.state.last, null, 1));
    return;
  }

  if (cmd === 'watch' || cmd === 'serve') {
    startServer(cfg, store);
    console.log(`IMD Watchtower on http://localhost:${cfg.port}  (every ${cfg.intervalMs / 1000}s, RPCs: ${cfg.rpcUrls.join(', ')})`);
    console.log(`alerts: webhook ${cfg.webhookUrl ? 'on' : 'off'}, telegram ${cfg.telegramToken && cfg.telegramChatId ? 'on' : 'off'}`);
    if (cmd === 'serve') return; // page + API over the existing store, no polling
    let running = false;
    const loop = async () => {
      if (running) return;
      running = true;
      try {
        await tick({ cfg, store });
      } catch (e) {
        console.warn(`tick failed: ${(e as Error).message}`);
      } finally {
        running = false;
      }
    };
    await loop();
    setInterval(loop, cfg.intervalMs);
    return;
  }

  console.error(`unknown command "${cmd}". Commands: watch | serve | once | backfill`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
