import {
  CHUNK_SIZE,
  DAY_LENGTH_SECONDS,
  dayOfSimMillis,
  weekdayOf,
  worldAgeDays,
} from '@terrace/shared';
import type {
  PersistenceSlice,
  SliceLoadOutcome,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  CHRONICLE_APPEND_MESSAGE,
  CHRONICLE_LOG_MESSAGE,
  CHRONICLE_MAX_ENTRIES,
  CHRONICLE_PLUGIN_NAME,
  packEntries,
  parseEntries,
  type ChronicleEntry,
} from '../protocol.ts';
import { placeName } from './names.ts';
import { settlementRace } from './races.ts';
import {
  CHRONICLE_CALAMITY_MIN_HOMES,
  calamityLine,
  firstTierLine,
  godsHandLine,
  monsterArrivedLine,
  monsterDepartedLine,
  mudslideLine,
  parseFireBurned,
  parseMonsterEvent,
  parseMudslideFlow,
  parseRelicCollected,
  parseStructuresChanges,
  relicLine,
  seededLine,
  wildfireLine,
  type EventCell,
} from './saga.ts';

export const CHRONICLE_SECONDS_PER_DAY = DAY_LENGTH_SECONDS;

const LEGACY_CHRONICLE_SECONDS_PER_DAY = 600;

export const CHRONICLE_SLICE_VERSION = 2;

export const GENESIS_TEXT = 'The world was young, and its history unwritten.';

let entries: ChronicleEntry[] = [];
let worldSimMillis = 0;

let sagaGenesisMillis = 0;
let tierFirsts = new Set<number>();
let monsterKindsSeen = new Set<string>();
let toldToday = new Set<string>();
let toldDay = -1;

let restored: {
  entries: ChronicleEntry[];
  simMillis: number;
  tierFirsts: number[];
  monsterKinds: string[];
  toldDay: number;
  toldToday: string[];
} | null = null;

const MILLISECONDS_PER_SECOND = 1000;

function migrateDay(legacyDay: number): number {
  return Math.floor(
    (legacyDay * LEGACY_CHRONICLE_SECONDS_PER_DAY) / CHRONICLE_SECONDS_PER_DAY,
  );
}

function sagaAgeMillis(): number {
  return Math.max(0, worldSimMillis - sagaGenesisMillis);
}

function currentDay(): number {
  return worldAgeDays(worldSimMillis, sagaGenesisMillis);
}

function genesisDay(): number {
  return dayOfSimMillis(sagaGenesisMillis);
}

function placeOf(cell: EventCell): string {
  return placeName(Math.floor(cell.x / CHUNK_SIZE), Math.floor(cell.y / CHUNK_SIZE));
}

function chunkKeyOf(cell: EventCell): string {
  return `${Math.floor(cell.x / CHUNK_SIZE)},${Math.floor(cell.y / CHUNK_SIZE)}`;
}

function alreadyToldToday(key: string): boolean {
  const day = currentDay();
  if (day !== toldDay) {
    toldDay = day;
    toldToday = new Set();
  }
  if (toldToday.has(key)) return true;
  toldToday.add(key);
  return false;
}

function write(world: WorldApi, texts: readonly string[]): void {
  if (texts.length === 0) return;
  const day = currentDay();
  const added = texts.map((text): ChronicleEntry => ({ day, text }));
  entries.push(...added);
  if (entries.length > CHRONICLE_MAX_ENTRIES) {
    entries = entries.slice(entries.length - CHRONICLE_MAX_ENTRIES);
  }
  world.broadcast(CHRONICLE_APPEND_MESSAGE, {
    entries: packEntries(added),
    genesisDay: genesisDay(),
  });
}

function groupByChunk(cells: readonly EventCell[]): Map<string, EventCell[]> {
  const groups = new Map<string, EventCell[]>();
  for (const cell of cells) {
    const key = chunkKeyOf(cell);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [cell]);
    else group.push(cell);
  }
  return groups;
}

