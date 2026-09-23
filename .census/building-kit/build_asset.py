"""Build Terrace assets using the original longhouse authoring and atlas pipeline."""
import bpy
import numpy as np
import pathlib
import math
import json
import sys
from mathutils import Vector

KIT = pathlib.Path(__file__).parent
BUILDING = sys.argv[sys.argv.index('--id')+1]
SOURCE_ROOT = KIT.parent / BUILDING
LOW_DETAIL = '--low' in sys.argv
ROOT = SOURCE_ROOT / 'low' if LOW_DETAIL else SOURCE_ROOT
ROOT.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(KIT))
import asset_helpers
if LOW_DETAIL:
    asset_helpers.ATLAS_SIZE = 1024
    if BUILDING=='durands': asset_helpers.ISLAND_GAP = 9
from asset_helpers import ATLAS_SIZE, ISLAND_GAP, pack_rectangles, project_polygon, write_png

MODEL_SCALE = 0.1
HALL_HALF_WIDTH = 3.0
HALL_HALF_LENGTH = 6.0
WALL_BASE = 0.48
WALL_TOP = 2.78
ROOF_HALF_WIDTH = 3.62
ROOF_HALF_LENGTH = 6.48
ROOF_RIDGE = 5.20
ROOF_EAVE = 2.65
ROOF_ROWS = 6
ROOF_SEGMENTS = 4 if LOW_DETAIL else 8
ROOF_SWEEP = 0.27
TIMBER_WIDTH = 0.30
BEVEL_FRACTION = 0.13
PALETTE = {
    'timber': (0.30, 0.245, 0.19),
    'wall': (0.52, 0.455, 0.35),
    'gable': (0.46, 0.385, 0.285),
    'roof': (0.55, 0.335, 0.22),
    'door': (0.385, 0.28, 0.185),
    'stone': (0.43, 0.445, 0.42), 'cutstone': (.51,.515,.48),
    'iron': (0.16, 0.175, 0.17),
    'dark': (0.085, 0.070, 0.05),
    'carving': (0.32, 0.265, 0.20),
    'thatch': (.60,.51,.33), 'plaster': (.66,.60,.47), 'turf': (.34,.42,.26), 'brick': (.53,.32,.24), 'canvas': (.65,.58,.44), 'fish': (.50,.55,.54), 'paint': (.40,.24,.19), 'slate': (.32,.37,.37),
}
vertices, polygons, tags = [], [], []
parts = []

def solid(coords, faces, kind, grain=(0, 0, 1), label='', **meta):
    offset = len(vertices)
    vertices.extend([tuple(p) for p in coords])
    start = len(polygons)
    for face in faces:
        polygons.append(tuple(offset + i for i in face))
        tags.append(dict(kind=kind, grain=np.array(grain, float), **meta))
    parts.append(dict(name=label or kind, first_face=start, face_count=len(faces)))

def box(center, size, kind='timber', grain=(0, 0, 1), label='', **meta):
    c = np.array(center, float)
    s = np.array(size, float) / 2
    coords = [c + s * p for p in np.array([[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]])]
    faces = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    solid(coords, faces, kind, grain, label, **meta)

def sweep(points, width, depth=None, kind='timber', bevel=True, label='', **meta):
    points = np.asarray(points, float)
    depth = width if depth is None else depth
    a, b = width / 2, depth / 2
    bevelsize = min(a, b) * BEVEL_FRACTION * 2
    if bevel and not LOW_DETAIL:
        section = [(-a+bevelsize,-b),(a-bevelsize,-b),(a,-b+bevelsize),(a,b-bevelsize),(a-bevelsize,b),(-a+bevelsize,b),(-a,b-bevelsize),(-a,-b+bevelsize)]
    else:
        section = [(-a,-b),(a,-b),(a,b),(-a,b)]
    coords = []
    for i, p in enumerate(points):
        direction = points[min(i+1,len(points)-1)]-points[max(0,i-1)]
        direction /= np.linalg.norm(direction)
        reference = np.array([0,1,0]) if abs(direction[1]) < .85 else np.array([1,0,0])
        u = np.cross(direction, reference); u /= np.linalg.norm(u)
        v = np.cross(direction, u)
        coords.extend([p+x*u+y*v for x,y in section])
    n = len(section)
    faces = [tuple(reversed(range(n))), tuple(range((len(points)-1)*n,len(points)*n))]
    for j in range(len(points)-1):
        for k in range(n):
            faces.append((j*n+k,j*n+(k+1)%n,(j+1)*n+(k+1)%n,(j+1)*n+k))
    grain = points[-1]-points[0]; grain /= np.linalg.norm(grain)
    solid(coords,faces,kind,grain,label,continuous=len(points)>2,**meta)

