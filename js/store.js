// Persistenza locale. Le password NON vengono mai salvate.
// - "Ricordami" attivo: il token di sessione va in localStorage (sopravvive alla chiusura del browser).
// - "Ricordami" spento: il token va in sessionStorage (resta solo finché la scheda è aperta).
// Attenzione: entrambi sono condivisi con OGNI pagina dello stesso origin (su GitHub Pages:
// tutto <utente>.github.io). Vedi README, sezione Sicurezza.

const KEY = 'streamsync.v1';
const SESSIONS = 'streamsync.sessions.v1';
const BACKUPS = 'streamsync.backups.v1';
const MAX_BACKUPS = 25;

export const STORE_KEY = KEY;

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const readJSON = (storage, key, fallback) => safe(() => JSON.parse(globalThis[storage].getItem(key) || 'null') ?? fallback, fallback);

export function loadStore() {
  const base = { accounts: [], settings: { theme: 'auto', collapsed: {} } };
  const data = readJSON('localStorage', KEY, null);
  if (!data || typeof data !== 'object') return base;
  const temp = readJSON('sessionStorage', SESSIONS, {});
  return {
    accounts: (Array.isArray(data.accounts) ? data.accounts : [])
      .filter((a) => a && a.id && (a.kind === 'stremio' || a.kind === 'nuvio'))
      .map((a) => ({ ...a, session: (a.remember ? a.session : temp[a.id]) ?? null })),
    settings: { ...base.settings, ...(data.settings || {}), collapsed: { ...(data.settings?.collapsed || {}) } },
  };
}

/** Sessione attualmente salvata per un account (per adottare token ruotati da un'altra scheda). */
export function readSession(id) {
  return loadStore().accounts.find((a) => a.id === id)?.session ?? null;
}

export function saveStore({ accounts, settings }) {
  const local = accounts.map((a) => ({
    id: a.id, kind: a.kind, label: a.label, email: a.email, remember: !!a.remember,
    session: a.remember ? a.session ?? null : null,
  }));
  const temp = Object.fromEntries(accounts.filter((a) => !a.remember && a.session).map((a) => [a.id, a.session]));
  safe(() => localStorage.setItem(KEY, JSON.stringify({ accounts: local, settings })));
  safe(() => sessionStorage.setItem(SESSIONS, JSON.stringify(temp)));
}

export function listBackups() {
  const list = readJSON('localStorage', BACKUPS, []);
  return Array.isArray(list) ? list : [];
}

/** Salva lo stato REMOTO prima di sovrascriverlo. Se la quota è piena, scarta i più vecchi. */
export function pushBackup(entry) {
  return writeBackups([entry, ...listBackups()].slice(0, MAX_BACKUPS));
}

function writeBackups(list) {
  for (;;) {
    try { localStorage.setItem(BACKUPS, JSON.stringify(list)); return true; } catch {
      if (list.length <= 1) return false;
      list = list.slice(0, Math.ceil(list.length / 2));
    }
  }
}

/** I backup contengono URL con possibili chiavi personali: spariscono insieme all'account. */
export function deleteBackupsFor(accountId) {
  writeBackups(listBackups().filter((b) => b.accountId !== accountId));
}

export function clearAll() {
  safe(() => { localStorage.removeItem(KEY); localStorage.removeItem(BACKUPS); sessionStorage.removeItem(SESSIONS); });
}
