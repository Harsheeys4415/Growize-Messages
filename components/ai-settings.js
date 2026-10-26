/* GrowizeMessages — AI Assistant configuration.
 * OpenRouter is called ONLY by the backend. This page configures the
 * backend's behaviour and offers a clearly-labeled preview console.
 * API keys are sent to an authenticated backend endpoint (live) or
 * accepted as mock values in demo — never stored in the frontend. */

import { state } from '../services/store.js';
import { api } from '../services/api.js';
import { onChange as onDemoChange } from '../services/demo.js';
import {
  esc, icon, refreshIcons, badge, demoTag, fmtNum, fmtCost, fmtDateTime,
  toast, confirmDialog, spinnerBlock,
} from './ui.js';

let unsub = null;

export async function render(container) {
  container.innerHTML = `<div class="page" id="ai-page">${spinnerBlock('Loading AI settings…')}</div>`;
  let settings;
  let usage;
  try {
    settings = state.settings || await api.getSettings();
    usage = await api.dashboardSummary('30d');
  } catch (err) {
    container.innerHTML = `<div class="page"><div class="note danger">${icon('circle-alert')}<span>Could not load AI settings: ${esc(err.message)}</span></div></div>`;
    refreshIcons(container);
    return;
  }
  const ai = settings.ai || {};
  const isDemo = state.mode === 'demo';

  container.innerHTML = `
    <div class="page" id="ai-page">
      <div class="page-head">
        <div>
          <h1>AI Assistant</h1>
          <div class="sub">Configure how the backend generates AI replies through OpenRouter. The frontend never calls OpenRouter directly and never stores your API key. ${demoTag(isDemo)}</div>
        </div>
        <div class="page-head-actions">
          <button type="button" class="btn btn-primary" id="ai-save">${icon('save')} Save AI settings</button>
        </div>
      </div>

      <div class="grid grid-2">
        <section class="card" aria-labelledby="ai-status-title">
          <div class="card-head"><h3 id="ai-status-title">${icon('radio')} OpenRouter status</h3></div>
          <div class="card-body">
            <div class="kv-list">
              <div class="kv"><span class="k">Provider</span><span class="v">OpenRouter <span class="helper-text">(chat completions API)</span></span></div>
              <div class="kv"><span class="k">Credential</span><span class="v">${ai.keyConfigured ? badge('configured · masked', 'success', 'key-round') : badge('not configured', 'warn')}</span></div>
              <div class="kv"><span class="k">Saved key (masked)</span><span class="v"><code class="chip">${esc(ai.keyMask || '—')}</code></span></div>
              <div class="kv"><span class="k">Last successful test</span><span class="v">${ai.lastTestAt ? esc(fmtDateTime(ai.lastTestAt)) : 'never'}</span></div>
              <div class="kv"><span class="k">AI enabled</span><span class="v">${ai.enabled ? badge('enabled', 'success') : badge('disabled', 'warn')}</span></div>
            </div>
            <div class="helper-text" style="margin-top:12px">
              The key is stored server-side by your backend (e.g. Supabase Edge Function secrets or Vault). It is never returned to this dashboard — only a masked status.
            </div>
          </div>
        </section>

        <section class="card" aria-labelledby="ai-key-title">
          <div class="card-head"><h3 id="ai-key-title">${icon('key-round')} API credential</h3></div>
          <div class="card-body">
            <div class="field">
              <label for="ai-key">OpenRouter API key</label>
              <input id="ai-key" type="password" class="input input-mono" placeholder="sk-or-v1-…" autocomplete="off" />
              <div class="hint">${isDemo
                ? 'Demo mode: the value is accepted for the session UI only — it is never saved to storage and never sent anywhere.'
                : 'Sent once over HTTPS to your authenticated backend endpoint. Never stored in this browser.'}</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn btn-primary btn-sm" id="ai-key-save">${icon('upload')} Save credential</button>
              <button type="button" class="btn btn-danger-soft btn-sm" id="ai-key-clear">${icon('trash-2')} Clear stored credential</button>
            </div>
            <div class="note" style="margin-top:12px">${icon('shield-check')}<span>Security: the saved key can only be rotated or cleared — it cannot be read back from the server.</span></div>
          </div>
        </section>
      </div>

      <section class="card" style="margin-top:14px" aria-labelledby="ai-config-title">
        <div class="card-head"><h3 id="ai-config-title">${icon('bot')} Model & behaviour</h3></div>
        <div class="card-body">
          <div class="field-check" style="margin-bottom:18px">
            <input type="checkbox" id="ai-enabled" ${ai.enabled ? 'checked' : ''} />
            <label for="ai-enabled" style="font-weight:600">AI replies enabled
              <span class="hint">When off, AI-mode rules fall back to the fallback reply text below.</span>
            </label>
          </div>

          <div class="field-row">
            <div class="field" style="min-width:260px">
              <label for="ai-model">Model</label>
              <select id="ai-model" class="select">
                <option value="${esc(ai.model || '')}" selected>${esc(ai.model || 'Select a model')}</option>
              </select>
              <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
                <button type="button" class="btn btn-ghost btn-sm" id="ai-fetch-models">${icon('refresh-cw')} Fetch available models</button>
              </div>
              <div class="hint">Any model your OpenRouter account can access. Fetched through the backend proxy.</div>
            </div>
            <div class="field">
              <label for="ai-custom-model">Custom model ID</label>
              <input id="ai-custom-model" class="input input-mono" value="${esc(ai.customModel || '')}" placeholder="vendor/model-name" />
              <div class="hint">Overrides the selector when set — for models not listed by the proxy.</div>
            </div>
          </div>

          <div class="field">
            <label for="ai-prompt">System prompt <span class="hint">(tone, behaviour and response rules)</span></label>
            <textarea id="ai-prompt" class="textarea" rows="6">${esc(ai.systemPrompt || '')}</textarea>
            <div class="char-count"><span id="ai-prompt-count">0</span> chars</div>
          </div>

          <div class="field-row">
            <div class="field">
              <label for="ai-maxtokens">Maximum response tokens</label>
              <input id="ai-maxtokens" type="number" min="50" max="4000" class="input" value="${ai.maxTokens ?? 400}" />
            </div>
            <div class="field">
              <label for="ai-temp">Temperature <span class="hint" id="ai-temp-val">${ai.temperature ?? 0.7}</span></label>
              <input id="ai-temp" type="range" min="0" max="2" step="0.1" value="${ai.temperature ?? 0.7}" />
            </div>
            <div class="field">
              <label for="ai-context">Conversation context <span class="hint">(recent messages sent to the model)</span></label>
              <input id="ai-context" type="number" min="0" max="50" class="input" value="${ai.contextMessages ?? 10}" />
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="ai-maxinput">Maximum input length <span class="hint">(chars)</span></label>
              <input id="ai-maxinput" type="number" min="200" max="32000" class="input" value="${ai.maxInputChars ?? 2000}" />
            </div>
            <div class="field">
              <label for="ai-timeout">Request timeout <span class="hint">(ms)</span></label>
              <input id="ai-timeout" type="number" min="2000" max="120000" step="1000" class="input" value="${ai.timeoutMs ?? 20000}" />
            </div>
            <div class="field">
              <label for="ai-retries">Retries on failure</label>
              <input id="ai-retries" type="number" min="0" max="5" class="input" value="${ai.retries ?? 2}" />
            </div>
          </div>
          <div class="field">
            <label for="ai-fallback">Fallback reply <span class="hint">(sent when AI fails or is disabled)</span></label>
            <textarea id="ai-fallback" class="textarea" rows="2">${esc(ai.fallbackReply || '')}</textarea>
          </div>
        </div>
      </section>

      <div class="grid grid-2" style="margin-top:14px">
        <section class="card" aria-labelledby="ai-test-title">
          <div class="card-head"><h3 id="ai-test-title">${icon('flask-conical')} Test console</h3></div>
          <div class="card-body">
            <div class="note success" style="margin-bottom:12px">${icon('shield-check')}<span><b>Preview only — nothing is sent to Instagram.</b> This generates a proposed reply for the sample DM below.</span></div>
            <div class="field">
              <label for="ai-test-input">Sample DM</label>
              <textarea id="ai-test-input" class="textarea" rows="2" placeholder="e.g. Do you deliver to Adelaide and how much is shipping?"></textarea>
            </div>
            <button type="button" class="btn btn-primary" id="ai-test-run">${icon('play')} Generate preview</button>
            <div id="ai-test-result" style="margin-top:14px"></div>
          </div>
        </section>

        <section class="card" aria-labelledby="ai-usage-title">
          <div class="card-head"><h3 id="ai-usage-title">${icon('wallet')} Usage & estimated cost <span style="font-weight:400">(30 days)</span></h3></div>
          <div class="card-body">
            <div class="kv-list">
              <div class="kv"><span class="k">AI requests</span><span class="v">${fmtNum(usage.aiRequests)}</span></div>
              <div class="kv"><span class="k">Tokens in</span><span class="v">${fmtNum(usage.tokensIn)}</span></div>
              <div class="kv"><span class="k">Tokens out</span><span class="v">${fmtNum(usage.tokensOut)}</span></div>
              <div class="kv"><span class="k">Estimated cost</span><span class="v">${fmtCost(usage.estCostUsd)}</span></div>
            </div>
            <div class="helper-text" style="margin-top:10px">Cost is estimated from the pricing configured below your model (${esc(String(ai.pricing?.inputPerMillionUsd ?? 0.15))}/1M in, ${esc(String(ai.pricing?.outputPerMillionUsd ?? 0.6))}/1M out). Actual billing lives in your OpenRouter account. ${isDemo ? 'Demo values are simulated.' : ''}</div>
          </div>
        </section>
      </div>
    </div>`;

  refreshIcons(container);

  // prompt char count + temperature readout
  const prompt = container.querySelector('#ai-prompt');
  prompt.addEventListener('input', () => { container.querySelector('#ai-prompt-count').textContent = prompt.value.length; });
  container.querySelector('#ai-prompt-count').textContent = prompt.value.length;
  const temp = container.querySelector('#ai-temp');
  temp.addEventListener('input', () => { container.querySelector('#ai-temp-val').textContent = temp.value; });

  // fetch models
  container.querySelector('#ai-fetch-models').addEventListener('click', async () => {
    const select = container.querySelector('#ai-model');
    const btn = container.querySelector('#ai-fetch-models');
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Fetching…`;
    try {
      const res = await api.aiFetchModels();
      select.innerHTML = `<option value="">— select a model —</option>` +
        res.models.map((m) => `<option value="${esc(m.id)}" ${m.id === ai.model ? 'selected' : ''}>${esc(m.name)}</option>`).join('') +
        `<option value="__custom__">Custom model ID…</option>`;
      toast(res.simulated ? 'Demo model list loaded' : 'Models fetched for your account', 'info', 2400);
      if (res.note) toast(res.note, 'info', 5000);
    } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false; btn.innerHTML = `${icon('refresh-cw')} Fetch available models`;
    refreshIcons(btn);
  });
  container.querySelector('#ai-model').addEventListener('change', (e) => {
    if (e.target.value === '__custom__') { container.querySelector('#ai-custom-model').focus(); toast('Enter the vendor/model ID in the custom field below', 'info'); }
  });

  // save settings
  container.querySelector('#ai-save').addEventListener('click', async () => {
    const btn = container.querySelector('#ai-save');
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Saving…`;
    const modelSelect = container.querySelector('#ai-model').value;
    const patch = {
      ai: {
        enabled: container.querySelector('#ai-enabled').checked,
        model: modelSelect && modelSelect !== '__custom__' ? modelSelect : ai.model,
        customModel: container.querySelector('#ai-custom-model').value.trim(),
        systemPrompt: prompt.value,
        maxTokens: clampInt(container.querySelector('#ai-maxtokens').value, 50, 4000, 400),
        temperature: parseFloat(temp.value) || 0.7,
        contextMessages: clampInt(container.querySelector('#ai-context').value, 0, 50, 10),
        maxInputChars: clampInt(container.querySelector('#ai-maxinput').value, 200, 32000, 2000),
        timeoutMs: clampInt(container.querySelector('#ai-timeout').value, 2000, 120000, 20000),
        retries: clampInt(container.querySelector('#ai-retries').value, 0, 5, 2),
        fallbackReply: container.querySelector('#ai-fallback').value,
      },
    };
    try {
      const next = await api.updateSettings(patch);
      state.settings = next;
      toast('AI settings saved', 'success');
    } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false; btn.innerHTML = `${icon('save')} Save AI settings`;
    refreshIcons(btn);
  });

  // credential actions
  container.querySelector('#ai-key-save').addEventListener('click', async () => {
    const key = container.querySelector('#ai-key').value.trim();
    if (!key) { toast('Enter an API key first.', 'warn'); return; }
    const btn = container.querySelector('#ai-key-save');
    btn.disabled = true;
    try {
      const res = await api.aiConfigureKey(key);
      if (res.ok) {
        container.querySelector('#ai-key').value = '';
        toast(isDemo ? 'Demo credential accepted for this session only — not stored' : 'Credential stored server-side. It cannot be read back.', 'success');
        const statusBadges = container.querySelectorAll('.kv .v .badge');
        if (statusBadges[0]) { statusBadges[0].outerHTML = badge('configured · masked', 'success', 'key-round'); }
      } else toast(res.error || 'Could not save credential', 'error');
    } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false;
  });
  container.querySelector('#ai-key-clear').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Clear stored credential?',
      message: 'AI-generated replies will fail until a new credential is configured. This action rotates nothing — it removes the stored key.',
      confirmLabel: 'Clear credential', danger: true,
    });
    if (!ok) return;
    try {
      await api.aiConfigureKey('', { clear: true });
      toast('Credential cleared', 'success');
      render(container); // re-render status
    } catch (err) { toast(err.message, 'error'); }
  });

  // test console
  container.querySelector('#ai-test-run').addEventListener('click', async () => {
    const input = container.querySelector('#ai-test-input');
    const result = container.querySelector('#ai-test-result');
    const run = container.querySelector('#ai-test-run');
    const text = input.value.trim();
    if (!text) { toast('Enter a sample DM first.', 'warn'); return; }
    run.disabled = true; run.innerHTML = `<span class="spinner"></span> Generating…`;
    result.innerHTML = `<div class="loading-block"><span class="spinner"></span> Contacting ${isDemo ? 'demo engine' : 'backend'}…</div>`;
    try {
      const res = await api.aiTest(text);
      if (res.ok) {
        result.innerHTML = `
          <div style="font-size:12px;font-weight:700;color:var(--text-2);margin-bottom:4px">Proposed reply ${badge(`AI · ${res.model}`, 'info', 'sparkles')}</div>
          <div class="card" style="padding:12px;background:var(--primary-softer)"><div class="bubble-text" style="color:var(--text)">${esc(res.reply)}</div></div>
          <div class="helper-text" style="margin-top:8px">Latency ~${res.latencyMs}ms · ~${res.tokensIn} in / ~${res.tokensOut} out tokens ${isDemo ? '· simulated values' : ''}</div>
          <div class="note warn" style="margin-top:10px">${icon('triangle-alert')}<span>This is a preview only. Nothing has been sent. Replies are delivered exclusively by the backend during live automation.</span></div>`;
      } else {
        result.innerHTML = `<div class="note danger">${icon('circle-alert')}<span>${esc(res.error || 'Test failed')}</span></div>`;
      }
      refreshIcons(result);
    } catch (err) {
      result.innerHTML = `<div class="note danger">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
      refreshIcons(result);
    }
    run.disabled = false; run.innerHTML = `${icon('play')} Generate preview`;
    refreshIcons(run);
  });

  unsub = onDemoChange(() => { /* status card shows lastTestAt via re-render on clear only */ });
  return () => { if (unsub) { unsub(); unsub = null; } };
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