def beam(a,b,width=TIMBER_WIDTH,depth=None,**kwargs):
    sweep([a,b],width,depth,**kwargs)

def profile_prism(profile, thickness, ybase, direction, kind='carving', label=''):
    coords = [(x, ybase+direction*d, z) for x in (-thickness/2,thickness/2) for d,z in profile]
    count = len(profile)
    faces = [tuple(reversed(range(count))),tuple(range(count,2*count))]
    faces += [(i,(i+1)%count,(i+1)%count+count,i+count) for i in range(count)]
    # Orient both sides and rim consistently for mirrored gable carvings.
    if direction < 0:
        faces = [tuple(reversed(face)) for face in faces]
    solid(coords,faces,kind,(0,0,1),label)

def roof_height(u, y, half_length=ROOF_HALF_LENGTH, ridge=ROOF_RIDGE, eave=ROOF_EAVE, sweepheight=ROOF_SWEEP):
    return ridge-(ridge-eave)*u**.88+sweepheight*(y/half_length)**2

def roof(halfwidth, ya, yb, ridge, eave, rows, segments, sweepheight, label):
    ys = np.linspace(ya,yb,segments+1)
    half_length = max(abs(ya),abs(yb))
    for side in (-1,1):
        for row in range(rows):
            u0=max(0,row/rows-.014); u1=(row+1)/rows
            coords=[]
            for bottom in (False,True):
                for u in (u0,u1):
                    for y in ys:
                        rise=0.05*(u-u0)/(u1-u0)
                        z=roof_height(u,y,half_length,ridge,eave,sweepheight)+rise-(.065 if bottom else 0)
                        coords.append((side*halfwidth*u,y,z))
            stride=len(ys); layer=2*stride; faces=[]
            for i in range(segments):
                faces.extend([(i,i+stride,i+stride+1,i+1),(i+layer,i+layer+1,i+stride+layer+1,i+stride+layer),
                              (i+stride,i+stride+layer,i+stride+layer+1,i+stride+1),(i,i+1,i+layer+1,i+layer)])
            faces.extend([(0,layer,layer+stride,stride),(stride-1,2*stride-1,4*stride-1,3*stride-1)])
            if side < 0: faces=[tuple(reversed(f)) for f in faces]
            solid(coords,faces,'roof',(side*halfwidth,0,eave-ridge),label+f' course {row+1}',row=row,rows=rows,roof_width=halfwidth)
    # Continuous fascia and ridge beams avoid per-segment end caps.
    for end in (ya,yb):
        for side in (-1,1):
            us=np.linspace(0,1,5)
            points=[(side*halfwidth*u,end,roof_height(u,end,half_length,ridge,eave,sweepheight)+.075) for u in us]
            sweep(points,.22,.25,label=label+' gable fascia',bevel=False)
    for side in (-1,1):
        points=[(side*halfwidth,y,roof_height(1,y,half_length,ridge,eave,sweepheight)-.01) for y in ys]
        sweep(points,.20,.23,label=label+' eave',bevel=False)
    points=[(0,y,roof_height(0,y,half_length,ridge,eave,sweepheight)+.05) for y in ys]
    sweep(points,.30,.24,label=label+' ridge',bevel=True)


bpy.ops.wm.read_factory_settings(use_empty=True)
from designs import build, NEW
provenance, placement = build(BUILDING, LOW_DETAIL, globals())
if LOW_DETAIL and BUILDING!='durands' and (SOURCE_ROOT/'verification.json').exists():
    bounds=json.loads((SOURCE_ROOT/'verification.json').read_text())['bounds_gltf_y_up']
    lo,hi=bounds['min'],bounds['max']
    targetlo=np.array([lo[0],-hi[2],lo[1]])/MODEL_SCALE
    targethi=np.array([hi[0],-lo[2],hi[1]])/MODEL_SCALE
    vv=np.array(vertices);vv=(vv-vv.min(axis=0))/np.ptp(vv,axis=0)*(targethi-targetlo)+targetlo
    vertices[:]=vv.tolist()
    placement['low_alignment']='Low vertices fitted to original bounds before UV packing; shared origin and envelope.'
