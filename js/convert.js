// Conversione di un item tra tipi di account (Stremio <-> Nuvio) per copia / specchio.

import { makeItem } from './model.js';
import { toManifestUrl } from './util.js';
import { fetchManifest } from './manifest.js';

/**
 * Crea una copia di `item` adatta all'account `kind` di destinazione.
 * Stremio richiede il manifest completo nel descrittore: se manca lo scarica; se non riesce, lancia.
 */
export async function convertItem(item, kind, { fetcher = fetchManifest } = {}) {
  const url = toManifestUrl(item.url);
  if (kind === 'nuvio') {
    return makeItem({
      url,
      name: item.manifest?.name || item.name,
      enabled: item.enabled !== false,
      manifest: item.manifest || null,
      isNew: true,
    });
  }
  let manifest = item.manifest;
  if (!manifest) {
    const r = await fetcher(url);
    if (!r.ok) throw new Error(r.error);
    manifest = r.manifest;
  }
  // I flag (official/protected) appartengono all'account d'origine: non si copiano.
  return makeItem({ url, name: manifest.name, manifest, flags: {}, isNew: true });
}
