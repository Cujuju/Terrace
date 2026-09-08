import {
  BAND_HEIGHT,
  MAX_BRUSH_RADIUS,
  WORLD_UNIT_CELLS,
  cellsAcross,
  type SculptIntent,
} from '@terrace/shared';
import type {
  IntentCtx,
  IntentVerdict,
  PersistenceSlice,
  SliceLoadOutcome,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  CAST_DENIED_COOLDOWN,
  CAST_DENIED_MESSAGE,
  CAST_DENIED_TARGET,
  CAST_DENIED_UNOWNED,
  CAST_DENIED_UNSUITABLE,
  CAST_DENIED_WARDED,
  CAST_MESSAGE,
  COLLECT_MESSAGE,
  RELICS_MESSAGE,
  SKILLS_MESSAGE,
  SKILL_IDS,
  isSkillId,
  parseCastPayload,
  parseCollectPayload,
  skillInfo,
  type RelicView,
  type SkillId,
  type SkillView,
} from '../protocol.ts';
import { applyManaPerk, loadManaBridge, revokeManaPerk } from './mana-bridge.ts';
import { composeManaPerk, isPerkSkill } from './perk.ts';
import {
  RELIC_RNG_DEFAULT_SEED,
  chooseRelicCell,
  createRelicRng,
  type RelicRng,
  type TerrainClass,
} from './spawn.ts';
import { TERRAFORM_BY_SKILL, applyTerraform } from './terraform.ts';
import {
  claimWardNotice,
  dropWardsOf,
  resetWards,
  stampWard,
  sweepWards,
  wardHolderAgainst,
} from './ward.ts';

import { RELIC_COUNT } from '../protocol.ts';
export { RELIC_COUNT };

export const RELIC_RESPAWN_S = 45;

export const RELIC_KEEPALIVE_S = 15;

export const RELIC_SPAWN_RETRY_S = 5;

export const COOLDOWN_S_PER_PEAK_BAND = 5;

const COOLDOWN_BY_SKILL: ReadonlyMap<SkillId, number> = new Map<SkillId, number>(
  Array.from(TERRAFORM_BY_SKILL, ([id, spec]) => [
    id,
    spec.peakBands * COOLDOWN_S_PER_PEAK_BAND,
  ]),
);

export const RELICS_SLICE_VERSION = 1;

interface Relic {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly skill: SkillId;
}

interface PendingRespawn {
  readonly skill: SkillId;
  remainingS: number;
}

interface RelicsSlice {
  readonly version: number;
  readonly rngState: number;
  readonly nextSerial: number;
  readonly relics: ReadonlyArray<readonly [string, number, number, string]>;
  readonly respawns: ReadonlyArray<readonly [string, number]>;
}

let relics: Relic[] = [];
let respawns: PendingRespawn[] = [];

let nextSerial = 1;

let rng: RelicRng = createRelicRng(RELIC_RNG_DEFAULT_SEED);

const skillsBySession = new Map<string, Set<SkillId>>();

const cooldownsBySession = new Map<string, Map<SkillId, number>>();

let sinceKeepaliveS = 0;

function relicViews(): RelicView[] {
  return relics.map((relic) => ({ id: relic.id, x: relic.x, y: relic.y, skill: relic.skill }));
}

function broadcastRelics(world: WorldApi): void {
  world.broadcast(RELICS_MESSAGE, { relics: relicViews() });
  sinceKeepaliveS = 0;
}

function cooldownRemaining(sessionId: string, skill: SkillId): number {
  return cooldownsBySession.get(sessionId)?.get(skill) ?? 0;
}

function skillViews(sessionId: string): SkillView[] {
  const held = skillsBySession.get(sessionId);
  if (held === undefined) return [];

  const views: SkillView[] = [];
  for (const id of SKILL_IDS) {
    if (!held.has(id)) continue;
    views.push({
      id,
      kind: skillInfo(id).kind,
      cooldownS: COOLDOWN_BY_SKILL.get(id) ?? 0,
      cooldownRemainingS: cooldownRemaining(sessionId, id),
    });
  }
  return views;
}

function sendSkills(world: WorldApi, sessionId: string): void {
  world.sendTo(sessionId, SKILLS_MESSAGE, { skills: skillViews(sessionId) });
}

function denyCast(world: WorldApi, sessionId: string, skill: string, reason: string): void {
  world.sendTo(sessionId, CAST_DENIED_MESSAGE, { skill, reason });
}

function wardRefuses(
  world: WorldApi,
  sessionId: string,
  x: number,
  y: number,
  radius: number,
): boolean {
  if (wardHolderAgainst(world.worldSize, sessionId, x, y, radius) === null) return false;
  if (claimWardNotice(sessionId)) {
    denyCast(world, sessionId, 'bedrock-ward', CAST_DENIED_WARDED);
  }
  return true;
}

function preferredTerrainFor(serial: number): TerrainClass {
  return serial % 2 === 0 ? 'shore' : 'land';
}

function occupiedCells(size: number): Set<number> {
  return new Set(relics.map((relic) => relic.y * size + relic.x));
}

