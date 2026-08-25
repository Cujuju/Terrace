// The Temple tool's face on the bottom toolbar: a stepped pyramid seen
// square-on, drawn as an inline stroke SVG so it takes the HUD's own colour
// like every other icon there (the chart, the history clock, the world stack).
//
// It is the model's silhouette, not a generic building glyph — a player who
// has seen one in the world should recognise the button without reading it.

import type { JSX } from 'solid-js';

export function TempleIcon(): JSX.Element {
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
      {/* The stepped outline: plinth, three battered courses, shrine. */}
      <path d="M2 20h20" />
      <path d="M4 20v-3h16v3" />
      <path d="M6 17v-3h12v3" />
      <path d="M8 14v-3h8v3" />
      {/* The shrine cell and its doorway. */}
      <path d="M10 11V7h4v4" />
      <path d="M12 11V9" />
    </svg>
  );
}
