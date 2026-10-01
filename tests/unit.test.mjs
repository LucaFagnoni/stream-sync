import test from 'node:test';
import vm from 'node:vm';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { parseAddonUrl, toManifestUrl, idOf, baseUrl, extractUrls, pLimit, isHttpUrl, moveInArray } from '../js/util.js';
import { buildExport, parseImport } from '../js/backup.js';
import { detectPlatform } from '../js/install.js';
import { Panel, makeItem, planMirror, applyMirror, diffLists, rebaseOnRemote, mergeThreeWay } from '../js/model.js';
import { convertItem } from '../js/convert.js';
import { fromDescriptor, toDescriptor, getAddons, setAddons, login as stremioLogin, StremioError } from '../js/stremio.js';
import { NuvioSession, NuvioError } from '../js/nuvio.js';

const mk = (url, extra = {}) => makeItem({ url, name: url, ...extra });
const stremioPanel = (urls) => {
  const p = new Panel({ id: 's', kind: 'stremio' });
  p.load(urls.map((u) => mk(u, { manifest: { id: u, name: u, version: '1' } })));
  return p;
};
const nuvioPanel = (urls) => {
  const p = new Panel({ id: 'n', kind: 'nuvio' });
  p.load(urls.map((u) => mk(u)));
  return p;
};

// ---------- util ----------
test('parseAddonUrl accetta stremio://, host nudi, e rifiuta il resto', () => {
  assert.equal(parseAddonUrl('stremio://a.com/x/manifest.json'), 'https://a.com/x/manifest.json');
  assert.equal(parseAddonUrl('a.com/manifest.json'), 'https://a.com/manifest.json');
  assert.equal(parseAddonUrl('javascript:alert(1)'), null);
  assert.equal(parseAddonUrl('ftp://a.com/x'), null);
  assert.equal(parseAddonUrl(''), null);
  assert.equal(parseAddonUrl('nonunurl'), null);
});

test('toManifestUrl aggiunge /manifest.json una sola volta e conserva la query', () => {
  assert.equal(toManifestUrl('https://a.com'), 'https://a.com/manifest.json');
  assert.equal(toManifestUrl('https://a.com/cfg/'), 'https://a.com/cfg/manifest.json');
  assert.equal(toManifestUrl('https://a.com/cfg/manifest.json'), 'https://a.com/cfg/manifest.json');
  assert.equal(toManifestUrl('https://a.com/manifest.json?k=1'), 'https://a.com/manifest.json?k=1');
  assert.equal(toManifestUrl('https://a.com/cfg/manifest.json/'), 'https://a.com/cfg/manifest.json');
});

test('idOf ignora schema stremio, maiuscole, slash finale e /manifest.json', () => {
  const a = idOf('stremio://Example.com/cfg/manifest.json');
  assert.equal(a, idOf('https://example.com/cfg'));
  assert.equal(a, idOf('https://example.com/cfg/'));
  assert.notEqual(a, idOf('https://example.com/other'));
  assert.notEqual(idOf('https://a.com/manifest.json?k=1'), idOf('https://a.com/manifest.json?k=2'));
});

test('baseUrl rimuove manifest.json e query', () => {
  assert.equal(baseUrl('https://a.com/cfg/manifest.json?x=1'), 'https://a.com/cfg');
});

test('extractUrls trova URL in testo libero e JSON, senza duplicati', () => {
  const txt = 'foo https://a.com/manifest.json, stremio://b.com/x\n["https://a.com/manifest.json/"] junk';
  const urls = extractUrls(txt);
  assert.equal(urls.length, 2);
  assert.ok(urls[1].startsWith('https://b.com'));
});

test('pLimit rispetta la concorrenza massima', async () => {
  const limit = pLimit(2);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => limit(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  })));
  assert.equal(peak, 2);
});

// ---------- Panel ----------
test('move: riordino verso il basso e verso l\'alto', () => {
  const p = nuvioPanel(['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com']);
  const [a, b, c, d] = p.items.map((i) => i.key);
  p.move([a], 3); // prima di d
  assert.deepEqual(p.items.map((i) => i.key), [b, c, a, d]);
  p.move([d], 0);
  assert.deepEqual(p.items.map((i) => i.key), [d, b, c, a]);
  p.move([b, c], 4); // in coda, ordine relativo mantenuto
  assert.deepEqual(p.items.map((i) => i.key), [d, a, b, c]);
});

test('move: nessuna modifica se la posizione non cambia (niente voce di undo)', () => {
  const p = nuvioPanel(['https://a.com', 'https://b.com']);
  const [a] = p.items.map((i) => i.key);
  assert.equal(p.move([a], 0), false);
  assert.equal(p.move([a], 1), false);
  assert.equal(p.canUndo, false);
  assert.equal(p.dirty, false);
});

