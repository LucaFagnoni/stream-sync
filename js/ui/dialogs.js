import { h, icon, dialog, dialogHeader, confirmDialog, toast, downloadFile, kindLogo } from './dom.js';
import * as app from '../app.js';
import { planMirror } from '../model.js';
import { buildExport, parseImport } from '../backup.js';
import { listBackups } from '../store.js';
import { extractUrls, idOf, hostOf, str } from '../util.js';

const field = (label, input, hint) =>
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);

// ---------- login ----------
export function openLogin({ account } = {}) {
  return dialog((close) => {
    let kind = account?.kind || 'stremio';
    const email = h('input', { type: 'email', required: true, autocomplete: 'username', value: account?.email || '', readonly: !!account, placeholder: 'email@esempio.it' });
    const pass = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Password' });
    const label = h('input', { type: 'text', placeholder: 'Facoltativo, es. "Casa" o "Famiglia"', maxlength: 40 });
    const remember = h('input', { type: 'checkbox', checked: account ? account.remember : false });
    const err = h('div', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, account ? 'Accedi di nuovo' : 'Accedi e aggiungi');

    const kinds = h('div', { class: 'kind-picker', role: 'radiogroup', 'aria-label': 'Servizio' });
    const renderKinds = () => {
      kinds.replaceChildren(...['stremio', 'nuvio'].map((k) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(kind === k), class: `kind-card ${k}${kind === k ? ' on' : ''}`,
        disabled: !!account && account.kind !== k,
        onClick: () => { kind = k; renderKinds(); },
      }, h('span', { class: 'kind-card-title' }, kindLogo(k, 22), h('strong', null, k === 'stremio' ? 'Stremio' : 'Nuvio')),
      h('small', null, k === 'stremio' ? 'Account email/password' : 'Account con profili (1–6)'))));
    };
    renderKinds();

    const form = h('form', {
      class: 'dialog-content form',
      onSubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        submit.disabled = true;
        submit.textContent = 'Accesso in corso…';
        try {
          if (account) await app.reauth(account, pass.value, remember.checked);
          else await app.addAccount({ kind, email: email.value, password: pass.value, label: label.value, remember: remember.checked });
          close(true);
        } catch (ex) {
          err.textContent = app.explain(ex);
          submit.disabled = false;
          submit.textContent = account ? 'Accedi di nuovo' : 'Accedi e aggiungi';
        }
      },
    },
    account ? null : kinds,
    field('Email', email),
    field('Password', pass, 'Non viene mai salvata: serve solo a ottenere un token di sessione.'),
    account ? null : field('Nome', label),
    h('label', { class: 'check' }, remember, h('span', null, 'Ricordami su questo browser ',
      h('small', null, 'Salva il token di sessione in modo permanente. È leggibile da chi usa questo browser e da ogni altra pagina dello stesso dominio: attivalo solo su un dispositivo tuo. Se spento, l\'accesso dura finché la scheda resta aperta.'))),
    err,
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onClick: () => close(false) }, 'Annulla'), submit));

    return h('div', { class: 'dialog-body' }, dialogHeader(account ? `Riaccedi a ${account.label}` : 'Aggiungi account', close), form);
  }, { label: 'Accesso' });
}

export function promptDialog({ title, value = '', label = 'Nome', confirm = 'Salva' }) {
  return dialog((close) => {
    const input = h('input', { type: 'text', value, maxlength: 40, autofocus: true });
    return h('form', { class: 'dialog-body', onSubmit: (e) => { e.preventDefault(); close(input.value); } },
      dialogHeader(title, close),
      h('div', { class: 'dialog-content form' }, field(label, input)),
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onClick: () => close(undefined) }, 'Annulla'),
        h('button', { type: 'submit', class: 'btn primary' }, confirm)));
  }, { label: title });
}

// ---------- installa da URL ----------
const STATUS = {
  ok: ['ok', 'Manifest valido'],
  unverified: ['warn', 'Non verificabile dal browser: verrà aggiunto solo l\'URL'],
  duplicate: ['muted', 'Già presente'],
  error: ['bad', 'Non aggiungibile'],
};

