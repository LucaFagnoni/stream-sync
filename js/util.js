// Piccole utility pure (nessuna dipendenza dal DOM: testabili in Node).

export const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/**
 * Accetta URL http(s) o stremio:// (e host "nudi") e restituisce un URL assoluto
 * normalizzato, oppure null se non valido.
 */
export function parseAddonUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  s = s.replace(/^stremio:\/\//i, 'https://');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Garantisce che l'URL termini con /manifest.json (come fa il client Nuvio). */
export function toManifestUrl(input) {
  const parsed = parseAddonUrl(input);
  if (!parsed) return String(input ?? '').trim();
  const u = new URL(parsed);
  const path = u.pathname.replace(/\/+$/, '');
  u.pathname = /\/manifest\.json$/i.test(path) ? path : path + '/manifest.json';
  return u.toString();
}

/** URL senza /manifest.json finale (utile per /configure). */
export function baseUrl(input) {
  const u = new URL(toManifestUrl(input));
  u.pathname = u.pathname.replace(/\/manifest\.json$/i, '');
  u.search = '';
  return u.toString().replace(/\/$/, '');
}

/**
 * Identità di un addon indipendente da differenze cosmetiche
 * (schema stremio://, maiuscole nell'host, slash finali, /manifest.json).
 */
export function idOf(input) {
  const parsed = parseAddonUrl(input);
  if (!parsed) return String(input ?? '').trim().toLowerCase();
  const u = new URL(parsed);
  const path = u.pathname.replace(/\/+$/, '').replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
  return u.host.toLowerCase() + path + u.search;
}

export function hostOf(input) {
  try {
    return new URL(parseAddonUrl(input)).host;
  } catch {
    return '';
  }
}

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** FNV-1a 32 bit: sufficiente per rilevare differenze tra manifest. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Limita la concorrenza di funzioni asincrone. */
export function pLimit(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** Estrae tutti gli URL addon da un testo libero (una o più righe, JSON, ecc.). */
export function extractUrls(text) {
  const found = String(text ?? '').match(/(?:https?|stremio):\/\/[^\s"'<>,\]\[]+/gi) || [];
  const seen = new Set();
  const out = [];
  for (const raw of found) {
    const url = parseAddonUrl(raw);
    if (!url) continue;
    const id = idOf(url);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(url);
  }
  return out;
}
