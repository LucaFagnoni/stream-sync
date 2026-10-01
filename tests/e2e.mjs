// Test end-to-end: Chromium reale contro mock di api.strem.io, api.nuvio.tv e host addon.
// Esecuzione: `npm run test:e2e` (richiede Playwright e Chromium installati).
import { serve } from '../scripts/serve.mjs';

const pw = await import('playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.mjs'));
const { chromium } = pw.default?.chromium ? pw.default : pw;

const PORT = 8123;
const APP = `http://localhost:${PORT}/`;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

// ---------- mock dei backend ----------
const manifestOf = (host, name, extra = {}) => ({ id: `test.${host}`, name, version: '1.0.0', description: `${name} description`, resources: ['catalog', 'stream'], types: ['movie', 'series'], catalogs: [], ...extra });
const HOSTS = {
  'addon-a.test': manifestOf('a', 'Addon A'),
  'addon-b.test': manifestOf('b', 'Addon B', { version: '2.0.0' }),
  'addon-x.test': manifestOf('x', 'Addon X'),
  'addon-y.test': manifestOf('y', 'Addon Y'),
  'addon-new.test': manifestOf('new', 'Addon New'),
  'cinemeta.test': manifestOf('cine', 'Cinemeta'),
  'tio.test': manifestOf('tio', 'Torrentio-like', { behaviorHints: { configurable: true } }),
};
const desc = (host, flags = {}) => ({ transportUrl: `https://${host}/manifest.json`, manifest: HOSTS[host], flags });

function freshDb() {
  return {
    stremio: { authKey: 'SKEY', addons: [desc('cinemeta.test', { protected: true, official: true }), desc('addon-a.test'), desc('addon-b.test')] },
    nuvio: {
      token: 'AT1', refresh: 'RT1',
      profiles: [
        { profile_index: 1, name: 'Main', avatar_color_hex: '#1E88E5', uses_primary_addons: false },
        { profile_index: 2, name: 'Kids', avatar_color_hex: '#FF5722', uses_primary_addons: false },
        { profile_index: 3, name: 'Shared', avatar_color_hex: '#43A047', uses_primary_addons: true },
      ],
      addons: {
        1: [{ url: 'https://addon-x.test/manifest.json', name: 'Addon X', enabled: true, sort_order: 0 }, { url: 'https://addon-y.test/manifest.json', name: null, enabled: true, sort_order: 1 }],
        2: [], 3: [],
      },
    },
  };
}

let db;
const log = [];

async function installMocks(context) {
  await context.route(/https:\/\/api\.strem\.io\/.*/, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = JSON.parse(req.postData() || '{}');
    const method = new URL(req.url()).pathname.split('/').pop();
    log.push({ svc: 'stremio', method, body });
    const json = (o) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(o) });
    if (method === 'login') {
      return body.email === 's@x.it' && body.password === 'pw'
        ? json({ result: { authKey: db.stremio.authKey, user: { _id: 'su1', email: 's@x.it' } } })
        : json({ error: { code: 2, message: 'User not found' } });
    }
    if (body.authKey !== db.stremio.authKey) return json({ error: { code: 1, message: 'Session does not exist' } });
    if (method === 'addonCollectionGet') return json({ result: { addons: db.stremio.addons, lastModified: 'now' } });
    if (method === 'addonCollectionSet') { db.stremio.addons = body.addons; return json({ result: { success: true } }); }
    if (method === 'logout') return json({ result: { success: true } });
    return json({ error: { code: 99, message: 'unknown' } });
  });

  await context.route(/https:\/\/api\.nuvio\.tv\/.*/, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    const h = req.headers();
    log.push({ svc: 'nuvio', method: req.method(), path: url.pathname + url.search, body, auth: h.authorization, apikey: h.apikey });
    const json = (o, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(o) });
    if (url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'password') {
        return body.email === 'n@x.it' && body.password === 'pw'
          ? json({ access_token: db.nuvio.token, refresh_token: db.nuvio.refresh, expires_in: 3600, user: { id: 'nu1', email: 'n@x.it' } })
          : json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400);
      }
      return json({ access_token: db.nuvio.token, refresh_token: db.nuvio.refresh, expires_in: 3600, user: { id: 'nu1', email: 'n@x.it' } });
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: CORS });
    if (h.authorization !== `Bearer ${db.nuvio.token}`) return json({ message: 'JWT expired' }, 401);
    if (url.pathname === '/rest/v1/rpc/sync_pull_profiles') return json(db.nuvio.profiles);
    if (url.pathname === '/rest/v1/addons') {
      const p = Number(url.searchParams.get('profile_id').replace('eq.', ''));
      return json((db.nuvio.addons[p] || []).map((a, i) => ({ id: `id${p}${i}`, ...a })));
    }
    if (url.pathname === '/rest/v1/rpc/sync_push_addons') { db.nuvio.addons[body.p_profile_id] = body.p_addons; return route.fulfill({ status: 204, headers: CORS }); }
    return json({ message: 'unknown' }, 404);
  });

  await context.route(/https:\/\/[a-z-]+\.test\/.*manifest\.json/, (route) => {
    const host = new URL(route.request().url()).host;
    log.push({ svc: 'addon', host });
    return HOSTS[host]
      ? route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(HOSTS[host]) })
      : route.fulfill({ status: 404, headers: CORS, body: 'nope' });
  });
  await context.route(/https:\/\/(blocked|offline)\.test\/.*/, (route) => route.abort('failed'));
}

