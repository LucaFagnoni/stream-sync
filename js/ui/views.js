import { h, icon, iconButton, menu, toast, copyText, confirmDialog, kindLogo, fill } from './dom.js';
import * as app from '../app.js';
import { isProtected } from '../model.js';
import { baseUrl, hostOf, str, arr, isHttpUrl, extractUrls, maskUrl, shownName } from '../util.js';
import { fetchManifest } from '../manifest.js';
import { t } from '../i18n.js';
import { openLogin, openInstall, openImport, openMirror, exportPanels, promptDialog, languageSection } from './dialogs.js';

const { state } = app;
let filterText = '';
let board;
const panelEls = new Map();
const lastClicked = new Map();
let drag = null; // { panelId, keys }: trascinamento di addon
let acctDrag = null; // { accountId, target: { id, before } | null }: trascinamento di un intero account
let renderAccountsLater = false;
const ACCT_MIME = 'application/x-addon-manager-account';
// Il trascinamento con il mouse c'è solo dove c'è un puntatore preciso; su touch si usa il menu.
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');

export const setFilter = (text) => {
  filterText = text.trim().toLowerCase();
  for (const p of app.panelList()) {
    // Niente azioni su righe che non si vedono: la selezione nascosta dal filtro viene tolta.
    for (const k of [...p.selected]) { const it = p.find(k); if (it && !matches(it)) p.selected.delete(k); }
    renderPanel(p);
  }
};

const httpUrl = isHttpUrl;

// Testi diversi per chi usa mouse/tastiera e per chi usa il touch: il CSS ne mostra uno solo
// (@media (hover: none) and (pointer: coarse)), così non ci sono istruzioni impossibili da eseguire.
const pc = (...c) => h('span', { class: 'pc-only' }, ...c);
const touch = (...c) => h('span', { class: 'touch-only' }, ...c);
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
  const out = [h('span', { class: 'chip host', title: maskUrl(item.url) || undefined }, hostOf(item.url) || t('Invalid URL'))];
  const types = arr(m?.types).map(str).filter(Boolean);
  const res = resourceNames(m);
  // Un chip per gruppo (non uno per valore): tiene le righe compatte.
  if (types.length) out.push(h('span', { class: 'chip type', title: t('Types: {list}', { list: types.join(', ') }) }, types.join(' · ')));
  if (res.length) out.push(h('span', { class: 'chip res', title: t('Resources: {list}', { list: res.join(', ') }) }, res.join(' · ')));
  return out;
}

/** Nome da mostrare: su Nuvio il nome può mancare (il fallback è l'URL): in quel caso l'host. */
const displayName = shownName;

function badges(item) {
  const b = [];
  if (isProtected(item)) b.push(h('span', { class: 'badge lock', title: t('Protected addon: cannot be removed') }, icon('lock', 11), t('Protected')));
  if (item.isNew) b.push(h('span', { class: 'badge new' }, t('New')));
  if (item.updatedFrom) {
    const from = str(item.updatedFrom.from);
    const to = str(item.updatedFrom.to);
    b.push(h('span', { class: 'badge upd', title: t('Manifest updated: save to apply it') }, from && to && from !== to ? t('Updated {from} → {to}', { from, to }) : t('Manifest updated')));
  }
  if (!item.enabled) b.push(h('span', { class: 'badge off' }, t('Disabled')));
  return b;
}

function statusDot(panel, item) {
  const s = panel.health.get(item.key);
  if (!s) return null;
  const title = s.state === 'ok' ? t('Reachable ({ms} ms)', { ms: s.ms }) : s.state === 'fail' ? s.error : t('Checking…');
  return h('span', { class: `dot ${s.state}`, title, role: 'img', 'aria-label': title });
}

function buildRow(panel, item, index) {
  const m = item.manifest;
  const version = str(m?.version);
  const description = str(m?.description);
  const sel = h('input', {
    type: 'checkbox', class: 'sel', checked: panel.selected.has(item.key), 'aria-label': t('Select {name}', { name: displayName(item) }),
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
    iconButton('copy', t('Copy manifest URL'), () => copyUrl(item.url), { dataset: { act: 'copy' } }),
    iconButton('up', t('Move up'), () => moveBy(panel, item, -1), { disabled: index === 0 || undefined, dataset: { act: 'up' } }),
    iconButton('down', t('Move down'), () => moveBy(panel, item, 1), { disabled: index === panel.items.length - 1 || undefined, dataset: { act: 'down' } }),
    iconButton('more', t('More actions'), (e) => itemMenu(e.currentTarget, panel, item), { dataset: { act: 'more' } })));
  row.hidden = !matches(item);
  return row;
}

