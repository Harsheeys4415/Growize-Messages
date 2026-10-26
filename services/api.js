/* GrowizeMessages — central API service.
 *
 * Two interchangeable adapters:
 *  - demo adapter: fully local, simulated data (default).
 *  - live adapter: calls your deployed backend (Supabase Edge Functions or
 *    any authenticated API implementing the contract in README.md).
 *
 * Route mapping is intentionally concentrated here so each operation can be
 * pointed at a real endpoint without touching UI components.
 *
 * Security: the live adapter attaches a Supabase access token to every
 * request, uses HTTPS only, applies timeouts, and NEVER retries a
 * message-send automatically (backend idempotency keys are required).
 */

import * as demo from './demo.js';
import { state } from './store.js';
import * as supabase from './supabase.js';

const LS_BACKEND = 'gm.live.backendBase';

let backendBase = '';
try { backendBase = localStorage.getItem(LS_BACKEND) || ''; } catch { /* ignore */ }

let authHeaderGetter = async () => null;

export function getBackendBase() { return backendBase; }
export function setBackendBase(url) {
  backendBase = (url || '').trim().replace(/\/+$/, '');
  try { localStorage.setItem(LS_BACKEND, backendBase); } catch { /* ignore */ }
}
export function setAuthGetter(fn) { authHeaderGetter = fn; }

