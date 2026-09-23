"""Hash completed deliverables and list exact paths for a scoped git commit."""
from pathlib import Path
import hashlib,json
KIT=Path(__file__).parent.resolve();CENSUS=KIT.parent
names=[n for n in json.loads((KIT/'ratings.json').read_text()) if n!='longhouse']
paths=[]
for name in names:
    root=CENSUS/name
    assert json.loads((root/'delivery-verification.json').read_text())['passed']
    assert json.loads((root/'mip-channel-verification.json').read_text())['passed']
    paths.extend(root/f for f in ['README.txt','rebuild.py','concept-prompt.txt',name+'-concept.png','comparison.png','alignment-verification.json','memory-report.json','compression-verification.json','delivery-verification.json','mip-channel-verification.json'])
    for folder in (root,root/'low'):
        files=[name+'.blend',name+'.glb',name+'-ktx2.glb',name+'-45deg.png',name+'-closeup.png','build-report.json','parts.json','verification.json']
        files += [name+'-'+kind+'.'+extension for kind in ('basecolor','normal','metallicRoughness') for extension in ('png','ktx2')]
        if json.loads((folder/'build-report.json').read_text()).get('emissive'):
            files += [name+'-emissive.png',name+'-emissive.ktx2']
        paths.extend(folder/f for f in files)
kit_names=['README.md','asset_helpers.py','audit_asset.py','audit_compression.py','audit_mips.py','build_asset.py','designs.py','contact_sheets.ps1','overview.ps1','inventory.mjs','source-inventory.json','imported-cottage-bounds.json','package_runtime.py','prepare_pipeline.py','ratings.json','render_asset.py','run_delivery.py','verify_delivery.py','write_catalog.py','write_reports.py','write_manifest.py','delivery-summary.json','core-buildings.png','coastal-overview.png','historical-additions.png']
paths.extend(KIT/name for name in kit_names)
paths.extend(KIT/name for name in ['crimson_cabaret.py','prepare_cabaret_paint.ps1','cabaret-paint/front.png','cabaret-paint/side.png','cabaret-paint/awning.png'])
paths.extend(KIT/'cabaret-paint'/name for name in ['front-reference.png','front-reference-prompt.txt','flag.png','wing-left.png','wing-right.png','door-left.png','door-right.png'])
paths.extend([CENSUS/'durands'/'durands-front.png',CENSUS/'durands'/'low'/'durands-front.png',CENSUS/'durands'/'design-notes.md'])
paths.extend([KIT/'render_cabaret_night.py',CENSUS/'durands'/'durands-night.png',CENSUS/'durands'/'low'/'durands-night.png'])
assert len(set(paths))==len(paths)
entries={}
for path in sorted(paths):
    data=path.read_bytes();assert data,path
    entries[path.as_posix()]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
manifest=KIT/'manifest.json'
manifest.write_text(json.dumps({'building_packages':len(names),'variants':len(names)*2,'hash_scope':'Raw bytes in the delivered Windows workspace. Git may normalize text line endings on checkout; binary asset hashes remain unchanged.','file_count':len(entries),'total_bytes':sum(v['bytes'] for v in entries.values()),'files':entries},indent=2),encoding='utf8')
paths.append(manifest)
# A NUL-delimited explicit file list; this script does not stage or commit.
(KIT/'commit-paths.txt').write_bytes(b'\0'.join(p.as_posix().encode('utf8') for p in sorted(paths))+b'\0')
print(len(paths),'exact completed files;',round(sum(v['bytes'] for v in entries.values())/1048576,2),'MiB')