// ---------- mini framework ----------
const results = [];
async function step(name, fn) {
  try { await fn(); results.push([true, name]); console.log('  ✓', name); }
  catch (e) { results.push([false, name, e]); console.log('  ✗', name, '\n     ', String(e.message).split('\n').slice(0, 4).join('\n      ')); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'asserzione fallita'); };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), `${m || 'diverso'}\n  atteso:  ${JSON.stringify(b)}\n  ottenuto: ${JSON.stringify(a)}`);

// ---------- esecuzione ----------
const server = await serve(PORT);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
await installMocks(context);
db = freshDb();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`console: ${m.text()}`); });

const panel = (label) => page.locator(`section.panel[aria-label="${label}"]`);
const row = (p, name) => p.locator(`.row[aria-label="${name}"]`);
const names = async (p) => p.locator('.row .name').allTextContents();
// Rilascia nello spazio vuoto in fondo alla lista (il centro potrebbe cadere sopra una riga).
const dragToEnd = async (source, panelLoc, opts = {}) => {
  const list = panelLoc.locator('.plist');
  const b = await list.boundingBox();
  await source.dragTo(list, { targetPosition: { x: 40, y: b.height - 12 }, ...opts });
};
// I toast restano visibili alcuni secondi: senza svuotarli, un toast del salvataggio precedente
// farebbe proseguire il test prima che quello nuovo sia finito.
const clearToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
const toast = (re) => page.locator('.toast', { hasText: re }).first();

async function addAccount(kind, email, pass, { remember = true, on = page } = {}) {
  await on.click('#add-account');
  await on.locator(`.kind-card.${kind}`).click();
  await on.fill('dialog input[type=email]', email);
  await on.fill('dialog input[type=password]', pass);
  const box = on.locator('dialog label.check input[type=checkbox]');
  assert(!(await box.isChecked()), '"Ricordami" deve essere spento di default');
  if (remember) await box.check();
  await on.click('dialog button[type=submit]');
}

console.log('\nStreamSync e2e');
await page.goto(APP);
const S = 'Stremio s@x.it';

await step('stato iniziale: schermata vuota con invito ad aggiungere un account', async () => {
  await page.locator('.empty-state').waitFor();
  assert(await page.locator('#save-all').isDisabled(), 'Salva tutto dovrebbe essere disabilitato');
  eq((await page.locator('#save-all').innerText()).trim(), 'Salva tutto', 'il pulsante non deve mostrare "null" o altro testo');
});

await step('desktop: istruzioni per mouse e tastiera (Maiusc, scorciatoia "/"), non quelle per il touch', async () => {
  const tips = await page.locator('.empty-state .tips').innerText();
  assert(/Maiusc/.test(tips) && /Trascina/.test(tips), `testo PC mancante: ${tips}`);
  assert(!/Tocca/.test(tips) && !/⋯/.test(tips), `testo touch visibile su desktop: ${tips}`);
  assert((await page.locator('#search').getAttribute('placeholder')).includes('( / )'), 'manca il suggerimento della scorciatoia');
});

await step('login con credenziali errate mostra un errore in italiano e non aggiunge nulla', async () => {
  await addAccount('stremio', 's@x.it', 'sbagliata');
  await page.locator('.form-error', { hasText: /Account non trovato/ }).waitFor();
  await page.click('dialog button:has-text("Annulla")');
  assert((await page.locator('.chip-acc').count()) === 0);
});

await step('Stremio: login, caricamento lista, Cinemeta protetto', async () => {
  await addAccount('stremio', 's@x.it', 'pw');
  await panel(S).locator('.row').first().waitFor();
  eq(await names(panel(S)), ['Cinemeta', 'Addon A', 'Addon B']);
  assert(await row(panel(S), 'Cinemeta').locator('.badge.lock').count() === 1, 'badge Protetto mancante');
  const get = log.find((l) => l.method === 'addonCollectionGet');
  eq(get.body.authKey, 'SKEY');
});

await step('Nuvio: login, 3 profili, il profilo che condivide gli addon è in sola lettura', async () => {
  await addAccount('nuvio', 'n@x.it', 'pw');
  await panel('Nuvio Main').locator('.row').first().waitFor();
  eq(await names(panel('Nuvio Main')), ['Addon X', 'addon-y.test']);
  assert(await panel('Nuvio Shared').locator('.note', { hasText: /usa gli addon del Profilo 1/ }).count() === 1);
  const sync = log.find((l) => l.path === '/rest/v1/rpc/sync_pull_profiles');
  assert(sync.apikey.startsWith('sb_publishable_'), 'apikey mancante');
  assert(sync.auth === 'Bearer AT1', 'Bearer mancante');
});

await step('spazio tra le linguette degli account e i pannelli (desktop)', async () => {
  const chips = await page.locator('#accounts').boundingBox();
  const first = await page.locator('section.panel').first().boundingBox();
  const gap = Math.round(first.y - (chips.y + chips.height));
  assert(gap >= 20, `spazio troppo stretto: ${gap}px`);
});

await step('nessuna password in localStorage, solo i token di sessione', async () => {
  const dump = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  assert(!dump.includes('"pw"') && !/password/i.test(dump), 'password trovata nello storage!');
  assert(dump.includes('SKEY') && dump.includes('AT1'), 'sessione non persistita');
});

await step('drag & drop Stremio → Nuvio (Kids): copia in bozza, origine intatta, nulla scritto sul server', async () => {
  const pushesBefore = log.filter((l) => l.path?.includes('sync_push')).length;
  await dragToEnd(row(panel(S), 'Addon A'), panel('Nuvio Kids'));
  await row(panel('Nuvio Kids'), 'Addon A').waitFor();
  assert(await row(panel('Nuvio Kids'), 'Addon A').locator('.badge.new').count() === 1, 'badge Nuovo mancante');
  eq(await names(panel(S)), ['Cinemeta', 'Addon A', 'Addon B'], 'origine modificata');
  assert(await panel('Nuvio Kids').locator('.changes', { hasText: '+1' }).count() === 1, 'riepilogo modifiche assente');
  eq(log.filter((l) => l.path?.includes('sync_push')).length, pushesBefore, 'scrittura prematura sul server');
  assert(!(await page.locator('#save-all').isDisabled()), 'Salva tutto dovrebbe attivarsi');
});

