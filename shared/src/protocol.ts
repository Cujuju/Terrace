import { MAX_BRUSH_RADIUS, MAX_DRAG_SWEEP_CELLS, MIN_BRUSH_RADIUS } from './constants.ts';
import { chebyshevDistance } from './grid.ts';
import type { ChunkHeights } from './chunks.ts';
import {
  MAX_BAND,
  MIN_BAND,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  TOOLS_WITHOUT_EDGE_PROFILE,
} from './heightmap.ts';
import type {
  CellDiff,
  ResolvedSculptOptions,
  SculptProfile,
  SculptTool,
} from './heightmap.ts';

export interface SculptIntent {
  type: 'sculpt';
  x: number;
  y: number;
  radius: number;
  dir: 1 | -1;
  tool?: SculptTool;
  profile?: SculptProfile;
  targetBand?: number;
  spanBand?: number;
  fromX?: number;
  fromY?: number;
  seq?: number;
}

export const WIRE_DEFAULT_SCULPT_OPTIONS: ResolvedSculptOptions = {
  tool: 'stamp',
  profile: 'soft',
  spill: 'banded',
  targetBand: null,
  spanBand: null,
  anchor: 'clicked',
  sweepFrom: null,
};

export const EDGELESS_SCULPT_PROFILE: SculptProfile = 'hard';

export function sculptProfileOf(tool: SculptTool, profile: SculptProfile): SculptProfile {
  return TOOLS_WITHOUT_EDGE_PROFILE.includes(tool) ? EDGELESS_SCULPT_PROFILE : profile;
}

export function sculptOptionsOf(intent: SculptIntent): ResolvedSculptOptions {
  const tool = intent.tool ?? WIRE_DEFAULT_SCULPT_OPTIONS.tool;
  const targetBand =
    tool === 'drag' ? (intent.targetBand ?? null) : WIRE_DEFAULT_SCULPT_OPTIONS.targetBand;
  return {
    tool,
    profile: sculptProfileOf(tool, intent.profile ?? WIRE_DEFAULT_SCULPT_OPTIONS.profile),
    spill: WIRE_DEFAULT_SCULPT_OPTIONS.spill,
    anchor: targetBand !== null ? 'band' : WIRE_DEFAULT_SCULPT_OPTIONS.anchor,
    targetBand,
    spanBand: intent.spanBand ?? null,
    sweepFrom:
      tool === 'drag' && intent.fromX !== undefined && intent.fromY !== undefined
        ? { x: intent.fromX, y: intent.fromY }
        : null,
  };
}

export function sculptSweepSteps(intent: SculptIntent): number {
  if (intent.fromX === undefined || intent.fromY === undefined) return 1;
  return Math.max(1, chebyshevDistance(intent.fromX, intent.fromY, intent.x, intent.y));
}

export interface SculptDeniedMessage {
  type: 'sculptDenied';
  seq: number;
}

export interface SculptAppliedMessage {
  type: 'sculptApplied';
  seq: number;
}

export interface TerrainDiffMessage {
  type: 'terrainDiff';
  cells: CellDiff[];
}

export interface ChunkLayeredSpans {
  at: number[];
  runs: number[];
}

export interface ChunkPayload {
  cx: number;
  cy: number;
  heights: ChunkHeights;
  layered?: ChunkLayeredSpans;
}

export interface ChunkUnlockMessage {
  type: 'chunkUnlock';
  chunks: ChunkPayload[];
}

export interface JoinSnapshotMessage {
  type: 'snapshot';
  worldSize: number;
  chunks: ChunkPayload[];
  worldName?: string;
  difficulty?: number;
  serverVersion?: string;
  buildIdentity?: string;
  livePlugins?: readonly string[];
}

export type ClientMessage =
  | SculptIntent
  | RestorePointsRequestMessage
  | RollbackRequestMessage
  | StackRestartRequestMessage;
export type ServerMessage =
  | TerrainDiffMessage
  | ChunkUnlockMessage
  | JoinSnapshotMessage
  | SculptAppliedMessage
  | SculptDeniedMessage
  | RestorePointListMessage
  | RollbackResultMessage;

