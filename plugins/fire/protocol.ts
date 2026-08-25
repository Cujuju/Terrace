// fire — the wire contract between the plugin's two halves.
//
// Imported by BOTH server/ and client/, so it stays dependency-free (no three,
// no node builtins) and side-effect-free, exactly as flora's protocol.ts does.
// The hosts prefix `fire:` on the wire in both directions, so every type here
// is the UN-namespaced form.
//
// ─────────────────────────────────────────────────────────────────────────────
// A FIRE IS SENT ONCE, NOT STREAMED.
//
// A burning cell's whole visible behaviour — catching, roaring, dying down — is
// a function of ONE number that only ever counts up: how long it has been
// alight. So the server does not broadcast intensity per tick. It sends a fire
// ONCE, with its age at the moment of sending and how long it has to burn, and
// both halves derive everything else from `fireIntensity` below.
//
// That makes fire cheap in exactly the way flora is cheap, for the same reason:
// re-transmitting a value the receiver can compute is the one cost worth
// designing out. The client's own clock advances the age between messages; the
// snapshot on join and the keepalive re-anchor it, so drift is bounded by the
// keepalive rather than accumulating.
//
// THE ARITHMETIC at the shipped FIRE_CELL_CAP of 400. A fire on the wire is
// five integers — cell x, cell y, and three decisecond/decimetre fixed-point
// values, all under 65536 and therefore ≤3 B each under msgpack:
//
//   full snapshot   400 × ~11 B                 = 4.4 KB, at join and keepalive
//   ignition delta  a spreading front, ~10/s    = ~110 B/s ≈ 0.9 kbit/s
//
// which is a third of what flora spends, for a thing that only exists while
// something is actually on fire.
//
// FIXED POINT, NOT FLOATS. Seconds and world units both ride as tenths
// (`FIRE_FIXED_POINT_SCALE`). msgpack encodes a float64 in 9 B and a small
// integer in 1–3, and a tenth of a second is finer than a frame boundary
// matters for something that burns for the better part of a minute.
// ─────────────────────────────────────────────────────────────────────────────

/** Plugin name on both sides. Also the message namespace. */
export const FIRE_PLUGIN_NAME = 'fire';

/**
 * Client → server, "light this cell" (`fire:ignite`), payload `{x, y}`.
 *
 * A MESSAGE, NOT A SCULPT INTENT. The intent pipeline is for edits to the
 * heightmap — it validates a brush, prices terrain and reconciles a client's
 * predicted terrain (design §3.5, and server/src/intent/pipeline.ts). Lighting a
 * fire moves no ground and predicts nothing: the client asks, the server answers
 * by broadcasting a fire or by staying silent, which is exactly what a plugin
 * message is for.
 */
export const FIRE_IGNITE_MESSAGE = 'ignite';

/**
 * Parses a `fire:ignite` request. Null for anything that is not two
 * non-negative integers — the client is untrusted here in a way the server
 * halves of this protocol are not.
 */
export function parseIgnitePayload(payload: unknown): { x: number; y: number } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const request = payload as { x?: unknown; y?: unknown };
  const { x, y } = request;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || y < 0 || x >= FIRE_CELL_KEY_STRIDE || y >= FIRE_CELL_KEY_STRIDE) return null;
  return { x, y };
}

/**
 * Server → client, everything currently alight (`fire:fires`). Sent to a
 * joining player and on the keepalive cadence. Replaces the receiver's whole
 * set.
 */
export const FIRE_FIRES_MESSAGE = 'fires';

/**
 * Server → client, what changed (`fire:changes`). Applied on top of whatever
 * the receiver already has.
 */
export const FIRE_CHANGES_MESSAGE = 'changes';

