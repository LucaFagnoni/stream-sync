// Piccole utility pure (nessuna dipendenza dal DOM: testabili in Node).

export const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** Stringa sicura da mostrare: i manifest sono dati non fidati e i campi possono avere tipi qualsiasi. */
export const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
export const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Accetta URL http(s) o stremio:// (e host "nudi") e restituisce l'URL assoluto, oppure null se non valido.
 * Il parser serve SOLO a validare: la stringa restituita è quella dell'utente (tranne stremio:// -> https://
 * e il frammento #…). Ricostruirla con URL#toString() la altererebbe: Chromium, ad esempio, trasforma
 * `|` in `%7C`, e gli URL degli addon contengono configurazioni e chiavi personali.
 */
export function parseAddonUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  s = s.replace(/^stremio:\/\//i, 'https://');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/#.*$/s, '');
  if (/\s/.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return s;
  } catch {
    return null;
  }
}

export const isHttpUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u) && parseAddonUrl(u) !== null;

/** Divide un URL in [prima della query, query con '?'] senza ricodificarlo. */
const splitQuery = (url) => {
  const i = url.indexOf('?');
  return i < 0 ? [url, ''] : [url.slice(0, i), url.slice(i)];
};

/** Garantisce che l'URL termini con /manifest.json (come fa il client Nuvio), senza toccare il resto. */
export function toManifestUrl(input) {
  const parsed = parseAddonUrl(input);
  if (!parsed) return String(input ?? '').trim();
  const [path, query] = splitQuery(parsed);
  const trimmed = path.replace(/\/+$/, '');
  return (/\/manifest\.json$/i.test(trimmed) ? trimmed : trimmed + '/manifest.json') + query;
}

/** URL senza /manifest.json finale e senza query (per /configure). null se non è un URL http(s). */
export function baseUrl(input) {
  const parsed = parseAddonUrl(input);
  if (!parsed) return null;
  return splitQuery(toManifestUrl(parsed))[0].replace(/\/manifest\.json$/i, '');
}

/** Decodifica solo i %XX di caratteri "innocui", così `|` e `%7C` (o `,` e `%2C`) sono lo stesso addon. */
const decodeSafe = (s) => s.replace(/%([0-9a-f]{2})/gi, (m, hex) => {
  const c = String.fromCharCode(parseInt(hex, 16));
  return /[A-Za-z0-9\-._~!$&'()*+,;=:@|]/.test(c) ? c : m.toUpperCase();
});

/**
 * Identità di un addon indipendente da differenze cosmetiche
 * (schema stremio://, maiuscole nell'host, slash finali, /manifest.json, %-encoding di caratteri innocui).
 * Serve solo per confrontare: non va mai usata come URL.
 */
export function idOf(input) {
  const parsed = parseAddonUrl(input);
  if (!parsed) return String(input ?? '').trim().toLowerCase();
  const u = new URL(parsed);
  const path = u.pathname.replace(/\/+$/, '').replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
  return u.host.toLowerCase() + decodeSafe(path) + decodeSafe(u.search);
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

/** Copia di `arr` con l'elemento in posizione `from` spostato nella posizione finale `to`. */
export function moveInArray(arr, from, to) {
  const out = arr.slice();
  if (!Number.isInteger(from) || from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Segnale che scade dopo `ms` (undefined dove AbortSignal.timeout non esiste). */
export const timeoutSignal = (ms) =>
  (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined);

export const isTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

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

/**
 * Estrae tutti gli URL addon da un testo libero (una o più righe, JSON, uri-list…).
 * Virgole e pipe fanno parte degli URL (es. Torrentio: `providers=yts,eztv|qualityfilter=cam`):
 * si separa solo su spazi, virgolette e parentesi angolari, e su una virgola seguita da un altro URL.
 */
export function extractUrls(text) {
  const normalized = String(text ?? '').replace(/,(?=\s*(?:https?|stremio):\/\/)/gi, ' ');
  const found = normalized.match(/(?:https?|stremio):\/\/[^\s"'<>`]+/gi) || [];
  const seen = new Set();
  const out = [];
  for (const raw of found) {
    const url = parseAddonUrl(raw.replace(/[.,;:!?)\]}]+$/, ''));
    if (!url) continue;
    const id = idOf(url);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(url);
  }
  return out;
}
