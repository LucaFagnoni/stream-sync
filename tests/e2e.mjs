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

// Il service worker e l'evento REALE `beforeinstallprompt` renderebbero i test non deterministici (un invito che
// compare a metà test sposta i layout; un service worker intercetta le richieste che i mock devono vedere):
// nei test "generali" si bloccano. I test sull'installazione usano contesti dedicati.
// L'app parte in inglese (US). I test generali girano in italiano (scelta salvata come farebbe un utente):
// le sezioni sulla lingua usano `lang: null` per vedere il comportamento reale della prima visita.
const newContext = async (opts = {}, { sw = false, installPrompt = false, lang = 'it' } = {}) => {
  const ctx = await browser.newContext({ serviceWorkers: sw ? 'allow' : 'block', ...opts });
  if (lang) await ctx.addInitScript((l) => { try { if (localStorage.getItem('addonmanager.lang') === null) localStorage.setItem('addonmanager.lang', l); } catch { /* ignorato */ } }, lang);
  if (!installPrompt) {
    await ctx.addInitScript(() => addEventListener('beforeinstallprompt', (e) => { if (!e.__synthetic) e.stopImmediatePropagation(); }, true));
  }
  await installMocks(ctx);
  return ctx;
};

const context = await newContext({ viewport: { width: 1500, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
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

console.log('\nAddon Manager e2e');
await page.goto(APP);
const S = 'Stremio s@x.it';

await step('stato iniziale: schermata vuota con invito ad aggiungere un account', async () => {
  await page.locator('.empty-state').waitFor();
  assert(await page.locator('#save-all').isDisabled(), 'Salva tutto dovrebbe essere disabilitato');
  eq((await page.locator('#save-all').innerText()).trim(), 'Salva tutto', 'il pulsante non deve mostrare "null" o altro testo');
});

await step('brand: nome, icone e manifest installabile accettati da Chromium (CSP compresa)', async () => {
  eq(await page.title(), 'Addon Manager — Stremio e Nuvio');
  eq((await page.locator('.brand strong').innerText()).trim(), 'Addon Manager');
  assert(!/StreamSync/i.test(await page.locator('body').innerText()), 'resta il vecchio nome nella pagina');
  const links = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('link[rel]')].map((l) => [l.rel + (l.type ? ':' + l.type : ''), l.getAttribute('href')])));
  eq([links.manifest, links['apple-touch-icon']], ['manifest.webmanifest', 'img/apple-touch-icon.png']);
  eq(await page.evaluate(() => [...document.querySelectorAll('link[rel=icon]')].map((l) => l.getAttribute('href'))), ['img/logo.png', 'img/icon-192.png']);
  // Il manifest viene scaricato dal browser (non dalla pagina): se la CSP lo bloccasse, getAppManifest riporterebbe errori
  const cdp = await context.newCDPSession(page);
  const man = await cdp.send('Page.getAppManifest');
  eq(man.errors, [], 'il browser non accetta il manifest');
  const m = JSON.parse(man.data);
  eq([m.name, m.short_name, m.display], ['Addon Manager', 'Addon Manager', 'standalone']);
  eq((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, [], 'l\'app non risulta installabile');
  eq(m.id, '/', 'identità dell\'app instabile');
  assert(m.screenshots.some((x) => x.form_factor === 'wide') && m.screenshots.some((x) => x.form_factor === 'narrow'), 'servono screenshot per computer e telefono');
  for (const icon of [...m.icons, ...m.screenshots]) { // ogni icona/screenshot esiste ed è un PNG della dimensione dichiarata
    const r = await page.request.get(new URL(icon.src, APP).href);
    assert(r.ok() && /image\/png/.test(r.headers()['content-type']), `icona non servita: ${icon.src}`);
    const buf = await r.body();
    eq(`${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`, icon.sizes, icon.src);
  }
  assert(/manifest-src 'self'/.test(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')));
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

// ---------- riordino degli account ----------
const panelOrder = () => page.locator('section.panel').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
const chipOrder = () => page.locator('.chip-wrap .chip-label').allTextContents();
const NUVIO_PANELS = ['Nuvio Main', 'Nuvio Kids', 'Nuvio Shared'];

await step('account: trascinando una linguetta davanti all\'altra cambiano linguette e pannelli (con indicatore) e l\'ordine resta dopo il reload', async () => {
  eq(await chipOrder(), ['s@x.it', 'n@x.it']);
  eq(await panelOrder(), [S, ...NUVIO_PANELS]);
  const c0 = await page.locator('.chip-wrap').nth(0).boundingBox();
  const c1 = await page.locator('.chip-wrap').nth(1).boundingBox();
  await page.mouse.move(c1.x + c1.width / 2, c1.y + c1.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(c0.x + 6, c0.y + c0.height / 2, { steps: 8 });
    // l'emulazione consegna un dragover per ogni movimento: ci si muove ancora un poco sul posto
    for (let k = 0; k < 3; k++) { await page.mouse.move(c0.x + 6 - k, c0.y + c0.height / 2); await page.waitForTimeout(60); }
    await page.locator('.chip-wrap.acct-before').waitFor({ timeout: 3000 }); // l'indicatore mostra dove cadrà
  } finally {
    await page.mouse.up(); // sempre rilasciato: un fallimento non deve lasciare il mouse premuto
  }
  eq(await chipOrder(), ['n@x.it', 's@x.it']);
  eq(await panelOrder(), [...NUVIO_PANELS, S], 'il gruppo dei 3 profili Nuvio deve muoversi insieme');
  eq(await page.locator('.acct-before, .acct-after, .acct-dragging').count(), 0, 'segni di trascinamento rimasti');
  eq(await page.evaluate(() => JSON.parse(localStorage.getItem('streamsync.v1')).accounts.map((a) => a.email)), ['n@x.it', 's@x.it'], 'ordine non salvato');
  await page.reload();
  await panel(S).locator('.row').first().waitFor();
  await panel('Nuvio Main').locator('.row').first().waitFor();
  eq(await chipOrder(), ['n@x.it', 's@x.it'], 'ordine perso dopo il reload');
  eq(await panelOrder(), [...NUVIO_PANELS, S]);
});

await step('account: trascinando l\'intestazione di un pannello si sposta l\'intero account (e si torna indietro)', async () => {
  // Finestra larga: tutti i pannelli sono visibili, così il test non dipende da uno scorrimento della board a metà trascinamento
  await page.setViewportSize({ width: 2000, height: 900 });
  // il pannello Stremio è ora ultimo: lo si porta davanti al gruppo Nuvio (metà sinistra del gruppo)
  await panel(S).locator('.phead').dragTo(panel('Nuvio Main'), { sourcePosition: { x: 90, y: 24 }, targetPosition: { x: 40, y: 300 } });
  eq(await panelOrder(), [S, ...NUVIO_PANELS]);
  eq(await chipOrder(), ['s@x.it', 'n@x.it']);
  // e dall'intestazione di un profilo Nuvio si sposta TUTTO l'account Nuvio dopo Stremio
  await panel('Nuvio Kids').locator('.phead').dragTo(panel(S), { sourcePosition: { x: 90, y: 24 }, targetPosition: { x: 400, y: 300 } });
  eq(await panelOrder(), [S, ...NUVIO_PANELS], 'rilasciare sul lato destro di Stremio lo lascia dove stava (già dopo): ordine invariato');
  await panel(S).locator('.phead').dragTo(panel('Nuvio Shared'), { sourcePosition: { x: 90, y: 24 }, targetPosition: { x: 300, y: 300 } });
  eq(await panelOrder(), [...NUVIO_PANELS, S]);
  await panel(S).locator('.phead').dragTo(panel('Nuvio Main'), { sourcePosition: { x: 90, y: 24 }, targetPosition: { x: 40, y: 300 } });
  eq(await panelOrder(), [S, ...NUVIO_PANELS]);
  await page.setViewportSize({ width: 1500, height: 900 });
});

await step('account: dal menu della linguetta e dei pannelli, e da tastiera (Alt+frecce, focus mantenuto)', async () => {
  await page.locator('.chip-acc').first().click();
  assert(await page.locator('.menu-item:has-text("Sposta prima")').isDisabled(), '"Sposta prima" dovrebbe essere disabilitato sul primo');
  await page.click('.menu-item:has-text("Sposta dopo")');
  eq(await chipOrder(), ['n@x.it', 's@x.it']);
  await page.locator('.chip-acc', { hasText: 's@x.it' }).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  eq(await chipOrder(), ['s@x.it', 'n@x.it']);
  assert(await page.evaluate(() => document.activeElement?.classList.contains('chip-acc') && document.activeElement.textContent.includes('s@x.it')), 'il focus si è perso dopo lo spostamento');
  // dal menu del pannello (un profilo Nuvio sposta l'intero account)
  await panel(S).locator('button[aria-label="Menu pannello"]').click();
  await page.click('.menu-item:has-text("Sposta account dopo")');
  eq(await panelOrder(), [...NUVIO_PANELS, S]);
  await panel('Nuvio Main').locator('button[aria-label="Menu pannello"]').click();
  assert(await page.locator('.menu-item:has-text("Sposta account prima")').isDisabled(), 'Nuvio è già primo');
  await page.click('.menu-item:has-text("Sposta account dopo")');
  eq(await panelOrder(), [S, ...NUVIO_PANELS]);
});

await step('account: le bozze non vanno perse spostando gli account', async () => {
  await row(panel(S), 'Addon B').locator('button[aria-label="Sposta su"]').click();
  const draft = await names(panel(S));
  eq((await page.locator('#save-all').innerText()).trim(), 'Salva tutto (1)');
  await page.locator('.chip-acc').first().click();
  await page.click('.menu-item:has-text("Sposta dopo")');
  eq(await panelOrder(), [...NUVIO_PANELS, S]);
  eq(await names(panel(S)), draft, 'la bozza è cambiata');
  eq((await page.locator('#save-all').innerText()).trim(), 'Salva tutto (1)');
  assert(await panel(S).evaluate((el) => el.classList.contains('dirty')), 'il pannello non risulta più modificato');
  await panel(S).locator('button:has-text("Annulla")').first().click();
  await page.locator('.chip-acc', { hasText: 's@x.it' }).click();
  await page.click('.menu-item:has-text("Sposta prima")');
  eq(await panelOrder(), [S, ...NUVIO_PANELS]);
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
  await page.mouse.move(200, 330, { steps: 4 }); // fuori dalle zone di bordo lo scorrimento si ferma
  await page.waitForTimeout(400);
  const over = await kids.locator('.plist').boundingBox(); // il punto di rilascio segue il pannello, non una coordinata fissa
  await page.mouse.move(200, over.y + over.height / 2, { steps: 4 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await row(kids, 'Addon B').waitFor({ timeout: 5000 });
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

await step("addon protetti: rimovibili solo dopo l'avviso, poi ripristinabili dal vault", async () => {
  const p = panel(S);
  await row(p, 'Cinemeta').focus();
  await page.keyboard.press('Delete');
  const dlg = page.locator('dialog[open]');
  await dlg.locator('text=addon di sistema').first().waitFor();
  await page.keyboard.press('Enter'); // il focus è su "Annulla"
  assert((await names(p)).includes('Cinemeta'), 'annullando resta');
  await row(p, 'Cinemeta').locator('button[aria-label="Altre azioni"]').click();
  await page.click('.menu-item:has-text("Rimuovi")');
  await dlg.locator('button:has-text("Rimuovi comunque")').click();
  await row(p, 'Cinemeta').waitFor({ state: 'detached' }); // confermando viene rimosso
  await p.locator('button[aria-label="Menu pannello"]').click();
  await page.click('.menu-item:has-text("Ripristina addon di sistema")');
  assert(await page.locator('.menu-item:has-text("Cinemeta")').isEnabled(), 'Cinemeta ripristinabile');
  await page.keyboard.press('Escape');
  await p.locator('button:has-text("Annulla")').first().click();
  await row(p, 'Cinemeta').waitFor();
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

await step('"Ricordami" spento: account e token solo in sessionStorage, sopravvivono al reload ma non a una nuova scheda', async () => {
  const ctx = await newContext({ viewport: { width: 1300, height: 800 } });
  const tab = await ctx.newPage();
  tab.on('pageerror', (e) => errors.push(`pageerror(tab): ${e.message}`));
  await tab.goto(APP);
  await addAccount('stremio', 's@x.it', 'pw', { remember: false, on: tab });
  await tab.locator('section.panel .row').first().waitFor();
  const local = await tab.evaluate(() => JSON.stringify({ ...localStorage }));
  assert(!local.includes('SKEY') && !local.includes('s@x.it'), 'token o email finiti in localStorage');
  await tab.reload();
  await tab.locator('section.panel .row').first().waitFor();
  const other = await ctx.newPage();
  await other.goto(APP);
  await other.locator('.empty-state').waitFor(); // nessuna traccia dell'account nelle altre schede
  await ctx.close();
});

// ---------- lingua ----------
// Parole italiane che in una pagina inglese non devono comparire (i nomi propri e i dati dell'utente non sono nell'elenco).
const ITALIAN_WORDS = /\b(?:salva|salvato|salvataggio|aggiungi|aggiungere|rimuovi|annulla|ricarica|account collegati|errore|riprova|accedi|accesso|addon di|nessun|caricamento|connessione|sposta|copia|copiati|bozza|modifiche|lista|liste|cerca|tutte|tutti|non|della|delle|degli|nel|nella|vengono|viene|esci|cancella|installa|ricordami|lingua|trascina|tocca|premi|importa|esporta|sincronizza|verifica|aggiorna|disattiva|attiva|protetto|nuovo|manifest aggiornato)\b/i;
const visibleText = (pg) => pg.evaluate(() => [document.body.innerText, ...[...document.querySelectorAll('[title],[aria-label],[placeholder]')].map((e) => `${e.title} ${e.getAttribute('aria-label')} ${e.getAttribute('placeholder') ?? ''}`)].join('\n'));

let lctx; let lpage;
await step('lingua: alla prima visita l\'app è in inglese (US), qualunque sia la lingua del browser', async () => {
  db = freshDb();
  lctx = await newContext({ viewport: { width: 1300, height: 800 }, locale: 'it-IT' }, { lang: null });
  lpage = await lctx.newPage();
  lpage.on('pageerror', (e) => errors.push(`pageerror(lingua): ${e.message}`));
  await lpage.goto(APP);
  await lpage.locator('.empty-state').waitFor();
  eq(await lpage.evaluate(() => document.documentElement.lang), 'en');
  eq(await lpage.title(), 'Addon Manager — Stremio and Nuvio');
  eq((await lpage.locator('.empty-state h2').innerText()).trim(), 'Manage the addons of all your accounts');
  eq(await lpage.locator('#search').getAttribute('placeholder'), 'Search all lists  ( / )');
  eq(await lpage.locator('#settings').getAttribute('aria-label'), 'Settings');
  assert((await lpage.locator('#theme, #lang').count()) === 0, 'tema e lingua non hanno più un pulsante nella barra');
  const text = await visibleText(lpage);
  assert(!ITALIAN_WORDS.test(text), `parole italiane in una pagina inglese: ${text.match(ITALIAN_WORDS)?.[0]}`);
  eq(await lpage.evaluate(() => localStorage.getItem('addonmanager.lang')), null, 'la lingua predefinita non è una scelta salvata');
});

await step('lingua: con un account collegato tutta l\'interfaccia (barra, pannelli, menu, dialoghi) è in inglese', async () => {
  await addAccount('stremio', 's@x.it', 'pw', { on: lpage });
  await lpage.locator('section.panel .row').first().waitFor();
  await addAccount('nuvio', 'n@x.it', 'pw', { on: lpage });
  await lpage.locator('section.panel[aria-label="Nuvio Kids"]').waitFor();
  const p = lpage.locator('section.panel').first();
  await row(p, 'Addon B').locator('button[aria-label="Move up"]').click();
  await p.locator('input.sel').first().check();
  await lpage.locator('.selbar').waitFor();
  let text = await visibleText(lpage);
  assert(text.includes('Save all (1)') && text.includes('Selection actions') && /Cinemeta[\s\S]*Protected/.test(text), 'testi inglesi attesi nella barra e nelle righe');
  await row(p, 'Addon A').locator('button[aria-label="More actions"]').click();
  text = await lpage.locator('.menu').innerText();
  assert(/Copy manifest URL/.test(text) && /Remove/.test(text) && !ITALIAN_WORDS.test(text), `menu: ${text}`);
  await lpage.keyboard.press('Escape');
  await p.locator('button[aria-label="Panel menu"]').click();
  text = await lpage.locator('.menu').innerText();
  assert(/Add from URL…/.test(text) && /Sync from another panel…/.test(text) && !ITALIAN_WORDS.test(text), `menu pannello: ${text}`);
  await lpage.locator('.menu-item:has-text("Add from URL")').click();
  text = await lpage.locator('dialog').innerText();
  assert(/Add addons to/.test(text) && /Verify/.test(text) && !ITALIAN_WORDS.test(text), `dialogo: ${text}`);
  await lpage.keyboard.press('Escape');
  await p.locator('button:has-text("Save")').first().click();
  await lpage.locator('.toast', { hasText: 'Saved: ' }).waitFor();
  await lpage.click('#backup');
  text = await lpage.locator('dialog').innerText();
  assert(/Automatic backups/.test(text) && /Export all lists/.test(text) && !/Sign out of everything|Install as an app|Language/.test(text) && !ITALIAN_WORDS.test(text), `backup: ${text.slice(0, 300)}`);
  const date = await lpage.locator('.backup-list small').first().innerText();
  assert(/\d{1,2}\/\d{1,2}\/\d{4}/.test(date) && /\bAM|PM\b/.test(date), `data in formato US: ${date}`);
  await lpage.keyboard.press('Escape');
  await lpage.click('#settings');
  text = await lpage.locator('dialog').innerText();
  assert(/Language/.test(text) && /Theme/.test(text) && /Install as an app/.test(text) && /Sign out of everything/.test(text) && !/Automatic backups/.test(text) && !ITALIAN_WORDS.test(text), `impostazioni: ${text.slice(0, 400)}`);
  await lpage.keyboard.press('Escape');
  text = await visibleText(lpage);
  assert(!ITALIAN_WORDS.test(text), `parole italiane: ${text.match(ITALIAN_WORDS)?.[0]}`);
});

await step('lingua: errori del server e dei controlli (login errato) nella lingua scelta', async () => {
  await lpage.click('#add-account');
  await lpage.fill('dialog input[type=email]', 'x@x.it');
  await lpage.fill('dialog input[type=password]', 'sbagliata');
  await lpage.click('dialog button[type=submit]');
  await lpage.locator('dialog .form-error', { hasText: 'Account not found.' }).waitFor();
  await lpage.keyboard.press('Escape');
});

await step('lingua: da Impostazioni (ingranaggio) passa all\'italiano, ridisegna tutto subito e salva la scelta', async () => {
  const draft = lpage.locator('section.panel').first();
  await row(draft, 'Addon A').locator('button[aria-label="Move up"]').click(); // una bozza e una selezione da conservare
  await draft.locator('input.sel').first().check();
  await lpage.click('#settings');
  const dlg = lpage.locator('dialog[open]');
  eq(await dlg.locator('h2').innerText(), 'Settings');
  eq((await dlg.locator('h3').allInnerTexts()).map((x) => x.trim()), ['Language', 'Theme', 'Install as an app', 'Data in this browser']);
  eq((await dlg.locator('[aria-label="Language"] button').allInnerTexts()).map((x) => x.trim()), ['English', 'Italiano']);
  await dlg.locator('[aria-label="Language"] button:has-text("Italiano")').click();
  // il dialogo si riapre già in italiano, con la scelta evidenziata
  await lpage.locator('dialog[open] h2:has-text("Impostazioni")').waitFor();
  eq((await lpage.locator('dialog[open] h3').allInnerTexts()).map((x) => x.trim()), ['Lingua', 'Tema', 'Installa come app', 'Dati in questo browser']);
  await lpage.locator('dialog[open] [role=radio][aria-checked=true]', { hasText: 'Italiano' }).waitFor();
  await lpage.keyboard.press('Escape');
  await lpage.locator('dialog').waitFor({ state: 'detached' });
  eq(await lpage.evaluate(() => document.documentElement.lang), 'it');
  eq(await lpage.title(), 'Addon Manager — Stremio e Nuvio');
  eq(await lpage.locator('#settings').getAttribute('aria-label'), 'Impostazioni');
  eq(await lpage.evaluate(() => localStorage.getItem('addonmanager.lang')), 'it');
  eq(await lpage.locator('#save-all').getAttribute('title'), 'Salva tutto (1 lista modificata)');
  eq(await lpage.locator('#backup').getAttribute('aria-label'), 'Backup');
  eq(await lpage.locator('#add-account').getAttribute('title'), 'Aggiungi account');
  eq(await lpage.locator('#search').getAttribute('placeholder'), 'Cerca in tutte le liste  ( / )');
  eq(await lpage.locator('#accounts').getAttribute('aria-label'), 'Account collegati');
  const p = lpage.locator('section.panel').first();
  assert(await p.locator('button:has-text("Salva")').first().isVisible(), 'il pannello deve essere in italiano senza ricaricare');
  assert(await lpage.locator('section.panel button[aria-label="Sposta su"]').first().count() > 0, 'azioni di riga in italiano');
  assert((await lpage.locator('.chip-acc').first().getAttribute('title')).includes('connesso'), 'stato account in italiano');
  // bozza e selezione non si perdono cambiando lingua
  assert(await lpage.locator('.selbar').isVisible(), 'la selezione resta');
  eq(await lpage.locator('section.panel').first().locator('.row .name').allInnerTexts().then((n) => n.slice(0, 3)), ['Cinemeta', 'Addon A', 'Addon B']);
});

await step('lingua: la scelta resta dopo il ricaricamento e dopo "Esci da tutto"; si può tornare all\'inglese da Impostazioni', async () => {
  await lpage.reload();
  await lpage.locator('section.panel .row').first().waitFor().catch(() => {}); // bozza persa al reload, sessione no
  await lpage.locator('#settings[aria-label="Impostazioni"]').waitFor();
  eq(await lpage.evaluate(() => document.documentElement.lang), 'it');
  await lpage.click('#settings');
  await lpage.locator('dialog [role=radio][aria-checked=true]', { hasText: 'Italiano' }).waitFor();
  await lpage.locator('dialog button:has-text("Esci da tutto")').click();
  await lpage.locator('dialog button:has-text("Esci e cancella")').click();
  await lpage.locator('.empty-state').waitFor();
  eq(await lpage.evaluate(() => localStorage.getItem('addonmanager.lang')), 'it', 'la lingua non è un dato personale: resta');
  eq((await lpage.locator('.empty-state h2').innerText()).trim(), 'Gestisci gli addon di tutti i tuoi account');
  await lpage.click('#settings');
  await lpage.locator('dialog [role=radiogroup] button:has-text("English")').click();
  await lpage.locator('dialog[open] h2:has-text("Settings")').waitFor();
  await lpage.keyboard.press('Escape');
  await lpage.locator('dialog').waitFor({ state: 'detached' });
  eq((await lpage.locator('.empty-state h2').innerText()).trim(), 'Manage the addons of all your accounts');
  eq(await lpage.evaluate(() => localStorage.getItem('addonmanager.lang')), 'en');
  await lpage.reload();
  await lpage.locator('.empty-state').waitFor();
  eq(await lpage.evaluate(() => document.documentElement.lang), 'en', 'scelta "inglese" ricordata');
});

await step('lingua: su telefono la barra resta in una riga (ingranaggio al posto di tema e lingua); la lingua si cambia da Impostazioni e dalla schermata iniziale', async () => {
  const c = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { lang: null });
  const pg = await c.newPage();
  try {
    await pg.goto(APP);
    await pg.locator('.empty-state').waitFor();
    const bar = await pg.evaluate(() => { const b = document.querySelector('.topbar-main'); const kids = [...b.querySelectorAll('.brand, .top-actions > *')].map((e) => e.getBoundingClientRect()); return { h: Math.round(b.getBoundingClientRect().height), right: Math.round(Math.max(...kids.map((r) => r.right))), tops: new Set(kids.map((r) => Math.round(r.top / 10))).size }; });
    assert(bar.h === 54 && bar.right <= 390 - 8 && bar.tops <= 2, `barra in alto affollata: ${JSON.stringify(bar)}`);
    assert(await pg.locator('#settings').isVisible(), 'l\'ingranaggio deve esserci anche sul telefono');
    eq(await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'nessuno sforamento orizzontale');
    eq((await pg.locator('.empty-state h2').innerText()).trim(), 'Manage the addons of all your accounts');
    await pg.locator('.empty-lang button:has-text("Italiano")').tap();
    await pg.locator('.empty-state h2:has-text("Gestisci")').waitFor();
    eq(await pg.evaluate(() => localStorage.getItem('addonmanager.lang')), 'it');
    await pg.locator('.empty-lang button:has-text("English")').tap();
    await pg.locator('.empty-state h2:has-text("Manage")').waitFor();
    await pg.locator('#settings').tap(); // anche dall'ingranaggio, con il tocco
    await pg.locator('dialog[open] [aria-label="Language"] button:has-text("Italiano")').tap();
    await pg.locator('dialog[open] h2:has-text("Impostazioni")').waitFor();
    await pg.locator('dialog[open] [aria-label="Lingua"] button:has-text("English")').tap();
    await pg.locator('dialog[open] h2:has-text("Settings")').waitFor();
    await pg.locator('dialog[open] button:has-text("Close")').last().tap();
    // in inglese, come in italiano: su telefono undo/redo senza cronologia non occupano spazio nell'intestazione
    db = freshDb();
    await addAccount('stremio', 's@x.it', 'pw', { on: pg });
    await pg.locator('section.panel .row').first().waitFor();
    const hidden = await pg.evaluate(() => ['undo', 'redo'].map((a) => getComputedStyle(document.querySelector(`.phead [data-act="${a}"]`)).display));
    eq(hidden, ['none', 'none']);
    eq(await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  } finally { await c.close(); }
});

await step('tema: Auto segue il sistema; Chiaro e Scuro lo forzano; la scelta si salva e si ritrova', async () => {
  const bg = () => lpage.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const theme = () => lpage.evaluate(() => document.documentElement.dataset.theme ?? null);
  const open = async () => { await lpage.click('#settings'); return lpage.locator('dialog[open]'); };
  const pick = async (label) => { const d = await open(); await d.locator(`[aria-label="Theme"] [role=radio]:has-text("${label}")`).click(); await lpage.keyboard.press('Escape'); await lpage.locator('dialog').waitFor({ state: 'detached' }); };
  await lpage.emulateMedia({ colorScheme: 'light' });
  let d = await open();
  eq((await d.locator('[aria-label="Theme"] [role=radio]').allInnerTexts()).map((x) => x.trim()), ['Auto', 'Light', 'Dark']);
  await d.locator('[aria-label="Theme"] [role=radio][aria-checked=true]:has-text("Auto")').waitFor();
  await lpage.keyboard.press('Escape');
  await lpage.locator('dialog').waitFor({ state: 'detached' });
  eq(await theme(), null); const light = await bg();
  await lpage.emulateMedia({ colorScheme: 'dark' });
  const darkSystem = await bg();
  assert(darkSystem !== light, 'Auto deve seguire il sistema scuro');
  await pick('Light');
  eq(await theme(), 'light'); eq(await bg(), light, 'Chiaro forzato anche con il sistema scuro');
  await lpage.emulateMedia({ colorScheme: 'light' });
  await pick('Dark');
  eq(await theme(), 'dark'); eq(await bg(), darkSystem, 'Scuro forzato anche con il sistema chiaro');
  eq(await lpage.evaluate(() => JSON.parse(localStorage.getItem('streamsync.v1')).settings.theme), 'dark');
  await lpage.reload();
  await lpage.locator('.empty-state').waitFor();
  eq(await theme(), 'dark', 'tema ricordato');
  d = await open();
  await d.locator('[aria-label="Theme"] [role=radio][aria-checked=true]:has-text("Dark")').waitFor();
  await d.locator('[aria-label="Theme"] [role=radio]:has-text("Auto")').click();
  await lpage.keyboard.press('Escape');
  eq(await theme(), null);
  await lpage.emulateMedia({ colorScheme: 'light' });
});

await step('lingua: chiusura dei contesti di prova', async () => { await lctx.close(); });

// ---------- attacchi simulati ----------
const SECRET = 'realdebrid=SEGRETO123';
const evilAddons = () => [
  ...freshDb().stremio.addons,
  { transportUrl: `https://evil.test/${SECRET}/manifest.json`, flags: {},
    manifest: { id: 'evil', name: '<img src=x onerror="window.__pwned=1">', version: '"><svg onload="window.__pwned=1">',
      description: '<script>window.__pwned=1</script>', types: ['<b onmouseover="window.__pwned=1">x</b>'], resources: ['stream'], catalogs: [],
      logo: 'https://evil.test/pixel.png" onerror="window.__pwned=1', behaviorHints: { configurable: true } } },
  { transportUrl: 'javascript:window.__pwned=1//https://x.test/manifest.json', flags: {},
    manifest: { id: 'js', name: 'JS', resources: ['stream'], catalogs: [], logo: 'javascript:window.__pwned=1' } },
];
const attackCtx = async () => {
  const ctx = await newContext({ viewport: { width: 1300, height: 800 } });
  const hits = [];
  await ctx.route(/https:\/\/evil\.test\/.*/, (r) => { hits.push(r.request().url()); return r.fulfill({ status: 404, headers: CORS, body: '' }); });
  const tab = await ctx.newPage();
  tab.on('pageerror', (e) => errors.push(`pageerror(attacco): ${e.message}`));
  return { ctx, tab, hits };
};

await step('attacco: HTML/JS nei manifest, nei nomi dei profili, nei colori e negli URL non viene mai eseguito', async () => {
  db = freshDb();
  db.stremio.addons = evilAddons();
  db.nuvio.profiles[0] = { ...db.nuvio.profiles[0], name: '<img src=x onerror="window.__pwned=1">', avatar_color_hex: 'red;background:url(https://evil.test/css)' };
  db.nuvio.addons[1].push({ url: `https://evil.test/${SECRET}/manifest.json`, name: null, enabled: true, sort_order: 2 });
  const { ctx, tab, hits } = await attackCtx();
  try {
    await tab.goto(APP);
    await addAccount('stremio', 's@x.it', 'pw', { on: tab });
    await tab.locator('section.panel .row').nth(4).waitFor();
    await addAccount('nuvio', 'n@x.it', 'pw', { on: tab });
    await tab.locator('section.panel[data-acc] .row').last().waitFor();
    for (const r of await tab.locator('.row').all()) await r.hover(); // eventuali onmouseover
    const evil = tab.locator('.row', { hasText: '<img src=x' }).first();
    await evil.locator('button[aria-label="Altre azioni"]').click();
    await tab.locator('.menu').waitFor();
    await tab.keyboard.press('Escape');
    const r = await tab.evaluate(() => ({
      pwned: window.__pwned ?? null,
      injected: document.querySelectorAll('img[src="x"], body script:not([src]), svg[onload], b[onmouseover]').length,
      jsLinks: [...document.querySelectorAll('[href^="javascript" i], img[src^="javascript" i]')].length,
    }));
    eq(r, { pwned: null, injected: 0, jsLinks: 0 });
    eq(hits.filter((u) => /css|pixel/.test(u)), [], 'richieste di tracciamento partite');
  } finally { await ctx.close(); }
});

await step('attacco: il segreto nell\'URL di un addon non compare a schermo (tooltip, nomi, dialog)', async () => {
  db = freshDb();
  db.nuvio.addons[1].push({ url: `https://evil.test/${SECRET}/manifest.json`, name: null, enabled: true, sort_order: 2 });
  const { ctx, tab } = await attackCtx();
  try {
    await tab.goto(APP);
    await addAccount('nuvio', 'n@x.it', 'pw', { on: tab });
    const main = tab.locator('section.panel[aria-label="Nuvio Main"]');
    await main.locator('.row').nth(2).waitFor();
    const visible = await tab.evaluate(() => [...document.querySelectorAll('[title], [aria-label]')].map((e) => `${e.title} ${e.getAttribute('aria-label')}`).join('\n') + document.body.innerText);
    assert(!visible.includes('SEGRETO123'), 'chiave visibile a schermo o nei tooltip');
    // Rimozione → dialog di conferma con l'elenco dei nomi
    await main.locator('.row').nth(2).locator('input.sel').check();
    await main.locator('button:has-text("Rimuovi")').first().click();
    await main.locator('button:has-text("Salva")').click();
    await tab.locator('dialog').waitFor();
    assert(!(await tab.locator('dialog').innerText()).includes('SEGRETO123'), 'chiave visibile nel dialog di conferma');
    await tab.locator('dialog button:has-text("Annulla")').click();
  } finally { await ctx.close(); }
});

await step('attacco: "Esci da tutto" in una scheda non viene annullato da un\'altra scheda aperta', async () => {
  db = freshDb();
  const { ctx, tab: a } = await attackCtx();
  try {
    await a.goto(APP);
    await addAccount('stremio', 's@x.it', 'pw', { on: a });
    await a.locator('section.panel .row').first().waitFor();
    const b = await ctx.newPage();
    await b.goto(APP);
    await b.locator('section.panel .row').first().waitFor();
    await a.click('#settings');
    await a.locator('dialog button:has-text("Esci da tutto")').click();
    await a.locator('dialog button:has-text("Esci e cancella")').click();
    await a.locator('.empty-state').waitFor();
    // la scheda B fa qualcosa che salva lo stato (es. comprimere un pannello)
    await b.waitForTimeout(300);
    await b.locator('button[aria-label="Comprimi"]').first().click().catch(() => {});
    await b.waitForTimeout(300);
    const stored = await a.evaluate(() => JSON.stringify({ ...localStorage }));
    assert(!/SKEY|s@x\.it/.test(stored), `la scheda B ha riscritto token/email: ${stored.slice(0, 200)}`);
    assert(await b.locator('.empty-state').isVisible(), 'la scheda B mostra ancora l\'account');
  } finally { await ctx.close(); }
});

await step('attacco: account rimosso in una scheda non viene "resuscitato" dall\'altra', async () => {
  db = freshDb();
  const { ctx, tab: a } = await attackCtx();
  try {
    await a.goto(APP);
    await addAccount('stremio', 's@x.it', 'pw', { on: a });
    await a.locator('section.panel .row').first().waitFor();
    const b = await ctx.newPage();
    await b.goto(APP);
    await b.locator('section.panel .row').first().waitFor();
    await a.evaluate(async () => { const app = await import('./js/app.js'); await app.removeAccount(app.state.accounts[0]); });
    await b.waitForTimeout(300);
    await b.locator('button[aria-label="Comprimi"]').first().click().catch(() => {});
    await b.waitForTimeout(300);
    const stored = await a.evaluate(() => localStorage.getItem('streamsync.v1') || '');
    assert(!/SKEY|s@x\.it/.test(stored), `account resuscitato: ${stored.slice(0, 200)}`);
  } finally { await ctx.close(); }
});

await step('attacco: con "Ricordami" spento non resta nulla nel browser dopo la chiusura (email, URL con chiavi nei backup)', async () => {
  db = freshDb();
  db.stremio.addons.push({ transportUrl: `https://addon-x.test/${SECRET}/manifest.json`, manifest: HOSTS['addon-x.test'], flags: {} });
  const { ctx, tab } = await attackCtx();
  try {
    await tab.goto(APP);
    await addAccount('stremio', 's@x.it', 'pw', { remember: false, on: tab });
    const p = tab.locator('section.panel').first();
    await row(p, 'Addon B').locator('button[aria-label="Sposta su"]').click();
    await p.locator('button:has-text("Salva")').click();
    await tab.locator('.toast', { hasText: 'Salvato' }).waitFor();
    const local = await tab.evaluate(() => JSON.stringify({ ...localStorage }));
    assert(!/SEGRETO123|s@x\.it|SKEY/.test(local), `dati persistenti con "Ricordami" spento: ${local.slice(0, 300)}`);
    // nella stessa scheda il backup automatico resta disponibile
    await tab.click('#backup');
    await tab.locator('dialog .backup-list li').first().waitFor();
    await tab.keyboard.press('Escape');
  } finally { await ctx.close(); }
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
  mctx = await newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
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

await step('telefono: l\'intestazione del pannello resta agganciata in alto, sotto la barra, mentre si scorre', async () => {
  await mpage.evaluate(() => window.scrollTo(0, 900));
  const r = await mpage.evaluate(() => {
    const el = document.querySelector('section[aria-label^="Stremio"] .pstick');
    const bar = document.querySelector('.topbar-main').getBoundingClientRect();
    return { top: Math.round(el.getBoundingClientRect().top), bar: Math.round(bar.bottom), position: getComputedStyle(el).position };
  });
  eq(r, { top: 54, bar: 54, position: 'sticky' });
});

await step('telefono: la barra con logo e azioni resta fissa in alto mentre si scorre (non scompare, non si sovrappone)', async () => {
  for (const y of [0, 400, 900, 5000]) {
    await mpage.evaluate((v) => window.scrollTo(0, v), y);
    const r = await mpage.evaluate(() => {
      const bar = document.querySelector('.topbar-main').getBoundingClientRect();
      const btn = document.getElementById('add-account').getBoundingClientRect();
      const hit = document.elementFromPoint(btn.x + btn.width / 2, btn.y + btn.height / 2);
      return { top: Math.round(bar.top), visible: !!hit?.closest('#add-account'), position: getComputedStyle(document.querySelector('.topbar-main')).position };
    });
    eq(r, { top: 0, visible: true, position: 'sticky' });
  }
  await mpage.evaluate(() => window.scrollTo(0, 0));
});

await step('telefono: viewport-fit=cover e schermata iniziale senza scorrimento inutile', async () => {
  assert(/viewport-fit=cover/.test(await mpage.locator('meta[name=viewport]').getAttribute('content')), 'serve viewport-fit=cover per usare le zone sicure');
});

await step('telefono: con notch/barra di stato (zone sicure) la barra resta sotto la barra di stato e la lista sopra l\'indicatore Home', async () => {
  await mcdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, bottom: 34, left: 0, right: 0 } });
  try {
    for (const y of [0, 900]) {
      await mpage.evaluate((v) => window.scrollTo(0, v), y);
      const r = await mpage.evaluate((scrolled) => {
        const bar = document.querySelector('.topbar-main').getBoundingClientRect();
        const btn = document.getElementById('add-account').getBoundingClientRect();
        const brand = document.querySelector('.brand').getBoundingClientRect();
        const stick = document.querySelector('section[aria-label^="Stremio"] .pstick').getBoundingClientRect();
        return { barTop: Math.round(bar.top), barH: Math.round(bar.height), btnTop: Math.round(btn.top), brandTop: Math.round(brand.top), stickTop: scrolled ? Math.round(stick.top) : null };
      }, y);
      eq(r.barTop, 0); eq(r.barH, 113);
      assert(r.btnTop >= 59 && r.brandTop >= 59, `i pulsanti sono sotto la barra di stato: ${JSON.stringify(r)}`);
      if (y) eq(r.stickTop, 113);
    }
    await mpage.evaluate(() => window.scrollTo(0, 1e6));
    const bottom = await mpage.evaluate(() => parseFloat(getComputedStyle(document.getElementById('board')).paddingBottom));
    assert(bottom >= 28 + 34, `margine inferiore insufficiente: ${bottom}`);
  } finally {
    await mcdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
    await mpage.evaluate(() => window.scrollTo(0, 0));
  }
});

await step('telefono in orizzontale: layout a colonna con scorrimento di pagina; con notch ai lati nulla sfora né finisce sotto il notch', async () => {
  const insets = { top: 0, bottom: 21, left: 59, right: 59 };
  await mpage.setViewportSize({ width: 844, height: 390 });
  await mcdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
  try {
    const measure = () => mpage.evaluate(() => {
      const L = (sel) => document.querySelector(sel).getBoundingClientRect();
      const all = [...document.querySelectorAll('.topbar-main > *, .top-actions > *, #search, .chip-wrap, section.panel')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0); // il pulsante lingua è nascosto su telefono
      return {
        scrollW: document.documentElement.scrollWidth, innerW: innerWidth,
        left: Math.round(Math.min(...all.map((r) => r.left))), right: Math.round(Math.max(...all.map((r) => r.right))),
        boardDir: getComputedStyle(document.getElementById('board')).flexDirection, barPos: getComputedStyle(document.querySelector('.topbar-main')).position,
        listOverflow: getComputedStyle(document.querySelector('.plist')).overflowY,
        brandLeft: Math.round(L('.brand').left), addRight: Math.round(L('#add-account').right),
      };
    });
    const r = await measure();
    eq(r.boardDir, 'column'); eq(r.barPos, 'sticky'); eq(r.listOverflow, 'visible'); eq(r.scrollW, r.innerW);
    assert(r.left >= 59 && r.right <= 844 - 59, `fuori dalle zone sicure: ${JSON.stringify(r)}`);
    // tablet/computer largo con un notch ai lati (layout a colonne): stessi margini
    await mpage.setViewportSize({ width: 1000, height: 700 });
    const d = await measure();
    eq(d.boardDir, 'row'); eq(d.scrollW, d.innerW);
    assert(d.left >= 59 && d.brandLeft >= 59 && d.addRight <= 1000 - 59, `layout largo fuori dalle zone sicure: ${JSON.stringify(d)}`);
  } finally {
    await mcdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
    await mpage.setViewportSize({ width: 390, height: 844 });
    await mpage.evaluate(() => window.scrollTo(0, 0));
  }
});

await step('orizzontale basso senza tocco rilevato (es. Safari): stesso layout a colonna; testi non ingranditi', async () => {
  await page.setViewportSize({ width: 956, height: 340 });
  try {
    const r = await page.evaluate(() => ({ dir: getComputedStyle(document.getElementById('board')).flexDirection, adj: getComputedStyle(document.documentElement).webkitTextSizeAdjust, sw: document.documentElement.scrollWidth, iw: innerWidth }));
    eq(r.dir, 'column'); eq(r.adj, '100%'); eq(r.sw, r.iw);
  } finally { await page.setViewportSize({ width: 1500, height: 900 }); await page.evaluate(() => window.scrollTo(0, 0)); }
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

await step('telefono: riordino degli account dal menu del pannello, senza perdere la posizione di scorrimento', async () => {
  await mpage.evaluate(() => window.scrollTo(0, 900));
  await settle();
  const order = () => mpage.locator('section.panel').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  eq((await order())[0], 'Stremio s@x.it');
  await mp('Stremio s@x.it').locator('button[aria-label="Menu pannello"]').tap();
  await mpage.locator('.menu-item:has-text("Sposta account dopo")').tap();
  eq(await order(), ['Nuvio Main', 'Nuvio Kids', 'Nuvio Shared', 'Stremio s@x.it']);
  const y = await mpage.evaluate(() => Math.round(scrollY));
  assert(y > 0, `la pagina è tornata in cima (scrollY=${y})`);
  await mpage.evaluate(() => window.scrollTo(0, 0));
  await settle();
  await mpage.locator('.chip-acc', { hasText: 's@x.it' }).tap();
  await mpage.locator('.menu-item:has-text("Sposta prima")').tap();
  eq(await order(), ['Stremio s@x.it', 'Nuvio Main', 'Nuvio Kids', 'Nuvio Shared']);
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

await step('iPhone: la schermata iniziale (nessun account) non scorre e la barra sta sotto la barra di stato', async () => {
  db = freshDb();
  const c = await newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const pg = await c.newPage();
  try {
    await pg.goto(APP);
    await pg.locator('.empty-state').waitFor();
    const cdp = await c.newCDPSession(pg);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, bottom: 34, left: 0, right: 0 } });
    const r = await pg.evaluate(() => ({
      overflow: document.scrollingElement.scrollHeight - innerHeight,
      btnTop: Math.round(document.getElementById('add-account').getBoundingClientRect().top),
    }));
    assert(r.overflow <= 0, `la pagina iniziale scorre di ${r.overflow}px`);
    assert(r.btnTop >= 59, `i pulsanti finiscono sotto la barra di stato: ${r.btnTop}`);
  } finally { await c.close(); }
});

// ---------- installazione come app ----------
const synthInstallPrompt = (pg) => pg.evaluate(() => {
  const e = new Event('beforeinstallprompt', { cancelable: true });
  Object.assign(e, { __synthetic: true, prompt: async () => { window.__prompted = (window.__prompted || 0) + 1; }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  window.dispatchEvent(e);
});

let ictx; let ipage;
await step('installazione: service worker registrato, attivo e che controlla la pagina; il browser la trova installabile', async () => {
  db = freshDb();
  ictx = await newContext({ viewport: { width: 1300, height: 800 } }, { sw: true });
  ipage = await ictx.newPage();
  ipage.on('pageerror', (e) => errors.push(`pageerror(installazione): ${e.message}`));
  ipage.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`console(installazione): ${m.text()}`); });
  await ipage.goto(APP);
  await ipage.evaluate(() => navigator.serviceWorker.ready);          // registrato e attivo (Trusted Types incluso)
  await ipage.reload();
  assert(await ipage.evaluate(() => !!navigator.serviceWorker.controller), 'il service worker non controlla la pagina');
  const cache = await ipage.evaluate(async () => (await (await caches.open('addon-manager-v2')).keys()).map((r) => new URL(r.url).pathname));
  for (const f of ['/', '/js/main.js', '/js/ui/install-ui.js', '/css/styles.css', '/img/logo.png', '/manifest.webmanifest']) assert(cache.includes(f), `non in cache: ${f}`);
  const cdp = await ictx.newCDPSession(ipage);
  eq((await cdp.send('Page.getAppManifest')).errors, []);
  eq((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, [], 'non installabile con il service worker attivo');
});

await step('installazione: senza rete l\'interfaccia si apre dalla cache', async () => {
  await ictx.setOffline(true);
  await ipage.reload();
  await ipage.locator('.empty-state').waitFor({ timeout: 8000 });
  eq((await ipage.locator('.brand strong').innerText()).trim(), 'Addon Manager');
  assert(await ipage.evaluate(() => [...document.querySelectorAll('img.kind-logo, img.logo-mark, img.empty-logo')].every((i) => i.complete && i.naturalWidth > 0)), 'loghi non caricati offline');
  await ictx.setOffline(false);
});

await step('installazione: il service worker non tocca le API: gli accessi passano dai server (finti) mentre la pagina è controllata', async () => {
  await ipage.reload();
  assert(await ipage.evaluate(() => !!navigator.serviceWorker.controller));
  const before = log.filter((l) => l.method === 'login' || l.method === 'addonCollectionGet').length;
  await addAccount('stremio', 's@x.it', 'pw', { remember: false, on: ipage });
  await ipage.locator('section.panel .row').first().waitFor();
  assert(log.filter((l) => l.method === 'login' || l.method === 'addonCollectionGet').length >= before + 2, 'le richieste alle API non sono arrivate');
  const apiCached = await ipage.evaluate(async () => (await (await caches.open('addon-manager-v2')).keys()).some((r) => !r.url.startsWith(location.origin)));
  assert(!apiCached, 'una risposta di un altro dominio è finita in cache');
});

await step('installazione: invito con "Installa" (apre l\'installazione vera) e "Non ora" (ricordato dopo il reload)', async () => {
  const pg = await ictx.newPage();
  await pg.goto(APP);
  assert(await pg.locator('#install-banner').isHidden(), 'invito visibile senza che il browser abbia dato il via libera');
  await synthInstallPrompt(pg);
  const banner = pg.locator('#install-banner');
  await banner.waitFor();
  assert(/Installa Addon Manager/.test(await banner.innerText()));
  await banner.locator('button:has-text("Installa")').click();
  eq(await pg.evaluate(() => window.__prompted), 1, 'la finestra di installazione non è stata richiesta');
  // l'evento vale una volta sola: dopo la richiesta l'invito si chiude (se la persona rinuncia, Chrome ne manda un altro più avanti)
  assert(await banner.isHidden(), 'l\'invito è rimasto dopo la richiesta di installazione');
  // "Non ora" → non ricompare
  await synthInstallPrompt(pg);
  await banner.waitFor();
  await banner.locator('button:has-text("Non ora")').click();
  assert(await banner.isHidden());
  await pg.reload();
  await synthInstallPrompt(pg);
  await pg.waitForTimeout(200);
  assert(await pg.locator('#install-banner').isHidden(), 'l\'invito è tornato dopo "Non ora"');
  // …ma l'installazione resta raggiungibile da Impostazioni
  await pg.click('#settings');
  const dlg = pg.locator('dialog[open]');
  await dlg.locator('h3', { hasText: 'Installa come app' }).waitFor();
  await dlg.locator('button:has-text("Installa")').click();
  eq(await pg.evaluate(() => window.__prompted), 1);
  await pg.close();
});

await step('installazione: dopo l\'installazione (evento appinstalled) l\'invito sparisce', async () => {
  const pg = await ictx.newPage();
  await pg.goto(APP);
  await pg.evaluate(() => localStorage.removeItem('addonmanager.install.dismissed'));
  await pg.reload();
  await synthInstallPrompt(pg);
  await pg.locator('#install-banner').waitFor();
  await pg.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await pg.locator('#install-banner').waitFor({ state: 'hidden' });
  await pg.click('#settings');
  await pg.locator('dialog[open]').locator('text=Stai usando Addon Manager come app installata').waitFor();
  await pg.close();
});

await step('installazione: già installata (finestra standalone) → nessun invito', async () => {
  const sctx = await newContext({ viewport: { width: 1200, height: 700 } });
  await sctx.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => {
      const m = real(q);
      return q === '(display-mode: standalone)' ? Object.defineProperty(m, 'matches', { value: true }) : m;
    };
  });
  const pg = await sctx.newPage();
  await pg.goto(APP);
  await pg.evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.__synthetic = true; e.prompt = async () => {}; e.userChoice = new Promise(() => {}); window.dispatchEvent(e); });
  await pg.waitForTimeout(200);
  assert(await pg.locator('#install-banner').isHidden(), 'invito mostrato in un\'app già installata');
  await sctx.close();
});

await step('installazione: su iPhone (senza evento di installazione) si spiega come fare dal menu Condividi', async () => {
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const xctx = await newContext({ viewport: { width: 390, height: 844 }, userAgent: UA, isMobile: true, hasTouch: true });
  const pg = await xctx.newPage();
  await pg.goto(APP);
  const banner = pg.locator('#install-banner');
  await banner.waitFor();
  await banner.locator('button:has-text("Come si installa")').tap();
  const dlg = pg.locator('dialog[open]');
  const text = await dlg.innerText();
  assert(/Condividi/.test(text) && /Aggiungi alla schermata Home/.test(text), `istruzioni iOS mancanti: ${text}`);
  assert(!/Dock/.test(text), 'istruzioni del Mac su iPhone');
  await dlg.locator('button:has-text("Ho capito")').tap();
  await banner.locator('button:has-text("Non ora")').tap();
  assert(await banner.isHidden());
  await xctx.close();
});

await step('installazione: Safari su Mac → istruzioni «Aggiungi al Dock…»', async () => {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
  const xctx = await newContext({ viewport: { width: 1200, height: 700 }, userAgent: UA });
  const pg = await xctx.newPage();
  await pg.goto(APP);
  await pg.locator('#install-banner button:has-text("Come si installa")').click();
  const text = await pg.locator('dialog[open]').innerText();
  assert(/Aggiungi al Dock/.test(text) && !/Condividi/.test(text), text);
  await xctx.close();
});

await step('installazione: chiusura dei contesti di prova', async () => { await ictx.close(); });

await step('nessun errore JS / violazione CSP in console', async () => {
  assert(errors.length === 0, errors.join('\n'));
});

await browser.close();
server.close();

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passati`);
process.exit(failed.length ? 1 : 0);