function onStructuresChanges(world: WorldApi, payload: unknown): void {
  const event = parseStructuresChanges(payload);
  if (event === null) return;

  const lines: string[] = [];

  if (event.seeded.length > 0) {
    const anchor = event.seeded[0];
    if (!alreadyToldToday(`seed:${chunkKeyOf(anchor)}`)) {
      lines.push(seededLine(settlementRace(anchor.x, anchor.y), placeOf(anchor)));
    }
  }

  const newTiers = [...new Set(
    event.upgraded.map((cell) => cell.tier).filter((tier) => tier >= 1 && !tierFirsts.has(tier)),
  )].sort((a, b) => a - b);
  for (const tier of newTiers) {
    tierFirsts.add(tier);
    const where = event.upgraded.find((cell) => cell.tier === tier);
    if (where !== undefined) {
      lines.push(firstTierLine(settlementRace(where.x, where.y), tier, placeOf(where)));
    }
  }

  for (const [key, cells] of groupByChunk(event.died)) {
    if (cells.length < CHRONICLE_CALAMITY_MIN_HOMES) continue;
    const kind = event.cause === 'sculpt' ? 'hand' : 'calamity';
    if (alreadyToldToday(`${kind}:${key}`)) continue;
    const race = settlementRace(cells[0].x, cells[0].y);
    lines.push(
      event.cause === 'sculpt'
        ? godsHandLine(cells.length, race, placeOf(cells[0]))
        : calamityLine(cells.length, race, placeOf(cells[0])),
    );
  }

  write(world, lines);
}

function onRelicCollected(world: WorldApi, payload: unknown): void {
  const event = parseRelicCollected(payload);
  if (event === null) return;
  write(world, [relicLine(event.player, event.label)]);
}

function onMonsterArrived(world: WorldApi, payload: unknown): void {
  const event = parseMonsterEvent(payload);
  if (event === null) return;
  if (alreadyToldToday(`beast:${event.kind}`)) return;
  const isFirstEver = !monsterKindsSeen.has(event.kind);
  monsterKindsSeen.add(event.kind);
  write(world, [monsterArrivedLine(event.kind, placeOf(event), isFirstEver)]);
}

export const CHRONICLE_WILDFIRE_MIN_CELLS = 8;

function onFireBurned(world: WorldApi, payload: unknown): void {
  const event = parseFireBurned(payload);
  if (event === null) return;
  if (event.consumed < CHRONICLE_WILDFIRE_MIN_CELLS) return;
  if (alreadyToldToday(`fire:${chunkKeyOf(event)}`)) return;
  write(world, [wildfireLine(event.consumed, placeOf(event))]);
}

export const CHRONICLE_MUDSLIDE_MIN_CELLS = 16;

function onMudslideFlow(world: WorldApi, payload: unknown): void {
  const event = parseMudslideFlow(payload);
  if (event === null) return;
  if (event.cellCount < CHRONICLE_MUDSLIDE_MIN_CELLS) return;
  const where = { x: event.headX, y: event.headY };
  if (alreadyToldToday(`mudslide:${chunkKeyOf(where)}`)) return;
  write(world, [mudslideLine(event.cellCount, placeOf(where))]);
}

function onMonsterDeparted(world: WorldApi, payload: unknown): void {
  const event = parseMonsterEvent(payload);
  if (event === null) return;
  write(world, [monsterDepartedLine(event.kind)]);
}

function selfDescribedSliceVersion(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const version = (data as { v?: unknown }).v;
  return Number.isSafeInteger(version) ? (version as number) : undefined;
}