export function validateSculptIntent(
  msg: unknown,
  worldSize: number,
): SculptIntent | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'sculpt') return null;

  const { x, y, radius, dir } = m;
  if (!Number.isInteger(x) || (x as number) < 0 || (x as number) >= worldSize) return null;
  if (!Number.isInteger(y) || (y as number) < 0 || (y as number) >= worldSize) return null;
  if (
    !Number.isInteger(radius) ||
    (radius as number) < MIN_BRUSH_RADIUS ||
    (radius as number) > MAX_BRUSH_RADIUS
  ) {
    return null;
  }
  if (dir !== 1 && dir !== -1) return null;

  const { seq } = m;
  if (seq !== undefined && !Number.isSafeInteger(seq)) return null;

  const { tool, profile } = m;
  if (tool !== undefined && !SCULPT_TOOLS.includes(tool as SculptTool)) return null;
  if (tool === 'carve' && dir === 1) return null;
  if (profile !== undefined && !SCULPT_PROFILES.includes(profile as SculptProfile)) {
    return null;
  }

  const { targetBand } = m;
  if (
    targetBand !== undefined &&
    (!Number.isInteger(targetBand) ||
      (targetBand as number) < MIN_BAND ||
      (targetBand as number) > MAX_BAND)
  ) {
    return null;
  }

  if (targetBand !== undefined && tool !== 'drag') return null;

  const { spanBand } = m;
  if (
    spanBand !== undefined &&
    (!Number.isInteger(spanBand) ||
      (spanBand as number) < MIN_BAND ||
      (spanBand as number) > MAX_BAND)
  ) {
    return null;
  }

  const { fromX, fromY } = m;
  if (fromX !== undefined || fromY !== undefined) {
    if (tool !== 'drag') return null;
    if (!Number.isInteger(fromX) || (fromX as number) < 0 || (fromX as number) >= worldSize) return null;
    if (!Number.isInteger(fromY) || (fromY as number) < 0 || (fromY as number) >= worldSize) return null;
    if (chebyshevDistance(fromX as number, fromY as number, x as number, y as number) > MAX_DRAG_SWEEP_CELLS) {
      return null;
    }
  }

  return {
    type: 'sculpt',
    x: x as number,
    y: y as number,
    radius: radius as number,
    dir,
    ...(tool !== undefined ? { tool: tool as SculptTool } : {}),
    ...(profile !== undefined ? { profile: profile as SculptProfile } : {}),
    ...(targetBand !== undefined ? { targetBand: targetBand as number } : {}),
    ...(spanBand !== undefined ? { spanBand: spanBand as number } : {}),
    ...(fromX !== undefined ? { fromX: fromX as number, fromY: fromY as number } : {}),
    ...(seq !== undefined ? { seq: seq as number } : {}),
  };
}

export const MAX_ROLLBACK_KEY_LENGTH = 256;

export interface RestorePoint {
  id: number;
  createdAt: number;
  cellsChanged: number | null;
  maxCellDelta: number | null;
  isCurrent: boolean;
  pinned: boolean;
}

export interface RestorePointsRequestMessage {
  type: 'restorePoints';
  key: string;
}

export type RollbackRefusal =
  | 'disabled'
  | 'badKey'
  | 'throttled'
  | 'unknownRestorePoint'
  | 'sizeMismatch'
  | 'failed';

export interface RestorePointListMessage {
  type: 'restorePointList';
  points: RestorePoint[];
  retention: number;
  intervalS: number;
  refused?: RollbackRefusal;
}

export interface RollbackRequestMessage {
  type: 'rollback';
  key: string;
  toId: number;
}

export interface RollbackResultMessage {
  type: 'rollbackResult';
  ok: boolean;
  toId?: number;
  undoId?: number;
  refused?: RollbackRefusal;
}

function validateRollbackKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_ROLLBACK_KEY_LENGTH) return null;
  return value;
}

export function validateRestorePointsRequest(
  msg: unknown,
): RestorePointsRequestMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'restorePoints') return null;
  const key = validateRollbackKey(m.key);
  if (key === null) return null;
  return { type: 'restorePoints', key };
}

