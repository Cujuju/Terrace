# Territory and fog of war

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-19 (settled with owner, issue #17)

- **Per-player territory: the reveal/frontier-pressure policy is REPLACED by
  instant per-player creep, and unlocks stop being world-wide** (owner
  decisions on issue #17: "Per-player territory: instant creep on spillover,
  browser-token identity"). Four parts.

  **1. Identity.** The client generates an opaque token
  (`crypto.randomUUID()`), persists it in `localStorage`, and resends it as a
  join option on every connection — first join, reconnect, or a later browser
  session. Pre-auth-plugin and §3.7-compatible: player identity was already an
  opaque string (the Colyseus sessionId), and this only adds a SECOND, DURABLE
  opaque string alongside it. The server sanitizes it exactly like
  `sanitizePlayerName` (length cap, closed charset, and ANY unusable value
  degrades to a session-scoped fallback identity rather than blocking the
  join — `server/src/player.ts`'s `sanitizePlayerToken`). `Player.id` stays
  the Colyseus sessionId (a connection); `Player.token` is the new durable
  identity attached to it.

  **2. Per-player masks in core.** The world-level unlocked-chunk mask
  (`World.mask`) is REDEFINED as the SIMULATION mask — the union of every
  player's own progress. Every existing reader (wildlife census, flora,
  monsters, the sculpt-permission check, and the ongoing `terrainDiff`
  broadcast filter) keeps reading it, with UNCHANGED semantics — see the
  "known residual" note below for why the latter two were deliberately left
  alone. A new per-token layer is added beside it: a chunk unlock happens FOR
  A TOKEN (`World.unlockChunkForToken`, published to plugins as
  `WorldApi.unlockChunkForToken`), and the union mask ORs in a chunk the
  instant its FIRST token earns it. The join snapshot sends only the joining
  token's OWN chunks (`World.chunkPayloadsForToken`), and a `chunkUnlock`
  message goes only to that token's live session(s) via `sendTo` — never a
  broadcast, so "one adventurous player must not expose the world to
  everyone" holds structurally, not by convention. The client needed NO new
  mask logic for this: it already infers unlocked-ness purely from which
  chunks it was sent, so per-player streaming is invisible to it — only the
  token plumbing (join options, `localStorage`) is client work.

  **Minimal API addition, and why this shape.** `WorldApi` gains exactly one
  write primitive, `unlockChunkForToken(token, cx, cy): boolean`, mirroring
  `unlockChunk`'s existing idempotent-boolean contract so the reveal plugin
  can call it unconditionally per touched cell with no separate read check.
  `onTerrainChanged` gains one additive optional parameter, `sculptorToken?:
  string` — WHO made this edit, when it was a player (an intent carries
  `player.token` through `sculpt-service.ts`); a plugin-initiated edit via
  the existing `WorldApi.sculpt` carries none, so a policy plugin has an
  explicit "nobody to credit" signal instead of an invented default. Two
  read primitives were added at the same time for a NAMED FOLLOW-UP
  (fog-of-war, filtering the global entity broadcasts below) rather than
  discovered later as a second contract change: `WorldApi.isChunkVisibleTo` /
  `isCellVisibleTo(playerId, …)`, answering from one connected player's own
  token mask. Nothing calls them yet.

  **3. Creep policy (reveal plugin).** The old "frontier pressure" counter —
  a locked chunk unlocked once it had absorbed `CHUNK_SIZE²` cumulative
  cell-changes from ANYONE, against the single world-wide mask that existed
  before this decision — is DELETED entirely, counter and persistence slice
  both. Replaced with: on terrain change, any changed cell landing in a chunk
  not yet in the SCULPTOR's own mask unlocks that chunk FOR THAT SCULPTOR,
  immediately — no threshold. The counter's reason to exist (resisting a
  single griefer forcing an unlock everyone else would then see for free)
  stopped applying the moment unlocking became per-player: that griefer now
  only ever unlocks the chunk for themselves. The plugin stays the policy
  owner (core still does not decide WHEN territory unlocks); it is now
  STATELESS, because the state it used to keep (pressure per chunk) is gone
  and the state it now acts through (per-token masks) lives in core.

  **4. Persistence: core's own table, not a reveal slice — decided, not
  defaulted.** Per-token masks are the SAME binary bitset shape as the
  existing union `mask`, and `unlockChunkForToken` is a `WorldApi` capability
  any plugin can reach, not reveal-plugin-private state — so they are stored
  beside `mask`, in a new `token_masks` SQLite table (one row per
  snapshot × token), the same way `world_name` was added: an additive
  `CREATE TABLE IF NOT EXISTS`, `SNAPSHOT_SCHEMA_VERSION` left UNCHANGED
  (an older build's `SELECT *` never sees the new table; this build reads a
  snapshot with no matching rows — exactly what every pre-#17 snapshot has —
  as "no per-token masks recorded"). **Legacy restore, stated loudly because
  it is a real, accepted regression:** an old snapshot's world-level mask
  becomes the new union/simulation mask (unchanged, since it was always the
  only mask); every per-token mask starts EMPTY. Concretely, a returning
  player on an upgraded server re-creeps their own view of territory the
  world already contains — even land they had personally opened before the
  upgrade — while the simulation (wildlife, flora, monsters) is unaffected,
  since it only ever read the union.

  **Known accepted residual, not fixed here — CLOSED by issue #18 (see the
  decisions block immediately below).** Global entity broadcasts (wildlife,
  flora, monsters, structures) still reference positions over
  chunks a given player has not personally unlocked — they were never
  filtered per-player before this change, and per-player masks existing in
  core does not by itself filter them. Tracked as a fog-of-war follow-up; the
  `isChunkVisibleTo`/`isCellVisibleTo` primitives above exist so that
  follow-up is a new caller, not another contract change. The same
  reasoning is why the intent pipeline's sculpt-permission check and the
  `terrainDiff` broadcast filter were deliberately left reading the UNION
  mask, unchanged: once a chunk is unlocked for anyone, the server itself no
  longer treats its terrain as secret, so a second player sculpting or
  seeing further edits there is shared-world behaviour, not the leak
  per-player masks exist to close — closing it is the SAME fog-of-war
  follow-up, not a gap in this one.

