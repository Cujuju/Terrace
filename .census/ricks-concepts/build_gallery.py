from pathlib import Path
import base64
import hashlib
import html
import json
import shutil

root = Path(__file__).resolve().parent
options = json.loads((root / 'concept-prompts.json').read_text(encoding='utf-8'))
sources = json.loads((root / 'sources.json').read_text(encoding='utf-8'))
cards = []
verification = []
assert len(options) == len(sources) == 5
for option, source in zip(options, sources):
    assert option['letter'] == source['letter']
    target = root / f"candidate-{option['letter']}.png"
    shutil.copyfile(source['source'], target)
    data = target.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    digest = hashlib.sha256(data).hexdigest()
    assert digest == hashlib.sha256(Path(source['source']).read_bytes()).hexdigest()
    width, height = int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')
    verification.append(dict(candidate=option['letter'], file=str(target), width=width, height=height, sha256=digest))
    title = html.escape(option['letter'].upper() + ' — ' + option['name'])
    image = 'data:image/png;base64,' + base64.b64encode(data).decode('ascii')
    cards.append(f'<article id="{option["letter"]}"><h2>{title}</h2><p>{html.escape(option["description"])}</p><a href="{image}" target="_blank"><img src="{image}" alt="{title}"></a></article>')

page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ricks — Five building concepts</title>
<style>*{box-sizing:border-box}body{margin:0;background:#181c19;color:#ecebe1;font:16px/1.5 system-ui,sans-serif}header,main,footer{max-width:1600px;margin:auto;padding:28px}h1{font-size:44px;letter-spacing:-1px;margin:0}header p{color:#b9c2b6}nav{display:flex;gap:12px;flex-wrap:wrap}nav a{color:#d4ec98;border:1px solid #566443;padding:6px 16px;border-radius:6px;text-decoration:none}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;padding-top:0}article{background:#242a24;border:1px solid #404b3c;border-radius:12px;overflow:hidden}h2{font-size:22px;margin:20px 22px 4px}article p{margin:0 22px 18px;color:#c0c7bb;min-height:48px}img{display:block;width:100%;aspect-ratio:1.3;object-fit:contain;background:#b6b0a5}footer{font-size:14px;color:#b9c2b6}a{color:#d4ec98}@media(max-width:760px){main{grid-template-columns:1fr}h1{font-size:34px}}@media print{body{background:white;color:black}header,main,footer{padding:12px}article{break-inside:avoid}nav{display:none}}</style>
<header><h1>Ricks</h1><p>Five fictional bioweapons-lab building concepts · Terrace · 23 September 2026</p><nav>'''
page += ''.join(f'<a href="#{o["letter"]}">{o["letter"].upper()} · {html.escape(o["name"])}</a>' for o in options)
page += '</nav></header><main>' + ''.join(cards) + '</main><footer>Concept art generated with the built-in image generator using the previous building and Durand’s concept workflow. Exact backend version unverified. These are selection concepts; Blender models and game integration are not part of this delivery. All five originals and exact prompts are preserved beside this gallery. Artifact publishing was unavailable; this standalone page is the local fallback.</footer></html>'
# Embed each PNG once; native image links would duplicate the page payload.
for option in options:
    data = (root / f"candidate-{option['letter']}.png").read_bytes()
    image = 'data:image/png;base64,' + base64.b64encode(data).decode('ascii')
    page = page.replace(f'<a href="{image}" target="_blank"><img', '<a href="#'+option['letter']+'"><img')
output = root / 'gallery.html'
output.write_text(page, encoding='utf-8')
assert len(verification) == 5 and len({v['sha256'] for v in verification}) == 5
assert page.count('<img ') == 5
(root / 'verification.json').write_text(json.dumps(verification, indent=2), encoding='utf-8')
print(json.dumps(dict(gallery=str(output), bytes=output.stat().st_size, candidates=verification), indent=2))
