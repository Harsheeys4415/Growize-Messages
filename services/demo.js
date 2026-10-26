/* GrowizeMessages — demo adapter data store.
 *
 * Everything in this module is SIMULATED sample data stored in the
 * browser (localStorage). It exists so the dashboard can be evaluated
 * without a backend. Demo mode NEVER sends real Instagram messages and
 * NEVER touches live account data.
 */

import { uid, lsGet, lsSet, lsDel, emit } from './store.js';
import { matchRules, applyTemplate } from './rules-engine.js';

const LS_KEY = 'gm.demo.state.v1';

let db = null;
const listeners = new Set();
let failNextOut = false;

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify(reason = 'change') {
  save();
  listeners.forEach((fn) => { try { fn(db, reason); } catch (e) { console.error(e); } });
  emit('demo:change', { reason });
}

/* ---------- time helpers ---------- */
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const minsAgo = (n) => ago(n * MIN);
const hrsAgo = (n) => ago(n * HOUR);
const daysAgo = (n) => ago(n * DAY);
export const nowIso = () => new Date().toISOString();

/* ============================================================
   Seed data
   ============================================================ */

function seedRules() {
  return [
    {
      id: 'rule_pricing', name: 'Pricing & cost questions',
      description: 'Answers questions about product prices using the AI assistant.',
      enabled: true, priority: 1, triggerType: 'contains',
      keywords: ['price', 'pricing', 'cost', 'how much', 'how much is'],
      excludedKeywords: ['wholesale'], caseSensitive: false,
      replyMode: 'ai', replyText: '', aiInstruction: '',
      cooldownMins: 30, triggerCount: 23, lastTriggeredAt: hrsAgo(2),
    },
    {
      id: 'rule_delivery', name: 'Delivery & shipping',
      description: 'Handles delivery areas and shipping time questions.',
      enabled: true, priority: 2, triggerType: 'any_keyword',
      keywords: ['deliver', 'delivery', 'shipping', 'ship to', 'post to'],
      excludedKeywords: [], caseSensitive: false,
      replyMode: 'ai_instruction', replyText: '',
      aiInstruction: 'Mention that delivery is free over $50 and standard shipping takes 3-5 business days. If the location is unclear, ask which city they are in. Never promise same-day delivery.',
      cooldownMins: 30, triggerCount: 17, lastTriggeredAt: hrsAgo(3),
    },
    {
      id: 'rule_hours', name: 'Business hours',
      description: 'Replies with opening hours when people ask when you are open.',
      enabled: true, priority: 3, triggerType: 'any_keyword',
      keywords: ['hours', 'open', 'opening', 'closing', 'what time'],
      excludedKeywords: [], caseSensitive: false,
      replyMode: 'predefined',
      replyText: 'Hi {name}! We are online Mon-Fri 9am-5pm AEST and Sat 9am-1pm. You can place orders anytime and we will reply first thing next business day if it is after hours.',
      aiInstruction: '',
      cooldownMins: 60, triggerCount: 9, lastTriggeredAt: daysAgo(5),
    },
    {
      id: 'rule_stock', name: 'Stock & restocks',
      description: 'Answers availability and restock questions.',
      enabled: true, priority: 4, triggerType: 'contains',
      keywords: ['restock', 'back in stock', 'in stock', 'available'],
      excludedKeywords: [], caseSensitive: false,
      replyMode: 'ai', replyText: '',
      aiInstruction: '',
      cooldownMins: 60, triggerCount: 6, lastTriggeredAt: hrsAgo(5),
    },
    {
      id: 'rule_collab', name: 'Collabs & partnerships',
      description: 'Collects collaboration and sponsorship enquiries for manual review.',
      enabled: true, priority: 5, triggerType: 'any_keyword',
      keywords: ['collab', 'collaboration', 'partnership', 'sponsor', 'brand deal'],
      excludedKeywords: [], caseSensitive: false,
      replyMode: 'predefined',
      replyText: 'Thanks for reaching out about partnerships! Could you share your profile and the concept you have in mind? Our team reviews collab requests every Friday and will get back to you then.',
      aiInstruction: '',
      cooldownMins: 0, triggerCount: 4, lastTriggeredAt: daysAgo(4),
    },
    {
      id: 'rule_order', name: 'Order status',
      description: 'Helps customers with order and delivery status questions.',
      enabled: true, priority: 6, triggerType: 'contains',
      keywords: ['my order', 'order number', 'order #', 'tracking', 'hasn', 'hasnt arrived', "hasn't arrived"],
      excludedKeywords: [], caseSensitive: false,
      replyMode: 'ai_instruction', replyText: '',
      aiInstruction: 'Be empathetic. Ask for the order number (format GZ-XXXX) if it was not provided. Never invent delivery dates or tracking events; offer to escalate to the team.',
      cooldownMins: 15, triggerCount: 8, lastTriggeredAt: hrsAgo(26),
    },
    {
      id: 'rule_wholesale', name: 'Wholesale enquiries (draft)',
      description: 'Draft rule for wholesale — disabled until pricing is approved.',
      enabled: false, priority: 7, triggerType: 'contains',
      keywords: ['wholesale', 'bulk order', 'reseller'],
      excludedKeywords: [], caseSensitive: false,
      replyMode: 'predefined',
      replyText: 'Thanks for your interest in wholesale! Our wholesale team will send you the current catalogue and MOQs shortly.',
      aiInstruction: '',
      cooldownMins: 0, triggerCount: 0, lastTriggeredAt: null,
    },
    {
      id: 'rule_fallback', name: 'Fallback — friendly greeting',
      description: 'Replies when no other rule matches, so nobody is left hanging.',
      enabled: true, priority: 99, triggerType: 'fallback',
      keywords: [], excludedKeywords: [], caseSensitive: false,
      replyMode: 'predefined',
      replyText: 'Hey! Thanks for messaging Growize. I can help with products, prices, delivery and workshops. What are you after today?',
      aiInstruction: '',
      cooldownMins: 30, triggerCount: 31, lastTriggeredAt: daysAgo(1),
    },
  ];
}

function msg(convId, direction, status, text, at, extra = {}) {
  return {
    id: uid('msg'), conversationId: convId, direction, status, text, at,
    viaAI: false, ruleId: null, ruleName: null, error: null,
    correlationId: null, model: null, tokensIn: null, tokensOut: null,
    manual: false, ...extra,
  };
}