function spawnRelic(world: WorldApi, skill: SkillId): boolean {
  const serial = nextSerial;
  const cell = chooseRelicCell(
    world,
    rng,
    occupiedCells(world.worldSize),
    preferredTerrainFor(serial),
  );
  if (cell === null) return false;

  nextSerial++;
  relics.push({ id: `r${serial}`, x: cell.x, y: cell.y, skill });
  return true;
}

function topUpRelics(world: WorldApi): boolean {
  const present = new Set(relics.map((relic) => relic.skill));
  const waiting = new Set(respawns.map((entry) => entry.skill));

  let spawned = false;
  for (const skill of SKILL_IDS) {
    if (present.has(skill) || waiting.has(skill)) continue;
    if (spawnRelic(world, skill)) spawned = true;
    else respawns.push({ skill, remainingS: RELIC_SPAWN_RETRY_S });
  }
  return spawned;
}

function syncManaPerk(sessionId: string): void {
  const held = skillsBySession.get(sessionId);
  applyManaPerk(sessionId, composeManaPerk(held ?? []));
}

function grantSkill(world: WorldApi, sessionId: string, skill: SkillId): void {
  let held = skillsBySession.get(sessionId);
  if (held === undefined) {
    held = new Set<SkillId>();
    skillsBySession.set(sessionId, held);
  }
  held.add(skill);

  if (isPerkSkill(skill)) syncManaPerk(sessionId);
  sendSkills(world, sessionId);
}

function startCooldown(sessionId: string, skill: SkillId): void {
  const seconds = COOLDOWN_BY_SKILL.get(skill) ?? 0;
  if (seconds <= 0) return;

  let cooldowns = cooldownsBySession.get(sessionId);
  if (cooldowns === undefined) {
    cooldowns = new Map<SkillId, number>();
    cooldownsBySession.set(sessionId, cooldowns);
  }
  cooldowns.set(skill, seconds);
}

function advanceCooldowns(world: WorldApi, dt: number): void {
  for (const [sessionId, cooldowns] of cooldownsBySession) {
    let displayChanged = false;

    for (const [skill, remaining] of cooldowns) {
      const before = Math.ceil(remaining);
      const next = remaining - dt;

      if (next <= 0) {
        cooldowns.delete(skill);
        displayChanged = true;
        continue;
      }

      cooldowns.set(skill, next);
      if (Math.ceil(next) !== before) displayChanged = true;
    }

    if (cooldowns.size === 0) cooldownsBySession.delete(sessionId);
    if (displayChanged) sendSkills(world, sessionId);
  }
}

function handleCollect(world: WorldApi, player: Player, payload: unknown): void {
  const message = parseCollectPayload(payload);
  if (message === null) return;

  const index = relics.findIndex((relic) => relic.id === message.id);
  if (index === -1) {
    return;
  }

  const [taken] = relics.splice(index, 1);
  respawns.push({ skill: taken.skill, remainingS: RELIC_RESPAWN_S });

  grantSkill(world, player.id, taken.skill);
  broadcastRelics(world);

  world.emitEvent('collected', {
    skill: taken.skill,
    label: skillInfo(taken.skill).name,
    player: player.name,
    x: taken.x,
    y: taken.y,
  });
}

function handleCast(world: WorldApi, player: Player, payload: unknown): void {
  const message = parseCastPayload(payload, world.worldSize);
  if (message === null) {
    return;
  }

  const { skill, x, y } = message;

  const held = skillsBySession.get(player.id);
  const spec = TERRAFORM_BY_SKILL.get(skill);
  if (held === undefined || !held.has(skill) || spec === undefined) {
    denyCast(world, player.id, skill, CAST_DENIED_UNOWNED);
    return;
  }

  if (cooldownRemaining(player.id, skill) > 0) {
    denyCast(world, player.id, skill, CAST_DENIED_COOLDOWN);
    return;
  }

  if (!world.isCellUnlocked(x, y)) {
    denyCast(world, player.id, skill, CAST_DENIED_TARGET);
    return;
  }

  const steps = spec.plan(world, x, y);
  if (steps.length === 0) {
    denyCast(world, player.id, skill, CAST_DENIED_UNSUITABLE);
    return;
  }

  for (const step of steps) {
    if (wardRefuses(world, player.id, x + step.dx, y + step.dy, step.radius)) return;
  }

  applyTerraform(world, x, y, steps);
  startCooldown(player.id, skill);
  sendSkills(world, player.id);
}

