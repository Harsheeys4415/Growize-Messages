/* GrowizeMessages backend — OpenRouter client.
 * Called ONLY from the backend. The key lives in app_secrets (or the
 * OPENROUTER_API_KEY environment secret) and is never returned to any client.
 * Endpoint: https://openrouter.ai/api/v1/chat/completions
 */

import { getSecret, maskKey, logActivity } from './lib.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function getKey() {
  return getSecret('OPENROUTER_API_KEY');
}

export async function keyStatus() {
  const key = await getKey();
  return { configured: !!key, keyMask: key ? maskKey(key) : null };
}

/* Build the message array from conversation context. */
export function buildMessages({ systemPrompt, instruction, history, incomingText, maxInputChars }) {
  const chars = Math.max(200, maxInputChars || 2000);
  const trimmedHistory = [];
  let budget = chars;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const t = String(m.text || '');
    if (t.length > budget) break;
    budget -= t.length;
    trimmedHistory.unshift({ role: m.direction === 'in' ? 'user' : 'assistant', content: t });
  }
  const messages = [{ role: 'system', content: instruction ? `${systemPrompt}\n\nAdditional instruction for this reply: ${instruction}` : systemPrompt }];
  messages.push(...trimmedHistory);
  messages.push({ role: 'user', content: String(incomingText || '').slice(0, chars) });
  return messages;
}

export async function chatCompletion({ model, messages, maxTokens, temperature, timeoutMs, retries }) {
  const key = await getKey();
  if (!key) {
    const err = new Error('No OpenRouter key is configured on the backend. Set it from the AI Assistant page (stored server-side) or via `supabase secrets set OPENROUTER_API_KEY=…`.');
    err.code = 'NO_KEY';
    throw err;
  }
  const attempts = Math.max(0, Math.min(3, retries ?? 2)) + 1;
  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(3000, timeoutMs || 20000));
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://growizemessages.app',
          'X-Title': 'GrowizeMessages',
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens || 400, temperature: temperature ?? 0.7 }),
        signal: ctrl.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(body?.error?.message || `OpenRouter returned ${res.status}`);
        err.upstreamStatus = res.status;
        err.retryable = res.status >= 500 || res.status === 429;
        lastErr = err;
        if (!err.retryable || attempt === attempts) throw err;
      } else {
        const choice = body?.choices?.[0]?.message?.content || '';
        return {
          text: String(choice).trim(),
          model: body?.model || model,
          tokensIn: body?.usage?.prompt_tokens ?? null,
          tokensOut: body?.usage?.completion_tokens ?? null,
        };
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        lastErr = new Error(`OpenRouter request timed out after ${timeoutMs || 20000}ms`);
        lastErr.retryable = true;
      } else if (err.code === 'NO_KEY') {
        throw err;
      } else {
        lastErr = err;
        lastErr.retryable = err.retryable ?? true;
      }
      if (attempt === attempts || !lastErr.retryable) throw lastErr;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr || new Error('OpenRouter request failed');
}

/* Generate a reply for an incoming DM using the configured settings. */
export async function generateReply({ settings, instruction = null, history = [], incomingText, correlationId = null, conversationRef = null }) {
  const ai = settings.ai || {};
  const model = ai.model || ai.customModel || 'openai/gpt-4o-mini';
  const started = Date.now();
  await logActivity({
    category: 'ai_request_started', status: 'info',
    conversationId: conversationRef?.id, conversationName: conversationRef?.label,
    message: `AI reply generation started (${model})`, correlationId,
  });
  try {
    const out = await chatCompletion({
      model,
      messages: buildMessages({
        systemPrompt: ai.systemPrompt || 'You are a helpful assistant.',
        instruction,
        history,
        incomingText,
        maxInputChars: ai.maxInputChars,
      }),
      maxTokens: ai.maxTokens,
      temperature: ai.temperature,
      timeoutMs: ai.timeoutMs,
      retries: ai.retries,
    });
    await logActivity({
      category: 'ai_request_succeeded', status: 'success',
      conversationId: conversationRef?.id, conversationName: conversationRef?.label,
      message: `AI reply generated in ${((Date.now() - started) / 1000).toFixed(1)}s (${out.model})`,
      detail: `Tokens: ${out.tokensIn ?? '?'} in / ${out.tokensOut ?? '?'} out.`, correlationId,
    });
    return out;
  } catch (err) {
    await logActivity({
      category: 'ai_request_failed', status: 'error',
      conversationId: conversationRef?.id, conversationName: conversationRef?.label,
      message: `AI request failed: ${err.message}`, correlationId,
    });
    throw err;
  }
}
