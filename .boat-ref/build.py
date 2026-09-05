"""Turn the traced curves into station-skinned hull meshes (out/mesh.json).

Coordinates: x fore-aft (bow +x), y athwart, z up. Gunwale datum z = 0 at the
highest point of the traced sheer; everything else hangs below it.
"""
import json
import numpy as np

BOAT = "/mnt/e/Development/Projects/Terrace/.boat-ref/"
OUT = BOAT + "out/"

HULL_LENGTH = 0.9          # world units; matches plugins/boats/client/models.ts
GAME_BEAM = 0.34           # HULL_BEAM from models.ts
GAME_DEPTH = 0.2           # HULL_DEPTH from models.ts
N_STATIONS = 13            # odd, so one station lands exactly amidships
N_PROFILE = 9              # points per half-section, keel -> gunwale
POST_RINGS = 6             # samples along each stem post
# 13 x 9 keeps the level-1 subdivided total under the 2000-tri budget:
# 12 x 16 shell quads + 12 deck quads = 204, x4 at level 1 = 1632 tris.
POST_HALF_THICK = 0.012    # stem/stern post half-thickness, as a fraction of L
# The traced section's lowest rows are the keel timber, a ~7%-of-half-beam
# shank that is well under a pixel at game scale; the profile is pulled to zero
# there so the two half-sections close cleanly on the centreline.

C = json.load(open(OUT + "curves.json"))


def resample(a, n):
    a = np.asarray(a, float)
    return np.interp(np.linspace(0, 1, n), np.linspace(0, 1, len(a)), a)


# station curves, t = 0 at the bow end of the drawings
half = resample(C["half"], N_STATIONS)
sheer = resample(C["sheer"], N_STATIONS)
keel = resample(C["keel"], N_STATIONS)

# section profile, sorted keel (v=0) -> gunwale (v=1)
sv = np.asarray(C["section_v"], float)
sh = np.asarray(C["section_hw"], float)
o = np.argsort(sv)
sv, sh = sv[o], sh[o]
prof_v = np.linspace(0, 1, N_PROFILE)
prof_hw = np.interp(prof_v, sv, sh)
prof_hw /= prof_hw.max()
prof_hw[0] = 0.0

L = HULL_LENGTH
TRUE_BEAM = 2 * half.max() * L


def hull_mesh(beam_scale, depth_scale):
    verts, faces, creases = [], [], []
    rings = []
    K = 2 * N_PROFILE - 1
    for i in range(N_STATIONS):
        x = (i / (N_STATIONS - 1) - 0.5) * L
        z_sheer = -sheer[i] * L * depth_scale
        z_keel = -keel[i] * L * depth_scale
        hb = half[i] * L * beam_scale
        ring = []
        if i in (0, N_STATIONS - 1):          # end stations collapse to the stem line
            base = len(verts)
            for p in range(N_PROFILE):
                verts.append([x, 0.0, z_keel + (z_sheer - z_keel) * prof_v[p]])
            ring = [base + abs(k - (N_PROFILE - 1)) for k in range(K)]
        else:
            for k in range(K):
                p = abs(k - (N_PROFILE - 1))
                side = -1.0 if k < N_PROFILE - 1 else 1.0
                verts.append([x, side * hb * prof_hw[p],
                              z_keel + (z_sheer - z_keel) * prof_v[p]])
                ring.append(len(verts) - 1)
        rings.append(ring)

    def add(quad):
        seen = []
        for v in quad:
            if v not in seen:
                seen.append(v)
        if len(seen) >= 3:
            faces.append(seen)

    for i in range(N_STATIONS - 1):
        a, b = rings[i], rings[i + 1]
        for k in range(K - 1):
            add([a[k], a[k + 1], b[k + 1], b[k]])       # hull shell
        add([a[0], b[0], b[K - 1], a[K - 1]])           # deck, closing the top
        creases.append([a[0], b[0]])
        creases.append([a[K - 1], b[K - 1]])
    return verts, faces, creases


def post_mesh(depth_scale):
    """Stem and stern posts as rectangular-section prisms along the traced curve."""
    verts, faces = [], []
    th = POST_HALF_THICK * L
    for side_idx, post in enumerate(C["posts"]):
        if len(post) < 2:
            continue
        pts = post if side_idx == 1 else post[::-1]
        step = max(1, len(pts) // POST_RINGS)
        pts = pts[::step] + ([pts[-1]] if pts[::step][-1] != pts[-1] else [])
        rings = []
        for t, ztop in pts:
            x = (t - 0.5) * L
            zt = -ztop * L * depth_scale
            zb = -np.interp(t, np.linspace(0, 1, N_STATIONS), sheer) * L * depth_scale
            base = len(verts)
            verts += [[x, -th, zb], [x, th, zb], [x, th, zt], [x, -th, zt]]
            rings.append([base, base + 1, base + 2, base + 3])
        for a, b in zip(rings, rings[1:]):
            for k in range(4):
                faces.append([a[k], a[(k + 1) % 4], b[(k + 1) % 4], b[k]])
        faces.append(rings[0][::-1])
        faces.append(rings[-1])
    return {"verts": verts, "faces": faces}


def variant(beam_scale, depth_scale):
    v, f, cr = hull_mesh(beam_scale, depth_scale)
    return {"hull": {"verts": v, "faces": f, "creases": cr},
            "posts": post_mesh(depth_scale)}


# --- the current in-game hull, rebuilt with the exact arithmetic of models.ts --
OUTLINE = [(0.5, 0.0), (0.34, 0.13), (0.06, 0.17), (-0.28, 0.16), (-0.46, 0.12)]
starboard = [(a * HULL_LENGTH, c * GAME_BEAM * 2) for a, c in OUTLINE]
ring2d = starboard + [(a, -c) for a, c in reversed(starboard[1:])]


def current_hull():
    verts, faces = [], []
    n = len(ring2d)
    for z in (0.0, -GAME_DEPTH):
        for a, c in ring2d:
            verts.append([a, c, z])
    for k in range(n):
        k2 = (k + 1) % n
        faces.append([k, k2, n + k2, n + k])
    faces.append(list(range(n))[::-1])
    faces.append([n + k for k in range(n)])
    return {"hull": {"verts": verts, "faces": faces, "creases": []},
            "posts": {"verts": [], "faces": []}}


game_beam_scale = GAME_BEAM / TRUE_BEAM
data = {
    "hull-true": variant(1.0, 1.0),
    "hull-beamy": variant(game_beam_scale, 1.0),
    "hull-gamebox": variant(game_beam_scale, GAME_DEPTH / (C["measured"]["depth_px"]
                                                           / C["side_px"]["len"] * L)),
    "hull-current": current_hull(),
}
json.dump(data, open(OUT + "mesh.json", "w"))

traced_depth = C["measured"]["depth_px"] / C["side_px"]["len"] * L
print(f"true beam {TRUE_BEAM:.4f}  L/B {L / TRUE_BEAM:.2f}")
print(f"traced depth {traced_depth:.4f}  L/D {L / traced_depth:.2f}   game depth {GAME_DEPTH}")
print(f"beamy y-scale {game_beam_scale:.3f}   gamebox z-scale {GAME_DEPTH / traced_depth:.3f}")
for k, v in data.items():
    print(f"{k}: hull {len(v['hull']['verts'])}v/{len(v['hull']['faces'])}f "
          f"posts {len(v['posts']['verts'])}v/{len(v['posts']['faces'])}f")
