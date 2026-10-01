// Controller: stato globale, account, caricamento/salvataggio, copia tra pannelli.
// Non tocca il DOM: la UI si registra con on() e con setHooks().

import * as Stremio from './stremio.js';
import * as Nuvio from './nuvio.js';
import {
  Panel, makeItem, remoteSignature, signature, isProtected, planMirror, applyMirror, rebaseOnRemote, mergeThreeWay,
} from './model.js';
import { convertItem } from './convert.js';
import { fetchManifest } from './manifest.js';
import { t } from './i18n.js';
import { loadStore, saveStore, pushBackup, readSession, readRemoved, deleteBackupsFor, clearAll, STORE_KEY } from './store.js';
import { uid, pLimit, hashString, stableStringify, idOf, str, toManifestUrl, moveInArray, shownName } from './util.js';

export const state = {
  accounts: [],
  panels: new Map(),
  settings: { theme: 'auto', collapsed: {} },
  activePanelId: null,
};

// ---------- eventi ----------
const listeners = new Map();
export const on = (ev, fn) => { (listeners.get(ev) || listeners.set(ev, new Set()).get(ev)).add(fn); };
const emit = (ev, arg) => { for (const fn of listeners.get(ev) || []) fn(arg); };
export const notifyPanel = (panel) => emit('panel', panel);
export const notifyBoard = () => emit('board');
export const notifyAccounts = () => emit('accounts');

/** Funzioni fornite dalla UI per le domande all'utente (il controller resta senza DOM). */
export const hooks = {
  toast: () => {},
  confirmSave: async () => true,
  confirmConflict: async () => 'cancel',
};
export const setHooks = (h) => Object.assign(hooks, h);

// ---------- helper ----------
export function explain(e) {
  const m = String(e?.message || e || '');
  if (/invalid login credentials/i.test(m)) return t('Incorrect email or password.');
  if (/user not found/i.test(m)) return t('Account not found.');
  if (/wrong passphrase|wrong password/i.test(m)) return t('Wrong password.');
  if (/too many requests|rate limit/i.test(m)) return t('Too many requests: try again shortly.');
  if (/email not confirmed/i.test(m)) return t('Email not confirmed yet.');
  return m || t('Unknown error.');
}

export const accountOf = (panel) => state.accounts.find((a) => a.id === panel.accountId);
export const panelList = () => [...state.panels.values()];
export const dirtyPanels = () => panelList().filter((p) => p.dirty);
export const panelLabel = (p) => (p.kind === 'nuvio' ? `${accountOf(p)?.label} · ${p.title}` : p.title);

// Account rimossi in questa scheda: non vanno "resuscitati" dall'unione con lo storage.
const removedIds = new Set();

function persist() {
  // Un'altra scheda può aver aggiunto account: si conservano invece di sovrascriverli.
  // Quelli rimossi (qui o in un'altra scheda) non vanno mai riscritti.
  const removed = new Set([...readRemoved(), ...removedIds]);
  const known = new Set(state.accounts.map((a) => a.id));
  const foreign = loadStore().accounts.filter((a) => !known.has(a.id) && !removed.has(a.id));
  saveStore({ accounts: [...state.accounts.filter((a) => !removed.has(a.id)), ...foreign], settings: state.settings, removed: [...removed] });
}

export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  persist();
}

export function toggleCollapsed(panelId) {
  const c = state.settings.collapsed;
  if (c[panelId]) delete c[panelId]; else c[panelId] = true;
  persist();
}

/**
 * Modifiche fatte da un'altra scheda:
 * - «Esci da tutto» (dati cancellati): anche questa scheda esce e cancella, invece di riscrivere token ed email;
 * - account rimosso: sparisce anche qui;
 * - token Nuvio ruotato: lo si adotta subito, prima di riusare quello vecchio.
 */
function onStorage(e) {
  if (e.key !== STORE_KEY && e.key !== null) return; // null: localStorage.clear()
  if (e.newValue == null) {
    if (state.accounts.length) {
      hooks.toast(t('Data cleared from another tab: signed out of all accounts here too.'), 'info');
      forgetEverything();
    }
    return;
  }
  const removed = new Set(readRemoved());
  const gone = state.accounts.filter((a) => removed.has(a.id));
  if (gone.length) {
    for (const acc of gone) { dropPanels(acc); removedIds.add(acc.id); }
    state.accounts = state.accounts.filter((a) => !removed.has(a.id));
    notifyBoard();
  }
  for (const acc of state.accounts) {
    if (acc.kind !== 'nuvio' || !acc.nuvio) continue;
    const s = readSession(acc.id);
    if (s?.refresh_token && s.refresh_token !== acc.nuvio.session?.refresh_token) {
      acc.session = s;
      acc.nuvio.session = s;
    }
  }
}

