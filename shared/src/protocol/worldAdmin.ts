import type { WorldSummary, WorldSwitchStatus, WorldViewScope } from './world.ts';

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

export interface WorldSwitchCancelRequestMessage {
  type: 'worldSwitchCancel';
  key: string;
}

export interface WorldViewRequestMessage {
  type: 'worldView';
  key: string;
  scope: WorldViewScope;
}

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
