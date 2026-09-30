// Client minimale per l'API Stremio (https://github.com/Stremio/stremio-api-client).
// Ogni metodo è un POST JSON su /api/<metodo>; gli errori arrivano come { error: { code, message } }.

export const STREMIO_API = 'https://api.strem.io/api/';

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
    });
  } catch {
    throw new StremioError('Impossibile contattare api.strem.io', 0);
  }
  let json;
  try { json = await res.json(); } catch { throw new StremioError(`Risposta non valida (HTTP ${res.status})`, 0); }
  if (json?.error) throw new StremioError(json.error.message || 'Errore Stremio', json.error.code);
  if (!res.ok || json?.result === undefined) throw new StremioError(`Errore HTTP ${res.status}`, 0);
  return json.result;
}

export async function login(email, password) {
  const r = await call('login', { type: 'Auth', email, password });
  return { authKey: r.authKey, userId: r.user?._id ?? null, email: r.user?.email ?? email };
}

export async function logout(authKey) {
  try { await call('logout', { type: 'Logout', authKey }); } catch { /* best effort */ }
}

/** @returns {Promise<{addons: object[], lastModified: string|null}>} */
export async function getAddons(authKey) {
  const r = await call('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: false });
  return { addons: Array.isArray(r.addons) ? r.addons : [], lastModified: r.lastModified ?? null };
}

/** Sostituisce l'intera collezione: l'ordine dell'array è l'ordine mostrato in Stremio. */
export async function setAddons(authKey, descriptors) {
  const r = await call('addonCollectionSet', { type: 'AddonCollectionSet', authKey, addons: descriptors });
  if (r?.success === false) throw new StremioError('Il salvataggio è stato rifiutato da Stremio', 0);
}

/** Descrittore API -> item di lista. */
export function fromDescriptor(d) {
  return {
    url: d.transportUrl,
    name: d.manifest?.name || d.transportUrl,
    enabled: true,
    manifest: d.manifest || null,
    flags: d.flags || {},
  };
}

/** Item di lista -> descrittore API. `template` = transportName usato dagli addon già presenti. */
export function toDescriptor(item, template) {
  if (!item.manifest) throw new Error(`Manifest mancante per ${item.url}`);
  const d = { transportUrl: item.url, manifest: item.manifest, flags: item.flags || {} };
  if (template !== undefined) d.transportName = template;
  return d;
}
