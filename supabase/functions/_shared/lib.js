/* GrowizeMessages backend — shared runtime library.
 * Environment & secret access, CORS, HTTP helpers, admin authentication,
 * the service-role database client and the activity logger.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

/* ---------- environment ---------- */
export const env = {
  get(key, fallback = null) {
    try { const v = Deno.env.get(key); return v && v.length ? v : fallback; } catch { return fallback; }
  },
};

export const SUPABASE_URL = env.get('SUPABASE_URL');
export const SERVICE_ROLE = env.get('SUPABASE_SERVICE_ROLE_KEY');

export const CONFIG = {
  openrouterKeyEnv: env.get('OPENROUTER_API_KEY'),
  metaAppId: env.get('META_APP_ID'),
  metaAppSecret: env.get('META_APP_SECRET'),
  metaVerifyToken: env.get('META_VERIFY_TOKEN'),
  igGraphBase: env.get('IG_GRAPH_BASE') || 'https://graph.instagram.com',
  igGraphVersion: env.get('IG_GRAPH_VERSION') || 'v21.0',
  allowedOrigins: (env.get('ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim()).filter(Boolean),
};

/* ---------- database (service role — bypasses RLS) ---------- */
let _admin = null;
export function db() {
  if (!_admin) {
    _admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _admin;
}

/* ---------- CORS ---------- */
export function corsHeaders(req) {
  const origin = req.headers.get('origin') || '*';
  const allowed = CONFIG.allowedOrigins.length === 0 || CONFIG.allowedOrigins.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : CONFIG.allowedOrigins[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, idempotency-key',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(req) },
  });
}

export function html(req, body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(req) },
  });
}

export function preflight(req) {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function fail(req, status, message, extra = {}) {
  return json(req, { error: message, ...extra }, status);
}

/* ---------- misc helpers ---------- */
export function uid(prefix = 'id') {
  const rnd = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${rnd}`;
}

export function maskKey(key) {
  const k = String(key || '');
  if (!k) return null;
  return `${k.slice(0, 8)}${'•'.repeat(14)}${k.slice(-4)}`;
}

export async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}

export function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* ---------- secrets (app_secrets table overrides env; 60s cache) ---------- */
const secretCache = new Map(); // name -> { value, at }
const SECRET_TTL = 60_000;

export async function getSecret(name) {
  const hit = secretCache.get(name);
  if (hit && Date.now() - hit.at < SECRET_TTL) return hit.value;
  let value = null;
  try {
    const { data } = await db().from('app_secrets').select('value').eq('name', name).maybeSingle();
    if (data?.value) value = data.value;
  } catch { /* table may not exist yet — fall through to env */ }
  if (!value) {
    const envMap = {
      OPENROUTER_API_KEY: CONFIG.openrouterKeyEnv,
      META_APP_ID: CONFIG.metaAppId,
      META_APP_SECRET: CONFIG.metaAppSecret,
      META_VERIFY_TOKEN: CONFIG.metaVerifyToken,
      IG_ACCESS_TOKEN: env.get('IG_ACCESS_TOKEN'),
      IG_ACCOUNT_ID: env.get('IG_ACCOUNT_ID'),
    };
    value = envMap[name] || null;
  }
  secretCache.set(name, { value, at: Date.now() });
  return value;
}

export async function setSecret(name, value) {
  if (value === null) {
    await db().from('app_secrets').delete().eq('name', name);
  } else {
    await db().from('app_secrets').upsert({ name, value, updatedAt: new Date().toISOString() });
  }
  secretCache.delete(name);
}

export function clearSecretCache() { secretCache.clear(); }

/* ---------- authentication ---------- */
export async function requireAdmin(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return { ok: false, status: 401, error: 'Missing access token. Sign in to the dashboard.' };

  const client = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error } = await client.auth.getUser(token);
  if (error || !userData?.user) return { ok: false, status: 401, error: 'Your session expired. Sign in again.' };
  const user = userData.user;

  let { data: profile } = await db().from('profiles').select('id, email, is_admin').eq('id', user.id).maybeSingle();
  if (!profile) {
    const { data: anyProfile } = await db().from('profiles').select('id').limit(1);
    const isFirst = !anyProfile || anyProfile.length === 0;
    const email = user.email || user.user_metadata?.email || null;
    const ins = await db().from('profiles').insert({ id: user.id, email, is_admin: isFirst }).select('id, email, is_admin').single();
    profile = ins.data;
  }
  if (!profile?.is_admin) return { ok: false, status: 403, error: 'Only dashboard administrators can access this API.' };
  return { ok: true, user: { id: user.id, email: profile.email || user.email }, profile };
}

/* ---------- settings ---------- */
export const DEFAULT_SETTINGS = {
  appName: 'GrowizeMessages',
  automationEnabled: false,
  defaultReplyMode: 'ai',
  fallbackResponse: "Sorry, we couldn't generate a reply right now — a team member will follow up with you soon!",
  globalCooldownMins: 10,
  maxRepliesPerConversation: 3,
  repliesWindowMins: 60,
  timezone: 'system',
  language: 'en',
  notifications: { desktop: false, sound: false },
  ai: {
    enabled: true,
    provider: 'OpenRouter',
    model: 'openai/gpt-4o-mini',
    customModel: '',
    systemPrompt: 'You are the assistant for Growize, a sustainable gardening brand helping people grow food in small spaces. Be warm, concise and practical. Answer questions about products, prices, delivery and workshops. Never invent order details, tracking events or medical claims. If a question needs human judgment, say a team member will follow up.',
    maxTokens: 400,
    temperature: 0.7,
    contextMessages: 10,
    maxInputChars: 2000,
    timeoutMs: 20000,
    retries: 2,
    fallbackReply: 'Thanks for your message! A human teammate will jump in shortly.',
    keyConfigured: false,
    keyMask: null,
    lastTestAt: null,
    lastTestResult: null,
    pricing: { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  },
};

export async function getSettingsRow() {
  const { data } = await db().from('settings').select('*').eq('id', 1).maybeSingle();
  if (data?.data) return { ...data, data: deepMerge(DEFAULT_SETTINGS, data.data) };
  const seed = await db().from('settings').upsert({ id: 1, data: DEFAULT_SETTINGS }).select('*').single();
  return { ...seed, data: deepMerge(DEFAULT_SETTINGS, seed?.data ?? {}) };
}

export async function updateSettingsData(patch) {
  const row = await getSettingsRow();
  const next = deepMerge(row.data, patch);
  const { data, error } = await db().from('settings').update({ data: next, updatedAt: new Date().toISOString() }).eq('id', 1).select('*').single();
  if (error) throw new Error(error.message);
  return deepMerge(DEFAULT_SETTINGS, data.data);
}

/* ---------- activity logging ---------- */
export async function logActivity(entry) {
  const row = {
    id: uid('log'),
    at: entry.at || new Date().toISOString(),
    category: entry.category,
    status: entry.status || 'success',
    conversationId: entry.conversationId || null,
    conversationName: entry.conversationName || null,
    ruleId: entry.ruleId || null,
    ruleName: entry.ruleName || null,
    message: entry.message,
    detail: entry.detail || null,
    correlationId: entry.correlationId || null,
  };
  try { await db().from('activity_logs').insert(row); } catch (e) { console.error('activity log failed', e); }
  return row;
}

/* ---------- timing-safe string compare ---------- */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
