# Flipper & Shrimp's Place

A pier clubhouse shared equally by Flipper (a dolphin) and Shrimp. It was built from the owner-selected concept: layout C (pier) with the character slides from A, then revised to use curved slides. See `flipper-shrimp-concept.png`. `concept-prompt.txt` holds the three prompts in order, and `E:\Development\Projects\Terrace\.census\flipper-shrimp-concepts\` has all the option images. The images came from Codex CLI 0.156.1 image generation; the backend model is not verified.

## Contents

- **Building:** clubhouse with an arched door and portholes, a shingled bait shack, and a striped lighthouse with a lit lantern.
- **Pier:** stilts with an algae line, two round lounge decks, a front dock, and a stone pool with stepping stones.
- **Water features:** a waterfall and two bubbling jets.
- **Signs and mascots:** the main "FLIPPER & SHRIMP'S PLACE" sign, flanked by equal dolphin and shrimp mascots on curling waves, with a scallop crest on top. Two small signs: "NO FISHING" and "WATER WIGGLERS WELCOME."
- **Slides:** each curved flume comes out of the open mouth of a dolphin head or a shrimp head.
- **Lounges:** Flipper's lounge (blue umbrella, wave backrest) matches Shrimp's lounge (coral umbrella, scallop canopy) in size and furniture.
- **Characters:** dolphins have a beak, forehead, white underside, painted smile, cartoon eyes, dorsal fin, flippers and fluke. Shrimp have a head shell with a spike, eyes on stalks, long antennae, banded abdomen segments, legs, pincers and a tail fan.

Omitted for the budget: barrels, plant pots, seagull, the small left hut, and some lanterns and ropes. The rear is extrapolated from the concept.

## Placement

The front is glTF +Z, and the footprint is centred on X/Z with ground at Y=0. The footprint is 0.86 world units wide, the same as Ricks. Undersides that rest on the ground or the deck have no faces.

## Variants

| | Triangles | UV islands | Texel density (px/world unit) | Atlas |
|---|---:|---:|---:|---:|
| Original | 10,396 | 6,845 | 493.2 | 2048 |
| Low | 6,092 | 3,551 | 135.0 | 1024 |

The low variant uses fewer sections and simpler ropes, drops the second rope rail, buoys, gallery posts and piling wraps, and has fewer fronds and legs. Its envelope is identical to the original's. Low density is below Durand's (142) and Ricks' (164), so the main sign is soft at the Low setting.

Paint is procedural: planks, clapboard, stone, lagoon caustics, and the character colours with painted smiles. `prepare_clubhouse_paint.ps1` typesets the sign lettering in Arial Rounded MT Bold. Lanterns, portholes and the lighthouse lamp use the fourth (emissive) map.

## Verification

Both variants pass `audit_asset.py`, compression and mip checks, and `verify_delivery.py flipper-shrimp`:

- no UV overlaps
- 12 px island gaps
- density spread under 0.03%
- metalness 0 at every mip level

## Rebuild

```powershell
python 'E:\Development\Projects\Terrace\.census\building-kit\run_delivery.py' flipper-shrimp
python 'E:\Development\Projects\Terrace\.census\building-kit\verify_delivery.py' flipper-shrimp
```

Geometry: `E:\Development\Projects\Terrace\.census\building-kit\clubhouse.py`. Not yet integrated into the game.
