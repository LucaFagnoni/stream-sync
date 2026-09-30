import { idOf } from './util.js';

const TTL = 5 * 60 * 1000;
const cache = new Map();

export function validateManifest(m) {
  return !!m && typeof m === 'object' && typeof m.id === 'string' && typeof m.name === 'string' &&
    (Array.isArray(m.resources) || Array.isArray(m.catalogs));
}

/**
 * Scarica e valida un manifest dal browser.
 * Dal browser non si può distinguere "offline" da "CORS negato": entrambi sono `network`.
 * @returns {{ok:true, manifest:object, ms:number} | {ok:false, kind:string, error:string}}
 */
export async function fetchManifest(url, { timeout = 8000, force = false } = {}) {
  const key = idOf(url);
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.t < TTL) return hit.result;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const started = Date.now();
  let result;
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' }, credentials: 'omit' });
    if (!res.ok) {
      result = { ok: false, kind: 'http', error: `HTTP ${res.status}` };
    } else {
      let json;
      try { json = await res.json(); } catch { json = null; }
      result = validateManifest(json)
        ? { ok: true, manifest: json, ms: Date.now() - started }
        : { ok: false, kind: 'invalid', error: 'Manifest non valido' };
    }
  } catch (e) {
    const isHttp = /^http:\/\//i.test(url) && typeof location !== 'undefined' && location.protocol === 'https:';
    result = e?.name === 'AbortError'
      ? { ok: false, kind: 'timeout', error: 'Timeout' }
      : {
          ok: false,
          kind: 'network',
          error: isHttp
            ? 'URL http:// bloccato dal browser su una pagina https'
            : 'Non raggiungibile (server offline o CORS non consentito)',
        };
  } finally {
    clearTimeout(timer);
  }
  if (result.ok) cache.set(key, { t: Date.now(), result });
  return result;
}

export const clearManifestCache = () => cache.clear();