export function validateRollbackRequest(msg: unknown): RollbackRequestMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'rollback') return null;
  const key = validateRollbackKey(m.key);
  if (key === null) return null;
  const { toId } = m;
  if (!Number.isSafeInteger(toId) || (toId as number) <= 0) return null;
  return { type: 'rollback', key, toId: toId as number };
}

export const MAX_WORLD_NAME_LENGTH = 48;

export const MAX_WORLD_ID_LENGTH = 64;

export const WORLD_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const WORLD_THUMBNAIL_SIZE = 64;

export interface WorldSummary {
  id: string;
  name: string;
  worldSize: number;
  restorePoints: number;
  pinnedPoints: number;
  newestAt: number | null;
  bytes: number;
  isActive: boolean;
  isArchived: boolean;
  archivedAt?: number;
  thumbnail?: string;

  unreadable?: string;
}

export interface WorldSwitchStatus {
  toId: string;
  toName: string;
  secondsRemaining: number;
}

export type WorldAdminRefusal =
  | 'disabled'
  | 'badKey'
  | 'throttled'
  | 'unknownWorld'
  | 'alreadyActive'
  | 'nameInUse'
  | 'invalidName'
  | 'invalidSize'
  | 'noWorldLoaded'
  | 'noSwitchPending'
  | 'notArchived'
  | 'confirmationMismatch'
  | 'switchInProgress'
  | 'unknownPlugin'
  | 'reloadFailed'
  | 'reloadLeftNoWorld'
  | 'unknownSetting'
  | 'worldIsActive'
  | 'unknownAction'
  | 'pluginDisabled'
  | 'actionDeclined'
  | 'restartInProgress'
  | 'failed';

export type WorldAdminAction =
  | 'create'
  | 'load'
  | 'unload'
  | 'rename'
  | 'duplicate'
  | 'archive'
  | 'unarchive'
  | 'purge'
  | 'pin'
  | 'cancelSwitch'
  | 'setPlugin'
  | 'configurePlugin'
  | 'reloadPlugin'
  | 'actPlugin'
  | 'restart'
  | 'view';

export interface WorldListRequestMessage {
  type: 'worldList';
  key: string;
}

export interface WorldCreateRequestMessage {
  type: 'worldCreate';
  key: string;
  name?: string;
  worldSize?: number;
  difficulty?: number;
  loadNow?: boolean;
}

export interface WorldLoadRequestMessage {
  type: 'worldLoad';
  key: string;
  id: string;
}

export interface WorldUnloadRequestMessage {
  type: 'worldUnload';
  key: string;
}

export interface WorldRenameRequestMessage {
  type: 'worldRename';
  key: string;
  id: string;
  name: string;
}

export interface WorldDuplicateRequestMessage {
  type: 'worldDuplicate';
  key: string;
  id: string;
  name?: string;
}

export interface WorldArchiveRequestMessage {
  type: 'worldArchive';
  key: string;
  id: string;
}

export interface WorldUnarchiveRequestMessage {
  type: 'worldUnarchive';
  key: string;
  id: string;
}

export interface WorldPurgeRequestMessage {
  type: 'worldPurge';
  key: string;
  id: string;
  confirmName: string;
}

export interface WorldPinRequestMessage {
  type: 'worldPin';
  key: string;
  pointId: number;
  pinned: boolean;
}

export interface WorldPluginListRequestMessage {
  type: 'worldPluginList';
  key: string;
  id?: string;
}

export interface WorldPluginSetRequestMessage {
  type: 'worldPluginSet';
  key: string;
  id: string;
  plugin: string;
  enabled: boolean;
}

export interface WorldPluginConfigureRequestMessage {
  type: 'worldPluginConfigure';
  key: string;
  id: string;
  plugin: string;
  setting: string;
  value: string;
}

export interface WorldPluginActRequestMessage {
  type: 'worldPluginAct';
  key: string;
  plugin: string;
  action: string;
  x: number;
  y: number;
}

export interface WorldPluginReloadRequestMessage {
  type: 'worldPluginReload';
  key: string;
  id: string;
  plugin: string;
}

export interface ServerRestartRequestMessage {
  type: 'serverRestart';
  key: string;
}

