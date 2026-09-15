import {
  createSeededRng,
  exponentialWaitSeconds,
  randomInRange,
  rollEvent,
  roundBroadcastIntensity,
  roundBroadcastPosition,
  type RotatingStormState,
} from '@terrace/shared';
import { isWaterAt, waterFractionUnder } from './rotatingStormTerrain.ts';
import {
  ROTATING_STORM_DAMAGE_INTERVAL_SECONDS,
  ROTATING_STORM_DAMAGE_SAMPLE_CELLS,
  ROTATING_STORM_DESPAWN_MARGIN_RADII,
  ROTATING_STORM_SITING_ATTEMPTS,
  ROTATING_STORM_VEER_SQRT_REFERENCE_SECONDS,
  type RotatingStorm,
  type RotatingStormDamage,
  type RotatingStormLandfall,
  type RotatingStorms,
  type RotatingStormsSnapshot,
  type RotatingStormsSpec,
  type RotatingStormTick,
  type RotatingStormWorld,
} from './rotatingStormTypes.ts';

export * from './rotatingStormTypes.ts';
export * from './rotatingStormTerrain.ts';
export * from './rotatingStormSnapshot.ts';

function clampEnvelope(value: number): number {
  return Math.min(1, Math.max(0, value));
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
      if (frozen) return false;
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
      if (frozen) return null;
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
          const veer =
            profile.veerRadiansPerSecond *
            ROTATING_STORM_VEER_SQRT_REFERENCE_SECONDS *
            Math.sqrt(dt);
          storm.heading += (rng.next() * 2 - 1) * veer;
          storm.x += Math.cos(storm.heading) * profile.speedCellsPerSecond * dt;
          storm.y += Math.sin(storm.heading) * profile.speedCellsPerSecond * dt;

          if (!storm.retiring) {
            storm.lifeSeconds -= dt;
            if (storm.lifeSeconds <= 0) storm.retiring = true;
          }

          hostile = hostileTerrainFraction(storm, world);
          const terrainDecay = hostile * profile.hostileTerrainDecayPerSecond * dt;
          storm.envelope = clampEnvelope(
            storm.retiring
              ? storm.envelope - dt / profile.fadeSeconds - terrainDecay
              : storm.envelope + dt / profile.spinUpSeconds - terrainDecay,
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
        if (storm.damageDebtSeconds >= ROTATING_STORM_DAMAGE_INTERVAL_SECONDS && intensity > 0) {
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

    // A restored id must never be handed out again, whatever the counter said.
    restore(snapshot: RotatingStormsSnapshot): void {
      storms.length = 0;
      let highestId = 0;
      for (const storm of snapshot.storms) {
        storms.push({ ...storm });
        if (storm.id > highestId) highestId = storm.id;
      }
      nextStormId = Math.max(snapshot.nextStormId, highestId + 1);
      namedCount = snapshot.namedCount;
      rng = createSeededRng(snapshot.rngState);
    },

    reset(): void {
      storms.length = 0;
      nextStormId = 1;
      namedCount = 0;
      rng = createSeededRng(spec.seed);
      frozen = false;
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
