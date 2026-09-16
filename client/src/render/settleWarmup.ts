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

interface DrawableFlags {
  isMesh?: boolean;
  isPoints?: boolean;
  isLine?: boolean;
  isSprite?: boolean;
}

interface Walk {
  readonly hidden: Object3D[];
  readonly culled: Object3D[];
  readonly doublePass: Set<Material>;
  readonly shownMaterials: Set<Material>;
  flipped: number;
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

// three draws a transparent DoubleSide material twice, BackSide then FrontSide;
// compileAsync restores DoubleSide before draining its deferred pipeline work,
// so the warmed key is never the frame's (Renderer.js:3620-3632).
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
  if (!node.visible) walk.hidden.push(node);
  if (isDrawable(node)) {
    if (nodeHidden) {
      walk.flipped += 1;
      if (node.frustumCulled) walk.culled.push(node);
      for (const material of materialsOf(node)) {
        if (needsDoublePass(material)) walk.doublePass.add(material);
      }
    } else {
      for (const material of materialsOf(node)) walk.shownMaterials.add(material);
    }
  }
  for (const child of node.children) collect(child, nodeHidden, walk);
}

async function compilePass(scope: WarmupScope, walk: Walk): Promise<void> {
  for (const node of walk.hidden) node.visible = true;
  for (const node of walk.culled) node.frustumCulled = false;

  let done: Promise<void>;
  try {
    // The whole scene, never one layer: a render object's pipeline key hashes the
    // lights of the projected root, so a sub-tree compiles keys the frame never uses.
    done = scope.renderer.compileAsync(scope.scene, scope.camera);
  } finally {
    // three builds the render list synchronously inside compileAsync and only awaits
    // the per-object compiles afterwards, so restoring here cannot flash.
    for (const node of walk.hidden) node.visible = false;
    for (const node of walk.culled) node.frustumCulled = true;
  }
  await done;
}

/**
 * Compiles the pipelines of drawables three skips: hidden ones, which
 * `_projectObject` drops before pipeline creation, so nothing pays its WGSL
 * compile on a first visible frame mid-play.
 */
export async function warmHiddenDrawables(scope: WarmupScope): Promise<WarmupResult> {
  // A cold renderer makes compileAsync await init() before it projects, which would put
  // the restore below ahead of projection: the flags would be back to hidden, warming nothing.
  if (!scope.renderer.initialized) return { flipped: 0 };
  const walk: Walk = {
    hidden: [],
    culled: [],
    doublePass: new Set<Material>(),
    shownMaterials: new Set<Material>(),
    flipped: 0,
  };
  collect(scope.scene, false, walk);
  const flipped = walk.flipped;
  if (flipped === 0) return { flipped };

  // A material a visible drawable also uses is already compiled for both sides by the
  // real render, and overriding it would show that object single-sided during the await.
  for (const material of walk.shownMaterials) walk.doublePass.delete(material);

  markBoot(BOOT_MARKS.settleWarmupStart);
  if (walk.doublePass.size === 0) {
    await compilePass(scope, walk);
  } else {
    // Residual: a hidden double-pass object shown during a pass renders
    // single-sided until that pass ends (load-time only).
    try {
      for (const material of walk.doublePass) material.side = BackSide;
      await compilePass(scope, walk);
      // Everything not double-pass is already cached from the pass above: Pipelines
      // keys `caches` by the render cache key string, and side is the only field moving.
      for (const material of walk.doublePass) material.side = FrontSide;
      await compilePass(scope, walk);
    } finally {
      for (const material of walk.doublePass) material.side = DoubleSide;
    }
  }
  markBoot(BOOT_MARKS.settleWarmupDone);
  return { flipped };
}
