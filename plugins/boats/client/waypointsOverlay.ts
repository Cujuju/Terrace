import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  SphereGeometry,
} from 'three';
import {
  CELL_WORLD_SIZE,
  parseWaypointDebugFrame,
  waypointForMember,
} from '@terrace/shared';
import { BOATS_PAYLOAD_CAP, parseBoatsPayload, type BoatState } from '../protocol.ts';
import type { InterpolatedBoat } from './interpolation.ts';

/** Fleet-chain debug overlay (the `?waypoints` flag). Six fixed draw objects:
 * chain lines, sailed lines, hop/slot/cursor points, and one instanced
 * sphere per boat showing its fleet. */
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

/** Marker for boats sailing outside any fleet. */
const UNAFFILIATED_GRAY_HEX = 0x8a918a;

/** Small world-unit marker: a dot on each boat, not a balloon. */
const FLEET_MARKER_RADIUS_WORLD_UNITS = 0.1;
const FLEET_MARKER_LIFT_WORLD_UNITS = 0.8;

function fleetBoatColorHex(fleetId: number): number {
  return FLEET_BOAT_COLORS[fleetId % FLEET_BOAT_COLORS.length]!;
}

export interface WaypointsOverlay {
  receive(payload: unknown): void;
  receiveBoats(payload: unknown): void;
  updateMarkers(sampled: ReadonlyMap<number, InterpolatedBoat>): void;
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
  const boatMarkers = new InstancedMesh(
    new SphereGeometry(FLEET_MARKER_RADIUS_WORLD_UNITS, 8, 6),
    new MeshStandardMaterial({ roughness: 1, metalness: 0 }),
    BOATS_PAYLOAD_CAP,
  );
  boatMarkers.renderOrder = 998;
  boatMarkers.frustumCulled = false;
  boatMarkers.count = 0;
  container.add(lines, sailed, hopPoints, slotPoints, cursorPoints, boatMarkers);

  /**
   * The readout wears the performance HUD's own classes (.hud-version for the
   * corner typography, .hud-version__perf-panel for the panel chrome,
   * .hud-version__perf rows inside), so it matches that styling exactly by
   * sharing it rather than by copying its values.
   */
  const readout = document.createElement('div');
  readout.id = 'boats-waypoints-readout';
  readout.className = 'hud-version';
  readout.style.zIndex = '50';
  readout.style.gap = '8px';
  // Left side: undo .hud-version's right anchor and end alignment.
  readout.style.right = 'auto';
  readout.style.left = '16px';
  readout.style.alignItems = 'flex-start';
  /** Two stacked panels: waypoints and boats above, squadron chains below.
   * The chain rows carry the longest values, and sharing one panel would
   * stretch it wide enough to cover the world header. */
  const boatPanel = document.createElement('div');
  boatPanel.className = 'hud-version__perf-panel';
  const chainPanel = document.createElement('div');
  chainPanel.className = 'hud-version__perf-panel';
  chainPanel.style.display = 'none';
  readout.append(boatPanel, chainPanel);
  document.body.appendChild(readout);

  type ReadoutRow = readonly [label: string, value: string];

  const makeReadoutRow = ([label, value]: ReadoutRow): HTMLSpanElement => {
    const row = document.createElement('span');
    row.className = 'hud-version__perf';
    const labelCell = document.createElement('span');
    labelCell.className = 'hud-version__perf-label';
    labelCell.textContent = label;
    const valueCell = document.createElement('span');
    valueCell.textContent = value;
    row.append(labelCell, valueCell);
    return row;
  };

  const setPanelRows = (panel: HTMLElement, rows: readonly ReadoutRow[]): void => {
    panel.replaceChildren(...rows.map(makeReadoutRow));
  };

  /**
   * Single-cell lines for the squadron panel: no label column. The `#id`
   * plus `sqN` pair duplicated the number and left the fixed label column
   * mostly empty, so each chain renders as one short line instead.
   */
  const setPanelLines = (panel: HTMLElement, lines: readonly string[]): void => {
    panel.replaceChildren(
      ...lines.map((line) => {
        const row = document.createElement('span');
        row.style.whiteSpace = 'pre';
        row.textContent = line;
        return row;
      }),
    );
  };

  /**
   * The stack hangs below the top-left corner panel, measured live: that
   * panel collapses to a tab or opens to full height, and the stack must
   * clear it either way without covering it.
   */
  const updateReadoutPosition = (): void => {
    const corner = document.querySelector('.hud-anchor-top-left');
    const top =
      corner instanceof HTMLElement
        ? Math.ceil(corner.getBoundingClientRect().bottom) + 8
        : 10;
    readout.style.top = `${String(top)}px`;
  };

  /**
   * Re-hang when the corner panel collapses or opens underneath us. Frames
   * already reposition on every render; this covers a toggle between
   * frames. Only DOM structure is inspected here, never geometry, so idle
   * document churn costs no layout.
   */
  const cornered = (node: Node): boolean =>
    node instanceof Element &&
    (node.matches('.hud-anchor-top-left') ||
      node.querySelector('.hud-anchor-top-left') !== null);

  const positionObserver = new MutationObserver((records) => {
    const touched = records.some(
      (record) =>
        (record.target instanceof Element &&
          record.target.closest('.hud-anchor-top-left') !== null) ||
        [...record.addedNodes].some(cornered) ||
        [...record.removedNodes].some(cornered),
    );
    if (!touched) return;
    updateReadoutPosition();
  });
  positionObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  let rejected = 0;
  let disposed = false;
  const fleetOfBoat = new Map<number, number>();
  let lastBoats: BoatState[] = [];
  let lastChainCount = 0;
  let readoutHead: ReadoutRow = ['waypoints', 'waiting for frame'];
  let chainLines: string[] = [];