await step('"Salva tutto" mostra il numero di liste modificate, senza "null"', async () => {
  eq((await page.locator('#save-all').innerText()).trim(), 'Salva tutto (1)');
});

await step('salvataggio Nuvio: body RPC corretto (sort_order, enabled, nome) e rilettura', async () => {
  await panel('Nuvio Kids').locator('button:has-text("Salva")').click();
  await toast(/Salvato: Kids/).waitFor();
  const push = log.filter((l) => l.path === '/rest/v1/rpc/sync_push_addons').at(-1);
  eq(push.body, { p_profile_id: 2, p_addons: [{ url: 'https://addon-a.test/manifest.json', name: 'Addon A', enabled: true, sort_order: 0 }] });
  assert(await panel('Nuvio Kids').locator('.panel.dirty, .changes').count() === 0, 'la bozza dovrebbe essere pulita dopo il salvataggio');
});

await step('drag & drop Nuvio → Stremio: scarica il manifest e aggiunge il descrittore completo', async () => {
  await dragToEnd(row(panel('Nuvio Main'), 'Addon X'), panel(S));
  await row(panel(S), 'Addon X').waitFor();
  await clearToasts();
  await panel(S).locator('button:has-text("Salva")').click();
  await toast(/Salvato: s@x.it/).waitFor();
  const set = log.filter((l) => l.method === 'addonCollectionSet').at(-1);
  eq(set.body.type, 'AddonCollectionSet');
  eq(set.body.addons.map((a) => a.transportUrl), ['https://cinemeta.test/manifest.json', 'https://addon-a.test/manifest.json', 'https://addon-b.test/manifest.json', 'https://addon-x.test/manifest.json']);
  eq(set.body.addons[3].manifest.name, 'Addon X', 'manifest completo mancante');
  eq(set.body.addons[0].flags, { protected: true, official: true }, 'i flag originali devono restare');
  eq(set.body.addons[3].flags, {}, 'le copie non devono ereditare i flag');
});

await step('trascinando verso il bordo la board scorre fino a un pannello fuori schermo', async () => {
  await page.setViewportSize({ width: 820, height: 900 });
  await page.evaluate(() => { document.getElementById('board').scrollLeft = 0; });
  assert(!(await panel('Nuvio Kids').isVisible()) || (await panel('Nuvio Kids').boundingBox()).x > 820, 'Kids dovrebbe essere fuori schermo');
  const box = await row(panel(S), 'Addon B').boundingBox();
  await page.mouse.move(box.x + 60, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 40, { steps: 3 });
  // 40 px dal bordo: lo scorrimento nativo di Chromium parte solo negli ultimi ~8 px, quindi qui scorre solo grazie all'app
  await page.mouse.move(780, 500, { steps: 10 });
  await page.waitForFunction(() => document.getElementById('board').scrollLeft > 500, null, { timeout: 6000 });
  const list = await panel('Nuvio Kids').locator('.plist').boundingBox();
  assert(list.x < 820, 'Kids non è entrato nello schermo');
  await page.mouse.move(Math.max(list.x + 40, 200), list.y + list.height - 15, { steps: 6 });
  await page.mouse.up();
  await row(panel('Nuvio Kids'), 'Addon B').waitFor();
  await panel('Nuvio Kids').locator('button:has-text("Annulla")').first().click();
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.evaluate(() => { document.getElementById('board').scrollLeft = 0; });
});

await step('finestra stretta: trascinando vicino al bordo inferiore scorre la PAGINA fino a un pannello sotto', async () => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const kids = panel('Nuvio Kids');
  assert((await kids.boundingBox()).y > 700, 'Kids dovrebbe essere sotto lo schermo');
  const box = await row(panel(S), 'Addon B').boundingBox();
  await page.mouse.move(box.x + 60, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 40, { steps: 3 });
  // 30px dal bordo: lo scorrimento nativo di Chromium parte solo negli ultimi ~8px, quindi scorre solo grazie all'app
  await page.mouse.move(200, 670, { steps: 10 });
  await page.waitForFunction(() => document.querySelector('section[aria-label="Nuvio Kids"] .plist').getBoundingClientRect().top < 450, null, { timeout: 15000 });
  await page.mouse.move(200, 500, { steps: 4 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await row(kids, 'Addon B').waitFor();
  await kids.locator('button:has-text("Annulla")').first().click();
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.evaluate(() => { window.scrollTo(0, 0); document.getElementById('board').scrollLeft = 0; });
});

await step('loghi Stremio e Nuvio caricati nelle schede', async () => {
  // I pannelli si ridisegnano spesso (nuovi <img> dalla cache): si attende il caricamento invece di campionare un istante.
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('img.kind-logo')];
    return imgs.length >= 4 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, null, { timeout: 5000 });
  const srcs = await page.evaluate(() => [...new Set([...document.querySelectorAll('img.kind-logo')].map((i) => i.getAttribute('src')))].sort());
  eq(srcs, ['img/nuvio.png', 'img/stremio.png']);
});

