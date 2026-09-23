"""Original Crimson Cabaret geometry, after the owner's selected concept D."""
import bpy, math, numpy as np
from pathlib import Path

def build(low, g):
    box, beam, solid = g['box'], g['beam'], g['solid']
    palette = g['PALETTE']
    palette.update(timber=(.73,.64,.48), wall=(.39,.13,.14), gable=(.39,.13,.14),
                   roof=(.235,.245,.25), door=(.34,.255,.175), stone=(.39,.375,.34),
                   dark=(.10,.065,.055), iron=(.16,.14,.13), canvas=(.48,.075,.105),
                   velvet=(.39,.035,.065), gold=(.72,.55,.29), glass=(.78,.43,.20), lanternglass=(.84,.18,.09),
                   sign=(92/255,24/255,32/255))
    paint = {}
    for key in ('front','side','awning'):
        image = bpy.data.images.load(str(Path(__file__).parent/'cabaret-paint'/(key+'.png')))
        image.colorspace_settings.name = 'Non-Color'
        paint[key] = np.array(image.pixels[:],float).reshape(image.size[1],image.size[0],4)[::-1,:,:3].copy()
        bpy.data.images.remove(image)

    def painted_surface(pos, ch):
        if ch['kind']=='glass':
            zlo=ch['points'][:,2].min(); zhi=ch['points'][:,2].max()
            height=np.clip((pos[:,2]-zlo)/max(zhi-zlo,.01),0,1)
            factor=.65+.35*np.sin(height*math.pi)
            return np.array(palette['glass'])*factor[:,None],np.zeros(len(pos)),np.full(len(pos),.75)
        if ch['kind'] != 'sign': return None
        pos=pos/np.array([fitx,fity,1.])+center
        key=ch.get('paint','front'); bounds=ch['paint_bounds']; axis=0 if key!='side' else 1
        uv=np.column_stack(((pos[:,axis]-bounds[0])/(bounds[1]-bounds[0]),
                            1-(pos[:,2]-bounds[2])/(bounds[3]-bounds[2])))
        im=paint[key]; h,w=im.shape[:2]
        xx=np.clip((uv[:,0]*(w-1)).astype(int),0,w-1); yy=np.clip((uv[:,1]*(h-1)).astype(int),0,h-1)
        correct = ch['n'][0]>.8 if key=='side' else ch['n'][1]<-.8
        color=im[yy,xx] if correct else np.tile(palette['sign'],(len(pos),1))
        return color,np.zeros(len(pos)),np.full(len(pos),.9)
    g['custom_surface']=painted_surface

    def prism(profile,y,depth,kind,label,**meta):
        n=len(profile); coords=[(x,yy,z) for yy in (y-depth/2,y+depth/2) for x,z in profile]
        faces=[tuple(reversed(range(n))),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
        solid(coords,faces,kind,label=label,**meta)

    def cylinder(x,y,z,r,h,kind,top=None,n=None):
        n=n or (6 if low else 8); top=r if top is None else top
        coords=[(x+rr*math.cos(i*math.tau/n),y+rr*math.sin(i*math.tau/n),zz) for rr,zz in ((r,z-h/2),(top,z+h/2)) for i in range(n)]
        faces=[tuple(reversed(range(n))),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
        solid(coords,faces,kind,label=kind+' turned detail')

    def heart(x,y,z,size):
        contour=[(0,-.55),(-.48,-.08),(-.53,.25),(-.34,.45),(-.12,.43),(0,.25),(.12,.43),(.34,.45),(.53,.25),(.48,-.08)]
        prism([(x+a*size,z+b*size) for a,b in contour],y,.045,'gold','Heart frame')
        prism([(x+a*size*.73,z+b*size*.73) for a,b in contour],y-.03,.035,'velvet','Heart inset')

    def curtain(x,y,bottom,w,h,side):
        inner=x-side*w*.2; outer=x+side*w*.5
        profile=[(outer,bottom),(inner,bottom+.12),(x+side*w*.15,bottom+h*.43),
                 (inner,bottom+h),(outer,bottom+h)]
        prism(profile,y,.095,'velvet','Gathered velvet curtain')
        beam((x+side*w*.02,y-.07,bottom+h*.42),(outer,y-.07,bottom+h*.45),.06,kind='gold',bevel=False,label='Curtain tie')

    def front_window(x,z,w=1.55,h=2.20,upper=True):
        y=-2.69
        box((x,y,z),(w,.14,h),'dark',label='Deep window recess')
        box((x,y-.09,z),(w*.82,.075,h*.86),'glass',label='Warm amber glass')
        for sx in (-1,1):
            beam((x+sx*w*.54,y-.13,z-h*.54),(x+sx*w*.54,y-.13,z+h*.54),.15,label='Cream window jamb')
            curtain(x+sx*w*.38,y-.24,z-h*.49,w*.4,h*.98,sx)
        for zz in (z-h*.55,z+h*.55):beam((x-w*.62,y-.16,zz),(x+w*.62,y-.16,zz),.16,label='Window rail')
        beam((x,y-.18,z-h*.45),(x,y-.18,z+h*.45),.075,kind='door',bevel=False,label='Window mullion')
        if not low:beam((x-w*.41,y-.18,z),(x+w*.41,y-.18,z),.065,kind='door',bevel=False,label='Window transom')

    def lantern(x,y,z):
        box((x,y,z),(.23,.23,.40),'lanternglass',label='Red lantern glass')
        for dx in (-.15,.15):
            for dy in (-.15,.15):box((x+dx,y+dy,z),(.045,.045,.48),'iron',label='Lantern frame')
        cylinder(x,y,z+.32,.28,.20,'iron',top=.07,n=4)
        cylinder(x,y,z-.28,.19,.10,'iron',top=.15,n=4)
        beam((x,y+.19,z+.55),(x,y,z+.55),.065,kind='iron',bevel=False,label='Lantern bracket')

    # Construction units: 10 = one game world unit. Front is Blender -Y.
    box((0,.45,.18),(8.10,7.60,.36),'stone',label='Continuous grounded foundation')
    box((0,.53,2.18),(7.25,6.25,3.70),'wall',label='Crimson ground-floor cladding')
    box((0,.53,6.13),(7.25,6.25,3.80),'wall',label='Crimson upper-floor cladding')
    box((0,-3.18,.43),(8.10,2.03,.24),'door',grain=(1,0,0),label='Porch deck')
    box((0,-3.18,4.19),(8.10,2.03,.25),'door',grain=(1,0,0),label='Upper gallery floor')
    for z in (.62,4.12,7.98):
        box((0,-2.64,z),(7.60,.18,.20),'timber',label='Facade storey rail')
        for sx in (-1,1):box((sx*3.69,.53,z),(.17,6.48,.20),'timber',label='Side storey rail')
    for sx in (-1,1):
        for yy in (-2.57,3.62):beam((sx*3.60,yy,.43),(sx*3.60,yy,8.03),.23,label='Cream corner pilaster')
    # Two storeys of open porch columns, with readable square bases and caps.
    for xx in (-3.73,-1.30,1.30,3.73):
        for bottom,top in ((.55,3.94),(4.32,7.89)):
            beam((xx,-3.89,bottom),(xx,-3.89,top),.19,label='Gallery pillar')
            for zz in (bottom+.14,top-.10):box((xx,-3.89,zz),(.32,.32,.23),'timber',label='Column plinth or capital')
    for z in (4.38,5.48):box((0,-3.89,z),(7.69,.15,.15),'timber',grain=(1,0,0),label='Balcony rail')
    for a,b in ((-3.65,-1.40),(-1.20,1.20),(1.40,3.65)):
        for x in np.linspace(a,b,4 if low else 7)[1:-1]:
            if low:box((x,-3.89,4.95),(.09,.09,.95),'timber',label='Balcony spindle')
            else:
                cylinder(x,-3.89,4.76,.067,.51,'timber',top=.045,n=6)
                cylinder(x,-3.89,5.20,.047,.38,'timber',top=.078,n=6)
    for sx in (-1,1):
        for z in (4.38,5.48):box((sx*3.75,-3.24,z),(.14,1.43,.15),'timber',label='Gallery return rail')
        for yy in np.linspace(-3.74,-2.70,3 if low else 5):box((sx*3.75,yy,4.95),(.08,.08,.98),'timber',label='Return spindle')
    # Front porch rails leave the entrance clear.
    for sx in (-1,1):
        for z in (.78,1.72):box((sx*2.73,-3.91,z),(1.80,.14,.13),'timber',label='Ground porch rail')
        for xx in np.linspace(1.96,3.49,3 if low else 5):box((sx*xx,-3.91,1.24),(.09,.09,.84),'timber',label='Porch spindle')
    for i in range(3):
        box((0,-4.10+i*.22,.075*(i+1)),(2.40,.50,.15*(i+1)),'door',label='Grounded entrance step')
        box((0,-4.10+i*.22,.15*(i+1)+.013),(1.27,.50,.024),'canvas',label='Red carpet tread')
    for xx in (-2.45,0,2.45):front_window(xx,6.21,w=1.60,h=2.45)
    for xx in (-2.45,2.45):front_window(xx,2.37,w=1.65,h=2.30,upper=False)
    box((0,-2.68,1.89),(1.96,.14,2.72),'dark',label='Recessed saloon entry')
    for sx in (-1,1):
        outline=[(sx*.06,.81),(sx*.90,.81),(sx*.90,2.43),(sx*.58,2.29),(sx*.06,2.16)]
        prism(outline,-2.86,.11,'door','Swinging saloon door')
        for z in (1.05,2.05):box((sx*.48,-2.94,z),(.78,.07,.10),'gold',label='Door panel rail')
        for k in range(3 if low else 5):box((sx*.48,-2.95,1.26+k*.14),(.60,.035,.045),'timber',label='Door louvre')
        beam((sx*1.04,-2.84,.52),(sx*1.04,-2.84,3.25),.18,label='Entrance jamb')
        curtain(sx*.85,-2.98,.65,.45,2.52,sx)
    box((0,-2.84,3.24),(2.31,.22,.19),'timber',label='Saloon entry lintel')
    # Shallow window assemblies on each side wall.
    for sx in (-1,1):
        for yy in (-.6,2.1):
            for zz in (2.32,6.18):
                box((sx*3.69,yy,zz),(.10,1.23,1.97),'dark',label='Side window recess')
                box((sx*3.75,yy,zz),(.06,.98,1.72),'glass',label='Side amber glass')
                for dy in (-.67,.67):box((sx*3.80,yy+dy,zz),(.10,.12,2.13),'timber',label='Side window jamb')
                for dz in (-1.05,1.05):box((sx*3.80,yy,zz+dz),(.12,1.44,.13),'timber',label='Side window rail')
                for dy in (-.43,.43):box((sx*3.82,yy+dy,zz),(.07,.19,1.78),'velvet',label='Side velvet curtain')
    # Main roof: course relief, with a false front concealing its front gable.
    g['roof'](3.98,-2.86,3.92,9.54,8.08,5 if low else 7,2 if low else 4,.015,'Slate shingle roof')
    for yy in (-2.60,3.66):prism([(-3.59,8.03),(3.59,8.03),(0,9.49)],yy,.12,'wall','Closed roof gable')
    box((2.65,2.60,9.25),(.65,.70,2.10),'stone',label='Brick chimney')
    box((2.65,2.60,10.32),(.83,.88,.18),'stone',label='Chimney crown')
    box((2.65,2.60,10.42),(.43,.48,.025),'dark',label='Chimney flue')
    # Porch roof, above the upper gallery.
    for i in range(3 if low else 5):
        n=3 if low else 5; ya=-4.20+i*1.65/n; yb=ya+1.65/n+.015
        za=7.96+(ya+4.20)*.23; zb=7.96+(yb+4.20)*.23
        solid([(-4.08,ya,za),(4.08,ya,za),(4.08,yb,zb),(-4.08,yb,zb),(-4.08,ya,za-.07),(4.08,ya,za-.07),(4.08,yb,zb-.07),(-4.08,yb,zb-.07)],
              [(0,1,2,3),(7,6,5,4),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)],'roof',grain=(0,1,0),label='Gallery roof course')
    box((0,-4.20,7.93),(8.23,.17,.17),'timber',label='Gallery fascia')
    # Strong red awning with scalloped valance; balcony floor remains visible.
    solid([(-3.77,-2.88,4.10),(3.77,-2.88,4.10),(3.77,-4.20,3.59),(-3.77,-4.20,3.59),(-3.77,-2.88,4.03),(3.77,-2.88,4.03),(3.77,-4.20,3.52),(-3.77,-4.20,3.52)],
          [(0,1,2,3),(7,6,5,4),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)],'canvas',label='Crimson entrance canopy')
    scallop=[(-3.77,3.60),(3.77,3.60)]
    for x in np.linspace(3.77,-3.77,25):scallop.append((x,3.27+.09*math.cos((x+3.77)*math.tau/.94)))
    prism(scallop,-4.21,.065,'sign','Painted canopy valance',paint='awning',paint_bounds=(-3.77,3.77,3.20,3.61))
    beam((-3.78,-4.25,3.61),(3.78,-4.25,3.61),.055,kind='gold',bevel=False,label='Canopy gold piping')
    # Shoulder wings and central arched false front.
    box((0,-2.95,9.74),(7.50,.22,2.65),'wall',label='Cabaret false-front wings')
    for sx in (-1,1):
        box((sx*3.66,-3.08,9.77),(.22,.22,2.95),'timber',label='False-front outer pilaster')
        box((sx*2.78,-3.09,11.11),(1.78,.19,.17),'timber',label='Shoulder cornice')
        heart(sx*2.87,-3.10,10.07,.83)
    profile=[(-2.05,8.66),(2.05,8.66),(2.05,11.61)]
    profile += [(2.05*math.cos(t),11.61+1.03*math.sin(t)) for t in np.linspace(0,math.pi,13 if not low else 9)[1:]]
    prism(profile,-3.10,.25,'sign','Arched cabaret sign',paint='front',paint_bounds=(-2.05,2.05,8.66,12.64))
    g['sweep']([(a[0],-3.27,a[1]) for a in profile[2:]],.12,kind='gold',bevel=False,label='Continuous arched sign frame')
    for sx in (-1,1):
        box((sx*2.07,-3.25,10.13),(.14,.15,2.94),'gold',label='Sign frame upright')
        cylinder(sx*2.07,-3.13,11.91,.16,.25,'gold',top=.055,n=6)
    box((0,-3.26,8.65),(4.24,.15,.13),'gold',label='Sign frame sill')
    # Side-wall sign centered between storeys, avoiding window surfaces.
    box((3.84,.60,4.38),(.10,4.58,1.32),'sign',label='Side painted saloon sign',paint='side',paint_bounds=(-1.69,2.89,3.72,5.04))
    for zz in (3.70,5.07):box((3.92,.60,zz),(.09,4.72,.075),'gold',label='Side sign rail')
    for x in (-3.37,3.37):
        for z in (2.86,6.87):lantern(x,-2.99,z)
    for x in (-1.34,1.34):lantern(x,-3.96,2.65)
    # Modest barrels and crates tucked inside the inherited footprint.
    for sx in (-1,1):
        cylinder(sx*3.36,-3.15,.91,.29,.75,'door',top=.26)
        for zz in (.62,1.16):cylinder(sx*3.36,-3.15,zz,.30,.055,'iron')
        if not low:
            box((sx*2.93,-3.15,.77),(.43,.46,.46),'door',label='Porch crate')
            beam((sx*2.74,-3.40,.57),(sx*3.11,-3.40,.97),.055,kind='timber',bevel=False,label='Crate brace')
    # Preserve previous Durand's X/Z envelope and ground origin; reduce obsolete sign height.
    verts=np.array(g['vertices']); lo=verts.min(axis=0); hi=verts.max(axis=0)
    fitx=8.240382075309754/(hi[0]-lo[0]); fity=8.500947952270508/(hi[1]-lo[1])
    center=np.array([(lo[0]+hi[0])/2,(lo[1]+hi[1])/2,lo[2]])
    g['vertices'][:]=((verts-center)*np.array([fitx,fity,1.])).tolist()
    placement={'front_gltf':'+Z','origin':'Inherited Durand\'s footprint center at ground',
               'deliberate_difference':'Original Crimson Cabaret replaces the giant freestanding dancer sign with an arched false-front cabaret emblem. X/Z footprint retained at 0.824038 x 0.850095; new roof/sign height about 1.27 rather than 2.060096 world units. No extra scene lights; amber glass and lantern colours are painted.'}
    return 'New original Blender geometry and procedural paint after owner-selected concept D (Crimson Cabaret). No old mesh, old textures or concept pixels reused.',placement
