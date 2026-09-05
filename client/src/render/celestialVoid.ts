// THE CELESTIAL VOID — what is drawn outside the map (issue #326).
//
// The world used to sit on a flat `scene.background` the colour of the sky
// (render/scene.ts, before this arc), so "off the map" and "the sky" were the
// same painted nothing. The owner's ask: make it read as "a plot among the
// stars". Two approved looks, chosen per player in the HUD's Controls panel:
//
//   'wheel'  (default) — a four-armed spiral galaxy seen at 60 degrees, its
//                        hub on the view axis under the map: log-spiral arms,
//                        dust lanes, a warm bulge, and stars in the disk plane
//                        that turn rigidly with the gas.
//   'nebula'           — domain-warped fbm clouds with two steady star layers.
//
// The GLSL below is a faithful port of the shaders the owner approved
// (.claude/orchestration/refs/celestial-void-shaders.glsl), at that file's
// REVISION 7 (owner, 2026-09-04). Cumulatively that revision line is: a 60
// degree default tilt, rotation reversed (clockwise seen from above), no
// twinkle in either look, the nebula's drift 3x faster (NEBULA_RATE 0.15),
// and the wheel rebuilt as a four-armed spiral galaxy — log-spiral arms with
// grain streaked along them, dust lanes, a warm bulge under the map, and stars
// embedded in the disk plane that turn rigidly with the gas. The wheel's rate
// has moved twice: revision 4 put it back to -0.008 because revision 3's 3x
// was too fast, then revision 5 took it to -0.04 (~2.6 min per turn) on the
// owner's "many times faster", with the arm count going from two to four at
// the same time. Revision 6 (owner, in-world, 2026-09-04) slowed it by a third
// to -0.0267, removed the white core, dimmed the bulge, darkened the gas and
// made the arms thicker and more tightly wound; revision 7 (same day) pushed
// further: -0.021 (five minutes per turn), gas gain 1.0, arm exponent 1.0,
// winding 8.0. The numbers in these shaders ARE the approved look; every
// one that encodes a design decision is a named constant here or in the
// shader's own `const` block.
//
// TIME OF DAY MUST NOT TOUCH IT. The owner's second rule: day/night affects
// the map's lighting only, never the void. That is enforced structurally
// rather than by a flag — `scene.background` is now null, and the one writer
// of it (render/skyRig.ts, driven by plugins/daynight) only writes when the
// background is a `Color`, so the day/night and cyclone plugins keep
// computing a `backgroundColor` that nothing consumes. No plugin edit, no
// conditional: there is simply no longer a background for them to tint.
//
// WHY A FULLSCREEN TRIANGLE MESH AND NOT A CAMERA-FOLLOWING SKY SPHERE.
// The brief left the choice open, on the criterion "least code in scene.ts".
// This shape needs ZERO code there beyond deleting the old background line:
// the mesh's vertex shader writes clip space directly, so it ignores the
// camera and the projection matrix entirely, needs no per-frame position
// sync, no radius that has to stay inside CAMERA_FAR, and no `frustumCulled`
// bookkeeping beyond the flag. A sky sphere would have needed a per-frame
// `position.copy(camera.position)` inside the render loop — i.e. an edit to
// renderFrame — plus a radius picked against the camera's near/far planes.
// Rendering the triangle before the scene with `autoClear` managed was the
// other option offered and was rejected for the same reason: it splits one
// `renderer.render` call into a manual two-pass sequence in scene.ts.
//
// ANCHORED TO THE CAMERA. The shaders are written in screen space and are
// ported that way: the void is fixed to the view. Panning the map does not
// drag it, and the wheel's hub stays exactly on the view axis, which is what
// the reference's ray/plane math assumes and what the owner approved on the
// concept page. See the report for the alternative (an unwrapped
// azimuth/elevation pan of the nebula's noise domain) and why it was not
// taken here.
//
// COLOUR PIPELINE. The renderer runs ACES tone mapping at exposure 1.25
// (render/scene.ts) and sRGB output conversion. Both are opt-in per shader in
// three: a custom ShaderMaterial only gets them if its fragment source
// `#include`s `<tonemapping_fragment>` / `<colorspace_fragment>`. Neither is
// included below, and `toneMapped: false` says so on the material as well, so
// the approved values reach the framebuffer as written — exactly as they did
// on the plain WebGL canvas the concept was approved on.

