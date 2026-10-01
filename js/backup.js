// Esportazione / importazione liste di addon. Pure, testabili.

import { extractUrls, idOf } from './util.js';

const slim = (i) => ({ url: i.url, name: i.name, enabled: i.enabled !== false });

export function buildExport(lists) {
  return {
    app: 'addon-manager', // i file esportati da versioni precedenti ('streamsync') si leggono comunque: parseImport non controlla questo campo
    version: 1,
    exportedAt: new Date().toISOString(),
    // Gli URL degli addon possono contenere chiavi personali (es. debrid): tratta il file come un segreto.
    lists: lists.map((l) => ({ title: l.title, account: l.account, kind: l.kind, addons: l.items.map(slim) })),
  };
}

/**
 * Legge un file di backup (nostro formato) o un testo qualunque contenente URL.
 * @returns {{title:string, items:{url:string,name?:string,enabled:boolean}[]}[]}
 */
export function parseImport(text) {
  let json = null;
  try { json = JSON.parse(text); } catch { /* non è JSON: testo libero */ }

  if (json && Array.isArray(json.lists)) {
    return json.lists
      .map((l) => ({
        title: [l.account, l.title].filter(Boolean).join(' · ') || 'Lista',
        items: (Array.isArray(l.addons) ? l.addons : [])
          .filter((a) => a && typeof a.url === 'string')
          .map((a) => ({ url: a.url, name: a.name, enabled: a.enabled !== false })),
      }))
      .filter((l) => l.items.length);
  }
  const urls = extractUrls(text);
  return urls.length ? [{ title: 'URL trovati nel file', items: urls.map((url) => ({ url, enabled: true })) }] : [];
}

export function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => { const id = idOf(i.url); if (seen.has(id)) return false; seen.add(id); return true; });
}