mesh=bpy.data.meshes.new(BUILDING)
mesh.from_pydata(vertices,[],polygons); mesh.update()
obj=bpy.data.objects.new(BUILDING,mesh); bpy.context.collection.objects.link(obj)
bpy.context.view_layer.objects.active=obj; obj.select_set(True)
# Recalculate solid-piece winding before UV projection.
import bmesh
bm=bmesh.new(); bm.from_mesh(mesh); bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces)) if BUILDING in NEW+['temple','timber-house','durands','ricks'] else bm.normal_update(); bm.to_mesh(mesh); bm.free(); mesh.update()
# Tags remain aligned because no face topology operation changes face order.
charts=[]
for face,tag in zip(mesh.polygons,tags):
    points=np.array([mesh.vertices[v].co[:] for v in face.vertices])
    ch=project_polygon(points,np.array(face.normal),tag['grain']); ch.update(tag); ch['points']=points; ch['face']=face.index
    charts.append(ch)
density,placements=pack_rectangles([ch['dim'] for ch in charts])
print('ATLAS',len(charts),'islands;',density,'pixels per construction unit',flush=True)
uv_layer=mesh.uv_layers.new(name='UVMap')
for i,ch in enumerate(charts):
    x,y,w,h,rotated=placements[i]
    if rotated:
        ch['t'],ch['v']=ch['v'],-ch['t']
        ch['xy']=np.column_stack((ch['points']@ch['t'],ch['points']@ch['v']))
        ch['lo']=ch['xy'].min(axis=0); ch['dim']=np.ptp(ch['xy'],axis=0)
    ch['offset']=np.array([x+ISLAND_GAP/2,y+ISLAND_GAP/2])
    pixeluv=(ch['xy']-ch['lo'])*density+ch['offset']
    ch['pixeluv']=pixeluv
    for loop,xy in zip(mesh.polygons[i].loop_indices,pixeluv): uv_layer.data[loop].uv=(xy[0]/ATLAS_SIZE,1-xy[1]/ATLAS_SIZE)

# All textures are newly authored procedural paint, in the concept's restrained palette.
def surface(pos,ch):
    if 'custom_surface' in globals():
        result=custom_surface(pos,ch)
        if result is not None: return result
    kind=ch['kind']; color=np.array(PALETTE[kind]); x,y,z=pos.T
    seed=(ch['face']%17)*.39
    local=np.column_stack((pos@ch['t'],pos@ch['v']))-ch['lo']
    edge=np.maximum(0,np.minimum.reduce([local[:,0],ch['dim'][0]-local[:,0],local[:,1],ch['dim'][1]-local[:,1]]))
    grain=ch['grain'].copy(); grain/=max(np.linalg.norm(grain),1e-8)
    along=pos@grain
    across=np.cross(ch['n'],grain)
    if np.linalg.norm(across)<.1: across=ch['t']
    across/=np.linalg.norm(across); crossgrain=pos@across
    phase=crossgrain*48+1.2*np.sin(along*3.5+crossgrain*4)+.30*np.sin(along*10)
    fibers=np.sin(phase)+.30*np.sin(phase*1.91)
    broad=np.sin(x*3.5+np.sin(y*2))*np.sin(z*4+y*1.7)
    wear=np.exp(-edge/.040)*(.65+.35*np.sin(along*19+crossgrain*5)**2)
    if kind=='roof':
        row=ch.get('row',0); width=ch.get('roof_width',ROOF_HALF_WIDTH); rows=ch.get('rows',ROOF_ROWS)
        tile=crossgrain/.54+(row%2)*.5; tileid=np.floor(tile); seamdist=np.minimum(tile%1,1-tile%1)
        seam=np.exp(-(seamdist/.038)**2)
        variation=.055*np.sin(tileid*19.33+row*13.73)
        a=np.abs(x)/width*rows-row
        lip=wear
        g=np.sin(np.abs(x)*17+np.sin(y*16)*.65)+.25*np.sin(np.abs(x)*39+y*18)
        mult=1+variation-.18*seam+.05*lip+.02*g
        height=-.012*seam+.003*g
        rough=.85+.03*seam-.025*lip
    elif kind in ('timber','door','carving'):
        wave=.065*fibers+.023*np.sin(along*1.7+crossgrain*16)
        knot=np.exp(-((along*.38+crossgrain*.13-.63)%1-.5)**2/.004)*np.exp(-np.sin(crossgrain*7.2)**2/.09)
        mult=1+wave+.14*wear-.045*knot
        height=.004*fibers-.003*wear-.002*knot
        rough=.88-.075*wear+.018*fibers
        if kind=='door':
            board=crossgrain/.20; joint=np.exp(-(np.minimum(board%1,1-board%1)/.055)**2)
            mult-=.18*joint; height-=.012*joint
        if kind=='carving':
            carving=np.exp(-(np.sin(along*5+crossgrain*6)/.18)**2)
            mult-=.06*carving; height-=.006*carving
    elif kind in ('wall','gable'):
        if kind=='wall' and abs(ch['n'][2])<.8:
            plank=z/.27; wavealong=y if abs(ch['n'][0])>.5 else x
        else:
            plank=(x if abs(ch['n'][1])>.5 else y)/.29; wavealong=z
        joint=np.exp(-(np.minimum(plank%1,1-plank%1)/.055)**2)
        change=.045*np.sin(np.floor(plank)*7.21)
        fibers=np.sin(plank*12+.55*np.sin(wavealong*3.2))
        mult=1+change-.21*joint+.027*fibers+.015*broad
        height=-.010*joint+.002*fibers
        rough=.92+.025*joint
    elif kind in ('stone','brick'):
        if BUILDING=='temple': x,y,z=x/2.7,y/2.7,z/2.7
        a=y if abs(ch['n'][0])>.5 else x
        b=z if abs(ch['n'][2])<.7 else y
        row=np.floor(b/.35); fy=(b/.35)%1; tile=a/.58+.5*(row%2)+.07*np.sin(row*12.7); fx=tile%1
        dx=np.minimum(fx,1-fx); dy=np.minimum(fy,1-fy)
        mortar=np.exp(-(np.minimum(dx,dy)/.067)**2)
        variant=.075*np.sin(np.floor(tile)*16.43+row*53.19)
        mult=1+variant-.27*mortar+.028*broad
        height=-.022*mortar+.003*broad
        rough=.95+.02*mortar
    elif kind in ('thatch','canvas','plaster','turf','paint','slate','cutstone'):
        lines=np.sin(crossgrain*35+.35*np.sin(along*7))
        fiber=.025 if kind in ('thatch','canvas') else .013
        mult=1+fiber*lines+.02*broad+.055*wear
        height=(.001 if kind=='thatch' else .0003)*lines
        if kind in ('plaster','cutstone'):
            mult=1+.018*broad+.035*wear+.02*math.sin(ch['face']*3.73)
            height=.0003*broad
        rough=np.full(len(pos),.94)
    else:
        mult=np.ones(len(pos))+.015*broad; height=np.zeros(len(pos)); rough=np.full(len(pos),.82 if kind=='iron' else .98)
    return np.clip(color*mult[:,None],0,1),height,np.clip(np.broadcast_to(rough,len(pos)),.65,1)