import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  ShaderMaterial,
  Vector2,
  type IUniform,
} from 'three';
import type { Viewport } from './scene.ts';

export type VoidStyle = 'nebula' | 'wheel';

/**
 * Tilt of the star wheel's disk from the view axis, in degrees.
 *
 * The owner's first ask was "something like a thirty to forty five degree
 * angle"; revision 2 of the approved reference (2026-09-04) supersedes that
 * with 60°, which is what they signed off on after seeing both — the steeper
 * tilt opens the ellipse enough that the stars' circular motion reads as
 * orbiting rather than as sideways drift.
 *
 * It is a constant and NOT a preference: the owner asked for the look to be
 * switchable, not for its tilt or its speed to be dialled from the HUD.
 */
const WHEEL_TILT_DEGREES = 60;

/**
 * Draw order for the void. Three sorts opaque objects by `renderOrder` before
 * anything else, so any value below every other object in the scene puts the
 * void first; combined with `depthWrite: false` it leaves the depth buffer
 * untouched for the world drawn over it. Nothing else in client/src sets a
 * negative render order, so -1 would do — a wide margin is used so a future
 * "behind everything" layer can still be ordered against it.
 */
const VOID_RENDER_ORDER = -1000;

/**
 * Clip-space vertices of a single triangle that covers the viewport. Larger
 * than the screen on purpose: one triangle clipped to the frame rasterises
 * the same pixels as two triangles forming a quad, with no diagonal seam and
 * one fewer vertex invocation.
 */
const FULLSCREEN_TRIANGLE_POSITIONS = [-1, -1, 0, 3, -1, 0, -1, 3, 0];

// ---------------------------------------------------------------------------
// GLSL — ported from the approved reference, verbatim except for the
// vertex/uniform plumbing three needs and the named constants noted above.
// ---------------------------------------------------------------------------

/**
 * Writes clip space straight through, ignoring the model-view and projection
 * matrices — this is what makes the pass camera-anchored with no per-frame
 * transform work. `position.z` is dropped in favour of a constant so the
 * triangle has a defined depth even though `depthTest` is off.
 */
const VERTEX_SHADER = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** hash / value noise / fbm / star field — shared by both looks. */
const COMMON_GLSL = /* glsl */ `
precision highp float;
uniform vec2 u_res;
uniform float u_time;

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
`;

const NEBULA_GLSL = /* glsl */ `${COMMON_GLSL}
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
`;

const WHEEL_GLSL = /* glsl */ `${COMMON_GLSL}
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
const float WHEEL_RATE   = -0.021; // rad/s (2*pi/300 = ~5.0 min per turn); rev 7 owner 2026-09-04: 'about five minutes per turn'; negative = clockwise from above
const float FOCAL        = 1.2;    // view-ray focal length; sets how much perspective the disk shows
const float DISK_DIST    = 2.6;    // hub distance along the view axis
const float FAR_FADE     = 12.0;   // ray length where the plane has fully dissolved into the void
const float ARMS         = 4.0;    // four gas arms; owner 2026-09-04: 'more than two'
const float WIND         = 8.0;    // how tightly the arms wind (log-spiral pitch); rev 6: 3.2 -> 6.0 'more circular', rev 7: 8.0
const float ARM_SHARPNESS= 1.0;    // arm cross-section exponent; rev 6: 2.2 -> 1.2 'thicker arms', rev 7: 1.0
const float GAS_GAIN     = 1.0;    // brightness of the gas arms; rev 6: 1.5 -> 1.2 'a little darker', rev 7: 1.0
const float BULGE_GAIN   = 0.25;   // warm hub glow; rev 6: 0.55 -> 0.25 and the white core removed, 'get rid of the bright center'
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
    // ARMS log-spiral arms; texture sampled in a spiral-wound frame so grain streaks along the arms.
    float phase=th*ARMS-log(r+0.05)*WIND;
    float arm=pow(0.5+0.5*cos(phase),ARM_SHARPNESS);
    vec2 wound=rot(rf,log(r+0.05)*WIND/ARMS);
    float grain=0.6*fbm(wound*2.2+vec2(4.0,1.0))+0.4*fbm(wound*5.0+vec2(1.0,7.0));
    float haze=fbm(rf*1.4+vec2(9.0,2.0));
    float radial=exp(-r/DISK_RADIUS)*smoothstep(0.0,0.12,r);
    float lanes=smoothstep(0.6,0.78,grain)*arm*0.6;          // dark dust lanes cut through the arms
    float gas=(arm*(0.35+1.1*grain)+0.10*haze)*radial*(1.0-lanes);
    float bulge=exp(-r*2.0);
    vec3 outer=vec3(0.30,0.52,0.95), pink=vec3(0.92,0.50,0.80), warm=vec3(1.0,0.88,0.62);
    vec3 gasCol=mix(outer,pink,smoothstep(0.5,0.85,grain)*0.8);
    col+=(gasCol*gas*GAS_GAIN+warm*bulge*BULGE_GAIN)*depthFade;

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
`;

