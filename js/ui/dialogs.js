import { h, icon, dialog, dialogHeader, confirmDialog, toast, downloadFile, kindLogo, fill } from './dom.js';
import * as app from '../app.js';
import { planMirror } from '../model.js';
import { buildExport, parseImport } from '../backup.js';
import { listBackups } from '../store.js';
import { installSection } from './install-ui.js';
import { extractUrls, idOf, hostOf, str, shownName } from '../util.js';
import { t, getLang, setLang, locale, LANGUAGES } from '../i18n.js';
import { THEMES, currentTheme, setTheme } from './theme.js';

const field = (label, input, hint) =>
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);

// ---------- login ----------
export function openLogin({ account } = {}) {
  return dialog((close) => {
    let kind = account?.kind || 'stremio';
    const email = h('input', { type: 'email', required: true, autocomplete: 'username', value: account?.email || '', readonly: !!account, placeholder: t('email@example.com') });
    const pass = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: t('Password') });
    const label = h('input', { type: 'text', placeholder: t('Optional, e.g. "Home" or "Family"'), maxlength: 40 });
    const remember = h('input', { type: 'checkbox', checked: account ? account.remember : false });
    const err = h('div', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, account ? t('Sign in again') : t('Sign in and add'));

    const kinds = h('div', { class: 'kind-picker', role: 'radiogroup', 'aria-label': t('Service') });
    const renderKinds = () => {
      kinds.replaceChildren(...['stremio', 'nuvio'].map((k) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(kind === k), class: `kind-card ${k}${kind === k ? ' on' : ''}`,
        disabled: !!account && account.kind !== k,
        onClick: () => { kind = k; renderKinds(); },
      }, h('span', { class: 'kind-card-title' }, kindLogo(k, 22), h('strong', null, k === 'stremio' ? 'Stremio' : 'Nuvio')),
      h('small', null, k === 'stremio' ? t('Email/password account') : t('Account with profiles (1–6)')))));
    };
    renderKinds();

    const form = h('form', {
      class: 'dialog-content form',
      onSubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        submit.disabled = true;
        submit.textContent = t('Signing in…');
        try {
          if (account) await app.reauth(account, pass.value, remember.checked);
          else await app.addAccount({ kind, email: email.value, password: pass.value, label: label.value, remember: remember.checked });
          close(true);
        } catch (ex) {
          err.textContent = app.explain(ex);
          submit.disabled = false;
          submit.textContent = account ? t('Sign in again') : t('Sign in and add');
        }
      },
    },
    account ? null : kinds,
    field(t('Email'), email),
    field(t('Password'), pass, t('It is never saved: it is only used to obtain a session token.')),
    account ? null : field(t('Name'), label),
    h('label', { class: 'check' }, remember, h('span', null, t('Remember me on this browser'), ' ',
      h('small', null, t('Saves the session token permanently. It can be read by anyone using this browser and by any other page on the same domain: turn it on only on a device of your own. If off, once the tab is closed nothing is left in this browser (no token, email or backup).')))),
    err,
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onClick: () => close(false) }, t('Cancel')), submit));

    return h('div', { class: 'dialog-body' }, dialogHeader(account ? t('Sign in again to {name}', { name: account.label }) : t('Add account'), close), form);
  }, { label: t('Sign-in') });
}

export function promptDialog({ title, value = '', label = t('Name'), confirm = t('Save') }) {
  return dialog((close) => {
    const input = h('input', { type: 'text', value, maxlength: 40, autofocus: true });
    return h('form', { class: 'dialog-body', onSubmit: (e) => { e.preventDefault(); close(input.value); } },
      dialogHeader(title, close),
      h('div', { class: 'dialog-content form' }, field(label, input)),
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onClick: () => close(undefined) }, t('Cancel')),
        h('button', { type: 'submit', class: 'btn primary' }, confirm)));
  }, { label: title });
}

