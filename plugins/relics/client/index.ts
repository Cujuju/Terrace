// relics — the client half (contract: client/src/plugins/types.ts).
//
// Three responsibilities, in the three things the ctx grants:
//
//   layer + onFrame   — a floating, slowly rotating gem per relic, sitting just
//                       above the RENDERED terrain surface.
//   onCanvasPress     — claims a press that lands on a relic (collect) or that
//                       lands anywhere while an active skill is armed (cast),
//                       so neither one also sculpts or spins the camera.
//   registerHudPanel  — the skill list and the cast buttons.
//
// The imperative half lives here; the maths it needs is in ./gems.ts (pure and
// tested) and the reactive state it shares with the panel is in ./state.ts.

import { Mesh, MeshStandardMaterial, OctahedronGeometry } from 'three';
// Type-only import of the client plugin contract, mirroring how the server
// halves type-import theirs from server/src. Erased at runtime.
import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import {
  CAST_DENIED_MESSAGE,
  CAST_MESSAGE,
  COLLECT_MESSAGE,
  RELICS_MESSAGE,
  SKILLS_MESSAGE,
  parseRelicsPayload,
  parseSkillsPayload,
  type RelicView,
} from '../protocol.ts';
import {
  CELL_WORLD_SIZE,
  GEM_HOVER_CELLS,
  GEM_RADIUS_CELLS,
  gemBobOffset,
  gemPhaseFor,
  gemSpinAngle,
  relicColor,
  relicUnderCell,
} from './gems.ts';
import { RelicsPanel } from './RelicsPanel.tsx';
import {
  armSkill,
  armedSkill,
  relics,
  resetRelicsClientState,
  setCastDenial,
  setRelics,
  setSkills,
} from './state.ts';

/**
 * Emissive strength of a gem. High enough that a relic reads as lit from within
 * against shaded terrain (the scene has no point lights — see
 * client/src/render/scene.ts — so without emission a gem in shadow is a grey
 * lump), low enough that ACES tone mapping does not blow it out to white and
 * lose the per-category colour that is the whole point.
 */
const GEM_EMISSIVE_INTENSITY = 0.6;

/** Gem surface: matte and non-metallic so the flat octahedron facets read. */
const GEM_ROUGHNESS = 0.35;
const GEM_METALNESS = 0;

/**
 * Octahedron subdivision detail. Zero — the literal 8-triangle solid. A relic
 * is a low-poly gem by design, and any subdivision above 0 rounds it into a
 * sphere and loses the facets.
 */
const GEM_DETAIL = 0;

/** Primary pointer button (mouse left / the only touch button). */
const PRIMARY_BUTTON = 0;

/** One rendered relic: its mesh plus the animation phase that keeps it out of
 * lockstep with its neighbours. */
interface GemEntry {
  readonly mesh: Mesh;
  readonly phaseS: number;
  readonly relic: RelicView;
}

/** Seconds since attach, driving bob and spin. */
let elapsedS = 0;

/** Live gems by relic id. */
const gems = new Map<string, GemEntry>();

/** Shared across every gem: geometry is identical, only the material colour
 * differs, so one geometry is allocated for the whole plugin. */
let sharedGeometry: OctahedronGeometry | null = null;

function geometry(): OctahedronGeometry {
  sharedGeometry ??= new OctahedronGeometry(GEM_RADIUS_CELLS, GEM_DETAIL);
  return sharedGeometry;
}

function disposeGem(entry: GemEntry): void {
  entry.mesh.removeFromParent();
  // The geometry is shared and outlives the gem; the material is per-relic.
  (entry.mesh.material as MeshStandardMaterial).dispose();
}

function createGem(relic: RelicView): GemEntry {
  const color = relicColor(relic.skill);
  const material = new MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: GEM_EMISSIVE_INTENSITY,
    roughness: GEM_ROUGHNESS,
    metalness: GEM_METALNESS,
    flatShading: true,
  });
  const mesh = new Mesh(geometry(), material);
  mesh.name = `relic:${relic.id}`;
  return { mesh, phaseS: gemPhaseFor(relic.id), relic };
}

/**
 * Reconciles the scene against a new relic list: creates gems for ids that are
 * new, removes gems for ids that are gone, and leaves the rest ALONE — an
 * untouched gem keeps its animation phase, so a keepalive re-broadcast does not
 * make every relic in the world visibly jump.
 */
function syncGems(ctx: ClientPluginCtx, next: readonly RelicView[]): void {
  const wanted = new Set(next.map((relic) => relic.id));

  for (const [id, entry] of gems) {
    if (wanted.has(id)) continue;
    disposeGem(entry);
    gems.delete(id);
  }

  for (const relic of next) {
    if (gems.has(relic.id)) continue;
    const entry = createGem(relic);
    ctx.layer.add(entry.mesh);
    gems.set(relic.id, entry);
  }
}