const FRAGMENT_SHADER: Record<VoidStyle, string> = {
  nebula: NEBULA_GLSL,
  wheel: WHEEL_GLSL,
};

export interface CelestialVoid {
  /** Switches the look live — no reload, no scene rebuild. */
  setStyle(style: VoidStyle): void;
  /** Removes the pass from the scene and frees its GPU resources. */
  dispose(): void;
}

/**
 * True when the user has asked their system for reduced motion. Read once:
 * this is an accessibility setting, not something that changes mid-session in
 * any way worth a live listener, and the reference looks are decorative — a
 * frozen frame of either is still the intended image.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Installs the void pass on `viewport`. Adds one mesh to its scene and one
 * frame callback; owns nothing else.
 */
export function createCelestialVoid(
  viewport: Viewport,
  initialStyle: VoidStyle,
): CelestialVoid {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(FULLSCREEN_TRIANGLE_POSITIONS, 3),
  );

  // ONE uniform object shared by both materials, so switching styles carries
  // the clock across instead of restarting the animation at zero.
  const uniforms: Record<string, IUniform> = {
    u_res: { value: new Vector2(1, 1) },
    u_time: { value: 0 },
    u_tilt: { value: (WHEEL_TILT_DEGREES * Math.PI) / 180 },
  };

  // Materials are compiled on first use and then cached: booting straight into
  // the default style must not pay for the other look's program.
  const materials = new Map<VoidStyle, ShaderMaterial>();
  const materialFor = (style: VoidStyle): ShaderMaterial => {
    const cached = materials.get(style);
    if (cached !== undefined) return cached;
    const material = new ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER[style],
      // The pass is the backdrop: it must neither read nor write depth, so it
      // cannot occlude the world drawn after it nor be occluded by geometry
      // that has not been drawn yet.
      depthTest: false,
      depthWrite: false,
      // See the colour-pipeline note at the top of this file.
      toneMapped: false,
    });
    materials.set(style, material);
    return material;
  };

  const mesh = new Mesh(geometry, materialFor(initialStyle));
  // The vertex shader ignores every matrix, so the mesh's computed bounds are
  // meaningless — culling it against the camera frustum would drop the
  // backdrop at arbitrary camera angles.
  mesh.frustumCulled = false;
  mesh.renderOrder = VOID_RENDER_ORDER;
  mesh.matrixAutoUpdate = false;
  viewport.scene.add(mesh);

  const frozen = prefersReducedMotion();
  const drawingBuffer = new Vector2();

  const stopFrames = viewport.onFrame((dt) => {
    // Advanced from the render loop's own dt (capped by FRAME_DELTA_CAP_S in
    // render/scene.ts), never from a wall clock: a backgrounded tab that
    // stops receiving animation frames must resume where it left off rather
    // than jumping the wheel forward by the time it spent hidden.
    if (!frozen) (uniforms['u_time'] as IUniform<number>).value += dt;
    // Drawing-buffer size, not client size: the shaders divide fragment
    // coordinates by it, and those are in device pixels.
    viewport.renderer.getDrawingBufferSize(drawingBuffer);
    (uniforms['u_res'] as IUniform<Vector2>).value.copy(drawingBuffer);
  });

  return {
    setStyle(style: VoidStyle): void {
      mesh.material = materialFor(style);
    },
    dispose(): void {
      stopFrames();
      viewport.scene.remove(mesh);
      for (const material of materials.values()) material.dispose();
      materials.clear();
      geometry.dispose();
    },
  };
}
