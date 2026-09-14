#!/usr/bin/env python3
"""Genera app/demo-data.js: inventario Latina reale (dati/latina_export.json), Aprilia simulato,
sei settimane di vendite simulate coerenti con le giacenze. Uso: python3 scripts/genera_demo.py"""
import json, random, datetime, csv, io, re, os
random.seed(7)
latina = json.load(open('dati/latina_export.json'))
def codice(n):
    m = re.match(r'^\s*(\d{3})(?!\d)', str(n)); return m.group(1) if m and not re.match(r'^\s*(30|50|100)\s*ML', str(n), re.I) else None
aprilia = []
for r in latina:
    q = r['quantita'] or 0
    if codice(r['nome']) and q > 0: q = round(q * random.uniform(0.25, 1.3) / 10) * 10
    elif codice(r['nome']) and random.random() < 0.15: q = random.choice([100, 150, 200])
    aprilia.append({**r, 'quantita': q})
stock = {'Latina': {}, 'Aprilia': {}}
for neg, lst in (('Latina', latina), ('Aprilia', aprilia)):
    for r in lst:
        c = codice(r['nome'])
        if c: stock[neg][c] = stock[neg].get(c, 0) + (r['quantita'] or 0)
codici = sorted(stock['Latina'])
best = random.sample(codici, 45)
peso = {c: (8 if c in best else 1) for c in codici}
bias = {c: random.uniform(0.2, 0.8) for c in codici}
def cat(c):
    n = int(c); return '01 UOMO' if n < 200 else '02 DONNA' if n < 500 else '03 NICCHIA' if n < 800 else '04 PREMIUM'
prezzi = {'01 UOMO': {30: 12.90, 50: 16.90, 100: 25.90}, '02 DONNA': {30: 12.90, 50: 16.90, 100: 25.90}, '03 NICCHIA': {30: 15.90, 50: 21.90, 100: 30.90}, '04 PREMIUM': {30: 19.90, 50: 25.90, 100: 35.90}}
mesi = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic']
pag = ['Contanti', 'Mastercard - Carta di debito', 'Visa - Carta di debito', 'Mastercard - Carta di credito']
venduto = {'Latina': {}, 'Aprilia': {}}
righe = []; n = 0
g0 = datetime.date(2026, 8, 3)
f = lambda v: f'{v:.2f}'.replace('.', ',')
for d in range(41):
    giorno = g0 + datetime.timedelta(days=d)
    if giorno.weekday() == 6: continue
    for _ in range(random.randint(18, 34)):
        c = random.choices(codici, weights=[peso[x] for x in codici])[0]
        neg = 'Aprilia' if random.random() < bias[c] else 'Latina'
        ml = random.choices([30, 50, 100], weights=[35, 45, 20])[0]
        if venduto[neg].get(c, 0) + ml > stock[neg].get(c, 0) * 0.75: continue
        venduto[neg][c] = venduto[neg].get(c, 0) + ml
        n += 1
        ct = cat(c); p = prezzi[ct][ml]; sc = round(p * 0.05, 2) if random.random() < 0.2 else 0.0
        lordo = round(p - sc, 2); netto = round(lordo / 1.22, 2); iva = round(lordo - netto, 2)
        righe.append([f"{giorno.day} {mesi[giorno.month-1]} {giorno.year}, {random.randint(9,19):02d}:{random.randint(0,59):02d}", 'Vendita', f'DEMO{n:05d}', random.choice(pag), '1', f'{c} {ml}ML', ct, '', 'EUR', f(p), f(sc), f(lordo), f(netto), f(iva), '22%', neg, ''])
        if random.random() < 0.03:
            righe.append([righe[-1][0], 'Vendita', f'DEMO{n:05d}', righe[-1][3], '1', random.choice(['Profumi Auto 555', 'Fresh cotton Piccolo', 'Blueberry']), random.choice(['ACCESSORI', 'BUCATO', 'MAISON ASRAR + GULF ORCHID']), '', 'EUR', '6,90', '0,00', '6,90', '5,66', '1,24', '22%', neg, ''])
righe.sort(key=lambda r: (int(r[0].split(' ')[0]) + 31 * mesi.index(r[0].split(' ')[1]), r[0].split(', ')[1]))
header = ['Data','Tipo','ID Transazione','Metodo di pagamento','Quantità','Descrizione','Categoria','SKU','Valuta','Prezzo iniziale','Sconto','Prezzo (lordo)','Prezzo (netto)','IVA','Percentuale imposta','Account','Motivo del rimborso']
buf = io.StringIO(); w = csv.writer(buf); w.writerow(header); w.writerows(righe)
dati = {'latina': latina, 'aprilia': aprilia, 'vendite': buf.getvalue()}
open('app/demo-data.js', 'w').write('// Dati dimostrativi: inventario Latina reale, Aprilia e vendite simulate. Generato da scripts/genera_demo.py\nwindow.DATI_DEMO = ' + json.dumps(dati, ensure_ascii=False) + ';\n')
print('righe vendita', len(righe), '| demo-data.js', os.path.getsize('app/demo-data.js') // 1024, 'KB')
