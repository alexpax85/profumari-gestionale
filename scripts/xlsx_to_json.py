#!/usr/bin/env python3
"""Converte l'export magazzino in JSON [{nome, quantita, genere?, fornitori?}].
Colonne riconosciute: Nome, Quantità, Genere/Categoria; ogni altra colonna con intestazione è un codice fornitore."""
import sys, json, warnings
warnings.filterwarnings("ignore")
import openpyxl
wb = openpyxl.load_workbook(sys.argv[1], read_only=True)
ws = wb.worksheets[0]
rows = list(ws.iter_rows(values_only=True))
hdr = [str(h).strip() if h is not None else '' for h in rows[0]]
low = [h.lower() for h in hdr]
i_nome = next((i for i, h in enumerate(low) if h.startswith('nome')), 0)
i_qta = next((i for i, h in enumerate(low) if h.startswith('quantit')), None)
i_gen = next((i for i, h in enumerate(low) if h.startswith('genere') or h.startswith('categoria')), None)
forn = [i for i, h in enumerate(hdr) if h and i not in (i_nome, i_qta, i_gen) and not low[i].startswith('codice a barre')]
out = []
for r in rows[1:]:
    if not r or r[i_nome] in (None, ''): continue
    o = {"nome": r[i_nome], "quantita": (r[i_qta] if i_qta is not None else 0) or 0}
    if i_gen is not None and r[i_gen]: o["genere"] = str(r[i_gen])
    f = {hdr[i]: str(r[i]).strip() for i in forn if r[i] not in (None, '')}
    if f: o["fornitori"] = f
    out.append(o)
json.dump(out, open(sys.argv[2], "w"), ensure_ascii=False, indent=1)
print(f"{len(out)} righe, fornitori {[hdr[i] for i in forn]} -> {sys.argv[2]}")
