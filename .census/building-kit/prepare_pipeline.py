"""Derive a reusable authoring pipeline from the completed in-repo longhouse."""
from pathlib import Path
import shutil
ROOT=Path(__file__).parent
REF=ROOT.parent/'longhouse'
source=(REF/'build_longhouse.py').read_text()
header=source[:source.index('bpy.ops.wm.read_factory_settings(use_empty=True)')]
header=header.replace("SOURCE_ROOT = pathlib.Path(__file__).parent", "KIT = pathlib.Path(__file__).parent\nBUILDING = sys.argv[sys.argv.index('--id')+1]\nSOURCE_ROOT = KIT.parent / BUILDING")
header=header.replace("sys.path.insert(0, str(SOURCE_ROOT))", "sys.path.insert(0, str(KIT))")
header=header.replace("'carving': (0.32, 0.265, 0.20),", "'carving': (0.32, 0.265, 0.20),\n    'thatch': (.60,.51,.33), 'plaster': (.66,.60,.47), 'turf': (.34,.42,.26), 'brick': (.53,.32,.24), 'canvas': (.65,.58,.44), 'fish': (.50,.55,.54), 'paint': (.40,.24,.19), 'slate': (.32,.37,.37),")
header=header.replace("'stone': (0.43, 0.445, 0.42),", "'stone': (0.43, 0.445, 0.42), 'cutstone': (.51,.515,.48),")
body=source[source.index("mesh=bpy.data.meshes.new('Longhouse')"):]
body=body.replace("bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));", "bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces)) if BUILDING in NEW+['temple','timber-house'] else bm.normal_update();" )
body=body.replace("'Longhouse'","BUILDING").replace("'Longhouse_PBR'","BUILDING+'_PBR'")
body=body.replace("'longhouse-basecolor.png'","BUILDING+'-basecolor.png'").replace("'longhouse-normal.png'","BUILDING+'-normal.png'").replace("'longhouse-metallicRoughness.png'","BUILDING+'-metallicRoughness.png'")
body=body.replace("'longhouse.blend'","BUILDING+'.blend'").replace("'longhouse.glb'","BUILDING+'.glb'")
body=body.replace("obj['provenance']='Original geometry generated from build_longhouse.py; no imported meshes or stock textures.'", "obj['provenance']=provenance")
body=body.replace("obj['concept']='longhouse-concept.png; built-in image generator, model version unverified.'", "obj['concept']=BUILDING+'-concept.png; built-in image generator, model version unverified.'")
body=body.replace("geometry_source='Original procedural mesh, no imported assets'","geometry_source=provenance")
body=body.replace("elif kind=='stone':", "elif kind in ('stone','brick'):")
body=body.replace("tile=y/.54", "tile=crossgrain/.54").replace("lip=np.exp(-((a-.97)/.12)**2)","lip=wear")
body=body.replace("        a=y if abs(ch['n'][0])>.5 else x", "        if BUILDING=='temple': x,y,z=x/2.7,y/2.7,z/2.7\n        a=y if abs(ch['n'][0])>.5 else x")
body=body.replace("    else:\n        mult=np.ones(len(pos))", "    elif kind in ('thatch','canvas','plaster','turf','paint','slate'):\n        lines=np.sin(crossgrain*65+.35*np.sin(along*7))\n        fiber=.035 if kind in ('thatch','canvas') else .013\n        mult=1+fiber*lines+.02*broad+.055*wear\n        height=(.002 if kind=='thatch' else .0006)*lines\n        rough=np.full(len(pos),.94)\n    else:\n        mult=np.ones(len(pos))")
body=body.replace("kind in ('thatch','canvas','plaster','turf','paint','slate')", "kind in ('thatch','canvas','plaster','turf','paint','slate','cutstone')")
body=body.replace("crossgrain*65", "crossgrain*35").replace("fiber=.035", "fiber=.025")
body=body.replace("height=(.002 if kind=='thatch' else .0006)*lines", "height=(.001 if kind=='thatch' else .0003)*lines\n        if kind in ('plaster','cutstone'):\n            mult=1+.018*broad+.035*wear+.02*math.sin(ch['face']*3.73)\n            height=.0003*broad")
body=body.replace("mesh.update()\nroot=bpy.data.objects", "mesh.update()\nbpy.context.view_layer.update()\nroot=bpy.data.objects")
body=body.replace("bpy.ops.wm.save_as_mainfile", "bpy.context.preferences.filepaths.save_version=0\nbpy.ops.wm.save_as_mainfile")
body=body.replace("bm.to_mesh(mesh); bm.free(); mesh.update()\nbpy.ops.export_scene.gltf", "bmesh.ops.delete(bm,geom=[f for f in bm.faces if f.calc_area()<1e-9],context='FACES')\nbm.to_mesh(mesh); bm.free(); mesh.update()\nif BUILDING=='durands': bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/(BUILDING+'.blend')))\nbpy.ops.export_scene.gltf")
body=body.replace("(ROOT/'build-report.json').write_text", "report['placement']=placement\n(ROOT/'build-report.json').write_text")
injection="""
bpy.ops.wm.read_factory_settings(use_empty=True)
from designs import build, NEW
provenance, placement = build(BUILDING, LOW_DETAIL, globals())
if LOW_DETAIL and (SOURCE_ROOT/'verification.json').exists():
    bounds=json.loads((SOURCE_ROOT/'verification.json').read_text())['bounds_gltf_y_up']
    lo,hi=bounds['min'],bounds['max']
    targetlo=np.array([lo[0],-hi[2],lo[1]])/MODEL_SCALE
    targethi=np.array([hi[0],-lo[2],hi[1]])/MODEL_SCALE
    vv=np.array(vertices);vv=(vv-vv.min(axis=0))/np.ptp(vv,axis=0)*(targethi-targetlo)+targetlo
    vertices[:]=vv.tolist()
    placement['low_alignment']='Low vertices fitted to original bounds before UV packing; shared origin and envelope.'
"""
body=body.replace("ROOT/BUILDING+'.blend'", "ROOT/(BUILDING+'.blend')").replace("ROOT/BUILDING+'.glb'", "ROOT/(BUILDING+'.glb')")
(ROOT/'build_asset.py').write_text(header+injection+body)
shutil.copyfile(REF/'asset_helpers.py',ROOT/'asset_helpers.py')
audit=(REF/'audit_longhouse.py').read_text().replace("ROOT=pathlib.Path(__file__).parent", "BUILDING=sys.argv[sys.argv.index('--id')+1]\nROOT=pathlib.Path(__file__).parent.parent/BUILDING")
audit=audit.replace("'longhouse.glb'","BUILDING+'.glb'").replace("'longhouse.blend'","BUILDING+'.blend'").replace("'Longhouse'","BUILDING")
audit=audit.replace("'longhouse-metallicRoughness'","BUILDING+'-metallicRoughness'").replace("'longhouse-normal'","BUILDING+'-normal'")
audit=audit.replace("report['passed']=", "report['bounds_gltf_y_up']={'min':pos.min(axis=0).tolist(),'max':pos.max(axis=0).tolist()}\nreport['passed']=")
audit=audit.replace("not pairs and gap>=8", "not pairs and gap>=8 and uv.min()>=0 and uv.max()<=1 and len(doc['images'])==3 and all(t['matches_external_bytes'] for t in report['textures'].values()) and report['blend']['images_packed']")
audit=audit.replace("ROOT/BUILDING+'.blend'", "ROOT/(BUILDING+'.blend')").replace("ROOT/BUILDING+'.glb'", "ROOT/(BUILDING+'.glb')")
(ROOT/'audit_asset.py').write_text(audit)
package=(REF/'package_runtime.py').read_text()
package=package.replace("ROOT=Path(__file__).parent", "import sys\nBUILDING=sys.argv[sys.argv.index('--id')+1]\nROOT=Path(__file__).parent.parent/BUILDING")
package=package.replace("'longhouse.glb'","BUILDING+'.glb'").replace("'longhouse-ktx2.glb'","BUILDING+'-ktx2.glb'")
package=package.replace("folder/BUILDING+'.glb'", "folder/(BUILDING+'.glb')").replace("folder/BUILDING+'-ktx2.glb'", "folder/(BUILDING+'-ktx2.glb')")
(ROOT/'package_runtime.py').write_text(package)
audit=(REF/'audit_compression.py').read_text().replace("ROOT=Path(__file__).parent", "import sys\nBUILDING=sys.argv[sys.argv.index('--id')+1]\nROOT=Path(__file__).parent.parent/BUILDING")
audit=audit.replace("name='longhouse-'+kind", "name=BUILDING+'-'+kind")
audit=audit.replace("metrics['mean_normal_angle_degrees']", "metrics['mean_normal_angle_degrees']")
(ROOT/'audit_compression.py').write_text(audit)
for name in ('asset_helpers.py','build_asset.py','audit_asset.py','package_runtime.py','audit_compression.py'):
    path=ROOT/name;path.write_text(path.read_text().rstrip()+'\n')
print('Prepared reusable pipeline')
