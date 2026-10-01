import { h, icon, dialog, dialogHeader, fill } from './dom.js';
import { t, onLangChange } from '../i18n.js';
import {
  onInstallChange, isStandalone, installPlatform, canPromptInstall, promptInstall, bannerDismissed, dismissBanner,
} from '../install.js';

const steps = () => ({
  ios: [
    t('Tap the Share button (the square with the arrow pointing up) in the browser bar.'),
    t('Scroll the list and choose “Add to Home Screen”.'),
    t('Confirm with “Add”: the Addon Manager icon will appear on your Home Screen.'),
  ],
  'mac-safari': [
    t('In Safari’s File menu choose “Add to Dock…” (Safari 17 and macOS Sonoma or later).'),
    t('Confirm: Addon Manager will open in a window of its own, with its icon in the Dock.'),
  ],
  other: [
    t('Look for the install icon in the address bar (Chrome, Edge) or “Install app” / “Add to Home Screen” in the browser menu.'),
    t('The browser only offers installation after you have used the page for a little while. Not all browsers can install web apps.'),
  ],
});

/** Finestra con i passi da fare a mano (Safari non ha un pulsante che apra l'installazione). */
export function openInstallHelp() {
  const platform = installPlatform();
  return dialog((close) => h('div', { class: 'dialog-body' },
    dialogHeader(t('Install Addon Manager'), close),
    h('div', { class: 'dialog-content' },
      h('p', { class: 'field-hint' }, t('It opens in a window of its own, with its own icon, without the browser bar.')),
      h('ol', { class: 'steps' }, ...steps()[platform].map((text) => h('li', null, text)))),
    h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn primary', onClick: () => close() }, t('Got it')))), { label: t('Installation') });
}

/** Il pulsante giusto per il browser in uso: apre l'installazione vera, oppure le istruzioni. */
function installButton(primary = true) {
  if (canPromptInstall()) {
    return h('button', { type: 'button', class: `btn${primary ? ' primary' : ''}`, onClick: () => promptInstall() }, icon('download', 15), ` ${t('Install')}`);
  }
  return h('button', { type: 'button', class: `btn${primary ? ' primary' : ''}`, onClick: openInstallHelp }, t('How to install'));
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
        h('strong', null, t('Install Addon Manager')),
        h('span', null, t('It opens like an app, in a window of its own, with its own icon.'))),
      h('div', { class: 'install-actions' },
        installButton(true),
        h('button', { type: 'button', class: 'btn', onClick: dismissBanner }, t('Not now')))));
  };
  onInstallChange(render);
  onLangChange(render);
  render();
}

/** Sezione sempre disponibile nella finestra Backup, anche dopo aver chiuso l'invito. */
export function installSection() {
  if (isStandalone()) return h('p', { class: 'field-hint' }, t('You are using Addon Manager as an installed app.'));
  return h('div', null,
    h('p', { class: 'field-hint' }, t('It opens in a window of its own, with its own icon; the interface also loads without a connection (managing addons needs the network).')),
    h('div', { class: 'row-actions' }, installButton(false)));
}
