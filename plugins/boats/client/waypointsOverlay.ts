import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Points,
  PointsMaterial,
} from 'three';
import {
  CELL_WORLD_SIZE,
  parseWaypointDebugFrame,
  waypointForMember,
} from '@terrace/shared';
import { parseBoatsPayload, type BoatState } from '../protocol.ts';

/** Fleet-chain debug overlay (the `?waypoints` flag). Six fixed draw objects:
 * chain lines, sailed lines, hop/slot/cursor points, and one coloured point
 * per crewed boat showing its fleet. */
export const WAYPOINTS_DEBUG_DRAW_OBJECTS = 6;

const WAYPOINT_LIFT_WORLD_UNITS = 0.02;

const CHAIN_LINE_COLOR = 0x7fd4ff;
const SAILED_LINE_COLOR = 0xffffff;
const HOP_POINT_COLOR = 0xffffff;
const SLOT_POINT_COLOR = 0xffb347;
const CURSOR_POINT_COLOR = 0x6fbf73;

/** One marker colour per fleet, by fleet id. The readout lists the ids. */
const FLEET_BOAT_COLORS = [
  0x7fd4ff, 0xffb347, 0x6fbf73, 0xe07ad4, 0xf2e35c, 0x8f7bff, 0xff7a6b, 0x5ce8d0,
];

