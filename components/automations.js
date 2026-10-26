/* GrowizeMessages — automation rules manager.
 * Create / edit / duplicate / reorder / test rules. The rule tester runs
 * locally (demo) or against POST /api/rules/test (live) and NEVER sends
 * anything to Instagram. */

import { state } from '../services/store.js';
import { api } from '../services/api.js';
import { onChange as onDemoChange } from '../services/demo.js';
import { TRIGGER_TYPES, REPLY_MODES, validateRegex, describeRule } from '../services/rules-engine.js';
import {
  esc, icon, refreshIcons, badge, demoTag, fmtRel, toast, confirmDialog,
  openDrawer, openModal, emptyState, spinnerBlock, debounce,
} from './ui.js';

let rules = [];
let search = '';
let filter = 'all';
let unsub = null;

export async function render(container) {
  container.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Automations</h1>
          <div class="sub">Rules are evaluated top-down by priority (1 = highest). The first eligible matching rule replies; ${'“'}fallback${'”'} rules apply only when nothing else matches. ${demoTag(state.mode === 'demo')}</div>
        </div>
        <div class="page-head-actions">
          <button type="button" class="btn btn-ghost" id="open-tester">${icon('flask-conical')} Test rules</button>
          <button type="button" class="btn btn-primary" id="new-rule">${icon('plus')} New rule</button>
        </div>
      </div>

      ${!state.settings?.automationEnabled ? `<div class="note warn" style="margin-bottom:14px">${icon('pause')}<span><b>Global automation is paused.</b> Rules are evaluated and logged, but no automated replies are sent until you resume it.</span></div>` : ''}

      <div class="card">
        <div class="card-head" style="flex-wrap:wrap">
          <h3>${icon('workflow')} Rules <span id="rule-count" class="helper-text" style="font-weight:400"></span></h3>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <div class="topbar-search" style="width:230px">
              ${icon('search')}
              <input type="search" class="input input-sm" id="rule-search" placeholder="Search rules…" aria-label="Search rules" />
            </div>
            <select class="select input-sm" id="rule-filter" aria-label="Filter rules" style="width:auto">
              <option value="all">All rules</option>
              <option value="enabled">Enabled only</option>
              <option value="disabled">Disabled only</option>
            </select>
          </div>
        </div>
        <div id="rules-root">${spinnerBlock('Loading rules…')}</div>
      </div>

      <div class="helper-text" style="margin-top:12px">
        When several rules match, the highest-priority eligible rule wins and sends a single reply. Cooldowns suppress repeat replies for the same rule. Comment-triggered automations are a planned future integration and are not part of the incoming-DM pipeline.
      </div>
    </div>`;

  refreshIcons(container);
  container.querySelector('#new-rule').addEventListener('click', () => openEditor(container, null));
  container.querySelector('#open-tester').addEventListener('click', () => openTester(container));

  const doSearch = debounce((v) => { search = v; paintRules(container); }, 200);
  container.querySelector('#rule-search').addEventListener('input', (e) => doSearch(e.target.value));
  container.querySelector('#rule-filter').addEventListener('change', (e) => { filter = e.target.value; paintRules(container); });

  await reload(container);
  unsub = onDemoChange(() => { if (container.isConnected) reload(container); });
  return () => { if (unsub) { unsub(); unsub = null; } };
}

async function reload(container) {
  try {
    rules = await api.listRules();
  } catch (err) {
    const root = container.querySelector('#rules-root');
    if (root) root.innerHTML = `<div class="note danger">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
    refreshIcons(root);
    return;
  }
  if (container.isConnected) paintRules(container);
}

