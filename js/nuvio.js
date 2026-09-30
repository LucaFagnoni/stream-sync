// Client per la API pubblica Nuvio (Supabase-compatibile): https://nuvio.tv/docs
// L'header `apikey` è la *publishable key* pubblicata nella documentazione ufficiale.

import { timeoutSignal, isTimeout } from './util.js';

export const NUVIO_BASE = 'https://api.nuvio.tv';
export const NUVIO_KEY = 'sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN';
export const MAX_PROFILES = 6;
const TIMEOUT = 20000;

export class NuvioError extends Error {
  constructor(message, status, expired = false) {
    super(message);
    this.name = 'NuvioError';
    this.status = status;
    this.expired = expired;
  }
}

function errorMessage(body, status) {
  const m = body?.message || body?.msg || body?.error_description || body?.error;
  return typeof m === 'string' && m ? m : `Errore HTTP ${status}`;
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
      signal: timeoutSignal(TIMEOUT),
    });
  } catch (e) {
    throw new NuvioError(isTimeout(e) ? 'api.nuvio.tv non ha risposto in tempo' : 'Impossibile contattare api.nuvio.tv', 0);
  }
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { /* corpo non JSON */ } }
  if (!res.ok) throw new NuvioError(errorMessage(json, res.status), res.status);
  return json;
}

const toSession = (r, previous = null) => {
  if (typeof r?.access_token !== 'string' || typeof r?.refresh_token !== 'string') {
    throw new NuvioError('Risposta di autenticazione non valida', 0);
  }
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    // 30 s di margine per non inviare token sul punto di scadere
    expires_at: Date.now() + Math.max(0, (Number(r.expires_in) || 3600) - 30) * 1000,
    userId: r.user?.id ?? previous?.userId ?? null,
    email: r.user?.email ?? previous?.email ?? null,
  };
};

export async function signIn(email, password) {
  return toSession(await raw('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }));
}

/**
 * Sessione autenticata: rinnova il token quando serve.
 * - Il refresh è "single-flight": richieste parallele (es. 6 profili) condividono un solo rinnovo,
 *   perché il refresh_token è monouso e riusarlo può far revocare l'intera sessione.
 * - `getLatest()` restituisce la sessione salvata: se un'altra scheda ha già ruotato il token,
 *   si adotta quella invece di riusare un refresh_token ormai consumato.
 * - Solo un rifiuto esplicito del server (400/401/403) rende la sessione "scaduta":
 *   un errore di rete o un timeout non devono far perdere l'accesso.
 */
export class NuvioSession {
  constructor(session, onChange = () => {}, getLatest = () => null) {
    this.session = session;
    this.onChange = onChange;
    this.getLatest = getLatest;
    this._refreshing = null;
  }

  async _refresh() {
    if (!this._refreshing) {
      this._refreshing = (async () => {
        const latest = this.getLatest();
        if (latest?.refresh_token && latest.refresh_token !== this.session.refresh_token) {
          this.session = latest;
          if (Date.now() < latest.expires_at) return;
        }
        let r;
        try {
          r = await raw('/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            body: { refresh_token: this.session.refresh_token },
          });
        } catch (e) {
          if ([400, 401, 403].includes(e.status)) {
            throw new NuvioError('Sessione scaduta: effettua di nuovo l\'accesso', e.status, true);
          }
          throw new NuvioError(`Rinnovo della sessione non riuscito: ${e.message}`, e.status ?? 0);
        }
        this.session = toSession(r, this.session);
        this.onChange(this.session);
      })().finally(() => { this._refreshing = null; });
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
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        index: Number(p.profile_index),
        name: (typeof p.name === 'string' && p.name.trim()) || `Profilo ${p.profile_index}`,
        color: typeof p.avatar_color_hex === 'string' ? p.avatar_color_hex : null,
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
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object');
    // Se il server restituisce righe di più utenti (account collegati), un push "sostituisci tutto"
    // non avrebbe un significato certo: meglio non gestire questo profilo.
    if (new Set(list.map((r) => r.user_id).filter(Boolean)).size > 1) {
      throw new NuvioError('Questo profilo contiene addon di più utenti (account collegato?): per sicurezza non viene gestito qui.', 0);
    }
    return list.map((r) => ({
      url: String(r.url ?? ''),
      name: typeof r.name === 'string' && r.name ? r.name : String(r.url ?? ''),
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
