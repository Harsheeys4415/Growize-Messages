/* GrowizeMessages — System health & troubleshooting.
 * States: connected / not configured / checking / needs attention /
 * disconnected / unknown. A configured URL alone never counts as a
 * successful connection. */

import { state } from '../services/store.js';
import { api } from '../services/api.js';
import {
  esc, icon, refreshIcons, badge, demoTag, toast, spinnerBlock, HEALTH_STATE_META,
} from './ui.js';

let cached = null;

export async function render(container) {
  container.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>System Health</h1>
          <div class="sub">Authoritative checks across the whole pipeline. Results come from real probes in live mode, and are clearly marked as simulated in demo. ${demoTag(state.mode === 'demo')}</div>
        </div>
        <div class="page-head-actions">
          <button type="button" class="btn btn-primary" id="hc-run">${icon('refresh-cw')} Run all checks</button>
        </div>
      </div>
      <div class="card"><div class="card-body" id="checks-root">${spinnerBlock('Running checks…')}</div></div>
      <div class="note" style="margin-top:14px">${icon('info')}<span><b>How states are decided:</b> “Connected” requires a successful probe response — the mere presence of a URL or key never counts. In demo mode Supabase and the backend intentionally report <b>Not configured</b>, because demo data lives in your browser.</span></div>
    </div>`;

  refreshIcons(container);
  container.querySelector('#hc-run').addEventListener('click', () => runChecks(container, true));
  await runChecks(container, false);
}

async function runChecks(container, explicit) {
  const root = container.querySelector('#checks-root');
  if (!root) return;
  if (explicit) root.innerHTML = spinnerBlock('Running all checks…');
  try {
    const res = await api.healthChecks();
    cached = res.checks;
    if (container.isConnected) paintChecks(root, res.checks);
  } catch (err) {
    root.innerHTML = `<div class="note danger">${icon('circle-alert')}<span>Health check failed: ${esc(err.message)}. Verify that the backend is deployed and reachable.</span></div>`;
    refreshIcons(root);
  }
}

function paintChecks(root, checks) {
  const counts = checks.reduce((acc, c) => { acc[c.state] = (acc[c.state] || 0) + 1; return acc; }, {});
  const summary = ['ok', 'attention', 'not_configured', 'disconnected', 'unknown']
    .filter((k) => counts[k])
    .map((k) => badge(`${counts[k]} ${HEALTH_STATE_META[k].label.toLowerCase()}`, k === 'ok' ? 'success' : k === 'attention' ? 'warn' : k === 'disconnected' ? 'danger' : 'neutral'))
    .join(' ');

  root.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">${summary}</div>
    <div class="check-grid">
      ${checks.map((c) => checkCard(c)).join('')}
    </div>`;
  refreshIcons(root);
}

function checkCard(c) {
  const meta = HEALTH_STATE_META[c.state] || HEALTH_STATE_META.unknown;
  return `
    <div class="card check-card" style="box-shadow:none">
      <div class="check-icon ${meta.cls}">${icon(meta.icon)}</div>
      <div class="check-main">
        <div class="check-title">${esc(c.title)} ${badge(meta.label, c.state === 'ok' ? 'success' : c.state === 'attention' ? 'warn' : c.state === 'disconnected' ? 'danger' : 'neutral')} ${c.simulated ? badge('simulated', 'outline') : ''}</div>
        <div class="check-desc">${esc(c.detail || '')}</div>
        ${c.fix ? `<div class="check-fix"><b>How to fix:</b> ${esc(c.fix)}</div>` : ''}
      </div>
    </div>`;
}

export function lastResults() { return cached; }