// ---------- installa da URL ----------
const status = (s) => ({
  ok: ['ok', t('Valid manifest')],
  unverified: ['warn', t('Cannot be verified by the browser: only the URL will be added')],
  duplicate: ['muted', t('Already present')],
  error: ['bad', t('Cannot be added')],
})[s];

export function openInstall(panel, { prefill = [] } = {}) {
  return dialog((close) => {
    const meta = new Map(prefill.map((p) => [idOf(p.url), p]));
    const area = h('textarea', { rows: 6, spellcheck: 'false', placeholder: t('Paste one or more manifest URLs (stremio:// too), one per line'), autofocus: true });
    area.value = prefill.map((p) => p.url).join('\n');
    const list = h('ul', { class: 'probe-list' });
    const addBtn = h('button', { type: 'button', class: 'btn primary', disabled: true }, t('Add'));
    const verifyBtn = h('button', { type: 'button', class: 'btn' }, t('Verify'));
    let results = [];
    const picks = new Set();

    const refreshAdd = () => {
      addBtn.disabled = picks.size === 0;
      addBtn.textContent = picks.size ? t('Add {n} addons', { n: picks.size }) : t('Add');
    };
    const renderList = () => {
      list.replaceChildren(...results.map((r, n) => {
        const selectable = r.status === 'ok' || r.status === 'unverified';
        const [cls, text] = status(r.status);
        return h('li', { class: `probe ${cls}` },
          h('input', { type: 'checkbox', disabled: !selectable, checked: picks.has(n), 'aria-label': t('Include'),
            onChange: (e) => { if (e.target.checked) picks.add(n); else picks.delete(n); refreshAdd(); } }),
          h('div', null,
            h('strong', null, r.manifest?.name || hostOf(r.url)),
            str(r.manifest?.version) ? h('span', { class: 'ver' }, ` v${str(r.manifest.version)}`) : null,
            h('div', { class: 'probe-sub' }, hostOf(r.url), ' — ', r.error && r.status !== 'unverified' ? `${text}: ${r.error}` : (r.error ? `${text} (${r.error})` : text))));
      }));
    };

    verifyBtn.addEventListener('click', async () => {
      const urls = extractUrls(area.value);
      if (!urls.length) { toast(t('No valid URL found.'), 'error'); return; }
      verifyBtn.disabled = true;
      verifyBtn.textContent = t('Verifying {n}…', { n: urls.length });
      picks.clear();
      results = await app.probeUrls(urls, panel.kind, new Set(panel.items.map((i) => idOf(i.url))));
      results.forEach((r, n) => { if (r.status === 'ok' || r.status === 'unverified') picks.add(n); });
      renderList();
      refreshAdd();
      verifyBtn.disabled = false;
      verifyBtn.textContent = t('Verify again');
    });

    addBtn.addEventListener('click', () => {
      if (panel.status !== 'ready') { toast(t('The panel is loading or saving: try again in a moment.'), 'error'); return; }
      const items = [...picks].sort((a, b) => a - b).map((n) => {
        const it = app.itemFromProbe(results[n], panel.kind);
        const m = meta.get(idOf(it.url));
        return m && m.enabled === false ? { ...it, enabled: false } : it;
      });
      const fresh = items.filter((i) => !panel.has(i.url));
      if (!panel.insert(fresh)) { toast(t('Cannot add right now: try again.'), 'error'); return; }
      app.notifyPanel(panel);
      toast(t('{n} addons added to the draft of “{title}”. Remember to save.', { n: fresh.length, title: panel.title }), 'ok');
      close(true);
    });

    return h('div', { class: 'dialog-body' },
      dialogHeader(t('Add addons to {title}', { title: panel.title }), close),
      h('div', { class: 'dialog-content' },
        area,
        panel.kind === 'stremio' ? h('p', { class: 'field-hint' }, t('Stremio requires the full manifest: addons the browser cannot download cannot be added.')) : null,
        h('div', { class: 'row-actions' }, verifyBtn),
        list),
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', onClick: () => close(false) }, t('Close')), addBtn));
  }, { wide: true, label: t('Add addons') });
}

// ---------- importa ----------
export function openImport(panel) {
  const input = h('input', { type: 'file', accept: '.json,.txt,application/json,text/plain' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast(t('File too large.'), 'error'); return; }
    const lists = parseImport(await file.text());
    if (!lists.length) { toast(t('No addons found in the file.'), 'error'); return; }
    let pick = lists[0];
    if (lists.length > 1) {
      const idx = await dialog((close) => {
        const sel = h('select', null, ...lists.map((l, n) => h('option', { value: n }, `${l.title} (${l.items.length})`)));
        return h('div', { class: 'dialog-body' }, dialogHeader(t('Which list to import?'), close),
          h('div', { class: 'dialog-content form' }, field(t('List'), sel)),
          h('div', { class: 'dialog-actions' },
            h('button', { type: 'button', class: 'btn', onClick: () => close(undefined) }, t('Cancel')),
            h('button', { type: 'button', class: 'btn primary', onClick: () => close(Number(sel.value)) }, t('Continue'))));
      });
      if (idx === undefined) return;
      pick = lists[idx];
    }
    openInstall(panel, { prefill: pick.items });
  });
  input.click();
}