// ---------- accesso remoto (per tipo) ----------
async function fetchRemote(panel) {
  const acc = accountOf(panel);
  if (!acc?.session) throw new Error(t('Account not connected.'));
  if (acc.kind === 'stremio') {
    const { addons } = await Stremio.getAddons(acc.session.authKey);
    const template = addons.find((a) => 'transportName' in a)?.transportName;
    return { items: addons.map((d) => makeItem(Stremio.fromDescriptor(d))), template };
  }
  const items = await acc.nuvio.listAddons(panel.profile);
  return { items: items.map(makeItem) };
}

async function pushRemote(panel, items, template) {
  const acc = accountOf(panel);
  if (acc.kind === 'stremio') {
    await Stremio.setAddons(acc.session.authKey, items.map((i) => Stremio.toDescriptor(i, template)));
  } else {
    await acc.nuvio.pushAddons(panel.profile, items);
  }
}

function markAuthLost(acc) {
  acc.status = 'auth';
  acc.error = t('Session expired: sign in again.');
  acc.session = null;
  persist();
  // I pannelli "puliti" non servono più; quelli con bozza restano visibili così il lavoro non sparisce.
  if (!acc.panelIds.some((id) => state.panels.get(id)?.dirty)) dropPanels(acc);
  notifyBoard();
}

// ---------- caricamento ----------
export async function loadPanel(panel) {
  const acc = accountOf(panel);
  if (panel.readOnly) { panel.status = 'ready'; notifyPanel(panel); return; }
  panel.status = 'loading';
  notifyPanel(panel);
  try {
    const r = await fetchRemote(panel);
    panel.template = r.template;
    panel.load(r.items);
  } catch (e) {
    panel.status = 'error';
    panel.error = explain(e);
    if (e.expired) markAuthLost(acc);
  }
  notifyPanel(panel);
}

function dropPanels(acc) {
  for (const id of acc.panelIds) state.panels.delete(id);
  acc.panelIds = [];
}

export async function connectAccount(acc) {
  dropPanels(acc);
  if (!acc.session) { acc.status = 'auth'; acc.error = ''; notifyBoard(); return; }
  acc.status = 'connecting';
  acc.error = '';
  try {
    if (acc.kind === 'stremio') {
      const p = new Panel({ id: acc.id, accountId: acc.id, kind: 'stremio', title: acc.label, subtitle: acc.email, color: '#8b5cf6' });
      state.panels.set(p.id, p);
      acc.panelIds = [p.id];
      notifyBoard();
      await loadPanel(p);
    } else {
      acc.nuvio = new Nuvio.NuvioSession(acc.session, (s) => { acc.session = s; persist(); }, () => readSession(acc.id));
      const profiles = await acc.nuvio.listProfiles();
      const panels = profiles.map((pr) => new Panel({
        id: `${acc.id}:${pr.index}`, accountId: acc.id, kind: 'nuvio', profile: pr.index,
        title: pr.name, subtitle: acc.email, color: pr.color || '#1e88e5',
        readOnly: pr.usesPrimary,
        readOnlyReason: t('This profile uses the addons of Profile 1: edit them there.'),
      }));
      for (const p of panels) state.panels.set(p.id, p);
      acc.panelIds = panels.map((p) => p.id);
      notifyBoard();
      await Promise.all(panels.map(loadPanel));
    }
    acc.status = acc.status === 'auth' ? 'auth' : 'ready';
  } catch (e) {
    if (e.expired) markAuthLost(acc);
    else { acc.status = 'error'; acc.error = explain(e); }
  }
  notifyBoard();
}

function makeAccount(p) {
  return { id: p.id || uid(), kind: p.kind, label: p.label, email: p.email, remember: !!p.remember,
    session: p.session || null, status: 'idle', error: '', panelIds: [], nuvio: null };
}

