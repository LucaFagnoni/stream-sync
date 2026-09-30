// Client minimale per l'API Stremio (https://github.com/Stremio/stremio-api-client).
// Ogni metodo è un POST JSON su /api/<metodo>; gli errori arrivano come { error: { code, message } }.

import { str, timeoutSignal, isTimeout } from './util.js';

export const STREMIO_API = 'https://api.strem.io/api/';
const TIMEOUT = 20000;

export class StremioError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StremioError';
    this.code = code;
    // code 1 = "Session does not exist": authKey scaduta o revocata.
    this.expired = code === 1;
  }
}

async function call(method, body) {
  let res;
  try {
    res = await fetch(STREMIO_API + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal(TIMEOUT),
    });
  } catch (e) {
    throw new StremioError(isTimeout(e) ? 'api.strem.io non ha risposto in tempo' : 'Impossibile contattare api.strem.io', 0);
  }
  let json;
  try { json = await res.json(); } catch { throw new StremioError(`Risposta non valida (HTTP ${res.status})`, 0); }
  if (json?.error) throw new StremioError(str(json.error.message) || 'Errore Stremio', json.error.code);
  if (!res.ok || json?.result === undefined) throw new StremioError(`Errore HTTP ${res.status}`, 0);
  return json.result;
}

export async function login(email, password) {
  const r = await call('login', { type: 'Auth', email, password });
  if (typeof r?.authKey !== 'string' || !r.authKey) throw new StremioError('Risposta di login non valida', 0);
  return { authKey: r.authKey, userId: r.user?._id ?? null, email: r.user?.email ?? email };
}

export async function logout(authKey) {
  try { await call('logout', { type: 'Logout', authKey }); } catch { /* best effort */ }
}

/** @returns {Promise<{addons: object[], lastModified: string|null}>} */
export async function getAddons(authKey) {
  const r = await call('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: false });
  const addons = Array.isArray(r?.addons) ? r.addons.filter((d) => d && typeof d === 'object') : [];
  return { addons, lastModified: r?.lastModified ?? null };
}

/** Sostituisce l'intera collezione: l'ordine dell'array è l'ordine mostrato in Stremio. */
export async function setAddons(authKey, descriptors) {
  const r = await call('addonCollectionSet', { type: 'AddonCollectionSet', authKey, addons: descriptors });
  if (r?.success === false) throw new StremioError('Il salvataggio è stato rifiutato da Stremio', 0);
}

/** Descrittore API -> item di lista. Il descrittore originale (`raw`) viene conservato intatto. */
export function fromDescriptor(d) {
  const manifest = d.manifest && typeof d.manifest === 'object' ? d.manifest : null;
  const flags = d.flags && typeof d.flags === 'object' ? d.flags : {};
  return { url: d.transportUrl, name: str(manifest?.name) || str(d.transportUrl), enabled: true, manifest, flags, raw: d };
}

/**
 * Item di lista -> descrittore API.
 * Per gli addon già presenti si parte dal descrittore originale, così campi che non conosciamo
 * non vengono persi; `template` (transportName) si applica solo agli addon nuovi.
 */
export function toDescriptor(item, template) {
  if (!item.manifest && !item.raw) throw new Error(`Manifest mancante per ${item.url}`);
  const d = item.raw ? { ...item.raw } : {};
  if (!item.raw && template !== undefined) d.transportName = template;
  d.transportUrl = item.url;
  if (item.manifest) d.manifest = item.manifest;
  d.flags = item.flags || {};
  return d;
}
