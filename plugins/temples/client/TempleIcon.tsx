// The Temple tool's face on the bottom toolbar: a stepped pyramid in
// isometric projection, drawn as a shaded inline SVG (owner, 2026-09-04:
// "gorgeous 3D icons"). Each tier is three faces — a sunlit top, a lit left
// wall and a shaded right wall — so the button reads as a solid, not a glyph.
// Every gradient id is prefixed with the tool's name because SVG ids are
// document-global and the toolbar holds several icons at once.
//
// It is the model's silhouette, not a generic building glyph — a player who
// has seen one in the world should recognise the button without reading it.

import type { JSX } from 'solid-js';

export function TempleIcon(): JSX.Element {
  return (
    <svg
      class="hud-tool__icon"
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="temple-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#f6e6c0" />
          <stop offset="1" stop-color="#d9bf8c" />
        </linearGradient>
        <linearGradient id="temple-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#cfae7a" />
          <stop offset="1" stop-color="#a5875a" />
        </linearGradient>
        <linearGradient id="temple-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#a5865a" />
          <stop offset="1" stop-color="#735a3a" />
        </linearGradient>
        <linearGradient id="temple-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#fff0a8" />
          <stop offset="0.5" stop-color="#f2c14e" />
          <stop offset="1" stop-color="#b8841a" />
        </linearGradient>
      </defs>
      {/* Ground shadow. */}
      <ellipse cx="16" cy="27" rx="13" ry="3.2" fill="#000" opacity="0.35" />
      {/* Plinth. */}
      <polygon points="16,15 29,21.5 16,28 3,21.5" fill="url(#temple-top)" />
      <polygon points="3,21.5 16,28 16,31 3,24.5" fill="url(#temple-left)" />
      <polygon points="29,21.5 16,28 16,31 29,24.5" fill="url(#temple-right)" />
      {/* Second course. */}
      <polygon points="16,11 25,15.5 16,20 7,15.5" fill="url(#temple-top)" />
      <polygon points="7,15.5 16,20 16,23.5 7,19" fill="url(#temple-left)" />
      <polygon points="25,15.5 16,20 16,23.5 25,19" fill="url(#temple-right)" />
      {/* Third course. */}
      <polygon points="16,7.5 21.5,10.25 16,13 10.5,10.25" fill="url(#temple-top)" />
      <polygon points="10.5,10.25 16,13 16,16.5 10.5,13.75" fill="url(#temple-left)" />
      <polygon points="21.5,10.25 16,13 16,16.5 21.5,13.75" fill="url(#temple-right)" />
      {/* The shrine's gilded cap. */}
      <polygon points="16,2.2 19.4,8.3 16,10 12.6,8.3" fill="url(#temple-gold)" />
      <polygon points="12.6,8.3 16,10 16,12.4 12.6,10.7" fill="#c9962a" />
      <polygon points="19.4,8.3 16,10 16,12.4 19.4,10.7" fill="#8f6512" />
      {/* The doorway in the plinth's lit wall. */}
      <path d="M8.6 21.6v3.4l2.4 1.2v-3.4z" fill="#3a2a16" />
    </svg>
  );
}
