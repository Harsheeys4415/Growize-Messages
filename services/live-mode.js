/* GrowizeMessages — live mode connection lifecycle.
 * Shared by Settings and Integrations pages.
 *
 * A connection is only reported as ACTIVE after authoritative checks:
 *   1. Supabase client initializes and a session query succeeds.
 *   2. The backend health endpoint responds ok.
 * Entering credentials alone NEVER marks the connection as active. */

import { state, patch, lsSet, lsDel } from './store.js';
import * as supabase from './supabase.js';
import { api, setBackendBase, getBackendBase } from './api.js';
import { emit } from './store.js';

const LS_ENABLED = 'gm.live.enabled';
const LS_SB = 'gm.live.sb';

export function liveConfig() {
  return lsGet_(LS_SB);
}
export function isLiveConfigured() { return !!lsGet_(LS_ENABLED); }

function lsGet_(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } }

/**
 * Attempt to switch the app to live mode.
 * @returns {{ok: boolean, error?: string, steps: Array<{label:string, ok:boolean, detail:string}>}}
 */
export async function connectLive({ supabaseUrl, anonKey, backendBase }) {
  const steps = [];
  const fail = (error) => ({ ok: false, error, steps });

  // Reset any previous client
  lsDel(LS_ENABLED);

  // 1. Initialize Supabase client
  try {
    await supabase.init({ url: supabaseUrl.trim(), anonKey: anonKey.trim() });
    steps.push({ label: 'Supabase client initialized', ok: true, detail: supabaseUrl.trim() });
  } catch (err) {
    steps.push({ label: 'Supabase client initialized', ok: false, detail: err.message });
    return fail('Supabase initialization failed — check the project URL and anon key.');
  }

  // 2. Session query (authoritative reachability check)
  try {
    await supabase.getSession();
    steps.push({ label: 'Supabase reachable (auth endpoint)', ok: true, detail: 'Session query succeeded' });
  } catch (err) {
    steps.push({ label: 'Supabase reachable (auth endpoint)', ok: false, detail: err.message });
    return fail('Could not reach the Supabase auth endpoint — verify the URL.');
  }

  // 3. Backend health check (required before live management actions)
  setBackendBase(backendBase);
  if (backendBase && backendBase.trim()) {
    try {
      const health = await fetchHealth(backendBase.trim().replace(/\/+$/, ''));
      steps.push({ label: 'Backend health endpoint', ok: true, detail: `OK (${health.service || 'backend'})` });
    } catch (err) {
      steps.push({ label: 'Backend health endpoint', ok: false, detail: err.message });
      return fail('Backend health check failed. Live mode requires a reachable, authenticated backend — stay in demo mode until it is deployed.');
    }
  } else {
    steps.push({ label: 'Backend health endpoint', ok: false, detail: 'No backend base URL provided' });
    return fail('A backend API base URL is required for live mode. The dashboard cannot manage automation without it.');
  }

  // 4. Persist config and switch
  lsSet(LS_SB, { url: supabaseUrl.trim(), anonKey: anonKey.trim() });
  lsSet(LS_ENABLED, true);
  patch({ mode: 'live' });
  emit('mode', 'live');
  return { ok: true, steps };
}

async function fetchHealth(base) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${base}/api/health`, { signal: ctrl.signal, headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`Health endpoint returned ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Health endpoint timed out after 12s');
    throw err;
  } finally { clearTimeout(t); }
}

export async function disconnectLive() {
  try { await supabase.signOut(); } catch { /* ignore */ }
  lsDel(LS_ENABLED);
  lsDel(LS_SB);
  patch({ mode: 'demo', user: null });
  emit('mode', 'demo');
}

export function getBackendUrl() { return getBackendBase(); }
export { api };
