// Modello dati dei pannelli (liste di addon) con bozza locale, undo/redo e diff.
// Nessuna dipendenza dal DOM.

import { uid, idOf, hashString, stableStringify } from './util.js';

export function makeItem(p) {
  const url = typeof p.url === 'string' ? p.url : String(p.url ?? '');
  return {
    key: p.key || uid(),
    url,
    // Il nome arriva da manifest non fidati: deve essere sempre una stringa (ordinamento, rendering).
    name: typeof p.name === 'string' && p.name.trim() ? p.name : url,
    enabled: p.enabled !== false,
    manifest: p.manifest && typeof p.manifest === 'object' ? p.manifest : null,
    flags: p.flags && typeof p.flags === 'object' ? p.flags : {},
    raw: p.raw ?? null,
    isNew: !!p.isNew,
    updatedFrom: p.updatedFrom ?? null,
  };
}

export const isProtected = (item) => !!item.flags?.protected;

/** Parte "di contenuto" di un item: ciò che, se cambia, rende la bozza diversa dal remoto. */
function contentSig(kind, item) {
  return kind === 'stremio'
    ? hashString(stableStringify(item.manifest))
    : `${item.name}|${item.enabled ? 1 : 0}`;
}

/** Firma completa (ordine + contenuto): usata per sapere se la bozza è sporca. */
export function signature(kind, items) {
  return items.map((i) => `${idOf(i.url)}#${contentSig(kind, i)}`).join('\n');
}

/** Firma "remota" (ordine + id + enabled): usata per rilevare modifiche fatte da altri client. */
export function remoteSignature(items) {
  return items.map((i) => `${idOf(i.url)}#${i.enabled ? 1 : 0}`).join('\n');
}

/** Differenza tra due liste (per id), con conteggi utili per l'interfaccia. */
export function diffLists(kind, base, next) {
  const baseMap = new Map(base.map((i) => [idOf(i.url), i]));
  const nextMap = new Map(next.map((i) => [idOf(i.url), i]));
  const added = next.filter((i) => !baseMap.has(idOf(i.url)));
  const removed = base.filter((i) => !nextMap.has(idOf(i.url)));
  const modified = next.filter((i) => {
    const b = baseMap.get(idOf(i.url));
    return b && contentSig(kind, b) !== contentSig(kind, i);
  });
  const common = (list, other) => list.map((i) => idOf(i.url)).filter((id) => other.has(id));
  const a = common(base, nextMap);
  const b = common(next, baseMap);
  const reordered = a.length === b.length && a.some((id, n) => id !== b[n]);
  return { added, removed, modified, reordered };
}

export class Panel {
  constructor(meta) {
    Object.assign(this, {
      title: '', subtitle: '', color: null, readOnly: false, readOnlyReason: '',
      status: 'idle', // idle | loading | ready | saving | error
      error: '', template: undefined,
    }, meta);
    this.base = [];
    this.items = [];
    this.past = [];
    this.future = [];
    this.selected = new Set();
    this.health = new Map(); // key -> { state: 'checking'|'ok'|'fail', ms?, error? }
    this.baseSig = '';
    this.remoteSig = '';
  }

  load(items) {
    this.base = items;
    this.items = items;
    this.past = [];
    this.future = [];
    this.selected = new Set();
    this.baseSig = signature(this.kind, items);
    this.remoteSig = remoteSignature(items);
    this.status = 'ready';
    this.error = '';
  }

  get dirty() { return this.status !== 'loading' && signature(this.kind, this.items) !== this.baseSig; }
  get diff() { return diffLists(this.kind, this.base, this.items); }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  find(key) { return this.items.find((i) => i.key === key); }
  has(url) { const id = idOf(url); return this.items.some((i) => idOf(i.url) === id); }

  /** Durante caricamento/salvataggio la lista non si tocca: la modifica andrebbe persa al reload. */
  get locked() { return this.status === 'saving' || this.status === 'loading'; }

  /** Applica una nuova lista registrando lo stato precedente per l'undo. @returns {boolean} */
  commit(next) {
    if (this.locked) return false;
    this.past.push(this.items);
    if (this.past.length > 100) this.past.shift();
    this.future = [];
    this.items = next;
    for (const k of [...this.selected]) if (!next.some((i) => i.key === k)) this.selected.delete(k);
    return true;
  }

