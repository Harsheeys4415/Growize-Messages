/* GrowizeMessages backend — Meta OAuth start/callback Edge Function.
 *
 * Deployed as `meta-oauth` with verify_jwt = false.
 * Redirect URI to register in the Meta App Dashboard (Settings → Basic):
 *   https://<project>.supabase.co/functions/v1/meta-oauth
 *
 * Flow:
 *   1. The dashboard opens  /functions/v1/api/integrations/meta/auth
 *   2. That redirects here (?action=start) → 302 to the Meta consent dialog
 *   3. Meta calls back with ?code&state → code exchange → long-lived token
 *      → locate the Facebook Page with the linked Instagram professional
 *      account → store the Page access token + ids server-side (app_secrets)
 *   4. A small HTML page confirms the result.
 *
 * Tokens are never rendered to the browser — only a masked summary.
 */

import {
  db, setSecret, getSecret, logActivity, hmacSha256Hex, timingSafeEqual, maskKey, CONFIG,
} from '../_shared/lib.js';

const FB = 'https://graph.facebook.com/v21.0';

const page = (title, body, ok = true) => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GrowizeMessages — ${title}</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:70px auto;padding:0 24px;line-height:1.6;color:#1a2b1f">
<div style="border:1px solid ${ok ? '#bfe3c8' : '#f0c4c4'};background:${ok ? '#f2faf4' : '#fdf4f4'};border-radius:14px;padding:28px">
<h1 style="font-size:20px;margin:0 0 12px">${ok ? '✅' : '⚠️'} ${title}</h1>
<div style="font-size:14px;color:#31473a">${body}</div>
<p style="font-size:13px;margin-top:22px;color:#6b7f72">You can close this window and return to GrowizeMessages. Use the Integrations page → “Check status” to confirm the connection.</p>
</div></body></html>`, {
  status: ok ? 200 : 400,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
});

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error_description');

  if (errorParam) return page('Meta consent was not completed', `<p>${escapeHtml(errorParam)}</p>`, false);

  /* ---------- start ---------- */
  if (!code) {
    const appId = CONFIG.metaAppId;
    const appSecret = CONFIG.metaAppSecret;
    if (!appId || !appSecret) {
      return page('OAuth is not configured yet', `
        <p>Two secrets are missing on the backend:</p>
        <pre style="background:#0e1f14;color:#cfe8d6;padding:12px;border-radius:8px;font-size:12px;overflow:auto">supabase secrets set META_APP_ID=your-app-id
