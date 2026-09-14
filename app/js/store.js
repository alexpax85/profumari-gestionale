// Strato di persistenza. Oggi: localStorage del tablet + snapshot automatici.
// Domani: stessa interfaccia (load/save/snapshots/ripristina) su Firebase, senza toccare le schermate.

import { CATEGORIE } from './normalizza.js';

const KEY = 'profumari.stato.v1';
const KEY_SNAP = 'profumari.snapshot.v1';
const MAX_SNAP = 12;

export function statoVuoto() {
  const soglie = {}, obiettivi = {};
  for (const c of CATEGORIE) { soglie[c] = 100; obiettivi[c] = 200; }
  return {
    versione: 1,
    creato: new Date().toISOString(),
    fragranze: {},      // codice -> { codice, brand, nome, categoria, varianti[], soglia|null, fornitore, costo, attivo, note }
    soglie,             // categoria -> scorta minima (allarme) in ml
    obiettivi,          // categoria -> scorta obiettivo (livello da ripristinare) in ml
    movimenti: [],      // { id, ts, dataEvento, negozio, codice, tipo, ml, rif, lotto, note }
    lotti: [],          // { id, ts, tipo: 'vendite'|'giacenze', file, negozio, righe, scartate, annullato }
    trasferimenti: [],  // { id, ts, da, a, codice, ml, stato, storia[] , note}
    chiaviVendite: {},  // chiave riga vendita -> id lotto (anti doppio import)
    piano: { riordini: {}, spostamenti: {} },  // selezioni in corso dal pannello "Da riordinare o spostare"
    ordini: [],         // liste di riordino confermate { id, ts, righe[], totMl }
  };
}

export class LocalStore {
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return { ...statoVuoto(), ...JSON.parse(raw) };
    } catch (e) { console.error('load', e); }
    return statoVuoto();
  }
  save(stato, etichetta = '', conSnapshot = true) {
    try {
      const prec = localStorage.getItem(KEY);
      if (prec && conSnapshot) {
        const snaps = this.snapshots();
        snaps.unshift({ ts: new Date().toISOString(), etichetta, stato: prec });
        while (snaps.length > MAX_SNAP) snaps.pop();
        try { localStorage.setItem(KEY_SNAP, JSON.stringify(snaps)); }
        catch (e) { localStorage.setItem(KEY_SNAP, JSON.stringify(snaps.slice(0, 3))); }
      }
      localStorage.setItem(KEY, JSON.stringify(stato));
      return true;
    } catch (e) { console.error('save', e); return false; }
  }
  snapshots() {
    try { return JSON.parse(localStorage.getItem(KEY_SNAP) || '[]'); } catch { return []; }
  }
  ripristina(indice) {
    const s = this.snapshots()[indice];
    if (!s) return null;
    const stato = { ...statoVuoto(), ...JSON.parse(s.stato) };
    this.save(stato, 'prima del ripristino');
    return stato;
  }
}
