import { BackSide, DoubleSide, FrontSide } from 'three';
import type { Camera, Material, Object3D, Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { BOOT_MARKS, markBoot } from '../bootMarks.ts';

export interface WarmupScope {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly renderer: WebGPURenderer;
}

export interface WarmupResult {
  readonly flipped: number;
}

/** Flipping a shared `material.side` is safe only while nothing can turn visible mid-pass. */
export type SideFlip = 'allowed' | 'forbidden';

interface DrawableFlags {
  isMesh?: boolean;
  isPoints?: boolean;
  isLine?: boolean;
  isSprite?: boolean;
}

interface Walk {
  readonly hiddenNodes: Object3D[];
  readonly hiddenDrawables: Object3D[];
  readonly shownDoublePass: Object3D[];
  readonly candidates: Set<Material>;
  readonly shownMaterials: Set<Material>;
}

// The flag edits a pass holds across its synchronous projection, and nothing else.
interface Projection {
  readonly show: readonly Object3D[];
  readonly hide: readonly Object3D[];
  readonly culled: readonly Object3D[];
}

function isDrawable(node: Object3D): boolean {
  const flags = node as Object3D & DrawableFlags;
  return (
    flags.isMesh === true ||
    flags.isPoints === true ||
    flags.isLine === true ||
    flags.isSprite === true
  );
}

function materialsOf(node: Object3D): readonly Material[] {
  const slot = (node as Object3D & { material?: Material | Material[] }).material;
  if (slot === undefined) return [];
  return Array.isArray(slot) ? slot : [slot];
}

// three draws a transparent DoubleSide material twice, BackSide then FrontSide
// (Renderer.js:3620-3632), so a drain at any other side keys pipelines the frame
// never asks for.
function needsDoublePass(material: Material): boolean {
  return (
    material.transparent === true &&
    material.side === DoubleSide &&
    material.forceSinglePass === false
  );
}

function subtreeHasLight(node: Object3D): boolean {
  if ((node as Object3D & { isLight?: boolean }).isLight === true) return true;
  for (const child of node.children) {
    if (subtreeHasLight(child)) return true;
  }
  return false;
}

// Hidden ancestors are flipped too: projection returns at the first invisible
// node, so its descendants never reach pipeline creation either.
function collect(node: Object3D, ancestorHidden: boolean, walk: Walk): void {
  // Every lit pipeline is keyed on the visible-light set (see plugins/kit/lightBank.ts),
  // so admitting a light here compiles keys the frame loop never asks for.
  if (!node.visible && subtreeHasLight(node)) return;
  const nodeHidden = ancestorHidden || !node.visible;
  const drawable = isDrawable(node);
  if (!node.visible && !drawable) walk.hiddenNodes.push(node);
  if (drawable) {
    if (nodeHidden) {
      walk.hiddenDrawables.push(node);
      for (const material of materialsOf(node)) {
        if (needsDoublePass(material)) walk.candidates.add(material);
      }
    } else {
      let doublePass = false;
      for (const material of materialsOf(node)) {
        walk.shownMaterials.add(material);
        if (needsDoublePass(material)) doublePass = true;
      }
      if (doublePass) walk.shownDoublePass.push(node);
    }
  }
  for (const child of node.children) collect(child, nodeHidden, walk);
}

// The one rule: a double-pass drawable joins a projection only when the pass
// drains at a side this warmup set for every double-pass material it carries.
function admits(node: Object3D, flipSet: ReadonlySet<Material>): boolean {
  for (const material of materialsOf(node)) {
    if (needsDoublePass(material) && !flipSet.has(material)) return false;
  }
  return true;
}

function planProjection(
  walk: Walk,
  flipSet: ReadonlySet<Material>,
): { projection: Projection; flipped: number } {
  const show: Object3D[] = [...walk.hiddenNodes];
  const hide: Object3D[] = [];
  const culled: Object3D[] = [];
  let flipped = 0;
  for (const node of walk.hiddenDrawables) {
    if (!admits(node, flipSet)) {
      if (node.visible) hide.push(node);
      continue;
    }
    flipped += 1;
    if (!node.visible) show.push(node);
    if (node.frustumCulled) culled.push(node);
  }
  // Already compiled by the real render: hiding them for the projection only keeps
  // them out of the compile list, and out of a drain at the wrong side.
  for (const node of walk.shownDoublePass) {
    if (!admits(node, flipSet)) hide.push(node);
  }
  return { projection: { show, hide, culled }, flipped };
}

async function compilePass(
  scope: WarmupScope,
  projection: Projection,
  // Runs once projection has queued the deferred work items and before the drain
  // reads `material.side` to key their pipelines.
  beforeDrain: (() => void) | null = null,
): Promise<void> {
  for (const node of projection.show) node.visible = true;
  for (const node of projection.hide) node.visible = false;
  for (const node of projection.culled) node.frustumCulled = false;

  let done: Promise<void>;
  try {
    // The whole scene, never one layer: a render object's pipeline key hashes the
    // lights of the projected root, so a sub-tree compiles keys the frame never uses.
    done = scope.renderer.compileAsync(scope.scene, scope.camera);
  } finally {
    // three builds the render list synchronously inside compileAsync and only awaits
    // the per-object compiles afterwards, so restoring here cannot flash.
    for (const node of projection.show) node.visible = false;
    for (const node of projection.hide) node.visible = true;
    for (const node of projection.culled) node.frustumCulled = true;
    beforeDrain?.();
  }
  await done;
}

/**
 * Compiles the pipelines of drawables three skips: hidden ones, which
 * `_projectObject` drops before pipeline creation, so nothing pays its WGSL
 * compile on a first visible frame mid-play.
 */
export async function warmHiddenDrawables(
  scope: WarmupScope,
  sideFlip: SideFlip = 'forbidden',
): Promise<WarmupResult> {
  // A cold renderer makes compileAsync await init() before it projects, which would put
  // the restore below ahead of projection: the flags would be back to hidden, warming nothing.
  if (!scope.renderer.initialized) return { flipped: 0 };
  const walk: Walk = {
    hiddenNodes: [],
    hiddenDrawables: [],
    shownDoublePass: [],
    candidates: new Set<Material>(),
    shownMaterials: new Set<Material>(),
  };
  collect(scope.scene, false, walk);

  const flipSet = new Set<Material>();
  // A pass holds the flip for its whole length, seconds, so a drawable shown meanwhile
  // would draw one-sided: only the pass before play may flip.
  if (sideFlip === 'allowed') {
    // A material a visible drawable also uses cannot be overridden: that object
    // would draw single-sided for the await.
    for (const material of walk.candidates) {
      if (!walk.shownMaterials.has(material)) flipSet.add(material);
    }
  }

  // Residual: on a re-run, a hidden double-pass drawable and its descendants are
  // left out, so they compile at first show unless the settle pass warmed them.
  const { projection, flipped } = planProjection(walk, flipSet);
  if (flipped === 0) return { flipped };

  markBoot(BOOT_MARKS.settleWarmupStart);
  if (flipSet.size === 0) {
    await compilePass(scope, projection);
  } else {
    // Residual: a hidden double-pass object shown during a pass renders
    // single-sided until that pass ends (load-time only).
    try {
      // Projecting at DoubleSide queues the back-side render object as well as the
      // default one, and the drain keys both off the side set here.
      await compilePass(scope, projection, () => {
        for (const material of flipSet) material.side = BackSide;
      });
      // The default render object came out of the drain above built for BackSide, and
      // only a material version change makes `RenderObjects.get` re-key it to FrontSide.
      for (const material of flipSet) {
        material.side = FrontSide;
        material.needsUpdate = true;
      }
      // FrontSide at projection queues the default render object alone, so the back-side
      // one still holds its pipeline and the cache keeps it instead of releasing it.
      await compilePass(scope, projection);
    } finally {
      for (const material of flipSet) material.side = DoubleSide;
    }
  }
  markBoot(BOOT_MARKS.settleWarmupDone);
  return { flipped };
}
