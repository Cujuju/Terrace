import { createSignal } from 'solid-js';
import type { RendererBackendName } from '../render/rendererBackend.ts';
import type { ConnectionStatus } from '../net/connection.ts';
import type { FrameStatsSample } from '../render/frameStats.ts';
import type { PickFace } from '../terrain/picking.ts';
import { REFUSED_PULSE_MS } from '../input/sculpt/contract.ts';

const [connectionStatus, setConnectionStatus] =
  createSignal<ConnectionStatus>('connecting');

export interface WorldIdentity {
  readonly name: string | null;
  readonly difficulty: number | null;
}

const [worldIdentity, setWorldIdentitySignal] = createSignal<WorldIdentity>({
  name: null,
  difficulty: null,
});

export function setWorldIdentity(identity: WorldIdentity): void {
  const name = identity.name?.trim() ?? '';
  const difficulty = identity.difficulty;
  setWorldIdentitySignal({
    name: name === '' ? null : name,
    difficulty:
      typeof difficulty === 'number' && Number.isFinite(difficulty)
        ? Math.round(difficulty)
        : null,
  });
}

const [serverVersion, setServerVersionSignal] = createSignal<string | null>(
  null,
);

export function setServerVersion(version: string | null | undefined): void {
  const trimmed = version?.trim() ?? '';
  setServerVersionSignal(trimmed === '' ? null : trimmed);
}

const [frameRate, setFrameRateSignal] = createSignal<number | null>(null);

export function setFrameRate(fps: number): void {
  setFrameRateSignal(fps);
}

export interface FrameDrawAccounting {
  readonly calls: number;
  readonly objects: number;
  readonly budget: number;
}

const [frameDraw, setFrameDrawSignal] = createSignal<FrameDrawAccounting | null>(
  null,
);

export function setFrameDraw(accounting: FrameDrawAccounting): void {
  setFrameDrawSignal(accounting);
}

/** What is drawing and what is meshing, sampled: a runtime demotion moves the mesher. */
export interface RenderPath {
  readonly backend: RendererBackendName;
  readonly mesher: 'gpu' | 'cpu';
}

const [renderPath, setRenderPathSignal] = createSignal<RenderPath | null>(null);

export function setRenderPath(path: RenderPath): void {
  setRenderPathSignal(path);
}

const [frameStats, setFrameStatsSignal] = createSignal<FrameStatsSample | null>(
  null,
);

export function setFrameStats(sample: FrameStatsSample | null): void {
  setFrameStatsSignal(sample);
}

const [perfOpen, setPerfOpenSignal] = createSignal(false);

/** The terrain cell under the pointer, for the performance panel's top row. */
export interface HoverPickSample {
  readonly x: number;
  readonly y: number;
  readonly face: PickFace;
  readonly band: number | null;
}

const [hoverPick, setHoverPickSignal] = createSignal<HoverPickSample | null>(null);

const sameHoverPick = (a: HoverPickSample | null, b: HoverPickSample | null): boolean =>
  a === b
  || (a !== null && b !== null && a.x === b.x && a.y === b.y
    && a.face === b.face && a.band === b.band);

/** Called every frame; only a changed pick notifies the HUD. */
export function setHoverPick(sample: HoverPickSample | null): void {
  if (sameHoverPick(hoverPick(), sample)) return;
  setHoverPickSignal(sample);
}

/** Which line a sculpt denial shows the hand. Chosen by world.ts denialHintFor. */
export type DenialHint = 'locked' | 'nest' | 'ward' | 'mana-with-cost' | 'refused';

/** The longest denial line is five words, read at a glancing ~150 wpm. */
const DENIAL_HINT_READING_MS = 2000;

/** The line outlasts the brush's red pulse, then holds long enough to read. */
export const DENIAL_HINT_VISIBLE_MS = REFUSED_PULSE_MS + DENIAL_HINT_READING_MS;

const [denialHint, setDenialHintSignal] = createSignal<DenialHint | null>(null);

let denialHintTimer: ReturnType<typeof setTimeout> | null = null;

/** Clears the line and its pending timer, so none outlives the caller. */
export function disposeDenialHint(): void {
  if (denialHintTimer !== null) clearTimeout(denialHintTimer);
  denialHintTimer = null;
  setDenialHintSignal(null);
}

/** Raise the denial line; it clears itself, so no reader has to time it. */
export function showDenialHint(hint: DenialHint | null): void {
  disposeDenialHint();
  if (hint === null) return;
  setDenialHintSignal(hint);
  denialHintTimer = setTimeout(disposeDenialHint, DENIAL_HINT_VISIBLE_MS);
}

export { denialHint };

export function setPerfOpen(open: boolean): void {
  setPerfOpenSignal(open);
}

export {
  connectionStatus,
  setConnectionStatus,
  worldIdentity,
  serverVersion,
  frameRate,
  frameDraw,
  renderPath,
  frameStats,
  perfOpen,
  hoverPick,
};
