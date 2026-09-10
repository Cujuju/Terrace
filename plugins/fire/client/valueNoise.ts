import { Fn, dot, floor, fract, mix, sin, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';

export const hash21 = Fn(([p]: [Node<'vec2'>]) =>
  fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123)),
).setLayout({ name: 'hash21', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

export const vnoise = Fn(([p]: [Node<'vec2'>]) => {
  const cell = floor(p);
  const f = fract(p);
  const smoothed = f.mul(f).mul(vec2(3.0).sub(f.mul(2.0)));
  const a = hash21(cell);
  const b = hash21(cell.add(vec2(1.0, 0.0)));
  const c = hash21(cell.add(vec2(0.0, 1.0)));
  const d = hash21(cell.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, smoothed.x), mix(c, d, smoothed.x), smoothed.y).mul(2.0).sub(1.0);
}).setLayout({ name: 'vnoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

export const fnoise = Fn(([p]: [Node<'vec2'>]) =>
  vnoise(p).mul(0.65).add(vnoise(p.mul(2.17).add(11.3)).mul(0.35)),
).setLayout({ name: 'fnoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });
