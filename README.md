# GrowizeMessages

**Every message, handled.**

GrowizeMessages is the **management dashboard** for an Instagram DM automation system. It is **not** the automation engine itself — the engine runs independently on your infrastructure (Meta webhooks → Supabase Edge Functions → OpenRouter → Instagram Messaging API) and keeps working while this app is closed.

GrowizeMessages is the control panel for:

- Viewing incoming messages and outgoing replies
- Managing automation rules and testing them safely
- Configuring AI behaviour (OpenRouter) with server-side credentials
- Monitoring system health, integration status and activity logs
- Controlling global and per-conversation automation
- Sending manual replies through your backend

---

## 1. Technology & file tree

HTML5 · CSS3 · vanilla JavaScript (ES modules) · Lucide icons · Supabase JS client (loaded lazily) · PWA manifest + service worker. **No framework, no build step.**

```text
GrowizeMessages/
├── index.html                  # App shell (sidebar, topbar, main, modal/toast roots)
├── styles.css                  # Complete design system (light + dark themes)
├── app.js                      # Entry point: boot, hash router, PWA registration
├── manifest.json               # PWA manifest (installable)
├── service-worker.js           # App-shell caching; NEVER caches /api/* or private data
├── package.json                # Metadata + `npm start` script (static server)
├── README.md
├── assets/
│   └── icons/                  # Generated PWA icons + logo.svg
├── services/
│   ├── store.js                # Tiny observable state + event bus + localStorage helpers
│   ├── api.js                  # Central API service — demo adapter + live adapter
│   ├── demo.js                 # Demo environment: seeded sample data + simulated pipeline
│   ├── supabase.js             # Lazy Supabase client wrapper (auth + realtime helpers)
│   ├── rules-engine.js         # Pure rule matching (shared logic + regex safety)
│   └── live-mode.js            # Authoritative demo→live connection lifecycle
└── components/
    ├── ui.js                   # esc(), icons, toasts, modals, dropdowns, formatters
    ├── navigation.js           # Sidebar, topbar, banners, demo tools, notifications
    ├── auth.js                 # Administrator sign-in / demo entry screen
    ├── dashboard.js            # Overview: stats, activity, conversations, health summary
    ├── inbox.js                # Conversations, message detail, manual composer
    ├── automations.js          # Rules manager, editor drawer, safe rule tester
    ├── ai-settings.js          # OpenRouter config, credential handling, test console
    ├── integrations.js         # Meta / Supabase / OpenRouter integration cards
    ├── activity-logs.js        # Searchable, filterable, expandable event log
    ├── system-health.js        # Authoritative checks + troubleshooting instructions
    ├── settings.js             # Global settings, emergency pause, export, demo reset
    └── setup-wizard.js         # 9-step first-run wizard with per-step verification
```

Plus the complete backend in [`supabase/`](./supabase/README.md) (deploy to your own Supabase project — you only paste the keys):

```text
supabase/
├── schema.sql                  # Full DB: tables, RLS, Realtime, admin trigger, starter rules
├── config.toml                 # Edge Function config (JWT verification policy per function)
├── README.md                   # 15-minute deployment guide + secrets table + troubleshooting
└── functions/
    ├── _shared/                # lib (env/CORS/auth/db), rules engine port, IG client, OpenRouter client, automation engine
    ├── api/                    # Management API gateway — implements the full §5 contract
    ├── meta-webhook/           # Meta webhook: signature validation, dedup, pipeline trigger
    └── meta-oauth/             # Official Meta OAuth start/callback (token stored server-side)
```

> Note: a few modules beyond the minimal suggested tree (store, ui, auth, live-mode, rules-engine, system-health, settings, setup-wizard) were added to keep each concern isolated and testable — the structure remains plain ES modules with no build system.

---

## 2. Local development

Any static file server works. From this folder:

```bash
# Option A (Python, preinstalled almost everywhere)
python3 -m http.server 4173
# or: npm start

# Option B (Node)
npx --yes serve -l 4173 .
```

Then open **http://localhost:4173**.

Requirements:

