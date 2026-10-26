/* GrowizeMessages backend — automation engine.
 * The authoritative pipeline: incoming DM → dedup → persist → rule match
 * → cooldown / rate limits / 24h window → AI or predefined reply → send
 * through the Instagram Messaging API → statuses + activity logs.
 *
 * Guarantees (mirrors the product spec):
 * - The browser NEVER talks to Meta or OpenRouter.
 * - "Sent" is only ever shown after Meta accepted the message.
 * - Global pause and per-conversation pause are enforced before every
 *   automated send.
 */

import { db, uid, getSettingsRow, updateSettingsData, logActivity } from './lib.js';
import { matchRules, applyTemplate } from './rules.mjs';
import { sendIgMessage, getIgConfig, fetchContactProfile } from './ig.js';
import { generateReply } from './ai.js';

const DAY_MS = 86_400_000;

export function convLabel(conv) {
  return `${conv.name || 'Instagram user'}${conv.username ? ` (@${conv.username.replace(/^@/, '')})` : ''}`;
}

export async function getConversation(id) {
  const { data } = await db().from('conversations').select('*').eq('id', id).maybeSingle();
  return data || null;
}

export async function historyFor(conversationId, limit = 10) {
  const { data } = await db().from('messages')
    .select('direction, text, at')
    .eq('conversationId', conversationId)
    .order('at', { ascending: false })
    .limit(Math.max(1, limit));
  return (data || []).reverse().filter((m) => m.text && !m.text.startsWith('[media'));
}

/* ---------- inbound conversation upsert ---------- */
export async function upsertIncomingConversation({ igsid, at, preview, igConfig }) {
  const existing = await getConversation(igsid);
  if (existing) {
    const patch = {
      unread: (existing.unread || 0) + 1,
      messageCount: (existing.messageCount || 0) + 1,
      lastMessageAt: at,
      lastMessagePreview: preview,
      lastInboundAt: at,
    };
    // Refresh the display name opportunistically (profile data may arrive late).
    if (!existing.username || existing.name === 'Instagram user') {
      const profile = await fetchContactProfile(igsid, igConfig);
      if (profile.username) patch.username = profile.username;
      if (profile.name) patch.name = profile.name;
    }
    const { data } = await db().from('conversations').update(patch).eq('id', igsid).select('*').single();
    return data;
  }
  // New conversation — try to resolve the real profile (best effort).
  const profile = await fetchContactProfile(igsid, igConfig);
  const { data } = await db().from('conversations').upsert({
    id: igsid,
    name: profile.name || 'Instagram user',
    username: profile.username || `ig_${igsid.slice(-6)}`,
    paused: false,
    unread: 1,
    messageCount: 1,
    lastMessageAt: at,
    lastMessagePreview: preview,
    lastInboundAt: at,
  }).select('*').single();
  return data;
}

