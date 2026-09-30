# StreamSync

Pagina web statica per gestire da un unico posto gli addon di **più account Nuvio e Stremio**: riordinarli, aggiornarli, copiare i manifest e trascinarli da un account all'altro.

Nessun backend: il browser parla direttamente con `api.strem.io` e `api.nuvio.tv` (entrambi con CORS aperto). Le credenziali non passano da nessun server terzo.

## Avvio

Online: **https://lucafagnoni.github.io/stream-sync/** (vedi sotto le avvertenze sull'origin condiviso).

In locale:

```bash
npm start            # http://localhost:8080 (solo loopback)
```

Non serve build né dipendenze: la cartella si può pubblicare così com'è su qualsiasi hosting statico.

## Funzioni

- **Più account insieme**: Stremio (una lista) e Nuvio (fino a 6 profili, una lista ciascuno), affiancati.
- **Drag & drop**: riordina nella stessa lista (avvicinandoti a un bordo la board e le liste scorrono, per raggiungere i pannelli fuori schermo); trascina in un'altra lista per **copiare**; tieni **Maiusc** al rilascio per **spostare**. Selezione multipla con checkbox (Maiusc+click per intervalli). In alternativa ai gesti: menu «Copia in… / Sposta in…» (utile da touch) e `Alt+↑/↓` per riordinare da tastiera.
- **Bozza + Salva**: ogni modifica resta locale (con undo/redo, `Ctrl+Z`) finché non premi *Salva* (`Ctrl+S`). Il riepilogo `+2 −1 ~1 ↕` mostra cosa cambierà.
- **Copia manifest**: URL, link `stremio://`, JSON completo, tutti gli URL di una lista; apri manifest e pagina di configurazione.
- **Verifica e aggiorna**: riscarica i manifest; su Stremio i manifest cambiati finiscono nella bozza (con badge versione `2.0.0 → 3.0.0`), su Nuvio si aggiorna il nome e si mostra lo stato (online / non raggiungibile).
- **Aggiungi da URL** (anche più righe, `stremio://` incluso) con verifica del manifest, **importa/esporta** JSON, **Sincronizza da…** tra due liste (aggiungi i mancanti oppure specchio esatto con anteprima).
- Attiva/disattiva addon (Nuvio), ricerca globale (`/`), tema chiaro/scuro, backup automatici prima di ogni scrittura.

## Sicurezza e integrità dei dati

- **Le password non vengono mai salvate.** Solo i token di sessione:
  - «Ricordami» **spento (default)** → token in `sessionStorage`: vale finché la scheda resta aperta;
  - «Ricordami» acceso → token in `localStorage`: resta anche dopo la chiusura del browser.