function paintRules(container) {
  const root = container.querySelector('#rules-root');
  if (!root) return;
  const q = search.toLowerCase();
  let rows = rules.filter((r) =>
    (filter === 'all' || (filter === 'enabled' ? r.enabled : !r.enabled)) &&
    (!q || r.name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q) ||
      (r.keywords || []).some((k) => k.toLowerCase().includes(q))));

  container.querySelector('#rule-count').textContent = `(${rows.length}${rows.length !== rules.length ? ` of ${rules.length}` : ''})`;

  if (!rules.length) {
    root.innerHTML = emptyState({
      iconName: 'workflow', title: 'No automation rules yet',
      sub: 'Create your first rule to start answering frequent questions automatically.',
      actionHtml: `<button type="button" class="btn btn-primary" id="empty-new">${icon('plus')} Create rule</button>`,
    });
    refreshIcons(root);
    root.querySelector('#empty-new')?.addEventListener('click', () => openEditor(container, null));
    return;
  }
  if (!rows.length) {
    root.innerHTML = emptyState({ iconName: 'search', title: 'No rules match your filters', sub: 'Adjust the search or filter to see your rules.' });
    return;
  }

  root.innerHTML = `
    <div class="table-wrap" style="border:none;border-radius:0;box-shadow:none">
      <table class="data">
        <thead><tr>
          <th style="width:36px"></th><th>Rule</th><th>Trigger → Reply</th>
          <th>Priority</th><th>Usage</th><th>Status</th><th style="text-align:right">Actions</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => ruleRow(r)).join('')}
        </tbody>
      </table>
    </div>`;
  refreshIcons(root);

  root.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { act, id } = btn.dataset;
      const rule = rules.find((r) => r.id === id);
      if (!rule) return;
      try {
        if (act === 'edit') openEditor(container, rule);
        else if (act === 'duplicate') { await api.duplicateRule(id); toast('Rule duplicated (disabled by default)', 'success'); }
        else if (act === 'move-up') { rules = await api.moveRule(id, 'up'); paintRules(container); }
        else if (act === 'move-down') { rules = await api.moveRule(id, 'down'); paintRules(container); }
        else if (act === 'test') openTester(container, id);
        else if (act === 'toggle') { await api.updateRule(id, { enabled: !rule.enabled }); toast(rule.enabled ? 'Rule disabled' : 'Rule enabled', 'info', 1800); }
        else if (act === 'delete') {
          const ok = await confirmDialog({
            title: 'Delete rule?',
            message: `“${rule.name}” will be removed permanently. Incoming messages will no longer be matched by it.`,
            confirmLabel: 'Delete rule', danger: true,
          });
          if (!ok) return;
          await api.deleteRule(id);
          toast('Rule deleted', 'success');
        }
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  root.querySelectorAll('[data-rule-switch]').forEach((sw) => {
    sw.addEventListener('change', async () => {
      const id = sw.dataset.ruleSwitch;
      const rule = rules.find((r) => r.id === id);
      try { await api.updateRule(id, { enabled: sw.checked }); toast(sw.checked ? 'Rule enabled' : 'Rule disabled', 'info', 1600); }
      catch (err) { sw.checked = !sw.checked; toast(err.message, 'error'); }
    });
  });
}

