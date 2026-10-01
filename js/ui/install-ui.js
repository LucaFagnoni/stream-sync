import { h, icon, dialog, dialogHeader, fill } from './dom.js';
import {
  onInstallChange, isStandalone, installPlatform, canPromptInstall, promptInstall, bannerDismissed, dismissBanner,
} from '../install.js';

const STEPS = {
  ios: [
    'Tocca il pulsante Condividi (il quadrato con la freccia verso l\'alto) nella barra del browser.',
    'Scorri l\'elenco e scegli «Aggiungi alla schermata Home».',
    'Conferma con «Aggiungi»: l\'icona di Addon Manager comparirà nella schermata Home.',
  ],
  'mac-safari': [
    'Nel menu File di Safari scegli «Aggiungi al Dock…» (Safari 17 e macOS Sonoma o successivi).',
    'Conferma: Addon Manager si aprirà in una finestra tutta sua, con l\'icona nel Dock.',
  ],
  other: [
    'Cerca l\'icona di installazione nella barra degli indirizzi (Chrome, Edge) oppure «Installa app» / «Aggiungi alla schermata Home» nel menu del browser.',
    'Il browser propone l\'installazione solo dopo qualche istante di utilizzo. Non tutti i browser permettono di installare le app web.',
  ],
};

/** Finestra con i passi da fare a mano (Safari non ha un pulsante che apra l'installazione). */
export function openInstallHelp() {
  const platform = installPlatform();
  return dialog((close) => h('div', { class: 'dialog-body' },
    dialogHeader('Installa Addon Manager', close),
    h('div', { class: 'dialog-content' },
      h('p', { class: 'field-hint' }, 'Si apre in una finestra tutta sua, con la propria icona, senza barra del browser.'),
      h('ol', { class: 'steps' }, ...STEPS[platform].map((t) => h('li', null, t)))),
    h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn primary', onClick: () => close() }, 'Ho capito'))), { label: 'Installazione' });
}

/** Il pulsante giusto per il browser in uso: apre l'installazione vera, oppure le istruzioni. */
function installButton(primary = true) {
  if (canPromptInstall()) {
    return h('button', { type: 'button', class: `btn${primary ? ' primary' : ''}`, onClick: () => promptInstall() }, icon('download', 15), ' Installa');
  }
  return h('button', { type: 'button', class: `btn${primary ? ' primary' : ''}`, onClick: openInstallHelp }, 'Come si installa');
}

/**
 * Invito in cima alla pagina. Compare solo se l'installazione è possibile (il browser l'ha consentita, oppure
 * si è su Safari, dove si può solo spiegare), l'app non è già installata e l'invito non è stato chiuso.
 */
export function mountInstallBanner(host) {
  const render = () => {
    const show = !isStandalone() && !bannerDismissed() && (canPromptInstall() || installPlatform() !== 'other');
    host.hidden = !show;
    if (!show) { host.replaceChildren(); return; }
    fill(host, h('div', { class: 'install-inner' },
      h('img', { class: 'install-logo', src: 'img/logo.svg', alt: '', width: 32, height: 32 }),
      h('div', { class: 'install-text' },
        h('strong', null, 'Installa Addon Manager'),
        h('span', null, 'Si apre come un\'app, in una finestra tutta sua, con la sua icona.')),
      h('div', { class: 'install-actions' },
        installButton(true),
        h('button', { type: 'button', class: 'btn', onClick: dismissBanner }, 'Non ora'))));
  };
  onInstallChange(render);
  render();
}

/** Sezione sempre disponibile nella finestra Backup, anche dopo aver chiuso l'invito. */
export function installSection() {
  if (isStandalone()) return h('p', { class: 'field-hint' }, 'Stai usando Addon Manager come app installata.');
  return h('div', null,
    h('p', { class: 'field-hint' }, 'Si apre in una finestra tutta sua, con la propria icona; l\'interfaccia si carica anche senza connessione (per gestire gli addon serve la rete).'),
    h('div', { class: 'row-actions' }, installButton(false)));
}
