import * as app from './app.js';
import { h, icon, toast, confirmDialog, closeMenu } from './ui/dom.js';
import { mountBoard, renderBoard, renderPanel, setFilter, updateSaveAll } from './ui/views.js';
import { openLogin, openBackups, confirmSave, confirmConflict } from './ui/dialogs.js';

const $ = (id) => document.getElementById(id);

// ---------- anti-clickjacking ----------
// GitHub Pages non permette header HTTP (X-Frame-Options / frame-ancestors, che nel <meta> è ignorato):
// se la pagina è dentro un iframe altrui non si carica nessun account.
if (window.top !== window.self) {
  document.body.replaceChildren(h('main', { class: 'framed' },
    h('p', null, 'Per sicurezza StreamSync non funziona dentro un\'altra pagina.'),
    h('a', { href: location.href, target: '_top', rel: 'noopener' }, 'Apri StreamSync direttamente')));
  throw new Error('StreamSync: caricamento in un frame bloccato');
}

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

$('add-account').addEventListener('click', () => openLogin());
$('backup').addEventListener('click', () => openBackups());
$('save-all').addEventListener('click', async () => {
  const n = await app.saveAll();
  if (n > 1) toast(`${n} liste salvate.`, 'ok');
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

// ---------- avvio ----------
await app.init();
applyTheme();
closeMenu();