export function exportPanels(panels, filename) {
  const data = buildExport(panels.map((p) => ({ title: p.title, account: app.accountOf(p)?.label, kind: p.kind, items: p.items })));
  downloadFile(filename, JSON.stringify(data, null, 2));
  toast(t('Backup downloaded. URLs may contain personal keys: keep it safe.'), 'info', 7000);
}

// ---------- sincronizza da... ----------
export function openMirror(dst) {
  const sources = app.panelList().filter((p) => p !== dst && p.status === 'ready' && !p.readOnly);
  if (!sources.length) { toast(t('You need at least one other loaded panel as a source.'), 'error'); return; }
  return dialog((close) => {
    const sel = h('select', null, ...sources.map((p, n) => h('option', { value: n }, app.panelLabel(p))));
    let mode = 'merge';
    const preview = h('div', { class: 'mirror-preview' });
    const apply = h('button', { type: 'button', class: 'btn primary' }, t('Apply to draft'));
    const src = () => sources[Number(sel.value)];

    const render = () => {
      const plan = planMirror(dst.items, src().items, mode);
      const names = (list) => list.slice(0, 6).map(shownName).join(', ') + (list.length > 6 ? `, … (+${list.length - 6})` : '');
      fill(preview,
        h('p', null, h('strong', null, `${plan.add.length}`), ' ', t('to add'), plan.add.length ? `: ${names(plan.add)}` : ''),
        mode === 'mirror' ? h('p', { class: plan.remove.length ? 'warn-text' : '' }, h('strong', null, `${plan.remove.length}`), ' ', t('to remove'), plan.remove.length ? `: ${names(plan.remove)}` : '') : null,
        mode === 'mirror' ? h('p', { class: 'field-hint' }, t('The order will become that of the source. Protected addons stay.')) : null);
      apply.disabled = mode === 'merge' && !plan.add.length;
    };

    const radios = h('div', { class: 'radio-col' },
      ...[['merge', t('Add only the missing ones'), t('Does not touch or remove anything that is already there.')],
        ['mirror', t('Exact mirror'), t('Makes this list identical to the source (same order, extras removed).')]].map(([v, title, desc]) =>
        h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'mode', value: v, checked: v === mode, onChange: () => { mode = v; render(); } }),
          h('span', null, h('strong', null, title), h('small', null, desc)))));
    sel.addEventListener('change', render);

    apply.addEventListener('click', async () => {
      apply.disabled = true;
      apply.textContent = t('Preparing…');
      const r = await app.mirrorInto(dst, src(), mode);
      if (r.locked) { toast(t('The panel is being saved: try again in a moment.'), 'error'); close(false); return; }
      const parts = [t('{n} added', { n: r.added }), mode === 'mirror' ? t('{n} removed', { n: r.removed }) : null].filter(Boolean);
      toast(t('Draft updated ({details}). Remember to save.', { details: parts.join(', ') }), r.failed.length ? 'info' : 'ok');
      if (r.failed.length) toast(t('Not copied: {list}', { list: r.failed.map((f) => `${f.name} (${f.error})`).join('; ') }), 'error');
      close(true);
    });
    render();

    return h('div', { class: 'dialog-body' },
      dialogHeader(t('Sync “{title}”', { title: dst.title }), close),
      h('div', { class: 'dialog-content form' }, field(t('Copy from'), sel), radios, preview),
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', onClick: () => close(false) }, t('Cancel')), apply));
  }, { label: t('Sync') });
}

