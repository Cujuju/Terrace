"""Build an original Viking-inspired longhouse; no imported mesh or stock textures."""
import bpy
import numpy as np
import pathlib
import math
import json
import sys
from mathutils import Vector

ROOT = pathlib.Path(__file__).parent
sys.path.insert(0, str(ROOT))
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
ROOF_SEGMENTS = 8
ROOF_SWEEP = 0.27
TIMBER_WIDTH = 0.30
BEVEL_FRACTION = 0.13
PALETTE = {
    'timber': (0.30, 0.245, 0.19),
    'wall': (0.52, 0.455, 0.35),
    'gable': (0.46, 0.385, 0.285),
    'roof': (0.55, 0.335, 0.22),
    'door': (0.385, 0.28, 0.185),
    'stone': (0.43, 0.445, 0.42),
    'iron': (0.16, 0.175, 0.17),
    'dark': (0.085, 0.070, 0.05),
    'carving': (0.32, 0.265, 0.20),
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
    if bevel:
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
# Hall shell, gables and low stone footing.
box((0,0,.245),(6.34,12.34,.49),'stone',label='Stone foundation')
wall_ys=np.linspace(-6,6,ROOF_SEGMENTS+1)
wall_vertices=[]
for y in wall_ys:
    top=roof_height(3/ROOF_HALF_WIDTH,y)-.06
    wall_vertices.extend([(-3,y,WALL_BASE),(3,y,WALL_BASE),(3,y,top),(-3,y,top)])
wall_faces=[(3,2,1,0),tuple(range(len(wall_vertices)-4,len(wall_vertices)))]
for i in range(len(wall_ys)-1):
    for k in range(4): wall_faces.append((i*4+k,i*4+(k+1)%4,(i+1)*4+(k+1)%4,(i+1)*4+k))
solid(wall_vertices,wall_faces,'wall',label='Planked hall walls following swept eaves')
for sign in (-1,1):
    y=sign*6
    profile=[(-3,WALL_TOP),(3,WALL_TOP)]
    profile.extend([(x,roof_height(abs(x)/ROOF_HALF_WIDTH,y)-.10) for x in np.linspace(3,-3,9)])
    count=len(profile); coords=[(x,y+depth,z) for depth in (-.065,.065) for x,z in profile]
    faces=[tuple(reversed(range(count))),tuple(range(count,2*count))]
    faces.extend([(i,(i+1)%count,(i+1)%count+count,i+count) for i in range(count)])
    solid(coords,faces,'gable',(0,0,1),'Gable infill following roof profile')
# Side posts, sills, top rails and diagonal braces.
post_ys=np.linspace(-5.87,5.87,5)
for side in (-1,1):
    x=side*3.06
    for y in post_ys:
        box((x,y,.36),(.53,.54,.72),'stone',label='Post stone')
        beam((x,y,.52),(x,y,roof_height(3.24/ROOF_HALF_WIDTH,y)-.08),.34,label='Upright timber')
        box((x,y,.68),(.41,.42,.25),'timber',label='Post foot')
    for z in (.65,2.67):
        beam((x,-6.02,z),(x,6.02,z),.25,label='Long wall rail')
    for y in (-4.65,4.65):
        end=y+(.76 if y<0 else -.76)
        beam((x+.035*side,y,1.82),(x+.035*side,end,2.62),.19,label='Upper diagonal brace')
# End framing, entry door and porch.
for sign in (-1,1):
    y=sign*6.09
    beam((-3.04,y,2.76),(3.04,y,2.76),.30,label='Gable tie beam')
    beam((0,y,2.78),(0,y,5.36),.26,label='Gable kingpost')
    for side in (-1,1):
        sweep([(side*x,y,roof_height(x/ROOF_HALF_WIDTH,y)-.25) for x in np.linspace(0,3.04,5)],.23,.23,label='Gable rafter',bevel=False)
        beam((side*1.72,y,2.86),(side*.54,y,4.01),.17,label='Gable brace')
    if sign>0:
        beam((0,y,.54),(0,y,2.78),.26,label='Rear post')
        beam((-3,y,.65),(3,y,.65),.25,label='Rear sill')
# A dark recess behind the entrance keeps the doorway legible.
box((0,-6.095,1.55),(1.60,.12,2.02),'dark',label='Door recess')
box((0,-6.18,1.51),(1.25,.13,1.87),'door',label='Front plank door')
for x in (-.83,.83): beam((x,-6.23,.51),(x,-6.23,2.68),.22,label='Door jamb')
beam((-.94,-6.23,2.62),(.94,-6.23,2.62),.24,label='Door lintel')
for z in (.98,2.10): box((0,-6.265,z),(1.18,.045,.095),'iron',grain=(1,0,0),label='Door strap')
# Polygonal pull ring, generated directly as a small torus.
ringcoords=[]; ringfaces=[]; ringsteps=10; tubesides=4
for i in range(ringsteps):
    a=i*2*math.pi/ringsteps
    for k in range(tubesides):
        t=k*2*math.pi/tubesides; radius=.115+.022*math.cos(t)
        ringcoords.append((radius*math.cos(a),-6.31+.022*math.sin(t),1.48+radius*math.sin(a)))
for i in range(ringsteps):
    for k in range(tubesides): ringfaces.append((i*tubesides+k,((i+1)%ringsteps)*tubesides+k,((i+1)%ringsteps)*tubesides+(k+1)%tubesides,i*tubesides+(k+1)%tubesides))
solid(ringcoords,ringfaces,'iron',label='Door pull ring')
box((0,-7.32,.22),(2.68,2.70,.44),'stone',label='Upper entry step')
box((0,-8.07,.10),(2.95,1.40,.20),'stone',label='Lower entry step')
for x in (-1.17,1.17):
    box((x,-7.31,.37),(.54,.54,.74),'stone',label='Porch footing')
    beam((x,-7.31,.59),(x,-7.31,2.48),.29,label='Porch post')
    beam((x,-7.31,2.12),(x*.53,-7.31,2.54),.16,label='Porch knee brace')
beam((-1.3,-7.31,2.46),(1.3,-7.31,2.46),.22,label='Porch header')
beam((0,-7.42,2.50),(0,-7.42,3.70),.19,label='Porch kingpost')
roof(1.53,-7.64,-5.82,3.72,2.52,3,2,.025,'Porch roof')
# Small shuttered windows on the long walls.
for side in (-1,1):
    x=side*3.09
    for y in (-4.42,-1.47,1.47,4.42):
        box((x,y,1.68),(.10,.78,.88),'dark',label='Window recess')
        box((x+side*.065,y,1.68),(.09,.60,.70),'door',label='Window shutter')
        for z in (1.23,2.12): box((x+side*.095,y,z),(.20,.88,.12),'timber',grain=(0,1,0),label='Window sill and lintel')
        for offset in (-.38,.38): box((x+side*.095,y+offset,1.68),(.17,.105,.80),'timber',label='Window side frame')
        for z in (1.43,1.93): box((x+side*.126,y,z),(.045,.59,.075),'iron',grain=(0,1,0),label='Shutter strap')
roof(ROOF_HALF_WIDTH,-ROOF_HALF_LENGTH,ROOF_HALF_LENGTH,ROOF_RIDGE,ROOF_EAVE,ROOF_ROWS,ROOF_SEGMENTS,ROOF_SWEEP,'Main roof')
# Original angular animal-head gable carvings, using custom polygon profiles.
for sign in (-1,1):
    ybase=sign*ROOF_HALF_LENGTH
    base=ROOF_RIDGE+ROOF_SWEEP+.10
    profile=[(-.20,-.44),(.15,-.44),(.22,.17),(.32,.53),(.50,.65),(.88,.55),(.94,.76),(.64,.88),(.34,1.05),(.09,1.00),(-.07,.71),(-.18,.30)]
    profile_prism([(d,base+z) for d,z in profile],.29,ybase,sign,label='Carved gable head')
    profile_prism([(.33,base+.47),(.75,base+.31),(.84,base+.43),(.49,base+.64)],.23,ybase,sign,label='Carved lower jaw')
    profile_prism([(.03,base+.92),(-.05,base+1.20),(.13,base+1.16),(.30,base+1.01)],.16,ybase,sign,label='Carved crest')
    for side in (-1,1):
        eye=[]
        for i in range(6):
            a=i*2*math.pi/6; eye.append((side*.147,ybase+sign*(.40+.055*math.cos(a)),base+.84+.032*math.sin(a)))
        if side*sign<0: eye.reverse()
        solid(eye,[tuple(range(6))],'dark',label='Carved eye')

mesh=bpy.data.meshes.new('Longhouse')
mesh.from_pydata(vertices,[],polygons); mesh.update()
obj=bpy.data.objects.new('Longhouse',mesh); bpy.context.collection.objects.link(obj)
bpy.context.view_layer.objects.active=obj; obj.select_set(True)
# Recalculate solid-piece winding before UV projection.
import bmesh
bm=bmesh.new(); bm.from_mesh(mesh); bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces)); bm.to_mesh(mesh); bm.free(); mesh.update()
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
        tile=y/.54+(row%2)*.5; tileid=np.floor(tile); seamdist=np.minimum(tile%1,1-tile%1)
        seam=np.exp(-(seamdist/.038)**2)
        variation=.055*np.sin(tileid*19.33+row*13.73)
        a=np.abs(x)/width*rows-row
        lip=np.exp(-((a-.97)/.12)**2)
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
    elif kind=='stone':
        a=y if abs(ch['n'][0])>.5 else x
        b=z if abs(ch['n'][2])<.7 else y
        row=np.floor(b/.35); fy=(b/.35)%1; tile=a/.58+.5*(row%2)+.07*np.sin(row*12.7); fx=tile%1
        dx=np.minimum(fx,1-fx); dy=np.minimum(fy,1-fy)
        mortar=np.exp(-(np.minimum(dx,dy)/.067)**2)
        variant=.075*np.sin(np.floor(tile)*16.43+row*53.19)
        mult=1+variant-.27*mortar+.028*broad
        height=-.022*mortar+.003*broad
        rough=.95+.02*mortar
    else:
        mult=np.ones(len(pos))+.015*broad; height=np.zeros(len(pos)); rough=np.full(len(pos),.82 if kind=='iron' else .98)
    return np.clip(color*mult[:,None],0,1),height,np.clip(np.broadcast_to(rough,len(pos)),.65,1)

