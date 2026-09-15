// Strato di persistenza.
// - LocalStore: localStorage del dispositivo + punti di ripristino (demo, o quando FIREBASE_CONFIG è vuota).
// - FirebaseStore (store-firebase.js): stesse funzioni su Firestore, condiviso tra i tablet, con accessi e ruoli.
// Le schermate (app.js) usano solo load / save / snapshots / ripristina / onChange / accedi / esci.

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
    fragranze: {},      // codice -> { codice, brand, nome, categoria, varianti[], soglia|null, fornitore, codiciFornitore, costi: { sigla|'_': €/litro }, attivo, note }
    soglie,             // categoria -> scorta minima (allarme) in ml
    obiettivi,          // categoria -> scorta obiettivo (livello da ripristinare) in ml
    movimenti: [],      // { id, ts, dataEvento, negozio, codice, tipo, ml, rif, lotto, note }
    lotti: [],          // { id, ts, tipo: 'vendite'|'giacenze', file, negozio, righe, scartate, annullato }
    trasferimenti: [],  // { id, ts, da, a, codice, ml, stato, storia[] , note}
    chiaviVendite: {},  // chiave riga vendita -> id lotto (anti doppio import)
    piano: { riordini: {}, spostamenti: {} },  // selezioni in corso dal pannello "Da riordinare o spostare"
    ordini: [],         // ordini confermati { id, ts, fornitore, negozio, righe[], totMl }
    fornitori: [],      // { sigla, nome }
  };
}

/** Utente fittizio della modalità locale: pieni poteri, nessun accesso richiesto. */
export const UTENTE_LOCALE = { uid: 'locale', ruolo: 'titolare', nome: 'Questo dispositivo', locale: true };

// ---------- punti di ripristino (localStorage del dispositivo, in entrambe le modalità) ----------
export class PuntiRipristino {
  constructor(max = MAX_SNAP) { this.max = max; }
  elenco() {
    try { return JSON.parse(localStorage.getItem(KEY_SNAP) || '[]'); } catch { return []; }
  }
  /** Conserva `precedente` (stringa JSON dello stato prima della modifica). */
  conserva(precedente, etichetta) {
    if (!precedente) return;
    const snaps = this.elenco();
    snaps.unshift({ ts: new Date().toISOString(), etichetta, stato: precedente });
    while (snaps.length > this.max) snaps.pop();
    try { localStorage.setItem(KEY_SNAP, JSON.stringify(snaps)); }
    catch { try { localStorage.setItem(KEY_SNAP, JSON.stringify(snaps.slice(0, 2))); } catch (e) { console.error('snapshot', e); } }
  }
  leggi(indice) {
    const s = this.elenco()[indice];
    return s ? { ...statoVuoto(), ...JSON.parse(s.stato) } : null;
  }
}

export class LocalStore {
  condiviso = false;
  constructor() { this.punti = new PuntiRipristino(); this.utente = null; }
  /** In modalità locale non c'è accesso: pieni poteri. Con ?ruolo=dipendente si prova cosa vede un commesso. */
  async accedi() {
    let ruolo = 'titolare';
    try { if (new URLSearchParams(location.search).get('ruolo') === 'dipendente') ruolo = 'dipendente'; } catch { /* fuori dal browser */ }
    this.utente = { ...UTENTE_LOCALE, ruolo };
    return this.utente;
  }
  async utenteCorrente() { return null; }
  async esci() { this.utente = null; }
  onChange() { /* nessun altro dispositivo scrive qui */ }
  onErrore() { }
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return { ...statoVuoto(), ...JSON.parse(raw) };
    } catch (e) { console.error('load', e); }
    return statoVuoto();
  }
  save(stato, etichetta = '', conSnapshot = true) {
    try {
      if (conSnapshot) this.punti.conserva(localStorage.getItem(KEY), etichetta);
      localStorage.setItem(KEY, JSON.stringify(stato));
      return true;
    } catch (e) { console.error('save', e); return false; }
  }
  snapshots() { return this.punti.elenco(); }
  ripristina(indice) {
    const stato = this.punti.leggi(indice);
    if (!stato) return null;
    this.save(stato, 'prima del ripristino');
    return stato;
  }
}

// ---------- scomposizione dello stato in documenti (modello condiviso) ----------
// Collezioni Firestore: fragranze/{codice}, riservato/{codice} (costo e codici fornitore, solo titolare),
// fornitori/{sigla}, movimenti/{id}, lotti/{id} (con le chiavi vendita del lotto), trasferimenti/{id},
// ordini/{id}, config/{soglie|piano_riordini|piano_spostamenti|meta}.

export const COLLEZIONI = ['fragranze', 'riservato', 'fornitori', 'movimenti', 'lotti', 'trasferimenti', 'ordini', 'config'];
export const COLLEZIONI_TITOLARE = new Set(['riservato']);
export const DOC_CONFIG = ['soglie', 'piano_riordini', 'piano_spostamenti', 'meta'];
export const DOC_CONFIG_TITOLARE = new Set(['piano_riordini']);

/** Id di documento sicuro (niente "/" e niente id vuoti). */
export function idDoc(s) { const id = encodeURIComponent(String(s ?? '')); return id || '_'; }