function seedConversations() {
  const convs = [
    {
      id: 'conv_maya', name: 'Maya Torres', username: 'maya.grows',
      paused: false, unread: 2, messageCount: 4, lastMessageAt: minsAgo(38),
      lastMessagePreview: 'Also do you have the honey starter kit in stock?',
    },
    {
      id: 'conv_liam', name: 'Liam Chen', username: 'liamchen.co',
      paused: true, unread: 0, messageCount: 4, lastMessageAt: hrsAgo(22),
      lastMessagePreview: 'Can you do a bulk discount for 10 people?',
    },
    {
      id: 'conv_priya', name: 'Priya Nair', username: 'priya.naturals',
      paused: false, unread: 1, messageCount: 3, lastMessageAt: hrsAgo(5),
      lastMessagePreview: "Please let me know as soon as it's available!",
    },
    {
      id: 'conv_jonas', name: 'Jonas Weber', username: 'jonasweber',
      paused: false, unread: 0, messageCount: 4, lastMessageAt: daysAgo(3),
      lastMessagePreview: 'Perfect, just booked. Thanks!',
    },
    {
      id: 'conv_sofia', name: 'Sofia Marín', username: 'sofia.marin.fit',
      paused: false, unread: 0, messageCount: 4, lastMessageAt: minsAgo(1),
      lastMessagePreview: 'Sending my media kit over now 😊',
    },
    {
      id: 'conv_dev', name: 'Dev Patel', username: 'devp.eats',
      paused: false, unread: 0, messageCount: 2, lastMessageAt: daysAgo(5),
      lastMessagePreview: 'Thanks, that is exactly what I needed.',
    },
    {
      id: 'conv_emma', name: 'Emma Ross', username: 'emma.ross.garden',
      paused: false, unread: 1, messageCount: 3, lastMessageAt: minsAgo(30),
      lastMessagePreview: 'Hello? Still waiting on my order',
    },
    {
      id: 'conv_noah', name: 'Noah Kim', username: 'noahkim.jpg',
      paused: false, unread: 0, messageCount: 3, lastMessageAt: daysAgo(6),
      lastMessagePreview: 'cool thanks',
    },
  ];

  const messages = {
    conv_maya: [
      msg('conv_maya', 'in', 'received', 'Hi! Do you deliver to Queensland? Just found your shop', hrsAgo(3), { correlationId: 'corr_8f21' }),
      msg('conv_maya', 'out', 'sent', 'Hi Maya! Yes — we deliver Australia-wide, including Queensland. Delivery is free on orders over $50 and standard shipping takes 3-5 business days. Anything you have your eye on?', minsAgo(170),
        { viaAI: true, ruleId: 'rule_delivery', ruleName: 'Delivery & shipping', model: 'openai/gpt-4o-mini', tokensIn: 210, tokensOut: 68, correlationId: 'corr_8f21' }),
      msg('conv_maya', 'in', 'received', 'Amazing. How long does shipping take to Brisbane?', minsAgo(41), { correlationId: 'corr_8f24' }),
      msg('conv_maya', 'in', 'received', 'Also do you have the honey starter kit in stock?', minsAgo(38), { correlationId: 'corr_8f25' }),
    ],
    conv_liam: [
      msg('conv_liam', 'in', 'received', "Hey, what's the price on the microgreens workshop?", daysAgo(1), { correlationId: 'corr_7a10' }),
      msg('conv_liam', 'out', 'sent', 'Hey Liam! The microgreens workshop is $45 per person and includes all materials, seeds for you to take home, and a tasting session. Dates and booking links are on our profile.', hrsAgo(23.5),
        { viaAI: true, ruleId: 'rule_pricing', ruleName: 'Pricing & cost questions', model: 'openai/gpt-4o-mini', tokensIn: 190, tokensOut: 61, correlationId: 'corr_7a10' }),
      msg('conv_liam', 'in', 'received', 'Can you do a bulk discount for 10 people?', hrsAgo(22), { correlationId: 'corr_7a12' }),
      msg('conv_liam', 'out', 'sent', 'For groups of 10+ we can do $38 per person. Would you like me to pencil in a date? This one came from the team — automation is paused for this conversation.', hrsAgo(21.8),
        { manual: true, correlationId: 'corr_7a13' }),
    ],
    conv_priya: [
      msg('conv_priya', 'in', 'received', 'When is the honey starter kit back in stock?', daysAgo(2), { correlationId: 'corr_6c02' }),
      msg('conv_priya', 'out', 'sent', 'Hi Priya! The honey starter kit sold out faster than expected. A restock lands next week — we can ping you here as soon as it is live if you like.', daysAgo(2) ,
        { viaAI: true, ruleId: 'rule_stock', ruleName: 'Stock & restocks', model: 'openai/gpt-4o-mini', tokensIn: 175, tokensOut: 55, correlationId: 'corr_6c02' }),
      msg('conv_priya', 'in', 'received', "Please let me know as soon as it's available!", hrsAgo(5), { correlationId: 'corr_6c05' }),
    ],
    conv_jonas: [
      msg('conv_jonas', 'in', 'received', 'Is the workshop beginner friendly?', daysAgo(3), { correlationId: 'corr_5d31' }),
      msg('conv_jonas', 'out', 'sent', 'Absolutely — the workshop is designed for total beginners. We walk through everything step by step and you leave with your own planted tray.', daysAgo(3),
        { viaAI: true, ruleId: 'rule_fallback', ruleName: 'Fallback — friendly greeting', model: 'openai/gpt-4o-mini', tokensIn: 160, tokensOut: 48, correlationId: 'corr_5d31' }),
      msg('conv_jonas', 'in', 'received', 'Perfect, just booked. Thanks!', daysAgo(3), { correlationId: 'corr_5d33' }),
      msg('conv_jonas', 'out', 'sent', "You're very welcome, Jonas! See you Saturday — sent personally by the team.", daysAgo(3), { manual: true, correlationId: 'corr_5d34' }),
    ],
    conv_sofia: [
      msg('conv_sofia', 'in', 'received', "Hi! I'd love to collab on a reel about your balcony kits.", daysAgo(4), { correlationId: 'corr_4e11' }),
      msg('conv_sofia', 'out', 'sent', 'Thanks for reaching out about partnerships! Could you share your profile and the concept you have in mind? Our team reviews collab requests every Friday and will get back to you then.', daysAgo(4),
        { viaAI: false, ruleId: 'rule_collab', ruleName: 'Collabs & partnerships', correlationId: 'corr_4e11' }),
      msg('conv_sofia', 'in', 'received', 'Sure — my handle is @sofia.marin.fit, I do 60-90s garden-to-plate recipes.', minsAgo(3), { correlationId: 'corr_4e14' }),
      msg('conv_sofia', 'out', 'queued', 'Sending my media kit over now 😊', minsAgo(1), { manual: true, correlationId: 'corr_4e15' }),
    ],
    conv_dev: [
      msg('conv_dev', 'in', 'received', 'What are your opening hours?', daysAgo(5), { correlationId: 'corr_3f77' }),
      msg('conv_dev', 'out', 'sent', 'Hi Dev! We are online Mon-Fri 9am-5pm AEST and Sat 9am-1pm. You can place orders anytime and we will reply first thing next business day if it is after hours.', daysAgo(5),
        { viaAI: false, ruleId: 'rule_hours', ruleName: 'Business hours', correlationId: 'corr_3f77' }),
    ],
    conv_emma: [
      msg('conv_emma', 'in', 'received', 'My order #GZ-1042 has not arrived yet, can you check?', hrsAgo(27), { correlationId: 'corr_2b40' }),
      msg('conv_emma', 'out', 'failed', "I'm so sorry for the delay, Emma! Let me check order GZ-1042 for you right away.", hrsAgo(26.9),
        { viaAI: true, ruleId: 'rule_order', ruleName: 'Order status', model: 'openai/gpt-4o-mini', tokensIn: 205, tokensOut: 40, correlationId: 'corr_2b40',
          error: 'Meta API error (#10): recipient is outside the allowed 24-hour messaging window. A retry will be attempted when the customer messages again.' }),
      msg('conv_emma', 'in', 'received', 'Hello? Still waiting on my order', minsAgo(30), { correlationId: 'corr_2b44' }),
    ],
    conv_noah: [
      msg('conv_noah', 'in', 'received', 'yo what is this account about', daysAgo(6), { correlationId: 'corr_1a01' }),
      msg('conv_noah', 'out', 'sent', "Hey! We're Growize — we help people grow their own food in small spaces: balcony kits, microgreens workshops and a lot of enthusiasm. What would you like to grow?", daysAgo(6),
        { viaAI: true, ruleId: 'rule_fallback', ruleName: 'Fallback — friendly greeting', model: 'openai/gpt-4o-mini', tokensIn: 150, tokensOut: 52, correlationId: 'corr_1a01' }),
      msg('conv_noah', 'in', 'ignored', 'yo what is this account about', daysAgo(6),
        { error: 'Duplicate webhook event ignored (event evt_1a01_dup). Original already processed.', correlationId: 'corr_1a02' }),
      msg('conv_noah', 'in', 'received', 'cool thanks', daysAgo(6), { correlationId: 'corr_1a03' }),
    ],
  };

  return { conversations: convs, messages };
}