## Decisions made 2026-08-19 (settled with owner, issue #18)

- **Strict fog of war: one fan-out primitive, not per-plugin filtering.**
  `WorldApi` gains `broadcastVisible(type, items, positionOf, buildPayload,
  options?)` — the ONE place a plugin loops `players()` and filters by
  visibility. For every connected player (or, with `options.onlyPlayerId`,
  exactly one of them) it filters `items` down to the ones visible over that
  player's own token mask (`isCellVisibleTo`, via `positionOf`) and hands the
  filtered subset to `buildPayload` to build that recipient's own wire
  payload. `options.skipEmpty` (default `false`) picks the disappearance
  contract: `false` — used for a FULL-STATE replace message (wildlife's
  `entities`, monsters' `state`) — always sends, even an empty payload,
  because the only way a client learns something it could see has left its
  view is that the next full list omits it; `true` — used for an ADDITIVE
  delta or a snapshot of content that never moves once placed (flora's
  grown/felled, structures' founded/upgraded/demolished, either plugin's join
  snapshot and keepalive) — sends nothing at all to a recipient whose subset
  is empty, which is safe *because* per-token masks only ever grow (issue
  #17): a position invisible to a player now was equally invisible whenever
  that item last changed, so there is nothing an empty send could ever have
  corrected. The join-snapshot side of each such plugin uses the SAME flag
  for the SAME reason, so the two paths cannot disagree about what silence
  means.

- **Migrated:** wildlife's `entities` broadcast, monsters' `state` broadcast,
  flora's `forest`/`changes` broadcasts and join snapshot, structures'
  `all`/`changes` broadcasts and join snapshot. **Not migrated:** relics —
  its own global, unfiltered five-item broadcast was never named in issue
  #17's residual note or in #18 itself; flagged here as a follow-up, not
  silently left as an oversight.

- **Weather is EXEMPT, verified rather than assumed.** Its broadcast stays a
  single unfiltered `world.broadcast` to everyone. A weather system's
  position is a function of RNG and the shared wind alone; the one place the
  sim reads terrain at all (snow siting) already refuses to look at a locked
  cell (`SNOW_MIN_TERRAIN_BANDS_ABOVE_SEA`'s guard, `isCellUnlocked`), so the
  payload carries no information about locked terrain shape to filter in the
  first place — weather's own file header already documented this
  reasoning before #18 and it was independently re-verified, not assumed,
  while implementing this issue. Wildlife's birds get the identical
  exemption for the identical reason: `flocks.ts` reads neither heights nor
  the mask, a flock's course is terrain-independent ambience exactly like a
  weather system's, and a bird legitimately spawns and despawns OFF the map
  — running one through `isCellVisibleTo` would throw (shared's `chunkIndex`
  bounds-checks by contract), so birds are spliced into every recipient's
  payload unfiltered rather than gated by position.

- **Appearance on creep.** Wildlife (5 Hz) and monsters (1 Hz) need no extra
  mechanism: `broadcastVisible` re-reads every connected player's own mask on
  every call, so a chunk a player just earned is reflected on the very next
  cadence tick regardless. Flora and structures cannot rely on their cadence
  — their periodic full resync is a 60 s REPAIR cadence, not a sync
  mechanism, and a delta only announces what just changed, not what has been
  standing there all along — so `TerracePlugin` gains one additive optional
  hook, `onChunkUnlockedForToken(world, token, cx, cy)`, fired by
  `WorldApi.unlockChunkForToken`'s wrapper after a REAL (non-idempotent) unlock,
  once per plugin. Flora and structures each push a targeted, ADDITIVE delta
  (never their "replace the whole list" message type, which would wipe out
  everything else the player already knows) containing whatever already
  stands in that one chunk.

- **Disappearance for a moving entity, verified client-side, no client
  change needed.** Both the wildlife and monsters clients already replace
  their whole entity map on every message and drop whatever id the newest
  message omits (`WildlifeInterpolator`/`MonsterInterpolator`'s own doc
  comments already say so) — fog-of-war's per-player, sometimes-smaller list
  is exactly the input that path was built for. Flora and structures never
  need an equivalent: their content is static and per-token masks are
  monotonic, so a position visible to a player now was visible to them at
  every earlier moment too — there is no "used to see it, now don't" case for
  a tree or a building to hit.

- **Perf, estimated at the shipped caps and ~10 players (the same anchor the
  bandwidth arithmetic elsewhere in this section uses).** `broadcastVisible`
  is O(players × items); at 10 players this is ≈1 680 `isCellVisibleTo` calls
  per wildlife broadcast (168 entities, 5 Hz ⇒ ≈8 400/s), ≈20/s for monsters
  (2 entities, 1 Hz), and for flora/structures — bounded by FLORA_TREE_CAP
  (3 000) / STRUCTURES_CAP (512) but almost never exercised at the cap on a
  keepalive (60 s) and typically single-digit item counts on a delta — a
  worst-case ≈30 000/500/s amortised on the keepalive and negligible on
  deltas. Every `isCellVisibleTo` call is O(1) (a couple of `Map`/typed-array
  lookups); one filtered array is allocated per recipient per call. All of
  this is rounding error next to the per-tick work these plugins already do
  (flora/structures each already scan thousands of cells a tick for their own
  survey/CA sweep).

## Decisions made 2026-08-19 (issue #21 — the frontier revert)

Owner report: "when I am moving land around it sometimes goes back and redraws
the outline and removes areas that I just sculpted."

**Root cause.** The client had no way to be TOLD that its intent was applied,
so it inferred acknowledgement by comparing the authoritative heights against
the ones its own prediction produced (`isConfirmed`). That inference only works
while the client can reproduce the server's arithmetic, and at a territory
frontier it provably cannot: the shared brush and relaxation math read cells in
chunks the client was never sent, and the mirror holds those at SEA_LEVEL as a
RENDERING choice (so revealed land slopes into the sea rather than ending in a
floating cliff). The prediction therefore never matched, was never retired, and
was replayed on top of the server's own copy of the same edit for a full
PREDICTION_TTL_MS — dragging just-sculpted ground down and then snapping it
back. Measured on the repro: the client rendered 181 where the server said 224,
and pulled its own frontier column to 149 from a starting 160.

Two changes, at the contract layer rather than at the call sites.

- **1. THE ANSWER CONTRACT (protocol, additive).** A new
  `SculptAppliedMessage { type, seq }`, sent to the ORIGINATING client only, is
  the twin of the existing `SculptDeniedMessage`: an intent carrying a `seq`
  now gets exactly one answer — applied or denied — and the client retires that
  prediction on the answer instead of guessing. **Ordering is the contract**:
  the ack is sent from `server/src/intent/pipeline.ts` only AFTER
  `applyServerSculpt` has returned, so it lands behind the terrainDiff and
  behind any `chunkUnlock` the same stroke earned. Verified from source
  (@colyseus/core 0.17.50 `Room.broadcastMessageType`, @colyseus/ws-transport
  0.17.13 `WebSocketClient.send`) that both funnel into the same per-client
  `enqueueRaw` synchronously, so call order is wire order. Retiring earlier
  would show pre-sculpt ground for a frame. Value agreement is kept as the
  fallback for a seq-less intent; the deadline stays as the safety net.
  The seq echoed is the CLIENT's, not a plugin-rewritten intent's — it
  identifies the prediction being held, not the edit the server made.
- **2. PREDICT ONLY WHAT YOU CAN COMPUTE (client).** `predict` already refused
  an intent whose brush CENTRE was in a chunk it had never received; that rule
  was right and merely too narrow — a brush is not one cell. It now refuses any
  intent whose footprint, plus the one-cell ring the relaxation compares
  against (`PREDICTION_HALO_CELLS`), reaches a chunk it has never received.
  The stroke is still sent and still applied; only the local preview is
  skipped, and only where it would have been wrong. This matters most for the
  level-fill brush (stamp + hard), which SURVEYS its whole footprint for the
  lowest terrace band: one unseen cell reading SEA_LEVEL drags the survey to
  band 0 and the entire stroke targets the wrong terrace.

**Not the cause, checked and recorded so it is not re-suspected.** The #17
union-vs-per-token asymmetry cannot produce a revert. Every per-token mask is
ORed into the union when it is granted, so the union is always a superset: a
client is never denied a diff cell for a chunk it holds. The asymmetry can only
send a client cells for a chunk it does NOT hold, which land in the mirror's
backing array, are in no mesh, and are overwritten whole by `writeChunkHeights`
if that chunk is ever unlocked for it. That is the fog-of-war leak already
tracked from #17, not this bug.

**"Redraws the outline" is a symptom, not a second defect.** The brush outline
follows the picked surface height and the terrace bands are a quantisation of
height (`bandColors.ts`), so both redraw whenever the heights under them move.
Nothing in the render layer was changed.

**Residual, stated rather than punted.** A stroke whose footprint is entirely
on known ground but whose relaxation cascade travels far enough to read past
the frontier anyway still predicts wrong — the halo bounds the brush's own
neighbour reads, not an arbitrarily long cascade. It is bounded to ONE ROUND
TRIP by the ack instead of to PREDICTION_TTL_MS, and it can no longer double.
Closing it exactly would mean having the shared math report its read set, which
is a change to `shared/` for a case the ack already makes invisible.
