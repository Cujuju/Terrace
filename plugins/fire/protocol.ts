export const FIRE_PLUGIN_NAME = 'fire';

export const FIRE_IGNITE_MESSAGE = 'ignite';

export function parseIgnitePayload(payload: unknown): { x: number; y: number } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const request = payload as { x?: unknown; y?: unknown };
  const { x, y } = request;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || y < 0 || x >= FIRE_CELL_KEY_STRIDE || y >= FIRE_CELL_KEY_STRIDE) return null;
  return { x, y };
}

export const FIRE_FIRES_MESSAGE = 'fires';

export const FIRE_CHANGES_MESSAGE = 'changes';

export const FIRE_CELL_CAP = 2000;

export const FIRE_FIXED_POINT_SCALE = 10;

export const FIRE_CELL_KEY_STRIDE = 65536;

export function fireKey(x: number, y: number): number {
  return y * FIRE_CELL_KEY_STRIDE + x;
}

export function fireCellOf(key: number): { x: number; y: number } {
  return { x: key % FIRE_CELL_KEY_STRIDE, y: Math.floor(key / FIRE_CELL_KEY_STRIDE) };
}

export interface FireCellState {
  readonly x: number;
  readonly y: number;
  readonly fuelHeight: number;
  readonly ageSeconds: number;
  readonly burnSeconds: number;
}

export const FIRE_IGNITION_FRACTION = 0.1;

export const FIRE_DECAY_FRACTION = 0.35;

export function fireIntensity(ageSeconds: number, burnSeconds: number): number {
  if (burnSeconds <= 0) return 0;
  if (ageSeconds <= 0 || ageSeconds >= burnSeconds) return 0;

  const progress = ageSeconds / burnSeconds;
  if (progress < FIRE_IGNITION_FRACTION) return progress / FIRE_IGNITION_FRACTION;

  const decayBegins = 1 - FIRE_DECAY_FRACTION;
  if (progress > decayBegins) return (1 - progress) / FIRE_DECAY_FRACTION;

  return 1;
}

export function isBurnedOut(ageSeconds: number, burnSeconds: number): boolean {
  return ageSeconds >= burnSeconds;
}

function toFixed(value: number): number {
  return Math.max(0, Math.round(value * FIRE_FIXED_POINT_SCALE));
}

function fromFixed(value: number): number {
  return value / FIRE_FIXED_POINT_SCALE;
}

export const FIRE_WIRE_STRIDE = 5;

export function packFires(fires: Iterable<FireCellState>): number[] {
  const packed: number[] = [];
  for (const fire of fires) {
    packed.push(fire.x, fire.y, toFixed(fire.fuelHeight), toFixed(fire.ageSeconds), toFixed(fire.burnSeconds));
  }
  return packed;
}

function isWireInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < FIRE_CELL_KEY_STRIDE
  );
}

export function parseFires(value: unknown): FireCellState[] | null {
  if (!Array.isArray(value)) return null;

  const fires: FireCellState[] = [];
  for (let i = 0; i + FIRE_WIRE_STRIDE - 1 < value.length; i += FIRE_WIRE_STRIDE) {
    if (fires.length >= FIRE_CELL_CAP) break;
    const [x, y, height, age, burn] = value.slice(i, i + FIRE_WIRE_STRIDE);
    if (!isWireInteger(x) || !isWireInteger(y)) continue;
    if (!isWireInteger(height) || !isWireInteger(age) || !isWireInteger(burn)) continue;
    if (burn <= 0) continue;
    fires.push({
      x,
      y,
      fuelHeight: fromFixed(height),
      ageSeconds: fromFixed(age),
      burnSeconds: fromFixed(burn),
    });
  }
  return fires;
}

export function packCells(cells: Iterable<{ readonly x: number; readonly y: number }>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

export function parseCells(value: unknown): Array<{ x: number; y: number }> | null {
  if (!Array.isArray(value)) return null;

  const cells: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= FIRE_CELL_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isWireInteger(x) || !isWireInteger(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

export const FIRE_BURNED_EVENT = 'burned';

export const FIRE_IGNITED_EVENT = 'ignited';

export const FIRE_IGNITED_STRIDE = 2;

export interface FireIgnitedPayload {
  readonly ignited: readonly number[];
}

export const FIRE_CELLS_BURNED_OUT_EVENT = 'cellsBurnedOut';

export const FIRE_CELLS_BURNED_OUT_STRIDE = 2;

export interface FireCellsBurnedOutPayload {
  readonly cells: readonly number[];
}

export interface FireFiresPayload {
  readonly fires: readonly number[];
}

export interface FireChangesPayload {
  readonly ignited: readonly number[];
  readonly extinguished: readonly number[];
}

export function parseFiresPayload(payload: unknown): FireCellState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parseFires((payload as { fires?: unknown }).fires);
}

export function parseChangesPayload(
  payload: unknown,
): { ignited: FireCellState[]; extinguished: Array<{ x: number; y: number }> } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { ignited?: unknown; extinguished?: unknown };
  const ignited = parseFires(message.ignited ?? []);
  const extinguished = parseCells(message.extinguished ?? []);
  if (ignited === null || extinguished === null) return null;
  return { ignited, extinguished };
}

export const FIRE_ENTITIES_MESSAGE = 'entities';

export const FIRE_ENTITY_CAP = 48;

export interface FireEntityState {
  readonly sourceName: string;
  readonly id: number;
  readonly ageSeconds: number;
  readonly burnSeconds: number;
}

export const FIRE_FLAME_INSTANCE_CAP = FIRE_CELL_CAP + FIRE_ENTITY_CAP;

export function fireEntityKey(sourceName: string, id: number): string {
  return `${sourceName}#${id}`;
}

export const FIRE_ENTITY_WIRE_STRIDE = 4;

export function packEntities(entities: Iterable<FireEntityState>): {
  sources: string[];
  entities: number[];
} {
  const sources: string[] = [];
  const packed: number[] = [];
  for (const entity of entities) {
    let index = sources.indexOf(entity.sourceName);
    if (index === -1) index = sources.push(entity.sourceName) - 1;
    packed.push(index, entity.id, toFixed(entity.ageSeconds), toFixed(entity.burnSeconds));
  }
  return { sources, entities: packed };
}

export function parseEntitiesPayload(payload: unknown): FireEntityState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { sources, entities } = payload as { sources?: unknown; entities?: unknown };
  if (!Array.isArray(sources) || !Array.isArray(entities)) return null;
  for (const name of sources) {
    if (typeof name !== 'string') return null;
  }

  const parsed: FireEntityState[] = [];
  for (let i = 0; i + FIRE_ENTITY_WIRE_STRIDE - 1 < entities.length; i += FIRE_ENTITY_WIRE_STRIDE) {
    if (parsed.length >= FIRE_ENTITY_CAP) break;
    const [sourceIndex, id, age, burn] = entities.slice(i, i + FIRE_ENTITY_WIRE_STRIDE);
    if (!isWireInteger(sourceIndex) || sourceIndex >= sources.length) continue;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) continue;
    if (!isWireInteger(age) || !isWireInteger(burn)) continue;
    if (burn <= 0) continue;
    parsed.push({
      sourceName: sources[sourceIndex] as string,
      id,
      ageSeconds: fromFixed(age),
      burnSeconds: fromFixed(burn),
    });
  }
  return parsed;
}
