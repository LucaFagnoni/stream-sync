import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAddonUrl, toManifestUrl, idOf, baseUrl, extractUrls, pLimit } from '../js/util.js';
import { Panel, makeItem, planMirror, applyMirror, diffLists } from '../js/model.js';
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

test('Stremio: descrittori round-trip e transportName solo se richiesto', () => {
  const d = { transportUrl: 'https://a/manifest.json', manifest: { id: 'a', name: 'A' }, flags: { official: true } };
  const item = fromDescriptor(d);
  assert.equal(item.name, 'A');
  assert.deepEqual(toDescriptor(item), d);
  assert.equal(toDescriptor(item, 'http').transportName, 'http');
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
