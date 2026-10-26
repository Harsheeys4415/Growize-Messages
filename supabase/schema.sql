-- ============================================================
-- GrowizeMessages — Supabase schema
-- Paste this whole file into: Supabase Dashboard → SQL Editor → New query → Run
-- Safe to re-run (idempotent).
--
-- Design notes:
-- - Column names are quoted camelCase so rows map 1:1 to the dashboard's
--   JavaScript objects (no field renaming in the API layer).
-- - Clients get SELECT-only access (for Realtime updates). EVERY write goes
--   through the Edge Functions with the service role — the browser can never
--   write data or read secrets.
-- - API keys/tokens live in `app_secrets`: RLS denies all direct access;
--   only the service role (Edge Functions) can read or write it.
-- ============================================================

-- ---------- profiles (dashboard administrators) ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  first_user boolean;
begin
  select not exists (select 1 from public.profiles) into first_user;
  insert into public.profiles (id, email, is_admin)
  values (new.id, new.email, first_user)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- global settings (single row, id = 1) ----------
create table if not exists public.settings (
  id        int primary key default 1 check (id = 1),
  data      jsonb not null,
  "updatedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);

insert into public.settings (id, data) values (
  1,
  '{
    "appName": "GrowizeMessages",
    "automationEnabled": false,
    "defaultReplyMode": "ai",
    "fallbackResponse": "Sorry, we couldn'"'"'t generate a reply right now — a team member will follow up with you soon!",
    "globalCooldownMins": 10,
    "maxRepliesPerConversation": 3,
    "repliesWindowMins": 60,
    "timezone": "system",
    "language": "en",
    "notifications": { "desktop": false, "sound": false },
    "ai": {
      "enabled": true,
      "provider": "OpenRouter",
      "model": "openai/gpt-4o-mini",
      "customModel": "",
      "systemPrompt": "You are the assistant for Growize, a sustainable gardening brand helping people grow food in small spaces. Be warm, concise and practical. Answer questions about products, prices, delivery and workshops. Never invent order details, tracking events or medical claims. If a question needs human judgment, say a team member will follow up.",
      "maxTokens": 400,
      "temperature": 0.7,
      "contextMessages": 10,
      "maxInputChars": 2000,
      "timeoutMs": 20000,
      "retries": 2,
      "fallbackReply": "Thanks for your message! A human teammate will jump in shortly.",
      "keyConfigured": false,
      "keyMask": null,
      "lastTestAt": null,
      "lastTestResult": null,
      "pricing": { "inputPerMillionUsd": 0.15, "outputPerMillionUsd": 0.6 }
    }
  }'::jsonb
) on conflict (id) do nothing;

-- ---------- server-side secrets (OpenRouter key, IG token, etc.) ----------
-- No RLS policies on purpose: direct client access is fully denied.
-- Edge Functions read/write it with the service role.
create table if not exists public.app_secrets (
  name        text primary key,
  value       text,
  "updatedAt" timestamptz
);

-- ---------- conversations ----------
create table if not exists public.conversations (
  id                   text primary key,          -- Instagram IGSID of the contact
  name                 text not null default 'Instagram user',
  username             text not null default '',
  paused               boolean not null default false,
  unread               int not null default 0,
  "messageCount"       int not null default 0,
  "lastMessageAt"      timestamptz not null default now(),
  "lastMessagePreview" text not null default '',
  "lastInboundAt"      timestamptz,               -- drives the 24h messaging window
  "createdAt"          timestamptz not null default now()
);
create index if not exists conversations_last_message_idx on public.conversations ("lastMessageAt" desc);

-- ---------- messages ----------
create table if not exists public.messages (
  id             text primary key,               -- Meta message id (mid) for inbound, generated for outbound
  "conversationId" text not null references public.conversations (id) on delete cascade,
  direction      text not null check (direction in ('in', 'out')),
  status         text not null check (status in ('received', 'queued', 'sent', 'failed', 'ignored')),
  text           text not null default '',
  at             timestamptz not null default now(),
  "viaAI"        boolean not null default false,
  "ruleId"       text,
  "ruleName"     text,
  error          text,
  "correlationId" text,
  model          text,
  "tokensIn"     int,
  "tokensOut"    int,
  manual         boolean not null default false,
  source         text not null default 'automation' check (source in ('automation', 'manual')),
  "createdAt"    timestamptz not null default now()
);
create index if not exists messages_conversation_at_idx on public.messages ("conversationId", at);
create index if not exists messages_at_idx on public.messages (at desc);
create index if not exists messages_status_idx on public.messages (status);

