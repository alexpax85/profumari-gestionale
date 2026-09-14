// Logica condivisa (browser + node): normalizzazione anagrafica, parsing vendite.

export const NEGOZI = ['Latina', 'Aprilia'];
export const FORMATI_ML = [30, 50, 100];
export const CATEGORIE = ['01 UOMO', '02 DONNA', '03 NICCHIA', '04 PREMIUM'];

export function categoriaDaCodice(codice) {
  const n = parseInt(codice, 10);
  if (n < 200) return '01 UOMO';
  if (n < 500) return '02 DONNA';
  if (n < 800) return '03 NICCHIA';
  return '04 PREMIUM';
}

// Suffissi "alla buona" usati come identificativi fornitore/lotto nell'Excel.
const RE_SUFFISSO = /[\s.]*\b(new|nuovo|parf\.?\s*lab\.?|pf|atlantis|tanica|brocca)\b.*$/i;
const RE_CODICE = /^\s*(\d{3})(?!\d)[.\s]*/;
const RE_FLACONE = /^\s*(30|50|100)\s*ML\b/i;

/** Riga dell'export magazzino -> { codice, brand, nome, variante } oppure null se non è un profumo. */
export function normalizzaRigaMagazzino(nomeOriginale) {
  const s = String(nomeOriginale ?? '');
  if (RE_FLACONE.test(s)) return null;
  const m = s.match(RE_CODICE);
  if (!m) return null;
  const codice = m[1];
  let resto = s.slice(m[0].length);
  const sm = resto.match(RE_SUFFISSO);
  const variante = sm ? sm[0].replace(/^[\s.]+/, '').trim() : '';
  if (sm) resto = resto.slice(0, sm.index);
  resto = resto.replace(/\s+/g, ' ').replace(/[\s.\-]+$/, '').replace(/^[\s.\-]+/, '').trim();
  let brand = '', nome = resto;
  const d = resto.indexOf('-');
  if (d > 0) {
    brand = resto.slice(0, d).trim();
    nome = resto.slice(d + 1).trim();
  }
  return { codice, brand, nome, variante, nomeCompleto: brand ? `${brand} - ${nome}` : nome };
}

/**
 * Elenco righe { nome, quantita } -> { fragranze: [...], ignorate: [...] }.
 * Le righe con lo stesso codice vengono aggregate (ml sommati, varianti in nota).
 */
export function normalizzaMagazzino(righe) {
  const perCodice = new Map();
  const ignorate = [];
  for (const r of righe) {
    const n = normalizzaRigaMagazzino(r.nome);
    const q = Number(r.quantita) || 0;
    if (!n) { ignorate.push({ nome: r.nome, quantita: q }); continue; }
    if (!perCodice.has(n.codice)) perCodice.set(n.codice, { codice: n.codice, candidati: [], ml: 0, righe: [] });
    const e = perCodice.get(n.codice);
    e.candidati.push(n);
    e.ml += q;
    e.righe.push({ nome: r.nome, quantita: q, variante: n.variante });
  }
  const fragranze = [...perCodice.values()].map(e => {
    // nome canonico: il più frequente, a parità il più corto
    const conta = new Map();
    for (const c of e.candidati) conta.set(c.nomeCompleto, (conta.get(c.nomeCompleto) || 0) + 1);
    const migliore = [...conta.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    const c = e.candidati.find(x => x.nomeCompleto === migliore);
    const varianti = [...new Set(e.candidati.map(x => x.variante).filter(Boolean))];
    const nomiDiversi = [...conta.keys()].filter(k => k !== migliore);
    return {
      codice: e.codice, brand: c.brand, nome: c.nome, categoria: categoriaDaCodice(e.codice),
      ml: e.ml, varianti, nomiDiversi, righe: e.righe,
    };
  }).sort((a, b) => a.codice.localeCompare(b.codice));
  return { fragranze, ignorate };
}

/** Descrizione di vendita -> { codice, ml } | { errore } */
export function parseDescrizioneVendita(desc) {
  const s = String(desc ?? '').trim();
  const m = s.match(/^(\d{3})(?!\d)\s*(\d+)\s*ml\b/i);
  if (m) {
    const ml = parseInt(m[2], 10);
    if (!FORMATI_ML.includes(ml)) return { codice: m[1], errore: `formato ${ml} ML non previsto` };
    return { codice: m[1], ml };
  }
  if (/\b\d{3}\b/.test(s)) return { errore: 'formato ML assente' };
  return { errore: 'senza codice' };
}

const MESI = { gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12 };
/** "12 set 2026, 09:25" -> "2026-09-12T09:25" (stringa locale, senza fuso) */
export function parseDataIt(s) {
  const m = String(s ?? '').match(/(\d{1,2})\s+([a-z]{3})\w*\s+(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?/i);
  if (!m) return null;
  const mese = MESI[m[2].toLowerCase()];
  if (!mese) return null;
  const p = n => String(n).padStart(2, '0');
  return `${m[3]}-${p(mese)}-${p(m[1])}T${p(m[4] || 0)}:${m[5] || '00'}`;
}

/** Parser CSV RFC4180 (virgolette, virgole nei campi, righe multiple). Ritorna array di oggetti con header. */
export function parseCSV(testo) {
  const righe = [];
  let riga = [], campo = '', inQ = false;
  const t = testo.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQ) {
      if (ch === '"') { if (t[i + 1] === '"') { campo += '"'; i++; } else inQ = false; }
      else campo += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',' || ch === ';') { riga.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      riga.push(campo); righe.push(riga); riga = []; campo = '';
    } else campo += ch;
  }
  if (campo !== '' || riga.length) { riga.push(campo); righe.push(riga); }
  const header = (righe.shift() || []).map(h => h.trim());
  return righe.filter(r => r.some(c => c.trim() !== '')).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

/**
 * Righe CSV vendite -> { riconosciute: [...], scartate: [...] }
 * Ogni riga riconosciuta ha una chiave univoca (per evitare doppi import).
 */
export function analizzaVendite(righeCSV) {
  const riconosciute = [], scartate = [];
  const occorrenze = new Map();
  for (const r of righeCSV) {
    const desc = r['Descrizione'] ?? '';
    const base = { data: r['Data'], id: r['ID Transazione'], descrizione: desc, categoria: r['Categoria'], negozio: r['Account'], tipo: r['Tipo'] };
    if ((r['Tipo'] || '').toLowerCase() !== 'vendita') { scartate.push({ ...base, motivo: `tipo "${r['Tipo']}" (non vendita)` }); continue; }
    if (!NEGOZI.includes(r['Account'])) { scartate.push({ ...base, motivo: `negozio "${r['Account']}" sconosciuto` }); continue; }
    const p = parseDescrizioneVendita(desc);
    if (p.errore) { scartate.push({ ...base, motivo: p.errore }); continue; }
    const qta = parseInt(r['Quantità'] || '1', 10) || 1;
    const dataISO = parseDataIt(r['Data']);
    if (!dataISO) { scartate.push({ ...base, motivo: 'data non riconosciuta' }); continue; }
    const k = `${r['ID Transazione']}|${desc}|${r['Account']}|${dataISO}|${r['Prezzo (lordo)'] || ''}`;
    const n = (occorrenze.get(k) || 0) + 1;
    occorrenze.set(k, n);
    riconosciute.push({ ...base, dataISO, codice: p.codice, formato: p.ml, quantita: qta, ml: p.ml * qta, chiave: `${k}#${n}` });
  }
  return { riconosciute, scartate };
}
