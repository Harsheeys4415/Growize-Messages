/* GrowizeMessages — shared UI helpers: escaping, formatting, toasts,
 * modals, dropdowns, empty states. No framework, just DOM done carefully. */

import { state } from '../services/store.js';

/* ---------- escaping (all dynamic content passes through esc) ---------- */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- icons ---------- */
export function icon(name, cls = '') {
  return `<i data-lucide="${esc(name)}"${cls ? ` class="${esc(cls)}"` : ''}></i>`;
}
export function refreshIcons(root) {
  try { window.lucide?.createIcons(root ? { attrs: {}, nameAttr: 'data-lucide' } : undefined); }
  catch { /* CDN unavailable — buttons remain usable via labels */ }
}

/* ---------- formatting ---------- */
function tz() {
  const t = state.settings?.timezone;
  return !t || t === 'system' ? undefined : t;
}
export function fmtTime(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: tz() }).format(new Date(iso));
}
export function fmtDate(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: tz() }).format(new Date(iso));
}
export function fmtDateTime(iso) {
  if (!iso) return '—';
  return `${fmtDate(iso)}, ${fmtTime(iso)}`;
}
export function fmtRel(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const future = diff < -30_000;
  const fmt = (n, u) => future ? `in ${n}${u}` : `${n}${u} ago`;
  if (abs < 60_000) return future ? 'soon' : 'just now';
  if (abs < 3_600_000) return fmt(Math.floor(abs / 60_000), 'm');
  if (abs < 86_400_000) return fmt(Math.floor(abs / 3_600_000), 'h');
  if (abs < 7 * 86_400_000) return fmt(Math.floor(abs / 86_400_000), 'd');
  return fmtDate(iso);
}
export function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat(undefined, { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
}
export function fmtCost(usd) {
  if (usd === null || usd === undefined) return '—';
  return usd < 0.01 && usd > 0 ? `<$0.01` : `$${usd.toFixed(2)}`;
}
export function fmtPct(p) { return p === null || p === undefined ? '—' : `${p.toFixed(1)}%`; }

export function debounce(fn, ms = 250) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'success'); return true; }
  catch { toast('Could not copy — select the text manually', 'warn'); return false; }
}

/* ---------- toasts ---------- */
export function toast(message, type = 'info', ms = 3600) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const iconName = { success: 'circle-check', error: 'circle-alert', warn: 'triangle-alert', info: 'info' }[type] || 'info';
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `${icon(iconName)}<span>${esc(message)}</span>`;
  el.addEventListener('click', () => el.remove());
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 200ms'; setTimeout(() => el.remove(), 220); }, ms);
}

/* ---------- modal ---------- */
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function openModal({ title = '', body = '', footer = '', size = '', onMount = null, onClose = null, labelledBy = 'gm-modal-title' }) {
  const root = document.getElementById('modal-root');
  const prevFocus = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-labelledby="${labelledBy}">
      <div class="modal-head">
        <h2 id="${labelledBy}">${title}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close dialog">${icon('x')}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  root.appendChild(backdrop);
  document.body.style.overflow = 'hidden';

  const modal = backdrop.querySelector('.modal');
  const close = () => {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', keyHandler);
    if (prevFocus?.focus) prevFocus.focus();
    onClose?.();
  };
  const keyHandler = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {
      const items = [...modal.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', keyHandler);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  modal.querySelector('[data-close]').addEventListener('click', close);

  const first = modal.querySelector('[autofocus]') || modal.querySelector(FOCUSABLE);
  if (first) setTimeout(() => first.focus(), 30);
  onMount?.(modal, close);
  refreshIcons(modal);
  return { close, el: modal };
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let decided = false;
    const { close } = openModal({
      title, size: 'narrow',
      body: `<p style="color:var(--text-2)">${message}</p>`,
      footer: `
        <button type="button" class="btn btn-ghost" data-cancel>${esc(cancelLabel)}</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm autofocus>${esc(confirmLabel)}</button>`,
      onClose: () => { if (!decided) resolve(false); },
      onMount: (modal, closeFn) => {
        modal.querySelector('[data-cancel]').addEventListener('click', () => { decided = true; resolve(false); closeFn(); });
        modal.querySelector('[data-confirm]').addEventListener('click', () => { decided = true; resolve(true); closeFn(); });
      },
    });
    return close;
  });
}