  undo() {
    if (!this.past.length || this.locked) return false;
    this.future.push(this.items);
    this.items = this.past.pop();
    this.selected = new Set([...this.selected].filter((k) => this.items.some((i) => i.key === k)));
    return true;
  }

  redo() {
    if (!this.future.length || this.locked) return false;
    this.past.push(this.items);
    this.items = this.future.pop();
    return true;
  }

  /** Adotta un nuovo stato remoto come base e `items` come bozza (dopo un'unione con il server). */
  rebase(remote, items) {
    this.base = remote;
    this.baseSig = signature(this.kind, remote);
    this.remoteSig = remoteSignature(remote);
    this.items = items;
    this.past = [];
    this.future = [];
    this.selected = new Set();
  }

  discard() {
    this.items = this.base;
    this.past = [];
    this.future = [];
    this.selected = new Set();
  }

  /** Inserisce item nuovi alla posizione indicata (o in coda). */
  insert(newItems, index = this.items.length) {
    const at = Math.max(0, Math.min(index, this.items.length));
    return this.commit([...this.items.slice(0, at), ...newItems, ...this.items.slice(at)]);
  }

  /** @returns {{removed: number, blocked: number}} gli addon protetti si rimuovono solo con `force` */
  remove(keys, { force = false } = {}) {
    const set = new Set(keys);
    const targets = this.items.filter((i) => set.has(i.key));
    const blocked = force ? 0 : targets.filter(isProtected).length;
    const kill = new Set(targets.filter((i) => force || !isProtected(i)).map((i) => i.key));
    const ok = kill.size > 0 && this.commit(this.items.filter((i) => !kill.has(i.key)));
    return { removed: ok ? kill.size : 0, blocked };
  }

  /**
   * Sposta gli item selezionati prima dell'elemento alla posizione `toIndex`
   * (indice nella lista corrente, prima della rimozione), mantenendo il loro ordine relativo.
   */
  move(keys, toIndex) {
    const set = new Set(keys);
    const moving = this.items.filter((i) => set.has(i.key));
    if (!moving.length) return false;
    const before = this.items.slice(0, toIndex).filter((i) => set.has(i.key)).length;
    const rest = this.items.filter((i) => !set.has(i.key));
    const at = Math.max(0, Math.min(toIndex - before, rest.length));
    const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    if (next.every((i, n) => i === this.items[n])) return false;
    return this.commit(next);
  }

  moveBy(key, delta) {
    const i = this.items.findIndex((x) => x.key === key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.items.length) return false;
    const next = this.items.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return this.commit(next);
  }

  sortByName() {
    const next = this.items.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    if (next.every((i, n) => i === this.items[n])) return false;
    return this.commit(next);
  }

  setEnabled(keys, enabled) {
    const set = new Set(keys);
    if (!this.items.some((i) => set.has(i.key) && i.enabled !== enabled)) return false;
    return this.commit(this.items.map((i) => (set.has(i.key) ? { ...i, enabled } : i)));
  }

  /** Modifica "vera" di un item (finisce nella cronologia e nella bozza). */
  patch(key, changes) {
    return this.commit(this.items.map((i) => (i.key === key ? { ...i, ...changes } : i)));
  }

  /** Annotazione non persistente (es. manifest scaricato per mostrarlo): niente undo, non sporca la bozza. */
  annotate(key, changes) {
    const apply = (list) => list.map((i) => (i.key === key ? { ...i, ...changes } : i));
    this.items = apply(this.items);
    this.base = apply(this.base);
  }

  toggleSelected(key, on) {
    const want = on ?? !this.selected.has(key);
    if (want) this.selected.add(key); else this.selected.delete(key);
  }
}

/** Prende dal server il contenuto di un item che noi non abbiamo modificato. */
function adoptRemote(kind, item, r) {
  return kind === 'stremio'
    ? { ...item, url: r.url, manifest: r.manifest, flags: r.flags, raw: r.raw }
    : { ...item, url: r.url, name: r.name, enabled: r.enabled };
}