/* ---------- low-level live request ---------- */
async function liveRequest(path, { method = 'GET', body = null, timeoutMs = 20000, idempotencyKey = null } = {}) {
  if (!backendBase) throw new ApiError('No backend base URL configured. Set it in Settings → Backend connection.', 0);
  if (!/^https:\/\//.test(backendBase) && !/localhost|127\.0\.0\.1/.test(backendBase)) {
    throw new ApiError('Backend base URL must use HTTPS.', 0);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    const token = await authHeaderGetter();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await fetch(`${backendBase}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal,
    });
    if (res.status === 401) throw new ApiError('Your session expired. Sign in again.', 401);
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try { const j = await res.json(); msg = j.error || j.message || msg; } catch { /* ignore */ }
      throw new ApiError(msg, res.status);
    }
    if (res.status === 204) return null;
    return await res.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'AbortError') throw new ApiError('The backend took too long to respond (timeout).', 408);
    throw new ApiError(`Network error: ${err.message}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

export class ApiError extends Error {
  constructor(message, status = 0, offline = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.offline = offline;
  }
}

/* ---------- live realtime (Supabase) ---------- */
let realtimeUnsubs = [];
export function subscribeRealtime(handlers = {}) {
  unsubscribeRealtime();
  if (state.mode !== 'live' || !supabase.isConfigured()) return () => {};
  const { onMessages, onActivity, onSettings } = handlers;
  if (onMessages) realtimeUnsubs.push(supabase.subscribeTable('messages', '*', (payload) => onMessages(payload)));
  if (onActivity) realtimeUnsubs.push(supabase.subscribeTable('activity_logs', '*', (payload) => onActivity(payload)));
  if (onSettings) realtimeUnsubs.push(supabase.subscribeTable('settings', '*', (payload) => onSettings(payload)));
  return unsubscribeRealtime;
}
export function unsubscribeRealtime() {
  realtimeUnsubs.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  realtimeUnsubs = [];
}

const latency = (ms = 220) => new Promise((r) => setTimeout(r, ms + Math.random() * 160));

/* ============================================================
   Public API
   ============================================================ */
export const api = {
  get mode() { return state.mode; },

  /* ----- health & connectivity ----- */
  async health() {
    if (state.mode === 'demo') { await latency(160); return { ok: true, mode: 'demo', service: 'demo-adapter', simulated: true }; }
    return liveRequest('/api/health');
  },

  /* ----- dashboard ----- */
  async dashboardSummary(range = '7d', custom = null) {
    if (state.mode === 'demo') { await latency(); return demo.dashboardSummary(range, custom); }
    const q = custom ? `&from=${encodeURIComponent(custom.from || '')}&to=${encodeURIComponent(custom.to || '')}` : '';
    return liveRequest(`/api/dashboard/summary?range=${encodeURIComponent(range)}${q}`);
  },

  /* ----- integrations ----- */
  async integrationsStatus() {
    if (state.mode === 'demo') { await latency(140); return demo.getIntegrations(); }
    return liveRequest('/api/integrations/status');
  },

  async metaStatus() {
    if (state.mode === 'demo') { await latency(120); return demo.metaStatus(); }
    return liveRequest('/api/integrations/meta/status');
  },

  metaAuthStartUrl() {
    if (state.mode === 'demo') return null;
    return `${backendBase}/api/integrations/meta/auth`;
  },

  /* ----- conversations ----- */
  async listConversations(params = {}) {
    if (state.mode === 'demo') { await latency(140); return demo.listConversations(params); }
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();
    return liveRequest(`/api/conversations${q ? `?${q}` : ''}`);
  },

  async getMessages(convId) {
    if (state.mode === 'demo') { await latency(120); return demo.getMessages(convId); }
    return liveRequest(`/api/conversations/${encodeURIComponent(convId)}/messages`);
  },

  async sendMessage(convId, text) {
    if (state.mode === 'demo') { await latency(180); return demo.sendMessage(convId, text, { manual: true }); }
    // No automatic retry: callers decide what to do after a failure.
    return liveRequest(`/api/conversations/${encodeURIComponent(convId)}/reply`, {
      method: 'POST', body: { text }, timeoutMs: 30000,
    });
  },

  async setConversationPaused(convId, paused) {
    if (state.mode === 'demo') { await latency(140); return demo.setConversationPaused(convId, paused); }
    return liveRequest(`/api/conversations/${encodeURIComponent(convId)}/${paused ? 'pause' : 'resume'}`, { method: 'POST' });
  },

  async markConversationRead(convId, read = true) {
    if (state.mode === 'demo') { await latency(100); return demo.markConversationRead(convId, read); }
    return liveRequest(`/api/conversations/${encodeURIComponent(convId)}/read`, { method: 'POST', body: { read } });
  },

  /* ----- rules ----- */
  async listRules() {
    if (state.mode === 'demo') { await latency(140); return demo.listRules(); }
    return liveRequest('/api/rules');
  },
  async createRule(rule) {
    if (state.mode === 'demo') { await latency(180); return demo.createRule(rule); }
    return liveRequest('/api/rules', { method: 'POST', body: rule });
  },
  async updateRule(id, patch) {
    if (state.mode === 'demo') { await latency(160); return demo.updateRule(id, patch); }
    return liveRequest(`/api/rules/${encodeURIComponent(id)}`, { method: 'PUT', body: patch });
  },
  async deleteRule(id) {
    if (state.mode === 'demo') { await latency(140); return demo.deleteRule(id); }
    return liveRequest(`/api/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async duplicateRule(id) {
    if (state.mode === 'demo') { await latency(160); return demo.duplicateRule(id); }
    return liveRequest(`/api/rules/${encodeURIComponent(id)}/duplicate`, { method: 'POST' });
  },
  async moveRule(id, direction) {
    if (state.mode === 'demo') { await latency(120); return demo.moveRule(id, direction); }
    return liveRequest(`/api/rules/${encodeURIComponent(id)}/priority`, { method: 'POST', body: { direction } });
  },
  async testRules(payload) {
    if (state.mode === 'demo') { await latency(240); return demo.testRules(payload.text, payload.ruleId || null); }
    return liveRequest('/api/rules/test', { method: 'POST', body: payload });
  },

  /* ----- activity logs ----- */
  async listActivity(filters = {}) {
    if (state.mode === 'demo') { await latency(160); return demo.listActivity(filters); }
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== undefined && v !== '' && v !== 'all')).toString();
    return liveRequest(`/api/activity${q ? `?${q}` : ''}`);
  },

  /* ----- settings & automation ----- */
  async getSettings() {
    if (state.mode === 'demo') { await latency(120); return demo.getSettings(); }
    return liveRequest('/api/settings');
  },
  async updateSettings(patch) {
    if (state.mode === 'demo') { await latency(180); return demo.updateSettings(patch); }
    return liveRequest('/api/settings', { method: 'PUT', body: patch });
  },
  async pauseAutomation({ emergency = false } = {}) {
    if (state.mode === 'demo') { await latency(160); demo.setAutomation(false, { emergency }); return { ok: true, automationEnabled: false, simulated: true }; }
    return liveRequest('/api/automation/pause', { method: 'POST', body: { emergency } });
  },
  async resumeAutomation() {
    if (state.mode === 'demo') { await latency(160); demo.setAutomation(true); return { ok: true, automationEnabled: true, simulated: true }; }
    return liveRequest('/api/automation/resume', { method: 'POST' });
  },

  /* ----- AI / OpenRouter ----- */
  async aiTest(sampleText) {
    if (state.mode === 'demo') { return demo.openrouterTest(sampleText); }
    return liveRequest('/api/integrations/openrouter/test', { method: 'POST', body: { message: sampleText }, timeoutMs: 40000 });
  },
  async aiConfigureKey(key, { clear = false } = {}) {
    if (state.mode === 'demo') { return demo.configureOpenRouterKey(key, { clear }); }
    return liveRequest('/api/integrations/openrouter/configure', { method: 'POST', body: clear ? { clear: true } : { apiKey: key } });
  },
  async aiFetchModels() {
    if (state.mode === 'demo') { await latency(300); return demo.fetchModels(); }
    return liveRequest('/api/integrations/openrouter/models');
  },

  /* ----- system health ----- */
  async healthChecks() {
    if (state.mode === 'demo') { await latency(260); return { checks: demo.runHealthChecks(), simulated: true }; }
    return liveRequest('/api/health/checks');
  },

  /* ----- wizard helpers (live validation) ----- */
  async wizardVerify(step, payload = {}) {
    if (state.mode === 'demo') {
      await latency(420);
      return { ok: true, simulated: true, message: 'Simulated check passed — connect a live backend for authoritative validation.' };
    }
    return liveRequest(`/api/setup/verify/${encodeURIComponent(step)}`, { method: 'POST', body: payload });
  },
};
