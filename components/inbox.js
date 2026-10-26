/* GrowizeMessages — Inbox: conversations + detail view + manual composer.
 * Incoming content is treated as untrusted text and always escaped.
 * Send flow shows a pending state and only confirms after the backend
 * (or demo adapter) acknowledges delivery. */

import { state } from '../services/store.js';
import { api } from '../services/api.js';
import { onChange as onDemoChange } from '../services/demo.js';
import {
  esc, icon, refreshIcons, badge, demoTag, fmtTime, fmtDate, fmtRel,
  emptyState, spinnerBlock, toast, confirmDialog, debounce,
} from './ui.js';

let sel = null;            // selected conversation id
let search = '';
let filter = 'all';
let visible = 8;
let showChatMobile = false;
let unsub = null;

export async function render(container, { id, params } = {}) {
  sel = id || null;
  search = params?.get('q') || '';
  filter = 'all';
  visible = 8;
  showChatMobile = !!sel;

  container.innerHTML = `
    <div class="inbox-layout${showChatMobile ? ' show-chat' : ''}" id="inbox-layout">
      <section class="card inbox-list-panel" aria-label="Conversations">
        <div class="inbox-filters">
          <div class="topbar-search" style="width:100%">
            ${icon('search')}
            <input type="search" class="input" id="conv-search" placeholder="Search name, username or message…" value="${esc(search)}" aria-label="Search conversations" />
          </div>
          <div class="segmented" style="align-self:flex-start" role="tablist" aria-label="Filter conversations">
            <button type="button" data-filter="all" class="active">All</button>
            <button type="button" data-filter="unread">Unread</button>
            <button type="button" data-filter="paused">Paused</button>
          </div>
        </div>
        <div class="inbox-list-scroll" id="conv-list"></div>
      </section>

      <section class="card chat-panel" aria-label="Conversation detail" id="chat-panel"></section>
    </div>`;

  refreshIcons(container);

  const doSearch = debounce((v) => { search = v; visible = 8; paintList(container); }, 220);
  container.querySelector('#conv-search').addEventListener('input', (e) => doSearch(e.target.value));
  container.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b === btn));
      filter = btn.dataset.filter;
      visible = 8;
      paintList(container);
    });
  });

  await paintList(container);
  if (sel) {
    try { await api.markConversationRead(sel, true); await paintList(container, { keepScroll: true }); } catch { /* non-fatal */ }
    await paintChat(container);
  }

  // live updates
  unsub = onDemoChange(async (_db, reason) => {
    if (!container.isConnected) return;
    await paintList(container, { keepScroll: true });
    if (sel && ['message-queued', 'message-update', 'incoming', 'conv-paused', 'read', 'reset'].includes(reason)) {
      await paintChat(container, { keepScroll: reason !== 'incoming' });
    }
  });

  return () => { if (unsub) { unsub(); unsub = null; } };
}

/* ============================================================
   Conversation list
   ============================================================ */
