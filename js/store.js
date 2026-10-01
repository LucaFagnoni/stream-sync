// Persistenza locale. Le password NON vengono mai salvate.
// Le chiavi si chiamano ancora "streamsync.*" (nome originale del progetto): rinominarle farebbe perdere
// a chi è già collegato le sessioni salvate, senza alcun vantaggio visibile.
// - "Ricordami" attivo: il token di sessione va in localStorage (sopravvive alla chiusura del browser).
// - "Ricordami" spento: l'account (email, token) e i suoi backup vanno in sessionStorage (solo finché la scheda è aperta).
// Entrambi sono leggibili da ogni pagina dello stesso origin: per questo l'app sta su un dominio
// tutto suo (addonmanager.pages.dev) e non su <utente>.github.io. Vedi README, sezione Sicurezza.

const KEY = 'streamsync.v1';
const SESSIONS = 'streamsync.sessions.v1';
const BACKUPS = 'streamsync.backups.v1';
const TEMP_BACKUPS = 'streamsync.backups.session.v1';
const MAX_BACKUPS = 25;
const MAX_REMOVED = 100;

export const STORE_KEY = KEY;

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const readJSON = (storage, key, fallback) => safe(() => JSON.parse(globalThis[storage].getItem(key) || 'null') ?? fallback, fallback);
const list = (v) => (Array.isArray(v) ? v : []);
const validAccount = (a) => a && typeof a === 'object' && a.id && (a.kind === 'stremio' || a.kind === 'nuvio');
const entry = (a) => ({ id: a.id, kind: a.kind, label: a.label, email: a.email, remember: !!a.remember, session: a.session ?? null });

/**
 * - Account con "Ricordami": in localStorage (token compreso).
 * - Account senza "Ricordami": INTERAMENTE in sessionStorage (email, nome e token): chiusa la scheda non resta nulla.
 * - `removed`: id degli account rimossi, così un'altra scheda aperta non li riscrive.
 */
export function loadStore() {
  const base = { accounts: [], settings: { theme: 'auto', collapsed: {} } };
  const data = readJSON('localStorage', KEY, null);
  const temp = readJSON('sessionStorage', SESSIONS, {});
  const removed = new Set(list(data?.removed));
  const local = list(data?.accounts).filter(validAccount);
  // Formato precedente di sessionStorage: { [id]: sessione } con l'account (senza token) in localStorage.
  const tempAccounts = Array.isArray(temp?.accounts)
    ? temp.accounts.filter(validAccount).map((a) => ({ ...a, remember: false }))
    : local.filter((a) => !a.remember && temp?.[a.id]).map((a) => ({ ...a, session: temp[a.id] }));
  const remembered = local.filter((a) => a.remember);
  const ids = new Set(remembered.map((a) => a.id));
  let accounts = [...remembered, ...tempAccounts.filter((a) => !ids.has(a.id))].filter((a) => !removed.has(a.id));
  const order = list(temp?.order);
  if (order.length) {
    const pos = (a) => { const i = order.indexOf(a.id); return i < 0 ? Infinity : i; };
    accounts = accounts.map((a, i) => [a, i]).sort(([a, i], [b, j]) => pos(a) - pos(b) || i - j).map(([a]) => a);
  }
  if (!data || typeof data !== 'object') return { ...base, accounts: accounts.map((a) => ({ ...a, session: a.session ?? null })) };
  return {
    accounts: accounts.map((a) => ({ ...a, session: a.session ?? null })),
    settings: { ...base.settings, ...(data.settings || {}), collapsed: { ...(data.settings?.collapsed || {}) } },
  };
}

/** Id degli account rimossi (in qualunque scheda). */
export const readRemoved = () => list(readJSON('localStorage', KEY, null)?.removed);

/** Sessione attualmente salvata per un account (per adottare token ruotati da un'altra scheda). */
export function readSession(id) {
  return loadStore().accounts.find((a) => a.id === id)?.session ?? null;
}

export function saveStore({ accounts, settings, removed = [] }) {
  const local = accounts.filter((a) => a.remember).map(entry);
  const temp = { accounts: accounts.filter((a) => !a.remember).map(entry), order: accounts.map((a) => a.id) };
  safe(() => localStorage.setItem(KEY, JSON.stringify({ accounts: local, settings, removed: [...new Set(removed)].slice(-MAX_REMOVED) })));
  safe(() => sessionStorage.setItem(SESSIONS, JSON.stringify(temp)));
}

// I backup automatici contengono gli URL degli addon (spesso con chiavi personali): per gli account
// senza "Ricordami" restano solo in sessionStorage, come il token.
export function listBackups() {
  return [...list(readJSON('localStorage', BACKUPS, [])), ...list(readJSON('sessionStorage', TEMP_BACKUPS, []))]
    .filter((b) => b && typeof b === 'object' && Array.isArray(b.items))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

/** Salva lo stato REMOTO prima di sovrascriverlo. Se la quota è piena, scarta i più vecchi. */
export function pushBackup(item, { persistent = true } = {}) {
  const [storage, key] = persistent ? ['localStorage', BACKUPS] : ['sessionStorage', TEMP_BACKUPS];
  return writeBackups(storage, key, [item, ...list(readJSON(storage, key, []))].slice(0, MAX_BACKUPS));
}

function writeBackups(storage, key, items) {
  for (;;) {
    try { globalThis[storage].setItem(key, JSON.stringify(items)); return true; } catch {
      if (items.length <= 1) return false;
      items = items.slice(0, Math.ceil(items.length / 2));
    }
  }
}

/** I backup contengono URL con possibili chiavi personali: spariscono insieme all'account. */
export function deleteBackupsFor(accountId) {
  for (const [storage, key] of [['localStorage', BACKUPS], ['sessionStorage', TEMP_BACKUPS]]) {
    const items = list(readJSON(storage, key, []));
    const kept = items.filter((b) => b?.accountId !== accountId);
    if (kept.length !== items.length) safe(() => writeBackups(storage, key, kept));
  }
}

export function clearAll() {
  safe(() => {
    localStorage.removeItem(KEY); localStorage.removeItem(BACKUPS);
    sessionStorage.removeItem(SESSIONS); sessionStorage.removeItem(TEMP_BACKUPS);
  });
}