function ruleRow(r) {
  const trig = TRIGGER_TYPES.find((t) => t.id === r.triggerType);
  const mode = REPLY_MODES.find((m) => m.id === r.replyMode);
  const kw = (r.keywords || []);
  const kwLabel = r.triggerType === 'regex' ? kw[0] : kw.slice(0, 3).join(', ') + (kw.length > 3 ? ` +${kw.length - 3}` : '');
  return `
    <tr data-id="${esc(r.id)}">
      <td>${r.triggerType === 'fallback' ? badge('fallback', 'outline') : `<span style="color:var(--text-3);font-size:12px">${r.priority}</span>`}</td>
      <td>
        <div class="cell-strong">${esc(r.name)}</div>
        <div class="cell-sub">${esc(r.description || '')}</div>
      </td>
      <td>
        <div style="font-size:12.5px">${esc(trig?.label || r.triggerType)}</div>
        <div class="cell-sub" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(kwLabel)}">${esc(kwLabel || '—')}</div>
        <div class="cell-sub">→ ${esc(mode?.label || r.replyMode)}</div>
      </td>
      <td>
        <div class="row-actions">
          <button type="button" class="icon-btn" data-act="move-up" data-id="${esc(r.id)}" title="Move up (higher priority)" aria-label="Move ${esc(r.name)} up">${icon('arrow-up')}</button>
          <button type="button" class="icon-btn" data-act="move-down" data-id="${esc(r.id)}" title="Move down (lower priority)" aria-label="Move ${esc(r.name)} down">${icon('arrow-down')}</button>
        </div>
        <span style="font-size:11px;color:var(--text-3);display:block;margin-top:2px">P${r.priority}</span>
      </td>
      <td>
        <div style="font-weight:600">${r.triggerCount}×</div>
        <div class="cell-sub">${r.lastTriggeredAt ? esc(fmtRel(r.lastTriggeredAt)) : 'never'}</div>
      </td>
      <td>
        <label class="switch" title="${r.enabled ? 'Disable rule' : 'Enable rule'}">
          <input type="checkbox" data-rule-switch="${esc(r.id)}" ${r.enabled ? 'checked' : ''} aria-label="Rule ${esc(r.name)} enabled" />
          <span class="track"></span>
        </label>
        ${r.cooldownMins ? `<div class="cell-sub">${r.cooldownMins}m cooldown</div>` : ''}
      </td>
      <td class="actions">
        <div class="row-actions">
          <button type="button" class="icon-btn" data-act="edit" data-id="${esc(r.id)}" title="Edit" aria-label="Edit ${esc(r.name)}">${icon('pencil')}</button>
          <button type="button" class="icon-btn" data-act="test" data-id="${esc(r.id)}" title="Test this rule" aria-label="Test ${esc(r.name)}">${icon('flask-conical')}</button>
          <button type="button" class="icon-btn" data-act="duplicate" data-id="${esc(r.id)}" title="Duplicate" aria-label="Duplicate ${esc(r.name)}">${icon('copy')}</button>
          <button type="button" class="icon-btn danger" data-act="delete" data-id="${esc(r.id)}" title="Delete" aria-label="Delete ${esc(r.name)}">${icon('trash-2')}</button>
        </div>
      </td>
    </tr>`;
}

/* ============================================================
   Rule editor (drawer)
   ============================================================ */
