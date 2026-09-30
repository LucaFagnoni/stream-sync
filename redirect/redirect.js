// Vecchio indirizzo (origin condiviso con lucafagnoni.github.io): prima di reindirizzare
// cancella i dati StreamSync salvati qui (token di sessione, backup con URL degli addon).
try {
  for (const store of [localStorage, sessionStorage]) {
    for (const key of Object.keys(store)) if (key.startsWith('streamsync.')) store.removeItem(key);
  }
} catch { /* storage non disponibile */ }
location.replace('https://addonmanager.pages.dev/');