await step('riordino con i pulsanti + undo/redo; il salvataggio scrive il nuovo ordine', async () => {
  const p = panel(S);
  await row(p, 'Addon B').locator('button[aria-label="Sposta su"]').click();
  eq(await names(p), ['Cinemeta', 'Addon A', 'Addon B', 'Addon X'].slice(0, 1).concat(['Addon B', 'Addon A', 'Addon X']));
  await p.locator('button[aria-label="Annulla"]').click();
  eq(await names(p), ['Cinemeta', 'Addon A', 'Addon B', 'Addon X'], 'undo');
  await p.locator('button[aria-label="Ripeti"]').click();
  await clearToasts();
  await p.locator('button:has-text("Salva")').click();
  await toast(/Salvato: s@x.it/).waitFor();
  eq(log.filter((l) => l.method === 'addonCollectionSet').at(-1).body.addons.map((a) => a.manifest.name), ['Cinemeta', 'Addon B', 'Addon A', 'Addon X']);
});

await step('riordino da tastiera (Alt+↓)', async () => {
  const p = panel(S);
  await row(p, 'Addon B').focus();
  await page.keyboard.press('Alt+ArrowDown');
  eq(await names(p), ['Cinemeta', 'Addon A', 'Addon B', 'Addon X']);
  await page.keyboard.press('Control+z');
  eq(await names(p), ['Cinemeta', 'Addon B', 'Addon A', 'Addon X'], 'Ctrl+Z');
});

await step('drag & drop dentro lo stesso pannello riordina (trascina Addon X in cima)', async () => {
  const p = panel(S);
  const target = row(p, 'Cinemeta');
  const box = await target.boundingBox();
  await row(p, 'Addon X').dragTo(target, { targetPosition: { x: 60, y: 3 } });
  eq((await names(p))[0], 'Addon X', `posizione dopo il drop (box y=${Math.round(box.y)})`);
  await p.locator('button:has-text("Annulla")').first().click();
  eq(await names(p), ['Cinemeta', 'Addon B', 'Addon A', 'Addon X'], 'annulla tutte le modifiche');
});

await step('addon protetti non rimovibili', async () => {
  const p = panel(S);
  await row(p, 'Cinemeta').locator('button[aria-label="Altre azioni"]').click();
  assert(await page.locator('.menu-item:has-text("Rimuovi")').isDisabled(), 'Rimuovi dovrebbe essere disabilitato');
  await page.keyboard.press('Escape');
  await row(p, 'Cinemeta').focus();
  await page.keyboard.press('Delete');
  await toast(/protetti/).waitFor();
  assert((await names(p)).includes('Cinemeta'));
});

await step('rimozione: richiede conferma elencando gli addon, poi scrive la lista ridotta', async () => {
  const p = panel(S);
  await row(p, 'Addon A').locator('button[aria-label="Altre azioni"]').click();
  await page.click('.menu-item:has-text("Rimuovi")');
  const writes = log.filter((l) => l.method === 'addonCollectionSet').length;
  await p.locator('button:has-text("Salva")').click();
  const dlg = page.locator('dialog[open]');
  await dlg.locator('.name-list li', { hasText: 'Addon A' }).waitFor();
  await page.keyboard.press('Enter'); // il focus è su "Annulla"
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  eq(log.filter((l) => l.method === 'addonCollectionSet').length, writes, 'Invio ha confermato una rimozione!');
  await p.locator('button:has-text("Salva")').click();
  await dlg.locator('.name-list li', { hasText: 'Addon A' }).waitFor();
  await clearToasts();
  await dlg.locator('button:has-text("Salva e rimuovi")').click();
  await toast(/Salvato: s@x.it/).waitFor();
  eq(log.filter((l) => l.method === 'addonCollectionSet').at(-1).body.addons.map((a) => a.manifest.name), ['Cinemeta', 'Addon B', 'Addon X']);
});

await step('conflitto: se il server è cambiato, il salvataggio chiede cosa fare e "Ricarica" non scrive', async () => {
  const p = panel(S);
  await row(p, 'Addon X').locator('button[aria-label="Sposta su"]').click();
  db.stremio.addons = [...db.stremio.addons, desc('addon-y.test')]; // modifica "da un altro dispositivo"
  const writes = log.filter((l) => l.method === 'addonCollectionSet').length;
  await p.locator('button:has-text("Salva")').click();
  const dlg = page.locator('dialog[open]');
  await dlg.locator('h2', { hasText: 'cambiata sul server' }).waitFor();
  await dlg.locator('button:has-text("Ricarica dal server")').click();
  await toast(/ricaricata dal server/).waitFor();
  eq(log.filter((l) => l.method === 'addonCollectionSet').length, writes, 'ha scritto nonostante il conflitto');
  assert((await names(p)).includes('Addon Y'), 'la lista non riflette il server');
});

await step('conflitto + Invio = "Unisci": tiene sia la modifica fatta altrove sia la nostra', async () => {
  const p = panel(S);
  const before = await names(p);
  await row(p, 'Addon X').locator('button[aria-label="Sposta su"]').click(); // nostra modifica
  db.stremio.addons = [...db.stremio.addons, desc('addon-new.test')];        // modifica "altrove"
  await clearToasts();
  await p.locator('button:has-text("Salva")').click();
  await page.locator('dialog[open] h2', { hasText: 'cambiata sul server' }).waitFor();
  await page.keyboard.press('Enter'); // focus sull'azione sicura
  await toast(/Salvato: s@x.it/).waitFor();
  const pushed = log.filter((l) => l.method === 'addonCollectionSet').at(-1).body.addons.map((a) => a.manifest.name);
  assert(pushed.includes('Addon New'), 'persa la modifica fatta altrove');
  const ix = before.indexOf('Addon X');
  assert(pushed.indexOf('Addon X') === ix - 1, `persa la nostra modifica: ${JSON.stringify(pushed)}`);
});