- ⚠️ **Origin condiviso su GitHub Pages.** `lucafagnoni.github.io/stream-sync/` ha lo stesso origin di `lucafagnoni.github.io` e di ogni altro tuo progetto Pages: tutte quelle pagine possono leggere lo stesso `localStorage` (e il `sessionStorage`, se aperte nella stessa scheda), quindi anche i token. Oggi su quell'origin c'è un sito con jQuery 3.3.1 e nessuna CSP. Per usare «Ricordami» in modo sicuro pubblica l'app su un **origin dedicato** (dominio personalizzato, oppure un account/organizzazione GitHub usato solo per questa app).
- Un token Stremio (`authKey`) non scade da solo: se temi che sia stato esposto usa **Backup → «Esci da tutto e cancella i dati locali»**, che lo invalida sul server.
- **Content-Security-Policy** restrittiva (script solo dalla stessa origine, nessun plugin) con **Trusted Types**: nessun `innerHTML` con dati esterni. Nomi, descrizioni e loghi degli addon sono trattati come non fidati, anche se malformati.
- **Anti-clickjacking**: dentro un iframe di un altro sito la pagina non carica account né chiama le API (GitHub Pages non permette l'header `frame-ancestors`).
- **Attenzione agli URL degli addon**: spesso contengono chiavi personali (es. `realdebrid=…`). Backup, export e «Copia tutti gli URL» le includono. Gli URL non vengono mai ricodificati: si salvano esattamente come li hai incollati.
- Il salvataggio **sostituisce l'intera lista** (così funzionano `addonCollectionSet` e `sync_push_addons`), quindi:
  - conferma esplicita quando rimuovi addon (l'Invio seleziona «Annulla»);
  - se la lista è cambiata su un altro dispositivo: **Unisci** (predefinito, non perde le modifiche di nessuno), Ricarica o Sovrascrivi;
  - gli addon che non hai toccato prendono la versione attuale del server (manifest/nomi aggiornati altrove non vengono riportati indietro);
  - campi del descrittore Stremio che l'app non conosce vengono conservati;
  - backup automatico dello stato remoto prima di ogni scrittura (ultimi 25, cancellati insieme all'account);
  - rilettura dopo la scrittura; dopo un timeout si verifica se la scrittura è comunque avvenuta;
  - «Salva tutto» salva prima le liste che ricevono addon e poi quelle che li perdono.
- La rimozione di un account Nuvio usa `logout?scope=local`: non disconnette le altre app. Un errore di rete durante il rinnovo del token non fa perdere la sessione; più schede aperte condividono il token ruotato.

## Limiti noti

- Il browser non distingue «server offline» da «CORS non consentito». Su **Nuvio** un addon non verificabile si può aggiungere comunque (serve solo l'URL); su **Stremio** serve il manifest completo, quindi non si può.
- Gli URL `http://` sono bloccati dal browser su una pagina `https://` (tranne `localhost`).
- Stremio: gli addon *protetti* (es. Cinemeta) non sono rimovibili. Nuvio: i profili che usano gli addon del Profilo 1 sono in sola lettura.
- Accessi Stremio solo via email/password (non Facebook/Apple). Non si creano account da qui.
- Su Nuvio il server non conserva il manifest, quindi «aggiorna» si limita al nome.

## Pubblicazione

**Cloudflare Pages (consigliato: origin dedicato + intestazioni HTTP di sicurezza).** Collegamento Git con:
build command `npm run build`, output `_site`, variabile `NODE_VERSION=22`. La build esegue gli unit test
e pubblica solo `index.html`, `css/`, `js/`, `img/` e `_headers` (CSP con `frame-ancestors`, `X-Frame-Options`, `nosniff`, HSTS).

**GitHub Pages.**

`.github/workflows/pages.yml` esegue unit test ed end-to-end e, se passano, pubblica su GitHub Pages **solo** `index.html`, `css/` e `js/`. Serve una configurazione una tantum: *Settings → Pages → Build and deployment → Source: **GitHub Actions***. Le action sono fissate per SHA e aggiornate da Dependabot.

## Test

```bash
npm test             # unit: URL, bozza/undo, unione a tre vie, client API (body esatti, refresh token), storage
npm run test:e2e     # Chromium (Playwright) contro mock di Stremio, Nuvio e degli host addon
```

I test e2e usano **mock** costruiti sulla documentazione: non sono stati eseguiti contro account reali.

## Struttura

```
index.html  css/styles.css
js/util.js manifest.js stremio.js nuvio.js     # rete e utilità (senza DOM)
js/model.js convert.js backup.js store.js      # bozza, conversione, import/export, persistenza
js/app.js                                      # controller (account, salvataggio, copia)
js/ui/dom.js views.js dialogs.js  js/main.js   # interfaccia
```

I loghi in `img/` sono marchi di Stremio e Nuvio, scaricati dai rispettivi siti ufficiali e usati solo per indicare a quale servizio appartiene un account. Sono serviti in locale, così la pagina non contatta siti terzi.

Riferimenti: [stremio-api-client](https://github.com/Stremio/stremio-api-client) · [Nuvio API](https://nuvio.tv/docs)