function loadSlice(data: unknown): void {
  relics = [];
  respawns = [];
  nextSerial = 1;
  rng = createRelicRng(RELIC_RNG_DEFAULT_SEED);

  if (typeof data !== 'object' || data === null) return;
  const slice = data as Partial<RelicsSlice>;
  if (slice.version !== RELICS_SLICE_VERSION) return;

  if (Number.isInteger(slice.rngState)) rng = createRelicRng(slice.rngState as number);
  if (Number.isInteger(slice.nextSerial) && (slice.nextSerial as number) > 0) {
    nextSerial = slice.nextSerial as number;
  }

  if (Array.isArray(slice.relics)) {
    for (const entry of slice.relics) {
      if (!Array.isArray(entry) || entry.length !== 4) continue;
      const [id, x, y, skill] = entry as [unknown, unknown, unknown, unknown];
      if (typeof id !== 'string' || id.length === 0) continue;
      if (!Number.isInteger(x) || (x as number) < 0) continue;
      if (!Number.isInteger(y) || (y as number) < 0) continue;
      if (!isSkillId(skill)) continue;
      relics.push({ id, x: x as number, y: y as number, skill });
    }
  }

  if (Array.isArray(slice.respawns)) {
    for (const entry of slice.respawns) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [skill, remainingS] = entry as [unknown, unknown];
      if (!isSkillId(skill)) continue;
      if (typeof remainingS !== 'number' || !Number.isFinite(remainingS)) continue;
      respawns.push({ skill, remainingS: Math.min(Math.max(remainingS, 0), RELIC_RESPAWN_S) });
    }
  }

  const claimed = new Set<SkillId>();
  const uniqueRelics: Relic[] = [];
  for (const relic of relics) {
    if (claimed.has(relic.skill)) continue;
    claimed.add(relic.skill);
    uniqueRelics.push(relic);
  }
  relics = uniqueRelics;

  const uniqueRespawns: PendingRespawn[] = [];
  for (const entry of respawns) {
    if (claimed.has(entry.skill)) continue;
    claimed.add(entry.skill);
    uniqueRespawns.push(entry);
  }
  respawns = uniqueRespawns;
}

function selfDescribedSliceVersion(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const version = (data as { version?: unknown }).version;
  return Number.isSafeInteger(version) ? (version as number) : undefined;
}

const persistence: PersistenceSlice = {
  save(): RelicsSlice {
    return {
      version: RELICS_SLICE_VERSION,
      rngState: rng.state(),
      nextSerial,
      relics: relics.map((relic) => [relic.id, relic.x, relic.y, relic.skill] as const),
      respawns: respawns.map((entry) => [entry.skill, entry.remainingS] as const),
    };
  },
  version: RELICS_SLICE_VERSION,
  load(data: unknown, fromVersion: number): SliceLoadOutcome {
    if ((selfDescribedSliceVersion(data) ?? fromVersion) > RELICS_SLICE_VERSION) {
      return 'refuse';
    }
    loadSlice(data);
    return undefined;
  },
};

export const plugin: TerracePlugin = {
  name: 'relics',

  onWorldCreate(world: WorldApi): void {
    loadManaBridge(world);

    topUpRelics(world);
    broadcastRelics(world);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    world.sendTo(player.id, RELICS_MESSAGE, { relics: relicViews() });
    sendSkills(world, player.id);
  },

  onPlayerLeave(_world: WorldApi, player: Player): void {
    skillsBySession.delete(player.id);
    cooldownsBySession.delete(player.id);
    revokeManaPerk(player.id);
    dropWardsOf(player.id);
  },

  onTick(world: WorldApi, dt: number): void {
    advanceCooldowns(world, dt);
    sweepWards(dt);

    let due = false;
    for (const entry of respawns) {
      entry.remainingS -= dt;
      if (entry.remainingS <= 0) due = true;
    }
    if (due) {
      respawns = respawns.filter((entry) => entry.remainingS > 0);
      if (topUpRelics(world)) broadcastRelics(world);
    }

    sinceKeepaliveS += dt;
    if (sinceKeepaliveS >= RELIC_KEEPALIVE_S) broadcastRelics(world);
  },

  onIntent(intent: SculptIntent, ctx: IntentCtx): IntentVerdict | void {
    if (wardRefuses(ctx.world, ctx.player.id, intent.x, intent.y, intent.radius)) {
      return { kind: 'deny', reason: CAST_DENIED_WARDED };
    }
  },

  onIntentApplied(intent: SculptIntent, ctx: IntentCtx): void {
    const held = skillsBySession.get(ctx.player.id);
    if (held === undefined || !held.has('bedrock-ward')) return;
    stampWard(ctx.world.worldSize, ctx.player.id, intent.x, intent.y, intent.radius);
  },

  messages: {
    [COLLECT_MESSAGE]: handleCollect,
    [CAST_MESSAGE]: handleCast,
  },

  persistence,
};

export function currentRelics(): readonly RelicView[] {
  return relicViews();
}

export function skillsOf(sessionId: string): readonly SkillId[] {
  return skillViews(sessionId).map((view) => view.id);
}

export function cooldownOf(sessionId: string, skill: SkillId): number {
  return cooldownRemaining(sessionId, skill);
}

export function resetRelicsState(): void {
  relics = [];
  respawns = [];
  nextSerial = 1;
  rng = createRelicRng(RELIC_RNG_DEFAULT_SEED);
  skillsBySession.clear();
  cooldownsBySession.clear();
  resetWards();
  sinceKeepaliveS = 0;
}
