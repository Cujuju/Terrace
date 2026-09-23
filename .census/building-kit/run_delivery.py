"""Sequential offline build, export, audit, package, render; no game process."""
from pathlib import Path
import subprocess,sys,json,time
KIT=Path(__file__).parent
BLENDER=r'E:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
original_only='--original-only' in sys.argv
low_only='--low-only' in sys.argv
ids=[arg for arg in sys.argv[1:] if arg not in ('--original-only','--low-only')]
for name in ids:
    if name=='durands':
        subprocess.run(['powershell','-NoProfile','-File',str(KIT/'prepare_cabaret_paint.ps1')],check=True)
    root=KIT.parent/name;root.mkdir(exist_ok=True)
    started=time.time()
    for low in ((False,) if original_only else (True,) if low_only else (False,True)):
        folder=root/'low' if low else root;folder.mkdir(exist_ok=True)
        for script,log in [('build_asset.py','build.log'),('audit_asset.py','audit.log'),('render_asset.py','render.log')]:
            command=[BLENDER,'--background','--factory-startup','--threads','8','--python-exit-code','1','--python',str(KIT/script),'--','--id',name]+(['--low'] if low else [])
            print(name,'low' if low else 'original',script,flush=True)
            with (folder/log).open('w') as f:subprocess.run(command,stdout=f,stderr=subprocess.STDOUT,check=True)
    with (root/'package.log').open('w') as f:
        subprocess.run([sys.executable,str(KIT/'package_runtime.py'),'--id',name],stdout=f,stderr=subprocess.STDOUT,check=True)
    with (root/'compression.log').open('w') as f:
        subprocess.run([BLENDER,'--background','--factory-startup','--threads','8','--python-exit-code','1','--python',str(KIT/'audit_compression.py'),'--','--id',name],stdout=f,stderr=subprocess.STDOUT,check=True)
    with (root/'mips.log').open('w') as f:
        subprocess.run([BLENDER,'--background','--factory-startup','--threads','8','--python-exit-code','1','--python',str(KIT/'audit_mips.py'),'--',name],stdout=f,stderr=subprocess.STDOUT,check=True)
    print('DELIVERED',name,round(time.time()-started,1),'seconds',flush=True)
