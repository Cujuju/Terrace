import bpy, numpy as np, pathlib, json, struct, zlib, hashlib, math, sys
from collections import defaultdict
ROOT=pathlib.Path(__file__).parent
SRC=ROOT.parents[1]/'plugins/structures/client/assets/timber-house.glb'
SIZE=1024
GUTTER=12
MARGIN=GUTTER/2
b=SRC.read_bytes(); jlen=struct.unpack_from('<I',b,12)[0]; source=json.loads(b[20:20+jlen]); blob=b[28+jlen:]
j=json.loads(json.dumps(source))
def acc(i):
 a=j['accessors'][i]; v=j['bufferViews'][a['bufferView']]; return np.frombuffer(blob,dtype={5126:'<f4',5123:'<u2'}[a['componentType']],count=a['count']*{'VEC3':3,'VEC2':2,'SCALAR':1}[a['type']],offset=v.get('byteOffset',0)+a.get('byteOffset',0)).reshape(a['count'],-1).copy()
p=acc(0).astype(float); normals=acc(1).astype(float); olduv=acc(2); tris=acc(3).reshape(-1,3)
parent=list(range(len(p)))
def find(x):
 while parent[x]!=x: parent[x]=parent[parent[x]]; x=parent[x]
 return x
for t in tris:
 for x in t[1:]: parent[find(int(x))]=find(int(t[0]))
groups=defaultdict(list)
for i in range(len(p)): groups[find(i)].append(i)
facegroups=defaultdict(list)
for f,t in enumerate(tris): facegroups[find(int(t[0]))].append(f)
charts=[]
for root,ids in groups.items():
 q=p[ids]; faces=facegroups[root]; tt=tris[faces]; crosses=np.cross(p[tt[:,1]]-p[tt[:,0]],p[tt[:,2]]-p[tt[:,0]])
 n=crosses.sum(axis=0); n/=np.linalg.norm(n)
 best=None
 for f in tt:
  for a,c in zip(f,np.roll(f,-1)):
   t=p[c]-p[a]; t-=n*np.dot(t,n)
   if np.linalg.norm(t)<1e-10: continue
   t/=np.linalg.norm(t); v=np.cross(n,t); xy=np.column_stack((q@t,q@v)); dim=np.ptp(xy,axis=0)
   if best is None or np.prod(dim)<best[0]: best=(np.prod(dim),t,v,xy,dim)
 _,t,v,xy,dim=best
 if dim[1]>dim[0]: t,v=v,-t; xy=np.column_stack((q@t,q@v)); dim=np.ptp(xy,axis=0)
 charts.append(dict(ids=ids,faces=faces,n=n,t=t,v=v,lo=xy.min(axis=0),dim=dim,xy=xy))
print('Charts',len(charts),flush=True)
def pack(scale):
 skyline=np.zeros(SIZE,dtype=int); placed={}
 order=sorted(range(len(charts)),key=lambda i:-(np.prod(charts[i]['dim']*scale+GUTTER)))
 for i in order:
  wh=np.ceil(charts[i]['dim']*scale).astype(int)+GUTTER
  best=None
  for rotated in [False,True]:
   w,h=wh[::-1] if rotated else wh
   if max(w,h)>SIZE: continue
   heights=np.lib.stride_tricks.sliding_window_view(skyline,int(w)).max(axis=1)
   x=int(np.argmin(heights)); y=int(heights[x])
   score=y+h
   if score<=SIZE and (best is None or score<best[0]): best=(score,x,y,int(w),int(h),rotated)
  if best is None: return None
  _,x,y,w,h,rotated=best; skyline[x:x+w]=y+h; placed[i]=(x,y,w,h,rotated)
 return placed
low,high=10.,600.
for _ in range(12):
 mid=(low+high)/2; result=pack(mid)
 if result is None: high=mid
 else: low=mid; placements=result
scale=low
print('Density',scale,'px/unit',flush=True)
newuv=np.zeros_like(olduv); tangent=np.zeros((len(p),4),np.float32)
for i,ch in enumerate(charts):
 x,y,w,h,rot=placements[i]
 if rot:
  ch['t'],ch['v']=ch['v'], -ch['t']; ch['xy']=np.column_stack((p[ch['ids']]@ch['t'],p[ch['ids']]@ch['v'])); ch['lo']=ch['xy'].min(axis=0); ch['dim']=np.ptp(ch['xy'],axis=0)
 ch['offset']=np.array([x+MARGIN,y+MARGIN]); xy=(ch['xy']-ch['lo'])*scale+ch['offset']; newuv[ch['ids']]=xy/SIZE
 # OpenGL bitangent points toward decreasing image-row coordinate.
 for vertex in ch['ids']:
  t=ch['t']-normals[vertex]*np.dot(ch['t'],normals[vertex]); t/=np.linalg.norm(t); tangent[vertex]=[*t,-1]
