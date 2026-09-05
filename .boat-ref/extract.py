"""Tier-2 algorithmic trace of Gokstad orthographic drawings -> normalized curves.

Sources:
  schematic.png        : longitudinal section (side view, top) + bird's-eye (plan, bottom)
  gokstad_section.jpg  : diagrammatic midship transverse section

Outputs:
  out/curves.json      : normalized sheer/keel/half-breadth/section-profile
  out/trace-debug.png  : traced curves overlaid on the source crops
"""
import json
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

BOAT = "/mnt/e/Development/Projects/Terrace/.boat-ref/"
OUT = BOAT + "out/"

# --- source geometry, measured from the images (see report) --------------------
SIDE_BAND = (0, 262)      # rows of schematic.png holding the longitudinal section
PLAN_BAND = (263, 662)    # rows holding the bird's-eye view
INK = 160                 # 8-bit threshold: below this is ink
MAX_SLOPE_PX = 8          # px of vertical travel allowed per column while walking
                          # an outline; the steepest real slope (bow sheer) is
                          # ~0.6 px/col, so this rejects masts/rudder without
                          # clipping any genuine part of the curve.
SHEER_LIFT_PX = 40        # how far above the hull body's own top edge we will
                          # look for the sheer strake. The strakes above the
                          # main hull body are drawn as their own hatched bands
                          # separated by hairline gaps, so they land in separate
                          # connected components; 40 px is ~18% of the drawing's
                          # hull depth (226 px) - enough to bridge those bands,
                          # far short of the mast tops and yard (~90 px above).
SPIKE_MEDIAN_PX = 41      # rolling-median width used to kill mast spikes, which
                          # are <=8 px wide in this drawing.
SHEER_CLOSE_PX = 91       # grey-closing width applied to the sheer curve. It
                          # deletes narrow upward excursions - the mast-partner
                          # block (~60 px) and the steering-oar bracket (~35 px)
                          # - while leaving the monotonic bow/stern rise intact,
                          # since closing is idempotent on a monotonic signal.


def biggest_component(mask):
    lab, n = ndimage.label(mask, np.ones((3, 3), int))
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    return lab == (int(np.argmax(sizes)) + 1)


def column_runs(mask, x):
    """Vertical dark runs in column x as (top, bottom) pairs."""
    ys = np.where(mask[:, x])[0]
    if len(ys) == 0:
        return []
    breaks = np.where(np.diff(ys) > 1)[0]
    starts = np.concatenate(([0], breaks + 1))
    ends = np.concatenate((breaks, [len(ys) - 1]))
    return [(int(ys[s]), int(ys[e])) for s, e in zip(starts, ends)]


def walk_edge(mask, x_lo, x_hi, x_seed, edge):
    """Follow one continuous outline edge ('top' or 'bot') across the columns.

    At each step we take, of all dark runs in the column, the boundary pixel
    closest to the previous column's value, preferring candidates within
    MAX_SLOPE_PX. This tracks a continuous curve and steps over detached
    clutter (mast, yard, rudder) that a naive per-column min/max would grab.
    """
    val = np.full(mask.shape[1], np.nan)

    def pick(x, prev):
        runs = column_runs(mask, x)
        if not runs:
            return None
        cands = [r[0] if edge == "top" else r[1] for r in runs]
        near = [c for c in cands if abs(c - prev) <= MAX_SLOPE_PX]
        pool = near if near else cands
        # among admissible candidates take the extreme one (highest/lowest),
        # so we hug the true outline rather than an interior stroke.
        return min(pool) if edge == "top" else max(pool)

    runs = column_runs(mask, x_seed)
    val[x_seed] = runs[0][0] if edge == "top" else runs[-1][1]
    for x in range(x_seed + 1, x_hi + 1):
        p = pick(x, val[x - 1])
        val[x] = val[x - 1] if p is None else p
    for x in range(x_seed - 1, x_lo - 1, -1):
        p = pick(x, val[x + 1])
        val[x] = val[x + 1] if p is None else p
    return val


