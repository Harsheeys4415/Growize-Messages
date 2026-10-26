/* GrowizeMessages — Global settings. */

import { state, patch, applyTheme, lsSet } from '../services/store.js';
import { api } from '../services/api.js';
import { esc, icon, refreshIcons, badge, demoTag, toast, confirmDialog } from './ui.js';
import { connectLive, disconnectLive, getBackendUrl } from '../services/live-mode.js';

const TIMEZONES = [
  ['system', 'Browser / system default'],
  ['UTC', 'UTC'],
  ['Australia/Sydney', 'Australia — Sydney (AEST)'],
  ['Australia/Brisbane', 'Australia — Brisbane (AEST)'],
  ['Australia/Perth', 'Australia — Perth (AWST)'],
  ['Asia/Kolkata', 'Asia — Kolkata (IST)'],
  ['Europe/London', 'Europe — London'],
  ['Europe/Berlin', 'Europe — Berlin'],
  ['America/New_York', 'America — New York'],
  ['America/Los_Angeles', 'America — Los Angeles'],
  ['Asia/Singapore', 'Asia — Singapore'],
];

export async function render(container) {
  const s = state.settings || await api.getSettings();
  const isDemo = state.mode === 'demo';

  container.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Settings</h1>
          <div class="sub">Global application and automation preferences. Changes are saved through the backend in live mode. ${demoTag(isDemo)}</div>
        </div>
        <div class="page-head-actions">
          <button type="button" class="btn btn-primary" id="st-save">${icon('save')} Save settings</button>
        </div>
      </div>

      <div class="grid grid-2">
        <section class="card" aria-labelledby="st-app-title">
          <div class="card-head"><h3 id="st-app-title">${icon('settings')} Application</h3></div>
          <div class="card-body">
            <div class="field">
              <label for="st-appname">Application name</label>
              <input id="st-appname" class="input" value="${esc(s.appName || 'GrowizeMessages')}" />
              <div class="hint">Shown in notifications and exports. The header brand remains GrowizeMessages.</div>
            </div>
            <div class="field">
              <label>Theme</label>
              <div class="segmented" id="st-theme">
                <button type="button" data-theme-opt="light" class="${s.theme === 'light' ? 'active' : ''}">${icon('sun')} Light</button>
                <button type="button" data-theme-opt="dark" class="${s.theme === 'dark' ? 'active' : ''}">${icon('moon')} Dark</button>
                <button type="button" data-theme-opt="system" class="${(!s.theme || s.theme === 'system') ? 'active' : ''}">${icon('monitor')} System</button>
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="st-tz">Timezone</label>
                <select id="st-tz" class="select">
                  ${TIMEZONES.map(([v, l]) => `<option value="${v}" ${(s.timezone || 'system') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
                </select>
                <div class="hint">Used for all timestamps displayed in the app.</div>
              </div>
              <div class="field">
                <label for="st-lang">Language</label>
                <select id="st-lang" class="select">
                  <option value="en" selected>English</option>
                  <option value="de" disabled>Deutsch (coming soon)</option>
                  <option value="es" disabled>Español (coming soon)</option>
                </select>
              </div>
            </div>
            <div class="field">
              <label>Notification preferences</label>
              <div class="field-check" style="margin-bottom:8px">
                <input type="checkbox" id="st-notif-desktop" ${s.notifications?.desktop ? 'checked' : ''} />
                <label for="st-notif-desktop">Desktop notifications for failed replies
                  <span class="hint">Delivered by the backend push channel in live mode; this app shows in-app toasts regardless.</span>
                </label>
              </div>
              <div class="field-check" style="margin-bottom:0">
                <input type="checkbox" id="st-notif-sound" ${s.notifications?.sound ? 'checked' : ''} />
                <label for="st-notif-sound">Play a sound on new activity <span class="hint">Local preference only.</span></label>
              </div>
            </div>
          </div>
        </section>

        <section class="card" aria-labelledby="st-auto-title">
          <div class="card-head"><h3 id="st-auto-title">${icon('zap')} Automation defaults</h3>
            ${s.automationEnabled ? badge('active', 'success') : badge('paused', 'warn')}</div>
          <div class="card-body">
            <div class="field-check">
              <input type="checkbox" id="st-auto-enabled" ${s.automationEnabled ? 'checked' : ''} />
              <label for="st-auto-enabled" style="font-weight:600">Global automation enabled
                <span class="hint">The backend enforces this state before processing or sending any automated reply. A frontend toggle alone is never sufficient.</span>
              </label>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="st-replymode">Default reply mode for new rules</label>
                <select id="st-replymode" class="select">
                  <option value="ai" ${s.defaultReplyMode === 'ai' ? 'selected' : ''}>AI-generated reply</option>
                  <option value="ai_instruction" ${s.defaultReplyMode === 'ai_instruction' ? 'selected' : ''}>AI + rule instruction</option>
                  <option value="predefined" ${s.defaultReplyMode === 'predefined' ? 'selected' : ''}>Predefined reply</option>
                </select>
              </div>
              <div class="field">
                <label for="st-cooldown">Global cooldown <span class="hint">(minutes between automated replies per conversation)</span></label>
                <input id="st-cooldown" type="number" min="0" max="1440" class="input" value="${s.globalCooldownMins ?? 10}" />
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="st-maxreplies">Max replies per conversation</label>
                <input id="st-maxreplies" type="number" min="1" max="50" class="input" value="${s.maxRepliesPerConversation ?? 3}" />
              </div>
              <div class="field">
                <label for="st-window">…over this interval <span class="hint">(minutes)</span></label>
                <input id="st-window" type="number" min="5" max="1440" class="input" value="${s.repliesWindowMins ?? 60}" />
              </div>
            </div>
            <div class="field">
              <label for="st-fallback">Default fallback response <span class="hint">(sent when no rule matches and automation should still acknowledge)</span></label>
              <textarea id="st-fallback" class="textarea" rows="3">${esc(s.fallbackResponse || '')}</textarea>
            </div>
            <div class="note warn">${icon('triangle-alert')}<span><b>Emergency pause</b> — instantly stop every automated reply, ignoring rules and cooldowns.</span></div>
            <button type="button" class="btn btn-danger" id="st-emergency" style="margin-top:10px">${icon('octagon-x')} EMERGENCY PAUSE — stop all automation</button>
          </div>
        </section>
      </div>

      <div class="grid grid-2" style="margin-top:14px">
        <section class="card" aria-labelledby="st-backend-title">
          <div class="card-head"><h3 id="st-backend-title">${icon('database')} Backend connection</h3>
            ${isDemo ? badge('demo mode', 'warn') : badge('live mode', 'success')}</div>
          <div class="card-body">
            ${isDemo ? `
              <p class="helper-text" style="margin-bottom:12px">Connect Supabase and your automation backend to manage live data. A connection only activates after both authoritative checks pass (Supabase auth endpoint + backend <code class="chip">/api/health</code>).</p>
              <div class="field"><label for="st-sb-url">Supabase project URL</label><input id="st-sb-url" class="input input-mono" placeholder="https://xxxxx.supabase.co" /></div>
              <div class="field"><label for="st-sb-key">Publishable (anon) key</label><input id="st-sb-key" type="password" class="input input-mono" placeholder="eyJhbGciOi…" autocomplete="off" /><div class="hint">Never paste the service-role key here — it must stay server-side.</div></div>
              <div class="field"><label for="st-sb-backend">Backend API base URL</label><input id="st-sb-backend" class="input input-mono" placeholder="https://xxxxx.supabase.co/functions/v1" value="${esc(getBackendUrl())}" /></div>
              <button type="button" class="btn btn-primary btn-sm" id="st-connect">${icon('plug-zap')} Verify & connect</button>
              <div id="st-connect-steps" style="margin-top:12px"></div>
            ` : `
              <div class="kv-list">
                <div class="kv"><span class="k">Mode</span><span class="v">Live — authenticated</span></div>
                <div class="kv"><span class="k">Signed in as</span><span class="v">${esc(state.user?.email || '—')}</span></div>
                <div class="kv"><span class="k">Backend base URL</span><span class="v"><code class="chip">${esc(getBackendUrl() || '—')}</code></span></div>
              </div>
              <button type="button" class="btn btn-danger-soft btn-sm" id="st-disconnect" style="margin-top:12px">${icon('unplug')} Disconnect & return to demo</button>
            `}
          </div>
        </section>

        <section class="card" aria-labelledby="st-data-title">
          <div class="card-head"><h3 id="st-data-title">${icon('hard-drive')} Data & session</h3></div>
          <div class="card-body">
            <div style="display:flex;flex-direction:column;gap:10px">
              <button type="button" class="btn btn-ghost" id="st-export">${icon('download')} Export permitted settings (JSON)</button>
              <div class="helper-text">Exports non-secret settings only: automation defaults, AI behaviour config (no keys), UI preferences.</div>
              ${isDemo ? `
                <button type="button" class="btn btn-danger-soft" id="st-reset">${icon('trash-2')} Reset demo data</button>
                <div class="helper-text">Restores the original sample conversations, rules, logs and settings.</div>` : `
                <button type="button" class="btn btn-ghost" id="st-signout">${icon('log-out')} Sign out</button>`}
            </div>
          </div>
        </section>
      </div>

      <section class="card" style="margin-top:14px" aria-labelledby="st-setup-title">
        <div class="card-head"><h3 id="st-setup-title">${icon('list-checks')} First-run setup</h3></div>
        <div class="card-body" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <span class="helper-text">Revisit the guided setup wizard to verify Supabase, Instagram, OpenRouter, backend health and webhooks step by step.</span>
          <a href="#/setup" class="btn btn-soft btn-sm">${icon('map')} Open setup wizard</a>
        </div>
      </section>
    </div>`;

  refreshIcons(container);

  // theme segmented
  container.querySelectorAll('#st-theme [data-theme-opt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('#st-theme [data-theme-opt]').forEach((b) => b.classList.toggle('active', b === btn));
      applyTheme(btn.dataset.themeOpt);
      lsSet('gm.theme', btn.dataset.themeOpt);
    });
  });

  // save
  container.querySelector('#st-save').addEventListener('click', async () => {
    const btn = container.querySelector('#st-save');
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Saving…`;
    try {
      const next = await api.updateSettings({
        appName: container.querySelector('#st-appname').value.trim() || 'GrowizeMessages',
        theme: document.querySelector('#st-theme .active')?.dataset.themeOpt || 'system',
        timezone: container.querySelector('#st-tz').value,
        language: container.querySelector('#st-lang').value,
        automationEnabled: container.querySelector('#st-auto-enabled').checked,
        defaultReplyMode: container.querySelector('#st-replymode').value,
        fallbackResponse: container.querySelector('#st-fallback').value,
        globalCooldownMins: intOf(container.querySelector('#st-cooldown').value, 10),
        maxRepliesPerConversation: intOf(container.querySelector('#st-maxreplies').value, 3),
        repliesWindowMins: intOf(container.querySelector('#st-window').value, 60),
        notifications: {
          desktop: container.querySelector('#st-notif-desktop').checked,
          sound: container.querySelector('#st-notif-sound').checked,
        },
      });
      state.settings = next;
      toast('Settings saved', 'success');
      window.dispatchEvent(new CustomEvent('gm:automation-changed'));
    } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false; btn.innerHTML = `${icon('save')} Save settings`;
    refreshIcons(btn);
  });

  // emergency pause
  container.querySelector('#st-emergency').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Activate EMERGENCY PAUSE?',
      message: 'All automated replies stop immediately. Manual replies from the inbox remain available. You must explicitly resume automation afterwards.',
      confirmLabel: 'Stop all automation', danger: true,
    });
    if (!ok) return;
    try {
      await api.pauseAutomation({ emergency: true });
      state.settings = { ...state.settings, automationEnabled: false };
      container.querySelector('#st-auto-enabled').checked = false;
      toast('EMERGENCY PAUSE active — the backend will not send automated replies', 'warn', 6000);
      window.dispatchEvent(new CustomEvent('gm:automation-changed'));
    } catch (err) { toast(err.message, 'error'); }
  });

  // export
  container.querySelector('#st-export').addEventListener('click', async () => {
    try {
      const s2 = await api.getSettings();
      const safe = JSON.parse(JSON.stringify(s2));
      if (safe.ai) { delete safe.ai.keyConfigured; delete safe.ai.keyMask; delete safe.ai.lastTestAt; delete safe.ai.lastTestResult; }
      const payload = {
        exportedAt: new Date().toISOString(), app: 'GrowizeMessages', version: '1.0.0',
        note: 'Non-secret settings export. Credentials are never included.',
        settings: safe,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `growizemessages-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Settings exported', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  // demo reset
  container.querySelector('#st-reset')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Reset demo data?',
      message: 'Sample conversations, rules, logs and settings return to their original state. This cannot be undone.',
      confirmLabel: 'Reset demo', danger: true,
    });
    if (!ok) return;
    const { reset } = await import('../services/demo.js');
    reset();
    state.settings = await api.getSettings();
    toast('Demo data reset', 'success');
    render(container);
  });

  // sign out
  container.querySelector('#st-signout')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Sign out?', message: 'You will need to sign in again.', confirmLabel: 'Sign out' });
    if (!ok) return;
    const { signOut } = await import('../services/supabase.js');
    await signOut();
    patch({ user: null });
  });

  // connect live
  container.querySelector('#st-connect')?.addEventListener('click', async (e) => {
    const url = container.querySelector('#st-sb-url').value.trim();
    const key = container.querySelector('#st-sb-key').value.trim();
    const backend = container.querySelector('#st-sb-backend').value.trim();
    const stepsEl = container.querySelector('#st-connect-steps');
    if (!url || !key || !backend) { toast('All three fields are required to verify a live connection.', 'warn'); return; }
    const btn = e.currentTarget;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Verifying…`;
    const res = await connectLive({ supabaseUrl: url, anonKey: key, backendBase: backend });
    btn.disabled = false; btn.innerHTML = `${icon('plug-zap')} Verify & connect`;
    refreshIcons(btn);
    stepsEl.innerHTML = res.steps.map((s3) => `
      <div style="display:flex;gap:8px;align-items:center;padding:5px 0;font-size:13px">
        <span class="dot-ind ${s3.ok ? 'ok' : 'err'}"></span><span>${esc(s3.label)}</span>
        <span class="helper-text" style="margin-left:auto;text-align:right">${esc(s3.detail)}</span>
      </div>`).join('');
    if (res.ok) {
      toast('Live mode active — signing in…', 'success');
      const { showAuth } = await import('./auth.js');
      showAuth({ allowDemo: false, notice: 'Connection verified. Sign in with your dashboard account.' });
    } else {
      toast(res.error, 'error', 6000);
    }
  });

  container.querySelector('#st-disconnect')?.addEventListener('click', async () => {
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
}

function intOf(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}