/* ---------- outbound send (shared by manual + automated) ---------- */
export async function sendOutbound({ conv, text, viaAI = false, ruleId = null, ruleName = null, model = null, tokensIn = null, tokensOut = null, manual = false, correlationId, source = 'automation' }) {
  const at = new Date().toISOString();
  const message = {
    id: uid('msg'),
    conversationId: conv.id,
    direction: 'out',
    status: 'queued',
    text,
    at,
    viaAI,
    ruleId,
    ruleName,
    error: null,
    correlationId,
    model,
    tokensIn,
    tokensOut,
    manual,
    source,
  };
  await db().from('messages').insert(message);
  await db().from('conversations').update({
    lastMessageAt: at,
    lastMessagePreview: String(text).slice(0, 80),
    messageCount: (conv.messageCount || 0) + 1,
  }).eq('id', conv.id);
  await logActivity({
    at, category: 'reply_queued', status: 'info',
    conversationId: conv.id, conversationName: convLabel(conv),
    ruleId, ruleName, correlationId,
    message: manual ? 'Manual reply queued for delivery' : viaAI ? 'AI reply queued for delivery' : 'Rule reply queued for delivery',
  });

  try {
    const igConfig = await getIgConfig();
    const res = await sendIgMessage(conv.id, text, igConfig);
    const { error: upErr } = await db().from('messages').update({ status: 'sent', error: null }).eq('id', message.id);
    if (upErr) console.error('message finalize failed', upErr);
    await logActivity({
      category: 'reply_sent', status: 'success',
      conversationId: conv.id, conversationName: convLabel(conv),
      ruleId, ruleName, correlationId,
      message: `Reply delivered via Instagram Messaging API`,
      detail: `Meta message id ${res?.message_id || 'unknown'}`,
    });
    return { ...message, status: 'sent' };
  } catch (err) {
    await db().from('messages').update({ status: 'failed', error: err.message }).eq('id', message.id);
    await logActivity({
      category: 'reply_failed', status: 'error',
      conversationId: conv.id, conversationName: convLabel(conv),
      ruleId, ruleName, correlationId,
      message: `Reply failed: ${err.message}`,
      detail: err.metaCode ? `Meta error code ${err.metaCode}${err.metaSubcode ? ` (subcode ${err.metaSubcode})` : ''}. No message was delivered.` : null,
    });
    return { ...message, status: 'failed', error: err.message };
  }
}

