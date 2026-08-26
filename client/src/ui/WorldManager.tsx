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
import {
  activeWorldId,
  archivedWorlds,
  pendingSwitch,
  setWorldAdminKey,
  setWorldFeedback,
  setWorldPanelOpen,
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

/** Plain-language reason, so the server never composes player-facing prose. */
function refusalText(reason: WorldAdminRefusal): string {
  switch (reason) {
    case 'disabled':
      return 'This server has no world-admin key set. Set WORLD_ADMIN_KEY in its environment and restart it.';
    case 'badKey':
      return 'That key does not match this server’s WORLD_ADMIN_KEY.';
    case 'throttled':
      return 'Too many wrong keys. Wait a minute, then try again.';
    case 'unknownWorld':
      return 'That world is not on this server any more. Refresh the list.';
    case 'alreadyActive':
      return 'That world is already the one you are in.';
    case 'nameInUse':
      return 'A world of that name already exists. Nothing was overwritten — pick another name.';
    case 'invalidName':
      return 'That name has no usable letters or digits in it. Try another.';
    case 'invalidSize':
      return 'That world size is outside what this server allows, or is not a whole number of chunks.';
    case 'notArchived':
      return 'That world is not in the trash. Archive it first.';
    case 'confirmationMismatch':
      return 'The name you typed does not match the world’s name. Nothing was deleted.';
    case 'switchInProgress':
      return 'A world switch is already counting down. Cancel it first.';
    case 'unknownPlugin':
      return 'This server has no plugin by that name any more. Reopen the plugin list.';
    case 'worldIsActive':
      return 'That world is loaded right now. Switch to another world (or unload) first.';
    case 'noWorldLoaded':
      return 'No world is loaded, so there was nothing to do.';
    case 'noSwitchPending':
      return 'There was no switch counting down.';
    case 'failed':
      return 'The server could not complete that. Nothing was destroyed — check the server log.';
  }
}

export function WorldManager(props: { actions: WorldActions }): JSX.Element {
  // Which world is armed for archiving, by id; null when nothing is armed.
  // Local to the panel: a property of this operator's current look at it.
  const [armedArchiveId, setArmedArchiveId] = createSignal<string | null>(null);
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
            {doneText(worldFeedback() as { action: string; id: string | null; archivedPath: string | null })}
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
                    <div class="restore-row-actions">
                      <For each={worldPlugins()?.installed ?? []}>
                        {(pluginName) => {
                          // Accessors, never a const holding the read: the lists
                          // are replaced by the server's answer to every toggle.
                          const isDisabled = (): boolean =>
                            worldPlugins()?.disabled.includes(pluginName) ?? false;
                          return (
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
                              {pluginName} — {isDisabled() ? 'off' : 'on'}
                            </button>
                          );
                        }}
                      </For>
                    </div>
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
function doneText(done: { action: string; id: string | null; archivedPath: string | null }): string {
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
    default:
      return 'Done.';
  }
}
