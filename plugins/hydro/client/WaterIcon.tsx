// The Hydro tool's face on the bottom toolbar: a bucket tipped on its side and
// pouring, drawn as
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
// event — and the bucket is deliberately the torch's own materials, wooden
// staves under iron bands, so the two read as one set of tools rather than as
// two pieces of clip art.

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
          <stop offset="0" stop-color="#d5f2ff" />
          <stop offset="0.45" stop-color="#3d9ce4" />
          <stop offset="0.82" stop-color="#1a5fa8" />
          <stop offset="1" stop-color="#124878" stop-opacity="0" />
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
      <circle cx="15.5" cy="23.5" r="11" fill="url(#hydro-glow)" />
      {/*
        The bail, swung forward off the two rim ears. Drawn BEFORE the body so
        the half that passes behind the bucket is covered by it, which is what
        makes the arc read as a handle going round rather than a line drawn
        across.
      */}
      <path
        d="M9.5 10.13 A 6.6 6.6 0 0 0 16.5 19.87"
        fill="none"
        stroke="url(#hydro-band)"
        stroke-width="1.1"
        stroke-linecap="round"
      />
      {/*
        The bucket, tipped on its side and pouring: staves tapering from the
        NARROW base at the top right down to the WIDE mouth at the bottom left.
        The taper is the whole of the read — a bucket seen end-on is a cylinder,
        and a cylinder is a pipe.

        SHORT (owner, 2026-09-06: "three brown sections, making it too long").
        A bucket is about as deep as its mouth is wide; the first cut of this
        icon was half again that, which read as a length of pipe however well
        the ends were drawn. The body is now a shade under one mouth-width deep,
        and the single hoop leaves TWO staves showing rather than three — the
        section count is what the length is actually read from at 32px.
      */}
      <path d="M18.60 6.53 9.50 10.13 16.50 19.87 22.80 12.37z" fill="url(#hydro-wood)" />
      {/* One iron hoop, sized to the body where it sits. */}
      <path d="M14.51 8.15 19.97 15.75 18.92 16.51 13.46 8.91z" fill="url(#hydro-band)" />
      {/* The closed base. WOOD, not iron: a bright cap here out-reads the mouth
          and the bucket turns back to front. */}
      <ellipse cx="20.7" cy="9.45" rx="3.6" ry="1.4" transform="rotate(54.2 20.7 9.45)" fill="#5a3720" />
      {/* The mouth: the iron rim, then the dark inside seen through it. */}
      <ellipse cx="13" cy="15" rx="6" ry="2.3" transform="rotate(54.2 13 15)" fill="url(#hydro-band)" />
      <ellipse cx="13.5" cy="14.9" rx="5" ry="1.7" transform="rotate(54.2 13.5 14.9)" fill="#2b1a0c" />
      {/* The stream, off the mouth's low lip into the pool it is making. */}
      <path d="M15.0 18.6c1.9 2.6 2.9 4.6 3.0 6.2l-5.6 0.6c0.1-1.9 1.0-4.2 2.6-6.8z" fill="url(#hydro-stream)" />
      {/* The patch on the ground: the disc this tool actually leaves behind. */}
      <ellipse cx="15.4" cy="25.4" rx="12" ry="5" fill="url(#hydro-pool)" />
      {/* The specular the torch's flame has, on the near lip of the water. */}
      <ellipse cx="10.8" cy="24.2" rx="2.6" ry="1" fill="#ffffff" opacity="0.85" />
    </svg>
  );
}