/**
 * Hard ceiling on cells alight at once.
 *
 * 400 is a wire-and-play number, three ways:
 *
 *   * WIRE — 400 × 11 B = 4.4 KB for the snapshot, well inside the design's
 *     "tens of KB" join budget even stacked on flora's 18 KB.
 *   * DRAW — the client draws every fire from one instanced flame renderer
 *     (client/flames/), so 400 fires are a fixed handful of draw calls; the
 *     number that would actually hurt is the pooled fire-light count, which is
 *     capped separately and far lower.
 *   * PLAY — 400 burning cells is a catastrophe a player can still fight with
 *     a firebreak. Uncapped, a dry 512² world could put 3000 trees alight at
 *     once, which is not a harder version of the same event; it is a different
 *     event, and not one anybody chose to design.
 *
 * When the cap binds, further ignitions simply fail. A fire that cannot start
 * is invisible; a fire that starts and then blows the frame is not.
 */
export const FIRE_CELL_CAP = 400;

/**
 * Fixed-point scale for the seconds and world-unit values on the wire: tenths.
 * See the header — this is a bandwidth decision, and a tenth of a second is
 * below the resolution at which a minute-long burn can be perceived.
 */
export const FIRE_FIXED_POINT_SCALE = 10;

/** Cell → integer key, and back. Identical in shape to flora's treeKey. */
export const FIRE_CELL_KEY_STRIDE = 65536;

export function fireKey(x: number, y: number): number {
  return y * FIRE_CELL_KEY_STRIDE + x;
}

export function fireCellOf(key: number): { x: number; y: number } {
  return { x: key % FIRE_CELL_KEY_STRIDE, y: Math.floor(key / FIRE_CELL_KEY_STRIDE) };
}

/**
 * One cell alight, as it travels and as both halves hold it.
 *
 * `ageSeconds` is what it was AT THE MOMENT OF SENDING; the receiver advances
 * it with its own clock. `burnSeconds` is the whole life of this fire, fixed at
 * ignition from whatever fuel was there.
 */
export interface FireCellState {
  readonly x: number;
  readonly y: number;
  /** How tall the burning thing is, in world units — sizes the flame. */
  readonly fuelHeight: number;
  readonly ageSeconds: number;
  readonly burnSeconds: number;
}

/**
 * Fraction of a fire's life spent catching — climbing from nothing to full.
 *
 * A fire that appears at full size the instant it is lit reads as a switch
 * being thrown. A tenth of the burn is long enough to see it take hold (≈2 s of
 * a 20 s tree) and short enough that the ignition still feels like an event.
 */
export const FIRE_IGNITION_FRACTION = 0.1;

/**
 * Fraction of a fire's life spent dying — falling from full back to nothing.
 *
 * Longer than the ignition, deliberately and asymmetrically: fires catch faster
 * than they die, and the long tail is what leaves a stand of trees guttering
 * down together instead of all going out at one instant.
 */
export const FIRE_DECAY_FRACTION = 0.35;

/**
 * How fiercely a fire of this age is burning, 0…1 — the ONE derived number the
 * whole feature is a function of (see the header).
 *
 * Shared rather than restated on each side because the two halves must agree:
 * the server prices spread and damage by it, the client sizes and brightens its
 * flame by it, and a client whose fire visibly roars while the server thinks it
 * is guttering is the exact drift this file exists to prevent.
 *
 * Outside the fire's life it is 0 — before ignition and after burnout alike, so
 * a caller that is late reading a dead fire gets "not burning" rather than a
 * negative or a wrapped value.
 */
export function fireIntensity(ageSeconds: number, burnSeconds: number): number {
  if (burnSeconds <= 0) return 0;
  if (ageSeconds <= 0 || ageSeconds >= burnSeconds) return 0;

  const progress = ageSeconds / burnSeconds;
  if (progress < FIRE_IGNITION_FRACTION) return progress / FIRE_IGNITION_FRACTION;

  const decayBegins = 1 - FIRE_DECAY_FRACTION;
  if (progress > decayBegins) return (1 - progress) / FIRE_DECAY_FRACTION;

  return 1;
}