async function paintList(container, { keepScroll = false } = {}) {
  const root = container.querySelector('#conv-list');
  if (!root) return;
  const prevScroll = keepScroll ? root.scrollTop : 0;
  let convs = [];
  try {
    convs = await api.listConversations({ search, filter });
  } catch (err) {
    root.innerHTML = `<div class="note danger" style="margin:12px">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
    refreshIcons(root);
    return;
  }
  if (!container.isConnected) return;

  if (!convs.length) {
    root.innerHTML = emptyState({
      iconName: 'inbox',
      title: filter === 'all' && !search ? 'No conversations yet' : 'No conversations match',
      sub: filter === 'all' && !search
        ? 'When customers DM your connected Instagram account, conversations appear here automatically.'
        : 'Try a different search or filter.',
    });
    return;
  }

  const shown = convs.slice(0, visible);
  root.innerHTML = `<div class="list">${shown.map((c) => convRow(c)).join('')}</div>
    ${convs.length > shown.length ? `<div style="padding:10px;text-align:center"><button type="button" class="btn btn-ghost btn-sm" id="load-more">Load ${Math.min(8, convs.length - shown.length)} more (${convs.length - shown.length} hidden)</button></div>` : ''}`;

  root.querySelectorAll('[data-conv]').forEach((el) => {
    el.addEventListener('click', () => selectConv(container, el.dataset.conv));
  });
  root.querySelector('#load-more')?.addEventListener('click', () => { visible += 8; paintList(container, { keepScroll: true }); });
  if (keepScroll) root.scrollTop = prevScroll;
}

function convRow(c) {
  return `
    <button type="button" class="list-row${c.id === sel ? ' active' : ''}" data-conv="${esc(c.id)}">
      <div class="avatar" aria-hidden="true">${esc(initials(c.name || c.username))}</div>
      <div class="list-main">
        <div class="list-top">
          <span class="list-name">${esc(c.name || c.username || 'Unknown contact')}</span>
          <span class="list-time">${esc(fmtRel(c.lastMessageAt))}</span>
        </div>
        <div class="list-preview">${esc(c.lastMessagePreview || '')}</div>
        <div class="list-tags">
          ${c.username && c.name ? `<span class="badge outline">@${esc(c.username)}</span>` : ''}
          ${c.unread ? badge(`${c.unread} unread`, 'info') : ''}
          ${c.paused ? badge('automation paused', 'warn', 'pause') : badge('automation active', 'success', 'zap')}
        </div>
      </div>
      ${c.unread ? '<span class="unread-dot"></span>' : ''}
    </button>`;
}

async function selectConv(container, convId) {
  sel = convId;
  showChatMobile = true;
  container.querySelector('#inbox-layout')?.classList.add('show-chat');
  await Promise.all([paintList(container, { keepScroll: true }), paintChat(container)]);
  try { await api.markConversationRead(convId, true); } catch { /* non-fatal */ }
}

/* ============================================================
   Conversation detail
   ============================================================ */
async function paintChat(container, { keepScroll = true } = {}) {
  const panel = container.querySelector('#chat-panel');
  if (!panel) return;
  if (!sel) {
    panel.innerHTML = emptyState({
      iconName: 'message-circle', title: 'Select a conversation',
      sub: 'Pick a conversation on the left to review messages, automation details and send a manual reply.',
    });
    return;
  }
  const prevScroll = keepScroll ? panel.querySelector('.chat-scroll')?.scrollTop ?? null : null;

  let conv = null, messages = [];
  try {
    [conv, messages] = await Promise.all([api.listConversations({}).then((l) => l.find((c) => c.id === sel)), api.getMessages(sel)]);
  } catch (err) {
    panel.innerHTML = `<div class="note danger" style="margin:16px">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
    refreshIcons(panel);
    return;
  }
  if (!conv) { sel = null; return paintChat(container); }
  if (!container.isConnected) return;

  const isDemo = state.mode === 'demo';

  panel.innerHTML = `
    <div class="chat-head">
      <button type="button" class="icon-btn" id="chat-back" aria-label="Back to conversation list" style="display:none">${icon('arrow-left')}</button>
      <div class="avatar" aria-hidden="true">${esc(initials(conv.name || conv.username))}</div>
      <div class="chat-head-main">
        <div class="chat-head-name">${esc(conv.name || conv.username || 'Unknown contact')}
          ${conv.paused ? badge('automation paused', 'warn', 'pause') : badge('automation active', 'success', 'zap')}
          ${isDemo ? badge('sample', 'warn') : ''}
        </div>
        <div class="chat-head-user">${conv.username ? '@' + esc(conv.username) : 'username unavailable'} · ${conv.messageCount ?? messages.length} messages</div>
      </div>
      <div class="chat-head-actions">
        ${conv.paused
          ? `<button type="button" class="btn btn-soft btn-sm" data-act="resume">${icon('play')} Resume automation</button>`
          : `<button type="button" class="btn btn-ghost btn-sm" data-act="pause">${icon('pause')} Pause automation</button>`}
        <button type="button" class="icon-btn" data-act="unread" title="Mark unread" aria-label="Mark conversation unread">${icon('mail')}</button>
        <button type="button" class="icon-btn" data-act="refresh" title="Refresh conversation" aria-label="Refresh conversation">${icon('refresh-cw')}</button>
      </div>
    </div>

    <div class="chat-scroll" id="chat-scroll" aria-live="polite">
      ${messages.length ? messages.map((m, i) => bubble(m, messages[i - 1], conv)).join('') : emptyState({ iconName: 'mail', title: 'No messages', sub: 'Messages will appear here as the conversation develops.' })}
    </div>

    ${conv.paused ? `<div class="paused-note">${icon('pause')} Automation is paused for this conversation — replies you send below are manual.</div>` : ''}
    ${!state.settings?.automationEnabled ? `<div class="paused-note">${icon('pause')} Global automation is paused — automated replies are disabled everywhere.</div>` : ''}

    <div class="composer">
      <div class="composer-row">
        <textarea class="textarea" id="composer-input" rows="1" placeholder="Write a manual reply…" aria-label="Manual reply message"></textarea>
        <button type="button" class="btn btn-primary" id="send-btn">${icon('send')} Send</button>
      </div>
      <div class="composer-note">
        ${icon('info')}
        <span>${isDemo
          ? 'Demo mode: the reply is simulated locally and never sent to Instagram.'
          : 'Replies are sent through your backend via the official Instagram Messaging API. You are responsible for this message content.'}</span>
      </div>
    </div>`;

  refreshIcons(panel);

  // mobile back
  const backBtn = panel.querySelector('#chat-back');
  if (window.matchMedia('(max-width: 900px)').matches) backBtn.style.display = 'inline-grid';
  backBtn.addEventListener('click', () => {
    showChatMobile = false;
    sel = null;
    container.querySelector('#inbox-layout')?.classList.remove('show-chat');
    paintList(container);
    paintChat(container);
  });

  // actions
  panel.querySelector('[data-act="pause"]')?.addEventListener('click', async () => {
    try {
      await api.setConversationPaused(sel, true);
      toast('Automation paused for this conversation — enforced by the backend', 'warn');
    } catch (err) { toast(err.message, 'error'); }
  });
  panel.querySelector('[data-act="resume"]')?.addEventListener('click', async () => {
    try {
      await api.setConversationPaused(sel, false);
      toast('Automation resumed for this conversation', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  panel.querySelector('[data-act="refresh"]')?.addEventListener('click', async () => {
    await paintChat(container, { keepScroll: false });
    toast('Conversation refreshed', 'info', 1600);
  });
  panel.querySelector('[data-act="unread"]')?.addEventListener('click', async () => {
    try {
      await api.markConversationRead(sel, false);
      toast('Marked unread', 'info', 1600);
    } catch (err) { toast(err.message, 'error'); }
  });

  // composer
  const input = panel.querySelector('#composer-input');
  const sendBtn = panel.querySelector('#send-btn');
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', send);
  async function send() {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    if (!state.online && state.mode === 'live') { toast('You are offline — sending is unavailable until the connection returns.', 'error'); return; }
    sendBtn.disabled = true;
    sendBtn.innerHTML = `<span class="spinner"></span> Sending…`;
    try {
      await api.sendMessage(sel, text);
      input.value = '';
      input.style.height = 'auto';
      // demo adapter updates via onChange; live re-renders on confirm:
      if (state.mode === 'live') await paintChat(container, { keepScroll: false });
    } catch (err) {
      toast(`Send failed: ${err.message}. The message was NOT delivered — check connection and try again.`, 'error', 6000);
    } finally {
      sendBtn.disabled = false;
      sendBtn.innerHTML = `${icon('send')} Send`;
      refreshIcons(sendBtn);
    }
  }

  // scroll
  const scroller = panel.querySelector('#chat-scroll');
  scroller.scrollTop = prevScroll ?? scroller.scrollHeight;

  // message details toggles
  panel.querySelectorAll('[data-details-for]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const el = document.getElementById(btn.dataset.detailsFor);
      if (el) {
        el.hidden = !el.hidden;
        btn.setAttribute('aria-expanded', el.hidden ? 'false' : 'true');
      }
    });
  });
}

/* ---------- message bubble ---------- */
const STATUS_META = {
  received: { label: 'Received', icon: '' },
  sent: { label: 'Sent', icon: 'check-check' },
  queued: { label: 'Processing…', icon: 'clock' },
  failed: { label: 'Failed', icon: 'circle-x' },
  ignored: { label: 'Ignored (duplicate)', icon: 'copy' },
};

function bubble(m, prev, conv) {
  const out = m.direction === 'out';
  const st = STATUS_META[m.status] || STATUS_META.received;
  const daySep = !prev || fmtDate(prev.at) !== fmtDate(m.at)
    ? `<div class="day-sep">${esc(fmtDate(m.at))}</div>` : '';
  const detailsId = `msg-details-${esc(m.id)}`;
  const hasDetails = !!(m.error || m.correlationId || m.ruleName || m.model);

  return `${daySep}
    <div class="msg ${out ? 'out' : 'in'} ${m.status}">
      <div class="avatar" style="width:28px;height:28px;font-size:11px;align-self:flex-end" aria-hidden="true">${out ? 'G' : esc(initials(conv?.name || conv?.username || '?'))}</div>
      <div class="bubble">
        <div class="bubble-text">${esc(m.text)}</div>
        <div class="bubble-meta">
          ${m.viaAI ? `<span class="ai-tag">${icon('sparkles')} AI</span>` : ''}
          ${m.manual ? `<span class="ai-tag" style="background:var(--surface-3);color:var(--text-2)">manual</span>` : ''}
          ${m.ruleName ? `<span class="rule-tag" title="Matched automation rule">${icon('zap')} ${esc(m.ruleName)}</span>` : ''}
          <span>${esc(fmtTime(m.at))}</span>
          <span class="msg-status" title="${esc(st.label)}">${st.icon ? icon(st.icon) : ''} ${esc(st.label)}</span>
          ${hasDetails ? `<button type="button" class="msg-details-toggle" data-details-for="${detailsId}" aria-expanded="false">details</button>` : ''}
        </div>
        ${hasDetails ? `
          <div class="msg-details" id="${detailsId}" hidden>
            ${m.correlationId ? `<div>Correlation ID: <code>${esc(m.correlationId)}</code></div>` : ''}
            ${m.ruleName ? `<div>Matched rule: ${esc(m.ruleName)}</div>` : ''}
            ${m.model ? `<div>Model: ${esc(m.model)}${m.tokensIn ? ` · ~${esc(m.tokensIn)} in / ~${esc(m.tokensOut)} out tokens` : ''}</div>` : ''}
            ${m.error ? `<div style="color:var(--danger);font-weight:600">Error: ${esc(m.error)}</div>` : ''}
          </div>` : ''}
      </div>
    </div>`;
}

function initials(name) {
  return (name || '?').split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}
