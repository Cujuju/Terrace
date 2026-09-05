// structures → cyclone, READ-DIRECTION: this plugin's end of the wind-damage
// world event, and the numbers that turn a wind into a demolished building.
//
// BY NAME, NEVER BY IMPORT. The whole of the coupling to the cyclone plugin is
// the string below (server/src/plugins/types.ts's emitEvent doc comment, and
// the by-name subscription rule it states). Nothing here imports cyclone, and
// this plugin builds, tests and runs with cyclone deleted — in which case the
// event never arrives and a town is only ever lost to fire, to the god's hand
// or to the generation rule, exactly the world it had before.
//
// The payload SHAPE is parsed by core's kit
// (server/src/plugins/kit/rotatingStormDamage.ts); see that file's header for
// why restating it here would be restating CORE's type rather than honouring
// the neighbour rule.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A BUILDING OUTLASTS A TREE, AND HOW MUCH.
//
// Both react to the same event with the same arithmetic — a roll per standing
// thing per second, at a chance proportional to `severity × durationSeconds` —
// and the whole difference is in the two numbers below against flora's
// (plugins/flora/server/cyclone-event.ts). The bar is more than twice as high,
// so the outer half of a cyclone's disc snaps trunks while leaving roofs on;
// and the rate at the bottom tier is a sixth of a tree's, so even under the
// eyewall a settlement is a thing the storm works through rather than erases in
// one event.
//
// NO NEW HEALTH MODEL. This plugin has never had one: a building is alive or it
// is gone, and every existing loss path (fire, the god's hand, the generation
// rule) removes it outright. A per-building hit-point pool invented for the
// wind would be a second model of what a building IS, reachable only from a
// cyclone, persisted nowhere — so the roll IS the model, and TIER is the
// durability the plugin already tracks.

/**
 * The event's full namespaced name, as the cyclone plugin emits it.
 *
 * A STRING, for this file's header's reason. The un-namespaced half is
 * `damage`; the prefix is the emitter's plugin name, which the host prepends.
 */
export const CYCLONE_DAMAGE_EVENT_NAME = 'cyclone:damage';

/**
 * The floor on severity below which the wind takes no building at all.
 *
 * 0.35 — more than double flora's FLORA_WIND_MIN_SEVERITY (0.15), and the
 * relationship is the point rather than the number. Under the shipped cyclone's
 * ramp it confines any structural loss to the inner ~69% of the disc against a
 * tree's ~87%, so a storm passing a settlement takes the wood around it before
 * it takes a roof, and a cyclone that land has already beaten below a third of
 * its peak stops flattening villages while it is still stripping trees. That
 * ordering is what makes the felled wood a WARNING rather than a footnote.
 */
export const STRUCTURES_WIND_MIN_SEVERITY = 0.35;

/**
 * Chance that one second of severity-1 wind demolishes one TIER-0 building.
 *
 * 0.08 — a sixth of a tree's 0.5, and read off the outcome rather than picked
 * for feel. A tier-0 cell is a teepee; the eyewall of a full-strength cyclone
 * takes about a minute to cross a settlement at the shipped storm speed, and at
 * 0.08 a teepee's survival odds over that minute are 0.92^60 ≈ 0.7%. So a camp
 * under the eyewall is gone, reliably, while any single second is only an 8%
 * event — which is the difference between a settlement being destroyed over a
 * minute the player can watch and one vanishing between two frames.
 */
export const STRUCTURES_WIND_DEMOLISH_CHANCE_PER_SEVERITY_SECOND = 0.08;

/**
 * What each tier of standing multiplies a building's survival odds by — i.e.
 * the factor its demolition chance is scaled DOWN by, once per tier.
 *
 * 0.5, chosen so that the top of the ladder is a real shelter without being
 * immunity — LOWERED from the 0.6 that shipped with #299 on the owner's ruling
 * of 2026-09-04 (issue #304), after a 0.75-intensity fixture demolished tiers
 * 1-3 outright and left only tier 4 standing. Over the same minute of eyewall
 * as above (MAX_STRUCTURE_TIER = 5, ../protocol.ts):
 *
 *   tier 0  0.0800/s → ~99% lost     tier 3  0.0100/s → ~45% lost
 *   tier 1  0.0400/s → ~91% lost     tier 4  0.0050/s → ~26% lost
 *   tier 2  0.0200/s → ~70% lost     tier 5  0.0025/s → ~14% lost
 *
 * A watchtower usually rides a hurricane out and sometimes does not, which is
 * the reading "higher tiers resist more" has to have if the tier ladder is to
 * mean anything under weather. At 0.6 the top tier was lost about a third of
 * the time and tier 3 two times in three, which read as the ladder buying too
 * little; a half puts tier 5 at about one in seven and leaves tier 3 a coin
 * flip, so the camp is gone, the village is gutted and the town mostly stands.
 * NOT LOWER: 0.4 would put tier 5 near 5%, which is shelter shading into
 * immunity.
 *
 * GEOMETRIC RATHER THAN LINEAR, deliberately: a linear scale over six tiers
 * either bottoms out at zero (immunity, and a tier-5 town becomes a place
 * cyclones cannot touch) or barely separates the ends. Each step buying the
 * same PROPORTION of survival is also the shape the tier ladder itself has —
 * every step costs the same three generations (./tiers.ts).
 */
export const STRUCTURES_WIND_TIER_RESISTANCE = 0.5;

/**
 * The demolition chance for one building this event, clamped to a probability.
 *
 * CLAMPED for flora's reason (its `windEffectChance`): `severity ×
 * durationSeconds` passes 1 as soon as an emitter accounts for more than a
 * second at full strength, and a probability above 1 is simply certainty —
 * throwing there would take this plugin out of the world over an emitter's
 * pacing decision.
 */
export function windDemolishChance(
  severity: number,
  durationSeconds: number,
  tier: number,
): number {
  const chance =
    severity *
    durationSeconds *
    STRUCTURES_WIND_DEMOLISH_CHANCE_PER_SEVERITY_SECOND *
    Math.pow(STRUCTURES_WIND_TIER_RESISTANCE, tier);
  return chance > 1 ? 1 : chance;
}