function fleetBoatColor(fleetId: number): [number, number, number] {
  const hex = FLEET_BOAT_COLORS[fleetId % FLEET_BOAT_COLORS.length];
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

export interface WaypointsOverlay {
  receive(payload: unknown): void;
  receiveBoats(payload: unknown): void;
  dispose(): void;
}

export function createWaypointsOverlay(layer: Group): WaypointsOverlay {
  const container = new Group();
  container.name = 'boats:waypoints-debug';
  container.visible = false;
  layer.add(container);

  const lines = new LineSegments(
    new BufferGeometry(),
    new LineBasicMaterial({
      color: CHAIN_LINE_COLOR,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    }),
  );
  lines.renderOrder = 998;
  lines.frustumCulled = false;

  const sailed = new LineSegments(
    new BufferGeometry(),
    new LineBasicMaterial({
      color: SAILED_LINE_COLOR,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    }),
  );
  sailed.renderOrder = 998;
  sailed.frustumCulled = false;

  const makePoints = (color: number, size: number): Points => {
    const points = new Points(
      new BufferGeometry(),
      new PointsMaterial({
        color,
        size,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
      }),
    );
    points.renderOrder = 998;
    points.frustumCulled = false;
    return points;
  };

  const hopPoints = makePoints(HOP_POINT_COLOR, 5);
  const slotPoints = makePoints(SLOT_POINT_COLOR, 6);
  const cursorPoints = makePoints(CURSOR_POINT_COLOR, 8);
  const boatPoints = new Points(
    new BufferGeometry(),
    new PointsMaterial({
      size: 7,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    }),
  );
  boatPoints.renderOrder = 998;
  boatPoints.frustumCulled = false;
  container.add(lines, sailed, hopPoints, slotPoints, cursorPoints, boatPoints);

  const readout = document.createElement('div');
  readout.style.cssText = [
    'position:fixed',
    'right:16px',
    'top:120px',
    'z-index:50',
    'pointer-events:none',
    'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace',
    'white-space:pre',
    'padding:10px 14px',
    'border-radius:6px',
    'background:rgba(10,16,13,0.82)',
    'color:#e7eee8',
    'border:1px solid rgba(255,255,255,0.14)',
  ].join(';');
  readout.textContent = 'waypoints: waiting for frame';
  document.body.appendChild(readout);

  let rejected = 0;
  let disposed = false;
  const fleetOfBoat = new Map<number, number>();
  let lastBoats: BoatState[] = [];

  const setPositions = (target: LineSegments | Points, positions: number[]): void => {
    target.geometry.dispose();
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    target.geometry = geometry;
  };

  const redrawBoats = (): void => {
    const positions: number[] = [];
    const colors: number[] = [];
    for (const boat of lastBoats) {
      const fleet = fleetOfBoat.get(boat.id);
      if (fleet === undefined) continue;
      positions.push(
        boat.x * CELL_WORLD_SIZE,
        WAYPOINT_LIFT_WORLD_UNITS,
        boat.y * CELL_WORLD_SIZE,
      );
      colors.push(...fleetBoatColor(fleet));
    }
    boatPoints.geometry.dispose();
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    boatPoints.geometry = geometry;
  };

  return {
    receive(payload: unknown): void {
      if (disposed) return;
      const frame = parseWaypointDebugFrame(payload);
      if (frame === null) {
        rejected++;
        readout.textContent = `waypoints: rejected frame (${rejected})`;
        return;
      }

      const segments: number[] = [];
      const sailedSegments: number[] = [];
      const hops: number[] = [];
      const slots: number[] = [];
      const cursors: number[] = [];
      const summary: string[] = [`waypoints: ${frame.chains.length} chains`];
      fleetOfBoat.clear();
      for (const chain of frame.chains) {
        const last = chain.hops.length - 1;
        const crew = chain.crew ?? [];
        for (const boatId of crew) fleetOfBoat.set(boatId, chain.id);
        summary.push(
          `#${chain.id} ${chain.label} cursor ${chain.cursor}/${chain.hops.length} ` +
            `hops ${chain.hops.length} sailed ${chain.sailed.length} members ${chain.members} ` +
            `crew [${crew.join(',')}]`,
        );
        let prevX = chain.anchor.x;
        let prevY = chain.anchor.y;
        hops.push(chain.anchor.x * CELL_WORLD_SIZE, WAYPOINT_LIFT_WORLD_UNITS, chain.anchor.y * CELL_WORLD_SIZE);
        for (const hop of chain.hops) {
          segments.push(
            prevX * CELL_WORLD_SIZE,
            WAYPOINT_LIFT_WORLD_UNITS,
            prevY * CELL_WORLD_SIZE,
            hop.x * CELL_WORLD_SIZE,
            WAYPOINT_LIFT_WORLD_UNITS,
            hop.y * CELL_WORLD_SIZE,
          );
          hops.push(hop.x * CELL_WORLD_SIZE, WAYPOINT_LIFT_WORLD_UNITS, hop.y * CELL_WORLD_SIZE);
          prevX = hop.x;
          prevY = hop.y;
        }
        for (let s = 1; s < chain.sailed.length; s++) {
          const prev = chain.sailed[s - 1];
          const cur = chain.sailed[s];
          sailedSegments.push(
            prev.x * CELL_WORLD_SIZE,
            WAYPOINT_LIFT_WORLD_UNITS,
            prev.y * CELL_WORLD_SIZE,
            cur.x * CELL_WORLD_SIZE,
            WAYPOINT_LIFT_WORLD_UNITS,
            cur.y * CELL_WORLD_SIZE,
          );
        }
        if (last >= 0) {          const goal = chain.hops[last];
          const at = Math.max(0, Math.min(chain.cursor, last));
          const cursor = chain.hops[at];
          cursors.push(
            cursor.x * CELL_WORLD_SIZE,
            WAYPOINT_LIFT_WORLD_UNITS,
            cursor.y * CELL_WORLD_SIZE,
          );
          for (let rank = 0; rank < chain.members; rank++) {
            const slot = waypointForMember(goal, rank, chain.spacing);
            slots.push(
              slot.x * CELL_WORLD_SIZE,
              WAYPOINT_LIFT_WORLD_UNITS,
              slot.y * CELL_WORLD_SIZE,
            );
          }
        }
      }
      setPositions(lines, segments);
      setPositions(sailed, sailedSegments);
      setPositions(hopPoints, hops);
      setPositions(slotPoints, slots);
      setPositions(cursorPoints, cursors);
      redrawBoats();
      container.visible = frame.chains.length > 0;
      readout.textContent = summary.join('\n');
    },

    receiveBoats(payload: unknown): void {
      if (disposed) return;
      const boats = parseBoatsPayload(payload);
      if (boats === null) return;
      lastBoats = boats;
      redrawBoats();
    },

    dispose(): void {
      disposed = true;
      container.removeFromParent();
      lines.geometry.dispose();
      (lines.material as LineBasicMaterial).dispose();
      sailed.geometry.dispose();
      (sailed.material as LineBasicMaterial).dispose();
      for (const points of [hopPoints, slotPoints, cursorPoints, boatPoints]) {
        points.geometry.dispose();
        (points.material as PointsMaterial).dispose();
      }
      readout.remove();
    },
  };
}
