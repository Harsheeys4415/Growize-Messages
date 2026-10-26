/* GrowizeMessages backend — API gateway Edge Function.
 *
 * Implements the full frontend contract (README §5). Deployed as `api`,
 * reachable at https://<project>.supabase.co/functions/v1/api/...
 *
 * Auth model:
 * - /api/health and the Meta OAuth start/callback are public.
 * - Everything else requires a Supabase access token belonging to a
 *   dashboard administrator (profiles.is_admin). RLS denies direct client
 *   access; the database is only touched with the service role here.
 *
 * CORS is handled for every response (the dashboard is hosted on a
 * different origin, e.g. GitHub Pages).
 */

import {
  json, html, fail, preflight, uid, readJson, deepMerge, maskKey,
  requireAdmin, getSettingsRow, updateSettingsData, logActivity,
  db, setSecret, corsHeaders, timingSafeEqual, hmacSha256Hex,
  SUPABASE_URL, CONFIG,
} from '../_shared/lib.js';
import { matchRules, matchRule, applyTemplate, TRIGGER_TYPES, REPLY_MODES } from '../_shared/rules.mjs';
import {
  dashboardSummary, healthChecks, sendOutbound, getConversation, convLabel,
} from '../_shared/engine.js';
import { getIgConfig, metaStatus, fetchIgProfile } from '../_shared/ig.js';
import * as ai from '../_shared/ai.js';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight(req);

  let route = '';
  try {
    const url = new URL(req.url);
    const m = url.pathname.match(/\/api\/?(.*)$/);
    route = '/' + (m ? m[1] : '').replace(/^\/+|\/+$/g, '');
    return await routeRequest(req, route, url);
  } catch (err) {
    console.error('api error', route, err);
    if (err?.message === 'AUTH') return fail(req, 401, 'Your session expired. Sign in again.');
    return fail(req, err?.status || 500, err?.message || 'Internal server error');
  }
});

