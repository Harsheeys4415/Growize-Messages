/* GrowizeMessages — application chrome: sidebar, topbar, banners,
 * demo-mode controls, offline indicator. */

import { state, patch, on, applyTheme, lsGet, lsSet } from '../services/store.js';
import { api } from '../services/api.js';
import { onChange as onDemoChange, unreadCount as demoUnreadCount } from '../services/demo.js';
import { esc, icon, refreshIcons, toast, confirmDialog, attachDropdown, closeDropdowns, fmtRel, demoTag, dot } from './ui.js';

const NAV = [
  { section: 'Manage', items: [
    { id: 'dashboard', label: 'Overview', icon: 'layout-dashboard' },
    { id: 'inbox', label: 'Inbox', icon: 'inbox', badge: 'unread' },
    { id: 'automations', label: 'Automations', icon: 'workflow' },
    { id: 'ai', label: 'AI Assistant', icon: 'bot' },
  ]},
  { section: 'Monitor', items: [
    { id: 'logs', label: 'Activity Logs', icon: 'scroll-text' },
    { id: 'health', label: 'System Health', icon: 'activity' },
  ]},
  { section: 'Configure', items: [
    { id: 'integrations', label: 'Integrations', icon: 'plug-zap' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ]},
];

export const PAGE_TITLES = {
  dashboard: 'Overview', inbox: 'Inbox', automations: 'Automations', ai: 'AI Assistant',
  logs: 'Activity Logs', health: 'System Health', integrations: 'Integrations', settings: 'Settings', setup: 'Setup wizard',
};

let mounted = false;
let notifCache = { at: 0, rows: [] };

export function renderNavigation() {
  if (mounted) return;
  mounted = true;

  renderSidebar();
  renderTopbar();
  renderDemoControls();
  renderBanners();

  // Live refresh hooks
  onDemoChange(() => { updateSidebar(); updateTopbar(); });
  on('state', () => { updateSidebar(); updateTopbar(); });
  on('theme', () => updateTopbar());
  window.addEventListener('online', () => { patch({ online: true }); toast('Back online', 'success'); });
  window.addEventListener('offline', () => { patch({ online: false }); });
}

/* ============================================================
   Sidebar
   ============================================================ */
function renderSidebar() {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = `
    <div class="brand">
      <div class="brand-logo" aria-hidden="true">G</div>
      <div style="min-width:0">
        <div class="brand-name">Growize<span>Messages</span></div>
        <div class="brand-tag">Every message, handled.</div>
      </div>
    </div>
    <nav class="nav-section" aria-label="Main">
      ${NAV.map((group) => `
        <div class="nav-label">${esc(group.section)}</div>
        <div class="nav-list">
          ${group.items.map((item) => `
            <a href="#/${item.id}" class="nav-item" data-nav="${item.id}" title="${esc(item.label)}">
              ${icon(item.icon)}<span>${esc(item.label)}</span>
              <span class="nav-badge" data-badge="${item.id}" hidden></span>
            </a>`).join('')}
        </div>`).join('')}
    </nav>
    <div class="sidebar-footer">
      <div class="status-row" style="justify-content:space-between">
        <span style="display:flex;align-items:center;gap:8px">${icon('radio')} Status</span>
        <span data-mode-pill></span>
      </div>
      <div class="status-row" title="Instagram connection">${icon('instagram')}<span class="grow">Instagram</span><span data-ig-status></span></div>
      <div class="status-row" title="Backend connection">${icon('database')}<span class="grow">Backend</span><span data-backend-status></span></div>
      <div class="status-row" style="background:var(--surface-2)">
        <span style="display:flex;align-items:center;gap:8px">${icon('zap')}<span class="grow">Automation</span></span>
        <label class="switch" title="Toggle global automation">
          <input type="checkbox" data-automation-switch aria-label="Global automation enabled" />
          <span class="track"></span>
        </label>
      </div>
      <div class="user-row">
        <div class="avatar" data-user-avatar>?</div>
        <div class="user-meta">
          <div class="name" data-user-name>Administrator</div>
          <div class="sub" data-user-sub>Demo session</div>
        </div>
        <button type="button" class="icon-btn small" data-signout title="Sign out" aria-label="Sign out">${icon('log-out')}</button>
      </div>
      <button type="button" class="btn btn-soft btn-sm" data-install hidden>${icon('download')} Install app</button>
    </div>`;

  // Nav clicks: close mobile drawer
  sb.addEventListener('click', (e) => {
    const link = e.target.closest('[data-nav]');
    if (link) closeSidebar();
    if (e.target.closest('[data-signout]')) handleSignOut();
    if (e.target.closest('[data-install]')) triggerInstall();
  });
  sb.querySelector('[data-automation-switch]').addEventListener('change', async (e) => {
    const enable = e.target.checked;
    if (!enable) {
      const ok = await confirmDialog({
        title: 'Pause global automation?',
        message: 'No automated replies will be sent until you resume it. The backend enforces this before every send.',
        confirmLabel: 'Pause automation',
      });
      if (!ok) { e.target.checked = true; return; }
    }
    try {
      const res = enable ? await api.resumeAutomation() : await api.pauseAutomation({});
      state.settings = { ...(state.settings || {}), automationEnabled: res.automationEnabled };
      toast(enable ? 'Automation resumed' : 'Automation paused — the backend will not send automated replies', enable ? 'success' : 'warn');
      updateSidebar(); updateTopbar();
      window.dispatchEvent(new CustomEvent('gm:automation-changed'));
    } catch (err) {
      e.target.checked = !enable;
      toast(err.message, 'error');
    }
  });
  updateSidebar();
}

export function updateSidebar() {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  sb.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === state.page);
  });
  // unread badge
  const badge = sb.querySelector('[data-badge="inbox"]');
  if (badge) {
    const unread = countUnread();
    badge.hidden = !unread;
    badge.textContent = unread > 99 ? '99+' : unread;
  }
  // mode pill
  const pill = sb.querySelector('[data-mode-pill]');
  if (pill) {
    pill.innerHTML = state.mode === 'demo'
      ? '<span class="mode-pill demo">Demo</span>'
      : '<span class="mode-pill live">Live</span>';
  }
  const ig = sb.querySelector('[data-ig-status]');
  if (ig) {
    ig.innerHTML = state.mode === 'demo'
      ? `${dot('ok')}<span class="sub" style="font-size:11px;color:var(--text-3)">sample</span>`
      : `${dot(state.metaConnected ? 'ok' : 'err')}`;
  }
  const be = sb.querySelector('[data-backend-status]');
  if (be) {
    be.innerHTML = state.mode === 'demo'
      ? `<span style="font-size:11px;color:var(--text-3)">demo data</span>`
      : `${dot(state.backendOk ? 'ok' : 'err')}`;
  }
  // automation switch
  const sw = sb.querySelector('[data-automation-switch]');
  if (sw && state.settings) {
    sw.checked = !!state.settings.automationEnabled;
  }
  // user
  const avatar = sb.querySelector('[data-user-avatar]');
  const name = sb.querySelector('[data-user-name]');
  const sub = sb.querySelector('[data-user-sub]');
  if (avatar && name && sub) {
    if (state.mode === 'live' && state.user) {
      avatar.textContent = (state.user.name || state.user.email || '?').slice(0, 1).toUpperCase();
      name.textContent = state.user.name || state.user.email;
      sub.textContent = 'Authenticated';
    } else {
      avatar.textContent = 'D';
      name.textContent = 'Demo session';
      sub.textContent = 'Sample data only';
    }
  }
}

