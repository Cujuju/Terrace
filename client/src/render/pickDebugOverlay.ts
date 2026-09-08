import { DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import type { Scene } from 'three';
import { CELL_WORLD_SIZE } from '../config.ts';
import type { TerrainRayPick } from '../terrain/picking.ts';

const MARKER_COLOR_CAP = 0x6fbf73;
const MARKER_COLOR_RISER = 0xffb347;

const MARKER_LIFT_WORLD_UNITS = 0.006;

const MARKER_OPACITY = 0.55;

export interface PickDebugOverlay {
  update(pick: TerrainRayPick | null, band: number | null): void;
  dispose(): void;
}

function createReadout(canvas: HTMLCanvasElement): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'left:16px',
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
  canvas.parentElement?.appendChild(el);
  return el;
}

export const PICK_DEBUG_OVERLAY_DRAW_OBJECTS = 1;

export function createPickDebugOverlay(
  scene: Scene,
  canvas: HTMLCanvasElement,
): PickDebugOverlay {
  const geometry = new PlaneGeometry(CELL_WORLD_SIZE, CELL_WORLD_SIZE);
  geometry.rotateX(-Math.PI / 2);
  const material = new MeshBasicMaterial({
    color: MARKER_COLOR_CAP,
    transparent: true,
    opacity: MARKER_OPACITY,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
  const marker = new Mesh(geometry, material);
  marker.renderOrder = 999;
  marker.visible = false;
  scene.add(marker);

  const readout = createReadout(canvas);

  return {
    update(pick, band) {
      if (pick === null) {
        marker.visible = false;
        readout.textContent =
          'PICK: none\n(pointer is off the world, over sky,\n or over an unreceived chunk)';
        return;
      }
      const colour = pick.hitRiser ? MARKER_COLOR_RISER : MARKER_COLOR_CAP;
      material.color.setHex(colour);
      marker.position.set(
        pick.x * CELL_WORLD_SIZE,
        pick.surfaceY + MARKER_LIFT_WORLD_UNITS,
        pick.y * CELL_WORLD_SIZE,
      );
      marker.visible = true;
      readout.textContent = [
        `PICK   cell ${pick.x}, ${pick.y}`,
        `       surfaceY ${pick.surfaceY.toFixed(3)} wu`,
        `       hit ${pick.hitX.toFixed(3)}, ${pick.hitY.toFixed(3)}, ${pick.hitZ.toFixed(3)} wu`,
        `       ${
          pick.hitRiser
            ? 'RISER  (step side)  █ amber'
            : pick.hitY === pick.surfaceY
              ? 'TREAD  (flat cap)   █ green'
              : 'UNDER  (cave roof)  █ green'
        }`,
        '',
        pick.hitRiser
          ? band === null
            ? 'BAND   named by the ray, REFUSED by the lip guard'
            : `BAND   ${band} — a press here acts on it`
          : 'BAND   none (only a riser face names one)',
      ].join('\n');
    },
    dispose() {
      marker.visible = false;
      scene.remove(marker);
      geometry.dispose();
      material.dispose();
      readout.remove();
    },
  };
}
