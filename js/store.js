// Persistenza locale. Le password NON vengono mai salvate: solo i token di sessione,
// e solo per gli account con "Ricordami".

const KEY = 'streamsync.v1';
const BACKUPS = 'streamsync.backups.v1';
const MAX_BACKUPS = 25;

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

export function loadStore() {
  const base = { accounts: [], settings: { theme: 'auto', collapsed: {} } };
  const data = safe(() => JSON.parse(localStorage.getItem(KEY) || 'null'), null);
  if (!data || typeof data !== 'object') return base;
  return {
    accounts: Array.isArray(data.accounts) ? data.accounts.filter((a) => a && a.id && (a.kind === 'stremio' || a.kind === 'nuvio')) : [],
    settings: { ...base.settings, ...(data.settings || {}), collapsed: { ...(data.settings?.collapsed || {}) } },
  };
}

export function saveStore(data) {
  safe(() => localStorage.setItem(KEY, JSON.stringify(data)));
}

export function clearStore() {
  safe(() => { localStorage.removeItem(KEY); localStorage.removeItem(BACKUPS); });
}

export function listBackups() {
  return safe(() => JSON.parse(localStorage.getItem(BACKUPS) || '[]'), []);
}

/** Salva lo stato REMOTO prima di sovrascriverlo. Se la quota è piena, scarta i più vecchi. */
export function pushBackup(entry) {
  let list = [entry, ...listBackups()].slice(0, MAX_BACKUPS);
  for (;;) {
    try { localStorage.setItem(BACKUPS, JSON.stringify(list)); return true; } catch {
      if (list.length <= 1) return false;
      list = list.slice(0, Math.ceil(list.length / 2));
    }
  }
}
