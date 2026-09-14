import {
  BufferGeometry,
  Float32BufferAttribute,
  LineSegments,
  Points,
  Sphere,
  Vector3,
  type Object3D,
} from 'three';
import { LineBasicNodeMaterial, PointsNodeMaterial, type NodeMaterial } from 'three/webgpu';
import { BAND_HEIGHT, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS, WORLD_UNITS_PER_BAND } from '@terrace/shared';

const TWO_PI = Math.PI * 2;

/** Particle positions refresh at half frame rate: fall motion aliases invisibly
 *  at 30 Hz while the rewrite + upload cost (the dominant precip expense) halves.
 *  Opacity, haze spin and deck slots still update every frame. */
const POSITION_UPDATE_INTERVAL_S = 1 / 30;

const WORLD_UNIT_HEIGHT_UNITS = MAX_HEIGHT / MAX_RELIEF_WORLD_UNITS;

export const MAX_GROUND_WORLD_Y = (MAX_HEIGHT / BAND_HEIGHT) * WORLD_UNITS_PER_BAND;

export const CLOUD_HEADROOM_WORLD_UNITS = MAX_GROUND_WORLD_Y / 2;

export const CLOUD_BASE_WORLD_Y = MAX_GROUND_WORLD_Y + CLOUD_HEADROOM_WORLD_UNITS;

const FRESH_SEABED_DEPTH_BELOW_SEA = 192;
const PRECIPITATION_FLOOR_CLEARANCE = WORLD_UNIT_HEIGHT_UNITS / 4;
export const PRECIPITATION_FLOOR_BANDS_BELOW_SEA =
  (FRESH_SEABED_DEPTH_BELOW_SEA + PRECIPITATION_FLOOR_CLEARANCE) / BAND_HEIGHT;

export const PRECIPITATION_FLOOR_WORLD_Y =
  -PRECIPITATION_FLOOR_BANDS_BELOW_SEA * WORLD_UNITS_PER_BAND;

export const PRECIPITATION_COLUMN_WORLD_UNITS =
  CLOUD_BASE_WORLD_Y - PRECIPITATION_FLOOR_WORLD_Y;

export interface PrecipitationProfile {
  readonly form: 'streak' | 'flake';
  readonly count: number;
  readonly fallSpeed: number;
  readonly streakLength: number;
  readonly spriteSize: number;
  readonly opacity: number;
  readonly color: number;
  readonly swayCells: number;
  readonly swayHz: number;
  readonly innerRadiusFraction: number;
}

export function seedRadius(u: number, innerRadiusFraction: number): number {
  const innerArea = innerRadiusFraction * innerRadiusFraction;
  return Math.sqrt(innerArea + u * (1 - innerArea));
}

export function fallFraction(
  elapsedSeconds: number,
  birth: number,
  fallSpeed: number,
): number {
  const cycles = birth + (elapsedSeconds * fallSpeed) / PRECIPITATION_COLUMN_WORLD_UNITS;
  return ((cycles % 1) + 1) % 1;
}

export function driftSeconds(fraction: number, fallSpeed: number): number {
  return (fraction * PRECIPITATION_COLUMN_WORLD_UNITS) / fallSpeed;
}

export interface PrecipitationColumn {
  readonly object: Object3D;
  readonly material: NodeMaterial;
  advance(elapsed: number, radius: number, vx: number, vy: number): void;
  dispose(): void;
}

export function createPrecipitationColumn(
  profile: PrecipitationProfile,
  renderOrder: number,
): PrecipitationColumn {
  const verticesPerParticle = profile.form === 'streak' ? 2 : 1;
  const discX = new Float32Array(profile.count);
  const discZ = new Float32Array(profile.count);
  const birth = new Float32Array(profile.count);
  const swayPhase = new Float32Array(profile.count);

  for (let i = 0; i < profile.count; i++) {
    const r = seedRadius(Math.random(), profile.innerRadiusFraction);
    const angle = Math.random() * TWO_PI;
    discX[i] = Math.cos(angle) * r;
    discZ[i] = Math.sin(angle) * r;
    birth[i] = Math.random();
    swayPhase[i] = Math.random() * TWO_PI;
  }

  const geometry = new BufferGeometry();
  const attribute = new Float32BufferAttribute(profile.count * verticesPerParticle * 3, 3);
  geometry.setAttribute('position', attribute);

  // Explicit bounds so the column frustum-culls like any other mesh. Spans the
  // full fall column in Y by construction; X/Z track the disc radius per advance.
  // (Previously frustumCulled = false: every system drew and uploaded every frame
  // even fully off-screen.)
  const bounds = new Sphere(
    new Vector3(0, PRECIPITATION_FLOOR_WORLD_Y + PRECIPITATION_COLUMN_WORLD_UNITS / 2, 0),
    PRECIPITATION_COLUMN_WORLD_UNITS / 2,
  );
  geometry.boundingSphere = bounds;

  const positions = attribute.array as Float32Array;

  const material =
    profile.form === 'streak'
      ? new LineBasicNodeMaterial({
          color: profile.color,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
      : new PointsNodeMaterial({
          color: profile.color,
          size: profile.spriteSize,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });

  const object =
    profile.form === 'streak'
      ? new LineSegments(geometry, material)
      : new Points(geometry, material);
  object.renderOrder = renderOrder;

  let lastPositionsAt = Number.NEGATIVE_INFINITY;

  function refreshBounds(radius: number): void {
    const halfH = PRECIPITATION_COLUMN_WORLD_UNITS / 2;
    const margin =
      (profile.form === 'streak' ? profile.streakLength : profile.spriteSize) +
      profile.swayCells;
    const r = radius + margin;
    bounds.radius = Math.sqrt(r * r + halfH * halfH);
  }

  return {
    object,
    material,

    advance(elapsed: number, radius: number, vx: number, vy: number): void {
      // Bounds track the disc every call (a few flops); the particle rewrite
      // below is gated to POSITION_UPDATE_INTERVAL_S.
      refreshBounds(radius);
      if (elapsed - lastPositionsAt < POSITION_UPDATE_INTERVAL_S) return;
      lastPositionsAt = elapsed;
      const speed = Math.hypot(vx, profile.fallSpeed, vy);
      const streakX = (vx / speed) * profile.streakLength;
      const streakY = (-profile.fallSpeed / speed) * profile.streakLength;
      const streakZ = (vy / speed) * profile.streakLength;

      let write = 0;
      for (let i = 0; i < profile.count; i++) {
        const fraction = fallFraction(elapsed, birth[i]!, profile.fallSpeed);
        const sway =
          profile.swayCells === 0
            ? 0
            : profile.swayCells * Math.sin(elapsed * profile.swayHz * TWO_PI + swayPhase[i]!);

        const x = discX[i]! * radius + sway;
        const y = CLOUD_BASE_WORLD_Y - fraction * PRECIPITATION_COLUMN_WORLD_UNITS;
        const z =
          discZ[i]! * radius +
          (profile.swayCells === 0
            ? 0
            : profile.swayCells * Math.cos(elapsed * profile.swayHz * TWO_PI + swayPhase[i]!));

        positions[write++] = x;
        positions[write++] = y;
        positions[write++] = z;
        if (verticesPerParticle === 2) {
          positions[write++] = x + streakX;
          positions[write++] = y + streakY;
          positions[write++] = z + streakZ;
        }
      }
      attribute.needsUpdate = true;
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
