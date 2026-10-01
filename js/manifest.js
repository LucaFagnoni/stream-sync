import { idOf, timeoutSignal, isTimeout } from './util.js';
import { t } from './i18n.js';

const TTL = 5 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024; // un manifest reale pesa pochi KB: oltre è un errore o un abuso
const cache = new Map();

export function validateManifest(m) {
  return !!m && typeof m === 'object' && !Array.isArray(m) && typeof m.id === 'string' && typeof m.name === 'string' &&
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

  const started = Date.now();
  let result;
  try {
    const res = await fetch(url, { signal: timeoutSignal(timeout), headers: { Accept: 'application/json' }, credentials: 'omit' });
    if (!res.ok) {
      result = { ok: false, kind: 'http', error: `HTTP ${res.status}` };
    } else if (Number(res.headers?.get?.('content-length')) > MAX_BYTES) {
      result = { ok: false, kind: 'invalid', error: t('Manifest too large') };
    } else {
      const text = await res.text();
      let json = null;
      if (text.length <= MAX_BYTES) { try { json = JSON.parse(text); } catch { /* non JSON */ } }
      result = text.length > MAX_BYTES
        ? { ok: false, kind: 'invalid', error: t('Manifest too large') }
        : validateManifest(json)
          ? { ok: true, manifest: json, ms: Date.now() - started }
          : { ok: false, kind: 'invalid', error: t('Invalid manifest') };
    }
  } catch (e) {
    const isHttp = /^http:\/\//i.test(url) && typeof location !== 'undefined' && location.protocol === 'https:';
    result = isTimeout(e)
      ? { ok: false, kind: 'timeout', error: t('Timeout') }
      : {
          ok: false,
          kind: 'network',
          error: isHttp
            ? t('http:// URL blocked by the browser on an https page')
            : t('Unreachable (server offline or CORS not allowed)'),
        };
  }
  if (result.ok) cache.set(key, { t: Date.now(), result });
  return result;
}

export const clearManifestCache = () => cache.clear();
