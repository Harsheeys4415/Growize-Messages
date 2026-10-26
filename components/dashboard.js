/* GrowizeMessages — Overview dashboard.
 * Every metric comes from the active adapter. In demo mode everything is
 * labeled as simulated; in live mode numbers come from your backend. */

import { state } from '../services/store.js';
import { api } from '../services/api.js';
import { onChange as onDemoChange } from '../services/demo.js';
import {
  esc, icon, refreshIcons, badge, dot, demoTag, fmtNum, fmtCost, fmtPct,
  fmtRel, fmtDateTime, emptyState, spinnerBlock, debounce, CATEGORY_META,
} from './ui.js';

let currentRange = '7d';
let currentCustom = null;

export async function render(container) {
  container.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Overview</h1>
          <div class="sub" id="dash-sub">Loading dashboard…</div>
        </div>
        <div class="page-head-actions">
          <div class="segmented" role="tablist" aria-label="Date range">
            <button type="button" data-range="today">Today</button>
            <button type="button" data-range="7d" class="active">7 days</button>
            <button type="button" data-range="30d">30 days</button>
            <button type="button" data-range="custom">Custom</button>
          </div>
          <div id="custom-range" hidden style="display:flex;gap:6px;align-items:center">
            <input type="date" class="input input-sm" id="range-from" aria-label="From date" />
            <span style="color:var(--text-3)">→</span>
            <input type="date" class="input input-sm" id="range-to" aria-label="To date" />
            <button type="button" class="btn btn-sm btn-ghost" id="range-apply">Apply</button>
          </div>
        </div>
      </div>

      <div id="stats-root">${spinnerBlock('Loading metrics…')}</div>

      <div class="layout-main-side" style="margin-top:14px">
        <section class="card" aria-labelledby="ra-title">
          <div class="card-head"><h3 id="ra-title">${icon('scroll-text')} Recent activity</h3>
            <a href="#/logs" class="btn btn-ghost btn-sm">View all</a></div>
          <div id="activity-root" style="max-height:380px;overflow-y:auto"></div>
        </section>
        <section class="card" aria-labelledby="rc-title">
          <div class="card-head"><h3 id="rc-title">${icon('inbox')} Recent conversations</h3>
            <a href="#/inbox" class="btn btn-ghost btn-sm">Open inbox</a></div>
          <div id="convs-root" style="max-height:380px;overflow-y:auto"></div>
        </section>
      </div>

      <div class="grid grid-3" style="margin-top:14px">
        <section class="card" aria-labelledby="tr-title">
          <div class="card-head"><h3 id="tr-title">${icon('zap')} Most triggered rules</h3>
            <a href="#/automations" class="btn btn-ghost btn-sm">Manage</a></div>
          <div id="rules-root" class="card-body" style="padding-top:8px"></div>
        </section>
        <section class="card" aria-labelledby="sr-title">
          <div class="card-head"><h3 id="sr-title">${icon('gauge')} Reply success rate</h3></div>
          <div id="rate-root" class="card-body"></div>
        </section>
        <section class="card" aria-labelledby="hs-title">
          <div class="card-head"><h3 id="hs-title">${icon('activity')} System health</h3>
            <a href="#/health" class="btn btn-ghost btn-sm">Details</a></div>
          <div id="health-root" class="card-body" style="padding-top:8px"></div>
        </section>
      </div>

      <section class="card" style="margin-top:14px" aria-labelledby="lw-title">
        <div class="card-head"><h3 id="lw-title">${icon('clock')} Pipeline timestamps</h3></div>
        <div class="card-body">
          <div class="kv-list" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));display:grid">
            <div class="kv"><span class="k">Last webhook received</span><span class="v" id="ts-webhook">—</span></div>
            <div class="kv"><span class="k">Last successful reply</span><span class="v" id="ts-reply">—</span></div>
            <div class="kv"><span class="k">Last synchronization</span><span class="v" id="ts-sync">—</span></div>
          </div>
          <div class="helper-text" style="margin-top:10px" id="pipeline-note"></div>
        </div>
      </section>
    </div>`;

  refreshIcons(container);

  // range controls
  container.querySelectorAll('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('active', b === btn));
      currentRange = btn.dataset.range;
      container.querySelector('#custom-range').hidden = currentRange !== 'custom';
      if (currentRange !== 'custom') { currentCustom = null; loadStats(container); }
      else container.querySelector('#range-from')?.focus();
    });
  });
  container.querySelector('#range-apply')?.addEventListener('click', () => {
    const from = container.querySelector('#range-from').value;
    const to = container.querySelector('#range-to').value;
    if (!from || !to) { currentCustom = { from: from || '', to: to || '' }; } else currentCustom = { from, to };
    loadStats(container);
  });

  await loadStats(container);

  // live refresh (demo store changes or automation toggles)
  const reload = debounce(() => loadStats(container), 250);
  const offDemo = onDemoChange(reload);
  const offAutomation = () => {};
  window.addEventListener('gm:automation-changed', reload);
  return () => { offDemo(); window.removeEventListener('gm:automation-changed', reload); offAutomation(); };
}

async function loadStats(container) {
  try {
    const summary = await api.dashboardSummary(currentRange, currentCustom);
    if (!container.isConnected) return;
    paintStats(container, summary);
  } catch (err) {
    const el = container.querySelector('#stats-root');
    if (el) el.innerHTML = `<div class="note danger">${icon('circle-alert')}<span>Could not load dashboard metrics: ${esc(err.message)}</span></div>`;
    refreshIcons(el);
  }
}

function paintStats(container, s) {
  const isDemo = !!s.simulated;
  container.querySelector('#dash-sub').innerHTML =
    `Automation is ${s.automationEnabled ? '<b style="color:var(--primary)">active</b>' : '<b style="color:var(--warn)">paused</b>'} ·
     ${isDemo ? 'All metrics below are <b>simulated demo data</b>, not real account activity.' : 'Live data from your backend.'} ${demoTag(isDemo)}`;

  const automationCard = `
    <div class="stat interactive" data-go="#/settings" role="link" tabindex="0" aria-label="Automation is ${s.automationEnabled ? 'active' : 'paused'} — open settings">
      <div class="stat-top"><span class="stat-label">${icon('zap')} Global automation</span>${dot(s.automationEnabled ? 'ok' : 'warn', s.automationEnabled)}</div>
      <div class="stat-value" style="font-size:19px;color:${s.automationEnabled ? 'var(--primary)' : 'var(--warn)'}">${s.automationEnabled ? 'Active' : 'Paused'}</div>
      <div class="stat-sub">${s.pausedConversations ? `${s.pausedConversations} conversation(s) individually paused` : 'Enforced by the backend before every send'}</div>
    </div>`;

  const igCard = `
    <div class="stat" data-go="#/integrations" role="link" tabindex="0" aria-label="Connected Instagram account">
      <div class="stat-top"><span class="stat-label">${icon('instagram')} Instagram account</span>${badge(isDemo ? 'sample' : 'connected', isDemo ? 'warn' : 'success')}</div>
      <div class="stat-value small">${esc(s.igAccount?.username || 'Not connected')}</div>
      <div class="stat-sub">${esc(s.igAccount?.name || '—')} · ${esc(s.igAccount?.status || 'unknown')}</div>
    </div>`;

  const stats = [
    automationCard,
    igCard,
    statCard('inbox', 'Incoming messages', fmtNum(s.incoming), 'received DMs in range'),
    statCard('send', 'Automated replies', fmtNum(s.repliesSent), 'sent in range'),
    statCard('circle-x', 'Failed replies', fmtNum(s.failed), s.failed > 0 ? 'needs review — see inbox' : 'no failures in range', s.failed > 0),
    statCard('mail-open', 'Unread conversations', fmtNum(s.unreadConversations), 'across all conversations'),
    statCard('sparkles', 'AI requests', fmtNum(s.aiRequests), `${fmtNum(s.tokensIn)} in / ${fmtNum(s.tokensOut)} out tokens`),
    statCard('wallet', 'Estimated AI cost', fmtCost(s.estCostUsd), 'from configured model pricing'),
  ].join('');

  const statsRoot = container.querySelector('#stats-root');
  statsRoot.innerHTML = `<div class="grid grid-stats">${stats}</div>`;
  statsRoot.querySelectorAll('[data-go]').forEach((el) => {
    const go = () => { location.hash = el.dataset.go; };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  refreshIcons(statsRoot);

  // Recent activity
  const actRoot = container.querySelector('#activity-root');
  if (!s.recentActivity?.length) {
    actRoot.innerHTML = emptyState({ iconName: 'scroll-text', title: 'No activity yet', sub: 'Automation events will appear here as soon as messages flow through the pipeline.' });
  } else {
    actRoot.innerHTML = `<div class="list">${s.recentActivity.map((row) => activityRow(row)).join('')}</div>`;
    actRoot.querySelectorAll('[data-goto-logs]').forEach((el) =>
      el.addEventListener('click', () => {
        const v = el.getAttribute('data-goto-logs');
        location.hash = `#/logs?q=${encodeURIComponent(v)}`;
      }));
  }

  // Recent conversations
  const convRoot = container.querySelector('#convs-root');
  if (!s.recentConversations?.length) {
    convRoot.innerHTML = emptyState({ iconName: 'inbox', title: 'No conversations yet', sub: 'Conversations appear when customers send their first DM.' });
  } else {
    convRoot.innerHTML = `<div class="list">${s.recentConversations.map((c) => `
      <button type="button" class="list-row" data-conv="${esc(c.id)}">
        <div class="avatar">${esc(initials(c.name))}</div>
        <div class="list-main">
          <div class="list-top"><span class="list-name">${esc(c.name)}</span><span class="list-time">${esc(fmtRel(c.lastMessageAt))}</span></div>
          <div class="list-preview">${esc(c.lastMessagePreview || '')}</div>
          <div class="list-tags">
            ${c.unread ? badge(`${c.unread} unread`, 'info') : ''}
            ${c.paused ? badge('paused', 'warn', 'pause') : ''}
          </div>
        </div>
        ${c.unread ? '<span class="unread-dot"></span>' : ''}
      </button>`).join('')}</div>`;
    convRoot.querySelectorAll('[data-conv]').forEach((el) =>
      el.addEventListener('click', () => { location.hash = `#/inbox/${el.dataset.conv}`; }));
  }

  // Top rules
  const rulesRoot = container.querySelector('#rules-root');
  if (!s.topRules?.length) {
    rulesRoot.innerHTML = emptyState({ iconName: 'zap', title: 'No rules triggered yet', sub: 'Create automation rules and they will rank here by usage.' });
  } else {
    const max = Math.max(...s.topRules.map((r) => r.triggerCount), 1);
    rulesRoot.innerHTML = s.topRules.map((r) => `
      <div style="margin-bottom:11px">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
          <span style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name)}</span>
          <span style="font-size:12px;color:var(--text-3);flex:none">${r.triggerCount}×</span>
        </div>
        <div style="height:5px;border-radius:99px;background:var(--surface-2);margin-top:4px">
          <div style="height:100%;width:${Math.round((r.triggerCount / max) * 100)}%;background:${r.enabled ? 'var(--primary)' : 'var(--border-strong)'};border-radius:99px"></div>
        </div>
      </div>`).join('') + `<div class="helper-text">Counts are all-time, demo values.</div>`;
  }

  // Success rate
  const rateRoot = container.querySelector('#rate-root');
  if (s.successRate === null) {
    rateRoot.innerHTML = emptyState({ iconName: 'gauge', title: 'Not enough data', sub: 'The success rate appears once replies have been attempted in this range.' });
  } else {
    rateRoot.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:10px">
        <div class="stat-value" style="font-size:34px;color:${s.successRate >= 95 ? 'var(--primary)' : 'var(--warn)'}">${fmtPct(s.successRate)}</div>
        <div class="helper-text">of automated replies delivered successfully</div>
      </div>
      <div style="height:8px;border-radius:99px;background:var(--surface-2);margin-top:12px">
        <div style="height:100%;width:${Math.min(100, s.successRate)}%;background:var(--primary);border-radius:99px;transition:width 400ms"></div>
      </div>
      <div class="helper-text" style="margin-top:10px">${fmtNum(s.repliesSent)} sent · ${fmtNum(s.failed)} failed in range</div>`;
  }

  // Health summary
  const healthRoot = container.querySelector('#health-root');
  const healthItems = isDemo
    ? [
        ['Instagram connection', 'ok', 'sample'],
        ['Webhook subscription', 'ok', 'sample'],
        ['Supabase', 'not_configured', 'demo mode'],
        ['Backend endpoint', 'not_configured', 'not connected'],
      ]
    : [
        ['Instagram connection', state.metaConnected ? 'ok' : 'err', ''],
        ['Webhook subscription', 'unknown', 'check details'],
        ['Supabase', 'ok', ''],
        ['Backend endpoint', state.backendOk ? 'ok' : 'err', ''],
      ];
  healthRoot.innerHTML = healthItems.map(([label, st, note]) => `
    <div style="display:flex;align-items:center;gap:9px;padding:7px 0;border-bottom:1px dashed var(--border);font-size:13px">
      ${dot(st)}<span style="flex:1">${esc(label)}</span>
      ${note ? `<span style="font-size:11px;color:var(--text-3)">${esc(note)}</span>` : ''}
    </div>`).join('') + `<a href="#/health" class="btn btn-soft btn-sm" style="margin-top:10px">Run all checks</a>`;

  // Timestamps
  container.querySelector('#ts-webhook').innerHTML = `${esc(fmtDateTime(s.lastWebhookAt))} <span class="helper-text">(${esc(fmtRel(s.lastWebhookAt))})</span>`;
  container.querySelector('#ts-reply').innerHTML = `${esc(fmtDateTime(s.lastReplyAt))} <span class="helper-text">(${esc(fmtRel(s.lastReplyAt))})</span>`;
  container.querySelector('#ts-sync').innerHTML = `${esc(fmtDateTime(s.lastSyncAt))} <span class="helper-text">(${esc(fmtRel(s.lastSyncAt))})</span>`;
  container.querySelector('#pipeline-note').innerHTML = isDemo
    ? 'Timestamps above belong to the <b>simulated demo environment</b>. Connect your backend to see live pipeline state.'
    : 'Timestamps come from your backend via the dashboard summary endpoint.';
}

function statCard(iconName, label, value, sub, alert = false) {
  return `
    <div class="stat${alert ? ' alert' : ''}">
      <div class="stat-top"><span class="stat-label">${icon(iconName)} ${esc(label)}</span></div>
      <div class="stat-value">${value}</div>
      <div class="stat-sub">${esc(sub)}</div>
    </div>`;
}

function activityRow(row) {
  const meta = CATEGORY_META[row.category] || { label: row.category, icon: 'dot', tone: 'neutral' };
  return `
    <button type="button" class="list-row" data-goto-logs="${esc(row.correlationId || row.id)}" style="padding:10px 16px">
      <span class="check-icon ${row.status === 'error' ? 'err' : row.status === 'success' ? 'ok' : 'off'}" style="width:30px;height:30px;border-radius:8px">${icon(meta.icon)}</span>
      <span class="list-main">
        <span class="list-top"><span class="list-name" style="font-weight:600;font-size:13px">${esc(meta.label)}</span><span class="list-time">${esc(fmtRel(row.at))}</span></span>
        <span class="list-preview" style="display:block">${esc(row.message || '')}</span>
      </span>
    </button>`;
}

function initials(name) {
  return (name || '?').split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}
