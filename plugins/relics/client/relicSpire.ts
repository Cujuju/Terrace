import {
  CylinderGeometry,
  DoubleSide,
  ShaderMaterial,
  type BufferGeometry,
  type Color,
} from 'three';

export const SPIRE_HEIGHT_WORLD = 14;

export const SPIRE_RADIUS_WORLD = 0.5;

const SPIRE_SEGMENTS = 10;

const SPIRE_FALLOFF_EXPONENT = 2.2;

const SPIRE_FOOT_FADE_WORLD = 1.2;

const SPIRE_BASE_ALPHA = 0.28;

export const SPIRE_PULSE_PERIOD_S = 4.5;
const SPIRE_PULSE_DEPTH = 0.18;

export const SPIRE_RENDER_ORDER = 10;

const VERTEX_SHADER =  `
varying float vHeight;

void main() {
  vHeight = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER =  `
uniform vec3 uColor;
uniform float uHeight;
uniform float uFootFade;
uniform float uFalloff;
uniform float uAlpha;
varying float vHeight;

void main() {
  float up = clamp(vHeight / uHeight, 0.0, 1.0);
  float fade = pow(1.0 - up, uFalloff) * smoothstep(0.0, uFootFade, vHeight);
  gl_FragColor = vec4(uColor, uAlpha * fade);
}
`;

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

export function createSpireMaterial(color: Color): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uColor: { value: color },
      uHeight: { value: SPIRE_HEIGHT_WORLD },
      uFootFade: { value: SPIRE_FOOT_FADE_WORLD },
      uFalloff: { value: SPIRE_FALLOFF_EXPONENT },
      uAlpha: { value: SPIRE_BASE_ALPHA },
    },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
  });
}

export function spireAlpha(elapsedS: number, phaseS: number): number {
  const breath = Math.sin(((elapsedS + phaseS) / SPIRE_PULSE_PERIOD_S) * Math.PI * 2);
  return SPIRE_BASE_ALPHA * (1 - SPIRE_PULSE_DEPTH * (1 - breath) * 0.5);
}
