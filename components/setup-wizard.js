/* GrowizeMessages — first-run setup wizard (9 steps).
 * A step is marked complete only after a successful validation response.
 * In demo mode validations are simulated and clearly labeled; in live
 * mode they hit POST /api/setup/verify/:step on your backend. */

import { state, patch, lsGet, lsSet } from '../services/store.js';
import { api } from '../services/api.js';
import { esc, icon, refreshIcons, badge, dot, toast, spinnerBlock } from './ui.js';

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'auth', label: 'Sign in' },
  { id: 'supabase', label: 'Supabase' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'backend', label: 'Backend health' },
  { id: 'webhook', label: 'Webhooks' },
  { id: 'test-event', label: 'Test event' },
  { id: 'enable', label: 'Enable' },
];

let step = 0;
const done = new Map();

export async function render(container) {
  step = 0;
  STEPS.forEach((s, i) => { if (lsGet(`gm.wizard.step.${s.id}`, false)) done.set(i, true); });

  container.innerHTML = `
    <div class="page wizard" id="wizard-page">
      <div class="page-head">
        <div>
          <h1>Setup wizard</h1>
          <div class="sub">GrowizeMessages — Every message, handled. Complete each step only when its check passes. You can revisit any step later.</div>
        </div>
        <div class="page-head-actions">
          <button type="button" class="btn btn-ghost" id="wz-skip">Skip for now</button>
        </div>
      </div>
      <div class="wizard-steps" role="tablist" aria-label="Setup steps">
        ${STEPS.map((s, i) => `
          <button type="button" class="wstep" data-step="${i}" role="tab" aria-selected="false">
            <span class="wnum" data-wnum="${i}">${i + 1}</span> ${esc(s.label)}
          </button>`).join('')}
      </div>
      <div class="card">
        <div class="wizard-panel" id="wz-panel">${spinnerBlock('Preparing wizard…')}</div>
        <div class="wizard-nav">
          <button type="button" class="btn btn-ghost" id="wz-back">${icon('arrow-left')} Back</button>
          <button type="button" class="btn btn-primary" id="wz-next">Continue ${icon('arrow-right')}</button>
        </div>
      </div>
    </div>`;

  refreshIcons(container);
  container.querySelectorAll('[data-step]').forEach((btn) =>
    btn.addEventListener('click', () => goTo(parseInt(btn.dataset.step, 10))));
  container.querySelector('#wz-skip').addEventListener('click', finish);
  container.querySelector('#wz-back').addEventListener('click', () => goTo(Math.max(0, step - 1)));
  container.querySelector('#wz-next').addEventListener('click', nextStep);

  paint();
}

function goTo(i) { step = Math.max(0, Math.min(STEPS.length - 1, i)); paint(); }
function nextStep() {
  if (step === STEPS.length - 1) { markDone(step); finish(); return; }
  goTo(step + 1);
}
function markDone(i) { done.set(i, true); lsSet(`gm.wizard.step.${STEPS[i].id}`, true); }
function finish() {
  lsSet('gm.wizardDone', true);
  state.wizardDone = true;
  toast('Setup wizard closed — you can revisit it from Settings', 'info');
  location.hash = '#/dashboard';
}

function paint() {
  const container = document.getElementById('wizard-page');
  if (!container) return;
  container.querySelectorAll('.wstep').forEach((el) => {
    const i = parseInt(el.dataset.step, 10);
    el.classList.toggle('active', i === step);
    el.classList.toggle('done', done.has(i));
    el.querySelector(`[data-wnum="${i}"]`).innerHTML = done.has(i) ? icon('check') : String(i + 1);
    el.setAttribute('aria-selected', i === step ? 'true' : 'false');
  });
  container.querySelector('#wz-back').disabled = step === 0;
  container.querySelector('#wz-next').innerHTML = step === STEPS.length - 1
    ? `${icon('party-popper')} Finish setup` : `Continue ${icon('arrow-right')}`;

  const panel = container.querySelector('#wz-panel');
  const renderer = PANELS[STEPS[step].id] || PANELS.welcome;
  panel.innerHTML = renderer();
  refreshIcons(panel);
  MOUNTS[STEPS[step].id]?.(panel);
}

