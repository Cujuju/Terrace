"""Measure the delivered model, texture channels, and UV atlas."""
import bpy, json, pathlib, struct, numpy as np, hashlib, sys
ROOT=pathlib.Path(__file__).parent
if '--low' in sys.argv: ROOT=ROOT/'low'
asset=ROOT/'longhouse.glb'; raw=asset.read_bytes(); length=struct.unpack_from('<I',raw,12)[0]; doc=json.loads(raw[20:20+length]); blob=raw[28+length:]
def accessor(index):
    a=doc['accessors'][index]; view=doc['bufferViews'][a['bufferView']]
    size={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
    dtype=np.dtype({5126:'<f4',5125:'<u4',5123:'<u2',5121:'u1'}[a['componentType']])
    offset=view.get('byteOffset',0)+a.get('byteOffset',0)
    stride=view.get('byteStride',dtype.itemsize*size)
    return np.ndarray((a['count'],size),dtype=dtype,buffer=blob,offset=offset,strides=(stride,dtype.itemsize)).copy()
primitive=doc['meshes'][0]['primitives'][0]; attributes=primitive['attributes']
pos=accessor(attributes['POSITION']).astype(float); uv=accessor(attributes['TEXCOORD_0']).astype(float); normal=accessor(attributes['NORMAL']).astype(float); tangent=accessor(attributes['TANGENT']).astype(float); triangles=accessor(primitive['indices']).reshape(-1,3)
size=json.loads((ROOT/'build-report.json').read_text())['texture_size'][0]
points=uv[triangles]*size
lo=points.min(axis=1); hi=points.max(axis=1)
def cross(a,b): return a[...,0]*b[...,1]-a[...,1]*b[...,0]
def intersection(subject,clip):
    polygon=list(subject)
    if cross(clip[1]-clip[0],clip[2]-clip[0])<0: clip=clip[::-1]
    for a,b in zip(clip,np.roll(clip,-1,axis=0)):
        output=[]
        for s,e in zip(polygon,polygon[1:]+polygon[:1]):
            ds=cross(b-a,s-a); de=cross(b-a,e-a)
            if (ds>=0)!=(de>=0): output.append(s+(e-s)*ds/(ds-de))
            if de>=0: output.append(e)
        polygon=output
        if not polygon: return 0.
    p=np.array(polygon)
    return abs(np.sum(cross(p,np.roll(p,-1,axis=0))))/2
pairs=[]; candidates=0
for i in range(len(triangles)):
    match=np.where(np.all(hi[i]>lo[i+1:],axis=1)&np.all(hi[i+1:]>lo[i],axis=1))[0]+i+1
    for k in match:
        candidates+=1; area=intersection(points[i],points[k])
        if area>1e-4: pairs.append([i,int(k),float(area)])
parent=list(range(len(pos)))
def find(x):
    while parent[x]!=x: parent[x]=parent[parent[x]]; x=parent[x]
    return x
for triangle in triangles:
    for vertex in triangle[1:]: parent[find(int(vertex))]=find(int(triangle[0]))
# Exported tangent seams can split vertices inside one continuous UV island.
keys={}
for i in range(len(pos)):
    key=tuple(np.round(np.concatenate((pos[i],uv[i])),7))
    if key in keys: parent[find(i)]=find(keys[key])
    else: keys[key]=i
islands={}
for i in range(len(pos)): islands.setdefault(find(i),[]).append(i)
bounds=np.array([[uv[ids].min(axis=0)*size,uv[ids].max(axis=0)*size] for ids in islands.values()])
gap=float('inf')
for i in range(len(bounds)-1):
    delta=np.maximum(0,np.maximum(bounds[i,0]-bounds[i+1:,1],bounds[i+1:,0]-bounds[i,1]))
    gap=min(gap,float(np.linalg.norm(delta,axis=1).min()))
area3=np.linalg.norm(np.cross(pos[triangles[:,1]]-pos[triangles[:,0]],pos[triangles[:,2]]-pos[triangles[:,0]]),axis=1)/2
area2=abs(cross(points[:,1]-points[:,0],points[:,2]-points[:,0]))/2
density=np.sqrt(area2/area3)
report=dict(glb_sha256=hashlib.sha256(raw).hexdigest(),mesh_count=len(doc['meshes']),primitive_count=len(doc['meshes'][0]['primitives']),material_count=len(doc['materials']),triangles=len(triangles),exported_vertices=len(pos),nodes=doc['nodes'],dimensions_gltf_y_up=np.ptp(pos,axis=0).tolist(),uv_islands=len(islands),uv_min_max=[float(uv.min()),float(uv.max())],uv_overlap_pairs=pairs,uv_candidate_pairs_checked=candidates,minimum_island_bounds_gap_pixels=gap,texel_density_min_max=density[[np.argmin(density),np.argmax(density)]].tolist(),zero_area_triangles=int(sum(area3<1e-12)),normal_length_error_max=float(np.max(abs(np.linalg.norm(normal,axis=1)-1))),tangent_normal_dot_max=float(np.max(abs(np.sum(tangent[:,:3]*normal,axis=1)))),compression_extensions=doc.get('extensionsUsed',[]))
report['textures']={}
for image in doc['images']:
    view=doc['bufferViews'][image['bufferView']]; png=blob[view['byteOffset']:view['byteOffset']+view['byteLength']]
    name=image['name']; external=(ROOT/(name+'.png')).read_bytes()
    report['textures'][name]=dict(format=image['mimeType'],dimensions=list(struct.unpack_from('>II',png,16)),matches_external_bytes=png==external)
for name in ['longhouse-metallicRoughness','longhouse-normal']:
    im=bpy.data.images.load(str(ROOT/(name+'.png'))); im.colorspace_settings.name='Non-Color'
    pixels=np.array(im.pixels[:],np.float32).reshape(-1,4)
    if 'metallic' in name:
        report['roughness_range']=pixels[:,1][[pixels[:,1].argmin(),pixels[:,1].argmax()]].tolist(); report['metalness_range']=[float(pixels[:,2].min()),float(pixels[:,2].max())]
    else:
        nn=pixels[:,:3]*2-1; report['normal_map_length_error_max']=float(np.max(abs(np.linalg.norm(nn,axis=1)-1)))
    bpy.data.images.remove(im)
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'longhouse.blend'))
mesh=bpy.data.objects['Longhouse'].data; mesh.calc_loop_triangles()
report['blend']=dict(mesh_count=len(bpy.data.meshes),material_count=len(bpy.data.materials),vertices=len(mesh.vertices),triangles=len(mesh.loop_triangles),uv_layers=[u.name for u in mesh.uv_layers],images_packed=all(i.packed_file is not None for i in bpy.data.images if i.type=='IMAGE'),objects=[o.name for o in bpy.data.objects])
report['passed']=not pairs and gap>=8 and min(density)>0 and report['zero_area_triangles']==0 and report['metalness_range']==[0.,0.] and report['mesh_count']==1 and report['material_count']==1 and 'TANGENT' in attributes
(ROOT/'verification.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2),flush=True)
if not report['passed']: raise RuntimeError('Asset audit failed; inspect verification.json')

