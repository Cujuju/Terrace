import bpy, pathlib, numpy as np, json, struct, hashlib
ROOT=pathlib.Path(__file__).parent
SRC=ROOT.parents[1]/'plugins/structures/client/assets/timber-house.glb'
def read(path):
 b=path.read_bytes(); n=struct.unpack_from('<I',b,12)[0]; return json.loads(b[20:20+n]),b[28+n:]
s,sb=read(SRC); d,db=read(ROOT/'timber-house.glb')
def raw(j,b,i):
 a=j['accessors'][i]; v=j['bufferViews'][a['bufferView']]; return b[v['byteOffset']:v['byteOffset']+v['byteLength']]
report=json.loads((ROOT/'verification.json').read_text())
report['geometry_byte_comparison']={k:raw(s,sb,i)==raw(d,db,i) for k,i in [('POSITION',0),('NORMAL',1),('INDICES',3)]}
report['nodes_identical']=s['nodes']==d['nodes']; report['scenes_identical']=s['scenes']==d['scenes']
data=np.load(ROOT/'atlas-data.npz'); uv=data['uv'].astype(float)*1024; tris=data['triangles']; p=data['positions']; q=uv[tris]
def cross(a,b): return a[...,0]*b[...,1]-a[...,1]*b[...,0]
def intersection(subject,clip):
 poly=list(subject)
 if cross(clip[1]-clip[0],clip[2]-clip[0])<0: clip=clip[::-1]
 for a,b in zip(clip,np.roll(clip,-1,axis=0)):
  result=[]
  for s,e in zip(poly,poly[1:]+poly[:1]):
   ds=cross(b-a,s-a); de=cross(b-a,e-a)
   if (ds>=0)!=(de>=0): result.append(s+(e-s)*(ds/(ds-de)))
   if de>=0: result.append(e)
  poly=result
  if not poly: return 0.
 v=np.array(poly); return abs(np.sum(cross(v,np.roll(v,-1,axis=0))))/2
lo=q.min(axis=1); hi=q.max(axis=1); overlaps=[]; candidates=0
for i in range(len(tris)):
 js=np.where(np.all(hi[i]>lo[i+1:],axis=1)&np.all(hi[i+1:]>lo[i],axis=1))[0]+i+1
 for k in js:
  candidates+=1; area=intersection(q[i],q[k])
  if area>1e-5: overlaps.append([i,int(k),float(area)])
area3=np.linalg.norm(np.cross(p[tris[:,1]]-p[tris[:,0]],p[tris[:,2]]-p[tris[:,0]]),axis=1)/2
area2=abs(cross(q[:,1]-q[:,0],q[:,2]-q[:,0]))/2
density=np.sqrt(area2/area3)
report['uv_min_max']=[float(uv.min()/1024),float(uv.max()/1024)]; report['overlapping_triangle_pairs']=overlaps; report['overlap_candidate_pairs_checked']=candidates; report['density_min_max']=[float(density.min()),float(density.max())]
ids=data['chart_ids']; bounds=[]
for c in np.unique(ids): bounds.append([uv[ids==c].min(axis=0),uv[ids==c].max(axis=0)])
bounds=np.array(bounds); mingap=1e9
for i in range(len(bounds)-1):
 delta=np.maximum(0,np.maximum(bounds[i,0]-bounds[i+1:,1],bounds[i+1:,0]-bounds[i,1])); mingap=min(mingap,float(np.linalg.norm(delta,axis=1).min()))
report['measured_min_island_aabb_gap_pixels']=mingap
report['embedded_pngs']={}
for im in d['images']:
 v=d['bufferViews'][im['bufferView']]; png=db[v['byteOffset']:v['byteOffset']+v['byteLength']]; report['embedded_pngs'][im['name']]={'signature':png[:8]==b'\x89PNG\r\n\x1a\n','size':list(struct.unpack_from('>II',png,16)),'matches_external':png==(ROOT/(im['name']+'.png')).read_bytes()}
mr=bpy.data.images.load(str(ROOT/'timber-house-metallicRoughness.png')); values=np.array(mr.pixels[:]).reshape(-1,4); report['metalness_blue_min_max']=[float(values[:,2].min()),float(values[:,2].max())]
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'timber-house.blend'))
mesh=bpy.data.objects['Cottage']; report['blend']={'meshes':len(bpy.data.meshes),'materials':len(bpy.data.materials),'vertices':len(mesh.data.vertices),'polygons':len(mesh.data.polygons),'objects':[(o.name,o.type,o.parent.name if o.parent else None) for o in bpy.data.objects],'images_packed':all(i.packed_file is not None for i in bpy.data.images if i.type=='IMAGE')}
mesh.data.calc_tangents(); tangent=np.frombuffer(raw(d,db,4),dtype='<f4').reshape(-1,4); deviations=[]
for loop in mesh.data.loops:
 t=np.array(loop.tangent); converted=np.array([t[0],t[2],-t[1]]); expected=tangent[loop.vertex_index]; deviations.append(float(np.linalg.norm(converted-expected[:3])))
report['blender_tangent_max_deviation']=max(deviations); report['blender_bitangent_signs']=sorted(set(float(l.bitangent_sign) for l in mesh.data.loops))
report['source_unchanged']=hashlib.sha256(SRC.read_bytes()).hexdigest()==report['source_sha256']
report['compression_extensions']=d.get('extensionsUsed',[])
(ROOT/'verification.json').write_text(json.dumps(report,indent=2)); print(json.dumps(report,indent=2),flush=True)
