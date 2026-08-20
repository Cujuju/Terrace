// A string substitution into a stock three.js shader that REFUSES to no-op.
//
// Extracted from render/terrainMeshes.ts (issue: the self-lit-attribute patch
// and water.ts's depth-alpha patch both needed the exact same "splice at a
// named include, or throw" primitive — two copies of the same contract is
// the duplication the project's own review checklist calls out, so this is
// the one place it is written).
//
// A plain `.replace` on a missing needle returns the source untouched, and
// the only symptom would be the dependent visual feature quietly breaking on
// some future three.js upgrade — silently, in a form no test would notice.
// Every anchor used by a caller of this function is a shader include three
// has carried for many major versions, so this can only fire when an upgrade
// genuinely moves the ground under the patch: it throws on the first frame,
// on the developer's machine, naming the anchor that moved and the material
// it belongs to.

export function spliceShader(
  source: string,
  anchor: string,
  replacement: string,
  materialLabel: string,
): string {
  if (!source.includes(anchor)) {
    throw new Error(
      `${materialLabel} shader patch failed: three no longer emits "${anchor}". ` +
        `Re-anchor the patch at its call site.`,
    );
  }
  return source.replace(anchor, replacement);
}
