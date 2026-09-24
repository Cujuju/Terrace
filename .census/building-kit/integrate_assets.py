"""Verify and copy the authored KTX2 GLBs into Vite's production asset tree."""
from pathlib import Path
import hashlib, json, math, shutil, struct, subprocess, sys

ROOT = Path(__file__).resolve().parents[2]
NAMES = ['camp', 'hut', 'prehistoric-granary', 'roman-granary', 'longhouse',
         'timber-house', 'stone-cottage', 'watchtower', 'medieval-dovecote',
         'renaissance-workshop', 'industrial-pump-house', 'durands', 'ricks', 'flipper-shrimp',
         'reed-cone', 'lashed-a-frame', 'stilted-hut', 'windbreak-dome',
         'upturned-hull', 'twin-hut-yard', 'drying-rack-long-hut',
         'turf-roof-on-stone', 'net-draped-cone', 'smoke-pit-hut', 'temple']

def glb(path):
    raw = path.read_bytes()
    length = struct.unpack_from('<I', raw, 12)[0]
    return json.loads(raw[20:20+length]), raw[28+length:]

def view(doc, blob, index):
    v = doc['bufferViews'][index]
    start = v.get('byteOffset', 0)
    return blob[start:start+v['byteLength']]

reports = []
selected = sys.argv[1:]
if selected:
    assert all(name in NAMES for name in selected), selected
    reports = [r for r in json.loads((ROOT/'.census'/'building-kit'/'integration-verification.json').read_text()) if r['building'] not in selected]
radii = {}
imports = []
url_rows = {'low': [], 'original': []}
for name in NAMES:
    if selected and name not in selected: continue
    for quality, size in [('original', 2048), ('low', 1024)]:
        folder = ROOT/'.census'/name
        if quality == 'low': folder /= 'low'
        source = folder/(name+'-ktx2.glb')
        doc, blob = glb(source)
        png, png_blob = glb(folder/(name+'.glb'))
        assert len(doc['meshes']) == len(doc['materials']) == 1
        assert len(doc['meshes'][0]['primitives']) == 1
        assert doc['nodes'] == png['nodes'] and doc['meshes'] == png['meshes']
        assert doc['accessors'] == png['accessors']
        if name != 'temple':
            assert all(not any(k in node for k in ('matrix', 'translation', 'rotation', 'scale')) for node in doc['nodes'])
            position = doc['accessors'][doc['meshes'][0]['primitives'][0]['attributes']['POSITION']]
            pv = doc['bufferViews'][position['bufferView']]
            assert position['componentType'] == 5126 and position['type'] == 'VEC3'
            start = pv.get('byteOffset', 0)+position.get('byteOffset', 0)
            stride = pv.get('byteStride', 12)
            radius = max(math.hypot(*struct.unpack_from('<fff', blob, start+i*stride)[::2]) for i in range(position['count']))
            radii[name] = max(radius, radii.get(name, 0))
            symbol = name.replace('-', '_')+'_'+quality
            imports.append(f"import {symbol} from './assets/authored/{quality}/{name}.glb?url';")
            url_rows[quality].append(f"    '{name}': {symbol},")
        assert 'KHR_texture_basisu' in doc['extensionsRequired']
        assert not any(e in str(doc) for e in ('KHR_draco_mesh_compression', 'EXT_meshopt_compression'))
        for accessor in doc['accessors']:
            i = accessor['bufferView']
            assert view(doc, blob, i) == view(png, png_blob, i)
        assert len(doc['images']) == (4 if 'emissiveTexture' in doc['materials'][0] else 3)
        assert doc['materials'] == png['materials']
        for image in doc['images']:
            path = folder/(image['name']+'.ktx2')
            assert image['mimeType'] == 'image/ktx2'
            assert view(doc, blob, image['bufferView']) == path.read_bytes()
            subprocess.run([r'e:\Scoop\shims\ktx.exe', 'validate', '--gltf-basisu', '--warnings-as-errors', str(path)], check=True, capture_output=True)
            info = json.loads(subprocess.check_output([r'e:\Scoop\shims\ktx.exe', 'info', '--format', 'json', str(path)]))
            dfd = info['dataFormatDescriptor']['blocks'][0]
            assert dfd['colorModel'] == 'KHR_DF_MODEL_UASTC'
            assert dfd['transferFunction'] == ('KHR_DF_TRANSFER_SRGB' if any(k in image['name'] for k in ('basecolor','emissive')) else 'KHR_DF_TRANSFER_LINEAR')
            assert dfd['samples'][0]['channelType'] == 'KHR_DF_CHANNEL_UASTC_RGB'
            assert 'KTXswizzle' not in info['keyValueData']
            assert info['header']['pixelWidth'] == info['header']['pixelHeight'] == size
            assert info['header']['levelCount'] == int(math.log2(size))+1
        for texture in doc['textures']:
            assert 'source' not in texture
            assert 'KHR_texture_basisu' in texture['extensions']
        plugin = 'temples' if name == 'temple' else 'structures'
        dest = ROOT/'plugins'/plugin/'client'/'assets'/'authored'/quality/(name+'.glb')
        dest.parent.mkdir(parents=True, exist_ok=True)
        pending = dest.with_name('.copy-'+dest.name)
        shutil.copyfile(source, pending)
        pending.replace(dest)
        assert source.read_bytes() == dest.read_bytes()
        reports.append({'building': name, 'quality': quality, 'source': str(source.relative_to(ROOT)),
                        'runtime': str(dest.relative_to(ROOT)), 'bytes': dest.stat().st_size,
                        'sha256': hashlib.sha256(dest.read_bytes()).hexdigest(),
                        'texture_resolution': size, 'mip_levels': int(math.log2(size))+1,
                        'uastc_rgb': True, 'geometry_preserved': True})
    print('Verified and copied', name, flush=True)
(ROOT/'.census'/'building-kit'/'integration-verification.json').write_text(json.dumps(reports, indent=2)+'\n')
if selected: sys.exit(0)  # Targeted asset refresh must not overwrite another task's registry edits.
client = ROOT/'plugins'/'structures'/'client'
(client/'authoredRadii.ts').write_text('export const AUTHORED_RADII: Readonly<Record<string, number>> = '+json.dumps(radii, indent=2)+';\n')
(client/'authoredUrls.ts').write_text('\n'.join(imports)+"\n\nexport const AUTHORED_URLS = {\n"+
    '\n'.join('  '+quality+': {\n'+'\n'.join(url_rows[quality])+'\n  },' for quality in ('low', 'original'))+'\n};\n')
