// The plugin contract (design §3.5). Core is terrain sim + sync + persistence +
// this host; everything "gamey" lives behind these types.
//
// The acceptance test for this file is the design's own: reveal-of-territory, a
// mana economy, and a follower stub must each be buildable WITHOUT touching
// core. That is why onIntent is an interceptor chain (a mana plugin vetoes or
// rewrites intents instead of patching the sim) and why plugins get namespaced
// messages plus their own persistence slice.

import type { CellDiff, FreshwaterMap, RiverNetwork, SculptIntent } from '@terrace/shared';
import type { Player } from '../player.ts';

export type { Player };

/**
 * The surface a plugin gets on the world. Deliberately narrow: read heights and
 * the mask, make edits that go through the same authoritative + filtered path
 * as player intents, unlock chunks, and talk to clients. There is no way to
 * write a raw height — plugins cannot bypass the gradient relaxation any more
 * than a client can.
 *
 * Every instance is bound to one plugin: `broadcast`/`sendTo` namespace the
 * message type with that plugin's name, so two plugins cannot collide on a wire
 * name and no plugin can forge a core message.
 */
export interface WorldApi {
  /** Cells per world edge. */
  readonly worldSize: number;
  /** Chunks per world edge. */
  readonly chunksPerEdge: number;

  /**
   * This world's difficulty rating: an integer in [1, 100] where 1 =
   * warm/forgiving and 100 = punishing. Set per deployment (WORLD_DIFFICULTY)
   * and constant for the life of the world.
   *
   * CORE ATTACHES NO MECHANICS TO IT — PLUGINS INTERPRET IT. Core neither reads
   * this number in any simulation path nor has an opinion about what a "hard"
   * world does; it publishes one neutral dial and each plugin decides what its
   * own mechanic makes of it (decided 2026-08-14 — see docs/DESIGN.md). mana is
   * the first consumer: it interpolates its default regen rate between two
   * anchors at difficulty 1 and 100. Monster aggression and relic counts are
   * expected to read the SAME scalar and pick their own anchors, so a host turns
   * one dial and the whole installed set of plugins moves together.
   *
   * A consumer should treat the ends as the only fixed points and interpolate
   * between them, rather than switching on particular values: the scale is
   * continuous on purpose, and a plugin that only handles 1 and 100 leaves
   * ninety-eight settings undefined.
   */
  readonly difficulty: number;

  /**
   * How much simulated time this world has lived, in MILLISECONDS — the world
   * clock, and the only one a plugin should keep.
   *
   * READ IT THROUGH shared/src/calendar.ts rather than dividing it by hand:
   * `dayOfSimMillis` turns it into a world-day and `weekdayOf` names that day,
   * which is what makes "settlers arrive on Mondays" a rule two plugins can
   * agree on. A plugin that needs a cadence in seconds may of course keep its
   * own float accumulator for that (structures does, for its keepalive) — what
   * it must NOT do is derive a DAY from one, because a summed float drifts and
   * a drifting clock moves day boundaries.
   *
   * Persisted with the world, so it survives a restart. Before this existed
   * (2026-08-23) every plugin kept its own accumulator and only the chronicle
   * saved one, which is why the sky reset to dawn on every boot.
   */
  readonly simMillis: number;

  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
  isChunkUnlocked(cx: number, cy: number): boolean;

  /**
   * This world's current rivers, springs, pools and waterfalls (mechanics
   * cards 27 and 40) — a READ, exactly like `heightAt`: rivers are derived
   * terrain fact, not gameplay, so exposing them here puts nothing "gamey"
   * in core. Scoped to unlocked territory and cached behind a short throttle
   * server-side (see World.riverNetwork's doc comment); calling this more
   * than once in the same tick is free. The mana plugin is the first (and,
   * as of this writing, only) reader — its waterfall regen aura — following
   * the same "core publishes a neutral fact, a plugin decides what it means"
   * shape WorldApi.difficulty already established.
   */
  riverNetwork(): RiverNetwork;