function openEditor(container, rule) {
  const isNew = !rule;
  const r = rule ? JSON.parse(JSON.stringify(rule)) : {
    name: '', description: '', enabled: true, priority: nextPriority(),
    triggerType: 'contains', keywords: [], excludedKeywords: [], caseSensitive: false,
    replyMode: state.settings?.defaultReplyMode === 'predefined' ? 'predefined' : 'ai',
    replyText: '', aiInstruction: '', cooldownMins: 0,
  };

  const { close } = openDrawer({
    title: isNew ? 'Create automation rule' : `Edit rule — ${esc(r.name)}`,
    body: `
      <div class="field">
        <label for="rf-name">Rule name *</label>
        <input id="rf-name" class="input" value="${esc(r.name)}" placeholder="e.g. Pricing questions" autofocus />
      </div>
      <div class="field">
        <label for="rf-desc">Description</label>
        <input id="rf-desc" class="input" value="${esc(r.description)}" placeholder="What this rule is for (internal note)" />
      </div>
      <div class="field-row">
        <div class="field">
          <label for="rf-priority">Priority <span class="hint">(1 = highest)</span></label>
          <input id="rf-priority" type="number" min="1" max="999" class="input" value="${r.priority}" />
        </div>
        <div class="field">
          <label for="rf-cooldown">Cooldown <span class="hint">(minutes, 0 = none)</span></label>
          <input id="rf-cooldown" type="number" min="0" max="10080" class="input" value="${r.cooldownMins ?? 0}" />
        </div>
        <div class="field">
          <label>Enabled</label>
          <label class="switch" style="height:34px">
            <input type="checkbox" id="rf-enabled" ${r.enabled ? 'checked' : ''} />
            <span class="track"></span>
          </label>
        </div>
      </div>

      <hr class="divider" />
      <div class="field">
        <label for="rf-trigger">Trigger type</label>
        <select id="rf-trigger" class="select">${TRIGGER_TYPES.map((t) => `<option value="${t.id}" ${t.id === r.triggerType ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
      </div>
      <div class="field" data-kw-wrap>
        <label for="rf-keywords">${r.triggerType === 'regex' ? 'Regular expression' : 'Trigger keywords or phrases'} *</label>
        <textarea id="rf-keywords" class="textarea" rows="3" placeholder="${r.triggerType === 'regex' ? 'e.g. ^(price|cost)' : 'One per line — e.g. price&#10;how much'}">${esc((r.keywords || []).join('\n'))}</textarea>
        <div class="hint" data-kw-hint>${triggerHint(r.triggerType)}</div>
        <div class="err" data-kw-err hidden></div>
      </div>
      <div class="field">
        <label for="rf-excluded">Excluded keywords <span class="hint">(message containing any of these is never matched)</span></label>
        <textarea id="rf-excluded" class="textarea" rows="2" placeholder="One per line — e.g. wholesale">${esc((r.excludedKeywords || []).join('\n'))}</textarea>
      </div>
      <div class="field-check">
        <input type="checkbox" id="rf-case" ${r.caseSensitive ? 'checked' : ''} />
        <label for="rf-case">Case-sensitive matching <span class="hint">Off by default — “Price” and “price” both match.</span></label>
      </div>

      <hr class="divider" />
      <div class="field">
        <label for="rf-mode">Reply mode</label>
        <select id="rf-mode" class="select">${REPLY_MODES.map((m) => `<option value="${m.id}" ${m.id === r.replyMode ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
      </div>

      <div data-reply-predefined ${r.replyMode === 'predefined' ? '' : 'hidden'}>
        <div class="field">
          <label for="rf-reply">Reply text *</label>
          <textarea id="rf-reply" class="textarea" rows="4" maxlength="1000" placeholder="The exact reply to send…">${esc(r.replyText)}</textarea>
          <div class="char-count"><span id="rf-reply-count">0</span>/1000</div>
          <div class="hint">Template variables: <code class="chip">{name}</code> <code class="chip">{username}</code> — filled only when that data is available.</div>
        </div>
        <div class="field">
          <label>Preview</label>
          <div class="card" style="padding:12px;background:var(--primary-softer);border-color:var(--border)"><div class="bubble-text" id="rf-reply-preview" style="color:var(--text)"></div></div>
        </div>
      </div>

      <div data-reply-ai ${r.replyMode === 'ai' ? '' : 'hidden'}>
        <div class="note">${icon('bot')}<span>This rule replies with the <b>global AI assistant</b> configuration (model, system prompt, limits). Manage them on the <a href="#/ai">AI Assistant page</a>.</span></div>
      </div>

      <div data-reply-aii ${r.replyMode === 'ai_instruction' ? '' : 'hidden'}>
        <div class="field">
          <label for="rf-aii">Rule-specific AI instruction</label>
          <textarea id="rf-aii" class="textarea" rows="3" placeholder="Extra guidance for the AI when this rule matches — e.g. always mention free delivery over $50.">${esc(r.aiInstruction)}</textarea>
          <div class="hint">Appended to the global system prompt. Requires backend support for per-rule instructions.</div>
        </div>
      </div>

      ${!isNew ? `
        <hr class="divider" />
        <div class="kv-list">
          <div class="kv"><span class="k">Total triggers</span><span class="v">${r.triggerCount}×</span></div>
          <div class="kv"><span class="k">Last triggered</span><span class="v">${r.lastTriggeredAt ? esc(fmtRel(r.lastTriggeredAt)) : 'never'}</span></div>
        </div>` : ''}
    `,
    footer: `
      <div class="left"><span class="helper-text">${isNew ? 'The rule starts enabled by default.' : esc(describeRule(r))}</span></div>
      <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-save>${icon('check')} ${isNew ? 'Create rule' : 'Save changes'}</button>`,
    onMount(drawer, closeFn) {
      const $ = (s) => drawer.querySelector(s);
      const keywordsField = $('[data-kw-wrap]');

      const syncMode = () => {
        const mode = $('#rf-mode').value;
        $('[data-reply-predefined]').hidden = mode !== 'predefined';
        $('[data-reply-ai]').hidden = mode !== 'ai';
        $('[data-reply-aii]').hidden = mode !== 'ai_instruction';
      };
      $('#rf-mode').addEventListener('change', syncMode);

      const syncTrigger = () => {
        const t = $('#rf-trigger').value;
        keywordsField.querySelector('label').innerHTML = t === 'regex'
          ? 'Regular expression *'
          : 'Trigger keywords or phrases *';
        keywordsField.querySelector('[data-kw-hint]').textContent = triggerHint(t);
      };
      $('#rf-trigger').addEventListener('change', syncTrigger);

      const updatePreview = () => {
        const text = $('#rf-reply').value;
        $('#rf-reply-count').textContent = text.length;
        const preview = text
          .replace(/\{name\}/g, 'Sample')
          .replace(/\{username\}/g, '@sampleuser');
        $('#rf-reply-preview').textContent = preview || 'Preview appears here as you type.';
      };
      $('#rf-reply').addEventListener('input', updatePreview);
      updatePreview();
      syncMode();

      drawer.querySelector('[data-cancel]').addEventListener('click', closeFn);
      drawer.querySelector('[data-save]').addEventListener('click', async () => {
        const name = $('#rf-name').value.trim();
        const triggerType = $('#rf-trigger').value;
        const keywords = $('#rf-keywords').value.split('\n').map((s) => s.trim()).filter(Boolean);
        const excludedKeywords = $('#rf-excluded').value.split('\n').map((s) => s.trim()).filter(Boolean);
        const replyMode = $('#rf-mode').value;
        const replyText = $('#rf-reply').value;
        const errEl = keywordsField.querySelector('[data-kw-err]');

        const fail = (msg) => { errEl.textContent = msg; errEl.hidden = false; errEl.scrollIntoView({ block: 'nearest' }); };
        errEl.hidden = true;

        if (!name) return fail('Rule name is required.');
        if (triggerType !== 'fallback' && !keywords.length) return fail('Add at least one trigger keyword or phrase.');
        if (triggerType === 'regex') {
          const v = validateRegex(keywords[0] || '');
          if (!v.ok) return fail(v.error);
        }
        if (replyMode === 'predefined' && !replyText.trim()) return fail('Predefined reply text is required.');
        if (replyMode === 'predefined' && replyText.length > 1000) return fail('Reply text exceeds 1000 characters (Instagram limit is 1000).');

        const payload = {
          name, description: $('#rf-desc').value.trim(),
          enabled: $('#rf-enabled').checked,
          priority: Math.max(1, Math.min(999, parseInt($('#rf-priority').value, 10) || 1)),
          triggerType, keywords, excludedKeywords,
          caseSensitive: $('#rf-case').checked,
          replyMode, replyText, aiInstruction: $('#rf-aii').value.trim(),
          cooldownMins: Math.max(0, parseInt($('#rf-cooldown').value, 10) || 0),
        };
        const btn = drawer.querySelector('[data-save]');
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner"></span> Saving…`;
        try {
          if (isNew) { await api.createRule(payload); toast('Rule created', 'success'); }
          else { await api.updateRule(r.id, payload); toast('Rule saved', 'success'); }
          closeFn();
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.innerHTML = `${icon('check')} ${isNew ? 'Create rule' : 'Save changes'}`; }
      });
    },
  });
  return close;
}

function triggerHint(t) {
  switch (t) {
    case 'exact': return 'The message must equal one of these lines exactly (after trimming).';
    case 'starts_with': return 'The message must start with one of these lines.';
    case 'any_keyword': return 'Matches if ANY of these words/phrases appear in the message.';
    case 'all_keywords': return 'Matches only if ALL of these words/phrases appear in the message.';
    case 'contains': return 'Matches if any of these words/phrases appear anywhere in the message.';
    case 'regex': return 'Validated for safety — nested quantifiers like (a+)+ are rejected to protect the engine.';
    default: return 'Fallback rules match only when no other rule matched.';
  }
}

function nextPriority() {
  const nums = rules.filter((r) => r.triggerType !== 'fallback').map((r) => r.priority);
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

/* ============================================================
   Rule tester (modal) — never sends anything
   ============================================================ */
function openTester(container, ruleId = null) {
  const { close } = openModal({
    title: `Test rules — ${state.mode === 'demo' ? 'simulated' : 'safe preview'}`,
    size: 'wide',
    body: `
      <div class="note success" style="margin-bottom:14px">${icon('shield-check')}<span><b>Nothing is sent to Instagram from this panel.</b> It shows which rule would match and what the reply would be.</span></div>
      <div class="field">
        <label for="tt-sample">Sample incoming message</label>
        <textarea id="tt-sample" class="textarea" rows="2" placeholder="Paste or type a DM, e.g. “hi, how much is the balcony kit?”"></textarea>
      </div>
      <div class="field">
        <label for="tt-rule">Scope</label>
        <select id="tt-rule" class="select">
          <option value="">All rules (priority order)</option>
          ${rules.map((r) => `<option value="${esc(r.id)}" ${r.id === ruleId ? 'selected' : ''}>Only “${esc(r.name)}”</option>`).join('')}
        </select>
      </div>
      <button type="button" class="btn btn-primary" id="tt-run">${icon('play')} Run test</button>
      <div id="tt-result" style="margin-top:16px"></div>`,
    onMount(modal) {
      const sample = modal.querySelector('#tt-sample');
      const result = modal.querySelector('#tt-result');
      const run = modal.querySelector('#tt-run');
      sample.focus();
      const doRun = async () => {
        const text = sample.value.trim();
        if (!text) { result.innerHTML = `<div class="note warn">${icon('triangle-alert')}<span>Enter a sample message first.</span></div>`; refreshIcons(result); return; }
        run.disabled = true;
        run.innerHTML = `<span class="spinner"></span> Testing…`;
        try {
          const res = await api.testRules({ text, ruleId: modal.querySelector('#tt-rule').value || null });
          result.innerHTML = testResultHtml(res, text);
        } catch (err) {
          result.innerHTML = `<div class="note danger">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
        }
        refreshIcons(result);
        run.disabled = false;
        run.innerHTML = `${icon('play')} Run test`;
      };
      run.addEventListener('click', doRun);
      sample.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doRun(); });
    },
    footer: `<button type="button" class="btn btn-ghost" data-close>Close</button>`,
  });
  return close;
}

function testResultHtml(res, text) {
  if (!res.ok) return `<div class="note danger">${icon('circle-alert')}<span>${esc(res.error || 'Test failed')}</span></div>`;
  const w = res.winner;
  return `
    ${w ? `
      <div class="card card-pad" style="border-color:var(--primary)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          ${badge('matched rule', 'success', 'zap')} <b>${esc(w.rule.name)}</b>
          ${w.isFallback ? badge('fallback applied', 'outline') : ''}
        </div>
        <div class="helper-text" style="margin-bottom:10px">${esc(w.reason)}</div>
        ${res.reply ? `
          <div style="font-size:12px;font-weight:700;color:var(--text-2);margin-bottom:4px">Proposed reply ${res.reply.mode !== 'predefined' ? badge(`AI · ${res.reply.model || ''}`, 'info', 'sparkles') : badge('predefined', 'neutral')}</div>
          <div class="card" style="padding:12px;background:var(--primary-softer)">
            <div class="bubble-text" style="color:var(--text)">${esc(res.reply.text || '(empty reply)')}</div>
          </div>
          ${res.reply.unresolved?.length ? `<div class="note warn" style="margin-top:8px">${icon('triangle-alert')}<span>Unresolved template variables: ${esc(res.reply.unresolved.join(', '))} — they will be left as-is unless that data is available at send time.</span></div>` : ''}
          ${res.reply.note ? `<div class="helper-text" style="margin-top:6px">${esc(res.reply.note)}</div>` : ''}
        ` : ''}
      </div>` : `
      <div class="note warn">${icon('triangle-alert')}<span><b>No rule matched</b> this sample message${text ? ':' : '.'} “${esc(text)}”. Consider adding a keyword, adjusting match conditions, or enabling a fallback rule.</span></div>`}
    ${res.evaluated?.length ? `
      <div class="section-title">Evaluation trace</div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Rule</th><th>Result</th><th>Reason</th></tr></thead>
          <tbody>${res.evaluated.map((e) => `
            <tr>
              <td class="cell-strong">${esc(e.ruleName)}</td>
              <td>${e.matched ? badge('matched', 'success') : badge('no match', 'neutral')}</td>
              <td class="cell-sub">${esc(e.reason)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}`;
}
