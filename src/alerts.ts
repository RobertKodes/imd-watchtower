import type { Config } from './config.js';
import { SEVERITY_RANK } from './incidents.js';
import type { IncidentEvent } from './types.js';

export function formatAlert(e: IncidentEvent): string {
  const i = e.incident;
  const tag = e.type === 'resolved' ? 'RESOLVED' : i.severity.toUpperCase();
  return `[IMD Watchtower] ${tag} ${e.type === 'escalated' ? '(escalated) ' : ''}${i.title}\n${i.detail}`;
}

/** Send incident events to the configured webhook and/or Telegram chat. Secrets come from env only. */
export async function sendAlerts(cfg: Config, events: IncidentEvent[], log = console): Promise<void> {
  const due = events.filter(
    (e) => SEVERITY_RANK[e.incident.severity] >= SEVERITY_RANK[cfg.alertMinSeverity] && e.incident.source === 'live',
  );
  for (const e of due) {
    const text = formatAlert(e);
    if (cfg.webhookUrl) {
      try {
        const res = await fetch(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // `text` and `content` make it work as-is with Slack- and Discord-style incoming webhooks
          body: JSON.stringify({ event: e.type, incident: e.incident, text, content: text }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) log.warn(`webhook ${res.status}`);
      } catch (err) {
        log.warn(`webhook failed: ${(err as Error).message}`);
      }
    }
    if (cfg.telegramToken && cfg.telegramChatId) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: cfg.telegramChatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) log.warn(`telegram ${res.status}`);
      } catch (err) {
        log.warn(`telegram failed: ${(err as Error).message}`);
      }
    }
  }
}
