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
import { BAND_HEIGHT } from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../../config.ts';
import { bandColorOf } from '../../terrain/bandColors.ts';
import { DENIED_COLOR, GHOST_OPACITY_SCALE, OFFLINE_COLOR, type DenialCue } from '../denialCue.ts';
import {
  CELL_GRID_COLOR,
  CELL_GRID_OPACITY,
  CROSSHAIR_ARM_WORLD_UNITS,
  CROSSHAIR_GAP_WORLD_UNITS,
  CROSSHAIR_OPACITY,
  HEM_OPACITY,
  MARK_BAND_TINT_MIX,
  MARK_COLOR_REFUSED,
  MARK_COLOR_RISER,
  MARK_REFUSED_OPACITY,
  OUTLINE_COLOR_CAP,
  OUTLINE_IS_CURSOR_CLASS,
  OUTLINE_OPACITY,
} from './style.ts';

export interface CursorSurface {
  readonly classList: { toggle(token: string, force: boolean): void };
}

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

export interface BrushLiveGeometries {
  readonly ring: BufferGeometry;
  readonly hem: BufferGeometry;
  readonly grid: BufferGeometry;
}

/** The scene objects the preview drives, plus the cue painting they answer to. */
export interface BrushStage {
  readonly line: Line;
  readonly hem: Mesh;
  readonly cellGrid: LineSegments;
  readonly crosshair: LineSegments;
  readonly material: LineBasicMaterial;
  readonly hemMaterial: MeshBasicMaterial;
  syncEdgeClipTo(worldSizeCells: number): void;
  paintRiserMark(band: number | null): void;
  paintFlatMark(): void;
  show(visible: boolean, markOnly?: boolean): void;
  removeFromScene(): void;
  disposeResources(): void;
}

export function createBrushStage(
  scene: Scene,
  canvas: CursorSurface,
  denial: DenialCue,
  live: BrushLiveGeometries,
): BrushStage {
  const edgeClip = createWorldEdgeClip();

  const material = new LineBasicMaterial({
    color: OUTLINE_COLOR_CAP,
    transparent: true,
    opacity: OUTLINE_OPACITY,
    depthTest: false,
    depthWrite: false,
    clippingPlanes: [...edgeClip.planes],
  });

  const line = new Line(live.ring, material);
  line.renderOrder = 999;
  line.visible = false;
  // The buffers are preallocated past the draw range, so the bounding sphere
  // reads the zeroed tail: never cull.
  line.frustumCulled = false;
  scene.add(line);

  const hemMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: HEM_OPACITY,
    side: DoubleSide,
    // The footprint paints over the stroke, never under it.
    depthTest: false,
    depthWrite: false,
    clippingPlanes: [...edgeClip.planes],
  });
  const hem = new Mesh(live.hem, hemMaterial);
  hem.renderOrder = 999;
  hem.visible = false;
  hem.frustumCulled = false;
  scene.add(hem);

  const cellGridMaterial = new LineBasicMaterial({
    color: CELL_GRID_COLOR,
    transparent: true,
    opacity: CELL_GRID_OPACITY,
    depthTest: false,
    depthWrite: false,
    clippingPlanes: [...edgeClip.planes],
  });
  const cellGrid = new LineSegments(live.grid, cellGridMaterial);
  cellGrid.renderOrder = 999;
  cellGrid.visible = false;
  cellGrid.frustumCulled = false;
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

  let showing = false;
  // The four cue states: refused=red, offline=grey/hollow (never red),
  // ghost=unpredicted (hollow, dimmed), flat=posture flat-mark (crosshair only).
  // Hollow keeps the ring, drops hem and grid. `markOnly` drops the footprint.
  const show = (visible: boolean, markOnly = false): void => {
    const isOffline = denial.offline();
    const isGhost = denial.ghost();
    const flatPosture = denial.flat();
    const hollow = isOffline || isGhost;
    const flatMark = markOnly || flatPosture;
    const footprint = visible && !flatMark;
    line.visible = footprint || (visible && hollow && !flatMark);
    hem.visible = footprint && !hollow;
    cellGrid.visible = footprint && !hollow;
    crosshair.visible = visible;
    if (visible) {
      // Offline never renders red, even while a refused hold is latched.
      const red = !isOffline && denial.isRed();
      if (isOffline) {
        material.color.setHex(OFFLINE_COLOR);
        crosshairMaterial.color.setHex(OFFLINE_COLOR);
        material.opacity = OUTLINE_OPACITY;
        crosshairMaterial.opacity = CROSSHAIR_OPACITY;
      } else if (red) {
        material.color.setHex(DENIED_COLOR);
        hemMaterial.color.setHex(DENIED_COLOR);
        crosshairMaterial.color.setHex(DENIED_COLOR);
        material.opacity = OUTLINE_OPACITY;
        crosshairMaterial.opacity = CROSSHAIR_OPACITY;
      } else if (isGhost) {
        material.opacity = OUTLINE_OPACITY * GHOST_OPACITY_SCALE;
        crosshairMaterial.opacity = CROSSHAIR_OPACITY * GHOST_OPACITY_SCALE;
      } else {
        material.opacity = OUTLINE_OPACITY;
        crosshairMaterial.opacity = CROSSHAIR_OPACITY;
      }
    }
    const ownsCursor = visible && !markOnly;
    if (ownsCursor === showing) return;
    showing = ownsCursor;
    canvas.classList.toggle(OUTLINE_IS_CURSOR_CLASS, ownsCursor);
  };

  return {
    line,
    hem,
    cellGrid,
    crosshair,
    material,
    hemMaterial,
    syncEdgeClipTo: (worldSizeCells: number): void => edgeClip.syncTo(worldSizeCells),
    paintRiserMark,
    paintFlatMark,
    show,
    removeFromScene(): void {
      scene.remove(line);
      scene.remove(crosshair);
      scene.remove(hem);
      scene.remove(cellGrid);
    },
    disposeResources(): void {
      material.dispose();
      crosshairGeometry.dispose();
      crosshairMaterial.dispose();
      hemMaterial.dispose();
      cellGridMaterial.dispose();
    },
  };
}
