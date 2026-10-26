/* GrowizeMessages — Activity logs: searchable, filterable event stream
 * with expandable detail rows. Never displays keys, tokens or headers. */

import { state } from '../services/store.js';
import { api } from '../services/api.js';
import { onChange as onDemoChange } from '../services/demo.js';
import {
  esc, icon, refreshIcons, badge, demoTag, fmtDateTime, fmtRel, toast,
  emptyState, spinnerBlock, CATEGORY_META,
} from './ui.js';

let filters = { q: '', category: 'all', status: 'all', convId: '', ruleId: '', from: '', to: '' };
let page = 1;
let expanded = new Set();
let unsub = null;

export async function render(container, { params } = {}) {
  filters = { q: params?.get('q') || '', category: 'all', status: 'all', convId: '', ruleId: '', from: '', to: '' };
  page = 1;
  expanded = new Set();

  let convs = [], rules = [];
  try {
    [convs, rules] = await Promise.all([api.listConversations({}), api.listRules()]);
  } catch { /* filter selects stay empty */ }

  container.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Activity Logs</h1>
          <div class="sub">Every step of the automation pipeline, correlated by ID. Private data such as keys and tokens is never logged. ${demoTag(state.mode === 'demo')}</div>
        </div>
        <div class="page-head-actions">
          <span class="badge outline">${icon('database')} ${state.mode === 'demo' ? 'demo logs (simulated)' : 'backend logs'}</span>
        </div>
      </div>

      <div class="card">
        <div class="log-filters">
          <div class="field" style="max-width:240px">
            <label for="lf-q">Search</label>
            <input id="lf-q" type="search" class="input input-sm" placeholder="Message, detail, contact…" value="${esc(filters.q)}" />
          </div>
          <div class="field">
            <label for="lf-cat">Event type</label>
            <select id="lf-cat" class="select input-sm">
              <option value="all">All categories</option>
              ${Object.entries(CATEGORY_META).map(([id, m]) => `<option value="${id}" ${filters.category === id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="lf-status">Status</label>
            <select id="lf-status" class="select input-sm">
              <option value="all">All</option>
              <option value="success">Success</option>
              <option value="error">Error</option>
              <option value="info">Info</option>
            </select>
          </div>
          <div class="field">
            <label for="lf-conv">Conversation</label>
            <select id="lf-conv" class="select input-sm">
              <option value="">All conversations</option>
              ${convs.map((c) => `<option value="${esc(c.id)}">${esc(c.name || c.username)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="lf-rule">Rule</label>
            <select id="lf-rule" class="select input-sm">
              <option value="">All rules</option>
              ${rules.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="lf-from">From</label>
            <input id="lf-from" type="date" class="input input-sm" value="${esc(filters.from)}" />
          </div>
          <div class="field">
            <label for="lf-to">To</label>
            <input id="lf-to" type="date" class="input input-sm" value="${esc(filters.to)}" />
          </div>
          <div class="field" style="max-width:130px">
            <label>&nbsp;</label>
            <button type="button" class="btn btn-ghost btn-sm" id="lf-clear">Clear filters</button>
          </div>
        </div>
        <div id="logs-root">${spinnerBlock('Loading activity…')}</div>
      </div>
    </div>`;

  refreshIcons(container);

  const bind = (id, ev, key) => {
    container.querySelector(id).addEventListener(ev, (e) => {
      filters[key] = e.target.value;
      page = 1;
      load(container);
    });
  };
  bind('#lf-q', 'input', 'q');
  bind('#lf-cat', 'change', 'category');
  bind('#lf-status', 'change', 'status');
  bind('#lf-conv', 'change', 'convId');
  bind('#lf-rule', 'change', 'ruleId');
  bind('#lf-from', 'change', 'from');
  bind('#lf-to', 'change', 'to');
  container.querySelector('#lf-clear').addEventListener('click', () => render(container, { params: new URLSearchParams() }));

  await load(container);
  unsub = onDemoChange(() => { if (container.isConnected) load(container, { silent: true }); });
  return () => { if (unsub) { unsub(); unsub = null; } };
}

async function load(container, { silent = false } = {}) {
  const root = container.querySelector('#logs-root');
  if (!root) return;
  if (!silent) root.innerHTML = spinnerBlock('Loading activity…');
  let res;
  try {
    res = await api.listActivity({ ...filters, page });
  } catch (err) {
    root.innerHTML = `<div class="note danger" style="margin:14px">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
    refreshIcons(root);
    return;
  }
  if (!container.isConnected) return;

  if (!res.rows.length) {
    root.innerHTML = emptyState({
      iconName: 'scroll-text', title: 'No events match these filters',
      sub: 'Events appear here as messages, rules, AI requests and replies are processed.',
    });
    return;
  }

  root.innerHTML = `
    <div class="table-wrap" style="border:none;border-radius:0;box-shadow:none">
      <table class="data">
        <thead><tr>
          <th>Time</th><th>Event</th><th>Status</th><th>Conversation</th><th>Rule</th><th>Correlation</th><th style="width:34px"></th>
        </tr></thead>
        <tbody>
          ${res.rows.map((row) => logRow(row)).join('')}
        </tbody>
      </table>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-top:1px solid var(--border);flex-wrap:wrap;gap:8px">
      <span class="helper-text">${res.total} events · page ${res.page} of ${res.pages}</span>
      <div style="display:flex;gap:6px">
        <button type="button" class="btn btn-ghost btn-sm" id="pg-prev" ${res.page <= 1 ? 'disabled' : ''}>${icon('chevron-left')} Prev</button>
        <button type="button" class="btn btn-ghost btn-sm" id="pg-next" ${res.page >= res.pages ? 'disabled' : ''}>Next ${icon('chevron-right')}</button>
      </div>
    </div>`;

  refreshIcons(root);

  root.querySelectorAll('[data-expand]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.expand;
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      load(container, { silent: true });
    });
  });
  root.querySelector('#pg-prev')?.addEventListener('click', () => { page = Math.max(1, page - 1); load(container, { silent: true }); });
  root.querySelector('#pg-next')?.addEventListener('click', () => { page = page + 1; load(container, { silent: true }); });
}