  /**
   * The same rivers, transposed to a PER-CELL lookup — the shape
   * `shared/`'s traversal predicates ask for (`TerrainSampler.freshwater` in
   * shared/src/traversal.ts).
   *
   * A PROPERTY, NOT A METHOD, and named to match `TerrainSampler` exactly:
   * that is what lets a plugin's own narrow world interface be handed
   * straight to `isWalkableCell` / `canTraverseSegment` with no adapter
   * object built per call — the same structural-typing trick `worldSize` and
   * `heightAt` already rely on. Backed by `World.freshwaterMap()`, which
   * caches against `riverNetwork()`'s identity, so reading it every A*
   * expansion costs one property access and one Set lookup.
   *
   * BOTH SURFACES STAY. `riverNetwork()` answers "where do the rivers GO"
   * (mana's waterfall aura, the renderer's ribbons); this answers "what is in
   * THIS cell" (traversal). freshwater.ts's header has the cost argument for
   * why serving the second question from the first's data structure is not an
   * option.
   */
  readonly freshwater: FreshwaterMap;

  /**
   * Whether the CONNECTED PLAYER `playerId` has personally unlocked the
   * chunk/cell — answered from THEIR OWN per-token mask, never the union
   * `isChunkUnlocked`/`isCellUnlocked` above (issue #17). Added for the
   * fog-of-war follow-up named as issue #17's accepted residual (global
   * entity broadcasts still reference positions over chunks a player hasn't
   * unlocked): NO core or shipped-plugin broadcast is filtered by these yet —
   * they exist so that follow-up is a new caller, not a new contract.
   * `players()` below already carries each connected player's `token`, which
   * is the other primitive a per-player broadcast fan-out needs.
   */
  isChunkVisibleTo(playerId: string, cx: number, cy: number): boolean;
  isCellVisibleTo(playerId: string, x: number, y: number): boolean;

  /**
   * Applies an edit through the authoritative path: shared brush + gradient
   * relaxation, full diff kept server-side, mask-filtered diff broadcast.
   * Returns the full (unfiltered) diff — plugins are trusted server code.
   *
   * ALWAYS THE SMOOTH TOOL WITH A SOFT EDGE, deliberately, and unchanged by the
   * 2026-08-14 brush-tool decision. Player intents now default to the stamp
   * tool, but existing plugins' terraforms were shaped and tuned against
   * relaxation — a plugin that raises a hill expects the land to flow. Changing
   * this default would silently re-tune every installed plugin, so it stays,
   * and the signature stays with it. If a plugin ever needs a stamp, that is an
   * additive optional options argument here, decided with the owner then.
   */
  sculpt(x: number, y: number, radius: number, amount: number): CellDiff[];

  /** Unlocks a chunk and streams it to clients. False if already unlocked. */
  unlockChunk(cx: number, cy: number): boolean;

  /**
   * THE PER-PLAYER CREEP PRIMITIVE (issue #17). Unlocks a chunk FOR ONE
   * TOKEN and streams it ONLY to that token's own live session(s) — never a
   * broadcast (see World.unlockChunkForToken for the full contract). This,
   * not `unlockChunk` above, is what the reveal plugin's per-player policy
   * calls: `unlockChunk` unlocks for the whole world at once.
   *
   * ALSO fans `onChunkUnlockedForToken` out to every plugin on a successful
   * (non-idempotent) unlock — added issue #18, so a plugin with static
   * per-chunk content (flora, structures) can push a targeted refresh into
   * the newly-visible chunk instead of waiting out a slow keepalive. See that
   * hook's own doc comment on TerracePlugin.
   */
  unlockChunkForToken(token: string, cx: number, cy: number): boolean;

  players(): readonly Player[];

  /** Sends `<pluginName>:<type>` to every client. */
  broadcast(type: string, payload: unknown): void;
  /** Sends `<pluginName>:<type>` to one player. */
  sendTo(playerId: string, type: string, payload: unknown): void;