- Serve over **HTTP(S) via a server** — opening `index.html` through `file://` will NOT work (ES modules + service worker require http:// or https://localhost).
- Node.js ≥ 18 only needed if you use `npx serve`; the app itself has zero runtime dependencies.
- Lucide icons and the Supabase client load from CDNs; the app degrades gracefully offline (buttons keep text labels).

### 2.1 Hosting on GitHub Pages

The app is deployment-ready for GitHub Pages with **no code changes**: every asset reference, manifest URL, service-worker path and dynamic import is relative, and `manifest.json` uses `start_url: "./"` / `scope: "./"`, so it works both at a domain root and under a project subpath (`https://<user>.github.io/<repo>/`). GitHub Pages is served over HTTPS, which satisfies the PWA install requirement. Demo mode is 100% client-side, so it works fully once deployed.

**Option A — GitHub Actions (recommended, auto-deploys on push):**

1. Push the contents of this folder to a GitHub repository (the repo root should contain `index.html` directly).
2. In the repo: **Settings → Pages → Build and deployment → Source: "GitHub Actions"**.
3. A ready workflow is included at `.github/workflows/deploy.yml` — it publishes the site on every push to `main` and adds `.nojekyll` for you.
4. Your app will be live at `https://<user>.github.io/<repo>/` within ~1 minute.

**Option B — Deploy from a branch (no Actions):**

1. Push the app files to the `main` branch (repo root).
2. **Settings → Pages → Source: "Deploy from a branch"** → `main` / `(root)` → Save.

Notes:

- If you keep the app in a **subfolder** of the repo, set the Pages source/folder (or the workflow `path:`) to that subfolder — the app handles the subpath automatically.
- A custom domain also works; serve the app from the domain root for the cleanest PWA scope.
- **GitHub Pages is static-only:** demo mode runs fully, but **live mode** requires the backend (Supabase Edge Functions or equivalent) hosted separately — see §5 and §8. The frontend will honestly report "backend unreachable" until you connect one in Settings → Backend connection. Never place API keys in the repo; they belong only in backend environment/secrets.

## 3. PWA installation

- **Chrome / Edge (desktop):** install icon in the address bar, or ⋮ menu → *Cast, save and share → Install page as app*.
- **Android:** browser menu → *Add to Home screen / Install app*.
- **iOS Safari:** Share → *Add to Home Screen*.
- The service worker caches the application shell; private data (messages, tokens, API responses) is **never cached**. `/api/*` requests are network-only.
- **Important:** installing the PWA installs **only the management interface**. The automation engine runs on your backend independently — closing or never opening this app does not stop automation.

## 4. Demo mode guide

The app boots into **demo mode by default** — a fully functional environment with simulated data, clearly labeled everywhere (`DEMO` pill, "demo" tags on every metric, "sample" badges).

What works in demo mode:

- Sample dashboard metrics, conversations, messages, rules and logs
- Creating / editing / duplicating / reordering / deleting rules locally
- The rule tester (safe matching + proposed-reply preview)
- Simulated send flow (queued → sent, or → failed via demo tools)
- **Demo tools** (bottom-right pill): *Simulate incoming DM* (runs the full local pipeline: webhook → rules → AI → reply), *Simulate reply failure*, *Reset demo data*
- Mock AI settings, integration statuses and health checks — all labeled simulated

What demo mode **never** does: send real Instagram messages, contact Meta/OpenRouter, or store credentials. Demo data lives in `localStorage` only and can be reset from Settings or the demo tools.

Going live: Settings → **Backend connection** (or Integrations → Supabase) → enter Supabase URL + publishable anon key + backend base URL → *Verify & connect*. Live mode activates **only after** the Supabase auth endpoint and the backend `/api/health` check both succeed, followed by administrator sign-in.

## 5. Backend API contract

The frontend talks to **one base URL** (your backend) using these application routes. They are **not** provided by Supabase automatically — implement them as Supabase Edge Functions (or any authenticated API). Map each route in `services/api.js` (`liveRequest(path)` calls) if your deployment differs.

All requests carry `Authorization: Bearer <Supabase access token>`; sends may carry an `Idempotency-Key` header. JSON everywhere. Error shape: `{ "error": "human readable message" }` with proper HTTP status codes (401 for expired sessions).

| Method | Route | Purpose | Body / Query | Response (abridged) |
|---|---|---|---|---|
| GET | `/api/health` | Liveness probe used by wizard/settings | — | `{ ok: true, service: "growize-engine" }` |
| GET | `/api/dashboard/summary` | Overview metrics | `?range=today\|7d\|30d\|custom&from&to` | `{ automationEnabled, igAccount, incoming, repliesSent, failed, unreadConversations, aiRequests, tokensIn, tokensOut, estCostUsd, successRate, topRules[], recentActivity[], recentConversations[], lastWebhookAt, lastReplyAt, lastSyncAt, simulated? }` |
| GET | `/api/integrations/status` | Three integration cards | — | `{ meta:{...}, supabase:{...}, openrouter:{...} }` (shapes mirror `services/demo.js` seeds) |
| GET | `/api/integrations/meta/status` | Meta connection detail | — | meta status object |
| GET | `/api/integrations/meta/auth` | Start Meta OAuth (302 redirect) | — | redirect to Meta consent |
| GET | `/api/conversations` | Conversation list | `?search&filter=all\|unread\|paused` | `Conversation[]` |
| GET | `/api/conversations/:id/messages` | Messages of a conversation | — | `Message[]` |
| POST | `/api/conversations/:id/reply` | Send manual reply via Meta API | `{ text }` + `Idempotency-Key` | `Message` (status `queued` or `sent`) |
| POST | `/api/conversations/:id/pause` | Pause automation for one conversation | — | `{ ok }` |
| POST | `/api/conversations/:id/resume` | Resume automation for one conversation | — | `{ ok }` |
| POST | `/api/conversations/:id/read` | Mark read/unread | `{ read }` | `{ ok }` |
| GET | `/api/rules` | List rules (priority order) | — | `Rule[]` |
| POST | `/api/rules` | Create rule | `Rule` payload | `Rule` |
| PUT | `/api/rules/:id` | Update rule | partial `Rule` | `Rule` |
| DELETE | `/api/rules/:id` | Delete rule | — | `204` |
| POST | `/api/rules/:id/duplicate` | Duplicate rule | — | `Rule` |
| POST | `/api/rules/:id/priority` | Reorder | `{ direction: "up"\|"down" }` | `Rule[]` |
| POST | `/api/rules/test` | **Safe** rule test — never sends | `{ text, ruleId? }` | `{ ok, winner?, evaluated[], reply? }` |
| GET | `/api/activity` | Event log, paginated | `?q&category&status&conversationId&ruleId&from&to&page` | `{ rows[], total, page, pages }` |
| GET | `/api/settings` | Global settings | — | `Settings` |
| PUT | `/api/settings` | Update settings | partial `Settings` | `Settings` |
| POST | `/api/automation/pause` | Global pause (enforced server-side) | `{ emergency? }` | `{ ok, automationEnabled }` |
| POST | `/api/automation/resume` | Global resume | — | `{ ok, automationEnabled }` |
| POST | `/api/integrations/openrouter/test` | Generate a preview reply | `{ message }` | `{ ok, reply, model, tokensIn, tokensOut, latencyMs }` |
| POST | `/api/integrations/openrouter/configure` | Store/clear key server-side | `{ apiKey }` or `{ clear: true }` | `{ ok, keyConfigured, keyMask? }` |
| GET | `/api/integrations/openrouter/models` | Model list proxy | — | `{ models[] }` |
| GET | `/api/health/checks` | System health checks | — | `{ checks[] }` |
| POST | `/api/setup/verify/:step` | Wizard step validation | `{}` | `{ ok, message }` |

Canonical object shapes (also implemented by the demo adapter in `services/demo.js`):

```ts
Conversation { id, name, username, paused, unread, messageCount, lastMessagePreview, lastMessageAt }
Message      { id, conversationId, direction: "in"|"out", status: "received"|"queued"|"sent"|"failed"|"ignored",
               text, at, viaAI, manual, ruleId, ruleName, model, tokensIn, tokensOut, error, correlationId }
Rule         { id, name, description, enabled, priority /* 1 = highest */, triggerType: "exact"|"contains"|"starts_with"|
               "any_keyword"|"all_keywords"|"regex"|"fallback", keywords[], excludedKeywords[], caseSensitive,
               replyMode: "predefined"|"ai"|"ai_instruction", replyText, aiInstruction, cooldownMins,
               triggerCount, lastTriggeredAt }
ActivityLog  { id, at, category /* see ui.js CATEGORY_META */, status: "success"|"error"|"info",
               conversationId?, conversationName?, ruleId?, ruleName?, message, detail?, correlationId? }
Settings     { appName, automationEnabled, defaultReplyMode, fallbackResponse, globalCooldownMins,
               maxRepliesPerConversation, repliesWindowMins, timezone, language, notifications{desktop,sound},
               ai{ enabled, model, customModel, systemPrompt, maxTokens, temperature, contextMessages,
                   maxInputChars, timeoutMs, retries, fallbackReply, pricing{...} } }
```

**Realtime:** when Supabase is configured the app subscribes to `postgres_changes` on `messages`, `activity_logs` and `settings`, and unsubscribes when a view is destroyed. Refetch authoritative data after reconnecting.

## 6. Proposed Supabase schema

```sql
-- Enable RLS on every table. The service role is used ONLY by Edge Functions.

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  display_name text,
  created_at timestamptz default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  ig_user_id text not null,               -- your connected IG account
  contact_ig_id text not null,
  contact_name text,
  contact_username text,
  automation_paused boolean default false,
  unread_count integer default 0,
  message_count integer default 0,
  last_message_preview text,
  last_message_at timestamptz,
  unique (ig_user_id, contact_ig_id)
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  direction text check (direction in ('in','out')),
  status text check (status in ('received','queued','sent','failed','ignored')),
  text text,
  at timestamptz default now(),
  via_ai boolean default false,
  manual boolean default false,
  rule_id uuid,
  rule_name text,
  model text, tokens_in int, tokens_out int,
  error text,
  correlation_id text,
  meta_message_id text,                   -- idempotency / dedupe
  ig_event_id text unique                 -- webhook event dedupe
);

create table rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  enabled boolean default true,
  priority int not null default 99,
  trigger_type text check (trigger_type in ('exact','contains','starts_with','any_keyword','all_keywords','regex','fallback')),
  keywords jsonb default '[]',
  excluded_keywords jsonb default '[]',
  case_sensitive boolean default false,
  reply_mode text check (reply_mode in ('predefined','ai','ai_instruction')),
  reply_text text,
  ai_instruction text,
  cooldown_mins int default 0,
  trigger_count int default 0,
  last_triggered_at timestamptz,
  created_at timestamptz default now()
);

create table activity_logs (
  id uuid primary key default gen_random_uuid(),
  at timestamptz default now(),
  category text not null,
  status text check (status in ('success','error','info')),
  conversation_id uuid,
  conversation_name text,
  rule_id uuid, rule_name text,
  message text, detail text,
  correlation_id text
);

create table settings (
  id int primary key default 1 check (id = 1),   -- single row
  data jsonb not null,                            -- Settings object (never secrets)
  updated_at timestamptz default now()
);

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  ig_event_id text unique not null,               -- dedupe at DB level
  payload jsonb,
  signature_valid boolean,
  processed_at timestamptz
);

create table ai_usage_daily (
  date date primary key,
  requests int, tokens_in int, tokens_out int
);

alter table conversations enable row level security;
alter table messages     enable row level security;
alter table rules        enable row level security;
alter table activity_logs enable row level security;
alter table settings     enable row level security;

-- Example policy (repeat per table): only authenticated dashboard users
create policy "authenticated read" on conversations
  for select to authenticated using (true);
-- All writes should go through Edge Functions with the service role;
-- grant write policies only if clients must write directly.
```

## 7. Meta integration requirements

1. **Meta app** with the **Instagram Messaging** product (business type). Connect a professional Instagram account to a Facebook Page.
2. **Permissions:** `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_read_engagement` (+ `instagram_manage_comments` only for the future comment-trigger integration).
3. **Webhook:** subscribe the app to `messages` and `messaging_postbacks`; point the callback URL at your backend Edge Function (e.g. `https://<project>.supabase.co/functions/v1/meta-webhook`) and set the verify token. Validate every payload's `X-Hub-Signature-256` against the app secret.
4. **Tokens:** use the official OAuth flow — the frontend links to `GET /api/integrations/meta/auth` on your backend, which performs consent → code exchange → long-lived token exchange → server-side storage (Supabase Vault / secrets). The frontend only ever sees masked status.
5. **Messaging window:** replies are only allowed within 24h of the user's last message (plus approved message tags). The backend must enforce this before sending.
6. **Never** ask for the Instagram password, use browser automation, cookie scraping, or unofficial APIs.

## 8. Secure OpenRouter configuration flow

- Calls go to `https://openrouter.ai/api/v1/chat/completions` **from the backend only**, using the configured model and recent conversation context.
- The dashboard's key field POSTs once to `POST /api/integrations/openrouter/configure` over HTTPS with the auth token. The backend stores the key server-side (Edge Function secret or Vault) and returns only `{ keyConfigured: true, keyMask }`.
- The key is **never** embedded in frontend source, never persisted in localStorage/sessionStorage, never returned by GET endpoints, never logged or placed in URLs.
- Rotation/clearing: `POST .../configure { clear: true }`.
- Model selection is free-form (any model the account can access); the model list is proxied via `GET /api/integrations/openrouter/models`.

## 9. Features that work right now (frontend + demo adapter)

- Complete management UI: overview, inbox, automations, AI settings, activity logs, integrations, system health, settings
- Full demo environment with simulated pipeline, demo tools, reset
- Rule CRUD + priority reordering + safe tester with evaluation trace
- Rule matching engine (all trigger types, exclusions, case sensitivity, fallback, regex safety validation)
- Send flow with pending → confirmed states; failure surfacing with error details
- Global & per-conversation pause/resume with confirmations
- AI configuration UI, masked credential handling, test console (clearly preview-only)
- Setup wizard with per-step simulated/live verification
- PWA: installable, offline shell, online/offline indicator
- Light/dark/system themes, accessible dialogs, keyboard navigation, reduced-motion support
- Live adapter implementation ready against the documented contract

## 10. Features that require backend implementation

**All of the below now ships in [`supabase/`](./supabase/README.md)** — deploy it to your Supabase project (3 CLI commands + SQL file) and live mode works end to end. Nothing here is left as a manual exercise:

- ✅ Receiving and validating Meta webhooks; event dedup (`webhook_events`) — `functions/meta-webhook`
- ✅ Persisting real conversations/messages and evaluating rules server-side — `functions/_shared/engine.js`
- ✅ Calling OpenRouter and sending replies through the Instagram Messaging API — `functions/_shared/ai.js`, `ig.js`
- ✅ Enforcing the 24h messaging window, rate limits, cooldowns and the global paused state **before** any send
- ✅ OAuth token exchange and server-side storage of Meta + OpenRouter credentials — `functions/meta-oauth` + `app_secrets`
- ✅ Supabase Auth users/roles + RLS policies for the dashboard account — `schema.sql`
- ✅ Authoritative health checks (`/api/health/checks`) and wizard verification endpoints — `functions/api`
- ☐ Realtime broadcast of changes (tables are published; client subscribes via `api.subscribeRealtime` — wire-up in components is future work; live pages refetch on navigation today)
- ☐ Push notifications for failures (the UI surfaces in-app toasts regardless)

## 11. Security checklist before connecting a real Instagram account

- [ ] Backend deployed over HTTPS; `service-role` key only in Edge Function secrets — never in this frontend, never in localStorage
- [ ] Supabase RLS enabled on all tables; dashboard access restricted to authorized authenticated users
- [ ] Webhook signature validation (`X-Hub-Signature-256`) active; invalid payloads rejected and logged
- [ ] Event dedupe in place (unique `ig_event_id`)
- [ ] Global + per-conversation pause state enforced server-side before every send
- [ ] 24h messaging window + rate limits + cooldowns enforced server-side
- [ ] Meta access token + OpenRouter key stored server-side only; masked statuses only in UI
- [ ] Idempotency keys on send endpoints; no blind client-side retries of message sends
- [ ] All rendered message content escaped (this app escapes by default — keep it that way if you modify components)
- [ ] Incoming DM content treated as untrusted data — never interpolated into prompts as instructions or rendered as HTML
- [ ] Activity logs free of keys, tokens and authorization headers
- [ ] Confirm-before-destructive flows kept enabled (delete rule, emergency pause, disconnect)
- [ ] Test the full loop with a test Instagram account before pointing at production
