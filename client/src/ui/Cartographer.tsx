// The Cartographer: an in-game map table that renders the player's KNOWN
// world — exactly the chunks the server has sent, nothing else — as an inked
// parchment chart, with the fog boundary drawn as the chart's own burnt edge.
//
// Client-only by construction: everything here is derived from the terrain
// mirror through the ChartSource window (terrain/chart.ts holds the pure
// model; this file is the canvas paint and the Solid overlay around it). The
// chart is drawn ONCE per open — it is a document, not a live minimap — and
// the Save button exports that same canvas as a PNG.
//
// SOLID REACTIVITY: as everywhere in the HUD, reactive reads happen inside
// JSX or inside handlers, never in a component-body const. The one deliberate
// exception to liveness: the canvas paint in onMount reads the world once,
// which is the point — a chart is dated the moment it is drawn.

import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import {
  buildChartModel,
  CHART_LAND,
  CHART_UNKNOWN,
  CHART_WATER,
  SINGE_RANGE_CELLS,
  chartWindow,
  hash01,
  type ChartModel,
  type ChartSource,
  type ChartWindow,
} from '../terrain/chart.ts';
import { worldIdentity } from '../state/hudState.ts';

/**
 * Whether the chart overlay is open. Module-scope like the hudState signals —
 * the HUD button toggles it, the overlay and the HUD's Escape handling both
 * read it — but deliberately NOT persisted: reopening a modal on reload is a
 * surprise, not a restored preference.
 */
const [chartOpen, setChartOpenSignal] = createSignal(false);
export { chartOpen };
export function setChartOpen(open: boolean): void {
  setChartOpenSignal(open);
}

// ---------------------------------------------------------------------------
// Chart geometry. The terrain square targets a fixed pixel budget and the
// margin around it carries the frame; both are design decisions, not derived.
// ---------------------------------------------------------------------------

/**
 * Pixel budget for the terrain square's edge. 1536 keeps the default 512-cell
 * world at a legible 3 px/cell while the exported PNG stays comfortably under
 * a couple of megabytes.
 */
const CHART_TERRAIN_TARGET_PX = 1536;
/** Bounds on the per-cell scale: below 2 px contours merge; above 12 px a young empire's chart turns into a poster of empty cells. */
const CHART_MIN_PX_PER_CELL = 2;
const CHART_MAX_PX_PER_CELL = 12;
/** Parchment margin around the terrain square — room for the frame lines. */
const CHART_MARGIN_PX = 56;
/** The double frame: outer/inner insets from the canvas edge, ink widths. */
const FRAME_OUTER_INSET_PX = 18;
const FRAME_INNER_INSET_PX = 26;

// ---------------------------------------------------------------------------
// The chart's palette. Sepia ink on aged parchment, one blue-grey for water —
// a chart is a DOCUMENT of the world, so it deliberately does not reuse the
// terrain palette: the game colours say "this is the world", these say "this
// is a drawing of it".
// ---------------------------------------------------------------------------

const PARCHMENT = '#e9dcb5';
const PARCHMENT_MOTTLE_DARK = '179, 154, 99';
const PARCHMENT_MOTTLE_LIGHT = '255, 244, 214';
const INK = '58, 47, 27'; // sepia ink, as "r, g, b" for rgba() composition
const COAST_INK = '47, 39, 24';
const WATER_WASH = '90, 118, 134';
const WATER_LINE = '58, 72, 84';
const BURN_OUTER = '124, 90, 46'; // the wide singe gradient
const BURN_EDGE = '43, 29, 12'; // the torn line itself

/** Mottle block size in canvas px: big enough to read as fibre, not noise. */
const MOTTLE_BLOCK_PX = 8;
/** Water gets a hatch dash every N world rows — the old-chart wave shorthand. */
const WATER_HATCH_ROW_STRIDE = 5;
/** Fraction of hatch-row water cells that actually carry a dash. */
const WATER_HATCH_DENSITY = 0.35;

interface ChartLayout {
  readonly pxPerCell: number;
  readonly margin: number;
  readonly canvasPx: number;
}

function layoutFor(size: number): ChartLayout {
  const raw = Math.floor(CHART_TERRAIN_TARGET_PX / size);
  const pxPerCell = Math.min(
    CHART_MAX_PX_PER_CELL,
    Math.max(CHART_MIN_PX_PER_CELL, raw),
  );
  return {
    pxPerCell,
    margin: CHART_MARGIN_PX,
    canvasPx: size * pxPerCell + 2 * CHART_MARGIN_PX,
  };
}

