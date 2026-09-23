"""Building designs in construction units (10 units = one Terrace world unit)."""
import bpy, bmesh, numpy as np, math, json
from pathlib import Path
KIT=Path(__file__).parent
NEW=['prehistoric-granary','roman-granary','medieval-dovecote','renaissance-workshop','industrial-pump-house']

def build(name,low,g):
    if name=='durands':
        from crimson_cabaret import build as build_cabaret
        return build_cabaret(low,g)
    box,beam,solid,roof=g['box'],g['beam'],g['solid'],g['roof']
    def cylinder(center,radius,height,kind='stone',top=None,sides=None):
        n=sides or (8 if low else 12); top=radius if top is None else top
        x,y,z=center
        coords=[(x+r*math.cos(i*math.tau/n),y+r*math.sin(i*math.tau/n),z+dz) for r,dz in [(radius,-height/2),(top,height/2)] for i in range(n)]
        faces=[tuple(reversed(range(n))),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
        solid(coords,faces,kind,label=kind+' polygonal course')
    def hip(cx,cy,w,d,z,h,kind='roof',rows=4):
        for i in range(rows):
            a=i/rows;b=(i+1)/rows
            s0=1-a;s1=max(.035,1-b)
            coords=[(cx+sx*w*s,cy+sy*d*s,z+h*f+lift) for s,f,lift in [(s0,a,0),(s1,b,.018)] for sx,sy in [(-1,-1),(1,-1),(1,1),(-1,1)]]
            solid(coords,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)],kind,label='Hipped roof course')
    def door(x,y,z,w,h):
        box((x,y,z+h/2),(w,.10,h),'dark',label='Recessed opening')
        box((x,y-.07,z+h*.48),(w*.76,.10,h*.94),'door',label='Inset door')
        for sx in (-1,1):beam((x+sx*w*.55,y-.10,z),(x+sx*w*.55,y-.10,z+h),.14,label='Door jamb')
        beam((x-w*.66,y-.10,z+h),(x+w*.66,y-.10,z+h),.18,label='Lintel')
    def windows(w,d,z):
        for sx in (-1,1):
            for yy in (-d*.5,d*.5):
                box((sx*(w+.025),yy,z),(.10,.65,.75),'dark',label='Window opening')
                for zz in (z-.4,z+.4):box((sx*(w+.09),yy,zz),(.16,.82,.12),'timber',label='Window rail')
                box((sx*(w+.10),yy,z),(.12,.075,.75),'timber',label='Window mullion')
    def gable(w,y,z,peak,kind):
        # A closed thin prism gives both elevations outward-facing normals.
        vertices=[]
        for yy in (y-.025,y+.025):vertices.extend([(-w,yy,z),(w,yy,z),(0,yy,peak)])
        solid(vertices,[(0,1,2),(5,4,3),(0,3,4,1),(1,4,5,2),(2,5,3,0)],kind,label='Closed gable')
    placement={}
    if name=='temple':
        base=20.; plinth=.9; course=2.6; inset=1.8
        box((0,0,plinth/2),(base,base,plinth),'stone',label='Original temple plinth')
        box((0,-10.9,.45),(5.2,1.8,.9),'stone',label='Grounded stair apron')
        for i in range(4):
            span=base-2*inset*i; bottom=plinth+course*i
            box((0,0,bottom+course/2),(span,span,course),'stone',label='Original terrace '+str(i+1))
            # Copings and dressed quoins stay inside the original silhouette.
            for sx in (-1,1):
                box((sx*(span/2-.15),0,bottom+course+.015),(.28,span-.02,.15),'plaster',label='Terrace coping')
                box((0,sx*(span/2-.15),bottom+course+.025),(span-.60,.28,.15),'plaster',label='Terrace coping')
                for sy in (-1,1):
                    box((sx*(span/2-.28),sy*(span/2-.28),bottom+course/2+.08),(.55,.55,course),'plaster',label='Dressed corner')
            count=6 if not low else 4
            tread=3.6/count
            for k in range(count):
                h=course*(k+1)/count
                box((0,-span/2-1.8+tread*(k+.5),bottom+h/2),(5.2,tread+.008,h),'plaster',label='Ascent tread')
            for sx in (-1,1):
                beam((sx*2.73,-span/2-1.62,bottom+.14),(sx*2.73,-span/2+1.63,bottom+course+.14),.25,kind='stone',label='Stair parapet')
        summit=11.3
        box((0,0,summit+2.35),(7.176,7.176,4.7),'stone',label='Summit shrine')
        for sx in (-1,1):
            for sy in (-1,1):box((sx*3.35,sy*3.35,summit+2.4),(.48,.48,4.8),'plaster',label='Shrine corner pier')
        door(0,-3.64,summit,2.45,3.85)
        box((0,0,16.16),(8.1,8.1,.32),'timber',grain=(1,0,0),label='Summit lintel band')
        hip(0,0,4.1,4.1,16.32,1.45,rows=4 if not low else 3)
        box((0,0,17.9),(.75,.75,.2),'plaster',label='Summit cap')
        for sx in (-1,1):
            box((sx*4.25,-10.02,1.9),(1.1,.10,1.65),'dark',label='Original lower portal')
        # Blender -Y entrance becomes glTF +X, matching the game temple.
        g['vertices'][:]=[(min(11.8,-y),x,z) for x,y,z in g['vertices']]
        for t in g['tags']:
            x,y,z=t['grain'];t['grain']=np.array([-y,x,z])
        placement={'front_gltf':'+X','origin':'Original plinth center at ground','original_bounds':{'min':[-1,0,-1],'max':[1.18,1.8,1]},'deliberate_difference':'Roof replaces upper shrine height; final height remains 1.8. Original four large steps subdivided into six (low four) treads. Apron unchanged.'}
        provenance='Improved original Terrace temple design; original terrace proportions retained, geometry rebuilt in Blender. No third-party art.'
    elif name in NEW or name=='timber-house':
        if name=='timber-house':
            box((0,0,.28),(5.4,8.5,.56),'stone',label='Stone footing')
            box((0,0,2.05),(4.9,7.9,3.0),'plaster',label='Plaster infill')
            for sx in (-1,1):
                for yy in (-3.87,0,3.87):beam((sx*2.5,yy,.5),(sx*2.5,yy,3.55),.24,label='Wall post')
                for zz in (.7,3.4):beam((sx*2.53,-3.97,zz),(sx*2.53,3.97,zz),.23,label='Wall rail')
                for yy in (-2.,2.):beam((sx*2.55,yy-.7,.8),(sx*2.55,yy+.7,3.28),.18,label='Diagonal brace')
            roof(2.85,-4.45,4.45,5.05,3.46,5,3 if low else 5,.03,'Cottage tiled roof')
            # Closed gable ends underneath the pitched roof.
            for yy in (-3.96,3.96):
                gable(2.45,yy,3.4,5.01,'plaster')
                beam((-2.48,yy,3.4),(0,yy,4.92),.18,label='Gable rafter');beam((0,yy,4.92),(2.48,yy,3.4),.18,label='Gable rafter')
            door(0,-4.02,.56,1.22,2.15);windows(2.45,3.9,2.1)
            box((1.6,1.8,4.1),(.7,.8,2.3),'stone',label='Chimney');box((1.6,1.8,5.27),(.88,.98,.15),'stone',label='Chimney crown')
            # Imported cottage envelope measured from its production GLB.
            placement={'front_gltf':'+X','origin':'Footprint center, ground','deliberate_difference':'New original timber-frame cottage replaces third-party imported design; fitted to measured imported bounds. No third-party mesh or texture used.'}
            provenance='New original Blender geometry and texture paint, replacing third-party CreativeTrio cottage without reusing it.'
        elif name=='prehistoric-granary':
            for xx in (-2.3,2.3):
                for yy in (-2.3,2.3):
                    cylinder((xx,yy,.85),.28,1.7,'timber',top=.22)
                    cylinder((xx,yy,1.55),.48,.22,'stone',top=.42)
            box((0,0,1.8),(5.4,5.4,.30),'timber',label='Raised platform')
            box((0,0,3.0),(4.6,4.6,2.2),'wall',label='Wattle grain store')
            for xx in (-2.35,2.35):
                for yy in (-2.35,2.35):beam((xx,yy,1.85),(xx,yy,4.2),.24,label='Store post')
            hip(0,0,3.,3.,4.15,2.0,'thatch',rows=5)
            door(0,-2.36,1.95,1.25,1.75)
            for sx in (-1,1):
                beam((sx*.62,-3.5,.04),(sx*.62,-2.4,2.3),.15,label='Ladder rail')
                box((sx*.62,-3.5,.04),(.17,.17,.08),'timber',label='Flat ladder foot')
            for i in range(5):beam((-.7,-3.4+i*.2,.24+i*.4),(.7,-3.4+i*.2,.24+i*.4),.13,label='Ladder rung')
        elif name=='roman-granary':
            box((0,0,.45),(5.6,8.6,.9),'stone',label='Ventilated raised base')
            box((0,0,2.4),(5.1,8.1,3.0),'plaster',label='Granary masonry')
            for sx in (-1,1):
                for yy in (-3.2,-1.1,1.1,3.2):
                    box((sx*2.68,yy,1.9),(.48,.42,3.8),'stone',label='External buttress')
                    box((sx*2.83,yy-.36,.47),(.08,.32,.32),'dark',label='Subfloor ventilation')
            roof(3.,-4.5,4.5,5.3,3.9,5,3 if low else 5,0,'Roman tile roof')
            for yy in (-4.06,4.06):gable(2.55,yy,3.86,5.22,'plaster')
            door(0,-4.1,.9,1.55,2.25)
            for i in range(3):box((0,-4.8+i*.2,.15*(i+1)),(2.1,.8,.3*(i+1)),'stone',label='Granary step')
        elif name=='medieval-dovecote':
            cylinder((0,0,.22),3.1,.44,'stone',sides=12)
            cylinder((0,0,2.75),2.8,5.1,'stone',top=2.6,sides=12)
            for z in (.55,3.8,5.22):cylinder((0,0,z),2.88,.16,'plaster',sides=12)
            hip(0,0,3.08,3.08,5.4,2.05,'roof',rows=5)
            box((0,0,7.55),(1.4,1.4,.65),'plaster',label='Louvred lantern')
            for zz in (7.42,7.68):box((0,-.72,zz),(1.1,.06,.12),'dark',label='Dove flight opening')
            hip(0,0,.95,.95,7.92,.85,'roof',rows=2)
            door(0,-2.82,.1,1.25,2.15)
            for xx in (-1.,0,1.):box((xx,-2.62,4.65),(.27,.09,.35),'dark',label='Pigeon hole')
        elif name=='renaissance-workshop':
            box((0,0,.25),(6.3,7.2,.5),'stone',label='Workshop footing')
            box((0,0,2.05),(5.7,6.6,3.1),'plaster',label='Ground workshop')
            box((0,0,4.75),(6.,6.9,2.3),'plaster',label='Jettied upper floor')
            for sx in (-1,1):
                for yy in (-3.43,0,3.43):beam((sx*3.,yy,3.62),(sx*3.,yy,5.93),.24,label='Upper post')
                for z in (3.6,5.9):beam((sx*3.05,-3.48,z),(sx*3.05,3.48,z),.24,label='Upper rail')
                beam((sx*3.05,-3.4,3.7),(sx*3.05,-.2,5.8),.2,label='Workshop brace')
            roof(3.45,-3.88,3.88,8.1,5.85,6,3 if low else 5,0,'Workshop roof')
            for yy in (-3.46,3.46):gable(3.,yy,5.82,8.03,'plaster')
            for xx in (-2.9,0,2.9):beam((xx,-3.49,3.62),(xx,-3.49,5.9),.20,label='Front upper frame')
            for zz in (3.65,5.85):beam((-3.0,-3.51,zz),(3.0,-3.51,zz),.20,label='Front upper rail')
            box((1.4,-3.51,4.72),(1.05,.08,.94),'dark',label='Workshop upper window')
            for zz in (4.22,5.22):box((1.4,-3.57,zz),(1.24,.13,.12),'timber',label='Window sill')
            box((1.4,-3.58,4.72),(.10,.12,.92),'timber',label='Window mullion')
            door(1.65,-3.35,.5,1.1,2.3)
            box((-.7,-3.38,1.9),(2.6,.14,1.55),'dark',label='Shop counter opening')
            box((-.7,-3.7,1.2),(2.9,.75,.16),'timber',label='Counter ledge')
            for xx in (-1.8,.4):beam((xx,-4.35,.05),(xx,-4.35,2.95),.14,label='Awning post')
            box((-.7,-3.9,3.0),(3.,1.35,.16),'canvas',label='Restrained shop awning')
            windows(3.,3.45,4.7)
        else:
            box((0,0,.3),(6.9,7.9,.6),'stone',label='Pump station footing')
            box((0,0,2.6),(6.3,7.3,4.6),'brick',label='Brick pump house')
            roof(3.6,-4.05,4.05,6.0,4.85,5,3 if low else 5,0,'Slate roof')
            for t in g['tags']:
                if t['kind']=='roof':t['kind']='slate'
            for yy in (-3.66,3.66):gable(3.15,yy,4.8,5.98,'brick')
            cylinder((2.55,2.6,4.5),.65,9.,'brick',top=.43,sides=8)
            rim=[(2.55+r*math.cos(i*math.tau/8),2.6+r*math.sin(i*math.tau/8),z) for z in (8.725,9.075) for r in (.61,.35) for i in range(8)]
            rimfaces=[]
            for i in range(8):
                j=(i+1)%8
                rimfaces.extend([(i,j,j+16,i+16),(i+8,i+24,j+24,j+8),(i+16,j+16,j+24,i+24),(i,i+8,j+8,j)])
            solid(rim,rimfaces,'brick',label='Open chimney crown')
            solid([(2.55+.35*math.cos(i*math.tau/8),2.6+.35*math.sin(i*math.tau/8),9.002) for i in range(8)],[tuple(range(8))],'dark',label='Recessed chimney flue')
            door(0,-3.7,.6,1.7,2.9)
            windows(3.15,3.65,2.8)
            box((0,-3.83,4.1),(2.3,.14,.33),'plaster',label='Stone lintel')
        if name!='timber-house':
            provenance='New original Blender geometry and procedural texture paint; no imported meshes or textures.'
            placement={'front_gltf':'+Z','origin':'Ground under footprint center','deliberate_difference':'New building: no existing gameplay envelope. Uniform fit inside 0.86 world-unit square; proposed asset only.'}
            verts=np.array(g['vertices']);verts[:,2]=np.maximum(verts[:,2],0)
            scale=.86/max(np.ptp(verts[:,:2],axis=0))
            g['vertices'][:]=(verts*scale*10).tolist()
        else:
            verts=np.array(g['vertices'])
            # Rotate from +Z entrance to the imported cottage +X orientation.
            verts=np.column_stack((-verts[:,1],verts[:,0],verts[:,2]))
            imported=json.loads((KIT/'imported-cottage-bounds.json').read_text())
            target=np.array(imported['max'])-np.array(imported['min']);dims=np.ptp(verts,axis=0)
            verts*=target/dims*10
            g['vertices'][:]=verts.tolist()
            for t in g['tags']:
                x,y,z=t['grain'];t['grain']=np.array([-y,x,z])
    else:
        source=json.loads((KIT/'source-inventory.json').read_text())[name]
        # Use the original first-party geometry as the authorized base.
        verts=np.array(source['vertices']);verts=np.column_stack((verts[:,0],-verts[:,2],verts[:,1]))*10
        colors=np.array(source['colors']);srgb=np.where(colors<=.0031308,12.92*colors,1.055*np.maximum(colors,0)**(1/2.4)-.055)
        def kind(rgb):
            r,gg,b=rgb
            rgb8=tuple(np.round(rgb*255).astype(int))
            if rgb8 in [(156,122,82),(135,104,63)]:return 'plaster'
            if rgb8==(201,180,140):return 'plaster'
            if rgb8==(216,85,31):return 'dark'
            if rgb8 in [(156,150,140),(139,139,134),(118,115,108),(141,135,129),(111,106,99)]:return 'cutstone'
            if rgb8 in [(58,36,22),(42,32,24),(42,26,16)]:return 'door'
            if max(rgb)<.26:return 'dark'
            if gg>r*1.08 and gg>b*1.15:return 'turf'
            if b>r*1.05:return 'slate' if name=='watchtower' else 'fish'
            if max(rgb)-min(rgb)<.13:return 'stone'
            if name=='durands' and r>gg*1.7:return 'paint'
            if r>gg*1.6 and r>.45:return 'roof'
            if r>.7 and gg>.55:return 'canvas' if name=='camp' else 'thatch'
            if r>.5 and gg>.37:return 'wall'
            return 'timber'
        kinds=list(g['PALETTE'])
        sourcefaces=source['faces']
        facekinds=[kind(c) for c in srgb]
        if name=='upturned-hull':facekinds=['wall' if k=='thatch' else k for k in facekinds]
        if name=='smoke-pit-hut':
            keep=[i for i,c in enumerate(srgb) if tuple(np.round(c*255).astype(int))!=(169,182,179)]
            sourcefaces=[sourcefaces[i] for i in keep];facekinds=[facekinds[i] for i in keep]
        if name=='durands':
            reject=set()
            for piece in source['pieces']:
                part=piece['part_index'];indices=range(piece['first_face'],piece['first_face']+piece['face_count'])
                if part in (21,22):reject.update(indices)
                chosen={0:'wall',1:'paint',2:'paint',3:'paint',4:'timber',5:'timber',6:'timber',8:'door',9:'door',10:'timber',11:'plaster',12:'plaster',13:'timber',14:'timber',15:'plaster',16:'plaster',17:'plaster',18:'plaster',19:'plaster',20:'plaster'}.get(part)
                if chosen:
                    for index in indices:facekinds[index]=chosen
            sourcefaces=[f for i,f in enumerate(sourcefaces) if i not in reject]
            facekinds=[k for i,k in enumerate(facekinds) if i not in reject]
        if name=='camp':
            flame=source['pieces'][1];start=flame['first_face'];end=start+flame['face_count']
            sourcefaces=[f for i,f in enumerate(sourcefaces) if not start<=i<end]
            facekinds=[k for i,k in enumerate(facekinds) if not start<=i<end]
        mesh=bpy.data.meshes.new('SourceBase');mesh.from_pydata(verts.tolist(),[],sourcefaces);mesh.update()
        for f,k in zip(mesh.polygons,facekinds):f.material_index=kinds.index(k)
        bm=bmesh.new();bm.from_mesh(mesh)
        bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00001)
        bmesh.ops.dissolve_degenerate(bm,edges=list(bm.edges),dist=.000001)
        bmesh.ops.dissolve_limit(bm,angle_limit=.001,verts=list(bm.verts),edges=list(bm.edges),delimit={'MATERIAL'})
        bm.normal_update()
        bmesh.ops.delete(bm,geom=[v for v in bm.verts if not v.link_faces],context='VERTS')
        # Join original door frames without overlapping coplanar surfaces.
        bm.verts.index_update()
        remaining=set(bm.verts);components=[];component_of={}
        while remaining:
            seed=min(remaining,key=lambda v:v.index);stack=[seed];remaining.remove(seed);members=[]
            while stack:
                v=stack.pop();members.append(v)
                for edge in v.link_edges:
                    other=edge.other_vert(v)
                    if other in remaining:remaining.remove(other);stack.append(other)
            ci=len(components);components.append(members)
            for v in members:component_of[v]=ci
        boxes=[]
        for members in components:
            coords=np.array([tuple(v.co) for v in members]);lo=coords.min(axis=0);hi=coords.max(axis=0);dim=hi-lo
            faces={f for v in members for f in v.link_faces}
            if all(len(e.link_faces)==2 for v in members for e in v.link_edges):
                bmesh.ops.recalc_face_normals(bm,faces=list(faces))
            if len(members)==8 and len(faces)==6 and all(max(abs(c) for c in f.normal)>.9999 for f in faces):
                boxes.append((members,lo,hi,dim))
            # Inset thin triangular gable ends behind roof-panel end faces.
            if len(faces)==5 and any(len(f.verts)==3 for f in faces) and dim[1]<.25 and min(dim[0],dim[2])>1:
                shift=.06 if (lo[1]+hi[1])<0 else -.06
                for v in members:v.co.y+=shift
        for members,lo,hi,dim in boxes:
            if dim[2]<max(dim[0],dim[1])*3:continue
            for _,otherlo,otherhi,otherdim in boxes:
                if otherdim[0]<otherdim[2]*3 or otherlo[2]<lo[2]+dim[2]*.65:continue
                if np.any(np.minimum(hi,otherhi)-np.maximum(lo,otherlo)<=.0001):continue
                if abs(hi[1]-otherhi[1])>.001 or abs(lo[1]-otherlo[1])>.001:continue
                for v in members:
                    if v.co.z>otherlo[2]:v.co.z=float(otherlo[2])
        bm.normal_update()
        # Bevel broad structural edges; low keeps the original coarse silhouette.
        edges=[e for e in bm.edges if len(e.link_faces)==2 and all(v.is_manifold for v in e.verts) and e.calc_length()>.4 and min(f.calc_area() for f in e.link_faces)>.15 and e.calc_face_angle()>.5]
        if not low and edges:
            bmesh.ops.bevel(bm,geom=edges,offset=.022,segments=1,affect='EDGES',clamp_overlap=True)
        if low and name=='durands':
            # Reduce round marquee/ornament tessellation while retaining outline.
            bm.to_mesh(mesh);bm.free()
            ob=bpy.data.objects.new('TemporaryLow',mesh);bpy.context.collection.objects.link(ob)
            bpy.context.view_layer.objects.active=ob;ob.select_set(True)
            mod=ob.modifiers.new('Silhouette simplification','DECIMATE');mod.ratio=.63
            bpy.ops.object.modifier_apply(modifier=mod.name)
            bm=bmesh.new();bm.from_mesh(mesh);bpy.data.objects.remove(ob,do_unlink=True)
        bm.verts.ensure_lookup_table();bm.verts.index_update()
        for f in bm.faces:
            # Triangulate only nonplanar faces before the uniform-density unwrap.
            if len(f.verts)>3 and max(abs((v.co-f.verts[0].co).dot(f.normal)) for v in f.verts)>.00001:
                pass
        nonplanar=[f for f in bm.faces if len(f.verts)>3 and max(abs((v.co-f.verts[0].co).dot(f.normal)) for v in f.verts)>.00001]
        if nonplanar:bmesh.ops.triangulate(bm,faces=nonplanar)
        bm.verts.index_update()
        g['vertices'].extend([tuple(v.co) for v in bm.verts])
        for f in bm.faces:
            g['polygons'].append(tuple(v.index for v in f.verts));g['tags'].append({'kind':kinds[f.material_index],'grain':np.array([0.,0.,1.])})
        g['parts'].append({'name':'Preserved original Terrace procedural base, coplanar merge and bevel improvements','first_face':0,'face_count':len(bm.faces)})
        bm.free();bpy.data.meshes.remove(mesh)
        # Additional real construction geometry; no floating overlays or noise.
        if name=='stilted-hut':
            for sx in (-1,1):beam((sx*2.1,-1.6,.08),(sx*2.1,1.6,1.88),.10,label='Added pile cross brace')
            box((0,-1.97,2.06),(1.3,.5,.18),'timber',label='Ramp landing connection')
        elif name=='windbreak-dome':
            box((0,-2.79,1.05),(1.3,.18,2.1),'dark',label='Visible entry recess')
            for xx in (-.76,.76):box((xx,-2.79,1.14),(.19,.4,2.28),'timber',label='Entry porch jamb')
            box((0,-2.79,2.23),(1.7,.4,.20),'timber',label='Entry porch lintel')
        elif name=='lashed-a-frame':
            for yy in (-2.60,2.60):
                for sx in (-1,1):beam((sx*2.9,yy,.10),(0,yy,6.22),.14,label='Covered gable edge')
            for yy in (-2.59,2.59):gable(2.9,yy,.04,6.22,'thatch')
        elif name=='drying-rack-long-hut':
            for yy in (-1.19,2.39):gable(3.04,yy,2.59,4.53,'thatch')
            for yy in (-1.29,2.49):box((0,yy,4.57),(.58,.10,.38),'timber',label='Closed ridge end')
        elif name=='stone-cottage':
            box((0,-2.55,.045),(1.7,.20,.09),'stone',label='Added threshold')
            beam((0,-2.6,8.65),(0,2.6,8.65),.32,label='Closed roof ridge')
            for yy in (-2.60,2.60):
                for sx in (-1,1):beam((sx*3.47,yy,5.48),(0,yy,8.63),.22,label='Closed roof verge')
            for yy in (-2.55,2.55):gable(3.44,yy,5.48,8.65,'stone')
            for yy in (-2.73,2.73):gable(.52,yy,8.05,8.74,'timber')
            box((0,-2.51,1.59),(1.10,.06,3.03),'door',label='Inset plank door')
            for xx in (-1.7,1.7):
                box((xx,-2.51,3.4),(.08,.08,.9),'timber',label='Window mullion')
                box((xx,-2.51,3.4),(.75,.08,.075),'timber',label='Window cross rail')
        elif name=='camp':
            solid([(-2.08,-2.30,.05),(-.52,-2.30,.05),(-1.3,-1.23,2.45)],[(0,1,2)],'dark',label='Visible triangular camp opening')
            for sx in (-1,1):beam((-1.3+sx*.80,-2.31,.05),(-1.3,-1.24,2.45),.06,kind='canvas',label='Hide opening edge')
            for dy in (-.13,.13):beam((1.75,-.6+dy,.25),(3.,-.6-dy,.25),.14,label='Cold hearth logs')
        elif name=='durands':
            # Typography is authored here, not taken from the old canvas texture.
            curve=bpy.data.curves.new('Original lettering','FONT');curve.body="DURAND'S";curve.align_x='CENTER';curve.size=.7;curve.extrude=.008;curve.resolution_u=2
            ob=bpy.data.objects.new('Lettering',curve);bpy.context.collection.objects.link(ob)
            ob.location=(0,-1.61,9.9);ob.rotation_euler=(math.pi/2,0,0)
            bpy.ops.object.select_all(action='DESELECT');ob.select_set(True);bpy.context.view_layer.objects.active=ob
            bpy.ops.object.convert(target='MESH');ob=bpy.context.object
            coords=[tuple(ob.matrix_world@v.co) for v in ob.data.vertices]
            solid(coords,[tuple(p.vertices) for p in ob.data.polygons],'plaster',label='Original DURANDS lettering')
            lettermesh=ob.data;bpy.data.objects.remove(ob,do_unlink=True);bpy.data.meshes.remove(lettermesh)
        # Preserve exact horizontal bounds, and repair small below-ground overshoot.
        verts=np.array(g['vertices']);old=np.array(source['bounds']['min']);hi=np.array(source['bounds']['max'])
        targetlo=np.array([old[0],-hi[2],0])*10;targethi=np.array([hi[0],-old[2],hi[1]])*10
        if name=='smoke-pit-hut':targethi[2]=6.55
        curlo=verts.min(axis=0);curhi=verts.max(axis=0)
        verts=(verts-curlo)/(curhi-curlo)*(targethi-targetlo)+targetlo
        g['vertices'][:]=verts.tolist()
        placement={'front_gltf':source['front'],'origin':'Original placement origin retained; ground contact corrected to zero','original_bounds':source['bounds'],'deliberate_difference':'Original silhouette and horizontal extents preserved. Broad edges chamfered in original; low uses coplanar simplification. Sub-ground source slivers corrected to Y=0.'}
        if name=='smoke-pit-hut':placement['deliberate_difference']+=' Static smoke bubbles removed; building height is 0.655 instead of 0.806 including smoke. Hearth is cold/unlit.'
        provenance='Improved original first-party Terrace procedural model from '+source['source']+'; not third-party geometry. New UVs and all texture maps authored in Blender pipeline.'
    return provenance,placement