/* ---------- activity log seed ---------- */
function log(entry) {
  return {
    id: uid('log'), at: entry.at || nowIso(), category: entry.category,
    status: entry.status || 'success', conversationId: entry.conversationId || null,
    conversationName: entry.conversationName || null, ruleId: entry.ruleId || null,
    ruleName: entry.ruleName || null, message: entry.message, detail: entry.detail || null,
    correlationId: entry.correlationId || null,
  };
}

function seedLogs() {
  const rows = [];
  const convRef = [
    { id: 'conv_maya', name: 'Maya Torres (@maya.grows)' },
    { id: 'conv_priya', name: 'Priya Nair (@priya.naturals)' },
    { id: 'conv_jonas', name: 'Jonas Weber (@jonasweber)' },
    { id: 'conv_sofia', name: 'Sofia Marín (@sofia.marin.fit)' },
    { id: 'conv_dev', name: 'Dev Patel (@devp.eats)' },
    { id: 'conv_noah', name: 'Noah Kim (@noahkim.jpg)' },
    { id: 'conv_liam', name: 'Liam Chen (@liamchen.co)' },
  ];
  const topics = [
    'do you deliver to Perth?', "what's the price of the balcony kit?", 'are you open on sunday?',
    'is the chili grow kit in stock?', 'do you ship to New Zealand?', 'how much for two workshops?',
    'when will my order arrive?', 'hi there!', 'do you have gift cards?',
  ];
  const rules = [
    { id: 'rule_delivery', name: 'Delivery & shipping' },
    { id: 'rule_pricing', name: 'Pricing & cost questions' },
    { id: 'rule_hours', name: 'Business hours' },
    { id: 'rule_stock', name: 'Stock & restocks' },
    { id: 'rule_fallback', name: 'Fallback — friendly greeting' },
    { id: 'rule_order', name: 'Order status' },
  ];

  // Structured chains over the last 7 days
  for (let d = 6; d >= 0; d--) {
    const chains = 3 + Math.floor(Math.random() * 4);
    for (let c = 0; c < chains; c++) {
      const base = Date.now() - d * DAY - Math.floor(Math.random() * 10 * HOUR);
      const at = (offsetMin) => new Date(base + offsetMin * MIN).toISOString();
      const conv = convRef[Math.floor(Math.random() * convRef.length)];
      const corr = `corr_${Math.random().toString(36).slice(2, 8)}`;
      const topic = topics[Math.floor(Math.random() * topics.length)];
      const rule = rules[Math.floor(Math.random() * rules.length)];
      const failAi = Math.random() < 0.07;
      const failSend = !failAi && Math.random() < 0.05;

      rows.push(log({ at: at(0), category: 'webhook_received', conversationId: conv.id, conversationName: conv.name, message: `Webhook event received (message) from @${conv.name.match(/@[\w.]+/)?.[0] ?? 'user'}`, correlationId: corr }));
      rows.push(log({ at: at(0.1), category: 'incoming_dm', conversationId: conv.id, conversationName: conv.name, message: `Incoming DM: "${topic}"`, detail: 'Event deduplicated and persisted. Signature verified.', correlationId: corr }));

      if (Math.random() < 0.06) {
        rows.push(log({ at: at(0.2), category: 'duplicate_ignored', status: 'info', conversationId: conv.id, conversationName: conv.name, message: 'Duplicate event ignored', detail: `Event id evt_${Math.random().toString(36).slice(2, 8)} already processed.`, correlationId: corr }));
        continue;
      }
      if (Math.random() < 0.04) {
        rows.push(log({ at: at(0.2), category: 'webhook_validation_failed', status: 'error', conversationId: conv.id, conversationName: conv.name, message: 'Webhook signature validation failed', detail: 'X-Hub-Signature-256 did not match app secret. Event discarded.', correlationId: corr }));
        continue;
      }

      rows.push(log({ at: at(0.4), category: 'rule_evaluated', status: 'info', conversationId: conv.id, conversationName: conv.name, message: 'Evaluated 7 enabled rules against message', detail: 'Priority order: Pricing (1) → Delivery (2) → Hours (3) → Stock (4) → Collabs (5) → Order (6) → Fallback (99).', correlationId: corr }));
      rows.push(log({ at: at(0.5), category: 'rule_matched', conversationId: conv.id, conversationName: conv.name, ruleId: rule.id, ruleName: rule.name, message: `Rule "${rule.name}" matched`, correlationId: corr }));

      if (rule.id !== 'rule_hours' && rule.id !== 'rule_collab' && rule.id !== 'rule_fallback') {
        rows.push(log({ at: at(0.8), category: 'ai_request_started', status: 'info', conversationId: conv.id, conversationName: conv.name, ruleId: rule.id, ruleName: rule.name, message: 'AI reply generation started (openai/gpt-4o-mini)', correlationId: corr }));
        if (failAi) {
          rows.push(log({ at: at(6), category: 'ai_request_failed', status: 'error', conversationId: conv.id, conversationName: conv.name, ruleId: rule.id, ruleName: rule.name, message: 'AI request failed: upstream timeout after 20s', detail: 'OpenRouter returned 504. Fallback reply used instead.', correlationId: corr }));
          rows.push(log({ at: at(6.4), category: 'retry_attempted', status: 'info', conversationId: conv.id, conversationName: conv.name, ruleId: rule.id, ruleName: rule.name, message: 'Retry 1/2 scheduled in 2s', correlationId: corr }));
          rows.push(log({ at: at(9), category: 'reply_queued', status: 'info', conversationId: conv.id, conversationName: conv.name, ruleId: rule.id, ruleName: rule.name, message: 'Fallback reply queued', correlationId: corr }));
          rows.push(log({ at: at(9.6), category: 'reply_sent', conversationId: conv.id, conversationName: conv.name, ruleId: rule.id, ruleName: rule.name, message: 'Reply delivered via Instagram Messaging API', detail: 'Meta message id m_x8f21…', correlationId: corr }));
          continue;
        }
        rows.push(log({ at: at(2.2), category: 'ai_request_succeeded', conversationId: conv.id, conversationName: conv.name, ruleId: rule.id, ruleName: rule.name, message: `AI reply generated in ${(0.8 + Math.random() * 1.6).toFixed(1)}s (openai/gpt-4o-mini)`, detail: `Tokens: ~${140 + Math.floor(Math.random() * 120)} in / ~${30 + Math.floor(Math.random() * 60)} out.`, correlationId: corr }));
      }

      rows.push(log({ at: at(3), category: 'reply_queued', status: 'info', conversationId: conv.id, conversationName: conv.name, ruleId: rule.id, ruleName: rule.name, message: 'Reply queued for delivery', correlationId: corr }));
      if (failSend) {
        rows.push(log({ at: at(3.4), category: 'reply_failed', status: 'error', conversationId: conv.id, conversationName: conv.name, ruleId: rule.id, ruleName: rule.name, message: 'Reply failed: (10) messaging window expired', detail: 'Recipient last active more than 24h ago. Reply re-queued for next inbound message.', correlationId: corr }));
      } else {
        rows.push(log({ at: at(3.6), category: 'reply_sent', conversationId: conv.id, conversationName: conv.name, ruleId: rule.id, ruleName: rule.name, message: 'Reply delivered via Instagram Messaging API', detail: 'Meta message id m_' + Math.random().toString(36).slice(2, 10), correlationId: corr }));
      }
    }
  }

  // One-off operational events
  rows.push(log({ at: hrsAgo(26.9), category: 'reply_failed', status: 'error', conversationId: 'conv_emma', conversationName: 'Emma Ross (@emma.ross.garden)', ruleId: 'rule_order', ruleName: 'Order status', message: 'Reply failed: (10) recipient outside 24h messaging window', detail: 'AI reply generated successfully but Meta API rejected the send. Will retry on next inbound message.', correlationId: 'corr_2b40' }));
  rows.push(log({ at: hrsAgo(30), category: 'automation_paused', status: 'info', conversationId: 'conv_liam', conversationName: 'Liam Chen (@liamchen.co)', message: 'Automation paused for conversation (manual)', detail: 'Paused by admin from the inbox.', correlationId: 'corr_7a14' }));
  rows.push(log({ at: daysAgo(2), category: 'automation_resumed', status: 'info', conversationId: 'conv_jonas', conversationName: 'Jonas Weber (@jonasweber)', message: 'Automation resumed for conversation', correlationId: 'corr_5d30' }));
  rows.push(log({ at: daysAgo(3), category: 'integration_error', status: 'error', message: 'Supabase realtime connection dropped', detail: 'Socket closed unexpectedly. Reconnected after 4s; data refetched. No data loss.', correlationId: 'corr_sys_912' }));
  rows.push(log({ at: daysAgo(4), category: 'automation_resumed', status: 'info', message: 'Global automation resumed from dashboard', detail: 'Resumed by admin after maintenance window.' }));

  rows.sort((a, b) => new Date(b.at) - new Date(a.at));
  return rows.slice(0, 120);
}