def rolling_median(a, k):
    pad = np.pad(np.asarray(a, float), k // 2, mode="edge")
    return np.median(np.lib.stride_tricks.sliding_window_view(pad, k), axis=-1)


def smooth(a, k=9):
    ker = np.ones(k) / k
    return np.convolve(np.pad(a, k // 2, mode="edge"), ker, mode="valid")


# --- side view: sheer + keel ---------------------------------------------------
img = np.array(Image.open(BOAT + "schematic.png"))
ink = img < INK

side_all = ink[SIDE_BAND[0]:SIDE_BAND[1]]
side = biggest_component(side_all)
sx = np.where(side.any(0))[0]
SX0, SX1 = int(sx.min()), int(sx.max())
SEED = (SX0 + SX1) // 2

# Keel: the hull body's lower boundary is one clean continuous stroke.
keel = walk_edge(side, SX0, SX1, SEED, "bot")

# Sheer: two passes. The hull body component gives an approximate top edge
# (mast spikes removed by rolling median); then we lift to the topmost ink of
# ANY component within SHEER_LIFT_PX of it, which picks up the upper strakes
# that are drawn as separate hatched bands while still ignoring mast and yard.
top_body = np.array([c[0][0] if (c := column_runs(side, x)) else np.nan
                     for x in range(side.shape[1])], float)
valid = ~np.isnan(top_body)
approx = top_body.copy()
approx[valid] = rolling_median(top_body[valid], SPIKE_MEDIAN_PX)
sheer = np.full(side.shape[1], np.nan)
for x in range(SX0, SX1 + 1):
    lo = int(max(0, approx[x] - SHEER_LIFT_PX))
    hi = int(approx[x]) + 1
    ys = np.where(side_all[lo:hi, x])[0]
    sheer[x] = (lo + ys[0]) if len(ys) else approx[x]
sheer[SX0:SX1 + 1] = ndimage.grey_closing(
    rolling_median(sheer[SX0:SX1 + 1], 31), size=SHEER_CLOSE_PX, mode="nearest")

# Stem and stern posts: where the raw top edge of the drawing stands clearly
# proud of the sheer, that ink is the post sweeping up above the gunwale. This
# is the same traced data, just the part the sheer filter deliberately rejected.
POST_MIN_RISE_PX = 6
post_raw = rolling_median(np.where(valid, top_body, np.nan)[SX0:SX1 + 1], 5)
post_rise = sheer[SX0:SX1 + 1] - post_raw
posts = []
for lo, hi in [(0, (SX1 - SX0) // 2), ((SX1 - SX0) // 2, SX1 - SX0 + 1)]:
    seg = post_rise[lo:hi]
    idx = np.where(seg > POST_MIN_RISE_PX)[0]
    # keep only the run that touches the end of the ship
    if len(idx) == 0:
        posts.append([])
        continue
    if lo == 0:
        run = idx[idx <= (np.split(idx, np.where(np.diff(idx) > 1)[0] + 1)[0][-1])]
    else:
        run = np.split(idx, np.where(np.diff(idx) > 1)[0] + 1)[-1]
    posts.append([[float((lo + i) / (SX1 - SX0)), float(post_raw[lo + i])] for i in run])

# --- plan view: half-breadth ---------------------------------------------------
plan = biggest_component(ink[PLAN_BAND[0]:PLAN_BAND[1]])
px = np.where(plan.any(0))[0]
PX0, PX1 = int(px.min()), int(px.max())
PSEED = (PX0 + PX1) // 2
p_top = walk_edge(plan, PX0, PX1, PSEED, "top")
p_bot = walk_edge(plan, PX0, PX1, PSEED, "bot")
half = (p_bot - p_top) / 2.0
half[PX0:PX1 + 1] = rolling_median(half[PX0:PX1 + 1], 31)

# --- midship section: normalized U profile -------------------------------------
sec = np.array(Image.open(BOAT + "gokstad_section.jpg").convert("L"))
sec = sec[:650]                      # drop the caption
sink = sec < 140
sec_comp = biggest_component(sink)
sy, sxx = np.where(sec_comp)
CX = (sxx.min() + sxx.max()) / 2.0   # symmetry axis of the section
SY0, SY1 = int(sy.min()), int(sy.max())

half_w, prof_y = [], []
for y in range(SY0, SY1 + 1):
    row = np.where(sec_comp[y])[0]
    right = row[row > CX]
    if len(right):
        half_w.append(right.max() - CX)
        prof_y.append(y)
half_w = np.array(half_w, float)
prof_y = np.array(prof_y, float)
# the keel timber below the hull is much narrower than the hull; the profile we
# want runs from where the planking meets the keel up to the gunwale.
KEEL_BOT = prof_y[-1]
sec_hw = half_w / half_w.max()
sec_v = 1.0 - (prof_y - SY0) / (KEEL_BOT - SY0)   # 0 at keel, 1 at gunwale

# --- normalize the plan/side curves to [0,1] -----------------------------------
def norm_len(vals, x0, x1, n=400):
    """Resample the valid span [x0,x1] of a per-column curve to n samples."""
    seg = smooth(np.asarray(vals[x0:x1 + 1], float))
    return np.interp(np.linspace(0, len(seg) - 1, n), np.arange(len(seg)), seg)

n_sheer = norm_len(sheer, SX0, SX1)
n_keel = norm_len(keel, SX0, SX1)
n_half = norm_len(half, PX0, PX1)

side_len = SX1 - SX0
plan_len = PX1 - PX0
depth_px = float(np.max(n_keel - n_sheer))
beam_px = float(np.max(n_half) * 2)

curves = {
    "n": 400,
    "side_px": {"x0": SX0, "x1": SX1, "len": side_len},
    "plan_px": {"x0": PX0, "x1": PX1, "len": plan_len},
    # unit length = ship length; sheer/keel are depths below the sheer maximum,
    # expressed as a fraction of ship length so the two views stay commensurate.
    "sheer": ((n_sheer - n_sheer.min()) / side_len).tolist(),
    "keel": ((n_keel - n_sheer.min()) / side_len).tolist(),
    "half": (n_half / plan_len).tolist(),
    "posts": [
        [[t, (y - n_sheer.min()) / side_len] for t, y in posts[0]],
        [[t, (y - n_sheer.min()) / side_len] for t, y in posts[1]],
    ],
    "section_v": sec_v.tolist(),
    "section_hw": sec_hw.tolist(),
    "measured": {
        "L_over_B_plan": plan_len / beam_px,
        "L_over_D_side": side_len / depth_px,
        "depth_px": depth_px,
        "beam_px": beam_px,
    },
}
json.dump(curves, open(OUT + "curves.json", "w"))

# --- debug overlay -------------------------------------------------------------
dbg = Image.open(BOAT + "schematic.png").convert("RGB")
d = ImageDraw.Draw(dbg)
d.line([(x, sheer[x]) for x in range(SX0, SX1 + 1)], fill=(255, 0, 0), width=3)
d.line([(x, keel[x]) for x in range(SX0, SX1 + 1)], fill=(0, 128, 255), width=3)
d.line([(x, p_top[x] + PLAN_BAND[0]) for x in range(PX0, PX1 + 1)], fill=(0, 190, 0), width=3)
d.line([(x, p_bot[x] + PLAN_BAND[0]) for x in range(PX0, PX1 + 1)], fill=(0, 190, 0), width=3)

secimg = Image.open(BOAT + "gokstad_section.jpg").convert("RGB")
d2 = ImageDraw.Draw(secimg)
pts = [(CX + hw * half_w.max(), y) for hw, y in zip(sec_hw, prof_y)]
d2.line(pts, fill=(255, 0, 255), width=3)
d2.line([(CX - hw * half_w.max(), y) for hw, y in zip(sec_hw, prof_y)], fill=(255, 0, 255), width=3)

W = max(dbg.width, secimg.width)
canvas = Image.new("RGB", (W, dbg.height + secimg.height), (255, 255, 255))
canvas.paste(dbg, (0, 0))
canvas.paste(secimg, (0, dbg.height))
canvas.save(OUT + "trace-debug.png")

print("side x", SX0, SX1, "plan x", PX0, PX1)
print("L/B(plan)", round(curves["measured"]["L_over_B_plan"], 3),
      "L/D(side)", round(curves["measured"]["L_over_D_side"], 3))
print("section rows", len(sec_v), "CX", CX, "SY", SY0, SY1)
