# Profumari · Magazzino

Web app per tracciare le giacenze di essenze (in ml) nei due punti vendita (Latina, Aprilia),
aggiornarle dalle vendite esportate dal gestionale di cassa, gestire soglie di riordino e trasferimenti tra negozi.

## Demo online

La cartella `app/` viene pubblicata automaticamente su GitHub Pages a ogni push su `main` (workflow in `.github/workflows/pages.yml`).
Sull'iPad: aprire il link in Safari, Condividi → "Aggiungi alla schermata Home", poi "Prova con i dati dimostrativi".

## Organizzazione della repo

- `main`: versione demo, pubblicata su Pages. I dati vivono nel browser del dispositivo.
- `produzione`: versione condivisa tra i tablet (Firebase), pubblicata su Firebase Hosting dal workflow `.github/workflows/produzione.yml`. Vedi la sezione **Produzione**.
- La stessa app funziona in entrambe le modalità: con `FIREBASE_CONFIG` vuota in `app/js/config.js` (o su GitHub Pages, o con `?demo` nell'indirizzo) resta locale; altrimenti chiede l'accesso e lavora sui dati condivisi.
- I file grezzi del cliente (Excel inventario, CSV vendite) non sono nella repo: vedi `.gitignore`.

## Avvio locale

Serve un piccolo server statico (i moduli JS non si caricano da `file://`):

```bash
python3 -m http.server 8765
```

poi apri <http://localhost:8765/app/index.html>. Font e libreria Excel sono inclusi in `app/fonts` e `app/lib`:
l'app non ha dipendenze esterne e funziona anche offline.

## Struttura

- `app/` — l'applicazione (HTML/CSS/JS senza build, pubblicabile su qualsiasi hosting statico)
  - `js/normalizza.js` — logica condivisa: normalizzazione anagrafica dall'Excel, parser CSV vendite, categoria da codice
  - `js/store.js` — persistenza locale (localStorage + punti di ripristino) e scomposizione dello stato in collezioni per la versione condivisa
  - `js/store-firebase.js` — persistenza condivisa: accessi, ruoli, ascolto in tempo reale, salvataggio per differenze, cache offline
  - `js/config.js` — configurazione Firebase (vuota = modalità locale) e dominio degli accessi
  - `js/app.js` — schermate e regole (giacenze, import, trasferimenti, soglie, storico), schermata di accesso, permessi per ruolo
  - `sw.js` — service worker: l'app si apre anche senza rete
  - `lib/firebase/` — SDK Firebase (app, auth, firestore) incluso nella repo, così non servono CDN
- `firestore.rules` — regole di accesso ai dati per ruolo (fatte rispettare dal server)
- `firebase.json` — hosting e regole per `firebase deploy`
- `scripts/` — utilità da riga di comando
  - `test_store.mjs` — test degli helper di persistenza (`node scripts/test_store.mjs`)
  - `xlsx_to_json.py` — converte l'export magazzino in JSON
  - `report_anagrafica.mjs` — genera il report di normalizzazione da rivedere col cliente
- `dati/` — dati derivati (export JSON, report)

## Accessi e permessi (versione condivisa)

Due accessi, uno per tipo di persona, decisi col titolare il 15/09/2026:

| Funzione | Titolare | Dipendente |
|---|---|---|
| Giacenze, filtri, copertura, badge in ordine / in arrivo | sì | sì |
| Costo €/100 ml e stima costo | sì | no (non viene nemmeno letto dal server) |
| Pannello "Da riordinare o spostare": Sposta | sì | sì |
| Pannello "Da riordinare o spostare": Riordina, lista riordino, ordini, Storico ordini | sì | no |
| Trasferimenti (proporre, spedire, ricevere, annullare) | sì | sì |
| Caricamento vendite da CSV | sì | sì |
| Registrazione consegne degli ordini (fornitore e quantità, senza prezzi) | sì | sì |
| Carico manuale e rettifica | sì | sì |
| Inventario completo da Excel, annullamento caricamenti | sì | no |
| Referenze, soglie, fornitori (scheda "Referenze e soglie") | sì | no |
| Backup, ripristino, azzeramento | sì | no |

Nell'app le voci riservate spariscono; in più `firestore.rules` le blocca lato server (costi e codici fornitore stanno in una collezione a parte, `riservato`, leggibile solo dal titolare).
Nella demo si può vedere cosa vede un commesso aprendo l'app con `?ruolo=dipendente`.

## Produzione (versione condivisa): come metterla in piedi

Tutto sul piano gratuito di Firebase (Spark), senza carta di credito. Una volta sola, da chi fa la manutenzione:

1. **Progetto**: su <https://console.firebase.google.com> crea il progetto (es. `profumari-magazzino`) con il tuo account Google, senza Google Analytics. In *Impostazioni progetto → Utenti e autorizzazioni* aggiungi il Gmail del titolare come **Proprietario**.
2. **Firestore**: *Build → Firestore Database → Crea database*, modalità produzione, regione europea (es. `europe-west1`). Nella scheda *Regole* incolla il contenuto di `firestore.rules` e pubblica (oppure `npx firebase-tools deploy --only firestore:rules --project <id>` dopo `npx firebase-tools login`).
3. **Accessi**: *Build → Authentication → Metodo di accesso*: abilita **Email/password**. In *Users* aggiungi due utenti con le password scelte dal titolare: `titolare@iprofumari.it` e `negozio@iprofumari.it` (il dominio è quello in `DOMINIO_ACCESSI`; nell'app si scrive solo `titolare` o `negozio`).
4. **Ruoli**: in Firestore crea la collezione `utenti` con un documento per utente. L'**id del documento è l'UID** dell'utente (colonna "Identificatore utente" in Authentication → Users); campi: `ruolo` = `titolare` oppure `dipendente`, `nome` = testo mostrato in alto a destra (es. "Titolare", "Negozio"). Senza questo documento l'accesso viene rifiutato con un messaggio chiaro.
5. **Configurazione dell'app**: *Impostazioni progetto → Le tue app → Aggiungi app → Web* (senza Hosting via SDK). Copia i valori di `firebaseConfig` in `app/js/config.js` (`FIREBASE_CONFIG`). Non sono segreti.
6. **Pubblicazione**: *Build → Hosting → Inizia* (solo per attivarlo). Poi, o a mano con `npx firebase-tools deploy --only hosting --project <id>`, oppure con il workflow: nella repo GitHub crea il segreto `FIREBASE_SERVICE_ACCOUNT` (contenuto del JSON da *Impostazioni progetto → Account di servizio → Genera nuova chiave privata*) e la variabile `FIREBASE_PROJECT_ID`; ogni push sul ramo `produzione` pubblica app e regole. L'indirizzo è `https://<id>.web.app`.
7. **Primo caricamento**: apri l'indirizzo, entra come `titolare`, vai in *Storico e backup → Ripristina da backup* e carica il backup scaricato dalla demo del titolare. Se nella demo erano stati caricati i dati dimostrativi, l'app li riconosce e propone di scartarli (inventario Aprilia simulato e vendite simulate), tenendo inventari e vendite veri.
8. **Tablet**: su ciascun iPad apri l'indirizzo in Safari, *Condividi → Aggiungi alla schermata Home*, apri dall'icona ed entra come `negozio` (una volta sola: l'accesso resta salvato). Il titolare entra come `titolare` da qualsiasi dispositivo.

Manutenzione ordinaria: password e nuovi accessi da *Authentication → Users* (per un nuovo accesso serve anche il documento in `utenti`); dati consultabili da *Firestore Database*; backup settimanale dall'app con l'accesso titolare (il piano gratuito non fa copie automatiche).

Limiti del piano gratuito e uso stimato: 20.000 scritture e 50.000 letture al giorno contro qualche centinaio di scritture nei giorni di caricamento vendite e poche migliaia di letture (ogni tablet tiene una copia locale e riceve solo le differenze); 1 GB di spazio contro pochi MB l'anno.

Come funziona sotto: i dati stanno in collezioni separate (`fragranze`, `riservato`, `fornitori`, `movimenti`, `lotti`, `trasferimenti`, `ordini`, `config`, `utenti`), ogni salvataggio scrive solo i documenti cambiati e ogni dispositivo riceve le modifiche degli altri in tempo reale. Senza rete si continua a lavorare sulla cache locale e le scritture si allineano al ritorno della connessione. I punti di ripristino restano sul singolo dispositivo (solo titolare).

## Regole di dominio

- La referenza è identificata dal **codice a 3 cifre**; le righe Excel con suffissi fornitore (Atlantis, PF, Parf. Lab, New…) vengono **sommate** in un'unica giacenza, i suffissi restano come "varianti".
- Categoria derivata dal codice: 0xx UOMO, 2xx/3xx DONNA, 5xx/6xx NICCHIA, 8xx PREMIUM.
- Dalle vendite si scala `formato × quantità` (formati ammessi: 30, 50, 100 ml). Righe senza codice o senza formato (accessori, bucato, Maison Asrar, profumi auto) e resi vengono ignorati e mostrati in anteprima.
- Flaconi, tappi, etichette e altri consumabili sono fuori perimetro.
- La giacenza non viene mai "scritta": è la somma di un registro movimenti (vendita, carico, rettifica, inventario, trasferimento). Ogni import è un lotto annullabile in blocco; ogni riga vendita ha una chiave univoca che impedisce doppi conteggi.
- Due livelli di scorta per categoria, con override per referenza: **minima** (allarme) e **obiettivo** (livello da ripristinare).
- Proposte di trasferimento (scheda Giacenze, pannello "Da riordinare o spostare"), a un tocco con annulla:
  - regola base: riporta il negozio in difficoltà alla scorta obiettivo, prelevando solo l'eccedenza sopra la minima dell'altro negozio;
  - con almeno 4 settimane di vendite caricate (`SETTIMANE_MIN` in `app.js`) la proposta equilibra la **copertura** (settimane di vendita davanti) tra i due negozi, con lo stesso limite; la copertura compare anche sotto ogni giacenza;
  - nessuna proposta porta chi riceve oltre `ORIZZONTE_SETT` (8) settimane di copertura, così chi cede non viene svuotato;
  - sotto i 50 ml non si propone nulla e la riga dice "da riordinare" con il motivo.
- **Fornitori**: ogni referenza ha i codici prodotto dei fornitori che la trattano (colonne PL, PF, VF… dell'inventario, o inseriti a mano in Referenze). I fornitori hanno sigla e nome esteso, gestiti nella scheda Referenze e soglie.
- **Ordini**: nel Piano le voci di riordino si raggruppano per fornitore + negozio di consegna; per ogni gruppo si genera l'ordine in Excel (.xlsx), in PDF (stampa dall'iPad) o come testo, e lo si conferma: resta in Storico, da dove si può riscaricare.
- **Movimenti attesi**: sotto ogni giacenza compaiono i ml già ordinati al fornitore (`+X ordine`), quelli in arrivo dall'altro negozio (`+X arrivo`, trasferimenti proposti o spediti) e quelli da spedire e ancora in giacenza (`−X uscita`, solo trasferimenti proposti: gli spediti sono già scalati). Il filtro stato ha le voci "Con trasferimenti in corso" e "Con ordini in attesa". Le proposte automatiche considerano la merce in ordine come già coperta: niente doppio riordino e la spunta di massa salta quelle voci.
- **Consegne**: gli ordini confermati compaiono in Carichi → "Ordini in attesa di consegna". All'arrivo della merce si registra la consegna voce per voce: ricevuto come ordinato, ricevuto con quantità diversa (si corregge il numero), non arrivato (resta in attesa di una consegna successiva) o annullato. I ml ricevuti entrano come carichi nel negozio di consegna, con riferimento all'ordine. L'ordine passa a "parziale" o "ricevuto".
- **Fuori soglia**: dalla tabella giacenze, il pulsante *Ordina o sposta* su ogni riga (e *+ Aggiungi voce* nel Piano) apre una finestra per mettere a piano un riordino o uno spostamento di qualsiasi referenza, anche non sotto scorta, con giacenze, copertura, quantità suggerita e avviso sull'effetto dello spostamento.
- Trasferimento in tre passi: *proposto → spedito* (ml in transito) *→ ricevuto*.
- **Giacenze**: i numeri in testata aprono viste filtrate; la tabella ha categoria, filtri (categoria, negozio, stato) e ordinamento per colonna.
- **Piano**: dal pannello "Da riordinare o spostare" si spuntano *Riordina* e/o *Sposta* per ogni voce; la scheda Piano mostra la lista riordino (quantità e note modificabili, stima costo da "€/100 ml", copia testo, CSV, stampa, conferma → salvata in Storico) e la lista trasferimenti (ml modificabili con giacenze prima/dopo e avvisi, creazione in blocco dei trasferimenti in stato "proposto"). Le spunte sono salvate e restano finché non si conferma o si toglie la voce.

## Come inserire un nuovo prodotto (istruzioni per il titolare)

1. In **Referenze e soglie** → "+ Nuova referenza": codice a 3 cifre libero nella fascia giusta (0xx uomo, 2xx/3xx donna, 5xx/6xx nicchia, 8xx premium), brand, nome, codici dei fornitori.
2. Nel **gestionale di cassa** creare un articolo per formato con descrizione esattamente `codice formato`, es. `545 30ML`, `545 50ML`, `545 100ML` (codice all'inizio, spazio, ml seguiti da "ML"), e la categoria corrispondente.
3. Se lo stesso profumo arriva da un altro fornitore **non** si crea un nuovo codice: si aggiunge il codice del nuovo fornitore alla referenza esistente.
4. All'arrivo della merce, in **Carichi** → "Ordini in attesa di consegna" → "Registra consegna": si spuntano le voci e le quantità entrano in giacenza. Il carico manuale serve solo per merce arrivata senza un ordine nel sistema.

Le stesse istruzioni sono nell'app, in fondo alla scheda Referenze e soglie.

## Stato della fase 2 (produzione)

Fatto (in attesa del progetto Firebase per la prova sui dati veri):

- sincronizzazione tra i tablet, accessi e permessi per ruolo, schermata di accesso, cache offline e service worker;
- importazione del backup della demo con riconoscimento dei dati dimostrativi;
- regole Firestore, configurazione hosting, workflow di pubblicazione, test degli helper.

Da fare:

- creare il progetto Firebase e compilare `app/js/config.js` (vedi **Produzione**);
- prova su due dispositivi con dati veri e verifica delle regole con entrambi gli accessi;
- decidere quando unire a `main` (la demo su Pages resta locale anche con la configurazione compilata).
- **Nomi estesi dei fornitori** PL, PF, VF: oggi negli ordini compare la sigla.
- **Unità degli ordini**: sono in ml. Se i fornitori vendono a flacone (250 ml, 500 ml, 1 L) va aggiunto il formato per fornitore e la conversione.
- **Costo di acquisto** per referenza (€/100 ml), oggi vuoto: serve per la stima in euro degli ordini.
- **Referenze non più trattate**: i 7 codici presenti nel vecchio export e non nel nuovo file vanno disattivati dall'anagrafica.
- **Soglie minima e obiettivo** definitive per categoria, oggi impostate a valori di prova.