-- ---------- automation rules ----------
create table if not exists public.rules (
  id                text primary key,
  name              text not null,
  description       text not null default '',
  enabled           boolean not null default true,
  priority          int not null default 10,
  "triggerType"     text not null check ("triggerType" in ('contains', 'exact', 'starts_with', 'any_keyword', 'all_keywords', 'regex', 'fallback')),
  keywords          jsonb not null default '[]'::jsonb,
  "excludedKeywords" jsonb not null default '[]'::jsonb,
  "caseSensitive"   boolean not null default false,
  "replyMode"       text not null check ("replyMode" in ('predefined', 'ai', 'ai_instruction')),
  "replyText"       text not null default '',
  "aiInstruction"   text not null default '',
  "cooldownMins"    int not null default 0,
  "triggerCount"    int not null default 0,
  "lastTriggeredAt" timestamptz,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz
);
create index if not exists rules_priority_idx on public.rules (priority);

-- Starter rules (ALL disabled — review, edit, then enable what you need).
insert into public.rules (id, name, description, enabled, priority, "triggerType", keywords, "excludedKeywords", "caseSensitive", "replyMode", "replyText", "aiInstruction", "cooldownMins")
values
  ('rule_pricing', 'Pricing & cost questions (sample)', 'Sample rule — review keywords and the AI instruction, then enable.', false, 1, 'contains',
   '["price","pricing","cost","how much"]'::jsonb, '["wholesale"]'::jsonb, false, 'ai', '', '', 30),
  ('rule_delivery', 'Delivery & shipping (sample)', 'Sample rule — review keywords and the AI instruction, then enable.', false, 2, 'any_keyword',
   '["deliver","delivery","shipping","ship to"]'::jsonb, '[]'::jsonb, false, 'ai_instruction', '',
   'Mention that delivery is free over $50 and standard shipping takes 3-5 business days. If the location is unclear, ask which city they are in. Never promise same-day delivery.', 30),
  ('rule_hours', 'Business hours (sample)', 'Sample rule — edit the predefined reply, then enable.', false, 3, 'any_keyword',
   '["hours","open","opening","closing","what time"]'::jsonb, '[]'::jsonb, false, 'predefined',
   'Hi {name}! We are online Mon-Fri 9am-5pm and Sat 9am-1pm. You can place orders anytime and we will reply first thing next business day if it is after hours.', '', 60),
  ('rule_fallback', 'Fallback — friendly greeting (sample)', 'Replies when no other rule matches. Keep it generic and friendly.', false, 99, 'fallback',
   '[]'::jsonb, '[]'::jsonb, false, 'predefined',
   'Hey! Thanks for your message — I can help with products, prices, delivery and workshops. What are you after today?', '', 30)
on conflict (id) do nothing;

-- ---------- activity logs ----------
create table if not exists public.activity_logs (
  id                text primary key,
  at                timestamptz not null default now(),
  category          text not null,
  status            text not null default 'success',
  "conversationId"  text,
  "conversationName" text,
  "ruleId"          text,
  "ruleName"        text,
  message           text not null,
  detail            text,
  "correlationId"   text
);
create index if not exists activity_at_idx on public.activity_logs (at desc);
create index if not exists activity_category_idx on public.activity_logs (category);
create index if not exists activity_conversation_idx on public.activity_logs ("conversationId");

-- ---------- webhook dedup ----------
create table if not exists public.webhook_events (
  provider    text not null default 'meta',
  "eventId"   text not null,
  "receivedAt" timestamptz not null default now(),
  payload     jsonb,
  "correlationId" text,
  primary key (provider, "eventId")
);

-- ============================================================
-- Row Level Security
-- The browser (authenticated dashboard user) may READ these tables so the
-- UI's Realtime subscriptions work. It may NEVER write. app_secrets and
-- profiles have NO select policy — direct client access is impossible.
-- ============================================================
alter table public.settings        enable row level security;
alter table public.conversations   enable row level security;
alter table public.messages        enable row level security;
alter table public.rules           enable row level security;
alter table public.activity_logs   enable row level security;
alter table public.webhook_events  enable row level security;
alter table public.app_secrets     enable row level security;
alter table public.profiles        enable row level security;

drop policy if exists "read_only" on public.settings;
create policy "read_only" on public.settings for select to authenticated using (true);

drop policy if exists "read_only" on public.conversations;
create policy "read_only" on public.conversations for select to authenticated using (true);

drop policy if exists "read_only" on public.messages;
create policy "read_only" on public.messages for select to authenticated using (true);

drop policy if exists "read_only" on public.rules;
create policy "read_only" on public.rules for select to authenticated using (true);

drop policy if exists "read_only" on public.activity_logs;
create policy "read_only" on public.activity_logs for select to authenticated using (true);

-- webhook_events, app_secrets, profiles: intentionally NO policies (deny all).

-- ---------- Realtime ----------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'activity_logs') then
    alter publication supabase_realtime add table public.activity_logs;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'settings') then
    alter publication supabase_realtime add table public.settings;
  end if;
end $$;
