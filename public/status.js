// The status page's script, a separate file so the page works under a strict Content-Security-Policy.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kv = (rows) => rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(v ?? '-')}</dd>`).join('');
const ago = (iso) => { if (!iso) return '-'; const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const fmtTime = (iso) => iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '';
const yes = (b) => b === true ? 'up' : b === false ? 'DOWN' : '-';
const dur = (a, b) => { const m = Math.round((Date.parse(b || new Date().toISOString()) - Date.parse(a)) / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

function worst(incs, scopes) {
  const hit = incs.filter((i) => scopes.includes(i.scope));
  return hit.some((i) => i.severity === 'critical') ? 'critical' : hit.length ? 'warning' : 'ok';
}

function incidentHtml(i) {
  const cls = i.resolvedAt ? 'resolved' : i.severity;
  return `<div class="inc ${cls}">
    <div class="t"><span class="dot ${i.resolvedAt ? '' : i.severity}"></span>${esc(i.title)}
      <span class="tag">${esc(i.severity)}</span><span class="tag">${esc(i.scope)}</span>${i.source === 'backfill' ? '<span class="tag">backfill replay</span>' : ''}</div>
    <div class="d">${esc(i.detail)}</div>
    <div class="when">opened ${fmtTime(i.openedAt)}${i.resolvedAt ? ` · resolved ${fmtTime(i.resolvedAt)} · lasted ${dur(i.openedAt, i.resolvedAt)}` : ` · open ${dur(i.openedAt)}`}</div>
  </div>`;
}

function chart(samples) {
  const svg = $('chart');
  if (!samples.length) { svg.innerHTML = ''; return; }
  const W = 1000, H = 90, n = samples.length;
  const maxP = Math.max(3, ...samples.map((s) => s.pending || 0));
  const maxA = Math.max(1, ...samples.map((s) => s.agentsOnline || 0));
  const x = (i) => n === 1 ? W : (i / (n - 1)) * W;
  const line = (f, max) => samples.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${(H - 4 - ((f(s) || 0) / max) * (H - 12)).toFixed(1)}`).join('');
  svg.innerHTML = `<line x1="0" y1="${H - 4}" x2="${W}" y2="${H - 4}" stroke="var(--line)"/>
    <path d="${line((s) => s.agentsOnline, maxA)}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke" opacity=".7"/>
    <path d="${line((s) => s.pending, maxP)}" fill="none" stroke="var(--warn)" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
}

async function load() {
  try {
    const [st, inc] = await Promise.all([fetch('status').then((r) => r.json()), fetch('incidents').then((r) => r.json())]);
    const open = st.openIncidents || [];
    const label = { ok: 'All systems normal', degraded: 'Degraded', down: 'Incident in progress' }[st.status] || st.status;
    $('overall').className = `pill ${st.status}`;
    $('overall').innerHTML = `<span class="dot"></span><span>${esc(label)}</span>`;
    $('meta').textContent = st.checkedAt ? `Last check ${ago(st.checkedAt)} · every ${st.intervalSeconds}s` : 'Waiting for the first check…';

    const it = st.intake || {};
    $('c-intake').innerHTML = kv([
      ['chain head', it.head ? it.head.number : '-'],
      ['last admitted block', it.lastAdmittedBlock],
      ['waiting', it.pending ?? '-'],
      ['oldest waiting', it.oldestPendingMinutes != null ? `${it.oldestPendingMinutes} min` : '-'],
      ['plane cursor lag', it.planeLag != null ? `${it.planeLag} blocks` : '-'],
    ]);
    const sw = (st.swarm && st.swarm.health) || {};
    $('c-swarm').innerHTML = kv([
      ['agents online', sw.agentsOnline != null ? `${sw.agentsOnline} / ${sw.seatsEnrolled}` : '-'],
      ['verifier', yes(sw.verifierUp)], ['publisher', yes(sw.publisherUp)], ['deployer', yes(sw.deployerUp)],
      ['working now', sw.workingNow],
    ]);
    const la = st.launches || {};
    const counts = la.counts || {};
    $('c-launches').innerHTML = kv([
      ['live (recent)', counts.live ?? 0], ['parked (recent)', counts.parked ?? 0],
      ['in progress', (la.open || []).filter((l) => l.status !== 'parked').length],
      ['deploy failures', (la.open || []).filter((l) => l.deployFailure).length],
      ['total live', st.swarm ? st.swarm.launchesLive : '-'],
    ]);
    const js = (st.swarm && st.swarm.jobStates) || {};
    $('c-jobs').innerHTML = kv([
      ['executing', st.jobs ? st.jobs.executing : '-'], ['completed', js.completed], ['blocked', js.blocked], ['cancelled', js.cancelled],
      ['stuck threshold', `${st.thresholds.jobStaleMinutes} min idle`],
    ]);
    for (const [id, scopes] of [['intake', ['intake', 'health']], ['swarm', ['swarm', 'api']], ['launches', ['launches']], ['jobs', ['jobs']]]) {
      $(`d-${id}`).className = `dot ${worst(open, scopes)}`;
    }
    $('errors').textContent = (st.errors || []).length ? `Check errors: ${st.errors.join(' · ')}` : '';
    chart(st.samples || []);
    $('open').innerHTML = open.length ? open.map(incidentHtml).join('') : '<div class="empty">No open incidents.</div>';
    const hist = (inc.incidents || []).filter((i) => i.resolvedAt);
    $('history').innerHTML = hist.length ? hist.map(incidentHtml).join('') : '<div class="empty">No resolved incidents in the last 7 days.</div>';
  } catch (e) {
    $('meta').textContent = `Could not reach the watchtower API: ${e.message}`;
  }
}
load();
setInterval(load, 30000);