/**
 * Positions every gem for this frame.
 *
 * The ground height is re-read every frame rather than cached: terrain under a
 * relic changes constantly (any player's sculpt, or a Quake), and a cached
 * height would leave gems buried in new hills or hanging over new craters. It
 * is a cheap array read per gem, and there are RELIC_COUNT of them.
 *
 * A gem whose cell has no height yet — the join snapshot has not arrived, or
 * the relic sits in a chunk this client was never sent — is hidden rather than
 * drawn at a guessed height, because a gem floating over blank sea is a bug
 * report and an absent one is simply territory you have not unlocked.
 */
function animateGems(ctx: ClientPluginCtx, dt: number): void {
  elapsedS += dt;

  for (const entry of gems.values()) {
    const ground = ctx.terrainHeightAt(entry.relic.x, entry.relic.y);
    if (ground === null) {
      entry.mesh.visible = false;
      continue;
    }

    entry.mesh.visible = true;
    entry.mesh.position.set(
      entry.relic.x * CELL_WORLD_SIZE,
      ground + GEM_HOVER_CELLS + gemBobOffset(elapsedS, entry.phaseS),
      entry.relic.y * CELL_WORLD_SIZE,
    );
    entry.mesh.rotation.y = gemSpinAngle(elapsedS, entry.phaseS);
  }
}

/**
 * THE PRESS CLAIM. Returning true stops the event dead — the sculpt brush and
 * OrbitControls never see it (client/src/plugins/host.ts listens in the capture
 * phase). So this must claim ONLY presses it genuinely consumes, or the world
 * becomes unsculptable wherever a relic happens to be.
 *
 * Two consuming cases, in priority order:
 *
 *   1. A skill is armed → this press IS the target. Claimed even if the ray
 *      misses the ground, because the player is aiming, not sculpting; the
 *      alternative (a missed aim silently digging a hole) is worse. A miss
 *      simply disarms.
 *   2. A primary press whose ground cell is within the pick tolerance of a
 *      relic → collect it.
 *
 * Everything else falls through untouched.
 */
function handlePress(ctx: ClientPluginCtx, event: PointerEvent): boolean {
  if (event.button !== PRIMARY_BUTTON) return false;

  const cell = ctx.pickTerrainCell(event.clientX, event.clientY);

  const armed = armedSkill();
  if (armed !== null) {
    armSkill(null);
    if (cell !== null) ctx.send(CAST_MESSAGE, { skill: armed, x: cell.x, y: cell.y });
    return true;
  }

  if (cell === null) return false;

  const relic = relicUnderCell(relics(), cell);
  if (relic === null) return false;

  // Optimistically nothing is changed locally: the server owns the relic list
  // and will broadcast the removal. Predicting it would only mean a gem that
  // pops back into existence when someone else's collect message won the race.
  ctx.send(COLLECT_MESSAGE, { id: relic.id });
  return true;
}

export const clientPlugin: TerraceClientPlugin = {
  name: 'relics',

  attach(ctx: ClientPluginCtx): void {
    // Module-scope signals outlive an attach (the module is a singleton), so a
    // re-attach after a rejoin would otherwise open on the previous world's
    // relics and skills — the same hygiene clearPluginHudPanels does for the
    // panel stack.
    resetRelicsClientState();

    ctx.onMessage(RELICS_MESSAGE, (payload) => {
      const next = parseRelicsPayload(payload);
      setRelics(next);
      syncGems(ctx, next);
    });

    ctx.onMessage(SKILLS_MESSAGE, (payload) => {
      const next = parseSkillsPayload(payload);
      setSkills(next);
      // Disarm a skill the player no longer holds, so a stale "Aim…" button
      // cannot keep claiming presses after the relic's grant went away.
      const armed = armedSkill();
      if (armed !== null && !next.some((skill) => skill.id === armed)) armSkill(null);
    });

    ctx.onMessage(CAST_DENIED_MESSAGE, (payload) => {
      const reason =
        typeof payload === 'object' && payload !== null
          ? (payload as { reason?: unknown }).reason
          : undefined;
      setCastDenial(typeof reason === 'string' ? reason : null);
    });

    ctx.onFrame((dt) => animateGems(ctx, dt));
    ctx.onCanvasPress((event) => handlePress(ctx, event));
    ctx.registerHudPanel(RelicsPanel);
  },

  dispose(): void {
    // The host empties and removes the layer itself; what it cannot know about
    // is the GPU memory behind the meshes, so those are released here.
    for (const entry of gems.values()) disposeGem(entry);
    gems.clear();
    sharedGeometry?.dispose();
    sharedGeometry = null;
    elapsedS = 0;
  },
};
