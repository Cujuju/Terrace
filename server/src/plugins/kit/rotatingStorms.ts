import {
  SEA_LEVEL,
  createSeededRng,
  exponentialWaitSeconds,
  isFiniteNumber,
  parseRecordArray,
  randomInRange,
  rollEvent,
  roundBroadcastIntensity,
  roundBroadcastPosition,
  type RotatingStormState,
} from '@terrace/shared';

export interface RotatingStormWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
}

export type HostileTerrain = 'land' | 'water';

export interface RotatingStormProfile {
  readonly speedCellsPerSecond: number;
  readonly veerRadiansPerSecond: number;
  readonly meanLifetimeSeconds: number;
  readonly spinUpSeconds: number;
  readonly fadeSeconds: number;
  readonly hostileTerrainDecayPerSecond: number;
  readonly minPeakIntensity: number;
  readonly maxPeakIntensity: number;
  readonly maxActive: number;
  readonly hostileTerrain: HostileTerrain;
  readonly eyeRadiusFraction: number;
  windFalloff(r: number): number;
}

export interface RotatingStormsSpec {
  readonly profile: RotatingStormProfile;
  readonly seed: number;
  radiusFor(worldSize: number): number;
  nameFor?(index: number, x: number, y: number, worldSize: number): string;
  readonly reportsLandfall?: boolean;
}

export const ROTATING_STORM_SITING_ATTEMPTS = 6;

export const ROTATING_STORM_DISC_SAMPLE_OFFSETS: readonly (readonly [number, number])[] = (() => {
  const offsets: Array<readonly [number, number]> = [[0, 0]];
  const rings: readonly (readonly [number, number])[] = [
    [0.55, 0],
    [1, Math.PI / 6],
  ];
  const SPOKES_PER_RING = 6;
  for (const [scale, phase] of rings) {
    for (let i = 0; i < SPOKES_PER_RING; i++) {
      const angle = phase + (i * 2 * Math.PI) / SPOKES_PER_RING;
      offsets.push([Math.cos(angle) * scale, Math.sin(angle) * scale]);
    }
  }
  return offsets;
})();

export const ROTATING_STORM_DESPAWN_MARGIN_RADII = 1.5;

export const ROTATING_STORM_DAMAGE_INTERVAL_SECONDS = 1;

export const ROTATING_STORM_DAMAGE_SAMPLE_CELLS = 12;

export interface RotatingStorm {
  readonly id: number;
  x: number;
  y: number;
  readonly radius: number;
  heading: number;
  readonly peakIntensity: number;
  envelope: number;
  retiring: boolean;
  lifeSeconds: number;
  readonly name?: string;
  landfallReported: boolean;
  damageDebtSeconds: number;
  ownerDebtSeconds: number;
}

export interface RotatingStormDamage {
  readonly stormId: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly eyeRadius: number;
  readonly intensity: number;
  readonly durationSeconds: number;
  readonly cells: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly severity: number;
  }>;
}

export interface RotatingStormLandfall {
  readonly stormId: number;
  readonly x: number;
  readonly y: number;
  readonly intensity: number;
  readonly name?: string;
}

export interface RotatingStormTick {
  readonly changed: boolean;
  readonly damage: readonly RotatingStormDamage[];
  readonly landfalls: readonly RotatingStormLandfall[];
}

export interface RotatingStormsSnapshot {
  readonly nextStormId: number;
  readonly namedCount: number;
  readonly rngState: number;
  readonly storms: readonly RotatingStorm[];
}

export interface RotatingStorms {
  readonly sitingAttempts: number;
  readonly maxActive: number;
  random(): number;
  rollSpawn(ratePerSecond: number, dt: number): boolean;
  storms(): readonly RotatingStorm[];
  count(): number;
  trySpawn(
    world: RotatingStormWorld,
    drawSite: (random: () => number) => { readonly x: number; readonly y: number } | null,
  ): RotatingStorm | null;
  spawnAt(world: RotatingStormWorld, x: number, y: number): RotatingStorm;
  advance(world: RotatingStormWorld, dt: number): RotatingStormTick;
  states(): RotatingStormState[];
  snapshot(): RotatingStormsSnapshot;
  restore(snapshot: RotatingStormsSnapshot): void;
  reset(): void;
  clear(): void;
  freeze(frozen: boolean): void;
  isFrozen(): boolean;
}