/* ---------- AI usage history (30 days) ---------- */
function seedUsage() {
  const days = [];
  for (let d = 29; d >= 0; d--) {
    const date = new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
    const base = 6 + Math.round((29 - d) * 0.35);
    const requests = Math.max(2, base + Math.floor(Math.random() * 6));
    const tokensIn = requests * (150 + Math.floor(Math.random() * 90));
    const tokensOut = requests * (35 + Math.floor(Math.random() * 45));
    days.push({ date, requests, tokensIn, tokensOut });
  }
  return days;
}

function seedSettings() {
  return {
    appName: 'GrowizeMessages',
    automationEnabled: true,
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
      keyConfigured: true,
      keyMask: 'sk-or-v1-•••••••••••••••• (sample)',
      lastTestAt: hrsAgo(5),
      lastTestResult: 'ok',
      pricing: { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
    },
  };
}

function seedIntegrations() {
  return {
    meta: {
      status: 'connected', simulated: true,
      appId: '98214405•• (sample)',
      igAccountId: '17841433••••• (sample)',
      igUsername: '@growize.garden',
      tokenStatus: 'Long-lived access token valid (sample)',
      tokenExpiresInDays: 42,
      permissions: ['instagram_basic', 'instagram_manage_messages', 'pages_manage_metadata', 'pages_read_engagement'],
      missingPermissions: [],
      webhookVerify: true,
      webhookUrl: 'https://your-project.supabase.co/functions/v1/meta-webhook (sample)',
      lastWebhookAt: minsAgo(38),
      lastEventSummary: 'DM received from @maya.grows',
      lastCheckAt: minsAgo(2),
      errors: [],
    },
    supabase: {
      status: 'demo', simulated: true,
      projectUrl: null, anonKeyConfigured: false, backendBase: null,
      health: 'unknown', lastSyncAt: null,
      note: 'Demo mode keeps all sample data in your browser. Connect a project in Settings to enable live data.',
      lastCheckAt: minsAgo(2),
      errors: [],
    },
    openrouter: {
      status: 'connected', simulated: true,
      keyConfigured: true, keyMask: 'sk-or-v1-•••••••••••••••• (sample)',
      model: 'openai/gpt-4o-mini',
      lastRequestAt: minsAgo(38),
      lastTestAt: hrsAgo(5),
      usageNote: '30-day usage: see Overview for tokens and estimated cost.',
      lastCheckAt: minsAgo(2),
      errors: [],
    },
  };
}

function freshDb() {
  const convs = seedConversations();
  return {
    simulated: true,
    createdAt: nowIso(),
    settings: seedSettings(),
    conversations: convs.conversations,
    messages: convs.messages,
    rules: seedRules(),
    logs: seedLogs(),
    usage: seedUsage(),
    integrations: seedIntegrations(),
    counters: { lastWebhookAt: minsAgo(38), lastReplyAt: minsAgo(38), lastSyncAt: minsAgo(1) },
  };
}

/* ============================================================
   Load / save / reset
   ============================================================ */

export function load() {
  const stored = lsGet(LS_KEY, null);
  db = stored && stored.simulated ? stored : freshDb();
  save();
  return db;
}
export function save() { if (db) lsSet(LS_KEY, db); }
export function reset() {
  lsDel(LS_KEY);
  db = freshDb();
  notify('reset');
}
export function getDb() { if (!db) load(); return db; }

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
   Settings
   ============================================================ */

export function getSettings() {
  const d = getDb();
  return JSON.parse(JSON.stringify(d.settings));
}

export function updateSettings(patch) {
  const d = getDb();
  d.settings = deepMerge(d.settings, patch);
  if (patch.automationEnabled !== undefined) {
    d.logs.unshift(log({
      category: patch.automationEnabled ? 'automation_resumed' : 'automation_paused',
      status: 'info',
      message: patch.automationEnabled ? 'Global automation resumed from Settings' : 'Global automation paused from Settings',
      detail: 'The backend enforces this state before processing any automated reply.',
    }));
    d.counters.lastSyncAt = nowIso();
  }
  notify('settings');
  return getSettings();
}

