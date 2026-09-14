// Genera il report di normalizzazione dell'anagrafica da rivedere col cliente.
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizzaMagazzino } from '../app/js/normalizza.js';
const [,, inFile, outFile] = process.argv;
const righe = JSON.parse(readFileSync(inFile, 'utf8'));
const { fragranze, ignorate } = normalizzaMagazzino(righe);
const L = [];
L.push(`# Report normalizzazione anagrafica`, '', `Righe Excel: ${righe.length}. Referenze: ${fragranze.length}. Righe ignorate (non profumo): ${ignorate.length}.`, '');
L.push(`## Referenze con più righe accorpate (${fragranze.filter(f => f.righe.length > 1).length})`, '');
for (const f of fragranze.filter(f => f.righe.length > 1)) {
  L.push(`- **${f.codice} ${f.brand} - ${f.nome}** → ${f.ml} ml  (varianti: ${f.varianti.join(', ') || '-'})`);
  for (const r of f.righe) L.push(`  - "${r.nome}" ${r.quantita} ml`);
  if (f.nomiDiversi.length) L.push(`  - ⚠ nomi diversi dopo la pulizia: ${f.nomiDiversi.join(' | ')}`);
}
L.push('', `## Referenze con suffisso rimosso (riga singola)`, '');
for (const f of fragranze.filter(f => f.righe.length === 1 && f.varianti.length)) L.push(`- ${f.codice} ${f.brand} - ${f.nome}  (era: "${f.righe[0].nome}")`);
L.push('', `## Referenze senza brand riconoscibile (manca il trattino)`, '');
for (const f of fragranze.filter(f => !f.brand)) L.push(`- ${f.codice} "${f.nome}"`);
L.push('', `## Righe ignorate`, '');
for (const r of ignorate) L.push(`- "${r.nome}" ${r.quantita}`);
L.push('', `## Anagrafica completa`, '', '| Codice | Brand | Nome | Categoria | ml |', '|---|---|---|---|---|');
for (const f of fragranze) L.push(`| ${f.codice} | ${f.brand} | ${f.nome} | ${f.categoria} | ${f.ml} |`);
writeFileSync(outFile, L.join('\n'));
console.log(`referenze ${fragranze.length}, ignorate ${ignorate.length} -> ${outFile}`);