/* ---------- shared verify helper ---------- */
function verifyButton(panel, { label = 'Verify this step', onVerify }) {
  const btn = panel.querySelector('[data-verify]');
  const out = panel.querySelector('[data-verify-out]');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Checking…`;
    out.innerHTML = '';
    try {
      const res = await onVerify();
      out.innerHTML = `
        <div style="display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:8px;background:var(--surface-2);font-size:13px">
          ${dot(res.ok ? 'ok' : 'err')}
          <div><b>${res.ok ? 'Check passed' : 'Check failed'}</b>${res.simulated ? ' ' + badge('simulated', 'warn') : ''}<div class="helper-text" style="margin-top:2px">${esc(res.message || '')}</div></div>
        </div>`;
      refreshIcons(out);
      if (res.ok) { markDone(step); toast('Step verified', 'success', 1800); }
    } catch (err) {
      out.innerHTML = `<div class="note danger">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
      refreshIcons(out);
    }
    btn.disabled = false;
    btn.innerHTML = `${icon('play')} ${label}`;
  });
}

const isDemo = () => state.mode === 'demo';

/* ---------- step panels ---------- */
const PANELS = {
  welcome: () => `
    <h2>Welcome to GrowizeMessages</h2>
    <div class="wsub">Every message, handled.</div>
    <p style="color:var(--text-2);margin-bottom:12px">This wizard connects the management dashboard to your automation backend. GrowizeMessages is <b>the control panel</b> — the automation engine itself runs independently on your infrastructure (Meta webhooks → Supabase Edge Functions → OpenRouter → Instagram Messaging API), and keeps running while this app is closed.</p>
    <div class="grid grid-3">
      ${[['instagram', 'Receive', 'Meta sends every incoming DM to your backend webhook.'],
         ['workflow', 'Decide', 'Rules are evaluated and OpenRouter drafts AI replies.'],
         ['send', 'Reply', 'Replies are delivered through the official Instagram API.']].map(([ic, t, d]) => `
        <div class="card card-pad">
          <div class="check-icon ok" style="margin-bottom:8px">${icon(ic)}</div>
          <b>${t}</b><div class="helper-text" style="margin-top:3px">${d}</div>
        </div>`).join('')}
    </div>
    <div class="note" style="margin-top:14px">${icon('info')}<span>You are currently in <b>${isDemo() ? 'demo mode with simulated data' : 'live mode'}</b>. The wizard tailors its checks accordingly.</span></div>`,

  auth: () => `
    <h2>Sign in or authenticate the administrator</h2>
    <div class="wsub">Live mode requires an authenticated dashboard account (Supabase Auth).</div>
    ${isDemo() ? `
      <div class="note warn">${icon('flask-conical')}<span>Demo mode does not use credentials. Verification below is <b>simulated</b> — connect a backend to authenticate for real.</span></div>` : `
      <div class="kv-list">
        <div class="kv"><span class="k">Signed in as</span><span class="v">${esc(state.user?.email || 'Not signed in')}</span></div>
      </div>`}
    <div style="margin-top:12px"><button type="button" class="btn btn-primary" data-verify>${icon('play')} Verify access</button></div>
    <div data-verify-out style="margin-top:12px"></div>`,

  supabase: () => `
    <h2>Configure Supabase connectivity</h2>
    <div class="wsub">Project URL + publishable anon key. The service-role key never belongs in a frontend.</div>
    ${isDemo() ? `
      <div class="note warn">${icon('flask-conical')}<span>Demo mode keeps data in your browser. Verification is <b>simulated</b> — use Settings → Backend connection to connect a real project.</span></div>` : `
      <div class="kv-list">
        <div class="kv"><span class="k">Project</span><span class="v">Connected via live mode</span></div>
      </div>`}
    <div style="margin-top:12px"><button type="button" class="btn btn-primary" data-verify>${icon('play')} Verify Supabase</button></div>
    <div data-verify-out style="margin-top:12px"></div>`,

  instagram: () => `
    <h2>Connect Instagram through Meta</h2>
    <div class="wsub">Authorization happens through the official Meta OAuth flow, executed by your backend.</div>
    <ol style="color:var(--text-2);padding-left:18px;display:grid;gap:6px;margin-bottom:14px">
      <li>Create a Meta app with the <b>Instagram Messaging</b> product.</li>
      <li>Link a professional Instagram account to a Facebook Page.</li>
      <li>Start OAuth from the backend — tokens are exchanged and stored server-side.</li>
      <li>Grant <code class="chip">instagram_basic</code> + <code class="chip">instagram_manage_messages</code>.</li>
    </ol>
    <div class="note warn">${icon('shield-alert')}<span>Never enter your Instagram password anywhere in this app. No browser automation or unofficial APIs are used.</span></div>
    <div style="margin-top:12px"><button type="button" class="btn btn-primary" data-verify>${icon('play')} Verify Instagram connection</button></div>
    <div data-verify-out style="margin-top:12px"></div>`,

  openrouter: () => `
    <h2>Configure OpenRouter</h2>
    <div class="wsub">The AI provider for generated replies. Your key is stored server-side only.</div>
    <div class="kv-list">
      <div class="kv"><span class="k">Credential</span><span class="v">${state.settings?.ai?.keyConfigured ? badge('configured · masked', 'success', 'key-round') : badge('not configured', 'warn')}</span></div>
      <div class="kv"><span class="k">Model</span><span class="v"><code class="chip">${esc(state.settings?.ai?.model || '—')}</code></span></div>
    </div>
    <div class="helper-text" style="margin-top:10px">Manage the key, model and system prompt on the <a href="#/ai">AI Assistant page</a>.</div>
    <div style="margin-top:12px"><button type="button" class="btn btn-primary" data-verify>${icon('play')} Test AI connection</button></div>
    <div data-verify-out style="margin-top:12px"></div>`,

  backend: () => `
    <h2>Verify backend health</h2>
    <div class="wsub">The dashboard requires a reachable backend before enabling live management actions.</div>
    ${isDemo() ? `
      <div class="note warn">${icon('flask-conical')}<span>Demo mode has no backend — verification is <b>simulated</b>. Deploy the Edge Functions from README §7 and connect via Settings.</span></div>` : `
      <div class="kv-list"><div class="kv"><span class="k">Base URL</span><span class="v"><code class="chip">${esc(location.origin)}</code></span></div></div>`}
    <div style="margin-top:12px"><button type="button" class="btn btn-primary" data-verify>${icon('play')} Call /api/health</button></div>
    <div data-verify-out style="margin-top:12px"></div>`,

  webhook: () => `
    <h2>Verify webhook configuration</h2>
    <div class="wsub">Meta must be able to reach your backend webhook and pass signature validation.</div>
    <div class="field">
      <label>Webhook callback URL (sample)</label>
      <div><code class="chip">https://your-project.supabase.co/functions/v1/meta-webhook</code></div>
    </div>
    <div class="field">
      <label>Verify token & subscribed fields</label>
      <div class="helper-text">Fields: <code class="chip">messages</code> <code class="chip">messaging_postbacks</code> — signature: <code class="chip">X-Hub-Signature-256</code> validated with your app secret.</div>
    </div>
    <div style="margin-top:12px"><button type="button" class="btn btn-primary" data-verify>${icon('play')} Verify webhook subscription</button></div>
    <div data-verify-out style="margin-top:12px"></div>`,

  'test-event': () => `
    <h2>Inspect a test event</h2>
    <div class="wsub">Send one message through the pipeline and confirm each stage is logged.</div>
    ${isDemo() ? `
      <div class="note">${icon('flask-conical')}<span>Pressing simulate creates a <b>fake</b> incoming DM and runs the local pipeline — nothing leaves your browser.</span></div>
      <div style="margin-top:12px"><button type="button" class="btn btn-primary" data-simulate>${icon('arrow-down-left')} Simulate a test DM</button></div>` : `
      <p class="helper-text">DM your connected Instagram account from another profile, then verify below. The backend records the event with a correlation ID.</p>`}
    <div style="margin-top:12px"><button type="button" class="btn btn-primary" data-verify>${icon('play')} Verify last event</button></div>
    <div data-verify-out style="margin-top:12px"></div>`,

  enable: () => `
    <h2>Enable automation</h2>
    <div class="wsub">Final step — switch the engine on once every check above passes.</div>
    <div class="kv-list">
      ${STEPS.slice(1, 8).map((s, i) => `
        <div class="kv"><span class="k">${i + 1}. ${esc(s.label)}</span><span class="v">${done.has(i + 1) ? badge('verified', 'success', 'check') : badge('not verified', 'neutral', 'circle-dashed')}</span></div>`).join('')}
    </div>
    ${!allVerified() ? `<div class="note warn" style="margin-top:12px">${icon('triangle-alert')}<span>Some steps are not verified yet. You can still enable automation, but unresolved issues will surface in System Health.</span></div>` : `<div class="note success" style="margin-top:12px">${icon('circle-check')}<span>All steps verified — you are ready to go live.</span></div>`}
    <div class="field-check" style="margin-top:14px">
      <input type="checkbox" id="wz-enable" ${state.settings?.automationEnabled ? 'checked' : ''} />
      <label for="wz-enable" style="font-weight:600">Enable global automation
        <span class="hint">Persisted through the backend; the engine checks this flag before every send.</span>
      </label>
    </div>`,
};