/** True once a fire has burned through its fuel. */
export function isBurnedOut(ageSeconds: number, burnSeconds: number): boolean {
  return ageSeconds >= burnSeconds;
}

// ────────────────────────────────────────────────────────────────────────────
// Packing
//
// Flat `[x, y, height, age, burn, …]` rather than an array of objects, for
// flora's reason: msgpack re-sends every key string of every object, so five
// named fields cost ~30 B where five integers cost ~11.
// ────────────────────────────────────────────────────────────────────────────

function toFixed(value: number): number {
  return Math.max(0, Math.round(value * FIRE_FIXED_POINT_SCALE));
}

function fromFixed(value: number): number {
  return value / FIRE_FIXED_POINT_SCALE;
}

/** How many integers one fire occupies in the flat wire form. */
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

/**
 * Defensive parse of the flat form, to flora's rule: a malformed entry is
 * dropped on its own, a payload that is not an array at all yields null so the
 * caller can ignore the message whole, and the count is capped at FIRE_CELL_CAP
 * so a broken or hostile payload cannot make the client allocate past its own
 * instance buffers.
 *
 * A fire with a zero or negative burn time is dropped too: it is already dead
 * by fireIntensity's own definition, and admitting it would put a permanently
 * invisible entry in the client's set that nothing would ever remove.
 */
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

/** Cells → the flat `[x0, y0, x1, y1, …]` form used for extinguished cells. */
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

/**
 * Plugin → plugin (`fire:burned`, via WorldApi.emitEvent), once per WILDFIRE:
 * emitted when the world stops burning, carrying how many cells that fire
 * consumed in total and where it started.
 *
 * NOT a client message. Nothing on screen changes when a fire ends — every
 * cell's own extinguishment already went out as a delta — and the audience is
 * other server plugins that think in episodes rather than in cells (the
 * chronicle writes one line per fire, not one per tree).
 */
export const FIRE_BURNED_EVENT = 'burned';

/** `fire:fires` — the receiver's whole burning set. */
export interface FireFiresPayload {
  readonly fires: readonly number[];
}

/**
 * `fire:changes` — fires that started (full five-integer form) and cells that
 * stopped burning (two integers each).
 *
 * The two halves are shaped differently on purpose: an ignition has to carry
 * the fire's whole life, and an extinguishment carries nothing but "the fire
 * that was at this cell is over" — whether it burned out, was rained on or had
 * the ground dug from under it is a distinction the renderer has no use for.
 */
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
  // An absent half is an empty half, not a malformed message — flora's rule, and
  // it matters more here: a delta that only extinguishes is an ordinary message.
  const ignited = parseFires(message.ignited ?? []);
  const extinguished = parseCells(message.extinguished ?? []);
  if (ignited === null || extinguished === null) return null;
  return { ignited, extinguished };
}

// ────────────────────────────────────────────────────────────────────────────
// FIRE THAT WALKS
//
// A cell fire is anchored to the ground and everything above derives from that.
// A creature is not: it catches, it keeps moving, and it dies where it happens
// to be standing when its time runs out. So a burning ENTITY is a second kind
// of fire, and it is a genuinely different thing rather than a cell fire with a
// moving position — which is why it gets its own message rather than a sixth
// integer on the old one.
//
// WHAT TRAVELS, AND WHAT POINTEDLY DOES NOT: the position. It is not on this
// wire at all. The owning plugin is already drawing the creature, interpolated
// its own way, sixty times a second; the flame is drawn at THAT pose, read from
// the owner through the host's neutral mover lookup (ClientPluginCtx.
// publishMovers). Sending a position here would mean two independent
// interpolations of one animal, and the flame would slide off the body — the
// same failure as a river modelled beside its own valley instead of from it.
//
// THE WHOLE SET, EVERY TIME, rather than deltas. A burning herd is a handful of
// entities where a wildfire is hundreds of cells, so the saving a delta would
// buy is a few bytes — and a full set cannot leave a client holding a fire the
// server has forgotten about, which is worth more than the bytes.
// ────────────────────────────────────────────────────────────────────────────