base=np.zeros((ATLAS_SIZE,ATLAS_SIZE,3)); base[:]=PALETTE['timber']
normal=np.zeros_like(base); normal[:]=(.5,.5,1)
mr=np.zeros_like(base); mr[:]=(1,.88,0)
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
    if i%250==0: print('TEXTURE',i,flush=True)
files=['longhouse-basecolor.png','longhouse-normal.png','longhouse-metallicRoughness.png']
for name,pixels in zip(files,[base,normal,mr]): write_png(ROOT/name,pixels,srgb=name==files[0])
# Single glTF-compatible material with explicit data colour spaces.
material=bpy.data.materials.new('Longhouse_PBR'); material.use_nodes=True; material.use_backface_culling=True
nodes=material.node_tree.nodes; links=material.node_tree.links; bsdf=nodes.get('Principled BSDF')
bsdf.inputs['Metallic'].default_value=0
bsdf.inputs['Roughness'].default_value=1
images=[]
for name in files:
    image=bpy.data.images.load(str(ROOT/name)); image.colorspace_settings.name='sRGB' if name==files[0] else 'Non-Color'
    node=nodes.new('ShaderNodeTexImage'); node.image=image; node.label=name; node.interpolation='Linear'; images.append(node)
images[0].location=(-650,300); images[1].location=(-650,-70); images[2].location=(-650,-430)
links.new(images[0].outputs['Color'],bsdf.inputs['Base Color'])
normalnode=nodes.new('ShaderNodeNormalMap'); normalnode.location=(-290,-65); normalnode.uv_map='UVMap'
links.new(images[1].outputs['Color'],normalnode.inputs['Color']); links.new(normalnode.outputs['Normal'],bsdf.inputs['Normal'])
separate=nodes.new('ShaderNodeSeparateColor'); separate.location=(-290,-430)
links.new(images[2].outputs['Color'],separate.inputs['Color']); links.new(separate.outputs['Green'],bsdf.inputs['Roughness']); links.new(separate.outputs['Blue'],bsdf.inputs['Metallic'])
mesh.materials.append(material)
for vertex in mesh.vertices: vertex.co*=MODEL_SCALE
mesh.update()
root=bpy.data.objects.new('RootNode',None); bpy.context.collection.objects.link(root); obj.parent=root
obj['provenance']='Original geometry generated from build_longhouse.py; no imported meshes or stock textures.'
obj['concept']='longhouse-concept.png; built-in image generator, model version unverified.'
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
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'longhouse.blend'))
editable_polygon_count=len(mesh.polygons)
bm=bmesh.new(); bm.from_mesh(mesh); bmesh.ops.triangulate(bm,faces=list(bm.faces)); bm.to_mesh(mesh); bm.free(); mesh.update()
bpy.ops.export_scene.gltf(filepath=str(ROOT/'longhouse.glb'),export_format='GLB',use_selection=False,export_apply=False,export_texcoords=True,export_normals=True,export_tangents=True,export_materials='EXPORT',export_image_format='AUTO',export_draco_mesh_compression_enable=False,export_cameras=False,export_lights=False)
report=dict(meshes=1,materials=1,vertices=len(mesh.vertices),triangles=len(mesh.loop_triangles),polygons=editable_polygon_count,parts=len(parts),islands=len(charts),texture_size=[ATLAS_SIZE,ATLAS_SIZE],gap_pixels=ISLAND_GAP,density_pixels_per_game_unit=density/MODEL_SCALE,dimensions=list(obj.dimensions),origin=list(obj.location),palette=PALETTE,geometry_source='Original procedural mesh, no imported assets',texture_source='Original procedural texture paint',image_generator='Built-in image generator; exact backend model unverified')
(ROOT/'build-report.json').write_text(json.dumps(report,indent=2))
(ROOT/'parts.json').write_text(json.dumps(parts,indent=2))
print(json.dumps(report,indent=2),flush=True)




