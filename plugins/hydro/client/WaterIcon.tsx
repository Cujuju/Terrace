// The Hydro tool's face on the bottom toolbar: a tipped pail pouring, drawn as
// a shaded inline SVG (owner, 2026-09-04: "gorgeous 3D icons") — gradients give
// the water its depth and the pail its roundness, so the button reads as an
// object rather than a glyph. Every gradient id is prefixed with the tool's
// name because SVG ids are document-global and the toolbar holds several icons
// at once.
//
// IT IS THE SHAPE THE GAME DRAWS, not a generic droplet — the pool at the foot
// is the PATCH's own silhouette: a soft-edged disc, bright in the middle and
// fading to nothing at the rim, which is exactly ../protocol.ts's `hydroFalloff`
// and exactly what ./puddles.ts paints on the ground. A player who has watered
// a hillside recognises the button without reading it.
//
// IT PAIRS WITH THE TORCH IT STANDS NEXT TO (../../fire/client/TorchIcon.tsx).
// Same 32×32 frame, same optical balance — one heavy body over one bright
// event — and the pail is deliberately the torch's own materials, a wooden
// stave body under an iron band, so the two read as one set of tools rather
// than as two pieces of clip art.

import type { JSX } from 'solid-js';

export function WaterIcon(): JSX.Element {
  return (
    <svg
      class="hud-tool__icon"
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <defs>
        {/* The wet sheen around the pool — the torch's heat haze, cooled. */}
        <radialGradient id="hydro-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="#7fd4ff" stop-opacity="0.7" />
          <stop offset="1" stop-color="#1b6fd1" stop-opacity="0" />
        </radialGradient>
        {/*
          The patch itself: full strength across the core, falling away over the
          rim. The stops are the two ends of `hydroFalloff` — a flat middle and
          a soft edge — rather than a linear ramp, which would draw a puddle
          with a boundary the game's own water does not have.
        */}
        <radialGradient id="hydro-pool" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="#bde9ff" />
          <stop offset="0.45" stop-color="#4aa8e8" />
          <stop offset="1" stop-color="#1a5fa8" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="hydro-stream" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#1f74c8" />
          <stop offset="0.4" stop-color="#7ecbf5" />
          <stop offset="1" stop-color="#2a86d6" />
        </linearGradient>
        <linearGradient id="hydro-wood" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#d9a066" />
          <stop offset="0.45" stop-color="#9c5f2c" />
          <stop offset="1" stop-color="#4e2f15" />
        </linearGradient>
        <linearGradient id="hydro-band" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#eaeaea" />
          <stop offset="0.5" stop-color="#8c96a0" />
          <stop offset="1" stop-color="#3f474f" />
        </linearGradient>
      </defs>
      {/* The sheen behind the pool. */}
      <circle cx="16" cy="24" r="9" fill="url(#hydro-glow)" />
      {/* The pail, tipped: a staved body under an iron band, mouth to the left. */}
      <path d="M9.4 4.2 22.6 8.1l-2.1 7.1a3.4 3.4 0 0 1-4.2 2.3l-5-1.5a3.4 3.4 0 0 1-2.3-4.2z" fill="url(#hydro-wood)" />
      <path d="M9.1 5.3 23 9.4l0.8-2.7L9.9 2.6z" fill="url(#hydro-band)" />
      {/* The stream, from the pail's lip to the pool it is making. */}
      <path d="M13.6 16.2c1.6 3.1 2.4 5.6 2.4 7.4h-3.6c0-1.8 0.4-4.3 1.2-7.4z" fill="url(#hydro-stream)" />
      {/* The patch on the ground: the disc this tool actually leaves behind. */}
      <ellipse cx="16" cy="25.4" rx="10" ry="4.2" fill="url(#hydro-pool)" />
      {/* The specular the torch's flame has, on the near lip of the water. */}
      <ellipse cx="12.4" cy="24.2" rx="2.1" ry="0.85" fill="#ffffff" opacity="0.8" />
    </svg>
  );
}