  /**
   * THE FOG-OF-WAR FAN-OUT PRIMITIVE (issue #18). Sends `<pluginName>:<type>`
   * to every connected player (or, with `options.onlyPlayerId`, to exactly
   * one of them), with each recipient's own payload built from ONLY the
   * `items` visible to THEIR OWN unlock mask (`isCellVisibleTo`, via
   * `positionOf`) — this is the ONE place a plugin needs to loop
   * `players()` and hand-filter by visibility; every migrated broadcast in
   * this codebase (wildlife, monsters, flora, structures) goes through it
   * rather than reimplementing the filter.
   *
   * DISAPPEARANCE SEMANTICS, decided per issue #18 and controlled by
   * `options.skipEmpty` (default `false`, i.e. "always send"):
   *
   *   - `skipEmpty: false` — the recipient is sent a payload EVERY call, even
   *     one built from an empty subset. Required for a FULL-STATE / replace
   *     message (wildlife's `entities`, monsters' `state`): the only way a
   *     client learns "the thing you could see has moved out of your sight"
   *     is that the next full list simply omits it, so omitting the SEND
   *     itself on an empty subset would leave the client's last (non-empty)
   *     payload stale — exactly the leak this primitive exists to prevent.
   *   - `skipEmpty: true` — a recipient whose filtered subset is empty is
   *     sent nothing at all. Safe ONLY for an ADDITIVE delta or a snapshot of
   *     content that never moves once placed (flora's grown/felled trees,
   *     structures' founded/upgraded/demolished cells, either plugin's join
   *     snapshot or keepalive): because per-player masks only ever GROW
   *     (issue #17 — a chunk unlock is never undone), a position that is
   *     invisible to a player right now was equally invisible whenever this
   *     same item last changed, so there is nothing that empty send could
   *     ever have corrected. The join-snapshot side of each such plugin uses
   *     the SAME flag for the SAME reason, so the two paths cannot disagree
   *     about what a silent, empty response means.
   *
   * `positionOf` and `buildPayload` are pure: `positionOf` maps one item to
   * the cell that gates its visibility, and `buildPayload` turns one
   * recipient's own filtered subset into that message type's wire shape (a
   * caller with more than one item CATEGORY per message — e.g. a delta's
   * `grown`/`felled` — tags each item with its category and re-partitions
   * the filtered subset inside `buildPayload`; see the flora/structures
   * server code for the pattern).
   *
   * COST: O(players × items) per call — every item is visibility-tested once
   * per connected player. At the shipped caps this is negligible; see the
   * cost note beside each migrated broadcast call site for the actual
   * numbers at ~10 players.
   */
  broadcastVisible<T>(
    type: string,
    items: readonly T[],
    positionOf: (item: T) => { readonly x: number; readonly y: number },
    buildPayload: (visible: readonly T[]) => unknown,
    options?: {
      /** See the disappearance-semantics doc above. Default false. */
      readonly skipEmpty?: boolean;
      /** Restrict the fan-out to one connected player (e.g. a join snapshot). */
      readonly onlyPlayerId?: string;
    },
  ): void;

  /**
   * THE CROSS-PLUGIN EVENT PRIMITIVE (added 2026-08-19 for the chronicle
   * plugin — the first plugin whose whole mechanic is REACTING to other
   * plugins' facts). Fans `onWorldEvent` out to every installed plugin,
   * synchronously and in load order, with the event name namespaced
   * `<pluginName>:<type>` exactly like `broadcast` — so an emitter cannot
   * forge another plugin's events and two plugins cannot collide on a name.
   *
   * SERVER-SIDE ONLY: nothing here touches the wire. A consumer that wants
   * clients to know converts the event into its OWN broadcast, under its own
   * name and its own fog-of-war policy.
   *
   * The contract between emitter and consumer is deliberately loose — the
   * payload is `unknown`, and a consumer subscribes by the emitter's NAME
   * (the same by-name coupling the message namespace already establishes),
   * never by importing the emitter's code: a plugin must still build and
   * test with every other plugin deleted. Consumers therefore validate
   * payloads structurally, exactly as they do untrusted client messages —
   * not because an emitter is untrusted, but because the emitter may be a
   * different version or absent entirely.
   */
  emitEvent(type: string, payload: unknown): void;
}

