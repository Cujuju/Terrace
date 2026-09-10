import {
  CylinderGeometry,
  DoubleSide,
  type BufferGeometry,
  type Color,
} from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  Fn,
  cameraProjectionMatrix,
  clamp,
  float,
  materialOpacity,
  modelViewMatrix,
  positionGeometry,
  pow,
  smoothstep,
  uniform,
  vec4,
} from 'three/tsl';
import { radianceForDisplay } from '../../../client/src/render/displayRadiance.ts';

export const SPIRE_HEIGHT_WORLD = 14;

export const SPIRE_RADIUS_WORLD = 0.5;

const SPIRE_SEGMENTS = 10;

const SPIRE_FALLOFF_EXPONENT = 2.2;

const SPIRE_FOOT_FADE_WORLD = 1.2;

const SPIRE_BASE_ALPHA = 0.28;

export const SPIRE_PULSE_PERIOD_S = 4.5;
const SPIRE_PULSE_DEPTH = 0.18;

export const SPIRE_RENDER_ORDER = 10;

export function spireGeometry(): BufferGeometry {
  const geometry = new CylinderGeometry(
    SPIRE_RADIUS_WORLD,
    SPIRE_RADIUS_WORLD,
    SPIRE_HEIGHT_WORLD,
    SPIRE_SEGMENTS,
    1,
    true,
  );
  geometry.translate(0, SPIRE_HEIGHT_WORLD / 2, 0);
  return geometry;
}

// The pulsing alpha is the material's opacity, set each frame from spireAlpha.
export function createSpireMaterial(color: Color): NodeMaterial {
  const material = new NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = DoubleSide;
  material.opacity = SPIRE_BASE_ALPHA;

  const colorUniform = uniform(color);
  const vHeight = positionGeometry.y;

  material.vertexNode = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(positionGeometry, 1.0));

  material.fragmentNode = Fn(() => {
    const up = clamp(vHeight.div(SPIRE_HEIGHT_WORLD), 0.0, 1.0);
    const fade = pow(float(1.0).sub(up), SPIRE_FALLOFF_EXPONENT).mul(
      smoothstep(0.0, SPIRE_FOOT_FADE_WORLD, vHeight),
    );
    // toneMapped: false is inert on WebGPU, so the displayed colour is inverted through ACES.
    return vec4(radianceForDisplay(colorUniform), materialOpacity.mul(fade));
  })();

  return material;
}

export function spireAlpha(elapsedS: number, phaseS: number): number {
  const breath = Math.sin(((elapsedS + phaseS) / SPIRE_PULSE_PERIOD_S) * Math.PI * 2);
  return SPIRE_BASE_ALPHA * (1 - SPIRE_PULSE_DEPTH * (1 - breath) * 0.5);
}
