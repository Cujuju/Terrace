# Kraken

Settled with the owner; do not relitigate without new information.

## 2026-08-19 — trench, eviction, body

- Depth bar is 7 bands (−448): the deepest bar admitting an untouched band-8 floor and that floor after one one-band shave.
- Every fresh world guarantees one kraken trench (owner-decided, #42): lair-sized, cut to the deep-ocean reference band through the deepest ocean, only if the noise produced none. Lowers open-ocean cells only; genesis path only.
- No eviction (owner: "For now, no eviction. Later, if we do boats, they can attack the kraken."). Raising the seabed under its own cell still dislodges it (ten-minute absence).
- Arrivals scatter: summon cell is hash-picked uniformly among the region's qualifying cells (murmur3 fmix32 of the monster-id counter), not the single deepest cell. Applies to all kinds.
- Body follows surfaced-cephalopod fact (owner: "physically wrong"): wider than tall, 7-cell footprint, eyes at the waterline. Dread-weather spec derives per kind from its own anatomy (#44).

## 2026-08-20 — boats fight the kraken (#43)

- Villages dispatch; players do not command. No player verb (reinforcement verb deferred to #49).
- Attrition: the kraken sinks one engaged boat per 12 s; each engaged boat wounds it 1/s; 54 wounds rout it. 54, not 60: 60 coincides with the second sinking, and a win must never tie a loss event. Relation pinned by test.
- A rout goes through `banish` (`boats:defeated` event); a routed kraken gets the standard ten-minute cooldown.
- Coastal-ness is decided in the boats plugin; `structures` unchanged.

## 2026-09-05 — squadrons, revised 2026-09-14

- Fleets of 2–5, crewed by current-position proximity (within formation spread = patrol range). No harbour, mooring, or home requirement. Every boat joins a fleet; loners attach to the nearest crew.
- Muster at the flagship's position; 60 s timeout sails with the whole crew, stragglers chasing the moving fleet. Only a crew reduced below strength dissolves.
- No per-boat recall. A kraken within patrol range of a village is answered by the nearest fleet (by flagship position), which returns to attack it. Boats the kraken is already on top of fight in self-defence.
- Short cruising legs (1/4 patrol range, 16-cell hops): sail one, arrive, draw the next from where the fleet sits. Map-spanning legs flip faster than hulls converge.
- One shared hop per fleet: the flagship takes the hop raw, members take lattice slots around it (snapped to sailable water) and plan their own routes. One leg routed per tick from the shared pool.
