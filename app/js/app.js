import { NEGOZI, CATEGORIE, categoriaDaCodice, normalizzaMagazzino, parseCSV, analizzaVendite } from './normalizza.js';
import { LocalStore, statoVuoto } from './store.js';

const store = new LocalStore();
let stato = store.load();
if (!stato.obiettivi) { stato.obiettivi = {}; for (const c of CATEGORIE) stato.obiettivi[c] = (Number(stato.soglie[c]) || 0) * 2; }
if (!stato.piano) stato.piano = { riordini: {}, spostamenti: {} };
if (!stato.ordini) stato.ordini = [];
if (!stato.fornitori) stato.fornitori = [];
for (const f of Object.values(stato.fragranze)) { if (!f.codiciFornitore) f.codiciFornitore = {}; }
const SETTIMANE_MIN = 4;   // settimane di vendite necessarie per attivare le proposte basate sulla copertura
const ORIZZONTE_SETT = 8;  // nessuna proposta porta chi riceve oltre questa copertura: evita di svuotare chi cede
let tab = 'magazzino';
let filtro = { testo: '', negozio: null, categoria: null, stato: null, sort: 'codice', dir: 1 };
let pannelloAperto = false;   // apertura del pannello "Da riordinare o spostare", scelta dall'utente
let anteprimaVendite = null;   // risultato analisi CSV in attesa di conferma
let anteprimaGiacenze = null;  // risultato analisi Excel in attesa di conferma
let ricezione = null;          // id dell'ordine di cui si sta registrando la consegna

// ---------- utilità ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtMl = n => (Number(n) || 0).toLocaleString('it-IT') + ' ml';
const fmtData = iso => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
};
const adesso = () => new Date().toISOString();
const altro = negozio => NEGOZI.find(n => n !== negozio);

function salva(etichetta) {
  if (!store.save(stato, etichetta)) toast('Attenzione: salvataggio non riuscito (spazio del browser esaurito?)');
}
function toast(msg, azione) {
  const t = $('#toast'); t.innerHTML = esc(msg) + (azione ? ` <button class="piccolo" id="toast-az">${esc(azione.label)}</button>` : '');
  t.style.pointerEvents = azione ? 'auto' : 'none';
  if (azione) $('#toast-az').onclick = () => { t.classList.remove('on'); azione.fn(); };
  t.classList.add('on');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), azione ? 7000 : 3000);
}
function conferma(titolo, testo, okLabel = 'Conferma', pericolo = false) {
  return new Promise(res => {
    const d = $('#dlg');
    d.innerHTML = `<h2>${esc(titolo)}</h2><p>${testo}</p><div class="azioni"><button id="dlg-no">Annulla</button><button id="dlg-ok" class="${pericolo ? 'pericolo' : 'primario'}">${esc(okLabel)}</button></div>`;
    $('#dlg-no').onclick = () => { d.close(); res(false); };
    $('#dlg-ok').onclick = () => { d.close(); res(true); };
    d.showModal();
  });
}

// ---------- modello ----------
function sogliaDi(f) { return f.soglia != null && f.soglia !== '' ? Number(f.soglia) : Number(stato.soglie[f.categoria] ?? 0); }
function obiettivoDi(f) { const o = f.obiettivo != null && f.obiettivo !== '' ? Number(f.obiettivo) : Number(stato.obiettivi[f.categoria] ?? 0); return Math.max(o, sogliaDi(f)); }
/** ml venduti a settimana per codice e negozio, sul periodo coperto dalle vendite caricate. */
function velocita() {
  const vend = movimentiValidi().filter(m => m.tipo === 'vendita' && m.dataEvento);
  if (!vend.length) return { attiva: false, settimane: 0, per: {} };
  const date = vend.map(m => m.dataEvento).sort();
  const giorni = (new Date(date.at(-1)) - new Date(date[0])) / 864e5 + 1;
  const settimane = giorni / 7;
  const per = {};
  for (const m of vend) { (per[m.codice] ??= {})[m.negozio] = (per[m.codice][m.negozio] || 0) - Number(m.ml); }
  for (const c in per) for (const n in per[c]) per[c][n] = per[c][n] / settimane;
  return { attiva: settimane >= SETTIMANE_MIN, settimane, dal: date[0], al: date.at(-1), per };
}
function copertura(ml, mlSett) { return mlSett > 0 ? ml / mlSett : Infinity; }
function fmtCop(sett) { if (!isFinite(sett)) return 'nessuna vendita'; if (sett < 1) return `${Math.round(sett * 7)} gg`; return `${sett.toLocaleString('it-IT', { maximumFractionDigits: 1 })} sett.`; }
/**
 * Proposta di spostamento verso `ricevente` per la referenza f.
 * Regola base: riporta chi riceve alla scorta obiettivo prelevando solo l'eccedenza sopra la minima di chi cede.
 * Con abbastanza vendite caricate: equilibra la copertura (settimane di vendita) tra i due negozi, con lo stesso limite.
 */
function proposta(f, ricevente, g, vel) {
  const mittente = altro(ricevente);
  const gR = g[f.codice]?.[ricevente] || 0, gM = g[f.codice]?.[mittente] || 0;
  const minima = sogliaDi(f), obiettivo = obiettivoDi(f);
  const inArrivo = stato.trasferimenti.filter(t => t.codice === f.codice && t.a === ricevente && (t.stato === 'proposto' || t.stato === 'spedito')).reduce((a, t) => a + t.ml, 0);
  if (inArrivo) return { tipo: 'in_arrivo', ml: inArrivo };
  const ordinato = mlInOrdine(f.codice, ricevente);
  const gRatteso = gR + ordinato;   // la merce ordinata non è ancora in giacenza, ma è già coperta
  const cedibile = gM - minima;
  let ml = obiettivo - gRatteso, modo = 'obiettivo';
  if (vel.attiva) {
    const vR = vel.per[f.codice]?.[ricevente] || 0, vM = vel.per[f.codice]?.[mittente] || 0;
    if (vR > 0) {
      const equilibrio = (vR * gM - vM * gRatteso) / (vR + vM);
      // tetto: non portare chi riceve oltre ORIZZONTE_SETT settimane di copertura (né sotto quanto serve per l'obiettivo)
      ml = Math.min(equilibrio, Math.max(vR * ORIZZONTE_SETT - gRatteso, obiettivo - gRatteso));
      modo = 'copertura';
    }
  }
  ml = Math.floor(Math.min(ml, cedibile) / 10) * 10;
  if (ml < 50) {
    let motivo = ordinato ? `${ricevente} ha già ${fmtMl(ordinato)} in ordine` : cedibile < 50 ? `${mittente} ha solo ${fmtMl(Math.max(0, cedibile))} oltre la scorta minima` : modo === 'copertura' ? `${ricevente} ha già scorta sufficiente rispetto a ${mittente}` : 'spostamento troppo piccolo';
    return { tipo: 'no', motivo, ordinato };
  }
  return { tipo: 'sposta', ml, da: mittente, a: ricevente, resta: gM - ml, modo, ordinato };
}
function lottiAnnullati() { return new Set(stato.lotti.filter(l => l.annullato).map(l => l.id)); }
function movimentiValidi() { const ann = lottiAnnullati(); return stato.movimenti.filter(m => !m.lotto || !ann.has(m.lotto)); }
function giacenze() {
  const g = {};
  for (const c of Object.keys(stato.fragranze)) { g[c] = { Latina: 0, Aprilia: 0, transito: 0 }; }
  for (const m of movimentiValidi()) {
    if (!g[m.codice]) g[m.codice] = { Latina: 0, Aprilia: 0, transito: 0 };
    g[m.codice][m.negozio] = (g[m.codice][m.negozio] || 0) + Number(m.ml);
  }
  for (const t of stato.trasferimenti) if (t.stato === 'spedito') { if (!g[t.codice]) g[t.codice] = { Latina: 0, Aprilia: 0, transito: 0 }; g[t.codice].transito += Number(t.ml); }
  return g;
}
function statoScorta(ml, soglia) { if (ml <= 0) return 'esaurito'; if (ml < soglia) return 'sotto'; return 'ok'; }
function fragranzeOrdinate() { return Object.values(stato.fragranze).sort((a, b) => a.codice.localeCompare(b.codice)); }
function nomeF(codice) { const f = stato.fragranze[codice]; return f ? `${f.codice} ${f.brand ? f.brand + ' - ' : ''}${f.nome}` : `${codice} (non in anagrafica)`; }
function aggiungiMovimento(m) { stato.movimenti.push({ id: nId(), ts: adesso(), ...m }); }
function assicuraFragranza(codice, extra = {}) {
  if (!stato.fragranze[codice]) stato.fragranze[codice] = { codice, brand: '', nome: '(da completare)', categoria: categoriaDaCodice(codice), varianti: [], soglia: null, fornitore: '', codiciFornitore: {}, costo: '', attivo: true, note: '', ...extra };
  return stato.fragranze[codice];
}
function ultimoAggiornamento() {
  const out = {};
  for (const n of NEGOZI) {
    const mv = movimentiValidi().filter(m => m.negozio === n);
    const vend = mv.filter(m => m.tipo === 'vendita');
    out[n] = {
      ultimaVendita: vend.length ? vend.map(m => m.dataEvento).sort().at(-1) : null,
      ultimoMovimento: mv.length ? mv.map(m => m.ts).sort().at(-1) : null,
    };
  }
  return out;
}
function sottoScorta() {
  const g = giacenze(); const out = [];
  for (const f of fragranzeOrdinate()) {
    if (f.attivo === false) continue;
    const s = sogliaDi(f);
    for (const n of NEGOZI) { const ml = g[f.codice]?.[n] ?? 0; const st = statoScorta(ml, s); if (st !== 'ok') out.push({ f, negozio: n, ml, soglia: s, stato: st }); }
  }
  return out;
}

