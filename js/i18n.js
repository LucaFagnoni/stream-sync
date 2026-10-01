// Lingue dell'interfaccia: inglese (US, predefinita) e italiano.
// I testi nel codice sono scritti in inglese e fanno da chiave; js/locales/it.js contiene le traduzioni.
// Una chiave senza traduzione si mostra in inglese. Segnaposto: {nome}.
// La scelta dell'utente è salvata in localStorage («addonmanager.lang») e sopravvive a «Esci da tutto»:
// non è un dato personale.

import it from './locales/it.js';

export const LANGUAGES = { en: { tag: 'en-US', name: 'English' }, it: { tag: 'it-IT', name: 'Italiano' } };
export const DEFAULT_LANG = 'en';
export const LANG_KEY = 'addonmanager.lang';
const DICTIONARIES = { en: null, it };

const read = () => { try { return localStorage.getItem(LANG_KEY); } catch { return null; } };
const valid = (l) => (typeof l === 'string' && Object.hasOwn(LANGUAGES, l) ? l : null);

let lang = valid(read()) || DEFAULT_LANG;
const listeners = new Set();

export const getLang = () => lang;
/** Tag BCP 47 per date e numeri (es. «en-US»). */
export const locale = () => LANGUAGES[lang].tag;
export const onLangChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** Traduce `key` (il testo inglese) e sostituisce i segnaposto {nome} con `params`. */
export function t(key, params) {
  const text = DICTIONARIES[lang]?.[key] ?? key;
  return params ? text.replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(params, name) ? String(params[name]) : m)) : text;
}

/** Cambia lingua. `persist: false` serve ai test. */
export function setLang(next, { persist = true } = {}) {
  const l = valid(next);
  if (!l) return false;
  const changed = l !== lang;
  lang = l;
  if (persist) { try { localStorage.setItem(LANG_KEY, l); } catch { /* storage non disponibile */ } }
  if (typeof document !== 'undefined') applyStatic();
  if (changed) for (const fn of listeners) fn(l);
  return true;
}

/**
 * Testi della pagina statica (index.html): `data-i18n` = testo, `data-i18n-title` / `-aria-label` / `-placeholder`
 * = attributi; il valore dell'attributo è la chiave inglese.
 */
export function applyStatic(root = document) {
  document.documentElement.lang = lang;
  document.title = t('Addon Manager — Stremio and Nuvio');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('Addon Manager: manage, reorder, update and copy the addons of your Stremio and Nuvio accounts from a single page.'));
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const attr of ['title', 'aria-label', 'placeholder']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
  }
}
