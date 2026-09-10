import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Camera,
  ClampToEdgeWrapping,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix3,
  Mesh,
  type PerspectiveCamera,
  Points,
  type PixelFormat,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type IUniform,
} from 'three';
import { DEFAULT_WORLD_SPAN, MAX_HEIGHT, MIN_HEIGHT } from '@terrace/shared';
import {
  CAMERA_FOV_DEGREES,
  CAMERA_MAX_DISTANCE,
  CELL_WORLD_SIZE,
  HEIGHT_WORLD_SCALE,
} from '../config.ts';
import { generateStarGrid, type StarGridSpec } from './celestialVoidStars.ts';
import type { Viewport } from './scene.ts';

export type VoidStyle = 'nebula' | 'wheel';

export type VoidAnchor = 'view' | 'world';

const WHEEL_TILT_DEGREES = 60;

const DISK_SCALE = 0.85;

const VIEW_HUB_DISTANCE = 2.6 / DISK_SCALE;

const VIEW_FOCAL = 1.2;

const NEBULA_ZOOM = 2.2;

const LOCKED_WORLD_UNITS_PER_DISK_UNIT = 200 * DISK_SCALE;

const DISK_THICKNESS_WORLD = 4;
const DISK_THICKNESS = DISK_THICKNESS_WORLD / LOCKED_WORLD_UNITS_PER_DISK_UNIT;

const STAR_FIELD_DEPTH_WORLD = 120;
const STAR_FIELD_DEPTH = STAR_FIELD_DEPTH_WORLD / LOCKED_WORLD_UNITS_PER_DISK_UNIT;

const STAR_FINE_DEPTH = 0.5 * STAR_FIELD_DEPTH;

const LOCKED_HUB_CLEARANCE_WORLD = 2;

const LOCKED_HUB_WORLD_Y = MIN_HEIGHT * HEIGHT_WORLD_SCALE - LOCKED_HUB_CLEARANCE_WORLD;

const GAS_INNER_R = 0.12;

const S_LOG_EPS = 0.05;

const R_BAKE_MAX = 12;

const GAS_BAKE_S_MIN = Math.log(S_LOG_EPS);
const GAS_BAKE_S_SPAN = Math.log(R_BAKE_MAX + S_LOG_EPS) - GAS_BAKE_S_MIN;

const GAS_BAKE_SIZE = 2048;

const FADE_END_HEIGHTS = 12.0 / 1.3;

const FADE_GROUND_REACH = Math.sqrt(FADE_END_HEIGHTS * FADE_END_HEIGHTS - 1);

const GAS_DISK_RADIUS = 1.7;

const CELL_FADE_PX = 4.0;

const ARM_GRID_GAIN = 2.5;

const STAR_COARSE_CELLS_PER_UNIT = 16;
const STAR_FINE_CELLS_PER_UNIT = 32;
const STAR_ARM_CELLS_PER_UNIT = 40;
const STAR_COARSE_DENSITY = 0.07;
const STAR_FINE_DENSITY = 0.05;
const STAR_ARM_DENSITY = 0.35;

const STAR_COARSE_SEED = 1;
const STAR_FINE_SEED = 2;
const STAR_ARM_SEED = 3;

const STAR_TARGET_OFFSET_WORLD = (DEFAULT_WORLD_SPAN / 2) * Math.SQRT2;

const STAR_TARGET_HEIGHT_WORLD =
  (MAX_HEIGHT - MIN_HEIGHT) * HEIGHT_WORLD_SCALE + LOCKED_HUB_CLEARANCE_WORLD;

const STAR_COARSE_RADIUS =
  (STAR_TARGET_OFFSET_WORLD +
    FADE_GROUND_REACH * STAR_TARGET_HEIGHT_WORLD +
    FADE_END_HEIGHTS * CAMERA_MAX_DISTANCE) /
  LOCKED_WORLD_UNITS_PER_DISK_UNIT;

const STAR_FINE_MAX_RES_Y = 2160;

const STAR_FINE_SDIST_MAX =
  (Math.max(VIEW_FOCAL, 0.5 / Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360)) *
    STAR_FINE_MAX_RES_Y) /
  (STAR_FINE_CELLS_PER_UNIT * CELL_FADE_PX);

const STAR_FINE_CROSS_COS =
  ((STAR_FINE_SDIST_MAX * LOCKED_WORLD_UNITS_PER_DISK_UNIT) / FADE_END_HEIGHTS -
    STAR_TARGET_HEIGHT_WORLD) /
  CAMERA_MAX_DISTANCE;

const STAR_FINE_RADIUS =
  (STAR_TARGET_OFFSET_WORLD +
    CAMERA_MAX_DISTANCE * Math.sqrt(1 - STAR_FINE_CROSS_COS * STAR_FINE_CROSS_COS)) /
    LOCKED_WORLD_UNITS_PER_DISK_UNIT +
  STAR_FINE_SDIST_MAX;

const STAR_ARM_CUTOFF = 0.02;

const STAR_ARM_RADIUS = GAS_DISK_RADIUS * Math.log(ARM_GRID_GAIN / STAR_ARM_CUTOFF);

const STAR_ARM_GRID_ENABLED = false;

const STAR_GRIDS: readonly StarGridSpec[] = [
  {
    seed: STAR_COARSE_SEED,
    radius: STAR_COARSE_RADIUS,
    depth: STAR_FIELD_DEPTH,
    scale: STAR_COARSE_CELLS_PER_UNIT,
    density: STAR_COARSE_DENSITY,
  },
  {
    seed: STAR_FINE_SEED,
    radius: STAR_FINE_RADIUS,
    depth: STAR_FINE_DEPTH,
    scale: STAR_FINE_CELLS_PER_UNIT,
    density: STAR_FINE_DENSITY,
  },
  ...(STAR_ARM_GRID_ENABLED
    ? [
        {
          seed: STAR_ARM_SEED,
          radius: STAR_ARM_RADIUS,
          depth: DISK_THICKNESS,
          scale: STAR_ARM_CELLS_PER_UNIT,
          density: STAR_ARM_DENSITY,
        },
      ]
    : []),
];

const VOID_RENDER_ORDER = -1000;

const STARS_RENDER_ORDER = VOID_RENDER_ORDER + 1;

const GAS_RES_DIVISOR = 2;

const FULLSCREEN_TRIANGLE_POSITIONS = [-1, -1, 0, 3, -1, 0, -1, 3, 0];

