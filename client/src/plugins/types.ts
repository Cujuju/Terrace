import type { SculptIntent } from '@terrace/shared';
import type { Group, Object3D } from 'three';
import type { NodeMaterial } from 'three/webgpu';
import type { Component } from 'solid-js';
import type { CellOccupancy } from '../terrain/occupancy.ts';
import type { RevealClipUniforms } from '../render/revealMask.ts';
import type { RigAsset } from '../render/rigAsset.ts';

export type { CellColumn, CellOccupancy, CellRayChord } from '../terrain/occupancy.ts';

export type RigLighting = 'sky-environment' | 'lamps-only';

export interface SkyRigState {
  readonly sunDirection: { readonly x: number; readonly y: number; readonly z: number };
  readonly sunColor: number;
  readonly sunIntensity: number;
  readonly hemisphereSkyColor: number;
  readonly hemisphereGroundColor: number;
  readonly hemisphereIntensity: number;
  readonly ambientColor: number;
  readonly ambientIntensity: number;
  readonly backgroundColor: number;
}

export interface GroundShadeDisc {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly radius: number;
  readonly darkness: number;
  readonly inner: number;
}

export interface WorldPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SfxOptions {
  readonly at?: WorldPosition;
  readonly gain?: number;
  readonly playbackRate?: number;
  readonly delaySeconds?: number;
}

export interface MusicOutlet {
  readonly context: AudioContext;
  readonly destination: AudioNode;
}

export interface MusicGenerator {
  stop(fadeSeconds: number): void;
}

export interface PluginAudio {
  preload(url: string): void;

  playSfx(url: string, opts?: SfxOptions): void;

  ambience(url: string, weight: number): void;

  setMusic(url: string | null): void;

  setMusicGenerator(start: ((outlet: MusicOutlet) => MusicGenerator) | null): void;
}

export interface MoverPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly bodyBottomY: number;
  readonly bodyHeight: number;
}

export interface ClientPluginCtx {
  readonly layer: Group;

  readonly audio: PluginAudio;

  worldSize(): number;

  terrainHeightAt(x: number, y: number): number | null;

  terrainRevisionAt(x: number, y: number): number;

  drawnGroundYAt(cellX: number, cellZ: number): number | null;

  onMessage(type: string, handler: (payload: unknown) => void): () => void;

  send(type: string, payload: unknown): void;

  onFrame(handler: (dt: number) => void): () => void;

  registerHudPanel(
    component: Component,
    options?: {
      placement?:
        | 'panel'
        | 'top-center'
        | 'bottom-center'
        | 'bottom-right'
        | 'connection'
        | 'settings';
      headerSummary?: Component;
      tabSummary?: () => string;
      hasBody?: () => boolean;
    },
  ): void;

  registerTool(tool: {
    id: string;
    label: string;
    title: string;
    icon: Component;
    onSelected: (selected: boolean) => void;
  }): void;

  registerWorldHeaderAction(action: {
    icon: Component;
    label: string;
    onClick: () => void;
  }): void;

  onCanvasPress(handler: (event: PointerEvent) => boolean): () => void;

  pickTerrainCell(clientX: number, clientY: number): { x: number; y: number } | null;

  markPickable(object: Object3D, occupancy?: CellOccupancy): () => void;

  pickWorldCell(clientX: number, clientY: number): { x: number; y: number } | null;

  cameraPosition(): WorldPosition;

  revealedAt(x: number, y: number): boolean;

  applyRevealClip(material: NodeMaterial, label: string): void;

  revealClipUniforms(): RevealClipUniforms;

  publishGroundShade(lookup: () => readonly GroundShadeDisc[]): () => void;

  publishMovers(lookup: (id: number) => MoverPose | null): () => void;

  moverPose(pluginName: string, id: number): MoverPose | null;

  publishGauge(key: string, read: () => number): () => void;

  gauge(pluginName: string, key: string): number | null;

  onLocalIntent(handler: (intent: SculptIntent) => boolean): () => void;

  setSkyRig(state: SkyRigState): void;

  loadRigAsset(url: string, lighting: RigLighting): Promise<RigAsset>;

  modulateSkyRig(modify: (state: SkyRigState) => SkyRigState): () => void;
}

export interface TerraceClientPlugin {
  readonly name: string;

  readonly drawBudget: number;

  readonly groundShadeBudget?: number;

  readonly clientOnly?: boolean;

  attach(ctx: ClientPluginCtx): void;

  preload?(ctx: ClientPluginCtx): Promise<void>;

  dispose?(): void;
}
