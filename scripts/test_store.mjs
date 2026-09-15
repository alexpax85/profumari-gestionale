// Test degli helper di persistenza condivisa: scomposizione, ricomposizione, differenze, filtro demo.
// Uso: node scripts/test_store.mjs
import assert from 'node:assert/strict';
import { statoVuoto, scomponi, ricomponi, differenze, canonico, lottiDemo, senzaDemo, idDoc } from '../app/js/store.js';

const s = statoVuoto();
s.fragranze['545'] = { codice: '545', brand: 'Brand', nome: 'Nome', categoria: 'NICCHIA', varianti: ['PF'], soglia: null, obiettivo: null, fornitore: 'PL', codiciFornitore: { PL: '12' }, costi: { PL: 350 }, attivo: true, note: '' };
s.fragranze['021'] = { codice: '021', brand: '', nome: '(da completare)', categoria: 'UOMO', varianti: [], soglia: null, fornitore: '', codiciFornitore: {}, costi: {}, attivo: true, note: '' };
s.fornitori.push({ sigla: 'PL', nome: 'Parfum Lab' }, { sigla: 'A/B', nome: 'Con barra' });
s.lotti.push({ id: 'l1', ts: '2026-09-01T10:00:00.000Z', tipo: 'vendite', file: 'vendite.csv', righe: 2, scartate: [], annullato: false });
s.lotti.push({ id: 'l2', ts: '2026-09-02T10:00:00.000Z', tipo: 'giacenze', file: 'Inventario Aprilia (demo)', negozio: 'Aprilia', righe: 1, scartate: [], annullato: false });
s.lotti.push({ id: 'l3', ts: '2026-09-03T10:00:00.000Z', tipo: 'vendite', file: 'vendite-demo-6-settimane.csv', righe: 1, scartate: [], annullato: false });
s.movimenti.push({ id: 'm2', ts: '2026-09-01T10:00:01.000Z', dataEvento: '2026-09-01', negozio: 'Latina', codice: '545', tipo: 'vendita', ml: -50, rif: 'r2', lotto: 'l1', note: '' });
s.movimenti.push({ id: 'm1', ts: '2026-09-01T10:00:00.000Z', dataEvento: '2026-09-01', negozio: 'Latina', codice: '545', tipo: 'vendita', ml: -30, rif: 'r1', lotto: 'l1', note: '' });
s.movimenti.push({ id: 'm3', ts: '2026-09-02T10:00:00.000Z', dataEvento: '2026-09-02', negozio: 'Aprilia', codice: '545', tipo: 'inventario', ml: 500, rif: '', lotto: 'l2', note: '' });
s.movimenti.push({ id: 'm4', ts: '2026-09-03T10:00:00.000Z', dataEvento: '2026-09-03', negozio: 'Aprilia', codice: '545', tipo: 'vendita', ml: -100, rif: 'r4', lotto: 'l3', note: '' });
s.chiaviVendite = { k1: 'l1', k2: 'l1', k4: 'l3' };
s.trasferimenti.push({ id: 't1', ts: '2026-09-04T10:00:00.000Z', da: 'Latina', a: 'Aprilia', codice: '545', ml: 100, stato: 'proposto', storia: [{ stato: 'proposto', ts: '2026-09-04T10:00:00.000Z' }], note: '' });
s.ordini.push({ id: 'o1', ts: '2026-09-05T10:00:00.000Z', fornitore: 'PL', negozio: 'Latina', righe: [{ codice: '545', ml: 200, codiceFornitore: '12', nome: 'Brand - Nome', categoria: 'NICCHIA', giacenza: 0, note: '' }], totMl: 200 });
s.piano = { riordini: { '545|Latina': { codice: '545', negozio: 'Latina', ml: 100, fornitore: 'PL', note: '' } }, spostamenti: { '545|Aprilia': { codice: '545', da: 'Latina', a: 'Aprilia', ml: 50 } } };
s.soglie.UOMO = 150;

