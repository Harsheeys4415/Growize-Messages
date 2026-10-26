/* GrowizeMessages backend — Meta webhook receiver Edge Function.
 *
 * Deployed as `meta-webhook` with verify_jwt = false (Meta cannot send a
 * Supabase JWT). Reachable at:
 *   https://<project>.supabase.co/functions/v1/meta-webhook
 *
 * GET  → Meta subscription verification (hub.challenge handshake).
 * POST → X-Hub-Signature-256 validation → dedup → persist inbound DM →
 *        run the automation pipeline in the background.
 *
 * The browser NEVER calls this function; nothing here is exposed to it.
 */

import {
  db, uid, getSecret, getSettingsRow, logActivity, hmacSha256Hex, timingSafeEqual,
} from '../_shared/lib.js';
import { upsertIncomingConversation, processIncoming } from '../_shared/engine.js';
import { getIgConfig } from '../_shared/ig.js';

const waitUntil = globalThis.EdgeRuntime?.waitUntil ?? ((p) => p);

Deno.serve(async (req) => {
  const url = new URL(req.url);

  /* ---------- subscription verification ---------- */
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    const expected = await getSecret('META_VERIFY_TOKEN');
    if (mode === 'subscribe' && expected && token && timingSafeEqual(token, expected)) {
      return new Response(challenge || '', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  /* ---------- signature validation ---------- */
  const raw = await req.text();
  const appSecret = await getSecret('META_APP_SECRET');
  const signatureHeader = req.headers.get('x-hub-signature-256') || '';
  if (!appSecret) {
    await logActivity({
      category: 'webhook_validation_failed', status: 'error',
      message: 'Webhook received but META_APP_SECRET is not configured — event rejected',
      detail: 'Set the META_APP_SECRET secret so signature validation can be enforced.',
    });
    return new Response('Server not configured', { status: 500 });
  }
  const expectedSig = 'sha256=' + (await hmacSha256Hex(appSecret, raw));
  if (!signatureHeader || !timingSafeEqual(signatureHeader, expectedSig)) {
    await logActivity({
      category: 'webhook_validation_failed', status: 'error',
      message: 'Webhook signature validation failed',
      detail: 'X-Hub-Signature-256 did not match the app secret. Event discarded.',
    });
    return new Response('Forbidden', { status: 401 });
  }

  /* ---------- parse ---------- */
  let payload = null;
  try { payload = JSON.parse(raw); } catch {
    await logActivity({ category: 'webhook_validation_failed', status: 'error', message: 'Webhook payload was not valid JSON' });
    return new Response('Bad request', { status: 400 });
  }

  const objectType = payload?.object; // 'instagram' (or 'page' for Page-hosted messaging)
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  if (!objectType || entries.length === 0) {
    return Response.json({ ok: true, ignored: 'unrecognised payload shape' });
  }

  let accepted = 0, duplicates = 0;

  for (const entry of entries) {
    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of messaging) {
      const senderId = event?.sender?.id;
      const isMessage = !!event?.message;

      // Ignore echoes of our own sends and read receipts.
      if (isMessage && event.message.is_echo) continue;
      if (!isMessage && !event?.postback) continue;

      const mid = event?.message?.mid || event?.postback?.mid || null;
      const tsMs = event?.timestamp || entry?.time || Date.now();
      const at = new Date(tsMs).toISOString();
      const eventId = mid || uid('evt');
      const dedupId = `${objectType}:${eventId}`;

      /* ---------- dedup (Meta delivers at-least-once) ---------- */
      const { data: inserted, error: dedupErr } = await db()
        .from('webhook_events')
        .upsert({ provider: 'meta', eventId: dedupId, receivedAt: new Date().toISOString() }, { onConflict: 'provider,eventId', ignoreDuplicates: true })
        .select('eventId')
        .maybeSingle();
      if (dedupErr) {
        console.error('dedup failed', dedupErr);
        return Response.json({ ok: false, error: 'dedup store unavailable' }, { status: 500 });
      }
      if (!inserted) { duplicates += 1; continue; }

      const correlationId = uid('corr');
      await db().from('webhook_events').update({ correlationId }).eq('provider', 'meta').eq('eventId', dedupId);

      if (!senderId) continue;

      const igConfig = await getIgConfig();
      await db().from('webhook_events').update({ payload: { senderId, objectType } }).eq('provider', 'meta').eq('eventId', dedupId).then(() => {}, () => {});

      /* ---------- postbacks ---------- */
      if (event?.postback) {
        const title = event.postback.title || event.postback.payload || 'postback';
        await logActivity({
          category: 'incoming_dm', status: 'info', conversationId: senderId,
          message: `Postback received: "${title}"`, correlationId,
        });
        accepted += 1;
        continue;
      }

      /* ---------- inbound message ---------- */
      const text = typeof event.message.text === 'string' ? event.message.text : null;
      const preview = text || '[media message]';

      const conv = await upsertIncomingConversation({ igsid: senderId, at, preview, igConfig });
      const convLabelStr = conv ? `${conv.name}${conv.username ? ` (@${String(conv.username).replace(/^@/, '')})` : ''}` : null;

      await logActivity({
        at, category: 'webhook_received', status: 'success',
        conversationId: senderId, conversationName: convLabelStr,
        message: `Webhook event received (${objectType}) from ${convLabelStr || senderId}`, correlationId,
      });

      if (mid && text) {
        const { error: msgErr } = await db().from('messages').upsert({
          id: mid,
          conversationId: senderId,
          direction: 'in',
          status: 'received',
          text,
          at,
          viaAI: false,
          ruleId: null,
          ruleName: null,
          error: null,
          correlationId,
          model: null,
          tokensIn: null,
          tokensOut: null,
          manual: false,
          source: 'automation',
        }, { onConflict: 'id', ignoreDuplicates: true });
        if (msgErr) console.error('message insert failed', msgErr);

        await logActivity({
          at, category: 'incoming_dm', status: 'success',
          conversationId: senderId, conversationName: convLabelStr,
          message: `Incoming DM: "${text.slice(0, 120)}"`,
          detail: 'Signature verified, event deduplicated and persisted.', correlationId,
        });
        accepted += 1;

        if (text) {
          waitUntil(processIncoming({ igsid: senderId, text, at, correlationId }).catch(async (err) => {
            console.error('pipeline failed', err);
            await logActivity({
              category: 'integration_error', status: 'error',
              conversationId: senderId, conversationName: convLabelStr, correlationId,
              message: `Automation pipeline failed: ${err.message}`,
            });
          }));
        }
      } else {
        // Media-only message — persisted to the conversation, no automation.
        if (mid) {
          await db().from('messages').upsert({
            id: mid, conversationId: senderId, direction: 'in', status: 'received',
            text: preview, at, viaAI: false, ruleId: null, ruleName: null, error: null,
            correlationId, model: null, tokensIn: null, tokensOut: null, manual: false, source: 'automation',
          }, { onConflict: 'id', ignoreDuplicates: true });
        }
        await logActivity({
          at, category: 'incoming_dm', status: 'info',
          conversationId: senderId, conversationName: convLabelStr,
          message: `Incoming ${text ? '' : 'media '}message received${text ? `: "${text.slice(0, 120)}"` : ' (no text) — no rule evaluation for media'}`, correlationId,
        });
        accepted += 1;
      }
    }
  }

  return Response.json({ ok: true, accepted, duplicates });
});