export interface StackRestartRequestMessage {
  type: 'stackRestart';
}

export const STACK_RESTART_MESSAGE_TYPE: StackRestartRequestMessage['type'] = 'stackRestart';

export function validateStackRestartRequest(msg: unknown): StackRestartRequestMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== STACK_RESTART_MESSAGE_TYPE) return null;
  return { type: STACK_RESTART_MESSAGE_TYPE };
}

export interface WorldSwitchCancelRequestMessage {
  type: 'worldSwitchCancel';
  key: string;
}

export interface WorldViewRequestMessage {
  type: 'worldView';
  key: string;
  scope: WorldViewScope;
}

export type WorldViewScope = 'all' | 'mine';

export interface WorldListMessage {
  type: 'worldListing';
  worlds: WorldSummary[];
  archived: WorldSummary[];
  activeId: string | null;
  pending?: WorldSwitchStatus;
  refused?: WorldAdminRefusal;
}

export interface WorldPluginSetting {
  plugin: string;
  key: string;
  values: string[];
  value: string;
}

export interface WorldPluginAction {
  plugin: string;
  key: string;
  label: string;
  description: string;
  archetype?: string;
}

export interface WorldPluginListMessage {
  type: 'worldPluginListing';
  id: string;
  installed: string[];
  disabled: string[];
  settings: WorldPluginSetting[];
  actions: WorldPluginAction[];
  versions: Record<string, string>;
  activeId?: string | null;
  refused?: WorldAdminRefusal;
}

export interface WorldAdminResultMessage {
  type: 'worldAdminResult';
  action: WorldAdminAction;
  ok: boolean;
  id?: string;
  archivedPath?: string;
  plugin?: string;
  detail?: string;
  refused?: WorldAdminRefusal;
}

export interface WorldSwitchNoticeMessage {
  type: 'worldSwitchNotice';
  toId: string;
  toName: string;
  secondsRemaining: number;
  cancelled?: boolean;
}

export interface ServerRestartNoticeMessage {
  type: 'serverRestartNotice';
  secondsRemaining: number;
}

export interface WorldUnloadedMessage {
  type: 'worldUnloaded';
}

export type WorldAdminRequestMessage =
  | WorldListRequestMessage
  | WorldCreateRequestMessage
  | WorldLoadRequestMessage
  | WorldUnloadRequestMessage
  | WorldRenameRequestMessage
  | WorldDuplicateRequestMessage
  | WorldArchiveRequestMessage
  | WorldUnarchiveRequestMessage
  | WorldPurgeRequestMessage
  | WorldPinRequestMessage
  | WorldPluginListRequestMessage
  | WorldPluginSetRequestMessage
  | WorldPluginConfigureRequestMessage
  | WorldPluginActRequestMessage
  | WorldPluginReloadRequestMessage
  | ServerRestartRequestMessage
  | WorldSwitchCancelRequestMessage
  | WorldViewRequestMessage;

export function slugifyWorldName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, MAX_WORLD_ID_LENGTH);
}

export function validateWorldId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_WORLD_ID_LENGTH) return null;
  if (!WORLD_ID_PATTERN.test(value)) return null;
  return value;
}

export const MAX_PLUGIN_NAME_LENGTH = 64;

export const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validatePluginName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_PLUGIN_NAME_LENGTH) return null;
  if (!PLUGIN_NAME_PATTERN.test(value)) return null;
  return value;
}

export const MAX_PLUGIN_SETTING_TOKEN_LENGTH = 64;

export const PLUGIN_SETTING_TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isCellCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validatePluginSettingToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_PLUGIN_SETTING_TOKEN_LENGTH) return null;
  if (!PLUGIN_SETTING_TOKEN_PATTERN.test(value)) return null;
  return value;
}

export function validateWorldName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_WORLD_NAME_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