/* ---------- drawer (right side panel) ---------- */
export function openDrawer({ title = '', body = '', footer = '', onMount = null }) {
  const root = document.getElementById('modal-root');
  const prevFocus = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  backdrop.innerHTML = `
    <div class="drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">
        <h2>${title}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close panel">${icon('x')}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  root.appendChild(backdrop);
  document.body.style.overflow = 'hidden';
  const close = () => {
    backdrop.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', keyHandler);
    if (prevFocus?.focus) prevFocus.focus();
  };
  const keyHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', keyHandler);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-close]').addEventListener('click', close);
  const first = backdrop.querySelector('[autofocus]') || backdrop.querySelector(FOCUSABLE);
  if (first) setTimeout(() => first.focus(), 30);
  onMount?.(backdrop.querySelector('.drawer'), close);
  refreshIcons(backdrop);
  return { close, el: backdrop.querySelector('.drawer') };
}

/* ---------- dropdown ---------- */
export function attachDropdown(anchor, html, { align = 'right', onClose = null } = {}) {
  closeDropdowns();
  const wrap = document.createElement('div');
  wrap.className = 'dropdown-wrap';
  wrap.style.position = 'relative';
  anchor.parentNode.insertBefore(wrap, anchor);
  wrap.appendChild(anchor);
  const dd = document.createElement('div');
  dd.className = 'dropdown';
  if (align === 'left') { dd.style.right = 'auto'; dd.style.left = '0'; }
  dd.innerHTML = html;
  wrap.appendChild(dd);
  refreshIcons(dd);

  const onDocClick = (e) => { if (!wrap.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    dd.remove();
    wrap.replaceWith(anchor);
    document.removeEventListener('mousedown', onDocClick);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
  }, 0);
  return { close, el: dd };
}
export function closeDropdowns() {
  document.querySelectorAll('.dropdown').forEach((dd) => {
    const wrap = dd.parentNode;
    const anchor = wrap.firstChild;
    if (anchor) wrap.replaceWith(anchor);
    dd.remove();
  });
}

/* ---------- building blocks ---------- */
export function emptyState({ iconName = 'inbox', title = 'Nothing here yet', sub = '', actionHtml = '' }) {
  return `
    <div class="empty">
      ${icon(iconName)}
      <div class="e-title">${esc(title)}</div>
      ${sub ? `<div class="e-sub">${esc(sub)}</div>` : ''}
      ${actionHtml}
    </div>`;
}

export function spinnerBlock(label = 'Loading…') {
  return `<div class="loading-block"><span class="spinner"></span> ${esc(label)}</div>`;
}

export function badge(text, tone = 'neutral', iconName = null) {
  return `<span class="badge ${tone}">${iconName ? icon(iconName) : ''}${esc(text)}</span>`;
}

export function dot(stateName, pulse = false) {
  const cls = { ok: 'ok', connected: 'ok', success: 'ok', err: 'err', error: 'err', disconnected: 'err', attention: 'warn', warn: 'warn', off: 'off', unknown: 'off', not_configured: 'off', checking: 'warn' }[stateName] || 'off';
  return `<span class="dot-ind ${cls}${pulse ? ' pulse' : ''}"></span>`;
}

/* Activity log categories */
export const CATEGORY_META = {
  incoming_dm: { label: 'Incoming DM', icon: 'arrow-down-left', tone: 'info' },
  webhook_received: { label: 'Webhook received', icon: 'webhook', tone: 'neutral' },
  webhook_validation_failed: { label: 'Webhook validation failed', icon: 'shield-alert', tone: 'danger' },
  duplicate_ignored: { label: 'Duplicate event ignored', icon: 'copy', tone: 'neutral' },
  rule_evaluated: { label: 'Rule evaluated', icon: 'git-compare', tone: 'neutral' },
  rule_matched: { label: 'Rule matched', icon: 'zap', tone: 'success' },
  ai_request_started: { label: 'AI request started', icon: 'sparkles', tone: 'neutral' },
  ai_request_succeeded: { label: 'AI request succeeded', icon: 'sparkles', tone: 'success' },
  ai_request_failed: { label: 'AI request failed', icon: 'circle-alert', tone: 'danger' },
  reply_queued: { label: 'Reply queued', icon: 'clock', tone: 'info' },
  reply_sent: { label: 'Reply sent', icon: 'send', tone: 'success' },
  reply_failed: { label: 'Reply failed', icon: 'circle-x', tone: 'danger' },
  retry_attempted: { label: 'Retry attempted', icon: 'rotate-cw', tone: 'warn' },
  automation_paused: { label: 'Automation paused', icon: 'pause', tone: 'warn' },
  automation_resumed: { label: 'Automation resumed', icon: 'play', tone: 'success' },
  integration_error: { label: 'Integration error', icon: 'unplug', tone: 'danger' },
};

export const HEALTH_STATE_META = {
  ok: { label: 'Connected', icon: 'circle-check', cls: 'ok' },
  not_configured: { label: 'Not configured', icon: 'circle-dashed', cls: 'off' },
  checking: { label: 'Checking…', icon: 'loader', cls: 'loading' },
  attention: { label: 'Needs attention', icon: 'triangle-alert', cls: 'warn' },
  disconnected: { label: 'Disconnected', icon: 'circle-x', cls: 'err' },
  unknown: { label: 'Unknown', icon: 'circle-help', cls: 'off' },
};

export function demoTag(simulated) {
  return simulated ? `<span class="badge warn" title="Simulated demo data — not real account data">demo</span>` : '';
}
