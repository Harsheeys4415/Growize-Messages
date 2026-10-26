/* GrowizeMessages — administrator sign-in / demo entry.
 *
 * Live mode requires authenticated dashboard access via Supabase Auth.
 * Demo mode never requires credentials and never stores any.
 */

import { esc, icon, refreshIcons, toast } from './ui.js';
import { patch, state } from '../services/store.js';

let active = null;

export function showAuth({ allowDemo = true, notice = null, error = null } = {}) {
  hideAuth();
  const wrap = document.createElement('div');
  wrap.className = 'auth-wrap';
  wrap.id = 'auth-wrap';
  wrap.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">
        <div class="brand-logo" aria-hidden="true">G</div>
        <h1>Growize<span style="color:var(--primary)">Messages</span></h1>
        <div class="tagline">Every message, handled.</div>
      </div>
      <div class="card">
        ${notice ? `<div class="note" style="margin-bottom:14px">${icon('info')}<span>${esc(notice)}</span></div>` : ''}
        <div style="margin-bottom:18px">
          <div style="font-weight:650;margin-bottom:2px">Administrator sign in</div>
          <div class="helper-text">Sign in to manage your live Instagram automation. Credentials are verified by Supabase Auth — they are never stored in this app.</div>
        </div>
        <form data-login-form novalidate>
          <div class="field">
            <label for="auth-email">Email</label>
            <input id="auth-email" name="email" type="email" class="input" autocomplete="username" required autofocus placeholder="admin@example.com" />
          </div>
          <div class="field">
            <label for="auth-password">Password</label>
            <input id="auth-password" name="password" type="password" class="input" autocomplete="current-password" required placeholder="••••••••" />
          </div>
          <div data-auth-error aria-live="polite"></div>
          <button type="submit" class="btn btn-primary btn-lg" style="width:100%" data-submit>
            ${icon('log-in')} Sign in
          </button>
        </form>
        ${allowDemo ? `
          <div class="divider"></div>
          <button type="button" class="btn btn-ghost" style="width:100%" data-demo-entry>
            ${icon('flask-conical')} Explore the demo instead
          </button>
          <div class="helper-text" style="text-align:center;margin-top:8px">Demo mode uses sample data only — nothing is sent to any real account.</div>` : ''}
      </div>
      <p class="auth-alt">GrowizeMessages manages your automation — it is not the automation engine itself. The backend keeps running while this app is closed.</p>
    </div>`;

  document.body.appendChild(wrap);
  active = wrap;
  refreshIcons(wrap);

  const showError = (msg) => {
    const box = wrap.querySelector('[data-auth-error]');
    box.innerHTML = `<div class="note danger auth-error">${icon('circle-alert')}<span>${esc(msg)}</span></div>`;
    refreshIcons(box);
  };
  if (error) showError(error);

  const form = wrap.querySelector('[data-login-form]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) { showError('Enter both email and password.'); return; }
    if (state.mode !== 'live') { showError('Connect a live backend first (Settings → Backend connection) before signing in.'); return; }
    const btn = form.querySelector('[data-submit]');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Signing in…`;
    try {
      const { signIn } = await import('../services/supabase.js');
      const data = await signIn(email, password);
      const user = data?.user;
      patch({ user: user ? { id: user.id, email: user.email, name: user.user_metadata?.name || user.email } : null });
      hideAuth();
      toast('Signed in', 'success');
      window.dispatchEvent(new CustomEvent('gm:auth-changed'));
    } catch (err) {
      showError(err.message || 'Sign-in failed.');
      btn.disabled = false;
      btn.innerHTML = `${icon('log-in')} Sign in`;
      refreshIcons(btn);
    }
  });

  const demoBtn = wrap.querySelector('[data-demo-entry]');
  if (demoBtn) {
    demoBtn.addEventListener('click', () => {
      hideAuth();
      patch({ user: null });
      window.dispatchEvent(new CustomEvent('gm:auth-changed'));
    });
  }
}

export function hideAuth() {
  document.getElementById('auth-wrap')?.remove();
  active = null;
}

export function isAuthVisible() { return !!document.getElementById('auth-wrap'); }
