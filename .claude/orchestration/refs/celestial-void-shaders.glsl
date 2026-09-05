// Reference shaders for arc celestial-void, lifted verbatim from the approved
// concept page (https://claude.ai/code/artifact/53915c5c-1373-496c-b6ad-6a58a0303ced).
// REVISION 12 (owner 2026-09-05): 'depth means the z of the gas and the stars, not repeated
// layers' - the gas is a rippled sheet under the plane (sheetZ: SHEET_MID_Z -0.11, SHEET_AMP 0.11,
// found by an 8-step march), so every filament has its own depth; the three star grids ride it
// at STAR_*_DZ offsets, the two under it seen through the gas. Crests touch the plane, never above.
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
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+vec2(17.3,9.1); a*=0.5; } return s; }
// The same noise, periodic in y with period `per` cells: the lattice row wraps, so a domain
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
const float ARM_SHARPNESS= 1.0;    // arm cross-section exponent; rev 6: 2.2 -> 1.2 'thicker arms', rev 7: 1.0
const float GAS_GAIN     = 1.0;    // brightness of the gas arms; rev 6: 1.5 -> 1.2 'a little darker', rev 7: 1.0
const float BULGE_GAIN   = 0.25;   // warm hub glow; rev 6: 0.55 -> 0.25 and the white core removed, 'get rid of the bright center'
const float ARM_WOBBLE   = 0.25;   // rad of low-frequency phase wander; rev 9: 2.0 'too rigid', rev 10 owner 2026-09-04: 'not random squiggly lines' - arms follow the spiral again
const float ARM_BLEED    = 0.35;   // floor under the arm profile so gas spills across the gaps; rev 10: 'bleed into each other so the divisions are not so obvious'
const float WOBBLE_SCALE = 0.6;    // disk units per wobble feature: the arms bend on a scale near the disk radius
const float STREAK_ALONG = 1.6;    // grain cells per e-fold of radius ALONG an arm (long filaments)
const float STREAK_ACROSS= 40.0;   // grain cells around the full circle ACROSS the arms (fine filaments); integer, the y period
const float HUE_SCALE    = 0.7;    // disk units per hue-drift feature between the deep blue and the violet
const float DISK_RADIUS  = 1.7;    // e-folding radius of the gas disk, plane units
// Rev 12 (owner 2026-09-05: depth means the z of the gas and the stars, not repeated layers). The gas
// is a rippled sheet under the plane: its height z = sheetZ(x, y) undulates with a low-frequency
// field, so every filament is drawn at its own depth and the ray finds it by marching to the
// surface. The stars ride the same undulation at three depths, and the ones under the sheet are
// seen through it. Nothing is above the plane, so the clearance to the map is unchanged.
const float SHEET_MID_Z  = -0.11;  // mean depth of the sheet, disk units (22 world units in the world anchor)
const float SHEET_AMP    = 0.11;   // ripple amplitude about SHEET_MID_Z; MID + AMP = 0 puts the crests exactly on the plane
const float SHEET_SCALE  = 2.0;    // ripple features per disk unit
const int   SHEET_STEPS  = 8;      // march samples between the plane and the deepest trough
const float STAR_FIELD_DZ= -0.12;  // coarse star grid: this far under the sheet
const float STAR_FINE_DZ = -0.04;  // fine star grid: just under the sheet
const float STAR_ARM_DZ  =  0.02;  // in-arm stars: just above the sheet, clamped to the plane at the crests
const float STAR_MIN_PX  = 0.8;    // smallest star radius on screen, px
const float CELL_FADE_PX = 4.0;    // star cells narrower than this on screen fade out (anti-shimmer)
// The sheet's depth under the plane at a rotating-frame point: always in [SHEET_MID_Z-SHEET_AMP, SHEET_MID_Z+SHEET_AMP].
float sheetZ(vec2 rf){ return SHEET_MID_Z+SHEET_AMP*(fbm(rf*SHEET_SCALE+vec2(11.0,4.0))-0.5)*2.0; }
// Gas on the sheet in the rotating frame: the arms, their grain, lanes and colour. gas (out) is the
// scalar density the disk stars key off.
// ARMS log-spiral arms. The arm's own coordinates: s = log r runs ALONG an arm (a log spiral is a
// straight line in log-polar space) and thw, the angle in the frame wound so every arm is radial,
// runs ACROSS it - an arm sits at a fixed thw. The grain is sampled in (s, thw) with long cells
// along and short cells across, so the filaments run along the curve of each arm.
vec3 gasSheet(vec2 rf, out float gas){
  float r=length(rf);
  float th=atan(rf.y,rf.x);
  float s=log(r+0.05);
  float wobble=(fbm(rf/WOBBLE_SCALE+vec2(3.0,8.0))-0.5)*2.0*ARM_WOBBLE;
  float phase=th*ARMS-s*WIND+wobble;
  float arm=mix(pow(0.5+0.5*cos(phase),ARM_SHARPNESS),1.0,ARM_BLEED);
  // Unwind by MINUS the arm's own twist so the wound angle is phase/ARMS - constant along an arm.
  vec2 wound=rot(rf,-(s*WIND-wobble)/ARMS);
  float thw=atan(wound.y,wound.x);
  vec2 aq=vec2(s*STREAK_ALONG, (thw/6.2831853+0.5)*STREAK_ACROSS);
  float grain=0.6*pfbm(aq+vec2(4.0,0.0),STREAK_ACROSS)+0.4*pfbm(aq*2.0+vec2(1.0,0.0),STREAK_ACROSS*2.0);
  float haze=fbm(rf*1.4+vec2(9.0,2.0));
  float radial=exp(-r/DISK_RADIUS)*smoothstep(0.0,0.12,r);
  float lanes=smoothstep(0.6,0.78,grain)*arm*0.45;         // dark dust lanes cut through the arms; rev 10: 0.6 -> 0.45, softer
  gas=(arm*(0.35+1.1*grain)+0.10*haze)*radial*(1.0-lanes);
  // Rev 9 palette: deeper and more saturated - a deep blue drifting into violet across the disk,
  // rose where the grain is dense, a touch of teal in the haze; the warm bulge keeps its colour.
  vec3 deepBlue=vec3(0.08,0.24,0.88), violet=vec3(0.40,0.14,0.82), rose=vec3(0.95,0.30,0.60), teal=vec3(0.12,0.70,0.85);
  float hue=fbm(rf/HUE_SCALE+vec2(2.0,5.0));
  vec3 gasCol=mix(deepBlue,violet,smoothstep(0.35,0.7,hue));
  gasCol=mix(gasCol,rose,smoothstep(0.55,0.9,grain)*0.7);
  gasCol=mix(gasCol,teal,smoothstep(0.6,0.85,haze)*0.35);
  return gasCol*gas*GAS_GAIN;
}
void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*u_res)/u_res.y;
  float a=u_time*WHEEL_RATE;
  vec3 col=vec3(0.012,0.014,0.03);

  vec3 d=viewRay(uv);                    // disk space: plane z = 0, hub at the origin
  if(d.z<0.0){
    // --- find the sheet: march from the plane down to the deepest trough, stop at the first
    // sample under the surface and interpolate the crossing ---
    float t0=-u_origin.z/d.z;                                   // ray length to the plane
    float t1=(u_origin.z-(SHEET_MID_Z-SHEET_AMP))/-d.z;         // ... to the deepest possible trough
    float dt=(t1-t0)/float(SHEET_STEPS);
    float tPrev=t0, fPrev=-sheetZ(rot(u_origin.xy+d.xy*t0,-a)); // height above the sheet at the plane (>= 0)
    float sdist=t1;
    for(int i=1;i<=SHEET_STEPS;i++){
      float t=t0+float(i)*dt;
      vec3 q=u_origin+d*t;
      float f=q.z-sheetZ(rot(q.xy,-a));
      if(f<0.0){ sdist=mix(tPrev,t,fPrev/(fPrev-f)); break; }
      tPrev=t; fPrev=f;
    }
    vec3 hit=u_origin+d*sdist;
    vec2 rf=rot(hit.xy,-a);              // rotating frame on the sheet: everything sampled here turns rigidly
    float r=length(rf);
    float depthFade=1.0-smoothstep(FADE_START_HEIGHTS*u_origin.z,FADE_END_HEIGHTS*u_origin.z,sdist);

    // --- gas ---
    float gas;
    col+=gasSheet(rf,gas)*depthFade;
    float bulge=exp(-r*2.0);
    vec3 warm=vec3(1.0,0.88,0.62);
    col+=warm*bulge*BULGE_GAIN*depthFade;

    // --- stars at their own depths, riding the sheet's undulation; the two under it are seen through the gas ---
    float sdField=(u_origin.z-(hit.z+STAR_FIELD_DZ))/-d.z, sdFine=(u_origin.z-(hit.z+STAR_FINE_DZ))/-d.z, sdArm=(u_origin.z-min(hit.z+STAR_ARM_DZ,0.0))/-d.z;
    vec2 rfField=rot(u_origin.xy+d.xy*sdField,-a), rfFine=rot(u_origin.xy+d.xy*sdFine,-a), rfArm=rot(u_origin.xy+d.xy*sdArm,-a);
    float pxPerUnit=u_focal*u_res.y/sdist;
    float cellFade=smoothstep(CELL_FADE_PX,CELL_FADE_PX*3.0,pxPerUnit/32.0);
    float minA=STAR_MIN_PX*16.0*sdField/(u_focal*u_res.y), minB=STAR_MIN_PX*32.0*sdFine/(u_focal*u_res.y), minC=STAR_MIN_PX*40.0*sdArm/(u_focal*u_res.y);
    float through=1.0-0.8*clamp(gas,0.0,1.0);                                 // what the sheet lets through
    float field=dstars(rfField*16.0,0.07,minA)*through;
    float fine=0.6*dstars(rfFine*32.0+11.0,0.05,minB)*cellFade*sqrt(through);
    float inArms=dstars(rfArm*40.0+23.0,0.35,minC)*cellFade*gas*2.5;
    col+=vec3(0.95,0.93,0.9)*((field+fine)*(0.45+0.9*gas)+inArms)*depthFade*depthFade;
  } else {
    // Above the plane's horizon (never in the view anchor at 60deg; the world anchor at a flat
    // orbit): a still, sparse field so the void is not empty, fixed to the sky direction.
    col+=vec3(0.8,0.82,0.9)*0.4*stars(dome(d)*110.0+5.0,0.03,0.0);
  }
  gl_FragColor=vec4(col,1.0);
}