function deepMerge(base, patch) {
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

export function setAutomation(enabled, { emergency = false } = {}) {
  const d = getDb();
  d.settings.automationEnabled = !!enabled;
  d.logs.unshift(log({
    category: enabled ? 'automation_resumed' : 'automation_paused',
    status: 'info',
    message: enabled ? 'Global automation resumed' : emergency ? 'EMERGENCY PAUSE activated — all automated replies stopped' : 'Global automation paused',
    detail: 'Persisted via the backend; the engine checks this flag before every automated reply.',
  }));
  notify('automation');
}

/* ============================================================
   Conversations & messages
   ============================================================ */

export function listConversations({ search = '', filter = 'all' } = {}) {
  const d = getDb();
  let rows = [...d.conversations].sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
  if (filter === 'unread') rows = rows.filter((c) => c.unread > 0);
  if (filter === 'paused') rows = rows.filter((c) => c.paused);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((c) =>
      c.name.toLowerCase().includes(q) || c.username.toLowerCase().includes(q) ||
      (c.lastMessagePreview || '').toLowerCase().includes(q));
  }
  return rows.map((c) => ({ ...c }));
}

export function getConversation(id) {
  const d = getDb();
  const c = d.conversations.find((x) => x.id === id);
  return c ? { ...c } : null;
}

export function unreadCount() {
  return getDb().conversations.reduce((a, c) => a + (c.unread > 0 ? 1 : 0), 0);
}

export function getMessages(convId) {
  const d = getDb();
  return [...(d.messages[convId] || [])].sort((a, b) => new Date(a.at) - new Date(b.at)).map((m) => ({ ...m }));
}

export function markConversationRead(convId, read = true) {
  const d = getDb();
  const c = d.conversations.find((x) => x.id === convId);
  if (!c) return null;
  c.unread = read ? 0 : Math.max(1, c.unread);
  notify('read');
  return { ...c };
}

export function setConversationPaused(convId, paused) {
  const d = getDb();
  const c = d.conversations.find((x) => x.id === convId);
  if (!c) return null;
  c.paused = !!paused;
  d.logs.unshift(log({
    category: paused ? 'automation_paused' : 'automation_resumed',
    status: 'info',
    conversationId: c.id, conversationName: `${c.name} (@${c.username})`,
    message: paused ? `Automation paused for @${c.username}` : `Automation resumed for @${c.username}`,
  }));
  notify('conv-paused');
  return { ...c };
}

/* ---------- outbound reply (demo: simulated delivery) ---------- */
export function sendMessage(convId, text, { viaAI = false, ruleId = null, ruleName = null, model = null, tokensIn = null, tokensOut = null } = {}) {
  const d = getDb();
  const conv = d.conversations.find((x) => x.id === convId);
  if (!conv) throw new Error('Conversation not found');
  const correlationId = uid('corr');

  const m = msg(convId, 'out', 'queued', text, nowIso(), {
    viaAI, ruleId, ruleName, model, tokensIn, tokensOut, correlationId,
    manual: !viaAI && !ruleId,
  });
  d.messages[convId] = [...(d.messages[convId] || []), m];
  conv.lastMessageAt = m.at;
  conv.lastMessagePreview = text.slice(0, 80);
  conv.messageCount += 1;

  d.logs.unshift(log({
    at: m.at, category: 'reply_queued', status: 'info',
    conversationId: conv.id, conversationName: `${conv.name} (@${conv.username})`,
    ruleId, ruleName, correlationId,
    message: viaAI ? 'AI reply queued for delivery' : m.manual ? 'Manual reply queued for delivery' : 'Rule reply queued for delivery',
    detail: 'Simulated in demo mode — a live deployment sends through the backend via the Meta API.',
  }));
  notify('message-queued');
  finishSend(convId, m.id, correlationId);
  return { ...m };
}

function finishSend(convId, msgId, correlationId) {
  setTimeout(() => {
    const d = getDb();
    const conv = d.conversations.find((x) => x.id === convId);
    const m = (d.messages[convId] || []).find((x) => x.id === msgId);
    if (!m || !conv) return;
    if (failNextOut) {
      failNextOut = false;
      m.status = 'failed';
      m.error = 'Simulated failure: Meta API error (#190) — access token expired. No message was delivered. (demo)';
      d.logs.unshift(log({
        category: 'reply_failed', status: 'error',
        conversationId: conv.id, conversationName: `${conv.name} (@${conv.username})`,
        ruleId: m.ruleId, ruleName: m.ruleName, correlationId,
        message: 'Reply failed: (190) access token expired (simulated)', detail: m.error,
      }));
      d.logs.unshift(log({
        category: 'retry_attempted', status: 'info',
        conversationId: conv.id, conversationName: `${conv.name} (@${conv.username})`,
        correlationId, message: 'Retry scheduled — awaiting fresh token from backend',
      }));
    } else {
      m.status = 'sent';
      d.counters.lastReplyAt = m.at;
      d.logs.unshift(log({
        category: 'reply_sent', status: 'success',
        conversationId: conv.id, conversationName: `${conv.name} (@${conv.username})`,
        ruleId: m.ruleId, ruleName: m.ruleName, correlationId,
        message: 'Reply delivered (simulated Meta message id m_' + Math.random().toString(36).slice(2, 10) + ')',
      }));
    }
    notify('message-update');
  }, 1100);
}

export function armFailure() { failNextOut = true; }

/* ---------- incoming DM simulation ---------- */
const INCOMING_POOL = [
  'Hey! Is the balcony kit suitable for herbs?',
  'Do you ship to Adelaide?',
  "What's your refund policy?",
  'How much is shipping for the workshop?',
  'Can I swap seeds in the starter kit?',
  'Are you open on public holidays?',
  'Do you have anything for low-light apartments?',
  'Hi, is someone there?',
];

export function simulateIncoming(convId = null) {
  const d = getDb();
  const conv = convId ? d.conversations.find((c) => c.id === convId)
    : d.conversations[Math.floor(Math.random() * d.conversations.length)];
  if (!conv) return null;

  const text = INCOMING_POOL[Math.floor(Math.random() * INCOMING_POOL.length)];
  const at = nowIso();
  const correlationId = uid('corr');
  d.counters.lastWebhookAt = at;
  d.counters.lastSyncAt = at;

  d.logs.unshift(log({
    at, category: 'webhook_received', status: 'success',
    conversationId: conv.id, conversationName: `${conv.name} (@${conv.username})`,
    message: `Webhook event received (simulated) from @${conv.username}`, correlationId,
  }));

  // Occasionally simulate a duplicate event being ignored
  if (Math.random() < 0.15) {
    const dup = msg(conv.id, 'in', 'ignored', text, at, { correlationId, error: 'Duplicate webhook event ignored (event already processed).' });
    d.messages[conv.id] = [...(d.messages[conv.id] || []), dup];
    d.logs.unshift(log({
      at, category: 'duplicate_ignored', status: 'info',
      conversationId: conv.id, conversationName: `${conv.name} (@${conv.username})`,
      message: 'Duplicate event ignored', detail: `Event id evt_${correlationId}_dup already processed.`, correlationId,
    }));
    conv.lastMessageAt = at; conv.lastMessagePreview = text.slice(0, 80);
    notify('incoming');
    return { convId: conv.id, duplicate: true };
  }

  const m = msg(conv.id, 'in', 'received', text, at, { correlationId });
  d.messages[conv.id] = [...(d.messages[conv.id] || []), m];
  conv.unread += 1;
  conv.messageCount += 1;
  conv.lastMessageAt = at;
  conv.lastMessagePreview = text.slice(0, 80);

  d.logs.unshift(log({
    at, category: 'incoming_dm', status: 'success',
    conversationId: conv.id, conversationName: `${conv.name} (@${conv.username})`,
    message: `Incoming DM: "${text}"`, detail: 'Signature verified and event persisted (simulated).', correlationId,
  }));
  notify('incoming');
  processAutomation(conv.id, m, correlationId);
  return { convId: conv.id, messageId: m.id, text };
}