/**
 * Paints the whole chart. Painting order is the layering: parchment and its
 * mottle, terrain washes, water hatching, contour/coast ink, the singed
 * frontier, captions, then the frame and cartouche on top.
 *
 * Everything terrain is drawn through the WINDOW (terrain/chart.ts): world
 * cell (x, y) lands at canvas (M + (x - win.x0) * P, …), and cells outside
 * the window are simply never visited.
 */
function drawChart(
  ctx: CanvasRenderingContext2D,
  model: ChartModel,
  win: ChartWindow,
  layout: ChartLayout,
  title: string,
  subtitle: string,
): void {
  const { size, kind, band, singe } = model;
  const { pxPerCell: P, margin: M, canvasPx: W } = layout;
  // Window bounds in world coordinates, inclusive-exclusive.
  const wx0 = win.x0;
  const wy0 = win.y0;
  const wx1 = win.x0 + win.span;
  const wy1 = win.y0 + win.span;

  // ── Parchment ground with deterministic mottling ──────────────────────────
  ctx.fillStyle = PARCHMENT;
  ctx.fillRect(0, 0, W, W);
  const mottleBlocks = Math.ceil(W / MOTTLE_BLOCK_PX);
  for (let by = 0; by < mottleBlocks; by++) {
    for (let bx = 0; bx < mottleBlocks; bx++) {
      const h = hash01(bx, by);
      // Two overlapping frequencies read as fibre; one reads as a grid.
      const coarse = hash01(bx >> 2, by >> 2);
      const tone = (h + coarse) / 2;
      if (tone < 0.42) {
        ctx.fillStyle = `rgba(${PARCHMENT_MOTTLE_DARK}, ${(0.42 - tone) * 0.16})`;
      } else if (tone > 0.72) {
        ctx.fillStyle = `rgba(${PARCHMENT_MOTTLE_LIGHT}, ${(tone - 0.72) * 0.3})`;
      } else {
        continue;
      }
      ctx.fillRect(bx * MOTTLE_BLOCK_PX, by * MOTTLE_BLOCK_PX, MOTTLE_BLOCK_PX, MOTTLE_BLOCK_PX);
    }
  }

  // ── Terrain washes ────────────────────────────────────────────────────────
  for (let y = wy0; y < wy1; y++) {
    for (let x = wx0; x < wx1; x++) {
      const i = y * size + x;
      const k = kind[i];
      if (k === CHART_UNKNOWN) continue;
      const px = M + (x - wx0) * P;
      const py = M + (y - wy0) * P;
      if (k === CHART_WATER) {
        // Deeper water takes a heavier wash: depth 0 is the waterline flats.
        const depth = -band[i];
        ctx.fillStyle = `rgba(${WATER_WASH}, ${Math.min(0.16 + depth * 0.022, 0.52)})`;
        ctx.fillRect(px, py, P, P);
      } else {
        // Land stays close to bare parchment; height reads mainly through the
        // contour ink, the wash only hints at it.
        const b = band[i];
        if (b > 0) {
          ctx.fillStyle = `rgba(${INK}, ${Math.min(b * 0.018, 0.16)})`;
          ctx.fillRect(px, py, P, P);
        }
      }
    }
  }

  // ── Water hatching: the wave-dash shorthand of old charts ────────────────
  ctx.fillStyle = `rgba(${WATER_LINE}, 0.5)`;
  for (let y = wy0; y < wy1; y++) {
    if (y % WATER_HATCH_ROW_STRIDE !== 2) continue;
    for (let x = wx0; x < wx1; x++) {
      const i = y * size + x;
      if (kind[i] !== CHART_WATER) continue;
      if (hash01(x, y) >= WATER_HATCH_DENSITY) continue;
      ctx.fillRect(M + (x - wx0) * P + P * 0.15, M + (y - wy0) * P + P * 0.5, P * 0.7, 1);
    }
  }

  // ── Ink lines: coast (heavy), land contours, water depth contours ───────
  // Three batched paths so a 512² world strokes three times, not 100k times.
  const coast = new Path2D();
  const landContour = new Path2D();
  const waterContour = new Path2D();
  const edge = (
    path: Path2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): void => {
    path.moveTo(M + (x1 - wx0) * P, M + (y1 - wy0) * P);
    path.lineTo(M + (x2 - wx0) * P, M + (y2 - wy0) * P);
  };
  for (let y = wy0; y < wy1; y++) {
    for (let x = wx0; x < wx1; x++) {
      const i = y * size + x;
      const k = kind[i];
      if (k === CHART_UNKNOWN) continue;
      // East edge against (x+1, y).
      if (x < size - 1) {
        const j = i + 1;
        const kj = kind[j];
        if (kj !== CHART_UNKNOWN) {
          if (k !== kj) edge(coast, x + 1, y, x + 1, y + 1);
          else if (band[i] !== band[j]) {
            edge(k === CHART_LAND ? landContour : waterContour, x + 1, y, x + 1, y + 1);
          }
        }
      }
      // South edge against (x, y+1).
      if (y < size - 1) {
        const j = i + size;
        const kj = kind[j];
        if (kj !== CHART_UNKNOWN) {
          if (k !== kj) edge(coast, x, y + 1, x + 1, y + 1);
          else if (band[i] !== band[j]) {
            edge(k === CHART_LAND ? landContour : waterContour, x, y + 1, x + 1, y + 1);
          }
        }
      }
    }
  }
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(${INK}, 0.55)`;
  ctx.lineWidth = 1;
  ctx.stroke(landContour);
  ctx.strokeStyle = `rgba(${WATER_LINE}, 0.35)`;
  ctx.lineWidth = 1;
  ctx.stroke(waterContour);
  ctx.strokeStyle = `rgba(${COAST_INK}, 0.9)`;
  ctx.lineWidth = Math.max(1.4, P * 0.5);
  ctx.stroke(coast);

  // ── The frontier as the parchment's burnt edge ───────────────────────────
  // Wide singe gradient first (unknown cells near revealed territory darken,
  // fading with BFS distance), then the torn line itself: the revealed/unknown
  // boundary stroked with per-cell jitter so it reads as a tear, not a rule.
  for (let y = wy0; y < wy1; y++) {
    for (let x = wx0; x < wx1; x++) {
      const i = y * size + x;
      const s = singe[i];
      if (s === 0) continue;
      const fade = 1 - (s - 1) / SINGE_RANGE_CELLS;
      const alpha = fade * (0.26 + hash01(x, y) * 0.1);
      ctx.fillStyle = `rgba(${s === 1 ? BURN_EDGE : BURN_OUTER}, ${alpha})`;
      ctx.fillRect(M + (x - wx0) * P, M + (y - wy0) * P, P, P);
    }
  }
  const torn = new Path2D();
  const jitter = (x: number, y: number, salt: number): number =>
    (hash01(x * 2 + salt, y * 2 + salt) - 0.5) * P * 0.8;
  for (let y = wy0; y < wy1; y++) {
    for (let x = wx0; x < wx1; x++) {
      const i = y * size + x;
      if (kind[i] === CHART_UNKNOWN) continue;
      // Any 4-neighbour that is unknown (or the seam sits on the world edge
      // of the revealed area? — no: the world border gets the frame, not a
      // tear) marks a torn edge on that side.
      const sides: Array<[number, number, number, number, boolean]> = [
        [x + 1, y, x + 1, y + 1, x < size - 1 && kind[i + 1] === CHART_UNKNOWN],
        [x, y, x, y + 1, x > 0 && kind[i - 1] === CHART_UNKNOWN],
        [x, y + 1, x + 1, y + 1, y < size - 1 && kind[i + size] === CHART_UNKNOWN],
        [x, y, x + 1, y, y > 0 && kind[i - size] === CHART_UNKNOWN],
      ];
      for (const [x1, y1, x2, y2, isTear] of sides) {
        if (!isTear) continue;
        // Jitter keys on WORLD coordinates so the tear is stable as the
        // window moves with new reveals; only the projection is windowed.
        torn.moveTo(M + (x1 - wx0) * P + jitter(x1, y1, 1), M + (y1 - wy0) * P + jitter(x1, y1, 3));
        torn.lineTo(M + (x2 - wx0) * P + jitter(x2, y2, 1), M + (y2 - wy0) * P + jitter(x2, y2, 3));
      }
    }
  }
  ctx.strokeStyle = `rgba(${BURN_EDGE}, 0.6)`;
  ctx.lineWidth = Math.max(1.5, P * 0.55);
  ctx.stroke(torn);

  // ── Here be krakens ──────────────────────────────────────────────────────
  if (model.krakenCell >= 0) {
    const kx = model.krakenCell % size;
    const ky = Math.floor(model.krakenCell / size);
    // The anchor is the GLOBALLY deepest unknown cell, which usually lies far
    // outside the cropped window — project it, then clamp it onto the sheet
    // with room for the words, so the caption sits at the sheet edge in the
    // deep's true direction and never clips the frame (or crowds the rose).
    const fontPx = Math.max(18, Math.round(W * 0.018));
    ctx.font = `italic 600 ${fontPx}px Georgia, 'Iowan Old Style', 'Times New Roman', serif`;
    const capHalfWidth = ctx.measureText('here be krakens').width / 2 + 10;
    const minC = M + capHalfWidth;
    const maxC = W - M - capHalfWidth;
    let cx = Math.max(minC, Math.min(maxC, M + (kx - wx0 + 0.5) * P));
    let cy = Math.max(M + fontPx * 2, Math.min(W - M - fontPx * 2.5, M + (ky - wy0 + 0.5) * P));
    // Keep clear of the compass rose (drawn below at a known position): if
    // the caption's box would touch the rose's backing circle, slide it left
    // of the circle — same corner of the deep, no collision.
    const roseRadius = Math.max(34, W * 0.028) + 10;
    const roseCentre = W - FRAME_INNER_INSET_PX - (roseRadius - 10) - 22;
    const roseLeft = roseCentre - roseRadius;
    const roseTop = roseCentre - roseRadius;
    if (cy + fontPx > roseTop && cx + capHalfWidth > roseLeft - 12) {
      cx = Math.max(minC, roseLeft - 12 - capHalfWidth);
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.09);
    ctx.fillStyle = `rgba(${INK}, 0.55)`;
    ctx.font = `italic 600 ${fontPx}px Georgia, 'Iowan Old Style', 'Times New Roman', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('here be krakens', 0, 0);
    // One small serpent squiggle beneath the words — flourish, not a mural.
    ctx.strokeStyle = `rgba(${INK}, 0.4)`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const span = Math.max(60, W * 0.045);
    ctx.moveTo(-span / 2, 16);
    ctx.bezierCurveTo(-span / 4, 8, -span / 8, 24, 0, 16);
    ctx.bezierCurveTo(span / 8, 8, span / 4, 24, span / 2, 16);
    ctx.stroke();
    ctx.restore();
  }

  // ── The frame: a double ink rule around the whole sheet ──────────────────
  ctx.strokeStyle = `rgba(${INK}, 0.85)`;
  ctx.lineWidth = 2.5;
  ctx.strokeRect(
    FRAME_OUTER_INSET_PX,
    FRAME_OUTER_INSET_PX,
    W - 2 * FRAME_OUTER_INSET_PX,
    W - 2 * FRAME_OUTER_INSET_PX,
  );
  ctx.lineWidth = 1;
  ctx.strokeRect(
    FRAME_INNER_INSET_PX,
    FRAME_INNER_INSET_PX,
    W - 2 * FRAME_INNER_INSET_PX,
    W - 2 * FRAME_INNER_INSET_PX,
  );

  // ── Cartouche: the chart names its world ─────────────────────────────────
  const titleSize = Math.max(20, Math.round(W * 0.017));
  const subSize = Math.max(11, Math.round(W * 0.009));
  ctx.font = `600 ${titleSize}px Georgia, 'Iowan Old Style', 'Times New Roman', serif`;
  const titleWidth = ctx.measureText(title).width;
  ctx.font = `${subSize}px Georgia, 'Times New Roman', serif`;
  const subWidth = ctx.measureText(subtitle).width;
  const boxW = Math.max(titleWidth, subWidth) + 44;
  const boxH = titleSize + subSize + 34;
  const boxX = FRAME_INNER_INSET_PX + 14;
  const boxY = FRAME_INNER_INSET_PX + 14;
  ctx.fillStyle = 'rgba(242, 231, 196, 0.92)';
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = `rgba(${INK}, 0.85)`;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.lineWidth = 0.75;
  ctx.strokeRect(boxX + 4, boxY + 4, boxW - 8, boxH - 8);
  ctx.fillStyle = `rgba(${INK}, 0.95)`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 ${titleSize}px Georgia, 'Iowan Old Style', 'Times New Roman', serif`;
  ctx.fillText(title, boxX + boxW / 2, boxY + 14 + titleSize);
  ctx.fillStyle = `rgba(${INK}, 0.7)`;
  ctx.font = `${subSize}px Georgia, 'Times New Roman', serif`;
  ctx.fillText(subtitle, boxX + boxW / 2, boxY + boxH - 12);

  // ── Compass rose, bottom-right, over its own parchment backing ──────────
  const roseR = Math.max(34, W * 0.028);
  const roseX = W - FRAME_INNER_INSET_PX - roseR - 22;
  const roseY = W - FRAME_INNER_INSET_PX - roseR - 22;
  ctx.fillStyle = 'rgba(242, 231, 196, 0.85)';
  ctx.beginPath();
  ctx.arc(roseX, roseY, roseR + 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(${INK}, 0.8)`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(roseX, roseY, roseR + 10, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(roseX, roseY, roseR * 0.45, 0, Math.PI * 2);
  ctx.stroke();
  for (let ray = 0; ray < 8; ray++) {
    const angle = (ray * Math.PI) / 4;
    const len = ray % 2 === 0 ? roseR : roseR * 0.55;
    ctx.beginPath();
    ctx.moveTo(roseX, roseY);
    ctx.lineTo(roseX + Math.sin(angle) * len, roseY - Math.cos(angle) * len);
    ctx.lineWidth = ray % 2 === 0 ? 1.6 : 0.9;
    ctx.stroke();
  }
  ctx.fillStyle = `rgba(${INK}, 0.9)`;
  ctx.font = `600 ${Math.round(roseR * 0.42)}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('N', roseX, roseY - roseR - 14);
}

/** File-safe slug of the world name for the export filename. */
function chartFilename(name: string | null): string {
  const slug = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug === '' ? 'terrace' : slug}-chart.png`;
}

