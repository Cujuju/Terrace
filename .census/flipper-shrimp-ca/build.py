"""Original Blender C+A clubhouse. No third-party models or reference-image projection.

Run in a factory-startup background Blender, never over the user's open scene.
The image textures are also valid glTF inputs, unlike unbaked procedural nodes.
"""
import bpy
import math
import json
import random
import bmesh
import shutil
from pathlib import Path
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

SOURCE_ROOT = Path(__file__).resolve().parent
ROOT = SOURCE_ROOT / 'revision-2'
ROOT.mkdir(exist_ok=True)
TEX = ROOT / 'textures'
TEX.mkdir(exist_ok=True)
shutil.copy2(SOURCE_ROOT/'textures'/'sign-atlas.png',TEX/'sign-atlas.png')
random.seed(147)
PI = math.pi
TAU = math.tau


def enum_set(owner, key, value):
    values = {i.identifier for i in owner.bl_rna.properties[key].enum_items}
    if value not in values:
        raise ValueError(f'{key}: {value} unavailable; valid {values}')
    setattr(owner, key, value)


# The script requires a disposable factory-startup file.
if bpy.data.filepath:
    raise RuntimeError('Build in a fresh background Blender, not over a saved user scene')
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob, do_unlink=True)
scene = bpy.context.scene
scene.name = 'Flipper & Shrimp - C plus A'
asset = bpy.data.collections.new('CLUBHOUSE - editable parts')
scene.collection.children.link(asset)
studio = bpy.data.collections.new('STUDIO - excluded from export')
scene.collection.children.link(studio)


def put(ob, collection=asset):
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    collection.objects.link(ob)
    return ob


def image_array(name, rgb, noncolor=False, alpha=None):
    h, w = rgb.shape[:2]
    im = bpy.data.images.new(name, width=w, height=h, alpha=True)
    enum_set(im.colorspace_settings, 'name', 'Non-Color' if noncolor else 'sRGB')
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[:, :, :3] = np.clip(rgb, 0, 1)
    if alpha is not None: rgba[:,:,3] = np.clip(alpha,0,1)
    im.pixels.foreach_set(rgba.ravel())
    enum_set(im, 'file_format', 'PNG')
    target=TEX/(name+'.png')
    temporary=TEX/(name+'-writing.png')
    im.filepath_raw = str(temporary)
    im.save()
    if target.exists() and temporary.read_bytes()==target.read_bytes():
        temporary.unlink()
    else:
        temporary.replace(target)
    im.filepath_raw=str(target)
    im.pack()
    return im


def surface(name, color, rough=.45, metal=0, emission=0, pattern=None):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    bs = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    linear = tuple(c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4 for c in color)
    bs.inputs['Base Color'].default_value = (*linear, 1)
    bs.inputs['Roughness'].default_value = rough
    bs.inputs['Metallic'].default_value = metal
    if emission:
        bs.inputs['Emission Color'].default_value = (*color, 1)
        bs.inputs['Emission Strength'].default_value = emission
    if pattern:
        n = 512 if pattern != 'water' else 1024
        v, u = np.mgrid[0:n, 0:n] / n
        grain = (np.sin(TAU*(u*38 + .19*np.sin(TAU*v*2)+.06*np.sin(TAU*v*7))) +
                 .4*np.sin(TAU*(u*87+.09*np.sin(TAU*v*3))))
        noise = .45*np.sin(TAU*(u*11+v*17)) * np.cos(TAU*(u*19-v*13))
        h = np.zeros_like(u)
        rgb = np.ones((n, n, 3))*np.array(color)
        if pattern in ('wood', 'planks', 'whitewood'):
            h = .52 + .012*grain + .010*noise
            rgb *= (.97+.030*grain+.012*noise)[..., None]
            if pattern in ('planks', 'whitewood'):
                seams = (np.mod(u*6, 1) < .025)
                ends = np.mod(v*2+(np.floor(u*6)%2)*.5, 1) < .012
                h -= .25*(seams | ends)
                rgb *= np.where(seams | ends, .76, 1)[..., None]
            if pattern == 'whitewood':
                worn = np.clip(grain-.5, 0, 1)*.06
                rgb -= worn[..., None]*np.array([.1, .14, .17])
        elif pattern == 'stone':
            h = .5+.11*noise+.07*np.sin(TAU*(u*4+v*3))*np.cos(TAU*v*7)
            rgb *= (.84+.28*h+.025*noise)[..., None]
        elif pattern == 'slide':
            # Water sheen is part of the flume material, with no intersecting overlay.
            wet=np.exp(-((u-.5)/.16)**4)
            streak=(.5+.5*np.sin(TAU*(u*31+.06*np.sin(TAU*v*3))))**10
            h=.5+.004*wet*np.sin(TAU*(u*22+.12*np.sin(TAU*v*2)))
            rgb += (wet*(.045+.045*streak))[...,None]*np.array([.7,1.,1.])
        elif pattern == 'rope':
            h = .5+.28*np.sin(TAU*(u*12+v*24))
            rgb *= (.8+.25*h)[..., None]
        elif pattern == 'roof':
            row = np.floor(v*7)
            x = np.mod(u*5+(row%2)*.5, 1)
            y = np.mod(v*7, 1)
            seam = (x < .025) | (y < .06)
            h = .3+.5*y+.035*grain
            h[seam] = .12
            variation = .88+.13*np.sin(row*13+np.floor(u*5+(row%2)*.5)*19)
            rgb *= (variation*(.80+.24*y))[..., None]
            rgb[seam] *= .48
            rgb[(y > .90) & ~seam] *= 1.14
        elif pattern in ('water', 'fall'):
            if pattern == 'water':
                # Periodic warped Voronoi ridges approximate a caustic network.
                xx = u*12+.55*np.sin(TAU*v*3)+.14*np.sin(TAU*u*7+TAU*v*5)
                yy = v*12+.55*np.sin(TAU*u*3)+.14*np.sin(TAU*v*6+TAU*u*4)
                ix, iy = np.floor(xx), np.floor(yy)
                d1 = np.full_like(u, 100.)
                d2 = d1.copy()
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        gx, gy = ix+dx, iy+dy
                        hx = np.mod(np.sin(np.mod(gx,12)*127.1+np.mod(gy,12)*311.7)*43758.54, 1)
                        hy = np.mod(np.sin(np.mod(gx,12)*269.5+np.mod(gy,12)*183.3)*43758.54, 1)
                        d = np.sqrt((gx+.2+.6*hx-xx)**2+(gy+.2+.6*hy-yy)**2)
                        d2 = np.minimum(d2, np.maximum(d1, d))
                        d1 = np.minimum(d1, d)
                glow = np.exp(-(d2-d1)*55)*.58
                h = .5+.12*np.sin(TAU*(u*5+v*6))+.07*noise
                rgb *= (.77+.22*np.sin(TAU*u*2)*np.sin(TAU*v*3))[..., None]
                rgb += glow[..., None]*np.array([.50, .65, .57])
            else:
                h = .5+.20*np.sin(TAU*(u*24+.03*np.sin(TAU*v*3)))
                stripe = np.maximum(0,np.sin(TAU*(u*19+.12*np.sin(TAU*v))))**12
                rgb = rgb*(.70+.2*h)[..., None]+stripe[..., None]*.65
        base = image_array(name+'-color', rgb)
        node = mat.node_tree.nodes.new('ShaderNodeTexImage'); node.image = base
        mat.node_tree.links.new(node.outputs['Color'], bs.inputs['Base Color'])
        gy, gx = np.gradient(h)
        normal = np.stack((-gx*3, -gy*3, np.ones_like(h)), axis=-1)
        normal /= np.linalg.norm(normal, axis=-1)[..., None]
        nim = image_array(name+'-normal', normal*.5+.5, True)
        nn = mat.node_tree.nodes.new('ShaderNodeTexImage'); nn.image = nim
        nm = mat.node_tree.nodes.new('ShaderNodeNormalMap')
        mat.node_tree.links.new(nn.outputs['Color'], nm.inputs['Color'])
        mat.node_tree.links.new(nm.outputs['Normal'], bs.inputs['Normal'])
    return mat


M = {}
for key, color, rough, metal, emiss, pat in [
    ('Timber',(.44,.29,.16),.58,0,0,'wood'),
    ('Deck',(.58,.40,.24),.54,0,0,'planks'),
    ('Ivory planks',(.84,.77,.63),.60,0,0,'whitewood'),
    ('Limestone',(.57,.54,.45),.73,0,0,'stone'),
    ('Warm stone',(.70,.63,.51),.69,0,0,'stone'),
    ('Rope',(.67,.51,.30),.78,0,0,'rope'),
    ('Roof',(.10,.37,.48),.37,0,0,'roof'),
    ('Lagoon',(.045,.58,.62),.18,.14,0,'water'),
    ('Cascade',(.25,.74,.79),.20,.1,0,'fall'),
    ('Blue flume glaze',(.08,.61,.71),.21,.06,0,'slide'),
    ('Coral flume glaze',(.98,.52,.33),.23,.04,0,'slide'),
    ('Teal',(.055,.34,.39),.34,0,0,None),
    ('Aqua',(.08,.61,.71),.23,.1,0,None),
    ('Coral',(.93,.30,.18),.27,0,0,None),
    ('Peach',(.98,.52,.33),.30,0,0,None),
    ('Shell',(.98,.71,.53),.38,0,0,None),
    ('Cream',(.96,.90,.76),.43,0,0,None),
    ('Dolphin',(.20,.43,.67),.23,0,0,None),
    ('Belly',(.81,.88,.88),.30,0,0,None),
    ('Eye',(.008,.019,.023),.13,0,0,None),
    ('Iris',(.02,.34,.45),.23,0,0,None),
    ('Mouth',(.13,.016,.015),.40,0,0,None),
    ('Tongue',(.84,.18,.18),.40,0,0,None),
    ('Brass',(.61,.37,.10),.28,.65,0,None),
    ('Iron',(.075,.085,.072),.44,.55,0,None),
    ('Lamp', (1.,.58,.12),.24,0,3,None),
    ('Glass',(.07,.43,.51),.16,.32,0,None),
    ('Leaf',(.20,.35,.065),.62,0,0,None),
    ('Leaf light',(.32,.46,.085),.61,0,0,None),
    ('Foam',(.83,.97,.94),.30,0,.10,None),
    ('White',(.98,.98,.93),.25,0,0,None),
    ('Algae',(.10,.22,.17),.75,0,0,None),
]:
    M[key] = surface(key,color,rough,metal,emiss,pat)


