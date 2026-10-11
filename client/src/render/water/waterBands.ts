import type { NodeMaterial, Node } from 'three/webgpu';
import { float, mix, positionWorld, step, uniform, vec2 } from 'three/tsl';
import { CELL_WORLD_SIZE } from '../../config.ts';
import { compose } from '../materialSlots.ts';

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

// The wave sum is signed; this maps it onto [0,1] before it is quantised.
const BAND_FIELD_UNIT_SCALE = 0.5;
const BAND_FIELD_UNIT_OFFSET = 0.5;

const bandTimeNode = uniform(0);

let clockInstalled = false;

export function installWaterBandClock(
  onFrame: (handler: (dt: number) => void) => () => void,
): void {
  if (clockInstalled) return;
  clockInstalled = true;
  onFrame((dt: number) => {
    bandTimeNode.value += dt;
  });
}

function bandField(q: Node<'vec2'>): Node<'float'> {
  let sum: Node<'float'> = float(0);
  for (const wave of BAND_WAVES) {
    sum = sum.add(
      q.dot(vec2(wave.dir[0], wave.dir[1])).mul(wave.k).sub(bandTimeNode.mul(wave.speed)).sin()
        .mul(wave.amplitude),
    );
  }
  return sum;
}

export function makeBanded(material: NodeMaterial): void {
  const cellXZ = positionWorld.xz.div(CELL_WORLD_SIZE);
  const height = bandField(cellXZ.mul(BAND_WAVE_SCALE_CELLS))
    .mul(BAND_FIELD_UNIT_SCALE)
    .add(BAND_FIELD_UNIT_OFFSET);
  const band = height.mul(BAND_STEPS).floor().div(BAND_STEPS - 1);
  const shade = mix(BAND_SHADE_MIN, BAND_SHADE_MAX, band.clamp(0, 1));
  const crest = mix(1, BAND_CREST_GAIN, step(BAND_CREST_THRESHOLD, band));
  compose(material, 'color', (previous) => previous.mul(shade).mul(crest));
}