# Read the actual embedded source palette, including its sRGB values.
v=source['bufferViews'][source['images'][0]['bufferView']]
palette_path=ROOT/'source-palette.jpg'; palette_path.write_bytes(blob[v['byteOffset']:v['byteOffset']+v['byteLength']])
im=bpy.data.images.load(str(palette_path)); pal=np.array(im.pixels[:]).reshape(im.size[1],im.size[0],4)[::-1,:,:3]
base=np.zeros((SIZE,SIZE,3),float); base[:]=[.36,.29,.24]
normal=np.zeros_like(base); normal[:]=[.5,.5,1]
mr=np.zeros_like(base); mr[:]=[1,.85,0]
owner=np.full((SIZE,SIZE),-1,np.int32); coverage=np.zeros((SIZE,SIZE),bool)
# Deterministic low-frequency surface marks; no baked directional lighting.
def surface(pos, color, ch):
 x,y,z=pos.T; uvlocal=np.column_stack((pos@ch['t'],pos@ch['v']))-ch['lo']; dims=ch['dim']; long=int(np.argmax(dims)); a=uvlocal[:,long]; c=uvlocal[:,1-long]
 edge=np.maximum(0,np.minimum.reduce([uvlocal[:,0],dims[0]-uvlocal[:,0],uvlocal[:,1],dims[1]-uvlocal[:,1]]))
 grainphase=c*550+1.2*np.sin(a*27+c*45)+.3*np.sin(a*71)
 grain=np.sin(grainphase)+.35*np.sin(grainphase*2.1)
 broad=np.sin(x*67+np.sin(z*34))*np.sin(y*73+z*26)
 wear=np.exp(-edge/.004)*(.65+.35*np.sin(a*183+c*72)**2)
 kind='roof' if color[0]-color[1]>.16 else ('plaster' if color[0]>.55 else ('stone' if max(color)-min(color)<.05 else 'wood'))
 if kind=='roof':
  course=(.5381-y)/.032; row=np.floor(course); f=course-row
  tile=z/.065+(row%2)*.5; joint=np.abs((tile+.5)%1-.5)
  seam=np.exp(-(f/.045)**2); rim=np.exp(-((f-.91)/.05)**2)
  vertical=np.exp(-(joint/.027)**2)
  variation=np.sin(np.floor(tile)*12.9898+row*78.233)*.028
  mult=1+variation-.15*seam-.065*vertical+.07*rim+.015*broad
  height=.0009*f-.00035*vertical+.00008*broad
  rough=.83+.03*broad+.035*seam
 elif kind=='wood':
  knotphase=np.sqrt(((a-dims[long]*.38)*100)**2+((c-dims[1-long]*.48)*480)**2)
  knot=np.exp(-(((a-dims[long]*.38)/.035)**2+((c-dims[1-long]*.48)/.008)**2))
  marks=.10*grain+.025*np.sin(a*19+c*210)-.10*knot*(.5+.5*np.sin(knotphase))
  mult=1+marks+.13*wear
  height=.00025*grain-.00012*knot*np.sin(knotphase)-.00018*wear
  rough=.88-.07*wear+.025*grain
 elif kind=='plaster':
  mult=1+.014*broad+.009*np.sin(x*173+z*117)*np.sin(y*146)-.025*np.exp(-edge/.005)
  height=.000035*broad
  rough=.94+.015*broad
 else:
  joint=np.exp(-(((y/.035)%1)/.05)**2)
  mult=1+.025*broad-.075*joint+.06*wear; height=.00008*broad-.00025*joint; rough=.93+.02*broad
 return np.clip(color[None,:]*mult[:,None],0,1),height,np.clip(rough,.6,1)
# Each chart's padded rectangle is evaluated outside the island too, providing gutters for mipmaps.
for ci,ch in enumerate(charts):
 x,y,w,h,_=placements[ci]
 yy,xx=np.mgrid[y:y+h,x:x+w]; xy=np.column_stack((xx.ravel()+.5,yy.ravel()+.5)); uvplane=(xy-ch['offset'])/scale+ch['lo']
 planeoff=float(np.mean(p[ch['ids']]@ch['n'])); pos=uvplane[:,0,None]*ch['t']+uvplane[:,1,None]*ch['v']+planeoff*ch['n']
 # All faces in a source connected component use the same palette region.
 old=olduv[ch['ids']].mean(axis=0); color=pal[min(255,int(old[1]*256)),min(255,int(old[0]*256))]
 rgb,height,rough=surface(pos,color,ch)
 step=.5/scale
 _,hx1,_=surface(pos+ch['t']*step,color,ch); _,hx0,_=surface(pos-ch['t']*step,color,ch)
 _,hy1,_=surface(pos+ch['v']*step,color,ch); _,hy0,_=surface(pos-ch['v']*step,color,ch)
 nn=np.column_stack((-(hx1-hx0)/(2*step),(hy1-hy0)/(2*step),np.ones(len(pos)))); nn/=np.linalg.norm(nn,axis=1)[:,None]
 base[y:y+h,x:x+w]=rgb.reshape(h,w,3); normal[y:y+h,x:x+w]=(nn*.5+.5).reshape(h,w,3); mr[y:y+h,x:x+w,1]=rough.reshape(h,w)
 owner[y:y+h,x:x+w]=ci
 for fi in ch['faces']:
  q=newuv[tris[fi]].astype(float)*SIZE; lo=np.maximum(0,np.floor(q.min(axis=0)).astype(int)); hi=np.minimum(SIZE,np.ceil(q.max(axis=0)).astype(int))
  gy,gx=np.mgrid[lo[1]:hi[1],lo[0]:hi[0]]; v0=q[1]-q[0]; v1=q[2]-q[0]; d=np.stack((gx+.5-q[0,0],gy+.5-q[0,1]),axis=-1)
  det=v0[0]*v1[1]-v0[1]*v1[0]; u=(d[...,0]*v1[1]-d[...,1]*v1[0])/det; v=(v0[0]*d[...,1]-v0[1]*d[...,0])/det
  mask=(u>=0)&(v>=0)&(u+v<=1); coverage[lo[1]:hi[1],lo[0]:hi[0]]|=mask
  if len(ch['faces'])>2 and color[0]<.55 and max(color)-min(color)>.05:
   vertex=p[tris[fi]]; edges=np.roll(vertex,-1,axis=0)-vertex; lengths=np.linalg.norm(edges,axis=1)
   # The second-longest edge is the long rectangle side, excluding its triangulation diagonal.
   gt=edges[np.argsort(lengths)[-2]].copy(); gt-=ch['n']*np.dot(gt,ch['n']); gt/=np.linalg.norm(gt); gv=np.cross(ch['n'],gt)
   gxy=np.column_stack((vertex@gt,vertex@gv)); grainchart=dict(ch,t=gt,v=gv,lo=gxy.min(axis=0),dim=np.ptp(gxy,axis=0))
   points=vertex[0]+u[mask,None]*(vertex[1]-vertex[0])+v[mask,None]*(vertex[2]-vertex[0])
   rgb,_,rough=surface(points,color,grainchart)
   _,hp,_=surface(points+ch['t']*step,color,grainchart); _,hm,_=surface(points-ch['t']*step,color,grainchart)
   _,vp,_=surface(points+ch['v']*step,color,grainchart); _,vm,_=surface(points-ch['v']*step,color,grainchart)
   nn=np.column_stack((-(hp-hm)/(2*step),(vp-vm)/(2*step),np.ones(len(points)))); nn/=np.linalg.norm(nn,axis=1)[:,None]
   base[gy[mask],gx[mask]]=rgb; normal[gy[mask],gx[mask]]=nn*.5+.5; mr[gy[mask],gx[mask],1]=rough
 if ci%200==0: print('Painted',ci,flush=True)
# Extend the final painted pixels into each chart's own gutter, without crossing island ownership.
filled=coverage.copy()
for _ in range(6):
 previous=filled.copy()
 for dy,dx in [(0,1),(0,-1),(1,0),(-1,0)]:
  neighboring=np.roll(previous,(dy,dx),(0,1)); same=np.roll(owner,(dy,dx),(0,1))==owner; use=(~filled)&neighboring&same&(owner>=0)
  for arr in [base,normal,mr]: arr[use]=np.roll(arr,(dy,dx),(0,1))[use]
  filled[use]=True
