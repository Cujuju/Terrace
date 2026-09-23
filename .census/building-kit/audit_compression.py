"""Decode UASTC for colour/channel verification without launching Terrace."""
from pathlib import Path
import bpy, numpy as np, json, shutil, subprocess
import sys
BUILDING=sys.argv[sys.argv.index('--id')+1]
ROOT=Path(__file__).parent.parent/BUILDING
review=ROOT/'.review'; review.mkdir(exist_ok=True)
report={}
for label,folder in [('original',ROOT),('low',ROOT/'low')]:
    report[label]={}
    for kind in ('basecolor','normal','metallicRoughness'):
        name=BUILDING+'-'+kind; decoded=review/(label+'-'+kind+'.png')
        subprocess.run([shutil.which('ktx'),'extract','--transcode','rgba8',str(folder/(name+'.ktx2')),str(decoded)],check=True)
        arrays=[]
        for path in (folder/(name+'.png'),decoded):
            im=bpy.data.images.load(str(path)); im.colorspace_settings.name='Non-Color'
            arrays.append(np.array(im.pixels[:],np.float32).reshape(-1,4)[:,:3]); bpy.data.images.remove(im)
        source,target=arrays; error=target-source
        metrics={'mean_absolute_error_8bit':float(abs(error).mean()*255),'root_mean_square_error_8bit':float(np.sqrt((error**2).mean())*255)}
        if kind=='metallicRoughness':
            metrics['metalness_range']=[float(target[:,2].min()),float(target[:,2].max())]
            if metrics['metalness_range']!=[0.,0.]: raise RuntimeError('Compression introduced metalness')
        if kind=='normal':
            src=source*2-1; dst=target*2-1
            src/=np.linalg.norm(src,axis=1)[:,None]; dst/=np.linalg.norm(dst,axis=1)[:,None]
            metrics['mean_normal_angle_degrees']=float(np.degrees(np.arccos(np.clip(np.sum(src*dst,axis=1),-1,1))).mean())
        report[label][kind]=metrics
(ROOT/'compression-verification.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2),flush=True)