async function copyUrl(url, label = t('Manifest URL copied')) {
  const ok = await copyText(url);
  toast(ok ? label : t('Copy failed: the browser denied access to the clipboard.'), ok ? 'ok' : 'error', 2500);
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
  if (r.blocked) toast(t('{n} protected addons cannot be removed.', { n: r.blocked }), 'info');
  app.notifyPanel(panel);
}

function targets(except) {
  return app.panelList().filter((p) => p !== except && !p.readOnly && p.status === 'ready');
}

function reportCopy(res, dst, move) {
  const bits = [];
  if (res.added) bits.push(move ? t('Moved {n} to “{title}”', { n: res.added, title: dst.title }) : t('Copied {n} to “{title}”', { n: res.added, title: dst.title }));
  if (res.skipped) bits.push(t('{n} already present', { n: res.skipped }));
  if (res.blocked) bits.push(t('{n} protected, not removed from the source', { n: res.blocked }));
  if (bits.length) toast(t('{details}. Save to apply.', { details: bits.join(' · ') }), res.added ? 'ok' : 'info');
  if (res.failed.length) toast(t('Not copied: {list}', { list: res.failed.map((f) => `${f.name} (${f.error})`).join('; ') }), 'error');
}

async function doCopy(src, keys, dst, index, move) {
  reportCopy(await app.copyItems(src, keys, dst, index ?? dst.items.length, { move }), dst, move);
}

function targetMenu(anchor, src, keys, move) {
  const list = targets(src);
  menu(anchor, [
    { heading: move ? t('Move to…') : t('Copy to…') },
    ...(list.length ? list.map((p) => ({ label: app.panelLabel(p), icon: p.kind === 'nuvio' ? 'layers' : 'user', onClick: () => doCopy(src, keys, p, undefined, move) }))
      : [{ label: t('No other panel available'), disabled: true }]),
  ]);
}