  /** One reading per row, like the performance panel: a count row plus one
   * short row per boat. A single row carrying every boat's position grows
   * the panel to the viewport width, since perf rows never wrap. */
  const boatRows = (): ReadoutRow[] => {
    const crewed = lastBoats.filter((boat) => fleetOfBoat.has(boat.id)).length;
    const head: ReadoutRow = [
      'boats',
      `${String(lastBoats.length)} (${String(crewed)} crewed)`,
    ];
    return [
      head,
      ...lastBoats.map((boat): ReadoutRow => {
        const fleet = fleetOfBoat.get(boat.id);
        return [
          `boat ${boat.id}`,
          `${boat.x.toFixed(0)},${boat.y.toFixed(0)} · ${fleet === undefined ? 'unaf' : `fleet ${fleet}`}`,
        ];
      }),
    ];
  };

  const renderReadout = (): void => {
    setPanelRows(boatPanel, [readoutHead, ...boatRows()]);
    setPanelLines(chainPanel, chainLines);
    chainPanel.style.display = chainLines.length > 0 ? '' : 'none';
    updateReadoutPosition();
  };

  setPanelRows(boatPanel, [readoutHead]);
  updateReadoutPosition();

  const setPositions = (target: LineSegments | Points, positions: number[]): void => {
    target.geometry.dispose();
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    target.geometry = geometry;
  };

  const markerMatrix = new Matrix4();
  const markerColor = new Color();
  const slotOfBoat = new Map<number, number>();

  const redrawBoats = (): void => {
    let drawn = 0;
    slotOfBoat.clear();
    for (const boat of lastBoats) {
      if (drawn >= BOATS_PAYLOAD_CAP) break;
      slotOfBoat.set(boat.id, drawn);
      markerMatrix.makeTranslation(
        boat.x * CELL_WORLD_SIZE,
        FLEET_MARKER_LIFT_WORLD_UNITS,
        boat.y * CELL_WORLD_SIZE,
      );
      boatMarkers.setMatrixAt(drawn, markerMatrix);
      const fleet = fleetOfBoat.get(boat.id);
      markerColor.setHex(
        fleet === undefined ? UNAFFILIATED_GRAY_HEX : fleetBoatColorHex(fleet),
      );
      boatMarkers.setColorAt(drawn, markerColor);
      drawn++;
    }
    boatMarkers.count = drawn;
    boatMarkers.instanceMatrix.needsUpdate = true;
    if (boatMarkers.instanceColor !== null) boatMarkers.instanceColor.needsUpdate = true;
  };

  return {
    receive(payload: unknown): void {
      if (disposed) return;
      const frame = parseWaypointDebugFrame(payload);
      if (frame === null) {
        rejected++;
        readoutHead = ['waypoints', `rejected frame (${String(rejected)})`];
        setPanelRows(boatPanel, [readoutHead]);
        updateReadoutPosition();
        return;
      }

      const segments: number[] = [];
      const sailedSegments: number[] = [];
      const hops: number[] = [];
      const slots: number[] = [];
      const cursors: number[] = [];
      const rows: string[] = [];
      fleetOfBoat.clear();
      for (const chain of frame.chains) {
        const last = chain.hops.length - 1;
        const crew = chain.crew ?? [];
        for (const boatId of crew) fleetOfBoat.set(boatId, chain.id);
        // One line per chain, no label column: `sq5` already carries the
        // squadron number, so a separate `#5` cell only bought dead space.
        // Non-squadron labels keep their `#id` prefix.
        const tag = chain.label.replace(/^squadron (\d+)$/, 'sq$1');
        rows.push(
          `${tag === chain.label ? `#${chain.id} ` : ''}${tag} cur ${chain.cursor}/${chain.hops.length} ` +
            `sailed ${chain.sailed.length} mem ${chain.members} crew ${crew.length}`,
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
      lastChainCount = frame.chains.length;
      container.visible = lastChainCount > 0 || lastBoats.length > 0;
      readoutHead = ['waypoints', `${frame.chains.length} chains`];
      chainLines = rows;
      renderReadout();
    },

    receiveBoats(payload: unknown): void {
      if (disposed) return;
      const boats = parseBoatsPayload(payload);
      if (boats === null) return;
      lastBoats = boats;
      redrawBoats();
      container.visible = lastChainCount > 0 || lastBoats.length > 0;
      renderReadout();
    },

    // Glide the markers from the same interpolated samples as the models,
    // so they never lead, lag, or step between server snapshots.
    updateMarkers(sampled: ReadonlyMap<number, InterpolatedBoat>): void {
      if (disposed || slotOfBoat.size === 0) return;
      let moved = false;
      for (const [id, pose] of sampled) {
        const slot = slotOfBoat.get(id);
        if (slot === undefined) continue;
        markerMatrix.makeTranslation(
          pose.x * CELL_WORLD_SIZE,
          FLEET_MARKER_LIFT_WORLD_UNITS,
          pose.y * CELL_WORLD_SIZE,
        );
        boatMarkers.setMatrixAt(slot, markerMatrix);
        moved = true;
      }
      if (moved) boatMarkers.instanceMatrix.needsUpdate = true;
    },

    dispose(): void {
      disposed = true;
      positionObserver.disconnect();
      container.removeFromParent();
      lines.geometry.dispose();
      (lines.material as LineBasicMaterial).dispose();
      sailed.geometry.dispose();
      (sailed.material as LineBasicMaterial).dispose();
      boatMarkers.geometry.dispose();
      (boatMarkers.material as MeshStandardMaterial).dispose();
      for (const points of [hopPoints, slotPoints, cursorPoints]) {
        points.geometry.dispose();
        (points.material as PointsMaterial).dispose();
      }
      readout.remove();
    },
  };
}
