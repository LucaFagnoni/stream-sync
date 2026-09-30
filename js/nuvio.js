// Client per la API pubblica Nuvio (Supabase-compatibile): https://nuvio.tv/docs
// L'header `apikey` è la *publishable key* pubblicata nella documentazione ufficiale.

export const NUVIO_BASE = 'https://api.nuvio.tv';
export const NUVIO_KEY = 'sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN';
export const MAX_PROFILES = 6;

export class NuvioError extends Error {
  constructor(message, status, expired = false) {
    super(message);
    this.name = 'NuvioError';
    this.status = status;
    this.expired = expired;
  }
}

function errorMessage(body, status) {
  return body?.message || body?.msg || body?.error_description || body?.error || `Errore HTTP ${status}`;
}

async function raw(path, { method = 'GET', body, token, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(NUVIO_BASE + path, {
      method,
      headers: {
        apikey: NUVIO_KEY,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new NuvioError('Impossibile contattare api.nuvio.tv', 0);
  }
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { /* corpo non JSON */ } }
  if (!res.ok) throw new NuvioError(errorMessage(json, res.status), res.status);
  return json;
}

const toSession = (r) => ({
  access_token: r.access_token,
  refresh_token: r.refresh_token,
  // 30 s di margine per non inviare token sul punto di scadere
  expires_at: Date.now() + Math.max(0, (r.expires_in ?? 3600) - 30) * 1000,
  userId: r.user?.id ?? null,
  email: r.user?.email ?? null,
});

export async function signIn(email, password) {
  return toSession(await raw('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }));
}

/**
 * Sessione autenticata: rinnova il token quando serve.
 * Il refresh è "single-flight": richieste parallele (es. 6 profili) condividono un solo
 * rinnovo, perché il refresh_token è monouso e un secondo uso invaliderebbe la sessione.
 */
export class NuvioSession {
  constructor(session, onChange = () => {}) {
    this.session = session;
    this.onChange = onChange;
    this._refreshing = null;
  }

  async _refresh() {
    if (!this._refreshing) {
      this._refreshing = raw('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: this.session.refresh_token },
      })
        .then((r) => {
          this.session = toSession(r);
          this.onChange(this.session);
        })
        .catch((e) => {
          throw new NuvioError('Sessione scaduta: effettua di nuovo l\'accesso', e.status ?? 0, true);
        })
        .finally(() => { this._refreshing = null; });
    }
    return this._refreshing;
  }

  async request(path, opts = {}) {
    if (Date.now() >= this.session.expires_at) await this._refresh();
    try {
      return await raw(path, { ...opts, token: this.session.access_token });
    } catch (e) {
      if (e.status !== 401) throw e;
      await this._refresh();
      return raw(path, { ...opts, token: this.session.access_token });
    }
  }

  rpc(name, body = {}) {
    return this.request(`/rest/v1/rpc/${name}`, { method: 'POST', body });
  }

  async logout() {
    // scope=local: senza, Supabase chiude TUTTE le sessioni dell'utente (app TV/mobile comprese).
    try { await raw('/auth/v1/logout?scope=local', { method: 'POST', token: this.session.access_token }); } catch { /* best effort */ }
  }

  /** @returns {Promise<{index:number,name:string,color:string|null,usesPrimary:boolean}[]>} */
  async listProfiles() {
    const rows = await this.rpc('sync_pull_profiles');
    const list = (Array.isArray(rows) ? rows : [])
      .map((p) => ({
        index: Number(p.profile_index),
        name: String(p.name || '').trim() || `Profilo ${p.profile_index}`,
        color: p.avatar_color_hex || null,
        usesPrimary: Number(p.profile_index) !== 1 && !!p.uses_primary_addons,
      }))
      .filter((p) => Number.isInteger(p.index) && p.index >= 1 && p.index <= MAX_PROFILES)
      .sort((a, b) => a.index - b.index);
    // Un account nuovo può non avere ancora righe: il profilo 1 esiste sempre.
    return list.some((p) => p.index === 1)
      ? list
      : [{ index: 1, name: 'Profilo 1', color: null, usesPrimary: false }, ...list];
  }

  async listAddons(profile) {
    const rows = await this.request(
      `/rest/v1/addons?select=*&profile_id=eq.${encodeURIComponent(profile)}&order=sort_order.asc,created_at.asc`,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      url: r.url,
      name: r.name || r.url,
      enabled: r.enabled !== false,
      manifest: null,
      flags: {},
    }));
  }

  /** Sostituzione completa: ciò che manca dall'array viene CANCELLATO lato server. */
  async pushAddons(profile, items) {
    await this.rpc('sync_push_addons', {
      p_profile_id: profile,
      p_addons: items.map((a, i) => ({
        url: a.url,
        // Se il nome è solo il fallback (= URL) si rimanda null, come lo aveva il server.
        name: a.name && a.name !== a.url ? a.name : null,
        enabled: a.enabled !== false,
        sort_order: i,
      })),
    });
  }
}
