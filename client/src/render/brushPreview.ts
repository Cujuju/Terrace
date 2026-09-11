import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  LineBasicMaterial,
  Line,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Plane,
  SRGBColorSpace,
  Vector3,
  type Scene,
} from 'three';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  MAX_BRUSH_RADIUS,
  sculptSweepRadius,
  MIN_BRUSH_RADIUS,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  applySculpt,
  bandOf,
  createHeightmap,
  forEachFootprintOffset,
  sculptOptionsOf,
  type SculptIntent,
  type SculptProfile,
  type SculptTool,
} from '@terrace/shared';
import { BAND_WORLD_HEIGHT, CELL_WORLD_SIZE } from '../config.ts';
import { bandColorOf } from '../terrain/bandColors.ts';
import { DENIED_COLOR, type DenialCue } from './denialCue.ts';
import {
  MAX_LATTICE_SPAN,
  assembleLoops,
  loadSampleField,
  marchLevel,
  type ContourLoop,
} from '../terrain/contours.ts';
import { simplifyLoop } from '../terrain/contourSmoothing.ts';
import { BRUSH_RADII } from '../state/hudState.ts';

const OUTLINE_LIFT_WORLD_UNITS = 0.05;

const OUTLINE_OPACITY = 0.45;

const SKIRT_OPACITY = OUTLINE_OPACITY / 3;

const CELL_GRID_COLOR = 0x8b918a;

const CELL_GRID_OPACITY = OUTLINE_OPACITY * 0.55;

const CROSSHAIR_ARM_WORLD_UNITS = CELL_WORLD_SIZE * 0.3;

const CROSSHAIR_GAP_WORLD_UNITS = CELL_WORLD_SIZE * 0.08;

const CROSSHAIR_OPACITY = 1;

const MARK_COLOR_RISER = 0xff2d95;

const OUTLINE_IS_CURSOR_CLASS = 'brush-outline-shown';

export interface CursorSurface {
  readonly classList: { toggle(token: string, force: boolean): void };
}

export interface BrushHover {
  readonly x: number;
  readonly y: number;
  readonly surfaceY: number;
  readonly hitRiser: boolean;
  readonly grabbable: boolean;
  readonly hitX?: number;
  readonly hitY?: number;
  readonly hitZ?: number;
  readonly band?: number | null;
}

type SculptDir = SculptIntent['dir'];

export interface BrushSelection {
  readonly radius: number;
  readonly tool: SculptTool;
  readonly profile: SculptProfile;
  readonly dir: SculptDir;
}

export interface BrushPreview {
  update(hover: BrushHover | null, brush: BrushSelection): void;
  dispose(): void;
}

const FOOTPRINT_OUTSIDE = 0;
const FOOTPRINT_INSIDE = 1;

const OUTLINE_COLOR_CAP = 0xffffff;
const OUTLINE_COLOR_RISER = 0xffb347;

const MARK_COLOR_REFUSED = 0x9aa09b;

const MARK_REFUSED_OPACITY = 0.5;

const MARK_BAND_TINT_MIX = 1 / 3;

const SEED_TOOL: SculptTool = 'stamp';
const SEED_PROFILE: SculptProfile = 'hard';

const SCULPT_DIRECTIONS: readonly SculptDir[] = [1, -1];

const FOOTPRINT_EDGE_CROSSING = 0.5;

const FOOTPRINT_LATTICE_MARGIN_CELLS = 1;

const FOOTPRINT_LATTICE_SPAN = 2 * (MAX_BRUSH_RADIUS + FOOTPRINT_LATTICE_MARGIN_CELLS);

const FOOTPRINT_LATTICE_CENTRE = FOOTPRINT_LATTICE_SPAN / 2;

const MAX_FOOTPRINT_REACH_CELLS = MAX_BRUSH_RADIUS - 1;