def decal_material(name,im):
    mat=surface(name,(1,1,1),.48)
    bs=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=im
    mat.node_tree.links.new(node.outputs['Color'],bs.inputs['Base Color'])
    mat.node_tree.links.new(node.outputs['Alpha'],bs.inputs['Alpha'])
    enum_set(mat,'surface_render_method','DITHERED')
    mat.use_transparent_shadow=True
    return mat


atlas=bpy.data.images.load(str(TEX/'sign-atlas.png'));atlas.pack()
sign_material=decal_material('Painted nautical lettering atlas',atlas)
n=512
vv,uu=np.mgrid[0:n,0:n]/n
xx=(uu-.5)*2;yy=(vv-.5)*2
rad=np.sqrt(xx*xx+yy*yy);ang=np.arctan2(yy,xx)
alpha=np.zeros_like(rad)
for rr in (.37,.52,.72,.90):
    ridge=np.exp(-((rad-(rr+.012*np.sin(ang*9)+.010*np.sin(ang*17)))/.011)**2)
    alpha=np.maximum(alpha,ridge*(.70+.25*np.sin(ang*13+rr*41)))
foam_rgb=np.ones((n,n,3))*np.array([.83,.97,.94])
foam_image=image_array('Foam-ripple-decal',foam_rgb,alpha=alpha)
foam_material=decal_material('Foam ripples - texture not tubes',foam_image)
# Diamond fishing net with knots: transparent texture on a lightly draped sheet.
net_a=np.abs(np.sin(PI*(uu*8+vv*8)))
net_b=np.abs(np.sin(PI*(uu*8-vv*8)))
net_alpha=np.maximum(np.clip((.085-net_a)*22,0,1),np.clip((.085-net_b)*22,0,1))
net_rgb=np.ones((n,n,3))*np.array([.71,.57,.37])
net_image=image_array('Nautical-net-decal',net_rgb,alpha=net_alpha)
net_material=decal_material('Draped rope net - alpha texture',net_image)


def mesh(name, verts, faces, mat, smooth=False, uv=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces); me.update()
    ob = bpy.data.objects.new(name, me); asset.objects.link(ob)
    me.materials.append(M[mat] if isinstance(mat,str) else mat)
    layer = me.uv_layers.new(name='UVMap')
    for face in me.polygons:
        face.use_smooth = smooth
        axis = int(np.argmax(np.abs(face.normal)))
        axes = ((1,2),(0,2),(0,1))[axis]
        for loop in face.loop_indices:
            vi = me.loops[loop].vertex_index
            p = me.vertices[vi].co
            layer.data[loop].uv = uv[vi] if uv is not None else (p[axes[0]]*.55,p[axes[1]]*.55)
    return ob


def bevel(ob, amount=.045, segments=2):
    mod = ob.modifiers.new('Rounded silhouette edges','BEVEL')
    mod.width=amount; mod.segments=segments
    return ob


def box(name, loc, size, mat, bevel_width=.025):
    x,y,z = [v/2 for v in size]
    verts=[(-x,-y,-z),(x,-y,-z),(x,y,-z),(-x,y,-z),(-x,-y,z),(x,-y,z),(x,y,z),(-x,y,z)]
    ob=mesh(name,verts,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)],mat)
    ob.location=loc
    if bevel_width: bevel(ob,bevel_width,2)
    return ob


def sphere(name, loc, scale, mat, seg=24, rings=14):
    verts=[]; uv=[]
    for j in range(rings+1):
        t=PI*j/rings
        for i in range(seg+1):
            a=TAU*i/seg
            verts.append((scale[0]*math.sin(t)*math.cos(a),scale[1]*math.sin(t)*math.sin(a),scale[2]*math.cos(t)))
            uv.append((i/seg,j/rings))
    faces=[]
    for j in range(rings):
        for i in range(seg):
            k=j*(seg+1)+i
            faces.append((k,k+1,k+seg+2,k+seg+1))
    ob=mesh(name,verts,faces,mat,True,uv); ob.location=loc
    return ob


def cylinder(name,loc,radius,depth,mat,vertices=16,top=None):
    if top is None: top=radius
    verts=[];uv=[]
    for z,r in ((-depth/2,radius),(depth/2,top)):
        for i in range(vertices):
            a=TAU*i/vertices
            verts.append((r*math.cos(a),r*math.sin(a),z))
            uv.append((i/vertices,z*.55))
    faces=[tuple(reversed(range(vertices))),tuple(range(vertices,2*vertices))]
    faces += [(i,(i+1)%vertices,(i+1)%vertices+vertices,i+vertices) for i in range(vertices)]
    ob=mesh(name,verts,faces,mat,True,uv);ob.location=loc
    # Flat caps, smooth sides.
    ob.data.polygons[0].use_smooth=False;ob.data.polygons[1].use_smooth=False
    return ob


def beam(name,a,b,r,mat='Timber',vertices=12):
    a,b=Vector(a),Vector(b)
    ob=cylinder(name,(a+b)*.5,r,(b-a).length,mat,vertices)
    ob.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler()
    return ob


def path(controls, steps=32):
    pts=[Vector(p) for p in controls]
    pts=[2*pts[0]-pts[1]]+pts+[2*pts[-1]-pts[-2]]
    out=[]
    for t in np.linspace(0,len(controls)-1,steps):
        i=min(int(t),len(controls)-2);f=t-i
        a,b,c,d=pts[i:i+4]
        out.append(.5*((2*b)+(-a+c)*f+(2*a-5*b+4*c-d)*f*f+(-a+3*b-3*c+d)*f**3))
    return out


def tube(name,points,radius,mat,sides=8):
    points=[Vector(p) for p in points]
    verts=[];uv=[]
    radii=[radius]*len(points) if isinstance(radius,(float,int)) else radius
    distance=0;previous_u=None
    for j,p in enumerate(points):
        d=(points[min(j+1,len(points)-1)]-points[max(j-1,0)]).normalized()
        if previous_u is None:
            v=Vector((0,0,1)) if abs(d.z)<.92 else Vector((0,1,0))
            u=d.cross(v).normalized()
        else:
            u=(previous_u-d*previous_u.dot(d)).normalized()
        v=d.cross(u).normalized();previous_u=u
        if j: distance+=(p-points[j-1]).length
        for k in range(sides):
            a=TAU*k/sides
            verts.append(p+radii[j]*(math.cos(a)*u+math.sin(a)*v))
            uv.append((k/sides,distance*2))
    faces=[]
    for j in range(len(points)-1):
        for k in range(sides):
            faces.append((j*sides+k,j*sides+(k+1)%sides,(j+1)*sides+(k+1)%sides,(j+1)*sides+k))
    faces += [tuple(reversed(range(sides))),tuple(range((len(points)-1)*sides,len(points)*sides))]
    return mesh(name,verts,faces,mat,True,uv)


def ring(name,center,r,t,mat,plane='xy',seg=32,sides=6):
    x,y,z=center
    pts=[(x+r*math.cos(a),y+r*math.sin(a),z) if plane=='xy' else (x+r*math.cos(a),y,z+r*math.sin(a)) for a in np.linspace(0,TAU,seg+1)]
    return tube(name,pts,t,mat,sides)


