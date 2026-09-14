#!/usr/bin/env python3
"""Produce build/index.html: la pagina senza doctype/html/head/body, come richiede la pubblicazione su claude.ai."""
import re, os
s = open('app/index.html', encoding='utf-8').read()
s = re.sub(r'<!doctype[^>]*>\s*', '', s, flags=re.I)
s = re.sub(r'</?(html|head|body)\b[^>]*>\s*', '', s, flags=re.I)
s = re.sub(r'<meta charset[^>]*>\s*|<meta name="viewport"[^>]*>\s*', '', s)
# la copia locale di SheetJS contiene un byte ESC che la pubblicazione rifiuta: nella versione pubblicata si usa il CDN
s = s.replace('src="lib/xlsx.full.min.js"', 'src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"')
os.makedirs('build', exist_ok=True)
open('build/index.html', 'w', encoding='utf-8').write(s.strip() + '\n')
print('build/index.html pronto')
