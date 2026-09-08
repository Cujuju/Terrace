import { Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { worldIdentity } from '../state/hudState.ts';
import { worldClock } from '../plugins/hudPanels.ts';
import { worldHeaderAction } from '../plugins/hudPanels.ts';
import { AlmanacClock } from './AlmanacClock.tsx';

const NAME_TITLE = 'World: named once, at creation';
const DIFFICULTY_TITLE = 'Difficulty: 1 forgiving to 100 punishing';
const CLOCK_TITLE = 'Clock: the time in this world';

export function WorldHeader(): JSX.Element {
  const claimed = (): boolean => worldHeaderAction() !== null;
  return (
    <Show when={worldIdentity().name !== null || worldIdentity().difficulty !== null}>
      <Dynamic
        component={claimed() ? 'button' : 'div'}
        type={claimed() ? 'button' : undefined}
        class="world-header"
        classList={{ 'world-header--action': claimed(), 'world-header--almanac': worldClock() !== null }}
        aria-label={worldHeaderAction()?.label}
        title={worldHeaderAction()?.label}
        onClick={() => worldHeaderAction()?.onClick()}
      >
        {
}
        <span class="world-header__title-row" classList={{ 'hud-frost': worldClock() !== null }}>
          <Show when={worldIdentity().name}>
            {(name) => (
              <span class="world-header__name" title={NAME_TITLE}>
                {name()}
                {
}
                <Show when={worldIdentity().difficulty !== null}>
                  <sup class="world-header__difficulty" title={DIFFICULTY_TITLE}>
                    {worldIdentity().difficulty}
                  </sup>
                </Show>
              </span>
            )}
          </Show>
          <Show when={worldHeaderAction()}>
            {(action) => (
              <span class="world-header__icon" aria-hidden="true">
                <Dynamic component={action().icon} />
              </span>
            )}
          </Show>
        </span>
        {
}
        <Show when={worldIdentity().name === null && worldIdentity().difficulty !== null}>
          <span class="world-header__rating" title={DIFFICULTY_TITLE}>
            Difficulty {worldIdentity().difficulty}
          </span>
        </Show>
        {
}
        <Show when={worldClock()}>
          {(reading) => (
            <span class="world-header__clock" title={CLOCK_TITLE}>
              <AlmanacClock reading={reading()} />
            </span>
          )}
        </Show>
      </Dynamic>
    </Show>
  );
}
