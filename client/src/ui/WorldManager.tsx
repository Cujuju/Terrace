// The world-manager panel — "which world am I in, and what else is there?"
// (multi-world, 2026-08-22).
//
// WHY THIS PANEL EXISTS. Until now a server had exactly one world and the only
// way to run another was to stop the process and point DB_PATH somewhere else.
// Worse, the old single-file layout meant a second world could quietly evict
// the first one's history. Worlds are now files, and this is the door to them.
//
// WHAT MAKES IT SAFE IS THE TRASH, NOT THE CONFIRMATIONS. Archive moves a
// world's file into `.trash` and says where it went; the only thing that
// destroys a world is Purge, on the archived tab, and it demands the world's
// own name typed out. Two separate decisions, separated by however long the
// operator takes to come back — see world-admin.ts for the server half.
//
// DESTRUCTIVE ACTIONS CONFIRM IN PLACE, matching RestorePoints.tsx: the row's
// button arms, a second differently-labelled button commits, and no dialog is
// used — the project's UI rule is that a confirm dialog which always says the
// same thing trains people to dismiss it.
//
// SOLID REACTIVITY: every reactive value is read by CALLING its accessor at
// the point of use, inside JSX or inside an event handler. There are no
// component-body consts holding a reactive read in this file, by construction.

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

/** What the panel can ask the server to do. Supplied by main.tsx. */
export interface WorldActions {
  send(message: WorldAdminRequestMessage): void;
}

/** Bytes per KiB/MiB step — named because it is a unit, not a tuning knob. */
const BYTES_PER_STEP = 1024;

/** Units the size column steps through. Beyond GiB is not a world, it is a bug. */
const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB'] as const;

/** Milliseconds in a day, for the "last played" column. */
const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