await step('manifest malformato dal server: nessun crash e il descrittore torna intatto al salvataggio', async () => {
  const bad = { transportUrl: 'https://bad.test/manifest.json', transportName: 'http', extra: { keep: true },
    manifest: { id: 'bad', name: 42, types: 'movie', resources: { a: 1 }, version: { x: 1 }, description: ['x'], logo: 'javascript:alert(1)', behaviorHints: { configurable: 'yes' } }, flags: {} };
  db.stremio.addons = [...db.stremio.addons, bad];
  const p = panel(S);
  await p.locator('button[aria-label="Menu pannello"]').click();
  await page.click('.menu-item:has-text("Ricarica dal server")');
  await row(p, '42').waitFor(); // name: 42 -> mostrato come "42"
  await row(p, '42').locator('button[aria-label="Sposta su"]').click();
  await clearToasts();
  await p.locator('button:has-text("Salva")').click();
  await toast(/Salvato: s@x.it/).waitFor();
  const sent = log.filter((l) => l.method === 'addonCollectionSet').at(-1).body.addons.find((a) => a.transportUrl === bad.transportUrl);
  eq(sent, bad, 'descrittore alterato');
});

await step('URL con virgole e pipe (stile Torrentio) salvato identico, non troncato', async () => {
  const url = 'https://tio.test/providers=yts,eztv|qualityfilter=scr,cam|realdebrid=KEY/manifest.json';
  const p = panel('Nuvio Main');
  await p.locator('button[aria-label="Aggiungi da URL"]').click();
  await page.fill('dialog textarea', url);
  await page.click('dialog button:has-text("Verifica")');
  await page.locator('dialog .probe.ok').waitFor();
  await page.locator('dialog button:has-text("Aggiungi 1 addon")').click();
  await clearToasts();
  await p.locator('button:has-text("Salva")').click();
  await toast(/Salvato: Main/).waitFor();
  const push = log.filter((l) => l.path === '/rest/v1/rpc/sync_push_addons').at(-1);
  assert(push.body.p_addons.some((a) => a.url === url), `URL alterato: ${JSON.stringify(push.body.p_addons.map((a) => a.url))}`);
});

await step('link trascinato da fuori (text/uri-list) su un pannello: apre l\'installazione verificata', async () => {
  await page.evaluate(() => {
    const dst = document.querySelector('section[aria-label="Nuvio Kids"]');
    const dt = new DataTransfer();
    dt.setData('text/uri-list', 'stremio://addon-new.test/manifest.json');
    for (const type of ['dragover', 'drop']) dst.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  eq(await page.locator('dialog textarea').inputValue(), 'https://addon-new.test/manifest.json');
  await page.click('dialog button:has-text("Chiudi")');
});

await step('backup automatico creato prima di ogni scrittura', async () => {
  const backups = await page.evaluate(() => JSON.parse(localStorage.getItem('streamsync.backups.v1') || '[]'));
  assert(backups.length >= 4, `attesi ≥4 backup, trovati ${backups.length}`);
  assert(backups[0].items.every((i) => i.url.startsWith('https://')));
});

await step('copia URL del manifest negli appunti (+ link stremio://)', async () => {
  const p = panel(S);
  await row(p, 'Addon B').locator('button[aria-label="Copia URL del manifest"]').click();
  eq(await page.evaluate(() => navigator.clipboard.readText()), 'https://addon-b.test/manifest.json');
  await row(p, 'Addon B').locator('button[aria-label="Altre azioni"]').click();
  await page.click('.menu-item:has-text("stremio://")');
  eq(await page.evaluate(() => navigator.clipboard.readText()), 'stremio://addon-b.test/manifest.json');
});

await step('selezione multipla → "Copia in…" verso Nuvio Main; duplicati saltati', async () => {
  const p = panel(S);
  await row(p, 'Addon B').locator('.sel').check();
  await row(p, 'Addon X').locator('.sel').check();
  await p.locator('.selbar button:has-text("Copia in")').click();
  await page.click('.menu-item:has-text("Main")');
  await toast(/Copiati 1 in «Main».*1 già presenti/).waitFor();
  assert((await names(panel('Nuvio Main'))).includes('Addon B'));
});

await step('Shift+drop = sposta (eventi DragEvent sintetici con shiftKey): rimuove dall\'origine e aggiunge alla destinazione', async () => {
  // Playwright non propaga i modificatori negli eventi di drag nativi: invio gli eventi a mano.
  const src = panel('Nuvio Main');
  await page.evaluate(([srcLabel, dstLabel, name]) => {
    const srcRow = document.querySelector(`section[aria-label="${srcLabel}"] .row[aria-label="${name}"]`);
    const dst = document.querySelector(`section[aria-label="${dstLabel}"]`);
    const r = dst.querySelector('.plist').getBoundingClientRect();
    const fire = (el, type, shiftKey) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, shiftKey, clientX: r.left + 20, clientY: r.bottom - 10, dataTransfer: dt }));
    const dt = new DataTransfer();
    fire(srcRow, 'dragstart', false);
    fire(dst, 'dragover', true);
    fire(dst, 'drop', true);
  }, ['Nuvio Main', 'Nuvio Kids', 'Addon B']);
  await row(panel('Nuvio Kids'), 'Addon B').waitFor();
  assert((await names(src)).indexOf('Addon B') === -1, 'non rimosso dall\'origine');
  // e lo stesso "sposta" dal menu della selezione
  await row(panel('Nuvio Kids'), 'Addon B').locator('.sel').check();
  await panel('Nuvio Kids').locator('.selbar button:has-text("Sposta in")').click();
  await page.click('.menu-item:has-text("Main")');
  await row(src, 'Addon B').waitFor();
  assert((await names(panel('Nuvio Kids'))).indexOf('Addon B') === -1, 'non rimosso da Kids');
});