function isWaterAt(world: RotatingStormWorld, x: number, y: number): boolean {
  return world.heightAt(x, y) <= SEA_LEVEL;
}

export function waterFractionUnder(
  world: RotatingStormWorld,
  x: number,
  y: number,
  radius: number,
): number {
  let water = 0;
  for (const [dx, dy] of ROTATING_STORM_DISC_SAMPLE_OFFSETS) {
    const sx = Math.round(x + dx * radius);
    const sy = Math.round(y + dy * radius);
    const outside = sx < 0 || sy < 0 || sx >= world.worldSize || sy >= world.worldSize;
    if (outside || isWaterAt(world, sx, sy)) water++;
  }
  return water / ROTATING_STORM_DISC_SAMPLE_OFFSETS.length;
}

function parseStorm(value: unknown): RotatingStorm | null {
  if (typeof value !== 'object' || value === null) return null;
  const {
    id,
    x,
    y,
    radius,
    heading,
    peakIntensity,
    envelope,
    retiring,
    lifeSeconds,
    name,
    landfallReported,
    damageDebtSeconds,
    ownerDebtSeconds,
  } = value as Record<string, unknown>;

  if (!Number.isInteger(id)) return null;
  for (const number of [x, y, radius, heading, peakIntensity, envelope, lifeSeconds]) {
    if (!isFiniteNumber(number)) return null;
  }
  if (!isFiniteNumber(damageDebtSeconds) || damageDebtSeconds < 0) return null;
  const ownerDebt = ownerDebtSeconds === undefined ? 0 : ownerDebtSeconds;
  if (!isFiniteNumber(ownerDebt) || ownerDebt < 0) return null;
  if (typeof retiring !== 'boolean' || typeof landfallReported !== 'boolean') return null;
  if (name !== undefined && typeof name !== 'string') return null;

  return {
    id: id as number,
    x: x as number,
    y: y as number,
    radius: radius as number,
    heading: heading as number,
    peakIntensity: peakIntensity as number,
    envelope: envelope as number,
    retiring: retiring as boolean,
    lifeSeconds: lifeSeconds as number,
    ...(typeof name === 'string' ? { name } : {}),
    landfallReported: landfallReported as boolean,
    damageDebtSeconds: damageDebtSeconds as number,
    ownerDebtSeconds: ownerDebt,
  };
}

export function parseRotatingStormsSnapshot(data: unknown): RotatingStormsSnapshot | null {
  if (typeof data !== 'object' || data === null) return null;
  const { nextStormId, namedCount, rngState, storms } = data as Record<string, unknown>;
  if (!Number.isInteger(nextStormId) || !Number.isInteger(namedCount)) return null;
  if (!Number.isInteger(rngState)) return null;
  const parsed = parseRecordArray(storms, parseStorm);
  if (parsed === null) return null;
  return {
    nextStormId: nextStormId as number,
    namedCount: namedCount as number,
    rngState: rngState as number,
    storms: parsed,
  };
}

