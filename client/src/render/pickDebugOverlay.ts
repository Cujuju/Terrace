// PICK DEBUG OVERLAY — shows exactly what terrain/picking.ts returns, and
// nothing more (owner, 2026-08-23: "I need to visually see what the current
// picking capabilities are").
//
// WHY IT EXISTS AND WHAT IT IS HONEST ABOUT. The two-method sculpt design turns
// on a question nobody had looked at directly: what can the game currently
// identify under the pointer? The answer is ONE CELL, a riser/cap flag, and the
// point on that face the ray met — pickTerrainCellByRay returns
// {x, y, surfaceY, spanIndex, hitRiser, hitX, hitY, hitZ} and there is no other
// spatial information anywhere in the pick path.
//
// So the MARKER deliberately draws A SINGLE CELL — the cell is still the whole
// of what the picker names for a SCULPT, and drawing anything richer would
// misrepresent it. The exact hit point is reported as text beside it rather
// than drawn: render/brushPreview.ts is what draws at that point, and two marks
// at the same place would only be read as one.
//
// The readout's BAND line is a different question, answered by two other
// modules in sequence: world.ts derives the band from the HEIGHT the ray struck
// on the riser face, and render/layerEdgeOverlay.ts then answers yes or no
// about whether that band's contour actually runs past this cell — a guard, not
// a search (2026-08-27). Both halves are shown, beside the pick, precisely so
// they can be compared: the picker names a face, the derivation names a band,
// the guard admits or refuses it, and a press that does nothing is one of those
// three.
//
// It is separate from render/brushPreview.ts on purpose. The brush outline
// answers "what will one click change" — a FOOTPRINT, radius-sized. This
// answers "what did the picker name" — one cell. Merging them would let the
// radius hide the thing being demonstrated.
//
// NOT REACTIVE, and not a Solid component: it is driven straight from the
// viewport's frame hook with the same pick object the brush outline gets, and
// it writes DOM text imperatively. A signal per frame would be churn for a
// readout that changes on most frames anyway.

import { DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import type { Scene } from 'three';
import { CELL_WORLD_SIZE } from '../config.ts';
import type { TerrainRayPick } from '../terrain/picking.ts';

/**
 * Marker colour when the ray landed on a terrace TREAD (its flat cap) — the
 * same green the HUD uses for an active control, so "flat" reads as the
 * ordinary case.
 */
const MARKER_COLOR_CAP = 0x6fbf73;
/**
 * Marker colour when the ray struck a terrace RISER (a step's side). Amber, and
 * matched to render/brushPreview.ts's riser colour so the two readouts agree at
 * a glance rather than needing to be cross-referenced.
 */
const MARKER_COLOR_RISER = 0xffb347;

/**
 * How far above the picked surface the marker floats, in world units. Small
 * enough to read as lying ON the tread, large enough to clear z-fighting with
 * the cap it covers.
 */
const MARKER_LIFT_WORLD_UNITS = 0.006;

/** Marker fill opacity — solid enough to find instantly, sheer enough to see the ground through. */
const MARKER_OPACITY = 0.55;

export interface PickDebugOverlay {
  /**
   * Draws the marker and readout for `pick`, or hides both on null.
   *
   * `band` is World.highlightLayerEdge's answer for this same pick — the band
   * a press would act on, already through the overlay's lip-exists guard. The
   * readout separates the two halves of that answer (which band the RAY named,
   * and whether the guard admitted it) because when a press does nothing those
   * are different faults with different fixes.
   */
  update(pick: TerrainRayPick | null, band: number | null): void;
  dispose(): void;
}

/**
 * Builds the floating text readout. A plain absolutely-positioned element over
 * the canvas rather than part of the HUD: this is a diagnostic, it is meant to
 * be obvious, and it must not inherit the HUD's own pointer-events or layout.
 */
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

export function createPickDebugOverlay(
  scene: Scene,
  canvas: HTMLCanvasElement,
): PickDebugOverlay {
  // One cell, lying flat. Rotated onto the ground plane once at build time.
  const geometry = new PlaneGeometry(CELL_WORLD_SIZE, CELL_WORLD_SIZE);
  geometry.rotateX(-Math.PI / 2);
  const material = new MeshBasicMaterial({
    color: MARKER_COLOR_CAP,
    transparent: true,
    opacity: MARKER_OPACITY,
    // Overlay semantics, matching the brush ring: the marker must be findable
    // even when the cell it names sits behind a taller step.
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
        // THE FACE, spelled out three ways rather than two, because the three
        // states behave differently and only the pair (hitRiser, hitY vs
        // surfaceY) tells them apart: a riser grabs, a tread seeds, and a cave
        // roof's underside is inert to a raise.
        `       ${
          pick.hitRiser
            ? 'RISER  (step side)  █ amber'
            : pick.hitY === pick.surfaceY
              ? 'TREAD  (flat cap)   █ green'
              : 'UNDER  (cave roof)  █ green'
        }`,
        '',
        // WHICH BAND THE RAY NAMED, and whether the guard let it through —
        // separately. A riser hit always names a band; the guard is what can
        // then refuse it, and a readout that collapsed the two into "none"
        // could not tell "I am not on a face" from "I am on a face whose lip
        // does not run past this cell".
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
