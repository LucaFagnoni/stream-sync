import { h, icon, iconButton, menu, toast, copyText, confirmDialog, kindLogo } from './dom.js';
import * as app from '../app.js';
import { isProtected } from '../model.js';
import { baseUrl, hostOf, str, arr, isHttpUrl, extractUrls } from '../util.js';
import { fetchManifest } from '../manifest.js';
import { openLogin, openInstall, openImport, openMirror, exportPanels, promptDialog } from './dialogs.js';

const { state } = app;
let filterText = '';
let board;
const panelEls = new Map();
const lastClicked = new Map();
let drag = null; // { panelId, keys }

export const setFilter = (t) => {
  filterText = t.trim().toLowerCase();
  for (const p of app.panelList()) {
    // Niente azioni su righe che non si vedono: la selezione nascosta dal filtro viene tolta.
    for (const k of [...p.selected]) { const it = p.find(k); if (it && !matches(it)) p.selected.delete(k); }
    renderPanel(p);
  }
};

const httpUrl = isHttpUrl;
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#64748b');
const matches = (i) => !filterText ||
  `${i.name} ${i.url} ${str(i.manifest?.description)}`.toLowerCase().includes(filterText);

// ---------- riga ----------
function logo(item) {
  const letter = h('div', { class: 'logo fallback', 'aria-hidden': 'true' }, (displayName(item) || '?').trim().charAt(0).toUpperCase());
  const src = str(item.manifest?.logo);
  if (!src || !httpUrl(src)) return letter;
  const img = h('img', { class: 'logo', src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false' });
  img.addEventListener('error', () => img.replaceWith(letter), { once: true });
  return img;
}

const resourceNames = (m) => [...new Set(arr(m?.resources).map((r) => (typeof r === 'string' ? r : str(r?.name))).filter(Boolean))];

function chips(item) {
  const m = item.manifest;
  const out = [h('span', { class: 'chip host', title: item.url }, hostOf(item.url) || item.url)];
  const types = arr(m?.types).map(str).filter(Boolean);
  const res = resourceNames(m);
  // Un chip per gruppo (non uno per valore): tiene le righe compatte.
  if (types.length) out.push(h('span', { class: 'chip type', title: `Tipi: ${types.join(', ')}` }, types.join(' · ')));
  if (res.length) out.push(h('span', { class: 'chip res', title: `Risorse: ${res.join(', ')}` }, res.join(' · ')));
  return out;
}

/** Nome da mostrare: su Nuvio il nome può mancare (il fallback è l'URL): in quel caso l'host. */
const displayName = (item) => (item.name === item.url ? hostOf(item.url) || item.url : item.name);

function badges(item) {
  const b = [];
  if (isProtected(item)) b.push(h('span', { class: 'badge lock', title: 'Addon protetto: non rimovibile' }, icon('lock', 11), 'Protetto'));
  if (item.isNew) b.push(h('span', { class: 'badge new' }, 'Nuovo'));
  if (item.updatedFrom) {
    const from = str(item.updatedFrom.from);
    const to = str(item.updatedFrom.to);
    b.push(h('span', { class: 'badge upd', title: 'Manifest aggiornato: salva per applicarlo' }, from && to && from !== to ? `Aggiornato ${from} → ${to}` : 'Manifest aggiornato'));
  }
  if (!item.enabled) b.push(h('span', { class: 'badge off' }, 'Disattivato'));
  return b;
}

function statusDot(panel, item) {
  const s = panel.health.get(item.key);
  if (!s) return null;
  const title = s.state === 'ok' ? `Raggiungibile (${s.ms} ms)` : s.state === 'fail' ? s.error : 'Verifica in corso…';
  return h('span', { class: `dot ${s.state}`, title, role: 'img', 'aria-label': title });
}

function buildRow(panel, item, index) {
  const m = item.manifest;
  const version = str(m?.version);
  const description = str(m?.description);
  const sel = h('input', {
    type: 'checkbox', class: 'sel', checked: panel.selected.has(item.key), 'aria-label': `Seleziona ${displayName(item)}`,
    onClick: (e) => onSelect(panel, item, index, e),
  });
  const row = h('li', {
    class: `row${panel.selected.has(item.key) ? ' selected' : ''}${item.enabled ? '' : ' disabled'}`,
    draggable: 'true', tabindex: '0', dataset: { key: item.key, index: String(index) },
    'aria-label': displayName(item),
    onDragStart: (e) => onDragStart(e, panel, item, row),
    onDragEnd: endDrag,
    onKeyDown: (e) => onRowKey(e, panel, item),
  },
  sel, h('span', { class: 'grip', 'aria-hidden': 'true' }, icon('grip', 14)), logo(item),
  h('div', { class: 'meta' },
    h('div', { class: 'title' }, h('span', { class: 'name' }, displayName(item)), version ? h('span', { class: 'ver' }, `v${version}`) : null, ...badges(item), statusDot(panel, item)),
    description ? h('div', { class: 'desc' }, description) : null,
    h('div', { class: 'chips' }, ...chips(item))),
  h('div', { class: 'ractions' },
    iconButton('copy', 'Copia URL del manifest', () => copyUrl(item.url)),
    iconButton('up', 'Sposta su', () => moveBy(panel, item, -1), { disabled: index === 0 || undefined }),
    iconButton('down', 'Sposta giù', () => moveBy(panel, item, 1), { disabled: index === panel.items.length - 1 || undefined }),
    iconButton('more', 'Altre azioni', (e) => itemMenu(e.currentTarget, panel, item))));
  row.hidden = !matches(item);
  return row;
}

async function copyUrl(url, label = 'URL del manifest copiato') {
  const ok = await copyText(url);
  toast(ok ? label : 'Copia non riuscita: il browser ha negato l\'accesso agli appunti.', ok ? 'ok' : 'error', 2500);
}

function moveBy(panel, item, delta) {
  if (!panel.moveBy(item.key, delta)) return;
  app.notifyPanel(panel);
  panelEls.get(panel.id)?.querySelector(`.row[data-key="${item.key}"]`)?.focus();
}

function onSelect(panel, item, index, e) {
  const last = lastClicked.get(panel.id);
  if (e.shiftKey && last !== undefined) {
    const [a, b] = [Math.min(last, index), Math.max(last, index)];
    for (const i of panel.items.slice(a, b + 1)) if (matches(i)) panel.toggleSelected(i.key, e.target.checked);
  } else panel.toggleSelected(item.key, e.target.checked);
  lastClicked.set(panel.id, index);
  app.notifyPanel(panel);
}

function onRowKey(e, panel, item) {
  if (e.target !== e.currentTarget) return;
  const rows = [...e.currentTarget.parentElement.querySelectorAll('.row:not([hidden])')];
  const at = rows.indexOf(e.currentTarget);
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveBy(panel, item, e.key === 'ArrowUp' ? -1 : 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); rows[at - 1]?.focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); rows[at + 1]?.focus(); }
  else if (e.key === ' ') { e.preventDefault(); panel.toggleSelected(item.key); app.notifyPanel(panel); }
  else if (e.key === 'Delete') { e.preventDefault(); removeKeys(panel, panel.selected.has(item.key) ? [...panel.selected] : [item.key]); }
}

