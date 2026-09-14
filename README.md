# Profumari · Magazzino

Web app per tracciare le giacenze di essenze (in ml) nei due punti vendita (Latina, Aprilia),
aggiornarle dalle vendite esportate dal gestionale di cassa, gestire soglie di riordino e trasferimenti tra negozi.

## Demo online

La cartella `app/` viene pubblicata automaticamente su GitHub Pages a ogni push su `main` (workflow in `.github/workflows/pages.yml`).
Sull'iPad: aprire il link in Safari, Condividi → "Aggiungi alla schermata Home", poi "Prova con i dati dimostrativi".

## Organizzazione della repo

- `main`: versione demo, pubblicata su Pages. I dati vivono nel browser del dispositivo.
- La versione definitiva (sincronizzazione tra i tablet con Firebase, accessi) si sviluppa su un ramo dedicato e si unisce a `main` solo quando pronta.
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
  - `js/store.js` — persistenza (oggi localStorage + punti di ripristino; interfaccia pronta per Firebase)
  - `js/app.js` — schermate e regole (giacenze, import, trasferimenti, soglie, storico)
- `scripts/` — utilità da riga di comando
  - `xlsx_to_json.py` — converte l'export magazzino in JSON
  - `report_anagrafica.mjs` — genera il report di normalizzazione da rivedere col cliente
- `dati/` — dati derivati (export JSON, report)

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

## Prossimi passi (fase 2)

- Sincronizzazione tra i tablet: backend Firebase (Firestore + Auth + Hosting, piano gratuito) dietro la stessa interfaccia di `store.js`.
- Accessi: titolare e commessi.
- Fornitore e costo già previsti in anagrafica; riepilogo riordino per fornitore.