test('undo/redo/discard e stato sporco', () => {
  const p = nuvioPanel(['https://a.com', 'https://b.com']);
  assert.equal(p.dirty, false);
  p.moveBy(p.items[0].key, 1);
  assert.equal(p.dirty, true);
  assert.equal(p.diff.reordered, true);
  p.undo();
  assert.equal(p.dirty, false);
  p.redo();
  assert.equal(p.dirty, true);
  p.discard();
  assert.equal(p.dirty, false);
  assert.equal(p.canUndo, false);
});

test('remove non tocca gli addon protetti di Stremio', () => {
  const p = new Panel({ id: 's', kind: 'stremio' });
  p.load([
    mk('https://cinemeta.com/manifest.json', { manifest: { id: 'c', name: 'Cinemeta' }, flags: { protected: true } }),
    mk('https://x.com/manifest.json', { manifest: { id: 'x', name: 'X' } }),
  ]);
  const r = p.remove(p.items.map((i) => i.key));
  assert.deepEqual(r, { removed: 1, blocked: 1 });
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].flags.protected, true);
});

test('diff conta aggiunti/rimossi/modificati', () => {
  const p = nuvioPanel(['https://a.com', 'https://b.com']);
  p.insert([mk('https://c.com')]);
  p.remove([p.items[0].key]);
  p.patch(p.items[0].key, { name: 'Nuovo nome' });
  const d = p.diff;
  assert.equal(d.added.length, 1);
  assert.equal(d.removed.length, 1);
  assert.equal(d.modified.length, 1);
});

test('Stremio: un manifest aggiornato rende la bozza sporca, un annotate Nuvio no', () => {
  const s = stremioPanel(['https://a.com/manifest.json']);
  s.patch(s.items[0].key, { manifest: { id: 'https://a.com/manifest.json', name: 'a', version: '2' } });
  assert.equal(s.dirty, true);

  const n = nuvioPanel(['https://a.com/manifest.json']);
  n.annotate(n.items[0].key, { manifest: { id: 'a', name: 'a' } });
  assert.equal(n.dirty, false);
  assert.equal(n.canUndo, false);
});

test('setEnabled: no-op se nulla cambia', () => {
  const p = nuvioPanel(['https://a.com']);
  assert.equal(p.setEnabled([p.items[0].key], true), false);
  assert.equal(p.setEnabled([p.items[0].key], false), true);
  assert.equal(p.items[0].enabled, false);
});

test('sortByName ordina senza badare alle maiuscole', () => {
  const p = new Panel({ id: 'n', kind: 'nuvio' });
  p.load([mk('https://1.com', { name: 'beta' }), mk('https://2.com', { name: 'Alpha' }), mk('https://3.com', { name: 'gamma' })]);
  p.sortByName();
  assert.deepEqual(p.items.map((i) => i.name), ['Alpha', 'beta', 'gamma']);
});

// ---------- mirror ----------
test('planMirror / applyMirror: merge aggiunge in coda senza toccare nulla', () => {
  const dst = [mk('https://a.com'), mk('https://x.com')];
  const src = [mk('https://b.com'), mk('https://a.com')];
  const plan = planMirror(dst, src, 'merge');
  assert.equal(plan.add.length, 1);
  assert.equal(plan.remove.length, 0);
  const conv = new Map([[idOf('https://b.com'), mk('https://b.com')]]);
  const out = applyMirror(dst, src, conv, 'merge');
  assert.deepEqual(out.map((i) => idOf(i.url)), ['a.com', 'x.com', 'b.com']);
});

test('applyMirror: mirror replica ordine, riusa gli item esistenti e tiene i protetti', () => {
  const keep = mk('https://keep.com', { flags: { protected: true } });
  const a = mk('https://a.com');
  const dst = [mk('https://x.com'), a, keep];
  const src = [mk('https://b.com'), mk('https://a.com')];
  const plan = planMirror(dst, src, 'mirror');
  assert.deepEqual(plan.remove.map((i) => idOf(i.url)), ['x.com']);
  const conv = new Map([[idOf('https://b.com'), mk('https://b.com')]]);
  const out = applyMirror(dst, src, conv, 'mirror');
  assert.deepEqual(out.map((i) => idOf(i.url)), ['b.com', 'a.com', 'keep.com']);
  assert.equal(out[1], a); // stesso oggetto: conserva flag/manifest dell'originale
});

test('applyMirror: gli item non convertibili vengono saltati', () => {
  const out = applyMirror([], [mk('https://b.com')], new Map(), 'mirror');
  assert.equal(out.length, 0);
});

// ---------- convert ----------
test('convertItem -> nuvio: URL completo, nome dal manifest, nessun flag', async () => {
  const item = mk('https://a.com/cfg', { manifest: { id: 'a', name: 'Bella' }, flags: { protected: true } });
  const r = await convertItem(item, 'nuvio');
  assert.equal(r.url, 'https://a.com/cfg/manifest.json');
  assert.equal(r.name, 'Bella');
  assert.equal(r.isNew, true);
  assert.notEqual(r.key, item.key);
});

