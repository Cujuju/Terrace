// relics — the third example plugin, and the one that stresses the parts of the
// plugin API the first two left alone (design §3.5).
//
//   reveal : onWorldCreate + onTerrainChanged + persistence, no player identity
//   mana   : onWorldCreate + onPlayerJoin/Leave + onTick + onIntent (DENY)
//   relics : all of the above PLUS onIntent (MODIFY), client → server messages,
//            WorldApi.sculpt as a game verb, a client half with its own scene
//            layer and HUD panel, and a dependency on ANOTHER PLUGIN.
//
// THE MECHANIC. Relics sit in the world as floating gems. Clicking one collects
// it and grants the skill it carries. Skills come in three categories, and each
// category exists to prove a different reach of the plugin API:
//
//   passive (Titan's Hand)       — rewrites the holder's sculpt intents through
//                                  the interceptor chain's `modify` verdict.
//   active  (Quake, Genesis)     — a HUD button, then a targeting click, then
//                                  composed WorldApi.sculpt calls.
//   perk    (Azure Heart,        — reaches into the mana plugin's exported perk
//            Spring of Aether)     API, optionally, over a dynamic import.
//
// ────────────────────────────────────────────────────────────────────────────
// TWO IDENTITY DECISIONS, BOTH FORCED BY §3.7 (accounts are deferred).
//
// 1. A CLICK IS THE CLAIM. Players have no position — `Player` is { id, name }
//    and core tracks nothing else — so the server cannot check that a collector
//    was anywhere near the relic they collected. Rather than invent a position
//    core does not have (and would then have to sync and validate), collection
//    is validated on the RELIC: does this id exist right now? First message
//    wins, the relic is removed, every later message for that id is rejected as
//    stale. That is honest about what the server actually knows, and it is not
//    exploitable in a way that matters — a scripted client could collect a
//    relic it never rendered, which costs it nothing it could not have had by
//    orbiting the camera there.
//
// 2. SKILLS ARE PER-SESSION AND ARE NOT PERSISTED. Player.id is the Colyseus
//    sessionId — per connection, not per person. Persisting skills under it
//    would restore them to whoever the transport next hands that id to, which
//    is worse than losing them. So relic POSITIONS and RESPAWN TIMERS persist
//    (they are world state) and SKILLS do not (they are player state, and there
//    is no player to key them by). A reconnecting player finds the world's
//    relics exactly where they left them and re-earns their skills, which is
//    the friendlier of the two wrong answers — the same call mana made for its
//    balances. The gap closes when the deferred auth plugin (§3.7) supplies a
//    stable identity; at that point `sessionKeyFor` below becomes the one line
//    to change, and skills gain a persistence slice.
// ────────────────────────────────────────────────────────────────────────────

