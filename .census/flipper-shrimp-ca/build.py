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
import importlib.util
from pathlib import Path
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

SOURCE_ROOT = Path(__file__).resolve().parent
ROOT = SOURCE_ROOT / 'revision-4'
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


def value_noise(u,v,frequency,seed):
    rng=np.random.default_rng(seed)
    grid=rng.random((frequency,frequency))
    xx=u*frequency;yy=v*frequency
    ix=np.floor(xx).astype(int);iy=np.floor(yy).astype(int)
    fx=xx-ix;fy=yy-iy;fx=fx*fx*(3-2*fx);fy=fy*fy*(3-2*fy)
    return ((1-fy)*((1-fx)*grid[iy%frequency,ix%frequency]+fx*grid[iy%frequency,(ix+1)%frequency])+
            fy*((1-fx)*grid[(iy+1)%frequency,ix%frequency]+fx*grid[(iy+1)%frequency,(ix+1)%frequency]))


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
        n = 1024 if pattern in ('water','stone','barnacles') else 512
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
            broad=value_noise(u,v,5,81);mid=value_noise(u,v,19,82)
            fine=value_noise(u,v,91,83);grit=value_noise(u,v,251,84)
            vein=np.exp(-((value_noise(u+.13*mid,v,9,85)-.49)/.025)**2)
            pits=np.clip((.31-fine)*7,0,1)
            h=.35+.27*mid+.09*fine+.035*grit-.10*pits+.025*vein
            rgb *= (.65+.40*broad+.21*mid+.10*(fine-.5))[...,None]
            rgb += vein[...,None]*np.array([.10,.085,.060])
            rgb -= pits[...,None]*np.array([.12,.115,.10])
            fleck=np.clip((grit-.72)*4,0,1)
            rgb += fleck[...,None]*.16
        elif pattern == 'barnacles':
            # Tileable circumference, vertically placed above the waterline.
            wet=np.clip((.8-v)*1.4,0,.65)
            h=.30+.025*grain+.035*value_noise(u,v,31,731)
            rgb *= (.83+.10*grain)[...,None]
            rgb=rgb*(1-wet[...,None]) + np.array([.13,.23,.18])*wet[...,None]
            rng=np.random.default_rng(247)
            for _ in range(195):
                cx=float(rng.uniform(0,1));cy=float(rng.beta(1.4,2.3)*.91)
                radius=float(rng.uniform(.011,.039))
                dx=np.mod(u-cx+.5,1)-.5;dy=(v-cy)*1.28
                r=np.sqrt(dx*dx+dy*dy)/radius;a=np.arctan2(dy,dx)
                rim=1+.06*np.sin(a*6+cx*40)
                mask=np.clip((rim-r)*130,0,1)
                hole=np.clip((.29-r)*75,0,1)
                ridges=.045*np.cos(a*12)
                shell_height=.23*np.clip(1-r,0,1)+.085*np.exp(-((r-.48)/.15)**2)+ridges*.13
                h=np.maximum(h,h+mask*(shell_height-.21*hole))
                shade=.67+.22*(1-r)+.10*np.cos(a*12)+.12*np.cos(a-2.0)
                shell=np.stack((shade*.98,shade*.91,shade*.73),axis=-1)
                shell=shell*(1-hole[...,None])+np.array([.11,.13,.105])*hole[...,None]
                rgb=rgb*(1-mask[...,None])+shell*mask[...,None]
        elif pattern == 'slide':
            # Water sheen is part of the flume material, with no intersecting overlay.
            wet=np.exp(-((u-.5)/.16)**4)
            streak=(.5+.5*np.sin(TAU*(u*31+.06*np.sin(TAU*v*3))))**10
            h=.5+.004*wet*np.sin(TAU*(u*22+.12*np.sin(TAU*v*2)))
            rgb += (wet*(.045+.045*streak))[...,None]*np.array([.7,1.,1.])
        elif pattern == 'rope':
            # Five wrapped courses and twisted fibres, all UV texture detail.
            course=.5+.5*np.cos(TAU*v*5)
            fibre=.5+.5*np.sin(TAU*(u*55-v*15))
            h=.24+.38*course+.055*fibre
            rgb *= (.58+.38*course+.10*fibre)[...,None]
        elif pattern in ('shell','shell_coral'):
            rib=.5+.5*np.cos(TAU*u*9)
            fine=.5+.5*np.cos(TAU*(u*90+.035*np.sin(TAU*v)))
            h=.3+.32*rib+.025*fine
            rgb *= (.79+.18*rib+.04*fine+.08*v)[...,None]
            if pattern=='shell_coral':
                crest=np.exp(-((np.mod(u*9+.5,1)-.5)/.06)**2)
                rgb=rgb*(1-crest[...,None]*.80)+np.array([1.,.81,.63])*crest[...,None]*.80
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
        strength=32 if pattern=='stone' else 22 if pattern=='barnacles' else 10 if pattern in ('rope','shell','shell_coral') else 3
        normal = np.stack((-gx*strength, -gy*strength, np.ones_like(h)), axis=-1)
        normal /= np.linalg.norm(normal, axis=-1)[..., None]
        nim = image_array(name+'-normal', normal*.5+.5, True)
        nn = mat.node_tree.nodes.new('ShaderNodeTexImage'); nn.image = nim
        nm = mat.node_tree.nodes.new('ShaderNodeNormalMap')
        mat.node_tree.links.new(nn.outputs['Color'], nm.inputs['Color'])
        mat.node_tree.links.new(nm.outputs['Normal'], bs.inputs['Normal'])
        if pattern in ('stone','barnacles'):
            roughness=np.clip(rough+.20*(.5-h),.45,.94)
            rim=image_array(name+'-roughness',np.repeat(roughness[...,None],3,axis=-1),True)
            rn=mat.node_tree.nodes.new('ShaderNodeTexImage');rn.image=rim
            mat.node_tree.links.new(rn.outputs['Color'],bs.inputs['Roughness'])
    return mat