test('convertItem -> stremio: scarica il manifest mancante, azzera i flag, propaga errori', async () => {
  const fetcher = async () => ({ ok: true, manifest: { id: 'a', name: 'Scaricato', resources: [] } });
  const r = await convertItem(mk('https://a.com'), 'stremio', { fetcher });
  assert.equal(r.manifest.name, 'Scaricato');
  assert.deepEqual(r.flags, {});
  const bad = async () => ({ ok: false, error: 'HTTP 404' });
  await assert.rejects(convertItem(mk('https://a.com'), 'stremio', { fetcher: bad }), /HTTP 404/);
});

// ---------- Stremio API ----------
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init?.method, headers: init?.headers, body });
    const r = await handler(String(url), body, init);
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => text, json: async () => JSON.parse(text) };
  };
  return calls;
}

test('Stremio: login / get / set usano i body documentati', async () => {
  const calls = stubFetch((url, body) => {
    if (url.endsWith('/login')) return { body: { result: { authKey: 'KEY', user: { _id: 'u1', email: 'a@b.it' } } } };
    if (url.endsWith('/addonCollectionGet')) return { body: { result: { addons: [{ transportUrl: 'https://a/manifest.json', manifest: { id: 'a', name: 'A' }, flags: {} }], lastModified: 'T' } } };
    return { body: { result: { success: true } } };
  });
  const s = await stremioLogin('a@b.it', 'pw');
  assert.equal(s.authKey, 'KEY');
  const g = await getAddons('KEY');
  assert.equal(g.addons.length, 1);
  await setAddons('KEY', [{ transportUrl: 'x' }]);
  assert.deepEqual(calls[0].body, { type: 'Auth', email: 'a@b.it', password: 'pw' });
  assert.deepEqual(calls[1].body, { type: 'AddonCollectionGet', authKey: 'KEY', update: false });
  assert.deepEqual(calls[2].body, { type: 'AddonCollectionSet', authKey: 'KEY', addons: [{ transportUrl: 'x' }] });
  assert.equal(calls[2].url, 'https://api.strem.io/api/addonCollectionSet');
});

test('Stremio: errore 1 = sessione scaduta', async () => {
  stubFetch(() => ({ body: { error: { code: 1, message: 'Session does not exist' } } }));
  await assert.rejects(getAddons('x'), (e) => e instanceof StremioError && e.expired === true);
});

test('Stremio: descrittori round-trip; transportName (template) solo per gli addon nuovi', () => {
  const d = { transportUrl: 'https://a/manifest.json', manifest: { id: 'a', name: 'A' }, flags: { official: true } };
  const item = fromDescriptor(d);
  assert.equal(item.name, 'A');
  assert.deepEqual(toDescriptor(item), d);
  assert.equal(toDescriptor(item, 'http').transportName, undefined, 'non va aggiunto a un descrittore esistente');
  assert.equal(toDescriptor({ url: 'https://n/manifest.json', manifest: { id: 'n', name: 'N' } }, 'http').transportName, 'http');
  assert.throws(() => toDescriptor({ url: 'x', manifest: null }), /Manifest mancante/);
});

// ---------- Nuvio API ----------
const tokenBody = (n) => ({ access_token: `AT${n}`, refresh_token: `RT${n}`, expires_in: 3600, user: { id: 'u', email: 'e@e.it' } });

test('Nuvio: push addons invia sort_order = indice e gli header documentati', async () => {
  const calls = stubFetch(() => ({ status: 204 }));
  const s = new NuvioSession({ access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 1e6 });
  await s.pushAddons(2, [
    { url: 'https://a/manifest.json', name: 'A', enabled: true },
    { url: 'https://b/manifest.json', name: '', enabled: false },
  ]);
  const c = calls[0];
  assert.equal(c.url, 'https://api.nuvio.tv/rest/v1/rpc/sync_push_addons');
  assert.equal(c.headers.Authorization, 'Bearer AT');
  assert.ok(c.headers.apikey.startsWith('sb_publishable_'));
  assert.deepEqual(c.body, {
    p_profile_id: 2,
    p_addons: [
      { url: 'https://a/manifest.json', name: 'A', enabled: true, sort_order: 0 },
      { url: 'https://b/manifest.json', name: null, enabled: false, sort_order: 1 },
    ],
  });
});

test('Nuvio: listAddons filtra per profilo e ordina per sort_order', async () => {
  const calls = stubFetch(() => ({ body: [{ url: 'https://a/manifest.json', name: null, enabled: false, sort_order: 0 }] }));
  const s = new NuvioSession({ access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 1e6 });
  const list = await s.listAddons(3);
  assert.match(calls[0].url, /profile_id=eq\.3&order=sort_order\.asc/);
  assert.equal(list[0].enabled, false);
  assert.equal(list[0].name, 'https://a/manifest.json');
});

