// flora → cyclone, READ-DIRECTION: this plugin's end of the wind-damage world
// event, and the numbers that turn a wind into a fallen tree.
//
// BY NAME, NEVER BY IMPORT. The whole of the coupling to the cyclone plugin is
// the string below (server/src/plugins/types.ts's emitEvent doc comment, and
// the by-name subscription rule it states). Nothing here imports cyclone, and
// this plugin builds, tests and runs with cyclone deleted — in which case the
// event never arrives, nothing here ever runs, and a wood is felled only by
// fire and by the hand, exactly the world flora had before cyclones existed.
// ./structures-event.ts is the same pattern against a different emitter.
//
// THE PAYLOAD SHAPE IS PARSED BY CORE'S KIT
// (server/src/plugins/kit/rotatingStormDamage.ts), not restated here — see that
// file's header for why the copy rule does not reach it: the shape belongs to
// core's storm engine, not to the neighbour that happens to drive one.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A CYCLONE DOES TO A WOOD, AND WHY IT IS A ROLL PER TREE PER SECOND.
//
// The event is emitted once a second per storm and carries the seconds it
// accounts for, which is exactly what lets this convert a severity into a RATE
// without knowing the server's tick rate. Every standing tree inside the disc is
// rolled once per event at a probability proportional to
// `severity × durationSeconds`, so:
//
//   * under the eyewall, where severity is at the storm's own intensity, a wood
//     is gone in a handful of seconds;
//   * out toward the rim, where the ramp has taken severity down to a fraction,
//     the same roll THINS the wood over the minutes a slow storm takes to pass;
//   * past FLORA_WIND_MIN_SEVERITY nothing falls at all, so the outermost skirt
//     of a cyclone is weather rather than destruction.
//
// The forest regrows on its own survey afterwards, which is what makes this a
// storm the world heals from rather than a permanent scar. The stump is the
// scar that outlives it, on the same clock a burn's does.

/**
 * The event's full namespaced name, as the cyclone plugin emits it.
 *
 * A STRING, for this file's header's reason. The un-namespaced half is
 * `damage`; the prefix is the emitter's plugin name, which the host prepends.
 */
export const CYCLONE_DAMAGE_EVENT_NAME = 'cyclone:damage';

/**
 * The floor on severity below which the wind fells nothing at all, as a
 * fraction of the storm's own intensity ceiling.
 *
 * 0.15 — the outer seventh or so of a cyclone's disc, and the last stretch of a
 * storm that land has already beaten down. Two things need this bar and neither
 * is cosmetic. A storm's envelope decays as it crosses land, so without a floor
 * a dying cyclone would go on felling single trees at a vanishing rate for the
 * whole minute it takes to die, which reads as a forest rotting rather than as a
 * storm passing. And the rim of a live storm is a stiff breeze: a tree bends in
 * it. The bar is what makes "the wind flattened the wood" a statement about
 * where the storm actually was.
 */
export const FLORA_WIND_MIN_SEVERITY = 0.15;

/**
 * Chance that one second of severity-1 wind fells one standing tree.
 *
 * 0.25 — HALVED from the 0.5 that shipped with #299, on the owner's ruling of
 * 2026-09-04 (issue #304). The fixture that prompted it ran a 0.75-intensity
 * cyclone over an island for 60 s and left 2 of 417 trees standing: the wood
 * well off the track was erased, not thinned, which is not what "a storm the
 * world heals from" was meant to read as.
 *
 * At a quarter per second the eyewall (severity 1) still flattens: a stand is
 * 76% gone after five seconds, 94% after ten and bare inside twenty, so "it
 * should flatten flora" still holds where the storm actually is. What changes
 * is the rest of the disc, which is the point of a per-severity-second rate:
 * the mid-disc (severity ~0.5) now has a half-life of about five seconds of
 * exposure and the near-rim (severity ~0.2) about thirteen, against three and
 * seven before — so a wood a cyclone passes at a distance loses roughly half
 * of itself in a passage rather than nearly all of it.
 *
 * NOT 0.125, which would leave only the eyewall clearing anything and make the
 * mid-disc a breeze; the owner chose the halving over the quartering.
 */
