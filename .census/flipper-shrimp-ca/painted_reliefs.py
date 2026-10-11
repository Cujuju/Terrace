"""Shallow carved mascots with image-painted features, used by build.py."""
import math
import numpy as np
import bmesh


def bezier(start, segments, steps=12):
    result = [tuple(start)]
    a = np.array(start, dtype=float)
    for controls in segments:
        b, c, d = np.array(controls, dtype=float).reshape(3, 2)
        for t in np.linspace(0, 1, steps + 1)[1:]:
            result.append(tuple((1-t)**3*a + 3*(1-t)**2*t*b + 3*(1-t)*t*t*c + t**3*d))
        a = d
    return result


class Paint:
    def __init__(self, bounds, color):
        self.bounds = bounds
        x0, x1, z0, z1 = bounds
        v, u = np.mgrid[0:1024, 0:1024] / 1023
        self.x = x0 + u * (x1-x0)
        self.z = z0 + v * (z1-z0)
        shade = .88 + .12*v + .08*np.exp(-((u-.48)/.35)**2)
        self.rgb = shade[..., None] * np.array(color)

    def blend(self, coverage, color):
        a = np.clip(coverage, 0, 1)[..., None]
        self.rgb = self.rgb*(1-a) + np.array(color)*a

    def ellipse(self, x, z, rx, rz, color):
        d = np.sqrt(((self.x-x)/rx)**2 + ((self.z-z)/rz)**2)
        self.blend((1-d)*80+.5, color)

    def polygon(self, points, color):
        inside = np.zeros_like(self.x, dtype=bool)
        for (a,b),(c,d) in zip(points, points[1:]+points[:1]):
            if abs(d-b) > 1e-9:
                inside ^= ((b>self.z)!=(d>self.z)) & (self.x < (c-a)*(self.z-b)/(d-b)+a)
        self.blend(inside, color)

    def stroke(self, points, width, color):
        distance = np.full_like(self.x, 1e3)
        for (a,b),(c,d) in zip(points,points[1:]):
            den = (c-a)**2+(d-b)**2
            if den < 1e-12: continue
            t = np.clip(((self.x-a)*(c-a)+(self.z-b)*(d-b))/den,0,1)
            distance = np.minimum(distance,np.sqrt((self.x-a-t*(c-a))**2+(self.z-b-t*(d-b))**2))
        self.blend((width-distance)*350+.5,color)


