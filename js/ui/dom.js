// Helper DOM: nessun innerHTML (manifest e nomi addon sono dati non fidati).

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'indeterminate') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// ---------- icone (path statici, stile "lucide") ----------
const ICONS = {
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  grip: '<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  sort: '<path d="M3 6h7M3 12h11M3 18h15"/>',
  power: '<path d="M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10"/>',
  layers: '<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = ICONS[name] || ''; // costanti statiche definite sopra, mai dati esterni
  return svg;
}

export function iconButton(name, label, onClick, extra = {}) {
  return h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, onClick, ...extra }, icon(name));
}

// ---------- toast ----------
let toastHost;
export function toast(message, kind = 'info', ms = 4500) {
  toastHost ||= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const t = h('div', { class: `toast ${kind}` }, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? Math.max(ms, 7000) : ms);
}

// ---------- menu contestuale ----------
let openMenu = null;
export function closeMenu() { openMenu?.remove(); openMenu = null; }

/** items: { label, icon?, onClick, danger?, disabled?, hint? } | 'sep' | { heading } */
export function menu(anchor, items) {
  closeMenu();
  const m = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === 'sep') { m.append(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if (it.heading) { m.append(h('div', { class: 'menu-heading' }, it.heading)); continue; }
    m.append(h('button', {
      type: 'button', role: 'menuitem', class: `menu-item${it.danger ? ' danger' : ''}`, disabled: it.disabled,
      title: it.hint, onClick: (e) => { e.stopPropagation(); closeMenu(); it.onClick?.(); },
    }, it.icon ? icon(it.icon, 15) : h('span', { class: 'icon-gap' }), h('span', null, it.label)));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.setProperty('left', `${Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8))}px`);
  m.style.setProperty('top', `${r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4}px`);
  m.querySelector('button:not([disabled])')?.focus();
  openMenu = m;
  return m;
}

addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
addEventListener('scroll', closeMenu, true);
addEventListener('resize', closeMenu);

// ---------- dialog ----------
/**
 * Apre un <dialog> modale. `build(close)` restituisce il contenuto; la promise si risolve
 * con il valore passato a close() (undefined se chiuso con Esc / click esterno).
 */
export function dialog(build, { wide = false, label = '' } = {}) {
  return new Promise((resolve) => {
    const d = h('dialog', { class: `dialog${wide ? ' wide' : ''}`, 'aria-label': label });
    let value;
    const close = (v) => { value = v; d.close(); };
    d.append(build(close));
    d.addEventListener('close', () => { d.remove(); resolve(value); });
    d.addEventListener('click', (e) => { if (e.target === d) close(undefined); });
    document.body.append(d);
    d.showModal();
  });
}

export const dialogHeader = (title, close) =>
  h('div', { class: 'dialog-head' }, h('h2', null, title), iconButton('x', 'Chiudi', () => close(undefined)));

export function confirmDialog({ title, body, confirm = 'Conferma', cancel = 'Annulla', danger = false, extra = [] }) {
  return dialog((close) => h('div', { class: 'dialog-body' },
    dialogHeader(title, close),
    h('div', { class: 'dialog-content' }, body),
    h('div', { class: 'dialog-actions' },
      ...extra.map((x) => h('button', { type: 'button', class: 'btn', onClick: () => close(x.value) }, x.label)),
      h('button', { type: 'button', class: 'btn', onClick: () => close(false) }, cancel),
      h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, onClick: () => close(true), autofocus: true }, confirm))), { label: title });
}

// ---------- clipboard / download ----------
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignorato */ }
    ta.remove();
    return ok;
  }
}

export function downloadFile(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
