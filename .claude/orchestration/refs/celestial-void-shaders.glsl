// Reference shaders for arc celestial-void, lifted verbatim from the approved
// concept page (https://claude.ai/code/artifact/53915c5c-1373-496c-b6ad-6a58a0303ced).
// REVISION 5 (owner 2026-09-04): on top of revision 4's spiral galaxy, the
// wheel turns 5x faster (WHEEL_RATE -0.04, ~2.6 min per turn) and has four gas
// arms (ARMS 4.0). Everything else in revision 4 stands: rigid disk at 60 deg,
// log-spiral arms with wound grain and dust lanes, warm bulge, stars embedded in
// the disk plane rotating with the gas, still sparse field above the horizon,
// no twinkle, no trails. Nebula unchanged (NEBULA_RATE 0.15).
// GLSL ES 1.00 (WebGL1) as written; port to three's ShaderMaterial conventions.
// Uniforms: u_res (vec2 px), u_time (s), u_tilt (rad, wheel only; default 60 deg).
// uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y  — i.e. screen-space, y up, height = 1.

// ===== COMMON (both looks) =====

precision highp float;
uniform vec2 u_res; uniform float u_time; 
float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+vec2(17.3,9.1); a*=0.5; } return s; }
// Star layer: one candidate per grid cell, soft falloff, steady (stars do not twinkle here).
float stars(vec2 p, float density, float t){
  vec2 i=floor(p), f=fract(p)-0.5; float h=hash(i);
  if(h>density) return 0.0;
  vec2 o=vec2(hash(i+3.1),hash(i+7.7))-0.5; float d=length(f-o*0.8);
  float size = 0.03 + 0.05*hash(i+9.2);
  return smoothstep(size,0.0,d)*(0.5+0.5*h/density);
}

// ===== NEBULA main =====

const float NEBULA_RATE = 0.15;   // drift clock scale; owner set 3x the original 0.05
void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*u_res)/u_res.y;
  float t=u_time*NEBULA_RATE;
  vec2 p=uv*2.2;
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
// ===== WHEEL main (+ its helpers) =====

uniform float u_tilt;
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
const float WHEEL_RATE   = -0.04;  // rad/s (~2.6 min per turn); owner 2026-09-04: 'many times faster'; negative = clockwise from above
const float FOCAL        = 1.2;    // view-ray focal length; sets how much perspective the disk shows
const float DISK_DIST    = 2.6;    // hub distance along the view axis
const float FAR_FADE     = 12.0;   // ray length where the plane has fully dissolved into the void
const float ARMS         = 4.0;    // four gas arms; owner 2026-09-04: 'more than two'
const float WIND         = 3.2;    // how tightly the arms wind (log-spiral pitch)
const float DISK_RADIUS  = 1.7;    // e-folding radius of the gas disk, plane units
const float STAR_MIN_PX  = 0.8;    // smallest star radius on screen, px
const float CELL_FADE_PX = 4.0;    // star cells narrower than this on screen fade out (anti-shimmer)
void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*u_res)/u_res.y;
  float a=u_time*WHEEL_RATE;
  vec3 col=vec3(0.012,0.014,0.03);

  vec3 d=normalize(vec3(uv,-FOCAL));
  float ct=cos(u_tilt), st=sin(u_tilt);
  vec3 n=vec3(0.0,st,ct);               // disk normal, tilted so the top edge leans away
  vec3 hub=vec3(0.0,0.0,-DISK_DIST);
  float dn=dot(d,n);
  if(dn<0.0){
    float sdist=dot(hub,n)/dn;           // ray length to the plane
    vec3 X=d*sdist-hub;
    vec3 e1=vec3(1.0,0.0,0.0), e2=vec3(0.0,ct,-st);
    vec2 pp=vec2(dot(X,e1),dot(X,e2));   // disk coordinates, hub at the origin
    vec2 rf=rot(pp,-a);                  // rotating frame: everything sampled here turns rigidly
    float r=length(rf);
    float th=atan(rf.y,rf.x);
    float depthFade=1.0-smoothstep(DISK_DIST,FAR_FADE,sdist);

    // --- gas ---
    // Two log-spiral arms; texture sampled in a spiral-wound frame so grain streaks along the arms.
    float phase=th*ARMS-log(r+0.05)*WIND;
    float arm=pow(0.5+0.5*cos(phase),2.2);
    vec2 wound=rot(rf,log(r+0.05)*WIND/ARMS);
    float grain=0.6*fbm(wound*2.2+vec2(4.0,1.0))+0.4*fbm(wound*5.0+vec2(1.0,7.0));
    float haze=fbm(rf*1.4+vec2(9.0,2.0));
    float radial=exp(-r/DISK_RADIUS)*smoothstep(0.0,0.12,r);
    float lanes=smoothstep(0.6,0.78,grain)*arm*0.6;          // dark dust lanes cut through the arms
    float gas=(arm*(0.35+1.1*grain)+0.10*haze)*radial*(1.0-lanes);
    float bulge=exp(-r*2.0);
    float core=exp(-r*r*18.0);
    vec3 outer=vec3(0.30,0.52,0.95), pink=vec3(0.92,0.50,0.80), warm=vec3(1.0,0.88,0.62), white=vec3(1.0,0.97,0.9);
    vec3 gasCol=mix(outer,pink,smoothstep(0.5,0.85,grain)*0.8);
    col+=(gasCol*gas*1.5+warm*bulge*0.55+white*core*1.2)*depthFade;

    // --- stars in the disk, riding the rotation; denser and brighter inside the arms ---
    float pxPerUnit=FOCAL*u_res.y/sdist;
    float minA=STAR_MIN_PX*16.0/pxPerUnit, minB=STAR_MIN_PX*32.0/pxPerUnit;
    float cellFade=smoothstep(CELL_FADE_PX,CELL_FADE_PX*3.0,pxPerUnit/32.0);
    float field=dstars(rf*16.0,0.07,minA)+0.6*dstars(rf*32.0+11.0,0.05,minB)*cellFade;
    float inArms=dstars(rf*40.0+23.0,0.35,minB*1.25)*cellFade*gas*2.5;
    col+=vec3(0.95,0.93,0.9)*(field*(0.45+0.9*gas)+inArms)*depthFade*depthFade;
  } else {
    // Above the plane's horizon (only at shallow tilts): a still, sparse field so the void is not empty.
    col+=vec3(0.8,0.82,0.9)*0.4*stars(uv*110.0+5.0,0.03,0.0);
  }
  gl_FragColor=vec4(col,1.0);
}
