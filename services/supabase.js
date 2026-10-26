/* GrowizeMessages — Supabase client wrapper.
 *
 * The client library is loaded lazily from a CDN only when a live backend
 * is being configured. In demo mode nothing is downloaded.
 *
 * Security notes:
 * - Only the publishable anon key is ever handled here, never the
 *   service-role key.
 * - Sessions persist in localStorage under the 'gm.sb' key via
 *   supabase-js built-in session storage.
 */

const CDN_URL = 'https://esm.sh/@supabase/supabase-js@2';
const STORAGE_KEY = 'gm.sb';

let client = null;
let config = null; // { url, anonKey }

export function getConfig() { return config; }
export function isConfigured() { return !!(config && config.url && config.anonKey); }

export async function init({ url, anonKey }) {
  if (!url || !anonKey) throw new Error('Supabase URL and anon key are both required.');
  if (!/^https:\/\/.+/.test(url)) throw new Error('Supabase URL must be a valid HTTPS URL.');
  try {
    const mod = await import(/* @vite-ignore */ CDN_URL);
    client = mod.createClient(url, anonKey, {
      auth: { storageKey: STORAGE_KEY, persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 5 } },
    });
    config = { url, anonKey };
    return client;
  } catch (err) {
    throw new Error(`Could not load the Supabase client library (network issue?). ${err.message}`);
  }
}

export function getClient() {
  if (!client) throw new Error('Supabase client is not initialized. Configure the live backend first.');
  return client;
}

export async function getSession() {
  if (!client) return null;
  try {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data?.session ?? null;
  } catch { return null; }
}

export async function getAccessToken() {
  const session = await getSession();
  if (!session) return null;
  // Refresh if close to expiry (60s margin)
  const expiresAt = session.expires_at ? session.expires_at * 1000 : 0;
  if (expiresAt && expiresAt - Date.now() < 60_000) {
    try {
      const { data } = await client.auth.refreshSession();
      return data?.session?.access_token ?? session.access_token;
    } catch { return session.access_token; }
  }
  return session.access_token;
}

export async function signIn(email, password) {
  const c = getClient();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data;
}

export async function signOut() {
  if (!client) return;
  try { await client.auth.signOut(); } catch { /* ignore */ }
}

/* Realtime helper: subscribe to a table and get an unsubscriber back. */
export function subscribeTable(table, event, callback, filter) {
  const c = getClient();
  const channel = c.channel(`gm-${table}-${event}-${Math.random().toString(36).slice(2, 8)}`);
  channel.on('postgres_changes', { event, schema: 'public', table, ...(filter ? { filter } : {}) }, callback);
  channel.subscribe();
  return () => { try { c.removeChannel(channel); } catch { /* ignore */ } };
}