// scomponi → ricomponi è l'identità sullo stato (a meno dell'ordine dei movimenti, che viene per data)
const d = scomponi(s);
assert.equal(Object.keys(d.fragranze).length, 2);
assert.ok(!('costi' in d.fragranze['545']) && !('codiciFornitore' in d.fragranze['545']), 'costi e codici fornitore non stanno nel documento pubblico');
assert.deepEqual(d.riservato['545'], { codice: '545', costi: { PL: 350 }, codiciFornitore: { PL: '12' }, fornitore: 'PL' });
// documento riservato vecchio (costo unico €/100 ml): resta come `costo`, lo converte app.js
const vecchio = ricomponi({ fragranze: { '001': { codice: '001', nome: 'X' } }, riservato: { '001': { codice: '001', costo: '35', codiciFornitore: {}, fornitore: '' } } });
assert.equal(vecchio.fragranze['001'].costo, '35'); assert.ok(!('costi' in vecchio.fragranze['001']));
assert.ok('A%2FB' in d.fornitori, 'id documento senza barra: ' + Object.keys(d.fornitori));
assert.deepEqual(d.lotti.l1.chiavi, ['k1', 'k2']);
assert.deepEqual(d.config.piano_riordini.voci, s.piano.riordini);
const r = ricomponi(d);
assert.deepEqual(r.fragranze, s.fragranze);
assert.deepEqual(r.fornitori.map(f => f.sigla), ['A/B', 'PL']);
assert.deepEqual(r.movimenti.map(m => m.id), ['m1', 'm2', 'm3', 'm4'], 'movimenti ordinati per data');
assert.deepEqual(r.chiaviVendite, s.chiaviVendite);
assert.ok(!('chiavi' in r.lotti[0]));
assert.deepEqual(r.piano, s.piano);
assert.deepEqual(r.soglie, s.soglie); assert.deepEqual(r.obiettivi, s.obiettivi);
assert.deepEqual(r.trasferimenti, s.trasferimenti); assert.deepEqual(r.ordini, s.ordini);

// differenze: primo salvataggio scrive tutto, il secondo niente, una modifica scrive un solo documento
const ultimo = {}; for (const c of Object.keys(d)) ultimo[c] = {};
const tutte = differenze(s, ultimo);
assert.equal(tutte.filter(o => o.tipo === 'set').length, 2 + 2 + 2 + 4 + 3 + 1 + 1 + 4);
for (const o of tutte) ultimo[o.c][o.id] = o.json;
assert.deepEqual(differenze(s, ultimo), []);
s.trasferimenti[0].stato = 'spedito';
const una = differenze(s, ultimo);
assert.equal(una.length, 1); assert.equal(una[0].c, 'trasferimenti'); assert.equal(una[0].id, 't1');
// ordine dei campi diverso → nessuna differenza
ultimo.trasferimenti.t1 = una[0].json;
s.trasferimenti[0] = Object.fromEntries(Object.entries(s.trasferimenti[0]).reverse());
assert.deepEqual(differenze(s, ultimo), []);
// undefined non arriva a Firestore
s.fragranze['021'].note = undefined;
const conUndef = differenze(s, ultimo);
assert.equal(conUndef.length, 1); assert.ok(!('note' in conUndef[0].dati));
// rimozione di un documento → delete
delete s.fragranze['021'];
assert.deepEqual(differenze(s, ultimo).map(o => [o.tipo, o.c, o.id]).sort(), [['del', 'fragranze', '021'], ['del', 'riservato', '021']]);
// il dipendente non tocca riservato né piano_riordini
const opsDip = differenze(s, ultimo, ['fragranze', 'config'], ['soglie', 'piano_spostamenti', 'meta']);
assert.deepEqual(opsDip.map(o => [o.tipo, o.c, o.id]), [['del', 'fragranze', '021']]);
assert.equal(canonico({ b: 1, a: [undefined, { z: 2, y: null }] }), '{"a":[null,{"y":null,"z":2}],"b":1}');
assert.equal(idDoc(''), '_');

// dati dimostrativi
assert.deepEqual(lottiDemo(s).map(l => l.id), ['l2', 'l3']);
const pulito = senzaDemo(s);
assert.deepEqual(pulito.lotti.map(l => l.id), ['l1']);
assert.deepEqual(pulito.movimenti.map(m => m.id).sort(), ['m1', 'm2']);
assert.deepEqual(pulito.chiaviVendite, { k1: 'l1', k2: 'l1' });
assert.equal(senzaDemo(pulito), pulito, 'senza lotti demo lo stato resta lo stesso oggetto');
console.log('test_store: ok');