import {
  BAND_HEIGHT,
  MAX_BRUSH_RADIUS,
  WORLD_UNIT_CELLS,
  cellsAcross,
  type SculptIntent,
} from '@terrace/shared';
// Type-only import of the plugin contract (erased at runtime), reaching into
// server/src exactly as mana and reveal do — core publishes no plugin-API entry
// point yet.
import type {
  IntentCtx,
  IntentVerdict,
  PersistenceSlice,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
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

// ────────────────────────────────────────────────────────────────────────────
// Tuning constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * How many relics exist at once: exactly one per skill.
 *
 * Derived from the roster rather than picked, because the alternative is a
 * player who wants Genesis waiting on a dice roll for it to be the one that
 * spawned. One of each means every skill is always obtainable by someone, the
 * cycle below can be a simple round robin, and adding a skill to the roster
 * automatically adds its relic instead of quietly making the pool more diluted.
 */
export const RELIC_COUNT = SKILL_IDS.length;

/**
 * Seconds between a relic being collected and the same skill's relic returning,
 * somewhere else.
 *
 * 45 s is roughly one tour of a small world at the default camera distance: long
 * enough that collecting is an event rather than a treadmill, short enough that
 * a player who missed one is not locked out of that skill for a session. It is
 * also comfortably longer than the longest active cooldown (30 s), so a relic
 * respawning can never be the thing gating a player's next cast.
 */
export const RELIC_RESPAWN_S = 45;

/**
 * Seconds between unsolicited re-broadcasts of the relic list.
 *
 * The list is pushed on every change and to every joining player, so this is
 * purely a repair cadence: it is what un-sticks a client that dropped a message
 * (Colyseus messages are ordered but a reconnect can straddle one) without
 * making a per-client resync protocol for five items of data. 15 s is three
 * beats per respawn cycle — fast enough that a wrong list is never on screen
 * long, slow enough to be free (five relics is a few hundred bytes).
 */
export const RELIC_KEEPALIVE_S = 15;

/**
 * Seconds before retrying a spawn that found nowhere to go.
 *
 * Placement is bounded rejection sampling (server/spawn.ts) and CAN come back
 * empty — a world whose unlocked region is tiny and already crowded. Without a
 * retry that skill would silently leave the game forever, which is the kind of
 * bug a self-hoster would notice only weeks later. Short compared to
 * RELIC_RESPAWN_S because the condition that caused the failure is transient:
 * one chunk unlocking, or one relic being collected, changes the answer.
 */
export const RELIC_SPAWN_RETRY_S = 5;

/**
 * Extra brush radius Titan's Hand grants, before clamping to MAX_BRUSH_RADIUS.
 *
 * ONE WORLD UNIT of extra reach, converted. The brush range is [1 cell, 4
 * world units], so this is a quarter of the whole range at the top end and a
 * multiplying of area at the bottom — a passive that is felt at every brush
 * size without any of them becoming the obvious choice.
 *
 * Stated in world units because a brush's reach is a distance across the
 * ground: left at one CELL through the 2026-08-21 re-sample, the game's one
 * reach passive would have granted a quarter of the ground it used to and read
 * as doing nothing at the top end.
 */
export const TITANS_HAND_RADIUS_BONUS = cellsAcross(1);

/**
 * Seconds of cooldown an active skill earns per terrace band it moves at its
 * centre. Cooldowns are PRICED, not picked per skill, so a skill added later
 * cannot accidentally be free, and so making a cast stronger automatically
 * makes it rarer.
 *
 * 5 s/band is calibrated against hand sculpting: under mana's volume pricing
 * (2026-08-14) the default regen sustains a point stamp — one band at one
 * cell — every ~0.3 s, and larger brushes proportionally slower. At 5 s/band
 * a cast remains several times SLOWER per band
 * than the hand it supplements, which is the intended relationship: relic casts
 * buy you reach and shape (a 15-cell crater no brush can draw), never
 * throughput. The number is written here rather than imported from mana because
 * relics must build and run with plugins/mana deleted.
 */
export const COOLDOWN_S_PER_CENTRE_BAND = 5;

/**
 * Cooldown, in seconds, for each active skill — DERIVED from that skill's own
 * terraform rather than listed, so the price and the effect cannot drift apart.
 * Skills with no terraform (passive, perk) are absent and read as zero.
 */
const COOLDOWN_BY_SKILL: ReadonlyMap<SkillId, number> = new Map<SkillId, number>(
  Array.from(TERRAFORM_BY_SKILL, ([id, steps]) => {
    // The centre step is the one at offset (0,0); the bands it moves are what
    // the price is computed from (see COOLDOWN_S_PER_CENTRE_BAND).
    const centre = steps.find((step) => step.dx === 0 && step.dy === 0);
    const bands = centre === undefined ? 0 : Math.abs(centre.amount) / BAND_HEIGHT;
    return [id, bands * COOLDOWN_S_PER_CENTRE_BAND] as const;
  }),
);

/** Schema version of this plugin's persistence slice. */
export const RELICS_SLICE_VERSION = 1;

// ────────────────────────────────────────────────────────────────────────────
// State
// ────────────────────────────────────────────────────────────────────────────

interface Relic {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly skill: SkillId;
}

/** A skill whose relic has been collected and is waiting to come back. */
interface PendingRespawn {
  readonly skill: SkillId;
  remainingS: number;
}

/** Persisted shape. World state only — never player state (see the header). */
interface RelicsSlice {
  readonly version: number;
  readonly rngState: number;
  readonly nextSerial: number;
  readonly relics: ReadonlyArray<readonly [string, number, number, string]>;
  readonly respawns: ReadonlyArray<readonly [string, number]>;
}

let relics: Relic[] = [];
let respawns: PendingRespawn[] = [];

/** Monotonic relic id counter. Ids are never reused, so a stale id stays stale. */
let nextSerial = 1;

let rng: RelicRng = createRelicRng(RELIC_RNG_DEFAULT_SEED);

/** Skills held, by session id. See identity decision 2 in the header. */
const skillsBySession = new Map<string, Set<SkillId>>();

/** Remaining cooldown seconds, by session id then skill. Absent = ready. */
const cooldownsBySession = new Map<string, Map<SkillId, number>>();

/** Seconds since the last keepalive broadcast. */
let sinceKeepaliveS = 0;

// ────────────────────────────────────────────────────────────────────────────
// Wire helpers
// ────────────────────────────────────────────────────────────────────────────

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

  // Emitted in roster order, not collection order, so the HUD list does not
  // reshuffle itself every time a player picks something up.
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

// ────────────────────────────────────────────────────────────────────────────
// Spawning
// ────────────────────────────────────────────────────────────────────────────

/**
 * Alternates land and shore by serial so a world's relics are visibly spread
 * across both, without needing to look at what is already out there.
 */
function preferredTerrainFor(serial: number): TerrainClass {
  return serial % 2 === 0 ? 'shore' : 'land';
}

function occupiedCells(size: number): Set<number> {
  return new Set(relics.map((relic) => relic.y * size + relic.x));
}

/**
 * Places one relic carrying `skill`. Returns false when the search found no
 * suitable cell.
 */
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

/**
 * Tops the world up to RELIC_COUNT: one relic per skill that is neither out in
 * the world nor already waiting on a timer. Returns true if anything spawned.
 *
 * This is the single place relics come into existence — first boot, restore
 * from a snapshot that predates a newly-added skill, and every respawn all
 * funnel through it, so "one of each, always" is enforced in one readable loop
 * rather than being an invariant three call sites have to remember.
 *
 * A skill whose spawn FAILS is re-armed on a short retry timer rather than
 * dropped. That closes the failure mode this shape would otherwise have: the
 * caller removes a due entry from `respawns` before calling, so a silent
 * failure here would leave the skill in neither list and it would never be
 * looked at again.
 */
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

// ────────────────────────────────────────────────────────────────────────────
// Skills
// ────────────────────────────────────────────────────────────────────────────

/**
 * Recomputes and pushes this session's total mana perk.
 *
 * Called after every grant, unconditionally, even for a session holding no perk
 * skills — composeManaPerk returns neutral for those, and an unconditional push
 * is one fewer branch that can be forgotten when a skill is added. If the mana
 * plugin is absent this is a buffered no-op (see mana-bridge.ts).
 */
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

/**
 * Advances every cooldown by one tick and reports which sessions need a fresh
 * skill push.
 *
 * A session is pushed when the WHOLE-SECOND value of one of its cooldowns
 * changes, not on every tick — the same throttle mana uses for whole mana units,
 * and for the same reason: a 10 Hz tick would otherwise send ten identical-
 * looking messages a second to redraw a number that only moves once.
 */
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

// ────────────────────────────────────────────────────────────────────────────
// Message handlers — UNTRUSTED CLIENT INPUT
// ────────────────────────────────────────────────────────────────────────────

/**
 * COLLECT — CRITICAL VALIDATION PATH.
 *
 * The entire authority check is "does this relic id exist right now", for the
 * reason set out in identity decision 1 at the top of this file: core gives
 * players no position, so there is nothing else the server could truthfully
 * check. Every other outcome — a malformed payload, an id from a relic someone
 * else already took, an id that never existed, a replay of the same message —
 * lands on the same silent rejection, because they are indistinguishable from
 * a client whose relic list is a few hundred milliseconds stale, which is a
 * completely normal thing to be.
 *
 * The relic is removed BEFORE anything is granted, so a duplicate message that
 * arrives in the same tick finds nothing and grants nothing.
 */
// `world` is used only to push the grant and the corrected relic list, not to
// touch terrain: collection has no sculpt of its own.
function handleCollect(world: WorldApi, player: Player, payload: unknown): void {
  const message = parseCollectPayload(payload);
  if (message === null) return;

  const index = relics.findIndex((relic) => relic.id === message.id);
  if (index === -1) {
    // Stale or unknown id. Silent: telling the client would only confirm which
    // ids have already been taken, and it has no action to take either way —
    // the corrected list is already on its way from the removal below.
    return;
  }

  const [taken] = relics.splice(index, 1);
  respawns.push({ skill: taken.skill, remainingS: RELIC_RESPAWN_S });

  grantSkill(world, player.id, taken.skill);
  broadcastRelics(world);

  // THE CHRONICLE'S EAR (2026-08-19): a collection is a player's own act and
  // rare by construction, so every one is a world event. The display label
  // travels WITH the event — the emitter owns its skill names, and a consumer
  // must not need this plugin's roster to print one.
  world.emitEvent('collected', {
    skill: taken.skill,
    label: skillInfo(taken.skill).name,
    player: player.name,
    x: taken.x,
    y: taken.y,
  });
}

/**
 * CAST — CRITICAL VALIDATION PATH.
 *
 * Four gates, in this order, each one refusing with its own reason so the HUD
 * can say something true:
 *
 *   1. STRUCTURE  — parseCastPayload: a roster skill id, and integer x/y inside
 *                   the world. Bounds are checked HERE because the shared brush
 *                   throws on an out-of-bounds centre rather than clamping.
 *   2. OWNERSHIP  — the player holds that skill, and it is one with a terraform
 *                   (a passive or perk skill is not castable).
 *   3. COOLDOWN   — driven by the server tick, never by the client's clock.
 *   4. MASK       — the target cell's chunk must be unlocked, the same rule the
 *                   core intent pipeline applies to a brush centre. Without it a
 *                   relic holder could reshape and thereby probe terrain the
 *                   mask exists to hide.
 *
 * Only then does the terraform run, and only then does the cooldown start — a
 * refused cast must never cost the player anything.
 */
function handleCast(world: WorldApi, player: Player, payload: unknown): void {
  const message = parseCastPayload(payload, world.worldSize);
  if (message === null) {
    // Nothing trustworthy to name in the reply; a well-behaved client cannot
    // produce this, so it is dropped rather than answered.
    return;
  }

  const { skill, x, y } = message;

  const held = skillsBySession.get(player.id);
  const steps = TERRAFORM_BY_SKILL.get(skill);
  if (held === undefined || !held.has(skill) || steps === undefined) {
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

  applyTerraform(world, x, y, steps);
  startCooldown(player.id, skill);
  sendSkills(world, player.id);
}

// ────────────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────────────

/**
 * Reads back a persisted slice defensively, exactly as reveal does: the data is
 * this server's own SQLite row, but a truncated or hand-edited one must degrade
 * to "no relics recorded" — from which onWorldCreate's top-up immediately
 * rebuilds a full set — rather than crash a world on boot.
 *
 * Every entry is re-validated, not trusted: an unknown skill id (a relic saved
 * by a build whose roster has since changed) is dropped, and the top-up spawns
 * a fresh relic for whatever skill is now missing.
 */
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
      // A timer restored longer than the configured respawn (a snapshot taken
      // under a previous, slower setting) is capped rather than honoured.
      respawns.push({ skill, remainingS: Math.min(Math.max(remainingS, 0), RELIC_RESPAWN_S) });
    }
  }

  // Restore the one-per-skill invariant that topUpRelics depends on. Our own
  // writer cannot produce a duplicate, but a hand-edited row can, and a skill
  // that appeared twice would leave the world permanently over-stocked.
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
    // A skill cannot be both out in the world and waiting to come back.
    if (claimed.has(entry.skill)) continue;
    claimed.add(entry.skill);
    uniqueRespawns.push(entry);
  }
  respawns = uniqueRespawns;
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
  load(data: unknown): void {
    loadSlice(data);
  },
};

