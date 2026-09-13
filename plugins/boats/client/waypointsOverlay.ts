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
   * The open performance panel, if any: a .hud-version__perf-panel outside
   * this readout. While it is open the readout docks to the left
   * of the performance HUD's column; while it is closed the readout parks
   * below the version lines, which it would otherwise cover.
   */
  const openPerfPanel = (): Element | null => {
    for (const panel of document.querySelectorAll('.hud-version__perf-panel')) {
      if (!readout.contains(panel)) return panel;
    }
    return null;
  };

  let perfDocked: boolean | null = null;

  /**
   * Parked right offset: just left of the bottom-right settings column
   * (connection button and its popups), measured live so open popups count
   * too. The tall stack would otherwise cover that column.
   */
  const parkedRightPx = (): number => {
    const settings = document.querySelector('.hud-settings');
    if (!(settings instanceof HTMLElement)) return 60;
    const gap = Math.ceil(window.innerWidth - settings.getBoundingClientRect().left) + 8;
    return Math.max(60, gap);
  };

  const updateReadoutPosition = (): void => {
    const perf = openPerfPanel();
    if (perf !== null) {
      const anchor = perf.closest('.hud-version') ?? perf;
      const width = anchor.getBoundingClientRect().width;
      // Same 10px top as .hud-version, right of the readout clearing the
      // performance column (its 12px anchor) plus an 8px gap.
      readout.style.top = '10px';
      readout.style.right = `${String(Math.ceil(width) + 12 + 8)}px`;
      perfDocked = true;
    } else {
      readout.style.top = '120px';
      readout.style.right = `${String(parkedRightPx())}px`;
      perfDocked = false;
    }
  };

  /**
   * Re-dock when the performance panel opens or closes underneath us. Frames
   * already reposition on every render; this covers a toggle between frames.
   * The presence check is cheap and the measuring update runs only on a flip.
   */
  const positionObserver = new MutationObserver(() => {
    if ((openPerfPanel() !== null) === perfDocked) return;
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

  const redrawBoats = (): void => {
    let drawn = 0;
    for (const boat of lastBoats) {
      if (drawn >= BOATS_PAYLOAD_CAP) break;
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
