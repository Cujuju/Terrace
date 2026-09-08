import {
  type DiscSystemState,
  cellsAcross,
  randomInRange,
  rollEvent,
  roundBroadcastIntensity,
  roundBroadcastPosition,
} from '@terrace/shared';

export const DISC_MIN_ACTIVE_SYSTEMS = 1;

export const DISC_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS = 20;

export const DISC_EFFECTIVE_LIFETIME_SECONDS = 130;

export const DISC_EQUILIBRIUM_OCCUPANCY =
  DISC_EFFECTIVE_LIFETIME_SECONDS /
  (DISC_EFFECTIVE_LIFETIME_SECONDS + DISC_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS);

export const DISC_MEAN_LIFETIME_SECONDS = 240;

export const DISC_FADE_SECONDS = 30;

export const DISC_SYSTEM_MIN_RADIUS_CELLS = cellsAcross(24);
export const DISC_SYSTEM_MAX_RADIUS_CELLS = cellsAcross(56);

export const DISC_DEFAULT_FOOTPRINT_AREA_SCALE = 1;

export function discRadiusFactorFor(footprintAreaScale: number): number {
  return Math.sqrt(footprintAreaScale);
}

export const DISC_MAX_RADIUS_WORLD_FRACTION = 0.35;

export const DISC_MIN_PEAK_INTENSITY = 0.45;
export const DISC_MAX_PEAK_INTENSITY = 1;

export const DISC_SPAWN_MARGIN_RADII = 1;

export const DISC_DESPAWN_MARGIN_RADII = 1.5;

export const DISC_SITING_ATTEMPTS = 4;

export interface DiscSystem {
  readonly id: number;
  x: number;
  y: number;
  readonly radius: number;
  readonly peakIntensity: number;
  envelope: number;
  retiring: boolean;
}

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
  spawnAt(worldSize: number, x: number, y: number): DiscSystem;
  force(forced: boolean): void;
  isForced(): boolean;
  intensityAt(x: number, y: number): number;
  states(velocity: DiscVelocity): DiscSystemState[];
}

export function discMinRadiusFor(
  footprintAreaScale: number = DISC_DEFAULT_FOOTPRINT_AREA_SCALE,
): number {
  return DISC_SYSTEM_MIN_RADIUS_CELLS * discRadiusFactorFor(footprintAreaScale);
}

export function discMaxRadiusFor(
  worldSize: number,
  footprintAreaScale: number = DISC_DEFAULT_FOOTPRINT_AREA_SCALE,
): number {
  const fromWorld = worldSize * DISC_MAX_RADIUS_WORLD_FRACTION;
  return Math.max(
    discMinRadiusFor(footprintAreaScale),
    Math.min(DISC_SYSTEM_MAX_RADIUS_CELLS * discRadiusFactorFor(footprintAreaScale), fromWorld),
  );
}

export function discMeanRadiusFor(
  worldSize: number,
  footprintAreaScale: number = DISC_DEFAULT_FOOTPRINT_AREA_SCALE,
): number {
  return (
    (discMinRadiusFor(footprintAreaScale) + discMaxRadiusFor(worldSize, footprintAreaScale)) / 2
  );
}

export function discMeanFootprintCells(worldSize: number): number {
  const a = DISC_SYSTEM_MIN_RADIUS_CELLS;
  const b = discMaxRadiusFor(worldSize);
  return (Math.PI * (a * a + a * b + b * b)) / 3;
}

export function discActiveCapFor(
  worldSize: number,
  coverageFraction: number,
  ceiling: number,
): number {
  const spawnFieldEdge =
    worldSize + 2 * discMeanRadiusFor(worldSize) * DISC_SPAWN_MARGIN_RADII;
  const perSystemCoverage = discMeanFootprintCells(worldSize) / (spawnFieldEdge * spawnFieldEdge);
  const wanted = Math.round(coverageFraction / perSystemCoverage / DISC_EQUILIBRIUM_OCCUPANCY);
  return Math.max(DISC_MIN_ACTIVE_SYSTEMS, Math.min(ceiling, wanted));
}

export function discHasLeftWorld(system: DiscSystem, worldSize: number): boolean {
  const margin = system.radius * DISC_DESPAWN_MARGIN_RADII;
  return (
    system.x < -margin ||
    system.y < -margin ||
    system.x > worldSize + margin ||
    system.y > worldSize + margin
  );
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

  function birth(x: number, y: number, radius: number, peakIntensity: number): DiscSystem {
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
      birth(
        centre,
        centre,
        discMeanRadiusFor(worldSize, footprintAreaScale),
        DISC_MAX_PEAK_INTENSITY,
      );
    }
    const system = systems[0]!;
    system.x = centre;
    system.y = centre;
    system.envelope = Math.min(1, system.envelope + dt / DISC_FADE_SECONDS);
  }

  function capFor(worldSize: number): number {
    return discActiveCapFor(worldSize, spec.coverageFraction, spec.maxActiveSystems);
  }

  function spawnOne(worldSize: number): DiscSystem | null {
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

    spawnAt(worldSize: number, x: number, y: number): DiscSystem {
      return birth(
        x,
        y,
        discMeanRadiusFor(worldSize, footprintAreaScale),
        DISC_MAX_PEAK_INTENSITY,
      );
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
        if (dx * dx + dy * dy > system.radius * system.radius) continue;
        const intensity = system.peakIntensity * system.envelope;
        if (intensity > strongest) strongest = intensity;
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