def create_reliefs(mesh, bevel, tube, path, surface, image_array):
    def material(name, paint):
        mat = surface(name,(1,1,1),.43)
        bs = next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
        im = image_array(name,paint.rgb)
        tex = mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im
        mat.node_tree.links.new(tex.outputs['Color'],bs.inputs['Base Color'])
        return mat

    def plaque(name, outline, paint, mat, front=.71, depth=.23, edge=.055):
        # A closed bevelled slab: the recognisable contour is geometry, all facial
        # marks are pigment. No mouth cavity, eye spheres, or detached lips.
        if np.linalg.norm(np.array(outline[0])-outline[-1])<1e-5: outline=outline[:-1]
        n=len(outline)
        vertices=[(x,y,z) for y in (front,front+depth) for x,z in outline]
        faces=[tuple(range(n)),tuple(reversed(range(n,2*n)))]
        faces += [(i,i+n,(i+1)%n+n,(i+1)%n) for i in range(n)]
        x0,x1,z0,z1=paint.bounds
        uv=[((x-x0)/(x1-x0),(z-z0)/(z1-z0)) for x,y,z in vertices]
        ob=mesh(name,vertices,faces,mat,False,uv)
        bm=bmesh.new();bm.from_mesh(ob.data)
        bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
        bm.to_mesh(ob.data);bm.free()
        bevel(ob,edge,4)
        return ob

    blue = (.16,.48,.68); navy=(.035,.17,.24); ivory=(.89,.94,.91)
    dp=Paint((-3.85,-1.38,6.04,9.12),blue)
    belly=bezier((-1.55,8.43),[
        (-1.94,8.43,-2.19,8.30,-2.43,8.12),
        (-2.74,7.78,-2.85,7.12,-2.56,6.48),
        (-2.26,6.11,-1.85,6.19,-1.75,6.42),
        (-1.30,7.10,-1.30,7.95,-1.55,8.43)])
    dp.polygon(belly,ivory)
    # Small almond-shaped eye; the short painted smile follows the beak.
    dp.ellipse(-2.20,8.66,.107,.129,navy)
    dp.ellipse(-2.195,8.665,.079,.103,ivory)
    dp.ellipse(-2.172,8.658,.055,.078,(.03,.19,.26))
    dp.ellipse(-2.155,8.691,.020,.025,(1,1,.97))
    dp.stroke(bezier((-2.32,8.82),[(-2.25,8.89,-2.14,8.89,-2.07,8.82)]),.012,navy)
    dp.stroke(bezier((-1.58,8.45),[(-1.86,8.42,-2.04,8.36,-2.25,8.42)]),.013,navy)
    dp.ellipse(-2.25,8.42,.022,.022,navy)
    dm=material('Dolphin painted relief',dp)
    outline=bezier((-1.53,8.49),[
        (-1.56,8.61,-1.77,8.59,-1.95,8.62),
        (-2.00,8.97,-2.32,9.08,-2.61,8.91),
        (-2.92,8.72,-3.09,8.39,-3.18,8.02),
        (-3.38,8.07,-3.59,8.03,-3.65,7.80),
        (-3.47,7.86,-3.34,7.71,-3.26,7.59),
        (-3.31,7.09,-3.07,6.59,-2.61,6.36),
        (-2.56,6.33,-2.51,6.29,-2.47,6.23),
        (-2.36,6.26,-2.25,6.29,-2.19,6.37),
        (-2.73,6.71,-2.67,7.24,-2.51,7.70),
        (-2.42,7.99,-2.23,8.22,-2.02,8.34),
        (-1.84,8.39,-1.56,8.36,-1.53,8.49)])
    plaque('Dolphin shallow relief body',outline,dp,dm,depth=.28,edge=.055)
    tail=bezier((-2.48,6.39),[
        (-2.67,6.36,-2.88,6.37,-3.03,6.17),
        (-2.73,6.10,-2.48,6.14,-2.34,6.27),
        (-2.17,6.10,-1.97,6.20,-1.92,6.43),
        (-2.15,6.40,-2.28,6.44,-2.48,6.39)])
    plaque('Dolphin broad tail flukes',tail,dp,dm,front=.69,depth=.20,edge=.035)
    flipper=bezier((-2.75,7.90),[
        (-2.95,7.85,-3.08,7.57,-3.13,7.39),
        (-2.89,7.45,-2.62,7.66,-2.57,7.79),
        (-2.57,7.87,-2.65,7.92,-2.75,7.90)])
    plaque('Dolphin raised pectoral flipper',flipper,dp,dm,front=.59,depth=.17,edge=.037)

    coral=(.94,.38,.21); dark=(.42,.15,.075); pale=(1,.78,.55)
    sp=Paint((1.45,3.76,6.06,9.04),coral)
    # Painted underside and shell divisions articulate the curled abdomen.
    sp.polygon(bezier((2.01,8.18),[
        (2.45,8.20,2.72,7.76,2.84,7.34),
        (2.92,6.84,2.52,6.57,2.12,6.61),
        (1.97,6.25,2.90,6.07,3.03,6.49),
        (3.31,7.11,2.93,8.30,2.01,8.18)]),pale)
    bands=[((2.53,8.12),(2.76,8.08),(3.03,8.14),(3.27,8.27)),
           ((2.71,7.83),(2.95,7.74),(3.18,7.78),(3.42,7.91)),
           ((2.83,7.49),(3.05,7.38),(3.29,7.43),(3.51,7.54)),
           ((2.82,7.13),(3.04,7.01),(3.27,7.04),(3.48,7.15)),
           ((2.68,6.84),(2.89,6.66),(3.10,6.66),(3.27,6.73)),
           ((2.43,6.70),(2.53,6.54),(2.68,6.39),(2.77,6.34))]
    for a,b,c,d in bands:
        line=bezier(a,[(*b,*c,*d)])
        sp.stroke(line,.027,dark)
        sp.stroke([(x,z+.042) for x,z in line],.018,(1,.64,.39))
    sp.ellipse(2.31,8.57,.108,.125,dark)
    sp.ellipse(2.30,8.58,.079,.097,(.99,.91,.75))
    sp.ellipse(2.278,8.575,.055,.071,(.075,.13,.13))
    sp.ellipse(2.262,8.607,.019,.023,(1,1,.94))
    sp.stroke(bezier((2.08,8.72),[(2.16,8.79,2.28,8.79,2.36,8.74)]),.012,dark)
    sp.stroke(bezier((1.98,8.30),[(2.14,8.21,2.31,8.24,2.40,8.34)]),.015,dark)
    sm=material('Shrimp painted relief',sp)
    outline=bezier((1.79,8.72),[
        (1.95,8.76,2.12,8.75,2.29,8.78),
        (2.62,9.01,2.93,8.80,3.09,8.55),
        (3.43,8.15,3.60,7.67,3.52,7.21),
        (3.48,6.78,3.22,6.38,2.84,6.29),
        (2.57,6.18,2.23,6.31,2.07,6.55),
        (2.13,6.65,2.18,6.73,2.26,6.76),
        (2.55,6.56,2.86,6.77,2.90,7.07),
        (2.94,7.41,2.69,7.81,2.42,8.08),
        (2.19,8.18,2.05,8.21,1.94,8.36),
        (1.95,8.43,2.05,8.48,2.16,8.52),
        (2.02,8.56,1.92,8.65,1.79,8.72)])
    plaque('Shrimp shallow relief shell',outline,sp,sm,depth=.27,edge=.055)
    for k in range(3):
        angle=(k-1)*.56
        start=np.array((2.20,6.64));direction=np.array((-math.cos(angle),math.sin(angle)))
        across=np.array((-direction[1],direction[0]))
        tip=start+direction*.55
        pts=bezier(tuple(start),[(*tuple(start+direction*.18+across*.15),*tuple(tip+across*.15),*tuple(tip)),
                              (*tuple(tip-across*.15),*tuple(start+direction*.18-across*.15),*tuple(start))])
        plaque('Shrimp fan tail lobe',pts,sp,sm,front=.68,depth=.18,edge=.035)
    # Delicate antennae and legs are kept in the same shallow relief plane.
    for k in range(2):
        points=path([(2.24,.80,8.73),(2.03,.80,9.10+k*.15),(1.42,.80,9.31+k*.14),(.91,.80,9.17+k*.14)],32)
        tube('Shrimp relief antenna',points,[.025*(1-.75*i/31) for i in range(32)],'Coral',6)
    for k in range(5):
        z=8.02-k*.19;x=2.65+k*.10
        points=path([(x,.79,z),(x-.22,.76,z-.09),(x-.44,.76,z-.29)],12)
        tube('Shrimp relief walking leg',points,[.025*(1-.62*i/11) for i in range(12)],'Peach',5)
    return {'design':'Shallow bevelled relief with painted eyes and closed smiles',
            'body_depths':[.28,.27],'facial_geometry_objects':0,'face_maps':2}