/* ---------- the automation pipeline (demo twin of backend logic) ---------- */
function processAutomation(convId, incoming, correlationId) {
  setTimeout(async () => {
    const d = getDb();
    const conv = d.conversations.find((c) => c.id === convId);
    if (!conv) return;
    const s = d.settings;

    d.logs.unshift(log({
      category: 'rule_evaluated', status: 'info',
      conversationId: convId, conversationName: `${conv.name} (@${conv.username})`,
      message: `Evaluated ${d.rules.filter((r) => r.enabled).length} enabled rules against message`, correlationId,
    }));

    if (!s.automationEnabled) {
      d.logs.unshift(log({
        category: 'rule_evaluated', status: 'info',
        conversationId: convId, conversationName: `${conv.name} (@${conv.username})`,
        message: 'Global automation is PAUSED — no automated reply attempted', correlationId,
      }));
      notify('automation-skip');
      return;
    }
    if (conv.paused) {
      d.logs.unshift(log({
        category: 'rule_evaluated', status: 'info',
        conversationId: convId, conversationName: `${conv.name} (@${conv.username})`,
        message: 'Automation is paused for this conversation — no automated reply attempted', correlationId,
      }));
      notify('automation-skip');
      return;
    }

    const { winner, evaluated } = matchRules(d.rules, incoming.text);
    if (!winner) {
      d.logs.unshift(log({
        category: 'rule_evaluated', status: 'info',
        conversationId: convId, conversationName: `${conv.name} (@${conv.username})`,
        message: 'No rule matched — no automated reply sent', correlationId,
      }));
      notify('automation-skip');
      return;
    }

    // Cooldown enforcement
    const rule = winner.rule;
    if (rule.cooldownMins > 0 && rule.lastTriggeredAt &&
        Date.now() - new Date(rule.lastTriggeredAt).getTime() < rule.cooldownMins * 60_000) {
      d.logs.unshift(log({
        category: 'rule_evaluated', status: 'info',
        conversationId: convId, conversationName: `${conv.name} (@${conv.username})`,
        ruleId: rule.id, ruleName: rule.name,
        message: `Rule matched but cooldown active (${rule.cooldownMins} min) — reply suppressed`, correlationId,
      }));
      notify('automation-skip');
      return;
    }

    d.logs.unshift(log({
      category: 'rule_matched', status: 'success',
      conversationId: convId, conversationName: `${conv.name} (@${conv.username})`,
      ruleId: rule.id, ruleName: rule.name,
      message: `Rule "${rule.name}" matched`, detail: winner.reason, correlationId,
    }));
    rule.triggerCount += 1;
    rule.lastTriggeredAt = nowIso();

    let text, viaAI = false, model = null, tokensIn = null, tokensOut = null;
    if (rule.replyMode === 'predefined') {
      const t = applyTemplate(rule.replyText, { name: conv.name.split(' ')[0], username: `@${conv.username}` });
      text = t.text;
    } else if (rule.replyMode === 'ai_instruction' || rule.replyMode === 'ai') {
      viaAI = true;
      model = s.ai.model || s.ai.customModel || 'openai/gpt-4o-mini';
      tokensIn = 150 + Math.floor(Math.random() * 120);
      tokensOut = 35 + Math.floor(Math.random() * 55);
      d.logs.unshift(log({
        category: 'ai_request_started', status: 'info',
        conversationId: convId, conversationName: `${conv.name} (@${conv.username})`,
        ruleId: rule.id, ruleName: rule.name,
        message: `AI reply generation started (${model})`, correlationId,
      }));
      await delay(700);
      text = mockAiReply(incoming.text, conv, rule.replyMode === 'ai_instruction' ? rule.aiInstruction : null);
      d.logs.unshift(log({
        category: 'ai_request_succeeded', status: 'success',
        conversationId: convId, conversationName: `${conv.name} (@${conv.username})`,
        ruleId: rule.id, ruleName: rule.name,
        message: `AI reply generated in ${(0.5 + Math.random()).toFixed(1)}s (${model}) (simulated)`,
        detail: `Tokens: ~${tokensIn} in / ~${tokensOut} out.`, correlationId,
      }));
      recordUsage(tokensIn, tokensOut);
    }
    sendMessage(convId, text, { viaAI, ruleId: rule.id, ruleName: rule.name, model, tokensIn, tokensOut });
  }, 1000);
}

function recordUsage(tokensIn, tokensOut) {
  const d = getDb();
  const today = new Date().toISOString().slice(0, 10);
  let day = d.usage.find((u) => u.date === today);
  if (!day) { day = { date: today, requests: 0, tokensIn: 0, tokensOut: 0 }; d.usage.push(day); }
  day.requests += 1;
  day.tokensIn += tokensIn || 0;
  day.tokensOut += tokensOut || 0;
}

export function mockAiReply(text, conv, instruction = null) {
  const first = conv ? conv.name.split(' ')[0] : 'there';
  const topic = text.replace(/\?+$/, '').trim();
  const hint = instruction ? ' ' + instruction.split('. ')[0] + '.' : '';
  return `Hi ${first}! Thanks for your message about "${topic.length > 60 ? topic.slice(0, 60) + '…' : topic}". ${hint ? hint + ' ' : ''}Short answer: yes — we can help with that. Our team is happy to share details on products, delivery and workshops. Is there anything specific you would like to know?`.trim();
}

/* ============================================================
   Rules CRUD + testing
   ============================================================ */

export function listRules() { return [...getDb().rules].sort((a, b) => a.priority - b.priority).map((r) => ({ ...r })); }

export function createRule(data) {
  const d = getDb();
  const maxP = Math.max(0, ...d.rules.filter((r) => r.triggerType !== 'fallback').map((r) => r.priority));
  const rule = {
    id: uid('rule'), name: data.name?.trim() || 'Untitled rule',
    description: data.description || '', enabled: data.enabled ?? true,
    priority: data.priority ?? maxP + 1,
    triggerType: data.triggerType || 'contains',
    keywords: data.keywords || [], excludedKeywords: data.excludedKeywords || [],
    caseSensitive: data.caseSensitive ?? false,
    replyMode: data.replyMode || 'predefined',
    replyText: data.replyText || '', aiInstruction: data.aiInstruction || '',
    cooldownMins: data.cooldownMins ?? 0,
    triggerCount: 0, lastTriggeredAt: null,
  };
  d.rules.push(rule);
  notify('rule-created');
  return { ...rule };
}

export function updateRule(id, patch) {
  const d = getDb();
  const r = d.rules.find((x) => x.id === id);
  if (!r) throw new Error('Rule not found');
  Object.assign(r, patch);
  notify('rule-updated');
  return { ...r };
}

export function deleteRule(id) {
  const d = getDb();
  d.rules = d.rules.filter((r) => r.id !== id);
  notify('rule-deleted');
}

