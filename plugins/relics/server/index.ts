// relics — the third example plugin, and the one that stresses the parts of the
// plugin API the first two left alone (design doc).
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
//   passive (Bedrock Ward)       — denies OTHER players' sculpt intents over
//                                  ground the holder just shaped (ward.ts).
//                                  The interceptor chain's `deny` verdict; the
//                                  only skill that is about the people in the
//                                  world rather than about the ground.
//
// TITAN'S HAND IS GONE (owner, 2026-09-05: a wider brush trades away the aim
// the player has learned, which is a downgrade dressed as a reward). It was
// this plugin's one user of the chain's `modify` verdict — see onIntent.
//   active  (Quake, Genesis,     — a HUD button, then a targeting click, then
//            Bulwark, Landslide)   composed WorldApi.sculpt calls. Landslide
//                                  READS the ground first (terraform.ts,
//                                  TerraformSpec.plan) and refuses where there
//                                  is no cliff to topple.
//   perk    (Azure Heart,        — reaches into the mana plugin's exported perk
//            Spring of Aether)     API, optionally, over a dynamic import.
//
// ────────────────────────────────────────────────────────────────────────────
// TWO IDENTITY DECISIONS, BOTH FORCED BY THE DESIGN (accounts are deferred).
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
//    balances. The gap closes when the deferred auth plugin supplies a
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

// ────────────────────────────────────────────────────────────────────────────
// Tuning constants
// ────────────────────────────────────────────────────────────────────────────

// RELIC_COUNT MOVED TO ../protocol.ts (2026-08-29): it is the cap the CLIENT
// half's draw budget is written against — one gem mesh per relic, part B of
// docs/plans/frame-budget-growth-and-draw-calls.md — and a client half may not
// import a plugin's server half. It was already derived from SKILL_IDS, which
// lives there. Re-exported here so every importer keeps working.
import { RELIC_COUNT } from '../protocol.ts';
export { RELIC_COUNT };

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
 * Seconds of cooldown an active skill earns per terrace band its strongest
 * step moves. Cooldowns are PRICED, not picked per skill, so a skill added later
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
export const COOLDOWN_S_PER_PEAK_BAND = 5;

/**
 * Cooldown, in seconds, for each active skill — DERIVED from that skill's own
 * terraform rather than listed, so the price and the effect cannot drift apart.
 * Skills with no terraform (passive, perk) are absent and read as zero.
 */
