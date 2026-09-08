import { ShaderMaterial, Vector3 } from 'three';

export const ICON_LIGHT_UVH = [-0.35, 0.55, 0.75] as const;

export const ICON_LIGHT_LEVELS = 4;

function iconLightInViewSpace(): Vector3 {
  const [u, v, h] = ICON_LIGHT_UVH;
  const light = new Vector3(u, h, v);
  const view = new Vector3(1, 1, 1).normalize();
  const right = new Vector3(1, 0, -1).normalize();
  const up = new Vector3().crossVectors(right, view);
  return new Vector3(light.dot(right), light.dot(up), light.dot(view)).normalize();
}

const LIGHT_DIR_VIEW = iconLightInViewSpace();

const VERTEX_SHADER =  `
attribute vec3 paintLight;
attribute vec3 paintDark;
attribute float paintBlend;
uniform float uRadius;
varying vec3 vViewPosition;
varying vec3 vPaintLight;
varying vec3 vPaintDark;
varying float vPaintBlend;
varying float vDownward;

void main() {
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vec4 viewCentre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vViewPosition = viewPosition.xyz;
  // 0 at the top of the gem on screen, 1 at its bottom: the icon's vertical
  // gradient, spanning the whole gem rather than each face.
  vDownward = clamp((viewCentre.y + uRadius - viewPosition.y) / (2.0 * uRadius), 0.0, 1.0);
  vPaintLight = paintLight;
  vPaintDark = paintDark;
  vPaintBlend = paintBlend;
  gl_Position = projectionMatrix * viewPosition;
}
`;

const FRAGMENT_SHADER =  `
uniform vec3 uLightDir;
uniform float uLevels;
varying vec3 vViewPosition;
varying vec3 vPaintLight;
varying vec3 vPaintDark;
varying float vPaintBlend;
varying float vDownward;

void main() {
  // The face's own normal, from screen-space derivatives: flat shading with
  // no normal attribute, as three's own flatShading does it.
  vec3 normal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
  float lit = (dot(normal, uLightDir) + 1.0) * 0.5;
  float level = min(uLevels - 1.0, floor((1.0 - lit) * uLevels));
  // A vertex with its own blend (the tile) is painted with it; the rest are
  // lit. A face is all one or all the other, so the varying never straddles.
  float t = vPaintBlend < 0.0 ? (level + vDownward) / uLevels : vPaintBlend;
  // The paints are sRGB and the icon blends them as sRGB; blend the same,
  // then hand three linear light to write out.
  vec4 srgb = vec4(mix(vPaintLight, vPaintDark, t), 1.0);
  gl_FragColor = sRGBTransferEOTF(srgb);
  #include <colorspace_fragment>
}
`;

export function createGemMaterial(radius: number): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uLightDir: { value: LIGHT_DIR_VIEW.clone() },
      uLevels: { value: ICON_LIGHT_LEVELS },
      uRadius: { value: radius },
    },
    toneMapped: false,
  });
}
