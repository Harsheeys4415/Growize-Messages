/* GrowizeMessages — global state + event bus.
 * A tiny observable store: no framework, no magic. */

export const state = {
  mode: 'demo',            // 'demo' | 'live'
  theme: 'system',         // 'light' | 'dark' | 'system'
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  page: 'dashboard',
  user: null,              // { id, email, name } — live mode only
  settings: null,          // global settings (from api.getSettings)
  wizardDone: true,
  sidebarOpen: false,
  installPrompt: null,     // captured beforeinstallprompt event
};

const listeners = new Map(); // eventName -> Set<fn>

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function emit(event, detail) {
  listeners.get(event)?.forEach((fn) => {
    try { fn(detail); } catch (err) { console.error('[store] listener failed for', event, err); }
  });
  listeners.get('*')?.forEach((fn) => {
    try { fn({ event, detail }); } catch (err) { console.error('[store] listener failed for *', err); }
  });
}

export function patch(partial) {
  Object.assign(state, partial);
  emit('state', partial);
}

/* ---------- localStorage helpers (safe) ---------- */
export function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}
export function lsDel(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/* ---------- theme ---------- */
const media = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

export function applyTheme(theme = state.theme) {
  state.theme = theme;
  const resolved = theme === 'system' ? (media?.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = resolved;
  lsSet('gm.theme', theme);
  emit('theme', resolved);
}

if (media) {
  const mq = () => { if (state.theme === 'system') applyTheme('system'); };
  if (media.addEventListener) media.addEventListener('change', mq);
}

/* ---------- misc ---------- */
export function uid(prefix = 'id') {
  const c = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${c.replace(/-/g, '').slice(0, 16)}`;
}