// ---------- azioni ----------
function removeKeys(panel, keys) {
  const r = panel.remove(keys);
  if (r.blocked) toast(`${r.blocked} addon protetti non possono essere rimossi.`, 'info');
  app.notifyPanel(panel);
}

function targets(except) {
  return app.panelList().filter((p) => p !== except && !p.readOnly && p.status === 'ready');
}

function reportCopy(res, dst, move) {
  const bits = [];
  if (res.added) bits.push(`${move ? 'Spostati' : 'Copiati'} ${res.added} in «${dst.title}»`);
  if (res.skipped) bits.push(`${res.skipped} già presenti`);
  if (res.blocked) bits.push(`${res.blocked} protetti non rimossi dall'origine`);
  if (bits.length) toast(`${bits.join(' · ')}. Salva per applicare.`, res.added ? 'ok' : 'info');
  if (res.failed.length) toast(`Non copiati: ${res.failed.map((f) => `${f.name} (${f.error})`).join('; ')}`, 'error');
}

async function doCopy(src, keys, dst, index, move) {
  reportCopy(await app.copyItems(src, keys, dst, index ?? dst.items.length, { move }), dst, move);
}

function targetMenu(anchor, src, keys, move) {
  const list = targets(src);
  menu(anchor, [
    { heading: move ? 'Sposta in…' : 'Copia in…' },
    ...(list.length ? list.map((p) => ({ label: app.panelLabel(p), icon: p.kind === 'nuvio' ? 'layers' : 'user', onClick: () => doCopy(src, keys, p, undefined, move) }))
      : [{ label: 'Nessun altro pannello disponibile', disabled: true }]),
  ]);
}