base=np.zeros((ATLAS_SIZE,ATLAS_SIZE,3)); base[:]=PALETTE['timber']
normal=np.zeros_like(base); normal[:]=(.5,.5,1)
mr=np.zeros_like(base); mr[:]=(1,.88,0)
emissive=np.zeros_like(base) if 'emissive_surface' in globals() else None
step=.5/density
for i,ch in enumerate(charts):
    x,y,w,h,_=placements[i]; yy,xx=np.mgrid[y:y+h,x:x+w]
    plane=np.column_stack((xx.ravel()+.5,yy.ravel()+.5)); plane=(plane-ch['offset'])/density+ch['lo']
    planeoff=np.mean(ch['points']@ch['n'])
    pos=plane[:,0,None]*ch['t']+plane[:,1,None]*ch['v']+planeoff*ch['n']
    color,height,rough=surface(pos,ch)
    _,hp,_=surface(pos+ch['t']*step,ch); _,hm,_=surface(pos-ch['t']*step,ch)
    _,vp,_=surface(pos+ch['v']*step,ch); _,vm,_=surface(pos-ch['v']*step,ch)
    nn=np.column_stack((-(hp-hm)/(2*step),(vp-vm)/(2*step),np.ones(len(pos))))
    nn/=np.linalg.norm(nn,axis=1)[:,None]
    base[y:y+h,x:x+w]=color.reshape(h,w,3)
    normal[y:y+h,x:x+w]=(nn*.5+.5).reshape(h,w,3)
    mr[y:y+h,x:x+w,1]=rough.reshape(h,w)
    if emissive is not None:
        emissive[y:y+h,x:x+w]=emissive_surface(pos,ch,color).reshape(h,w,3)
    if i%250==0: print('TEXTURE',i,flush=True)
files=[BUILDING+'-basecolor.png',BUILDING+'-normal.png',BUILDING+'-metallicRoughness.png']
for name,pixels in zip(files,[base,normal,mr]): write_png(ROOT/name,pixels,srgb=name==files[0])
if emissive is not None:
    files.append(BUILDING+'-emissive.png')
    write_png(ROOT/files[-1],emissive,srgb=True)
