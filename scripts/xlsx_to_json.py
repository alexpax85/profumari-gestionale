#!/usr/bin/env python3
"""Converte l'export magazzino (Nome, Codice a barre, Quantità) in JSON [{nome, quantita}]."""
import sys, json, warnings
warnings.filterwarnings("ignore")
import openpyxl
wb = openpyxl.load_workbook(sys.argv[1], read_only=True)
ws = wb.worksheets[0]
rows = list(ws.iter_rows(values_only=True))
out = [{"nome": r[0], "quantita": r[2] or 0} for r in rows[1:] if r and r[0] is not None]
json.dump(out, open(sys.argv[2], "w"), ensure_ascii=False, indent=1)
print(f"{len(out)} righe -> {sys.argv[2]}")
