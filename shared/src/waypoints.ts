import { isFiniteNumber } from './parse.ts';

/** Generic waypoint chains for long-range travel.
 *
 * A waypoint chain is an ordered list of cell-space goals with a cursor. A
 * mover aims at the current waypoint, and the cursor advances whenever the
 * mover comes within an arrival radius. Chains exist for one reason: a single
 * A* search cannot span a long leg inside a per-tick node budget
 * (`pathing.ts`'s trial pattern), so a coarse leg (e.g. a 256–512 cell
 * squadron leg) is subdivided into hops, each of which fits one budgeted
 * search. How each hop is ROUTED stays the caller's job — this module never
 * reads terrain, so it works for any mover on any profile.
 *
 * Group travel reduces to two helpers here, which settle the handoff's open
 * representation question: members share one point list, and each member is
 * either given the leader's cursor (leader-follow) or the leader's cursor
 * minus a fixed stagger (shared path + index offsets). Both are the same
 * `memberTargetIndex` call with a different stagger. Per-member spacing around
 * a goal (so members do not stack) is `slotOffsetForMember`, an integer-lattice
 * ring walk: deterministic, no trigonometry. Anti-collision itself stays with
 * the caller.
 *
 * Arrival is `WaypointGroupArrival`: 'all' (every member complete), 'flagship'
 * (the flagship alone releases the group), or 'any' (first member home).
 *
 * Determinism: integer arithmetic and fixed iteration order throughout. The
 * subdivision interpolates linearly with one division per coordinate; slot
 * offsets walk integer rings with a single final multiply. No randomness, no
 * wall clock, no terrain reads.
 *
 * Not yet wired to any mover: landing the chain inside a plugin's tick loop
 * (boats, pilgrims, wildlife) is follow-up work.
 */

export interface Waypoint {
  readonly x: number;
  readonly y: number;
}

export interface WaypointChain {
  readonly points: Waypoint[];
  index: number;
}

/** Default arrival radius: one cell. Matches the rejoin radius `followRoute`
 * (`steering.ts`) treats as "close enough to be on the route". */
export const WAYPOINT_ARRIVAL_RADIUS_CELLS = 1;

export function createWaypointChain(points: readonly Waypoint[]): WaypointChain {
  const copied: Waypoint[] = [];
  for (const point of points) copied.push({ x: point.x, y: point.y });
  return { points: copied, index: 0 };
}

export function waypointChainCurrent(chain: WaypointChain): Waypoint | null {
  if (chain.index < 0 || chain.index >= chain.points.length) return null;
  return chain.points[chain.index];
}

export function waypointChainRemaining(chain: WaypointChain): number {
  const remaining = chain.points.length - chain.index;
  return remaining < 0 ? 0 : remaining;
}

export function waypointChainComplete(chain: WaypointChain): boolean {
  return chain.index >= chain.points.length;
}

export function resetWaypointChain(chain: WaypointChain, index: number = 0): void {
  chain.index = Math.max(0, Math.min(Math.floor(index), chain.points.length));
}

/** Advances the cursor while the mover is within `arrivalRadiusCells` of the
 * current waypoint, so a fast step that overshoots several tight hops lands on
 * the right one. Returns true when the cursor moved. */
export function advanceWaypointChain(
  chain: WaypointChain,
  x: number,
  y: number,
  arrivalRadiusCells: number = WAYPOINT_ARRIVAL_RADIUS_CELLS,
): boolean {
  const radius = arrivalRadiusCells < 0 ? 0 : arrivalRadiusCells;
  const radiusSquared = radius * radius;
  let progressed = false;
  while (chain.index < chain.points.length) {
    const current = chain.points[chain.index];
    const dx = x - current.x;
    const dy = y - current.y;
    if (dx * dx + dy * dy > radiusSquared) break;
    chain.index++;
    progressed = true;
  }
  return progressed;
}

function chebyshevCells(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? dx : dy;
}

/** Subdivides one straight leg into hops of at most `maxLegCells` (chebyshev),
 * excluding `from` and including `to`. A coincident leg subdivides to nothing.
 * Linear interpolation in fixed order, so identical inputs give identical
 * hops. */
