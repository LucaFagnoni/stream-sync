import * as app from './app.js';
import { t, getLang, setLang, applyStatic, onLangChange, LANGUAGES } from './i18n.js';
import { h, icon, toast, menu, closeMenu } from './ui/dom.js';
import { mountBoard, renderBoard, renderPanel, setFilter, updateSaveAll } from './ui/views.js';
import { openLogin, openBackups, confirmSave, confirmConflict } from './ui/dialogs.js';
import { initInstall, registerServiceWorker } from './install.js';
import { mountInstallBanner } from './ui/install-ui.js';

const $ = (id) => document.getElementById(id);

// ---------- anti-clickjacking ----------
// GitHub Pages non permette header HTTP (X-Frame-Options / frame-ancestors, che nel <meta> è ignorato):
// se la pagina è dentro un iframe altrui non si carica nessun account.
if (window.top !== window.self) {
  document.body.replaceChildren(h('main', { class: 'framed' },
    h('p', null, t('For security, Addon Manager does not work inside another page.')),
    h('a', { href: location.href, target: '_top', rel: 'noopener' }, t('Open Addon Manager directly'))));
  throw new Error('Addon Manager: caricamento in un frame bloccato');
}

applyStatic();

// ---------- tema ----------
const root = document.documentElement;
function applyTheme() {
  const t = app.state.settings.theme;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('theme').replaceChildren(icon(dark ? 'sun' : 'moon', 18));
}
$('theme').addEventListener('click', () => {
  const dark = root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  app.updateSettings({ theme: dark ? 'light' : 'dark' });
  applyTheme();
});

// ---------- collegamento controller <-> UI ----------
mountBoard($('board'), $('accounts'), $('save-all'));
app.setHooks({ toast, confirmSave, confirmConflict });
app.on('board', renderBoard);
app.on('panel', renderPanel);
app.on('accounts', updateSaveAll);

// Sui telefoni i pulsanti della barra mostrano solo l'icona (il testo .lbl si nasconde via CSS).
// Il suggerimento "( / )" ha senso solo dove c'è una tastiera.
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
function renderChrome() {
  $('backup').replaceChildren(icon('download', 16), h('span', { class: 'lbl' }, t('Backup')));
  $('add-account').replaceChildren(icon('plus', 16), h('span', { class: 'lbl' }, t('Account')));
  $('lang').textContent = getLang().toUpperCase();
  $('search').placeholder = finePointer.matches ? t('Search all lists  ( / )') : t('Search all lists');
}
renderChrome();
finePointer.addEventListener('change', renderChrome);

// ---------- lingua ----------
// La scelta è salvata (js/i18n.js) e vale anche alla visita successiva; cambiandola si ridisegna tutto.
$('lang').addEventListener('click', (e) => menu(e.currentTarget, [
  { heading: t('Language') },
  ...Object.entries(LANGUAGES).map(([code, l]) => ({
    label: l.name, icon: code === getLang() ? 'check' : null, onClick: () => setLang(code),
  })),
]));
onLangChange(() => {
  closeMenu();
  renderChrome();
  applyTheme();
  app.notifyBoard();
});

$('add-account').addEventListener('click', () => openLogin());
$('backup').addEventListener('click', () => openBackups());
$('save-all').addEventListener('click', async () => {
  const n = await app.saveAll();
  if (n > 1) toast(t('{n} lists saved.', { n }), 'ok');
});
$('search').addEventListener('input', (e) => setFilter(e.target.value));

// ---------- scorciatoie ----------
const activePanel = () => app.state.panels.get(app.state.activePanelId);
document.addEventListener('focusin', (e) => {
  const id = e.target.closest?.('[data-panel]')?.dataset.panel;
  if (id) app.state.activePanelId = id;
});
document.addEventListener('pointerdown', (e) => {
  const id = e.target.closest?.('[data-panel]')?.dataset.panel;
  if (id) app.state.activePanelId = id;
});
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.activeElement.type !== 'checkbox';
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === '/' && !typing && !mod) { e.preventDefault(); $('search').focus(); return; }
  if (e.key === 'Escape' && document.activeElement === $('search')) { $('search').value = ''; setFilter(''); $('search').blur(); return; }
  if (!mod || typing || document.querySelector('dialog[open]')) return;
  const p = activePanel();
  if (!p) return;
  if (e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey ? p.redo() : p.undo()) app.notifyPanel(p);
  } else if (e.key.toLowerCase() === 's') {
    e.preventDefault();
    app.savePanel(p);
  }
});

// Un link o un file rilasciato fuori dai pannelli farebbe navigare via dalla pagina (bozze comprese).
document.addEventListener('dragover', (e) => {
  if (!e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; }
});
document.addEventListener('drop', (e) => { if (!e.defaultPrevented) e.preventDefault(); });

addEventListener('beforeunload', (e) => {
  if (app.dirtyPanels().length) { e.preventDefault(); e.returnValue = ''; }
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- installazione come app + uso senza rete ----------
initInstall();
mountInstallBanner($('install-banner'));
registerServiceWorker();

// ---------- avvio ----------
await app.init();
applyTheme();
closeMenu();