test('Nuvio: listProfiles normalizza, ordina e garantisce il profilo 1', async () => {
  stubFetch(() => ({ body: [
    { profile_index: 3, name: ' ', avatar_color_hex: '#fff', uses_primary_addons: true },
    { profile_index: 9, name: 'fuori range' },
  ] }));
  const s = new NuvioSession({ access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 1e6 });
  const p = await s.listProfiles();
  assert.deepEqual(p.map((x) => x.index), [1, 3]);
  assert.equal(p[1].name, 'Profilo 3');
  assert.equal(p[1].usesPrimary, true);
});

test('Nuvio: su 401 rinnova il token una sola volta anche con richieste parallele', async () => {
  let refreshes = 0;
  stubFetch((url, body, init) => {
    if (url.includes('grant_type=refresh_token')) { refreshes++; return { body: tokenBody(2) }; }
    return init.headers.Authorization === 'Bearer AT2' ? { body: [] } : { status: 401, body: { message: 'JWT expired' } };
  });
  let persisted = null;
  const s = new NuvioSession({ access_token: 'AT1', refresh_token: 'RT1', expires_at: Date.now() + 1e6 }, (x) => { persisted = x; });
  await Promise.all([s.listAddons(1), s.listAddons(2), s.listAddons(3)]);
  assert.equal(refreshes, 1);
  assert.equal(persisted.refresh_token, 'RT2');
});

test('Nuvio: se il refresh fallisce l\'errore è "expired"', async () => {
  stubFetch((url) => (url.includes('refresh_token') ? { status: 400, body: { message: 'bad' } } : { status: 401, body: {} }));
  const s = new NuvioSession({ access_token: 'x', refresh_token: 'y', expires_at: Date.now() + 1e6 });
  await assert.rejects(s.listAddons(1), (e) => e instanceof NuvioError && e.expired === true);
});

test('Nuvio: token scaduto in locale -> refresh preventivo', async () => {
  const calls = stubFetch((url) => (url.includes('refresh_token') ? { body: tokenBody(5) } : { body: [] }));
  const s = new NuvioSession({ access_token: 'old', refresh_token: 'r', expires_at: Date.now() - 1 });
  await s.listAddons(1);
  assert.ok(calls[0].url.includes('grant_type=refresh_token'));
  assert.equal(calls[1].headers.Authorization, 'Bearer AT5');
});

test('diffLists è coerente con la firma', () => {
  const a = [mk('https://a.com'), mk('https://b.com')];
  const d = diffLists('nuvio', a, [a[1], a[0]]);
  assert.equal(d.reordered, true);
  assert.equal(d.added.length + d.removed.length + d.modified.length, 0);
});

test('Nuvio: logout usa scope=local (non chiude le altre sessioni)', async () => {
  const calls = stubFetch(() => ({ status: 204 }));
  const s = new NuvioSession({ access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 1e6 });
  await s.logout();
  assert.equal(calls[0].url, 'https://api.nuvio.tv/auth/v1/logout?scope=local');
});

test('Nuvio: il nome fallback (= URL) viene rimandato come null', async () => {
  const calls = stubFetch(() => ({ status: 204 }));
  const s = new NuvioSession({ access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 1e6 });
  await s.pushAddons(1, [{ url: 'https://a/manifest.json', name: 'https://a/manifest.json', enabled: true }]);
  assert.equal(calls[0].body.p_addons[0].name, null);
});


// ---------- regressioni trovate nella revisione di sicurezza/dati ----------
const TORRENTIO = 'https://torrentio.strem.fun/providers=yts,eztv,1337x|qualityfilter=scr,cam|realdebrid=KEY123/manifest.json';

test('extractUrls NON tronca virgole e pipe (configurazioni tipo Torrentio)', () => {
  assert.deepEqual(extractUrls(TORRENTIO), [TORRENTIO]);
  assert.deepEqual(extractUrls(`["${TORRENTIO}"]`), [TORRENTIO]);
  assert.deepEqual(extractUrls(`${TORRENTIO}\nstremio://b.test/manifest.json`), [TORRENTIO, 'https://b.test/manifest.json']);
});

test('extractUrls separa liste con virgola e toglie la punteggiatura finale', () => {
  assert.deepEqual(extractUrls('https://a.test/manifest.json,https://b.test/manifest.json'), ['https://a.test/manifest.json', 'https://b.test/manifest.json']);
  assert.deepEqual(extractUrls('vedi (https://a.test/manifest.json).'), ['https://a.test/manifest.json']);
  assert.deepEqual(extractUrls('# commento uri-list\r\nhttps://a.test/manifest.json\r\n'), ['https://a.test/manifest.json']);
});