/** Context handed to onIntent alongside the intent itself. */
export interface IntentCtx {
  readonly player: Player;
  readonly world: WorldApi;
}

/**
 * An interceptor's answer. `deny` stops the chain immediately (first deny
 * wins); `modify` replaces the intent and the REPLACEMENT flows to the next
 * interceptor, so plugins compose. A plugin that returns nothing is treated as
 * allow, which keeps trivial hooks trivial.
 */
export type IntentVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason?: string }
  | { readonly kind: 'modify'; readonly intent: SculptIntent };

/** Convenience constant for the common case. */
export const ALLOW: IntentVerdict = { kind: 'allow' };

/** Handler for a namespaced client → server plugin message. */
export type PluginMessageHandler = (
  world: WorldApi,
  player: Player,
  payload: unknown,
) => void;

/**
 * Plugin-owned data included in world snapshots and restored on boot.
 * `save()` must return a JSON-serializable value (it is stored as JSON text
 * next to the heightmap blob); `load()` receives back exactly what `save()`
 * produced, or is never called if this plugin had no slice in that snapshot.
 *
 * RE-RUNNABLE, NOT ONCE-PER-PROCESS (world rollback, 2026-08-21). `load()`
 * followed by `onWorldCreate()` may run again on a LIVE world, when an
 * operator rolls the world back to an earlier restore point. Both must
 * therefore REPLACE this plugin's state rather than add to it: a load that
 * appends to a list, resumes a counter, or spawns a second copy of something
 * would double it on every rollback. Every plugin in this repo already
 * satisfies this — each `onWorldCreate` assigns fresh state or zeroes its
 * counters — and a rollback replays exactly the boot pair, in the boot order,
 * so "what a fresh boot from this snapshot would produce" is the whole
 * contract to hold to. See server/src/world/rollback.ts.
 */
export interface PersistenceSlice {
  save(): unknown;
  load(data: unknown): void;
}

export interface TerracePlugin {
  /**
   * Unique, stable identifier. Also the message namespace, so it is restricted
   * to lowercase alphanumerics and dashes (see PLUGIN_NAME_PATTERN).
   */
  readonly name: string;

  /** World is ready — already restored from a snapshot if one existed. */
  onWorldCreate?(world: WorldApi): void;

  /** Fixed-rate sim step. `dt` is the constant tick period in seconds. */
  onTick?(world: WorldApi, dt: number): void;

  /**
   * VERDICT-PHASE interceptor: allow / deny / modify. See IntentVerdict.
   *
   * VERDICT ONLY — NO SIDE EFFECTS (issue #19). Every installed plugin's
   * onIntent runs, in load order, BEFORE core applies anything to the
   * heightmap or commits any plugin-owned economy: a later plugin in the
   * chain (monsters denying a raise near a living Cthulhu, say) can still
   * veto the whole intent, and first-deny-wins means everything this plugin
   * decided is discarded. A plugin that mutates its own state here — most of
   * all one that debits a currency or consumes a limited resource — is
   * exposed to exactly the bug issue #19 was filed for: the mutation survives
   * a later plugin's deny, so a denied intent still cost something.
   *
   * IRREVERSIBLE SIDE EFFECTS BELONG IN `onIntentApplied` INSTEAD (below),
   * which core calls once, only after every interceptor in the chain has
   * allowed (directly or via `modify`) AND the edit has actually landed. A
   * plugin that only READS world/player state here — as every deny/modify
   * decision in this repo does (mana prices and checks a balance without
   * touching it; monsters checks a monster's position; relics reads a
   * player's held skills) — needs no split at all.
   *
   * One exception, and it is safe rather than an oversight: a plugin MAY
   * message the player about ITS OWN decision to deny (`world.sendTo`) here,
   * because first-deny-wins means that decision is never overturned by a
   * later interceptor — there is nothing for the message to become stale
   * against. Mutating state that would need to be undone on a later veto is
   * what this contract forbids, not telling the client why THIS plugin said
   * no.
   */
  onIntent?(intent: SculptIntent, ctx: IntentCtx): IntentVerdict | void;