function countUnread() {
  return state.mode === 'demo' ? demoUnreadCount() : (state.unreadCount || 0);
}

/* The store keeps a live unread count via settings refresh; inbox also pushes it. */
export function setUnreadCount(n) { state.unreadCount = n; updateSidebar(); }

/* ============================================================
   Topbar
   ============================================================ */
function renderTopbar() {
  const tb = document.getElementById('topbar');
  tb.innerHTML = `
    <button type="button" class="icon-btn menu-btn" data-menu aria-label="Open navigation">${icon('menu')}</button>
    <div class="topbar-title"><h1 data-page-title style="font-size:15.5px;font-weight:650">Overview</h1></div>
    <div class="topbar-spacer"></div>
    <div class="topbar-search">
      ${icon('search')}
      <input type="search" class="input" data-global-search placeholder="Search conversations…" aria-label="Search conversations" />
    </div>
    <div class="topbar-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-global-toggle title="Pause or resume global automation">
        <span data-global-toggle-label>Pause automation</span>
      </button>
      <button type="button" class="icon-btn" data-notifications aria-label="Notifications">${icon('bell')}</button>
      <button type="button" class="icon-btn" data-theme-toggle aria-label="Toggle theme"></button>
    </div>`;

  tb.addEventListener('click', async (e) => {
    if (e.target.closest('[data-menu]')) toggleSidebar();
    if (e.target.closest('[data-notifications]')) showNotifications(e.target.closest('[data-notifications]'));
    if (e.target.closest('[data-theme-toggle]')) cycleTheme();
    if (e.target.closest('[data-global-toggle]')) toggleGlobalAutomation();
  });
  tb.querySelector('[data-global-search]').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = e.target.value.trim();
      location.hash = q ? `#/inbox?q=${encodeURIComponent(q)}` : '#/inbox';
    }
  });
  updateTopbar();
}

