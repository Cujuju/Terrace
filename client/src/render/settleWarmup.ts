import type { Camera, Object3D, Scene } from 'three';
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

function isDrawable(node: Object3D): boolean {
  const flags = node as Object3D & DrawableFlags;
  return (
    flags.isMesh === true ||
    flags.isPoints === true ||
    flags.isLine === true ||
    flags.isSprite === true
  );
}

// Hidden ancestors are flipped too: projection returns at the first invisible
// node, so its descendants never reach pipeline creation either.
function collect(
  node: Object3D,
  ancestorHidden: boolean,
  hidden: Object3D[],
  culled: Object3D[],
): number {
  const nodeHidden = ancestorHidden || !node.visible;
  if (!node.visible) hidden.push(node);
  let flipped = 0;
  if (nodeHidden && isDrawable(node)) {
    flipped = 1;
    if (node.frustumCulled) culled.push(node);
  }
  for (const child of node.children) flipped += collect(child, nodeHidden, hidden, culled);
  return flipped;
}

/**
 * Compiles the pipelines of drawables three skips: hidden ones, which
 * `_projectObject` drops before pipeline creation, so nothing pays its WGSL
 * compile on a first visible frame mid-play.
 */
export async function warmHiddenDrawables(scope: WarmupScope): Promise<WarmupResult> {
  const hidden: Object3D[] = [];
  const culled: Object3D[] = [];
  const flipped = collect(scope.scene, false, hidden, culled);
  if (flipped === 0) return { flipped };

  for (const node of hidden) node.visible = true;
  for (const node of culled) node.frustumCulled = false;

  markBoot(BOOT_MARKS.settleWarmupStart);
  let done: Promise<void>;
  try {
    // The whole scene, never one layer: a render object's pipeline key hashes the
    // lights of the projected root, so a sub-tree compiles keys the frame never uses.
    done = scope.renderer.compileAsync(scope.scene, scope.camera);
  } finally {
    // three builds the render list synchronously inside compileAsync and only awaits
    // the per-object compiles afterwards, so restoring here cannot flash.
    for (const node of hidden) node.visible = false;
    for (const node of culled) node.frustumCulled = true;
  }
  await done;
  markBoot(BOOT_MARKS.settleWarmupDone);
  return { flipped };
}