  /**
   * EFFECT-PHASE companion to onIntent (added for issue #19 — see that hook's
   * doc comment for the split this exists to enable).
   *
   * Fires once per applied player intent, AFTER the edit has been applied and
   * broadcast, and ONLY when every interceptor in the chain allowed it. Never
   * fires for a denied or malformed intent, and never fires for a
   * plugin-initiated edit made through `WorldApi.sculpt` (there is no
   * player intent to apply — see onTerrainChanged for the hook that covers
   * every edit, player or plugin, by diff alone).
   *
   * `intent` is the EFFECTIVE intent — the one actually applied, after any
   * `modify` earlier in the chain rewrote it (e.g. relics' Titan's Hand
   * widening the brush) — not the one this plugin's own onIntent may have
   * seen. This is a deliberate choice: `onIntentApplied` describes what
   * HAPPENED, and what happened is the effective intent's edit, matching
   * `diff`. A plugin that priced or gated the ORIGINAL intent during the
   * verdict phase and wants to charge for what was actually built should
   * recompute against this parameter rather than trust a value it cached
   * from onIntent.
   *
   * `ctx` is the same shape onIntent receives (the player and their
   * per-plugin WorldApi). `diff` is the full, unfiltered server-side diff —
   * same semantics as onTerrainChanged's.
   */
  onIntentApplied?(
    intent: SculptIntent,
    ctx: IntentCtx,
    diff: readonly CellDiff[],
  ): void;

  /**
   * The DENY-side companion to onIntentApplied (added 2026-08-19, mana
   * phantom-debit bug). Fires once per intent that passed structural
   * validation and the mask check but was then refused — an interceptor
   * denied it, or a plugin's rewrite of it failed re-validation. Never fires
   * for the pipeline's silent rejections (malformed, locked): those are
   * unreachable from a well-behaved client and deliberately unanswered.
   *
   * WHY IT EXISTS. A client plugin may optimistically mutate its own
   * replicated state the moment an intent is SENT (mana's local gate debits
   * its balance estimate). #21 guarantees the sender exactly one answer per
   * intent, and the terrain prediction reconciles against it — but a plugin
   * client has no view of core's `sculptDenied`, so its optimistic state
   * needs a server-side push to reconcile against. This hook is where such a
   * plugin re-asserts its authoritative state to the sender (mana pushes the
   * player's untouched balance), so a denied intent leaves EVERY prediction
   * premised on the send corrected, not just the terrain's.
   *
   * `intent` is the intent AS THE CLIENT SENT IT (post-validation), not any
   * partial rewrite an earlier interceptor produced before the deny — the
   * hook's purpose is reconciling what the SENDER predicted. Fires for every
   * plugin, the denier included; like onIntentApplied it must not assume it
   * was the one that denied. State mutation here must be limited to
   * client-reconciliation messaging — the intent was refused, so nothing may
   * be spent or built on its account.
   */
  onIntentDenied?(intent: SculptIntent, ctx: IntentCtx): void;