export function updateTopbar() {
  const tb = document.getElementById('topbar');
  if (!tb) return;
  const title = tb.querySelector('[data-page-title]');
  if (title) title.textContent = PAGE_TITLES[state.page] || 'GrowizeMessages';
  const themeBtn = tb.querySelector('[data-theme-toggle]');
  const resolved = document.documentElement.dataset.theme || 'light';
  themeBtn.innerHTML = icon(resolved === 'dark' ? 'sun' : 'moon');
  const label = tb.querySelector('[data-global-toggle-label]');
  const btn = tb.querySelector('[data-global-toggle]');
  if (label && btn && state.settings) {
    const paused = !state.settings.automationEnabled;
    label.textContent = paused ? 'Resume automation' : 'Pause automation';
    btn.classList.toggle('btn-ghost', !paused);
    btn.classList.toggle('btn-danger-soft', paused);
    btn.title = paused ? 'Resume global automation' : 'Pause global automation';
  }
}

async function toggleGlobalAutomation() {
  const paused = !(state.settings?.automationEnabled);
  if (paused) {
    const ok = await confirmDialog({
      title: 'Resume global automation?',
      message: 'Automated replies will be sent again according to your rules.',
      confirmLabel: 'Resume',
    });
    if (!ok) return;
  } else {
    const ok = await confirmDialog({
      title: 'Pause global automation?',
      message: 'No automated replies will be sent until you resume it. This state is enforced by the backend.',
      confirmLabel: 'Pause automation', danger: true,
    });
    if (!ok) return;
  }
  try {
    const res = paused ? await api.resumeAutomation() : await api.pauseAutomation({});
    state.settings = { ...(state.settings || {}), automationEnabled: res.automationEnabled };
    toast(paused ? 'Automation resumed' : 'Automation paused', paused ? 'success' : 'warn');
    updateTopbar(); updateSidebar();
    window.dispatchEvent(new CustomEvent('gm:automation-changed'));
  } catch (err) { toast(err.message, 'error'); }
}

function cycleTheme() {
  const current = document.documentElement.dataset.theme || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  lsSet('gm.theme', next);
}

/* ---------- notifications ---------- */
async function showNotifications(anchor) {
  const now = Date.now();
  if (now - notifCache.at > 30_000) {
    try {
      const res = await api.listActivity({ status: 'error' });
      notifCache = { at: now, rows: (res.rows || []).slice(0, 6) };
    } catch { notifCache = { at: now, rows: [] }; }
  }
  const rows = notifCache.rows;
  const html = `
    <div class="dd-head">Recent failures</div>
    ${rows.length ? rows.map((r) => `
      <button type="button" class="notif-item dd-item" data-goto="#/logs?q=${encodeURIComponent((r.message || '').slice(0, 30))}">
        <span style="margin-top:2px">${dot('err')}</span>
        <span style="min-width:0">
          <span class="n-title" style="display:block">${esc(r.message || 'Error')}</span>
          <span class="n-sub">${esc(r.conversationName || '')} · ${esc(fmtRel(r.at))}</span>
        </span>
      </button>`).join('')
      : '<div class="dd-note">No recent failures. All clear.</div>'}
    <div class="dd-sep"></div>
    <button type="button" class="dd-item" data-goto="#/logs">${icon('scroll-text')} View all activity</button>`;
  const { close, el } = attachDropdown(anchor, html);
  el.addEventListener('click', (e) => {
    const item = e.target.closest('[data-goto]');
    if (item) { location.hash = item.dataset.goto; close(); }
  });
}

/* ============================================================
   Sidebar mobile behaviour
   ============================================================ */
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const open = !sb.classList.contains('open');
  sb.classList.toggle('open', open);
  if (open) {
    const scrim = document.createElement('div');
    scrim.className = 'sidebar-scrim';
    scrim.addEventListener('click', closeSidebar);
    document.body.appendChild(scrim);
  } else closeSidebar();
}
function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.querySelector('.sidebar-scrim')?.remove();
}

/* ============================================================
   Banners (offline)
   ============================================================ */
function renderBanners() {
  const root = document.getElementById('banner-root');
  const render = () => {
    root.innerHTML = !state.online
      ? `<div class="offline-banner" role="status">${icon('wifi-off')} You are offline — the app shell is cached, live management actions are unavailable.</div>`
      : '';
    refreshIcons(root);
  };
  render();
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
}

/* ============================================================
   Demo controls (only visible in demo mode)
   ============================================================ */
