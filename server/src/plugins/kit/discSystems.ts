import {
  type DiscSystemState,
  randomInRange,
  rollEvent,
  roundBroadcastIntensity,
  roundBroadcastPosition,
} from '@terrace/shared';
import {
  DISC_DEFAULT_FOOTPRINT_AREA_SCALE,
  DISC_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS,
  DISC_SPAWN_MARGIN_RADII,
  type DiscSystem,
  discActiveCapFor,
  discHasLeftWorld,
  discMaxRadiusFor,
  discMeanRadiusFor,
  discMinRadiusFor,
} from './discGeometry.ts';

export * from './discGeometry.ts';

export const DISC_MEAN_LIFETIME_SECONDS = 240;

export const DISC_FADE_SECONDS = 30;

export const DISC_MIN_PEAK_INTENSITY = 0.45;
export const DISC_MAX_PEAK_INTENSITY = 1;

export const DISC_SITING_ATTEMPTS = 4;

export interface DiscCell {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
}

export interface DiscVelocity {
  readonly vx: number;
  readonly vy: number;
}

export interface DiscSystemsSpec {
  readonly coverageFraction: number;
  readonly footprintAreaScale?: number;
  readonly maxActiveSystems: number;
  random(): number;
  siting?(x: number, y: number, radius: number): boolean;
  onUnsited?(): void;
}

export interface DiscSystems {
  readonly sitingAttempts: number;
  reset(): void;
  capFor(worldSize: number): number;
  systems(): readonly DiscSystem[];
  cells(): readonly DiscCell[];
  advance(worldSize: number, dt: number, velocity: DiscVelocity): void;
  spawnOne(worldSize: number): DiscSystem | null;
  spawnAt(worldSize: number, x: number, y: number): DiscSystem | null;
  force(forced: boolean): void;
  isForced(): boolean;
  intensityAt(x: number, y: number): number;
  states(velocity: DiscVelocity): DiscSystemState[];
}

export function createDiscSystems(spec: DiscSystemsSpec): DiscSystems {
  const systems: DiscSystem[] = [];
  let nextId = 1;
  let forced = false;

  const footprintAreaScale = spec.footprintAreaScale ?? DISC_DEFAULT_FOOTPRINT_AREA_SCALE;

  function randomCentre(worldSize: number, radius: number): { x: number; y: number } {
    const margin = radius * DISC_SPAWN_MARGIN_RADII;
    return {
      x: randomInRange(spec.random, -margin, worldSize + margin),
      y: randomInRange(spec.random, -margin, worldSize + margin),
    };
  }

  function birth(
    x: number,
    y: number,
    radius: number,
    peakIntensity: number,
  ): DiscSystem | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const system: DiscSystem = {
      id: nextId++,
      x,
      y,
      radius,
      peakIntensity,
      envelope: 0,
      retiring: false,
    };
    systems.push(system);
    return system;
  }

  function advanceForced(worldSize: number, dt: number): void {
    const centre = worldSize / 2;
    if (systems.length === 0) {
      const parked = birth(
        centre,
        centre,
        discMeanRadiusFor(worldSize, footprintAreaScale),
        DISC_MAX_PEAK_INTENSITY,
      );
      if (parked === null) return;
    }
    const system = systems[0]!;
    system.x = centre;
    system.y = centre;
    system.envelope = Math.min(1, system.envelope + dt / DISC_FADE_SECONDS);
  }

  function capFor(worldSize: number): number {
    return discActiveCapFor(worldSize, spec.coverageFraction, spec.maxActiveSystems);
  }

  // Two gates: natural and hub spawns stop at the coverage cap; a summoned
  // system may pass it but never the client's draw ceiling.
  function spawnOne(worldSize: number): DiscSystem | null {
    if (forced) return null;
    if (systems.length >= capFor(worldSize)) return null;

    const radius = randomInRange(
      spec.random,
      discMinRadiusFor(footprintAreaScale),
      discMaxRadiusFor(worldSize, footprintAreaScale),
    );

    let centre = randomCentre(worldSize, radius);
    if (spec.siting !== undefined) {
      let sited = spec.siting(centre.x, centre.y, radius);
      for (let attempt = 1; !sited && attempt < DISC_SITING_ATTEMPTS; attempt++) {
        centre = randomCentre(worldSize, radius);
        sited = spec.siting(centre.x, centre.y, radius);
      }
      if (!sited) {
        spec.onUnsited?.();
        return null;
      }
    }

    return birth(
      centre.x,
      centre.y,
      radius,
      randomInRange(spec.random, DISC_MIN_PEAK_INTENSITY, DISC_MAX_PEAK_INTENSITY),
    );
  }

  return {
    sitingAttempts: DISC_SITING_ATTEMPTS,

    reset(): void {
      systems.length = 0;
      nextId = 1;
      forced = false;
    },

    capFor,

    systems(): readonly DiscSystem[] {
      return systems;
    },

    cells(): readonly DiscCell[] {
      return systems.map((system) => ({
        x: system.x,
        y: system.y,
        radius: system.radius,
        intensity: system.peakIntensity * system.envelope,
      }));
    },

    spawnOne,

    spawnAt(worldSize: number, x: number, y: number): DiscSystem | null {
      if (forced) return null;
      if (systems.length >= spec.maxActiveSystems) return null;
      return birth(x, y, discMeanRadiusFor(worldSize, footprintAreaScale), DISC_MAX_PEAK_INTENSITY);
    },

    force(next: boolean): void {
      forced = next;
      systems.length = 0;
    },

    isForced(): boolean {
      return forced;
    },

    advance(worldSize: number, dt: number, velocity: DiscVelocity): void {
      if (forced) {
        advanceForced(worldSize, dt);
        return;
      }

      const envelopeStep = dt / DISC_FADE_SECONDS;
      const deathRate = 1 / DISC_MEAN_LIFETIME_SECONDS;

      for (let index = systems.length - 1; index >= 0; index--) {
        const system = systems[index]!;

        if (!system.retiring && rollEvent(spec.random, deathRate, dt)) system.retiring = true;

        system.envelope = system.retiring
          ? Math.max(0, system.envelope - envelopeStep)
          : Math.min(1, system.envelope + envelopeStep);

        system.x += velocity.vx * dt;
        system.y += velocity.vy * dt;

        const dissipated = system.retiring && system.envelope <= 0;
        if (dissipated || discHasLeftWorld(system, worldSize)) {
          systems.splice(index, 1);
        }
      }

      const freeSlots = capFor(worldSize) - systems.length;
      if (freeSlots <= 0) return;
      if (!rollEvent(spec.random, freeSlots / DISC_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS, dt)) {
        return;
      }
      spawnOne(worldSize);
    },

    intensityAt(x: number, y: number): number {
      let strongest = 0;
      for (const system of systems) {
        const dx = x - system.x;
        const dy = y - system.y;
        if (dx * dx + dy * dy <= system.radius * system.radius) {
          const intensity = system.peakIntensity * system.envelope;
          if (intensity > strongest) strongest = intensity;
        }
      }
      return Math.min(1, strongest);
    },

    states(velocity: DiscVelocity): DiscSystemState[] {
      const vx = roundBroadcastPosition(velocity.vx);
      const vy = roundBroadcastPosition(velocity.vy);
      return systems.map((system) => ({
        id: system.id,
        x: roundBroadcastPosition(system.x),
        y: roundBroadcastPosition(system.y),
        radius: roundBroadcastPosition(system.radius),
        intensity: roundBroadcastIntensity(system.peakIntensity * system.envelope),
        vx,
        vy,
      }));
    },
  };
}
