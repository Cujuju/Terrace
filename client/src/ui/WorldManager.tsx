import { For, Show, createSignal, type JSX } from 'solid-js';
import {
  slugifyWorldName,
  type WorldAdminRefusal,
  type WorldAdminRequestMessage,
} from '@terrace/shared';
import { WorldThumbnail } from './WorldThumbnail.tsx';
import { refusalText } from './worldAdminCopy.ts';
import {
  activeWorldId,
  archivedWorlds,
  pendingSwitch,
  setWorldAdminKey,
  setWorldFeedback,
  setWorldPanelOpen,
  type WorldFeedback,
  worldAdminKey,
  worldFeedback,
  worldPlugins,
  worlds,
} from '../state/worldsState.ts';

export interface WorldActions {
  send(message: WorldAdminRequestMessage): void;
}

const BYTES_PER_STEP = 1024;

const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB'] as const;

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_STEP && unit < SIZE_UNITS.length - 1) {
    value /= BYTES_PER_STEP;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

function formatWhen(epochMs: number | null | undefined, nowMs: number): string {
  if (epochMs === null || epochMs === undefined) return 'never';
  const elapsed = Math.max(0, nowMs - epochMs);
  if (elapsed < MS_PER_MINUTE) return 'just now';
  if (elapsed < MS_PER_HOUR) return `${Math.round(elapsed / MS_PER_MINUTE)}m ago`;
  if (elapsed < MS_PER_DAY) return `${Math.round(elapsed / MS_PER_HOUR)}h ago`;
  return `${Math.round(elapsed / MS_PER_DAY)}d ago`;
}

export function WorldManager(props: { actions: WorldActions }): JSX.Element {
  const [armedArchiveId, setArmedArchiveId] = createSignal<string | null>(null);
  const [armedRestart, setArmedRestart] = createSignal(false);
  const [purgingId, setPurgingId] = createSignal<string | null>(null);
  const [purgeConfirm, setPurgeConfirm] = createSignal('');
  const [pluginsForId, setPluginsForId] = createSignal<string | null>(null);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameTo, setRenameTo] = createSignal('');
  const [newName, setNewName] = createSignal('');
  const [showArchived, setShowArchived] = createSignal(false);
  const [listedAtMs, setListedAtMs] = createSignal(Date.now());

  const send = (message: WorldAdminRequestMessage): void => {
    setWorldFeedback({ kind: 'working' });
    props.actions.send(message);
  };

  const requestList = (): void => {
    setArmedArchiveId(null);
    setPurgingId(null);
    setRenamingId(null);
    setPluginsForId(null);
    setArmedRestart(false);
    setListedAtMs(Date.now());
    send({ type: 'worldList', key: worldAdminKey() });
  };

  return (
    <div class="restore-overlay" role="dialog" aria-label="Worlds">
      <div class="restore-sheet">
        <div class="restore-header">
          <span class="status-label">Worlds</span>
          <button
            type="button"
            class="chart-button"
            aria-label="Close worlds"
            title="Close: put the panel away"
            onClick={() => setWorldPanelOpen(false)}
          >
            ✕
          </button>
        </div>

        <p class="hud-hint">
          Every world is its own file, with its own history — loading one can
          never shorten another’s. Archiving moves a world to the trash; only
          Purge, on the Trash tab, ever deletes one.
        </p>

        {
}
        <form
          class="restore-key-row"
          onSubmit={(event) => {
            event.preventDefault();
            requestList();
          }}
        >
          <label class="controls-label" for="world-admin-key">
            World-admin key
          </label>
          <input
            id="world-admin-key"
            class="restore-key-input"
            type="password"
            autocomplete="off"
            placeholder="WORLD_ADMIN_KEY"
            value={worldAdminKey()}
            onInput={(event) => setWorldAdminKey(event.currentTarget.value)}
          />
          <button type="submit" class="chart-button" disabled={worldAdminKey() === ''}>
            List
          </button>
        </form>

        <Show when={worldFeedback().kind === 'refused'}>
          {
}
          <p class="restore-refusal">
            {refusalText((worldFeedback() as { reason: WorldAdminRefusal }).reason)}
          </p>
        </Show>

        <Show when={worldFeedback().kind === 'done'}>
          <p class="hud-hint">
            {
}
            {doneText(worldFeedback() as Extract<WorldFeedback, { kind: 'done' }>)}
          </p>
        </Show>

        {
}
        <Show when={pendingSwitch()}>
          {(pending) => (
            <div class="restore-key-row">
              <span class="status-label">
                Moving everyone to “{pending().toName}” in {pending().secondsRemaining}s
              </span>
              <button
                type="button"
                class="chart-button"
                onClick={() => send({ type: 'worldSwitchCancel', key: worldAdminKey() })}
              >
                Cancel switch
              </button>
            </div>
          )}
        </Show>

        {
}
        <div class="restore-key-row">
          <span class="status-label">
            Restart the server to pick up plugin or core code that changed on
            disk. The live world is saved first and comes back; everyone
            reconnects by themselves.
          </span>
          <Show
            when={armedRestart()}
            fallback={
              <button
                type="button"
                class="chart-button"
                title="Restart: make new code live"
                disabled={worldAdminKey() === ''}
                onClick={() => setArmedRestart(true)}
              >
                Restart server
              </button>
            }
          >
            <button
              type="button"
              class="chart-button"
              onClick={() => {
                setArmedRestart(false);
                send({ type: 'serverRestart', key: worldAdminKey() });
              }}
            >
              Restart now
            </button>
            <button type="button" class="chart-button" onClick={() => setArmedRestart(false)}>
              Cancel
            </button>
          </Show>
        </div>

        <div class="restore-key-row">
          <button
            type="button"
            class="chart-button"
            classList={{ open: !showArchived() }}
            onClick={() => setShowArchived(false)}
          >
            Worlds ({worlds().length})
          </button>
          <button
            type="button"
            class="chart-button"
            classList={{ open: showArchived() }}
            onClick={() => setShowArchived(true)}
          >
            Trash ({archivedWorlds().length})
          </button>
        </div>

        <Show when={!showArchived()}>
          <For each={worlds()}>
            {(world) => (
              <div class="restore-row" classList={{ current: world.id === activeWorldId() }}>
                <WorldThumbnail data={world.thumbnail} name={world.name} />
                <div class="restore-row-main">
                  <strong>{world.name}</strong>
                  <Show when={world.id === activeWorldId()}>
                    <span class="status-label"> — loaded</span>
                  </Show>
                  <Show when={world.unreadable !== undefined}>
                    <span class="restore-refusal"> — unreadable: {world.unreadable}</span>
                  </Show>
                  <div class="hud-hint">
                    {world.worldSize}² · {world.restorePoints} restore points
                    <Show when={world.pinnedPoints > 0}> ({world.pinnedPoints} pinned)</Show>
                    {' · '}
                    {formatBytes(world.bytes)} · played {formatWhen(world.newestAt, listedAtMs())}
                    {' · '}
                    <code>{world.id}</code>
                  </div>
                </div>

                <div class="restore-row-actions">
                  <Show when={world.id !== activeWorldId() && world.unreadable === undefined}>
                    <button
                      type="button"
                      class="chart-button"
                      title="Open: save current, load this one"
                      onClick={() => send({ type: 'worldLoad', key: worldAdminKey(), id: world.id })}
                    >
                      Load
                    </button>
                  </Show>

                  <button
                    type="button"
                    class="chart-button"
                    title="Rename: the file never moves"
                    onClick={() => {
                      setRenamingId(world.id);
                      setRenameTo(world.name);
                    }}
                  >
                    Rename
                  </button>

                  <button
                    type="button"
                    class="chart-button"
                    title="Copy: whole history, new name"
                    onClick={() =>
                      send({ type: 'worldDuplicate', key: worldAdminKey(), id: world.id })
                    }
                  >
                    Duplicate
                  </button>

                  {
}
                  <button
                    type="button"
                    class="chart-button"
                    title="Plugins: choose what this world runs"
                    onClick={() => {
                      if (pluginsForId() === world.id) {
                        setPluginsForId(null);
                        return;
                      }
                      setPluginsForId(world.id);
                      send({ type: 'worldPluginList', key: worldAdminKey(), id: world.id });
                    }}
                  >
                    Plugins
                  </button>

                  {
}
                  <Show when={world.id !== activeWorldId()}>
                    <Show
                      when={armedArchiveId() === world.id}
                      fallback={
                        <button
                          type="button"
                          class="chart-button"
                          title="Trash: moved aside, not deleted"
                          onClick={() => setArmedArchiveId(world.id)}
                        >
                          Archive
                        </button>
                      }
                    >
                      <button
                        type="button"
                        class="chart-button danger"
                        onClick={() => {
                          setArmedArchiveId(null);
                          send({ type: 'worldArchive', key: worldAdminKey(), id: world.id });
                        }}
                      >
                        Move to trash
                      </button>
                      <button type="button" class="chart-button" onClick={() => setArmedArchiveId(null)}>
                        Cancel
                      </button>
                    </Show>
                  </Show>
                </div>

                {
}
                <Show when={pluginsForId() === world.id && worldPlugins()?.id === world.id}>
                  <div class="restore-row-main">
                    <p class="hud-hint">
                      Terrain a disabled plugin sculpted stays sculpted — it is in
                      the heightmap, and switching the plugin off does not put it
                      back. Disabling frees no memory either: the plugin’s module
                      stays loaded and its saved state is frozen, not freed, which
                      is what lets re-enabling pick up exactly where it left off.
                    </p>
                    <Show when={world.id === activeWorldId()}>
                      <p class="hud-hint">
                        Toggling the world you are in reopens it: everyone is
                        re-snapshotted where they stand, and nobody is disconnected.
                      </p>
                    </Show>
                    {
}
                    <div class="plugin-list">
                      <For each={worldPlugins()?.installed ?? []}>
                        {(pluginName) => {
                          const isDisabled = (): boolean =>
                            worldPlugins()?.disabled.includes(pluginName) ?? false;
                          const stamp = (): string => worldPlugins()?.versions[pluginName] ?? '';
                          return (
                            <>
                            <span class="plugin-label">
                              {pluginName}
                              {
}
                              <Show when={stamp() !== ''}>
                                <span class="plugin-version"> v{stamp()}</span>
                              </Show>
                            </span>
                            <span class="plugin-controls">
                            <button
                              type="button"
                              class="chart-button plugin-toggle"
                              classList={{ on: !isDisabled(), off: isDisabled() }}
                              title={
                                isDisabled()
                                  ? `On: “${pluginName}” runs in this world`
                                  : `Off: “${pluginName}” stops in this world`
                              }
                              onClick={() =>
                                send({
                                  type: 'worldPluginSet',
                                  key: worldAdminKey(),
                                  id: world.id,
                                  plugin: pluginName,
                                  enabled: isDisabled(),
                                })
                              }
                            >
                              {isDisabled() ? 'off' : 'on'}
                            </button>
                            {
}
                            <button
                              type="button"
                              class="chart-button plugin-reload"
                              aria-label={`Reload ${pluginName}`}
                              title={`Reload: re-import “${pluginName}” without restarting`}
                              onClick={() =>
                                send({
                                  type: 'worldPluginReload',
                                  key: worldAdminKey(),
                                  id: world.id,
                                  plugin: pluginName,
                                })
                              }
                            >
                              ↻
                            </button>
                            </span>
                            </>
                          );
                        }}
                      </For>
                    </div>
                    {
}
                    <For each={worldPlugins()?.settings ?? []}>
                      {(setting) => (
                        <label class="restore-row-actions plugin-setting">
                          <span class="hud-hint">
                            {setting.plugin} — {setting.key}
                          </span>
                          <select
                            class="chart-button"
                            value={
                              worldPlugins()?.settings.find(
                                (row) => row.plugin === setting.plugin && row.key === setting.key,
                              )?.value ?? setting.value
                            }
                            onChange={(event) =>
                              send({
                                type: 'worldPluginConfigure',
                                key: worldAdminKey(),
                                id: world.id,
                                plugin: setting.plugin,
                                setting: setting.key,
                                value: event.currentTarget.value,
                              })
                            }
                          >
                            <For each={setting.values}>
                              {(value) => <option value={value}>{value}</option>}
                            </For>
                          </select>
                        </label>
                      )}
                    </For>
                    <Show when={(worldPlugins()?.settings.length ?? 0) > 0}>
                      <p class="hud-hint">
                        Changing a setting reopens the world it belongs to, the same
                        way a toggle does. A settlement grown under one rule is then
                        judged by the next one — swapping back to the cellular
                        automaton will demolish most of what the other rule built,
                        which is what “swap” means here.
                      </p>
                    </Show>
                    <Show when={(worldPlugins()?.installed.length ?? 0) === 0}>
                      <p class="hud-hint">This server has no plugins installed.</p>
                    </Show>
                  </div>
                </Show>

                <Show when={renamingId() === world.id}>
                  <form
                    class="restore-key-row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      setRenamingId(null);
                      send({
                        type: 'worldRename',
                        key: worldAdminKey(),
                        id: world.id,
                        name: renameTo(),
                      });
                    }}
                  >
                    <input
                      class="restore-key-input"
                      value={renameTo()}
                      onInput={(event) => setRenameTo(event.currentTarget.value)}
                    />
                    <button type="submit" class="chart-button" disabled={renameTo().trim() === ''}>
                      Save name
                    </button>
                    <button type="button" class="chart-button" onClick={() => setRenamingId(null)}>
                      Cancel
                    </button>
                  </form>
                </Show>
              </div>
            )}
          </For>

          <Show when={activeWorldId() !== null}>
            <button
              type="button"
              class="chart-button"
              title="Close world: save it, load none"
              onClick={() => send({ type: 'worldUnload', key: worldAdminKey() })}
            >
              Unload the current world
            </button>
          </Show>

          {
}
          <form
            class="restore-key-row"
            onSubmit={(event) => {
              event.preventDefault();
              const name = newName().trim();
              setNewName('');
              send({
                type: 'worldCreate',
                key: worldAdminKey(),
                ...(name === '' ? {} : { name }),
              });
            }}
          >
            <label class="controls-label" for="new-world-name">
              New world
            </label>
            <input
              id="new-world-name"
              class="restore-key-input"
              placeholder="leave blank for a minted name"
              value={newName()}
              onInput={(event) => setNewName(event.currentTarget.value)}
            />
            <button type="submit" class="chart-button" disabled={worldAdminKey() === ''}>
              Create
            </button>
          </form>
          <Show when={newName().trim() !== ''}>
            <p class="hud-hint">
              File: <code>{slugifyWorldName(newName().trim())}.db</code>
            </p>
          </Show>
        </Show>

        <Show when={showArchived()}>
          <p class="hud-hint">
            Archived worlds are still on disk, untouched. Restore puts one back;
            Purge deletes it permanently and cannot be undone.
          </p>
          <For each={archivedWorlds()}>
            {(world) => (
              <div class="restore-row">
                <WorldThumbnail data={world.thumbnail} name={world.name} />
                <div class="restore-row-main">
                  <strong>{world.name}</strong>
                  <div class="hud-hint">
                    {world.worldSize}² · {world.restorePoints} restore points ·{' '}
                    {formatBytes(world.bytes)} · archived{' '}
                    {formatWhen(world.archivedAt, listedAtMs())} · <code>{world.id}</code>
                  </div>
                </div>
                <div class="restore-row-actions">
                  <button
                    type="button"
                    class="chart-button"
                    title="Restore: out of the trash"
                    onClick={() =>
                      send({ type: 'worldUnarchive', key: worldAdminKey(), id: world.id })
                    }
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    class="chart-button"
                    onClick={() => {
                      setPurgingId(world.id);
                      setPurgeConfirm('');
                    }}
                  >
                    Purge…
                  </button>
                </div>

                <Show when={purgingId() === world.id}>
                  <form
                    class="restore-key-row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      setPurgingId(null);
                      send({
                        type: 'worldPurge',
                        key: worldAdminKey(),
                        id: world.id,
                        confirmName: purgeConfirm(),
                      });
                    }}
                  >
                    <label class="controls-label" for={`purge-${world.id}`}>
                      Type “{world.name}” to delete it forever
                    </label>
                    <input
                      id={`purge-${world.id}`}
                      class="restore-key-input"
                      autocomplete="off"
                      value={purgeConfirm()}
                      onInput={(event) => setPurgeConfirm(event.currentTarget.value)}
                    />
                    <button
                      type="submit"
                      class="chart-button danger"
                      disabled={purgeConfirm() !== world.name}
                    >
                      Delete permanently
                    </button>
                    <button type="button" class="chart-button" onClick={() => setPurgingId(null)}>
                      Cancel
                    </button>
                  </form>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

