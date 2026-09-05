// Reference shaders for arc celestial-void, lifted verbatim from the approved
// concept page (https://claude.ai/code/artifact/53915c5c-1373-496c-b6ad-6a58a0303ced).
// REVISION 15 (owner 2026-09-05): 'substantially more Z variability for the stars' - the star
// field is a 3-D voxel walk (stars3, Amanatides-Woo) down to STAR_FIELD_DEPTH 0.600 disk units
// (120 world units) under the plane, the fine grid to half that, the in-arm stars inside the gas.
// STAR_POINT_BOOST 3 keeps the count up (a ray must pass within a point's radius in 3-D),
// STAR_GAS_SHADE 0.7 dims stars under the gas. The gas keeps to DISK_THICKNESS.
// REVISION 14 (owner 2026-09-05): 'more 3-D variability, still a flat disk; more definition between
// the arms, too homogeneous' - each gas patch sits at its own level between GAS_TOP_Z and
// GAS_BOTTOM_Z (LEVEL_SCALE field), thinner layers (GAS_SCALE_H 0.12 T, GAS_STEPS 10), puffs
// 0.7, deeper gas darker (LIT_FROM_ABOVE 0.6), GAS_EXTINCTION 160; ARM_SHARPNESS 1.4, ARM_BLEED 0.18.
// REVISION 13 (owner 2026-09-05): 'the gas should look diffuse in three dimensions, and the
// stars should be placed in three dimensions', 'don't make the disk any thicker than four world
// units' - DISK_THICKNESS 0.020 disk units (4 world units at 200/unit). The gas is a ray-marched
// volume under the plane (sech^2 profile about GAS_MID_Z, 3-D puff noise, GAS_STEPS 6); the
// stars are points at hashed depths in the slab, found by walking the plane grid along the ray
// (stars3) and dimmed by the gas in front of them. Nothing above the plane. hash3/vnoise3 in common.
// REVISION 12 (superseded the same day): a rippled sheet - 'I don't want it wavy'.
// REVISION 11 (superseded the same day): three stacked copies of the sheet.
// REVISION 10 (owner 2026-09-04): ARM_WOBBLE 2.0 -> 0.25 ('not random squiggly lines'),
// ARM_BLEED 0.35 floor under the arm profile and softer lanes ('bleed into each other').
// Client-side only: LOCKED_HUB_CLEARANCE_WORLD 5 -> 2.
// REVISION 9 (owner 2026-09-04): arm CONTENT — grain streaks along each arm's curve
// (periodic noise in (log r, wound angle)), ARM_WOBBLE phase wander, deeper palette.
// The reference's wound frame rotated the wrong way, which is why its grain cut across.
// REVISION 8 (owner 2026-09-04): plumbing only, no look change — both shaders
// take an anchor frame (u_focal, u_toDisk mat3, u_origin vec3, disk space with
// the plane at z=0) instead of u_tilt, so the client can lock the void to the
// world's plane. The view anchor's frame reproduces revision 7 exactly; see
// client/src/render/celestialVoid.ts viewAnchorFrame().
// REVISION 7 (owner 2026-09-04): WHEEL_RATE -0.021 (five minutes per turn),
// GAS_GAIN 1.0, ARM_SHARPNESS 1.0, WIND 8.0.
// REVISION 6 (owner 2026-09-04, in-world feedback): rate slowed by a third
// (-0.0267), white core removed and bulge dimmed (0.25), gas gain 1.5 -> 1.2,
// arms thicker (exponent 2.2 -> 1.2) and wound tighter (WIND 3.2 -> 6.0).
// REVISION 5 (owner 2026-09-04): on top of revision 4's spiral galaxy, the
// wheel turns 5x faster (WHEEL_RATE -0.04, ~2.6 min per turn) and has four gas
// arms (ARMS 4.0). Everything else in revision 4 stands: rigid disk at 60 deg,
// log-spiral arms with wound grain and dust lanes, warm bulge, stars embedded in
// the disk plane rotating with the gas, still sparse field above the horizon,
// no twinkle, no trails. Nebula unchanged (NEBULA_RATE 0.15).
// GLSL ES 1.00 (WebGL1) as written; port to three's ShaderMaterial conventions.
// Uniforms: u_res (vec2 px), u_time (s), u_focal, u_toDisk (mat3), u_origin (vec3), u_dome (0/1).
// uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y  — i.e. screen-space, y up, height = 1.

