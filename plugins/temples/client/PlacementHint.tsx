import { Show, type JSX } from 'solid-js';

export function PlacementHint(props: { readonly message: string | null }): JSX.Element {
  return (
    <Show when={props.message}>
      <div
        class="hud-panel"
        role="status"
        aria-live="polite"
        style={{
          'min-width': '0',
          'max-width': 'min(28rem, calc(100vw - 24px))',
          'pointer-events': 'none',
          'text-align': 'center',
        }}
      >
        {props.message}
      </div>
    </Show>
  );
}