/** Server → client, the whole set of burning entities (`fire:entities`). */
export const FIRE_ENTITIES_MESSAGE = 'entities';

/**
 * How many things may be alight AT ONCE, over and above the burning cells.
 *
 * Far below FIRE_CELL_CAP and for a different reason: every burning entity
 * costs a per-frame pose lookup through its owner and a flame instance, and a
 * world where sixty animals are alight at once is not a harder version of a
 * herd catching — it is a stampede nobody designed. When the cap binds, further
 * ignitions simply fail, exactly as they do for cells.
 */
export const FIRE_ENTITY_CAP = 48;

/**
 * One burning thing, as it travels and as both halves hold it.
 *
 * `sourceName` is the OWNING PLUGIN's name — the same by-name addressing the
 * server-side fuel registry and the client-side mover lookup both use, so the
 * client can ask the right plugin where this creature is without knowing what
 * kind of creature it is.
 */
export interface FireEntityState {
  readonly sourceName: string;
  readonly id: number;
  /** Flame size in world units, as ./server/fuel.ts's CellFuel.height. */
  readonly fuelHeight: number;
  /** Age at the moment of sending; the receiver advances it with its own clock. */
  readonly ageSeconds: number;
  /** The whole life of this fire, fixed when it caught. */
  readonly burnSeconds: number;
}

/**
 * How many flames a renderer must be able to draw at once.
 *
 * THE SUM, not either cap, because the two kinds of fire share one instanced
 * mesh (client/flames/) and a pool sized to the cells alone would silently drop
 * the burning animals off the end of a full wildfire — the flames that are
 * hardest to see missing and the ones a player is most likely to be watching.
 */
export const FIRE_FLAME_INSTANCE_CAP = FIRE_CELL_CAP + FIRE_ENTITY_CAP;

/** Identity of one burning entity: its owner's name and its owner's id. */
export function fireEntityKey(sourceName: string, id: number): string {
  return `${sourceName}#${id}`;
}

/** How many integers one burning entity occupies in the flat wire form. */
export const FIRE_ENTITY_WIRE_STRIDE = 5;

/**
 * Packs the set as a SOURCE TABLE plus flat integers — `[sourceIndex, id,
 * height, age, burn, …]`.
 *
 * The table exists because the one non-integer a burning entity carries is its
 * owner's name, and repeating "wildlife" once per animal would cost more than
 * everything else on this wire put together. There are at most a handful of
 * distinct sources in any world.
 */
export function packEntities(entities: Iterable<FireEntityState>): {
  sources: string[];
  entities: number[];
} {
  const sources: string[] = [];
  const packed: number[] = [];
  for (const entity of entities) {
    let index = sources.indexOf(entity.sourceName);
    if (index === -1) index = sources.push(entity.sourceName) - 1;
    packed.push(
      index,
      entity.id,
      toFixed(entity.fuelHeight),
      toFixed(entity.ageSeconds),
      toFixed(entity.burnSeconds),
    );
  }
  return { sources, entities: packed };
}

/**
 * Defensive parse, to the same rule as parseFires: a malformed entry is dropped
 * on its own, a payload that is not the right shape at all yields null so the
 * caller can ignore the message whole, and the count is capped.
 */
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
    const [sourceIndex, id, height, age, burn] = entities.slice(i, i + FIRE_ENTITY_WIRE_STRIDE);
    if (!isWireInteger(sourceIndex) || sourceIndex >= sources.length) continue;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) continue;
    if (!isWireInteger(height) || !isWireInteger(age) || !isWireInteger(burn)) continue;
    if (burn <= 0) continue;
    parsed.push({
      sourceName: sources[sourceIndex] as string,
      id,
      fuelHeight: fromFixed(height),
      ageSeconds: fromFixed(age),
      burnSeconds: fromFixed(burn),
    });
  }
  return parsed;
}
