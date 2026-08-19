// relics, driven through the REAL plugin host, the REAL intent pipeline and the
// REAL mana plugin — no stubs for any of the three. The plugin's whole premise
// is that a skill system, a terraform verb and a cross-plugin dependency all fit
// behind the shipped API; if any of that is untrue, this file is what fails.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAND_HEIGHT, MAX_BRUSH_RADIUS } from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import type { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  worldWithUnlockedChunks,
} from '../../../server/test/support/harness.ts';
import {
  MANA_CAPACITY,
  MANA_COST_PER_MIN_RADIUS_SCULPT,
  MANA_PER_BAND_CELL,
  NEUTRAL_MANA_MULTIPLIER,
  manaPerBandCellFor,
  manaPerkOf,
  plugin as manaPlugin,
  resetManaState,
} from '../../mana/server/index.ts';
import {
  CAST_DENIED_COOLDOWN,
  CAST_DENIED_MESSAGE,
  CAST_DENIED_TARGET,
  CAST_DENIED_UNOWNED,
  CAST_MESSAGE,
  COLLECT_MESSAGE,
  RELICS_MESSAGE,
  SKILLS_MESSAGE,
  SKILL_IDS,
  type SkillId,
} from '../protocol.ts';
import {
  MANA_UNAVAILABLE_WARNING,
  type ManaModuleLoader,
  isManaAvailable,
  manaBridgeReady,
  resetManaBridge,
  setManaModuleLoader,
} from '../server/mana-bridge.ts';
import {
  AZURE_HEART_COST_MULTIPLIER,
  SPRING_OF_AETHER_REGEN_MULTIPLIER,
} from '../server/perk.ts';
import {
  RELIC_COUNT,
  RELIC_KEEPALIVE_S,
  RELIC_RESPAWN_S,
  RELIC_SPAWN_RETRY_S,
  TITANS_HAND_RADIUS_BONUS,
  cooldownOf,
  currentRelics,
  plugin as relicsPlugin,
  resetRelicsState,
  skillsOf,
} from '../server/index.ts';
import { QUAKE_CORE_DEPTH_BANDS } from '../server/terraform.ts';

/** 64² cells = 4×4 chunks — small enough to reason about, big enough to spawn in. */
const WORLD_SIZE = 64;

/** Chunks per edge at WORLD_SIZE (CHUNK_SIZE is 16). */
const CHUNKS_PER_EDGE = 4;

/**
 * The one chunk left LOCKED, so there is somewhere a cast may not target.
 * Everything else is unlocked, which also keeps relic spawning (bounded
 * rejection sampling over the whole grid) from being able to starve.
 */
const LOCKED_CHUNK: readonly [number, number] = [3, 3];

/** A cell inside LOCKED_CHUNK. */
const LOCKED_CELL = { x: 56, y: 56 } as const;

/** Well inside unlocked territory, and far enough from every edge that a
 * composed terraform's ±MAX_BRUSH_RADIUS offsets all stay in bounds. */
const TARGET_CELL = { x: 24, y: 24 } as const;

/** Default server tick period (TICK_HZ = 10). */
const TICK_DT = 0.1;

const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };

function unlockedChunksExcept(
  excluded: readonly [number, number],
): Array<readonly [number, number]> {
  const chunks: Array<readonly [number, number]> = [];
  for (let cy = 0; cy < CHUNKS_PER_EDGE; cy++) {
    for (let cx = 0; cx < CHUNKS_PER_EDGE; cx++) {
      if (cx === excluded[0] && cy === excluded[1]) continue;
      chunks.push([cx, cy]);
    }
  }
  return chunks;
}

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

/**
 * Boots a world with mana and relics in the order discovery would produce
 * (directories sorted: mana, relics) and walks the same boot sequence
 * server/src/index.ts does — restorePersistence, then worldCreate.
 */