/* ---------- the automation pipeline ---------- */
export async function processIncoming({ igsid, text, at, correlationId }) {
  const settingsRow = await getSettingsRow();
  const settings = settingsRow.data;
  const conv = await getConversation(igsid);
  if (!conv) return;

  // 1. Global pause
  if (!settings.automationEnabled) {
    await logActivity({
      category: 'rule_evaluated', status: 'info', conversationId: conv.id, conversationName: convLabel(conv),
      message: 'Global automation is PAUSED — no automated reply attempted', correlationId,
    });
    return;
  }
  // 2. Per-conversation pause
  if (conv.paused) {
    await logActivity({
      category: 'rule_evaluated', status: 'info', conversationId: conv.id, conversationName: convLabel(conv),
      message: 'Automation is paused for this conversation — no automated reply attempted', correlationId,
    });
    return;
  }

  // 3. Rule evaluation
  const { data: rules } = await db().from('rules').select('*');
  const enabledRules = (rules || []).map((r) => ({ ...r, keywords: r.keywords || [], excludedKeywords: r.excludedKeywords || [] }));
  await logActivity({
    category: 'rule_evaluated', status: 'info', conversationId: conv.id, conversationName: convLabel(conv),
    message: `Evaluated ${enabledRules.filter((r) => r.enabled !== false).length} enabled rules against message`, correlationId,
  });

  const { winner, evaluated } = matchRules(enabledRules, text);
  if (!winner) {
    await logActivity({
      category: 'rule_evaluated', status: 'info', conversationId: conv.id, conversationName: convLabel(conv),
      message: 'No rule matched — no automated reply sent', correlationId,
    });
    return;
  }
  const rule = winner.rule;

  // 4. Cooldown (global per rule, mirrors the rule tester semantics)
  if (rule.cooldownMins > 0 && rule.lastTriggeredAt &&
      Date.now() - new Date(rule.lastTriggeredAt).getTime() < rule.cooldownMins * 60_000) {
    await logActivity({
      category: 'rule_evaluated', status: 'info', conversationId: conv.id, conversationName: convLabel(conv),
      ruleId: rule.id, ruleName: rule.name,
      message: `Rule matched but cooldown active (${rule.cooldownMins} min) — reply suppressed`, correlationId,
    });
    return;
  }

  // 5. Per-conversation rate limit
  const maxReplies = settings.maxRepliesPerConversation ?? 3;
  const windowMins = settings.repliesWindowMins ?? 60;
  if (maxReplies > 0) {
    const since = new Date(Date.now() - windowMins * 60_000).toISOString();
    const { count } = await db().from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversationId', conv.id).eq('direction', 'out').eq('source', 'automation')
      .gte('at', since);
    if ((count || 0) >= maxReplies) {
      await logActivity({
        category: 'rule_evaluated', status: 'info', conversationId: conv.id, conversationName: convLabel(conv),
        ruleId: rule.id, ruleName: rule.name,
        message: `Rate limit reached (${maxReplies} automated replies / ${windowMins} min) — reply suppressed`, correlationId,
      });
      return;
    }
  }

  // 6. 24h messaging window (Meta policy — enforced before spending tokens)
  const lastInbound = conv.lastInboundAt ? new Date(conv.lastInboundAt).getTime() : 0;
  if (!lastInbound || Date.now() - lastInbound > DAY_MS) {
    await logActivity({
      category: 'rule_evaluated', status: 'info', conversationId: conv.id, conversationName: convLabel(conv),
      ruleId: rule.id, ruleName: rule.name,
      message: 'Recipient is outside the 24h messaging window — automated reply suppressed (Meta policy)', correlationId,
    });
    return;
  }

  await logActivity({
    category: 'rule_matched', status: 'success', conversationId: conv.id, conversationName: convLabel(conv),
    ruleId: rule.id, ruleName: rule.name,
    message: `Rule "${rule.name}" matched`, detail: winner.reason, correlationId,
  });
  await db().from('rules').update({ triggerCount: (rule.triggerCount || 0) + 1, lastTriggeredAt: new Date().toISOString() }).eq('id', rule.id);

  // 7. Build the reply
  let replyText = null, viaAI = false, model = null, tokensIn = null, tokensOut = null;
  if (rule.replyMode === 'predefined') {
    const t = applyTemplate(rule.replyText, { name: (conv.name || 'there').split(' ')[0], username: conv.username ? `@${conv.username.replace(/^@/, '')}` : '', firstName: (conv.name || 'there').split(' ')[0] });
    replyText = t.text;
    if (t.unresolved.length) {
      await logActivity({
        category: 'rule_matched', status: 'info', conversationId: conv.id, conversationName: convLabel(conv),
        ruleId: rule.id, ruleName: rule.name,
        message: `Template variables not available, left as-is: ${t.unresolved.join(', ')}`, correlationId,
      });
    }
  } else {
    viaAI = true;
    try {
      const history = await historyFor(conv.id, settings.ai?.contextMessages ?? 10);
      const out = await generateReply({
        settings,
        instruction: rule.replyMode === 'ai_instruction' ? rule.aiInstruction : null,
        history,
        incomingText: text,
        correlationId,
        conversationRef: { id: conv.id, label: convLabel(conv) },
      });
      replyText = out.text;
      model = out.model;
      tokensIn = out.tokensIn;
      tokensOut = out.tokensOut;
    } catch (err) {
      if (err.code === 'NO_KEY') {
        await logActivity({
          category: 'reply_failed', status: 'error', conversationId: conv.id, conversationName: convLabel(conv),
          ruleId: rule.id, ruleName: rule.name, correlationId,
          message: 'Automated reply skipped: no OpenRouter key configured on the backend',
          detail: 'Set the key from AI Assistant → Configure (stored server-side only).',
        });
        return;
      }
      // AI failed after retries → fall back to the configured fallback reply
      replyText = settings.ai?.fallbackReply || settings.fallbackResponse;
      await logActivity({
        category: 'reply_queued', status: 'info', conversationId: conv.id, conversationName: convLabel(conv),
        ruleId: rule.id, ruleName: rule.name, correlationId,
        message: 'AI failed — fallback reply used instead', detail: err.message,
      });
      viaAI = false;
    }
  }

  // 8. Send
  await sendOutbound({
    conv: { ...conv }, text: replyText, viaAI, ruleId: rule.id, ruleName: rule.name,
    model, tokensIn, tokensOut, manual: false, correlationId, source: 'automation',
  });
}