def png(path,arr,srgb=False):
 a=np.clip(np.round(arr*255),0,255).astype(np.uint8); h,w,_=a.shape
 def chunk(name,data): return struct.pack('>I',len(data))+name+data+struct.pack('>I',zlib.crc32(name+data)&0xffffffff)
 out=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))
 if srgb: out+=chunk(b'sRGB',b'\x00')
 out+=chunk(b'IDAT',zlib.compress(b''.join(b'\x00'+row.tobytes() for row in a),9))+chunk(b'IEND',b''); path.write_bytes(out)
files=['timber-house-basecolor.png','timber-house-normal.png','timber-house-metallicRoughness.png']
for name,arr in zip(files,[base,normal,mr]): png(ROOT/name,arr,name==files[0])
# Preserve original accessors and buffer bytes except TEXCOORD_0. Add explicit tangents and three PNGs.
end=max(v.get('byteOffset',0)+v['byteLength'] for v in source['bufferViews'][:4]); out=bytearray(blob[:end]); uvview=j['bufferViews'][j['accessors'][2]['bufferView']]; out[uvview['byteOffset']:uvview['byteOffset']+uvview['byteLength']]=newuv.astype('<f4').tobytes()
j['bufferViews']=j['bufferViews'][:4]
def append(data,target=None):
 while len(out)%4: out.append(0)
 view={'buffer':0,'byteOffset':len(out),'byteLength':len(data)}
 if target: view['target']=target
 j['bufferViews'].append(view); out.extend(data); return len(j['bufferViews'])-1
vi=append(tangent.astype('<f4').tobytes(),34962); j['accessors'].append({'bufferView':vi,'componentType':5126,'count':len(p),'type':'VEC4'}); j['meshes'][0]['primitives'][0]['attributes']['TANGENT']=len(j['accessors'])-1
j['images']=[]; j['textures']=[]
for i,name in enumerate(files):
 vi=append((ROOT/name).read_bytes()); j['images'].append({'bufferView':vi,'mimeType':'image/png','name':pathlib.Path(name).stem}); j['textures'].append({'sampler':0,'source':i})
j['samplers']=[{'magFilter':9729,'minFilter':9987,'wrapS':33071,'wrapT':33071}]
j['materials']=[{'name':'Diffuse_color','pbrMetallicRoughness':{'baseColorTexture':{'index':0},'metallicRoughnessTexture':{'index':2},'metallicFactor':1,'roughnessFactor':1},'normalTexture':{'index':1,'scale':1}}]
j['buffers']=[{'byteLength':len(out)}]; j['asset']['generator']='Terrace texture-only atlas; source geometry preserved byte-for-byte'
js=json.dumps(j,separators=(',',':')).encode(); js+=b' '*((-len(js))%4); out+=b'\0'*((-len(out))%4)
(ROOT/'timber-house.glb').write_bytes(struct.pack('<III',0x46546c67,2,28+len(js)+len(out))+struct.pack('<I4s',len(js),b'JSON')+js+struct.pack('<I4s',len(out),b'BIN\0')+out)
np.savez_compressed(ROOT/'atlas-data.npz',uv=newuv,positions=p,triangles=tris,placements=np.array([placements[i] for i in range(len(charts))]),chart_ids=np.array([find(i) for i in range(len(p))]),density=scale)
report={'source_sha256':hashlib.sha256(b).hexdigest(),'vertices':len(p),'triangles':len(tris),'islands':len(charts),'density_pixels_per_source_unit':scale,'minimum_rectangle_gutter_pixels':GUTTER,'coverage_percent':float(coverage.mean()*100),'mesh_count':1,'material_count':1,'texture_size':[SIZE,SIZE],'metalness':0,'normal_convention':'OpenGL +Y, explicit tangent handedness -1','source_geometry':'POSITION, NORMAL and indices byte-identical; nodes and scenes identical'}
(ROOT/'verification.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2),flush=True)
# Import the delivered GLB itself for the editable file and all after renders.
bpy.ops.wm.read_factory_settings(use_empty=True); bpy.ops.import_scene.gltf(filepath=str(ROOT/'timber-house.glb'),merge_vertices=False)
for image in bpy.data.images:
 if image.source=='FILE': image.pack()
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'timber-house.blend'))