function boot(options: { manaLoader?: ManaModuleLoader; slices?: Record<string, unknown> } = {}): Harness {
  resetManaState();
  resetRelicsState();
  resetManaBridge();
  if (options.manaLoader !== undefined) setManaModuleLoader(options.manaLoader);

  const world = worldWithUnlockedChunks(WORLD_SIZE, unlockedChunksExcept(LOCKED_CHUNK));
  const sink = new RecordingSink();
  world.setSink(sink);

  const host = new PluginHost(world, [manaPlugin, relicsPlugin].map(asLoadedPlugin));
  if (options.slices !== undefined) host.restorePersistence(options.slices);
  host.worldCreate();

  world.addPlayer(PLAYER);
  host.playerJoined(PLAYER);

  return { world, host, sink };
}

/** Delivers a client → server plugin message through the host's own routing,
 * so the `relics:` namespacing is exercised rather than bypassed. */
function send(harness: Harness, type: string, payload: unknown, player: Player = PLAYER): void {
  const wireType = `relics:${type}`;
  const entry = harness.host.messageHandlers().find(([name]) => name === wireType);
  expect(entry, `no handler registered for ${wireType}`).toBeDefined();
  entry?.[1](player, payload);
}

/** Collects the relic currently carrying `skill`. Fails if there is none. */
function collectSkill(harness: Harness, skill: SkillId): void {
  const relic = currentRelics().find((entry) => entry.skill === skill);
  expect(relic, `no relic carrying ${skill}`).toBeDefined();
  send(harness, COLLECT_MESSAGE, { id: relic?.id });
}

function tickFor(harness: Harness, seconds: number): void {
  const ticks = Math.round(seconds / TICK_DT);
  for (let n = 0; n < ticks; n++) harness.host.tick(TICK_DT);
}

