# GrowizeMessages — Supabase backend (automation engine)

This folder contains the complete backend that powers live mode: the
database, the management API and the automation pipeline
(`Meta webhook → rule match → OpenRouter → Instagram send`).
Everything runs on Supabase (free tier is enough to start).

**The dashboard never talks to Meta or OpenRouter directly** — all of that
happens here, server-side. You only ever paste keys in two places (listed
below); none of them ever reach the frontend code.

---

## 0. What you need

- The [Supabase CLI](https://supabase.com/docs/guides/cli) (once: `npm install -g supabase` or brew/scoop) — only for deploying the functions
- A [Meta developer app](https://developers.facebook.com/apps) with the **Instagram Messaging** product (only needed for the Instagram part)
- An [OpenRouter API key](https://openrouter.ai/keys) (only if you use AI replies)

## 1. Create the project & the database

1. [supabase.com](https://supabase.com) → **New project** (free tier is fine). Save the DB password.
2. Open **SQL Editor → New query**, paste the whole of [`schema.sql`](./schema.sql), **Run**.
   → creates tables, RLS, Realtime publications, the admin trigger and starter (disabled) rules.

## 2. Deploy the three Edge Functions

From this folder's parent (the repo root):

```bash
supabase login
supabase link --project-ref <your-project-ref>      # ref = xxxx.supabase.co → xxxx
supabase functions deploy api
supabase functions deploy meta-webhook
supabase functions deploy meta-oauth
```

`config.toml` already disables the platform JWT check for these functions
(the `api` function verifies administrator JWTs itself; Meta has no JWT).
**Smoke test:**

```bash
curl https://<project-ref>.supabase.co/functions/v1/api/health
# → {"ok":true,"service":"growize-engine",...}
```

## 3. Set the secrets (this is where your keys go)

```bash
supabase secrets set \
  META_APP_SECRET=your-meta-app-secret \
  META_VERIFY_TOKEN=any-random-string-you-invent \
  OPENROUTER_API_KEY=sk-or-v1-...
```

| Secret | Required | Purpose |
|---|---|---|
| `META_APP_SECRET` | for webhooks | Validates every webhook signature (`X-Hub-Signature-256`) |
| `META_VERIFY_TOKEN` | for webhooks | Any random string — you type the same one in the Meta App Dashboard |
| `OPENROUTER_API_KEY` | for AI replies | Alternative: configure it from the app's AI page (stored in `app_secrets`) |
| `META_APP_ID` | for OAuth | Enables "Connect Instagram" from the Integrations page |
| `IG_ACCESS_TOKEN` | alternative | Manual token instead of OAuth (then use the app's API `POST /api/integrations/meta/token`) |

The OpenRouter key can also be set from the dashboard (**AI Assistant → Configure**) —
it lands in the `app_secrets` table server-side and is never returned to any client.
Instagram tokens are stored server-side via OAuth or the manual token endpoint.

## 4. Connect Instagram (in the Meta App Dashboard)

1. Your Instagram account must be **Professional** and linked to a Facebook Page.
2. Meta app → **Instagram Messaging** product → verify the webhook:
   - Callback URL: `https://<project-ref>.supabase.co/functions/v1/meta-webhook`
   - Verify token: the exact `META_VERIFY_TOKEN` value from step 3
   - Subscribe to the **messages** field (and `messaging_postbacks` if you want button taps).
3. **Settings → Basic**: copy the App ID / App Secret → `supabase secrets set META_APP_ID=…`
4. Add the OAuth redirect URL: `https://<project-ref>.supabase.co/functions/v1/meta-oauth`
5. App mode **Live** (or add your account as a test role while in Development).

## 5. Create your login & connect the dashboard

1. Supabase Dashboard → **Authentication → Users → Add user → Create new user**
   (email + password, **Auto Confirm**). *The first user automatically becomes an administrator.*
2. In the dashboard app: **Settings → Backend connection**
   - Supabase project URL: `https://<project-ref>.supabase.co`
   - Publishable (anon) key: Supabase → Settings → API → `anon` `public` key
   - Backend API base URL: `https://<project-ref>.supabase.co/functions/v1`
3. **Verify & connect** → both checks pass → sign in with the user from step 1.
4. Walk through **Settings → Open setup wizard** to verify each integration,
   review the sample rules in **Automations**, then resume automation.

## How it behaves in live mode

- **Inbound**: Meta → `meta-webhook` → signature check → dedup → persisted → rule engine → reply (predefined template or OpenRouter) → Meta send API. Every step lands in Activity Logs with a shared correlation id.
- **Guardrails enforced server-side**: global pause, per-conversation pause, per-rule cooldown, `maxRepliesPerConversation` per window, and Meta's 24-hour messaging window.
- **Manual sends** from the Inbox go through the same Meta API; `sent` is only ever shown after Meta accepted the message.
- **Failures** are honest: failed sends stay `failed` with Meta's error text; nothing auto-pretends success.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `curl /api/health` returns 401 | `config.toml` missing → re-deploy after `supabase functions deploy api` (see step 2) |
| Health check times out in the app | Backend base URL must be exactly `https://<ref>.supabase.co/functions/v1` |
| Sign-in fails | Create the user in Supabase Auth first; the app has no signup by design |
| Webhook verification fails in Meta | `META_VERIFY_TOKEN` secret ≠ token typed in Meta dashboard |
| No auto-replies | Automation paused? Rule enabled? Cooldown? Contact outside the 24h window? Check Activity Logs — the pipeline logs every skip reason |
| `NO_KEY` in logs | Set the OpenRouter key (AI page or `supabase secrets set`) |
| Meta sends `(10) window expired` | Normal outside 24h — the customer must message you first |