await step('installa da URL: valido, non verificabile (Nuvio) e duplicato', async () => {
  const p = panel('Nuvio Main');
  await p.locator('button[aria-label="Aggiungi da URL"]').click();
  await page.fill('dialog textarea', 'stremio://addon-new.test/manifest.json\nhttps://blocked.test/manifest.json\nhttps://addon-x.test/manifest.json');
  await page.click('dialog button:has-text("Verifica")');
  const dlg = page.locator('dialog[open]');
  await dlg.locator('.probe.ok').waitFor();
  eq(await dlg.locator('.probe').count(), 3);
  assert(await dlg.locator('.probe.warn').count() === 1 && await dlg.locator('.probe.muted').count() === 1, 'stati attesi: 1 ok, 1 non verificabile, 1 duplicato');
  await dlg.locator('button:has-text("Aggiungi 2 addon")').click();
  assert((await names(p)).includes('Addon New'));
});

await step('Stremio rifiuta gli URL non scaricabili (serve il manifest completo)', async () => {
  await panel(S).locator('button[aria-label="Aggiungi da URL"]').click();
  await page.fill('dialog textarea', 'https://blocked.test/manifest.json');
  await page.click('dialog button:has-text("Verifica")');
  await page.locator('dialog .probe.bad').waitFor();
  assert(await page.locator('dialog button:has-text("Aggiungi")').last().isDisabled());
  await page.click('dialog button:has-text("Chiudi")');
});

await step('sincronizza: l\'anteprima della modalità predefinita non contiene "null"', async () => {
  await panel('Nuvio Kids').locator('button[aria-label="Menu pannello"]').click();
  await page.click('.menu-item:has-text("Sincronizza")');
  const dlg = page.locator('dialog[open]');
  await dlg.locator('.mirror-preview').waitFor();
  const text = await dlg.locator('.mirror-preview').innerText();
  assert(!/null/.test(text), `anteprima: ${text}`);
  assert(/da aggiungere/.test(text));
  await dlg.locator('button:has-text("Annulla")').click();
});

await step('sincronizza (specchio) Stremio → Kids: stessa lista e ordine, gli extra vengono rimossi', async () => {
  const kids = panel('Nuvio Kids');
  await kids.locator('button[aria-label="Menu pannello"]').click();
  await page.click('.menu-item:has-text("Sincronizza")');
  const dlg = page.locator('dialog[open]');
  await dlg.locator('select').selectOption({ label: 'Stremio s@x.it'.replace('Stremio ', '') });
  await dlg.locator('input[value=mirror]').check();
  await dlg.locator('.mirror-preview', { hasText: 'da rimuovere' }).waitFor();
  await dlg.locator('button:has-text("Applica alla bozza")').click();
  await toast(/Bozza aggiornata/).waitFor();
  const srcNames = await names(panel(S));
  eq(await names(kids), srcNames, 'Kids dovrebbe riflettere Stremio');
});

await step('verifica/aggiornamento Stremio: un manifest cambiato lato addon finisce in bozza', async () => {
  HOSTS['addon-b.test'] = manifestOf('b', 'Addon B', { version: '3.0.0' });
  await panel(S).locator('button[aria-label="Menu pannello"]').click();
  await page.click('.menu-item:has-text("Verifica e aggiorna tutti")');
  await toast(/aggiornati nella bozza/).waitFor();
  assert(await row(panel(S), 'Addon B').locator('.badge.upd', { hasText: '2.0.0 → 3.0.0' }).count() === 1, 'badge aggiornamento mancante');
  await clearToasts();
  await panel(S).locator('button:has-text("Salva")').click();
  await toast(/Salvato: s@x.it/).waitFor();
  const set = log.filter((l) => l.method === 'addonCollectionSet').at(-1);
  eq(set.body.addons.find((a) => a.manifest.name === 'Addon B').manifest.version, '3.0.0');
});

await step('ricerca filtra tutte le liste e "/" mette il fuoco sulla ricerca', async () => {
  await page.locator('body').click({ position: { x: 5, y: 450 } });
  await page.keyboard.press('/');
  await page.keyboard.type('addon b');
  assert((await page.locator('.row:not([hidden])').count()) >= 1);
  assert((await panel(S).locator('.row:not([hidden]) .name').allTextContents()).every((n) => /addon b/i.test(n)));
  await page.fill('#search', '');
  await page.locator('#search').dispatchEvent('input');
});

await step('screenshot', async () => {
  await page.screenshot({ path: new URL('./.artifacts/board.png', import.meta.url).pathname.replace('/.artifacts/', '/.artifacts/') });
});

await step('ricarica pagina: account ripristinati dal token, senza rifare il login', async () => {
  const loginsBefore = log.filter((l) => l.method === 'login').length;
  await page.reload();
  await panel(S).locator('.row').first().waitFor();
  await panel('Nuvio Main').locator('.row').first().waitFor();
  eq(log.filter((l) => l.method === 'login').length, loginsBefore, 'ha rifatto il login');
});

await step('sessione Stremio scaduta → account in "accesso richiesto", nessun crash', async () => {
  db.stremio.authKey = 'ALTRA';
  await page.reload();
  await page.locator('.account-card .note', { hasText: /Sessione scaduta/ }).waitFor();
  assert(await page.locator('.account-card button:has-text("Accedi")').count() === 1);
  // si riaccede dallo stesso pulsante
  await page.click('.account-card button:has-text("Accedi")');
  await page.fill('dialog input[type=password]', 'pw');
  db.stremio.authKey = 'SKEY';
  await page.click('dialog button[type=submit]');
  await panel(S).locator('.row').first().waitFor();
});