const persistence: PersistenceSlice = {
  save(): unknown {
    return {
      v: CHRONICLE_SLICE_VERSION,
      simMillis: sagaAgeMillis(),
      entries: packEntries(entries),
      tierFirsts: [...tierFirsts],
      monsterKinds: [...monsterKindsSeen],
      toldDay,
      toldToday: [...toldToday],
    };
  },
  version: CHRONICLE_SLICE_VERSION,
  load(data: unknown, fromVersion: number): SliceLoadOutcome {
    if ((selfDescribedSliceVersion(data) ?? fromVersion) > CHRONICLE_SLICE_VERSION) {
      return 'refuse';
    }
    if (typeof data !== 'object' || data === null) return undefined;
    const slice = data as {
      v?: unknown;
      simMillis?: unknown;
      entries?: unknown;
      tierFirsts?: unknown;
      monsterKinds?: unknown;
      toldDay?: unknown;
      toldToday?: unknown;
    };
    const legacy = slice.v === 1;
    if (slice.v !== CHRONICLE_SLICE_VERSION && !legacy) return undefined;

    const parsedEntries = parseEntries({ entries: slice.entries });
    const millis =
      Number.isInteger(slice.simMillis) && (slice.simMillis as number) >= 0
        ? (slice.simMillis as number)
        : 0;
    restored = {
      entries: (parsedEntries ?? []).map((entry) =>
        legacy ? { ...entry, day: migrateDay(entry.day) } : entry,
      ),
      simMillis: millis,
      tierFirsts: Array.isArray(slice.tierFirsts)
        ? slice.tierFirsts.filter((t): t is number => Number.isInteger(t))
        : [],
      monsterKinds: Array.isArray(slice.monsterKinds)
        ? slice.monsterKinds.filter((k): k is string => typeof k === 'string')
        : [],
      toldDay: Number.isInteger(slice.toldDay)
        ? legacy
          ? migrateDay(slice.toldDay as number)
          : (slice.toldDay as number)
        : -1,
      toldToday: Array.isArray(slice.toldToday)
        ? slice.toldToday.filter((k): k is string => typeof k === 'string')
        : [],
    };
    return undefined;
  },
};

export const plugin: TerracePlugin = {
  name: CHRONICLE_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    worldSimMillis = world.simMillis;
    if (restored !== null) {
      entries = restored.entries;
      tierFirsts = new Set(restored.tierFirsts);
      monsterKindsSeen = new Set(restored.monsterKinds);
      toldDay = restored.toldDay;
      toldToday = new Set(restored.toldToday);
      sagaGenesisMillis = Math.min(world.genesisMillis, world.simMillis - restored.simMillis);
      restored = null;
      return;
    }
    sagaGenesisMillis = world.genesisMillis;
    write(world, [GENESIS_TEXT]);
  },

  onTick(world: WorldApi, _dt: number): void {
    worldSimMillis = world.simMillis;
  },

  onWorldEvent(world: WorldApi, event: string, payload: unknown): void {
    switch (event) {
      case 'structures:changes':
        onStructuresChanges(world, payload);
        break;
      case 'relics:collected':
        onRelicCollected(world, payload);
        break;
      case 'monsters:arrived':
        onMonsterArrived(world, payload);
        break;
      case 'fire:burned':
        onFireBurned(world, payload);
        break;
      case 'monsters:departed':
        onMonsterDeparted(world, payload);
        break;
      case 'mudslides:flow':
        onMudslideFlow(world, payload);
        break;
      default:
        break;
    }
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    world.sendTo(player.id, CHRONICLE_LOG_MESSAGE, {
      entries: packEntries(entries),
      genesisDay: genesisDay(),
    });
  },

  persistence,
};

export function chronicleEntries(): readonly ChronicleEntry[] {
  return entries;
}

export function chronicleSimSeconds(): number {
  return sagaAgeMillis() / MILLISECONDS_PER_SECOND;
}

export function resetChronicleState(): void {
  entries = [];
  worldSimMillis = 0;
  sagaGenesisMillis = 0;
  tierFirsts = new Set();
  monsterKindsSeen = new Set();
  toldToday = new Set();
  toldDay = -1;
  restored = null;
}
