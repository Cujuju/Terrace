export const PUFF_INSTANCE_BASE_GLSL = `vec3 base = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;`;

export const PUFF_BILLBOARD_GLSL = `vec4 viewPosition = viewMatrix * vec4(world, 1.0);
    viewPosition.xy += position.xy * size;
    gl_Position = projectionMatrix * viewPosition;`;

export function puffMaskGlsl(innerEdge: string, lobing?: PuffLobing): string {
  const lobed = lobing ? `${puffLobeScaleGlsl(lobing)}
    ` : '';
  const radius = lobing ? 'length(vQuad) / lobeScale' : 'length(vQuad)';
  return `${lobed}float radius = ${radius};
    float puff = 1.0 - smoothstep(${innerEdge}, 1.0, radius);
    if (puff <= 0.0) discard;`;
}

export interface PuffLobing {
  readonly amplitude: number;
  readonly seedVarying: string;
}

const PUFF_LOBE_HARMONICS: ReadonlyArray<{ readonly k: number; readonly phaseHash: number }> = [
  { k: 2, phaseHash: 2.17 },
  { k: 3, phaseHash: 4.73 },
  { k: 5, phaseHash: 9.11 },
];

const TWO_PI = Math.PI * 2;

export function puffLobeScaleGlsl(lobing: PuffLobing): string {
  const perHarmonic = 1 / PUFF_LOBE_HARMONICS.length;
  const terms = PUFF_LOBE_HARMONICS.map(
    ({ k, phaseHash }) =>
      `sin(${k.toFixed(1)} * lobeAngle + fract(${lobing.seedVarying} * ${phaseHash.toFixed(2)}) * ${TWO_PI.toFixed(6)})`,
  ).join(' +\n      ');
  return `float lobeAngle = atan(vQuad.y, vQuad.x);
    float lobeScale = 1.0 + ${(lobing.amplitude * perHarmonic).toFixed(4)} * (${terms});`;
}

const PUFF_ALPHA_DISCARD_THRESHOLD = 0.004;

export const PUFF_ALPHA_DISCARD_GLSL = `if (alpha <= ${PUFF_ALPHA_DISCARD_THRESHOLD.toFixed(3)}) discard;`;
