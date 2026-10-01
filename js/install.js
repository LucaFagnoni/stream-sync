// Installazione come app (PWA) e service worker.
// Chrome/Edge (computer e Android) permettono di proporre l'installazione con un evento
// (`beforeinstallprompt`); Safari no: lì si possono solo spiegare i passi del menu.

const DISMISS_KEY = 'addonmanager.install.dismissed';

/**
 * Su che sistema siamo, per scegliere le istruzioni giuste quando il browser non offre un pulsante.
 * 'ios' = iPhone/iPad (anche iPadOS, che si presenta come Mac ma ha il touch);
 * 'mac-safari' = Safari su Mac (17+: «Aggiungi al Dock…»); 'other' = il resto.
 */
export function detectPlatform({ ua = '', platform = '', maxTouchPoints = 0 } = {}) {
  if (/iPhone|iPad|iPod/.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1)) return 'ios';
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua)) return 'mac-safari';
  return 'other';
}

let deferred = null; // l'evento beforeinstallprompt, utilizzabile una volta sola
let installed = false;
const listeners = new Set();
const emit = () => { for (const fn of listeners) fn(); };

export const onInstallChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export const isStandalone = () => installed ||
  globalThis.matchMedia?.('(display-mode: standalone)').matches === true || globalThis.navigator?.standalone === true;

export const installPlatform = () => detectPlatform({
  ua: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints,
});

/** true se il browser ha dato il via libera e basta un clic per mostrare la finestra di installazione */
export const canPromptInstall = () => !!deferred && !isStandalone();

export function bannerDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

export function dismissBanner() {
  try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* storage non disponibile */ }
  emit();
}

/** @returns {Promise<'accepted'|'dismissed'|'unavailable'>} */
export async function promptInstall() {
  const event = deferred;
  if (!event) return 'unavailable';
  deferred = null; // l'evento vale una volta sola
  emit();
  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome;
}

export function initInstall() {
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // niente mini-barra automatica: l'invito lo mostra l'app, quando serve
    deferred = e;
    emit();
  });
  addEventListener('appinstalled', () => { deferred = null; installed = true; emit(); });
  matchMedia('(display-mode: standalone)').addEventListener?.('change', emit);
}

/**
 * Registra il service worker. Con Trusted Types attivo anche register() richiede un URL "fidato":
 * la policy accetta solo 'sw.js'.
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const policy = globalThis.trustedTypes?.createPolicy?.('addon-manager-sw', {
    createScriptURL: (url) => {
      if (url !== 'sw.js') throw new TypeError('Service worker URL not allowed');
      return url;
    },
  });
  navigator.serviceWorker.register(policy ? policy.createScriptURL('sw.js') : 'sw.js').catch(() => { /* non fatale: l'app funziona anche senza */ });
}
