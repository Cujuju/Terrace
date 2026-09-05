// The Torch tool's face on the bottom toolbar: a lit torch, drawn as a
// shaded inline SVG (owner, 2026-09-04: "gorgeous 3D icons") — gradients give
// the flame its heat and the handle its roundness, so the button reads as an
// object rather than a glyph. Every gradient id is prefixed with the tool's
// name because SVG ids are document-global and the toolbar holds several
// icons at once.
//
// It is the SHAPE THE GAME DRAWS, not a generic fire glyph — the teardrop
// flame is the plume's own silhouette (flames/shaderPlume.ts), so a player
// who has watched a tree burn recognises the button without reading it.

import type { JSX } from 'solid-js';

export function TorchIcon(): JSX.Element {
  return (
    <svg
      class="hud-tool__icon"
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="pyro-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="#ffb347" stop-opacity="0.75" />
          <stop offset="1" stop-color="#ff5a1f" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="pyro-outer" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffd23f" />
          <stop offset="0.5" stop-color="#ff7a1a" />
          <stop offset="1" stop-color="#d1261a" />
        </linearGradient>
        <linearGradient id="pyro-inner" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fff9c4" />
          <stop offset="1" stop-color="#ffb020" />
        </linearGradient>
        <linearGradient id="pyro-wood" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#d9a066" />
          <stop offset="0.45" stop-color="#9c5f2c" />
          <stop offset="1" stop-color="#4e2f15" />
        </linearGradient>
        <linearGradient id="pyro-band" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#eaeaea" />
          <stop offset="0.5" stop-color="#8c96a0" />
          <stop offset="1" stop-color="#3f474f" />
        </linearGradient>
      </defs>
      {/* The heat haze behind the flame. */}
      <circle cx="16" cy="12" r="12" fill="url(#pyro-glow)" />
      {/* The handle: a wooden shaft under an iron band. */}
      <path d="M13.2 17.5h5.6l-1.4 12.5h-2.8z" fill="url(#pyro-wood)" />
      <path d="M12.6 16.6h6.8v3h-6.8z" fill="url(#pyro-band)" />
      {/* The outer flame, then its hot core and a white-hot highlight. */}
      <path
        d="M16 2.5c4.4 4.6 6.6 8.1 6.6 11.4a6.6 6.6 0 0 1-13.2 0c0-3.3 2.2-6.8 6.6-11.4z"
        fill="url(#pyro-outer)"
      />
      <path
        d="M16.6 9.2c2 2.2 3 4 3 5.4a3.1 3.1 0 0 1-6.2 0c0-1.4 1-3.2 3.2-5.4z"
        fill="url(#pyro-inner)"
      />
      <ellipse cx="17.4" cy="14.6" rx="1.1" ry="1.6" fill="#ffffff" opacity="0.85" />
    </svg>
  );
}
