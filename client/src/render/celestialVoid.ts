// THE CELESTIAL VOID — what is drawn outside the map (issue #326).
//
// The world used to sit on a flat `scene.background` the colour of the sky
// (render/scene.ts, before this arc), so "off the map" and "the sky" were the
// same painted nothing. The owner's ask: make it read as "a plot among the
// stars". Two approved looks, chosen per player in the HUD's Controls panel:
//
//   'wheel'  (default) — a tilted galactic haze disk with a full-screen star
//                        field turning about a hub on the view axis, each star
//                        drawing a short motion trail behind it.
//   'nebula'           — domain-warped fbm clouds with two steady star layers.
//
// The GLSL below is a faithful port of the shaders the owner approved
// (.claude/orchestration/refs/celestial-void-shaders.glsl), at that file's
// REVISION 3 (owner, 2026-09-04). Cumulatively that revision line is: a 60
// degree default tilt, rotation reversed, no twinkle in either look, drift 3x
// faster in both (NEBULA_RATE 0.15, WHEEL_RATE -0.018), and the wheel's stars
// moved off the perspective disk plane onto the whole background — uniform
// density edge to edge, turning about the same hub as the haze. The numbers
// in them ARE the approved look; every one that encodes a design decision is
// a named constant here or in the shader's own `const` block.
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
 * The colour anything that must dissolve INTO the void should blend toward —
 * the frontier mist's top row (render/frontierFog.ts) is the one caller.
 *
 * The component-wise mean of the two looks' base colours: the nebula's `deep`
 * (0.05, 0.05, 0.14) and the wheel's backdrop (0.025, 0.03, 0.06), giving
 * (0.0375, 0.04, 0.10) → 0x0a0a1a. Those two are what fills most of the
 * screen in each look — the arms and stars are sparse highlights on top of
 * them — so the mean is the honest "average colour of the void", and one
 * value serves both styles without the fog having to know which is showing.
 *
 * Not exact: the fog is a lit-pipeline material and so passes through ACES
 * tone mapping and sRGB conversion, while the void pass deliberately does
 * not (see the colour-pipeline note above). The mist's top row therefore
 * lands slightly lighter than the void behind it rather than identical to it,
 * which is the right direction for haze anyway.
 */
export const VOID_HAZE_COLOR = 0x0a0a1a;

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
// Wheel stars: steady points positioned on the tilted disk (orthographic, so screen density is
// uniform edge to edge) but shaped in screen space so they stay round at any tilt.
float wstars(vec2 p, float density, float aspect){
  vec2 i=floor(p), f=fract(p)-0.5; float h=hash(i);
  if(h>density) return 0.0;
  vec2 o=vec2(hash(i+3.1),hash(i+7.7))-0.5; float d=length((f-o*0.8)*vec2(1.0,aspect));
  float size = 0.03 + 0.06*hash(i+9.2);
  return smoothstep(size,0.0,d)*(0.5+0.5*h/density);
}
const float WHEEL_RATE   = -0.018; // rad/s (~6 min per revolution); owner set 3x the original; negative = clockwise from above
const float FOCAL        = 1.2;    // view-ray focal length; sets how much perspective the haze disk shows
const float DISK_DIST    = 2.6;    // hub distance along the view axis
const float FAR_FADE     = 14.0;   // ray length where the haze has fully dissolved into the void
const int   TRAIL_SAMPLES = 5;
const float TRAIL_STEP   = 0.004;  // rad between trail samples
void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*u_res)/u_res.y;
  float a=u_time*WHEEL_RATE;
  vec3 col=vec3(0.025,0.03,0.06);

  // The disk: a plane through the hub, tilted so its top edge leans away from the viewer.
  vec3 d=normalize(vec3(uv,-FOCAL));
  float ct=cos(u_tilt), st=sin(u_tilt);
  vec3 n=vec3(0.0,st,ct);               // disk normal, tilted from the view axis
  vec3 hub=vec3(0.0,0.0,-DISK_DIST);
  float dn=dot(d,n);
  if(dn<0.0){
    float sdist=dot(hub,n)/dn;           // ray length to the plane
    vec3 X=d*sdist-hub;
    vec3 e1=vec3(1.0,0.0,0.0), e2=vec3(0.0,ct,-st);
    vec2 pp=vec2(dot(X,e1),dot(X,e2));   // disk coordinates, hub at the origin
    float r=length(pp);
    float depthFade=1.0-smoothstep(DISK_DIST,FAR_FADE,sdist);
    // Disk density: dense inner ring around the map, thinning outward, with slow spiral arms.
    // Spiral warp: rotate the plane coords by log(r) so noise winds into arms with no angular seam.
    float arms=fbm(rot(pp,a*0.5+log(r+0.3)*2.0)*1.2+vec2(7.0,3.0));
    float ring=smoothstep(0.35,0.9,r)*exp(-r*0.55);
    vec3 haze=mix(vec3(0.28,0.22,0.5),vec3(0.9,0.62,0.45),smoothstep(0.4,0.8,arms));
    col+=haze*ring*arms*1.3*depthFade;
  }
  // Stars: the whole background, hub on the view axis, turning with the haze at the same rate.
  // Orthographic tilted-disk coordinates: y stretched by 1/cos(tilt), so a rotation here is an
  // ellipse on screen (the disk seen at an angle) while density stays uniform top to bottom.
  vec2 sp0=vec2(uv.x, uv.y/ct);
  float s=0.0;
  for(int k=0;k<TRAIL_SAMPLES;k++){
    float w=1.0-float(k)/float(TRAIL_SAMPLES);
    vec2 sp=rot(sp0,a-float(k)*TRAIL_STEP);
    s+=w*w*(wstars(sp*90.0,0.06,ct)+0.6*wstars(sp*180.0+31.0,0.04,ct));
  }
  col+=vec3(0.95,0.93,0.85)*s*0.8;
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