function logRow(row) {
  const meta = CATEGORY_META[row.category] || { label: row.category, icon: 'dot', tone: 'neutral' };
  const isOpen = expanded.has(row.id);
  const statusTone = row.status === 'error' ? 'danger' : row.status === 'success' ? 'success' : 'neutral';
  const statusIcon = row.status === 'error' ? 'circle-x' : row.status === 'success' ? 'circle-check' : 'info';
  return `
    <tr class="log-row">
      <td class="log-time" title="${esc(fmtDateTime(row.at))}">${esc(fmtRel(row.at))}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="color:var(--text-3)">${icon(meta.icon)}</span>
          <span class="cell-strong">${esc(meta.label)}</span>
        </div>
        <div class="cell-sub" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(row.message || '')}">${esc(row.message || '')}</div>
      </td>
      <td>${badge(row.status, statusTone, statusIcon)}</td>
      <td class="cell-sub" style="max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(row.conversationName || '—')}</td>
      <td class="cell-sub">${esc(row.ruleName || '—')}</td>
      <td>${row.correlationId ? `<code class="chip">${esc(row.correlationId)}</code>` : '—'}</td>
      <td class="actions"><button type="button" class="icon-btn" data-expand="${esc(row.id)}" aria-expanded="${isOpen}" aria-label="Toggle event details">${icon(isOpen ? 'chevron-up' : 'chevron-down')}</button></td>
    </tr>
    ${isOpen ? `
      <tr class="log-detail-row"><td colspan="7">
        <div class="log-detail">
          <div><b>Full timestamp:</b> ${esc(fmtDateTime(row.at))}</div>
          ${row.conversationId ? `<div><b>Conversation ID:</b> <code class="chip">${esc(row.conversationId)}</code></div>` : ''}
          ${row.ruleId ? `<div><b>Rule ID:</b> <code class="chip">${esc(row.ruleId)}</code></div>` : ''}
          ${row.correlationId ? `<div><b>Correlation ID:</b> <code class="chip">${esc(row.correlationId)}</code> — use it to trace the full pipeline chain.</div>` : ''}
          ${row.detail ? `<div><b>Detail</b><pre>${esc(row.detail)}</pre></div>` : '<div class="helper-text">No extra detail recorded for this event.</div>'}
        </div>
      </td></tr>` : ''}`;
}