function doneText(done: Extract<WorldFeedback, { kind: 'done' }>): string {
  switch (done.action) {
    case 'create':
      return `Created “${done.id ?? 'the world'}”.`;
    case 'load':
      return 'Loading that world.';
    case 'unload':
      return 'The world was saved and closed. No world is loaded.';
    case 'rename':
      return 'Renamed.';
    case 'duplicate':
      return `Duplicated as “${done.id ?? 'a copy'}”, with its whole history.`;
    case 'archive':
      return done.archivedPath === null
        ? 'Moved to the trash.'
        : `Moved to the trash: ${done.archivedPath}`;
    case 'unarchive':
      return `Restored from the trash as “${done.id ?? 'it was'}”.`;
    case 'purge':
      return 'Deleted permanently.';
    case 'pin':
      return 'Restore point pinned.';
    case 'cancelSwitch':
      return 'The switch was called off.';
    case 'setPlugin':
      return 'That world’s plugin set was changed.';
    case 'configurePlugin':
      return 'That world’s plugin setting was changed.';
    case 'reloadPlugin':
      return `Re-imported “${done.plugin ?? 'the plugin'}”. The version beside its toggle is the build that is now live.`;
    case 'restart':
      return 'The server is restarting. It will come back on the code that is on disk now.';
    case 'view':
      return done.detail === 'all'
        ? 'Showing the whole world.'
        : 'Showing your own territory again.';
    case 'actPlugin':
      return done.detail ?? `“${done.plugin ?? 'the plugin'}” did that.`;
    default: {
      const missed: never = done.action;
      return missed;
    }
  }
}