export function validateWorldAdminRequest(msg: unknown): WorldAdminRequestMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;

  const key = typeof m.key === 'string' ? m.key : null;
  if (key === null || key.length > MAX_ROLLBACK_KEY_LENGTH) return null;

  switch (m.type) {
    case 'worldList':
      return { type: 'worldList', key };

    case 'worldUnload':
      return { type: 'worldUnload', key };

    case 'worldSwitchCancel':
      return { type: 'worldSwitchCancel', key };

    case 'worldView':
      if (m.scope !== 'all' && m.scope !== 'mine') return null;
      return { type: 'worldView', key, scope: m.scope };

    case 'serverRestart':
      return { type: 'serverRestart', key };

    case 'worldCreate': {
      const request: WorldCreateRequestMessage = { type: 'worldCreate', key };
      if (m.name !== undefined) {
        const name = validateWorldName(m.name);
        if (name === null) return null;
        request.name = name;
      }
      if (m.worldSize !== undefined) {
        if (!Number.isSafeInteger(m.worldSize) || (m.worldSize as number) <= 0) return null;
        request.worldSize = m.worldSize as number;
      }
      if (m.difficulty !== undefined) {
        if (!Number.isSafeInteger(m.difficulty)) return null;
        request.difficulty = m.difficulty as number;
      }
      if (m.loadNow !== undefined) {
        if (typeof m.loadNow !== 'boolean') return null;
        request.loadNow = m.loadNow;
      }
      return request;
    }

    case 'worldLoad':
    case 'worldArchive':
    case 'worldUnarchive': {
      const id = validateWorldId(m.id);
      if (id === null) return null;
      return { type: m.type, key, id };
    }

    case 'worldRename': {
      const id = validateWorldId(m.id);
      const name = validateWorldName(m.name);
      if (id === null || name === null) return null;
      return { type: 'worldRename', key, id, name };
    }

    case 'worldDuplicate': {
      const id = validateWorldId(m.id);
      if (id === null) return null;
      const request: WorldDuplicateRequestMessage = { type: 'worldDuplicate', key, id };
      if (m.name !== undefined) {
        const name = validateWorldName(m.name);
        if (name === null) return null;
        request.name = name;
      }
      return request;
    }

    case 'worldPurge': {
      const id = validateWorldId(m.id);
      if (id === null) return null;
      if (typeof m.confirmName !== 'string' || m.confirmName.length > MAX_WORLD_NAME_LENGTH) {
        return null;
      }
      return { type: 'worldPurge', key, id, confirmName: m.confirmName };
    }

    case 'worldPluginList': {
      if (m.id === undefined) return { type: 'worldPluginList', key };
      const id = validateWorldId(m.id);
      if (id === null) return null;
      return { type: 'worldPluginList', key, id };
    }

    case 'worldPluginReload': {
      const id = validateWorldId(m.id);
      const plugin = validatePluginName(m.plugin);
      if (id === null || plugin === null) return null;
      return { type: 'worldPluginReload', key, id, plugin };
    }

    case 'worldPluginSet': {
      const id = validateWorldId(m.id);
      const plugin = validatePluginName(m.plugin);
      if (id === null || plugin === null) return null;
      if (typeof m.enabled !== 'boolean') return null;
      return { type: 'worldPluginSet', key, id, plugin, enabled: m.enabled };
    }

    case 'worldPluginConfigure': {
      const id = validateWorldId(m.id);
      const plugin = validatePluginName(m.plugin);
      const setting = validatePluginSettingToken(m.setting);
      const value = validatePluginSettingToken(m.value);
      if (id === null || plugin === null || setting === null || value === null) return null;
      return { type: 'worldPluginConfigure', key, id, plugin, setting, value };
    }

    case 'worldPluginAct': {
      const plugin = validatePluginName(m.plugin);
      const action = validatePluginSettingToken(m.action);
      if (plugin === null || action === null) return null;
      if (!isCellCoordinate(m.x) || !isCellCoordinate(m.y)) return null;
      return { type: 'worldPluginAct', key, plugin, action, x: m.x, y: m.y };
    }

    case 'worldPin': {
      if (!Number.isSafeInteger(m.pointId) || (m.pointId as number) <= 0) return null;
      if (typeof m.pinned !== 'boolean') return null;
      return { type: 'worldPin', key, pointId: m.pointId as number, pinned: m.pinned };
    }

    default:
      return null;
  }
}
