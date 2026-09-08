import { createSignal } from 'solid-js';
import type {
  WorldAdminAction,
  WorldAdminRefusal,
  WorldPluginAction,
  WorldPluginSetting,
  WorldSummary,
  WorldSwitchStatus,
  WorldViewScope,
} from '@terrace/shared';

export type WorldFeedback =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'listed' }
  | {
      kind: 'done';
      action: WorldAdminAction;
      id: string | null;
      archivedPath: string | null;
      plugin: string | null;
      detail: string | null;
    }
  | {
      kind: 'refused';
      action: WorldAdminAction;
      reason: WorldAdminRefusal;
      detail: string | null;
    };

const [worldPanelOpen, setWorldPanelOpen] = createSignal(false);

const [adminPanelOpen, setAdminPanelOpen] = createSignal(false);

const [armedAction, setArmedAction] = createSignal<WorldPluginAction | null>(null);

const [worlds, setWorlds] = createSignal<readonly WorldSummary[]>([]);
const [archivedWorlds, setArchivedWorlds] = createSignal<readonly WorldSummary[]>([]);

const [activeWorldId, setActiveWorldId] = createSignal<string | null>(null);

const [pendingSwitch, setPendingSwitch] = createSignal<WorldSwitchStatus | null>(null);

const [worldLoaded, setWorldLoaded] = createSignal(true);

const [pendingRestartSeconds, setPendingRestartSeconds] = createSignal<number | null>(null);

export interface WorldPlugins {
  readonly id: string;
  readonly installed: readonly string[];
  readonly disabled: readonly string[];
  readonly settings: readonly WorldPluginSetting[];
  readonly actions: readonly WorldPluginAction[];
  readonly versions: Readonly<Record<string, string>>;
}

const [worldPlugins, setWorldPlugins] = createSignal<WorldPlugins | null>(null);

const [worldFeedback, setWorldFeedback] = createSignal<WorldFeedback>({ kind: 'idle' });

const [worldAdminKey, setWorldAdminKey] = createSignal('');

const [worldViewScope, setWorldViewScope] = createSignal<WorldViewScope>('mine');

export {
  activeWorldId,
  adminPanelOpen,
  archivedWorlds,
  armedAction,
  pendingRestartSeconds,
  setPendingRestartSeconds,
  pendingSwitch,
  setPendingSwitch,
  setAdminPanelOpen,
  setArmedAction,
  setWorldAdminKey,
  setWorldFeedback,
  setWorldLoaded,
  setWorldPanelOpen,
  worldAdminKey,
  worldFeedback,
  worldLoaded,
  worldPanelOpen,
  worldPlugins,
  worlds,
  worldViewScope,
  setWorldViewScope,
};

export function applyWorldListing(message: {
  worlds: WorldSummary[];
  archived: WorldSummary[];
  activeId: string | null;
  pending?: WorldSwitchStatus;
  refused?: WorldAdminRefusal;
}): void {
  if (message.refused !== undefined) {
    setWorlds([]);
    setArchivedWorlds([]);
    setWorldFeedback({ kind: 'refused', action: 'load', reason: message.refused, detail: null });
    return;
  }

  setWorlds(message.worlds);
  setArchivedWorlds(message.archived);
  setActiveWorldId(message.activeId);
  setPendingSwitch(message.pending ?? null);
  if (message.activeId !== null) setWorldLoaded(true);
  setWorldFeedback({ kind: 'listed' });
}

export function applyWorldPluginListing(message: {
  id: string;
  installed: string[];
  disabled: string[];
  settings: WorldPluginSetting[];
  actions?: WorldPluginAction[];
  versions?: Record<string, string>;
  activeId?: string | null;
  refused?: WorldAdminRefusal;
}): void {
  if (message.activeId !== undefined) setActiveWorldId(message.activeId);
  if (message.refused !== undefined) {
    setWorldPlugins(null);
    setWorldFeedback({ kind: 'refused', action: 'setPlugin', reason: message.refused, detail: null });
    return;
  }
  setWorldPlugins({
    id: message.id,
    installed: message.installed,
    disabled: message.disabled,
    settings: message.settings,
    actions: message.actions ?? [],
    versions: message.versions ?? {},
  });
}

export function applyWorldAdminResult(message: {
  action: WorldAdminAction;
  ok: boolean;
  id?: string;
  archivedPath?: string;
  plugin?: string;
  detail?: string;
  refused?: WorldAdminRefusal;
}): void {
  if (!message.ok) {
    setWorldFeedback({
      kind: 'refused',
      action: message.action,
      reason: message.refused ?? 'failed',
      detail: message.detail ?? null,
    });
    return;
  }

  if (message.action === 'unload') setWorldLoaded(false);
  if (message.action === 'view' && (message.detail === 'all' || message.detail === 'mine')) {
    setWorldViewScope(message.detail);
  }
  setWorldFeedback({
    kind: 'done',
    action: message.action,
    id: message.id ?? null,
    archivedPath: message.archivedPath ?? null,
    plugin: message.plugin ?? null,
    detail: message.detail ?? null,
  });
}

export function applyWorldSwitchNotice(message: {
  toId: string;
  toName: string;
  secondsRemaining: number;
  cancelled?: boolean;
}): void {
  if (message.cancelled === true || message.secondsRemaining <= 0) {
    setPendingSwitch(null);
    return;
  }
  setPendingSwitch({
    toId: message.toId,
    toName: message.toName,
    secondsRemaining: message.secondsRemaining,
  });
}
