/* GrowizeMessages backend — Instagram Messaging API client.
 * Works with the official Instagram Messaging API (graph.instagram.com)
 * and, by configuration, the Page-hosted variant (graph.facebook.com).
 * Tokens and account ids are read from app_secrets / env — never logged.
 */

import { db, CONFIG, getSecret, SUPABASE_URL } from './lib.js';

const SEND_TIMEOUT_MS = 15000;

export async function getIgConfig() {
  const [token, accountId, baseOverride] = await Promise.all([
    getSecret('IG_ACCESS_TOKEN'),
    getSecret('IG_ACCOUNT_ID'),
    getSecret('IG_GRAPH_BASE_OVERRIDE'),
  ]);
  return {
    token,
    accountId,
    base: (baseOverride || CONFIG.igGraphBase).replace(/\/+$/, ''),
    version: CONFIG.igGraphVersion,
    configured: !!token,
  };
}

async function graphFetch(url, options = {}, timeoutMs = SEND_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!res.ok) {
      const m = body?.error || {};
      const err = new Error(m.error_user_msg || m.message || `Graph API returned ${res.status}`);
      err.metaCode = m.code;
      err.metaSubcode = m.error_subcode;
      err.metaType = m.type;
      err.status = res.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

/* ---------- identity ---------- */
export async function fetchIgProfile(igConfig) {
  if (!igConfig.token) return null;
  try {
    const me = await graphFetch(`${igConfig.base}/${igConfig.version}/me?fields=id,username,name&access_token=${encodeURIComponent(igConfig.token)}`, {}, 8000);
    return { id: me.id, username: me.username ? `@${me.username}` : null, name: me.name || null, rawId: me.id };
  } catch (err) {
    return { error: err.message };
  }
}

export async function fetchUserPermissions(igConfig) {
  if (!igConfig.token) return { permissions: [], note: 'Not checked' };
  try {
    const perms = await graphFetch(`${igConfig.base}/${igConfig.version}/me/permissions?access_token=${encodeURIComponent(igConfig.token)}`, {}, 8000);
    const granted = (perms?.data || []).filter((p) => p.status === 'granted').map((p) => p.permission);
    return { permissions: granted, note: null };
  } catch (err) {
    return { permissions: [], note: `Permission lookup unavailable: ${err.message}` };
  }
}

/* Best-effort public profile of an Instagram user (IGSID). */
export async function fetchContactProfile(igsid, igConfig) {
  try {
    const p = await graphFetch(`${igConfig.base}/${igConfig.version}/${igsid}?fields=name,username&access_token=${encodeURIComponent(igConfig.token)}`, {}, 6000);
    return { name: p.name || null, username: p.username || null };
  } catch {
    return { name: null, username: null };
  }
}

/* ---------- sending ---------- */
export async function sendIgMessage(igsid, text, igConfig) {
  if (!igConfig.token) {
    const err = new Error('No Instagram access token is configured on the backend. Connect Instagram first (Integrations → Meta).');
    err.metaCode = 'NO_TOKEN';
    throw err;
  }
  const url = `${igConfig.base}/${igConfig.version}/me/messages`;
  const res = await graphFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${igConfig.token}` },
    body: JSON.stringify({ recipient: { id: igsid }, message: { text } }),
  });
  return res; // { recipient_id, message_id }
}

/* ---------- status card ---------- */
export async function metaStatus(req) {
  const igConfig = await getIgConfig();
  const [tokenExpiresAt, storedUsername, storedAccountId] = await Promise.all([
    getSecret('IG_TOKEN_EXPIRES_AT'), getSecret('IG_USERNAME'), getSecret('IG_ACCOUNT_ID'),
  ]);

  const status = {
    status: 'disconnected',
    simulated: false,
    appId: CONFIG.metaAppId ? `${CONFIG.metaAppId.slice(0, 6)}••` : null,
    igAccountId: storedAccountId || null,
    igUsername: storedUsername || null,
    tokenStatus: igConfig.token ? 'Access token stored server-side' : 'No access token configured',
    tokenExpiresInDays: null,
    permissions: [],
    missingPermissions: [],
    webhookVerify: !!(CONFIG.metaVerifyToken && CONFIG.metaAppSecret),
    webhookUrl: `${SUPABASE_URL}/functions/v1/meta-webhook`,
    lastWebhookAt: null,
    lastEventSummary: null,
    lastCheckAt: new Date().toISOString(),
    errors: [],
  };

  if (tokenExpiresAt) {
    const days = Math.round((new Date(tokenExpiresAt).getTime() - Date.now()) / 86_400_000);
    status.tokenExpiresInDays = days;
    if (days <= 0) status.errors.push('The stored Instagram access token has expired — reconnect to refresh it.');
  }

  // last webhook info
  try {
    const { data: lastEvent } = await db().from('webhook_events').select('receivedAt').order('receivedAt', { ascending: false }).limit(1).maybeSingle();
    status.lastWebhookAt = lastEvent?.receivedAt || null;
  } catch { /* table may not exist */ }
  try {
    const { data: lastDm } = await db().from('activity_logs').select('message').eq('category', 'incoming_dm').order('at', { ascending: false }).limit(1).maybeSingle();
    status.lastEventSummary = lastDm?.message || null;
  } catch { /* ignore */ }

  if (igConfig.token) {
    const profile = await fetchIgProfile(igConfig);
    if (profile && !profile.error) {
      status.status = 'connected';
      status.igUsername = profile.username || storedUsername || profile.name || status.igUsername;
      status.igAccountId = storedAccountId || profile.rawId || profile.id;
      status.tokenStatus = 'Long-lived access token valid';
      const perm = await fetchUserPermissions(igConfig);
      status.permissions = perm.permissions;
      if (perm.note) status.errors.push(perm.note);
      const required = ['instagram_basic', 'instagram_manage_messages'];
      status.missingPermissions = required.filter((r) => !perm.permissions.includes(r));
      if (!status.igUsername) {
        await db().from('app_secrets').upsert({ name: 'IG_USERNAME', value: profile.name || profile.rawId, updatedAt: new Date().toISOString() });
      } else if (status.igUsername !== storedUsername) {
        await db().from('app_secrets').upsert({ name: 'IG_USERNAME', value: status.igUsername, updatedAt: new Date().toISOString() });
      }
    } else {
      status.errors.push(`Token check failed: ${profile?.error || 'unknown error'}`);
    }
  }
  return status;
}
