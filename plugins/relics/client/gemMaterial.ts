import { Vector3 } from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraProjectionMatrix,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  floor,
  min,
  mix,
  modelViewMatrix,
  normalize,
  positionGeometry,
  select,
  uniform,
  varying,
  vec4,
} from 'three/tsl';
import { radianceForDisplay } from '../../../client/src/render/displayRadiance.ts';

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

export function createGemMaterial(radius: number): NodeMaterial {
  const material = new NodeMaterial();

  const lightDirUniform = uniform(LIGHT_DIR_VIEW.clone());
  const levelsUniform = uniform(ICON_LIGHT_LEVELS);
  const radiusUniform = uniform(radius);
  const paintLight = attribute<'vec3'>('paintLight', 'vec3');
  const paintDark = attribute<'vec3'>('paintDark', 'vec3');
  const paintBlend = attribute<'float'>('paintBlend', 'float');

  const viewPosition = modelViewMatrix.mul(vec4(positionGeometry, 1.0));
  const viewCentre = modelViewMatrix.mul(vec4(0.0, 0.0, 0.0, 1.0));
  const vViewPosition = varying(viewPosition.xyz, 'vViewPosition');
  // 0 at the top of the gem on screen, 1 at its bottom: one gradient across the whole gem.
  const vDownward = varying(
    clamp(
      viewCentre.y.add(radiusUniform).sub(viewPosition.y).div(radiusUniform.mul(2.0)),
      0.0,
      1.0,
    ),
    'vDownward',
  );

  material.vertexNode = cameraProjectionMatrix.mul(viewPosition);

  material.fragmentNode = Fn(() => {
    // The face's own normal from screen-space derivatives: flat shading with no normal attribute.
    const normal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    const lit = dot(normal, lightDirUniform).add(1.0).mul(0.5);
    const level = min(levelsUniform.sub(1.0), floor(float(1.0).sub(lit).mul(levelsUniform)));
    // A vertex with its own blend (the tile) is painted with it; the rest are lit.
    const t = select(
      paintBlend.lessThan(0.0),
      level.add(vDownward).div(levelsUniform),
      paintBlend,
    );
    // The paints are sRGB and blend as sRGB, which is the displayed colour the icon shows.
    const srgb = mix(paintLight, paintDark, t);
    // toneMapped: false is inert on WebGPU, so the displayed colour is inverted through ACES.
    return vec4(radianceForDisplay(srgb), 1.0);
  })();

  return material;
}