async function routeRequest(req, route, url) {
  const method = req.method;
  const seg = route.split('/').filter(Boolean);

  /* ---------- public: liveness ---------- */
  if ((route === '/health' || route === '/') && method === 'GET') {
    return json(req, { ok: true, service: 'growize-engine', time: new Date().toISOString() });
  }

  /* ---------- public: Meta OAuth start ---------- */
  if (route === '/integrations/meta/auth' && method === 'GET') {
    return metaAuthStart(req, url);
  }

  const auth = await requireAdmin(req);
  if (!auth.ok) return fail(req, auth.status, auth.error);
  const me = auth.user;

  /* ---------- dashboard ---------- */
  if (route === '/dashboard/summary' && method === 'GET') {
    const range = url.searchParams.get('range') || '7d';
    const from = url.searchParams.get('from') || null;
    const to = url.searchParams.get('to') || null;
    return json(req, await dashboardSummary(range, from, to));
  }

  /* ---------- integrations: status ---------- */
  if (route === '/integrations/status' && method === 'GET') {
    const [meta, orKey, settingsRow] = await Promise.all([metaStatus(req), ai.keyStatus(), getSettingsRow()]);
    const orLast = await db().from('activity_logs').select('at').eq('category', 'ai_request_started').order('at', { ascending: false }).limit(1).maybeSingle();
    return json(req, {
      meta,
      supabase: {
        status: 'connected', simulated: false,
        projectUrl: SUPABASE_URL, anonKeyConfigured: true,
        backendBase: `${SUPABASE_URL}/functions/v1`,
        health: 'ok', lastSyncAt: settingsRow.updatedAt || null,
        note: '', errors: [], lastCheckAt: new Date().toISOString(),
      },
      openrouter: {
        status: orKey.configured ? 'connected' : 'not_configured', simulated: false,
        keyConfigured: orKey.configured, keyMask: orKey.keyMask,
        model: settingsRow.data.ai?.model || null,
        lastRequestAt: orLast?.at || null,
        lastTestAt: settingsRow.data.ai?.lastTestAt || null,
        usageNote: 'Usage is computed from real API responses — see Overview for tokens and estimated cost.',
        lastCheckAt: new Date().toISOString(),
        errors: [],
      },
    });
  }

  if (route === '/integrations/meta/status' && method === 'GET') {
    return json(req, await metaStatus(req));
  }

  /* ---------- integrations: manual Meta token ---------- */
  if (route === '/integrations/meta/token' && method === 'POST') {
    const body = await readJson(req);
    const token = String(body.accessToken || '').trim();
    if (!token) return fail(req, 400, 'accessToken is required.');
    const base = (String(body.graphBase || 'https://graph.instagram.com')).replace(/\/+$/, '');
    const version = String(body.graphVersion || CONFIG.igGraphVersion);
    // Validate the token against the configured graph host before storing it.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    let identity = null;
    try {
      const res = await fetch(`${base}/${version}/me?fields=id,name,username&access_token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
      identity = await res.json().catch(() => ({}));
      if (!res.ok) {
        return fail(req, 400, `Meta rejected this token: ${identity?.error?.message || res.status}`);
      }
    } catch (err) {
      return fail(req, 400, `Could not validate the token (${err.message}).`);
    } finally { clearTimeout(t); }

    await setSecret('IG_ACCESS_TOKEN', token);
    await setSecret('IG_ACCOUNT_ID', body.igAccountId || identity.id || null);
    await setSecret('IG_USERNAME', identity.username ? `@${identity.username}` : (identity.name || null));
    await setSecret('IG_GRAPH_BASE_OVERRIDE', base === CONFIG.igGraphBase ? null : base);
    await logActivity({
      category: 'integration_connected', status: 'success',
      message: `Instagram access token stored server-side (account ${identity.username ? '@' + identity.username : identity.id})`,
    });
    return json(req, { ok: true, status: 'connected', igAccountId: identity.id, igUsername: identity.username ? `@${identity.username}` : null });
  }

  /* ---------- integrations: OpenRouter ---------- */
  if (route === '/integrations/openrouter/test' && method === 'POST') {
    const body = await readJson(req);
    const text = String(body.message || '').trim();
    if (!text) return fail(req, 400, 'message is required.');
    const settingsRow = await getSettingsRow();
    const s = settingsRow.data;
    if (!s.ai?.enabled) return json(req, { ok: false, error: 'AI assistant is disabled in settings. Enable it to run this test.' });
    const started = Date.now();
    try {
      const out = await ai.chatCompletion({
        model: s.ai.model || s.ai.customModel || 'openai/gpt-4o-mini',
        messages: ai.buildMessages({ systemPrompt: s.ai.systemPrompt, instruction: null, history: [], incomingText: text, maxInputChars: s.ai.maxInputChars }),
        maxTokens: s.ai.maxTokens, temperature: s.ai.temperature, timeoutMs: s.ai.timeoutMs, retries: s.ai.retries,
      });
      await updateSettingsData({ ai: { lastTestAt: new Date().toISOString(), lastTestResult: 'ok' } });
      return json(req, {
        ok: true, reply: out.text, model: out.model, tokensIn: out.tokensIn, tokensOut: out.tokensOut,
        latencyMs: Date.now() - started, at: new Date().toISOString(),
      });
    } catch (err) {
      await updateSettingsData({ ai: { lastTestAt: new Date().toISOString(), lastTestResult: 'failed' } });
      return json(req, { ok: false, error: err.message });
    }
  }

  if (route === '/integrations/openrouter/configure' && method === 'POST') {
    const body = await readJson(req);
    if (body.clear) {
      await setSecret('OPENROUTER_API_KEY', null);
      await updateSettingsData({ ai: { keyConfigured: false, keyMask: null } });
      await logActivity({ category: 'integration_connected', status: 'info', message: 'OpenRouter credential removed (server-side)' });
      return json(req, { ok: true, keyConfigured: false });
    }
    const key = String(body.apiKey || '').trim();
    if (!key) return fail(req, 400, 'apiKey is required (or send { clear: true }).');
    await setSecret('OPENROUTER_API_KEY', key);
    const mask = maskKey(key);
    await updateSettingsData({ ai: { keyConfigured: true, keyMask: mask } });
    await logActivity({ category: 'integration_connected', status: 'success', message: `OpenRouter credential stored server-side (${mask})` });
    return json(req, { ok: true, keyConfigured: true, keyMask: mask });
  }

  if (route === '/integrations/openrouter/models' && method === 'GET') {
    const key = await ai.getKey();
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return fail(req, res.status, body?.error?.message || `OpenRouter returned ${res.status}`);
    return json(req, {
      models: (body?.data || []).map((m) => ({ id: m.id, name: m.name || m.id })),
    });
  }

  /* ---------- conversations ---------- */
  if (seg[0] === 'conversations' && seg.length === 1 && method === 'GET') {
    const search = url.searchParams.get('search') || '';
    const filter = url.searchParams.get('filter') || 'all';
    let q = db().from('conversations').select('*').order('lastMessageAt', { ascending: false });
    if (filter === 'unread') q = q.gt('unread', 0);
    if (filter === 'paused') q = q.eq('paused', true);
    if (search) q = q.or(`name.ilike.%${search}%,username.ilike.%${search}%,lastMessagePreview.ilike.%${search}%`);
    const { data, error } = await q.limit(500);
    if (error) return fail(req, 500, error.message);
    return json(req, data || []);
  }

  if (seg[0] === 'conversations' && seg[2] === 'messages' && method === 'GET') {
    const { data, error } = await db().from('messages').select('*').eq('conversationId', seg[1]).order('at', { ascending: true }).limit(500);
    if (error) return fail(req, 500, error.message);
    return json(req, data || []);
  }

  if (seg[0] === 'conversations' && seg[2] === 'reply' && method === 'POST') {
    const body = await readJson(req);
    const text = String(body.text || '').trim();
    if (!text) return fail(req, 400, 'Reply text is required.');
    if (text.length > 1000) return fail(req, 400, 'Reply exceeds the 1000 character limit.');
    const conv = await getConversation(seg[1]);
    if (!conv) return fail(req, 404, 'Conversation not found');
    const correlationId = uid('corr');
    const out = await sendOutbound({
      conv, text, manual: true, correlationId, source: 'manual',
    });
    return json(req, out, out.status === 'failed' ? 200 : 200);
  }

  if (seg[0] === 'conversations' && (seg[2] === 'pause' || seg[2] === 'resume') && method === 'POST') {
    const conv = await getConversation(seg[1]);
    if (!conv) return fail(req, 404, 'Conversation not found');
    const paused = seg[2] === 'pause';
    const { data, error } = await db().from('conversations').update({ paused }).eq('id', conv.id).select('*').single();
    if (error) return fail(req, 500, error.message);
    await logActivity({
      category: paused ? 'automation_paused' : 'automation_resumed', status: 'info',
      conversationId: conv.id, conversationName: convLabel(conv),
      message: paused ? `Automation paused for @${conv.username}` : `Automation resumed for @${conv.username}`,
      detail: paused ? 'Paused by an administrator from the inbox.' : 'Resumed by an administrator from the inbox.',
    });
    return json(req, { ok: true, conversation: data });
  }

  if (seg[0] === 'conversations' && seg[2] === 'read' && method === 'POST') {
    const body = await readJson(req);
    const read = body.read !== false;
    const { data, error } = await db().from('conversations')
      .update({ unread: read ? 0 : 1 }).eq('id', seg[1]).select('*').single();
    if (error) return fail(req, 500, error.message);
    if (!data) return fail(req, 404, 'Conversation not found');
    return json(req, { ok: true });
  }

  /* ---------- rules ---------- */
  if (route === '/rules' && method === 'GET') {
    const { data, error } = await db().from('rules').select('*').order('priority', { ascending: true });
    if (error) return fail(req, 500, error.message);
    return json(req, (data || []).map(normalizeRule));
  }

  if (route === '/rules' && method === 'POST') {
    const body = await readJson(req);
    const errText = validateRulePayload(body);
    if (errText) return fail(req, 400, errText);
    const { data: maxRow } = await db().from('rules').select('priority').neq('triggerType', 'fallback').order('priority', { ascending: false }).limit(1);
    const rule = {
      id: uid('rule'),
      name: String(body.name || '').trim() || 'Untitled rule',
      description: String(body.description || ''),
      enabled: body.enabled ?? true,
      priority: Number.isInteger(body.priority) ? body.priority : (maxRow?.[0]?.priority ?? 0) + 1,
      triggerType: body.triggerType || 'contains',
      keywords: Array.isArray(body.keywords) ? body.keywords.map(String) : [],
      excludedKeywords: Array.isArray(body.excludedKeywords) ? body.excludedKeywords.map(String) : [],
      caseSensitive: !!body.caseSensitive,
      replyMode: body.replyMode || 'predefined',
      replyText: String(body.replyText || ''),
      aiInstruction: String(body.aiInstruction || ''),
      cooldownMins: Math.max(0, Number(body.cooldownMins) || 0),
      triggerCount: 0,
      lastTriggeredAt: null,
      createdAt: new Date().toISOString(),
    };
    const { data, error } = await db().from('rules').insert(rule).select('*').single();
    if (error) return fail(req, 500, error.message);
    await logActivity({ category: 'system', status: 'info', ruleId: rule.id, ruleName: rule.name, message: `Rule created: "${rule.name}"` });
    return json(req, normalizeRule(data), 201);
  }

  if (seg[0] === 'rules' && seg[1] && seg.length === 2) {
    if (method === 'PUT') {
      const body = await readJson(req);
      const errText = validateRulePayload(body, { partial: true });
      if (errText) return fail(req, 400, errText);
      const patch = {};
      for (const k of ['name', 'description', 'enabled', 'priority', 'triggerType', 'keywords', 'excludedKeywords', 'caseSensitive', 'replyMode', 'replyText', 'aiInstruction', 'cooldownMins']) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      patch.updatedAt = new Date().toISOString();
      const { data, error } = await db().from('rules').update(patch).eq('id', seg[1]).select('*').single();
      if (error || !data) return fail(req, error ? 500 : 404, error ? error.message : 'Rule not found');
      return json(req, normalizeRule(data));
    }
    if (method === 'DELETE') {
      const { error } = await db().from('rules').delete().eq('id', seg[1]);
      if (error) return fail(req, 500, error.message);
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
  }

  if (seg[0] === 'rules' && seg[2] === 'duplicate' && method === 'POST') {
    const { data: src } = await db().from('rules').select('*').eq('id', seg[1]).maybeSingle();
    if (!src) return fail(req, 404, 'Rule not found');
    const copy = {
      ...src, id: uid('rule'), name: `${src.name} (copy)`,
      triggerCount: 0, lastTriggeredAt: null, enabled: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const { data, error } = await db().from('rules').insert(copy).select('*').single();
    if (error) return fail(req, 500, error.message);
    return json(req, normalizeRule(data), 201);
  }

  if (seg[0] === 'rules' && seg[2] === 'priority' && method === 'POST') {
    const body = await readJson(req);
    const direction = body.direction === 'up' ? 'up' : 'down';
    const { data: all } = await db().from('rules').select('id, priority').order('priority', { ascending: true });
    const sorted = all || [];
    const idx = sorted.findIndex((r) => r.id === seg[1]);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (idx < 0) return fail(req, 404, 'Rule not found');
    if (swapIdx < 0 || swapIdx >= sorted.length) {
      const { data } = await db().from('rules').select('*').order('priority', { ascending: true });
      return json(req, (data || []).map(normalizeRule));
    }
    const a = sorted[idx], b = sorted[swapIdx];
    await db().from('rules').update({ priority: b.priority, updatedAt: new Date().toISOString() }).eq('id', a.id);
    await db().from('rules').update({ priority: a.priority, updatedAt: new Date().toISOString() }).eq('id', b.id);
    const { data } = await db().from('rules').select('*').order('priority', { ascending: true });
    return json(req, (data || []).map(normalizeRule));
  }

  if (route === '/rules/test' && method === 'POST') {
    return ruleTest(req);
  }

  /* ---------- activity ---------- */
  if (route === '/activity' && method === 'GET') {
    const sp = url.searchParams;
    let q = db().from('activity_logs').select('*', { count: 'exact' });
    if (sp.get('q')) q = q.or(`message.ilike.%${sp.get('q')}%,detail.ilike.%${sp.get('q')}%,conversationName.ilike.%${sp.get('q')}%`);
    if (sp.get('category') && sp.get('category') !== 'all') q = q.eq('category', sp.get('category'));
    if (sp.get('status') && sp.get('status') !== 'all') q = q.eq('status', sp.get('status'));
    if (sp.get('convId')) q = q.eq('conversationId', sp.get('convId'));
    if (sp.get('ruleId')) q = q.eq('ruleId', sp.get('ruleId'));
    if (sp.get('from')) q = q.gte('at', `${sp.get('from')}T00:00:00Z`);
    if (sp.get('to')) q = q.lte('at', `${sp.get('to')}T23:59:59Z`);
    const perPage = 20;
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const { data, count, error } = await q.order('at', { ascending: false }).range((page - 1) * perPage, page * perPage - 1);
    if (error) return fail(req, 500, error.message);
    const total = count || 0;
    return json(req, { rows: data || [], total, page, pages: Math.max(1, Math.ceil(total / perPage)) });
  }

  /* ---------- settings & automation ---------- */
  if (route === '/settings' && method === 'GET') {
    const row = await getSettingsRow();
    return json(req, row.data);
  }

  if (route === '/settings' && method === 'PUT') {
    const body = await readJson(req);
    const next = await updateSettingsData(body);
    if (body.automationEnabled !== undefined) {
      await logActivity({
        category: body.automationEnabled ? 'automation_resumed' : 'automation_paused', status: 'info',
        message: body.automationEnabled ? 'Global automation resumed from Settings' : 'Global automation paused from Settings',
        detail: 'The engine checks this flag before processing any automated reply.',
      });
    }
    return json(req, next);
  }

  if (route === '/automation/pause' && method === 'POST') {
    const body = await readJson(req);
    await updateSettingsData({ automationEnabled: false });
    await logActivity({
      category: 'automation_paused', status: 'info',
      message: body?.emergency ? 'EMERGENCY PAUSE activated — all automated replies stopped' : 'Global automation paused',
      detail: 'Persisted in the backend; the engine checks this flag before every automated reply.',
    });
    return json(req, { ok: true, automationEnabled: false });
  }

  if (route === '/automation/resume' && method === 'POST') {
    await updateSettingsData({ automationEnabled: true });
    await logActivity({
      category: 'automation_resumed', status: 'info',
      message: 'Global automation resumed', detail: 'Persisted in the backend; the engine checks this flag before every automated reply.',
    });
    return json(req, { ok: true, automationEnabled: true });
  }

  /* ---------- system health ---------- */
  if (route === '/health/checks' && method === 'GET') {
    return json(req, { checks: await healthChecks() });
  }

  /* ---------- setup wizard verification ---------- */
  if (seg[0] === 'setup' && seg[1] === 'verify' && seg[2] && method === 'POST') {
    return wizardVerify(req, seg[2], me);
  }

  return fail(req, 404, `No route for ${method} ${route}`);
}

/* ================= handler helpers ================= */

function normalizeRule(r) {
  return { ...r, keywords: r.keywords || [], excludedKeywords: r.excludedKeywords || [] };
}

function validateRulePayload(body, { partial = false } = {}) {
  if (!partial || body.triggerType !== undefined) {
    if (!TRIGGER_TYPES.includes(body.triggerType)) return `Unknown trigger type "${body.triggerType}".`;
  }
  if (!partial || body.replyMode !== undefined) {
    if (!REPLY_MODES.includes(body.replyMode)) return `Unknown reply mode "${body.replyMode}".`;
  }
  if (body.triggerType === 'regex' && Array.isArray(body.keywords) && body.keywords.length) {
    const v = matchRule({ triggerType: 'regex', enabled: true, caseSensitive: false, keywords: [body.keywords[0]] }, 'probe');
    if (v.reason?.startsWith('Unsafe/invalid regex')) return v.reason.replace('Unsafe/invalid regex: ', '');
  }
  if (body.replyMode === 'predefined' && body.replyText !== undefined && !String(body.replyText).trim() && !partial) {
    return 'A predefined rule needs reply text.';
  }
  if (body.priority !== undefined && (!Number.isInteger(body.priority) || body.priority < 1)) {
    return 'Priority must be a positive integer.';
  }
  return null;
}

async function ruleTest(req) {
  const body = await readJson(req);
  const text = String(body.text ?? '');
  const ruleId = body.ruleId || null;
  if (!text.trim()) return fail(req, 400, 'Enter a sample message to test.');
  if (text.length > 4000) return fail(req, 400, 'Sample message exceeds 4000 characters.');

  const { data: rulesRaw } = await db().from('rules').select('*');
  const rules = (rulesRaw || []).map(normalizeRule);
  const sampleVars = { name: 'Sample', username: '@sampleuser' };

  const previewFor = async (rule) => {
    if (rule.replyMode === 'predefined') {
      const t = applyTemplate(rule.replyText, sampleVars);
      return { mode: 'predefined', text: t.text, unresolved: t.unresolved };
    }
    const settingsRow = await getSettingsRow();
    const s = settingsRow.data;
    const model = s.ai?.model || s.ai?.customModel || 'openai/gpt-4o-mini';
    if (!s.ai?.keyConfigured) {
      return {
        mode: rule.replyMode, text: null, model,
        note: 'No OpenRouter key is configured on the backend yet — set it from the AI Assistant page (stored server-side) and re-run this test for a real AI preview.',
      };
    }
    try {
      const out = await ai.chatCompletion({
        model,
        messages: ai.buildMessages({
          systemPrompt: s.ai.systemPrompt,
          instruction: rule.replyMode === 'ai_instruction' ? rule.aiInstruction : null,
          history: [], incomingText: text, maxInputChars: s.ai.maxInputChars,
        }),
        maxTokens: s.ai.maxTokens, temperature: s.ai.temperature, timeoutMs: s.ai.timeoutMs, retries: s.ai.retries,
      });
      return { mode: rule.replyMode, text: out.text, model: out.model, note: 'Live AI preview generated by the backend via OpenRouter. Nothing was sent to any recipient.' };
    } catch (err) {
      return { mode: rule.replyMode, text: null, model, note: `AI preview failed: ${err.message}` };
    }
  };

  if (ruleId) {
    const rule = rules.find((r) => r.id === ruleId);
    if (!rule) return fail(req, 404, 'Rule not found');
    const res = matchRule(rule, text);
    return json(req, {
      ok: true,
      winner: res.matched ? { rule, reason: res.reason, isFallback: rule.triggerType === 'fallback' } : null,
      evaluated: [{ ruleId: rule.id, ruleName: rule.name, matched: res.matched, reason: res.reason }],
      reply: res.matched ? await previewFor(rule) : null,
    });
  }

  const { winner, evaluated } = matchRules(rules, text);
  return json(req, {
    ok: true,
    winner: winner ? { rule: winner.rule, reason: winner.reason, isFallback: winner.isFallback } : null,
    evaluated,
    reply: winner ? await previewFor(winner.rule) : null,
  });
}

/* ================= Meta OAuth ================= */

function browserWantsHtml(req) {
  const accept = req.headers.get('accept') || '';
  return accept.includes('text/html');
}

async function metaAuthStart(req, url) {
  if (!CONFIG.metaAppId || !CONFIG.metaAppSecret) {
    const msg = 'Meta OAuth is not configured on this backend. Set the META_APP_ID and META_APP_SECRET secrets (supabase secrets set …), then add this callback URL in your Meta app settings: ' + `${SUPABASE_URL}/functions/v1/meta-oauth`;
    if (browserWantsHtml(req)) {
      return html(req, `<!doctype html><meta charset="utf-8"><title>GrowizeMessages</title>
        <body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px;line-height:1.5">
        <h2>Meta OAuth is not configured</h2><p>${msg}</p>
        <p>Alternatively, an administrator can paste a long-lived access token via the API (POST /api/integrations/meta/token).</p></body>`);
    }
    return fail(req, 400, msg);
  }
  const origin = url.searchParams.get('redirect') || '';
  const stateTs = Date.now().toString();
  const statePayload = `${stateTs}.${origin.replace(/[^a-zA-Z0-9.:\-\/]/g, '')}`;
  const sig = await hmacSha256Hex(CONFIG.metaAppSecret, statePayload);
  const stateB64 = btoa(statePayload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const state = `${stateB64}.${sig}`;
  const cb = `${SUPABASE_URL}/functions/v1/meta-oauth`;
  const dialog = new URL('https://www.facebook.com/v21.0/dialog/oauth');
  dialog.searchParams.set('client_id', CONFIG.metaAppId);
  dialog.searchParams.set('redirect_uri', cb);
  dialog.searchParams.set('state', state);
  dialog.searchParams.set('scope', 'pages_show_list,instagram_basic,instagram_manage_messages,pages_manage_metadata,pages_read_engagement,pages_messaging');
  return new Response(null, { status: 302, headers: { Location: dialog.toString(), ...corsHeaders(req) } });
}

async function wizardVerify(req, step, me) {
  const settingsRow = await getSettingsRow();
  const s = settingsRow.data;
  switch (step) {
    case 'auth':
      return json(req, { ok: true, message: `Signed in as ${me.email} (administrator).` });
    case 'supabase':
      return json(req, { ok: true, message: `Database reachable — settings row loaded (project ${SUPABASE_URL.replace('https://', '').split('.')[0]}).` });
    case 'instagram': {
      const igConfig = await getIgConfig();
      if (!igConfig.token) return json(req, { ok: false, message: 'No Instagram access token is stored. Connect via Integrations → Meta (OAuth or manual token).' });
      const profile = await fetchIgProfile(igConfig);
      if (profile?.error) return json(req, { ok: false, message: `Token check failed: ${profile.error}` });
      return json(req, { ok: true, message: `Connected as ${profile?.username || profile?.name || 'Instagram account'}.` });
    }
    case 'openrouter': {
      const st = await ai.keyStatus();
      return st.configured
        ? json(req, { ok: true, message: `OpenRouter credential configured (${st.keyMask}).` })
        : json(req, { ok: false, message: 'No OpenRouter key stored. Set it from the AI Assistant page or via `supabase secrets set OPENROUTER_API_KEY=…`.' });
    }
    case 'backend':
      return json(req, { ok: true, message: 'You are talking to the automation backend — health endpoint reachable.' });
    case 'webhook':
      return (CONFIG.metaAppSecret && CONFIG.metaVerifyToken)
        ? json(req, { ok: true, message: `Webhook secrets present. Point Meta at ${SUPABASE_URL}/functions/v1/meta-webhook and use the same verify token.` })
        : json(req, { ok: false, message: 'META_APP_SECRET / META_VERIFY_TOKEN secrets are missing. Set them, then configure the webhook in the Meta App Dashboard.' });
    case 'test-event': {
      const { data: last } = await db().from('webhook_events').select('receivedAt').order('receivedAt', { ascending: false }).limit(1).maybeSingle();
      return last?.receivedAt
        ? json(req, { ok: true, message: `Webhook is receiving events — last one arrived ${last.receivedAt}.` })
        : json(req, { ok: false, message: 'No webhook events received yet. Send a DM to your connected Instagram account, then re-run this check.' });
    }
    case 'enable':
      return json(req, {
        ok: true,
        message: s.automationEnabled
          ? 'Automation is ENABLED — the engine will reply to matching inbound messages.'
          : 'Automation is currently PAUSED. Resume it from Settings or the Overview page when you are ready.',
      });
    default:
      return fail(req, 404, `Unknown wizard step "${step}"`);
  }
}