export function duplicateRule(id) {
  const d = getDb();
  const r = d.rules.find((x) => x.id === id);
  if (!r) throw new Error('Rule not found');
  const copy = { ...JSON.parse(JSON.stringify(r)), id: uid('rule'), name: `${r.name} (copy)`, triggerCount: 0, lastTriggeredAt: null, enabled: false };
  d.rules.push(copy);
  notify('rule-duplicated');
  return { ...copy };
}

export function moveRule(id, direction) {
  const d = getDb();
  const sorted = [...d.rules].sort((a, b) => a.priority - b.priority);
  const idx = sorted.findIndex((r) => r.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return listRules();
  const a = sorted[idx], b = sorted[swapIdx];
  const tmp = a.priority; a.priority = b.priority; b.priority = tmp;
  notify('rule-reordered');
  return listRules();
}

/* Test against a sample message — nothing is ever sent to Instagram. */
export function testRules(text, ruleId = null) {
  const d = getDb();
  const s = d.settings;
  const sampleVars = { name: 'Sample', username: '@sampleuser' };

  if (ruleId) {
    const rule = d.rules.find((r) => r.id === ruleId);
    if (!rule) return { ok: false, error: 'Rule not found' };
    const res = matchRuleSafe(rule, text);
    return {
      ok: true, simulated: true, winner: res.matched ? { rule: { ...rule }, reason: res.reason, isFallback: rule.triggerType === 'fallback' } : null,
      evaluated: [{ ruleId: rule.id, ruleName: rule.name, matched: res.matched, reason: res.reason }],
      reply: res.matched ? buildReplyPreview(rule, sampleVars, s, text) : null,
    };
  }

  const { winner, evaluated } = matchRules(d.rules, text);
  return {
    ok: true, simulated: true, winner: winner ? { rule: { ...winner.rule }, reason: winner.reason, isFallback: winner.isFallback } : null,
    evaluated,
    reply: winner ? buildReplyPreview(winner.rule, sampleVars, s, text) : null,
  };
}

function matchRuleSafe(rule, text) {
  try { return matchRule(rule, text); }
  catch (err) { return { matched: false, reason: `Error: ${err.message}` }; }
}

function buildReplyPreview(rule, vars, s, text = '') {
  if (rule.replyMode === 'predefined') {
    const t = applyTemplate(rule.replyText, vars);
    return { mode: 'predefined', text: t.text, unresolved: t.unresolved, simulated: true };
  }
  const model = s.ai.model || s.ai.customModel || 'openai/gpt-4o-mini';
  return {
    mode: rule.replyMode,
    text: mockAiReply(text || 'your message', { name: vars.name }, rule.replyMode === 'ai_instruction' ? rule.aiInstruction : null),
    model, simulated: true,
    note: 'Simulated AI preview. The real reply is generated by the backend via OpenRouter.',
  };
}

export function setTestText(text) { getDb().settings.testLastText = text; }

/* ============================================================
   Dashboard summary, activity, usage
   ============================================================ */

export function rangeStart(rangeKey, custom = null) {
  const now = Date.now();
  switch (rangeKey) {
    case 'today': return new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    case '7d': return now - 7 * 86_400_000;
    case '30d': return now - 30 * 86_400_000;
    case 'custom': return custom?.from ? new Date(custom.from + 'T00:00:00').getTime() : now - 7 * 86_400_000;
    default: return now - 7 * 86_400_000;
  }
}

export function dashboardSummary(rangeKey = '7d', custom = null) {
  const d = getDb();
  const start = rangeStart(rangeKey, custom);
  const end = rangeKey === 'custom' && custom?.to ? new Date(custom.to + 'T23:59:59').getTime() : Date.now();
  const inRange = (iso) => { const t = new Date(iso).getTime(); return t >= start && t <= end; };

  let incoming = 0, repliesSent = 0, failed = 0, aiRequests = 0, tokensIn = 0, tokensOut = 0;
  for (const msgs of Object.values(d.messages)) {
    for (const m of msgs) {
      if (!inRange(m.at)) continue;
      if (m.direction === 'in' && m.status === 'received') incoming += 1;
      if (m.direction === 'out' && m.status === 'sent') { repliesSent += 1; if (m.viaAI) { aiRequests += 1; tokensIn += m.tokensIn || 0; tokensOut += m.tokensOut || 0; } }
      if (m.direction === 'out' && m.status === 'failed') failed += 1;
    }
  }
  const attempted = repliesSent + failed;
  const successRate = attempted ? (repliesSent / attempted) * 100 : null;

  const price = d.settings.ai.pricing || { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 };
  const estCost = (tokensIn / 1e6) * price.inputPerMillionUsd + (tokensOut / 1e6) * price.outputPerMillionUsd;

  return {
    range: rangeKey, simulated: true,
    automationEnabled: d.settings.automationEnabled,
    igAccount: { username: d.integrations.meta.igUsername, name: 'Growize', status: d.integrations.meta.status },
    incoming, repliesSent, failed,
    unreadConversations: d.conversations.filter((c) => c.unread > 0).length,
    aiRequests, tokensIn, tokensOut, estCostUsd: estCost,
    successRate,
    topRules: [...d.rules].filter((r) => r.triggerCount > 0).sort((a, b) => b.triggerCount - a.triggerCount).slice(0, 5)
      .map((r) => ({ id: r.id, name: r.name, triggerCount: r.triggerCount, lastTriggeredAt: r.lastTriggeredAt, enabled: r.enabled })),
    recentActivity: d.logs.slice(0, 8),
    recentConversations: [...d.conversations].sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt)).slice(0, 5),
    lastWebhookAt: d.counters.lastWebhookAt,
    lastReplyAt: d.counters.lastReplyAt,
    lastSyncAt: d.counters.lastSyncAt,
    pausedConversations: d.conversations.filter((c) => c.paused).length,
  };
}

export function aiUsageSummary(rangeKey = '7d', custom = null) {
  const d = getDb();
  const start = rangeStart(rangeKey, custom);
  const days = d.usage.filter((u) => new Date(u.date + 'T12:00:00').getTime() >= start);
  return {
    simulated: true, days,
    requests: days.reduce((a, b) => a + b.requests, 0),
    tokensIn: days.reduce((a, b) => a + b.tokensIn, 0),
    tokensOut: days.reduce((a, b) => a + b.tokensOut, 0),
  };
}

export function listActivity(filters = {}) {
  const d = getDb();
  let rows = [...d.logs];
  const { q = '', category = 'all', status = 'all', convId = '', ruleId = '', from = '', to = '' } = filters;
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((r) => (r.message || '').toLowerCase().includes(needle) ||
      (r.detail || '').toLowerCase().includes(needle) || (r.conversationName || '').toLowerCase().includes(needle));
  }
  if (category !== 'all') rows = rows.filter((r) => r.category === category);
  if (status !== 'all') rows = rows.filter((r) => (status === 'error' ? r.status === 'error' : r.status === status));
  if (convId) rows = rows.filter((r) => r.conversationId === convId);
  if (ruleId) rows = rows.filter((r) => r.ruleId === ruleId);
  if (from) rows = rows.filter((r) => new Date(r.at) >= new Date(from + 'T00:00:00'));
  if (to) rows = rows.filter((r) => new Date(r.at) <= new Date(to + 'T23:59:59'));
  rows.sort((a, b) => new Date(b.at) - new Date(a.at));
  const perPage = 20;
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const page = Math.min(Math.max(1, filters.page || 1), pages);
  return { rows: rows.slice((page - 1) * perPage, page * perPage).map((r) => ({ ...r })), total: rows.length, page, pages };
}