async function itemMenu(anchor, panel, item) {
  const keys = panel.selected.has(item.key) ? [...panel.selected] : [item.key];
  const many = keys.length > 1;
  const m = item.manifest;
  menu(anchor, [
    { label: t('Copy manifest URL'), icon: 'copy', onClick: () => copyUrl(item.url) },
    { label: t('Copy as stremio:// link'), icon: 'link', onClick: () => copyUrl(item.url.replace(/^https?:\/\//i, 'stremio://'), t('stremio:// link copied')) },
    { label: t('Copy manifest JSON'), icon: 'copy', onClick: () => copyManifestJson(item) },
    { label: t('Open manifest'), icon: 'external', disabled: !httpUrl(item.url), onClick: () => window.open(item.url, '_blank', 'noopener,noreferrer') },
    m?.behaviorHints?.configurable === true && baseUrl(item.url)
      ? { label: t('Configure addon'), icon: 'external', onClick: () => window.open(`${baseUrl(item.url)}/configure`, '_blank', 'noopener,noreferrer') }
      : null,
    'sep',
    { label: many ? t('Copy {n} to…', { n: keys.length }) : t('Copy to…'), icon: 'layers', onClick: () => targetMenu(anchor, panel, keys, false) },
    { label: many ? t('Move {n} to…', { n: keys.length }) : t('Move to…'), icon: 'layers', onClick: () => targetMenu(anchor, panel, keys, true), disabled: panel.readOnly },
    'sep',
    { label: panel.kind === 'stremio' ? t('Check and update manifest') : t('Check reachability'), icon: 'refresh', onClick: () => runCheck(panel, keys) },
    panel.kind === 'nuvio' ? { label: item.enabled ? t('Disable') : t('Enable'), icon: 'power', onClick: () => { panel.setEnabled(keys, !item.enabled); app.notifyPanel(panel); } } : null,
    { label: many ? t('Remove {n}', { n: keys.length }) : t('Remove'), icon: 'trash', danger: true, disabled: isProtected(item) && !many, hint: isProtected(item) ? t('Protected addon') : undefined, onClick: () => removeKeys(panel, keys) },
  ].filter(Boolean));
}

async function copyManifestJson(item) {
  let m = item.manifest;
  if (!m) {
    const r = await fetchManifest(item.url);
    if (!r.ok) { toast(t('Manifest cannot be downloaded: {error}', { error: r.error }), 'error'); return; }
    m = r.manifest;
  }
  toast((await copyText(JSON.stringify(m, null, 2))) ? t('Manifest JSON copied') : t('Copy failed'), 'ok', 2500);
}

async function runCheck(panel, keys) {
  const r = await app.checkItems(panel, keys);
  if (r.skipped) toast(t('Saving in progress: the updates found were not applied. Run the check again.'), 'info');
  const parts = [t('{n} checked', { n: r.checked })];
  if (panel.kind === 'stremio') parts.push(t('{n} updated in the draft', { n: r.updated }));
  else if (r.updated) parts.push(t('{n} names updated', { n: r.updated }));
  if (r.failures) parts.push(t('{n} unreachable', { n: r.failures }));
  toast(parts.join(' · ') + (r.updated ? t('. Save to apply.') : '.'), r.failures ? 'info' : 'ok');
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
// Verticalmente può scorrere la lista sotto il puntatore, la board o (layout stretto) la pagina intera.
const EDGE = 90;
const MAX_SPEED = 26;
let scroll = { dx: 0, dy: 0, scroller: null };
let scrollRaf = 0;

const edgeSpeed = (pos, start, end) => {
  const z = Math.min(EDGE, (end - start) / 3);
  if (pos < start + z) return -Math.ceil(MAX_SPEED * Math.min(1, (start + z - pos) / z) ** 2);
  if (pos > end - z) return Math.ceil(MAX_SPEED * Math.min(1, (pos - (end - z)) / z) ** 2);
  return 0;
};

const canScrollY = (el) => el.scrollHeight > el.clientHeight + 1;

function scrollTick() {
  if ((!drag && !acctDrag) || (!scroll.dx && !scroll.dy)) { scrollRaf = 0; return; }
  if (scroll.dx) board.scrollLeft += scroll.dx;
  if (scroll.dy) {
    if (scroll.scroller === document.scrollingElement) window.scrollBy(0, scroll.dy);
    else if (scroll.scroller) scroll.scroller.scrollTop += scroll.dy;
  }
  scrollRaf = requestAnimationFrame(scrollTick);
}

function stopAutoScroll() {
  scroll = { dx: 0, dy: 0, scroller: null };
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = 0;
}

document.addEventListener('dragover', (e) => {
  if ((!drag && !acctDrag) || !board) return;
  const b = board.getBoundingClientRect();
  const left = Math.max(b.left, 0);
  const right = Math.min(b.right, innerWidth);
  scroll.dx = board.scrollWidth > board.clientWidth ? edgeSpeed(e.clientX, left, right) : 0;
  const list = e.target.closest?.('.plist');
  const page = document.scrollingElement;
  const scroller = list && canScrollY(list) ? list : canScrollY(board) ? board : page && canScrollY(page) ? page : null;
  if (scroller) {
    const r = scroller === page ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
    scroll.dy = edgeSpeed(e.clientY, Math.max(r.top, 0), Math.min(r.bottom, innerHeight));
    scroll.scroller = scroller;
  } else scroll.dy = 0;
  if ((scroll.dx || scroll.dy) && !scrollRaf) scrollRaf = requestAnimationFrame(scrollTick);
}, true);

function endDrag() {
  stopAutoScroll();
  drag = null;
  acctDrag = null;
  for (const el of board.querySelectorAll('.dragging, .drop-target')) el.classList.remove('dragging', 'drop-target');
  for (const el of document.querySelectorAll('.acct-dragging, .acct-before, .acct-after')) el.classList.remove('acct-dragging', 'acct-before', 'acct-after');
  for (const el of board.querySelectorAll('.drop-line')) el.remove();
  if (renderAccountsLater) { renderAccountsLater = false; renderAccounts(stripEl); }
}

// Un pointerdown non arriva mai durante un trascinamento: se è rimasto uno stato appeso (es. l'elemento
// d'origine è stato ricostruito e dragend non è partito), si azzera prima della prossima interazione.
document.addEventListener('pointerdown', () => { if (drag || acctDrag) endDrag(); }, true);

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
    if (acctDrag) return;
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
    if (acctDrag) return;
    if (!drag) {
      if (!isExternal(e) || panel.readOnly || panel.status !== 'ready') return;
      e.preventDefault();
      section.classList.remove('drop-target');
      const urls = extractUrls(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'));
      if (urls.length) openInstall(panel, { prefill: urls.map((url) => ({ url, enabled: true })) });
      else toast(t('There is no addon URL in the dragged content.'), 'error');
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

// ---------- riordino degli account (linguette e intestazioni dei pannelli) ----------
const groupOf = (id, cls) => [...document.querySelectorAll('[data-acc]')].filter((el) => el.dataset.acc === id && el.classList.contains(cls));
const rowLayout = () => getComputedStyle(board).flexDirection === 'row';

function dropAccountAt(srcId, targetId, before) {
  const list = state.accounts;
  const from = list.findIndex((a) => a.id === srcId);
  const to = list.findIndex((a) => a.id === targetId);
  if (from < 0 || to < 0 || from === to) return false;
  const insertAt = before ? to : to + 1; // posizione nella lista di partenza
  return app.moveAccount(list[from], insertAt > from ? insertAt - 1 : insertAt);
}

function startAccountDrag(e, accountId) {
  if (drag) return;
  acctDrag = { accountId, target: null };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(ACCT_MIME, accountId); // Firefox non avvia il trascinamento senza dati
  requestAnimationFrame(() => { for (const el of document.querySelectorAll('[data-acc]')) if (el.dataset.acc === accountId) el.classList.add('acct-dragging'); });
}

function finishAccountDrag() {
  const d = acctDrag;
  endDrag();
  if (d?.target) dropAccountAt(d.accountId, d.target.id, d.target.before);
}

/** Rende `el` un'origine di trascinamento per l'account (solo con mouse). */
function makeAccountDraggable(el, accountId, title) {
  if (!finePointer.matches) return;
  el.setAttribute('draggable', 'true');
  if (title) el.title = title;
  el.addEventListener('dragstart', (e) => startAccountDrag(e, accountId));
  el.addEventListener('dragend', endDrag);
}

/**
 * Rende `el` una destinazione: mostra dove cadrebbe l'account (prima/dopo il gruppo di `accountId`)
 * e, al rilascio, lo sposta. `group()` = elementi del gruppo, `before(e)` = il puntatore è nella prima metà?
 */
function wireAccountTarget(el, accountId, { group, before }) {
  el.addEventListener('dragover', (e) => {
    if (!acctDrag) return;
    // Rilasciare un account sul proprio gruppo non ha senso: niente indicatore, niente drop
    if (accountId === acctDrag.accountId) { for (const m of document.querySelectorAll('.acct-before, .acct-after')) m.classList.remove('acct-before', 'acct-after'); acctDrag.target = null; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const b = before(e);
    for (const m of document.querySelectorAll('.acct-before, .acct-after')) m.classList.remove('acct-before', 'acct-after');
    const els = group();
    (b ? els[0] : els.at(-1))?.classList.add(b ? 'acct-before' : 'acct-after');
    acctDrag.target = { id: accountId, before: b };
  });
  el.addEventListener('drop', (e) => { if (!acctDrag) return; e.preventDefault(); finishAccountDrag(); });
}

/** Un pannello (o scheda) fa parte di un gruppo: la metà si calcola sull'intero gruppo dell'account. */
function panelAccountTarget(section, accountId) {
  wireAccountTarget(section, accountId, {
    group: () => groupOf(accountId, 'panel'),
    before: (e) => {
      const rects = groupOf(accountId, 'panel').map((el) => el.getBoundingClientRect());
      const row = rowLayout();
      const start = Math.min(...rects.map((r) => (row ? r.left : r.top)));
      const end = Math.max(...rects.map((r) => (row ? r.right : r.bottom)));
      return (row ? e.clientX : e.clientY) < (start + end) / 2;
    },
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
  if (d.reordered) bits.push(h('span', { class: 'chg ord' }, t('↕ order')));
  return h('span', { class: 'changes' }, ...bits);
}

function panelMenu(anchor, panel) {
  const all = panel.items.length > 0 && panel.items.every((i) => panel.selected.has(i.key));
  const acc = app.accountOf(panel);
  const at = state.accounts.indexOf(acc);
  const many = state.accounts.length > 1;
  menu(anchor, [
    many ? { label: t('Move account before'), hint: t('Moves all the panels of this account'), disabled: at <= 0, onClick: () => app.moveAccountBy(acc, -1) } : null,
    many ? { label: t('Move account after'), hint: t('Moves all the panels of this account'), disabled: at >= state.accounts.length - 1, onClick: () => app.moveAccountBy(acc, 1) } : null,
    many ? 'sep' : null,
    { label: t('Add from URL…'), icon: 'plus', onClick: () => openInstall(panel) },
    { label: t('Import from file…'), icon: 'upload', onClick: () => openImport(panel) },
    { label: t('Sync from another panel…'), icon: 'layers', onClick: () => openMirror(panel) },
    'sep',
    { label: t('Sort A → Z'), icon: 'sort', onClick: () => { panel.sortByName(); app.notifyPanel(panel); } },
    { label: all ? t('Deselect all') : t('Select all'), icon: 'check', onClick: () => { panel.selected = all ? new Set() : new Set(panel.items.filter(matches).map((i) => i.key)); app.notifyPanel(panel); } },
    { label: panel.kind === 'stremio' ? t('Check and update all') : t('Check reachability of all'), icon: 'refresh', onClick: () => runCheck(panel) },
    'sep',
    { label: t('Export this list…'), icon: 'download', onClick: () => exportPanels([panel], `addon-manager-${panel.title.replace(/\W+/g, '-').toLowerCase()}.json`) },
    { label: t('Copy all URLs'), icon: 'copy', onClick: () => copyUrl(panel.items.map((i) => i.url).join('\n'), t('{n} URLs copied', { n: panel.items.length })) },
    'sep',
    { label: t('Reload from server'), icon: 'refresh', onClick: () => reloadPanel(panel) },
    { label: t('Undo all changes'), icon: 'undo', disabled: !panel.dirty, onClick: () => app.discardPanel(panel) },
  ].filter(Boolean));
}

async function reloadPanel(panel) {
  if (panel.dirty && !(await confirmDialog({ title: t('Discard changes?'), body: t('Unsaved changes to “{title}” will be lost.', { title: panel.title }), confirm: t('Discard and reload'), danger: true }))) return;
  app.loadPanel(panel);
}

function selectionBar(panel) {
  const keys = [...panel.selected];
  const only = keys.map((k) => panel.find(k)).filter(Boolean);
  // Su touch il testo dei pulsanti si nasconde (.lbl) e restano le icone: la barra sta su una riga sola.
  // `text` = nome accessibile e tooltip; `visible` = testo mostrato su desktop (se diverso); `short` = parola breve su touch
  const act = (name, text, onClick, { danger = false, disabled = false, short = null, visible = text } = {}) => h('button', {
    type: 'button', class: `btn small${danger ? ' danger' : ''}`, title: text, 'aria-label': text, disabled: disabled || undefined, onClick,
  }, icon(name, 14), h('span', { class: 'lbl' }, ` ${visible}`), short ? h('span', { class: 'lbl-s' }, ` ${short}`) : null);
  return h('div', { class: 'selbar', role: 'toolbar', 'aria-label': t('Selection actions') },
    h('strong', { class: 'selcount' }, h('span', { class: 'selicon' }, icon('check', 14)), `${keys.length}`, h('span', { class: 'lbl' }, ` ${t('selected')}`)),
    act('layers', t('Copy to…'), (e) => targetMenu(e.currentTarget, panel, keys, false), { short: t('Copy') }),
    act('move', t('Move to…'), (e) => targetMenu(e.currentTarget, panel, keys, true), { disabled: panel.readOnly, short: t('Move') }),
    act('link', t('Copy the URLs'), () => copyUrl(only.map((i) => i.url).join('\n'), t('{n} URLs copied', { n: only.length })), { visible: 'URL' }),
    panel.kind === 'nuvio' ? act('power', t('Enable/Disable'), () => { panel.setEnabled(keys, !only.every((i) => i.enabled)); app.notifyPanel(panel); }) : null,
    act('trash', t('Remove'), () => removeKeys(panel, keys), { danger: true }),
    h('button', { type: 'button', class: 'icon-btn', title: t('Deselect'), 'aria-label': t('Deselect'), onClick: () => { panel.selected = new Set(); app.notifyPanel(panel); } }, icon('x')));
}

function body(panel) {
  if (panel.readOnly) return h('div', { class: 'note' }, icon('lock', 16), h('span', null, panel.readOnlyReason));
  if (panel.status === 'loading') return h('div', { class: 'note' }, h('span', { class: 'spinner' }), t('Loading…'));
  if (panel.status === 'error') {
    return h('div', { class: 'note error' }, icon('alert', 16), h('span', null, panel.error || t('Error')),
      h('button', { type: 'button', class: 'btn small', onClick: () => app.loadPanel(panel) }, t('Retry')));
  }
  const rows = panel.items.map((it, n) => buildRow(panel, it, n));
  const list = h('ul', { class: 'plist', role: 'list', 'aria-label': t('Addons of {title}', { title: panel.title }) }, ...rows);
  if (!panel.items.length) {
    return h('div', { class: 'plist empty' }, h('p', null, t('No addons.')),
      h('p', { class: 'muted' },
        pc(t('Drag addons here from another panel or use “+”.')),
        touch(t('Add addons with “+”, or copy them from another panel with ⋯ → “Copy to…”.'))));
  }
  if (filterText && !rows.some((r) => !r.hidden)) list.append(h('li', { class: 'note muted' }, t('No addon matches the search.')));
  return list;
}

function buildPanel(panel) {
  const usable = panel.status === 'ready' && !panel.readOnly;
  const collapsed = !!state.settings.collapsed[panel.id];
  const section = h('section', {
    class: `panel ${panel.kind}${panel.dirty ? ' dirty' : ''}${panel.status === 'saving' ? ' saving' : ''}${collapsed ? ' collapsed' : ''}`,
    dataset: { panel: panel.id, acc: panel.accountId }, style: { '--accent': safeColor(panel.color) },
    'aria-label': `${panel.kind === 'nuvio' ? 'Nuvio' : 'Stremio'} ${panel.title}`,
  },
  h('div', { class: 'pstick' },
  h('header', { class: 'phead' },
    kindLogo(panel.kind),
    h('div', { class: 'ptitle' }, h('strong', null, panel.title), h('small', null, panel.kind === 'nuvio' ? t('{account} · profile {n}', { account: app.accountOf(panel)?.label, n: panel.profile }) : panel.subtitle)),
    h('div', { class: 'pbtns' },
      iconButton('undo', t('Undo'), () => { panel.undo(); app.notifyPanel(panel); }, { title: t('Undo (Ctrl+Z)'), disabled: !panel.canUndo || undefined, dataset: { act: 'undo' } }),
      iconButton('redo', t('Redo'), () => { panel.redo(); app.notifyPanel(panel); }, { title: t('Redo (Ctrl+Shift+Z)'), disabled: !panel.canRedo || undefined, dataset: { act: 'redo' } }),
      iconButton('plus', t('Add from URL'), () => openInstall(panel), { disabled: !usable || undefined }),
      iconButton('more', t('Panel menu'), (e) => panelMenu(e.currentTarget, panel), { disabled: !usable || undefined }),
      iconButton('chevron', collapsed ? t('Expand') : t('Collapse'), () => { app.toggleCollapsed(panel.id); app.notifyPanel(panel); }, { 'aria-expanded': String(!collapsed) }))),
  collapsed ? null : h('div', { class: 'pbar' },
    h('span', { class: 'count' }, filterText ? `${panel.items.filter(matches).length} / ${panel.items.length} addon` : `${panel.items.length} addon`),
    changeSummary(panel),
    h('span', { class: 'spacer' }),
    panel.dirty ? h('button', { type: 'button', class: 'btn small', onClick: () => app.discardPanel(panel) }, t('Cancel')) : null,
    panel.dirty ? h('button', { type: 'button', class: 'btn small primary', disabled: panel.status === 'saving', onClick: () => app.savePanel(panel) },
      icon('save', 14), ` ${panel.status === 'saving' ? t('Saving…') : t('Save')}`) : null),
  !collapsed && panel.selected.size ? selectionBar(panel) : null),
  collapsed ? null : body(panel));
  wireDrop(section, panel);
  makeAccountDraggable(section.querySelector('.phead'), panel.accountId, t('Drag to move the account'));
  panelAccountTarget(section, panel.accountId);
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
  if (focusKey && focusCls !== null) fresh.querySelector(`.row[data-key="${focusKey}"]${focusCls ? ' ' + focusCls : ''}`)?.focus({ preventScroll: true });
  updateSaveAll();
}

// ---------- account ----------
function accountCard(acc) {
  const auth = acc.status === 'auth';
  const card = h('section', { class: `panel account-card ${acc.kind}`, dataset: { account: acc.id, acc: acc.id } },
    h('header', { class: 'phead' },
      kindLogo(acc.kind),
      h('div', { class: 'ptitle' }, h('strong', null, acc.label), h('small', null, acc.email))),
    acc.status === 'connecting' || acc.status === 'idle'
      ? h('div', { class: 'note' }, h('span', { class: 'spinner' }), t('Connecting…'))
      : h('div', { class: `note ${auth ? '' : 'error'}` }, icon(auth ? 'lock' : 'alert', 16), h('span', null, acc.error || (auth ? t('Sign-in required.') : t('Error'))),
        auth ? h('button', { type: 'button', class: 'btn small primary', onClick: () => openLogin({ account: acc }) }, t('Sign in'))
          : h('button', { type: 'button', class: 'btn small', onClick: () => app.reloadAccount(acc) }, t('Retry'))),
    h('div', { class: 'note' }, h('button', { type: 'button', class: 'btn small', onClick: () => removeAcc(acc) }, t('Remove account'))));
  makeAccountDraggable(card.querySelector('.phead'), acc.id, t('Drag to move the account'));
  panelAccountTarget(card, acc.id);
  return card;
}

async function removeAcc(acc) {
  const dirty = acc.panelIds.some((id) => state.panels.get(id)?.dirty);
  const ok = await confirmDialog({
    title: t('Remove {name}?', { name: acc.label }), danger: true, confirm: t('Remove'),
    body: h('div', null, h('p', null, t('The account is disconnected from this browser and its session token is invalidated (only this session: your other apps stay connected).')),
      dirty ? h('p', { class: 'warn-text' }, t('There are unsaved changes that will be lost.')) : null),
  });
  if (ok) await app.removeAccount(acc);
}

function accountChip(acc) {
  const dirty = acc.panelIds.some((id) => state.panels.get(id)?.dirty);
  const at = state.accounts.indexOf(acc);
  const last = state.accounts.length - 1;
  const status = acc.status === 'ready' ? t('connected') : acc.status === 'auth' ? t('sign-in required') : acc.status === 'error' ? t('error') : t('connecting…');
  const chip = h('button', {
    type: 'button', class: `chip-acc ${acc.kind} ${acc.status}`, 'aria-haspopup': 'menu',
    title: `${acc.email} — ${status}`,
    onClick: (e) => menu(e.currentTarget, [
      { label: t('Reload'), icon: 'refresh', onClick: () => reloadAccount(acc) },
      { label: t('Rename…'), icon: 'user', onClick: async () => { const v = await promptDialog({ title: t('Rename account'), value: acc.label }); if (v !== undefined) app.renameAccount(acc, v); } },
      acc.status === 'auth' ? { label: t('Sign in again…'), icon: 'lock', onClick: () => openLogin({ account: acc }) } : null,
      state.accounts.length > 1 ? 'sep' : null,
      state.accounts.length > 1 ? { label: t('Move before'), disabled: at <= 0, onClick: () => app.moveAccountBy(acc, -1) } : null,
      state.accounts.length > 1 ? { label: t('Move after'), disabled: at >= last, onClick: () => app.moveAccountBy(acc, 1) } : null,
      'sep',
      { label: t('Remove account…'), icon: 'logout', danger: true, onClick: () => removeAcc(acc) },
    ].filter(Boolean)),
    // Alt + frecce: sposta l'account (sinistra/su = prima, destra/giù = dopo)
    onKeyDown: (e) => {
      if (!e.altKey) return;
      const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0;
      if (!d) return;
      e.preventDefault();
      app.moveAccountBy(acc, d);
    },
  }, h('span', { class: 'status-dot' }), kindLogo(acc.kind, 18),
  h('span', { class: 'chip-label' }, acc.label), dirty ? h('span', { class: 'chip-dirty', title: t('Unsaved changes') }, '●') : null);

  // Il contenitore è trascinabile (Firefox non permette di trascinare direttamente un <button>)
  const wrap = h('div', { class: 'chip-wrap', dataset: { acc: acc.id } }, chip);
  makeAccountDraggable(wrap, acc.id);
  wireAccountTarget(wrap, acc.id, {
    group: () => [wrap],
    before: (e) => { const r = wrap.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; },
  });
  return wrap;
}

export function renderAccounts(strip) {
  // Ricostruire le linguette durante un trascinamento distruggerebbe l'elemento d'origine: si rimanda.
  if (acctDrag) { renderAccountsLater = true; return; }
  const focused = strip.contains(document.activeElement) ? document.activeElement.closest('.chip-wrap')?.dataset.acc : null;
  strip.replaceChildren(...state.accounts.map(accountChip));
  if (focused) [...strip.children].find((el) => el.dataset.acc === focused)?.querySelector('.chip-acc')?.focus({ preventScroll: true });
}

async function reloadAccount(acc) {
  if (acc.panelIds.some((id) => state.panels.get(id)?.dirty) &&
    !(await confirmDialog({ title: t('Discard changes?'), body: t('If you reload the account, unsaved changes will be lost.'), confirm: t('Discard and reload'), danger: true }))) return;
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
  fill(saveAllBtn,
    icon('save', 16),
    h('span', { class: 'lbl' }, n ? t('Save all ({n})', { n }) : t('Save all')),
    n ? h('span', { class: 'count-badge', 'aria-hidden': 'true' }, String(n)) : null);
  saveAllBtn.title = n ? (n === 1 ? t('Save all (1 modified list)') : t('Save all ({n} modified lists)', { n })) : t('Save all');
  renderAccounts(stripEl);
}

export function renderBoard() {
  // La board si ricostruisce da zero (es. dopo aver spostato un account): si conservano le posizioni di scorrimento.
  const lists = new Map([...panelEls].map(([id, el]) => [id, el.querySelector('.plist')?.scrollTop ?? 0]));
  const left = board.scrollLeft;
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
  board.scrollLeft = left;
  for (const [id, top] of lists) { const l = panelEls.get(id)?.querySelector('.plist'); if (l && top) l.scrollTop = top; }
  updateSaveAll();
}

function emptyState() {
  return h('div', { class: 'empty-state' },
    h('img', { class: 'empty-logo', src: 'img/logo.svg', alt: '', width: 72, height: 72 }),
    h('h2', null, t('Manage the addons of all your accounts')),
    h('p', null, t('Add one or more Stremio and Nuvio accounts, then copy and move addons between the lists, reorder them and save when you are ready.')),
    h('button', { type: 'button', class: 'btn primary large', onClick: () => openLogin() }, icon('plus', 16), ` ${t('Add your first account')}`),
    h('ul', { class: 'tips' },
      h('li', null, pc(t('Changes stay a draft until you press “Save”.')), touch(t('Changes stay a draft until you tap “Save”.'))),
      h('li', null,
        pc(t('Drag an addon into another list to copy it; hold '), h('kbd', null, t('Shift')), t(' while you drop it to move it.')),
        touch(t('Tap ⋯ next to an addon and choose “Copy to…” or “Move to…” to bring it to another account.'))),
      h('li', null, touch(t('Reorder with the ↑ ↓ arrows next to each addon.')), pc(t('Reorder by dragging, or with '), h('kbd', null, 'Alt'), ' + ', h('kbd', null, '↑'), ' / ', h('kbd', null, '↓'), '.')),
      h('li', null, t('Passwords are not saved.'))),
    languageSection({ small: true, className: 'empty-lang' }));
}
