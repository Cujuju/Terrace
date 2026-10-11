export type GradientStop = { readonly name: string; readonly hex: number };

export type TerrainGradient = {
  readonly name: string;
  readonly seaColumn: readonly GradientStop[];
  readonly basalt: readonly GradientStop[];
  readonly obsidian: readonly GradientStop[];
  readonly lava: readonly GradientStop[];
  readonly land: readonly GradientStop[];
  readonly cliffRockTint: GradientStop;
  readonly seabedRimTint: GradientStop;
};

export const EARTHLIKE_GRADIENT: TerrainGradient = {
  name: 'earthlike',
  seaColumn: [
    { name: 'surf', hex: 0x6a7f68 },
    { name: 'lagoon', hex: 0x50705d },
    { name: 'shelf', hex: 0x3a5b52 },
    { name: 'slope', hex: 0x274347 },
    { name: 'sublittoral', hex: 0x1f3a44 },
    { name: 'twilight', hex: 0x183243 },
    { name: 'midnight', hex: 0x122a40 },
    { name: 'bathyal', hex: 0x0d233c },
    { name: 'abyssal', hex: 0x0a1d37 },
    { name: 'hadal-lip', hex: 0x081931 },
    { name: 'hadal', hex: 0x07152b },
    { name: 'hadal-deep', hex: 0x061226 },
    { name: 'trench', hex: 0x050f21 },
    { name: 'trench-deep', hex: 0x040d1d },
    { name: 'trench-dark', hex: 0x040b19 },
    { name: 'trench-floor', hex: 0x030916 },
    { name: 'column-floor', hex: 0x030813 },
  ],
  basalt: [
    { name: 'crust', hex: 0x3a3b41 },
    { name: 'basalt', hex: 0x323338 },
    { name: 'basalt-deep', hex: 0x2a2b2f },
    { name: 'basalt-floor', hex: 0x232427 },
  ],
  obsidian: [
    { name: 'obsidian', hex: 0x1a1820 },
    { name: 'obsidian-deep', hex: 0x121017 },
    { name: 'obsidian-floor', hex: 0x0b0a10 },
  ],
  lava: [{ name: 'lava', hex: 0xf25c1a }],
  land: [
    { name: 'beach', hex: 0xd9c89a },
    { name: 'dune', hex: 0xc0a468 },
    { name: 'dry-earth', hex: 0x96774a },
    { name: 'meadow', hex: 0x8fc25a },
    { name: 'grass', hex: 0x69a244 },
    { name: 'deep-grass', hex: 0x467a33 },
    { name: 'scree', hex: 0x736f61 },
    { name: 'rock', hex: 0x908c80 },
    { name: 'pale-rock', hex: 0xb3aea2 },
    { name: 'snow', hex: 0xf2f4f6 },
  ],
  cliffRockTint: { name: 'cliff-rock', hex: 0x6b5a49 },
  seabedRimTint: { name: 'seabed-rim', hex: 0x9fd4c8 },
};

export const ACTIVE_TERRAIN_GRADIENT: TerrainGradient = EARTHLIKE_GRADIENT;