const COOLDOWN_BY_SKILL: ReadonlyMap<SkillId, number> = new Map<SkillId, number>(
  Array.from(TERRAFORM_BY_SKILL, ([id, spec]) => [
    id,
    spec.peakBands * COOLDOWN_S_PER_PEAK_BAND,
  ]),
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

/**
 * Whether a brush at (x, y) is refused by someone else's Bedrock Ward, telling
 * the actor so at most once a second.
 *
 * THE ONE PREDICATE BOTH WRITE PATHS ASK. A sculpt intent runs the interceptor
 * chain and a relic cast does not, so the rule cannot live in `onIntent` — it
 * would be enforced against hands and ignored by relics, which is the exact
 * hole a ward exists to close.
 */
function wardRefuses(
  world: WorldApi,
  sessionId: string,
  x: number,
  y: number,
  radius: number,
): boolean {
  if (wardHolderAgainst(world.worldSize, sessionId, x, y, radius) === null) return false;
  // The notice rides this plugin's own `denied` channel because core's nack for
  // a plugin-denied intent carries only the sequence number — a plugin that
  // wants the player told why has to say it itself (intent/pipeline.ts).
  if (claimWardNotice(sessionId)) {
    denyCast(world, sessionId, 'bedrock-ward', CAST_DENIED_WARDED);
  }
  return true;
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
 * Six gates, in this order, each one refusing with its own reason so the HUD
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
 *   5. SHAPE      — the cast must plan at least one step. Only a skill that
 *                   reads the ground can fail this (Landslide with no cliff
 *                   under the cursor); a fixed shape always plans.
 *   6. WARD       — no step of the cast may land on ground another player's
 *                   Bedrock Ward holds. This gate is HERE and not in the
 *                   interceptor chain because a cast never runs that chain.
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

  // GATE 5 — SHAPE. A cast that plans itself against the terrain can find
  // nothing to do there (Landslide on flat ground). That is the player aiming
  // badly, not the world refusing them, so it is its own reason and — like
  // every other refusal above — it costs no cooldown.
  const steps = spec.plan(world, x, y);
  if (steps.length === 0) {
    denyCast(world, player.id, skill, CAST_DENIED_UNSUITABLE);
    return;
  }

  // GATE 6 — WARD. Checked over every step's own footprint, not just the
  // target: a Bulwark's ring touches ground its centre never does, so a
  // centre-only check would let a cast wall in land another player holds.
  for (const step of steps) {
    if (wardRefuses(world, player.id, x + step.dx, y + step.dy, step.radius)) return;
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

/**
 * The version a stored blob SAYS it was written under, or undefined when it
 * says nothing.
 *
 * WHY THIS PLUGIN STILL READS ITS OWN FIELD (see PersistenceSlice.load). The
 * host's `{ v, data }` envelope is authoritative for everything written since
 * it existed — but every byte written BEFORE it carries no envelope and reaches
 * `load` as version 1, and this plugin's own format was already past that.
 * Trusting the host's 1 over this field would run a version-1 migration over a
 * version-1 slice on the first boot after the envelope landed, which is the
 * one way this contract can destroy a world.
 */
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
    // REFUSE, DO NOT ERASE, relics from a newer build: loadSlice answers an
    // unknown version by keeping nothing — relics and the relic RNG both gone
    // one snapshot later. The host parks it instead.
    if ((selfDescribedSliceVersion(data) ?? fromVersion) > RELICS_SLICE_VERSION) {
      return 'refuse';
    }
    loadSlice(data);
    return undefined;
  },
};

// ────────────────────────────────────────────────────────────────────────────
// The plugin
// ────────────────────────────────────────────────────────────────────────────

export const plugin: TerracePlugin = {
  name: 'relics',

  onWorldCreate(world: WorldApi): void {
    // CROSS-PLUGIN DEPENDENCY (see mana-bridge.ts for the full pattern). One
    // synchronous question to the host: is a mana running in this world? A perk
    // granted while none is stays buffered in the bridge and is replayed to the
    // mana of a later session. A missing mana plugin and one the operator
    // disabled here are the same answer.
    loadManaBridge(world);

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
    // A ward outliving its holder's connection would refuse everyone else on
    // behalf of nobody, and could be inherited by whoever the transport hands
    // that session id to next — the same reason skills do not survive either.
    dropWardsOf(player.id);
  },

  onTick(world: WorldApi, dt: number): void {
    advanceCooldowns(world, dt);
    sweepWards(dt);

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
   * PASSIVE SKILL — Bedrock Ward, via the interceptor chain's `deny` verdict.
   *
   * Returns nothing (treated as allow) for a stroke on free ground or on the
   * sculptor's own, which is every stroke in a single-player world: the ward
   * map is empty until somebody holds the skill and works some ground.
   *
   * THE VERDICT IS ONLY HALF THE ENFORCEMENT. A relic cast never reaches this
   * hook (handleCast → applyTerraform → WorldApi.sculpt), so the same
   * predicate is asked there as gate 6. See ward.ts's header for why that is
   * the whole point rather than a detail.
   *
   * THE CHAIN'S `modify` VERDICT IS NO LONGER USED BY ANY PLUGIN. Titan's Hand
   * was the only one, and removing it (owner, 2026-09-05) also retires the
   * prediction shimmer this comment used to document: nothing now rewrites a
   * player's intent behind their client's back, so a prediction that is not
   * denied always matches what the server applied.
   */
  onIntent(intent: SculptIntent, ctx: IntentCtx): IntentVerdict | void {
    if (wardRefuses(ctx.world, ctx.player.id, intent.x, intent.y, intent.radius)) {
      return { kind: 'deny', reason: CAST_DENIED_WARDED };
    }
  },

  /**
   * EFFECT PHASE — where a Bedrock Ward is laid down.
   *
   * Here rather than in onIntent because this hook is the one that fires only
   * for intents that were actually APPLIED: a stroke refused further down the
   * chain (no mana, another player's ward) must not leave its sculptor holding
   * ground they never moved.
   *
   * The intent handed over is the one core applied, so the ward covers exactly
   * the footprint the player's stroke actually moved.
   */
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
  resetWards();
  sinceKeepaliveS = 0;
}