export function scomponi(stato) {
  const d = {}; for (const c of COLLEZIONI) d[c] = {};
  for (const [codice, f] of Object.entries(stato.fragranze || {})) {
    const { costo, costi, codiciFornitore, fornitore, ...pubblico } = f;   // `costo` (€/100 ml) è il campo vecchio: app.js lo converte in `costi`
    d.fragranze[idDoc(codice)] = { ...pubblico, codice };
    d.riservato[idDoc(codice)] = { codice, costi: costi || {}, codiciFornitore: codiciFornitore || {}, fornitore: fornitore || '' };
  }
  for (const fo of stato.fornitori || []) d.fornitori[idDoc(fo.sigla)] = fo;
  for (const m of stato.movimenti || []) d.movimenti[idDoc(m.id)] = m;
  const chiaviPerLotto = {};
  for (const [k, id] of Object.entries(stato.chiaviVendite || {})) (chiaviPerLotto[id] ??= []).push(k);
  for (const l of stato.lotti || []) d.lotti[idDoc(l.id)] = { ...l, chiavi: (chiaviPerLotto[l.id] || []).sort() };
  for (const t of stato.trasferimenti || []) d.trasferimenti[idDoc(t.id)] = t;
  for (const o of stato.ordini || []) d.ordini[idDoc(o.id)] = o;
  d.config.soglie = { soglie: stato.soglie || {}, obiettivi: stato.obiettivi || {} };
  d.config.piano_riordini = { voci: stato.piano?.riordini || {} };
  d.config.piano_spostamenti = { voci: stato.piano?.spostamenti || {} };
  d.config.meta = { versione: stato.versione || 1, creato: stato.creato || new Date().toISOString() };
  return d;
}

const perTs = (a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || String(a.id || '').localeCompare(String(b.id || ''));

export function ricomponi(d) {
  const s = statoVuoto();
  for (const f of Object.values(d.fragranze || {})) s.fragranze[f.codice] = { ...f };
  for (const r of Object.values(d.riservato || {})) {
    const f = s.fragranze[r.codice]; if (!f) continue;
    if (r.costi) f.costi = r.costi; else if (r.costo != null && r.costo !== '') f.costo = r.costo;   // documento vecchio: lo converte app.js
    f.codiciFornitore = r.codiciFornitore || {}; f.fornitore = r.fornitore || '';
  }
  s.fornitori = Object.values(d.fornitori || {}).sort((a, b) => String(a.sigla).localeCompare(String(b.sigla)));
  s.movimenti = Object.values(d.movimenti || {}).sort(perTs);
  s.lotti = Object.values(d.lotti || {}).sort(perTs).map(({ chiavi, ...l }) => { for (const k of chiavi || []) s.chiaviVendite[k] = l.id; return l; });
  s.trasferimenti = Object.values(d.trasferimenti || {}).sort(perTs);
  s.ordini = Object.values(d.ordini || {}).sort(perTs);
  const cfg = d.config || {};
  if (cfg.soglie) { s.soglie = { ...s.soglie, ...cfg.soglie.soglie }; s.obiettivi = { ...s.obiettivi, ...cfg.soglie.obiettivi }; }
  s.piano = { riordini: cfg.piano_riordini?.voci || {}, spostamenti: cfg.piano_spostamenti?.voci || {} };
  if (cfg.meta) { s.versione = cfg.meta.versione || 1; s.creato = cfg.meta.creato || s.creato; }
  return s;
}

/** JSON con chiavi ordinate: serve a confrontare un documento con quello già salvato indipendentemente dall'ordine dei campi. */
export function canonico(v) {
  if (Array.isArray(v)) return '[' + v.map(canonico).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonico(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

/** Differenze tra i documenti attuali (`ultimo`: collezione -> id -> JSON canonico) e lo stato nuovo. */
export function differenze(stato, ultimo, collezioni = COLLEZIONI, docConfig = DOC_CONFIG) {
  const nuovo = scomponi(stato);
  const ops = [];
  for (const c of collezioni) {
    const ids = new Set([...Object.keys(nuovo[c]), ...Object.keys(ultimo[c] || {})]);
    for (const id of ids) {
      if (c === 'config' && !docConfig.includes(id)) continue;
      const d = nuovo[c][id];
      if (d === undefined) { ops.push({ tipo: 'del', c, id }); continue; }
      const pulito = JSON.parse(JSON.stringify(d));
      const j = canonico(pulito);
      if (ultimo[c]?.[id] === j) continue;
      ops.push({ tipo: 'set', c, id, dati: pulito, json: j });
    }
  }
  return ops;
}

// ---------- dati dimostrativi ----------
/** Lotti creati dal pulsante "Prova con i dati dimostrativi" (inventario Aprilia simulato e vendite simulate). */
export function lottiDemo(stato) {
  return (stato.lotti || []).filter(l => /\(demo\)\s*$/i.test(l.file || '') || l.file === 'vendite-demo-6-settimane.csv');
}
/** Copia dello stato senza i lotti dimostrativi, i loro movimenti e le loro chiavi vendita. */
export function senzaDemo(stato) {
  const ids = new Set(lottiDemo(stato).map(l => l.id));
  if (!ids.size) return stato;
  return {
    ...stato,
    lotti: stato.lotti.filter(l => !ids.has(l.id)),
    movimenti: stato.movimenti.filter(m => !ids.has(m.lotto)),
    chiaviVendite: Object.fromEntries(Object.entries(stato.chiaviVendite || {}).filter(([, v]) => !ids.has(v))),
  };
}

/** Sceglie lo store in base alla configurazione (import dinamico: l'SDK Firebase si carica solo se serve). */
export async function creaStore() {
  const cfg = await import('./config.js');
  if (!cfg.modalitaCondivisa()) return new LocalStore();
  const { FirebaseStore } = await import('./store-firebase.js');
  return new FirebaseStore(cfg.FIREBASE_CONFIG, cfg.DOMINIO_ACCESSI);
}