supabase secrets set META_APP_SECRET=your-app-secret</pre>
        <p>Then add this redirect URL in the Meta App Dashboard → Settings → Basic:</p>
        <p><code>${url.origin}${url.pathname}</code></p>`, false);
    }
    const redirectParam = url.searchParams.get('redirect') || '';
    const statePayload = `${Date.now()}.${redirectParam.replace(/[^a-zA-Z0-9.:\-\/]/g, '')}`;
    const sig = await hmacSha256Hex(appSecret, statePayload);
    const stateB64 = btoa(statePayload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const dialog = new URL('https://www.facebook.com/v21.0/dialog/oauth');
    dialog.searchParams.set('client_id', appId);
    dialog.searchParams.set('redirect_uri', url.origin + url.pathname);
    dialog.searchParams.set('state', `${stateB64}.${sig}`);
    dialog.searchParams.set('scope', 'pages_show_list,instagram_basic,instagram_manage_messages,pages_manage_metadata,pages_read_engagement,pages_messaging');
    return new Response(null, { status: 302, headers: { Location: dialog.toString() } });
  }

  /* ---------- callback ---------- */
  const appSecret = CONFIG.metaAppSecret;
  if (!state || !appSecret || !state.includes('.')) return page('Invalid state', '<p>The OAuth state parameter is missing or malformed. Restart the connection from the dashboard.</p>', false);
  const [stateB64, sig] = state.split('.');
  let statePayload;
  try { statePayload = atob(stateB64.replace(/-/g, '+').replace(/_/g, '/')); } catch { return page('Invalid state', '<p>Malformed state.</p>', false); }
  const expectedSig = await hmacSha256Hex(appSecret, statePayload);
  if (!timingSafeEqual(sig, expectedSig)) return page('Invalid state signature', '<p>The state signature did not match — restart the connection.</p>', false);
  const [tsStr] = statePayload.split('.');
  if (Date.now() - parseInt(tsStr, 10) > 10 * 60_000) return page('Link expired', '<p>The connection request expired (>10 min). Restart it from the dashboard.</p>', false);

  try {
    // 1. code → short-lived user token
    const exch = new URL(`${FB}/oauth/access_token`);
    exch.searchParams.set('client_id', CONFIG.metaAppId);
    exch.searchParams.set('client_secret', appSecret);
    exch.searchParams.set('redirect_uri', url.origin + url.pathname);
    exch.searchParams.set('code', code);
    const shortToken = await (await fetch(exch)).json();
    if (shortToken?.error) throw new Error(shortToken.error.message || 'Code exchange failed');
    const short = shortToken.access_token;
    if (!short) throw new Error('No access token returned by Meta');

    // 2. → long-lived user token
    const longRes = new URL(`${FB}/oauth/access_token`);
    longRes.searchParams.set('grant_type', 'fb_exchange_token');
    longRes.searchParams.set('client_id', CONFIG.metaAppId);
    longRes.searchParams.set('client_secret', appSecret);
    longRes.searchParams.set('fb_exchange_token', short);
    const longToken = await (await fetch(longRes)).json();
    if (longToken?.error) throw new Error(longToken.error.message || 'Token upgrade failed');
    const userToken = longToken.access_token;
    const expiresIn = longToken.expires_in || null;

    // 3. pages + linked Instagram professional accounts
    const accountsRes = await fetch(`${FB}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name}&access_token=${encodeURIComponent(userToken)}`);
    const accounts = await accountsRes.json();
    if (accounts?.error) throw new Error(accounts.error.message || 'Could not list pages');
    const pages = accounts?.data || [];
    const linked = pages.find((p) => p.instagram_business_account);
    if (!linked) {
      return page('No linked Instagram account found', `
        <p>None of your Facebook Pages has an <b>Instagram professional account</b> linked.</p>
        <p>Convert your Instagram account to Professional (Settings → Account type), link it to a Facebook Page, then retry.</p>`, false);
    }

    const ig = linked.instagram_business_account;
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    await setSecret('IG_ACCESS_TOKEN', linked.access_token);      // Page access token — used for /me/messages
    await setSecret('IG_ACCOUNT_ID', linked.id);                  // Page id (sending identity)
    await setSecret('IG_IG_USERID', ig.id);                       // Instagram business account id
    await setSecret('IG_USERNAME', ig.username ? `@${ig.username}` : (ig.name || linked.name || null));
    await setSecret('IG_GRAPH_BASE_OVERRIDE', 'https://graph.facebook.com');
    await setSecret('IG_TOKEN_EXPIRES_AT', expiresAt);
    await setSecret('FB_USER_TOKEN', userToken);

    await logActivity({
      category: 'integration_connected', status: 'success',
      message: `Instagram connected via Meta OAuth (${ig.username ? '@' + ig.username : ig.id})`,
      detail: 'Page access token stored server-side. The dashboard only ever sees masked status.',
    });

    return page('Instagram connected', `
      <p><b>${escapeHtml(ig.username ? '@' + ig.username : ig.name || 'Instagram account')}</b> is now linked through the Facebook Page “${escapeHtml(linked.name)}”.</p>
      <p style="font-size:13px;color:#6b7f72">Token: ${maskKey(linked.access_token)} (stored server-side only)${expiresAt ? ` · expires ${expiresAt}` : ' · long-lived'}</p>
      <p style="font-size:13px">Next: finish the webhook subscription in the Meta App Dashboard, then run the setup wizard's remaining checks.</p>`, true);
  } catch (err) {
    await logActivity({ category: 'integration_error', status: 'error', message: `Meta OAuth failed: ${err.message}` });
    return page('Connection failed', `<p>${escapeHtml(err.message)}</p>`, false);
  }
});

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