export async function init() {
  const s = loadStore();
  state.settings = s.settings;
  state.accounts = s.accounts.map(makeAccount);
  globalThis.addEventListener?.('storage', onStorage);
  notifyBoard();
  await Promise.all(state.accounts.map(connectAccount));
}

// ---------- account ----------
async function authenticate(kind, email, password) {
  if (kind === 'stremio') {
    const r = await Stremio.login(email, password);
    return { authKey: r.authKey, userId: r.userId };
  }
  return Nuvio.signIn(email, password);
}

export async function addAccount({ kind, email, password, label, remember }) {
  email = email.trim();
  if (state.accounts.some((a) => a.kind === kind && a.email.toLowerCase() === email.toLowerCase())) {
    throw new Error(t('This account has already been added.'));
  }
  const session = await authenticate(kind, email, password);
  const acc = makeAccount({ kind, email, label: label.trim() || email, remember, session });
  state.accounts.push(acc);
  persist();
  notifyBoard();
  await connectAccount(acc);
  return acc;
}

export async function reauth(acc, password, remember = acc.remember) {
  acc.session = await authenticate(acc.kind, acc.email, password);
  acc.remember = !!remember;
  persist();
  await connectAccount(acc);
}

export function renameAccount(acc, label) {
  acc.label = label.trim() || acc.email;
  for (const id of acc.panelIds) {
    const p = state.panels.get(id);
    if (p && acc.kind === 'stremio') p.title = acc.label;
  }
  persist();
  notifyBoard();
}

export async function removeAccount(acc) {
  if (acc.session) {
    if (acc.kind === 'stremio') await Stremio.logout(acc.session.authKey);
    else if (acc.nuvio) await acc.nuvio.logout();
  }
  dropPanels(acc);
  state.accounts = state.accounts.filter((a) => a !== acc);
  removedIds.add(acc.id);
  deleteBackupsFor(acc.id);
  persist();
  notifyBoard();
}

/** Esce da tutti gli account (invalidando i token sul server) e cancella ogni dato locale. */
export async function forgetEverything() {
  for (const acc of [...state.accounts]) await removeAccount(acc);
  clearAll();
  notifyBoard();
}

export async function reloadAccount(acc) { await connectAccount(acc); }

/**
 * Sposta un account (con tutti i suoi pannelli) nella posizione `toIndex` dell'elenco.
 * L'ordine è quello di state.accounts, che viene salvato: le bozze non si toccano.
 * @returns {boolean} true se l'ordine è cambiato
 */
export function moveAccount(acc, toIndex) {
  const from = state.accounts.indexOf(acc);
  const to = Math.max(0, Math.min(toIndex, state.accounts.length - 1));
  if (from < 0 || from === to) return false;
  state.accounts = moveInArray(state.accounts, from, to);
  persist();
  notifyBoard();
  return true;
}

export const moveAccountBy = (acc, delta) => moveAccount(acc, state.accounts.indexOf(acc) + delta);

// ---------- salvataggio ----------
const backupEntry = (panel, remoteItems) => ({
  ts: Date.now(),
  accountId: panel.accountId,
  account: accountOf(panel)?.label,
  title: panel.title,
  kind: panel.kind,
  items: remoteItems.map((i) => ({ url: i.url, name: i.name, enabled: i.enabled !== false })),
});