// ---------- backup ----------
export function openBackups() {
  return dialog((close) => {
    const ready = app.panelList().filter((p) => p.status === 'ready' && !p.readOnly);
    const auto = listBackups();
    const fmt = (ts) => new Date(ts).toLocaleString(locale());
    return h('div', { class: 'dialog-body' },
      dialogHeader(t('Backup'), close),
      h('div', { class: 'dialog-content' },
        h('h3', null, t('Export')),
        h('p', { class: 'field-hint' }, t('Downloads the lists currently loaded (draft included). The file contains the addon URLs, which may include personal keys.')),
        h('div', { class: 'row-actions' },
          h('button', { type: 'button', class: 'btn', disabled: !ready.length, onClick: () => exportPanels(ready, `addon-manager-backup-${new Date().toISOString().slice(0, 10)}.json`) },
            icon('download', 15), ' ', t('Export all lists')),
          h('span', { class: 'field-hint' }, t('To import: panel ⋯ menu → “Import from file”.'))),
        h('h3', null, t('Automatic backups')),
        h('p', { class: 'field-hint' }, t('Before every save, the state you are about to overwrite is kept (in this browser): the last 25.')),
        auto.length
          ? h('ul', { class: 'backup-list' }, ...auto.map((b) => h('li', null,
            h('div', null, h('strong', null, `${b.account || ''} · ${b.title}`), h('small', null, `${fmt(b.ts)} — ${t('{n} addons', { n: b.items.length })}`)),
            h('button', { type: 'button', class: 'btn small', onClick: () => downloadFile(`addon-manager-auto-${b.ts}.json`, JSON.stringify(buildExport([{ title: b.title, account: b.account, kind: b.kind, items: b.items }]), null, 2)) }, icon('download', 14), ' ', t('Download')))))
          : h('p', { class: 'muted' }, t('No automatic backups yet.')),
      ),
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', onClick: () => close() }, t('Close'))));
  }, { wide: true, label: t('Backup') });
}

// ---------- impostazioni ----------
/** Impostazioni dell'app (ingranaggio nella barra): lingua, tema, installazione e dati salvati in questo browser. */
export function openSettings() {
  return dialog((close) => h('div', { class: 'dialog-body' },
    dialogHeader(t('Settings'), close),
    h('div', { class: 'dialog-content' },
      h('h3', null, t('Language')),
      // il dialogo si riapre nella nuova lingua
      languageSection({ onChange: () => { close(); openSettings(); } }),
      h('h3', null, t('Theme')),
      themeSection(),
      h('h3', null, t('Install as an app')),
      installSection(),
      h('h3', null, t('Data in this browser')),
      h('p', { class: 'field-hint' }, t('Signs out of all accounts (invalidating the tokens on the server) and deletes the tokens, backups and settings saved here. Use it on a computer that is not yours or if you fear a token has been exposed.')),
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn danger', onClick: async () => {
        const ok = await confirmDialog({
          title: t('Sign out of everything and delete local data?'), danger: true, confirm: t('Sign out and delete'),
          body: h('p', null, t('Unsaved changes will be lost. The addons on the servers are not touched.')),
        });
        if (!ok) return;
        await app.forgetEverything();
        toast(t('Signed out of all accounts. Local data deleted.'), 'ok');
        close();
      } }, icon('logout', 15), ' ', t('Sign out of everything and delete local data')))),
    h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', onClick: () => close() }, t('Close')))), { wide: true, label: t('Settings') });
}