if (
  MAX_FOOTPRINT_REACH_CELLS + FOOTPRINT_LATTICE_MARGIN_CELLS > FOOTPRINT_LATTICE_CENTRE ||
  FOOTPRINT_LATTICE_CENTRE + MAX_FOOTPRINT_REACH_CELLS + FOOTPRINT_LATTICE_MARGIN_CELLS >
    FOOTPRINT_LATTICE_SPAN ||
  FOOTPRINT_LATTICE_SPAN > MAX_LATTICE_SPAN
) {
  throw new RangeError(
    `brush radius ${MAX_BRUSH_RADIUS} does not fit a ${FOOTPRINT_LATTICE_SPAN}-cell contour lattice`,
  );
}

interface Mark {
  readonly has: (dx: number, dy: number) => boolean;
  readonly cells: readonly (readonly [number, number])[];
}

const SIMULATION_SPAN_CELLS =
  2 * (sculptSweepRadius(MAX_BRUSH_RADIUS, 'soft', 'stamp', 'clicked') + FOOTPRINT_LATTICE_MARGIN_CELLS + 1);

const SIMULATION_GROUND_HEIGHT = 0;

function oneClickMark(
  radius: number,
  tool: SculptTool,
  profile: SculptProfile,
  dir: SculptDir,
): Mark {
  const map = createHeightmap(SIMULATION_SPAN_CELLS);
  const centre = SIMULATION_SPAN_CELLS >> 1;
  map.cells.fill(SIMULATION_GROUND_HEIGHT);

  const before = bandOf(SIMULATION_GROUND_HEIGHT);
  applySculpt(
    map,
    centre,
    centre,
    radius,
    DEFAULT_SCULPT_AMOUNT * dir,
    sculptOptionsOf({ type: 'sculpt', x: centre, y: centre, radius, dir, tool, profile }),
  );

  const keys = new Set<string>();
  const cells: (readonly [number, number])[] = [];
  for (let j = 0; j < SIMULATION_SPAN_CELLS; j++) {
    for (let i = 0; i < SIMULATION_SPAN_CELLS; i++) {
      if (bandOf(map.cells[j * SIMULATION_SPAN_CELLS + i]!) === before) continue;
      const dx = i - centre;
      const dy = j - centre;
      keys.add(`${dx},${dy}`);
      cells.push([dx, dy]);
    }
  }
  if (cells.length === 0) {
    throw new RangeError(
      `brush radius ${radius} (${tool}, ${profile}, dir ${dir}) renders no change`,
    );
  }
  return { has: (dx, dy) => keys.has(`${dx},${dy}`), cells };
}

function clampIntoMark(x: number, z: number, mark: Mark): [number, number] {
  if (mark.has(Math.round(x), Math.round(z))) return [x, z];
  let bestX = x;
  let bestZ = z;
  let bestDistance = Infinity;
  for (const [cx, cz] of mark.cells) {
    const nx = x < cx - 0.5 ? cx - 0.5 : x > cx + 0.5 ? cx + 0.5 : x;
    const nz = z < cz - 0.5 ? cz - 0.5 : z > cz + 0.5 ? cz + 0.5 : z;
    const dx = x - nx;
    const dz = z - nz;
    const distance = dx * dx + dz * dz;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestX = nx;
      bestZ = nz;
    }
  }
  return [bestX, bestZ];
}

function markOutline(radius: number, mark: Mark): ContourLoop {
  loadSampleField(
    (i, j) =>
      mark.has(i - FOOTPRINT_LATTICE_CENTRE, j - FOOTPRINT_LATTICE_CENTRE)
        ? FOOTPRINT_INSIDE
        : FOOTPRINT_OUTSIDE,
    FOOTPRINT_LATTICE_SPAN,
  );

  const origin = -FOOTPRINT_LATTICE_CENTRE;
  const segmentCount = marchLevel(
    FOOTPRINT_INSIDE,
    origin,
    origin,
    FOOTPRINT_EDGE_CROSSING,
  );
  const loops = assembleLoops(segmentCount, origin, origin, false).map(simplifyLoop);

  if (loops.length !== 1) {
    throw new RangeError(
      `brush radius ${radius} marched to ${loops.length} contour loops, expected 1`,
    );
  }

  for (const point of loops[0]) {
    const [x, z] = clampIntoMark(point.x, point.z, mark);
    point.x = x;
    point.z = z;
  }
  return loops[0];
}