const VERTEX_SHADER =  `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COMMON_GLSL =  `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
// The anchor frame (see the header): focal length in screen heights, the
// rotation taking a view-space direction into disk space, and the eye's
// position in disk space (disk units, z up, plane at z = 0).
uniform float u_focal;
uniform mat3 u_toDisk;
uniform vec3 u_origin;
// 1.0 in the world anchor, 0.0 in the view anchor: whether a look that has no
// plane to intersect (the nebula's clouds, the wheel's sky above its horizon)
// maps the ray onto a dome around the world instead of the view's image plane.
uniform float u_dome;
vec3 viewRay(vec2 uv){ return u_toDisk*normalize(vec3(uv,-u_focal)); }
// Lambert azimuthal equal-area projection of a direction, from the nadir: a
// smooth 2-D domain over every direction but straight up (|p| = 2 there), with
// no seam and no stretch at the horizon (|p| = sqrt 2). Near the nadir it is
// d.xy to first order, so it matches the plane mapping where the two meet. The
// zenith is the one singular point, and the orbit's polar cap
// (CAMERA_MAX_POLAR_ANGLE_DEGREES) keeps it off screen.
vec2 dome(vec3 d){ return d.xy*sqrt(2.0/(1.0-d.z)); }

float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
float hash3(vec3 p){ p=fract(p*vec3(123.34,456.21,789.13)); p+=dot(p,p.yzx+45.32); return fract(p.x*p.y*p.z); }
float vnoise3(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash3(i),hash3(i+vec3(1,0,0)),f.x), mix(hash3(i+vec3(0,1,0)),hash3(i+vec3(1,1,0)),f.x), f.y),
             mix(mix(hash3(i+vec3(0,0,1)),hash3(i+vec3(1,0,1)),f.x), mix(hash3(i+vec3(0,1,1)),hash3(i+vec3(1,1,1)),f.x), f.y), f.z); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+vec2(17.3,9.1); a*=0.5; } return s; }
// The same fbm cut to FBM_LOW_OCTAVES, for fields read only on the broad scale (their fine octaves
// were below a filament wide and invisible); the same first octaves, so the look is unchanged.
const int FBM_LOW_OCTAVES=3;
float fbmLow(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<FBM_LOW_OCTAVES;i++){ s+=a*vnoise(p); p=p*2.03+vec2(17.3,9.1); a*=0.5; } return s; }
// The same noise, periodic in y with period per cells: the lattice row wraps, so a domain
// whose y is an angle has no seam. Lacunarity exactly 2 and no y offset keep every octave periodic.
float pvnoise(vec2 p, float per){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float y0=mod(i.y,per), y1=mod(i.y+1.0,per);
  return mix(mix(hash(vec2(i.x,y0)),hash(vec2(i.x+1.0,y0)),f.x), mix(hash(vec2(i.x,y1)),hash(vec2(i.x+1.0,y1)),f.x), f.y); }
