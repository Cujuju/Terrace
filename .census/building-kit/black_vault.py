"""Black Vault geometry and atlas paint following selected Ricks concept B."""
import math
import bpy
import numpy as np

BRICK_SIZE_FACTOR = .70
BRICK_WIDTH = 1.02 * BRICK_SIZE_FACTOR
BRICK_HEIGHT = .53 * BRICK_SIZE_FACTOR


def weather_noise(a,b,frequency,seed=0):
    a=a*frequency; b=b*frequency
    ax=np.floor(a); by=np.floor(b); u=a-ax; v=b-by
    u=u*u*(3-2*u); v=v*v*(3-2*v)
    def sample(x,y):
        value=np.sin(x*127.1+y*311.7+seed*74.7)*43758.5453
        return value-np.floor(value)
    return (sample(ax,by)*(1-u)+sample(ax+1,by)*u)*(1-v)+(sample(ax,by+1)*(1-u)+sample(ax+1,by+1)*u)*v


def build(low, g):
    box, beam, solid = g['box'], g['beam'], g['solid']
    palette = g['PALETTE']
    palette.update(concrete=(.43, .425, .39), coping=(.51, .50, .455),
                   graphite=(.19, .195, .185), trim=(.245, .25, .235),
                   recess=(.075, .083, .073), green=(.40, .62, .105),
                   amber=(1., .65, .10), red=(.96, .035, .018),
                   stripe=(.78, .55, .08), plaque=(.185, .188, .173),
                   lettering=(.87,.835,.733), gold=(.886,.667,.125), steps=(.52,.51,.47))

    def octagon(w, d, corner, z):
        return [(-w+corner, -d, z), (w-corner, -d, z), (w, -d+corner, z),
                (w, d-corner, z), (w-corner, d, z), (-w+corner, d, z),
                (-w, d-corner, z), (-w, -d+corner, z)]

    def frustum(bottom, top, kind, label, caps=True):
        n = len(bottom)
        faces = [tuple(reversed(range(n))), tuple(range(n, n*2))] if caps else []
        faces += [(i, (i+1)%n, (i+1)%n+n, i+n) for i in range(n)]
        solid(bottom+top, faces, kind, label=label)

    def oct_slab(w, d, corner, z, height, kind, label, caps=True):
        frustum(octagon(w, d, corner, z), octagon(w, d, corner, z+height), kind, label, caps)

    def ring(w, d, corner, z, height, thickness, kind, label):
        a, b = octagon(w, d, corner, z), octagon(w, d, corner, z+height)
        ia, ib = octagon(w-thickness, d-thickness, corner*.8, z), octagon(w-thickness, d-thickness, corner*.8, z+height)
        for i in range(8):
            j = (i+1)%8
            solid([a[i], a[j], b[j], b[i], ia[i], ia[j], ib[j], ib[i]],
                  [(0,1,2,3),(7,6,5,4),(0,4,5,1),(3,2,6,7),(0,3,7,4),(1,5,6,2)], kind, label=label)

    def prism(profile, y, depth, kind, label, **meta):
        n = len(profile)
        coords = [(x, yy, z) for yy in (y-depth/2, y+depth/2) for x, z in profile]
        faces = [tuple(reversed(range(n))), tuple(range(n, n*2))]
        faces += [(i, (i+1)%n, (i+1)%n+n, i+n) for i in range(n)]
        solid(coords, faces, kind, label=label, **meta)

    def cylinder(x, y, z, radius, height, kind, top=None, sides=8, label='Roof drum', caps=True):
        upper = radius if top is None else top
        a = [(x+radius*math.cos(i*math.tau/sides+math.pi/8), y+radius*math.sin(i*math.tau/sides+math.pi/8), z) for i in range(sides)]
        b = [(x+upper*math.cos(i*math.tau/sides+math.pi/8), y+upper*math.sin(i*math.tau/sides+math.pi/8), z+height) for i in range(sides)]
        frustum(a, b, kind, label, caps)

    def lettering(text,font_path,cx,z,width,height,y,kind,sloped=False):
        curve=bpy.data.curves.new('Ricks lettering','FONT')
        curve.body=text; curve.font=bpy.data.fonts.load(font_path)
        curve.resolution_u=2 if low else 4; curve.extrude=.002
        ob=bpy.data.objects.new('Ricks lettering',curve); bpy.context.collection.objects.link(ob)
        bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active=ob
        bpy.ops.object.convert(target='MESH'); ob=bpy.context.object
        vv=np.array([v.co[:] for v in ob.data.vertices]); lo=vv.min(axis=0); hi=vv.max(axis=0)
        scale=min(width/(hi[0]-lo[0]),height/(hi[1]-lo[1]))
        x=(vv[:,0]-(lo[0]+hi[0])/2)*scale+cx
        zz=(vv[:,1]-(lo[1]+hi[1])/2)*scale+z
        yy=np.full(len(vv),y)-vv[:,2]*scale
        if sloped: yy=-4.01+(zz-.18)*(.74/2.32)-.075-vv[:,2]*scale
        solid(np.column_stack((x,yy,zz)),[tuple(p.vertices) for p in ob.data.polygons],kind,label='Raised '+text+' lettering')
        mesh=ob.data; bpy.data.objects.remove(ob,do_unlink=True); bpy.data.meshes.remove(mesh)

    oct_slab(4.9, 4.0, .65, 0, .18, 'graphite', 'Grounded octagonal footing')
    # Front shell is split around the recessed doorway.
    bottom, top = octagon(4.84, 3.94, .64, .18), octagon(4.04, 3.20, .52, 2.50)
    for i in range(8):
        j = (i+1)%8
        spans = [(0, 1)] if i else [(0, .325), (.675, 1)]
        for left, right in spans:
            a = np.array(bottom[i])*(1-left)+np.array(bottom[j])*left
            b = np.array(bottom[i])*(1-right)+np.array(bottom[j])*right
            c = np.array(top[i])*(1-right)+np.array(top[j])*right
            d = np.array(top[i])*(1-left)+np.array(top[j])*left
            inner = np.array([0, .24, 0]) if i==0 else -np.array([(a[0]+b[0])*.055, (a[1]+b[1])*.055, 0])
            solid([a,b,c,d,a+inner,b+inner,c+inner,d+inner],
                  [(0,1,2,3),(7,6,5,4),(0,4,5,1),(3,2,6,7),(0,3,7,4),(1,5,6,2)], 'concrete', label='Sloped concrete wall')
    oct_slab(4.055,3.215,.52,2.46,.12,'graphite','Clerestory lower sill',caps=False)
    oct_slab(4.025,3.185,.52,2.57,.38,'green','Continuous green window band',caps=False)
    ring(4.07,3.23,.53,2.55,.075,.11,'trim','Window lower frame')
    ring(4.07,3.23,.53,2.90,.07,.11,'trim','Window upper frame')
    perimeter = octagon(4.06,3.22,.53,2.73)
    for i in range(8):
        a, b = np.array(perimeter[i]), np.array(perimeter[(i+1)%8])
        count = max(1, round(np.linalg.norm(b-a)/.65))
        for k in range(count):
            p = a+(b-a)*k/count
            if i==0 and abs(p[0])<1.5: continue
            box(p,(.09,.09,.40),'graphite',label='Clerestory mullion')
    ring(4.17,3.33,.56,2.97,.18,.22,'coping','Heavy octagonal roof cornice')
    oct_slab(4.01,3.17,.50,3.13,.08,'graphite','Flat graphite roof deck')
    ring(4.02,3.18,.51,3.20,.035,.055,'trim','Fine roof perimeter seam')

    def buttress(x, y, axis=0):
        profile=[(-.25,0),(.25,0),(.24,.30),(.04,1.04),(-.18,2.72),(-.30,3.13),(-.57,3.13),(-.43,2.62),(-.24,.98)]
        coords=[]
        for offset in (-.20,.20):
            for depth,z in profile:
                coords.append((x+offset,y-depth,z) if axis==0 else (x+depth,y+offset,z))
        n=len(profile)
        solid(coords,[tuple(reversed(range(n))),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)],'coping',label='Stepped concrete buttress')

    for x in (-1.56,1.56): buttress(x,-3.91)
    for side in (-1,1):
        # Long dark ribs follow the actual wall slope, with concrete shoulders.
        for y in (-2.15,1.65):
            a=(side*4.90,y,.18); b=(side*4.10,y,2.98)
            beam(a,b,.36,.18,kind='coping',bevel=False,label='Side wall buttress')
            beam((side*4.93,y,.24),(side*4.13,y,2.94),.21,.12,kind='graphite',bevel=False,label='Inset dark buttress face')
        beam((side*4.17,-3.99,.20),(side*3.49,-3.33,2.97),.28,.25,kind='coping',bevel=False,label='Chamfer corner pilaster')

    box((0,-3.125,1.73),(2.66,.20,2.64),'graphite',label='Recessed entrance back wall')
    door_profile=[(-1.07,.55),(1.07,.55),(1.07,1.82),(.87,2.08),(-.87,2.08),(-1.07,1.82)]
    prism(door_profile,-3.29,.15,'trim','Chamfered door surround')
    prism([(x*.89,.59+(z-.55)*.91) for x,z in door_profile],-3.385,.07,'recess','Door dark gasket')
    for side in (-1,1):
        profile=[(side*.025,.59),(side*.90,.59),(side*.90,1.77),(side*.72,1.94),(side*.025,1.94)]
        prism(profile,-3.43,.06,'graphite','Armored double door leaf')
        box((side*.18,-3.48,1.14),(.05,.075,.32),'trim',label='Door handle')
        if not low:
            for z in (.83,1.61): box((side*.85,-3.48,z),(.09,.055,.08),'trim',label='Door hinge')
    box((0,-3.255,2.63),(2.70,.25,.76),'trim',label='Ricks sign frame')
    box((0,-3.398,2.63),(2.49,.05,.60),'plaque',label='Ricks nameplate')
    lettering('Ricks','C:/Windows/Fonts/seguisb.ttf',0,2.63,2.04,.45,-3.43,'lettering')
    box((0,-3.47,2.17),(.76,.13,.15),'trim',label='Amber lintel light frame')
    box((0,-3.548,2.17),(.64,.025,.067),'amber',label='Emissive amber lintel light')
    for side in (-1,1):
        box((side*1.24,-3.39,1.13),(.15,.13,.41),'trim',label='Entry lamp casing')
        box((side*1.24,-3.47,1.13),(.070,.035,.29),'amber',label='Emissive amber entry light')
    for i in range(5):
        h=.11*(i+1)
        front=-4.57+i*.19
        box((0,-4.38+i*.19,h/2),(2.56,.38,h),'steps',label='Five entrance stair treads',step_front=front,step_top=h)
    box((0,-3.47,.565),(2.14,.33,.045),'stripe',label='Hazard-striped threshold')

    def wall_panel(x,z,w,h,kind,label,**meta):
        offset=.05 if kind in ('plaque','amber') else .035
        def point(xx,zz): return (xx,-4.01+(zz-.18)*(.74/2.32)-offset,zz)
        front=[point(x-w/2,z-h/2),point(x+w/2,z-h/2),point(x+w/2,z+h/2),point(x-w/2,z+h/2)]
        back=[(xx,yy+.055,zz) for xx,yy,zz in front]
        solid(front+back,[(0,1,2,3),(7,6,5,4),(0,4,5,1),(3,2,6,7),(0,3,7,4),(1,5,6,2)],kind,label=label,**meta)

    wall_panel(2.79,1.53,1.25,1.25,'trim','Biohazard plaque frame')
    wall_panel(2.79,1.53,1.14,1.14,'plaque','Gold biohazard plaque')
    lettering('\u2623','C:/Windows/Fonts/seguisym.ttf',2.79,1.53,.98,1.01,0,'gold',sloped=True)
    for x in (-4.05,4.05):
        wall_panel(x,.33,.22,.23,'trim','Lower amber marker casing')
        wall_panel(x,.33,.145,.15,'amber','Emissive amber ground marker')
    for x in (-1.56,1.56):
        box((x,-4.20,.26),(.22,.10,.24),'trim',label='Buttress marker casing')
        box((x,-4.26,.26),(.14,.025,.155),'amber',label='Emissive buttress marker')
    wall_panel(-2.88,1.27,.60,.58,'recess','Front wall ventilation recess')
    for z in np.linspace(1.05,1.48,4 if low else 6): wall_panel(-2.88,float(z),.51,.042,'trim','Front vent louver')
    def side_panel(side,y,z,w,h,kind,label):
        offset=.055 if kind in ('amber','trim') else .025
        coords=[(side*(4.84-(zz-.18)*(.80/2.32)+offset),yy,zz) for yy,zz in ((y-w/2,z-h/2),(y+w/2,z-h/2),(y+w/2,z+h/2),(y-w/2,z+h/2))]
        face=(0,1,2,3) if side==1 else (3,2,1,0)
        solid(coords,[face],kind,label=label)
    for side in (-1,1):
        for yy in (-.35,2.70):
            side_panel(side,yy,.55,.24,.26,'graphite','Side marker casing')
            side_panel(side,yy,.55,.14,.15,'amber','Emissive side marker')
        side_panel(side,.33,1.15,.74,.65,'recess','Side wall ventilation recess')
        for z in np.linspace(.91,1.39,4 if low else 6): side_panel(side,.33,float(z),.65,.045,'trim','Side vent louver')

    for cx,cy in ((-1.70,-.88),(1.70,-.88),(0,1.48)):
        drum_start=len(g['vertices'])
        cylinder(cx,cy,3.21,1.25,.13,'trim',label='Octagonal drum footing')
        cylinder(cx,cy,3.34,1.23,.40,'graphite',top=1.08,label='Heavy drum collar',caps=False)
        cylinder(cx,cy,3.74,1.075,.67,'green',top=.71,label='Eight tapered emissive green panes',caps=False)
        cylinder(cx,cy,4.41,.77,.105,'trim',label='Octagonal drum cap rim')
        cylinder(cx,cy,4.515,.705,.035,'graphite',label='Dark solid drum top')
        for k in range(8):
            angle=k*math.tau/8+math.pi/8
            co,si=math.cos(angle),math.sin(angle)
            a=(cx+1.255*co,cy+1.255*si,3.26)
            b=(cx+1.105*co,cy+1.105*si,3.79)
            c=(cx+.775*co,cy+.775*si,4.43)
            beam(a,b,.105,.12,kind='trim',bevel=not low,label='Heavy drum radial collar rib')
            beam(b,c,.062,.077,kind='graphite',bevel=False,label='Tapered window glazing bar')
            angle_mid=angle+math.pi/8
            co_mid,si_mid=math.cos(angle_mid),math.sin(angle_mid)
            tangent=np.array([-si_mid,co_mid,0])
            center=np.array([cx+1.075*co_mid,cy+1.075*si_mid,3.52])
            a=center-tangent*.32+np.array([co_mid*.04,si_mid*.04,-.12])
            b=center+tangent*.32+np.array([co_mid*.04,si_mid*.04,-.12])
            c=center+tangent*.27+np.array([-co_mid*.04,-si_mid*.04,.12])
            d=center-tangent*.27+np.array([-co_mid*.04,-si_mid*.04,.12])
            solid([a,b,c,d],[(0,1,2,3)],'trim',label='Inset drum collar panel')
            if not low:
                box((cx+1.105*co,cy+1.105*si,3.77),(.095,.095,.07),'trim',label='Collar rib fastener')
        drum=np.array(g['vertices'][drum_start:])
        drum[:,:2]=(drum[:,:2]-np.array([cx,cy]))*1.10+np.array([cx,cy])
        g['vertices'][drum_start:]=drum.tolist()

    for x,y,s in ((-3.40,-2.30,.38),(3.43,-2.28,.34),(-3.41,1.88,.33),(3.44,1.88,.35),(0,-2.53,.43)):
        box((x,y,3.23),(s+.09,s+.11,.05),'trim',label='Roof vent flashing')
        box((x,y,3.40),(s,s,.32),'graphite',label='Roof vent housing')
        box((x,y,3.58),(s+.065,s+.065,.045),'trim',label='Roof vent cap')
        for z in (3.31,3.39,3.47): box((x,y-s/2-.014,z),(s*.76,.027,.03),'recess',label='Roof vent louver')
    cylinder(.85,-2.66,3.21,.10,.12,'graphite',sides=8,label='Beacon socket')
    cylinder(.85,-2.66,3.33,.065,.21,'red',sides=8,label='Emissive red status beacon')
    cylinder(.85,-2.66,3.54,.065,.024,'red',top=.041,sides=8,label='Red beacon lens cap')

    vertices=np.array(g['vertices'])
    fit=8.6/max(np.ptp(vertices[:,0]),np.ptp(vertices[:,1]))
    g['vertices'][:]=(vertices*fit).tolist()

    def surface(pos,ch):
        p=pos/fit; x,y,z=p.T; kind=ch['kind']; count=len(p)
        color=np.array(palette[kind]); height=np.zeros(count)
        wave=np.sin(x*8.1+y*11.7+z*13.1)*np.sin(x*17.3-y*12.2+z*9.7)
        broad=np.sin(x*2.4+z*1.7)*np.sin(y*2.1-z*3.6)
        if kind=='green':
            clouds=.78+.16*np.sin(x*9+y*7+z*11)*np.sin(y*12-z*6)+.12*np.sin(x*21-z*13)
            highlight=.08*np.maximum(0,np.sin(x*12+y*7))**12
            rgb=np.clip(color*clouds[:,None]+highlight[:,None],0,1)
            return rgb,height,np.full(count,.30)
        if kind in ('amber','red','gold','lettering'): return np.tile(color,(count,1)),height,np.full(count,.55)
        if kind=='stripe':
            stripe=((x+y)*2.5)%1>.47
            return np.where(stripe[:,None],color,np.array(palette['graphite'])),height,np.full(count,.85)
        if kind=='steps':
            worn=weather_noise(x,y+z,5.1,7)
            if ch['n'][2]>.8:
                distance=y-ch['step_front']
                nosing=np.exp(-(distance/.029)**2)
                rear_dirt=np.exp(-((distance-.19)/.035)**2)
                traffic=np.exp(-(x/.66)**2)
                shade=1.01+.17*nosing-.12*rear_dirt+.055*traffic+.05*(worn-.5)
            elif ch['n'][1]<-.8:
                under_lip=np.exp(-((ch['step_top']-z)/.026)**2)
                shade=.66-.13*under_lip+.06*(worn-.5)
            else:
                shade=.78+.04*(worn-.5)
            return np.clip(color*np.broadcast_to(shade,(count,))[:,None],0,1),.0005*(worn-.5),np.full(count,.92)
        mult=1+.022*wave+.035*broad
        rough=np.full(count,.82 if kind in ('trim','graphite','recess') else .94)
        if kind in ('concrete','coping'):
            a=y if abs(ch['n'][0])>.6 else x
            b=y if ch['n'][2]>.8 else z
            row=np.floor(b/BRICK_HEIGHT)
            column=a/BRICK_WIDTH+(row%2)*.5
            u=column%1; v=(b/BRICK_HEIGHT)%1
            edge=np.minimum.reduce((u,1-u,v,1-v))
            pores=weather_noise(a,b,11.0,3)
            mottling=weather_noise(a,b,3.6,9)
            joint=np.exp(-(edge/(.018+.022*pores))**2)
            chipped=np.exp(-(edge/.073)**2)*np.maximum(0,pores-.43)
            variation=.08*np.sin(np.floor(column)*19.17+row*17.31)
            streaks=np.maximum(0,.58-weather_noise(a,b*.085,4.0,4))
            damp=.17*np.exp(-np.maximum(z,0)/.48)*(.55+.45*mottling)
            chalk=np.maximum(0,mottling-.57)*.22
            mult=1+variation+.17*(mottling-.5)+.045*(pores-.5)-.23*joint+.10*chipped-.17*streaks-damp+chalk
            height=.0006*(pores-.5)-.0035*joint-.0012*chipped
            rough=np.clip(.91+.05*joint+.03*pores,.88,1)
        if kind=='graphite' and ch['n'][2]>.9:
            u=(x/1.1)%1; v=(y/1.1)%1
            joint=np.maximum(np.exp(-(np.minimum(u,1-u)/.014)**2),np.exp(-(np.minimum(v,1-v)/.014)**2))
            mult-=.12*joint; height-=.0008*joint
        return np.clip(color*mult[:,None],0,1),height,rough

    def emission(pos,ch,color):
        return color if ch['kind'] in ('green','amber','red') else np.zeros_like(color)

    g['custom_surface']=surface
    g['emissive_surface']=emission
    g['EMISSION_STRENGTH']=1.6
    g['TEXTURE_PROVENANCE']='Original weathered masonry with block width and height reduced 30 percent; mottling, chipped joints and ground grime. Shaded step risers and worn tread edges. Original graphite, green glass and emissive paint; raised Ricks lettering and biohazard glyph. No concept pixels used.'
    placement={'front_gltf':'+Z','origin':'Footprint centered in X; construction origin at ground Y=0',
               'deliberate_difference':'Rear elevation extrapolated from front-right concept. Three octagonal drums, window belt, recessed doors, five stairs, concrete slope and plaque retained. Low omits collar fasteners and simplifies vent louvers; envelope identical.'}
    return 'Original Black Vault geometry authored after owner-selected Ricks concept B; no third-party mesh.',placement