export function Cartographer(props: {
  source: () => ChartSource | null;
}): JSX.Element {
  let overlayEl: HTMLDivElement | undefined;
  let canvasEl: HTMLCanvasElement | undefined;

  // Drawn once on mount — the component only exists while the overlay is open
  // (Hud wraps it in <Show>), so "on mount" IS "on open".
  onMount(() => {
    const source = props.source();
    if (source === null || canvasEl === undefined) return;
    const model = buildChartModel(source);
    const win = chartWindow(model);
    const layout = layoutFor(win.span);
    canvasEl.width = layout.canvasPx;
    canvasEl.height = layout.canvasPx;
    const ctx = canvasEl.getContext('2d');
    if (ctx === null) return;
    const identity = worldIdentity();
    const revealedPct = Math.round(
      (model.revealedCount / (model.size * model.size)) * 100,
    );
    drawChart(
      ctx,
      model,
      win,
      layout,
      identity.name ?? 'An Uncharted World',
      `${identity.difficulty !== null ? `difficulty ${identity.difficulty} · ` : ''}${revealedPct}% of the world charted`,
    );
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') setChartOpen(false);
  };
  window.addEventListener('keydown', onKeyDown);
  onCleanup(() => window.removeEventListener('keydown', onKeyDown));

  const saveChart = (): void => {
    canvasEl?.toBlob((blob) => {
      if (blob === null) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = chartFilename(worldIdentity().name);
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  };

  return (
    <div
      class="chart-overlay"
      role="dialog"
      aria-label="Chart of the known world"
      ref={overlayEl}
      onClick={(event) => {
        // The scrim closes; the chart and its toolbar do not.
        if (event.target === overlayEl) setChartOpen(false);
      }}
    >
      <Show
        when={props.source() !== null}
        fallback={<p class="chart-empty">No world to chart yet — join a world first.</p>}
      >
        <div class="chart-sheet">
          <canvas class="chart-canvas" ref={canvasEl} />
          <div class="chart-toolbar">
            <button
              type="button"
              class="chart-button"
              title="Download this chart as a PNG image."
              onClick={saveChart}
            >
              Save chart
            </button>
            <button
              type="button"
              class="chart-button"
              title="Close the chart."
              aria-label="Close the chart"
              onClick={() => setChartOpen(false)}
            >
              ✕
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