/* ---------- dashboard summary ---------- */
function rangeWindow(rangeKey, from, to) {
  const now = Date.now();
  let start;
  if (rangeKey === 'today') start = new Date(new Date().setUTCHours(0, 0, 0, 0)).getTime();
  else if (rangeKey === '30d') start = now - 30 * DAY_MS;
  else if (rangeKey === 'custom' && from) start = new Date(`${from}T00:00:00Z`).getTime();
  else start = now - 7 * DAY_MS;
  const end = rangeKey === 'custom' && to ? new Date(`${to}T23:59:59Z`).getTime() : now;
  return { startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() };
}

export async function dashboardSummary(rangeKey = '7d', from = null, to = null) {
  const settingsRow = await getSettingsRow();
  const settings = settingsRow.data;
  const { startIso, endIso } = rangeWindow(rangeKey, from, to);

  const { data: msgs } = await db().from('messages')
    .select('direction, status, viaAI, tokensIn, tokensOut, at')
    .gte('at', startIso).lte('at', endIso)
    .limit(5000);

  let incoming = 0, repliesSent = 0, failed = 0, aiRequests = 0, tokensIn = 0, tokensOut = 0;
  for (const m of msgs || []) {
    if (m.direction === 'in' && m.status === 'received') incoming += 1;
    if (m.direction === 'out' && m.status === 'sent') {
      repliesSent += 1;
      if (m.viaAI) { aiRequests += 1; tokensIn += m.tokensIn || 0; tokensOut += m.tokensOut || 0; }
    }
    if (m.direction === 'out' && m.status === 'failed') failed += 1;
  }
  const attempted = repliesSent + failed;
  const successRate = attempted ? (repliesSent / attempted) * 100 : null;
  const price = settings.ai?.pricing || { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 };
  const estCost = (tokensIn / 1e6) * price.inputPerMillionUsd + (tokensOut / 1e6) * price.outputPerMillionUsd;

  const [igUsername, igStatus] = await Promise.all([getIgUsername(), getIgConnectionState()]);
  const { count: unread } = await db().from('conversations').select('id', { count: 'exact', head: true }).gt('unread', 0);
  const { count: pausedCount } = await db().from('conversations').select('id', { count: 'exact', head: true }).eq('paused', true);
  const { data: topRules } = await db().from('rules').select('id, name, triggerCount, lastTriggeredAt, enabled').gt('triggerCount', 0).order('triggerCount', { ascending: false }).limit(5);
  const { data: recentActivity } = await db().from('activity_logs').select('*').order('at', { ascending: false }).limit(8);
  const { data: recentConversations } = await db().from('conversations').select('*').order('lastMessageAt', { ascending: false }).limit(5);
  const { data: lastIn } = await db().from('messages').select('at').eq('direction', 'in').order('at', { ascending: false }).limit(1).maybeSingle();
  const { data: lastOut } = await db().from('messages').select('at').eq('direction', 'out').eq('status', 'sent').order('at', { ascending: false }).limit(1).maybeSingle();

  return {
    range: rangeKey,
    automationEnabled: !!settings.automationEnabled,
    igAccount: { username: igUsername, name: igUsername ? igUsername.replace(/^@/, '') : null, status: igStatus },
    incoming, repliesSent, failed,
    unreadConversations: unread || 0,
    aiRequests, tokensIn, tokensOut, estCostUsd: estCost,
    successRate,
    topRules: (topRules || []).map((r) => ({ id: r.id, name: r.name, triggerCount: r.triggerCount, lastTriggeredAt: r.lastTriggeredAt, enabled: r.enabled })),
    recentActivity: recentActivity || [],
    recentConversations: recentConversations || [],
    lastWebhookAt: lastIn?.at || null,
    lastReplyAt: lastOut?.at || null,
    lastSyncAt: settingsRow.updatedAt || settingsRow.createdAt || new Date().toISOString(),
    pausedConversations: pausedCount || 0,
  };
}

async function getIgUsername() {
  const { data } = await db().from('app_secrets').select('value').eq('name', 'IG_USERNAME').maybeSingle();
  return data?.value || null;
}

async function getIgConnectionState() {
  const { data } = await db().from('app_secrets').select('value').eq('name', 'IG_ACCESS_TOKEN').maybeSingle();
  return data?.value ? 'connected' : 'disconnected';
}

