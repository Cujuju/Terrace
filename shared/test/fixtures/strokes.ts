import type { StrokeScriptStep } from '../support/goldenCorpus.ts';

export const STROKE_SCRIPTS: Readonly<Record<string, readonly StrokeScriptStep[]>> = {
    "common": [
      {
        "name": "stamp-hard-raise-centre",
        "tool": "stamp",
        "profile": "hard",
        "anchor": "clicked",
        "cx": 32,
        "cy": 32,
        "radius": 4,
        "amount": 16
      },
      {
        "name": "stamp-soft-raise",
        "tool": "stamp",
        "profile": "soft",
        "anchor": "clicked",
        "cx": 20,
        "cy": 40,
        "radius": 6,
        "amount": 16
      },
      {
        "name": "stamp-soft-lower",
        "tool": "stamp",
        "profile": "soft",
        "anchor": "clicked",
        "cx": 44,
        "cy": 20,
        "radius": 5,
        "amount": -16
      },
      {
        "name": "stamp-hard-lower-free",
        "tool": "stamp",
        "profile": "hard",
        "anchor": "free",
        "cx": 12,
        "cy": 12,
        "radius": 3,
        "amount": -32
      },
      {
        "name": "stamp-band-anchored",
        "tool": "stamp",
        "profile": "hard",
        "anchor": "band",
        "targetBand": {
          "fromClick": 0
        },
        "cx": 26,
        "cy": 26,
        "radius": 3,
        "amount": 16
      },
      {
        "name": "smooth-banded-raise",
        "tool": "smooth",
        "spill": "banded",
        "anchor": "clicked",
        "cx": 32,
        "cy": 24,
        "radius": 6,
        "amount": 16
      },
      {
        "name": "smooth-free-lower",
        "tool": "smooth",
        "spill": "free",
        "anchor": "free",
        "cx": 24,
        "cy": 32,
        "radius": 5,
        "amount": -16
      },
      {
        "name": "drag-raise-one-band",
        "tool": "drag",
        "targetBand": {
          "fromClick": 1
        },
        "cx": 30,
        "cy": 30,
        "radius": 3,
        "amount": 16
      },
      {
        "name": "drag-lower-swept",
        "tool": "drag",
        "targetBand": {
          "fromClick": -1
        },
        "sweepFrom": {
          "x": 30,
          "y": 34
        },
        "cx": 34,
        "cy": 34,
        "radius": 3,
        "amount": -16
      },
      {
        "name": "carve-click-band",
        "tool": "carve",
        "spanBand": {
          "fromClick": 0
        },
        "cx": 32,
        "cy": 32,
        "radius": 2,
        "amount": -16
      },
      {
        "name": "carve-click-band-again",
        "tool": "carve",
        "spanBand": {
          "fromClick": 0
        },
        "cx": 32,
        "cy": 32,
        "radius": 2,
        "amount": -16
      },
      {
        "name": "settle-library-tool",
        "tool": "settle",
        "profile": "soft",
        "anchor": "free",
        "cx": 16,
        "cy": 48,
        "radius": 4,
        "amount": 16
      },
      {
        "name": "edge-stamp-origin-corner",
        "tool": "stamp",
        "profile": "hard",
        "anchor": "clicked",
        "cx": 0,
        "cy": 0,
        "radius": 3,
        "amount": 16
      },
      {
        "name": "edge-stamp-far-column",
        "tool": "stamp",
        "profile": "soft",
        "anchor": "clicked",
        "cx": 63,
        "cy": 31,
        "radius": 4,
        "amount": -16
      },
      {
        "name": "edge-smooth-last-row",
        "tool": "smooth",
        "spill": "banded",
        "anchor": "clicked",
        "cx": 31,
        "cy": 63,
        "radius": 4,
        "amount": 16
      },
      {
        "name": "edge-drag-far-corner",
        "tool": "drag",
        "targetBand": {
          "fromClick": 1
        },
        "cx": 63,
        "cy": 63,
        "radius": 2,
        "amount": 16
      }
    ],
    "genesis-noise": [
      {
        "name": "noise-basin-raise",
        "tool": "stamp",
        "profile": "soft",
        "anchor": "clicked",
        "cx": 8,
        "cy": 56,
        "radius": 5,
        "amount": 32
      }
    ],
    "arch": [
      {
        "name": "arch-roof-carve",
        "tool": "carve",
        "spanBand": {
          "fromClick": 0
        },
        "cx": 18,
        "cy": 32,
        "radius": 3,
        "amount": -16
      },
      {
        "name": "arch-pillar-drag-up",
        "tool": "drag",
        "targetBand": {
          "fromClick": 1
        },
        "cx": 46,
        "cy": 32,
        "radius": 2,
        "amount": 16
      },
      {
        "name": "arch-shelf-smooth",
        "tool": "smooth",
        "spill": "banded",
        "anchor": "clicked",
        "cx": 32,
        "cy": 52,
        "radius": 6,
        "amount": -16
      }
    ],
    "terrace": [
      {
        "name": "min-floor-lower-noop",
        "tool": "stamp",
        "profile": "hard",
        "anchor": "clicked",
        "cx": 1,
        "cy": 32,
        "radius": 2,
        "amount": -16
      },
      {
        "name": "max-ceiling-raise-noop",
        "tool": "stamp",
        "profile": "hard",
        "anchor": "clicked",
        "cx": 62,
        "cy": 32,
        "radius": 2,
        "amount": 16
      },
      {
        "name": "max-ceiling-lower",
        "tool": "stamp",
        "profile": "hard",
        "anchor": "clicked",
        "cx": 62,
        "cy": 40,
        "radius": 3,
        "amount": -16
      },
      {
        "name": "slab-carve",
        "tool": "carve",
        "spanBand": {
          "fromClick": 0
        },
        "cx": 20,
        "cy": 32,
        "radius": 2,
        "amount": -16
      },
      {
        "name": "min-floor-raise",
        "tool": "stamp",
        "profile": "soft",
        "anchor": "clicked",
        "cx": 1,
        "cy": 8,
        "radius": 3,
        "amount": 16
      }
    ],
    "shoreline": [
      {
        "name": "waterline-stamp-raise",
        "tool": "stamp",
        "profile": "soft",
        "anchor": "clicked",
        "cx": 20,
        "cy": 32,
        "radius": 3,
        "amount": 16
      },
      {
        "name": "deep-water-lower",
        "tool": "stamp",
        "profile": "hard",
        "anchor": "clicked",
        "cx": 2,
        "cy": 32,
        "radius": 3,
        "amount": -16
      },
      {
        "name": "shore-drag-terrace",
        "tool": "drag",
        "targetBand": {
          "fromClick": 1
        },
        "sweepFrom": {
          "x": 24,
          "y": 40
        },
        "cx": 28,
        "cy": 40,
        "radius": 2,
        "amount": 16
      }
    ],
    "played": [
      {
        "name": "played-carve-under-roof",
        "tool": "carve",
        "spanBand": 17,
        "cx": 17,
        "cy": 9,
        "radius": 2,
        "amount": -16
      },
      {
        "name": "played-drag-into-gap",
        "tool": "drag",
        "targetBand": 18,
        "cx": 17,
        "cy": 9,
        "radius": 2,
        "amount": 16
      },
      {
        "name": "played-roof-smooth",
        "tool": "smooth",
        "spill": "banded",
        "anchor": "clicked",
        "cx": 20,
        "cy": 12,
        "radius": 5,
        "amount": -16
      }
    ]
  };
