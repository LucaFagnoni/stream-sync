# StreamSync

Pagina web statica per gestire da un unico posto gli addon di **più account Nuvio e Stremio**: riordinarli, aggiornarli, copiare i manifest e trascinarli da un account all'altro.

Nessun backend: il browser parla direttamente con `api.strem.io` e `api.nuvio.tv` (entrambi con CORS aperto). Le credenziali non passano da nessun server terzo.

## Avvio

```bash
npm start            # http://localhost:8080
```

Oppure pubblica la cartella così com'è su qualsiasi hosting statico (GitHub Pages, Netlify, …). Non serve build né dipendenze.

## Funzioni

- **Più account insieme**: Stremio (una lista) e Nuvio (fino a 6 profili, una lista ciascuno), affiancati.
- **Drag & drop**: riordina nella stessa lista; trascina in un'altra lista per **copiare**; tieni **Maiusc** al rilascio per **spostare**. Selezione multipla con checkbox (Maiusc+click per intervalli). In alternativa ai gesti: menu «Copia in… / Sposta in…» (utile da touch) e `Alt+↑/↓` per riordinare da tastiera.
- **Bozza + Salva**: ogni modifica resta locale (con undo/redo, `Ctrl+Z`) finché non premi *Salva* (`Ctrl+S`). Il riepilogo `+2 −1 ~1 ↕` mostra cosa cambierà.
- **Copia manifest**: URL, link `stremio://`, JSON completo, tutti gli URL di una lista; apri manifest e pagina di configurazione.
- **Verifica e aggiorna**: riscarica i manifest; su Stremio i manifest cambiati finiscono nella bozza (con badge versione `2.0.0 → 3.0.0`), su Nuvio si aggiorna il nome e si mostra lo stato (online / non raggiungibile).
- **Aggiungi da URL** (anche più righe, `stremio://` incluso) con verifica del manifest, **importa/esporta** JSON, **Sincronizza da…** tra due liste (aggiungi i mancanti oppure specchio esatto con anteprima).
- Attiva/disattiva addon (Nuvio), ricerca globale (`/`), tema chiaro/scuro, backup automatici prima di ogni scrittura.

## Sicurezza e integrità dei dati

- **Le password non vengono mai salvate.** Solo i token di sessione, e solo con «Ricordami», nel `localStorage` di questo browser. Su un computer condiviso lascia «Ricordami» spento.
- La pagina ha una **Content-Security-Policy** restrittiva (script solo dalla stessa origine) e non usa `innerHTML` con dati esterni: nomi, descrizioni e loghi degli addon sono trattati come non fidati.
- **Attenzione agli URL degli addon**: spesso contengono chiavi personali (es. debrid). Backup, export e «Copia tutti gli URL» le includono.
- Il salvataggio **sostituisce l'intera lista** (è così che funzionano `addonCollectionSet` e `sync_push_addons`). Per questo: conferma quando rimuovi addon, controllo di conflitto se la lista è cambiata altrove nel frattempo, backup automatico dello stato remoto (ultimi 25) e rilettura dopo la scrittura.
- La rimozione di un account Nuvio usa `logout?scope=local`: non disconnette le altre app.

## Limiti noti

- Il browser non distingue «server offline» da «CORS non consentito». Su **Nuvio** un addon non verificabile si può aggiungere comunque (serve solo l'URL); su **Stremio** serve il manifest completo, quindi non si può.
- Gli URL `http://` sono bloccati dal browser su una pagina `https://` (tranne `localhost`).
- Stremio: gli addon *protetti* (es. Cinemeta) non sono rimovibili. Nuvio: i profili che usano gli addon del Profilo 1 sono in sola lettura.
- Accessi Stremio solo via email/password (non Facebook/Apple). Non si creano account da qui.
- Su Nuvio il server non conserva il manifest, quindi «aggiorna» si limita al nome.

## Test

```bash
npm test             # unit: URL, modello bozza/undo, specchio, client API (body esatti, refresh token)
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

Riferimenti: [stremio-api-client](https://github.com/Stremio/stremio-api-client) · [Nuvio API](https://nuvio.tv/docs)