async function itemMenu(anchor, panel, item) {
  const keys = panel.selected.has(item.key) ? [...panel.selected] : [item.key];
  const many = keys.length > 1;
  const m = item.manifest;
  menu(anchor, [
    { label: 'Copia URL del manifest', icon: 'copy', onClick: () => copyUrl(item.url) },
    { label: 'Copia come link stremio://', icon: 'link', onClick: () => copyUrl(item.url.replace(/^https?:\/\//i, 'stremio://'), 'Link stremio:// copiato') },
    { label: 'Copia il manifest JSON', icon: 'copy', onClick: () => copyManifestJson(item) },
    { label: 'Apri il manifest', icon: 'external', disabled: !httpUrl(item.url), onClick: () => window.open(item.url, '_blank', 'noopener,noreferrer') },
    m?.behaviorHints?.configurable === true && baseUrl(item.url)
      ? { label: 'Configura addon', icon: 'external', onClick: () => window.open(`${baseUrl(item.url)}/configure`, '_blank', 'noopener,noreferrer') }
      : null,
    'sep',
    { label: many ? `Copia ${keys.length} in…` : 'Copia in…', icon: 'layers', onClick: () => targetMenu(anchor, panel, keys, false) },
    { label: many ? `Sposta ${keys.length} in…` : 'Sposta in…', icon: 'layers', onClick: () => targetMenu(anchor, panel, keys, true), disabled: panel.readOnly },
    'sep',
    { label: panel.kind === 'stremio' ? 'Verifica e aggiorna manifest' : 'Verifica raggiungibilità', icon: 'refresh', onClick: () => runCheck(panel, keys) },
    panel.kind === 'nuvio' ? { label: item.enabled ? 'Disattiva' : 'Attiva', icon: 'power', onClick: () => { panel.setEnabled(keys, !item.enabled); app.notifyPanel(panel); } } : null,
    { label: many ? `Rimuovi ${keys.length}` : 'Rimuovi', icon: 'trash', danger: true, disabled: isProtected(item) && !many, hint: isProtected(item) ? 'Addon protetto' : undefined, onClick: () => removeKeys(panel, keys) },
  ].filter(Boolean));
}

async function copyManifestJson(item) {
  let m = item.manifest;
  if (!m) {
    const r = await fetchManifest(item.url);
    if (!r.ok) { toast(`Manifest non scaricabile: ${r.error}`, 'error'); return; }
    m = r.manifest;
  }
  toast((await copyText(JSON.stringify(m, null, 2))) ? 'Manifest JSON copiato' : 'Copia non riuscita', 'ok', 2500);
}

async function runCheck(panel, keys) {
  const r = await app.checkItems(panel, keys);
  if (r.skipped) toast('Salvataggio in corso: gli aggiornamenti trovati non sono stati applicati. Ripeti la verifica.', 'info');
  const parts = [`${r.checked} verificati`];
  if (panel.kind === 'stremio') parts.push(`${r.updated} aggiornati nella bozza`);
  else if (r.updated) parts.push(`${r.updated} nomi aggiornati`);
  if (r.failures) parts.push(`${r.failures} non raggiungibili`);
  toast(parts.join(' · ') + (r.updated ? '. Salva per applicare.' : '.'), r.failures ? 'info' : 'ok');
}

// ---------- drag & drop ----------
function onDragStart(e, panel, item, row) {
  if (panel.status !== 'ready') { e.preventDefault(); return; }
  const keys = panel.selected.has(item.key) ? [...panel.selected] : [item.key];
  drag = { panelId: panel.id, keys };
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/plain', keys.map((k) => panel.find(k)?.url).filter(Boolean).join('\n'));
  requestAnimationFrame(() => {
    for (const k of keys) panelEls.get(panel.id)?.querySelector(`.row[data-key="${k}"]`)?.classList.add('dragging');
  });
}

// ---------- scorrimento automatico durante il trascinamento ----------
// Il browser non fa scorrere da solo la board orizzontale (né le liste) mentre si trascina:
// avvicinandosi a un bordo si scorre, così si raggiungono i pannelli fuori schermo.
const EDGE = 90;
const MAX_SPEED = 26;
let scroll = { dx: 0, dy: 0, list: null };
let scrollRaf = 0;

const edgeSpeed = (pos, start, end) => {
  const z = Math.min(EDGE, (end - start) / 3);
  if (pos < start + z) return -Math.ceil(MAX_SPEED * Math.min(1, (start + z - pos) / z) ** 2);
  if (pos > end - z) return Math.ceil(MAX_SPEED * Math.min(1, (pos - (end - z)) / z) ** 2);
  return 0;
};

function scrollTick() {
  if (!drag || (!scroll.dx && !scroll.dy)) { scrollRaf = 0; return; }
  if (scroll.dx) board.scrollLeft += scroll.dx;
  if (scroll.dy) (scroll.list || board).scrollTop += scroll.dy;
  scrollRaf = requestAnimationFrame(scrollTick);
}

function stopAutoScroll() {
  scroll = { dx: 0, dy: 0, list: null };
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = 0;
}

document.addEventListener('dragover', (e) => {
  if (!drag || !board) return;
  const b = board.getBoundingClientRect();
  const left = Math.max(b.left, 0);
  const right = Math.min(b.right, innerWidth);
  scroll.dx = board.scrollWidth > board.clientWidth ? edgeSpeed(e.clientX, left, right) : 0;
  // Verticale: la lista sotto il puntatore, oppure la board stessa (layout a colonna su schermi stretti).
  const list = e.target.closest?.('.plist');
  const vScroller = list && list.scrollHeight > list.clientHeight ? list
    : board.scrollHeight > board.clientHeight ? board : null;
  if (vScroller) {
    const r = vScroller.getBoundingClientRect();
    scroll.dy = edgeSpeed(e.clientY, Math.max(r.top, 0), Math.min(r.bottom, innerHeight));
    scroll.list = vScroller;
  } else scroll.dy = 0;
  if ((scroll.dx || scroll.dy) && !scrollRaf) scrollRaf = requestAnimationFrame(scrollTick);
}, true);

function endDrag() {
  stopAutoScroll();
  drag = null;
  for (const el of board.querySelectorAll('.dragging, .drop-target')) el.classList.remove('dragging', 'drop-target');
  for (const el of board.querySelectorAll('.drop-line')) el.remove();
}

function dropIndex(panel, list, y) {
  const rows = [...list.querySelectorAll('.row:not([hidden])')];
  for (const r of rows) {
    const b = r.getBoundingClientRect();
    if (y < b.top + b.height / 2) return { index: Number(r.dataset.index), before: r };
  }
  const last = rows.at(-1);
  return { index: last ? Number(last.dataset.index) + 1 : panel.items.length, before: null, last };
}

function showLine(list, pos) {
  let line = list.querySelector('.drop-line');
  if (!line) line = list.appendChild(h('div', { class: 'drop-line' }));
  const lr = list.getBoundingClientRect();
  const ref = pos.before ?? pos.last;
  const top = ref ? (pos.before ? ref.getBoundingClientRect().top : ref.getBoundingClientRect().bottom) : lr.top;
  line.style.setProperty('top', `${top - lr.top + list.scrollTop - 1}px`);
}

const isExternal = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'text/uri-list' || t === 'text/plain');

function wireDrop(section, panel) {
  const list = () => section.querySelector('.plist');
  section.addEventListener('dragover', (e) => {
    if (!drag) {
      // Link trascinato da un'altra scheda/app: si propone l'installazione (verificata) in questo pannello.
      if (!isExternal(e) || panel.readOnly || panel.status !== 'ready') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      section.classList.add('drop-target');
      return;
    }
    const same = drag.panelId === panel.id;
    if ((!same && (panel.readOnly || panel.status !== 'ready')) || !list()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = same || e.shiftKey ? 'move' : 'copy';
    section.classList.add('drop-target');
    showLine(list(), dropIndex(panel, list(), e.clientY));
  });
  section.addEventListener('dragleave', (e) => {
    if (!section.contains(e.relatedTarget)) { section.classList.remove('drop-target'); section.querySelector('.drop-line')?.remove(); }
  });
  section.addEventListener('drop', (e) => {
    if (!drag) {
      if (!isExternal(e) || panel.readOnly || panel.status !== 'ready') return;
      e.preventDefault();
      section.classList.remove('drop-target');
      const urls = extractUrls(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'));
      if (urls.length) openInstall(panel, { prefill: urls.map((url) => ({ url, enabled: true })) });
      else toast('Nel contenuto trascinato non c\'è un URL di addon.', 'error');
      return;
    }
    if (!list()) return;
    e.preventDefault();
    const { index } = dropIndex(panel, list(), e.clientY);
    const d = drag;
    const shift = e.shiftKey;
    endDrag();
    if (d.panelId === panel.id) {
      if (panel.move(d.keys, index)) app.notifyPanel(panel);
    } else {
      const src = state.panels.get(d.panelId);
      if (src) doCopy(src, d.keys, panel, index, shift);
    }
  });
}

// ---------- pannello ----------
function changeSummary(panel) {
  if (!panel.dirty) return null;
  const d = panel.diff;
  const bits = [];
  if (d.added.length) bits.push(h('span', { class: 'chg add' }, `+${d.added.length}`));
  if (d.removed.length) bits.push(h('span', { class: 'chg del' }, `−${d.removed.length}`));
  if (d.modified.length) bits.push(h('span', { class: 'chg mod' }, `~${d.modified.length}`));
  if (d.reordered) bits.push(h('span', { class: 'chg ord' }, '↕ ordine'));
  return h('span', { class: 'changes' }, ...bits);
}

function panelMenu(anchor, panel) {
  const all = panel.items.length > 0 && panel.items.every((i) => panel.selected.has(i.key));
  menu(anchor, [
    { label: 'Aggiungi da URL…', icon: 'plus', onClick: () => openInstall(panel) },
    { label: 'Importa da file…', icon: 'upload', onClick: () => openImport(panel) },
    { label: 'Sincronizza da un altro pannello…', icon: 'layers', onClick: () => openMirror(panel) },
    'sep',
    { label: 'Ordina A → Z', icon: 'sort', onClick: () => { panel.sortByName(); app.notifyPanel(panel); } },
    { label: all ? 'Deseleziona tutti' : 'Seleziona tutti', icon: 'check', onClick: () => { panel.selected = all ? new Set() : new Set(panel.items.filter(matches).map((i) => i.key)); app.notifyPanel(panel); } },
    { label: panel.kind === 'stremio' ? 'Verifica e aggiorna tutti' : 'Verifica raggiungibilità di tutti', icon: 'refresh', onClick: () => runCheck(panel) },
    'sep',
    { label: 'Esporta questa lista…', icon: 'download', onClick: () => exportPanels([panel], `streamsync-${panel.title.replace(/\W+/g, '-').toLowerCase()}.json`) },
    { label: 'Copia tutti gli URL', icon: 'copy', onClick: () => copyUrl(panel.items.map((i) => i.url).join('\n'), `${panel.items.length} URL copiati`) },
    'sep',
    { label: 'Ricarica dal server', icon: 'refresh', onClick: () => reloadPanel(panel) },
    { label: 'Annulla tutte le modifiche', icon: 'undo', disabled: !panel.dirty, onClick: () => app.discardPanel(panel) },
  ]);
}

async function reloadPanel(panel) {
  if (panel.dirty && !(await confirmDialog({ title: 'Scartare le modifiche?', body: `Le modifiche non salvate a «${panel.title}» andranno perse.`, confirm: 'Scarta e ricarica', danger: true }))) return;
  app.loadPanel(panel);
}

function selectionBar(panel) {
  const keys = [...panel.selected];
  const only = keys.map((k) => panel.find(k)).filter(Boolean);
  return h('div', { class: 'selbar', role: 'toolbar', 'aria-label': 'Azioni sulla selezione' },
    h('strong', null, `${keys.length} selezionati`),
    h('button', { type: 'button', class: 'btn small', onClick: (e) => targetMenu(e.currentTarget, panel, keys, false) }, icon('layers', 14), ' Copia in…'),
    h('button', { type: 'button', class: 'btn small', disabled: panel.readOnly, onClick: (e) => targetMenu(e.currentTarget, panel, keys, true) }, 'Sposta in…'),
    h('button', { type: 'button', class: 'btn small', onClick: () => copyUrl(only.map((i) => i.url).join('\n'), `${only.length} URL copiati`) }, icon('copy', 14), ' URL'),
    panel.kind === 'nuvio' ? h('button', { type: 'button', class: 'btn small', onClick: () => { panel.setEnabled(keys, !only.every((i) => i.enabled)); app.notifyPanel(panel); } }, icon('power', 14), ' Attiva/Disattiva') : null,
    h('button', { type: 'button', class: 'btn small danger', onClick: () => removeKeys(panel, keys) }, icon('trash', 14), ' Rimuovi'),
    h('button', { type: 'button', class: 'icon-btn', title: 'Deseleziona', 'aria-label': 'Deseleziona', onClick: () => { panel.selected = new Set(); app.notifyPanel(panel); } }, icon('x')));
}

function body(panel) {
  if (panel.readOnly) return h('div', { class: 'note' }, icon('lock', 16), h('span', null, panel.readOnlyReason));
  if (panel.status === 'loading') return h('div', { class: 'note' }, h('span', { class: 'spinner' }), 'Caricamento…');
  if (panel.status === 'error') {
    return h('div', { class: 'note error' }, icon('alert', 16), h('span', null, panel.error || 'Errore'),
      h('button', { type: 'button', class: 'btn small', onClick: () => app.loadPanel(panel) }, 'Riprova'));
  }
  const rows = panel.items.map((it, n) => buildRow(panel, it, n));
  const list = h('ul', { class: 'plist', role: 'list', 'aria-label': `Addon di ${panel.title}` }, ...rows);
  if (!panel.items.length) {
    return h('div', { class: 'plist empty' }, h('p', null, 'Nessun addon.'), h('p', { class: 'muted' }, 'Trascina qui degli addon da un altro pannello oppure usa «+».'));
  }
  if (filterText && !rows.some((r) => !r.hidden)) list.append(h('li', { class: 'note muted' }, 'Nessun addon corrisponde alla ricerca.'));
  return list;
}

function buildPanel(panel) {
  const usable = panel.status === 'ready' && !panel.readOnly;
  const collapsed = !!state.settings.collapsed[panel.id];
  const section = h('section', {
    class: `panel ${panel.kind}${panel.dirty ? ' dirty' : ''}${panel.status === 'saving' ? ' saving' : ''}${collapsed ? ' collapsed' : ''}`,
    dataset: { panel: panel.id }, style: { '--accent': safeColor(panel.color) },
    'aria-label': `${panel.kind === 'nuvio' ? 'Nuvio' : 'Stremio'} ${panel.title}`,
  },
  h('header', { class: 'phead' },
    kindLogo(panel.kind),
    h('div', { class: 'ptitle' }, h('strong', null, panel.title), h('small', null, panel.kind === 'nuvio' ? `${app.accountOf(panel)?.label} · profilo ${panel.profile}` : panel.subtitle)),
    h('div', { class: 'pbtns' },
      iconButton('undo', 'Annulla (Ctrl+Z)', () => { panel.undo(); app.notifyPanel(panel); }, { disabled: !panel.canUndo || undefined }),
      iconButton('redo', 'Ripeti (Ctrl+Maiusc+Z)', () => { panel.redo(); app.notifyPanel(panel); }, { disabled: !panel.canRedo || undefined }),
      iconButton('plus', 'Aggiungi da URL', () => openInstall(panel), { disabled: !usable || undefined }),
      iconButton('more', 'Menu pannello', (e) => panelMenu(e.currentTarget, panel), { disabled: !usable || undefined }),
      iconButton('chevron', collapsed ? 'Espandi' : 'Comprimi', () => { app.toggleCollapsed(panel.id); app.notifyPanel(panel); }, { 'aria-expanded': String(!collapsed) }))),
  collapsed ? null : h('div', { class: 'pbar' },
    h('span', { class: 'count' }, filterText ? `${panel.items.filter(matches).length} / ${panel.items.length} addon` : `${panel.items.length} addon`),
    changeSummary(panel),
    h('span', { class: 'spacer' }),
    panel.dirty ? h('button', { type: 'button', class: 'btn small', onClick: () => app.discardPanel(panel) }, 'Annulla') : null,
    panel.dirty ? h('button', { type: 'button', class: 'btn small primary', disabled: panel.status === 'saving', onClick: () => app.savePanel(panel) },
      icon('save', 14), panel.status === 'saving' ? ' Salvataggio…' : ' Salva') : null),
  !collapsed && panel.selected.size ? selectionBar(panel) : null,
  collapsed ? null : body(panel));
  wireDrop(section, panel);
  return section;
}

export function renderPanel(panel) {
  const old = panelEls.get(panel.id);
  if (!old) return;
  const list = old.querySelector('.plist');
  const scroll = list?.scrollTop ?? 0;
  const active = document.activeElement;
  const focusKey = old.contains(active) ? active.closest('.row')?.dataset.key : null;
  const focusCls = focusKey && active.classList.contains('sel') ? '.sel' : active.classList.contains('row') ? '' : null;
  const fresh = buildPanel(panel);
  old.replaceWith(fresh);
  panelEls.set(panel.id, fresh);
  const nl = fresh.querySelector('.plist');
  if (nl) nl.scrollTop = scroll;
  if (focusKey && focusCls !== null) fresh.querySelector(`.row[data-key="${focusKey}"]${focusCls ? ' ' + focusCls : ''}`)?.focus();
  updateSaveAll();
}

// ---------- account ----------
function accountCard(acc) {
  const auth = acc.status === 'auth';
  return h('section', { class: `panel account-card ${acc.kind}`, dataset: { account: acc.id } },
    h('header', { class: 'phead' },
      kindLogo(acc.kind),
      h('div', { class: 'ptitle' }, h('strong', null, acc.label), h('small', null, acc.email))),
    acc.status === 'connecting' || acc.status === 'idle'
      ? h('div', { class: 'note' }, h('span', { class: 'spinner' }), 'Connessione…')
      : h('div', { class: `note ${auth ? '' : 'error'}` }, icon(auth ? 'lock' : 'alert', 16), h('span', null, acc.error || (auth ? 'Accesso richiesto.' : 'Errore')),
        auth ? h('button', { type: 'button', class: 'btn small primary', onClick: () => openLogin({ account: acc }) }, 'Accedi')
          : h('button', { type: 'button', class: 'btn small', onClick: () => app.reloadAccount(acc) }, 'Riprova')),
    h('div', { class: 'note' }, h('button', { type: 'button', class: 'btn small', onClick: () => removeAcc(acc) }, 'Rimuovi account')));
}

async function removeAcc(acc) {
  const dirty = acc.panelIds.some((id) => state.panels.get(id)?.dirty);
  const ok = await confirmDialog({
    title: `Rimuovere ${acc.label}?`, danger: true, confirm: 'Rimuovi',
    body: h('div', null, h('p', null, 'L\'account viene scollegato da questo browser e il token di sessione invalidato (solo per questa sessione: le altre app restano collegate).'),
      dirty ? h('p', { class: 'warn-text' }, 'Ci sono modifiche non salvate che andranno perse.') : null),
  });
  if (ok) await app.removeAccount(acc);
}

export function renderAccounts(strip) {
  strip.replaceChildren(...state.accounts.map((acc) => {
    const dirty = acc.panelIds.some((id) => state.panels.get(id)?.dirty);
    const chip = h('button', {
      type: 'button', class: `chip-acc ${acc.kind} ${acc.status}`, 'aria-haspopup': 'menu',
      title: `${acc.email} — ${acc.status === 'ready' ? 'connesso' : acc.status === 'auth' ? 'accesso richiesto' : acc.status === 'error' ? 'errore' : 'connessione…'}`,
      onClick: (e) => menu(e.currentTarget, [
        { label: 'Ricarica', icon: 'refresh', onClick: () => reloadAccount(acc) },
        { label: 'Rinomina…', icon: 'user', onClick: async () => { const v = await promptDialog({ title: 'Rinomina account', value: acc.label }); if (v !== undefined) app.renameAccount(acc, v); } },
        acc.status === 'auth' ? { label: 'Accedi di nuovo…', icon: 'lock', onClick: () => openLogin({ account: acc }) } : null,
        'sep',
        { label: 'Rimuovi account…', icon: 'logout', danger: true, onClick: () => removeAcc(acc) },
      ].filter(Boolean)),
    }, h('span', { class: 'status-dot' }), kindLogo(acc.kind, 18),
    h('span', { class: 'chip-label' }, acc.label), dirty ? h('span', { class: 'chip-dirty', title: 'Modifiche non salvate' }, '●') : null);
    return chip;
  }));
}

async function reloadAccount(acc) {
  if (acc.panelIds.some((id) => state.panels.get(id)?.dirty) &&
    !(await confirmDialog({ title: 'Scartare le modifiche?', body: 'Ricaricando l\'account le modifiche non salvate andranno perse.', confirm: 'Scarta e ricarica', danger: true }))) return;
  app.reloadAccount(acc);
}

// ---------- board ----------
let stripEl;
let saveAllBtn;

export function mountBoard(boardEl, strip, saveBtn) {
  board = boardEl;
  stripEl = strip;
  saveAllBtn = saveBtn;
}

export function updateSaveAll() {
  const n = app.dirtyPanels().length;
  if (!saveAllBtn) return;
  saveAllBtn.disabled = n === 0;
  saveAllBtn.replaceChildren(icon('save', 16), h('span', null, n ? `Salva tutto (${n})` : 'Salva tutto'));
  renderAccounts(stripEl);
}

export function renderBoard() {
  panelEls.clear();
  const cards = [];
  for (const acc of state.accounts) {
    const panels = acc.panelIds.map((id) => state.panels.get(id)).filter(Boolean);
    if (!panels.length || acc.status === 'auth') cards.push(accountCard(acc));
    for (const p of panels) {
      const el = buildPanel(p);
      panelEls.set(p.id, el);
      cards.push(el);
    }
  }
  board.replaceChildren(...(cards.length ? cards : [emptyState()]));
  board.classList.toggle('is-empty', !cards.length);
  updateSaveAll();
}

function emptyState() {
  return h('div', { class: 'empty-state' },
    h('h2', null, 'Gestisci gli addon di tutti i tuoi account'),
    h('p', null, 'Aggiungi uno o più account Stremio e Nuvio, poi trascina gli addon da una lista all\'altra per copiarli, riordinali e salva quando sei pronto.'),
    h('button', { type: 'button', class: 'btn primary large', onClick: () => openLogin() }, icon('plus', 16), ' Aggiungi il primo account'),
    h('ul', { class: 'tips' },
      h('li', null, 'Le modifiche restano una bozza finché non premi «Salva».'),
      h('li', null, 'Trascina per copiare tra account, ', h('kbd', null, 'Maiusc'), ' mentre rilasci per spostare.'),
      h('li', null, 'Le password non vengono salvate.')));
}