function renderDemoControls() {
  const root = document.getElementById('demo-root');
  root.innerHTML = `
    <div class="demo-controls" hidden data-demo-wrap>
      <div class="dc-menu" hidden data-demo-menu>
        <div class="dd-head">Demo tools — all simulated</div>
        <button type="button" class="dd-item" data-demo-act="incoming">${icon('arrow-down-left')} Simulate incoming DM</button>
        <button type="button" class="dd-item" data-demo-act="failure">${icon('circle-x')} Simulate reply failure</button>
        <button type="button" class="dd-item" data-demo-act="reset">${icon('trash-2')} Reset demo data</button>
        <div class="dd-sep"></div>
        <div class="dd-note">Nothing here touches a real Instagram account.</div>
      </div>
      <button type="button" class="dc-toggle" data-demo-toggle>${icon('flask-conical')} DEMO TOOLS</button>
    </div>`;
  refreshIcons(root);

  const wrap = root.querySelector('[data-demo-wrap]');
  const menu = root.querySelector('[data-demo-menu]');
  root.querySelector('[data-demo-toggle]').addEventListener('click', () => {
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) menu.hidden = true;
  });
  menu.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-demo-act]');
    if (!btn) return;
    menu.hidden = true;
    const act = btn.dataset.demoAct;
    if (act === 'incoming') {
      const { simulateIncoming } = await import('../services/demo.js');
      const res = simulateIncoming();
      if (res?.duplicate) toast('Simulated duplicate event — ignored by the engine', 'info');
      else toast('Simulated incoming DM — automation pipeline running', 'info');
    } else if (act === 'failure') {
      const { armFailure } = await import('../services/demo.js');
      armFailure();
      toast('Next outgoing reply will fail (simulated)', 'warn');
    } else if (act === 'reset') {
      const ok = await confirmDialog({
        title: 'Reset demo data?',
        message: 'All sample conversations, rules, logs and settings return to their original state.',
        confirmLabel: 'Reset demo', danger: true,
      });
      if (!ok) return;
      const { reset } = await import('../services/demo.js');
      reset();
      const { api } = await import('../services/api.js');
      state.settings = await api.getSettings();
      toast('Demo data reset', 'success');
      location.hash = '#/dashboard';
      window.dispatchEvent(new CustomEvent('gm:automation-changed'));
    }
  });
}

export function updateDemoVisibility() {
  const wrap = document.querySelector('[data-demo-wrap]');
  if (wrap) wrap.hidden = state.mode !== 'demo';
}

/* ============================================================
   Sign out & install
   ============================================================ */
async function handleSignOut() {
  if (state.mode === 'live') {
    const ok = await confirmDialog({ title: 'Sign out?', message: 'You will need to sign in again to manage live data.', confirmLabel: 'Sign out' });
    if (!ok) return;
    const { signOut } = await import('../services/supabase.js');
    await signOut();
    patch({ user: null });
    const { showAuth } = await import('./auth.js');
    showAuth();
    return;
  }
  const ok = await confirmDialog({ title: 'Exit demo session?', message: 'You can return to the demo at any time from the sign-in screen.', confirmLabel: 'Exit demo' });
  if (!ok) return;
  const { showAuth } = await import('./auth.js');
  showAuth({ allowDemo: true });
}

async function triggerInstall() {
  const evt = state.installPrompt;
  if (evt) {
    evt.prompt();
    try {
      const choice = await evt.userChoice;
      if (choice?.outcome === 'accepted') toast('GrowizeMessages installed', 'success');
    } catch { /* ignore */ }
    state.installPrompt = null;
    const btn = document.querySelector('[data-install]');
    if (btn) btn.hidden = true;
  } else {
    const { openModal } = await import('./ui.js');
    openModal({
      title: 'Install GrowizeMessages',
      body: `
        <p class="helper-text" style="margin-bottom:12px">Installing gives you the management dashboard as an app. Installing the PWA <b>only installs the interface</b> — the automation engine runs independently on your backend, so automation keeps working while this app is closed.</p>
        <ul style="margin:0;padding-left:18px;color:var(--text-2);font-size:13px;display:grid;gap:6px">
          <li><b>Chrome / Edge (desktop):</b> install icon in the address bar, or Menu → Cast/Save → Install.</li>
          <li><b>Android:</b> browser menu → “Add to Home screen” / “Install app”.</li>
          <li><b>iOS Safari:</b> Share → “Add to Home Screen”.</li>
        </ul>
        <div class="note" style="margin-top:14px">${icon('info')}<span>PWA installation requires HTTPS or localhost — opening the file directly (file://) will not work.</span></div>`,
      footer: `<button type="button" class="btn btn-primary" data-close>Got it</button>`,
    });
  }
}

export function showInstallButton(evt) {
  const btn = document.querySelector('[data-install]');
  if (btn && evt) { btn.hidden = false; }
}
