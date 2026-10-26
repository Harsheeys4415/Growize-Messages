/* GrowizeMessages — Integrations: Meta/Instagram, Supabase, OpenRouter.
 * Status is never faked: in demo mode cards are explicitly labeled as
 * simulated; in live mode values come from GET /api/integrations/status. */

import { state } from '../services/store.js';
import { api } from '../services/api.js';
import { onChange as onDemoChange } from '../services/demo.js';
import { esc, icon, refreshIcons, badge, dot, demoTag, fmtDateTime, toast, confirmDialog, spinnerBlock } from './ui.js';
import { connectLive, disconnectLive, getBackendUrl } from '../services/live-mode.js';

let unsub = null;

export async function render(container) {
  container.innerHTML = `<div class="page" id="int-page">${spinnerBlock('Checking integration status…')}</div>`;
  let ints;
  try {
    ints = await api.integrationsStatus();
  } catch (err) {
    container.innerHTML = `<div class="page"><div class="note danger">${icon('circle-alert')}<span>Could not load integration status: ${esc(err.message)}</span></div></div>`;
    refreshIcons(container);
    return;
  }
  const isDemo = state.mode === 'demo';

  const statusBadge = (st, simulated) => {
    if (st === 'connected') return badge(simulated ? 'connected · sample' : 'connected', simulated ? 'warn' : 'success', 'circle-check');
    if (st === 'demo') return badge('demo — local data', 'warn', 'database');
    if (st === 'error') return badge('error', 'danger', 'circle-x');
    return badge('not configured', 'neutral', 'circle-dashed');
  };

  container.innerHTML = `
    <div class="page" id="int-page">
      <div class="page-head">
        <div>
          <h1>Integrations</h1>
          <div class="sub">Connection status for the three services behind GrowizeMessages. ${isDemo ? 'All values shown are <b>sample data</b> from demo mode.' : 'Live values from your backend.'} ${demoTag(isDemo)}</div>
        </div>
        <div class="page-head-actions">
          <button type="button" class="btn btn-ghost" id="int-refresh">${icon('refresh-cw')} Refresh status</button>
        </div>
      </div>

      <div class="grid grid-3">
        <!-- ============ META / INSTAGRAM ============ -->
        <section class="card" style="display:flex;flex-direction:column" aria-labelledby="int-meta-title">
          <div class="card-head"><h3 id="int-meta-title">${icon('instagram')} Meta / Instagram</h3>${statusBadge(ints.meta.status, ints.meta.simulated)}</div>
          <div class="card-body" style="flex:1">
            <div class="kv-list">
              <div class="kv"><span class="k">Instagram account</span><span class="v">${esc(ints.meta.igUsername || 'Not connected')}</span></div>
              <div class="kv"><span class="k">Instagram account ID</span><span class="v"><code class="chip">${esc(ints.meta.igAccountId || '—')}</code></span></div>
              <div class="kv"><span class="k">Meta app ID</span><span class="v"><code class="chip">${esc(ints.meta.appId || '—')}</code></span></div>
              <div class="kv"><span class="k">Access token</span><span class="v">${esc(ints.meta.tokenStatus || 'unknown')}</span></div>
              <div class="kv"><span class="k">Token expiry</span><span class="v">${ints.meta.tokenExpiresInDays != null ? `in ${ints.meta.tokenExpiresInDays} days` : '—'}</span></div>
              <div class="kv"><span class="k">Webhook verification</span><span class="v">${ints.meta.webhookVerify ? badge('verified', 'success', 'shield-check') : badge('not verified', 'warn')}</span></div>
              <div class="kv"><span class="k">Last webhook event</span><span class="v">${ints.meta.lastWebhookAt ? esc(fmtDateTime(ints.meta.lastWebhookAt)) : '—'}</span></div>
              <div class="kv"><span class="k">Last health check</span><span class="v">${ints.meta.lastCheckAt ? esc(fmtDateTime(ints.meta.lastCheckAt)) : '—'}</span></div>
            </div>
            ${ints.meta.errors?.length ? `<div class="note danger" style="margin-top:10px">${icon('circle-alert')}<span>${esc(ints.meta.errors.join(' · '))}</span></div>` : ''}
            <details style="margin-top:12px">
              <summary style="cursor:pointer;font-weight:600;font-size:13px">Required permissions & setup</summary>
              <div class="helper-text" style="margin-top:8px">
                <b>Permissions:</b>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
                  ${(ints.meta.permissions || []).map((p) => `<code class="chip">${esc(p)}</code>`).join('')}
                </div>
                <div style="margin-top:10px">
                  <b>Webhook callback URL (configure in Meta App Dashboard):</b>
                  <div style="margin-top:4px"><code class="chip">${esc(ints.meta.webhookUrl || 'https://your-backend.example/functions/v1/meta-webhook')}</code></div>
                </div>
                <ol style="margin:10px 0 0;padding-left:18px;color:var(--text-2);display:grid;gap:4px">
                  <li>Create a Meta app and add the Instagram Messaging product.</li>
                  <li>Connect your Instagram professional account to a Facebook Page.</li>
                  <li>Generate an access token via the official OAuth flow — <b>through your backend</b>.</li>
                  <li>Subscribe to the <code class="chip">messages</code> and <code class="chip">messaging_postbacks</code> fields.</li>
                </ol>
                <div class="note warn" style="margin-top:10px">${icon('shield-alert')}<span>Never share your Instagram password with any tool. GrowizeMessages uses the official Meta API only — no browser automation, cookie scraping or unofficial logins.</span></div>
              </div>
            </details>
          </div>
          <div class="card-foot" style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-primary btn-sm" id="meta-connect">${icon('link')} Connect via Meta</button>
            <button type="button" class="btn btn-ghost btn-sm" id="meta-test">${icon('plug-zap')} Test connection</button>
          </div>
        </section>

        <!-- ============ SUPABASE ============ -->
        <section class="card" style="display:flex;flex-direction:column" aria-labelledby="int-sb-title">
          <div class="card-head"><h3 id="int-sb-title">${icon('database')} Supabase</h3>${statusBadge(ints.supabase.status, true)}</div>
          <div class="card-body" style="flex:1">
            ${ints.supabase.status === 'demo' ? `
              <div class="note" style="margin-bottom:12px">${icon('info')}<span>${esc(ints.supabase.note || 'Demo mode — connect a project to go live.')}</span></div>
              <div class="field">
                <label for="sb-url">Project URL</label>
                <input id="sb-url" class="input input-mono" placeholder="https://xxxxx.supabase.co" />
              </div>
              <div class="field">
                <label for="sb-key">Publishable (anon) key</label>
                <input id="sb-key" type="password" class="input input-mono" placeholder="eyJhbGciOi…" autocomplete="off" />
                <div class="hint">Publishable key only — the service-role key must NEVER be placed in a frontend.</div>
              </div>
              <div class="field">
                <label for="sb-backend">Backend API base URL</label>
                <input id="sb-backend" class="input input-mono" placeholder="https://xxxxx.supabase.co/functions/v1" value="${esc(getBackendUrl())}" />
                <div class="hint">Base URL of your deployed Edge Functions (or any authenticated backend implementing the API contract).</div>
              </div>
              <button type="button" class="btn btn-primary btn-sm" id="sb-connect">${icon('plug-zap')} Verify & connect</button>
              <div id="sb-steps" style="margin-top:12px"></div>
            ` : `
              <div class="kv-list">
                <div class="kv"><span class="k">Project URL</span><span class="v"><code class="chip">${esc(ints.supabase.projectUrl || '—')}</code></span></div>
                <div class="kv"><span class="k">Anon key</span><span class="v">${ints.supabase.anonKeyConfigured ? badge('configured', 'success') : badge('missing', 'warn')}</span></div>
                <div class="kv"><span class="k">Backend API</span><span class="v"><code class="chip">${esc(getBackendUrl() || '—')}</code></span></div>
                <div class="kv"><span class="k">Health status</span><span class="v">${dot(ints.supabase.health === 'ok' ? 'ok' : 'err')} ${esc(String(ints.supabase.health || 'unknown'))}</span></div>
                <div class="kv"><span class="k">Last sync</span><span class="v">${ints.supabase.lastSyncAt ? esc(fmtDateTime(ints.supabase.lastSyncAt)) : '—'}</span></div>
              </div>
              <button type="button" class="btn btn-danger-soft btn-sm" id="sb-disconnect" style="margin-top:12px">${icon('unplug')} Disconnect & return to demo</button>
            `}
          </div>
        </section>

        <!-- ============ OPENROUTER ============ -->
        <section class="card" style="display:flex;flex-direction:column" aria-labelledby="int-or-title">
          <div class="card-head"><h3 id="int-or-title">${icon('sparkles')} OpenRouter</h3>${statusBadge(ints.openrouter.status, ints.openrouter.simulated)}</div>
          <div class="card-body" style="flex:1">
            <div class="kv-list">
              <div class="kv"><span class="k">Credential</span><span class="v">${ints.openrouter.keyConfigured ? badge('configured · masked', 'success', 'key-round') : badge('not configured', 'warn')}</span></div>
              <div class="kv"><span class="k">Key (masked)</span><span class="v"><code class="chip">${esc(ints.openrouter.keyMask || '—')}</code></span></div>
              <div class="kv"><span class="k">Selected model</span><span class="v"><code class="chip">${esc(ints.openrouter.model || state.settings?.ai?.model || '—')}</code></span></div>
              <div class="kv"><span class="k">Last successful request</span><span class="v">${ints.openrouter.lastRequestAt ? esc(fmtDateTime(ints.openrouter.lastRequestAt)) : '—'}</span></div>
              <div class="kv"><span class="k">Last connection test</span><span class="v">${ints.openrouter.lastTestAt ? esc(fmtDateTime(ints.openrouter.lastTestAt)) : '—'}</span></div>
            </div>
            ${ints.openrouter.usageNote ? `<div class="helper-text" style="margin-top:10px">${esc(ints.openrouter.usageNote)}</div>` : ''}
            <div class="note" style="margin-top:10px">${icon('shield-check')}<span>The API key is configured on the <a href="#/ai">AI Assistant page</a> and stored server-side only. It is never displayed or returned here.</span></div>
          </div>
          <div class="card-foot" style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap">
            <a href="#/ai" class="btn btn-ghost btn-sm">${icon('settings')} Configure AI</a>
          </div>
        </section>
      </div>
    </div>`;

  refreshIcons(container);

  container.querySelector('#int-refresh').addEventListener('click', () => render(container));

  // Meta connect
  container.querySelector('#meta-connect').addEventListener('click', async () => {
    if (state.mode === 'demo') {
      toast('Demo mode: the OAuth flow runs through your backend in live mode (GET /api/integrations/meta/auth).', 'info', 5200);
      return;
    }
    const url = api.metaAuthStartUrl();
    if (url) window.open(url, '_blank', 'noopener');
    else toast('Backend auth endpoint not configured yet.', 'warn');
  });

  // Meta test
  container.querySelector('#meta-test').addEventListener('click', async () => {
    if (state.mode === 'demo') { toast('Demo mode: connection test simulated — values above are samples.', 'info', 4000); return; }
    try {
      const st = await api.metaStatus();
      if (st.status === 'connected') toast(`Meta connection healthy — ${st.igUsername}`, 'success');
      else toast(st.errors?.join(' · ') || 'Meta connection reported a problem', 'error');
    } catch (err) { toast(`Test failed: ${err.message}`, 'error'); }
  });

  // Supabase connect (live-mode handshake)
  container.querySelector('#sb-connect')?.addEventListener('click', async (e) => {
    const url = container.querySelector('#sb-url').value.trim();
    const key = container.querySelector('#sb-key').value.trim();
    const backend = container.querySelector('#sb-backend').value.trim();
    const stepsEl = container.querySelector('#sb-steps');
    if (!url || !key) { toast('Project URL and anon key are required.', 'warn'); return; }
    if (!backend) { toast('A backend API base URL is required — live management actions need it.', 'warn'); return; }
    const btn = e.currentTarget;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Verifying…`;
    stepsEl.innerHTML = `<div class="loading-block"><span class="spinner"></span> Running authoritative checks…</div>`;
    const res = await connectLive({ supabaseUrl: url, anonKey: key, backendBase: backend });
    btn.disabled = false; btn.innerHTML = `${icon('plug-zap')} Verify & connect`;
    refreshIcons(btn);
    stepsEl.innerHTML = res.steps.map((s) => `
      <div style="display:flex;gap:8px;align-items:center;padding:5px 0;font-size:13px">
        ${dot(s.ok ? 'ok' : 'err')}<span>${esc(s.label)}</span>
        <span class="helper-text" style="margin-left:auto;text-align:right">${esc(s.detail)}</span>
      </div>`).join('');
    if (res.ok) {
      toast('Live mode active — signing in…', 'success');
      const { showAuth } = await import('./auth.js');
      showAuth({ allowDemo: false, notice: 'Connection verified. Sign in with your dashboard account.' });
    } else {
      toast(res.error, 'error', 6000);
    }
  });

  container.querySelector('#sb-disconnect')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Disconnect live backend?',
      message: 'The app returns to demo mode with local sample data. Your backend keeps running the automation independently.',
      confirmLabel: 'Disconnect', danger: true,
    });
    if (!ok) return;
    await disconnectLive();
    toast('Returned to demo mode', 'info');
    render(container);
  });

  unsub = onDemoChange(() => { /* statuses are static per render */ });
  return () => { if (unsub) { unsub(); unsub = null; } };
}