// ---------- fornitori ----------
function registraFornitore(sigla, nome) {
  sigla = String(sigla || '').trim(); if (!sigla) return null;
  let f = stato.fornitori.find(x => x.sigla === sigla);
  if (!f) { f = { sigla, nome: nome || sigla }; stato.fornitori.push(f); }
  return f;
}
function nomeFornitore(sigla) { const f = stato.fornitori.find(x => x.sigla === sigla); return f ? f.nome : (sigla || ''); }
function fornitoriDi(f) { return Object.entries(f?.codiciFornitore || {}).filter(([, c]) => String(c || '').trim()).map(([s]) => s); }
function fornitorePreferito(f) { const l = fornitoriDi(f); if (f?.fornitore && l.includes(f.fornitore)) return f.fornitore; return l[0] || null; }
function codiceFornitore(f, sigla) { return String(f?.codiciFornitore?.[sigla] || '').trim(); }
/** Aggiorna l'anagrafica con una riga normalizzata dell'inventario (nome se mancante, categoria, codici fornitore, varianti). */
function aggiornaAnagraficaDaInventario(f) {
  const e = stato.fragranze[f.codice];
  if (!e) { assicuraFragranza(f.codice, { brand: f.brand, nome: f.nome, categoria: f.categoria, varianti: f.varianti, codiciFornitore: { ...f.fornitori } }); }
  else {
    e.varianti = [...new Set([...(e.varianti || []), ...(f.varianti || [])])];
    if (e.nome === '(da completare)') { e.nome = f.nome; e.brand = f.brand; }
    if (f.categoria) e.categoria = f.categoria;
    e.codiciFornitore = e.codiciFornitore || {};
    for (const [s, c] of Object.entries(f.fornitori || {})) if (c) e.codiciFornitore[s] = c;
  }
  for (const s of Object.keys(f.fornitori || {})) registraFornitore(s);
}
// ---------- ordini: righe, Excel, stampa ----------
function righeOrdine(sigla, negozio, voci, g) {
  return voci.map(r => { const f = stato.fragranze[r.codice]; return { codiceFornitore: sigla ? codiceFornitore(f, sigla) : '', codice: r.codice, nome: `${f.brand ? f.brand + ' - ' : ''}${f.nome}`, categoria: f.categoria, giacenza: g?.[r.codice]?.[negozio] ?? r.giacenza ?? 0, ml: r.ml, note: r.note || '' }; });
}
function nomeFileOrdine(o, est) { return `ordine-${(o.fornitore || 'senza-fornitore').replace(/[^\w-]/g, '')}-${o.negozio}-${new Date(o.ts).toISOString().slice(0, 10)}.${est}`; }
function excelOrdine(o) {
  if (!window.XLSX) { toast('Libreria Excel non disponibile.'); return; }
  const int = `Ordine ${nomeFornitore(o.fornitore)}${o.fornitore && o.fornitore !== nomeFornitore(o.fornitore) ? ` (${o.fornitore})` : ''} · consegna ${o.negozio} · ${fmtData(o.ts)}`;
  const aoa = [[int], [], [`Codice ${o.fornitore || 'fornitore'}`, 'Nostro codice', 'Prodotto', 'Categoria', 'Quantità (ml)', 'Note'],
    ...o.righe.map(r => [r.codiceFornitore, r.codice, r.nome, r.categoria, r.ml, r.note]), [], ['', '', 'Totale', '', o.righe.reduce((a, r) => a + r.ml, 0), '']];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 14 }, { wch: 13 }, { wch: 44 }, { wch: 12 }, { wch: 14 }, { wch: 30 }];
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Ordine');
  XLSX.writeFile(wb, nomeFileOrdine(o, 'xlsx'));
}
function stampaOrdine(o) {
  let box = $('#stampa'); if (!box) { box = document.createElement('div'); box.id = 'stampa'; document.body.appendChild(box); }
  box.innerHTML = `<div class="testata"><img src="logo.svg" alt="i profumari" class="logo-stampa"><div><div class="tit">Ordine di acquisto</div><div>Fornitore: <b>${esc(nomeFornitore(o.fornitore))}${o.fornitore && o.fornitore !== nomeFornitore(o.fornitore) ? ` (${esc(o.fornitore)})` : ''}</b></div><div>Consegna presso: <b>i profumari · ${esc(o.negozio)}</b></div><div>Data: ${fmtData(o.ts)}</div></div></div>
    <table><thead><tr><th>Codice ${esc(o.fornitore || 'fornitore')}</th><th>Nostro codice</th><th>Prodotto</th><th class="num">Quantità (ml)</th><th>Note</th></tr></thead>
    <tbody>${o.righe.map(r => `<tr><td class="cod">${esc(r.codiceFornitore) || '<span class="manca">manca</span>'}</td><td>${r.codice}</td><td>${esc(r.nome)}</td><td class="num">${r.ml}</td><td>${esc(r.note)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="3">Totale · ${o.righe.length} ${o.righe.length === 1 ? 'voce' : 'voci'}</td><td class="num">${o.righe.reduce((a, r) => a + r.ml, 0)}</td><td></td></tr></tfoot></table>`;
  document.body.classList.add('modo-stampa');
  const fine = () => { document.body.classList.remove('modo-stampa'); window.removeEventListener('afterprint', fine); };
  window.addEventListener('afterprint', fine);
  window.print();
  setTimeout(fine, 2000);
}
function testoOrdine(o) {
  return [`ORDINE ${nomeFornitore(o.fornitore)} · consegna ${o.negozio} · ${fmtData(o.ts)}`, ...o.righe.map(r => `${r.codiceFornitore || '???'}  ${r.codice} ${r.nome}  |  ${r.ml} ml${r.note ? '  |  ' + r.note : ''}`), `Totale: ${o.righe.reduce((a, r) => a + r.ml, 0)} ml`].join('\n');
}
async function copiaTesto(testo) { try { await navigator.clipboard.writeText(testo); toast('Copiato negli appunti.'); } catch { toast('Copia non riuscita: usa Excel o Stampa.'); } }
function dialogOrdine(o) {
  const d = $('#dlg');
  d.innerHTML = `<h2>Ordine ${esc(nomeFornitore(o.fornitore))} · ${esc(o.negozio)}</h2><p class="muted">${fmtData(o.ts)} · ${o.righe.length} voci · ${fmtMl(o.righe.reduce((a, r) => a + r.ml, 0))} · ${badgeOrdine(o)}</p>
    <div class="tabella-wrap"><table><thead><tr><th>Cod. ${esc(o.fornitore || 'forn.')}</th><th>Codice</th><th>Prodotto</th><th class="num">Ordinati</th><th>Consegna</th><th>Nota</th></tr></thead><tbody>${o.righe.map(r => `<tr><td class="cod">${esc(r.codiceFornitore)}</td><td>${r.codice}</td><td>${esc(r.nome)}</td><td class="num"><b>${r.ml}</b></td><td>${r.annullata ? '<span class="badge grigio">annullata</span>' : r.ricevutoMl != null ? `<span class="badge ${r.ricevutoMl === r.ml ? 'ok' : 'sotto'}">ricevuti ${r.ricevutoMl}</span>` : '<span class="badge neutro">in attesa</span>'}</td><td>${esc(r.note)}</td></tr>`).join('')}</tbody></table></div>
    <div class="azioni"><button id="ord-excel">Excel</button><button id="ord-stampa">Stampa / PDF</button><button id="ord-copia">Copia testo</button><button id="ord-chiudi" class="primario">Chiudi</button></div>`;
  $('#ord-chiudi').onclick = () => d.close();
  $('#ord-excel').onclick = () => excelOrdine(o);
  $('#ord-stampa').onclick = () => { d.close(); stampaOrdine(o); };
  $('#ord-copia').onclick = () => copiaTesto(testoOrdine(o));
  d.showModal();
}

// ---------- ricezione ordini ----------
function righePendenti(o) { return o.righe.filter(r => r.ricevutoMl == null && !r.annullata); }
/** ml confermati ai fornitori e non ancora ricevuti, per codice e negozio di consegna. */
function inOrdine() {
  const m = {};
  for (const o of stato.ordini) for (const r of righePendenti(o)) { (m[r.codice] ??= {})[o.negozio] = (m[r.codice]?.[o.negozio] || 0) + r.ml; }
  return m;
}
/**
 * Trasferimenti aperti, per codice e negozio: `arrivo` = ml che entreranno (proposti o spediti),
 * `uscita` = ml che usciranno ma non sono ancora stati scalati (solo i proposti: gli spediti sono già fuori giacenza).
 */
function movimentiAttesi() {
  const m = {};
  const voce = (c, n) => ((m[c] ??= {})[n] ??= { arrivo: 0, uscita: 0 });
  for (const t of stato.trasferimenti) {
    if (t.stato !== 'proposto' && t.stato !== 'spedito') continue;
    voce(t.codice, t.a).arrivo += Number(t.ml);
    if (t.stato === 'proposto') voce(t.codice, t.da).uscita += Number(t.ml);
  }
  return m;
}
function mlInOrdine(codice, negozio) { let t = 0; for (const o of stato.ordini) if (o.negozio === negozio) for (const r of righePendenti(o)) if (r.codice === codice) t += r.ml; return t; }
function statoOrdine(o) {
  const pend = righePendenti(o).length, ric = o.righe.filter(r => r.ricevutoMl != null).length;
  if (!pend) return ric ? 'ricevuto' : 'annullato';
  return ric || o.righe.some(r => r.annullata) ? 'parziale' : 'in attesa';
}
function badgeOrdine(o) { const s = statoOrdine(o); return `<span class="badge ${s === 'ricevuto' ? 'ok' : s === 'in attesa' ? 'neutro' : s === 'parziale' ? 'sotto' : 'grigio'}">${s}</span>`; }
/** Scheda di ricezione di un ordine: una riga per voce con stato e ml ricevuti, poi carico a magazzino. */
function cardRicezione(o, g) {
  const pend = righePendenti(o), fatte = o.righe.filter(r => r.ricevutoMl != null || r.annullata);
  const riga = (r, i) => `<tr><td class="cod">${esc(r.codiceFornitore) || '<span class="muted">–</span>'}</td><td>${r.codice} ${esc(r.nome)}${r.note ? `<div class="cop">${esc(r.note)}</div>` : ''}</td><td class="num">${fmtMl(g[r.codice]?.[o.negozio] || 0)}</td><td class="num">${r.ml}</td>
    <td><select class="mini-sel" data-ric-stato="${i}"><option value="ok">Ricevuto</option><option value="attesa">Non arrivato, resta in attesa</option><option value="annulla">Non arriverà, annulla</option></select></td>
    <td class="num"><input class="mini" type="number" min="0" step="10" inputmode="numeric" value="${r.ml}" data-ric-ml="${i}"></td></tr>`;
  return `<div class="card info" id="ricezione"><h2>Consegna ordine ${esc(nomeFornitore(o.fornitore))} · ${esc(o.negozio)} <span class="muted piccolo-testo">del ${fmtData(o.ts)}</span></h2>
    <p class="muted">Per ogni voce: lascia <b>Ricevuto</b> con la quantità ordinata se è tutto a posto, correggi i ml se il fornitore ha mandato una quantità diversa, oppure segna la voce come non arrivata (resta in attesa) o annullata. Al carico i ml ricevuti entrano nella giacenza di <b>${esc(o.negozio)}</b>.</p>
    <div class="azioni" style="margin:0 0 10px"><button class="piccolo" data-ric-tutti="ok">Tutto ricevuto come ordinato</button><button class="piccolo" data-ric-tutti="attesa">Niente arrivato</button></div>
    <div class="tabella-wrap"><table><thead><tr><th>Cod. ${esc(o.fornitore || 'forn.')}</th><th>Prodotto</th><th class="num">Giacenza ora</th><th class="num">Ordinati</th><th>Esito</th><th class="num">Ricevuti ml</th></tr></thead><tbody>${o.righe.map((r, i) => r.ricevutoMl == null && !r.annullata ? riga(r, i) : '').join('')}</tbody></table></div>
    ${fatte.length ? `<details style="margin-top:10px"><summary>Voci già chiuse (${fatte.length})</summary><ul class="pulita piccolo-testo">${fatte.map(r => `<li>${r.codice} ${esc(r.nome)} · ordinati ${r.ml} ml · ${r.annullata ? '<span class="badge grigio">annullata</span>' : `<span class="badge ok">ricevuti ${r.ricevutoMl} ml</span> il ${fmtData(r.ricevutoTs)}`}</li>`).join('')}</ul></details>` : ''}
    <p id="ric-riepilogo" class="piccolo-testo" style="margin:10px 0 0"></p>
    <div class="azioni"><button id="ric-annulla">Chiudi senza caricare</button><button id="ric-conferma" class="primario">Carica a magazzino</button></div></div>`;
}
function collegaRicezione(o, el) {
  const box = $('#ricezione', el); if (!box) return;
  const leggi = () => $$('[data-ric-stato]', box).map(s => { const i = Number(s.dataset.ricStato); const ml = Number($(`[data-ric-ml="${i}"]`, box).value) || 0; return { i, esito: s.value, ml }; });
  const riepilogo = () => {
    const v = leggi(); const ok = v.filter(x => x.esito === 'ok'); const tot = ok.reduce((a, x) => a + x.ml, 0);
    $('#ric-riepilogo').innerHTML = `Da caricare a ${esc(o.negozio)}: <b>${ok.length}</b> voci per <b>${fmtMl(tot)}</b>${v.some(x => x.esito === 'attesa') ? ` · ${v.filter(x => x.esito === 'attesa').length} restano in attesa` : ''}${v.some(x => x.esito === 'annulla') ? ` · ${v.filter(x => x.esito === 'annulla').length} annullate` : ''}.`;
    $$('[data-ric-ml]', box).forEach(i => { i.disabled = $(`[data-ric-stato="${i.dataset.ricMl}"]`, box).value !== 'ok'; });
  };
  $$('[data-ric-stato], [data-ric-ml]', box).forEach(x => { x.onchange = riepilogo; x.oninput = riepilogo; });
  $$('[data-ric-tutti]', box).forEach(b => b.onclick = () => { $$('[data-ric-stato]', box).forEach(s => { s.value = b.dataset.ricTutti; }); riepilogo(); });
  $('#ric-annulla').onclick = () => { ricezione = null; render(); };
  $('#ric-conferma').onclick = async () => {
    const v = leggi(); const ok = v.filter(x => x.esito === 'ok' && x.ml > 0);
    const tot = ok.reduce((a, x) => a + x.ml, 0);
    if (!ok.length && !v.some(x => x.esito === 'annulla')) { toast('Nessuna voce ricevuta o annullata.'); return; }
    if (!await conferma('Registrare la consegna?', `<b>${ok.length}</b> voci per <b>${fmtMl(tot)}</b> entrano in giacenza a <b>${esc(o.negozio)}</b>.${v.some(x => x.esito === 'attesa') ? `<br>${v.filter(x => x.esito === 'attesa').length} voci restano in attesa di una prossima consegna.` : ''}${v.some(x => x.esito === 'annulla') ? `<br>${v.filter(x => x.esito === 'annulla').length} voci vengono annullate.` : ''}`, 'Carica')) return;
    const ts = adesso();
    for (const x of v) {
      const r = o.righe[x.i];
      if (x.esito === 'ok' && x.ml > 0) { r.ricevutoMl = x.ml; r.ricevutoTs = ts; aggiungiMovimento({ dataEvento: ts, negozio: o.negozio, codice: r.codice, tipo: 'carico', ml: x.ml, rif: o.id, note: `Ordine ${nomeFornitore(o.fornitore)} del ${fmtData(o.ts).slice(0, 10)}${x.ml !== r.ml ? ` (ordinati ${r.ml})` : ''}` }); }
      else if (x.esito === 'annulla') { r.annullata = true; r.ricevutoTs = ts; }
    }
    ricezione = null; salva(`consegna ordine ${o.fornitore} ${o.negozio}`);
    toast(`Caricati ${fmtMl(tot)} a ${o.negozio} (${ok.length} voci). Ordine: ${statoOrdine(o)}.`); render();
  };
  riepilogo();
}

// ---------- render ----------
function render() {
  renderHeader();
  $$('#tabs button').forEach(b => b.classList.toggle('attivo', b.dataset.tab === tab));
  $$('section.tab').forEach(s => s.classList.toggle('attivo', s.id === 'tab-' + tab));
  const n = sottoScorta().length;
  const bt = $('#tabs button[data-tab=magazzino]'); bt.innerHTML = 'Giacenze' + (n ? `<span class="n">${n}</span>` : '');
  const nt = stato.trasferimenti.filter(t => t.stato !== 'ricevuto' && t.stato !== 'annullato').length;
  $('#tabs button[data-tab=trasferimenti]').innerHTML = 'Trasferimenti' + (nt ? `<span class="n">${nt}</span>` : '');
  const np = contaPiano(); $('#tabs button[data-tab=piano]').innerHTML = 'Piano' + (np ? `<span class="n teal">${np}</span>` : '');
  ({ magazzino: renderMagazzino, piano: renderPiano, vendite: renderVendite, trasferimenti: renderTrasferimenti, movimenti: renderMovimenti, anagrafica: renderAnagrafica, storico: renderStorico })[tab]();
}
function renderHeader() {
  const u = ultimoAggiornamento();
  $('#aggiornamento').innerHTML = NEGOZI.map(n => `<div><b>${n}</b>: vendite fino al <b>${fmtData(u[n].ultimaVendita)}</b> · ultimo movimento ${fmtData(u[n].ultimoMovimento)}</div>`).join('');
}

function chiavePiano(codice, negozio) { return `${codice}|${negozio}`; }
function arr10(x, su) { return su ? Math.ceil(x / 10) * 10 : Math.floor(x / 10) * 10; }
function salvaPiano() { store.save(stato, 'piano', false); }
function contaPiano() { return Object.keys(stato.piano.riordini).length + Object.keys(stato.piano.spostamenti).length; }
function mlRiordinoDefault(f, negozio, g) { const serve = obiettivoDi(f) - (g[f.codice]?.[negozio] || 0); return serve >= 10 ? arr10(serve, true) : 100; }
function mlSpostamentoDefault(f, ricevente, g, p) {
  if (p.tipo === 'sposta') return p.ml;
  const gM = g[f.codice]?.[altro(ricevente)] || 0;
  const serve = Math.max(100, arr10(obiettivoDi(f) - (g[f.codice]?.[ricevente] || 0), true));
  const cedibile = arr10(gM - sogliaDi(f), false);
  // se chi cede ha eccedenza, si usa quella; altrimenti si propone di dividere a metà quello che ha
  return Math.max(10, cedibile >= 10 ? Math.min(serve, cedibile) : Math.min(serve, arr10(gM / 2, false)));
}
const ETICH_STATO = { sotto: 'Sotto scorta', esaurito: 'Esaurite', ok: 'A posto', transito: 'Con trasferimenti in corso', ordine: 'Con ordini in attesa' };

function renderMagazzino() {
  const el = $('#tab-magazzino');
  const fr = fragranzeOrdinate();
  if (!fr.length) {
    el.innerHTML = `<div class="card benvenuto"><img src="logo.svg" alt="i profumari"><h2>Il magazzino è vuoto</h2><p>Per iniziare importa le giacenze iniziali di ciascun negozio dal file Excel dell'inventario (scheda <b>Carichi</b> → "Importa inventario da Excel"), poi carica le vendite dal CSV del gestionale.</p><div class="azioni"><button class="primario" data-vai="movimenti">Importa l'inventario</button>${window.DATI_DEMO ? `<button id="btn-demo">Prova con i dati dimostrativi</button>` : ''}</div>${window.DATI_DEMO ? `<p class="piccolo-testo" style="margin-top:14px;opacity:.7">I dati dimostrativi usano l'inventario reale di Latina, un inventario simulato per Aprilia e sei settimane di vendite simulate.</p>` : ''}</div>`;
    const bd = $('#btn-demo'); if (bd) bd.onclick = caricaDemo;
    return;
  }
  const g = giacenze();
  const vel = velocita();
  const ord = inOrdine();
  const att = movimentiAttesi();
  const ss = sottoScorta();
  const tot = {}; for (const n of NEGOZI) tot[n] = fr.reduce((a, f) => a + (g[f.codice]?.[n] || 0), 0);
  const transito = fr.reduce((a, f) => a + (g[f.codice]?.transito || 0), 0);
  const q = filtro.testo.trim().toLowerCase();
  const statoDi = (f, n) => statoScorta(g[f.codice]?.[n] || 0, sogliaDi(f));
  const negoziFiltro = filtro.negozio ? [filtro.negozio] : NEGOZI;
  const passaFiltro = f => {
    if (f.attivo === false && !q) return false;
    if (q && !(`${f.codice} ${f.brand} ${f.nome}`.toLowerCase().includes(q))) return false;
    if (filtro.categoria && f.categoria !== filtro.categoria) return false;
    if (filtro.stato === 'sotto' && !negoziFiltro.some(n => statoDi(f, n) !== 'ok')) return false;
    if (filtro.stato === 'esaurito' && !negoziFiltro.some(n => statoDi(f, n) === 'esaurito')) return false;
    if (filtro.stato === 'ok' && !negoziFiltro.every(n => statoDi(f, n) === 'ok')) return false;
    if (filtro.stato === 'transito' && !negoziFiltro.some(n => (att[f.codice]?.[n]?.arrivo || 0) + (att[f.codice]?.[n]?.uscita || 0))) return false;
    if (filtro.stato === 'ordine' && !negoziFiltro.some(n => ord[f.codice]?.[n])) return false;
    return true;
  };
  const chiaveOrd = f => ({ codice: f.codice, nome: `${f.brand} ${f.nome}`.toLowerCase(), categoria: f.categoria, Latina: g[f.codice]?.Latina || 0, Aprilia: g[f.codice]?.Aprilia || 0, minima: sogliaDi(f) })[filtro.sort] ?? f.codice;
  const visibili = fr.filter(passaFiltro).sort((a, b) => { const x = chiaveOrd(a), y = chiaveOrd(b); return ((x < y ? -1 : x > y ? 1 : 0) * filtro.dir) || a.codice.localeCompare(b.codice); });
  const th = (key, label, cls = '') => `<th class="${cls} ord${filtro.sort === key ? ' attivo' : ''}" data-sort="${key}">${label}<span class="freccia">${filtro.sort === key ? (filtro.dir > 0 ? '▲' : '▼') : '↕'}</span></th>`;
  const cellaMl = (f, n) => {
    const ml = g[f.codice]?.[n] || 0, st = statoDi(f, n);
    const io = ord[f.codice]?.[n] || 0, a = att[f.codice]?.[n] || {};
    const mov = [
      io ? `<span class="badge ordine" title="Ordinato al fornitore, non ancora consegnato">+${fmtMl(io)} ordine</span>` : '',
      a.arrivo ? `<span class="badge arrivo" title="In arrivo dall'altro negozio">+${fmtMl(a.arrivo)} arrivo</span>` : '',
      a.uscita ? `<span class="badge uscita" title="Da spedire all'altro negozio, ancora in giacenza">−${fmtMl(a.uscita)} uscita</span>` : '',
    ].filter(Boolean).join(' ');
    return `<td class="num${filtro.negozio === n ? ' evid' : ''}"><span class="badge ${st}">${fmtMl(ml)}</span>${mov ? `<div class="mov">${mov}</div>` : ''}${vel.attiva ? `<div class="cop">${fmtCop(copertura(ml, vel.per[f.codice]?.[n] || 0))}</div>` : ''}</td>`;
  };
  const righe = visibili.map(f => {
    return `<tr><td class="cod">${f.codice}</td><td>${esc(f.brand ? f.brand + ' - ' : '')}${esc(f.nome)}${f.attivo === false ? ' <span class="badge grigio">disattivata</span>' : ''}</td><td class="muted piccolo-testo">${esc(f.categoria)}</td>${NEGOZI.map(n => cellaMl(f, n)).join('')}<td class="num muted">${sogliaDi(f)} / ${obiettivoDi(f)}</td><td><button class="piccolo azione-piano" data-piu="${f.codice}" title="Ordina o sposta questa referenza">Ordina o sposta</button></td></tr>`;
  }).join('');

  const chips = [];
  if (filtro.negozio) chips.push(['negozio', filtro.negozio]);
  if (filtro.stato) chips.push(['stato', ETICH_STATO[filtro.stato]]);
  if (filtro.categoria) chips.push(['categoria', filtro.categoria]);
  const ssVis = ss.filter(x => (!filtro.negozio || x.negozio === filtro.negozio) && (!filtro.categoria || x.f.categoria === filtro.categoria));
  const nPiano = contaPiano();
  const spiegazione = vel.attiva
    ? `Con <b>${vel.settimane.toLocaleString('it-IT', { maximumFractionDigits: 0 })} settimane</b> di vendite caricate (dal ${fmtData(vel.dal).slice(0, 10)} al ${fmtData(vel.al).slice(0, 10)}), le proposte <b>equilibrano la copertura</b>, cioè le settimane di vendita che ogni negozio ha davanti. Chi cede non scende mai sotto la propria scorta minima.`
    : `Le proposte riportano il negozio in difficoltà alla <b>scorta obiettivo</b>, prelevando solo quello che l'altro negozio ha <b>oltre la scorta minima</b>. Quando saranno caricate almeno ${SETTIMANE_MIN} settimane di vendite (oggi: ${vel.settimane.toLocaleString('it-IT', { maximumFractionDigits: 1 })}), le proposte terranno conto anche di quanto vende ciascun negozio.`;
  const rigaProposta = x => {
    const p = proposta(x.f, x.negozio, g, vel);
    const mitt = altro(x.negozio); const alt = g[x.f.codice]?.[mitt] || 0;
    const k = chiavePiano(x.f.codice, x.negozio);
    const giaOrd = ord[x.f.codice]?.[x.negozio] || 0;
    const rio = stato.piano.riordini[k], spo = stato.piano.spostamenti[k];
    const spoPossibile = alt > 0 && p.tipo !== 'in_arrivo';
    const cop = n => vel.attiva ? `<div class="cop">${fmtCop(copertura(g[x.f.codice]?.[n] || 0, vel.per[x.f.codice]?.[n] || 0))}</div>` : '';
    let info;
    if (giaOrd) info = `<span class="badge ordine">già ordinati ${fmtMl(giaOrd)}</span> in attesa di consegna${p.tipo === 'sposta' ? ` · si può anche spostare subito ${p.ml} ml da ${p.da}` : ''}`;
    else if (p.tipo === 'sposta') info = `Proposta: <b>${p.ml} ml da ${p.da}</b> · ${p.da} resta con ${fmtMl(p.resta)}${p.modo === 'copertura' ? ' · copertura pari' : ''}`;
    else if (p.tipo === 'in_arrivo') info = `<span class="badge neutro">in arrivo ${fmtMl(p.ml)}</span> vedi Trasferimenti`;
    else info = `<span class="badge sotto">da riordinare</span> ${esc(p.motivo)}`;
    return `<tr class="${x.stato}"><td class="cod">${x.f.codice}</td><td>${esc(x.f.brand)} ${esc(x.f.nome)}<div class="cop">${esc(x.f.categoria)}</div></td><td>${x.negozio}</td><td class="num"><span class="badge ${x.stato}">${fmtMl(x.ml)}</span>${giaOrd ? `<div class="cop"><span class="badge ordine">+${fmtMl(giaOrd)}</span></div>` : ''}${cop(x.negozio)}</td><td class="num muted">${x.soglia} / ${obiettivoDi(x.f)}</td><td class="num">${mitt}: ${fmtMl(alt)}${cop(mitt)}</td>
      <td class="pian"><div class="cop">${info}</div>
        <label class="chk2"><input type="checkbox" data-rio="${k}" ${rio ? 'checked' : ''}> Riordina${rio ? ` <b>${rio.ml} ml</b>` : ''}${giaOrd && !rio ? ` <span class="muted">(ancora?)</span>` : ''}</label>
        <label class="chk2${spoPossibile ? '' : ' disab'}"><input type="checkbox" data-spo="${k}" ${spo ? 'checked' : ''} ${spoPossibile ? '' : 'disabled'}> Sposta da ${mitt}${spo ? ` <b>${spo.ml} ml</b>` : ''}</label></td></tr>`;
  };
  const kpi = (cls, v, l, dati) => `<button class="card kpi-btn ${cls}" data-kpi='${JSON.stringify(dati)}' title="Apri la vista filtrata"><div class="v">${v}</div><div class="l">${l}</div></button>`;
  el.innerHTML = `
    <div class="kpi">
      ${NEGOZI.map(n => { const k = ss.filter(x => x.negozio === n).length; return kpi(k ? 'warn' : '', k, `sotto scorta a ${n}`, { negozio: n, stato: 'sotto', sort: n, dir: 1 }) + kpi('', `${(tot[n] / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} L`, `totale ${n} · ${fr.length} referenze`, { negozio: n, stato: null, sort: n, dir: -1 }); }).join('')}
      ${kpi('teal', fmtMl(transito), 'in transito tra negozi', { tab: 'trasferimenti' })}
      ${(() => { const t = stato.ordini.reduce((a, o) => a + righePendenti(o).reduce((b, r) => b + r.ml, 0), 0); const n = stato.ordini.filter(o => righePendenti(o).length).length; return kpi('teal', fmtMl(t), n ? `in ordine · ${n} ${n === 1 ? 'ordine' : 'ordini'} da ricevere` : 'in ordine dai fornitori', { tab: 'movimenti' }); })()}
    </div>
    ${ssVis.length ? `<details class="card avviso" id="pannello-proposte" ${pannelloAperto ? 'open' : ''}><summary>Da riordinare o spostare: ${ssVis.length} ${ssVis.length === 1 ? 'caso' : 'casi'}${chips.length ? ` <span class="muted piccolo-testo">(con i filtri attivi)</span>` : ''}</summary>
      <p class="piccolo-testo" style="margin:10px 0 12px">${spiegazione} Spunta <b>Riordina</b> o <b>Sposta</b> sulle voci che vuoi trattare, poi apri il <b>Piano</b> per rifinire quantità e confermare.</p>
      <div class="azioni" style="margin:0 0 12px"><button class="piccolo" data-sel="spo">Spunta tutte le proposte di spostamento</button><button class="piccolo" data-sel="rio">Spunta tutte le "da riordinare"</button><button class="piccolo" data-sel="niente" ${nPiano ? '' : 'disabled'}>Togli tutte le spunte</button><button class="piccolo primario" data-vai="piano" ${nPiano ? '' : 'disabled'}>Apri il piano (${nPiano})</button></div>
      <div class="tabella-wrap"><table><thead><tr><th>Codice</th><th>Referenza</th><th>Negozio</th><th class="num">Giacenza</th><th class="num">Min / Obiettivo</th><th class="num">Altro negozio</th><th>Proposta e scelta</th></tr></thead><tbody>
      ${ssVis.map(rigaProposta).join('')}
      </tbody></table></div></details>` : `<div class="card" style="background:var(--ok-bg)"><b>${chips.length ? 'Nessuna referenza sotto scorta con i filtri attivi.' : 'Tutte le referenze sono sopra la scorta minima.'}</b></div>`}
    <div class="card" id="tabella-giacenze">
      <div class="cerca">
        <input type="search" id="cerca" placeholder="Cerca codice, brand o nome…" value="${esc(filtro.testo)}">
        <select id="f-categoria" class="sel"><option value="">Tutte le categorie</option>${CATEGORIE.map(c => `<option ${filtro.categoria === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <select id="f-negozio" class="sel"><option value="">Entrambi i negozi</option>${NEGOZI.map(n => `<option ${filtro.negozio === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <select id="f-stato" class="sel"><option value="">Qualsiasi stato</option>${Object.entries(ETICH_STATO).map(([k, v]) => `<option value="${k}" ${filtro.stato === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </div>
      ${chips.length ? `<div class="chips">Filtri: ${chips.map(([k, v]) => `<button class="chip" data-chip="${k}">${esc(v)} ✕</button>`).join('')}<button class="chip azzera" data-chip="tutti">Azzera</button><span class="muted piccolo-testo">${visibili.length} referenze</span></div>` : ''}
      <p class="muted piccolo-testo" style="margin:0 0 8px">Tocca l'intestazione di una colonna per ordinare. Con <b>Ordina o sposta</b> aggiungi al piano qualsiasi referenza, anche se non è sotto scorta. Sotto ogni giacenza: quanto è <span class="badge ordine">in ordine</span> dal fornitore, <span class="badge arrivo">in arrivo</span> dall'altro negozio, <span class="badge uscita">in uscita</span> perché da spedire${vel.attiva ? `, e la copertura stimata in settimane di vendita` : ` (la copertura in settimane comparirà dopo ${SETTIMANE_MIN} settimane di vendite caricate)`}.</p>
      <div class="tabella-wrap"><table><thead><tr>${th('codice', 'Codice')}${th('nome', 'Referenza')}${th('categoria', 'Categoria')}${NEGOZI.map(n => th(n, n, 'num')).join('')}${th('minima', 'Min / Obiettivo', 'num')}<th></th></tr></thead><tbody>${righe || '<tr><td colspan="7" class="vuoto">Nessuna referenza corrisponde ai filtri.</td></tr>'}</tbody></table></div>
    </div>`;
  $('#cerca').oninput = e => { filtro.testo = e.target.value; renderMagazzinoSoloTabella(); };
  const pannello = $('#pannello-proposte'); if (pannello) pannello.ontoggle = () => { pannelloAperto = pannello.open; };
  $('#f-categoria').onchange = e => { filtro.categoria = e.target.value || null; render(); };
  $('#f-negozio').onchange = e => { filtro.negozio = e.target.value || null; render(); };
  $('#f-stato').onchange = e => { filtro.stato = e.target.value || null; render(); };
  $$('[data-chip]', el).forEach(b => b.onclick = () => { const k = b.dataset.chip; if (k === 'tutti') { filtro.negozio = filtro.stato = filtro.categoria = null; } else filtro[k] = null; render(); });
  $$('[data-piu]', el).forEach(b => b.onclick = () => dialogPiano({ codice: b.dataset.piu }));
  $$('th[data-sort]', el).forEach(h => h.onclick = () => { const k = h.dataset.sort; if (filtro.sort === k) filtro.dir = -filtro.dir; else { filtro.sort = k; filtro.dir = 1; } render(); });
  $$('[data-kpi]', el).forEach(b => b.onclick = () => {
    const d = JSON.parse(b.dataset.kpi);
    if (d.tab) { tab = d.tab; render(); window.scrollTo(0, 0); return; }
    Object.assign(filtro, { negozio: d.negozio, stato: d.stato, sort: d.sort, dir: d.dir }); pannelloAperto = false; render();
    $('#tabella-giacenze').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $$('[data-rio]', el).forEach(c => c.onchange = () => {
    const k = c.dataset.rio; const [codice, negozio] = k.split('|');
    if (c.checked) stato.piano.riordini[k] = { codice, negozio, ml: mlRiordinoDefault(stato.fragranze[codice], negozio, g), fornitore: fornitorePreferito(stato.fragranze[codice]) || '', note: '' };
    else delete stato.piano.riordini[k];
    salvaPiano(); render();
  });
  $$('[data-spo]', el).forEach(c => c.onchange = () => {
    const k = c.dataset.spo; const [codice, negozio] = k.split('|'); const f = stato.fragranze[codice];
    if (c.checked) stato.piano.spostamenti[k] = { codice, da: altro(negozio), a: negozio, ml: mlSpostamentoDefault(f, negozio, g, proposta(f, negozio, g, vel)) };
    else delete stato.piano.spostamenti[k];
    salvaPiano(); render();
  });
  $$('[data-sel]', el).forEach(b => b.onclick = () => {
    const m = b.dataset.sel;
    if (m === 'niente') { stato.piano.riordini = {}; stato.piano.spostamenti = {}; }
    for (const x of ssVis) {
      const p = proposta(x.f, x.negozio, g, vel); const k = chiavePiano(x.f.codice, x.negozio);
      if (m === 'spo' && p.tipo === 'sposta') stato.piano.spostamenti[k] = { codice: x.f.codice, da: p.da, a: p.a, ml: p.ml };
      if (m === 'rio' && p.tipo === 'no' && !(ord[x.f.codice]?.[x.negozio] || 0)) stato.piano.riordini[k] = { codice: x.f.codice, negozio: x.negozio, ml: mlRiordinoDefault(x.f, x.negozio, g), fornitore: fornitorePreferito(x.f) || '', note: '' };
    }
    salvaPiano(); render();
  });
}
function renderMagazzinoSoloTabella() { const pos = $('#cerca').selectionStart; renderMagazzino(); const c = $('#cerca'); c.focus(); c.setSelectionRange(pos, pos); }

/** Finestra per aggiungere o modificare a mano una voce del piano (riordino o spostamento), per qualsiasi referenza. */
function dialogPiano({ codice = '', tipo = 'riordino', negozio = NEGOZI[0], da = null } = {}) {
  const g = giacenze(), vel = velocita();
  const d = $('#dlg');
  const opzioni = fragranzeOrdinate().filter(f => f.attivo !== false || f.codice === codice).map(f => `<option value="${f.codice}" ${f.codice === codice ? 'selected' : ''}>${esc(nomeF(f.codice))}</option>`).join('');
  d.innerHTML = `<h2>Ordina o sposta</h2>
    <form id="form-piano">
      <div class="riga"><label class="campo" style="flex:1 1 100%">Referenza<select name="codice"><option value="">— scegli —</option>${opzioni}</select></label></div>
      <div id="p-info" class="card info" style="margin:12px 0;padding:12px"></div>
      <div class="riga"><label class="campo">Operazione<select name="tipo">
        <option value="riordino" ${tipo === 'riordino' ? 'selected' : ''}>Riordino dal fornitore</option>
        <option value="spostamento" ${tipo === 'spostamento' ? 'selected' : ''}>Spostamento tra negozi</option></select></label>
        <label class="campo" id="p-l-negozio">Negozio<select name="negozio">${NEGOZI.map(n => `<option ${n === negozio ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="campo" id="p-l-da" hidden>Da<select name="da">${NEGOZI.map(n => `<option ${n === (da || altro(negozio)) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="campo">ml<input name="ml" type="number" min="10" step="10" inputmode="numeric" required></label>
        <label class="campo" id="p-l-forn">Fornitore<select name="fornitore"></select></label></div>
      <div class="riga"><label class="campo" style="flex:1 1 100%">Nota<input name="note" placeholder="facoltativa, es. richiesta cliente"></label></div>
      <p id="p-avviso" class="piccolo-testo" style="margin:10px 0 0"></p>
      <div class="azioni"><button type="button" id="p-annulla">Annulla</button><button type="submit" class="primario" id="p-ok">Aggiungi al piano</button></div>
    </form>`;
  const form = $('#form-piano');
  const stato_ = () => {
    const c = form.codice.value, t = form.tipo.value;
    const ricevente = form.negozio.value, mittente = t === 'spostamento' ? form.da.value : null;
    return { c, t, ricevente, mittente, f: c ? stato.fragranze[c] : null };
  };
  const aggiornaInfo = (ricalcolaMl = true) => {
    const { c, t, ricevente, mittente, f } = stato_();
    form.querySelector('#p-l-da').hidden = t !== 'spostamento';
    form.querySelector('#p-l-negozio').firstChild.textContent = t === 'spostamento' ? 'A' : 'Negozio';
    form.querySelector('#p-l-forn').hidden = t !== 'riordino';
    if (f && t === 'riordino') { const pref = fornitorePreferito(f); form.fornitore.innerHTML = `<option value="">—</option>` + fornitoriDi(f).map(sg => `<option value="${esc(sg)}" ${sg === pref ? 'selected' : ''}>${esc(sg)} · ${esc(codiceFornitore(f, sg))}</option>`).join(''); }
    if (!f) { $('#p-info').innerHTML = '<span class="muted">Scegli una referenza per vedere le giacenze.</span>'; $('#p-ok').disabled = true; return; }
    $('#p-ok').disabled = false;
    const cop = n => vel.attiva ? ` <span class="muted">(${fmtCop(copertura(g[c]?.[n] || 0, vel.per[c]?.[n] || 0))})</span>` : '';
    $('#p-info').innerHTML = `<b>${esc(f.categoria)}</b> · scorta minima ${sogliaDi(f)} ml, obiettivo ${obiettivoDi(f)} ml<br>${NEGOZI.map(n => { const io = mlInOrdine(c, n); return `${n}: <b>${fmtMl(g[c]?.[n] || 0)}</b>${io ? ` <span class="badge ordine">+${fmtMl(io)} in ordine</span>` : ''}${cop(n)}`; }).join(' &nbsp;·&nbsp; ')}`;
    if (ricalcolaMl) form.ml.value = t === 'riordino' ? mlRiordinoDefault(f, ricevente, g) : mlSpostamentoDefault(f, ricevente, g, proposta(f, ricevente, g, vel));
    verifica();
  };
  const verifica = () => {
    const { c, t, ricevente, mittente, f } = stato_();
    const ml = Number(form.ml.value) || 0;
    const av = $('#p-avviso');
    av.className = 'piccolo-testo'; av.textContent = '';
    if (!f || !ml) return;
    if (t === 'spostamento') {
      if (mittente === ricevente) { av.className = 'piccolo-testo badge esaurito'; av.textContent = 'I due negozi devono essere diversi.'; return; }
      const gM = g[c]?.[mittente] || 0, gR = g[c]?.[ricevente] || 0;
      if (ml > gM) { av.className = 'piccolo-testo badge esaurito'; av.textContent = `${mittente} ha solo ${fmtMl(gM)}.`; return; }
      const resta = gM - ml;
      av.innerHTML = `Dopo lo spostamento: ${mittente} ${fmtMl(resta)}, ${ricevente} ${fmtMl(gR + ml)}.` + (resta < sogliaDi(f) ? ` <span class="badge sotto">${mittente} scende sotto la minima (${sogliaDi(f)})</span>` : '');
    } else {
      av.innerHTML = `Dopo il carico: ${ricevente} ${fmtMl((g[c]?.[ricevente] || 0) + ml)} (obiettivo ${obiettivoDi(f)} ml).`;
    }
  };
  form.codice.onchange = () => aggiornaInfo();
  form.tipo.onchange = () => aggiornaInfo();
  form.negozio.onchange = () => { if (form.tipo.value === 'spostamento') form.da.value = altro(form.negozio.value); aggiornaInfo(); };
  form.da.onchange = () => { form.negozio.value = altro(form.da.value); aggiornaInfo(); };
  form.ml.oninput = verifica;
  $('#p-annulla').onclick = () => d.close();
  form.onsubmit = e => {
    e.preventDefault();
    const { c, t, ricevente, mittente, f } = stato_();
    const ml = Math.max(10, arr10(Number(form.ml.value) || 0, false));
    if (!f || !ml) { toast('Scegli la referenza e i ml.'); return; }
    const k = chiavePiano(c, ricevente);
    if (t === 'riordino') stato.piano.riordini[k] = { codice: c, negozio: ricevente, ml, fornitore: form.fornitore.value || '', note: form.note.value };
    else {
      if (mittente === ricevente) { toast('I due negozi devono essere diversi.'); return; }
      if (ml > (g[c]?.[mittente] || 0)) { toast(`${mittente} ha solo ${fmtMl(g[c]?.[mittente] || 0)} di ${c}.`); return; }
      stato.piano.spostamenti[k] = { codice: c, da: mittente, a: ricevente, ml, note: form.note.value };
    }
    salvaPiano(); d.close();
    toast(`${t === 'riordino' ? 'Riordino' : 'Spostamento'} aggiunto al piano: ${ml} ml di ${c}.`, { label: 'Apri il piano', fn: () => { tab = 'piano'; render(); window.scrollTo(0, 0); } });
    render();
  };
  aggiornaInfo();
  d.showModal();
}

function renderPiano() {
  const el = $('#tab-piano');
  const g = giacenze(), vel = velocita();
  const rio = Object.entries(stato.piano.riordini).sort((a, b) => a[1].codice.localeCompare(b[1].codice) || a[1].negozio.localeCompare(b[1].negozio));
  const spo = Object.entries(stato.piano.spostamenti).sort((a, b) => a[1].codice.localeCompare(b[1].codice));
  if (!rio.length && !spo.length) {
    el.innerHTML = `<div class="card info"><h2>Piano di riordino e trasferimenti</h2><p>Qui arrivano le voci che spunti nel pannello <b>Da riordinare o spostare</b> della scheda Giacenze o che aggiungi con <b>Ordina o sposta</b>. Per ogni voce rifinisci quantità e fornitore, poi generi l'ordine (Excel o PDF) per ciascun fornitore e negozio di consegna, e crei i trasferimenti tra i negozi in un colpo solo.</p><div class="azioni"><button class="primario" data-vai="magazzino">Vai alle giacenze</button><button id="piano-nuovo">Aggiungi una voce a mano</button></div>${stato.ordini.length ? `<p class="muted piccolo-testo" style="margin-top:12px">Gli ordini già generati sono in <b>Storico e backup</b>.</p>` : ''}</div>`;
    const bn = $('#piano-nuovo'); if (bn) bn.onclick = () => dialogPiano({});
    return;
  }
  const cop = (codice, n) => vel.attiva ? `<div class="cop">${fmtCop(copertura(g[codice]?.[n] || 0, vel.per[codice]?.[n] || 0))}</div>` : '';
  const euro = v => v.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
  const oggi = new Date().toLocaleDateString('it-IT');
  // ---- riordini raggruppati per fornitore + negozio ----
  const gruppi = new Map();
  for (const [k, r] of rio) { const gk = `${r.fornitore || ''}|${r.negozio}`; if (!gruppi.has(gk)) gruppi.set(gk, { fornitore: r.fornitore || '', negozio: r.negozio, voci: [] }); gruppi.get(gk).voci.push([k, r]); }
  const ordineGruppi = [...gruppi.values()].sort((a, b) => (a.fornitore ? 0 : 1) - (b.fornitore ? 0 : 1) || a.fornitore.localeCompare(b.fornitore) || a.negozio.localeCompare(b.negozio));
  const rigaRio = ([k, r]) => {
    const f = stato.fragranze[r.codice]; const giac = g[r.codice]?.[r.negozio] || 0; const alt = g[r.codice]?.[altro(r.negozio)] || 0;
    const stima = f.costo !== '' && f.costo != null && !isNaN(Number(f.costo)) ? r.ml / 100 * Number(f.costo) : null;
    const forn = fornitoriDi(f);
    const sel = `<select class="mini-sel" data-rio-forn="${k}"><option value="">—</option>${forn.map(s => `<option value="${esc(s)}" ${r.fornitore === s ? 'selected' : ''}>${esc(s)} · ${esc(codiceFornitore(f, s))}</option>`).join('')}</select>${forn.length ? '' : '<div class="cop"><span class="badge sotto">nessun codice fornitore</span></div>'}`;
    return `<tr><td class="cod">${r.codice}</td><td>${esc(nomeF(r.codice)).replace(/^\d{3} /, '')}<div class="cop">${esc(f.categoria)}</div></td><td class="num"><span class="badge ${statoScorta(giac, sogliaDi(f))}">${fmtMl(giac)}</span>${cop(r.codice, r.negozio)}</td><td class="num muted">${sogliaDi(f)} / ${obiettivoDi(f)}</td><td class="num">${altro(r.negozio)}: ${fmtMl(alt)}${cop(r.codice, altro(r.negozio))}</td><td>${sel}</td><td class="num"><input class="mini" type="number" min="10" step="10" inputmode="numeric" value="${r.ml}" data-rio-ml="${k}"></td><td class="num">${stima != null ? euro(stima) : '<span class="muted">–</span>'}</td><td><input class="nota" value="${esc(r.note || '')}" placeholder="nota" data-rio-note="${k}"></td><td><button class="piccolo" data-rio-del="${k}" title="Togli dalla lista">✕</button></td></tr>`;
  };
  const cardGruppo = gr => {
    const totMl = gr.voci.reduce((a, [, r]) => a + r.ml, 0);
    const senzaCodice = gr.fornitore ? gr.voci.filter(([, r]) => !codiceFornitore(stato.fragranze[r.codice], gr.fornitore)).length : 0;
    const gk = `${gr.fornitore}|${gr.negozio}`;
    const titolo = gr.fornitore ? `Ordine <b>${esc(nomeFornitore(gr.fornitore))}</b>${gr.fornitore !== nomeFornitore(gr.fornitore) ? ` <span class="muted">(${esc(gr.fornitore)})</span>` : ''} · consegna <b>${esc(gr.negozio)}</b>` : `<span class="badge sotto">Senza fornitore</span> · ${esc(gr.negozio)}`;
    return `<div class="card gruppo-ordine"><div class="cerca"><h3 style="margin:0;flex:1 1 auto;font-weight:400;font-size:1.2rem">${titolo} <span class="muted piccolo-testo">· ${gr.voci.length} ${gr.voci.length === 1 ? 'voce' : 'voci'} · ${fmtMl(totMl)}</span></h3>
        ${gr.fornitore ? `<div class="azioni no-print" style="margin:0"><button class="piccolo" data-ord="copia" data-gk="${esc(gk)}">Copia testo</button><button class="piccolo" data-ord="excel" data-gk="${esc(gk)}">Excel</button><button class="piccolo" data-ord="stampa" data-gk="${esc(gk)}">Stampa / PDF</button><button class="piccolo primario" data-ord="conferma" data-gk="${esc(gk)}">Conferma ordine</button></div>` : `<span class="piccolo-testo muted">Scegli il fornitore su ogni riga per poter generare l'ordine.</span>`}</div>
      ${senzaCodice ? `<p class="piccolo-testo" style="margin:0 0 8px"><span class="badge sotto">${senzaCodice} ${senzaCodice === 1 ? 'voce senza codice' : 'voci senza codice'} ${esc(gr.fornitore)}</span> Aggiungi il codice in Referenze o scegli un altro fornitore.</p>` : ''}
      <div class="tabella-wrap"><table><thead><tr><th>Codice</th><th>Referenza</th><th class="num">Giacenza</th><th class="num">Min / Obiettivo</th><th class="num">Altro negozio</th><th>Fornitore · codice</th><th class="num">Da ordinare</th><th class="num">Stima €</th><th>Nota</th><th class="no-print"></th></tr></thead><tbody>${gr.voci.map(rigaRio).join('')}</tbody></table></div></div>`;
  };
  // ---- spostamenti ----
  const righeSpo = spo.map(([k, t]) => {
    const f = stato.fragranze[t.codice]; const gM = g[t.codice]?.[t.da] || 0, gR = g[t.codice]?.[t.a] || 0;
    const resta = gM - t.ml; const min = sogliaDi(f);
    const avviso = t.ml > gM ? `<span class="badge esaurito">supera la giacenza di ${t.da}</span>` : resta < min ? `<span class="badge sotto">${t.da} scende sotto la minima (${min})</span>` : '';
    return `<tr><td class="cod">${t.codice}</td><td>${esc(nomeF(t.codice)).replace(/^\d{3} /, '')}<div class="cop">${esc(f.categoria)}</div></td><td class="nowrap">${t.da} → ${t.a}</td><td class="num">${fmtMl(gM)}${cop(t.codice, t.da)}</td><td class="num"><span class="badge ${statoScorta(gR, min)}">${fmtMl(gR)}</span>${cop(t.codice, t.a)}</td><td class="num muted">${min} / ${obiettivoDi(f)}</td><td class="num"><input class="mini" type="number" min="10" step="10" inputmode="numeric" value="${t.ml}" data-spo-ml="${k}"></td><td class="num" data-resta="${k}">${fmtMl(resta)} <span class="muted">/ ${fmtMl(gR + t.ml)}</span></td><td><input class="nota" value="${esc(t.note || '')}" placeholder="nota" data-spo-note="${k}"></td><td data-avviso="${k}">${avviso}</td><td><button class="piccolo" data-spo-del="${k}" title="Togli dalla lista">✕</button></td></tr>`;
  }).join('');
  el.innerHTML = `
    <div class="card no-print"><h2>Piano</h2><p class="muted">Rifinisci quantità e fornitore, poi genera gli ordini. Ogni ordine è per un fornitore e un negozio di consegna. Le voci restano qui finché non confermi o le togli.</p></div>
    ${rio.length ? `<div class="card no-print" style="padding:12px 20px"><div class="cerca"><h2 style="margin:0;flex:1 1 auto">Lista riordino <span class="muted piccolo-testo">${oggi} · ${rio.length} voci</span></h2><div class="azioni" style="margin:0"><button class="piccolo primario" data-piano="nuovo-rio">+ Aggiungi voce</button><button class="pericolo piccolo" data-piano="svuota-rio">Svuota lista</button></div></div></div>${ordineGruppi.map(cardGruppo).join('')}` : ''}
    ${spo.length ? `<div class="card stampa-spo"><div class="cerca"><h2 style="margin:0;flex:1 1 auto">Trasferimenti tra negozi <span class="muted piccolo-testo">${oggi}</span></h2><div class="azioni no-print" style="margin:0"><button class="piccolo primario" data-piano="nuovo-spo">+ Aggiungi voce</button><button class="piccolo" data-piano="copia-spo">Copia testo</button><button class="piccolo" data-piano="stampa">Stampa</button></div></div>
      <div class="tabella-wrap"><table><thead><tr><th>Codice</th><th>Referenza</th><th>Tratta</th><th class="num">Giacenza chi cede</th><th class="num">Giacenza chi riceve</th><th class="num">Min / Obiettivo</th><th class="num">ml da spostare</th><th class="num">Dopo: cede / riceve</th><th>Nota</th><th></th><th class="no-print"></th></tr></thead><tbody>${righeSpo}</tbody></table></div>
      <div class="azioni no-print"><button class="pericolo piccolo" data-piano="svuota-spo">Svuota lista</button><button class="primario" data-piano="crea-spo">Crea ${spo.length} ${spo.length === 1 ? 'trasferimento' : 'trasferimenti'}</button></div></div>` : ''}`;
  // modifiche quantità, fornitore e note
  $$('[data-rio-ml]', el).forEach(i => i.onchange = () => { const v = Math.max(10, arr10(Number(i.value) || 0, true)); stato.piano.riordini[i.dataset.rioMl].ml = v; salvaPiano(); render(); });
  $$('[data-rio-forn]', el).forEach(i => i.onchange = () => { stato.piano.riordini[i.dataset.rioForn].fornitore = i.value; salvaPiano(); render(); });
  $$('[data-rio-note]', el).forEach(i => i.onchange = () => { stato.piano.riordini[i.dataset.rioNote].note = i.value; salvaPiano(); });
  $$('[data-rio-del]', el).forEach(b => b.onclick = () => { delete stato.piano.riordini[b.dataset.rioDel]; salvaPiano(); render(); });
  $$('[data-spo-ml]', el).forEach(i => {
    i.oninput = () => { const t = stato.piano.spostamenti[i.dataset.spoMl]; const ml = Number(i.value) || 0; const gM = g[t.codice]?.[t.da] || 0, gR = g[t.codice]?.[t.a] || 0; $(`[data-resta="${i.dataset.spoMl}"]`).innerHTML = `${fmtMl(gM - ml)} <span class="muted">/ ${fmtMl(gR + ml)}</span>`; };
    i.onchange = () => { stato.piano.spostamenti[i.dataset.spoMl].ml = Math.max(10, arr10(Number(i.value) || 0, false)); salvaPiano(); render(); };
  });
  $$('[data-spo-note]', el).forEach(i => i.onchange = () => { stato.piano.spostamenti[i.dataset.spoNote].note = i.value; salvaPiano(); });
  $$('[data-spo-del]', el).forEach(b => b.onclick = () => { delete stato.piano.spostamenti[b.dataset.spoDel]; salvaPiano(); render(); });
  // ordini per gruppo
  $$('[data-ord]', el).forEach(b => b.onclick = async () => {
    const gr = gruppi.get(b.dataset.gk); if (!gr) return;
    const o = { id: nId(), ts: adesso(), fornitore: gr.fornitore, negozio: gr.negozio, righe: righeOrdine(gr.fornitore, gr.negozio, gr.voci.map(([, r]) => r), g) };
    const a = b.dataset.ord;
    if (a === 'copia') return copiaTesto(testoOrdine(o));
    if (a === 'excel') return excelOrdine(o);
    if (a === 'stampa') return stampaOrdine(o);
    if (a === 'conferma') {
      const manca = o.righe.filter(r => !r.codiceFornitore).length;
      if (!await conferma('Confermare l\'ordine?', `<b>${esc(nomeFornitore(o.fornitore))}</b>, consegna a <b>${esc(o.negozio)}</b>: ${o.righe.length} voci per ${fmtMl(o.righe.reduce((s, r) => s + r.ml, 0))}.${manca ? `<br><span class="badge sotto">${manca} ${manca === 1 ? 'voce senza codice' : 'voci senza codice'} ${esc(o.fornitore)}</span>` : ''}<br>L'ordine viene salvato e le voci tolte dal piano. Lo ritrovi in <b>Carichi</b> → "Ordini in attesa di consegna": all'arrivo della merce lo spunti voce per voce e le quantità entrano in giacenza.`, 'Conferma')) return;
      o.totMl = o.righe.reduce((s, r) => s + r.ml, 0);
      stato.ordini.push(o);
      for (const [k] of gr.voci) delete stato.piano.riordini[k];
      salva(`ordine ${o.fornitore} ${o.negozio}`); render();
      toast(`Ordine ${nomeFornitore(o.fornitore)} · ${o.negozio} salvato in Storico.`, { label: 'Excel', fn: () => excelOrdine(o) });
    }
  });
  // azioni generali
  const testoSpo = () => [`TRASFERIMENTI ${oggi}`, ...spo.map(([, t]) => { const f = stato.fragranze[t.codice]; return `${t.codice}  ${f.brand ? f.brand + ' - ' : ''}${f.nome}  |  ${t.ml} ml da ${t.da} a ${t.a}  |  ${t.da} resta con ${(g[t.codice]?.[t.da] || 0) - t.ml} ml${t.note ? '  |  ' + t.note : ''}`; })].join('\n');
  $$('[data-piano]', el).forEach(b => b.onclick = async () => {
    const a = b.dataset.piano;
    if (a === 'nuovo-rio') return dialogPiano({ tipo: 'riordino' });
    if (a === 'nuovo-spo') return dialogPiano({ tipo: 'spostamento' });
    if (a === 'copia-spo') return copiaTesto(testoSpo());
    if (a === 'stampa') return window.print();
    if (a === 'svuota-rio' && await conferma('Svuotare la lista riordino?', 'Le spunte "Riordina" verranno tolte.', 'Svuota', true)) { stato.piano.riordini = {}; salvaPiano(); render(); }
    if (a === 'svuota-spo' && await conferma('Svuotare la lista trasferimenti?', 'Le spunte "Sposta" verranno tolte.', 'Svuota', true)) { stato.piano.spostamenti = {}; salvaPiano(); render(); }
    if (a === 'crea-spo') {
      const errati = spo.filter(([, t]) => t.ml > (g[t.codice]?.[t.da] || 0));
      if (errati.length) { toast(`${errati.length} ${errati.length === 1 ? 'voce supera' : 'voci superano'} la giacenza di chi cede: correggi i ml.`); return; }
      if (!await conferma('Creare i trasferimenti?', `${spo.length} trasferimenti in stato "proposto". Chi spedisce e chi riceve li confermeranno nella scheda Trasferimenti.`, 'Crea')) return;
      for (const [, t] of spo) stato.trasferimenti.push({ id: nId(), ts: adesso(), da: t.da, a: t.a, codice: t.codice, ml: t.ml, note: t.note || 'dal piano', stato: 'proposto', storia: [{ stato: 'proposto', ts: adesso() }] });
      stato.piano.spostamenti = {}; salva('trasferimenti dal piano'); toast(`${spo.length} trasferimenti proposti.`); tab = 'trasferimenti'; render();
    }
  });
}

function renderVendite() {
  const el = $('#tab-vendite');
  let ant = '';
  if (anteprimaVendite) {
    const a = anteprimaVendite;
    const nuove = a.riconosciute.filter(r => !r.duplicata);
    const perNeg = {}; for (const r of nuove) perNeg[r.negozio] = (perNeg[r.negozio] || 0) + r.ml;
    const mancanti = [...new Set(nuove.filter(r => !stato.fragranze[r.codice]).map(r => r.codice))];
    ant = `<div class="card info"><h2>Anteprima: ${esc(a.file)}</h2>
      <p><b>${nuove.length}</b> righe di vendita da caricare (${NEGOZI.map(n => `${n}: ${fmtMl(perNeg[n] || 0)}`).join(' · ')})${a.riconosciute.length - nuove.length ? `, <b>${a.riconosciute.length - nuove.length}</b> già caricate in precedenza (ignorate)` : ''}, <b>${a.scartate.length}</b> righe non profumo o non riconosciute.</p>
      ${a.riconosciute.length ? `<p>Periodo vendite: dal ${fmtData(a.riconosciute.map(r => r.dataISO).sort()[0])} al ${fmtData(a.riconosciute.map(r => r.dataISO).sort().at(-1))}</p>` : ''}
      ${mancanti.length ? `<p class="card avviso" style="margin:8px 0">Codici venduti ma non presenti in anagrafica: <b>${mancanti.join(', ')}</b>. Verranno creati con nome "(da completare)": potrai sistemarli in <b>Referenze e soglie</b>.</p>` : ''}
      ${a.scartate.length ? `<details><summary>Righe non conteggiate (${a.scartate.length})</summary><ul class="pulita piccolo-testo">${a.scartate.map(s => `<li><b>${esc(s.descrizione)}</b> · ${esc(s.negozio)} · ${esc(s.data)} → <i>${esc(s.motivo)}</i></li>`).join('')}</ul></details>` : ''}
      <details><summary>Dettaglio righe da caricare (${nuove.length})</summary><div class="tabella-wrap"><table><thead><tr><th>Data</th><th>Negozio</th><th>Descrizione</th><th>Referenza</th><th class="num">ml</th></tr></thead><tbody>${nuove.map(r => `<tr><td>${fmtData(r.dataISO)}</td><td>${r.negozio}</td><td>${esc(r.descrizione)}</td><td>${esc(nomeF(r.codice))}</td><td class="num">${r.ml}</td></tr>`).join('')}</tbody></table></div></details>
      <div class="azioni"><button id="v-annulla">Annulla</button><button id="v-conferma" class="primario" ${nuove.length ? '' : 'disabled'}>Scarica dal magazzino ${nuove.length} vendite</button></div></div>`;
  }
  const lotti = stato.lotti.filter(l => l.tipo === 'vendite').slice().reverse().slice(0, 10);
  el.innerHTML = `
    <div class="card"><h2>Carica le vendite dal gestionale</h2>
      <p class="muted">Esporta il "resoconto vendite" in CSV dal gestionale di cassa (entrambi i negozi insieme vanno bene) e selezionalo qui. Le righe già caricate vengono riconosciute e non scalate due volte: puoi caricare anche periodi sovrapposti senza problemi.</p>
      <div class="riga"><label class="campo">File CSV vendite<input type="file" id="file-vendite" accept=".csv,text/csv"></label></div></div>
    ${ant}
    <div class="card"><h3>Ultimi caricamenti</h3>${lotti.length ? `<div class="tabella-wrap"><table><thead><tr><th>Quando</th><th>File</th><th class="num">Righe</th><th class="num">Ignorate</th><th></th></tr></thead><tbody>${lotti.map(l => `<tr><td>${fmtData(l.ts)}</td><td>${esc(l.file)}</td><td class="num">${l.righe}</td><td class="num">${l.scartate?.length || 0}</td><td>${l.annullato ? '<span class="badge grigio">annullato</span>' : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nessun caricamento ancora.</p>'}</div>`;
  $('#file-vendite').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const testo = await f.text();
    const righe = parseCSV(testo);
    if (!righe.length || !('Descrizione' in righe[0])) { toast('Il file non sembra un resoconto vendite (manca la colonna Descrizione).'); return; }
    const a = analizzaVendite(righe);
    for (const r of a.riconosciute) r.duplicata = !!stato.chiaviVendite[r.chiave];
    anteprimaVendite = { ...a, file: f.name };
    render();
  };
  if (anteprimaVendite) {
    $('#v-annulla').onclick = () => { anteprimaVendite = null; render(); };
    $('#v-conferma').onclick = () => {
      const n = importaVendite(anteprimaVendite, anteprimaVendite.file);
      anteprimaVendite = null; toast(`Caricate ${n} vendite.`); tab = 'magazzino'; render();
    };
  }
}

/** Applica un'analisi vendite (già marcata con `duplicata`) creando lotto e movimenti. Ritorna le righe caricate. */
function importaVendite(a, file) {
  const nuove = a.riconosciute.filter(r => !r.duplicata);
  const lotto = { id: nId(), ts: adesso(), tipo: 'vendite', file, righe: nuove.length, scartate: a.scartate.map(s => ({ descrizione: s.descrizione, negozio: s.negozio, motivo: s.motivo })), annullato: false };
  stato.lotti.push(lotto);
  for (const r of nuove) {
    assicuraFragranza(r.codice);
    aggiungiMovimento({ dataEvento: r.dataISO, negozio: r.negozio, codice: r.codice, tipo: 'vendita', ml: -r.ml, rif: r.id, lotto: lotto.id, note: r.descrizione });
    stato.chiaviVendite[r.chiave] = lotto.id;
  }
  salva(`import vendite ${file}`);
  return nuove.length;
}
/** Carica i dati dimostrativi (inventario Latina reale, Aprilia e vendite simulate). */
function caricaDemo() {
  const D = window.DATI_DEMO;
  if (!D) { toast('Dati dimostrativi non disponibili.'); return; }
  const g = giacenze();
  for (const [negozio, righe] of [['Latina', D.latina], ['Aprilia', D.aprilia]]) {
    const a = normalizzaMagazzino(righe);
    const lotto = { id: nId(), ts: adesso(), tipo: 'giacenze', file: `Inventario ${negozio} (demo)`, negozio, righe: a.fragranze.length, scartate: a.ignorate.map(r => ({ descrizione: r.nome, motivo: 'non profumo' })), annullato: false };
    stato.lotti.push(lotto);
    for (const f of a.fragranze) {
      aggiornaAnagraficaDaInventario(f);
      const delta = f.ml - (g[f.codice]?.[negozio] || 0);
      if (delta) aggiungiMovimento({ dataEvento: '2026-08-01T08:00', negozio, codice: f.codice, tipo: 'inventario', ml: delta, rif: '', lotto: lotto.id, note: lotto.file });
    }
  }
  const a = analizzaVendite(parseCSV(D.vendite));
  for (const r of a.riconosciute) r.duplicata = !!stato.chiaviVendite[r.chiave];
  const n = importaVendite(a, 'vendite-demo-6-settimane.csv');
  toast(`Dati dimostrativi caricati: ${n} vendite su 6 settimane.`); tab = 'magazzino'; render();
}

function renderTrasferimenti() {
  const el = $('#tab-trasferimenti');
  const g = giacenze();
  const aperti = stato.trasferimenti.filter(t => t.stato === 'proposto' || t.stato === 'spedito').slice().reverse();
  const chiusi = stato.trasferimenti.filter(t => t.stato === 'ricevuto' || t.stato === 'annullato').slice().reverse().slice(0, 15);
  const opzioni = fragranzeOrdinate().filter(f => f.attivo !== false).map(f => `<option value="${f.codice}">${esc(nomeF(f.codice))}</option>`).join('');
  const rigaT = t => `<tr><td>${fmtData(t.ts)}</td><td class="cod">${t.codice}</td><td>${esc(nomeF(t.codice))}</td><td>${t.da} → ${t.a}</td><td class="num">${fmtMl(t.ml)}</td><td><span class="badge ${t.stato === 'ricevuto' ? 'ok' : t.stato === 'annullato' ? 'grigio' : 'neutro'}">${t.stato}</span></td>
    <td class="azioni" style="margin:0">${t.stato === 'proposto' ? `<button class="piccolo primario" data-tr="spedito" data-id="${t.id}">Spedito da ${t.da}</button>` : ''}${t.stato === 'spedito' ? `<button class="piccolo ok" data-tr="ricevuto" data-id="${t.id}">Ricevuto a ${t.a}</button>` : ''}${t.stato === 'proposto' || t.stato === 'spedito' ? `<button class="piccolo pericolo" data-tr="annullato" data-id="${t.id}">Annulla</button>` : ''}</td></tr>`;
  el.innerHTML = `
    <div class="card"><h2>Nuovo trasferimento</h2>
      <p class="muted">Le proposte automatiche si creano dalla scheda Giacenze. Qui puoi crearne una a mano con la quantità che vuoi.</p>
      <form id="form-tr" class="riga">
        <label class="campo">Da<select name="da">${NEGOZI.map(n => `<option>${n}</option>`).join('')}</select></label>
        <label class="campo">A<select name="a">${NEGOZI.map((n, i) => `<option ${i === 1 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="campo" style="flex:2 1 260px">Referenza<select name="codice"><option value="">— scegli —</option>${opzioni}</select></label>
        <label class="campo">ml<input name="ml" type="number" min="10" step="10" inputmode="numeric" placeholder="es. 200"></label>
        <label class="campo" style="flex:2 1 200px">Nota<input name="note" placeholder="facoltativa"></label>
        <button class="primario stretto" type="submit">Proponi</button>
      </form>
      <p id="tr-disp" class="muted piccolo-testo"></p></div>
    <div class="card"><h3>In corso (${aperti.length})</h3><p class="muted piccolo-testo">Tre passi: <b>proposto</b> → <b>spedito</b> (i ml escono da chi cede e restano in transito) → <b>ricevuto</b> (entrano in giacenza a chi riceve).</p>${aperti.length ? `<div class="tabella-wrap"><table><thead><tr><th>Creato</th><th>Codice</th><th>Referenza</th><th>Tratta</th><th class="num">ml</th><th>Stato</th><th>Azioni</th></tr></thead><tbody>${aperti.map(rigaT).join('')}</tbody></table></div>` : '<p class="muted">Nessun trasferimento in corso.</p>'}</div>
    <div class="card"><h3>Conclusi (ultimi ${chiusi.length})</h3>${chiusi.length ? `<div class="tabella-wrap"><table><thead><tr><th>Creato</th><th>Codice</th><th>Referenza</th><th>Tratta</th><th class="num">ml</th><th>Stato</th><th></th></tr></thead><tbody>${chiusi.map(rigaT).join('')}</tbody></table></div>` : '<p class="muted">Nessuno.</p>'}</div>`;
  const form = $('#form-tr');
  const aggDisp = () => { const c = form.codice.value; const da = form.da.value; $('#tr-disp').textContent = c ? `Disponibile a ${da}: ${fmtMl(g[c]?.[da] || 0)} · a ${altro(da)}: ${fmtMl(g[c]?.[altro(da)] || 0)}` : ''; };
  form.codice.onchange = aggDisp; form.da.onchange = () => { form.a.value = altro(form.da.value); aggDisp(); }; form.a.onchange = () => { form.da.value = altro(form.a.value); aggDisp(); };
  form.onsubmit = e => {
    e.preventDefault();
    const codice = form.codice.value, ml = Number(form.ml.value), da = form.da.value, a = form.a.value;
    if (!codice || !ml || ml <= 0) { toast('Scegli la referenza e i ml.'); return; }
    if (da === a) { toast('I due negozi devono essere diversi.'); return; }
    if ((g[codice]?.[da] || 0) < ml) { toast(`A ${da} ci sono solo ${fmtMl(g[codice]?.[da] || 0)} di ${codice}.`); return; }
    stato.trasferimenti.push({ id: nId(), ts: adesso(), da, a, codice, ml, note: form.note.value, stato: 'proposto', storia: [{ stato: 'proposto', ts: adesso() }] });
    salva('nuovo trasferimento'); toast('Trasferimento proposto.'); render();
  };
  $$('[data-tr]', el).forEach(b => b.onclick = async () => {
    const t = stato.trasferimenti.find(x => x.id === b.dataset.id); const nuovo = b.dataset.tr;
    if (nuovo === 'annullato' && !await conferma('Annullare il trasferimento?', `${esc(nomeF(t.codice))}, ${fmtMl(t.ml)} da ${t.da} a ${t.a}.${t.stato === 'spedito' ? ' I ml torneranno in giacenza a ' + t.da + '.' : ''}`, 'Annulla trasferimento', true)) return;
    if (nuovo === 'spedito') aggiungiMovimento({ dataEvento: adesso(), negozio: t.da, codice: t.codice, tipo: 'trasf_out', ml: -t.ml, rif: t.id, note: `verso ${t.a}` });
    if (nuovo === 'ricevuto') aggiungiMovimento({ dataEvento: adesso(), negozio: t.a, codice: t.codice, tipo: 'trasf_in', ml: t.ml, rif: t.id, note: `da ${t.da}` });
    if (nuovo === 'annullato' && t.stato === 'spedito') aggiungiMovimento({ dataEvento: adesso(), negozio: t.da, codice: t.codice, tipo: 'trasf_in', ml: t.ml, rif: t.id, note: `rientro per annullamento` });
    t.stato = nuovo; t.storia.push({ stato: nuovo, ts: adesso() });
    salva(`trasferimento ${nuovo}`); toast(`Trasferimento: ${nuovo}.`); render();
  });
}

function renderMovimenti() {
  const el = $('#tab-movimenti');
  const g = giacenze();
  const opzioni = fragranzeOrdinate().map(f => `<option value="${f.codice}">${esc(nomeF(f.codice))}</option>`).join('');
  const recenti = movimentiValidi().filter(m => ['carico', 'rettifica', 'inventario'].includes(m.tipo)).slice().reverse().slice(0, 20);
  const aperti = stato.ordini.filter(o => righePendenti(o).length).slice().reverse();
  const inRicezione = ricezione ? stato.ordini.find(o => o.id === ricezione) : null;
  const ordiniHtml = inRicezione ? cardRicezione(inRicezione, g) : `<div class="card"><h2>Ordini in attesa di consegna${aperti.length ? ` (${aperti.length})` : ''}</h2>
      ${aperti.length ? `<p class="muted">Quando arriva la merce, registra la consegna: le quantità ricevute entrano in giacenza nel negozio di consegna senza doverle ricaricare a mano.</p><div class="tabella-wrap"><table><thead><tr><th>Ordine</th><th>Fornitore</th><th>Consegna</th><th class="num">Voci in attesa</th><th class="num">ml in attesa</th><th>Stato</th><th></th></tr></thead><tbody>${aperti.map(o => { const p = righePendenti(o); return `<tr><td>${fmtData(o.ts)}</td><td>${esc(nomeFornitore(o.fornitore))}</td><td>${esc(o.negozio)}</td><td class="num">${p.length} / ${o.righe.length}</td><td class="num">${fmtMl(p.reduce((a, r) => a + r.ml, 0))}</td><td>${badgeOrdine(o)}</td><td class="azioni" style="margin:0"><button class="piccolo primario" data-ricevi="${o.id}">Registra consegna</button><button class="piccolo" data-ordine="${o.id}">Vedi</button></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">Nessun ordine in attesa. Gli ordini si creano dal Piano; una volta confermati compaiono qui finché la merce non è arrivata.</p>'}</div>`;
  let ant = '';
  if (anteprimaGiacenze) {
    const a = anteprimaGiacenze;
    const nuove = a.fragranze.filter(f => !stato.fragranze[f.codice]);
    const conDelta = a.fragranze.map(f => ({ ...f, attuale: g[f.codice]?.[a.negozio] || 0 })).filter(f => f.attuale !== f.ml);
    ant = `<div class="card info"><h2>Anteprima inventario ${esc(a.negozio)}: ${esc(a.file)}</h2>
      <p><b>${a.fragranze.length}</b> referenze riconosciute per <b>${fmtMl(a.fragranze.reduce((s, f) => s + f.ml, 0))}</b> complessivi. Nuove in anagrafica: <b>${nuove.length}</b>. Righe ignorate (flaconi, tappi, etichette, accessori…): <b>${a.ignorate.length}</b>.${(() => { const sig = [...new Set(a.fragranze.flatMap(f => Object.keys(f.fornitori || {})))]; return sig.length ? ` Codici fornitore letti: <b>${sig.map(esc).join(', ')}</b> (${a.fragranze.filter(f => Object.keys(f.fornitori || {}).length).length} referenze).` : ''; })()}</p>
      <p class="muted piccolo-testo">Le righe con lo stesso codice a 3 cifre (es. varianti Atlantis / PF / Parf. Lab) vengono sommate in un'unica giacenza; le diciture restano come nota della referenza.</p>
      ${a.fragranze.some(f => f.righe.length > 1) ? `<details><summary>Righe accorpate (${a.fragranze.filter(f => f.righe.length > 1).length})</summary><ul class="pulita piccolo-testo">${a.fragranze.filter(f => f.righe.length > 1).map(f => `<li><b>${f.codice} ${esc(f.brand ? f.brand + ' - ' : '')}${esc(f.nome)}</b> = ${fmtMl(f.ml)}<br>${f.righe.map(r => `&nbsp;&nbsp;"${esc(r.nome)}" ${r.quantita}`).join('<br>')}</li>`).join('')}</ul></details>` : ''}
      ${a.ignorate.length ? `<details><summary>Righe ignorate (${a.ignorate.length})</summary><ul class="pulita piccolo-testo">${a.ignorate.map(r => `<li>"${esc(r.nome)}" ${r.quantita}</li>`).join('')}</ul></details>` : ''}
      <details open><summary>Giacenze che cambiano a ${esc(a.negozio)} (${conDelta.length})</summary><div class="tabella-wrap"><table><thead><tr><th>Codice</th><th>Referenza</th><th class="num">Attuale</th><th class="num">Inventario</th><th class="num">Differenza</th></tr></thead><tbody>${conDelta.slice(0, 400).map(f => `<tr><td class="cod">${f.codice}</td><td>${esc(f.brand ? f.brand + ' - ' : '')}${esc(f.nome)}</td><td class="num">${f.attuale}</td><td class="num">${f.ml}</td><td class="num">${f.ml - f.attuale > 0 ? '+' : ''}${f.ml - f.attuale}</td></tr>`).join('')}</tbody></table></div></details>
      <div class="azioni"><button id="g-annulla">Annulla</button><button id="g-conferma" class="primario">Applica inventario a ${esc(a.negozio)}</button></div></div>`;
  }
  el.innerHTML = `
    ${ant}
    ${ordiniHtml}
    <div class="card"><h2>Carico o rettifica manuale</h2>
      <p class="muted">Usa <b>Carico</b> quando arriva merce dal fornitore (ml aggiunti). Usa <b>Rettifica</b> dopo un conteggio: inserisci i ml effettivamente presenti e la differenza viene registrata.</p>
      <form id="form-mov" class="riga">
        <label class="campo">Negozio<select name="negozio">${NEGOZI.map(n => `<option>${n}</option>`).join('')}</select></label>
        <label class="campo">Tipo<select name="tipo"><option value="carico">Carico (aggiungi ml)</option><option value="rettifica">Rettifica (ml contati)</option></select></label>
        <label class="campo" style="flex:2 1 260px">Referenza<select name="codice"><option value="">— scegli —</option>${opzioni}</select></label>
        <label class="campo">ml<input name="ml" type="number" min="0" step="10" inputmode="numeric"></label>
        <label class="campo" style="flex:2 1 200px">Nota<input name="note" placeholder="es. fornitore, DDT…"></label>
        <button class="primario stretto" type="submit">Registra</button>
      </form><p id="mov-disp" class="muted piccolo-testo"></p></div>
    <div class="card"><h2>Importa inventario da Excel</h2>
      <p class="muted">Per il caricamento iniziale (o per un inventario completo): esporta l'elenco dal vecchio programma di magazzino (colonne <i>Nome</i> e <i>Quantità</i>) in .xlsx o .csv e scegli il negozio a cui si riferisce. Le quantità sono in ml. Se il negozio ha già giacenze, ogni referenza viene portata al valore dell'inventario con una rettifica.</p>
      <div class="riga"><label class="campo">Negozio<select id="g-negozio">${NEGOZI.map(n => `<option>${n}</option>`).join('')}</select></label><label class="campo" style="flex:2 1 260px">File inventario<input type="file" id="file-giacenze" accept=".xlsx,.xls,.csv"></label></div></div>
    <div class="card"><h3>Ultimi carichi e rettifiche</h3>${recenti.length ? `<div class="tabella-wrap"><table><thead><tr><th>Quando</th><th>Negozio</th><th>Referenza</th><th>Tipo</th><th class="num">ml</th><th>Nota</th></tr></thead><tbody>${recenti.map(m => `<tr><td>${fmtData(m.ts)}</td><td>${m.negozio}</td><td>${esc(nomeF(m.codice))}</td><td>${m.tipo}</td><td class="num">${m.ml > 0 ? '+' : ''}${m.ml}</td><td class="muted">${esc(m.note || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nessuno.</p>'}</div>`;
  $$('[data-ricevi]', el).forEach(b => b.onclick = () => { ricezione = b.dataset.ricevi; render(); $('#ricezione')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $$('[data-ordine]', el).forEach(b => b.onclick = () => dialogOrdine(stato.ordini.find(x => x.id === b.dataset.ordine)));
  if (inRicezione) collegaRicezione(inRicezione, el);
  const form = $('#form-mov');
  const aggDisp = () => { const c = form.codice.value; $('#mov-disp').textContent = c ? `Giacenza attuale di ${c} a ${form.negozio.value}: ${fmtMl(g[c]?.[form.negozio.value] || 0)}` : ''; };
  form.codice.onchange = aggDisp; form.negozio.onchange = aggDisp;
  form.onsubmit = e => {
    e.preventDefault();
    const codice = form.codice.value, ml = Number(form.ml.value), negozio = form.negozio.value, tipo = form.tipo.value;
    if (!codice || form.ml.value === '' || ml < 0) { toast('Scegli la referenza e i ml.'); return; }
    const attuale = g[codice]?.[negozio] || 0;
    const delta = tipo === 'carico' ? ml : ml - attuale;
    if (delta === 0) { toast('Nessuna differenza da registrare.'); return; }
    aggiungiMovimento({ dataEvento: adesso(), negozio, codice, tipo, ml: delta, rif: '', note: form.note.value });
    salva(`${tipo} ${codice}`); toast(`${tipo === 'carico' ? 'Carico' : 'Rettifica'} registrata: ${delta > 0 ? '+' : ''}${delta} ml.`); render();
  };
  $('#file-giacenze').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    let righe;
    try { righe = await leggiInventario(f); } catch (err) { console.error(err); toast('Non riesco a leggere il file: ' + err.message); return; }
    if (!righe.length) { toast('Nessuna riga trovata: servono le colonne Nome e Quantità.'); return; }
    anteprimaGiacenze = { ...normalizzaMagazzino(righe), file: f.name, negozio: $('#g-negozio').value };
    render();
  };
  if (anteprimaGiacenze) {
    $('#g-annulla').onclick = () => { anteprimaGiacenze = null; render(); };
    $('#g-conferma').onclick = () => applicaInventario(anteprimaGiacenze);
  }
}
async function leggiInventario(file) {
  let matrice;
  if (/\.csv$/i.test(file.name)) {
    const righe = parseCSV(await file.text());
    matrice = righe.length ? [Object.keys(righe[0]), ...righe.map(r => Object.values(r))] : [];
  } else {
    if (!window.XLSX) throw new Error('libreria Excel non caricata');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    matrice = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  }
  if (!matrice.length) return [];
  const header = matrice[0].map(h => String(h).trim()); const low = header.map(h => h.toLowerCase());
  let iNome = low.findIndex(h => h.startsWith('nome')); let iQta = low.findIndex(h => h.startsWith('quantit'));
  const iGen = low.findIndex(h => h.startsWith('genere') || h.startsWith('categoria'));
  if (iNome < 0) iNome = 0; if (iQta < 0) iQta = header.length - 1;
  // ogni altra colonna con intestazione è un codice fornitore (es. PL, PF, VF)
  const iForn = header.map((h, i) => i).filter(i => header[i] && ![iNome, iQta, iGen].includes(i) && !low[i].startsWith('codice a barre'));
  return matrice.slice(1).filter(r => r[iNome] !== '' && r[iNome] != null).map(r => {
    const o = { nome: r[iNome], quantita: Number(String(r[iQta]).replace(',', '.')) || 0 };
    if (iGen >= 0 && r[iGen] !== '' && r[iGen] != null) o.genere = String(r[iGen]);
    const f = {}; for (const i of iForn) { const v = String(r[i] ?? '').trim(); if (v) f[header[i]] = v; }
    if (Object.keys(f).length) o.fornitori = f;
    return o;
  });
}
function applicaInventario(a) {
  const g = giacenze();
  const lotto = { id: nId(), ts: adesso(), tipo: 'giacenze', file: a.file, negozio: a.negozio, righe: a.fragranze.length, scartate: a.ignorate.map(r => ({ descrizione: r.nome, motivo: 'non profumo' })), annullato: false };
  stato.lotti.push(lotto);
  let n = 0;
  for (const f of a.fragranze) {
    aggiornaAnagraficaDaInventario(f);
    const attuale = g[f.codice]?.[a.negozio] || 0;
    const delta = f.ml - attuale;
    if (delta !== 0) { aggiungiMovimento({ dataEvento: adesso(), negozio: a.negozio, codice: f.codice, tipo: 'inventario', ml: delta, rif: '', lotto: lotto.id, note: a.file }); n++; }
  }
  salva(`inventario ${a.negozio}`); anteprimaGiacenze = null; toast(`Inventario applicato a ${a.negozio}: ${n} referenze aggiornate.`); tab = 'magazzino'; render();
}

function renderAnagrafica() {
  const el = $('#tab-anagrafica');
  const fr = fragranzeOrdinate();
  const q = (filtro.testoAna || '').toLowerCase();
  const vis = fr.filter(f => !q || `${f.codice} ${f.brand} ${f.nome} ${fornitoriDi(f).map(s => s + ' ' + codiceFornitore(f, s)).join(' ')}`.toLowerCase().includes(q));
  const cellaForn = f => { const l = fornitoriDi(f); if (!l.length) return '<span class="muted">–</span>'; const pref = fornitorePreferito(f); return l.map(s => `<span class="nowrap ${s === pref ? 'pref' : ''}">${esc(s)} <b>${esc(codiceFornitore(f, s))}</b></span>`).join(' · '); };
  el.innerHTML = `
    <div class="card"><h2>Scorte per categoria</h2><p class="muted"><b>Scorta minima</b>: sotto questa quantità (ml, per negozio) la referenza va in allarme. <b>Scorta obiettivo</b>: il livello a cui riportarla con un trasferimento o un riordino. Puoi impostare valori diversi per singola referenza dalla tabella sotto.</p>
      <form id="form-soglie">
        <div class="riga" style="margin-bottom:10px"><div class="etich">Minima</div>${CATEGORIE.map(c => `<label class="campo">${esc(c)}<input type="number" min="0" step="10" inputmode="numeric" name="min:${esc(c)}" value="${stato.soglie[c] ?? 0}"></label>`).join('')}</div>
        <div class="riga"><div class="etich">Obiettivo</div>${CATEGORIE.map(c => `<label class="campo">${esc(c)}<input type="number" min="0" step="10" inputmode="numeric" name="ob:${esc(c)}" value="${stato.obiettivi[c] ?? 0}"></label>`).join('')}</div>
        <div class="azioni"><button class="primario" type="submit">Salva scorte</button></div></form></div>
    <div class="card"><h2>Fornitori</h2><p class="muted">Ogni fornitore ha una sigla (quella usata come intestazione di colonna nell'inventario, es. PL) e un nome esteso che compare sugli ordini. I codici prodotto di ciascun fornitore si inseriscono sulla singola referenza.</p>
      ${stato.fornitori.length ? `<div class="tabella-wrap"><table><thead><tr><th>Sigla</th><th>Nome esteso</th><th class="num">Referenze con codice</th></tr></thead><tbody>${stato.fornitori.map(fo => `<tr><td class="cod">${esc(fo.sigla)}</td><td><input class="nota" value="${esc(fo.nome)}" data-forn-nome="${esc(fo.sigla)}" placeholder="nome esteso"></td><td class="num">${fr.filter(f => codiceFornitore(f, fo.sigla)).length}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nessun fornitore: vengono creati dall\'inventario (colonne PL, PF, VF…) o qui sotto.</p>'}
      <form id="form-forn" class="riga" style="margin-top:10px"><label class="campo">Sigla<input name="sigla" placeholder="es. PL" maxlength="10" required></label><label class="campo" style="flex:2 1 220px">Nome esteso<input name="nome" placeholder="es. Parfum Lab"></label><button class="stretto" type="submit">Aggiungi fornitore</button></form></div>
    <div class="card"><div class="cerca"><h2 style="margin:0;flex:1 1 auto">Referenze (${fr.length})</h2><input type="search" id="cerca-ana" placeholder="Cerca codice, nome, codice fornitore…" value="${esc(filtro.testoAna || '')}"><button id="nuova-ref" class="piccolo primario">+ Nuova referenza</button></div>
      <div class="tabella-wrap"><table><thead><tr><th>Codice</th><th>Brand</th><th>Nome</th><th>Categoria</th><th class="num">Minima</th><th class="num">Obiettivo</th><th>Codici fornitore</th><th class="num">€/100 ml</th><th></th></tr></thead><tbody>
      ${vis.map(f => `<tr ${f.attivo === false ? 'class="muted"' : ''}><td class="cod">${f.codice}</td><td>${esc(f.brand)}</td><td>${esc(f.nome)}${f.varianti?.length ? `<div class="piccolo-testo muted">varianti: ${esc(f.varianti.join(', '))}</div>` : ''}${f.nome === '(da completare)' ? ' <span class="badge sotto">da completare</span>' : ''}${f.attivo === false ? ' <span class="badge grigio">disattivata</span>' : ''}</td><td>${esc(f.categoria)}</td><td class="num">${f.soglia != null && f.soglia !== '' ? `<b>${f.soglia}</b>` : `<span class="muted">${stato.soglie[f.categoria] ?? 0}</span>`}</td><td class="num">${f.obiettivo != null && f.obiettivo !== '' ? `<b>${f.obiettivo}</b>` : `<span class="muted">${obiettivoDi(f)}</span>`}</td><td class="piccolo-testo">${cellaForn(f)}</td><td class="num">${esc(f.costo || '')}</td><td><button class="piccolo" data-mod="${f.codice}">Modifica</button></td></tr>`).join('')}
      </tbody></table></div></div>
    <div class="card info"><h2>Come inserire un nuovo prodotto senza rompere i collegamenti</h2>
      <p>Il magazzino riconosce le vendite dal <b>codice a 3 cifre</b> e dal <b>formato in ML</b> scritti nella descrizione del gestionale di cassa. Perché tutto torni, quando crei un prodotto nuovo:</p>
      <ol class="istruzioni">
        <li><b>Qui</b>: "+ Nuova referenza", scegli un codice a 3 cifre libero nella fascia giusta (0xx uomo, 2xx e 3xx donna, 5xx e 6xx nicchia, 8xx premium), inserisci brand, nome e i codici dei fornitori che lo trattano.</li>
        <li><b>Nel gestionale di cassa</b>: crea un articolo per ogni formato con descrizione <b>esattamente</b> "codice spazio formato", ad esempio <code>545 30ML</code>, <code>545 50ML</code>, <code>545 100ML</code>. Il codice va all'inizio, poi uno spazio, poi i ml seguiti da "ML". Niente altro prima del codice.</li>
        <li>Assegna la <b>categoria</b> corrispondente (01 UOMO, 02 DONNA, 03 NICCHIA, 04 PREMIUM). Non è obbligatoria per il magazzino, ma tiene ordinati i report della cassa.</li>
        <li>Se lo stesso profumo arriva da un altro fornitore, <b>non</b> creare un nuovo codice: apri la referenza con "Modifica" e aggiungi il codice del nuovo fornitore. Un codice a 3 cifre = una fragranza, chiunque la fornisca.</li>
        <li>Quando la merce arriva, registrala in <b>Carichi</b> (ml aggiunti) sul negozio giusto.</li>
      </ol>
      <p class="piccolo-testo muted">Cosa non viene conteggiato: righe senza codice a 3 cifre (accessori, bucato, Maison Asrar), righe senza formato ML (es. "Profumi Auto 555"), resi. Le trovi comunque elencate nell'anteprima di ogni caricamento vendite.</p></div>`;
  $('#form-soglie').onsubmit = e => { e.preventDefault(); for (const c of CATEGORIE) { stato.soglie[c] = Number(e.target.elements['min:' + c].value) || 0; stato.obiettivi[c] = Math.max(Number(e.target.elements['ob:' + c].value) || 0, stato.soglie[c]); } salva('scorte'); toast('Scorte salvate.'); render(); };
  $('#form-forn').onsubmit = e => { e.preventDefault(); const sigla = e.target.sigla.value.trim().toUpperCase(); if (!sigla) return; if (stato.fornitori.some(x => x.sigla === sigla)) { toast('Sigla già presente.'); return; } registraFornitore(sigla, e.target.nome.value.trim() || sigla); salva('nuovo fornitore'); toast(`Fornitore ${sigla} aggiunto.`); render(); };
  $$('[data-forn-nome]', el).forEach(i => i.onchange = () => { const fo = stato.fornitori.find(x => x.sigla === i.dataset.fornNome); if (fo) { fo.nome = i.value.trim() || fo.sigla; salva('nome fornitore'); toast('Nome fornitore salvato.'); } });
  $('#cerca-ana').oninput = e => { filtro.testoAna = e.target.value; const pos = e.target.selectionStart; renderAnagrafica(); const c = $('#cerca-ana'); c.focus(); c.setSelectionRange(pos, pos); };
  $('#nuova-ref').onclick = () => modificaFragranza(null);
  $$('[data-mod]', el).forEach(b => b.onclick = () => modificaFragranza(b.dataset.mod));
}
function modificaFragranza(codice) {
  const f = codice ? stato.fragranze[codice] : { codice: '', brand: '', nome: '', categoria: '', soglia: '', obiettivo: '', fornitore: '', codiciFornitore: {}, costo: '', attivo: true, note: '' };
  const d = $('#dlg');
  const campiForn = stato.fornitori.map(fo => `<label class="campo">Codice ${esc(fo.sigla)}${fo.nome !== fo.sigla ? ` <span class="muted" style="text-transform:none;letter-spacing:0">(${esc(fo.nome)})</span>` : ''}<input name="cf:${esc(fo.sigla)}" value="${esc(f.codiciFornitore?.[fo.sigla] || '')}" inputmode="numeric" placeholder="—"></label>`).join('');
  d.innerHTML = `<h2>${codice ? 'Modifica referenza ' + codice : 'Nuova referenza'}</h2><form id="form-ref">
    <div class="riga"><label class="campo">Codice (3 cifre)<input name="codice" value="${esc(f.codice)}" ${codice ? 'readonly' : ''} pattern="\\d{3}" inputmode="numeric" required placeholder="es. 622"></label>
    <label class="campo">Categoria<select name="categoria">${CATEGORIE.map(c => `<option ${c === f.categoria ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div>
    <div class="riga"><label class="campo">Brand<input name="brand" value="${esc(f.brand)}"></label><label class="campo">Nome<input name="nome" value="${esc(f.nome)}" required></label></div>
    <div class="riga"><label class="campo">Scorta minima ml (vuoto = categoria)<input name="soglia" type="number" min="0" step="10" value="${f.soglia ?? ''}"></label><label class="campo">Scorta obiettivo ml (vuoto = categoria)<input name="obiettivo" type="number" min="0" step="10" value="${f.obiettivo ?? ''}"></label></div>
    <fieldset class="forn"><legend>Codici fornitore</legend>${campiForn || '<p class="muted piccolo-testo" style="margin:0">Nessun fornitore ancora: aggiungilo nella scheda Referenze e soglie, sezione Fornitori.</p>'}
      ${stato.fornitori.length > 1 ? `<label class="campo" style="margin-top:8px">Fornitore preferito per gli ordini<select name="fornitore"><option value="">primo con codice</option>${stato.fornitori.map(fo => `<option value="${esc(fo.sigla)}" ${f.fornitore === fo.sigla ? 'selected' : ''}>${esc(fo.sigla)} · ${esc(fo.nome)}</option>`).join('')}</select></label>` : ''}</fieldset>
    <div class="riga"><label class="campo">Costo €/100 ml<input name="costo" type="number" step="0.01" value="${esc(f.costo || '')}"></label><label class="campo">Stato<select name="attivo"><option value="1" ${f.attivo !== false ? 'selected' : ''}>Attiva</option><option value="0" ${f.attivo === false ? 'selected' : ''}>Disattivata (non più venduta)</option></select></label></div>
    <div class="riga"><label class="campo">Note<input name="note" value="${esc(f.note || '')}"></label></div>
    ${codice ? '' : '<p class="piccolo-testo muted">Ricorda di creare nel gestionale di cassa gli articoli con descrizione "codice formato", es. <code>622 50ML</code>.</p>'}
    <div class="azioni"><button type="button" id="ref-annulla">Annulla</button><button type="submit" class="primario">Salva</button></div></form>`;
  $('#ref-annulla').onclick = () => d.close();
  $('#form-ref').onsubmit = e => {
    e.preventDefault(); const v = Object.fromEntries(new FormData(e.target));
    if (!codice && stato.fragranze[v.codice]) { toast('Codice già presente.'); return; }
    const t = codice ? stato.fragranze[codice] : assicuraFragranza(v.codice);
    const cf = {}; for (const fo of stato.fornitori) { const c = String(v['cf:' + fo.sigla] || '').trim(); if (c) cf[fo.sigla] = c; }
    Object.assign(t, { brand: v.brand.trim(), nome: v.nome.trim(), categoria: v.categoria, soglia: v.soglia === '' ? null : Number(v.soglia), obiettivo: v.obiettivo === '' ? null : Number(v.obiettivo), fornitore: v.fornitore || '', codiciFornitore: cf, costo: v.costo, note: v.note.trim(), attivo: v.attivo === '1' });
    salva('modifica referenza'); d.close(); toast('Referenza salvata.'); render();
  };
  d.showModal();
}

function renderStorico() {
  const el = $('#tab-storico');
  const lotti = stato.lotti.slice().reverse();
  const mv = movimentiValidi().slice().reverse();
  const q = (filtro.testoSto || '').toLowerCase();
  const vis = mv.filter(m => !q || `${m.codice} ${nomeF(m.codice)} ${m.negozio} ${m.tipo} ${m.note || ''}`.toLowerCase().includes(q)).slice(0, 300);
  const snaps = store.snapshots();
  const tipoIt = { vendita: 'vendita', carico: 'carico', rettifica: 'rettifica', inventario: 'inventario', trasf_out: 'uscita trasferimento', trasf_in: 'entrata trasferimento' };
  el.innerHTML = `
    <div class="card"><h2>Backup</h2><p class="muted">I dati vivono in questo browser/tablet. Scarica un backup ogni tanto (e prima di operazioni delicate); da un backup puoi ripristinare tutto, anche su un altro dispositivo.</p>
      <div class="azioni"><button id="bk-esporta" class="primario">Scarica backup</button><label class="btn" style="display:inline-flex;align-items:center">Ripristina da backup <input type="file" id="bk-importa" accept=".json" style="display:none"></label><button id="bk-azzera" class="pericolo">Azzera tutti i dati</button></div>
      ${snaps.length ? `<details style="margin-top:12px"><summary>Punti di ripristino automatici (${snaps.length})</summary><p class="muted piccolo-testo">Prima di ogni salvataggio viene conservata una copia dello stato precedente. Utile per tornare indietro dopo un errore.</p><ul class="pulita">${snaps.map((s, i) => `<li>${fmtData(s.ts)} · prima di: <b>${esc(s.etichetta || '-')}</b> <button class="piccolo" data-snap="${i}" style="float:right">Ripristina</button></li>`).join('')}</ul></details>` : ''}</div>
    ${stato.ordini.length ? `<div class="card"><h2>Ordini confermati (${stato.ordini.length})</h2><p class="muted piccolo-testo">Da qui puoi riscaricare Excel o PDF di ogni ordine.</p><div class="tabella-wrap"><table><thead><tr><th>Quando</th><th>Fornitore</th><th>Consegna</th><th class="num">Voci</th><th class="num">Totale</th><th>Stato</th><th></th></tr></thead><tbody>${stato.ordini.slice().reverse().map(o => `<tr><td>${fmtData(o.ts)}</td><td>${esc(nomeFornitore(o.fornitore) || '–')}</td><td>${esc(o.negozio || '–')}</td><td class="num">${o.righe.length}</td><td class="num">${fmtMl(o.totMl)}</td><td>${badgeOrdine(o)}</td><td class="azioni" style="margin:0"><button class="piccolo" data-ordine="${o.id}">Vedi</button><button class="piccolo" data-ordine-excel="${o.id}">Excel</button><button class="piccolo" data-ordine-stampa="${o.id}">PDF</button></td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="card"><h2>Caricamenti (${lotti.length})</h2><p class="muted">Un caricamento sbagliato si annulla in blocco: tutte le sue righe smettono di contare e il file può essere ricaricato.</p>
      ${lotti.length ? `<div class="tabella-wrap"><table><thead><tr><th>Quando</th><th>Tipo</th><th>File</th><th>Negozio</th><th class="num">Righe</th><th></th></tr></thead><tbody>${lotti.map(l => `<tr><td>${fmtData(l.ts)}</td><td>${l.tipo}</td><td>${esc(l.file)}</td><td>${l.negozio || 'entrambi'}</td><td class="num">${l.righe}</td><td>${l.annullato ? '<span class="badge grigio">annullato</span>' : `<button class="piccolo pericolo" data-annulla-lotto="${l.id}">Annulla</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nessuno.</p>'}</div>
    <div class="card"><div class="cerca"><h2 style="margin:0;flex:1 1 auto">Movimenti (${mv.length})</h2><input type="search" id="cerca-sto" placeholder="Filtra per codice, negozio, tipo…" value="${esc(filtro.testoSto || '')}"></div>
      <div class="tabella-wrap"><table><thead><tr><th>Registrato</th><th>Data evento</th><th>Negozio</th><th>Referenza</th><th>Tipo</th><th class="num">ml</th><th>Rif.</th></tr></thead><tbody>${vis.map(m => `<tr><td>${fmtData(m.ts)}</td><td>${fmtData(m.dataEvento)}</td><td>${m.negozio}</td><td>${esc(nomeF(m.codice))}</td><td>${tipoIt[m.tipo] || m.tipo}</td><td class="num">${m.ml > 0 ? '+' : ''}${m.ml}</td><td class="muted piccolo-testo">${esc(m.note || m.rif || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="vuoto">Nessun movimento.</td></tr>'}</tbody></table></div>${mv.length > 300 ? '<p class="muted piccolo-testo">Mostrati i 300 più recenti.</p>' : ''}</div>`;
  $('#bk-esporta').onclick = () => {
    const blob = new Blob([JSON.stringify(stato, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `profumari-backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`; a.click();
  };
  $('#bk-importa').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (!s.fragranze || !s.movimenti) throw new Error('formato');
      if (!await conferma('Ripristinare il backup?', `Il file <b>${esc(f.name)}</b> sostituirà i dati attuali (${Object.keys(s.fragranze).length} referenze, ${s.movimenti.length} movimenti). Lo stato attuale resta nei punti di ripristino automatici.`, 'Ripristina', true)) return;
      stato = { ...statoVuoto(), ...s }; salva('ripristino backup'); toast('Backup ripristinato.'); render();
    } catch { toast('File di backup non valido.'); }
  };
  $('#bk-azzera').onclick = async () => {
    if (!await conferma('Azzerare tutti i dati?', 'Referenze, movimenti, trasferimenti e liste verranno cancellati da questo dispositivo. Lo stato attuale resta nei punti di ripristino automatici.', 'Azzera tutto', true)) return;
    stato = statoVuoto(); salva('azzeramento'); filtro.negozio = filtro.stato = filtro.categoria = null; tab = 'magazzino'; toast('Dati azzerati.'); render();
  };
  $$('[data-snap]', el).forEach(b => b.onclick = async () => {
    const s = snaps[Number(b.dataset.snap)];
    if (!await conferma('Tornare a questo punto?', `Stato del ${fmtData(s.ts)} (prima di: ${esc(s.etichetta || '-')}). Le operazioni fatte dopo andranno perse.`, 'Ripristina', true)) return;
    const r = store.ripristina(Number(b.dataset.snap)); if (r) { stato = r; toast('Stato ripristinato.'); render(); }
  });
  $$('[data-annulla-lotto]', el).forEach(b => b.onclick = async () => {
    const l = stato.lotti.find(x => x.id === b.dataset.annullaLotto);
    if (!await conferma('Annullare il caricamento?', `<b>${esc(l.file)}</b> (${l.righe} righe). Le sue righe non conteranno più e il file potrà essere ricaricato.`, 'Annulla caricamento', true)) return;
    l.annullato = true;
    for (const [k, v] of Object.entries(stato.chiaviVendite)) if (v === l.id) delete stato.chiaviVendite[k];
    salva('annulla caricamento'); toast('Caricamento annullato.'); render();
  });
  $$('[data-ordine]', el).forEach(b => b.onclick = () => dialogOrdine(stato.ordini.find(x => x.id === b.dataset.ordine)));
  $$('[data-ordine-excel]', el).forEach(b => b.onclick = () => excelOrdine(stato.ordini.find(x => x.id === b.dataset.ordineExcel)));
  $$('[data-ordine-stampa]', el).forEach(b => b.onclick = () => stampaOrdine(stato.ordini.find(x => x.id === b.dataset.ordineStampa)));
  $('#cerca-sto').oninput = e => { filtro.testoSto = e.target.value; const pos = e.target.selectionStart; renderStorico(); const c = $('#cerca-sto'); c.focus(); c.setSelectionRange(pos, pos); };
}

// ---------- avvio ----------
$('#tabs').onclick = e => { const b = e.target.closest('button[data-tab]'); if (b) { tab = b.dataset.tab; render(); window.scrollTo(0, 0); } };
document.addEventListener('click', e => {
  const v = e.target.closest('[data-vai]'); if (v) { tab = v.dataset.vai; render(); }
});
window.profumari = { velocita, proposta, get stato() { return stato; }, set stato(s) { stato = s; salva('impostazione manuale'); render(); }, giacenze, render, normalizzaMagazzino, applicaInventario };
render();
