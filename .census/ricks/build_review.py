"""Package the measured Ricks delivery and self-contained visual review."""
from pathlib import Path
import base64
import hashlib
import html
import json

root=Path(__file__).resolve().parent
repo=root.parents[1]
checks={q:json.loads((p/'verification.json').read_text()) for q,p in (('original',root),('low',root/'low'))}
memory=json.loads((root/'memory-report.json').read_text())
lighting=json.loads((root/'lighting-verification.json').read_text())
assert all(c['passed'] for c in checks.values()) and lighting['passed']
delta=max(abs(a-b) for key in ('min','max') for a,b in zip(checks['original']['bounds_gltf_y_up'][key],checks['low']['bounds_gltf_y_up'][key]))
assert delta<.0002
integration=[r for r in json.loads((root.parent/'building-kit'/'integration-verification.json').read_text()) if r['building']=='ricks']
assert len(integration)==2
for entry in integration:
    assert hashlib.sha256((repo/entry['runtime']).read_bytes()).hexdigest()==entry['sha256']
delivery={'asset':'Ricks — Black Vault','selected_concept':'B','date':'2026-09-23',
          'original_low_bounds_delta':delta,'runtime':integration,
          'geometry_uv_compression_mips_passed':True,'emission_visible_with_no_external_light':True,
          'app_started':False,'client_build':'passed at initial integration','structures_typecheck':'passed after concrete/entrance revision',
          'existing_structures_tests':{'passed':195,'failed':2,'cause':'Unchanged assertions require <=6 tiers; existing protocol has 11.'},
          'workspace_typecheck':'Existing Buffer/Uint8Array type errors in client/test/rigAsset.test.ts; no diagnostics in modified sources.',
          'assumptions':['Rear elevation extrapolated from the selected front-right concept.','Cosmetic top-tier inland variant using 24 of 256 hash buckets after the unchanged Durands buckets.']}
delivery['appearance_revision']={'wall_material':'Weathered cast concrete, no brick courses',
    'weathering':['aggregate','pitting','edge wear','hairline cracks','runoff stains','ground grime'],
    'geometry':['Broad horizontal concrete shoulder below recessed clerestory','Folded coated-steel wall straps','Wider splayed entrance columns and steel jambs'],
    'biohazard_sign':'Same wall location',
    'stairs':'Dark risers, brighter tread noses and shaded tread backs',
    'emission':'Strength 1.6 retained; atlas repacked for revised geometry; darkness controls passed'}
(root/'delivery-verification.json').write_text(json.dumps(delivery,indent=2),encoding='utf-8')
shots=[('Selected concept B',root/'ricks-concept.png','Generated reference selected by the owner.'),
       ('Finished model · Original',root/'ricks-day.png','Actual exported GLB in Blender, 2048 textures.'),
       ('Before rim revision',root/'ricks-before-rim.png','Previous narrow beveled lip, preserved for comparison.'),
       ('Concrete, lip and entrance detail',root/'ricks-closeup.png','The wall rises to a broad level concrete ledge, then meets the recessed window band.'),
       ('Original · night',root/'ricks-night.png','Emissive green glass, amber fixtures and red beacon.'),
       ('Original · zero external light',root/'ricks-unlit.png','World and sun energy are zero. Bloom is off.'),
       ('Finished model · Low',root/'low'/'ricks-day.png','Same silhouette and placement, 1024 textures.'),
       ('Low · zero external light',root/'low'/'ricks-unlit.png','The low variant preserves all emissive regions.')]
cards=[]
for title,path,caption in shots:
    image='data:image/png;base64,'+base64.b64encode(path.read_bytes()).decode('ascii')
    cards.append('<figure><figcaption><h2>'+html.escape(title)+'</h2><p>'+html.escape(caption)+'</p></figcaption><img src="'+image+'" alt="'+html.escape(title)+'"></figure>')
rows=[]
for quality in ('original','low'):
    c=checks[quality]; m=memory['variants'][quality]
    rows.append(f'<tr><td>{quality.title()}</td><td>{c["triangles"]:,}</td><td>{2048 if quality=="original" else 1024}</td><td>{m["ktx2_bc7_astc_gpu_total_bytes"]/1048576:.2f} MiB</td></tr>')
page='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ricks · Black Vault</title><style>
*{box-sizing:border-box}body{margin:0;background:#151b17;color:#f0eee4;font:16px/1.5 system-ui,sans-serif}header,main,footer{max-width:1560px;margin:auto;padding:28px}h1{font-size:42px;margin:0}header p,figcaption p,footer{color:#bdc7b7}main{padding-top:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}figure{margin:0;background:#232b23;border:1px solid #46523e;border-radius:10px;overflow:hidden}figcaption{padding:18px}h2{font-size:20px;margin:0}p{margin:7px 0}img{display:block;width:100%;aspect-ratio:4/3;object-fit:contain;background:#080b09}table{border-collapse:collapse;margin-top:20px}td,th{border-bottom:1px solid #4a5445;padding:8px 24px 8px 0;text-align:left}footer{font-size:14px;padding-top:8px}@media(max-width:760px){main{grid-template-columns:1fr}h1{font-size:34px}}
</style><header><h1>Ricks · Black Vault</h1><p>Selected concept B, rebuilt as an original game asset. Green glass, amber fixtures and red beacon remain visible in darkness.</p><table><tr><th>Variant</th><th>Triangles</th><th>Atlas size</th><th>Estimated GPU allocation*</th></tr>'''+''.join(rows)+'''</table></header><main>'''+''.join(cards)+'''</main><footer>
<p>Revised to match concept B: weathered cast concrete replaces brick, the wall flattens into a broad horizontal ledge before meeting the recessed small windows, folded dark steel straps reinforce the walls, and heavier concrete columns flank the entrance. The biohazard sign stays in its original wall location. Shaded steps and emissive lights are retained.</p>
<p>One mesh, material and primitive per variant. Full-mip UASTC KTX2 textures: base colour and emission in sRGB; normal and metallic/roughness in linear space.</p>
<p>These are Blender renders of the delivered GLBs, not captures from the running game. Both variants are integrated with the existing quality selector. No new scene lights were added. Blender can show local illumination from emissive surfaces; Terrace uses self-lit materials.</p>
<p>Assumption: rear details extend the selected front-right design. Assumption: Ricks is a rare top-tier inland variant (24/256 cell-hash buckets), preserving Durand’s and coastal selections. No weapon gameplay was added.</p>
<p>Current asset audits, darkness checks and structures typecheck passed. The client build passed at initial integration. Initial integration tests: 195 pass; two unchanged assertions require at most six tiers although the existing game has eleven. Workspace typecheck reports existing Buffer type errors in client tests.</p>
<p>*Calculated for BC7 or ASTC 4×4 with full mipmaps, including geometry; not measured GPU residency. Artifact publishing was unavailable; this page is the local fallback.</p></footer></html>'''
(root/'review.html').write_text(page,encoding='utf-8')
assert (root/'review.html').stat().st_size<16*1024*1024
manifest={str(p.relative_to(root)):{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(root.rglob('*')) if p.is_file() and '.review' not in p.parts and p.suffix!='.log' and p.name!='manifest.json'}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps({'review_bytes':(root/'review.html').stat().st_size,'files':len(manifest),'original_low_bounds_delta':delta,'triangles':{q:c['triangles'] for q,c in checks.items()}},indent=2))