export function createRotatingStorms(spec: RotatingStormsSpec): RotatingStorms {
  const { profile } = spec;
  const storms: RotatingStorm[] = [];
  let nextStormId = 1;
  let namedCount = 0;
  let rng = createSeededRng(spec.seed);
  let frozen = false;

  function birth(
    world: RotatingStormWorld,
    x: number,
    y: number,
    name: string | undefined,
  ): RotatingStorm {
    const storm: RotatingStorm = {
      id: nextStormId++,
      x,
      y,
      radius: spec.radiusFor(world.worldSize),
      heading: rng.next() * Math.PI * 2,
      peakIntensity: randomInRange(rng.next, profile.minPeakIntensity, profile.maxPeakIntensity),
      envelope: 0,
      retiring: false,
      lifeSeconds: exponentialWaitSeconds(rng.next, profile.meanLifetimeSeconds),
      ...(name === undefined ? {} : { name }),
      landfallReported: false,
      damageDebtSeconds: 0,
      ownerDebtSeconds: 0,
    };
    storms.push(storm);
    return storm;
  }

  function nextName(world: RotatingStormWorld, x: number, y: number): string | undefined {
    if (spec.nameFor === undefined) return undefined;
    return spec.nameFor(namedCount++, x, y, world.worldSize);
  }

  function hasLeftWorld(storm: RotatingStorm, worldSize: number): boolean {
    const margin = storm.radius * ROTATING_STORM_DESPAWN_MARGIN_RADII;
    return (
      storm.x < -margin ||
      storm.y < -margin ||
      storm.x > worldSize + margin ||
      storm.y > worldSize + margin
    );
  }

  function hostileTerrainFraction(storm: RotatingStorm, world: RotatingStormWorld): number {
    const water = waterFractionUnder(world, storm.x, storm.y, storm.radius);
    return profile.hostileTerrain === 'land' ? 1 - water : water;
  }

  function sampleStruckCells(
    storm: RotatingStorm,
    world: RotatingStormWorld,
    intensity: number,
  ): RotatingStormDamage['cells'] {
    const cells: Array<{ x: number; y: number; severity: number }> = [];
    for (let i = 0; i < ROTATING_STORM_DAMAGE_SAMPLE_CELLS; i++) {
      const angle = rng.next() * Math.PI * 2;
      const distance = Math.sqrt(rng.next()) * storm.radius;
      const x = Math.round(storm.x + Math.cos(angle) * distance);
      const y = Math.round(storm.y + Math.sin(angle) * distance);
      if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) continue;
      const severity = intensity * windFalloffAt(distance, storm.radius);
      if (severity <= 0) continue;
      cells.push({ x, y, severity });
    }
    return cells;
  }

  function windFalloffAt(distance: number, radius: number): number {
    if (radius <= 0) return 0;
    const r = distance / radius;
    if (r >= 1) return 0;
    return profile.windFalloff(r);
  }

  return {
    sitingAttempts: ROTATING_STORM_SITING_ATTEMPTS,
    maxActive: profile.maxActive,

    random(): number {
      return rng.next();
    },

    rollSpawn(ratePerSecond: number, dt: number): boolean {
      return rollEvent(rng.next, ratePerSecond, dt);
    },

    storms(): readonly RotatingStorm[] {
      return storms;
    },

    count(): number {
      return storms.length;
    },

    trySpawn(
      world: RotatingStormWorld,
      drawSite: (random: () => number) => { readonly x: number; readonly y: number } | null,
    ): RotatingStorm | null {
      for (let attempt = 0; attempt < ROTATING_STORM_SITING_ATTEMPTS; attempt++) {
        const site = drawSite(rng.next);
        if (site === null) continue;
        return birth(world, site.x, site.y, nextName(world, site.x, site.y));
      }
      return null;
    },

    spawnAt(world: RotatingStormWorld, x: number, y: number): RotatingStorm {
      return birth(world, x, y, nextName(world, x, y));
    },

    advance(world: RotatingStormWorld, dt: number): RotatingStormTick {
      const damage: RotatingStormDamage[] = [];
      const landfalls: RotatingStormLandfall[] = [];
      let changed = false;

      for (let index = storms.length - 1; index >= 0; index--) {
        const storm = storms[index]!;
        changed = true;

        let hostile = 0;
        if (!frozen) {
          storm.heading += (rng.next() * 2 - 1) * profile.veerRadiansPerSecond * dt;
          storm.x += Math.cos(storm.heading) * profile.speedCellsPerSecond * dt;
          storm.y += Math.sin(storm.heading) * profile.speedCellsPerSecond * dt;

          if (!storm.retiring) {
            storm.lifeSeconds -= dt;
            if (storm.lifeSeconds <= 0) storm.retiring = true;
          }

          hostile = hostileTerrainFraction(storm, world);
          const terrainDecay = hostile * profile.hostileTerrainDecayPerSecond * dt;
          storm.envelope = storm.retiring
            ? Math.max(0, storm.envelope - dt / profile.fadeSeconds - terrainDecay)
            : Math.min(
                1,
                Math.max(0, storm.envelope + dt / profile.spinUpSeconds - terrainDecay),
              );
        }

        const intensity = storm.peakIntensity * storm.envelope;

        if (spec.reportsLandfall === true && !storm.landfallReported) {
          const ex = Math.round(storm.x);
          const ey = Math.round(storm.y);
          const inside = ex >= 0 && ey >= 0 && ex < world.worldSize && ey < world.worldSize;
          if (inside && !isWaterAt(world, ex, ey)) {
            storm.landfallReported = true;
            landfalls.push({
              stormId: storm.id,
              x: roundBroadcastPosition(storm.x),
              y: roundBroadcastPosition(storm.y),
              intensity: roundBroadcastIntensity(intensity),
              ...(storm.name === undefined ? {} : { name: storm.name }),
            });
          }
        }

        storm.damageDebtSeconds += dt;
        if (
          storm.damageDebtSeconds >= ROTATING_STORM_DAMAGE_INTERVAL_SECONDS &&
          intensity > 0
        ) {
          const durationSeconds = storm.damageDebtSeconds;
          storm.damageDebtSeconds = 0;
          damage.push({
            stormId: storm.id,
            x: roundBroadcastPosition(storm.x),
            y: roundBroadcastPosition(storm.y),
            radius: roundBroadcastPosition(storm.radius),
            eyeRadius: roundBroadcastPosition(storm.radius * profile.eyeRadiusFraction),
            intensity: roundBroadcastIntensity(intensity),
            durationSeconds,
            cells: sampleStruckCells(storm, world, intensity),
          });
        }

        const spentOut = storm.envelope <= 0 && (storm.retiring || hostile > 0);
        if (!frozen && (spentOut || hasLeftWorld(storm, world.worldSize))) {
          storms.splice(index, 1);
        }
      }

      return { changed, damage, landfalls };
    },

    states(): RotatingStormState[] {
      return storms.map((storm) => ({
        id: storm.id,
        x: roundBroadcastPosition(storm.x),
        y: roundBroadcastPosition(storm.y),
        radius: roundBroadcastPosition(storm.radius),
        intensity: roundBroadcastIntensity(storm.peakIntensity * storm.envelope),
        vx: roundBroadcastPosition(Math.cos(storm.heading) * profile.speedCellsPerSecond),
        vy: roundBroadcastPosition(Math.sin(storm.heading) * profile.speedCellsPerSecond),
        ...(storm.name === undefined ? {} : { name: storm.name }),
      }));
    },

    snapshot(): RotatingStormsSnapshot {
      return {
        nextStormId,
        namedCount,
        rngState: rng.state(),
        storms: storms.map((storm) => ({ ...storm })),
      };
    },

    restore(snapshot: RotatingStormsSnapshot): void {
      storms.length = 0;
      for (const storm of snapshot.storms) storms.push({ ...storm });
      nextStormId = snapshot.nextStormId;
      namedCount = snapshot.namedCount;
      rng = createSeededRng(snapshot.rngState);
    },

    reset(): void {
      storms.length = 0;
      nextStormId = 1;
      namedCount = 0;
      rng = createSeededRng(spec.seed);
    },

    clear(): void {
      storms.length = 0;
    },

    freeze(value: boolean): void {
      frozen = value;
    },

    isFrozen(): boolean {
      return frozen;
    },
  };
}