test('baseUrl / isHttpUrl rifiutano schemi pericolosi (javascript:, data:)', () => {
  assert.equal(baseUrl('javascript:alert(1)'), null);
  assert.equal(baseUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(isHttpUrl('javascript:alert(1)//https://x.test'), false);
  assert.equal(isHttpUrl('https://x.test/manifest.json'), true);
});

test('makeItem: nome e campi non stringa da manifest malformati non rompono nulla', () => {
  const i = makeItem({ url: 'https://a.test/manifest.json', name: 42, manifest: 'non un oggetto', flags: null });
  assert.equal(i.name, 'https://a.test/manifest.json');
  assert.equal(i.manifest, null);
  assert.deepEqual(i.flags, {});
  const p = new Panel({ id: 'n', kind: 'nuvio' });
  p.load([i, makeItem({ url: 'https://b.test', name: { x: 1 } })]);
  assert.equal(p.sortByName() || true, true); // non lancia
});

test('fromDescriptor conserva il descrittore originale e toDescriptor non perde campi sconosciuti', () => {
  const d = { transportUrl: 'https://a/manifest.json', transportName: 'http', manifest: { id: 'a', name: 'A', types: 'movie' }, flags: { protected: true }, extra: { x: 1 } };
  const back = toDescriptor(fromDescriptor(d), undefined);
  assert.deepEqual(back, d);
  // manifest assente sul server: si rimanda il descrittore com'era invece di bloccare il salvataggio
  const noManifest = { transportUrl: 'https://z/manifest.json', flags: {} };
  assert.deepEqual(toDescriptor(fromDescriptor(noManifest)), noManifest);
});

test('Panel bloccato durante il salvataggio: nessuna modifica silenziosamente persa', () => {
  const p = nuvioPanel(['https://a.test', 'https://b.test']);
  p.status = 'saving';
  assert.equal(p.moveBy(p.items[0].key, 1), false);
  assert.equal(p.insert([mk('https://c.test')]), false);
  assert.deepEqual(p.remove([p.items[0].key]), { removed: 0, blocked: 0 });
  assert.equal(p.undo(), false);
  assert.equal(p.items.length, 2);
  p.status = 'ready';
  assert.equal(p.moveBy(p.items[0].key, 1), true);
});

const smk = (url, version, flags = {}) => makeItem({ url, name: url, manifest: { id: url, name: url, version }, flags });

test('rebaseOnRemote: gli addon non toccati prendono il manifest aggiornato altrove, quelli modificati no', () => {
  const base = [smk('https://a.test/manifest.json', '1'), smk('https://b.test/manifest.json', '1')];
  const draft = [base[1], { ...base[0], manifest: { ...base[0].manifest, version: 'mio' } }]; // riordinati + a modificato da noi
  const remote = [smk('https://a.test/manifest.json', '9'), smk('https://b.test/manifest.json', '2', { official: true })];
  const out = rebaseOnRemote('stremio', base, draft, remote);
  assert.deepEqual(out.map((i) => i.manifest.version), ['2', 'mio']);
  assert.deepEqual(out[0].flags, { official: true });
});

test('mergeThreeWay: conserva le modifiche di entrambe le parti', () => {
  const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map((x) => mk(`https://${x}.test/manifest.json`, { name: x.toUpperCase() }));
  const base = [A, B, C, D];
  // noi: rimuoviamo B, spostiamo D in cima, aggiungiamo E, rinominiamo C
  const draft = [D, A, { ...C, name: 'C mio' }, E];
  // altrove: aggiunto X dopo A, rimosso D (che noi abbiamo solo spostato -> contenuto invariato), rinominato A
  const X = mk('https://x.test/manifest.json', { name: 'X' });
  const remote = [{ ...A, name: 'A remoto' }, X, B, C];
  const out = mergeThreeWay('nuvio', base, draft, remote);
  assert.deepEqual(out.map((i) => i.name), ['A remoto', 'X', 'C mio', 'E']);
});

test('mergeThreeWay: un addon rimosso altrove ma modificato da noi resta (vince la modifica esplicita)', () => {
  const A = mk('https://a.test/manifest.json', { name: 'A' });
  const out = mergeThreeWay('nuvio', [A], [{ ...A, enabled: false }], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].enabled, false);
});

test('mergeThreeWay: stesso addon aggiunto da entrambe le parti non viene duplicato', () => {
  const N = mk('https://n.test/manifest.json');
  const out = mergeThreeWay('nuvio', [], [N], [mk('https://n.test/manifest.json/')]);
  assert.equal(out.length, 1);
});

test('convertItem: l\'addon locale di Stremio (127.0.0.1) non viene copiato su Nuvio', async () => {
  const local = mk('http://127.0.0.1:11470/local-addon/manifest.json', { manifest: { id: 'local', name: 'Local Files' } });
  await assert.rejects(convertItem(local, 'nuvio'), /locale/);
});