export function openInstall(panel, { prefill = [] } = {}) {
  return dialog((close) => {
    const meta = new Map(prefill.map((p) => [idOf(p.url), p]));
    const area = h('textarea', { rows: 6, spellcheck: 'false', placeholder: 'Incolla uno o più URL manifest (anche stremio://), uno per riga', autofocus: true });
    area.value = prefill.map((p) => p.url).join('\n');
    const list = h('ul', { class: 'probe-list' });
    const addBtn = h('button', { type: 'button', class: 'btn primary', disabled: true }, 'Aggiungi');
    const verifyBtn = h('button', { type: 'button', class: 'btn' }, 'Verifica');
    let results = [];
    const picks = new Set();

    const refreshAdd = () => {
      addBtn.disabled = picks.size === 0;
      addBtn.textContent = picks.size ? `Aggiungi ${picks.size} addon` : 'Aggiungi';
    };
    const renderList = () => {
      list.replaceChildren(...results.map((r, n) => {
        const selectable = r.status === 'ok' || r.status === 'unverified';
        const [cls, text] = STATUS[r.status];
        return h('li', { class: `probe ${cls}` },
          h('input', { type: 'checkbox', disabled: !selectable, checked: picks.has(n), 'aria-label': 'Includi',
            onChange: (e) => { if (e.target.checked) picks.add(n); else picks.delete(n); refreshAdd(); } }),
          h('div', null,
            h('strong', null, r.manifest?.name || hostOf(r.url)),
            str(r.manifest?.version) ? h('span', { class: 'ver' }, ` v${str(r.manifest.version)}`) : null,
            h('div', { class: 'probe-sub' }, hostOf(r.url), ' — ', r.error && r.status !== 'unverified' ? `${text}: ${r.error}` : (r.error ? `${text} (${r.error})` : text))));
      }));
    };

    verifyBtn.addEventListener('click', async () => {
      const urls = extractUrls(area.value);
      if (!urls.length) { toast('Nessun URL valido trovato.', 'error'); return; }
      verifyBtn.disabled = true;
      verifyBtn.textContent = `Verifica di ${urls.length}…`;
      picks.clear();
      results = await app.probeUrls(urls, panel.kind, new Set(panel.items.map((i) => idOf(i.url))));
      results.forEach((r, n) => { if (r.status === 'ok' || r.status === 'unverified') picks.add(n); });
      renderList();
      refreshAdd();
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Verifica di nuovo';
    });

    addBtn.addEventListener('click', () => {
      if (panel.status !== 'ready') { toast('Il pannello è in caricamento o salvataggio: riprova tra un attimo.', 'error'); return; }
      const items = [...picks].sort((a, b) => a - b).map((n) => {
        const it = app.itemFromProbe(results[n], panel.kind);
        const m = meta.get(idOf(it.url));
        return m && m.enabled === false ? { ...it, enabled: false } : it;
      });
      const fresh = items.filter((i) => !panel.has(i.url));
      if (!panel.insert(fresh)) { toast('Impossibile aggiungere adesso: riprova.', 'error'); return; }
      app.notifyPanel(panel);
      toast(`${fresh.length} addon aggiunti alla bozza di «${panel.title}». Ricorda di salvare.`, 'ok');
      close(true);
    });

    return h('div', { class: 'dialog-body' },
      dialogHeader(`Aggiungi addon a ${panel.title}`, close),
      h('div', { class: 'dialog-content' },
        area,
        panel.kind === 'stremio' ? h('p', { class: 'field-hint' }, 'Stremio richiede il manifest completo: gli addon che il browser non riesce a scaricare non possono essere aggiunti.') : null,
        h('div', { class: 'row-actions' }, verifyBtn),
        list),
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', onClick: () => close(false) }, 'Chiudi'), addBtn));
  }, { wide: true, label: 'Aggiungi addon' });
}

// ---------- importa ----------
export function openImport(panel) {
  const input = h('input', { type: 'file', accept: '.json,.txt,application/json,text/plain' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('File troppo grande.', 'error'); return; }
    const lists = parseImport(await file.text());
    if (!lists.length) { toast('Nessun addon trovato nel file.', 'error'); return; }
    let pick = lists[0];
    if (lists.length > 1) {
      const idx = await dialog((close) => {
        const sel = h('select', null, ...lists.map((l, n) => h('option', { value: n }, `${l.title} (${l.items.length})`)));
        return h('div', { class: 'dialog-body' }, dialogHeader('Quale lista importare?', close),
          h('div', { class: 'dialog-content form' }, field('Lista', sel)),
          h('div', { class: 'dialog-actions' },
            h('button', { type: 'button', class: 'btn', onClick: () => close(undefined) }, 'Annulla'),
            h('button', { type: 'button', class: 'btn primary', onClick: () => close(Number(sel.value)) }, 'Continua')));
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
  toast('Backup scaricato. Gli URL possono contenere chiavi personali: conservalo con cura.', 'info', 7000);
}

// ---------- sincronizza da... ----------
export function openMirror(dst) {
  const sources = app.panelList().filter((p) => p !== dst && p.status === 'ready' && !p.readOnly);
  if (!sources.length) { toast('Serve almeno un altro pannello caricato come sorgente.', 'error'); return; }
  return dialog((close) => {
    const sel = h('select', null, ...sources.map((p, n) => h('option', { value: n }, app.panelLabel(p))));
    let mode = 'merge';
    const preview = h('div', { class: 'mirror-preview' });
    const apply = h('button', { type: 'button', class: 'btn primary' }, 'Applica alla bozza');
    const src = () => sources[Number(sel.value)];

    const render = () => {
      const plan = planMirror(dst.items, src().items, mode);
      const names = (list) => list.slice(0, 6).map((i) => i.name).join(', ') + (list.length > 6 ? `, … (+${list.length - 6})` : '');
      preview.replaceChildren(
        h('p', null, h('strong', null, `${plan.add.length}`), ' da aggiungere', plan.add.length ? `: ${names(plan.add)}` : ''),
        mode === 'mirror' ? h('p', { class: plan.remove.length ? 'warn-text' : '' }, h('strong', null, `${plan.remove.length}`), ' da rimuovere', plan.remove.length ? `: ${names(plan.remove)}` : '') : null,
        mode === 'mirror' ? h('p', { class: 'field-hint' }, 'L\'ordine diventerà quello della sorgente. Gli addon protetti restano.') : null);
      apply.disabled = mode === 'merge' && !plan.add.length;
    };

    const radios = h('div', { class: 'radio-col' },
      ...[['merge', 'Aggiungi solo i mancanti', 'Non tocca né rimuove nulla di ciò che c\'è già.'],
        ['mirror', 'Specchio esatto', 'Rende questa lista identica alla sorgente (stesso ordine, extra rimossi).']].map(([v, t, d]) =>
        h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'mode', value: v, checked: v === mode, onChange: () => { mode = v; render(); } }),
          h('span', null, h('strong', null, t), h('small', null, d)))));
    sel.addEventListener('change', render);

    apply.addEventListener('click', async () => {
      apply.disabled = true;
      apply.textContent = 'Preparazione…';
      const r = await app.mirrorInto(dst, src(), mode);
      if (r.locked) { toast('Il pannello è in salvataggio: riprova tra un attimo.', 'error'); close(false); return; }
      const parts = [`${r.added} aggiunti`, mode === 'mirror' ? `${r.removed} rimossi` : null].filter(Boolean);
      toast(`Bozza aggiornata (${parts.join(', ')}). Ricorda di salvare.`, r.failed.length ? 'info' : 'ok');
      if (r.failed.length) toast(`Non copiati: ${r.failed.map((f) => `${f.name} (${f.error})`).join('; ')}`, 'error');
      close(true);
    });
    render();

    return h('div', { class: 'dialog-body' },
      dialogHeader(`Sincronizza «${dst.title}»`, close),
      h('div', { class: 'dialog-content form' }, field('Copia da', sel), radios, preview),
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', onClick: () => close(false) }, 'Annulla'), apply));
  }, { label: 'Sincronizza' });
}

// ---------- backup ----------
export function openBackups() {
  return dialog((close) => {
    const ready = app.panelList().filter((p) => p.status === 'ready' && !p.readOnly);
    const auto = listBackups();
    const fmt = (ts) => new Date(ts).toLocaleString();
    return h('div', { class: 'dialog-body' },
      dialogHeader('Backup', close),
      h('div', { class: 'dialog-content' },
        h('h3', null, 'Esporta'),
        h('p', { class: 'field-hint' }, 'Scarica le liste attualmente caricate (bozza inclusa). Il file contiene gli URL degli addon, che possono includere chiavi personali.'),
        h('div', { class: 'row-actions' },
          h('button', { type: 'button', class: 'btn', disabled: !ready.length, onClick: () => exportPanels(ready, `streamsync-backup-${new Date().toISOString().slice(0, 10)}.json`) },
            icon('download', 15), ' Esporta tutte le liste'),
          h('span', { class: 'field-hint' }, 'Per importare: menu ⋯ del pannello → «Importa da file».')),
        h('h3', null, 'Backup automatici'),
        h('p', { class: 'field-hint' }, 'Prima di ogni salvataggio viene conservato (in questo browser) lo stato che stai per sovrascrivere: ultimi 25.'),
        auto.length
          ? h('ul', { class: 'backup-list' }, ...auto.map((b) => h('li', null,
            h('div', null, h('strong', null, `${b.account || ''} · ${b.title}`), h('small', null, `${fmt(b.ts)} — ${b.items.length} addon`)),
            h('button', { type: 'button', class: 'btn small', onClick: () => downloadFile(`streamsync-auto-${b.ts}.json`, JSON.stringify(buildExport([{ title: b.title, account: b.account, kind: b.kind, items: b.items }]), null, 2)) }, icon('download', 14), ' Scarica'))))
          : h('p', { class: 'muted' }, 'Ancora nessun backup automatico.'),
        h('h3', null, 'Dati in questo browser'),
        h('p', { class: 'field-hint' }, 'Esce da tutti gli account (invalidando i token sul server) e cancella token, backup e impostazioni salvati qui. Da usare su un computer non tuo o se temi che un token sia stato esposto.'),
        h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn danger', onClick: async () => {
          const ok = await confirmDialog({
            title: 'Uscire da tutto e cancellare i dati locali?', danger: true, confirm: 'Esci e cancella',
            body: h('p', null, 'Le modifiche non salvate andranno perse. Gli addon sui server non vengono toccati.'),
          });
          if (!ok) return;
          await app.forgetEverything();
          toast('Disconnesso da tutti gli account. Dati locali cancellati.', 'ok');
          close();
        } }, icon('logout', 15), ' Esci da tutto e cancella i dati locali'))),
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', onClick: () => close() }, 'Chiudi')));
  }, { wide: true, label: 'Backup' });
}