export function subdivideLeg(
  from: Waypoint,
  to: Waypoint,
  maxLegCells: number,
): Waypoint[] {
  const span = chebyshevCells(from.x, from.y, to.x, to.y);
  if (span <= 0) return [];
  const capped = maxLegCells <= 0 ? span : maxLegCells;
  const legs = Math.max(1, Math.ceil(span / capped));
  const hops: Waypoint[] = [];
  for (let i = 1; i <= legs; i++) {
    hops.push({
      x: from.x + ((to.x - from.x) * i) / legs,
      y: from.y + ((to.y - from.y) * i) / legs,
    });
  }
  return hops;
}

/** Expands coarse legs (e.g. squadron legs) into fine hops, starting from
 * `from`. Each leg is subdivided independently, so every emitted hop spans at
 * most `maxLegCells` and fits one budgeted route search. */
export function buildWaypointChain(
  from: Waypoint,
  legs: readonly Waypoint[],
  maxLegCells: number,
): Waypoint[] {
  const hops: Waypoint[] = [];
  let anchor: Waypoint = from;
  for (const leg of legs) {
    const part = subdivideLeg(anchor, leg, maxLegCells);
    for (const hop of part) hops.push(hop);
    anchor = leg;
  }
  return hops;
}

/** Shared-path cursor for one group member. `leaderIndex` is the leader's
 * cursor into the shared point list; `staggerWaypoints` trails behind it
 * (0 = leader-follow, N = index offsets). Clamped to the list. Returns null
 * for an empty list. */
export function memberTargetIndex(
  pointCount: number,
  leaderIndex: number,
  staggerWaypoints: number,
): number | null {
  if (pointCount <= 0) return null;
  const stagger = Math.max(0, Math.floor(staggerWaypoints));
  const target = Math.floor(leaderIndex) - stagger;
  if (target < 0) return 0;
  if (target >= pointCount) return pointCount - 1;
  return target;
}

export function memberWaypoint(
  points: readonly Waypoint[],
  leaderIndex: number,
  staggerWaypoints: number,
): Waypoint | null {
  const target = memberTargetIndex(points.length, leaderIndex, staggerWaypoints);
  if (target === null) return null;
  return points[target];
}

export interface SlotOffset {
  readonly dx: number;
  readonly dy: number;
}

/** Deterministic formation offset for `memberRank` around a shared goal, on
 * integer-lattice rings scaled by `spacingCells`. Rank 0 is the flagship at
 * the goal itself; every further rank walks square-ring perimeters in fixed
 * order (top edge, right edge, bottom edge, left edge), so members sharing one
 * chain goal fan out instead of stacking. */
export function slotOffsetForMember(memberRank: number, spacingCells: number): SlotOffset {
  const rank = Math.max(0, Math.floor(memberRank));
  if (rank === 0) return { dx: 0, dy: 0 };
  let remaining = rank;
  let ring = 1;
  for (;;) {
    const capacity = 8 * ring;
    if (remaining <= capacity) break;
    remaining -= capacity;
    ring++;
  }
  const sideLength = 2 * ring;
  const position = remaining - 1;
  const side = Math.floor(position / sideLength);
  const step = position % sideLength;
  let lx = 0;
  let ly = 0;
  if (side === 0) {
    lx = -ring + step;
    ly = -ring;
  } else if (side === 1) {
    lx = ring;
    ly = -ring + step;
  } else if (side === 2) {
    lx = ring - step;
    ly = ring;
  } else {
    lx = -ring;
    ly = ring - step;
  }
  return { dx: lx * spacingCells, dy: ly * spacingCells };
}

/** The shared goal with one member's formation offset applied. Pure
 * composition of `slotOffsetForMember` over a chain point. */
export function waypointForMember(
  goal: Waypoint,
  memberRank: number,
  spacingCells: number,
): Waypoint {
  const offset = slotOffsetForMember(memberRank, spacingCells);
  return { x: goal.x + offset.dx, y: goal.y + offset.dy };
}