// ────────────────────────────────────────────────────────────────────────────
// The plugin
// ────────────────────────────────────────────────────────────────────────────

export const plugin: TerracePlugin = {
  name: 'relics',

  onWorldCreate(world: WorldApi): void {
    // CROSS-PLUGIN DEPENDENCY (see mana-bridge.ts for the full pattern). Kicked
    // off, deliberately not awaited: every plugin hook is synchronous, and a
    // perk granted before the import settles is buffered and replayed by the
    // bridge. A missing mana plugin resolves this promise just the same.
    void loadManaBridge();

    // Persistence has already been restored by the host at this point
    // (server/src/index.ts: restorePersistence, then worldCreate), so this both
    // fills a fresh world and tops up a restored one.
    topUpRelics(world);
    broadcastRelics(world);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    // The room sends the core join snapshot before this hook, so the client is
    // already sized and listening. Relics are pushed directly rather than being
    // left to the keepalive: a player should never see an empty world for up to
    // RELIC_KEEPALIVE_S seconds.
    world.sendTo(player.id, RELICS_MESSAGE, { relics: relicViews() });
    // An empty skill list, on purpose: it tells a reconnecting client to clear
    // whatever its HUD was showing before, which is the truth (see identity
    // decision 2 — skills do not survive a connection).
    sendSkills(world, player.id);
  },

  onPlayerLeave(_world: WorldApi, player: Player): void {
    skillsBySession.delete(player.id);
    cooldownsBySession.delete(player.id);
    // Unconditional: revoking a perk the player never had is a no-op, and one
    // unconditional call cannot forget a case the way a guarded one can. mana
    // also clears its own perk on leave — belt and suspenders across a plugin
    // boundary, where the two halves can be at different versions.
    revokeManaPerk(player.id);
  },

  onTick(world: WorldApi, dt: number): void {
    advanceCooldowns(world, dt);

    // Respawn timers. Entries that come due are removed first, then handed to
    // the top-up, so a spawn that fails to find a cell simply leaves that skill
    // missing and is retried on the next tick rather than re-arming a full
    // RELIC_RESPAWN_S wait.
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

  /**
   * PASSIVE SKILL — Titan's Hand, via the interceptor chain's `modify` verdict.
   *
   * Returns nothing (treated as allow) for players without the skill and for
   * brushes already at MAX_BRUSH_RADIUS: an unchanged `modify` would still make
   * core re-validate the intent (pipeline step 4) for no reason, and would make
   * every holder's every stroke look modified in a log.
   *
   * ── KNOWN, ACCEPTED TRADEOFF: THE PREDICTION SHIMMER ───────────────────────
   * The client predicts the intent it SENT (client/src/terrain/prediction.ts),
   * so a holder's local view shows a radius-N edit while the server applies
   * radius-N+1. The server's diff then cannot match the prediction, the
   * prediction is not recognised as acknowledged (`isConfirmed`), and the
   * client draws its own smaller edit on top of the server's larger one until
   * PREDICTION_TTL_MS (1 s) retires it — the "MODIFIED INTENT" residual already
   * documented in that module. Visually: about a second of doubled edit at the
   * brush, per stroke, then it settles onto the server's version.
   *
   * ── LOAD-ORDER CONSEQUENCE, UPDATED BY ISSUE #19 ──────────────────────────
   * Discovery sorts directories, so the verdict-phase chain is still
   * mana → relics → reveal, and mana's own `onIntent` still only ever sees the
   * PRE-widened intent (nothing runs before mana to modify it). But mana no
   * longer charges during that pass — see mana's `checkAffordability` /
   * `commitCharge` split (server/src/plugins/types.ts documents the
   * onIntent / onIntentApplied contract this relies on). Charging now happens
   * in the EFFECT phase, once every interceptor has allowed, against the
   * EFFECTIVE intent core actually applied — which already includes this
   * widened radius. So Titan's Hand is NO LONGER free extra area: the wider
   * footprint is priced like any other radius, because the charge is taken
   * after the widening rather than before it. This was the "same gap mana
   * documents" the previous version of this comment named as the fix that
   * would close it; issue #19 is that fix.
   *
   * THIS IS NOT FIXED CLIENT-SIDE, on purpose. Teaching the client to predict
   * the modification would mean the client knowing this plugin's rules — which
   * skills a player holds, what each does to an intent — and re-implementing
   * them in sync with the server. That is the exact coupling the intent model
   * exists to prevent, and it would break the moment a third-party plugin added
   * its own modifier. The real fix is core-side and is the same one the
   * prediction module already names: a correlation id on the intent, echoed on
   * the diff that applied it, so a client can recognise its own edit whatever
   * the server did to it. Until then, this shimmer is the price of `modify`
   * being available to plugins at all, and it is a fair one.
   */
  onIntent(intent: SculptIntent, ctx: IntentCtx): IntentVerdict | void {
    const held = skillsBySession.get(ctx.player.id);
    if (held === undefined || !held.has('titans-hand')) return;

    // Clamped to the shared cap: the brush math throws outside [1, 4], and the
    // pipeline re-validates a modified intent against the same bound, so an
    // unclamped +1 would turn every radius-4 stroke into a silent rejection.
    const radius = Math.min(intent.radius + TITANS_HAND_RADIUS_BONUS, MAX_BRUSH_RADIUS);
    if (radius === intent.radius) return;

    return { kind: 'modify', intent: { ...intent, radius } };
  },

  messages: {
    [COLLECT_MESSAGE]: handleCollect,
    [CAST_MESSAGE]: handleCast,
  },

  persistence,
};

// ────────────────────────────────────────────────────────────────────────────
// Test seams
// ────────────────────────────────────────────────────────────────────────────

/** The relics currently in the world, in spawn order. */
export function currentRelics(): readonly RelicView[] {
  return relicViews();
}

/** The skills a session holds, in roster order. */
export function skillsOf(sessionId: string): readonly SkillId[] {
  return skillViews(sessionId).map((view) => view.id);
}

/** Remaining cooldown seconds for one session's skill (0 when ready). */
export function cooldownOf(sessionId: string, skill: SkillId): number {
  return cooldownRemaining(sessionId, skill);
}

/** Drops all accumulated state so a suite can start from zero. */
export function resetRelicsState(): void {
  relics = [];
  respawns = [];
  nextSerial = 1;
  rng = createRelicRng(RELIC_RNG_DEFAULT_SEED);
  skillsBySession.clear();
  cooldownsBySession.clear();
  sinceKeepaliveS = 0;
}