await step('sessione Nuvio: su 401 rinnova il token e riprova in modo trasparente', async () => {
  db.nuvio.token = 'AT2'; db.nuvio.refresh = 'RT2';
  await page.reload();
  await panel('Nuvio Main').locator('.row').first().waitFor();
  const refreshes = log.filter((l) => l.path?.includes('grant_type=refresh_token')).length;
  assert(refreshes >= 1, 'nessun refresh');
  const stored = await page.evaluate(() => localStorage.getItem('streamsync.v1'));
  assert(stored.includes('AT2') && stored.includes('RT2'), 'token rinnovato non persistito');
});

await step('rimozione account Nuvio: logout con scope=local (non chiude le altre sessioni)', async () => {
  await page.locator('.chip-acc.nuvio').click();
  await page.click('.menu-item:has-text("Rimuovi account")');
  await page.locator('dialog button:has-text("Rimuovi")').last().click();
  await page.waitForFunction(() => document.querySelectorAll('section[aria-label^="Nuvio"]').length === 0);
  assert(log.some((l) => l.path === '/auth/v1/logout?scope=local'), 'logout locale non chiamato');
  assert(!log.some((l) => l.path === '/auth/v1/logout'), 'logout globale chiamato!');
});

await step('dentro un iframe altrui (clickjacking) non carica account né chiama le API', async () => {
  const calls = log.length;
  const framer = await context.newPage();
  await framer.setContent(`<iframe src="${APP}" width="800" height="600"></iframe>`);
  await framer.frameLocator('iframe').locator('.framed').waitFor();
  await framer.waitForTimeout(500);
  eq(log.length, calls, 'la pagina incorniciata ha contattato le API');
  await framer.close();
});

await step('"Ricordami" spento: token solo in sessionStorage, sopravvive al reload ma non a una nuova scheda', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
  await installMocks(ctx);
  const tab = await ctx.newPage();
  tab.on('pageerror', (e) => errors.push(`pageerror(tab): ${e.message}`));
  await tab.goto(APP);
  await addAccount('stremio', 's@x.it', 'pw', { remember: false, on: tab });
  await tab.locator('section.panel .row').first().waitFor();
  const local = await tab.evaluate(() => JSON.stringify({ ...localStorage }));
  assert(!local.includes('SKEY'), 'token finito in localStorage');
  await tab.reload();
  await tab.locator('section.panel .row').first().waitFor();
  const other = await ctx.newPage();
  await other.goto(APP);
  await other.locator('.account-card button:has-text("Accedi")').waitFor();
  await ctx.close();
});

// ---------- telefono: contesto mobile con eventi touch reali ----------
let mctx; let mpage; let mcdp;
const mp = (label) => mpage.locator(`section.panel[aria-label="${label}"]`);
// Swipe vero (touchStart/Move/End): la pagina decide chi scorre, come con un dito.
const swipe = async (x, y0, y1, steps = 8) => {
  await mcdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  for (let k = 1; k <= steps; k++) {
    await mcdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * k) / steps }] });
    await mpage.waitForTimeout(16);
  }
  await mcdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};

// Un tap su una pagina che sta ancora scorrendo per inerzia serve a fermarla (come su un telefono vero):
// prima di toccare si aspetta che lo scorrimento sia fermo.
const settle = async () => {
  let last = -1; let stable = 0;
  for (let k = 0; k < 60 && stable < 4; k++) {
    const y = await mpage.evaluate(() => scrollY);
    stable = y === last ? stable + 1 : 0;
    last = y;
    await mpage.waitForTimeout(60);
  }
};

await step('telefono: istruzioni per il tocco (niente Maiusc/Alt/trascina) e ricerca senza scorciatoia', async () => {
  db = freshDb();
  db.stremio.addons = Array.from({ length: 30 }, (_, n) => ({ transportUrl: `https://gen${n}.test/manifest.json`, manifest: manifestOf('g' + n, 'Addon generato ' + n), flags: {} }));
  mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await installMocks(mctx);
  mpage = await mctx.newPage();
  mpage.on('pageerror', (e) => errors.push(`pageerror(telefono): ${e.message}`));
  mpage.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`console(telefono): ${m.text()} @ ${JSON.stringify(m.location())}`); });
  await mpage.goto(APP);
  const tips = await mpage.locator('.empty-state .tips').innerText();
  assert(!/\b(Maiusc|Alt|Ctrl)\b|[Tt]rascin/.test(tips), `testo da PC su telefono: ${tips}`);
  assert(/Copia in…/.test(tips) && /frecce/.test(tips), `istruzioni touch mancanti: ${tips}`);
  eq(await mpage.locator('#search').getAttribute('placeholder'), 'Cerca in tutte le liste');
  const desc = await mpage.locator('.empty-state > p').innerText();
  assert(!/trascina/i.test(desc), `la descrizione parla di trascinare: ${desc}`);
});

await step('telefono: le liste non sono scroller annidati (scorre solo la pagina)', async () => {
  await addAccount('stremio', 's@x.it', 'pw', { remember: false, on: mpage });
  await mpage.locator('section.panel .row').first().waitFor();
  await addAccount('nuvio', 'n@x.it', 'pw', { remember: false, on: mpage });
  await mp('Nuvio Main').locator('.row').first().waitFor();
  const m = await mpage.evaluate(() => {
    const pl = document.querySelector('.plist');
    const board = document.getElementById('board');
    return { overflow: getComputedStyle(pl).overflowY, plist: pl.scrollHeight > pl.clientHeight + 1, board: board.scrollHeight > board.clientHeight + 1, page: document.scrollingElement.scrollHeight > innerHeight + 500 };
  });
  eq(m, { overflow: 'visible', plist: false, board: false, page: true });
});