export type WaypointGroupArrival = 'all' | 'flagship' | 'any';

/** Group arrival semantics over per-member completion flags in fixed order.
 * 'all' releases when every member is complete; 'flagship' when the member at
 * `flagshipIndex` is; 'any' when at least one is. An empty group never
 * arrives. */
export function groupArrived(
  completions: readonly boolean[],
  mode: WaypointGroupArrival,
  flagshipIndex: number = 0,
): boolean {
  if (completions.length === 0) return false;
  if (mode === 'flagship') {
    const index = Math.max(0, Math.min(Math.floor(flagshipIndex), completions.length - 1));
    return completions[index];
  }
  if (mode === 'any') {
    for (const complete of completions) {
      if (complete) return true;
    }
    return false;
  }
  for (const complete of completions) {
    if (!complete) return false;
  }
  return true;
}

/** Debug wire: one group's live chain geometry, for visualisation only. `anchor`
 * is where the chain was built from (usually the flagship's position at build
 * time), `hops` are the subdivided points ending at the goal, `cursor` is the
 * leader's current hop, and `members`/`spacing` let the overlay draw formation
 * slots around the goal via `waypointForMember`. Carries no authority: the
 * simulation never reads a snapshot back. */
export interface WaypointChainSnapshot {
  readonly id: number;
  readonly label: string;
  readonly anchor: Waypoint;
  readonly hops: readonly Waypoint[];
  readonly cursor: number;
  readonly members: number;
  readonly spacing: number;
}

export interface WaypointDebugFrame {
  readonly chains: readonly WaypointChainSnapshot[];
}

export const MAX_DEBUG_CHAINS_PER_FRAME = 64;

export const MAX_DEBUG_HOPS_PER_CHAIN = 64;

export const MAX_DEBUG_LABEL_LENGTH = 64;

function isDebugWaypoint(value: unknown): value is Waypoint {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as Record<string, unknown>;
  return isFiniteNumber(point.x) && isFiniteNumber(point.y);
}

function isDebugWaypointList(value: unknown, cap: number): value is Waypoint[] {
  if (!Array.isArray(value) || value.length > cap) return false;
  for (const item of value) {
    if (!isDebugWaypoint(item)) return false;
  }
  return true;
}

/** Validates an untrusted debug frame (e.g. off the plugin wire), returning a
 * deep copy or null. Bounds mirror `parseBoatsPayload`'s caps: a frame can
 * never carry more than a few dozen chains of a few dozen hops. */
export function parseWaypointDebugFrame(payload: unknown): WaypointDebugFrame | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { chains } = payload as { chains?: unknown };
  if (!Array.isArray(chains) || chains.length > MAX_DEBUG_CHAINS_PER_FRAME) return null;
  const parsed: WaypointChainSnapshot[] = [];
  for (const item of chains) {
    if (typeof item !== 'object' || item === null) return null;
    const chain = item as Record<string, unknown>;
    const { id, label, anchor, hops, cursor, members, spacing } = chain;
    if (!Number.isInteger(id) || (id as number) < 0) return null;
    if (typeof label !== 'string' || label.length > MAX_DEBUG_LABEL_LENGTH) return null;
    if (!isDebugWaypoint(anchor)) return null;
    if (!isDebugWaypointList(hops, MAX_DEBUG_HOPS_PER_CHAIN)) return null;
    const hopList = hops as Waypoint[];
    if (!Number.isInteger(cursor) || (cursor as number) < 0 || (cursor as number) > hopList.length) {
      return null;
    }
    if (!Number.isInteger(members) || (members as number) < 0) return null;
    if (!isFiniteNumber(spacing) || (spacing as number) < 0) return null;
    parsed.push({
      id: id as number,
      label,
      anchor: { x: (anchor as Waypoint).x, y: (anchor as Waypoint).y },
      hops: hopList.map((hop) => ({ x: hop.x, y: hop.y })),
      cursor: cursor as number,
      members: members as number,
      spacing: spacing as number,
    });
  }
  return { chains: parsed };
}
