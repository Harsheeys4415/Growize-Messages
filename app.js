/* GrowizeMessages — application entry point.
 * Hash router, boot sequence, PWA registration, mode handling. */

import { state, patch, applyTheme, lsGet, on } from './services/store.js';
import { api, setAuthGetter } from './services/api.js';
import * as demo from './services/demo.js';
import { refreshIcons, toast, spinnerBlock, esc } from './components/ui.js';
import { renderNavigation, updateSidebar, updateTopbar, updateDemoVisibility, showInstallButton, setUnreadCount } from './components/navigation.js';
import { isAuthVisible, showAuth, hideAuth } from './components/auth.js';
import * as supabase from './services/supabase.js';

const main = document.getElementById('main');

/* ---------- routes ---------- */
const ROUTES = {
  dashboard: () => import('./components/dashboard.js'),
  inbox: () => import('./components/inbox.js'),
  automations: () => import('./components/automations.js'),
  ai: () => import('./components/ai-settings.js'),
  logs: () => import('./components/activity-logs.js'),
  integrations: () => import('./components/integrations.js'),
  health: () => import('./components/system-health.js'),
  settings: () => import('./components/settings.js'),
  setup: () => import('./components/setup-wizard.js'),
};

let cleanup = null;
let renderSeq = 0;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  return { page: segments[0] || 'dashboard', id: segments[1] || null, params: new URLSearchParams(queryPart) };
}

async function render() {
  const seq = ++renderSeq;
  const { page, id, params } = parseHash();
  const pageId = ROUTES[page] ? page : 'dashboard';
  state.page = pageId;

  updateSidebar();
  updateTopbar();
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  main.innerHTML = spinnerBlock();
  try {
    const mod = await ROUTES[pageId]();
    if (seq !== renderSeq) return; // a newer navigation superseded this one
    const result = await mod.render(main, { id, params });
    cleanup = typeof result === 'function' ? result : null;
  } catch (err) {
    console.error('[router] render failed:', err);
    if (seq === renderSeq) {
      main.innerHTML = `
        <div class="page">
          <div class="note danger">${`<i data-lucide="circle-alert"></i>`}
            <span><b>Something went wrong loading this page.</b><br/>${esc(err?.message || 'Unknown error')}</span>
          </div>
          <p style="margin-top:12px"><a href="#/dashboard">← Back to Overview</a></p>
        </div>`;
      refreshIcons(main);
    }
  }
  refreshIcons(main);
  updateDemoVisibility();
}

window.addEventListener('hashchange', render);

/* ---------- no silent failures ---------- */
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason);
  toast(e.reason?.message || 'An unexpected error occurred', 'error');
});
window.addEventListener('error', (e) => {
  console.error('[window error]', e.error || e.message);
});

/* ---------- live mode session handling ---------- */
async function restoreLiveSession() {
  const liveCfg = lsGet('gm.live.sb', null);
  const liveEnabled = lsGet('gm.live.enabled', false);
  if (!liveEnabled || !liveCfg?.url || !liveCfg?.anonKey) return false;
  try {
    await supabase.init({ url: liveCfg.url, anonKey: liveCfg.anonKey });
    const session = await supabase.getSession();
    if (!session) { patch({ mode: 'live' }); showAuth({ allowDemo: true, notice: 'Sign in to your dashboard account to manage the live automation.' }); return true; }
    patch({ mode: 'live', user: { id: session.user.id, email: session.user.email, name: session.user.user_metadata?.name || session.user.email } });
    return true;
  } catch (err) {
    console.error('Live restore failed:', err);
    toast(`Could not restore live mode: ${err.message}. Falling back to demo mode.`, 'error', 6000);
    lsSet('gm.live.enabled', false);
    return false;
  }
}

/* ---------- auth change reaction ---------- */
on('state', async (p) => {
  if (p && 'user' in p && state.mode === 'live') {
    if (!p.user && !isAuthVisible()) showAuth({ allowDemo: true });
  }
});

/* ---------- boot ---------- */
(async function boot() {
  applyTheme(lsGet('gm.theme', 'system'));
  demo.load();
  setAuthGetter(supabase.getAccessToken);

  // live session (if previously configured)
  await restoreLiveSession();

  // load settings into global state
  try {
    state.settings = await api.getSettings();
  } catch (err) {
    console.error('settings load failed', err);
    toast(`Could not load settings: ${err.message}`, 'error');
    state.settings = demo.getSettings();
  }

  renderNavigation();
  updateDemoVisibility();

  // first run → setup wizard
  const wizardDone = lsGet('gm.wizardDone', false);
  state.wizardDone = wizardDone;
  if (!location.hash) {
    location.hash = wizardDone ? '#/dashboard' : '#/setup';
    return; // hashchange triggers render
  }
  await render();
})();

/* ---------- keep automation status fresh ---------- */
window.addEventListener('gm:automation-changed', () => { updateSidebar(); });

/* ---------- demo store → unread badge ---------- */
demo.onChange((_db, reason) => {
  if (['incoming', 'read', 'reset', 'message-queued'].includes(reason)) {
    if (state.mode === 'demo') setUnreadCount(demo.unreadCount());
  }
});

/* ---------- PWA: service worker + install prompt ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const swUrl = new URL('service-worker.js', import.meta.url).href;
    navigator.serviceWorker.register(swUrl).catch((err) => {
      console.warn('Service worker registration failed (PWA features disabled):', err);
    });
  });
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
  showInstallButton(e);
});
window.addEventListener('appinstalled', () => toast('GrowizeMessages installed', 'success'));