function cellGridSegments(mark: Mark): number[] {
  const segments: number[] = [];
  for (const [dx, dy] of mark.cells) {
    if (mark.has(dx + 1, dy)) {
      segments.push(dx + 0.5, dy - 0.5, dx + 0.5, dy + 0.5);
    }
    if (mark.has(dx, dy + 1)) {
      segments.push(dx - 0.5, dy + 0.5, dx + 0.5, dy + 0.5);
    }
  }
  return segments;
}

function skirtDropWorldUnits(mark: Mark): number {
  let manhattanReachCells = 0;
  for (const [dx, dy] of mark.cells) {
    manhattanReachCells = Math.max(manhattanReachCells, Math.abs(dx) + Math.abs(dy));
  }
  return (manhattanReachCells + 1) * BAND_WORLD_HEIGHT + OUTLINE_LIFT_WORLD_UNITS;
}

interface BrushGeometry {
  readonly ring: BufferGeometry;
  readonly skirt: BufferGeometry;
  readonly cellGrid: BufferGeometry;
}

function brushGeometry(
  radius: number,
  tool: SculptTool,
  profile: SculptProfile,
  dir: SculptDir,
): BrushGeometry {
  const mark = oneClickMark(radius, tool, profile, dir);
  const outline = markOutline(radius, mark);
  const drop = skirtDropWorldUnits(mark);

  // Closed by repeating the first point: WebGPURenderer draws Line, not LineLoop.
  const ringPositions: number[] = [];
  for (const point of [...outline, outline[0]!]) {
    ringPositions.push(point.x * CELL_WORLD_SIZE, 0, point.z * CELL_WORLD_SIZE);
  }
  const ring = new BufferGeometry();
  ring.setAttribute('position', new Float32BufferAttribute(ringPositions, 3));

  const skirtPositions: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const ax = a.x * CELL_WORLD_SIZE;
    const az = a.z * CELL_WORLD_SIZE;
    const bx = b.x * CELL_WORLD_SIZE;
    const bz = b.z * CELL_WORLD_SIZE;
    skirtPositions.push(
      ax, 0, az, bx, 0, bz, bx, -drop, bz,
      ax, 0, az, bx, -drop, bz, ax, -drop, az,
    );
  }
  const skirt = new BufferGeometry();
  skirt.setAttribute('position', new Float32BufferAttribute(skirtPositions, 3));

  const gridPositions: number[] = [];
  const flat = cellGridSegments(mark);
  for (let i = 0; i < flat.length; i += 2) {
    gridPositions.push(flat[i]! * CELL_WORLD_SIZE, 0, flat[i + 1]! * CELL_WORLD_SIZE);
  }
  const cellGrid = new BufferGeometry();
  cellGrid.setAttribute('position', new Float32BufferAttribute(gridPositions, 3));

  return { ring, skirt, cellGrid };
}

export const BRUSH_PREVIEW_DRAW_OBJECTS = 4;

const CELL_EDGE_FROM_CENTRE_CELLS = 0.5;

interface WorldEdgeClip {
  readonly planes: readonly Plane[];
  syncTo(worldSizeCells: number): void;
}

function createWorldEdgeClip(): WorldEdgeClip {
  const west = new Plane(new Vector3(1, 0, 0), 0);
  const east = new Plane(new Vector3(-1, 0, 0), 0);
  const north = new Plane(new Vector3(0, 0, 1), 0);
  const south = new Plane(new Vector3(0, 0, -1), 0);
  let syncedSize = -1;
  return {
    planes: [west, east, north, south],
    syncTo(worldSizeCells: number): void {
      if (worldSizeCells === syncedSize) return;
      syncedSize = worldSizeCells;
      const min = -CELL_EDGE_FROM_CENTRE_CELLS * CELL_WORLD_SIZE;
      const max = (worldSizeCells - 1 + CELL_EDGE_FROM_CENTRE_CELLS) * CELL_WORLD_SIZE;
      west.constant = -min;
      east.constant = max;
      north.constant = -min;
      south.constant = max;
    },
  };
}