test('Nuvio: refresh fallito per rete NON invalida la sessione (non è "expired")', async () => {
  globalThis.fetch = async (url) => { if (String(url).includes('refresh_token')) throw new TypeError('Failed to fetch'); return { ok: false, status: 401, text: async () => '{}' }; };
  const s = new NuvioSession({ access_token: 'x', refresh_token: 'y', expires_at: Date.now() + 1e6 });
  await assert.rejects(s.listAddons(1), (e) => e instanceof NuvioError && e.expired === false);
});

test('Nuvio: se un\'altra scheda ha già ruotato il token, lo adotta senza riusare quello consumato', async () => {
  const seen = [];
  stubFetch((url, body, init) => {
    if (url.includes('refresh_token')) { seen.push(body.refresh_token); return { body: tokenBody(9) }; }
    return init.headers.Authorization === 'Bearer AT-NEW' ? { body: [] } : { status: 401, body: {} };
  });
  const latest = { access_token: 'AT-NEW', refresh_token: 'RT-NEW', expires_at: Date.now() + 1e6 };
  const s = new NuvioSession({ access_token: 'AT-OLD', refresh_token: 'RT-OLD', expires_at: Date.now() + 1e6 }, () => {}, () => latest);
  await s.listAddons(1);
  assert.deepEqual(seen, [], 'non doveva chiamare il refresh con il token vecchio');
  assert.equal(s.session.refresh_token, 'RT-NEW');
});

test('Nuvio: righe di più utenti nello stesso profilo -> errore, niente push ambiguo', async () => {
  stubFetch(() => ({ body: [{ url: 'https://a/manifest.json', user_id: 'u1' }, { url: 'https://b/manifest.json', user_id: 'u2' }] }));
  const s = new NuvioSession({ access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 1e6 });
  await assert.rejects(s.listAddons(1), /più utenti/);
});

// ---------- store: split localStorage / sessionStorage ----------
class MemStorage { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }

test('store: senza "Ricordami" il token va solo in sessionStorage; con, in localStorage', async () => {
  globalThis.localStorage = new MemStorage();
  globalThis.sessionStorage = new MemStorage();
  const store = await import('../js/store.js');
  store.saveStore({
    accounts: [
      { id: 'a', kind: 'stremio', label: 'A', email: 'a@x', remember: false, session: { authKey: 'TEMP' } },
      { id: 'b', kind: 'stremio', label: 'B', email: 'b@x', remember: true, session: { authKey: 'KEEP' } },
    ],
    settings: {},
  });
  const local = localStorage.getItem('streamsync.v1');
  assert.ok(!local.includes('TEMP'), 'token temporaneo finito in localStorage');
  assert.ok(local.includes('KEEP'));
  assert.ok(sessionStorage.getItem('streamsync.sessions.v1').includes('TEMP'));
  const loaded = store.loadStore();
  assert.equal(loaded.accounts.find((x) => x.id === 'a').session.authKey, 'TEMP');
  // chiusura della scheda = sessionStorage vuoto: l'account resta ma senza sessione
  globalThis.sessionStorage = new MemStorage();
  assert.equal(store.loadStore().accounts.find((x) => x.id === 'a').session, null);
});

test('store: i backup di un account rimosso vengono cancellati', async () => {
  globalThis.localStorage = new MemStorage();
  const store = await import('../js/store.js');
  store.pushBackup({ ts: 1, accountId: 'a', items: [] });
  store.pushBackup({ ts: 2, accountId: 'b', items: [] });
  store.deleteBackupsFor('a');
  assert.deepEqual(store.listBackups().map((b) => b.accountId), ['b']);
});

test('parseAddonUrl / toManifestUrl non ricodificano mai l\'URL dell\'utente', () => {
  // Node non ricodifica `|`, Chromium sì (%7C): si verifica con caratteri che anche Node ricodificherebbe.
  const raw = 'https://a.test/cfg={"k":"v"}|x/manifest.json?q=1';
  assert.equal(parseAddonUrl(raw), raw);
  assert.equal(toManifestUrl(raw), raw);
  assert.equal(toManifestUrl('https://a.test/cfg={x}|y'), 'https://a.test/cfg={x}|y/manifest.json');
  assert.equal(parseAddonUrl('stremio://a.test/x|y/manifest.json#frag'), 'https://a.test/x|y/manifest.json');
  assert.equal(parseAddonUrl('https://a.test/con spazio'), null);
});

test('idOf: `|` e `%7C`, `,` e `%2C` indicano lo stesso addon', () => {
  assert.equal(idOf('https://t.test/a,b|c/manifest.json'), idOf('https://t.test/a%2Cb%7Cc/manifest.json'));
  assert.notEqual(idOf('https://t.test/a%2Fb/manifest.json'), idOf('https://t.test/a/b/manifest.json'));
});