/** Disk size, at one decimal place from KiB up. */
function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_STEP && unit < SIZE_UNITS.length - 1) {
    value /= BYTES_PER_STEP;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/** "3h ago" / "just now" / "never" — the reading an operator navigates by. */
function formatWhen(epochMs: number | null | undefined, nowMs: number): string {
  if (epochMs === null || epochMs === undefined) return 'never';
  const elapsed = Math.max(0, nowMs - epochMs);
  if (elapsed < MS_PER_MINUTE) return 'just now';
  if (elapsed < MS_PER_HOUR) return `${Math.round(elapsed / MS_PER_MINUTE)}m ago`;
  if (elapsed < MS_PER_DAY) return `${Math.round(elapsed / MS_PER_HOUR)}h ago`;
  return `${Math.round(elapsed / MS_PER_DAY)}d ago`;
}

export function WorldManager(props: { actions: WorldActions }): JSX.Element {
  // Which world is armed for archiving, by id; null when nothing is armed.
  // Local to the panel: a property of this operator's current look at it.
  const [armedArchiveId, setArmedArchiveId] = createSignal<string | null>(null);
  // Whether the restart button has been armed. Local to this look at the
  // panel, exactly as `armedArchiveId` is.
  const [armedRestart, setArmedRestart] = createSignal(false);
  // Which archived world's purge form is open, and what has been typed into it.
  const [purgingId, setPurgingId] = createSignal<string | null>(null);
  const [purgeConfirm, setPurgeConfirm] = createSignal('');
  // Which world's plugin list is expanded, by id; null when none is.
  const [pluginsForId, setPluginsForId] = createSignal<string | null>(null);
  // Which world is being renamed, and to what.
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameTo, setRenameTo] = createSignal('');
  // The create form.
  const [newName, setNewName] = createSignal('');
  const [showArchived, setShowArchived] = createSignal(false);
  // Captured when a listing arrives, so every row's age is measured against
  // one instant instead of each row rendering against a slightly different now.
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
            title="Close this panel."
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

        {/* The key is typed, never stored: see state/worldsState.ts. A
            password field so it is not shoulder-read off a shared screen. */}
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
          {/* Narrowed through a local, non-reactive read inside the guard: the
              Show above has already established the kind. */}
          <p class="restore-refusal">
            {refusalText((worldFeedback() as { reason: WorldAdminRefusal }).reason)}
          </p>
        </Show>

        <Show when={worldFeedback().kind === 'done'}>
          <p class="hud-hint">
            {/* Narrowed the same way as the refusal above; keeping the union
                intact is what lets doneText's switch be checked exhaustive. */}
            {doneText(worldFeedback() as Extract<WorldFeedback, { kind: 'done' }>)}
          </p>
        </Show>

        {/* Cancelling is offered HERE as well as being possible from the
            server, because the operator who started a countdown is the person
            most likely to want it stopped, and they are already looking at
            this panel. */}
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

        {/* RESTART — the update button. Armed then committed, like Archive,
            because it interrupts everyone on the server; unlike Archive it
            destroys nothing, so the second press is not styled as a danger.
            It lives beside the tabs rather than in a world's row on purpose:
            it is a property of the PROCESS, not of any one world. */}
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
                title="Restart the server process so new code becomes live."
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
                      title="Save the world you are in, close it, and open this one."
                      onClick={() => send({ type: 'worldLoad', key: worldAdminKey(), id: world.id })}
                    >
                      Load
                    </button>
                  </Show>

                  <button
                    type="button"
                    class="chart-button"
                    title="Rename this world. Its file never moves."
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
                    title="Copy this world, with its entire history, under a new name."
                    onClick={() =>
                      send({ type: 'worldDuplicate', key: worldAdminKey(), id: world.id })
                    }
                  >
                    Duplicate
                  </button>

                  {/* Opening the list ASKS the server for it rather than
                      reading anything the listing carried: the disabled set
                      lives in each world's own file, and the panel should not
                      make the server open every world to answer about one. */}
                  <button
                    type="button"
                    class="chart-button"
                    title="Choose which plugins this world runs."
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

                  {/* Archive arms, then commits — see this file's header. The
                      live world cannot be archived at all, so it is not offered. */}
                  <Show when={world.id !== activeWorldId()}>
                    <Show
                      when={armedArchiveId() === world.id}
                      fallback={
                        <button
                          type="button"
                          class="chart-button"
                          title="Move this world to the trash. It is not deleted."
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

                {/* Rendered only once the server's answer is IN and is about
                    THIS world, so a toggle is never offered against another
                    world's plugin set left over on screen. */}
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
                    {/* One grid row per plugin: a label column of one shared
                        width, then the toggle and its reload joined as one
                        control group, so sixteen rows align instead of
                        wrapping wherever the names happen to break. */}
                    <div class="plugin-list">
                      <For each={worldPlugins()?.installed ?? []}>
                        {(pluginName) => {
                          // Accessors, never a const holding the read: the lists
                          // are replaced by the server's answer to every toggle.
                          const isDisabled = (): boolean =>
                            worldPlugins()?.disabled.includes(pluginName) ?? false;
                          // Which build of this plugin the server loaded, or ''
                          // from a server too old to say. An accessor, not a
                          // const, for the reason above it: the listing is
                          // replaced by the answer to every toggle.
                          const stamp = (): string => worldPlugins()?.versions[pluginName] ?? '';
                          return (
                            <>
                            <span class="plugin-label">
                              {pluginName}
                              {/* The build, in small type: it answers "is the
                                  code I just edited live?" and is never
                                  something to act on, so it must not compete
                                  with the on/off state beside it. */}
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
                                  ? `Run “${pluginName}” in this world.`
                                  : `Stop running “${pluginName}” in this world.`
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
                            {/* RE-IMPORT THIS PLUGIN'S SERVER CODE (issue
                                #198). Its own control rather than a modifier on
                                the toggle beside it: the toggle is about THIS
                                world, a reload is about the whole server, and
                                one button that did either depending on how it
                                was clicked is how an operator reloads a plugin
                                they meant to switch off. The page reloads
                                itself afterwards — the build identity moves. */}
                            <button
                              type="button"
                              class="chart-button plugin-reload"
                              aria-label={`Reload ${pluginName}`}
                              title={`Re-import “${pluginName}”’s server code without restarting. If the new code fails, the build that is running stays.`}
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
                    {/* WHAT EACH PLUGIN OFFERS, RENDERED FROM ITS OWN
                        DECLARATION. One select per declared key, its options
                        the values that plugin declared. Nothing here names a
                        plugin, a key or a value: `life | populous` is
                        structures' vocabulary arriving over the wire, and a
                        list of it in core is exactly what this panel must not
                        grow. */}
                    <For each={worldPlugins()?.settings ?? []}>
                      {(setting) => (
                        <label class="restore-row-actions plugin-setting">
                          <span class="hud-hint">
                            {setting.plugin} — {setting.key}
                          </span>
                          <select
                            class="chart-button"
                            // An accessor at the point of use, never a const:
                            // the listing is replaced by the server's answer to
                            // every change, and a frozen read would leave the
                            // control showing the value before last.
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
              title="Save the world you are in and close it, leaving none loaded."
              onClick={() => send({ type: 'worldUnload', key: worldAdminKey() })}
            >
              Unload the current world
            </button>
          </Show>

          {/* Create. The id preview is computed with the SAME function the
              server uses (shared/src/protocol.ts), so it cannot lie. */}
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
                    title="Move this world back out of the trash."
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

/** What a successful action says. Kept beside refusalText for the same reason. */
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
      // The one action whose whole purpose is confirming which code is live
      // (issue #211). The stamp beside the plugin's toggle is re-sent by the
      // server right after this receipt and is the authoritative answer.
      return `Re-imported “${done.plugin ?? 'the plugin'}”. The version beside its toggle is the build that is now live.`;
    case 'restart':
      return 'The server is restarting. It will come back on the code that is on disk now.';
    case 'actPlugin':
      // The plugin's own account is the receipt (AdminPanel.tsx shows it in
      // full); this panel only ever sees one if both are open at once.
      return done.detail ?? `“${done.plugin ?? 'the plugin'}” did that.`;
    default: {
      // Exhaustiveness check: a new WorldAdminAction with no wording here is
      // now a compile error — the omission this switch shipped with (#211).
      const missed: never = done.action;
      return missed;
    }
  }
}
