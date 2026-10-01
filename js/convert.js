// Conversione di un item tra tipi di account (Stremio <-> Nuvio) per copia / specchio.

import { makeItem } from './model.js';
import { toManifestUrl, hostOf, str } from './util.js';
import { fetchManifest } from './manifest.js';
import { t } from './i18n.js';

/**
 * Crea una copia di `item` adatta all'account `kind` di destinazione.
 * Stremio richiede il manifest completo nel descrittore: se manca lo scarica; se non riesce, lancia.
 */
export async function convertItem(item, kind, { fetcher = fetchManifest } = {}) {
  const url = toManifestUrl(item.url);
  if (kind === 'nuvio') {
    // Es. "Local Files" di Stremio (127.0.0.1:11470): esiste solo dentro l'app Stremio.
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(hostOf(url))) {
      throw new Error(t('local Stremio addon, cannot be used on Nuvio'));
    }
    return makeItem({
      url,
      name: str(item.manifest?.name) || item.name,
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