export function getIntegrations() {
  return JSON.parse(JSON.stringify(getDb().integrations));
}

/* ---------- health checks (demo — clearly labeled simulated) ---------- */
export function runHealthChecks() {
  const d = getDb();
  const checks = [];
  const recent = (iso, warnMins) => iso && (Date.now() - new Date(iso).getTime()) < warnMins * 60_000;

  checks.push({
    id: 'supabase', title: 'Supabase connectivity', state: 'not_configured', simulated: true,
    detail: 'Demo mode stores data in your browser — no Supabase project is connected.',
    fix: 'Open Settings → Backend connection, then enter your project URL and publishable anon key.',
  });
  checks.push({
    id: 'backend', title: 'Backend health endpoint', state: 'not_configured', simulated: true,
    detail: 'No backend API base URL is configured. All management actions are simulated.',
    fix: 'Deploy the automation backend (Supabase Edge Functions) and set its base URL in Settings.',
  });
  const meta = d.integrations.meta;
  checks.push({
    id: 'meta-account', title: 'Meta / Instagram account connection', state: meta.status === 'connected' ? 'ok' : 'disconnected', simulated: true,
    detail: meta.status === 'connected' ? `Connected to ${meta.igUsername} (sample). Token ${meta.tokenExpiresInDays} days from expiry.` : 'Instagram is not connected.',
    fix: meta.status !== 'connected' ? 'Connect Instagram through Settings → Integrations → Meta.' : null,
  });
  checks.push({
    id: 'permissions', title: 'Required Instagram permissions', state: 'ok', simulated: true,
    detail: meta.permissions.join(', ') + ' granted (sample).',
  });
  checks.push({
    id: 'webhook-sub', title: 'Webhook subscription', state: 'ok', simulated: true,
    detail: 'Webhook verified for fields: messages, messaging_postbacks (sample).',
  });
  checks.push({
    id: 'last-webhook', title: 'Most recent webhook event', state: recent(d.counters.lastWebhookAt, 24 * 60) ? 'ok' : 'attention', simulated: true,
    detail: d.counters.lastWebhookAt ? `Last event ${d.counters.lastWebhookAt} (sample).` : 'No webhook events received yet.',
    fix: recent(d.counters.lastWebhookAt, 24 * 60) ? null : 'If you expect activity, verify the webhook URL and subscription in Meta App Dashboard.',
  });
  checks.push({
    id: 'openrouter-cred', title: 'OpenRouter credential', state: d.integrations.openrouter.keyConfigured ? 'ok' : 'not_configured', simulated: true,
    detail: d.integrations.openrouter.keyConfigured ? 'Credential configured (sample, masked).' : 'No credential stored.',
    fix: d.integrations.openrouter.keyConfigured ? null : 'Configure the OpenRouter API key in AI Assistant — it is stored server-side only.',
  });
  checks.push({
    id: 'model', title: 'Selected model availability', state: 'ok', simulated: true,
    detail: `Model ${d.settings.ai.model} responded to the last health probe (sample).`,
  });
  const lastAi = d.logs.find((l) => l.category === 'ai_request_succeeded');
  checks.push({
    id: 'last-ai', title: 'Most recent successful AI request', state: lastAi ? 'ok' : 'unknown', simulated: true,
    detail: lastAi ? `${lastAi.at}` : 'No AI requests recorded yet.',
  });
  const lastReply = d.logs.find((l) => l.category === 'reply_sent');
  checks.push({
    id: 'last-reply', title: 'Most recent successful reply', state: lastReply ? 'ok' : 'unknown', simulated: true,
    detail: lastReply ? `${lastReply.at}` : 'No replies sent yet.',
  });
  const failedCount = d.messages.conv_emma ? 1 : 0;
  checks.push({
    id: 'failed-jobs', title: 'Failed processing jobs', state: failedCount ? 'attention' : 'ok', simulated: true,
    detail: `${failedCount} failed reply in the last 7 days (sample). Inspect it in the Inbox (Emma Ross) or Activity Logs.`,
    fix: failedCount ? 'Most 24h-window failures recover automatically when the customer messages again. Review the error details for anything else.' : null,
  });
  checks.push({
    id: 'queue', title: 'Queue & retry status', state: 'ok', simulated: true,
    detail: 'No jobs pending or retrying right now (sample).',
  });
  return checks;
}

/* ============================================================
   OpenRouter (demo — fully simulated, never real credentials)
   ============================================================ */

export async function openrouterTest(sampleText) {
  const d = getDb();
  await delay(700);
  const s = d.settings.ai;
  if (!s.enabled) return { ok: false, error: 'AI assistant is disabled in settings. Enable it to run this test.', simulated: true };
  const started = Date.now();
  const reply = mockAiReply(sampleText, { name: 'Sample' });
  const tokensIn = 90 + Math.floor(Math.random() * 60);
  const tokensOut = 40 + Math.floor(Math.random() * 40);
  d.settings.ai.lastTestAt = nowIso();
  d.settings.ai.lastTestResult = 'ok';
  d.integrations.openrouter.lastRequestAt = nowIso();
  recordUsage(tokensIn, tokensOut);
  notify('ai-test');
  return {
    ok: true, simulated: true, reply, model: s.model || s.customModel || 'openai/gpt-4o-mini',
    tokensIn, tokensOut, latencyMs: Date.now() - started + Math.floor(300 + Math.random() * 700), at: nowIso(),
  };
}

export function fetchModels() {
  return {
    simulated: true,
    note: 'Demo list. In live mode this is fetched through the backend proxy from OpenRouter /api/v1/models for your account.',
    models: [
      { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini' },
      { id: 'openai/gpt-4o', name: 'OpenAI: GPT-4o' },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Anthropic: Claude 3.5 Sonnet' },
      { id: 'google/gemini-2.0-flash-001', name: 'Google: Gemini 2.0 Flash' },
      { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Meta: Llama 3.1 70B Instruct' },
      { id: 'mistralai/mistral-large', name: 'Mistral: Mistral Large' },
    ],
  };
}

export function configureOpenRouterKey(key, { clear = false } = {}) {
  const d = getDb();
  if (clear) {
    d.settings.ai.keyConfigured = false;
    d.settings.ai.keyMask = null;
    d.integrations.openrouter.keyConfigured = false;
    d.integrations.openrouter.keyMask = null;
    notify('ai-key');
    return { ok: true, simulated: true, keyConfigured: false };
  }
  const trimmed = String(key || '').trim();
  if (!trimmed) return { ok: false, error: 'Enter a key first.', simulated: true };
  // Demo accepts any non-empty value; it is NEVER persisted or sent anywhere.
  const mask = `sk-or-v1-••••••••••••${trimmed.slice(-4)} (sample)`;
  d.settings.ai.keyConfigured = true;
  d.settings.ai.keyMask = mask;
  d.integrations.openrouter.keyConfigured = true;
  d.integrations.openrouter.keyMask = mask;
  notify('ai-key');
  return { ok: true, simulated: true, keyConfigured: true, keyMask: mask };
}

/* ---------- meta integration actions (demo) ---------- */
export function metaStatus() { return { ...getDb().integrations.meta }; }

