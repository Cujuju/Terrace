import { For, Show, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import type { WorldAdminRequestMessage, WorldPluginAction } from '@terrace/shared';
import {
  activeWorldId,
  setAdminPanelOpen,
  setArmedAction,
  setWorldAdminKey,
  setWorldFeedback,
  worldAdminKey,
  worldFeedback,
  worldPlugins,
  type WorldFeedback,
} from '../state/worldsState.ts';
import type { WorldActions } from './WorldManager.tsx';
import { refusalText } from './worldAdminCopy.ts';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HUE_DEGREES = 360;

function hueFor(name: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash % HUE_DEGREES;
}

const UNDECLARED_ARCHETYPE = 'other';

interface ArchetypeGroup {
  readonly archetype: string;
  readonly actions: WorldPluginAction[];
}

function groupByArchetype(actions: readonly WorldPluginAction[]): ArchetypeGroup[] {
  const groups: ArchetypeGroup[] = [];
  for (const action of actions) {
    const archetype = action.archetype ?? UNDECLARED_ARCHETYPE;
    const group = groups.find((candidate) => candidate.archetype === archetype);
    if (group === undefined) groups.push({ archetype, actions: [action] });
    else group.actions.push(action);
  }
  return groups.sort(
    (a, b) =>
      Number(a.archetype === UNDECLARED_ARCHETYPE) - Number(b.archetype === UNDECLARED_ARCHETYPE),
  );
}

function isActionFeedback(feedback: WorldFeedback): boolean {
  return (feedback.kind === 'done' || feedback.kind === 'refused') && feedback.action === 'actPlugin';
}

export function AdminPanel(props: { actions: WorldActions }): JSX.Element {
  const [unlocked, setUnlocked] = createSignal(worldAdminKey() !== '');

  const send = (message: WorldAdminRequestMessage): void => {
    setWorldFeedback({ kind: 'working' });
    props.actions.send(message);
  };

  const requestListing = (): void => {
    setUnlocked(true);
    send({ type: 'worldPluginList', key: worldAdminKey() });
  };

  const listedForLiveWorld = (): boolean =>
    activeWorldId() !== null && worldPlugins()?.id === activeWorldId();

  if (unlocked() && !listedForLiveWorld()) requestListing();

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') setAdminPanelOpen(false);
  };
  window.addEventListener('keydown', onKeyDown);
  onCleanup(() => window.removeEventListener('keydown', onKeyDown));

  let pressedBackdrop = false;
  const onBackdropPointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }): void => {
    pressedBackdrop = event.target === event.currentTarget;
  };
  const onBackdropClick = (event: MouseEvent & { currentTarget: HTMLDivElement }): void => {
    if (pressedBackdrop && event.target === event.currentTarget) setAdminPanelOpen(false);
    pressedBackdrop = false;
  };

  const groups = createMemo(() => groupByArchetype(worldPlugins()?.actions ?? []));

  const arm = (action: WorldPluginAction): void => {
    setArmedAction(action);
    setAdminPanelOpen(false);
  };

  return (
    <div
      class="restore-overlay"
      role="dialog"
      aria-label="Admin: world events"
      onPointerDown={onBackdropPointerDown}
      onClick={onBackdropClick}
    >
      <div class="restore-sheet admin-sheet">
        {}
        <header class="admin-header">
          <div class="admin-title-block">
            <span class="admin-eyebrow">Admin</span>
            <h2 class="admin-title">World events</h2>
          </div>
          <button
            type="button"
            class="chart-button admin-close"
            aria-label="Close admin panel"
            title="Close: put the panel away"
            onClick={() => setAdminPanelOpen(false)}
          >
            ✕
          </button>
        </header>

        <p class="admin-lede">
          Fire the events that would otherwise wait on chance. Pick one, then
          click the ground where it should happen; it behaves exactly as the
          real thing would.
        </p>

        {
}
        <Show when={!unlocked()}>
          <form
            class="admin-key-row"
            onSubmit={(event) => {
              event.preventDefault();
              requestListing();
            }}
          >
            <label class="controls-label" for="admin-key">
              World-admin key
            </label>
            <input
              id="admin-key"
              class="restore-key-input"
              type="password"
              autocomplete="off"
              placeholder="WORLD_ADMIN_KEY"
              value={worldAdminKey()}
              onInput={(event) => setWorldAdminKey(event.currentTarget.value)}
            />
            <button type="submit" class="chart-button admin-unlock" disabled={worldAdminKey() === ''}>
              Unlock
            </button>
          </form>
        </Show>

        {
}
        <Show when={isActionFeedback(worldFeedback())}>
          {(() => {
            const feedback = worldFeedback() as Extract<WorldFeedback, { kind: 'done' | 'refused' }>;
            const tone =
              feedback.kind === 'done' ? 'ok' : feedback.reason === 'actionDeclined' ? 'declined' : 'refused';
            const text =
              feedback.kind === 'done'
                ? feedback.detail ?? 'Done.'
                : feedback.reason === 'actionDeclined'
                  ? feedback.detail ?? refusalText(feedback.reason)
                  : refusalText(feedback.reason);
            return (
              <p class="admin-receipt" classList={{ [`admin-receipt-${tone}`]: true }} role="status">
                <span class="admin-receipt-dot" aria-hidden="true" />
                <span>{text}</span>
              </p>
            );
          })()}
        </Show>

        {
}
        <Show when={worldFeedback().kind === 'refused' && !isActionFeedback(worldFeedback())}>
          <p class="admin-receipt admin-receipt-refused" role="status">
            <span class="admin-receipt-dot" aria-hidden="true" />
            <span>{refusalText((worldFeedback() as { reason: Parameters<typeof refusalText>[0] }).reason)}</span>
          </p>
        </Show>

        {
}
        <Show
          when={
            unlocked() &&
            activeWorldId() === null &&
            worldFeedback().kind !== 'working' &&
            worldFeedback().kind !== 'refused'
          }
        >
          <p class="admin-empty">No world is loaded. Load one from the Worlds panel first.</p>
        </Show>

        <Show when={listedForLiveWorld() && groups().length === 0}>
          <p class="admin-empty">No installed plugin declares an action.</p>
        </Show>

        {
}
        <Show when={listedForLiveWorld()}>
          <div class="admin-groups">
            <For each={groups()}>
              {(group) => (
                <section
                  class="admin-group"
                  style={{ '--admin-hue': `${hueFor(group.archetype)}` }}
                >
                  <h3 class="admin-group-name">
                    <span class="admin-group-swatch" aria-hidden="true" />
                    {group.archetype}
                  </h3>
                  <div class="admin-cards">
                    <For each={group.actions}>
                      {(action) => (
                        <button
                          type="button"
                          class="admin-card"
                          title={`${action.plugin}: ${action.description}`}
                          onClick={() => arm(action)}
                        >
                          <span class="admin-card-label">{action.label}</span>
                          <span class="admin-card-description">{action.description}</span>
                          <span class="admin-card-go" aria-hidden="true">→</span>
                        </button>
                      )}
                    </For>
                  </div>
                </section>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