  /**
   * Fired after any applied edit, with the FULL server-side diff. Handed the
   * same WorldApi as onTick/onIntent, so a plugin that reacts to terrain
   * (re-checking a habitat, creeping a player's territory, felling a tree)
   * needs no stash of its own to reach `sculpt`, `broadcast`, or any other
   * member.
   *
   * `sculptorToken` (added issue #17) identifies the PLAYER whose intent
   * produced this diff, when there was one: a player's own sculpt carries
   * their token (intent/pipeline.ts resolves it once, before this fires), a
   * plugin-initiated edit via `WorldApi.sculpt` carries none — there is no
   * player to credit. The reveal plugin's per-player creep policy is the
   * first, and so far only, reader of this parameter; every other existing
   * plugin's `onTerrainChanged` ignores it (a JS function may always declare
   * fewer parameters than its call site provides).
   */
  onTerrainChanged?(world: WorldApi, diff: readonly CellDiff[], sculptorToken?: string): void;

  /** Handed the same WorldApi as onTick/onIntent — see onTerrainChanged. */
  onPlayerJoin?(world: WorldApi, player: Player): void;
  /** Handed the same WorldApi as onTick/onIntent — see onTerrainChanged. */
  onPlayerLeave?(world: WorldApi, player: Player): void;

  /**
   * THE TARGETED-REFRESH HOOK (issue #18). Fired after `WorldApi.
   * unlockChunkForToken` successfully unlocks chunk (cx, cy) FOR ONE TOKEN —
   * never for `unlockChunk`'s world-wide unlock, which every connected
   * player already learns about directly. `token`, not a playerId: the token
   * can be live in more than one session (issue #17), and this plugin is
   * expected to resolve `world.players()` filtered by `player.token ===
   * token` itself, exactly as `World.unlockChunkForToken` does for the core
   * `chunkUnlock` message.
   *
   * WHY THIS EXISTS, rather than leaving every plugin to catch up on its own
   * cadence: a moving-entity plugin (wildlife, monsters) already re-sends
   * its full state every broadcast, so the newly unlocked chunk's occupants
   * reach the player on the very next cycle (≤ 1 s) with no extra code. A
   * STATIC-content plugin (flora, structures) does not — its periodic
   * full resync is a 60 s REPAIR cadence, not a sync mechanism (see each
   * plugin's own header), so without this hook a tree or a building already
   * standing in a chunk a player just earned would not reach them for up to
   * a minute. A plugin with nothing already sitting in that chunk, or with
   * moving entities that do not need this, simply does not implement it.
   */
  onChunkUnlockedForToken?(world: WorldApi, token: string, cx: number, cy: number): void;

  /**
   * Fired for every `WorldApi.emitEvent` from any plugin, THIS PLUGIN'S OWN
   * INCLUDED (an emitter that also consumes must filter itself out if it
   * cares). `event` is the full namespaced name (`structures:changes`) and
   * `payload` is whatever the emitter passed, to be validated structurally —
   * see emitEvent's doc comment for the by-name coupling rule this half of
   * the contract lives under. Runs synchronously inside the emitting call,
   * guarded against runaway emit-from-handler cascades exactly like
   * onTerrainChanged (host.ts's MAX_WORLD_EVENT_DEPTH).
   */
  onWorldEvent?(world: WorldApi, event: string, payload: unknown): void;

  /** Namespaced client → server handlers, keyed by the un-namespaced type. */
  readonly messages?: Readonly<Record<string, PluginMessageHandler>>;

  /** Plugin-owned snapshot data. */
  readonly persistence?: PersistenceSlice;

  // state?: SchemaSlice;
  // DELIBERATELY ABSENT IN PHASE 1. The design sketch (§3.5) included a
  // plugin-owned Colyseus schema slice, but decision Q7 (2026-08-13) rules that
  // terrain never travels as schema state, and Phase 1 core has no other
  // synced state to anchor the feature on. Plugins that need synced state today
  // use `messages`. Add this slot when a real plugin needs it, together with the
  // room-side wiring — an untested empty hook is worse than no hook.
}

/** A discovered plugin plus where it came from (used in logs and errors). */
export interface LoadedPlugin {
  readonly plugin: TerracePlugin;
  /** Directory name under plugins/ — also the alphabetical sort key. */
  readonly directory: string;
  /** Absolute path of the server entry module that was imported. */
  readonly entryPath: string;
}