/**
 * Prima di un push "sostituisci tutto": per gli item che NON abbiamo modificato si usa la versione
 * attuale del server (manifest/flag/nome aggiornati altrove), così il salvataggio non li riporta indietro.
 */
export function rebaseOnRemote(kind, base, draft, remote) {
  const baseById = new Map(base.map((i) => [idOf(i.url), i]));
  const remoteById = new Map(remote.map((i) => [idOf(i.url), i]));
  return draft.map((item) => {
    const id = idOf(item.url);
    const b = baseById.get(id);
    const r = remoteById.get(id);
    if (!b || !r || contentSig(kind, b) !== contentSig(kind, item)) return item;
    return adoptRemote(kind, item, r);
  });
}

/**
 * Unione a tre vie tra base (ciò che avevamo caricato), bozza (le nostre modifiche) e remoto
 * (lo stato attuale, cambiato da un altro dispositivo). Nessuna delle due parti perde modifiche:
 *  - aggiunti da noi: restano;             - rimossi da noi: restano rimossi;
 *  - modificati da noi: vince la bozza;     - invariati da noi: si prende la versione remota;
 *  - rimossi altrove e non toccati da noi: restano rimossi;
 *  - aggiunti altrove: inseriti dopo il loro predecessore nella lista remota.
 * L'ordine segue la bozza.
 */
export function mergeThreeWay(kind, base, draft, remote) {
  const baseById = new Map(base.map((i) => [idOf(i.url), i]));
  const remoteById = new Map(remote.map((i) => [idOf(i.url), i]));
  const draftIds = new Set(draft.map((i) => idOf(i.url)));
  const out = [];
  for (const item of draft) {
    const id = idOf(item.url);
    const b = baseById.get(id);
    const r = remoteById.get(id);
    if (!b) { out.push(item); continue; }
    const mine = contentSig(kind, b) !== contentSig(kind, item);
    if (!r) { if (mine) out.push(item); continue; }
    out.push(mine ? item : adoptRemote(kind, item, r));
  }
  remote.forEach((r, n) => {
    const id = idOf(r.url);
    if (baseById.has(id) || draftIds.has(id)) return;
    let at = 0;
    for (let k = n - 1; k >= 0; k--) {
      const prevId = idOf(remote[k].url);
      const pos = out.findIndex((o) => idOf(o.url) === prevId);
      if (pos >= 0) { at = pos + 1; break; }
    }
    out.splice(at, 0, r);
  });
  return out;
}

/**
 * Piano per portare `dst` verso `src`.
 *  - merge:  aggiunge in coda ciò che manca
 *  - mirror: stessa lista e stesso ordine di src (gli extra di dst vengono rimossi, tranne i protetti)
 */
export function planMirror(dstItems, srcItems, mode) {
  const dstIds = new Set(dstItems.map((i) => idOf(i.url)));
  const srcIds = new Set(srcItems.map((i) => idOf(i.url)));
  const add = srcItems.filter((i) => !dstIds.has(idOf(i.url)));
  const extra = dstItems.filter((i) => !srcIds.has(idOf(i.url)));
  const remove = mode === 'mirror' ? extra.filter((i) => !isProtected(i)) : [];
  return { add, remove, keepExtra: mode === 'mirror' ? extra.filter(isProtected) : extra };
}

/**
 * Costruisce la lista risultante. `converted` mappa idOf(url) -> item già convertito per dst.
 * Gli item non convertibili (assenti dalla mappa) vengono saltati.
 */
export function applyMirror(dstItems, srcItems, converted, mode) {
  const dstById = new Map(dstItems.map((i) => [idOf(i.url), i]));
  if (mode === 'merge') {
    const extra = srcItems.map((s) => converted.get(idOf(s.url))).filter((i) => i && !dstById.has(idOf(i.url)));
    return [...dstItems, ...extra];
  }
  const srcIds = new Set(srcItems.map((i) => idOf(i.url)));
  const ordered = srcItems
    .map((s) => dstById.get(idOf(s.url)) || converted.get(idOf(s.url)))
    .filter(Boolean);
  const protectedExtra = dstItems.filter((i) => !srcIds.has(idOf(i.url)) && isProtected(i));
  return [...ordered, ...protectedExtra];
}