float pfbm(vec2 p, float per){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*pvnoise(p,per); p=p*2.0+vec2(17.3,0.0); per*=2.0; a*=0.5; } return s; }
// Star layer: one candidate per grid cell, soft falloff, steady (stars do not twinkle here).
float stars(vec2 p, float density, float t){
  vec2 i=floor(p), f=fract(p)-0.5; float h=hash(i);
  if(h>density) return 0.0;
  vec2 o=vec2(hash(i+3.1),hash(i+7.7))-0.5; float d=length(f-o*0.8);
  float size = 0.03 + 0.05*hash(i+9.2);
  return smoothstep(size,0.0,d)*(0.5+0.5*h/density);
}
`;

const NEBULA_GLSL =  `${COMMON_GLSL}
const float NEBULA_RATE = 0.15;   // drift clock scale; owner set 3x the original 0.05
const float NEBULA_ZOOM = ${NEBULA_ZOOM.toFixed(1)}; // reference: p = uv*2.2
// World anchor only: how much of the eye's offset from the hub (disk units)
// slides the clouds. A quarter: panning across the whole default map (±1.28
// disk units) moves them by about a third of a screen, which reads as far
// away but still attached to the world.
const float NEBULA_PARALLAX = 0.25;
void main(){
  vec2 suv=(gl_FragCoord.xy-0.5*u_res)/u_res.y;
  vec3 d=viewRay(suv);
  float t=u_time*NEBULA_RATE;
  vec2 p;
  if(u_dome>0.5){
    // World anchor: clouds on a dome around the world, so orbiting turns them
    // with the terrain and no camera angle can see them stretch; panning
    // slides them a little (NEBULA_PARALLAX).
    p=NEBULA_ZOOM*dome(d)+u_origin.xy*NEBULA_PARALLAX;
  } else {
    // View anchor: the cloud plane is z = 0 in disk space with the eye
    // u_origin.z = NEBULA_ZOOM*focal above it and u_toDisk the identity, which
    // makes p exactly the reference's uv*NEBULA_ZOOM.
    p=u_origin.xy+d.xy*(u_origin.z/-d.z);
  }
  vec2 uv=p/NEBULA_ZOOM;             // the reference's screen coordinate, for the star layers
  vec2 q=vec2(fbm(p+t*0.3), fbm(p+vec2(5.2,1.3)-t*0.2));
  vec2 r=vec2(fbm(p+3.0*q+vec2(1.7,9.2)+t*0.15), fbm(p+3.0*q+vec2(8.3,2.8)-t*0.1));
  float n=fbm(p+2.5*r);
  vec3 deep=vec3(0.05,0.05,0.14), violet=vec3(0.26,0.14,0.42), ember=vec3(0.82,0.45,0.28), pale=vec3(0.55,0.62,0.85);
  vec3 col=mix(deep,violet,smoothstep(0.25,0.6,n));
  col=mix(col,ember,smoothstep(0.55,0.85,n)*0.55*(0.4+0.6*length(q)));
  col=mix(col,pale,smoothstep(0.7,0.95,n)*0.35);
  float s=stars(uv*90.0,0.06,u_time)+0.6*stars(uv*180.0+31.0,0.04,u_time*1.3);
  col+=vec3(0.9,0.9,1.0)*s;
  gl_FragColor=vec4(col,1.0);
}
`;

const WHEEL_FIELDS_GLSL =  `${COMMON_GLSL}
vec2 rot(vec2 p,float a){ float c=cos(a),s=sin(a); return vec2(c*p.x-s*p.y,s*p.x+c*p.y); }
// Disk stars: steady points in the disk plane with a screen-space size floor so far stars
// never shrink below a pixel and shimmer. minSize is in cell units, from the ray length.
float dstars(vec2 p, float density, float minSize){
  vec2 i=floor(p), f=fract(p)-0.5; float h=hash(i);
  if(h>density) return 0.0;
  vec2 o=vec2(hash(i+3.1),hash(i+7.7))-0.5; float d=length(f-o*0.8);
  float size = max(0.03 + 0.05*hash(i+9.2), minSize);
  return smoothstep(size,0.0,d)*(0.5+0.5*h/density);
}
const float WHEEL_RATE   = -0.021; // rad/s (2*pi/300 = ~5.0 min per turn); rev 7 owner 2026-09-04: 'about five minutes per turn'; negative = clockwise from above
// Depth fade, as multiples of the eye's height above the plane so it is the
// same at every zoom in the world anchor: the reference faded between ray
// lengths DISK_DIST (2.6) and FAR_FADE (12.0) with the eye 2.6*cos(60deg) = 1.3
// above the plane, i.e. between 2.0 and ~9.23 heights. The end is a TS constant
// as well: the star field's extents are derived from it.
const float FADE_START_HEIGHTS = 2.0;
const float FADE_END_HEIGHTS   = ${FADE_END_HEIGHTS.toFixed(6)};
const float ARMS         = 4.0;    // four gas arms; owner 2026-09-04: 'more than two'
const float WIND         = 8.0;    // how tightly the arms wind (log-spiral pitch); rev 6: 3.2 -> 6.0 'more circular', rev 7: 8.0
const float ARM_SHARPNESS= 1.4;    // arm cross-section exponent; rev 6: 2.2 -> 1.2 'thicker arms', rev 7: 1.0, rev 14: 1.4 'more definition between the arms'
const float GAS_GAIN     = 1.0;    // brightness of the gas arms; rev 6: 1.5 -> 1.2 'a little darker', rev 7: 1.0
const float BULGE_GAIN   = 0.25;   // warm hub glow; rev 6: 0.55 -> 0.25 and the white core removed, 'get rid of the bright center'
const float ARM_WOBBLE   = 0.25;   // rad of low-frequency phase wander; rev 9: 2.0 'too rigid', rev 10 owner 2026-09-04: 'not random squiggly lines' - arms follow the spiral again
const float ARM_BLEED    = 0.18;   // floor under the arm profile so gas spills across the gaps; rev 10: 0.35 'bleed into each other', rev 14: 0.18 'too homogeneous'
const float WOBBLE_SCALE = 0.6;    // disk units per wobble feature: the arms bend on a scale near the disk radius
const float STREAK_ALONG = 1.6;    // grain cells per e-fold of radius ALONG an arm (long filaments)
const float STREAK_ACROSS= 40.0;   // grain cells around the full circle ACROSS the arms (fine filaments); integer, the y period
const float HUE_SCALE    = 0.7;    // disk units per hue-drift feature between the deep blue and the violet
const float DISK_RADIUS  = ${GAS_DISK_RADIUS.toFixed(1)};    // e-folding radius of the gas disk, plane units; TS: the in-arm stars' extent is derived from it
// Rev 13 (owner 2026-09-05: 'the gas should look diffuse in three dimensions, and the stars should be
// placed in three dimensions', and 'don't make the disk any thicker than four world units'). The
// gas is a volume under the plane, ray-marched: the arm pattern runs through it as columns
// (gasPattern, once per ray), a vertical profile makes it diffuse about each patch's own level,
// and 3-D puff noise breaks it up through the thickness (gasDepthProfile, per sample). The stars are
// points in three 3-D grids: the in-arm stars inside the gas, the field and fine grids on down to
// STAR_FIELD_DEPTH under it, each dimmed by the gas in front of it. They used to be found by walking
// those grids per fragment; since issue #342 they are a point cloud drawn after this program (see
// STARS_VERT_GLSL and the header), and the numbers below that describe them are its numbers too. The
// in-arm grid is the exception: its walk broke before its first voxel, so it has never drawn, and
// STAR_ARM_GRID_ENABLED keeps it off until the owner has seen it.
// Nothing is above the plane, so the clearance to the map is unchanged.
const float DISK_THICKNESS= ${DISK_THICKNESS.toFixed(3)}; // DISK_THICKNESS_WORLD in disk units; gas and stars both stay within it
const int   GAS_STEPS    = 6;      // march samples through the thickness; rev 16 bench: 10 -> 6 saves ~0.5 ms at 1440p, no visible banding
// Rev 14 (owner: 'needs more 3-D variability, still a flat disk'): the depth of peak density is not one
// number but a field - each patch of gas sits at its own level between GAS_TOP_Z and GAS_BOTTOM_Z, in
// a thin layer, so patches above hide and shade the patches below.
const float GAS_TOP_Z    = -0.12*DISK_THICKNESS;  // shallowest layer centre
const float GAS_BOTTOM_Z = -0.88*DISK_THICKNESS;  // deepest layer centre
const float GAS_SCALE_H  = 0.12*DISK_THICKNESS;   // sech^2 scale height of each patch about its own level
const float LEVEL_SCALE  = 5.0;    // level-field features per disk unit: patches change level on about the filament scale
const float LIT_FROM_ABOVE=0.6;    // gas at the bottom of the slab is this much darker than at the top (a depth cue the eye reads)
const float GAS_EXTINCTION=100.0;  // optical depth per unit density per disk unit; 160 read like the rev 10 sheet; rev 17 'colors a little more transparent, maybe 20%' 128; rev 18 owner 2026-09-05 'more transparent' 100
const float PUFF_SCALE   = 12.0;   // 3-D puff noise features per disk unit across the disk
const float PUFF_Z_SCALE = 3.0/DISK_THICKNESS;    // ... and about three through the thickness, so the puffs vary with depth
const float PUFF_DEPTH   = 0.7;    // how much the puffs modulate the density (0 = columnar gas); rev 14: 0.35 -> 0.7
const float PUFF_OCTAVE2 = 0.4;    // weight of the second, finer puff octave (0 drops it: one vnoise3 per march step)
// The grids' depths (STAR_FIELD_DEPTH, STAR_FINE_DEPTH) and their density boost (STAR_POINT_BOOST)
// are TS/JS constants since issue #342: nothing in GLSL reads them now that the point cloud, not the
// fragment, decides where the stars are. STAR_WALK went with the walk itself; the ~80% of the coarse
// depth it reached at 60 degrees was a bench compromise, and the cloud draws every star instead.
const float STAR_GAS_SHADE=0.7;    // how much fully overlying gas dims a star (1 = hidden)
const float STAR_MIN_PX  = 0.8;    // smallest star radius on screen, px
const float CELL_FADE_PX = ${CELL_FADE_PX.toFixed(1)};    // star cells narrower than this on screen fade out (anti-shimmer); TS too, for the per-frame guard
// Rev 17 (owner 2026-09-05: 'make some of the floating stars glow a little bit, and others twinkle just a
// little bit'). Each star draws one kind from its own hash: the first GLOW_FRACTION carry a soft halo
// GLOW_RADIUS times their core, the next TWINKLE_FRACTION breathe in brightness by TWINKLE_DEPTH at
// TWINKLE_RATE with a per-star phase, the rest are steady. u_time is frozen under reduced motion.
const float GLOW_FRACTION   = 0.15;
const float GLOW_RADIUS     = 4.0;   // halo radius as a multiple of the core radius
const float GLOW_GAIN       = 0.35;  // halo peak brightness relative to the core
const float TWINKLE_FRACTION= 0.30;
const float TWINKLE_DEPTH   = 0.35;  // brightness swing, peak to trough, as a fraction of the star
const float TWINKLE_RATE    = 2.2;   // rad/s: about one breath every three seconds
// --- the log-polar bake (perf, issue #340) --------------------------------------------------
// gasPattern and gasLevel below depend only on rf, the rotating-frame plane position, so they are
// evaluated once into two textures at startup (BAKE_GLSL) and read back per fragment. The grid is
// the arms' own coordinate: theta across u, wrapping, and s = log(r + S_LOG_EPS) up v, in which a
// log spiral is a straight line - so a texel keeps the same shape across an arm at every radius
// (its aspect is TAU/BAKE_S_SPAN, a constant) and the grain stays resolved out to the rim.
const float TAU          = 6.2831853;
const float GAS_INNER_R  = ${GAS_INNER_R.toFixed(2)};   // radius over which the gas ramps in from the hub (a ramp, not a floor)
const float S_LOG_EPS    = ${S_LOG_EPS.toFixed(2)};   // the offset in s = log(r + eps); keeps s finite at the hub
const float GAS_BAKE_SIZE= ${GAS_BAKE_SIZE.toFixed(1)}; // texels per axis; the TS constant carries the Nyquist derivation
const float BAKE_S_MIN   = ${GAS_BAKE_S_MIN.toFixed(6)};  // s at the hub: log(S_LOG_EPS)
const float BAKE_S_SPAN  = ${GAS_BAKE_S_SPAN.toFixed(6)};   // log(R_BAKE_MAX + S_LOG_EPS) - BAKE_S_MIN
// The gas pattern on the plane in the rotating frame: the arms, their grain, lanes and colour.
// It is columnar - the same at every depth of the four-unit slab, whose parallax across the
// thickness is under a filament wide - so it is baked ONCE into the log-polar texture above and
// read back per fragment, and the march below only
// varies the vertical profile and the 3-D puffs (rev 16: 6.1 ms -> see the bench in .void-bench).
// ARMS log-spiral arms. The arm's own coordinates: s = log r runs ALONG an arm (a log spiral is a
// straight line in log-polar space) and thw, the angle in the frame wound so every arm is radial,
// runs ACROSS it - an arm sits at a fixed thw. The grain is sampled in (s, thw) with long cells
// along and short cells across, so the filaments run along the curve of each arm.
float gasPattern(vec2 rf, out vec3 gasCol){
  float r=length(rf);
  float th=atan(rf.y,rf.x);
  float s=log(r+S_LOG_EPS);
  float wobble=(fbmLow(rf/WOBBLE_SCALE+vec2(3.0,8.0))-0.5)*2.0*ARM_WOBBLE;
  float phase=th*ARMS-s*WIND+wobble;
  float arm=mix(pow(0.5+0.5*cos(phase),ARM_SHARPNESS),1.0,ARM_BLEED);
  // Unwind by MINUS the arm's own twist so the wound angle is phase/ARMS - constant along an arm.
  vec2 wound=rot(rf,-(s*WIND-wobble)/ARMS);
  float thw=atan(wound.y,wound.x);
  vec2 aq=vec2(s*STREAK_ALONG, (thw/TAU+0.5)*STREAK_ACROSS);
  float grain=0.6*pfbm(aq+vec2(4.0,0.0),STREAK_ACROSS)+0.4*pfbm(aq*2.0+vec2(1.0,0.0),STREAK_ACROSS*2.0);
  float haze=fbmLow(rf*1.4+vec2(9.0,2.0));
  float radial=exp(-r/DISK_RADIUS)*smoothstep(0.0,GAS_INNER_R,r);
  float lanes=smoothstep(0.6,0.78,grain)*arm*0.45;         // dark dust lanes cut through the arms
  // Rev 9 palette: deeper and more saturated - a deep blue drifting into violet across the disk,
  // rose where the grain is dense, a touch of teal in the haze; the warm bulge keeps its colour.
  vec3 deepBlue=vec3(0.08,0.24,0.88), violet=vec3(0.40,0.14,0.82), rose=vec3(0.95,0.30,0.60), teal=vec3(0.12,0.70,0.85);
  float hue=fbmLow(rf/HUE_SCALE+vec2(2.0,5.0));
  gasCol=mix(deepBlue,violet,smoothstep(0.35,0.7,hue));
  gasCol=mix(gasCol,rose,smoothstep(0.55,0.9,grain)*0.7);
  gasCol=mix(gasCol,teal,smoothstep(0.6,0.85,haze)*0.35);
  return (arm*(0.35+1.1*grain)+0.10*haze)*radial*(1.0-lanes);
}
// This patch's depth in the slab: the level field of rev 14, baked alongside the pattern.
float gasLevel(vec2 rf){ return mix(GAS_TOP_Z,GAS_BOTTOM_Z,fbmLow(rf*LEVEL_SCALE+vec2(6.0,13.0))); }
// rf -> bake texture coordinate. u wraps with theta (RepeatWrapping, so the two sides of atan's
// branch cut still filter into each other); v spans the hub to R_BAKE_MAX and clamps beyond it,
// where the gas is under 1e-3 of its peak.
vec2 gasBakeUv(vec2 rf){
  return vec2(atan(rf.y,rf.x)/TAU+0.5, (log(length(rf)+S_LOG_EPS)-BAKE_S_MIN)/BAKE_S_SPAN);
}
// ...and back: the rf that a bake texel centre stands for. Exactly the inverse of gasBakeUv, so a
// lookup lands on the texel that was written for it.
vec2 gasBakeRf(vec2 uv){
  float th=(uv.x-0.5)*TAU;
  return vec2(cos(th),sin(th))*(exp(BAKE_S_MIN+uv.y*BAKE_S_SPAN)-S_LOG_EPS);
}
// Reads the bake through whichever branch of atan has its cut a quarter turn away. RepeatWrapping
// gets the VALUE right across the cut, but u jumps by 1 there, and the quad that straddles the
// jump derives a huge du/dx and drops to the coarsest mip - a blurred radial line along -x, plain
// to see in the hub shot. u+1 reaches the same texel through the branch that is continuous there,
// so its cut lies along +x instead; each fragment takes the branch whose cut it is far from.
// The two branches sample the same texel wherever both are valid, so the switch itself is unseen.
vec4 gasBakeFetch(sampler2D tex, vec2 uv){
  vec4 nearCut=texture2D(tex,vec2(uv.x+1.0-step(0.5,uv.x),uv.y));
  return mix(texture2D(tex,uv),nearCut,step(0.25,abs(uv.x-0.5)));
}
`;

const BAKE_GLSL =  `${WHEEL_FIELDS_GLSL}
uniform float u_bakeField;   // 0: colour and pattern; 1: level
void main(){
  vec2 rf=gasBakeRf(gl_FragCoord.xy/GAS_BAKE_SIZE);
  if(u_bakeField>0.5){ gl_FragColor=vec4(gasLevel(rf),0.0,0.0,1.0); return; }
  vec3 gasCol;
  float pattern=gasPattern(rf,gasCol);
  gl_FragColor=vec4(gasCol,pattern);
}
`;

const GAS_GLSL =  `${WHEEL_FIELDS_GLSL}
// The baked fields: gasPattern's colour in rgb and its pattern in a, gasLevel in the second
// texture's r. Half float, so the pattern's ~1.55 peak needs no scaling on the way through.
uniform sampler2D u_gasBake;
uniform sampler2D u_gasLevel;
// This pass's own resolution in texels; u_res stays the FULL-res drawing buffer in both programs.
uniform vec2 u_gasRes;
// Declared for the bench harness, which lifts it to size its own target (.void-bench/gl2.js); the
// app sizes the render target from the TS constant of the same name. The pass itself needs only
// the two resolutions, because ceil() rounding makes the ratio not exactly the divisor.
const float GAS_RES_DIVISOR = ${GAS_RES_DIVISOR.toFixed(1)};
// The gas's variation through the thickness at a point: a sech^2 layer about this patch's own level,
// broken up by 3-D puffs. Multiplies gasPattern.
float gasDepthProfile(vec2 rf, float z, float level){
  float dz=(z-level)/GAS_SCALE_H;
  float ch=exp(dz)+exp(-dz);
  float vert=4.0/(ch*ch);                                    // sech^2 (no cosh in GLSL ES 1.00): diffuse both ways about the level
  vec3 pq=vec3(rf*PUFF_SCALE,z*PUFF_Z_SCALE);
  float puff=(1.0-PUFF_OCTAVE2)*vnoise3(pq)+PUFF_OCTAVE2*vnoise3(pq*2.1+vec3(3.0,1.0,7.0));
  float puffMod=1.0-PUFF_DEPTH+2.0*PUFF_DEPTH*puff;          // mean 1
  return vert*puffMod;
}
void main(){
  // The full-res pixel this texel stands for. Scaling the texel centre by the exact ratio of the
  // two buffers — not by GAS_RES_DIVISOR — is what keeps the two passes on the same uv when the
  // drawing buffer has an odd dimension and the target was rounded up. The wheel reads back at
  // gl_FragCoord.xy/u_res, which is this mapping inverted exactly.
  vec2 full=gl_FragCoord.xy*(u_res/u_gasRes);
  vec2 uv=(full-0.5*u_res)/u_res.y;
  float a=u_time*WHEEL_RATE;
  vec3 d=viewRay(uv);                    // disk space: plane z = 0, hub at the origin
  if(d.z>=0.0){ gl_FragColor=vec4(0.0); return; }   // above the plane's horizon: no gas to march
  float sdist=-u_origin.z/d.z;           // ray length to the plane
  vec2 pp=u_origin.xy+d.xy*sdist;        // disk coordinates, hub at the origin
  vec2 rf=rot(pp,-a);                    // rotating frame: everything sampled here turns rigidly

  // --- gas: the plane pattern once, then march the thickness front to back ---
  vec2 bakeUv=gasBakeUv(rf);
  vec4 baked=gasBakeFetch(u_gasBake,bakeUv);
  vec3 gasCol=baked.rgb;
  float pattern=baked.a;
  float level=gasBakeFetch(u_gasLevel,bakeUv).r;                                  // this patch's depth
  float tBottom=(u_origin.z+DISK_THICKNESS)/-d.z;
  float dt=(tBottom-sdist)/float(GAS_STEPS);
  float gasAcc=0.0;                     // lit weight so far
  float T=1.0;                          // transmittance so far
  for(int i=0;i<GAS_STEPS;i++){
    float t=sdist+(float(i)+0.5)*dt;
    vec3 q=u_origin+d*t;
    float dens=pattern*gasDepthProfile(rot(q.xy,-a),q.z,level);
    float lit=1.0-LIT_FROM_ABOVE*clamp(-q.z/DISK_THICKNESS,0.0,1.0);   // deeper gas is darker
    float alpha=1.0-exp(-dens*GAS_EXTINCTION*dt);
    gasAcc+=T*alpha*lit;
    T*=1.0-alpha;
  }
  gl_FragColor=vec4(gasCol*gasAcc,1.0-T);   // lit colour before GAS_GAIN; alpha = total gas opacity
}
`;

const WHEEL_GLSL =  `${WHEEL_FIELDS_GLSL}
// The half-res gas pass's output (issue #341): rgb = gasCol*gasAcc before GAS_GAIN, a = the gas
// opacity. Bilinear, so a full-res pixel between texel centres gets the interpolated field.
uniform sampler2D u_gasHalf;
void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*u_res)/u_res.y;
  float a=u_time*WHEEL_RATE;
  vec3 col=vec3(0.012,0.014,0.03);

  vec3 d=viewRay(uv);                    // disk space: plane z = 0, hub at the origin
  if(d.z<0.0){
    float sdist=-u_origin.z/d.z;         // ray length to the plane
    vec2 pp=u_origin.xy+d.xy*sdist;      // disk coordinates, hub at the origin
    vec2 rf=rot(pp,-a);                  // rotating frame: everything sampled here turns rigidly
    float r=length(rf);
    float depthFade=1.0-smoothstep(FADE_START_HEIGHTS*u_origin.z,FADE_END_HEIGHTS*u_origin.z,sdist);
    if(depthFade<=0.0){ gl_FragColor=vec4(col,1.0); return; }   // fully faded: nothing below would show

    // --- gas: marched at half resolution into u_gasHalf (issue #341), read back here ---
    // The exact inverse of the gas pass's own mapping, so the texel a pixel lands on is the one
    // written for it; between centres the bilinear filter interpolates a field that is smooth
    // everywhere below the horizon, which is why the fade and the gain stay out of it.
    vec4 gasHalf=texture2D(u_gasHalf,gl_FragCoord.xy/u_res);
    vec3 gasCol=gasHalf.rgb;              // lit gas colour (gasCol*gasAcc), before GAS_GAIN
    float bulge=exp(-r*2.0);
    vec3 warm=vec3(1.0,0.88,0.62);
    col+=(gasCol*GAS_GAIN+warm*bulge*BULGE_GAIN)*depthFade;
    // The stars under the plane are no longer found here: they are a point cloud drawn straight
    // over this program's output, additively (issue #342, STARS_VERT_GLSL below). col += stars
    // was already the composite, so the arithmetic is unchanged.
  } else {
    // Above the plane's horizon (never in the view anchor at 60deg; the world anchor at a flat
    // orbit): a still, sparse field so the void is not empty, fixed to the sky direction.
    col+=vec3(0.8,0.82,0.9)*0.4*stars(dome(d)*110.0+5.0,0.03,0.0);
  }
  gl_FragColor=vec4(col,1.0);
}
`;

const STARS_VERT_GLSL =  `${WHEEL_FIELDS_GLSL}
// Which grid this Points object is: 0 the coarse field, 1 the fine field, 2 the in-arm stars (which
// STAR_ARM_GRID_ENABLED keeps off - the branch below is kept because it is the intended design, not
// because anything reaches it today). It is a property of the OBJECT, not of the vertex, so it is a
// uniform and the materials differ in nothing else (see createStarPoints).
uniform float u_starGrid;
// The half-res gas pass's output (issue #341). Only its alpha is read here — the total gas opacity
// along the ray — and only once per star, at the star's own screen position. Bilinear, no mips, so
// a vertex-shader texture2D is well defined under GLSL ES 1.00.
uniform sampler2D u_gasHalf;
// The widest a sprite may be: the drawing buffer's long edge. The fragment's falloff is measured
// across the sprite, so the clamp has to happen here where both the size and the varying that
// carries it can see it.
uniform float u_pointSizeMax;
// Per star: radius in disk units, kind on [0,1), brightness on [0.5,1) - the three draws the voxel
// hashes used to make, now generated once (render/celestialVoidStars.ts).
attribute vec3 starShape;
varying vec3 v_col;      // the star's colour, everything but the falloff already applied
varying vec3 v_shape;    // core radius in px, 1 for a glow star, and the sprite's width in px
const float STAR_GRID_FINE = 1.0;
const float STAR_GRID_ARM  = 2.0;
const float STAR_FINE_CELLS_PER_UNIT = ${STAR_FINE_CELLS_PER_UNIT.toFixed(1)};  // the cell fade's own measure, for the in-arm grid as well as the fine one
const float FINE_GRID_WEIGHT = 0.6;   // the fine field's stars are drawn dimmer than the coarse field's
const float FIELD_GAS_LIFT   = 0.45;  // a field star keeps this much of itself with no gas in front of it...
const float FIELD_GAS_GAIN   = 0.9;   // ...and gains this much where the gas is thickest
const float ARM_GRID_GAIN    = ${ARM_GRID_GAIN.toFixed(1)};   // in-arm stars are revealed BY the gas: bright only where it is
const float POINT_SPRITE_MARGIN_PX = 2.0;  // so the smoothstep's tail is not clipped by the sprite's edge
// Clip space well outside the frustum, for a star that must not rasterise at all.
const vec4 OFF_SCREEN = vec4(2.0,2.0,2.0,1.0);
void main(){
  // The rotating frame back into disk space: the wheel samples at rot(pp,-a), so this is that
  // inverted, and the field turns rigidly with the gas exactly as before.
  float a=u_time*WHEEL_RATE;
  vec3 P=vec3(rot(position.xy,a),position.z);
  vec3 rel=P-u_origin;
  // Disk space back into view space. u_toDisk is a rotation, so its inverse is its transpose, and
  // rel*u_toDisk is that product (a row vector times the matrix). viewRay is the same map the
  // other way: u_toDisk*normalize(vec3(uv,-u_focal)).
  vec3 v=rel*u_toDisk;
  if(v.z>=0.0){ gl_Position=OFF_SCREEN; gl_PointSize=0.0; return; }   // behind the eye
  // Screen heights, the wheel's own uv convention. Named suv, not uv: three declares an attribute
  // vec2 uv in every ShaderMaterial's vertex prefix and shadowing it here would only confuse.
  vec2 suv=-v.xy*u_focal/v.z;
  vec2 ndc=2.0*suv*u_res.y/u_res;
  float t=length(rel);                   // disk units along the ray from the eye (the walk's tBase+along/scale)
  float sdist=-u_origin.z*t/rel.z;       // ray length to the plane along THIS star's ray
  float depthFade=1.0-smoothstep(FADE_START_HEIGHTS*u_origin.z,FADE_END_HEIGHTS*u_origin.z,sdist);
  float pxPerUnit=u_focal*u_res.y/sdist;
  float cellFade=smoothstep(CELL_FADE_PX,CELL_FADE_PX*3.0,pxPerUnit/STAR_FINE_CELLS_PER_UNIT);
  float weight=u_starGrid<STAR_GRID_FINE?1.0:(u_starGrid<STAR_GRID_ARM?FINE_GRID_WEIGHT*cellFade:cellFade);
  // The walk's max(size, minPerT*t*scale) projected: a star never shrinks below STAR_MIN_PX.
  float rPx=max(starShape.x*u_focal*u_res.y/t,STAR_MIN_PX);
  float glow=starShape.y<GLOW_FRACTION?1.0:0.0;
  float size=min(2.0*rPx*mix(1.0,GLOW_RADIUS,glow)+POINT_SPRITE_MARGIN_PX,u_pointSizeMax);
  // Faded out, or off screen by more than the sprite's own half width: no fragment, and no fetch.
  // At the reference pose over nine tenths of the coarse field is off screen and the fetch is by
  // far the most expensive thing here, so the order matters.
  if(depthFade<=0.0||weight<=0.0||abs(ndc.x)>1.0+size/u_res.x||abs(ndc.y)>1.0+size/u_res.y){
    gl_Position=OFF_SCREEN; gl_PointSize=0.0; return;
  }
  float gas=texture2D(u_gasHalf,ndc*0.5+0.5).a;   // total gas opacity along the ray
  // The field grids are dimmed by the gas over them and lifted by the gas in front of them; the
  // in-arm stars are INSIDE the gas, so nothing is over them and the gas is what reveals them.
  float above=u_starGrid<STAR_GRID_ARM?gas:0.0;
  float outer=u_starGrid<STAR_GRID_ARM?FIELD_GAS_LIFT+FIELD_GAS_GAIN*gas:1.0;
  if(u_starGrid>=STAR_GRID_ARM) weight*=gas*ARM_GRID_GAIN;
  float dim=1.0-STAR_GAS_SHADE*above*clamp(-position.z/DISK_THICKNESS,0.0,1.0);
  // Rev 17's kinds, unchanged: the first GLOW_FRACTION carry a halo (the fragment adds it), the
  // next TWINKLE_FRACTION breathe, the rest are steady. u_time is frozen under reduced motion.
  float twinkle=1.0;
  if(glow<0.5&&starShape.y<GLOW_FRACTION+TWINKLE_FRACTION)
    twinkle=1.0-TWINKLE_DEPTH*(0.5+0.5*sin(u_time*TWINKLE_RATE+starShape.y*40.0));
  v_col=vec3(0.95,0.93,0.9)*starShape.z*dim*twinkle*weight*outer*depthFade*depthFade;
  v_shape=vec3(rPx,glow,size);
  gl_Position=vec4(ndc,0.0,1.0);
  gl_PointSize=size;
}
`;

const STARS_FRAG_GLSL =  `${WHEEL_FIELDS_GLSL}
varying vec3 v_col;
varying vec3 v_shape;
void main(){
  float d=length((gl_PointCoord-0.5)*v_shape.z);
  float core=smoothstep(v_shape.x,0.0,d);
  if(v_shape.y>0.5) core+=GLOW_GAIN*smoothstep(v_shape.x*GLOW_RADIUS,0.0,d);
  gl_FragColor=vec4(v_col*core,0.0);
}
`;

const FRAGMENT_SHADER: Record<VoidStyle, string> = {
  nebula: NEBULA_GLSL,
  wheel: WHEEL_GLSL,
};

export interface CelestialVoid {
  setStyle(style: VoidStyle): void;
  setAnchor(anchor: VoidAnchor): void;
  dispose(): void;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface DiskFrame {
  focal: number;
  toDisk: Matrix3;
  origin: Vector3;
}

function viewAnchorFrame(style: VoidStyle): DiskFrame {
  if (style === 'nebula') {
    return {
      focal: VIEW_FOCAL,
      toDisk: new Matrix3().identity(),
      origin: new Vector3(0, 0, NEBULA_ZOOM * VIEW_FOCAL),
    };
  }
  const tilt = (WHEEL_TILT_DEGREES * Math.PI) / 180;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  // prettier-ignore
  const toDisk = new Matrix3().set(
    1, 0,   0,
    0, ct, -st,
    0, st,  ct,
  );
  return {
    focal: VIEW_FOCAL,
    toDisk,
    origin: new Vector3(0, -st * VIEW_HUB_DISTANCE, ct * VIEW_HUB_DISTANCE),
  };
}

// prettier-ignore
const WORLD_TO_DISK = new Matrix3().set(
  1, 0,  0,
  0, 0, -1,
  0, 1,  0,
);

const CORE_RIG_STARS_NAME = 'core:void-stars';
const CORE_RIG_VOID_NAME = 'core:void';

export function createCelestialVoid(
  viewport: Viewport,
  initialStyle: VoidStyle,
  initialAnchor: VoidAnchor,
  worldSize: () => number,
): CelestialVoid {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(FULLSCREEN_TRIANGLE_POSITIONS, 3),
  );

  const uniforms: Record<string, IUniform> = {
    u_res: { value: new Vector2(1, 1) },
    u_time: { value: 0 },
    u_focal: { value: VIEW_FOCAL },
    u_toDisk: { value: new Matrix3() },
    u_origin: { value: new Vector3() },
    u_dome: { value: 0 },
    u_gasBake: { value: null },
    u_gasLevel: { value: null },
    u_gasRes: { value: new Vector2(1, 1) },
    u_gasHalf: { value: null },
  };
  const writeFrame = (frame: DiskFrame): void => {
    (uniforms['u_focal'] as IUniform<number>).value = frame.focal;
    (uniforms['u_toDisk'] as IUniform<Matrix3>).value.copy(frame.toDisk);
    (uniforms['u_origin'] as IUniform<Vector3>).value.copy(frame.origin);
  };

  let style = initialStyle;
  let anchor = initialAnchor;
  const worldFrame: DiskFrame = {
    focal: VIEW_FOCAL,
    toDisk: new Matrix3(),
    origin: new Vector3(),
  };
  const cameraToWorld = new Matrix3();
  const hub = new Vector3();
  const writeWorldFrame = (camera: PerspectiveCamera): void => {
    worldFrame.focal = 0.5 / Math.tan((camera.fov * Math.PI) / 360);
    cameraToWorld.setFromMatrix4(camera.matrixWorld);
    worldFrame.toDisk.multiplyMatrices(WORLD_TO_DISK, cameraToWorld);
    const halfSpan = (worldSize() * CELL_WORLD_SIZE) / 2;
    hub.set(halfSpan, LOCKED_HUB_WORLD_Y, halfSpan);
    worldFrame.origin
      .copy(camera.position)
      .sub(hub)
      .applyMatrix3(WORLD_TO_DISK)
      .divideScalar(LOCKED_WORLD_UNITS_PER_DISK_UNIT);
    writeFrame(worldFrame);
  };
  const applyAnchor = (): void => {
    (uniforms['u_dome'] as IUniform<number>).value = anchor === 'world' ? 1 : 0;
    if (anchor === 'view') writeFrame(viewAnchorFrame(style));
  };
  applyAnchor();

  const makeBakeTarget = (format: PixelFormat): WebGLRenderTarget =>
    new WebGLRenderTarget(GAS_BAKE_SIZE, GAS_BAKE_SIZE, {
      type: HalfFloatType,
      format,
      wrapS: RepeatWrapping,
      wrapT: ClampToEdgeWrapping,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
    });

  const BAKE_FIELD_PATTERN = 0;
  const BAKE_FIELD_LEVEL = 1;

  let bakeTargets: WebGLRenderTarget[] = [];
  const bakeGasPattern = (): void => {
    const material = new ShaderMaterial({
      uniforms: { u_bakeField: { value: BAKE_FIELD_PATTERN } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: BAKE_GLSL,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const bakeMesh = new Mesh(geometry, material);
    bakeMesh.frustumCulled = false;
    const bakeScene = new Scene().add(bakeMesh);
    const bakeCamera = new Camera();
    const { renderer } = viewport;
    const previous = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmap = renderer.getActiveMipmapLevel();
    bakeTargets = [makeBakeTarget(RGBAFormat), makeBakeTarget(RedFormat)];
    for (const field of [BAKE_FIELD_PATTERN, BAKE_FIELD_LEVEL]) {
      (material.uniforms['u_bakeField'] as IUniform<number>).value = field;
      renderer.setRenderTarget(bakeTargets[field] as WebGLRenderTarget);
      renderer.render(bakeScene, bakeCamera);
    }
    renderer.setRenderTarget(previous, previousCubeFace, previousMipmap);
    material.dispose();
    (uniforms['u_gasBake'] as IUniform<Texture>).value = (
      bakeTargets[BAKE_FIELD_PATTERN] as WebGLRenderTarget
    ).texture;
    (uniforms['u_gasLevel'] as IUniform<Texture>).value = (
      bakeTargets[BAKE_FIELD_LEVEL] as WebGLRenderTarget
    ).texture;
  };

  let gasTarget: WebGLRenderTarget | null = null;
  let gasMaterial: ShaderMaterial | null = null;
  let gasScene: Scene | null = null;
  let gasCamera: Camera | null = null;
  const drawingBuffer = new Vector2();

  const sizeGasTarget = (width: number, height: number): void => {
    if (gasTarget === null) return;
    const w = Math.ceil(width / GAS_RES_DIVISOR);
    const h = Math.ceil(height / GAS_RES_DIVISOR);
    if (gasTarget.width === w && gasTarget.height === h) return;
    gasTarget.setSize(w, h);
    (uniforms['u_gasRes'] as IUniform<Vector2>).value.set(w, h);
  };

  const createGasPass = (): void => {
    const { renderer } = viewport;
    renderer.getDrawingBufferSize(drawingBuffer);
    gasTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    sizeGasTarget(drawingBuffer.x, drawingBuffer.y);
    gasMaterial = new ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: GAS_GLSL,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const gasMesh = new Mesh(geometry, gasMaterial);
    gasMesh.frustumCulled = false;
    gasScene = new Scene().add(gasMesh);
    gasCamera = new Camera();
    (uniforms['u_gasHalf'] as IUniform<Texture>).value = gasTarget.texture;
  };

  const renderGasPass = (): void => {
    if (gasScene === null || gasCamera === null || gasTarget === null) return;
    const { renderer } = viewport;
    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmap = renderer.getActiveMipmapLevel();
    const previousXrEnabled = renderer.xr.enabled;
    const previousInfoAutoReset = renderer.info.autoReset;
    renderer.xr.enabled = false;
    renderer.info.autoReset = false;
    renderer.setRenderTarget(gasTarget);
    renderer.render(gasScene, gasCamera);
    renderer.info.autoReset = previousInfoAutoReset;
    renderer.xr.enabled = previousXrEnabled;
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmap);
  };

  let starPoints: Points[] = [];

  const createStarPoints = (): void => {
    const { renderer } = viewport;
    renderer.getDrawingBufferSize(drawingBuffer);
    const pointSizeMax: IUniform<number> = {
      value: Math.max(drawingBuffer.x, drawingBuffer.y),
    };
    starPoints = STAR_GRIDS.map((spec, grid) => {
      const buffers = generateStarGrid(spec);
      const starGeometry = new BufferGeometry();
      starGeometry.setAttribute('position', new BufferAttribute(buffers.position, 3));
      starGeometry.setAttribute('starShape', new BufferAttribute(buffers.shape, 3));
      const material = new ShaderMaterial({
        uniforms: { ...uniforms, u_starGrid: { value: grid }, u_pointSizeMax: pointSizeMax },
        vertexShader: STARS_VERT_GLSL,
        fragmentShader: STARS_FRAG_GLSL,
        blending: AdditiveBlending,
        premultipliedAlpha: true,
        transparent: false,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const points = new Points(starGeometry, material);
      points.frustumCulled = false;
      points.matrixAutoUpdate = false;
      points.renderOrder = STARS_RENDER_ORDER;
      points.visible = style === 'wheel';
      points.name = `${CORE_RIG_STARS_NAME}-${String(grid)}`;
      viewport.scene.add(points);
      return points;
    });
  };

  const updateStarVisibility = (): void => {
    if (starPoints.length === 0) return;
    const wheel = style === 'wheel';
    const origin = (uniforms['u_origin'] as IUniform<Vector3>).value;
    const res = (uniforms['u_res'] as IUniform<Vector2>).value;
    const focal = (uniforms['u_focal'] as IUniform<number>).value;
    const fine =
      origin.z < (focal * res.y) / (STAR_FINE_CELLS_PER_UNIT * CELL_FADE_PX);
    starPoints.forEach((points, grid) => {
      points.visible = wheel && (grid === 0 || fine);
    });
  };

  const materials = new Map<VoidStyle, ShaderMaterial>();
  const materialFor = (style: VoidStyle): ShaderMaterial => {
    const cached = materials.get(style);
    if (cached !== undefined) return cached;
    if (style === 'wheel') {
      bakeGasPattern();
      createGasPass();
      createStarPoints();
    }
    const material = new ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER[style],
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    materials.set(style, material);
    return material;
  };

  const mesh = new Mesh(geometry, materialFor(initialStyle));
  mesh.frustumCulled = false;
  mesh.renderOrder = VOID_RENDER_ORDER;
  mesh.matrixAutoUpdate = false;
  mesh.onBeforeRender = (_renderer, _scene, camera): void => {
    if (anchor === 'world') writeWorldFrame(camera as PerspectiveCamera);
    updateStarVisibility();
    if (style === 'wheel') renderGasPass();
  };
  mesh.name = CORE_RIG_VOID_NAME;
  viewport.scene.add(mesh);

  const frozen = prefersReducedMotion();

  const stopFrames = viewport.onFrame((dt) => {
    if (!frozen) (uniforms['u_time'] as IUniform<number>).value += dt;
    viewport.renderer.getDrawingBufferSize(drawingBuffer);
    (uniforms['u_res'] as IUniform<Vector2>).value.copy(drawingBuffer);
    sizeGasTarget(drawingBuffer.x, drawingBuffer.y);
  });

  return {
    setStyle(next: VoidStyle): void {
      style = next;
      mesh.material = materialFor(next);
      applyAnchor();
      updateStarVisibility();
    },
    setAnchor(next: VoidAnchor): void {
      anchor = next;
      applyAnchor();
    },
    dispose(): void {
      stopFrames();
      viewport.scene.remove(mesh);
      for (const material of materials.values()) material.dispose();
      materials.clear();
      for (const target of bakeTargets) target.dispose();
      bakeTargets = [];
      gasMaterial?.dispose();
      gasMaterial = null;
      gasTarget?.dispose();
      gasTarget = null;
      gasScene?.clear();
      gasScene = null;
      gasCamera = null;
      for (const points of starPoints) {
        viewport.scene.remove(points);
        points.geometry.dispose();
        (points.material as ShaderMaterial).dispose();
      }
      starPoints = [];
      geometry.dispose();
    },
  };
}
