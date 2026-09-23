"""Create separate KTX2 runtime copies; preserve both PNG source GLBs byte-for-byte."""
from pathlib import Path
import copy, hashlib, json, math, shutil, struct, subprocess
import sys
BUILDING=sys.argv[sys.argv.index('--id')+1]
ROOT=Path(__file__).parent.parent/BUILDING
TOKTX=shutil.which('toktx'); KTX=shutil.which('ktx')
if not TOKTX or not KTX: raise RuntimeError('Installed KTX-Software tools are required')
def read_glb(path):
    raw=path.read_bytes(); length=struct.unpack_from('<I',raw,12)[0]
    return json.loads(raw[20:20+length]),raw[28+length:],raw

def write_glb(path,doc,blob):
    doc['buffers']=[{'byteLength':len(blob)}]
    js=json.dumps(doc,separators=(',',':')).encode(); js+=b' '*((-len(js))%4)
    blob+=b'\0'*((-len(blob))%4)
    pending=path.with_name('.package-'+path.name)
    pending.write_bytes(struct.pack('<III',0x46546c67,2,28+len(js)+len(blob))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(blob),0x004e4942)+blob)
    pending.replace(path)

report={'assumptions':{'png_gpu_format':'RGBA8 with complete mip chain','compressed_gpu_format':'BC7 or ASTC 4x4, 16 bytes per 4x4 block, complete mip chain','excluded':'CPU decoded images, loader buffers, driver allocation overhead, shaders, framebuffer and instance buffers','sharing':'Terrace draws repeated structures with InstancedMesh; mesh and textures are shared, not duplicated per house.'},'variants':{}}
for label,folder in [('original',ROOT),('low',ROOT/'low')]:
    doc,blob,source=read_glb(folder/(BUILDING+'.glb')); source_hash=hashlib.sha256(source).hexdigest()
    out=copy.deepcopy(doc); replacements={}; texture_info=[]
    for im in doc['images']:
        name=im['name']; png=folder/(name+'.png'); ktx=folder/(name+'.ktx2')
        srgb='basecolor' in name
        cmd=[TOKTX,'--t2','--encode','uastc','--uastc_quality','2','--zcmp','9','--genmipmap','--assign_oetf','srgb' if srgb else 'linear','--assign_primaries','bt709' if srgb else 'none','--upper_left_maps_to_s0t0','--threads','4']
        if 'normal' in name: cmd+=['--normalize']
        print('ENCODE',label,name,flush=True)
        pending_ktx=ktx.with_name('.encode-'+ktx.name)
        subprocess.run(cmd+[str(pending_ktx),str(png)],check=True)
        subprocess.run([KTX,'validate','--gltf-basisu','--warnings-as-errors',str(pending_ktx)],check=True)
        pending_ktx.replace(ktx)
        raw=ktx.read_bytes(); width,height=struct.unpack_from('<II',raw,20); levels=struct.unpack_from('<I',raw,40)[0]
        if levels!=int(math.log2(max(width,height)))+1: raise RuntimeError('Incomplete mip chain')
        replacements[im['bufferView']]=raw
        rgba=sum(max(1,width>>i)*max(1,height>>i)*4 for i in range(levels))
        bc=sum(math.ceil(max(1,width>>i)/4)*math.ceil(max(1,height>>i)/4)*16 for i in range(levels))
        texture_info.append(dict(name=name,width=width,height=height,mip_levels=levels,png_rgba8_gpu_bytes=rgba,bc7_astc_gpu_bytes=bc,ktx_file_bytes=len(raw)))
    newblob=bytearray()
    for i,view in enumerate(out['bufferViews']):
        old=doc['bufferViews'][i]; offset=old.get('byteOffset',0)
        payload=replacements.get(i,blob[offset:offset+old['byteLength']])
        newblob.extend(b'\0'*((-len(newblob))%8)); view['byteOffset']=len(newblob); view['byteLength']=len(payload); newblob.extend(payload)
    for im in out['images']: im['mimeType']='image/ktx2'
    for texture in out['textures']:
        index=texture.pop('source'); texture.setdefault('extensions',{})['KHR_texture_basisu']={'source':index}
    for key in ['extensionsUsed','extensionsRequired']:
        out[key]=list(dict.fromkeys(out.get(key,[])+['KHR_texture_basisu']))
    target=folder/(BUILDING+'-ktx2.glb'); write_glb(target,out,newblob)
    # Verify exact geometry accessor bytes and embedded KTX2 bytes after packing.
    rd,rb,rr=read_glb(target)
    for i,a in enumerate(doc['accessors']):
        oi=a['bufferView']; ov=doc['bufferViews'][oi]; nv=rd['bufferViews'][oi]
        if blob[ov.get('byteOffset',0):ov.get('byteOffset',0)+ov['byteLength']]!=rb[nv['byteOffset']:nv['byteOffset']+nv['byteLength']]: raise RuntimeError('Geometry changed while packing')
    for im in rd['images']:
        v=rd['bufferViews'][im['bufferView']]
        if rb[v['byteOffset']:v['byteOffset']+v['byteLength']]!=(folder/(im['name']+'.ktx2')).read_bytes(): raise RuntimeError('Texture embedding mismatch')
    if hashlib.sha256((folder/(BUILDING+'.glb')).read_bytes()).hexdigest()!=source_hash: raise RuntimeError('Source was modified')
    primitive=doc['meshes'][0]['primitives'][0]
    accessors=list(primitive['attributes'].values())+[primitive['indices']]
    views={doc['accessors'][i]['bufferView'] for i in accessors}; geometry=sum(doc['bufferViews'][i]['byteLength'] for i in views)
    verification=json.loads((folder/'verification.json').read_text())
    report['variants'][label]=dict(triangles=verification['triangles'],exported_vertices=verification['exported_vertices'],geometry_gpu_bytes=geometry,textures=texture_info,png_gpu_total_bytes=geometry+sum(t['png_rgba8_gpu_bytes'] for t in texture_info),ktx2_bc7_astc_gpu_total_bytes=geometry+sum(t['bc7_astc_gpu_bytes'] for t in texture_info),png_glb_file_bytes=len(source),ktx2_glb_file_bytes=len(rr),png_glb_sha256=source_hash,ktx2_glb_sha256=hashlib.sha256(rr).hexdigest(),geometry_unchanged=True,ktx_validation_passed=True)
(ROOT/'memory-report.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2),flush=True)