function allVerified() { return STEPS.slice(1, 8).every((_s, i) => done.has(i + 1)); }

/* ---------- step mounts (verify handlers) ---------- */
const MOUNTS = {
  auth(panel) {
    verifyButton(panel, {
      onVerify: async () => {
        if (isDemo()) { await new Promise((r) => setTimeout(r, 500)); return { ok: true, simulated: true, message: 'Demo session active — real authentication happens after connecting a backend.' }; }
        if (state.user) return { ok: true, simulated: false, message: `Authenticated as ${state.user.email}.` };
        return { ok: false, simulated: false, message: 'Not signed in. Use Settings → Backend connection, then sign in.' };
      },
    });
  },
  supabase(panel) {
    verifyButton(panel, {
      onVerify: async () => api.wizardVerify('supabase'),
    });
  },
  instagram(panel) {
    verifyButton(panel, {
      onVerify: async () => {
        if (isDemo()) { await new Promise((r) => setTimeout(r, 500)); return { ok: true, simulated: true, message: 'Sample connection healthy — @growize.garden (sample). Real OAuth runs through your backend.' }; }
        const st = await api.metaStatus();
        return st.status === 'connected'
          ? { ok: true, simulated: false, message: `Connected as ${st.igUsername}.` }
          : { ok: false, simulated: false, message: st.errors?.join(' · ') || 'Instagram not connected yet.' };
      },
    });
  },
  openrouter(panel) {
    verifyButton(panel, {
      onVerify: async () => {
        const res = await api.aiTest('Hello! This is a setup wizard test.');
        return res.ok
          ? { ok: true, simulated: !!res.simulated, message: `Model ${res.model} responded in ~${res.latencyMs}ms${res.simulated ? ' (simulated)' : ''}.` }
          : { ok: false, simulated: true, message: res.error || 'AI test failed.' };
      },
    });
  },
  backend(panel) {
    verifyButton(panel, {
      onVerify: async () => {
        if (isDemo()) { await new Promise((r) => setTimeout(r, 500)); return { ok: true, simulated: true, message: 'Simulated health check passed. Connect a real backend via Settings → Backend connection.' }; }
        const res = await api.health();
        return res.ok ? { ok: true, simulated: false, message: `Backend healthy (${res.service || 'ok'}).` } : { ok: false, simulated: false, message: 'Health endpoint returned an error.' };
      },
    });
  },
  webhook(panel) {
    verifyButton(panel, {
      onVerify: async () => api.wizardVerify('webhook'),
    });
  },
  'test-event'(panel) {
    panel.querySelector('[data-simulate]')?.addEventListener('click', async () => {
      const { simulateIncoming } = await import('../services/demo.js');
      const res = simulateIncoming();
      toast(res?.duplicate ? 'Simulated duplicate event — ignored, as designed' : 'Simulated DM sent through the local pipeline', 'info');
    });
    verifyButton(panel, {
      label: 'Verify last event',
      onVerify: async () => {
        if (isDemo()) {
          const { listActivity } = await import('../services/demo.js');
          const last = await listActivity({});
          const recent = last.rows.find((r) => r.category === 'incoming_dm');
          return recent
            ? { ok: true, simulated: true, message: `Found recent simulated event: “${recent.message}” (${recent.correlationId}). Inspect it in Activity Logs.` }
            : { ok: false, simulated: true, message: 'No simulated events found — press “Simulate a test DM” first.' };
        }
        return api.wizardVerify('test-event');
      },
    });
  },
  enable(panel) {
    panel.querySelector('#wz-enable')?.addEventListener('change', async (e) => {
      try {
        const res = e.target.checked ? await api.resumeAutomation() : await api.pauseAutomation({});
        state.settings = { ...(state.settings || {}), automationEnabled: res.automationEnabled };
        toast(res.automationEnabled ? 'Automation enabled — the engine will reply according to your rules' : 'Automation paused', res.automationEnabled ? 'success' : 'warn');
        window.dispatchEvent(new CustomEvent('gm:automation-changed'));
      } catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'error'); }
    });
  },
};

/* wizard finished handling lives in nextStep() */