# Single glTF-compatible material with explicit data colour spaces.
material=bpy.data.materials.new(BUILDING+'_PBR'); material.use_nodes=True; material.use_backface_culling=True
nodes=material.node_tree.nodes; links=material.node_tree.links; bsdf=nodes.get('Principled BSDF')
bsdf.inputs['Metallic'].default_value=0
bsdf.inputs['Roughness'].default_value=1
images=[]
for name in files:
    image=bpy.data.images.load(str(ROOT/name)); image.colorspace_settings.name='sRGB' if name==files[0] or 'emissive' in name else 'Non-Color'
    node=nodes.new('ShaderNodeTexImage'); node.image=image; node.label=name; node.interpolation='Linear'; images.append(node)
images[0].location=(-650,300); images[1].location=(-650,-70); images[2].location=(-650,-430)
links.new(images[0].outputs['Color'],bsdf.inputs['Base Color'])
normalnode=nodes.new('ShaderNodeNormalMap'); normalnode.location=(-290,-65); normalnode.uv_map='UVMap'
links.new(images[1].outputs['Color'],normalnode.inputs['Color']); links.new(normalnode.outputs['Normal'],bsdf.inputs['Normal'])
separate=nodes.new('ShaderNodeSeparateColor'); separate.location=(-290,-430)
links.new(images[2].outputs['Color'],separate.inputs['Color']); links.new(separate.outputs['Green'],bsdf.inputs['Roughness']); links.new(separate.outputs['Blue'],bsdf.inputs['Metallic'])
if emissive is not None:
    images[3].location=(-650,-750)
    links.new(images[3].outputs['Color'],bsdf.inputs['Emission Color'])
    bsdf.inputs['Emission Strength'].default_value=globals().get('EMISSION_STRENGTH',1.0)
mesh.materials.append(material)
for vertex in mesh.vertices: vertex.co*=MODEL_SCALE
mesh.update()
bpy.context.view_layer.update()
root=bpy.data.objects.new('RootNode',None); bpy.context.collection.objects.link(root); obj.parent=root
obj['provenance']=provenance
obj['concept']=BUILDING+'-concept.png; built-in image generator, model version unverified.'
obj['construction_scale']=MODEL_SCALE
obj['parts']=len(parts)
mesh.calc_loop_triangles()
# Keep an editable polygon mesh in the blend; triangulate the exported game mesh.
for image in bpy.data.images:
    if image.source=='FILE': image.pack()
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            area.spaces.active.shading.type='MATERIAL'
            area.spaces.active.region_3d.view_distance=2.8
            area.spaces.active.region_3d.view_location=(0,-.05,.30)
bpy.context.scene.unit_settings.system='METRIC'
bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/(BUILDING+'.blend')))
editable_polygon_count=len(mesh.polygons)
bm=bmesh.new(); bm.from_mesh(mesh); bmesh.ops.triangulate(bm,faces=list(bm.faces)); bmesh.ops.delete(bm,geom=[f for f in bm.faces if f.calc_area()<1e-9],context='FACES')
bm.to_mesh(mesh); bm.free(); mesh.update()
if BUILDING=='durands': bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/(BUILDING+'.blend')))
export_path=ROOT/('.export-'+BUILDING+'.glb')
bpy.ops.export_scene.gltf(filepath=str(export_path),export_format='GLB',use_selection=False,export_apply=False,export_texcoords=True,export_normals=True,export_tangents=True,export_materials='EXPORT',export_image_format='AUTO',export_draco_mesh_compression_enable=False,export_cameras=False,export_lights=False)
export_path.replace(ROOT/(BUILDING+'.glb'))
report=dict(profile='low' if LOW_DETAIL else 'original',meshes=1,materials=1,vertices=len(mesh.vertices),triangles=len(mesh.loop_triangles),polygons=editable_polygon_count,parts=len(parts),islands=len(charts),texture_size=[ATLAS_SIZE,ATLAS_SIZE],gap_pixels=ISLAND_GAP,density_pixels_per_game_unit=density/MODEL_SCALE,dimensions=list(obj.dimensions),origin=list(obj.location),palette=PALETTE,geometry_source=provenance,texture_source='Original procedural texture paint',image_generator='Built-in image generator; exact backend model unverified')
report['placement']=placement
report['texture_source']=globals().get('TEXTURE_PROVENANCE',report['texture_source'])
report['emissive']=emissive is not None
if emissive is not None: report['emission_strength']=EMISSION_STRENGTH
(ROOT/'build-report.json').write_text(json.dumps(report,indent=2))
(ROOT/'parts.json').write_text(json.dumps(parts,indent=2))
print(json.dumps(report,indent=2),flush=True)