/** @returns {Promise<boolean>} true se sul server c'è ora la bozza */
export async function savePanel(panel) {
  if (!panel.dirty || panel.status !== 'ready' || panel.readOnly) return false;
  const acc = accountOf(panel);
  if (!acc?.session) return false;
  const diff = panel.diff;

  // Il push sostituisce TUTTO: chiedi conferma quando si cancella qualcosa.
  if ((diff.removed.length || !panel.items.length) && !(await hooks.confirmSave(panel, diff))) return false;
  if (!panel.dirty || panel.status !== 'ready') return false;

  const same = (a, b) => signature(panel.kind, a) === signature(panel.kind, b);
  panel.status = 'saving';
  notifyPanel(panel);
  try {
    const remote = await fetchRemote(panel);

    // Il server ha già esattamente la bozza (es. un tentativo precedente, scaduto per timeout, era riuscito).
    if (same(remote.items, panel.items)) {
      panel.template = remote.template;
      panel.load(remote.items);
      hooks.toast(t('“{title}” was already up to date on the server.', { title: panel.title }), 'ok');
      return true;
    }

    let draft = panel.items;
    if (remoteSignature(remote.items) !== panel.remoteSig) {
      const choice = await hooks.confirmConflict(panel, remote.items);
      if (choice === 'reload') {
        panel.template = remote.template;
        panel.load(remote.items);
        hooks.toast(t('List reloaded from the server: your changes were discarded.'), 'info');
        return false;
      }
      if (choice === 'merge') {
        draft = mergeThreeWay(panel.kind, panel.base, panel.items, remote.items);
        panel.rebase(remote.items, draft);
      } else if (choice !== 'overwrite') {
        panel.status = 'ready';
        return false;
      }
    }

    // Gli addon che non abbiamo toccato prendono la versione attuale del server.
    const toPush = rebaseOnRemote(panel.kind, panel.base, draft, remote.items);
    if (same(toPush, remote.items)) {
      panel.template = remote.template;
      panel.load(remote.items);
      hooks.toast(t('“{title}”: no changes to write.', { title: panel.title }), 'info');
      return true;
    }

    pushBackup(backupEntry(panel, remote.items), { persistent: !!acc.remember });
    try {
      await pushRemote(panel, toPush, remote.template);
    } catch (e) {
      if (e.expired) throw e;
      // Esito incerto (timeout, rete): prima di dichiarare il fallimento si guarda cosa c'è sul server.
      const now = await fetchRemote(panel).catch(() => null);
      if (!now || !same(now.items, toPush)) throw e;
    }

    // Rilettura: conferma che il server abbia davvero accettato ciò che abbiamo inviato.
    const fresh = await fetchRemote(panel);
    panel.template = fresh.template;
    panel.load(fresh.items);
    if (same(fresh.items, toPush)) hooks.toast(t('Saved: {title}', { title: panel.title }), 'ok');
    else hooks.toast(t('“{title}” was saved, but the server now shows a different list from the one sent: check it.', { title: panel.title }), 'error');
    return true;
  } catch (e) {
    panel.status = 'ready';
    panel.error = '';
    if (e.expired) markAuthLost(acc);
    hooks.toast(t('Save failed ({title}): {error}', { title: panel.title, error: explain(e) }), 'error');
    return false;
  } finally {
    notifyPanel(panel);
  }
}

/**
 * Salva prima le liste che ricevono addon e poi quelle che ne perdono: se uno "sposta" si interrompe
 * a metà, l'addon resta duplicato invece di sparire da entrambe.
 */
export async function saveAll() {
  const list = dirtyPanels().sort((a, b) => a.diff.removed.length - b.diff.removed.length);
  let ok = 0;
  for (const p of list) if (await savePanel(p)) ok++;
  return ok;
}

export async function discardPanel(panel) {
  panel.discard();
  notifyPanel(panel);
}

// ---------- copia / sposta ----------
const convertLimit = pLimit(4);

/**
 * Copia (o sposta) item da un pannello a un altro. Gli item già presenti in destinazione vengono saltati;
 * quelli che non si possono convertire (es. manifest non scaricabile verso Stremio) sono riportati come falliti.
 */
export async function copyItems(src, keys, dst, index, { move = false } = {}) {
  const res = { added: 0, skipped: 0, failed: [], removed: 0, blocked: 0 };
  if (dst.readOnly) { hooks.toast(dst.readOnlyReason || t('Read-only panel.'), 'error'); return res; }
  if (dst.status !== 'ready') { hooks.toast(t('The destination panel is not ready (loading or saving in progress).'), 'error'); return res; }

  const set = new Set(keys);
  const items = src.items.filter((i) => set.has(i.key));
  const todo = items.filter((i) => !dst.has(i.url));
  res.skipped = items.length - todo.length;

  const converted = await Promise.all(todo.map((item) => convertLimit(async () => {
    try { return { item, out: await convertItem(item, dst.kind) }; }
    catch (e) { return { item, error: explain(e) }; }
  })));
  res.failed = converted.filter((c) => c.error).map((c) => ({ name: shownName(c.item), error: c.error }));

  // Durante la conversione (asincrona) la destinazione può essere cambiata.
  const ok = converted.filter((c) => c.out && !dst.has(c.out.url));
  if (ok.length && !dst.insert(ok.map((c) => c.out), index)) {
    hooks.toast(t('The destination is being saved: copy cancelled, try again in a moment.'), 'error');
    return { ...res, failed: [] };
  }
  res.added = ok.length;

  if (move) {
    const moved = items.filter((i) => ok.some((c) => c.item === i) || dst.has(i.url));
    const r = src.remove(moved.map((i) => i.key));
    res.removed = r.removed;
    res.blocked = r.blocked;
  }
  notifyPanel(dst);
  if (move) notifyPanel(src);
  return res;
}

