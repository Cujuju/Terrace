import { MAX_ROLLBACK_KEY_LENGTH } from './rollback.ts';
import {
  MAX_WORLD_NAME_LENGTH,
  validatePluginName,
  validatePluginSettingToken,
  validateWorldId,
  validateWorldName,
} from './world.ts';
import type {
  WorldAdminRequestMessage,
  WorldCreateRequestMessage,
  WorldDuplicateRequestMessage,
} from './worldAdmin.ts';

function isCellCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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