/* ---------- system health checks ---------- */
export async function healthChecks() {
  const checks = [];
  const recent = (iso, warnMins) => iso && (Date.now() - new Date(iso).getTime()) < warnMins * 60_000;
  const settingsRow = await getSettingsRow();
  const settings = settingsRow.data;

  checks.push({ id: 'supabase', title: 'Supabase connectivity', state: 'ok', detail: 'Database reachable — this check is served by the backend itself.' });
  checks.push({ id: 'backend', title: 'Backend health endpoint', state: 'ok', detail: 'The automation engine is reachable and responding.' });

  const igConfig = await getIgConfig();
  checks.push({
    id: 'meta-account', title: 'Meta / Instagram account connection',
    state: igConfig.token ? 'ok' : 'not_configured',
    detail: igConfig.token ? 'Access token stored server-side.' : 'Instagram is not connected.',
    fix: igConfig.token ? null : 'Connect Instagram through Settings → Integrations → Meta (OAuth or manual token).',
  });
  checks.push({
    id: 'webhook-sub', title: 'Webhook configuration',
    state: igConfig.configured ? 'ok' : 'attention',
    detail: 'Webhook receiver deployed. Signature validation is enforced when META_APP_SECRET is set.',
    fix: igConfig.configured ? null : 'Set META_APP_SECRET and META_VERIFY_TOKEN, then subscribe Meta to the webhook URL.',
  });

  const { data: lastWebhook } = await db().from('webhook_events').select('receivedAt').order('receivedAt', { ascending: false }).limit(1).maybeSingle();
  checks.push({
    id: 'last-webhook', title: 'Most recent webhook event',
    state: recent(lastWebhook?.receivedAt, 24 * 60) ? 'ok' : 'attention',
    detail: lastWebhook?.receivedAt ? `Last event received ${lastWebhook.receivedAt}.` : 'No webhook events received yet.',
    fix: recent(lastWebhook?.receivedAt, 24 * 60) ? null : 'If you expect activity, verify the webhook URL and subscription in the Meta App Dashboard.',
  });

  const orKey = settings.ai?.keyConfigured;
  checks.push({
    id: 'openrouter-cred', title: 'OpenRouter credential',
    state: orKey ? 'ok' : 'not_configured',
    detail: orKey ? 'Credential configured server-side (masked).' : 'No credential stored.',
    fix: orKey ? null : 'Configure the OpenRouter API key in AI Assistant — it is stored server-side only.',
  });

  const { data: lastAi } = await db().from('activity_logs').select('at').eq('category', 'ai_request_succeeded').order('at', { ascending: false }).limit(1).maybeSingle();
  checks.push({
    id: 'last-ai', title: 'Most recent successful AI request',
    state: lastAi ? 'ok' : 'unknown',
    detail: lastAi ? `Last succeeded ${lastAi.at}.` : 'No AI requests recorded yet.',
  });

  const { data: lastReply } = await db().from('activity_logs').select('at').eq('category', 'reply_sent').order('at', { ascending: false }).limit(1).maybeSingle();
  checks.push({
    id: 'last-reply', title: 'Most recent successful reply',
    state: lastReply ? 'ok' : 'unknown',
    detail: lastReply ? `Last delivered ${lastReply.at}.` : 'No replies sent yet.',
  });

  const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const { count: failedCount } = await db().from('messages').select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('at', since);
  checks.push({
    id: 'failed-jobs', title: 'Failed processing jobs',
    state: failedCount ? 'attention' : 'ok',
    detail: `${failedCount || 0} failed repl${failedCount === 1 ? 'y' : 'ies'} in the last 7 days. Inspect them in the Inbox or Activity Logs.`,
    fix: failedCount ? 'Most 24h-window failures recover automatically when the customer messages again.' : null,
  });

  checks.push({ id: 'queue', title: 'Queue & retry status', state: 'ok', detail: 'Sends are executed inline with idempotent bookkeeping; nothing is pending.' });
  return checks;
}
