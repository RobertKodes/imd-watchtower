import { randomUUID } from 'node:crypto';
import type { Finding, Incident, IncidentEvent, Scope, Severity } from './types.js';

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

/**
 * Turns per-tick findings into incidents. A finding key that appears opens an incident,
 * a higher severity escalates it, and a key that disappears resolves it, but only for the
 * scopes whose detectors actually ran this tick (a failed fetch never resolves anything).
 */
export function reconcile(
  incidents: Incident[],
  findings: Finding[],
  scopesRan: Set<Scope>,
  now: number,
  source: Incident['source'] = 'live',
): IncidentEvent[] {
  const events: IncidentEvent[] = [];
  const at = new Date(now).toISOString();
  const open = new Map(incidents.filter((i) => !i.resolvedAt).map((i) => [i.key, i]));
  const seen = new Set<string>();

  for (const f of findings) {
    seen.add(f.key);
    const cur = open.get(f.key);
    if (!cur) {
      const inc: Incident = {
        id: randomUUID(), key: f.key, scope: f.scope, severity: f.severity, title: f.title, detail: f.detail,
        data: f.data, openedAt: at, updatedAt: at, resolvedAt: null, source,
      };
      incidents.push(inc);
      open.set(f.key, inc);
      events.push({ type: 'opened', incident: inc });
      continue;
    }
    const escalated = SEVERITY_RANK[f.severity] > SEVERITY_RANK[cur.severity];
    Object.assign(cur, { title: f.title, detail: f.detail, data: f.data, updatedAt: at });
    if (escalated) {
      cur.severity = f.severity;
      events.push({ type: 'escalated', incident: cur });
    }
  }

  for (const inc of open.values()) {
    if (!seen.has(inc.key) && scopesRan.has(inc.scope)) {
      inc.resolvedAt = at;
      inc.updatedAt = at;
      events.push({ type: 'resolved', incident: inc });
    }
  }
  return events;
}