// ---------- conferme di salvataggio ----------
const names = (list, max = 8) => h('ul', { class: 'name-list' }, ...list.slice(0, max).map((i) => h('li', null, i.name)),
  list.length > max ? h('li', { class: 'muted' }, `… e altri ${list.length - max}`) : null);

export async function confirmSave(panel, diff) {
  const empty = panel.items.length === 0;
  return !!(await confirmDialog({
    title: empty ? 'Svuotare completamente la lista?' : `Salvare «${panel.title}»?`,
    danger: true,
    confirm: empty ? 'Svuota la lista' : 'Salva e rimuovi',
    body: h('div', null,
      h('p', null, empty ? 'La lista è vuota: verranno cancellati TUTTI gli addon di questo ' + (panel.kind === 'nuvio' ? 'profilo.' : 'account.')
        : `Verranno rimossi ${diff.removed.length} addon dal server:`),
      empty ? null : names(diff.removed),
      h('p', { class: 'field-hint' }, 'Prima di scrivere viene salvato un backup automatico dello stato attuale.')),
  }));
}

export async function confirmConflict(panel, remoteItems) {
  const r = await confirmDialog({
    title: 'La lista è cambiata sul server',
    confirm: 'Unisci le modifiche',
    focus: 'confirm',
    extra: [{ label: 'Ricarica dal server', value: 'reload' }, { label: 'Sovrascrivi', value: 'overwrite', danger: true }],
    body: h('div', null,
      h('p', null, `«${panel.title}» è stata modificata da un altro dispositivo o app dopo che l'hai caricata (ora ha ${remoteItems.length} addon).`),
      h('ul', { class: 'name-list' },
        h('li', null, h('strong', null, 'Unisci'), ' (consigliato): applica le tue modifiche sopra quelle fatte altrove, senza perderne nessuna.'),
        h('li', null, h('strong', null, 'Ricarica'), ': scarta le tue modifiche.'),
        h('li', null, h('strong', null, 'Sovrascrivi'), ': scarta le modifiche fatte altrove.'))),
  });
  return r === true ? 'merge' : r === 'reload' ? 'reload' : r === 'overwrite' ? 'overwrite' : 'cancel';
}