/** Chiaro / scuro / automatico (segue il sistema). */
function themeSection() {
  const labels = { auto: t('Auto'), light: t('Light'), dark: t('Dark') };
  const icons = { auto: 'monitor', light: 'sun', dark: 'moon' };
  const group = h('div', { class: 'row-actions', role: 'radiogroup', 'aria-label': t('Theme') });
  const render = () => fill(group, ...THEMES.map((mode) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(mode === currentTheme()), class: `btn${mode === currentTheme() ? ' primary' : ''}`, dataset: { theme: mode },
    onClick: () => { setTheme(mode); render(); },
  }, icon(icons[mode], 15), ' ', labels[mode])));
  render();
  return h('div', null, group, h('p', { class: 'field-hint' }, t('Auto follows the light or dark setting of your device.')));
}

// ---------- conferme di salvataggio ----------
const names = (list, max = 8) => h('ul', { class: 'name-list' }, ...list.slice(0, max).map((i) => h('li', null, shownName(i))),
  list.length > max ? h('li', { class: 'muted' }, t('… and {n} more', { n: list.length - max })) : null);

export async function confirmSave(panel, diff) {
  const empty = panel.items.length === 0;
  return !!(await confirmDialog({
    title: empty ? t('Empty the list completely?') : t('Save “{title}”?', { title: panel.title }),
    danger: true,
    confirm: empty ? t('Empty the list') : t('Save and remove'),
    body: h('div', null,
      h('p', null, empty ? (panel.kind === 'nuvio' ? t('The list is empty: ALL the addons of this profile will be deleted.') : t('The list is empty: ALL the addons of this account will be deleted.'))
        : t('{n} addons will be removed from the server:', { n: diff.removed.length })),
      empty ? null : names(diff.removed),
      h('p', { class: 'field-hint' }, t('An automatic backup of the current state is saved before writing.'))),
  }));
}

export async function confirmConflict(panel, remoteItems) {
  const r = await confirmDialog({
    title: t('The list has changed on the server'),
    confirm: t('Merge changes'),
    focus: 'confirm',
    extra: [{ label: t('Reload from server'), value: 'reload' }, { label: t('Overwrite'), value: 'overwrite', danger: true }],
    body: h('div', null,
      h('p', null, t('“{title}” was modified by another device or app after you loaded it (it now has {n} addons).', { title: panel.title, n: remoteItems.length })),
      h('ul', { class: 'name-list' },
        h('li', null, h('strong', null, t('Merge')), ' ', t('(recommended): applies your changes on top of those made elsewhere, without losing any.')),
        h('li', null, h('strong', null, t('Reload')), t(': discards your changes.')),
        h('li', null, h('strong', null, t('Overwrite')), t(': discards the changes made elsewhere.')))),
  });
  return r === true ? 'merge' : r === 'reload' ? 'reload' : r === 'overwrite' ? 'overwrite' : 'cancel';
}

// ---------- lingua ----------
/** Scelta della lingua (Impostazioni e schermata iniziale). `onChange` parte dopo il cambio. */
export function languageSection({ small = false, className = 'row-actions', onChange } = {}) {
  return h('div', { class: className, role: 'radiogroup', 'aria-label': t('Language') },
    ...Object.entries(LANGUAGES).map(([code, l]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(code === getLang()), class: `btn${small ? ' small' : ''}${code === getLang() ? ' primary' : ''}`,
      onClick: () => { if (code !== getLang()) { setLang(code); onChange?.(); } },
    }, l.name)));
}