/** Porta `dst` verso `src` (bozza): vedi planMirror/applyMirror per la semantica dei due modi. */
export async function mirrorInto(dst, src, mode) {
  const plan = planMirror(dst.items, src.items, mode);
  const converted = new Map();
  const failed = [];
  await Promise.all(plan.add.map((item) => convertLimit(async () => {
    try { converted.set(idOf(item.url), await convertItem(item, dst.kind)); }
    catch (e) { failed.push({ name: shownName(item), error: explain(e) }); }
  })));
  const applied = dst.commit(applyMirror(dst.items, src.items, converted, mode));
  notifyPanel(dst);
  return applied
    ? { added: converted.size, removed: plan.remove.length, failed }
    : { added: 0, removed: 0, failed, locked: true };
}

// ---------- verifica / aggiornamento ----------
const checkLimit = pLimit(6);

/**
 * Scarica di nuovo i manifest. Stremio: se il manifest è cambiato lo aggiorna nella bozza.
 * Nuvio: non conserva il manifest sul server, quindi si aggiorna solo il nome e si mostra lo stato.
 * Le modifiche vanno comunque salvate esplicitamente.
 */
export async function checkItems(panel, keys) {
  const set = keys ? new Set(keys) : null;
  const targets = panel.items.filter((i) => !set || set.has(i.key));
  for (const i of targets) panel.health.set(i.key, { state: 'checking' });
  notifyPanel(panel);

  const updates = new Map();
  let failures = 0;
  await Promise.all(targets.map((item) => checkLimit(async () => {
    const r = await fetchManifest(item.url, { force: true });
    if (!r.ok) {
      failures++;
      panel.health.set(item.key, { state: 'fail', error: r.error });
    } else {
      panel.health.set(item.key, { state: 'ok', ms: r.ms });
      const m = r.manifest;
      if (panel.kind === 'stremio') {
        const changed = hashString(stableStringify(m)) !== hashString(stableStringify(item.manifest));
        if (changed) {
          updates.set(item.key, { manifest: m, name: m.name, updatedFrom: { from: str(item.manifest?.version) || null, to: str(m.version) || null } });
        }
      } else if (m.name !== item.name) {
        updates.set(item.key, { name: m.name, manifest: m });
      } else {
        panel.annotate(item.key, { manifest: m });
      }
    }
    notifyPanel(panel);
  })));

  const committed = updates.size > 0 &&
    panel.commit(panel.items.map((i) => (updates.has(i.key) ? { ...i, ...updates.get(i.key) } : i)));
  notifyPanel(panel);
  return { checked: targets.length, updated: committed ? updates.size : 0, skipped: updates.size > 0 && !committed, failures };
}

// ---------- installazione da URL ----------
/** `existing`: Set di idOf() già presenti nella lista. Gli URL vengono normalizzati a …/manifest.json. */
export async function probeUrls(urls, kind, existing) {
  const limit = pLimit(4);
  return Promise.all(urls.map((raw) => limit(async () => {
    const url = toManifestUrl(raw);
    if (existing.has(idOf(url))) return { url, status: 'duplicate' };
    const r = await fetchManifest(url);
    if (r.ok) return { url, status: 'ok', manifest: r.manifest };
    // Su Nuvio basta l'URL: molti addon validi non mandano CORS e non sono verificabili dal browser.
    return kind === 'nuvio' ? { url, status: 'unverified', error: r.error } : { url, status: 'error', error: r.error };
  })));
}

export function itemFromProbe(p, kind) {
  const m = p.manifest;
  return makeItem({
    url: p.url,
    name: m?.name || new URL(p.url).hostname,
    manifest: kind === 'stremio' ? m : (m || null),
    isNew: true,
  });
}

export { isProtected, idOf, signature };
