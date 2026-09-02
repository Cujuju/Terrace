// Contract test for the weather hub's INWARD REGISTRY — written BEFORE the
// module it covers.
//
// The hub owns the world's wind and a list of the kind plugins running beside
// it. What is under test here is only the registry's contract, because that is
// what every consumer (fire's wetness, mudslides' wetness, phase 2's tornado)
// and every kind plugin depend on: a registration replaces one of the same name,
// unregistering removes exactly one, the `kind` on a living system is stamped by
// the HUB rather than trusted from the entry, wetness is a max and never exceeds
// one, a hand-off to an absent kind is a false rather than a throw, and a world
// close empties the list.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  livingSystems,
  precipitationAt,
  registerSkyKind,
  resetSkyRegistry,
  spawnSkyKind,
  type SkyKindEntry,
} from '../server/index.ts';

/** A kind entry with one disc over the origin, at the wetness asked for. */
function entry(name: string, wetness: number, overrides: Partial<SkyKindEntry> = {}): SkyKindEntry {
  return {
    name,
    cells: () => [{ x: 0, y: 0, radius: 10, intensity: wetness }],
    wetnessAt: () => wetness,
    ...overrides,
  };
}

beforeEach(() => {
  resetSkyRegistry();
});

describe('the sky-kind registry', () => {
  it('stamps the KIND on a living system from the registering name', () => {
    // Not from anything the entry says about its own cells: the hub knows who
    // registered, and a consumer filtering by kind must not be steerable by the
    // contents of a cell.
    registerSkyKind(entry('rain', 0.5));
    const living = livingSystems();
    expect(living).toHaveLength(1);
    expect(living[0]!.kind).toBe('rain');
    expect(living[0]!.radius).toBe(10);
  });

  it('replaces a registration of the same name rather than doubling it', () => {
    registerSkyKind(entry('rain', 0.5));
    registerSkyKind(entry('rain', 0.9));
    expect(livingSystems()).toHaveLength(1);
    expect(precipitationAt(0, 0)).toBe(0.9);
  });

  it('unregisters exactly the entry that registered', () => {
    const dropRain = registerSkyKind(entry('rain', 0.5));
    registerSkyKind(entry('fog', 0));
    expect(livingSystems()).toHaveLength(2);

    dropRain();
    expect(livingSystems()).toHaveLength(1);
    expect(livingSystems()[0]!.kind).toBe('fog');
    // Idempotent: a second call removes nothing else.
    dropRain();
    expect(livingSystems()).toHaveLength(1);
  });

  it('takes the STRONGEST wetness, never the sum, and clamps at one', () => {
    registerSkyKind(entry('rain', 0.4));
    registerSkyKind(entry('snow', 0.7));
    registerSkyKind(entry('fog', 0));
    expect(precipitationAt(0, 0)).toBe(0.7);

    registerSkyKind(entry('thunderstorm', 5));
    expect(precipitationAt(0, 0)).toBe(1);
  });

  it('reports zero wetness under a clear sky', () => {
    expect(precipitationAt(0, 0)).toBe(0);
  });

  it('refuses an entry that does not fit the shape, rather than trusting it', () => {
    const broken = { name: 'rain' } as unknown as SkyKindEntry;
    expect(() => registerSkyKind(broken)).toThrow();
    expect(livingSystems()).toHaveLength(0);
  });

  it('hands a spawn to a named kind, and answers false when it is absent', () => {
    let births = 0;
    registerSkyKind(entry('rain', 0.5, { spawnOne: () => { births++; return true; } }));

    expect(spawnSkyKind('rain')).toBe(true);
    expect(births).toBe(1);
    // Absent entirely, and present but unable to take one, are both false — the
    // caller loses the roll either way and must not branch on which.
    expect(spawnSkyKind('snow')).toBe(false);
    registerSkyKind(entry('fog', 0));
    expect(spawnSkyKind('fog')).toBe(false);
  });

  it('empties on reset, so a closed world leaves nothing reachable', () => {
    registerSkyKind(entry('rain', 0.5));
    resetSkyRegistry();
    expect(livingSystems()).toHaveLength(0);
    expect(precipitationAt(0, 0)).toBe(0);
    expect(spawnSkyKind('rain')).toBe(false);
  });
});