describe('relics plugin', () => {
  let harness: Harness;

  afterEach(() => {
    // The bridge's loader is module state; a test that swapped it must not
    // leak that into the next file to import this module.
    resetManaBridge();
    vi.restoreAllMocks();
  });

  describe('spawning', () => {
    beforeEach(() => {
      harness = boot();
    });

    it('loads in the interceptor order discovery would produce', () => {
      expect(harness.host.pluginNames).toEqual(['mana', 'relics']);
    });

    it('spawns one relic per skill, on unlocked cells', () => {
      const relics = currentRelics();
      expect(relics).toHaveLength(RELIC_COUNT);
      expect(relics.map((relic) => relic.skill).sort()).toEqual([...SKILL_IDS].sort());

      for (const relic of relics) {
        expect(harness.world.isCellUnlocked(relic.x, relic.y)).toBe(true);
      }
    });

    it('gives every relic a distinct id and cell', () => {
      const relics = currentRelics();
      expect(new Set(relics.map((relic) => relic.id)).size).toBe(relics.length);
      expect(new Set(relics.map((relic) => `${relic.x},${relic.y}`)).size).toBe(relics.length);
    });

    it('broadcasts the list at world create and sends it to a joining player', () => {
      expect(harness.sink.ofType(`relics:${RELICS_MESSAGE}`).length).toBeGreaterThan(0);

      const targeted = harness.sink
        .ofType(`relics:${RELICS_MESSAGE}`)
        .filter((message) => message.target === PLAYER.id);
      expect(targeted).toHaveLength(1);
      expect((targeted[0].payload as { relics: unknown[] }).relics).toHaveLength(RELIC_COUNT);
    });

    it('re-broadcasts on the keepalive cadence, and not before', () => {
      harness.sink.clear();

      tickFor(harness, RELIC_KEEPALIVE_S - TICK_DT);
      expect(harness.sink.ofType(`relics:${RELICS_MESSAGE}`)).toHaveLength(0);

      // Two ticks, not one: the accumulator is a sum of floating-point tick
      // periods, so 150 × 0.1 is 14.999…, a hair under the threshold. The
      // keepalive therefore lands on the first tick at or after the interval —
      // which is the contract worth asserting. Chasing exactness here would
      // mean counting ticks instead of seconds, and that would break the moment
      // a self-hoster changed TICK_HZ.
      tickFor(harness, TICK_DT * 2);
      expect(harness.sink.ofType(`relics:${RELICS_MESSAGE}`).length).toBeGreaterThan(0);
    });

    it('retries a spawn that found nowhere to go, instead of losing the skill', () => {
      // A world with a single unlocked chunk cannot hold five relics comfortably;
      // one with almost nothing unlocked cannot hold any. The skills that failed
      // to place must still be pending, or they would leave the game forever.
      resetManaState();
      resetRelicsState();
      resetManaBridge();

      const crampedWorld = worldWithUnlockedChunks(WORLD_SIZE, []);
      crampedWorld.setSink(new RecordingSink());
      const crampedHost = new PluginHost(
        crampedWorld,
        [manaPlugin, relicsPlugin].map(asLoadedPlugin),
      );
      crampedHost.worldCreate();

      // Nothing could be placed: every chunk is locked.
      expect(currentRelics()).toHaveLength(0);

      // Unlock the world and let the retry timer come round.
      for (const [cx, cy] of unlockedChunksExcept(LOCKED_CHUNK)) crampedWorld.unlockChunk(cx, cy);
      for (let n = 0; n < Math.round(RELIC_SPAWN_RETRY_S / TICK_DT) + 1; n++) {
        crampedHost.tick(TICK_DT);
      }

      expect(currentRelics()).toHaveLength(RELIC_COUNT);
    });

    it('respawns a collected relic elsewhere after RELIC_RESPAWN_S', () => {
      const before = currentRelics().find((relic) => relic.skill === 'quake');
      collectSkill(harness, 'quake');
      expect(currentRelics().some((relic) => relic.skill === 'quake')).toBe(false);

      // One tick short of the timer: still gone.
      tickFor(harness, RELIC_RESPAWN_S - TICK_DT);
      expect(currentRelics().some((relic) => relic.skill === 'quake')).toBe(false);

      tickFor(harness, TICK_DT);
      const after = currentRelics().find((relic) => relic.skill === 'quake');
      expect(after).toBeDefined();
      // A fresh identity, so a client holding the old id cannot collect twice.
      expect(after?.id).not.toBe(before?.id);
    });
  });

  describe('collection', () => {
    beforeEach(() => {
      harness = boot();
    });

    it('grants the skill the relic carried and pushes the new list', () => {
      expect(skillsOf(PLAYER.id)).toEqual([]);
      harness.sink.clear();

      collectSkill(harness, 'titans-hand');

      expect(skillsOf(PLAYER.id)).toEqual(['titans-hand']);
      expect(currentRelics().some((relic) => relic.skill === 'titans-hand')).toBe(false);
      expect(harness.sink.ofType(`relics:${RELICS_MESSAGE}`).length).toBeGreaterThan(0);

      const pushed = harness.sink.ofType(`relics:${SKILLS_MESSAGE}`);
      expect(pushed[pushed.length - 1].target).toBe(PLAYER.id);
      expect(pushed[pushed.length - 1].payload).toEqual({
        skills: [{ id: 'titans-hand', kind: 'passive', cooldownS: 0, cooldownRemainingS: 0 }],
      });
    });

    it('rejects an unknown id, a stale id and a malformed payload', () => {
      const relic = currentRelics()[0];

      send(harness, COLLECT_MESSAGE, { id: 'r-nope' });
      send(harness, COLLECT_MESSAGE, {});
      send(harness, COLLECT_MESSAGE, null);
      send(harness, COLLECT_MESSAGE, { id: 42 });
      expect(skillsOf(PLAYER.id)).toEqual([]);
      expect(currentRelics()).toHaveLength(RELIC_COUNT);

      // First claim wins; the replay finds nothing and grants nothing.
      send(harness, COLLECT_MESSAGE, { id: relic.id });
      expect(skillsOf(PLAYER.id)).toEqual([relic.skill]);
      send(harness, COLLECT_MESSAGE, { id: relic.id });
      expect(skillsOf(PLAYER.id)).toEqual([relic.skill]);
      expect(currentRelics()).toHaveLength(RELIC_COUNT - 1);
    });

    it('drops a session’s skills entirely when its player leaves', () => {
      collectSkill(harness, 'titans-hand');
      expect(skillsOf(PLAYER.id)).toEqual(['titans-hand']);

      harness.world.removePlayer(PLAYER.id);
      harness.host.playerLeft(PLAYER);
      expect(skillsOf(PLAYER.id)).toEqual([]);
    });
  });

  describe("passive skill — Titan's Hand", () => {
    beforeEach(() => {
      harness = boot();
    });

    it('is inert for a player who does not hold it', () => {
      const verdict = harness.host.runIntent(
        { type: 'sculpt', x: TARGET_CELL.x, y: TARGET_CELL.y, radius: 2, dir: 1 },
        PLAYER,
      );
      expect(verdict).toEqual({ kind: 'allow' });
    });

    it('returns a modify verdict widening the brush by exactly the bonus', () => {
      collectSkill(harness, 'titans-hand');

      const verdict = harness.host.runIntent(
        { type: 'sculpt', x: TARGET_CELL.x, y: TARGET_CELL.y, radius: 2, dir: 1 },
        PLAYER,
      );
      expect(verdict).toEqual({
        kind: 'modify',
        intent: {
          type: 'sculpt',
          x: TARGET_CELL.x,
          y: TARGET_CELL.y,
          radius: 2 + TITANS_HAND_RADIUS_BONUS,
          dir: 1,
        },
      });
    });

    it('clamps at MAX_BRUSH_RADIUS instead of producing an invalid intent', () => {
      collectSkill(harness, 'titans-hand');

      // A widened radius 5 would fail the pipeline's re-validation of a modified
      // intent (step 4) and the whole sculpt would be silently dropped, so the
      // plugin must return no verdict at all here.
      const verdict = harness.host.runIntent(
        { type: 'sculpt', x: TARGET_CELL.x, y: TARGET_CELL.y, radius: MAX_BRUSH_RADIUS, dir: 1 },
        PLAYER,
      );
      expect(verdict).toEqual({ kind: 'allow' });
    });

    it('actually widens the applied edit, end to end through the pipeline', () => {
      const plain = handleSculptIntent(
        { world: harness.world, interceptors: harness.host },
        PLAYER,
        { type: 'sculpt', x: TARGET_CELL.x, y: TARGET_CELL.y, radius: 1, dir: 1 },
      );
      expect(plain.applied).toBe(true);
      const plainCells = plain.applied ? plain.diff.length : 0;

      collectSkill(harness, 'titans-hand');

      const widened = handleSculptIntent(
        { world: harness.world, interceptors: harness.host },
        PLAYER,
        { type: 'sculpt', x: TARGET_CELL.x + 20, y: TARGET_CELL.y, radius: 1, dir: 1 },
      );
      expect(widened.applied).toBe(true);
      if (!widened.applied) return;
      expect(widened.intent.radius).toBe(1 + TITANS_HAND_RADIUS_BONUS);
      expect(widened.diff.length).toBeGreaterThan(plainCells);
    });
  });

  describe('active skills — cast', () => {
    beforeEach(() => {
      harness = boot();
    });

    it('refuses a skill the player does not hold', () => {
      send(harness, CAST_MESSAGE, { skill: 'quake', x: TARGET_CELL.x, y: TARGET_CELL.y });

      const denials = harness.sink.ofType(`relics:${CAST_DENIED_MESSAGE}`);
      expect(denials).toHaveLength(1);
      expect(denials[0].payload).toEqual({ skill: 'quake', reason: CAST_DENIED_UNOWNED });
    });

    it('refuses a perk skill as if it were unowned — it is not castable', () => {
      collectSkill(harness, 'azure-heart');
      harness.sink.clear();

      send(harness, CAST_MESSAGE, { skill: 'azure-heart', x: TARGET_CELL.x, y: TARGET_CELL.y });
      expect(harness.sink.ofType(`relics:${CAST_DENIED_MESSAGE}`)[0].payload).toEqual({
        skill: 'azure-heart',
        reason: CAST_DENIED_UNOWNED,
      });
    });

    it('refuses a target in a locked chunk and leaves the terrain alone', () => {
      collectSkill(harness, 'quake');
      const before = harness.world.heightAt(LOCKED_CELL.x, LOCKED_CELL.y);
      harness.sink.clear();

      send(harness, CAST_MESSAGE, { skill: 'quake', x: LOCKED_CELL.x, y: LOCKED_CELL.y });

      expect(harness.sink.ofType(`relics:${CAST_DENIED_MESSAGE}`)[0].payload).toEqual({
        skill: 'quake',
        reason: CAST_DENIED_TARGET,
      });
      expect(harness.world.heightAt(LOCKED_CELL.x, LOCKED_CELL.y)).toBe(before);
      expect(cooldownOf(PLAYER.id, 'quake')).toBe(0);
    });

    it('drops a malformed cast without replying', () => {
      collectSkill(harness, 'quake');
      harness.sink.clear();

      send(harness, CAST_MESSAGE, { skill: 'quake', x: -1, y: 0 });
      send(harness, CAST_MESSAGE, { skill: 'quake', x: 1.5, y: 0 });
      send(harness, CAST_MESSAGE, { skill: 'not-a-skill', x: 0, y: 0 });
      send(harness, CAST_MESSAGE, 'nonsense');

      expect(harness.sink.ofType(`relics:${CAST_DENIED_MESSAGE}`)).toHaveLength(0);
      expect(cooldownOf(PLAYER.id, 'quake')).toBe(0);
    });

    it('Quake digs a crater far wider than one brush, and starts a cooldown', () => {
      collectSkill(harness, 'quake');
      const before = harness.world.heightAt(TARGET_CELL.x, TARGET_CELL.y);

      send(harness, CAST_MESSAGE, { skill: 'quake', x: TARGET_CELL.x, y: TARGET_CELL.y });

      const after = harness.world.heightAt(TARGET_CELL.x, TARGET_CELL.y);
      expect(after).toBeLessThan(before);
      // Several terrace bands down at the centre, even after relaxation has
      // pulled it back up toward its neighbours.
      expect(before - after).toBeGreaterThan(BAND_HEIGHT);

      // Wider than the MAX_BRUSH_RADIUS a single sculpt could reach: the
      // composed rim brushes sit MAX_BRUSH_RADIUS out, so cells beyond one
      // brush's footprint must have moved too.
      const rim = harness.world.heightAt(TARGET_CELL.x + MAX_BRUSH_RADIUS + 1, TARGET_CELL.y);
      expect(rim).toBeLessThan(before);

      expect(cooldownOf(PLAYER.id, 'quake')).toBeGreaterThan(0);
    });

    it('Genesis raises land where Quake lowers it', () => {
      collectSkill(harness, 'genesis');
      const before = harness.world.heightAt(TARGET_CELL.x, TARGET_CELL.y);

      send(harness, CAST_MESSAGE, { skill: 'genesis', x: TARGET_CELL.x, y: TARGET_CELL.y });

      expect(harness.world.heightAt(TARGET_CELL.x, TARGET_CELL.y)).toBeGreaterThan(before);
    });

    it('refuses a second cast until the tick-driven cooldown expires', () => {
      collectSkill(harness, 'quake');
      send(harness, CAST_MESSAGE, { skill: 'quake', x: TARGET_CELL.x, y: TARGET_CELL.y });

      const cooldown = cooldownOf(PLAYER.id, 'quake');
      expect(cooldown).toBe(QUAKE_CORE_DEPTH_BANDS * 5);

      const heightAfterFirst = harness.world.heightAt(TARGET_CELL.x, TARGET_CELL.y);
      harness.sink.clear();

      send(harness, CAST_MESSAGE, { skill: 'quake', x: TARGET_CELL.x, y: TARGET_CELL.y });
      expect(harness.sink.ofType(`relics:${CAST_DENIED_MESSAGE}`)[0].payload).toEqual({
        skill: 'quake',
        reason: CAST_DENIED_COOLDOWN,
      });
      expect(harness.world.heightAt(TARGET_CELL.x, TARGET_CELL.y)).toBe(heightAfterFirst);

      // Cooldowns are driven by the host's fixed tick, never by a client clock.
      tickFor(harness, cooldown);
      expect(cooldownOf(PLAYER.id, 'quake')).toBe(0);

      harness.sink.clear();
      send(harness, CAST_MESSAGE, { skill: 'quake', x: TARGET_CELL.x, y: TARGET_CELL.y });
      expect(harness.sink.ofType(`relics:${CAST_DENIED_MESSAGE}`)).toHaveLength(0);
      expect(harness.world.heightAt(TARGET_CELL.x, TARGET_CELL.y)).toBeLessThan(heightAfterFirst);
    });
  });

  describe('mana perks — the cross-plugin dependency', () => {
    it('halves the holder’s sculpt cost through mana’s perk API', async () => {
      harness = boot();
      await manaBridgeReady();
      expect(isManaAvailable()).toBe(true);
      // Since mana prices sculpts by displaced volume, the perk scales the RATE
      // (mana per band-cell) rather than a per-sculpt constant — so that is what
      // this bridge is asserted against.
      expect(manaPerBandCellFor(PLAYER.id)).toBe(MANA_PER_BAND_CELL);

      collectSkill(harness, 'azure-heart');

      expect(manaPerkOf(PLAYER.id).costMultiplier).toBe(AZURE_HEART_COST_MULTIPLIER);
      expect(manaPerBandCellFor(PLAYER.id)).toBe(
        MANA_PER_BAND_CELL * AZURE_HEART_COST_MULTIPLIER,
      );
    });

    it('doubles the holder’s regeneration', async () => {
      harness = boot();
      await manaBridgeReady();

      collectSkill(harness, 'spring-of-aether');
      expect(manaPerkOf(PLAYER.id).regenMultiplier).toBe(SPRING_OF_AETHER_REGEN_MULTIPLIER);
    });

    it('composes both perks multiplicatively', async () => {
      harness = boot();
      await manaBridgeReady();

      collectSkill(harness, 'azure-heart');
      collectSkill(harness, 'spring-of-aether');

      expect(manaPerkOf(PLAYER.id)).toEqual({
        costMultiplier: AZURE_HEART_COST_MULTIPLIER,
        regenMultiplier: SPRING_OF_AETHER_REGEN_MULTIPLIER,
      });
    });

    it('clears the perk when the player leaves', async () => {
      harness = boot();
      await manaBridgeReady();
      collectSkill(harness, 'azure-heart');
      expect(manaPerBandCellFor(PLAYER.id)).toBeLessThan(MANA_PER_BAND_CELL);

      harness.world.removePlayer(PLAYER.id);
      harness.host.playerLeft(PLAYER);

      expect(manaPerkOf(PLAYER.id)).toEqual({
        costMultiplier: NEUTRAL_MANA_MULTIPLIER,
        regenMultiplier: NEUTRAL_MANA_MULTIPLIER,
      });
      expect(manaPerBandCellFor(PLAYER.id)).toBe(MANA_PER_BAND_CELL);
    });

    it('buys the holder more sculpts, through the real intent pipeline', async () => {
      harness = boot();
      await manaBridgeReady();
      collectSkill(harness, 'azure-heart');

      // At half price the pool affords strictly more sculpts than a full pool
      // buys at the standard price. The sculpts below are radius-1 point stamps,
      // so the standard price is MANA_COST_PER_MIN_RADIUS_SCULPT.
      const standardSculpts = MANA_CAPACITY / MANA_COST_PER_MIN_RADIUS_SCULPT;
      let applied = 0;
      for (let n = 0; n < standardSculpts * 2; n++) {
        const outcome = handleSculptIntent(
          { world: harness.world, interceptors: harness.host },
          PLAYER,
          { type: 'sculpt', x: TARGET_CELL.x, y: TARGET_CELL.y, radius: 1, dir: 1 },
        );
        if (outcome.applied) applied++;
      }
      expect(applied).toBeGreaterThan(standardSculpts);
    });
  });

  describe('graceful degradation when mana is absent', () => {
    it('still collects perk relics, logs once, and changes no prices', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Exactly what Node throws when a self-hoster deletes plugins/mana.
      harness = boot({
        manaLoader: () => Promise.reject(new Error("Cannot find module '../../mana/server/index.ts'")),
      });
      await manaBridgeReady();

      expect(isManaAvailable()).toBe(false);

      collectSkill(harness, 'azure-heart');
      collectSkill(harness, 'spring-of-aether');

      // The skills are still granted and still shown — relics does not know or
      // care whether an economy exists to modify.
      expect(skillsOf(PLAYER.id)).toEqual(['azure-heart', 'spring-of-aether']);
      // …and mana (which is loaded in this process, just not reachable through
      // the bridge) was never told anything.
      expect(manaPerkOf(PLAYER.id)).toEqual({
        costMultiplier: NEUTRAL_MANA_MULTIPLIER,
        regenMultiplier: NEUTRAL_MANA_MULTIPLIER,
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(MANA_UNAVAILABLE_WARNING);
    });

    it('degrades the same way when the module loads but lacks the perk API', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // An older mana, or a fork: the folder is there, the API is not.
      harness = boot({ manaLoader: () => Promise.resolve({ plugin: { name: 'mana' } }) });
      await manaBridgeReady();

      expect(isManaAvailable()).toBe(false);
      collectSkill(harness, 'azure-heart');
      expect(skillsOf(PLAYER.id)).toEqual(['azure-heart']);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('replays perks granted before a slow mana import finished', async () => {
      // The load is started in onWorldCreate and deliberately not awaited, so a
      // relic collected in the first milliseconds of a world must not be lost.
      // Definite-assignment: the executor runs synchronously, so `release` is
      // assigned before the next statement, but TS cannot see that.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realMana = await import('../../mana/server/index.ts');

      harness = boot({ manaLoader: () => gate.then(() => realMana) });
      collectSkill(harness, 'azure-heart');
      // Still buffered: the import has not resolved.
      expect(isManaAvailable()).toBe(false);
      expect(manaPerBandCellFor(PLAYER.id)).toBe(MANA_PER_BAND_CELL);

      release();
      await manaBridgeReady();

      expect(isManaAvailable()).toBe(true);
      expect(manaPerBandCellFor(PLAYER.id)).toBe(
        MANA_PER_BAND_CELL * AZURE_HEART_COST_MULTIPLIER,
      );
    });
  });

  describe('persistence', () => {
    it('round-trips relic positions and respawn timers, but never skills', () => {
      harness = boot();
      collectSkill(harness, 'quake');
      tickFor(harness, 10);

      const before = currentRelics().map((relic) => ({ ...relic }));
      const remainingBefore = RELIC_RESPAWN_S - 10;
      const slices = harness.host.collectPersistence();
      expect(slices.relics).toBeDefined();

      // A fresh process: nothing survives except the snapshot.
      const restored = boot({ slices });

      expect(currentRelics()).toEqual(before);
      // Skills are player state with no stable identity to key them by, so they
      // are deliberately NOT in the slice (design §3.7).
      expect(skillsOf(PLAYER.id)).toEqual([]);

      // The respawn timer resumed where it left off rather than restarting.
      tickFor(restored, remainingBefore - TICK_DT);
      expect(currentRelics().some((relic) => relic.skill === 'quake')).toBe(false);
      tickFor(restored, TICK_DT);
      expect(currentRelics().some((relic) => relic.skill === 'quake')).toBe(true);
    });

    it('rebuilds a full set from a corrupt or unreadable slice', () => {
      for (const corrupt of [null, 'nonsense', { version: 999 }, { version: 1, relics: 'no' }]) {
        const booted = boot({ slices: { relics: corrupt } });
        expect(currentRelics()).toHaveLength(RELIC_COUNT);
        expect(booted.host.pluginNames).toEqual(['mana', 'relics']);
      }
    });

    it('drops persisted relics whose skill is no longer in the roster', () => {
      const slices = {
        relics: {
          version: 1,
          rngState: 1,
          nextSerial: 9,
          relics: [['r8', 20, 20, 'skill-from-the-future']],
          respawns: [],
        },
      };
      boot({ slices });

      // The unknown entry is discarded and the top-up refills the world.
      expect(currentRelics()).toHaveLength(RELIC_COUNT);
      expect(currentRelics().some((relic) => relic.id === 'r8')).toBe(false);
    });
  });
});