M = {}
for key, color, rough, metal, emiss, pat in [
    ('Timber',(.44,.29,.16),.58,0,0,'wood'),
    ('Barnacled timber',(.44,.29,.16),.76,0,0,'barnacles'),
    ('Deck',(.58,.40,.24),.54,0,0,'planks'),
    ('Ivory planks',(.84,.77,.63),.60,0,0,'whitewood'),
    ('Limestone',(.57,.54,.45),.73,0,0,'stone'),
    ('Warm stone',(.70,.63,.51),.69,0,0,'stone'),
    ('Rope',(.67,.51,.30),.78,0,0,'rope'),
    ('Ivory shell relief',(.97,.85,.67),.43,0,0,'shell'),
    ('Coral shell relief',(.97,.46,.29),.38,0,0,'shell_coral'),
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
    ('Lamp', (1.,.64,.20),.24,0,6,None),
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

# Crossed narrow strips carry painted cylindrical shading and twisted fibre normals.
# They stay opaque and two-sided; no alpha sorting is needed for the ropes.
n=512
vv,uu=np.mgrid[0:n,0:n]/n
xx=uu*2-1
cord_twist=.5+.5*np.sin(TAU*(vv*8+uu*2))
cord_round=np.sqrt(np.clip(1-xx*xx,0,1))
cord_rgb=np.array([.71,.56,.35])*(.57+.38*cord_round+.10*cord_twist)[...,None]
rope_cord=surface('UV textured rope cord',(1,1,1),.78)
bs=next(n for n in rope_cord.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
node=rope_cord.node_tree.nodes.new('ShaderNodeTexImage');node.image=image_array('Rope cord-color',cord_rgb)
rope_cord.node_tree.links.new(node.outputs['Color'],bs.inputs['Base Color'])
normal=np.stack((xx*.65,.14*np.cos(TAU*(vv*8+uu*2)),np.maximum(.2,cord_round)),axis=-1)
normal/=np.linalg.norm(normal,axis=-1)[...,None]
node=rope_cord.node_tree.nodes.new('ShaderNodeTexImage');node.image=image_array('Rope cord-normal',normal*.5+.5,True)
nm=rope_cord.node_tree.nodes.new('ShaderNodeNormalMap')
rope_cord.node_tree.links.new(node.outputs['Color'],nm.inputs['Color'])
rope_cord.node_tree.links.new(nm.outputs['Normal'],bs.inputs['Normal'])


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
    if mat=='Rope': return rope_strip(name,points,radius)
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


def rope_strip(name,points,radius):
    points=[Vector(p) for p in points];verts=[];uv=[];faces=[]
    distance=0
    for j,p in enumerate(points):
        d=(points[min(j+1,len(points)-1)]-points[max(0,j-1)]).normalized()
        ref=Vector((0,0,1)) if abs(d.z)<.92 else Vector((0,1,0))
        a=d.cross(ref).normalized();b=d.cross(a).normalized()
        if j: distance+=(p-points[j-1]).length
        for vec in (a,b):
            verts.extend((p-vec*radius,p+vec*radius))
            uv.extend(((0,distance*3),(1,distance*3)))
        if j:
            for k in (0,2): faces.append(((j-1)*4+k,j*4+k,j*4+k+1,(j-1)*4+k+1))
    return mesh(name+' UV strips',verts,faces,rope_cord,True,uv)


def rope_wrap(name,x,y,z,r,height):
    verts=[];uv=[];sides=8
    for zz,v in ((z-height/2,0),(z+height/2,1)):
        for i in range(sides+1):
            a=TAU*i/sides;verts.append((x+r*math.cos(a),y+r*math.sin(a),zz));uv.append((i/sides,v))
    return mesh(name+' UV band',verts,[(i,i+1,i+sides+2,i+sides+1) for i in range(sides)],'Rope',True,uv)


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
        rope_wrap('Rope lashing',x,y,top-.23,r*1.10,.20)
    if bottom<.3:
        # Replace the old flat-green collar with a single texture-bearing sleeve.
        # Duplicated seam vertices keep the final cylinder face from stretching UVs.
        verts=[];uv=[];segments=16
        shift=(x*1.731+y*.793)%1
        for z in (.015,.89):
            for i in range(segments+1):
                a=TAU*i/segments
                verts.append((x+r*1.012*math.cos(a),y+r*1.012*math.sin(a),z))
                uv.append((i/segments+shift,(z-.015)/.875))
        faces=[(i,i+1,i+segments+2,i+segments+1) for i in range(segments)]
        mesh('Barnacle encrusted pier base',verts,faces,'Barnacled timber',True,uv)
    return ob


def rails(points,z,height=.68,piles=False):
    for x,y in points: post(x,y,0 if piles else z-.08,z+height)
    for (x,y),(xx,yy) in zip(points,points[1:]):
        beam('Handrail',(x,y,z+height-.06),(xx,yy,z+height-.06),.055,'Timber',8)
        for h in (.23,.48):
            tube('Sagging rope rail',path([(x,y,z+h),((x+xx)/2,(y+yy)/2,z+h-.09),(xx,yy,z+h)],4),.026,'Rope',4)


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
    # Individual stone UV offsets and scale prevent identical flecks on every block.
    offset=((loc[0]*1.731+loc[2]*.912)%1,(loc[1]*1.129+loc[2]*.717)%1)
    for loop in ob.data.uv_layers.active.data:
        loop.uv=(loop.uv.x*3.4+offset[0],loop.uv.y*3.4+offset[1])
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
    if abs(x)>2: rope_wrap('Facade rope wrap',x,1.35,4.38,.17,.23)
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


def shell_fan(name,center,width,height,depth,mat,angular=37):
    # One connected convex fan. Shallow corrugation carries the broad silhouette;
    # the fine ribs and pale crests are in base-color and tangent-space normal maps.
    x,y,z=center;verts=[(x,y,z)];uv=[(.5,0)];rings=3
    for row in range(1,rings+1):
        t=row/rings
        for k in range(angular):
            u=k/(angular-1);a=PI*(.05+.90*u)
            scallop=.955+.045*math.cos(TAU*u*9)
            radius=t*scallop
            bulge=depth*math.sin(PI*t*.80)*(.86+.14*math.cos(TAU*u*9))
            verts.append((x+width*radius*math.cos(a),y-bulge,z+height*radius*math.sin(a)))
            uv.append((u,t))
    faces=[(0,1+k,2+k) for k in range(angular-1)]
    for row in range(rings-1):
        for k in range(angular-1):
            a=1+row*angular+k;faces.append((a,a+angular,a+angular+1,a+1))
    boundary=[0]+[1+row*angular for row in range(rings)]
    boundary += [1+(rings-1)*angular+k for k in range(1,angular)]
    boundary += [1+row*angular+angular-1 for row in reversed(range(rings-1))]
    back=[]
    for i in boundary:
        p=verts[i];back.append(len(verts));verts.append((p[0],y+depth*.22,p[2]));uv.append(uv[i])
    faces.append(tuple(reversed(back)))
    for j,i in enumerate(boundary):
        k=(j+1)%len(boundary);faces.append((i,boundary[k],back[k],back[j]))
    ob=mesh(name,verts,faces,mat,True,uv)
    bm=bmesh.new();bm.from_mesh(ob.data);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(ob.data);bm.free()
    return ob


def scallop(center,r,mat='Shell',ribs=9):
    shell_fan('Textured scallop ornament',center,r*1.10,r*1.35,r*.14,'Ivory shell relief')
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


# The relief module replaces all volumetric mascot faces and eye geometry.
def fin(name,outline,front,thickness,mat):
    # Small lenticular ornament still used by the lighthouse seabird.
    n=len(outline);cx=sum(p[0] for p in outline)/n;cz=sum(p[1] for p in outline)/n
    verts=[(x,front,z) for x,z in outline]+[(cx,front-thickness,cz),(cx,front+thickness*.55,cz)]
    faces=[]
    for i in range(n): faces.extend([(i,(i+1)%n,n),((i+1)%n,i,n+1)])
    ob=mesh(name,verts,faces,mat,True)
    mod=ob.modifiers.new('Fin sculpt smoothing','SUBSURF');mod.levels=1;mod.render_levels=1
    return ob


_spec=importlib.util.spec_from_file_location('painted_reliefs',SOURCE_ROOT/'painted_reliefs.py')
_reliefs=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_reliefs)
mascot_report=_reliefs.create_reliefs(mesh,bevel,tube,path,surface,image_array)
print('Painted shallow relief mascots complete',flush=True)
# --- Mirrored S-shaped open flumes. The owner allowed removal of duplicate heads. ---
for side,mat in ((-1,'Blue flume glaze'),(1,'Coral flume glaze')):
    controls=[(side*2.64,.69,3.60),(side*2.23,.18,3.31),(side*1.84,-.48,2.74),
              (side*1.96,-1.22,2.00),(side*1.62,-1.98,1.39),(side*1.10,-2.42,1.11)]
    rows=28;pts=path(controls,rows);verts=[];uv=[]
    angles=np.linspace(-PI*.49,PI*.49,9)
    # A closed cross-section includes the rolled edges and underside in one mesh.
    profile=[(.38*math.sin(a),.33*(1-math.cos(a))) for a in angles]
    profile += [(.414,.345)]
    profile += [(.43*math.sin(a),.33*(1-math.cos(a))-.05*math.cos(a)) for a in reversed(angles)]
    profile += [(-.414,.345)]
    ns=len(profile)
    for j,p in enumerate(pts):
        d=(pts[min(j+1,rows-1)]-pts[max(j-1,0)]).normalized()
        across=Vector((-d.y,d.x,0)).normalized()
        for k,(xx,zz) in enumerate(profile):
            verts.append(p+across*xx+Vector((0,0,zz)))
            uv.append((k/8 if k<9 else (18-k)/8,j/(rows-1)*3))
    faces=[(j*ns+k,(j+1)*ns+k,(j+1)*ns+(k+1)%ns,j*ns+(k+1)%ns) for j in range(rows-1) for k in range(ns)]
    faces += [tuple(reversed(range(ns))),tuple(range((rows-1)*ns,rows*ns))]
    ob=mesh('Blue sweeping flume' if side<0 else 'Coral sweeping flume',verts,faces,mat,True,uv)
    ob.data.materials.append(M['Belly' if side<0 else 'Shell'])
    for face in ob.data.polygons:
        if face.index<(rows-1)*ns and face.index%ns in (8,9,18,19): face.material_index=1
    ob['trough_profile_sides']=ns;ob['inner_profile_edges']=8;ob['longitudinal_panels']=rows-1
    bm=bmesh.new();bm.from_mesh(ob.data);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(ob.data);bm.free()
    # Sheen is baked into the glaze texture; no second surface can cross the trough.
    splash(side*1.10,-2.44,1.085,.41)
    # Open landing: no arch or vertical member cuts through the trough entrance.
    # Supports meet the underside of the actual centreline, never pierce its floor.
    for j in (8,17):
        p=pts[j]
        beam('Slide support below trough',(p.x,p.y,.16),(p.x,p.y,p.z-.085),.09,'Timber')


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

# One closed shell fan replaces nine overlapping lobes and nine separate rib tubes.
shell_fan('Textured scallop canopy',(3.94,-.58,1.78),1.27,1.97,.38,'Coral shell relief',55)

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
part_counts={'slides_and_rims':0,'rope_details':0,'shell_decorations':0}
for ob in asset.objects:
    if ob.type not in ('MESH','FONT','CURVE'): continue
    ev=ob.evaluated_get(deps);me=ev.to_mesh();me.calc_loop_triangles()
    triangles+=len(me.loop_triangles);objects+=1
    group='slides_and_rims' if ob.name.startswith(('Blue sweeping flume','Coral sweeping flume','Smooth rolled slide lip')) else 'rope_details' if ob.name.startswith(('Rope lashing','Facade rope wrap','Sagging rope rail','Buoy suspension','Sign hanging rope','Net top rope')) else 'shell_decorations' if ob.name.startswith(('Scallop fan rib','Scallop canopy','Textured scallop')) else None
    if group: part_counts[group]+=len(me.loop_triangles)
    all_coords.extend([ob.matrix_world@Vector(p) for p in ob.bound_box])
    ev.to_mesh_clear()
coords=np.array(all_coords)
report={
    'revision':4,
    'revision_changes':[
        'Slides use 28 longitudinal samples and integrated closed rims instead of separate tubes.',
        'Suspended ropes use crossed opaque UV strips; wrapped ropes use eight-sided UV bands.',
        'Three connected shell fans replace overlapping lobes; fine ribs use color and normal maps.',
        'Painted mascots, rock and barnacle textures, and emissive lanterns preserved.',
    ],
    'blender_version':bpy.app.version_string,
    'authoring_objects':objects,'evaluated_triangles':triangles,
    'optimized_part_triangles':part_counts,
    'materials':len({slot.material for ob in asset.objects for slot in ob.material_slots}),
    'authoring_dimensions':(coords.max(axis=0)-coords.min(axis=0)).tolist(),
    'mascot_design':mascot_report,
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

# Keep export independently repeatable without regenerating or rendering the scene.
_export_spec=importlib.util.spec_from_file_location('export_asset',SOURCE_ROOT/'export_asset.py')
_export=importlib.util.module_from_spec(_export_spec);_export_spec.loader.exec_module(_export)
_export.export_asset(ROOT)