def disc(name,center,rx,ry,z,depth,mat,n=64):
    pts=[(center[0]+rx*math.cos(a),center[1]+ry*math.sin(a)) for a in np.linspace(0,TAU,n,endpoint=False)]
    verts=[(x,y,h) for h in (z-depth,z) for x,y in pts]
    faces=[tuple(range(n,2*n)),tuple(reversed(range(n)))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return mesh(name,verts,faces,mat)


def relief(name,outline,y,depth,mat):
    n=len(outline)
    verts=[(x,yy,z) for yy in (y,y+depth) for x,z in outline]
    faces=[tuple(range(n)),tuple(reversed(range(n,2*n)))]
    faces += [(i,i+n,(i+1)%n+n,(i+1)%n) for i in range(n)]
    return bevel(mesh(name,verts,faces,mat),.028,2)


def post(x,y,bottom,top,r=.13,wrap=True):
    ob=cylinder('Weathered pier post',(x,y,(bottom+top)/2),r,top-bottom,'Timber',12,top=r*.96)
    bevel(ob,.018,1)
    cylinder('End-grain cap',(x,y,top+.015),r*1.08,.055,'Deck',12)
    if wrap:
        # One collar, texture conveys the individual rope strands.
        cylinder('Rope lashing',(x,y,top-.23),r*1.16,.20,'Rope',12)
    if bottom<.3:
        cylinder('Algae tide mark',(x,y,.18),r*1.025,.36,'Algae',12)
    return ob


def rails(points,z,height=.68,piles=False):
    for x,y in points: post(x,y,0 if piles else z-.08,z+height)
    for (x,y),(xx,yy) in zip(points,points[1:]):
        beam('Handrail',(x,y,z+height-.06),(xx,yy,z+height-.06),.055,'Timber',8)
        for h in (.23,.48):
            tube('Sagging rope rail',path([(x,y,z+h),((x+xx)/2,(y+yy)/2,z+h-.09),(xx,yy,z+h)],5),.026,'Rope',4)


def lantern(x,y,z,scale=1):
    r=.11*scale; h=.30*scale
    cylinder('Amber lantern',(x,y,z),r,h,'Lamp',8)
    cylinder('Lantern foot',(x,y,z-h*.58),r*1.3,.045*scale,'Iron',8)
    cylinder('Lantern hood',(x,y,z+h*.67),r*1.55,.12*scale,'Brass',8,top=.025*scale)
    for a in np.linspace(0,TAU,4,endpoint=False):
        beam('Lantern mullion',(x+r*math.cos(a),y+r*math.sin(a),z-h/2),(x+r*math.cos(a),y+r*math.sin(a),z+h/2),.012*scale,'Iron',5)
    ring('Lantern hanging loop',(x,y,z+h),.055*scale,.013*scale,'Iron','xz',12,4)


def porthole(x,y,z,r=.40):
    ob=cylinder('Porthole amber aqua glass',(x,y,z),r,.07,'Glass',32)
    ob.rotation_euler.x=PI/2
    ring('Porthole timber surround',(x,y-.055,z),r+.055,.072,'Timber','xz')
    ring('Porthole brass rim',(x,y-.10,z),r,.040,'Brass','xz')
    for dx,dz in ((r,0),(-r,0),(0,r),(0,-r)):
        sphere('Porthole rivet',(x+dx,y-.15,z+dz),(.025,.018,.025),'Brass',8,6)
    beam('Porthole crossbar',(x-r,y-.13,z),(x+r,y-.13,z),.024,'Brass',8)
    beam('Porthole crossbar',(x,y-.13,z-r),(x,y-.13,z+r),.024,'Brass',8)


def rock(loc,size,mat='Limestone'):
    ob=box('Rounded stone block',loc,size,mat,min(size)*.18)
    ob.modifiers[0].segments=1
    ob.rotation_euler=(random.uniform(-.08,.08),random.uniform(-.08,.08),random.uniform(-.12,.12))
    return ob


def plant(x,y,z,scale=1):
    cylinder('Plant pot',(x,y,z+.12*scale),.18*scale,.25*scale,'Timber',10,top=.23*scale)
    for k in range(7):
        a=TAU*k/7
        start=Vector((x,y,z+.25*scale));end=start+Vector((math.cos(a)*.44,math.sin(a)*.44,.17))*scale
        middle=(start+end)*.5+Vector((0,0,.26*scale))
        side=Vector((-math.sin(a),math.cos(a),0))*.11*scale
        mesh('Tropical pointed leaf',[start,middle+side,end,middle-side,middle+Vector((0,0,.035))],[(0,1,4),(1,2,4),(2,3,4),(3,0,4)],'Leaf light' if k%2 else 'Leaf',True)


print('Materials and modelling tools ready',flush=True)

# --- Water courtyard and boardwalk. Front is Blender -Y. ---
disc('Shallow tidal skirt',(0,0),5.45,4.9,.045,.08,'Lagoon',96)
disc('Lagoon pool',(0,-.90),2.68,2.95,1.05,.06,'Lagoon',80)
for row in range(3):
    count=36
    for i in range(count):
        a=TAU*(i+(row%2)*.5)/count
        # The entry gap is bridged by the stairs.
        if row==2 and abs(a-PI*1.5)<.16: continue
        x=2.87*math.cos(a);y=-.9+3.12*math.sin(a)
        ob=rock((x,y,.22+row*.35),(.55,.42,.34),'Warm stone' if (i+row)%3 else 'Limestone')
        ob.rotation_euler.z=a+PI/2
for i in range(38):
    a=TAU*i/38
    ob=rock((2.84*math.cos(a),-.9+3.11*math.sin(a),1.23),(.51,.50,.21),'Warm stone')
    ob.rotation_euler.z=a+PI/2

for s in (-1,1):
    cx=s*3.58;cy=-1.25
    disc('Rounded lounge boardwalk',(cx,cy),1.55,1.78,1.63,.23,'Deck',48)
    # Raised fascia follows the outer pier. Wood planks themselves are texture.
    angles=np.linspace(-PI*.78,PI*.78,13) if s==1 else np.linspace(PI*.22,PI*1.78,13)
    pts=[(cx+1.53*math.cos(a),cy+1.76*math.sin(a)) for a in angles]
    rails(pts,1.65,.71,True)
    for z in (1.39,1.10):
        tube('Curved boardwalk fascia',[(cx+1.55*math.cos(a),cy+1.78*math.sin(a),z) for a in angles],.105,'Timber',6)
    for x,y in pts[::3]: lantern(x,y-.06,2.64,.85)

box('Upper pier platform',(0,2.58,3.42),(9.1,3.60,.24),'Deck',.07)
for x in (-4.4,-3,-1.75,0,1.75,3,4.4):
    post(x,.88,0,3.47,.18)
    post(x,4.20,0,3.47,.18)
    if x<4:
        beam('Under-pier cross bracing',(x,.94,.6),(x+1.20,.94,3.28),.085)
for s in (-1,1):
    rails([(s*4.43,.88),(s*4.43,2),(s*4.43,3.1),(s*4.43,4.2)],3.54)
    rails([(s*4.43,.88),(s*3.70,.88),(s*3.05,.88)],3.54)
    for k in range(7):
        box('Stair to upper pier',(s*4.1,.12+k*.18,1.71+k*.25),(.70,.34,.18),'Deck')
    # Small striped fishing floats on the rail.
    for j in range(3):
        x=s*(4.2+j*.30);y=-.55-j*.95;z=1.25
        tube('Buoy suspension',[(x,y,2.06),(x,y,z+.30)],.013,'Rope',4)
        cylinder('Buoy ivory stripe',(x,y,z),.095,.30,'Cream',10)
        cylinder('Buoy painted top',(x,y,z+.21),.095,.15,'Coral' if j%2 else 'Aqua',10,top=.035)
        cylinder('Buoy painted bottom',(x,y,z-.18),.035,.12,'Aqua' if j%2 else 'Coral',10,top=.095)

# Front landing and steps, no rectangular plinth around the water.
box('Arrival dock',(0,-4.48,.46),(2.0,1.17,.22),'Deck',.05)
for s in (-1,1):
    for yy in (-4.98,-3.98): post(s*.92,yy,-.05,1.10,.15)
for j in range(5):
    box('Arrival stair tread',(0,-3.95+j*.17,.54+j*.16),(1.46,.34,.18),'Deck',.025)
lantern(.96,-4.95,1.35,.8)
for x,y in ((-.7,-3.0),(.0,-3.15),(.65,-3.0)):
    cylinder('Stepping stone',(x,y,1.11),.26,.11,'Warm stone',9)

# The central cascade is rock, thin water ribbons and painted foam.
for tier,(zz,ww,yy) in enumerate(((1.25,1.8,.05),(1.84,1.20,.37),(2.40,.75,.67))):
    for x in np.linspace(-ww/2,ww/2,5-tier):
        rock((x,yy,zz),(.40,.55,.51),'Limestone')
    w=ww*.36
    verts=[(-w,yy-.30,zz+.285),(w,yy-.30,zz+.285),(-w,yy-.42,zz+.20),(w,yy-.42,zz+.20),
           (-w*.85,yy-.50,zz-.45),(w*.85,yy-.50,zz-.45)]
    mesh('Thin falling water sheet',verts,[(0,1,3,2),(2,3,5,4)],'Cascade',True,
         [(0,1),(1,1),(0,.85),(1,.85),(0,0),(1,0)])
    for k in range(7):
        xx=(k/6-.5)*w*1.65
        tube('Waterfall white rim',path([(xx,yy-.31,zz+.29),(xx,yy-.43,zz+.18),(xx,yy-.51,zz-.37)],9),.010,'Foam',4)
for x in (-.96,.96):
    tube('Arcing fountain jet',path([(x,.18,1.08),(x,.15,1.89),(x*.83,-.12,1.36),(x*.75,-.31,1.08)],18),[.055*(1-.48*i/17) for i in range(18)],'Cascade',7)
    for k in range(3): sphere('Fountain droplet',(x+.05*k,.1-.15*k,1.86-.15*k),(.04,.035,.07),'Foam',8,6)


def splash(x,y,z,r):
    mesh('Textured foam ripple',[(x-r,y-r*.64,z+.012),(x+r,y-r*.64,z+.012),(x+r,y+r*.64,z+.012),(x-r,y+r*.64,z+.012)],[(0,1,2,3)],foam_material,False,[(0,0),(1,0),(1,1),(0,1)])
    for k in range(6):
        a=TAU*k/6
        tube('Splash crown',path([(x,y,z),(x+r*.30*math.cos(a),y+r*.23*math.sin(a),z+.15),(x+r*.65*math.cos(a),y+r*.45*math.sin(a),z+.015)],7),[.036*(1-i/8) for i in range(7)],'Foam',5)
splash(0,-.36,1.07,.63)

# --- Main facade: round portholes, arched double door, gabled awning. ---
box('Main weathered clubhouse',(0,2.80,4.63),(5.20,2.72,2.22),'Ivory planks',.13)
box('Clubhouse eave',(0,2.80,5.85),(5.50,2.97,.19),'Timber',.045)
for x in (-2.52,-.91,.91,2.52):
    post(x,1.35,3.48,6.01,.13)
    if abs(x)>2: cylinder('Facade rope wrap',(x,1.35,4.38),.17,.23,'Rope',12)
for x in (-1.73,1.73):
    porthole(x,1.36,4.74,.46)
    box('Window lower sill',(x,1.19,4.13),(1.20,.35,.13),'Timber',.04)
    lantern(x+(.66 if x<0 else -.66),1.10,4.77,.76)
    plant(x,1.05,3.57,.76)

arch=[(-.72,3.56),(.72,3.56),(.72,4.72)]
arch += [(.72*math.cos(a),4.72+.70*math.sin(a)) for a in np.linspace(0,PI,21)[1:]]
relief('Arched door oak surround',[(x*1.13,3.54+(z-3.54)*1.07) for x,z in arch],1.19,.20,'Timber')
relief('Arched teal double doors',arch,1.10,.14,'Teal')
for x in (-.47,-.23,0,.23,.47):
    box('Door panel seam',(x,1.075,4.08),(.013,.015,1.01),'Timber',0)
for s in (-1,1):
    box('Door upper window',(s*.31,1.035,4.76),(.46,.035,.47),'Glass',.07)
    beam('Door window mullion',(s*.31,.999,4.55),(s*.31,.999,4.96),.023,'Brass',8)
    sphere('Door brass handle',(s*.12,.94,4.15),(.045,.045,.07),'Brass',12,8)

for s in (-1,1):
    # Two planar shingle-covered roof panels, pitched over the door.
    mesh('Blue shingle entrance gable',[(0,.60,6.09),(s*1.17,.60,5.49),(s*1.17,1.63,5.49),(0,1.63,6.09)],[(0,1,2,3)],'Roof',False,[(0,0),(1,0),(1,.65),(0,.65)])
    beam('Awning pale fascia',(0,.56,6.09),(s*1.18,.56,5.49),.074,'Cream')
lantern(0,.61,5.56,.88)
# Entrance balcony projects over the cascade.
disc('Door balcony',(0,.89),1.02,.69,3.51,.20,'Deck',32)
balcony=[(math.cos(a),.89+.69*math.sin(a)) for a in np.linspace(PI,TAU,7)]
rails(balcony,3.55,.59)
ring('Entrance life ring',(0,.17,3.96),.28,.081,'Cream','xz',40,8)
for a in (0,PI/2,PI,PI*1.5):
    pts=[(.28*math.cos(t),.155,3.96+.28*math.sin(t)) for t in np.linspace(a-.19,a+.19,5)]
    tube('Life ring coral band',pts,.085,'Coral',8)

# Left annex and its sloping shingle roof.
box('Left pier hut',(-3.49,2.52,4.34),(1.49,2.38,1.64),'Ivory planks',.045)
for s in (-1,1):
    mesh('Annex shingle roof',[(-3.49,1.24,5.69),(-3.49+s*.91,1.24,5.12),(-3.49+s*.91,3.94,5.12),(-3.49,3.94,5.69)],[(0,1,2,3)],'Roof',False,[(0,0),(.8,0),(.8,1.6),(0,1.6)])
    beam('Annex roof trim',(-3.49,1.21,5.69),(-3.49+s*.94,1.21,5.12),.055,'Timber')
porthole(-3.50,1.27,4.59,.27)

# --- Lighthouse, gallery, lantern and copper dome. ---
tx,ty=3.44,2.93
tower_start=set(asset.objects)
cylinder('Lighthouse tapered plaster tower',(tx,ty,5.84),.67,4.12,'Ivory planks',40,top=.56)
for zz in (4.02,5.91,7.81):
    cylinder('Lighthouse stone collar',(tx,ty,zz),.75,.16,'Warm stone',32)
disc('Lighthouse gallery',(tx,ty),1.00,1.00,7.80,.15,'Deck',48)
gallery=[(tx+.97*math.cos(a),ty+.97*math.sin(a)) for a in np.linspace(0,TAU,13)]
rails(gallery,7.84,.52)
porthole(tx,ty-.65,6.23,.22)
cylinder('Lighthouse glowing lantern',(tx,ty,8.53),.48,1.20,'Lamp',16)
for a in np.linspace(0,TAU,8,endpoint=False):
    beam('Lantern house brass frame',(tx+.5*math.cos(a),ty+.5*math.sin(a),7.99),(tx+.5*math.cos(a),ty+.5*math.sin(a),9.14),.045,'Brass')
cylinder('Lighthouse lantern top rim',(tx,ty,9.15),.66,.12,'Teal',32)
# Hemisphere dome, open underside.
verts=[]
for j in range(9):
    theta=PI*.5*j/8
    for k in range(32):
        a=TAU*k/32;verts.append((tx+.66*math.sin(theta)*math.cos(a),ty+.66*math.sin(theta)*math.sin(a),9.20+.47*math.cos(theta)))
faces=[(j*32+k,j*32+(k+1)%32,(j+1)*32+(k+1)%32,(j+1)*32+k) for j in range(8) for k in range(32)]
mesh('Sea-blue lighthouse dome',verts,faces,'Teal',True)
for a in np.linspace(0,TAU,8,endpoint=False):
    tube('Dome raised seam',[(tx+.672*math.sin(t)*math.cos(a),ty+.672*math.sin(t)*math.sin(a),9.2+.48*math.cos(t)) for t in np.linspace(0,PI/2,12)],.018,'Aqua',5)
beam('Nautical pennant pole',(tx,ty,9.6),(tx,ty,10.24),.025,'Brass')
mesh('Blue pennant',[(tx,ty,10.17),(tx+.82,ty-.08,10.04),(tx+.69,ty+.05,9.73),(tx,ty,9.84)],[(0,1,2,3)],'Teal')
beam('Pennant anchor stem',(tx+.31,ty-.065,9.87),(tx+.31,ty-.065,10.08),.016,'Cream',5)
tube('Pennant anchor arms',path([(tx+.17,ty-.065,9.93),(tx+.31,ty-.065,9.85),(tx+.45,ty-.065,9.93)],12),.016,'Cream',5)
ring('Pennant anchor eye',(tx+.31,ty-.065,10.08),.03,.012,'Cream','xz',12,4)
lantern(tx+.93,ty-.1,7.27,.91)
tower_parts=set(asset.objects)-tower_start

# --- Main timber sign, scallop and sculpted wave brackets. ---
outline=[(-2.24,6.26),(-2.43,6.71),(-2.36,7.45),(-1.92,7.98),(-.85,8.18),(0,8.35),(.85,8.18),(1.92,7.98),(2.36,7.45),(2.43,6.71),(2.24,6.26),(0,6.06)]
relief('Carved oak sign frame',outline,1.18,.30,'Timber')
inside=[(x*.94,7.18+(z-7.18)*.89) for x,z in outline]
relief('Ivory sign face',inside,1.095,.095,'Ivory planks')
# Single thin strips define the big sign planks; fine grain stays in the map.
for z in (6.48,6.85,7.22,7.59,7.93):
    span=2.12 if z<7.65 else 1.75
    beam('Sign plank joint',(-span,1.069,z),(span,1.069,z),.009,'Timber',4)
for x,z in ((-2.14,6.62),(2.14,6.62),(-1.87,7.80),(1.87,7.80)):
    sphere('Sign iron peg',(x,1.02,z),(.036,.02,.036),'Iron',10,6)


def scallop(center,r,mat='Shell',ribs=9):
    x,y,z=center
    for k in range(ribs):
        a=PI*(.08+.84*(k+.5)/ribs)
        p=(x+math.cos(a)*r*.65,y,z+math.sin(a)*r*.57)
        ob=sphere('Scallop fan rib',p,(r*.10,r*.09,r*.58),'Cream' if k%2 else mat,14,10)
        ob.rotation_euler.y=PI/2-a
scallop((0,1.07,8.22),.60)
scallop((0,-.11,1.77),.34)


def wave(x,y,z,s=1,mirror=1):
    contour=[(-.65,0),(.58,0),(.45,.18),(.22,.37),(.10,.59),(.15,.78),(.32,.88),(.48,.85),
             (.52,.72),(.43,.64),(.34,.68),(.31,.76),(.25,.69),(.28,.54),(.42,.48),(.61,.55),
             (.72,.73),(.69,.97),(.53,1.17),(.29,1.26),(.02,1.20),(-.20,1.06),(-.37,.84),(-.44,.52)]
    ob=relief('Carved curling wave relief',[(x+mirror*s*a,z+s*b) for a,b in contour],y-.16*s,.28*s,'Teal')
    crest=[(-.41,.23),(-.29,.62),(-.10,.98),(.14,1.14),(.39,1.15),(.58,1.01),(.62,.82),(.53,.65),(.40,.63)]
    tube('Wave pale carved crest',path([(x+mirror*s*a,y-.20*s,z+s*b) for a,b in crest],28),.036*s,'Aqua',6)
    tube('Wave white foam lip',path([(x+mirror*s*a,y-.225*s,z+s*b+.035*s) for a,b in crest[3:]],20),.015*s,'Belly',5)
    trough=[(-.31,.04),(-.10,.15),(.13,.18),(.29,.13)]
    tube('Wave lower carved line',path([(x+mirror*s*a,y-.205*s,z+s*b) for a,b in trough],16),.020*s,'Aqua',5)
for s in (-1,1):
    wave(s*2.77,1.41,5.92,1.18,-s)
    wave(s*2.95,1.43,6.49,.91,-s)
    wave(s*4.53,-2.16,1.75,.64,-s)

print('Architecture complete',flush=True)


def fin(name,outline,front,thickness,mat):
    # Lenticular fin with a raised centre: 2D outline, actual volume, tapered rim.
    n=len(outline);cx=sum(p[0] for p in outline)/n;cz=sum(p[1] for p in outline)/n
    verts=[(x,front,z) for x,z in outline]+[(cx,front-thickness,cz),(cx,front+thickness*.55,cz)]
    faces=[]
    for i in range(n): faces.extend([(i,(i+1)%n,n),((i+1)%n,i,n+1)])
    ob=mesh(name,verts,faces,mat,True)
    mod=ob.modifiers.new('Fin sculpt smoothing','SUBSURF');mod.levels=1;mod.render_levels=1
    return ob


def eye(x,y,z,r=.15,look=1):
    sphere('Inset ivory eye',(x,y,z),(r,r*.24,r*1.12),'Belly',24,16)
    sphere('Inset turquoise iris',(x+look*r*.19,y-r*.19,z),(r*.68,r*.17,r*.79),'Iris',24,16)
    sphere('Inset dark pupil',(x+look*r*.23,y-r*.32,z),(r*.44,r*.10,r*.59),'Eye',24,16)
    sphere('Eye catchlight',(x+look*r*.12-r*.13,y-r*.41,z+r*.29),(r*.19,r*.045,r*.21),'White',12,8)
    sphere('Eye secondary glint',(x+look*r*.26,y-r*.415,z-r*.22),(r*.067,r*.025,r*.08),'White',8,6)


def sculpt_head(name,origin,forward,stations,upper,lower):
    """Continuous rounded upper/lower jaw lofts with an inset, three-dimensional mouth.

    Stations: forward distance, half depth, upper height, lower height, centre Z, gape.
    No flat mouth plate or detached oval lip. The mouth rim is the head's own edge.
    """
    values=np.array(stations,dtype=float)
    padded=np.vstack((2*values[0]-values[1],values,2*values[-1]-values[-2]))
    rows=[]
    for t in np.linspace(0,len(values)-1,56):
        i=min(int(t),len(values)-2);f=t-i
        a,b,c,d=padded[i:i+4]
        row=.5*(2*b+(-a+c)*f+(2*a-5*b+4*c-d)*f*f+(-a+3*b-3*c+d)*f**3)
        row[1:4]=np.maximum(row[1:4],.008);row[5]=max(0,float(row[5]))
        rows.append(row)
    ox,oy,oz=origin;n=25
    for is_upper,material in ((True,upper),(False,lower)):
        verts=[]
        for xx,depth,up,down,zc,gape in rows:
            for k in range(n):
                angle=PI*k/(n-1)+(0 if is_upper else PI)
                h=up if is_upper else down
                verts.append((ox+forward*xx,oy+depth*math.cos(angle),oz+zc+h*math.sin(angle)+(gape/2 if is_upper else -gape/2)))
        faces=[(j*n+k,j*n+k+1,(j+1)*n+k+1,(j+1)*n+k) for j in range(len(rows)-1) for k in range(n-1)]
        faces += [(j*n,(j+1)*n,(j+1)*n+n-1,j*n+n-1) for j in range(len(rows)-1)]
        faces += [tuple(reversed(range(n))),tuple(range((len(rows)-1)*n,len(rows)*n))]
        if forward<0: faces=[tuple(reversed(f)) for f in faces]
        mesh(name+(' sculpted upper head' if is_upper else ' integrated lower jaw'),verts,faces,material,True)
    # Curved inset side walls and internal palate give the opening depth from oblique views.
    open_rows=[r for r in rows if r[5]>.003]
    for side in (-1,1):
        rim=[(ox+forward*r[0],oy+side*r[1],oz+r[4]+r[5]/2) for r in open_rows]
        rim += [(ox+forward*r[0],oy+side*r[1],oz+r[4]-r[5]/2) for r in reversed(open_rows)]
        center=Vector((sum(p[0] for p in rim)/len(rim),oy,sum(p[2] for p in rim)/len(rim)))
        inner=[(center.x+(p[0]-center.x)*.78,p[1]-side*.075,center.z+(p[2]-center.z)*.78) for p in rim]
        verts=rim+inner+[tuple(center)];count=len(rim)
        faces=[(k,(k+1)%count,(k+1)%count+count,k+count) for k in range(count)]
        faces += [(count+k,count+(k+1)%count,2*count) for k in range(count)]
        ob=mesh(name+' recessed mouth cavity',verts,faces,'Mouth',True)
    for sign in (-1,1):
        verts=[]
        for xx,depth,up,down,zc,gape in open_rows:
            verts.extend([(ox+forward*xx,oy-depth,oz+zc+sign*gape/2),(ox+forward*xx,oy+depth,oz+zc+sign*gape/2)])
        mesh(name+' inner palate',verts,[(j*2,j*2+1,j*2+3,j*2+2) for j in range(len(open_rows)-1)],'Mouth',True)
    # A small inset tongue, safely behind the lower rim.
    mid=max(open_rows,key=lambda r:r[5])
    sphere(name+' inset tongue',(ox+forward*mid[0],oy-mid[1]*.58,oz+mid[4]-mid[5]*.39),(.12,.075,.020),'Tongue',20,10)
    def skin_y(x,z):
        t=(x-ox)*forward
        values=np.array(rows)
        depth=float(np.interp(t,values[:,0],values[:,1]))
        height=float(np.interp(t,values[:,0],values[:,2]))
        center=oz+float(np.interp(t,values[:,0],values[:,4]+values[:,5]*.5))
        return oy-depth*math.sqrt(max(.05,1-((z-center)/height)**2))
    return skin_y


def seated_eye(skin,x,z,r,look,material):
    y=skin(x,z)-.009
    eye(x,y,z,r,look)
    rim=[]
    for a in np.linspace(.02,PI-.02,22):
        xx=x+r*1.05*math.cos(a);zz=z+r*1.18*math.sin(a)
        rim.append((xx,skin(xx,zz)-.011,zz))
    tube(material+' fitted upper eyelid',rim,.018,material,7)


def fuse_skin(label,names):
    """Unify face and body into a smooth sculpt while retaining surface colours."""
    bpy.ops.object.select_all(action='DESELECT')
    parts=[bpy.data.objects[n] for n in names]
    for part in parts: part.select_set(True)
    bpy.context.view_layer.objects.active=parts[0]
    bpy.ops.object.join()
    ob=bpy.context.object;ob.name=label
    bm=bmesh.new();bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-6)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
    bm.to_mesh(ob.data);bm.free()
    source=BVHTree.FromPolygons([v.co.copy() for v in ob.data.vertices],[list(p.vertices) for p in ob.data.polygons])
    colours=[p.material_index for p in ob.data.polygons]
    mod=ob.modifiers.new('Unified sculpt skin','REMESH');enum_set(mod,'mode','VOXEL')
    mod.voxel_size=.020;mod.use_smooth_shade=True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    mod=ob.modifiers.new('Relax sculpt junctions','SMOOTH');mod.factor=.62;mod.iterations=6
    bpy.ops.object.modifier_apply(modifier=mod.name)
    mod=ob.modifiers.new('Sculpt surface economy','DECIMATE');mod.ratio=.40
    bpy.ops.object.modifier_apply(modifier=mod.name)
    ob.data.update()
    palette=[]
    for material in ob.data.materials:
        bs=next(n for n in material.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
        palette.append(tuple(bs.inputs['Base Color'].default_value))
    rgba=np.zeros((len(ob.data.vertices),4),dtype=np.float32)
    for v in ob.data.vertices:
        nearest=source.find_nearest(v.co)
        rgba[v.index]=palette[colours[nearest[2]]] if nearest[2] is not None else palette[0]
    # Vertex interpolation softens the colour boundary instead of assigning
    # a ragged white/coral boundary to individual remeshed triangles.
    edges=np.array([tuple(e.vertices) for e in ob.data.edges],dtype=np.int32)
    for _ in range(4):
        total=rgba.copy();count=np.ones((len(rgba),1),dtype=np.float32)
        np.add.at(total,edges[:,0],rgba[edges[:,1]]);np.add.at(total,edges[:,1],rgba[edges[:,0]])
        np.add.at(count,edges[:,0],1);np.add.at(count,edges[:,1],1)
        rgba=rgba*.35+(total/count)*.65
    colour=ob.data.color_attributes.new(name='SculptColor',type='FLOAT_COLOR',domain='POINT')
    colour.data.foreach_set('color',rgba.ravel())
    material=surface(label+' colour',(1,1,1),.28)
    bs=next(n for n in material.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    node=material.node_tree.nodes.new('ShaderNodeVertexColor');node.layer_name='SculptColor'
    material.node_tree.links.new(node.outputs['Color'],bs.inputs['Base Color'])
    ob.data.materials.clear();ob.data.materials.append(material)
    for face in ob.data.polygons: face.material_index=0;face.use_smooth=True
    ob.select_set(False)


# Dolphin: curved continuous body, pale ventral strip, melon, expressive beak.
controls=[(-2.30,.98,6.41),(-2.71,1.02,6.76),(-2.94,1.03,7.30),(-2.88,1.03,7.87),(-2.64,1.04,8.40),(-2.34,1.03,8.63)]
points=path(controls,36)
widths=np.interp(np.linspace(0,1,36),[0,.14,.35,.57,.8,1],[.08,.19,.39,.50,.49,.19])
verts=[];uv=[];ns=28
for j,p in enumerate(points):
    d=(points[min(j+1,35)]-points[max(0,j-1)]).normalized()
    u=Vector((d.z,0,-d.x)).normalized();v=Vector((0,-1,0))
    for k in range(ns):
        a=TAU*k/ns
        verts.append(p+float(widths[j])*(u*math.cos(a)+v*math.sin(a)*.78))
        uv.append((k/ns,j/35))
faces=[(j*ns+k,j*ns+(k+1)%ns,(j+1)*ns+(k+1)%ns,(j+1)*ns+k) for j in range(35) for k in range(ns)]
faces += [tuple(reversed(range(ns))),tuple(range(35*ns,36*ns))]
dolphin=mesh('Dolphin continuous curved body',verts,faces,'Dolphin',True,uv)
dolphin.data.materials.append(M['Belly'])
for f in dolphin.data.polygons:
    k=f.index%ns
    if 1<=k<=5: f.material_index=1
dolphin_skin=sculpt_head('Dolphin',(-2.56,.96,8.42),1,[
    (-.40,.04,.10,.09,-.11,0),(-.24,.29,.34,.20,-.01,0),
    (-.03,.40,.43,.22,.025,0),(.16,.37,.41,.17,.005,.025),
    (.35,.27,.16,.12,-.055,.25),(.61,.19,.10,.08,-.015,.18),
    (.76,.12,.075,.04,.005,.055),
    (.83,.025,.025,.02,.005,0)],'Dolphin','Belly')
seated_eye(dolphin_skin,-2.37,8.66,.143,1,'Dolphin')
fuse_skin('Dolphin unified sculpt',[
    'Dolphin continuous curved body','Dolphin sculpted upper head','Dolphin integrated lower jaw'])
# Dorsal fin on the left silhouette, one forward pectoral and a rear fin.
fin('Dolphin dorsal fin',[(-3.17,7.92),(-3.51,8.02),(-3.61,8.37),(-3.34,8.30),(-2.98,8.14)],1.04,.10,'Dolphin')
fin('Dolphin near pectoral flipper',[(-2.75,7.88),(-2.97,7.85),(-3.30,7.43),(-3.19,7.38),(-2.87,7.56),(-2.67,7.77)],.60,.10,'Dolphin')
fin('Dolphin far pectoral flipper',[(-2.53,7.82),(-2.35,7.62),(-2.21,7.31),(-2.43,7.39),(-2.64,7.64)],1.19,.07,'Dolphin')
fin('Dolphin left tail fluke',[(-2.32,6.51),(-2.59,6.56),(-2.94,6.39),(-2.85,6.20),(-2.54,6.19),(-2.27,6.38)],.95,.09,'Dolphin')
fin('Dolphin right tail fluke',[(-2.31,6.48),(-2.12,6.65),(-1.91,6.62),(-1.91,6.45),(-2.11,6.23),(-2.30,6.32)],.95,.09,'Dolphin')
# Small blowhole is pigment-like geometry sitting flush on the melon.
sphere('Dolphin blowhole',(-2.58,1.00,8.877),(.037,.058,.008),'Teal',16,8)

# Shrimp, equally tall and substantial. Six overlapping curled abdominal plates.
shrimp_path=path([(2.78,1.02,8.00),(3.06,1.04,7.64),(3.12,1.04,7.17),(2.94,1.04,6.77),(2.59,1.03,6.55),(2.19,1.03,6.64)],48)
verts=[];uv=[];ns=28
for j,p in enumerate(shrimp_path):
    d=(shrimp_path[min(j+1,47)]-shrimp_path[max(j-1,0)]).normalized()
    u=Vector((d.z,0,-d.x)).normalized();v=Vector((0,-1,0))
    r=float(np.interp(j/47,[0,.2,.4,.6,.8,1],[.36,.36,.32,.27,.19,.095]))
    # A small lip and recessed seam articulate the six plates without separate beads.
    phase=j%8
    r*=1.04 if phase in (0,1) else .94 if phase==7 else 1.0
    for k in range(ns):
        a=TAU*k/ns
        verts.append(p+r*(u*math.cos(a)+v*math.sin(a)*.82));uv.append((k/ns,j/47))
faces=[(j*ns+k,j*ns+(k+1)%ns,(j+1)*ns+(k+1)%ns,(j+1)*ns+k) for j in range(47) for k in range(ns)]
faces += [tuple(reversed(range(ns))),tuple(range(47*ns,48*ns))]
abdomen=mesh('Shrimp continuous six-segment abdomen',verts,faces,'Coral',True,uv)
abdomen.data.materials.append(M['Peach']);abdomen.data.materials.append(M['Shell'])
for face in abdomen.data.polygons:
    j=face.index//ns;k=face.index%ns
    face.material_index=1 if j%8==0 or k<6 else 0
sphere('Shrimp thorax',(2.73,1.03,8.08),(.43,.34,.61),'Coral',28,18)
shrimp_skin=sculpt_head('Shrimp',(2.62,.97,8.40),-1,[
    (-.34,.065,.13,.12,-.08,0),(-.16,.27,.34,.24,.035,0),
    (0,.365,.39,.25,.035,0),(.17,.34,.34,.17,-.005,.035),
    (.32,.275,.19,.11,-.09,.25),(.49,.16,.115,.07,-.11,.16),
    (.58,.025,.025,.025,-.08,0)],'Coral','Peach')
# Rostrum projecting left with small dorsal points gives a shrimp silhouette.
fin('Shrimp swept rostrum',[(2.54,8.78),(2.26,8.91),(2.03,8.93),(2.20,8.81),(2.45,8.73)],.94,.07,'Coral')
seated_eye(shrimp_skin,2.47,8.64,.146,-1,'Coral')
fuse_skin('Shrimp unified sculpt',[
    'Shrimp continuous six-segment abdomen','Shrimp thorax',
    'Shrimp sculpted upper head','Shrimp integrated lower jaw'])
for k in range(3):
    ctr=[(2.39+k*.045,.91+k*.075,8.82),(2.22-k*.15,.88,9.24+k*.14),(1.74-k*.17,.89,9.52+k*.08),(1.20-k*.18,.9,9.43-k*.04)]
    tube('Shrimp long arching antenna',path(ctr,32),[.029*(1-.8*i/31) for i in range(32)],'Coral',6)
for k in range(2):
    tube('Shrimp short antennule',path([(2.21,.77,8.76),(1.95,.73,8.96+k*.13),(1.63,.76,9.02+k*.14)],20),[.018*(1-.70*i/19) for i in range(20)],'Peach',5)
for k in range(4):
    zz=8.15-k*.20
    tube('Shrimp near walking leg',path([(2.59,.76,zz),(2.30,.61,zz-.15),(2.15,.56,zz-.37),(2.02,.57,zz-.40)],16),[.027*(1-.4*i/15) for i in range(16)],'Shell',6)
# Two modest chelipeds, not lobster-sized fists.
for side in (-1,1):
    start=(2.60+side*.24,.96,8.18)
    elbow=(2.66+side*.58,.83,8.08)
    hand=(2.67+side*.70,.77,8.55)
    tube('Shrimp waving cheliped',path([start,elbow,hand],20),.045,'Coral',7)
    sphere('Shrimp pincer palm',hand,(.10,.08,.18),'Peach',16,10)
    hx,hy,hz=hand
    for s in (-1,1):
        tube('Shrimp small pincer',path([(hx+s*.065,hy,hz+.07),(hx+s*.115,hy,hz+.24),(hx+s*.05,hy,hz+.37)],15),[.065*(1-.82*i/14) for i in range(15)],'Coral',7)
for k in range(3):
    ob=sphere('Shrimp tail fan petal',(2.02-k*.11,1.00,6.64+(k-1)*.18),(.29,.09,.16),'Coral' if k%2 else 'Peach',18,12)
    ob.rotation_euler.y=(k-1)*.5

print('Character sculpts complete',flush=True)

# --- Mirrored S-shaped open flumes. The owner allowed removal of duplicate heads. ---
for side,mat in ((-1,'Blue flume glaze'),(1,'Coral flume glaze')):
    controls=[(side*2.64,.69,3.60),(side*2.23,.18,3.31),(side*1.84,-.48,2.74),
              (side*1.96,-1.22,2.00),(side*1.62,-1.98,1.39),(side*1.10,-2.42,1.11)]
    pts=path(controls,64); ns=15;verts=[];uv=[]
    for j,p in enumerate(pts):
        d=(pts[min(j+1,63)]-pts[max(j-1,0)]).normalized()
        across=Vector((-d.y,d.x,0)).normalized()
        for k in range(ns):
            a=-PI*.49+PI*.98*k/(ns-1)
            # Broad U-shaped trough; no pinching or disconnected rim at the exit.
            verts.append(p+across*(.38*math.sin(a))+Vector((0,0,.33*(1-math.cos(a)))))
            uv.append((k/(ns-1),j/63*3))
    faces=[(j*ns+k,(j+1)*ns+k,(j+1)*ns+k+1,j*ns+k+1) for j in range(63) for k in range(ns-1)]
    ob=mesh('Blue sweeping flume' if side<0 else 'Coral sweeping flume',verts,faces,mat,True,uv)
    mod=ob.modifiers.new('Fibreglass shell thickness','SOLIDIFY');mod.thickness=.055;mod.offset=-1
    for k in (0,ns-1):
        tube('Smooth rolled slide lip',[verts[j*ns+k] for j in range(64)],.032,'Belly' if side<0 else 'Shell',7)
    # Sheen is baked into the glaze texture; no second surface can cross the trough.
    splash(side*1.10,-2.44,1.085,.41)
    # Launch arch replaces a character head with a small shell/wave portal.
    tube('Open flume launch arch',[(side*2.64+.46*math.cos(a),.77,3.61+.46*math.sin(a)) for a in np.linspace(0,PI,24)],.075,'Timber',7)
    for zz,yy,xx in ((2.0,-.7,2.0),(2.65,.1,2.25)):
        beam('Slide support',(side*xx,yy,.16),(side*xx,yy,zz),.09,'Timber')


def umbrella(x,y,z,r,accent):
    beam('Parasol timber pole',(x,y,z),(x,y,z+1.76),.035,'Timber')
    # Twelve curved cloth gores; each bulges between ribs, scalloped silhouette.
    for k in range(12):
        verts=[]
        for j in range(6):
            t=j/5
            for q in range(5):
                f=q/4;a=TAU*(k+f)/12
                rr=r*t
                zz=z+1.76-.46*t**.65-.07*math.sin(PI*f)*t*t
                verts.append((x+rr*math.cos(a),y+rr*math.sin(a),zz))
        faces=[(j*5+q,j*5+q+1,(j+1)*5+q+1,(j+1)*5+q) for j in range(5) for q in range(4)]
        mesh('Striped scalloped parasol',verts,faces,accent if k%2 else 'Cream',True)
        tube('Parasol hem',[verts[25+q] for q in range(5)],.015,'Cream',5)
    sphere('Parasol brass finial',(x,y,z+1.80),(.07,.07,.07),'Brass',12,8)


def chair(x,y,z,accent):
    for side in (-1,1):
        beam('Lounge chair runner',(x+side*.28,y-.40,z+.03),(x+side*.28,y+.32,z+.68),.035)
        beam('Lounge chair crossed leg',(x+side*.28,y+.32,z+.03),(x+side*.28,y-.24,z+.36),.035)
        beam('Lounge chair arm',(x+side*.34,y-.12,z+.51),(x+side*.34,y+.22,z+.58),.037)
    for k in range(7):
        xx=x-.25+k*.083
        mesh('Lounge canvas stripe',[(xx,y-.32,z+.32),(xx+.078,y-.32,z+.32),(xx+.078,y+.09,z+.38),(xx,y+.09,z+.38),
             (xx,y+.12,z+.37),(xx+.078,y+.12,z+.37),(xx+.078,y+.36,z+.92),(xx,y+.36,z+.92)],[(0,1,2,3),(4,5,6,7)],accent if k%2==0 else 'Cream')
    pillow=box('Lounge small cushion',(x,y+.22,z+.62),(.38,.09,.20),accent,.06);pillow.rotation_euler.x=-.35


for s,accent in ((-1,'Dolphin'),(1,'Coral')):
    cx=s*3.57;cy=-1.72
    umbrella(cx,cy+.18,1.67,.89,accent)
    for dx in (-.59,.59): chair(cx+dx,cy-.30,1.67,accent)
    cylinder('Round cafe table',(cx,cy-.53,2.18),.31,.08,'Deck',24)
    beam('Cafe table stem',(cx,cy-.53,1.66),(cx,cy-.53,2.14),.045,'Timber')
    for dx in (-.09,.09):
        cylinder('Little cafe mug',(cx+dx,cy-.53,2.29),.038,.12,'Cream',10)
    # Wave/seafood emblems on lounge fascia.
    if s<0:
        tube('Blue lounge wave emblem',path([(cx-.6,-2.98,1.24),(cx-.25,-3.08,1.10),(cx+.14,-3.07,1.25),(cx+.55,-2.98,1.18)],24),.043,'Aqua',6)
    else:
        tube('Shrimp lounge emblem',path([(cx+.29,-3.01,1.3),(cx+.39,-3.02,1.09),(cx+.19,-3.06,.99),(cx-.15,-3.07,1.14)],24),.058,'Coral',7)

# Shell canopy behind right lounge: arched lobes, open to the front.
for k in range(9):
    a=PI*.08+PI*.84*(k+.5)/9
    cx=3.58+math.cos(a)*.91;zz=1.78+math.sin(a)*1.38
    ob=sphere('Scallop canopy lobe',(cx+.36,-.58,zz),(.24,.44,.69),'Peach' if k%2 else 'Coral',20,12)
    ob.rotation_euler.y=PI/2-a
    tube('Scallop canopy pale rib',path([(3.94,-.80,1.80),(3.94+math.cos(a)*.75,-.88,1.78+math.sin(a)*1.13),(3.94+math.cos(a)*1.14,-.81,1.78+math.sin(a)*1.70)],15),.026,'Shell',5)

# Smaller signs, sized to remain legible at the review camera.
for s,body in ((-1,'NO\nFISHING'),(1,'WATER\nWIGGLERS\nWELCOME.')):
    x=s*3.40;z=4.11
    board=box('Secondary hanging sign',(x,.52,z),(1.60,.11,1.08),'Ivory planks',.04)
    for xx in (x-.75,x+.75): beam('Sign edging',(xx,.443,z-.54),(xx,.443,z+.54),.04,'Timber')
    for xx in (x-.53,x+.53): tube('Sign hanging rope',[(xx,.55,z+.50),(xx,.59,z+.89)],.021,'Rope',5)
    if s<0:
        ring('No fishing prohibition',(x,.424,z-.31),.14,.022,'Coral','xz',24,5)
        beam('No fishing slash',(x-.10,.406,z-.21),(x+.10,.406,z-.41),.021,'Coral',5)
    lantern(s*4.29,.71,4.84,.78)


def palm(x,y,z,scale=1):
    pts=path([(x,y,z),(x+.15*scale,y+.04,z+.7*scale),(x+.23*scale,y,z+1.6*scale)],12)
    tube('Leaning palm trunk',pts,[.095*scale*(1-.3*i/11) for i in range(12)],'Timber',9)
    top=pts[-1]
    for k in range(8):
        a=TAU*k/8
        spine=path([top,top+Vector((math.cos(a)*.44,math.sin(a)*.44,.32))*scale,top+Vector((math.cos(a)*1.02,math.sin(a)*1.02,-.15))*scale],9)
        verts=[]
        for j,p in enumerate(spine):
            w=math.sin(PI*j/8)*.20*scale
            side=Vector((-math.sin(a),math.cos(a),0))*w
            verts.extend([p-side,p+Vector((0,0,.018*scale)),p+side])
        faces=[]
        for j in range(8): faces.extend([(j*3,j*3+1,j*3+4,j*3+3),(j*3+1,j*3+2,j*3+5,j*3+4)])
        mesh('Palm frond',verts,faces,'Leaf light' if k%2 else 'Leaf',True)
    for k in range(3): sphere('Palm coconut',top+Vector((.09*math.cos(k*2),.09*math.sin(k*2),-.12))*scale,(.10*scale,.09*scale,.12*scale),'Timber',12,8)


palm(-4.38,2.23,1.67,1.20)
palm(4.56,.37,1.58,.84)
for x,y,z,s in ((-4.75,-.35,1.65,.9),(4.51,-.63,1.65,.8),(-2.78,-3.37,1.19,.8),(2.62,-3.18,1.22,.75),(-.92,-4.20,.63,.65),(-3.17,2.80,5.25,.70)):
    plant(x,y,z,s)
for x,y in ((-4.91,-2.58),(4.85,-2.20),(-1.63,-4.03),(1.43,-4.02)):
    for k in range(3): rock((x+random.uniform(-.24,.24),y+random.uniform(-.2,.2),.14),(.35,.29,.31))


def barrel(x,y,z,s=1):
    cylinder('Coopered barrel',(x,y,z+.27*s),.23*s,.54*s,'Timber',14,top=.215*s)
    for h in (.09,.43): ring('Barrel iron hoop',(x,y,z+h*s),.234*s,.021*s,'Iron',seg=20,sides=5)
    cylinder('Barrel lid',(x,y,z+.548*s),.213*s,.022*s,'Deck',14)
for p in ((1.18,-4.13,.39,.8),(-4.37,-.75,1.64,.9),(-3.92,1.14,3.55,.85),(.96,1.07,2.26,.7)):
    barrel(*p)

# Small seabird on the lighthouse, coral and starfish complete the silhouette details.
sphere('Seabird body',(tx-.02,ty,10.28),(.20,.09,.12),'Cream',18,10)
sphere('Seabird head',(tx-.19,ty-.01,10.37),(.095,.075,.10),'Cream',16,10)
beam('Seabird beak',(tx-.25,ty-.025,10.37),(tx-.39,ty-.025,10.33),.034,'Brass',6)
sphere('Seabird eye',(tx-.21,ty-.074,10.395),(.016,.01,.018),'Eye',8,6)
for xx in (tx-.06,tx+.06): beam('Seabird leg',(xx,ty,10.14),(xx,ty,10.24),.015,'Brass',5)
fin('Seabird tail',[(tx+.07,10.29),(tx+.36,10.37),(tx+.28,10.25)],ty,.045,'Cream')
for s in (-1,1):
    cx=s*4.47;cy=-2.21
    for k in range(5):
        end=(cx+(k-2)*.12,cy,2.12+.18*math.sin(k*2))
        tube('Branching coral',path([(cx,cy,1.69),(cx+(k-2)*.06,cy,1.91),end],12),[.043*(1-.63*i/11) for i in range(12)],'Coral',6)
for k in range(5):
    a=TAU*k/5
    beam('Starfish arm',(-.93,-3.98,1.02),(-.93+.17*math.cos(a),-3.99,1.02+.17*math.sin(a)),.037,'Coral',7)

print('Slides and nautical dressing complete',flush=True)

# Netting, vine growth and hardware use only enough mesh to follow the silhouette.
for s in (-1,1):
    verts=[];uv=[]
    for j in range(4):
        for k in range(7):
            u=k/6;v=j/3
            verts.append((s*(1.09+1.13*u),.65-.13*math.sin(PI*u),3.52-.25*math.sin(PI*u)-v*(.68+.10*math.sin(PI*u))))
            uv.append((u,v))
    faces=[(j*7+k,j*7+k+1,(j+1)*7+k+1,(j+1)*7+k) for j in range(3) for k in range(6)]
    mesh('Draped fishing net',verts,faces,net_material,False,uv)
    tube('Net top rope',[(p[0],p[1]-.01,p[2]+.01) for p in verts[:7]],.033,'Rope',5)
    for k in range(6):
        x=s*(.97+k*.22)
        sphere('Facade timber peg',(x,1.21,5.88),(.020,.018,.024),'Iron',8,5)
    for k in range(4):
        xx=s*(3.00+.17*k);zz=5.57-.18*k
        plant(xx,1.52,zz,.44)
# The outer tidal edge is broken by irregular stones and clusters of seaweed.
for k in range(16):
    a=TAU*k/16
    if abs(a-PI*1.5)<.38: continue
    x=5.04*math.cos(a);y=4.55*math.sin(a)
    rock((x,y,.13),(.28+random.random()*.19,.26+random.random()*.16,.26+random.random()*.21))
    for j in range(3):
        p=(x+(j-1)*.08,y,.11)
        tube('Seaweed at tide line',path([p,(p[0]+.10,y,.34),(p[0]-.05,y+.06,.55+random.random()*.15)],9),[.043*(1-i/10) for i in range(9)],'Algae',5)

def sign_decal(name,x,y,z,w,h,uv):
    return mesh(name,[(x-w/2,y,z-h/2),(x+w/2,y,z-h/2),(x+w/2,y,z+h/2),(x-w/2,y,z+h/2)],[(0,1,2,3)],sign_material,False,uv)


sign_decal('Main sign painted title',0,1.048,7.215,4.10,1.63,[(0,.5),(1,.5),(1,1),(0,1)])
sign_decal('No fishing painted title',-3.40,.448,4.11,1.54,1.05,[(0,0),(.5,0),(.5,.5),(0,.5)])
sign_decal('Water wigglers painted title',3.40,.448,4.11,1.54,1.05,[(.5,0),(1,0),(1,.5),(.5,.5)])
for ob in tower_parts:
    ob.location.z-=.70
for ob in asset.objects:
    if ob.name.startswith('Seabird'): ob.location.z-=.70

# --- Save authoring scene, render it, export a portable textured asset. ---
ground=box('Studio ground',(0,0,-.18),(200,200,.20),'Limestone',0)
put(ground,studio)
ground.data.materials.clear()
ground.data.materials.append(surface('Studio grey',(.19,.205,.22),.82))
world=bpy.data.worlds.new('Grey studio environment')
scene.world=world
bg=next(n for n in world.node_tree.nodes if n.type=='BACKGROUND')
bg.inputs['Color'].default_value=(.31,.36,.42,1)
bg.inputs['Strength'].default_value=.45


def aim(ob,where): ob.rotation_euler=(Vector(where)-ob.location).to_track_quat('-Z','Y').to_euler()


for name,pos,power,size,color in [
    ('Large warm key',(-8,-10,17),2200,8,(1,.85,.68)),
    ('Cool fill',(8,-4,11),1500,7,(.69,.86,1)),
    ('Soft rim',(2,8,15),2300,6,(1,.81,.62)),
]:
    light=bpy.data.lights.new(name,'AREA');light.energy=power;light.shape='DISK';light.size=size;light.color=color
    ob=bpy.data.objects.new(name,light);studio.objects.link(ob);ob.location=pos;aim(ob,(0,0,4))
cam=bpy.data.cameras.new('Reference composition camera');enum_set(cam,'type','ORTHO')
cam.ortho_scale=14.8
camera=bpy.data.objects.new('Reference composition camera',cam);studio.objects.link(camera)
camera.location=(5,-28,21);aim(camera,(0,.25,4.40));scene.camera=camera
try: scene.render.engine='CYCLES'
except TypeError: pass
scene.cycles.samples=40
scene.cycles.use_denoising=True
scene.render.resolution_x=1400;scene.render.resolution_y=1400;scene.render.resolution_percentage=100
enum_set(scene.render.image_settings,'file_format','PNG')
scene.render.image_settings.color_mode='RGBA'
scene.render.film_transparent=False
try: scene.view_settings.view_transform='AgX'
except TypeError: pass
scene.view_settings.exposure=.65
# Pack original textures so the .blend is self-contained.
bpy.ops.file.pack_all()
scene.render.filepath=str(ROOT/'flipper-shrimp-ca.png')
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            area.spaces.active.region_3d.view_perspective='CAMERA'
            area.spaces.active.overlay.show_overlays=False
            area.spaces.active.shading.type='MATERIAL'

deps=bpy.context.evaluated_depsgraph_get()
triangles=0;objects=0;all_coords=[]
for ob in asset.objects:
    if ob.type not in ('MESH','FONT','CURVE'): continue
    ev=ob.evaluated_get(deps);me=ev.to_mesh();me.calc_loop_triangles()
    triangles+=len(me.loop_triangles);objects+=1
    all_coords.extend([ob.matrix_world@Vector(p) for p in ob.bound_box])
    ev.to_mesh_clear()
coords=np.array(all_coords)
report={
    'revision':2,
    'revision_changes':[
        'Unified rounded mascot heads and bodies, recessed mouths, fitted eyes and eyelids.',
        'Interpolated vertex colour softens mascot skin boundaries without extra texture geometry.',
        'Corrected upward flume normals; removed intersecting water strips; sheen is a texture.',
        'Moved right shell canopy clear of the slide; opened launch arches; cleared waterfall sheets.',
    ],
    'blender_version':bpy.app.version_string,
    'authoring_objects':objects,'evaluated_triangles':triangles,
    'materials':len({slot.material for ob in asset.objects for slot in ob.material_slots}),
    'authoring_dimensions':(coords.max(axis=0)-coords.min(axis=0)).tolist(),
    'reference':'Owner-selected C plus A; owner supplied reference image',
    'differences':['Duplicate dolphin and shrimp slide heads omitted with owner authorization.','Water is a static textured surface in this asset; no animation or simulation.'],
    'surface_strategy':'Reusable original image base-color and tangent-space normal maps for wood, decking, plaster, roof shingles, stone, rope, caustics and waterfall streaks. No concept-image projection.',
    'runtime_status':'Standalone asset, not integrated into the game. Runtime frame cost unmeasured.',
}
(ROOT/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'flipper-shrimp-ca.blend'),compress=True)
print('SAVED',json.dumps(report),flush=True)
bpy.ops.render.render(write_still=True)
print('RENDERED',flush=True)

# The glTF exporter handles image-based Principled materials, including normals.
bpy.ops.object.select_all(action='DESELECT')
for ob in asset.objects: ob.select_set(True)
bpy.context.view_layer.objects.active=next(ob for ob in asset.objects if ob.type=='MESH')
bpy.ops.object.convert(target='MESH')
# Join by material at export so the hundreds of authoring parts are not scene nodes.
bpy.ops.object.join()
joined=bpy.context.object;joined.name='Flipper and Shrimp C+A'
span=max(coords.max(axis=0)[:2]-coords.min(axis=0)[:2])
scale=.86/span
joined.scale=(scale,scale,scale)
bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
bpy.ops.export_scene.gltf(filepath=str(ROOT/'flipper-shrimp-ca.glb'),export_format='GLB',use_selection=True,export_apply=True)
report['gltf_footprint']=.86
report['gltf_bytes']=(ROOT/'flipper-shrimp-ca.glb').stat().st_size
(ROOT/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
print('EXPORTED',report['gltf_bytes'],flush=True)

# Remove coincident pole vertices, then make a separate lighter export.
# The editable source and full-resolution GLB are retained.
bm=bmesh.new();bm.from_mesh(joined.data)
bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-7)
bmesh.ops.dissolve_degenerate(bm,edges=list(bm.edges),dist=1e-8)
bm.to_mesh(joined.data);bm.free()
mod=joined.modifiers.new('Lighter presentation mesh','DECIMATE')
mod.ratio=.48;mod.use_collapse_triangulate=True
allowed={v.identifier for v in mod.bl_rna.properties['delimit'].enum_items}
if 'MATERIAL' in allowed: mod.delimit={'MATERIAL'}
bpy.context.view_layer.objects.active=joined
bpy.ops.object.modifier_apply(modifier=mod.name)
joined.data.calc_loop_triangles()
report['lighter_export_triangles']=len(joined.data.loop_triangles)
bpy.ops.export_scene.gltf(filepath=str(ROOT/'flipper-shrimp-ca-light.glb'),export_format='GLB',use_selection=True,export_apply=True)
report['lighter_export_bytes']=(ROOT/'flipper-shrimp-ca-light.glb').stat().st_size
(ROOT/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
print('LIGHTER EXPORT',report['lighter_export_triangles'],flush=True)