await step('telefono: uno swipe SOPRA la lista scorre la pagina, anche senza aspettare l\'inerzia, e si raggiungono gli altri account', async () => {
  mcdp = await mctx.newCDPSession(mpage);
  await swipe(200, 700, 250);
  await swipe(200, 700, 250); // subito dopo, mentre l'inerzia del primo non è finita
  const y = await mpage.evaluate(() => scrollY);
  assert(y > 600, `la pagina non ha seguito i due swipe: scrollY=${y}`);
  eq(await mpage.evaluate(() => document.querySelector('.plist').scrollTop), 0, 'la lista ha catturato il gesto');
  let top = Infinity;
  for (let k = 0; k < 25 && top > 600; k++) {
    await swipe(200, 700, 150);
    top = (await mp('Nuvio Main').boundingBox()).y;
  }
  assert(top < 600, `il pannello Nuvio sotto non è stato raggiunto (top=${top})`);
  await settle();
});

await step('telefono: l\'intestazione del pannello resta agganciata in alto mentre si scorre', async () => {
  await mpage.evaluate(() => window.scrollTo(0, 900));
  const r = await mpage.evaluate(() => {
    const el = document.querySelector('section[aria-label^="Stremio"] .pstick');
    return { top: Math.round(el.getBoundingClientRect().top), position: getComputedStyle(el).position };
  });
  eq(r, { top: 0, position: 'sticky' });
});

await step('telefono: spazio tra le linguette e il primo pannello', async () => {
  await mpage.evaluate(() => window.scrollTo(0, 0));
  const chips = await mpage.locator('#accounts').boundingBox();
  const first = await mpage.locator('section.panel').first().boundingBox();
  const gap = Math.round(first.y - (chips.y + chips.height));
  assert(gap >= 20, `spazio troppo stretto: ${gap}px`);
});

await step('telefono: un pannello compresso occupa poco spazio e si riapre', async () => {
  await mpage.evaluate(() => window.scrollTo(0, 0));
  await settle();
  const st = mp('Stremio s@x.it');
  const before = Math.round((await st.boundingBox()).height);
  await st.locator('button[aria-label="Comprimi"]').tap();
  // il click nasce dopo il touchend: si aspetta che il pannello sia davvero compresso prima di misurarlo
  await mpage.waitForFunction(() => document.querySelector('section[aria-label^="Stremio"]').classList.contains('collapsed'), null, { timeout: 5000 });
  const h = Math.round((await st.boundingBox()).height);
  assert(h < 120, `pannello compresso alto ${h}px (da ${before}px)`);
  await st.locator('button[aria-label="Espandi"]').tap();
  await st.locator('.row').first().waitFor();
});

await step('telefono: azioni di riga sempre visibili con bersagli da almeno 36px', async () => {
  const r = await mpage.evaluate(() => {
    const b = document.querySelector('section[aria-label^="Stremio"] .row button[aria-label="Altre azioni"]');
    const box = b.getBoundingClientRect();
    return { w: Math.round(box.width), h: Math.round(box.height), opacity: getComputedStyle(b.closest('.ractions')).opacity };
  });
  assert(r.w >= 36 && r.h >= 36 && r.opacity === '1', JSON.stringify(r));
});

await step('telefono: copia con il tocco (⋯ → Copia in… → Luca/Main)', async () => {
  await settle();
  await mpage.locator('section[aria-label^="Stremio"] .row').nth(2).locator('button[aria-label="Altre azioni"]').tap();
  await mpage.locator('.menu-item:has-text("Copia in…")').tap();
  await mpage.locator('.menu-item:has-text("Main")').tap();
  await mpage.locator('.toast', { hasText: /Copiati 1 in «Main»/ }).waitFor();
  await mp('Nuvio Main').locator('.row', { hasText: 'Addon generato 2' }).waitFor();
});

await step('telefono: barra di selezione su una riga con le parole brevi; "Salva tutto" senza "null"', async () => {
  await mpage.evaluate(() => window.scrollTo(0, 0));
  await settle();
  const sels = mpage.locator('section[aria-label^="Stremio"] .row .sel');
  await sels.nth(0).check();
  await sels.nth(1).check();
  const bar = await mpage.evaluate(() => {
    const b = document.querySelector('section[aria-label^="Stremio"] .selbar');
    const visible = (el) => el.offsetParent !== null;
    return { h: Math.round(b.getBoundingClientRect().height), short: [...b.querySelectorAll('.lbl-s')].filter(visible).map((e) => e.textContent.trim()), full: [...b.querySelectorAll('.lbl')].some(visible) };
  });
  assert(bar.h <= 64, `barra su più righe: ${bar.h}px`);
  eq(bar.short, ['Copia', 'Sposta']);
  assert(!bar.full, 'etichette lunghe ancora visibili');
  await mpage.locator('section[aria-label^="Stremio"] .selbar button[aria-label="Rimuovi"]').tap();
  const text = await mpage.locator('#save-all').textContent();
  assert(!/null/.test(text) && /Salva tutto \(\d\)/.test(text), `testo del pulsante: ${JSON.stringify(text)}`);
  await mctx.close();
});

await step('nessun errore JS / violazione CSP in console', async () => {
  assert(errors.length === 0, errors.join('\n'));
});

await browser.close();
server.close();

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passati`);
process.exit(failed.length ? 1 : 0);