export function createBrushPreview(
  scene: Scene,
  canvas: CursorSurface,
  worldSize: () => number,
  denial: DenialCue,
): BrushPreview {
  const edgeClip = createWorldEdgeClip();
  const geometries = new Map<string, BrushGeometry>();
  const key = (
    radius: number,
    tool: SculptTool,
    profile: SculptProfile,
    dir: SculptDir,
  ): string => `${radius}|${tool}|${profile}|${dir}`;
  for (const r of BRUSH_RADII) {
    for (const tool of SCULPT_TOOLS) {
      if (tool === 'drag' || tool === 'carve') continue;
      for (const profile of SCULPT_PROFILES) {
        for (const dir of SCULPT_DIRECTIONS) {
          geometries.set(key(r, tool, profile, dir), brushGeometry(r, tool, profile, dir));
        }
      }
    }
  }
  const initialKey = key(
    MIN_BRUSH_RADIUS,
    SCULPT_TOOLS[0]!,
    SCULPT_PROFILES[0]!,
    SCULPT_DIRECTIONS[0]!,
  );
  const initial = geometries.get(initialKey)!;

  const material = new LineBasicMaterial({
    color: OUTLINE_COLOR_CAP,
    transparent: true,
    opacity: OUTLINE_OPACITY,
    depthTest: false,
    depthWrite: false,
    clippingPlanes: [...edgeClip.planes],
  });

  const line = new Line(initial.ring, material);
  line.renderOrder = 998;
  line.visible = false;
  scene.add(line);

  const skirtMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: SKIRT_OPACITY,
    side: DoubleSide,
    depthWrite: false,
    clippingPlanes: [...edgeClip.planes],
  });
  const skirt = new Mesh(initial.skirt, skirtMaterial);
  skirt.renderOrder = 997;
  skirt.visible = false;
  scene.add(skirt);

  const cellGridMaterial = new LineBasicMaterial({
    color: CELL_GRID_COLOR,
    transparent: true,
    opacity: CELL_GRID_OPACITY,
    depthTest: false,
    depthWrite: false,
    clippingPlanes: [...edgeClip.planes],
  });
  const cellGrid = new LineSegments(initial.cellGrid, cellGridMaterial);
  cellGrid.renderOrder = 998;
  cellGrid.visible = false;
  scene.add(cellGrid);

  const crosshairMaterial = new LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: CROSSHAIR_OPACITY,
    depthTest: false,
    depthWrite: false,
  });
  const arm = CROSSHAIR_ARM_WORLD_UNITS;
  const gap = CROSSHAIR_GAP_WORLD_UNITS;
  const crosshairGeometry = new BufferGeometry();
  crosshairGeometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      [
        -arm, 0, 0, -gap, 0, 0,
        gap, 0, 0, arm, 0, 0,
        0, 0, -arm, 0, 0, -gap,
        0, 0, gap, 0, 0, arm,
      ],
      3,
    ),
  );
  const crosshair = new LineSegments(crosshairGeometry, crosshairMaterial);
  crosshair.renderOrder = 999;
  crosshair.visible = false;
  scene.add(crosshair);

  const markColor = new Color();
  const bandTint = new Color();

  const paintRiserMark = (band: number | null): void => {
    if (band === null) {
      crosshairMaterial.color.setHex(MARK_COLOR_REFUSED);
      crosshairMaterial.opacity = CROSSHAIR_OPACITY * MARK_REFUSED_OPACITY;
      return;
    }
    markColor.setHex(MARK_COLOR_RISER, SRGBColorSpace);
    const [r, g, b] = bandColorOf(band * BAND_HEIGHT);
    bandTint.setRGB(r, g, b, SRGBColorSpace);
    crosshairMaterial.color.copy(markColor.lerp(bandTint, MARK_BAND_TINT_MIX));
    crosshairMaterial.opacity = CROSSHAIR_OPACITY;
  };

  const paintFlatMark = (): void => {
    crosshairMaterial.color.setHex(OUTLINE_COLOR_CAP);
    crosshairMaterial.opacity = CROSSHAIR_OPACITY;
  };

  let shownKey = initialKey;

  let showing = false;
  const show = (visible: boolean, crosshairOnly = false): void => {
    const footprint = visible && !crosshairOnly;
    line.visible = footprint;
    skirt.visible = footprint;
    cellGrid.visible = footprint;
    crosshair.visible = visible;
    const red = denial.isRed();
    if (visible && red) {
      material.color.setHex(DENIED_COLOR);
      skirtMaterial.color.setHex(DENIED_COLOR);
      crosshairMaterial.color.setHex(DENIED_COLOR);
    }
    if (visible === showing) return;
    showing = visible;
    canvas.classList.toggle(OUTLINE_IS_CURSOR_CLASS, visible);
  };

  return {
    update(hover, brush) {
      if (hover === null) {
        show(false);
        return;
      }
      edgeClip.syncTo(worldSize());
      const atX = hover.hitX ?? hover.x * CELL_WORLD_SIZE;
      const atY = hover.hitY ?? hover.surfaceY;
      const atZ = hover.hitZ ?? hover.y * CELL_WORLD_SIZE;

      const onTread = !hover.hitRiser && atY === hover.surfaceY;
      const seeding = brush.tool === 'drag' && onTread;

      if (!seeding && (brush.tool === 'drag' || brush.tool === 'carve')) {
        if (hover.hitRiser) {
          const band = hover.band ?? null;
          const held = band !== null && (brush.tool !== 'drag' || hover.grabbable);
          paintRiserMark(held ? band : null);
          crosshair.position.set(atX, atY + OUTLINE_LIFT_WORLD_UNITS, atZ);
          show(true, true);
          return;
        }
        paintFlatMark();
        crosshair.position.set(atX, atY + OUTLINE_LIFT_WORLD_UNITS, atZ);
        show(true, true);
        return;
      }
      const wanted = seeding
        ? key(brush.radius, SEED_TOOL, SEED_PROFILE, brush.dir)
        : key(brush.radius, brush.tool, brush.profile, brush.dir);
      if (wanted !== shownKey) {
        const geometry = geometries.get(wanted);
        if (geometry === undefined) {
          show(false);
          return;
        }
        line.geometry = geometry.ring;
        skirt.geometry = geometry.skirt;
        cellGrid.geometry = geometry.cellGrid;
        shownKey = wanted;
      }
      material.color.setHex(hover.hitRiser ? OUTLINE_COLOR_RISER : OUTLINE_COLOR_CAP);
      skirtMaterial.color.setHex(hover.hitRiser ? OUTLINE_COLOR_RISER : OUTLINE_COLOR_CAP);
      paintFlatMark();
      const lift = hover.surfaceY + OUTLINE_LIFT_WORLD_UNITS;
      line.position.set(hover.x * CELL_WORLD_SIZE, lift, hover.y * CELL_WORLD_SIZE);
      if (hover.hitRiser) {
        crosshair.position.set(atX, atY + OUTLINE_LIFT_WORLD_UNITS, atZ);
      } else {
        crosshair.position.copy(line.position);
      }
      skirt.position.copy(line.position);
      cellGrid.position.copy(line.position);
      show(true);
    },
    dispose() {
      show(false);
      scene.remove(line);
      scene.remove(crosshair);
      scene.remove(skirt);
      scene.remove(cellGrid);
      for (const g of geometries.values()) {
        g.ring.dispose();
        g.skirt.dispose();
        g.cellGrid.dispose();
      }
      material.dispose();
      crosshairGeometry.dispose();
      crosshairMaterial.dispose();
      skirtMaterial.dispose();
      cellGridMaterial.dispose();
    },
  };
}