test('moveInArray: sposta avanti/indietro, ai bordi, ignora indici non validi e non muta l\'originale', () => {
  assert.deepEqual(moveInArray(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveInArray(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveInArray(['a', 'b', 'c'], 1, 99), ['a', 'c', 'b']);
  assert.deepEqual(moveInArray(['a', 'b', 'c'], 1, -5), ['b', 'a', 'c']);
  assert.deepEqual(moveInArray(['a', 'b'], 5, 0), ['a', 'b']);
  assert.deepEqual(moveInArray(['a', 'b'], -1, 0), ['a', 'b']);
  const src = ['a', 'b'];
  moveInArray(src, 0, 1);
  assert.deepEqual(src, ['a', 'b']);
});

test('backup: l\'esportazione si rilegge e i file della versione precedente (app: "streamsync") restano importabili', () => {
  const items = [{ url: 'https://a.test/x,y|z/manifest.json', name: 'A', enabled: false }];
  const exported = buildExport([{ title: 'Luca', account: 'Famiglia', kind: 'nuvio', items }]);
  assert.equal(exported.app, 'addon-manager');
  const back = parseImport(JSON.stringify(exported));
  assert.deepEqual(back, [{ title: 'Famiglia · Luca', items: [{ url: 'https://a.test/x,y|z/manifest.json', name: 'A', enabled: false }] }]);
  const legacy = { app: 'streamsync', version: 1, lists: [{ title: 'Vecchia', account: 'Casa', addons: [{ url: 'https://b.test/manifest.json', name: 'B', enabled: true }] }] };
  assert.deepEqual(parseImport(JSON.stringify(legacy)), [{ title: 'Casa · Vecchia', items: [{ url: 'https://b.test/manifest.json', name: 'B', enabled: true }] }]);
});

// ---------- installazione come app ----------
test('detectPlatform: iPhone/iPad (anche iPadOS "da Mac"), Safari su Mac, e tutto il resto', () => {
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
  const cases = [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'iPhone', 5, 'ios'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1', 'iPhone', 5, 'ios'],
    [SAFARI, 'MacIntel', 5, 'ios'],        // iPadOS: si presenta come Mac ma ha il touch
    [SAFARI, 'MacIntel', 0, 'mac-safari'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'MacIntel', 0, 'other'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', 'Linux armv8l', 5, 'other'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0', 'Win32', 0, 'other'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0', 'MacIntel', 0, 'other'],
  ];
  for (const [ua, platform, maxTouchPoints, expected] of cases) assert.equal(detectPlatform({ ua, platform, maxTouchPoints }), expected, ua);
  assert.equal(detectPlatform(), 'other');
});

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const swSource = readFileSync(ROOT + 'sw.js', 'utf8');
const SHELL = new Function(`return ${/const SHELL = (\[[\s\S]*?\]);/.exec(swSource)[1]}`)();

const walk = (dir) => readdirSync(ROOT + dir).flatMap((n) => (statSync(ROOT + dir + '/' + n).isDirectory() ? walk(dir + '/' + n) : [dir + '/' + n]));

test('service worker: ogni file elencato esiste, e ogni file di js/ e css/ è nell\'elenco (offline completo)', () => {
  for (const f of SHELL) assert.ok(existsSync(ROOT + (f === './' ? 'index.html' : f)), `nell'elenco ma assente: ${f}`);
  const missing = [...walk('js'), ...walk('css')].filter((f) => !SHELL.includes(f));
  assert.deepEqual(missing, [], `file dell'app non presenti in sw.js (offline incompleto): ${missing}`);
  for (const f of ['manifest.webmanifest', 'img/logo.svg', 'img/stremio.png', 'img/nuvio.png']) assert.ok(SHELL.includes(f), `manca ${f}`);
  assert.ok(!SHELL.includes('index.html'), 'index.html risponde con un reindirizzamento su Cloudflare: si usa "./"');
});

/** Esegue sw.js in un ambiente finto (cache e rete simulate) e permette di inviargli eventi. */
function loadSw(fetchImpl) {
  const handlers = {};
  const stores = new Map(); // nome cache -> Map(url -> Response)
  const key = (r) => new URL(typeof r === 'string' ? r : r.url, 'https://app.test/').href;
  const cacheOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      put: async (req, res) => { m.set(key(req), res.clone()); },
      match: async (req, opts = {}) => {
        const k = key(req);
        if (m.has(k)) return m.get(k).clone();
        if (opts.ignoreSearch) { const u = new URL(k); u.search = ''; return m.get(u.href)?.clone(); }
        return undefined;
      },
      addAll: async (reqs) => { for (const r of reqs) { const res = await fetchImpl(r); if (!res.ok) throw new Error('addAll: ' + res.status); m.set(key(r), res.clone()); } },
    };
  };
  const self = { location: new URL('https://app.test/'), addEventListener: (t, fn) => { handlers[t] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
  const caches = { open: async (n) => cacheOf(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n) };
  class SwRequest extends Request { constructor(u, init) { super(new URL(u, 'https://app.test/').href, init); } }
  vm.runInNewContext(swSource, { self, caches, fetch: fetchImpl, Request: SwRequest, Response, URL, AbortController, setTimeout, clearTimeout, console });
  const waits = [];
  const dispatch = async (request) => {
    let handled = null;
    handlers.fetch({ request, respondWith: (p) => { handled = p; }, waitUntil: (p) => waits.push(p) });
    const response = handled ? await handled : null;
    await Promise.all(waits.splice(0));
    return response;
  };
  return { handlers, stores, dispatch };
}
const navigation = (url) => ({ url, method: 'GET', mode: 'navigate' });
const reply = (body, { type = 'basic', redirected = false, status = 200 } = {}) => {
  const r = new Response(body, { status });
  Object.defineProperty(r, 'type', { value: type });
  Object.defineProperty(r, 'redirected', { value: redirected });
  return r;
};

test('service worker: non tocca richieste di altri domini (API, manifest degli addon) né non-GET', async () => {
  let calls = 0;
  const sw = loadSw(async () => { calls++; return reply('x'); });
  assert.equal(await sw.dispatch(new Request('https://api.strem.io/api/login', { method: 'POST', body: '{}' })), null);
  assert.equal(await sw.dispatch(new Request('https://api.nuvio.tv/rest/v1/addons')), null);
  assert.equal(await sw.dispatch(new Request('https://addon.test/manifest.json')), null);
  assert.equal(await sw.dispatch(new Request('https://app.test/js/app.js', { method: 'POST', body: 'x' })), null);
  assert.equal(calls, 0);
  assert.equal(sw.stores.size, 0, 'nulla deve finire in cache');
});

test('service worker: rete prima (file sempre freschi), poi cache se la rete manca', async () => {
  let version = 'v1'; let online = true;
  const sw = loadSw(async () => { if (!online) throw new TypeError('offline'); return reply(`contenuto ${version}`); });
  const asset = () => new Request('https://app.test/js/app.js');
  assert.equal(await (await sw.dispatch(asset())).text(), 'contenuto v1');
  version = 'v2';
  assert.equal(await (await sw.dispatch(asset())).text(), 'contenuto v2', 'online deve arrivare la versione nuova, non quella in cache');
  online = false;
  assert.equal(await (await sw.dispatch(asset())).text(), 'contenuto v2', 'offline si usa l\'ultima copia scaricata');
  assert.equal(await (await sw.dispatch(new Request('https://app.test/js/app.js?v=3'))).text(), 'contenuto v2', 'la query string non fa mancare la cache');
});

test('service worker: offline una navigazione ricade sulla pagina principale; senza copia è un errore di rete', async () => {
  let online = true;
  const sw = loadSw(async (r) => { if (!online) throw new TypeError('offline'); return reply(new URL(r.url).pathname === '/' ? '<html>app</html>' : 'altro'); });
  await sw.dispatch(navigation('https://app.test/'));
  online = false;
  const nav = await sw.dispatch(navigation('https://app.test/percorso/qualunque'));
  assert.equal(await nav.text(), '<html>app</html>');
  const missing = await sw.dispatch(new Request('https://app.test/js/mai-visto.js'));
  assert.equal(missing.type, 'error');
});

test('service worker: non salva risposte d\'errore né reindirizzate (Chrome le rifiuta per le navigazioni)', async () => {
  const responses = [reply('non trovato', { status: 404 }), reply('reindirizzato', { redirected: true }), reply('opaca', { type: 'cors' })];
  const sw = loadSw(async () => responses.shift());
  for (const path of ['a.js', 'b.js', 'c.js']) await sw.dispatch(new Request('https://app.test/' + path));
  const cache = sw.stores.get('addon-manager-v1');
  assert.equal(cache?.size ?? 0, 0, 'nessuna delle tre risposte doveva essere salvata');
});

test('service worker: installa tutto l\'elenco e all\'attivazione elimina solo le vecchie cache di Addon Manager', async () => {
  const fetched = [];
  const sw = loadSw(async (r) => { fetched.push(new URL(r.url).pathname); return reply('ok'); });
  let installed; sw.handlers.install({ waitUntil: (p) => { installed = p; } });
  await installed;
  assert.equal(fetched.length, SHELL.length);
  assert.ok(sw.stores.get('addon-manager-v1').size === SHELL.length);
  sw.stores.set('addon-manager-v0', new Map());
  sw.stores.set('altra-app', new Map());
  let activated; sw.handlers.activate({ waitUntil: (p) => { activated = p; } });
  await activated;
  assert.deepEqual([...sw.stores.keys()].sort(), ['addon-manager-v1', 'altra-app']);
});
