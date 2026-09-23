"""Verify zero metalness through every delivered UASTC mip, offline in Blender."""
from pathlib import Path
import bpy, numpy as np, subprocess, json, sys, math
KIT=Path(__file__).parent
names=sys.argv[sys.argv.index('--')+1:]
if not names:names=[n for n in json.loads((KIT/'ratings.json').read_text()) if n!='longhouse']
for name in names:
    root=KIT.parent/name;report={}
    for label,folder,size in [('original',root,2048),('low',root/'low',1024)]:
        out=root/'.review'/('metalness-mips-'+label);out.mkdir(parents=True,exist_ok=True)
        subprocess.run([r'e:\Scoop\shims\ktx.exe','extract','--level','all','--transcode','rgba8',str(folder/(name+'-metallicRoughness.ktx2')),str(out)],check=True)
        levels=[]
        for level in range(int(math.log2(size))+1):
            im=bpy.data.images.load(str(out/('output_level'+str(level)+'.png')));im.colorspace_settings.name='Non-Color'
            values=np.array(im.pixels[:],np.float32).reshape(-1,4)
            dims=list(im.size);metal=[float(values[:,2].min()),float(values[:,2].max())]
            assert dims==[max(1,size>>level)]*2 and metal==[0.,0.],(name,label,level,dims,metal)
            levels.append({'level':level,'dimensions':dims,'metalness_range':metal})
            bpy.data.images.remove(im)
        report[label]=levels
    report['passed']=True
    (root/'mip-channel-verification.json').write_text(json.dumps(report,indent=2))
    print('MIPS VERIFIED',name,flush=True)
