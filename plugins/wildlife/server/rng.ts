// Shared randomness helpers.
//
// A separate file rather than a home in movement.ts or population.ts: those two
// already depend on each other (movement.ts reads WildlifeEntity and
// livingEntities from population.ts), so putting a helper either of them needs
// in the OTHER would invent a dependency cycle. flocks.ts needs it too. This
// file depends on nothing in the plugin, so everything can depend on it.

/**
 * A uniform random value in [-magnitude, +magnitude).
 *
 * The "double, then re-centre" shape (`Math.random() * 2 - 1`) used to appear
 * independently at eight call sites across this plugin — wander noise, group
 * scatter, flock aim spread, bird scatter, bird turn noise — each a candidate
 * for a transcription slip (dropping the `- 1` would silently bias every use
 * toward positive values, with no seeded test to catch it, since this plugin
 * deliberately runs on unseeded RNG). One named helper makes the shape
 * impossible to get wrong at more than one of them.
 */
export function randomSigned(magnitude: number): number {
  return (Math.random() * 2 - 1) * magnitude;
}
