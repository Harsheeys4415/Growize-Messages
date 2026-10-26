/* GrowizeMessages — automation rule matching engine.
 * Pure functions shared by the demo adapter, the rule test panel and
 * (for reference) the backend implementation documented in README.md.
 * The backend engine remains authoritative in live mode. */

export const TRIGGER_TYPES = [
  { id: 'contains', label: 'Contains keyword or phrase' },
  { id: 'exact', label: 'Exact phrase' },
  { id: 'starts_with', label: 'Starts with' },
  { id: 'any_keyword', label: 'Multiple keywords — match ANY' },
  { id: 'all_keywords', label: 'Multiple keywords — match ALL' },
  { id: 'regex', label: 'Regular expression (advanced)' },
  { id: 'fallback', label: 'Fallback — when no other rule matches' },
];

export const REPLY_MODES = [
  { id: 'predefined', label: 'Predefined reply' },
  { id: 'ai', label: 'AI-generated reply' },
  { id: 'ai_instruction', label: 'AI-generated reply + rule-specific instruction' },
];

/* ---------- regex safety ---------- */
export function validateRegex(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return { ok: false, error: 'Pattern is empty.' };
  if (pattern.length > 256) return { ok: false, error: 'Pattern exceeds 256 characters.' };
  if (/\0/.test(pattern)) return { ok: false, error: 'Pattern contains invalid characters.' };
  // Heuristic guard against catastrophic backtracking: ( ... + ) + / ( ... * ) * etc.
  const nested = /\((?:[^()\\]|\\.)*[+*]\)\s*\{?\s*\d*\s*,?\s*\d*\s*\}?\s*[+*]/;
  if (nested.test(pattern)) return { ok: false, error: 'Nested quantifiers like (a+)+ can hang the engine and are not allowed.' };
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: `Invalid pattern: ${err.message}` };
  }
}

/* ---------- single rule matching ---------- */
export function matchRule(rule, rawText) {
  const text = String(rawText ?? '');
  if (!rule || rule.enabled === false) return { matched: false, reason: 'Rule is disabled' };
  if (rule.triggerType === 'fallback') return { matched: false, reason: 'Fallback rules match only when nothing else does' };

  const caseSensitive = rule.caseSensitive === true;
  const norm = (s) => (caseSensitive ? String(s) : String(s).toLowerCase()).trim();
  const hay = norm(text);
  const normList = (list) => (Array.isArray(list) ? list.filter((k) => String(k ?? '').trim() !== '') : []);
  const keywords = normList(rule.keywords).map(norm);
  const excluded = normList(rule.excludedKeywords).map(norm);

  if (excluded.length && excluded.some((k) => hay.includes(k))) {
    return { matched: false, reason: `Excluded keyword present: "${excluded.find((k) => hay.includes(k))}"` };
  }
  if (!hay) return { matched: false, reason: 'Message is empty' };

  let matched = false;
  let reason = '';
  switch (rule.triggerType) {
    case 'contains':
      matched = keywords.some((k) => hay.includes(k));
      reason = matched ? `Message contains "${keywords.find((k) => hay.includes(k))}"` : 'No keyword found in message';
      break;
    case 'exact':
      matched = keywords.some((k) => hay === k);
      reason = matched ? 'Message equals trigger phrase' : 'Message is not an exact match';
      break;
    case 'starts_with':
      matched = keywords.some((k) => hay.startsWith(k));
      reason = matched ? `Message starts with "${keywords.find((k) => hay.startsWith(k))}"` : 'Message does not start with any trigger phrase';
      break;
    case 'any_keyword':
      matched = keywords.some((k) => hay.includes(k));
      reason = matched ? `Matched ANY of ${keywords.length} keywords` : 'None of the keywords appear in the message';
      break;
    case 'all_keywords':
      matched = keywords.length > 0 && keywords.every((k) => hay.includes(k));
      reason = matched ? 'Matched ALL keywords' : 'Not all keywords appear in the message';
      break;
    case 'regex': {
      const v = validateRegex((rule.keywords || [])[0] ?? rule.pattern ?? '');
      if (!v.ok) return { matched: false, reason: `Unsafe/invalid regex: ${v.error}` };
      const re = new RegExp((rule.keywords || [])[0] ?? rule.pattern ?? '', caseSensitive ? '' : 'i');
      matched = re.test(text);
      reason = matched ? 'Message matched regular expression' : 'Regular expression did not match';
      break;
    }
    default:
      return { matched: false, reason: `Unknown trigger type "${rule.triggerType}"` };
  }
  return { matched, reason };
}

/* ---------- priority-aware evaluation ----------
 * Lower priority number wins (1 = highest). Fallback rules apply only
 * when no regular rule matched. Cooldown is evaluated by the caller
 * (backend / demo engine) because it is per-conversation state. */
export function matchRules(rules, rawText) {
  const list = [...(rules || [])].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  const evaluated = [];
  let winner = null;
  for (const rule of list) {
    if (rule.triggerType === 'fallback') continue;
    const res = matchRule(rule, rawText);
    evaluated.push({ ruleId: rule.id, ruleName: rule.name, matched: res.matched, reason: res.reason });
    if (res.matched && !winner) winner = { rule, reason: res.reason, isFallback: false };
  }
  if (!winner) {
    const fb = list.find((r) => r.triggerType === 'fallback' && r.enabled !== false);
    if (fb) winner = { rule: fb, reason: 'No higher-priority rule matched — fallback applied', isFallback: true };
  }
  return { winner, evaluated };
}

/* ---------- template variables ----------
 * Only substitutes variables for which data is actually available;
 * unresolved variables are reported, never silently blanked. */
export function applyTemplate(text, vars = {}) {
  const unresolved = [];
  const out = String(text ?? '').replace(/\{(\w+)\}/g, (m, key) => {
    const v = vars[key];
    if (v === undefined || v === null || v === '') { unresolved.push(key); return m; }
    return String(v);
  });
  return { text: out, unresolved };
}

export function describeRule(rule) {
  const t = TRIGGER_TYPES.find((x) => x.id === rule.triggerType);
  const r = REPLY_MODES.find((x) => x.id === rule.replyMode);
  return `${t?.label ?? rule.triggerType} → ${r?.label ?? rule.replyMode}`;
}
