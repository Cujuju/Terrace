// The Torch tool's face on the bottom toolbar: a flame, drawn as an inline
// stroke SVG so it takes the HUD's own colour like every other icon there.
//
// It is the SHAPE THE GAME DRAWS, not a generic fire glyph — the teardrop with
// the notched foot is the plume's own silhouette (flames/shaderPlume.ts), so a
// player who has watched a tree burn recognises the button without reading it.

import type { JSX } from 'solid-js';

export function TorchIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {/* The outer flame: a leaning teardrop, waisted at the foot. */}
      <path d="M12 3c3.2 3.4 4.8 6 4.8 8.4a4.8 4.8 0 0 1-9.6 0C7.2 9 8.8 6.4 12 3Z" />
      {/* The hot core, the same shape at a third the size. */}
      <path d="M12 12.4c1.3 1.4 1.9 2.5 1.9 3.4a1.9 1.9 0 0 1-3.8 0c0-.9.6-2 1.9-3.4Z" />
      {/* The ground it stands on. */}
      <path d="M6 21h12" />
    </svg>
  );
}
