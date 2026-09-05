// THE RELICS' FACES in the corner panel (owner, 2026-09-04: "more
// representative of what they do and what they are"): one shaded SVG per
// skill, each the same object the relic takes in the world (relicShapes.ts),
// drawn in the toolbar's idiom — an isometric grass tile, the object standing
// or hovering over it, a drop shadow from the tile's own CSS. The skill's
// category colour (gems.ts) is on every one as the glow on the grass and the
// object's own accent, so the three-colour code a player learns from the gems
// still holds.
//
// Gradient ids are prefixed with the skill's name because SVG ids are
// document-global and the panel shows several of these at once.

import type { JSX } from 'solid-js';

/** The tile every icon stands on — the toolbar icons' own, verbatim. */
function Tile(props: { prefix: string; glow: string }): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id={`${props.prefix}-tile-top`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#a6e08a" />
          <stop offset="1" stop-color="#4f9a4a" />
        </linearGradient>
        <linearGradient id={`${props.prefix}-tile-left`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9a6a45" />
          <stop offset="1" stop-color="#5a3a22" />
        </linearGradient>
        <linearGradient id={`${props.prefix}-tile-right`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#6e4a2f" />
          <stop offset="1" stop-color="#3a2415" />
        </linearGradient>
      </defs>
      <ellipse cx="16" cy="27.5" rx="12" ry="3" fill="#000" opacity="0.35" />
      <polygon points="16,13 28,19 16,25 4,19" fill={`url(#${props.prefix}-tile-top)`} />
      <polygon points="4,19 16,25 16,29 4,23" fill={`url(#${props.prefix}-tile-left)`} />
      <polygon points="28,19 16,25 16,29 28,23" fill={`url(#${props.prefix}-tile-right)`} />
      <ellipse cx="16" cy="19" rx="7" ry="3.2" fill={props.glow} opacity="0.3" />
    </>
  );
}

/** Titan's Hand: an open stone hand pressing the ground flat and wide. */
export function TitansHandIcon(): JSX.Element {
  return (
    <svg class="relics-gem" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="titan-stone" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffd48a" />
          <stop offset="0.5" stop-color="#ffb347" />
          <stop offset="1" stop-color="#a86a1a" />
        </linearGradient>
      </defs>
      <Tile prefix="titan" glow="#ffb347" />
      {/* The ground flattened under the palm: a wide, low disc. */}
      <ellipse cx="16" cy="18.5" rx="9" ry="3.6" fill="#3f7f3e" />
      <ellipse cx="16" cy="17.8" rx="9" ry="3.4" fill="#8fd07a" />
      {/* Palm, then fingers fanning forward and a thumb out to the left. */}
      <path
        d="M11 15.5c0-3 2-4.4 5-4.4s5 1.4 5 4.4v2.2c0 1.6-2.2 2.6-5 2.6s-5-1-5-2.6z"
        fill="url(#titan-stone)"
        stroke="#7a4d10"
        stroke-width="0.4"
      />
      <g fill="url(#titan-stone)" stroke="#7a4d10" stroke-width="0.4" stroke-linejoin="round">
        <path d="M11.4 12.2l-1.2-4.6c-.2-.9.3-1.5 1-1.5s1.1.5 1.3 1.3l1.1 4.6z" />
        <path d="M13.9 11.4l-.4-5.4c0-.9.5-1.4 1.2-1.4s1.2.5 1.2 1.4l.3 5.4z" />
        <path d="M16.6 11.4l.3-5.4c0-.9.5-1.4 1.2-1.4s1.2.5 1.2 1.4l-.4 5.4z" />
        <path d="M19.3 12.2l1.1-4.6c.2-.8.7-1.3 1.3-1.3s1.2.6 1 1.5l-1.2 4.6z" />
        <path d="M11 15.8l-3.6-2.2c-.8-.5-.8-1.3-.4-1.8s1.2-.5 1.9-.1l3.2 1.9z" />
      </g>
      <path d="M12.5 12.5c1-.8 2.3-1.1 3.5-1.1" stroke="#fff1d0" stroke-width="0.6" opacity="0.7" fill="none" stroke-linecap="round" />
    </svg>
  );
}

/** Quake: the tile cracked open into a crater, shards thrown up from it. */
export function QuakeIcon(): JSX.Element {
  return (
    <svg class="relics-gem" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <radialGradient id="quake-crater" cx="0.5" cy="0.5" r="0.6">
          <stop offset="0" stop-color="#1a0c0a" />
          <stop offset="0.7" stop-color="#3a1a14" />
          <stop offset="1" stop-color="#5a3a22" />
        </radialGradient>
        <linearGradient id="quake-shard" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffb3a8" />
          <stop offset="0.5" stop-color="#ff5c5c" />
          <stop offset="1" stop-color="#8a1f1f" />
        </linearGradient>
      </defs>
      <Tile prefix="quake" glow="#ff5c5c" />
      {/* The crater, and the cracks running out from its lip. */}
      <ellipse cx="16" cy="19" rx="7" ry="3.4" fill="url(#quake-crater)" />
      <ellipse cx="16" cy="18.4" rx="7" ry="3" fill="none" stroke="#c9a27a" stroke-width="0.5" opacity="0.6" />
      <g stroke="#ff5c5c" stroke-width="0.7" fill="none" stroke-linecap="round">
        <path d="M9.5 18.2l-2.3-1.1-1.4 0.8" />
        <path d="M22.6 18.4l2.6-0.6 1.3-1.4" />
        <path d="M14 22l-1.6 1.7 0.4 1.6" />
        <path d="M19 21.8l1.2 1.9" />
      </g>
      {/* Shards flung upward, the largest in front. */}
      <g fill="url(#quake-shard)" stroke="#5a1212" stroke-width="0.4" stroke-linejoin="round">
        <polygon points="12,17 9.5,8.5 14.5,12" />
        <polygon points="20,17.5 23.5,7.5 24.5,13" />
        <polygon points="16.5,16 15,4.5 19.5,11" />
      </g>
    </svg>
  );
}

/** Genesis: an island risen from the water with one tree on it. */
export function GenesisIcon(): JSX.Element {
  return (
    <svg class="relics-gem" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="genesis-water" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#7fd4ff" />
          <stop offset="1" stop-color="#2a7fb8" />
        </linearGradient>
        <linearGradient id="genesis-mound" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#c8f0a8" />
          <stop offset="1" stop-color="#4f9a4a" />
        </linearGradient>
        <linearGradient id="genesis-canopy" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffb3a8" />
          <stop offset="0.5" stop-color="#ff5c5c" />
          <stop offset="1" stop-color="#8a1f1f" />
        </linearGradient>
      </defs>
      <Tile prefix="genesis" glow="#ff5c5c" />
      {/* The tile's top is water here, with the island breaking through. */}
      <polygon points="16,13.6 27,19 16,24.4 5,19" fill="url(#genesis-water)" />
      <path d="M8 18.5c1.5-.6 3-.6 4.5 0" stroke="#ffffff" stroke-width="0.5" fill="none" opacity="0.6" stroke-linecap="round" />
      <path d="M20 21.5c1.5-.6 3-.6 4.5 0" stroke="#ffffff" stroke-width="0.5" fill="none" opacity="0.5" stroke-linecap="round" />
      <ellipse cx="16" cy="19.6" rx="6" ry="2.8" fill="#6e4a2f" />
      <path d="M10 19.2c1-3.4 3.4-5 6-5s5 1.6 6 5c-1.6 1.4-3.8 2-6 2s-4.4-.6-6-2z" fill="url(#genesis-mound)" />
      {/* The tree: trunk, then a canopy in the category's crimson bloom. */}
      <rect x="15.3" y="10" width="1.4" height="5" rx="0.5" fill="#6d4220" />
      <polygon points="16,2.5 21,10.5 11,10.5" fill="url(#genesis-canopy)" stroke="#5a1212" stroke-width="0.4" stroke-linejoin="round" />
      <path d="M16 4.5L13 9.5" stroke="#ffe0dc" stroke-width="0.6" opacity="0.7" stroke-linecap="round" />
    </svg>
  );
}

/** Azure Heart: a cut heart hovering over the tile. */
export function AzureHeartIcon(): JSX.Element {
  return (
    <svg class="relics-gem" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="azure-heart-face" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#c8f0ff" />
          <stop offset="0.45" stop-color="#4fc3f7" />
          <stop offset="1" stop-color="#1a6fa0" />
        </linearGradient>
      </defs>
      <Tile prefix="azure-heart" glow="#4fc3f7" />
      <ellipse cx="16" cy="19.2" rx="5" ry="2.2" fill="#2e5a2e" opacity="0.55" />
      <path
        d="M16 17.5c-4.5-3.4-8-6.2-8-9.6C8 5.6 9.7 4 11.8 4c1.7 0 3.2 1 4.2 2.6C17 5 18.5 4 20.2 4 22.3 4 24 5.6 24 7.9c0 3.4-3.5 6.2-8 9.6z"
        fill="url(#azure-heart-face)"
        stroke="#0f4f78"
        stroke-width="0.5"
        stroke-linejoin="round"
      />
      {/* A facet edge down the middle and a highlight on the left lobe. */}
      <path d="M16 6.6v10.4" stroke="#0f4f78" stroke-width="0.4" opacity="0.5" />
      <path d="M10.2 7.2c.3-1.2 1.2-1.9 2.3-1.9" stroke="#ffffff" stroke-width="0.8" fill="none" opacity="0.8" stroke-linecap="round" />
    </svg>
  );
}

/** Spring of Aether: a basin with a column of water welling up from it. */
export function SpringOfAetherIcon(): JSX.Element {
  return (
    <svg class="relics-gem" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="spring-water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#e2f7ff" />
          <stop offset="0.4" stop-color="#4fc3f7" />
          <stop offset="1" stop-color="#1a6fa0" />
        </linearGradient>
        <linearGradient id="spring-stone" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#d9cdb8" />
          <stop offset="1" stop-color="#7a6a55" />
        </linearGradient>
      </defs>
      <Tile prefix="spring" glow="#4fc3f7" />
      {/* The basin: a stone ring with water standing in it. */}
      <ellipse cx="16" cy="19" rx="7" ry="3.4" fill="url(#spring-stone)" />
      <ellipse cx="16" cy="18.6" rx="5.4" ry="2.4" fill="#2a7fb8" />
      <ellipse cx="16" cy="18.3" rx="5.4" ry="2.1" fill="url(#spring-water)" opacity="0.9" />
      {/* The column rising, widening as it falls back, and a drop at the crest. */}
      <path d="M13.6 18c0-5 .8-8.5 2.4-11.5 1.6 3 2.4 6.5 2.4 11.5z" fill="url(#spring-water)" stroke="#1a6fa0" stroke-width="0.4" />
      <path d="M15.2 15c0-3 .3-5.5.8-7.5" stroke="#ffffff" stroke-width="0.6" opacity="0.8" fill="none" stroke-linecap="round" />
      <path d="M16 2.5c1.3 1.8 2 3 2 4a2 2 0 0 1-4 0c0-1 .7-2.2 2-4z" fill="url(#spring-water)" stroke="#1a6fa0" stroke-width="0.4" />
      {/* Splashes off the rim. */}
      <g fill="#e2f7ff" opacity="0.85">
        <circle cx="10.5" cy="15.5" r="0.7" />
        <circle cx="21.8" cy="15" r="0.6" />
        <circle cx="22.8" cy="17.2" r="0.45" />
      </g>
    </svg>
  );
}
