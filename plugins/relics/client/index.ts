import { Color, Mesh, type BufferGeometry, type ShaderMaterial } from 'three';
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
  RELIC_COUNT,
} from '../protocol.ts';
import {
  CELL_WORLD_SIZE,
  GEM_HOVER_CELLS,
  GEM_RADIUS_CELLS,
  gemBobOffset,
  gemGroundY,
  gemPhaseFor,
  gemSpinAngle,
  relicColor,
  relicUnderCell,
} from './gems.ts';
import { createGemMaterial } from './gemMaterial.ts';
import {
  createSpireMaterial,
  spireAlpha,
  spireGeometry,
  SPIRE_RENDER_ORDER,
} from './relicSpire.ts';
import { disposeRelicGeometries, relicGeometry } from './relicShapes.ts';
import { RelicsHeaderLine, RelicsPanel } from './RelicsPanel.tsx';
import {
  armSkill,
  armedSkill,
  relics,
  resetRelicsClientState,
  setCastDenial,
  setRelics,
  setSkills,
  skills,
} from './state.ts';

const PRIMARY_BUTTON = 0;

interface GemEntry {
  readonly mesh: Mesh;
  readonly spire: Mesh;
  readonly phaseS: number;
  readonly relic: RelicView;
}

let spireShape: BufferGeometry | null = null;

function sharedSpireGeometry(): BufferGeometry {
  spireShape ??= spireGeometry();
  return spireShape;
}

let elapsedS = 0;

const gems = new Map<string, GemEntry>();

function disposeGem(entry: GemEntry): void {
  for (const mesh of [entry.mesh, entry.spire]) {
    mesh.removeFromParent();
    (mesh.material as ShaderMaterial).dispose();
  }
}

function createGem(relic: RelicView): GemEntry {
  const geometry = relicGeometry(relic.skill);
  const mesh = new Mesh(geometry, createGemMaterial(geometry.boundingSphere!.radius));
  mesh.name = `relic:${relic.id}`;
  const spire = new Mesh(
    sharedSpireGeometry(),
    createSpireMaterial(new Color(relicColor(relic.skill))),
  );
  spire.name = `relic-spire:${relic.id}`;
  spire.renderOrder = SPIRE_RENDER_ORDER;
  return { mesh, spire, phaseS: gemPhaseFor(relic.id), relic };
}

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
    ctx.layer.add(entry.mesh, entry.spire);
    gems.set(relic.id, entry);
  }
}

function animateGems(ctx: ClientPluginCtx, dt: number): void {
  elapsedS += dt;

  const sample = (cellX: number, cellY: number): number | null =>
    ctx.terrainHeightAt(cellX, cellY);
  for (const entry of gems.values()) {
    const ground = gemGroundY(sample, entry.relic.x, entry.relic.y);
    if (ground === null) {
      entry.mesh.visible = false;
      entry.spire.visible = false;
      continue;
    }

    entry.mesh.visible = true;
    entry.mesh.position.set(
      entry.relic.x * CELL_WORLD_SIZE,
      ground + GEM_HOVER_CELLS + gemBobOffset(elapsedS, entry.phaseS),
      entry.relic.y * CELL_WORLD_SIZE,
    );
    entry.mesh.rotation.y = gemSpinAngle(elapsedS, entry.phaseS);

    entry.spire.visible = true;
    entry.spire.position.set(
      entry.relic.x * CELL_WORLD_SIZE,
      ground,
      entry.relic.y * CELL_WORLD_SIZE,
    );
    (entry.spire.material as ShaderMaterial).uniforms.uAlpha!.value = spireAlpha(
      elapsedS,
      entry.phaseS,
    );
  }
}

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

  ctx.send(COLLECT_MESSAGE, { id: relic.id });
  return true;
}

const RELIC_DRAW_OBJECTS = 2;

export const clientPlugin: TerraceClientPlugin = {
  name: 'relics',

  drawBudget: RELIC_COUNT * RELIC_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    resetRelicsClientState();

    ctx.onMessage(RELICS_MESSAGE, (payload) => {
      const next = parseRelicsPayload(payload);
      setRelics(next);
      syncGems(ctx, next);
    });

    ctx.onMessage(SKILLS_MESSAGE, (payload) => {
      const next = parseSkillsPayload(payload);
      setSkills(next);
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
    ctx.registerHudPanel(RelicsPanel, {
      headerSummary: RelicsHeaderLine,
      tabSummary: () => `Relics (${relics().length})`,
      hasBody: () => skills().length > 0,
    });
  },

  dispose(): void {
    for (const entry of gems.values()) disposeGem(entry);
    gems.clear();
    disposeRelicGeometries();
    spireShape?.dispose();
    spireShape = null;
    elapsedS = 0;
  },
};
