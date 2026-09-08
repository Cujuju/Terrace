import type { MeshStandardMaterial } from 'three';
import { CELL_WORLD_SIZE } from '../../config.ts';
import { spliceShader } from '../shaderSplice.ts';

const BAND_STEPS = 5;

const BAND_WAVE_SCALE_CELLS = 0.075;

const BAND_WAVES = [
  { dir: [1.0, 0.16], k: 5.2, speed: 1.55, amplitude: 0.55 },
  { dir: [0.86, -0.22], k: 8.7, speed: 2.05, amplitude: 0.3 },
  { dir: [1.0, 0.42], k: 15.1, speed: 2.7, amplitude: 0.15 },
] as const;

const BAND_SHADE_MIN = 0.66;
const BAND_SHADE_MAX = 1.25;

const BAND_CREST_GAIN = 1.1;
const BAND_CREST_THRESHOLD = 0.8;

const bandTimeUniform = { value: 0 };

let clockInstalled = false;

export function installWaterBandClock(
  onFrame: (handler: (dt: number) => void) => () => void,
): void {
  if (clockInstalled) return;
  clockInstalled = true;
  onFrame((dt: number) => {
    bandTimeUniform.value += dt;
  });
}

function glslFloat(value: number): string {
  return value.toFixed(6);
}

function wavesGlsl(): string {
  const terms = BAND_WAVES.map(
    (w) =>
      `  s += sin( dot( q, vec2( ${glslFloat(w.dir[0])}, ${glslFloat(w.dir[1])} ) ) * ` +
      `${glslFloat(w.k)} - t * ${glslFloat(w.speed)} ) * ${glslFloat(w.amplitude)};`,
  );
  return ['float waterBandField( vec2 q, float t ) {', '  float s = 0.0;', ...terms, '  return s;', '}'].join(
    '\n',
  );
}

export function makeBanded(material: MeshStandardMaterial): void {
  const existing = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    existing(shader, renderer);
    shader.uniforms.uWaterBandTime = bandTimeUniform;

    shader.vertexShader = spliceShader(
      spliceShader(
        shader.vertexShader,
        '#include <common>',
        '#include <common>\nvarying vec2 vWaterBandXZ;',
        'waterBands',
      ),
      '#include <begin_vertex>',
      `#include <begin_vertex>\nvWaterBandXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz / ${glslFloat(
        CELL_WORLD_SIZE,
      )};`,
      'waterBands',
    );

    shader.fragmentShader = spliceShader(
      spliceShader(
        shader.fragmentShader,
        '#include <common>',
        `#include <common>\nvarying vec2 vWaterBandXZ;\nuniform float uWaterBandTime;\n${wavesGlsl()}`,
        'waterBands',
      ),
      '#include <color_fragment>',
      [
        '#include <color_fragment>',
        `float wbHeight = waterBandField( vWaterBandXZ * ${glslFloat(
          BAND_WAVE_SCALE_CELLS,
        )}, uWaterBandTime ) * 0.5 + 0.5;`,
        `float wbBand = floor( wbHeight * ${glslFloat(BAND_STEPS)} ) / ${glslFloat(
          BAND_STEPS - 1,
        )};`,
        `diffuseColor.rgb *= mix( ${glslFloat(BAND_SHADE_MIN)}, ${glslFloat(
          BAND_SHADE_MAX,
        )}, clamp( wbBand, 0.0, 1.0 ) );`,
        `diffuseColor.rgb *= mix( 1.0, ${glslFloat(
          BAND_CREST_GAIN,
        )}, step( ${glslFloat(BAND_CREST_THRESHOLD)}, wbBand ) );`,
      ].join('\n'),
      'waterBands',
    );
  };
}