export const FLORA_WIND_TREE_FELL_CHANCE_PER_SEVERITY_SECOND = 0.25;

/**
 * The same floor for a field of grain, and the same roll — with a LOWER bar
 * than a tree's, because a crop is flattened by wind a tree stands up to.
 *
 * 0.05 — a third of FLORA_WIND_MIN_SEVERITY, so a cyclone lays a field over
 * some way beyond the edge of where it is snapping trunks. That relationship is
 * the reason for the value; the absolute number is only its consequence.
 */
export const FLORA_WIND_CROP_MIN_SEVERITY = FLORA_WIND_MIN_SEVERITY / 3;

/**
 * Chance that one second of severity-1 wind flattens one cell of crop.
 *
 * 1.0 — a certainty, and deliberately so rather than merely high. Grain has no
 * strategy against a hurricane: the question a player asks about a flattened
 * field is which of it the storm reached, never which stalks got lucky. The
 * severity ramp is what still makes it a gradient — at the rim the effective
 * rate is a few per cent a second, so the edge of a field goes over slowly and
 * the middle of the storm's track goes flat at once.
 */
export const FLORA_WIND_CROP_FLATTEN_CHANCE_PER_SEVERITY_SECOND = 1;

/**
 * How long a wind-flattened crop plot stays unsown, in simulated seconds.
 *
 * WHY A BAR AT ALL (issue #304). Wind stamps no scorch record — a cyclone takes
 * the stalks, not the soil (./index.ts's FloraRemovalCause) — so until this
 * existed a flattened field was re-sown by the very next crop survey, within
 * CROP_SURVEY_INTERVAL_SECONDS (./crops.ts, 5 s) of going over, often while
 * the storm still stood on it. A field that springs back inside the storm is
 * a field the storm never visibly touched.
 *
 * 60 s — A THIRD OF FLORA_SCORCH_REGROW_SECONDS (./scorch.ts, 180 s), restated
 * rather than derived, on scorch.ts's own rule that two windows which relate
 * today must be free to disagree tomorrow. The ordering is the reason: a burn
 * consumes the ground and a storm only lays the crop over, so wind must heal
 * FASTER than fire or the two become indistinguishable on the ground. A minute
 * is long enough to outlast the storm's own passage of a field (a cyclone
 * crosses the map at a quarter of a world unit a second, so its disc clears a
 * plot in well under a minute) and short enough that the field is visibly
 * back before the stumps around it rot (FLORA_STUMP_ROT_SECONDS, 360 s). The
 * owner chose this over reusing the 180 s scorch window (2026-09-04).
 *
 * NOT PERSISTED, unlike the scorch record. A lost scorch entry is FUEL and
 * re-lights a fire; a lost flatten entry re-sows one field up to a minute
 * early after a restart, which is cosmetic. The window is also about equal to
 * the snapshot cadence (server/src/config.ts's DEFAULT_SNAPSHOT_INTERVAL_S,
 * 60 s), so a persisted copy would be stale on arrival more often than not.
 */
export const FLORA_WIND_CROP_REGROW_SECONDS = 60;

/**
 * The chance one roll should use, clamped to a probability.
 *
 * CLAMPED, not asserted: `severity × durationSeconds` exceeds 1 the moment an
 * emitter accounts for more than a second at full strength (a slower damage
 * cadence, a tick the engine batched), and a probability above 1 is simply
 * certainty. Failing there would take a whole plugin out of the world over an
 * emitter's pacing decision.
 */
export function windEffectChance(
  severity: number,
  durationSeconds: number,
  chancePerSeveritySecond: number,
): number {
  const chance = severity * durationSeconds * chancePerSeveritySecond;
  return chance > 1 ? 1 : chance;
}