// ===== common =====
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

// ===== nebula =====
const float NEBULA_RATE = 0.15;   // drift clock scale; owner set 3x the original 0.05
const float NEBULA_ZOOM = 2.2; // reference: p = uv*2.2
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

// ===== wheel =====
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
// above the plane, i.e. between 2.0 and ~9.23 heights.
const float FADE_START_HEIGHTS = 2.0;
const float FADE_END_HEIGHTS   = 12.0/1.3;
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
const float DISK_RADIUS  = 1.7;    // e-folding radius of the gas disk, plane units
// Rev 13 (owner 2026-09-05: 'the gas should look diffuse in three dimensions, and the stars should be
// placed in three dimensions', and 'don't make the disk any thicker than four world units'). The
// gas is a volume under the plane, ray-marched: the arm pattern runs through it as columns, a
// vertical profile makes it diffuse about each patch's own level, and 3-D puff noise breaks it up through the
// thickness. The stars are points in 3-D voxel grids that the ray walks exactly: the in-arm stars
// inside the gas, the field and fine grids on down to STAR_FIELD_DEPTH under it, each dimmed by the
// gas in front of it. Nothing is above the plane, so the clearance to the map is unchanged.
const float DISK_THICKNESS= 0.020; // DISK_THICKNESS_WORLD in disk units; gas and stars both stay within it
const int   GAS_STEPS    = 10;     // march samples through the thickness; the layers are ~0.12 T thick, so ~1 sample per layer at 60 deg
// Rev 14 (owner: 'needs more 3-D variability, still a flat disk'): the depth of peak density is not one
// number but a field - each patch of gas sits at its own level between GAS_TOP_Z and GAS_BOTTOM_Z, in
// a thin layer, so patches above hide and shade the patches below.
const float GAS_TOP_Z    = -0.12*DISK_THICKNESS;  // shallowest layer centre
const float GAS_BOTTOM_Z = -0.88*DISK_THICKNESS;  // deepest layer centre
const float GAS_SCALE_H  = 0.12*DISK_THICKNESS;   // sech^2 scale height of each patch about its own level
const float LEVEL_SCALE  = 5.0;    // level-field features per disk unit: patches change level on about the filament scale
const float LIT_FROM_ABOVE=0.6;    // gas at the bottom of the slab is this much darker than at the top (a depth cue the eye reads)
const float GAS_EXTINCTION=160.0;  // optical depth per unit density per disk unit; scaled so the thin slab reads like the rev 10 sheet
const float PUFF_SCALE   = 12.0;   // 3-D puff noise features per disk unit across the disk
const float PUFF_Z_SCALE = 3.0/DISK_THICKNESS;    // ... and about three through the thickness, so the puffs vary with depth
const float PUFF_DEPTH   = 0.7;    // how much the puffs modulate the density (0 = columnar gas); rev 14: 0.35 -> 0.7
const float STAR_FIELD_DEPTH=0.600; // STAR_FIELD_DEPTH_WORLD in disk units: the coarse star grid reaches this far under the plane
const float STAR_FINE_DEPTH=0.5*STAR_FIELD_DEPTH;  // the fine grid reaches half as deep (it has twice the cells per unit, so the same voxel budget)
const float STAR_POINT_BOOST=3.0;  // a ray must pass within a star's radius in 3-D, not cross a disc: more stars per voxel to keep the count on screen
const float STAR_GAS_SHADE=0.7;    // how much fully overlying gas dims a star (1 = hidden)
const int   STAR_WALK    = 36;     // voxel visits per star grid per ray; covers STAR_FIELD_DEPTH in the coarse grid at 60 deg, flatter views lose the deepest stars
const float STAR_MIN_PX  = 0.8;    // smallest star radius on screen, px
const float CELL_FADE_PX = 4.0;    // star cells narrower than this on screen fade out (anti-shimmer)
// Stars as points in 3-D. The grid has scale cells per disk unit; the ray is walked voxel by voxel
// (Amanatides-Woo) from the plane down to -depth, and each voxel that holds a star lights up by the
// ray's 3-D distance to that point. density is per column of the plane grid and is spread over the
// column's voxels, so a deeper field is not a denser one. minSizePerT is the screen-size floor in
// disk units per unit ray length; tBase the ray length from the eye to o (on the plane). above is
// the gas opacity along the ray, which dims the stars under the gas by how much of it is over them.
float stars3(vec3 o, vec3 d, float tBase, float scale, float density, float depth, float minSizePerT, float seed, float above){
  vec3 p=o*scale;                        // grid units, plane at z = 0
  vec3 cell=floor(p-vec3(0.0,0.0,0.001)); // start in the voxel just under the plane
  vec3 stp=sign(d);
  vec3 tDelta=abs(1.0/d);
  vec3 tMax=(cell+max(stp,0.0)-p)*tDelta*stp;   // grid-unit ray lengths to the next cell walls
  float zBot=-depth*scale;
  float perVoxel=density*STAR_POINT_BOOST/(depth*scale);
  float sum=0.0;
  for(int i=0;i<STAR_WALK;i++){
    if(cell.z<zBot) break;
    float h=hash3(cell+seed);
    if(h<perVoxel){
      vec3 P=cell+0.1+0.8*vec3(hash3(cell+seed+3.1),hash3(cell+seed+7.7),hash3(cell+seed+5.3));
      vec3 rel=P-p;
      float along=dot(rel,d);
      float dist=length(rel-along*d);
      float t=tBase+along/scale;         // disk units along the ray from the eye
      float size=max(0.03+0.05*hash3(cell+seed+9.2), minSizePerT*t*scale);
      float dim=1.0-STAR_GAS_SHADE*above*clamp(-P.z/(DISK_THICKNESS*scale),0.0,1.0); // gas above this star
      sum+=smoothstep(size,0.0,dist)*(0.5+0.5*h/perVoxel)*dim;
    }
    if(tMax.x<tMax.y && tMax.x<tMax.z){ cell.x+=stp.x; tMax.x+=tDelta.x; }
    else if(tMax.y<tMax.z){ cell.y+=stp.y; tMax.y+=tDelta.y; }
    else { cell.z+=stp.z; tMax.z+=tDelta.z; }
  }
  return sum;
}
// Gas density at a point of the volume: rf the rotating-frame xy, z <= 0 the depth, q the point in
// the fixed frame for the puff noise. The arm pattern is columnar (the same at every z) and the
// filaments' grain with it; the vertical profile and the 3-D puffs give the volume its depth.
// ARMS log-spiral arms. The arm's own coordinates: s = log r runs ALONG an arm (a log spiral is a
// straight line in log-polar space) and thw, the angle in the frame wound so every arm is radial,
// runs ACROSS it - an arm sits at a fixed thw. The grain is sampled in (s, thw) with long cells
// along and short cells across, so the filaments run along the curve of each arm.
float gasDensity(vec2 rf, float z, vec3 q, float wobble, float level, out float grain, out float haze){
  float r=length(rf);
  float th=atan(rf.y,rf.x);
  float s=log(r+0.05);
  float phase=th*ARMS-s*WIND+wobble;
  float arm=mix(pow(0.5+0.5*cos(phase),ARM_SHARPNESS),1.0,ARM_BLEED);
  // Unwind by MINUS the arm's own twist so the wound angle is phase/ARMS - constant along an arm.
  vec2 wound=rot(rf,-(s*WIND-wobble)/ARMS);
  float thw=atan(wound.y,wound.x);
  vec2 aq=vec2(s*STREAK_ALONG, (thw/6.2831853+0.5)*STREAK_ACROSS);
  grain=0.6*pfbm(aq+vec2(4.0,0.0),STREAK_ACROSS)+0.4*pfbm(aq*2.0+vec2(1.0,0.0),STREAK_ACROSS*2.0);
  haze=fbm(rf*1.4+vec2(9.0,2.0));
  float radial=exp(-r/DISK_RADIUS)*smoothstep(0.0,0.12,r);
  float lanes=smoothstep(0.6,0.78,grain)*arm*0.45;         // dark dust lanes cut through the arms
  float dz=(z-level)/GAS_SCALE_H;
  float ch=exp(dz)+exp(-dz);
  float vert=4.0/(ch*ch);                                    // sech^2 (no cosh in GLSL ES 1.00): diffuse both ways about the mid depth
  vec3 pq=vec3(rf*PUFF_SCALE,z*PUFF_Z_SCALE);
  float puff=0.6*vnoise3(pq)+0.4*vnoise3(pq*2.1+vec3(3.0,1.0,7.0));
  float puffMod=1.0-PUFF_DEPTH+2.0*PUFF_DEPTH*puff;          // mean 1
  return (arm*(0.35+1.1*grain)+0.10*haze)*radial*(1.0-lanes)*vert*puffMod;
}
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

    // --- gas: march the volume from the plane down through DISK_THICKNESS, front to back ---
    // The arm wobble and the hue drift are low-frequency and evaluated once at the plane hit; the
    // density, grain, haze and puffs are evaluated at every sample.
    float wobble=(fbm(rf/WOBBLE_SCALE+vec2(3.0,8.0))-0.5)*2.0*ARM_WOBBLE;
    float hue=fbm(rf/HUE_SCALE+vec2(2.0,5.0));
    float level=mix(GAS_TOP_Z,GAS_BOTTOM_Z,fbm(rf*LEVEL_SCALE+vec2(6.0,13.0)));  // this patch's depth
    vec3 deepBlue=vec3(0.08,0.24,0.88), violet=vec3(0.40,0.14,0.82), rose=vec3(0.95,0.30,0.60), teal=vec3(0.12,0.70,0.85), warm=vec3(1.0,0.88,0.62);
    vec3 baseCol=mix(deepBlue,violet,smoothstep(0.35,0.7,hue));
    float tBottom=(u_origin.z+DISK_THICKNESS)/-d.z;
    float dt=(tBottom-sdist)/float(GAS_STEPS);
    vec3 gasAcc=vec3(0.0);
    float T=1.0;                          // transmittance so far
    for(int i=0;i<GAS_STEPS;i++){
      float t=sdist+(float(i)+0.5)*dt;
      vec3 q=u_origin+d*t;
      float grain,haze;
      float dens=gasDensity(rot(q.xy,-a),q.z,q,wobble,level,grain,haze);
      vec3 c=mix(baseCol,rose,smoothstep(0.55,0.9,grain)*0.7);
      c=mix(c,teal,smoothstep(0.6,0.85,haze)*0.35);
      c*=1.0-LIT_FROM_ABOVE*clamp(-q.z/DISK_THICKNESS,0.0,1.0);   // deeper gas is darker
      float alpha=1.0-exp(-dens*GAS_EXTINCTION*dt);
      gasAcc+=T*alpha*c;
      T*=1.0-alpha;
    }
    float gas=1.0-T;                      // total gas opacity along the ray
    float bulge=exp(-r*2.0);
    col+=(gasAcc*GAS_GAIN+warm*bulge*BULGE_GAIN)*depthFade;

    // --- stars: points in three voxel grids under the plane, rotating with the gas ---
    // The grids are walked in the rotating frame: rotate the plane hit and the ray into it once.
    vec3 ro=vec3(rf,0.0);                                      // the plane hit, rotating frame
    vec3 rd=vec3(rot(d.xy,-a),d.z);
    float minPerT=STAR_MIN_PX/(u_focal*u_res.y);               // disk units of star radius per unit ray length
    float pxPerUnit=u_focal*u_res.y/sdist;
    float cellFade=smoothstep(CELL_FADE_PX,CELL_FADE_PX*3.0,pxPerUnit/32.0);
    float field=stars3(ro,rd,sdist,16.0,0.07,STAR_FIELD_DEPTH,minPerT,0.0,gas);
    float fine=0.6*stars3(ro,rd,sdist,32.0,0.05,STAR_FINE_DEPTH,minPerT,11.0,gas)*cellFade;
    float inArms=stars3(ro,rd,sdist,40.0,0.35,DISK_THICKNESS,minPerT,23.0,0.0)*cellFade*gas*2.5;
    col+=vec3(0.95,0.93,0.9)*((field+fine)*(0.45+0.9*gas)+inArms)*depthFade*depthFade;
  } else {
    // Above the plane's horizon (never in the view anchor at 60deg; the world anchor at a flat
    // orbit): a still, sparse field so the void is not empty, fixed to the sky direction.
    col+=vec3(0.8,0.82,0.9)*0.4*stars(dome(d)*110.0+5.0,0.03,0.0);
  }
  gl_FragColor=vec4(col,1.0);
}
